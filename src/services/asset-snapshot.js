/**
 * 资产快照 — 工作日 23:30 自动记录资产到 asset_records
 *
 * 每个 position_config 对应一个用户，各拍各的：
 *   ths    = 该用户的股票总市值 + ths_cash
 *   alipay = 该用户的基金总市值 + alipay_cash
 *   crypto = 该用户的加密货币总市值
 *   cmb    = bank_cash
 *   其余静态字段继承该用户最新一条 asset_record
 */
const db = require('../db/db');
const { fetchQuotesBatch } = require('../utils/quotes');

const CRYPTO_CODES = new Set(['BTC', 'ETH', 'OKB']);

async function takeAssetSnapshot() {
  console.log('\n========== 资产快照 ==========');

  // 1. 获取所有用户的 position_config
  const allConfigs = await db.query('SELECT * FROM position_config');
  const configs = (allConfigs && allConfigs.rows) ? allConfigs.rows : [];
  if (configs.length === 0) {
    console.log('[资产快照] 无 position_config，跳过');
    return;
  }

  // 2. 获取所有用户的 asset_records（用于继承静态字段）
  const allRecords = await db.getAssetRecords(null) || [];
  const latestByUser = {};
  for (const r of allRecords) {
    const uid = r.userId || r.user_id || 'none';
    if (!latestByUser[uid]) latestByUser[uid] = r;
  }

  // 3. 北京时间
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const recordedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // 4. 获取汇率
  const usdRate = parseFloat(await db.getConfig('crypto_fx')) || 7.25;

  // 5. 每个用户单独处理
  for (const cfg of configs) {
    const uid = cfg.user_id;
    if (!uid) continue;

    // 5a. 该用户的持仓
    const positions = await db.getPositions(uid) || [];
    if (positions.length === 0) {
      console.log(`[资产快照] user=${uid} 无持仓，跳过`);
      continue;
    }

    // 5b. 行情
    const quoteItems = positions.map(p => ({
      code: p.code,
      isFund: p.isFund === true || p.isFund === 1 || p.isFund === '1' || p.isFund === 'true',
    }));
    const quotes = await fetchQuotesBatch(quoteItems);

    // 5c. 计算股票/基金市值（从行情）
    let stockMv = 0, fundMv = 0;
    for (const p of positions) {
      if (CRYPTO_CODES.has(p.code)) continue; // 加密币单独处理
      const isFund = p.isFund === true || p.isFund === 1 || p.isFund === '1' || p.isFund === 'true';
      const key = `${p.code}:${isFund ? 1 : 0}`;
      const q = quotes[key];
      if (!q || !q.price || !p.shares) continue;
      const mv = q.price * p.shares;
      if (isFund) { fundMv += mv; } else { stockMv += mv; }
    }
    stockMv = Math.round(stockMv * 100) / 100;
    fundMv = Math.round(fundMv * 100) / 100;

    // 5d. 加密币市值（从 crypto_snapshots 取最新价格）
    let cryptoMv = 0;
    const cryptoCodes = positions.filter(p => CRYPTO_CODES.has(p.code));
    for (const p of cryptoCodes) {
      const snapRes = await db.query(
        `SELECT price FROM crypto_snapshots WHERE user_id = $1 AND code = $2 ORDER BY date DESC, time DESC LIMIT 1`,
        [uid, p.code]
      );
      const snapPrice = (snapRes && snapRes.rows && snapRes.rows[0]) ? parseFloat(snapRes.rows[0].price) || 0 : 0;
      if (snapPrice > 0 && p.shares > 0) {
        cryptoMv += snapPrice * p.shares * usdRate;
      }
    }
    cryptoMv = Math.round(cryptoMv * 100) / 100;

    // 5d. 现金
    const thsCash = parseFloat(cfg.ths_cash) || 0;
    const alipayCash = parseFloat(cfg.alipay_cash) || 0;
    const bankCash = parseFloat(cfg.bank_cash) || 0;

    // 5e. 继承静态字段
    const latest = latestByUser[uid] || {};
    const wechat = parseFloat(latest.wechat) || 0;
    const cash = parseFloat(latest.cash) || 0;
    const provident = parseFloat(latest.provident) || 0;
    const receivable = parseFloat(latest.receivable) || 0;
    const debt = parseFloat(latest.debt) || 0;

    // 5f. 计算
    const ths = Math.round((stockMv + thsCash) * 100) / 100;
    const alipay = Math.round((fundMv + alipayCash) * 100) / 100;
    const crypto = cryptoMv;
    const cmb = bankCash;
    const total = Math.round(
      (ths + alipay + crypto + cmb + cash + wechat + provident + receivable - debt) * 100
    ) / 100;

    // 5g. 写入
    await db.createAssetRecord({
      recordedAt, userId: uid,
      total, alipay, wechat, ths, crypto, cash, cmb, provident, receivable, debt,
    });

    console.log(
      `[资产快照] user=${uid}: total=¥${total.toLocaleString('zh-CN')} ` +
      `(股票市值+ths_cash→ths=¥${ths.toLocaleString('zh-CN')}, 基金市值+alipay_cash→alipay=¥${alipay.toLocaleString('zh-CN')}, 加密=¥${crypto.toLocaleString('zh-CN')}, cmb=¥${cmb.toLocaleString('zh-CN')})`
    );
  }

  console.log('========== 资产快照完成 ==========');
}

module.exports = { takeAssetSnapshot };
