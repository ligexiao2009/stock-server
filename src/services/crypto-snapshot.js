/**
 * 加密币持仓收益快照 — 每5分钟记录一次加密币持仓的实时收益
 */
const db = require('../db/db');

const CRYPTO_PAIRS = [
  { pair: 'BTC_USDT', code: 'BTC', name: 'Bitcoin' },
  { pair: 'ETH_USDT', code: 'ETH', name: 'Ethereum' },
  { pair: 'OKB_USDT', code: 'OKB', name: 'OKB' },
];

async function fetchWithRetry(url, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url);
      const data = await resp.json();
      return data;
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay * (i + 1)));
    }
  }
}

async function fetchGateioPrices() {
  const result = {};
  for (const cp of CRYPTO_PAIRS) {
    try {
      const url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${cp.pair}`;
      const data = await fetchWithRetry(url);
      if (Array.isArray(data) && data.length > 0) {
        result[cp.code] = parseFloat(data[0].last) || 0;
      }
    } catch (e) {
      console.error(`获取 ${cp.code} 价格失败:`, e.message);
    }
  }
  return result;
}

async function takeCryptoSnapshot() {
  console.log('\n========== 加密币持仓快照 ==========');
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();
  const timeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;

  // 获取所有持仓
  const allRows = await db.getPositions();

  // 筛选出加密币持仓（is_fund=false，code 在 CRYPTO_PAIRS 中）
  const cryptoCodes = new Set(CRYPTO_PAIRS.map(p => p.code));
  const cryptoRows = allRows.filter(r => !r.isFund && cryptoCodes.has(r.code));

  if (cryptoRows.length === 0) {
    console.log('无加密币持仓，跳过快照');
    return;
  }

  // 一次请求获取所有币价格
  let prices = {};
  try {
    prices = await fetchGateioPrices();
  } catch (e) {
    console.error('获取加密币价格失败:', e.message);
  }

  // 获取汇率
  const usdRate = parseFloat(await db.getConfig('crypto_fx')) || 7.2;

  // 按用户分组
  const userMap = {};
  for (const row of cryptoRows) {
    const uid = row.user_id || row.userId || 'default';
    if (!userMap[uid]) userMap[uid] = [];
    userMap[uid].push(row);
  }

  for (const [userId, rows] of Object.entries(userMap)) {
    for (const row of rows) {
      const price = prices[row.code];
      if (!price || price <= 0 || row.shares <= 0) continue;

      const profit = (price - row.cost) * row.shares * usdRate;

      await db.saveCryptoSnapshot({
        userId,
        date: dateStr,
        time: timeStr,
        code: row.code,
        name: row.name || row.code,
        price,
        cost: row.cost,
        shares: row.shares,
        profit: Math.round(profit * 100) / 100,
      });

      console.log(`[${timeStr}] 用户 ${userId} ${row.code}: 价格 $${price}, 成本 $${row.cost}, 汇率${usdRate}, 收益 ¥${Math.round(profit)}`);
    }
  }

  console.log('========== 加密币快照完成 ==========');
}

module.exports = { takeCryptoSnapshot };
