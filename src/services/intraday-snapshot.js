/**
 * 盘中收益快照服务 — 每5分钟记录一次当日收益走势
 */
const db = require('../db/db');
const { fetchQuotesBatch, setHKQuoteCache } = require('../utils/quotes');
const { checkStock, sendAlertEmail } = require('./alert-notify');

/** 批量获取基金盘中估值（天天基金，并行请求） */
async function fetchFundEstimates(codes) {
  const results = {};
  const tasks = codes.map(async code => {
    try {
      const resp = await fetch(`http://fundgz.1234567.com.cn/js/${code}.js`);
      const text = await resp.text();
      const m = text.match(/jsonpgz\((\{.*?\})\s*\);?/s);
      if (m) {
        const d = JSON.parse(m[1]);
        results[code] = {
          estimateValue: parseFloat(d.gsz) || 0,
          estimateChange: parseFloat(d.gszzl) || 0,
        };
      }
    } catch (_) {}
  });
  await Promise.all(tasks);
  return results;
}

const HKD_RATE_DEFAULT = 0.92;
const USD_RATE_DEFAULT = 7.2;

function getPrevClose(q) {
  if (q.prev_close > 0) return q.prev_close;
  return q.price / (1 + q.change / 100);
}

function calcStockProfit(price, prevClose, shares, cost, trades) {
  let profit = (price - prevClose) * shares;
  for (const t of trades || []) {
    if (t.type === 'add') {
      profit += (prevClose - t.netValue) * t.shares;
    } else {
      profit += (t.netValue - prevClose) * t.shares;
    }
  }
  return profit;
}

