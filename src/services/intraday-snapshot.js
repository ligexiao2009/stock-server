/**
 * 盘中收益快照服务 — 每5分钟记录一次当日收益走势
 */
const db = require('../db/db');
const { fetchQuotesBatch } = require('../utils/quotes');

/** 批量获取基金盘中估值（天天基金） */
async function fetchFundEstimates(codes) {
  const results = {};
  for (const code of codes) {
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
    await new Promise(r => setTimeout(r, 50));
  }
  return results;
}

const HKD_RATE_DEFAULT = 0.92;
const USD_RATE_DEFAULT = 7.2;

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

  // 按用户分组
  const userMap = {};
  for (const row of allRows) {
    const uid = row.user_id || row.userId || 'default';
    if (!userMap[uid]) userMap[uid] = [];
    userMap[uid].push(row);
  }

  for (const [userId, rows] of Object.entries(userMap)) {
    const stocks = rows.filter(r => !r.isFund && r.code);
    const funds = rows.filter(r => r.isFund && r.code);

    // 批量获取行情
    const specs = rows.map(r => ({ code: r.code, isFund: r.isFund }));
    const quotes = await fetchQuotesBatch(specs);

    let stockProfit = 0, fundProfit = 0;
    let stockMarket = 0, fundMarket = 0;

    for (const stock of stocks) {
      // 港股休市跳过（A股收盘后仍用最后价格）
      if (stock.code.length === 5 && !hkOpen) continue;

      const q = quotes[`${stock.code}:0`];
      if (!q || q.price <= 0 || stock.shares <= 0) continue;

      let price = q.price;
      if (stock.code.length === 5) price *= hkdRate;

      const mkt = stock.shares * price;
      const prevMkt = (1 + q.change / 100) !== 0 ? mkt / (1 + q.change / 100) : mkt;
      const profit = prevMkt * (q.change / 100);
      stockProfit += profit;
      stockMarket += mkt;
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
        // 估值不可用时降级到昨日净值
        const q = quotes[`${fund.code}:1`];
        if (!q || q.price <= 0) continue;
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

  console.log('========== 盘中快照完成 ==========');
}

module.exports = { takeSnapshot };
