/**
 * 每日收益计算服务
 */
const db = require('../db/db');
const { fetchStockPrice, fetchFundNetValue } = require('../utils/quotes');

async function checkMarketOpen() {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const headers = { 'Referer': 'https://finance.sina.com.cn' };
    const [shText, hkText] = await Promise.all([
      fetch('http://hq.sinajs.cn/list=sh000001', { headers, signal: ctrl.signal }).then(r => r.text()),
      fetch('http://hq.sinajs.cn/list=hkHSI', { headers, signal: ctrl.signal }).then(r => r.text()),
    ]);
    clearTimeout(t);
    const getDate = (text) => {
      const parts = text.split(',');
      for (let i = parts.length - 1; i >= 0; i--) {
        const v = parts[i].replace(/"/g, '').trim();
        if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(v)) return v.replace(/-/g, '').replace(/\//g, '');
      }
      return '';
    };
    const aOpen = getDate(shText) === today;
    const hkOpen = getDate(hkText) === today;
    console.log(`市场状态: A股${aOpen ? '开' : '休'} 港股${hkOpen ? '开' : '休'} (sh=${getDate(shText)} hk=${getDate(hkText)})`);
    return { aStockOpen: aOpen, hkStockOpen: hkOpen };
  } catch (e) {
    const day = new Date().getDay();
    const isWeekday = day >= 1 && day <= 5;
    console.log(`市场状态检测失败(${e.message})，按工作日推算: A股${isWeekday ? '开' : '休'} 港股${isWeekday ? '开' : '休'}`);
    return { aStockOpen: isWeekday, hkStockOpen: isWeekday };
  }
}

function getPrevClose(q) {
  if (q.prev_close > 0) return q.prev_close;
  return q.price / (1 + q.change / 100);
}

function calcStockProfit(price, prevClose, shares, cost, trades, fxRate = 1) {
  let profit = (price - prevClose) * shares;
  for (const t of trades || []) {
    const nv = t.netValue * fxRate;
    if (t.type === 'add') {
      profit += (prevClose - nv) * t.shares;
    } else {
      profit += (nv - prevClose) * t.shares;
    }
  }
  return profit;
}

