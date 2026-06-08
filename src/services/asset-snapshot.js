/**
 * 资产快照 — 工作日 23:30 自动记录资产到 asset_records
 *
 * 计算逻辑：
 *   ths    = 股票总市值 + position_config.ths_cash
 *   alipay = 基金总市值 + position_config.alipay_cash
 *   crypto = 加密货币总市值
 *   cmb    = position_config.bank_cash
 *   其余字段沿用最新一条 asset_records
 */
const db = require('../db/db');
const { fetchQuotesBatch } = require('../utils/quotes');

const CRYPTO_CODES = new Set(['BTC', 'ETH', 'OKB']);
const USD_RATE_DEFAULT = 7.2;

async function takeAssetSnapshot() {
  console.log('\n========== 资产快照 ==========');

  const positions = await db.getPositions() || [];
  if (positions.length === 0) {
    console.log('[资产快照] 无持仓，跳过');
    return;
  }

  const userId = 'default';

  // 1. 获取 position_config
  const posConfig = (await db.getPositionConfig(userId)) || {};
  const thsCash = parseFloat(posConfig.ths_cash) || 0;
  const alipayCash = parseFloat(posConfig.alipay_cash) || 0;
  const bankCash = parseFloat(posConfig.bank_cash) || 0;

  // 2. 批量获取实时行情
  const quoteItems = positions.map(p => ({
    code: p.code,
    isFund: p.isFund === true || p.isFund === 1 || p.isFund === '1' || p.isFund === 'true',
  }));
  const quotes = await fetchQuotesBatch(quoteItems);

  // 3. 计算各类市值
  let stockMv = 0;
  let fundMv = 0;
  let cryptoMv = 0;

  for (const p of positions) {
    const isFund = p.isFund === true || p.isFund === 1 || p.isFund === '1' || p.isFund === 'true';
    const key = `${p.code}:${isFund ? 1 : 0}`;
    const q = quotes[key];
    if (!q || !q.price || !p.shares) continue;

    const mv = q.price * p.shares;

    if (CRYPTO_CODES.has(p.code)) {
      cryptoMv += mv;
    } else if (isFund) {
      fundMv += mv;
    } else {
      stockMv += mv;
    }
  }

  // 加密货币转人民币
  const usdRate = parseFloat(await db.getConfig('crypto_fx')) || USD_RATE_DEFAULT;
  cryptoMv = Math.round(cryptoMv * usdRate * 100) / 100;
  stockMv = Math.round(stockMv * 100) / 100;
  fundMv = Math.round(fundMv * 100) / 100;

  // 4. 获取最新一条 asset_record，继承静态字段
  const latestRecords = await db.getAssetRecords(userId);
  const latest = (latestRecords && latestRecords.length > 0) ? latestRecords[0] : {};

  const wechat = parseFloat(latest.wechat) || 0;
  const cash = parseFloat(latest.cash) || 0;
  const provident = parseFloat(latest.provident) || 0;
  const receivable = parseFloat(latest.receivable) || 0;
  const debt = parseFloat(latest.debt) || 0;

  // 5. 计算各字段
  const ths = Math.round((stockMv + thsCash) * 100) / 100;
  const alipay = Math.round((fundMv + alipayCash) * 100) / 100;
  const crypto = cryptoMv;
  const cmb = bankCash;

  const total = Math.round(
    (ths + alipay + crypto + cmb + cash + wechat + provident + receivable - debt) * 100
  ) / 100;

  // 6. 生成北京时间记录
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const recordedAt = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  // 7. 写入
  await db.createAssetRecord({
    recordedAt,
    userId,
    total,
    alipay,
    wechat,
    ths,
    crypto,
    cash,
    cmb,
    provident,
    receivable,
    debt,
  });

  console.log(
    `[资产快照] 已记录: total=¥${total.toLocaleString('zh-CN')} ` +
    `(股票市值 ¥${stockMv.toLocaleString('zh-CN')} + ths现金 ¥${thsCash.toLocaleString('zh-CN')} → ths=¥${ths.toLocaleString('zh-CN')}, ` +
    `基金市值 ¥${fundMv.toLocaleString('zh-CN')} + alipay现金 ¥${alipayCash.toLocaleString('zh-CN')} → alipay=¥${alipay.toLocaleString('zh-CN')}, ` +
    `加密 ¥${crypto.toLocaleString('zh-CN')}, cmb(bank_cash)=¥${cmb.toLocaleString('zh-CN')})`
  );
  console.log('========== 资产快照完成 ==========');
}

module.exports = { takeAssetSnapshot };