async function takeSnapshot() {
  console.log('\n========== 盘中收益快照 ==========');
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  // 判断是否在交易时间（A股 9:30-15:00，港股 9:30-16:10）
  const aOpen = (hour > 9 || (hour === 9 && minute >= 30)) && (hour < 15 || (hour === 15 && minute === 0));
  const hkOpen = (hour > 9 || (hour === 9 && minute >= 30)) && (hour < 16 || (hour === 16 && minute <= 15));
  if (!aOpen && !hkOpen) {
    console.log(`非交易时间 ${timeStr}，跳过快照`);
    return;
  }

  const allRows = await db.getPositions();
  const hkdRate = parseFloat(await db.getConfig('hkd_cny_rate')) || HKD_RATE_DEFAULT;
  const usdRate = parseFloat(await db.getConfig('crypto_fx')) || USD_RATE_DEFAULT;
  console.log(`市场状态: A股=${aOpen} 港股=${hkOpen} | 汇率: HKD=${hkdRate} USD=${usdRate}`);
  console.log(`持仓总数: ${allRows.length}`);

  // 按用户分组
  const userMap = {};
  for (const row of allRows) {
    const uid = row.user_id || row.userId || 'default';
    if (!userMap[uid]) userMap[uid] = [];
    userMap[uid].push(row);
  }

  const alertItems = [];

  for (const [userId, rows] of Object.entries(userMap)) {
    const cryptoSet = new Set(['BTC', 'ETH', 'OKB']);
    const stocks = rows.filter(r => !r.isFund && r.code && !cryptoSet.has(r.code.toUpperCase()));
    const funds = rows.filter(r => r.isFund && r.code);
    console.log(`\n用户 ${userId}: 股票=${stocks.length}只 基金=${funds.length}只`);

    // 批量获取行情（跳过加密币，加密币有独立快照）
    const specs = rows.filter(r => !cryptoSet.has(r.code.toUpperCase())).map(r => ({ code: r.code, isFund: r.isFund }));
    const quotes = await fetchQuotesBatch(specs, { skipCache: true });
    setHKQuoteCache(quotes);

    let stockProfit = 0, fundProfit = 0;
    let stockMarket = 0, fundMarket = 0;

    // 查当日交易，用于修正收益
    const todayTrades = stocks.length > 0 ? await db.getTodayTrades(userId, dateStr) : [];
    const tradesByRow = {};
    for (const t of todayTrades) {
      if (!tradesByRow[t.rowId]) tradesByRow[t.rowId] = [];
      tradesByRow[t.rowId].push(t);
    }

    for (const stock of stocks) {
      // 港股休市跳过（A股收盘后仍用最后价格）
      if (stock.code.length === 5 && !hkOpen) {
        console.log(`  [跳过] ${stock.code} ${stock.name} 港股休市`);
        continue;
      }

      const q = quotes[`${stock.code}:0`];
      if (!q || q.price <= 0 || stock.shares <= 0) {
        console.log(`  [跳过] ${stock.code} ${stock.name} 行情无效 price=${q?.price} shares=${stock.shares}`);
        continue;
      }

      let price = q.price;
      if (stock.code.length === 5) price *= hkdRate;

      const rawPrevClose = getPrevClose(q);
      const prevClose = stock.code.length === 5 ? rawPrevClose * hkdRate : rawPrevClose;
      // 港股 trade 的 netValue 也是港币，需转成人民币
      const trades = (tradesByRow[stock.id] || []).map(t => ({
        ...t,
        netValue: stock.code.length === 5 ? t.netValue * hkdRate : t.netValue,
      }));
      const profit = calcStockProfit(price, prevClose, stock.shares, stock.cost, trades);
      const mkt = stock.shares * price;
      stockProfit += profit;
      stockMarket += mkt;

      console.log(`  [股票] ${stock.code} ${stock.name} | 股数=${stock.shares} 行情价=${q.price} 涨跌=${q.change?.toFixed(2)}% 汇率后=${price.toFixed(2)} 昨收=${prevClose.toFixed(2)} 收益=${profit.toFixed(0)}`);

      // 涨跌幅告警检查
      const alertResult = checkStock(stock.code, q.change || 0, dateStr);
      if (alertResult.fire) {
        alertItems.push({
          code: stock.code,
          name: stock.name,
          changePct: q.change || 0,
          price: q.price,
          threshold: alertResult.threshold,
        });
      }
    }

    // 基金用天天基金估值接口
    const fundCodes = funds.filter(f => f.shares > 0).map(f => f.code);
    const estimates = await fetchFundEstimates(fundCodes);

    for (const fund of funds) {
      if (fund.shares <= 0) continue;
      const est = estimates[fund.code];
      if (est && est.estimateValue > 0) {
        const mkt = fund.shares * est.estimateValue;
        const changePct = est.estimateChange;
        const prevMkt = (1 + changePct / 100) !== 0 ? mkt / (1 + changePct / 100) : mkt;
        const profit = prevMkt * (changePct / 100);
        fundProfit += profit;
        fundMarket += mkt;
      } else {
        // 估值不可用时降级到腾讯净值（仅当天有效）
        const q = quotes[`${fund.code}:1`];
        if (!q || q.price <= 0 || q.priceDate !== dateStr) continue;
        const mkt = fund.shares * q.price;
        const prevMkt = (1 + q.change / 100) !== 0 ? mkt / (1 + q.change / 100) : mkt;
        const profit = prevMkt * (q.change / 100);
        fundProfit += profit;
        fundMarket += mkt;
      }
    }

    await db.saveIntradaySnapshot({
      userId,
      date: dateStr,
      time: timeStr,
      stockProfit: Math.round(stockProfit),
      fundProfit: Math.round(fundProfit),
      totalProfit: Math.round(stockProfit + fundProfit),
      stockMarket: Math.round(stockMarket),
      fundMarket: Math.round(fundMarket),
      totalMarket: Math.round(stockMarket + fundMarket),
    });

    console.log(`[${timeStr}] 用户 ${userId}: 股票 ¥${Math.round(stockProfit)} 基金 ¥${Math.round(fundProfit)} 总计 ¥${Math.round(stockProfit + fundProfit)}`);
  }

  // 发送涨跌幅告警邮件
  if (alertItems.length > 0) {
    await sendAlertEmail(dateStr, alertItems);
  }

  console.log('========== 盘中快照完成 ==========');
}

module.exports = { takeSnapshot };