async function calculateAndSaveDailyProfit() {
  console.log('\n========== 开始计算每日收益 ==========');
  const allRows = await db.getPositions();
  const now = new Date();
  const dateStr = now.getFullYear().toString() + '-' +
    (now.getMonth() + 1).toString().padStart(2, '0') + '-' +
    now.getDate().toString().padStart(2, '0');
  const todayStr = now.getFullYear().toString() +
    (now.getMonth() + 1).toString().padStart(2, '0') +
    now.getDate().toString().padStart(2, '0');
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.getFullYear().toString() +
    (yesterday.getMonth() + 1).toString().padStart(2, '0') +
    yesterday.getDate().toString().padStart(2, '0');
  const hour = now.getHours();
  const minute = now.getMinutes();
  const isTradingMorning = (hour > 9 || (hour === 9 && minute >= 30)) && hour < 15;

  // 按用户分组
  const userMap = {};
  for (const row of allRows) {
    const uid = row.user_id || row.userId || 'default';
    if (!userMap[uid]) userMap[uid] = [];
    userMap[uid].push(row);
  }

  for (const [userId, rows] of Object.entries(userMap)) {
    let stockToday = 0, fundToday = 0;
    const details = [];
    const stocks = rows.filter(r => !r.isFund && r.code);
    const funds = rows.filter(r => r.isFund && r.code);

    const hkdRate = parseFloat(await db.getConfig('hkd_cny_rate')) || 0.92;
    const usdRate = parseFloat(await db.getConfig('crypto_fx')) || 7.2;
    const marketStatus = await checkMarketOpen();

    const todayTrades = stocks.length > 0 ? await db.getTodayTrades(userId, todayStr) : [];
    const tradesByRow = {};
    for (const t of todayTrades) {
      if (!tradesByRow[t.rowId]) tradesByRow[t.rowId] = [];
      tradesByRow[t.rowId].push(t);
    }

    for (const stock of stocks) {
      // 休市跳过：港股5位代码 + HK休市 / A股6位 + A休市
      if (stock.code.length === 5 && !marketStatus.hkStockOpen) continue;
      if (stock.code.length === 6 && !marketStatus.aStockOpen) continue;

      const stockData = await fetchStockPrice(stock.code);
      // 已清仓（shares==0）但当天有交易的股票也要计入已实现收益
      const stockTrades = tradesByRow[stock.id] || [];
      if (stockData && stockData.price > 0 && (stock.shares > 0 || stockTrades.length > 0)) {
        let price = stockData.price;
        if (stock.code.length === 5) price *= hkdRate;
        const rawPrevClose = getPrevClose(stockData);
        const prevClose = stock.code.length === 5 ? rawPrevClose * hkdRate : rawPrevClose;
        const mkt = stock.shares * price;
        const hkRate = stock.code.length === 5 ? hkdRate : 1;
        const today = calcStockProfit(price, prevClose, stock.shares, stock.cost, stockTrades, hkRate);
        stockToday += today;
        details.push({ code: stock.code, name: stock.name || stock.code, type: 'stock', change: stockData.change, profit: Math.round(today), prevClose: Math.round(prevClose * 100) / 100 });
      }
    }

    for (const fund of funds) {
      const fundData = await fetchFundNetValue(fund.code);
      if (fundData && fundData.netValue > 0 && fund.shares > 0) {
        let adjustedPriceDate = fundData.priceDate;
        if (fund.isOverseas && adjustedPriceDate && adjustedPriceDate.length === 8) {
          const year = parseInt(adjustedPriceDate.substr(0, 4));
          const month = parseInt(adjustedPriceDate.substr(4, 2)) - 1;
          const day = parseInt(adjustedPriceDate.substr(6, 2));
          const date = new Date(year, month, day);
          const weekday = now.getDay(); // 0=周日 1=周一 ... 6=周六
          const offset = weekday === 1 ? 3 : 1; // 周一+3跳过周末，其余+1
          date.setDate(date.getDate() + offset);
          adjustedPriceDate = `${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}`;
        }
        let isTodayUpdated = false;
        if (adjustedPriceDate === todayStr) isTodayUpdated = true;
        else if (adjustedPriceDate === yesterdayStr) isTodayUpdated = !isTradingMorning && hour < 15;

        if (isTodayUpdated) {
          const mkt = fund.shares * fundData.netValue;
          const prevMkt = (1 + fundData.change / 100) !== 0 ? mkt / (1 + fundData.change / 100) : mkt;
          const today = prevMkt * (fundData.change / 100);
          fundToday += today;
          details.push({ code: fund.code, name: fund.name || fund.code, type: 'fund', change: fundData.change, profit: Math.round(today) });

          // 保存单只基金收益明细
          try {
            await db.saveFundDailyProfit({
              positionId: fund.id,
              code: fund.code,
              date: dateStr,
              profit: Math.round(today * 100) / 100,
              nav: fundData.netValue,
              shares: fund.shares,
              marketValue: Math.round(mkt * 100) / 100,
              userId,
            });
          } catch (e) {
            console.error(`保存基金 ${fund.code} 收益失败:`, e.message);
          }
        }
      }
    }

    const profitRecord = {
      date: dateStr,
      stockToday: Math.round(stockToday),
      fundToday: Math.round(fundToday),
      totalToday: Math.round(stockToday + fundToday),
      details: JSON.stringify(details),
      userId,
    };

    await db.createDailyProfit(profitRecord);
    console.log(`用户 ${userId}: 股票 ¥${profitRecord.stockToday}, 基金 ¥${profitRecord.fundToday}, 合计 ¥${profitRecord.totalToday}`);
  }

  console.log('========== 收益计算完成 ==========\n');
}

module.exports = { calculateAndSaveDailyProfit };
