/**
 * 行情数据获取 — 腾讯行情接口 qt.gtimg.cn
 */
const QUOTES_BATCH_SIZE = Number(process.env.QUOTES_BATCH_SIZE || 60);

/** 根据代码和类型构建腾讯行情 symbol */
function buildQuoteSymbol(code, isFund) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) return '';
  if (normalizedCode.length === 5) return `hk${normalizedCode}`;
  if (isFund) return `jj${normalizedCode}`;
  return /^[569]/.test(normalizedCode) ? `sh${normalizedCode}` : `sz${normalizedCode}`;
}

/** 从基金行情字段中提取价格日期 */
function parseFundPriceDate(parts) {
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] && /^\d{4}[-]?\d{2}[-]?\d{2}$/.test(parts[i])) {
      return parts[i].replace(/-/g, '');
    }
  }
  return '';
}

/** 解析腾讯行情响应文本，返回 Map<variableName, parts[]> */
function parseQuoteResponse(text) {
  const result = new Map();
  const lines = String(text || '').split('\n');

  for (const line of lines) {
    const match = line.match(/^v_(.+?)="(.*)";?$/);
    if (!match) continue;
    const variableName = match[1];
    const raw = match[2];
    if (!raw || raw.indexOf('~') === -1) continue;
    result.set(variableName, raw.split('~'));
  }

  return result;
}

/** GB18030 解码 fetch response */
async function decodeQtResponse(response) {
  const buffer = await response.arrayBuffer();
  return new TextDecoder('gb18030').decode(buffer);
}

/** 批量获取行情数据 */
async function fetchQuotesBatch(items) {
  const normalizedItems = [];
  const seen = new Set();

  for (const item of items || []) {
    const code = String(item.code || '').trim();
    if (!code) continue;
    const isFund = item.isFund === true || item.isFund === 'true' || item.isFund === 1 || item.isFund === '1';
    const cacheKey = `${code}:${isFund ? 1 : 0}`;
    if (seen.has(cacheKey)) continue;
    seen.add(cacheKey);
    normalizedItems.push({
      code,
      isFund,
      symbol: buildQuoteSymbol(code, isFund),
      key: cacheKey,
    });
  }

  const quotes = {};

  // TickFlow 优先获取港股（有 timestamp 可判断休市）
  const hkCodes = normalizedItems
    .filter(item => !item.isFund && item.code.length === 5)
    .map(item => item.code);
  if (hkCodes.length > 0) {
    const tfQuotes = await fetchHKQuotesViaTickFlow(hkCodes);
    Object.assign(quotes, tfQuotes);
  }

  // 剩余走腾讯行情
  const remaining = normalizedItems.filter(item => !quotes[item.key]);
  for (let i = 0; i < remaining.length; i += QUOTES_BATCH_SIZE) {
    const batch = remaining.slice(i, i + QUOTES_BATCH_SIZE);
    if (!batch.length) continue;

    const query = batch.map(item => `s_${item.symbol}`).join(',');

    try {
      const response = await fetch(`https://qt.gtimg.cn/q=${query}`);
      const text = await decodeQtResponse(response);
      const parsed = parseQuoteResponse(text);

      batch.forEach(item => {
        const parts = parsed.get(`s_${item.symbol}`);
        if (!parts) return;
        quotes[item.key] = {
          code: item.code,
          isFund: item.isFund,
          name: item.isFund ? (parts[1] ? parts[1].replace('[基金] ', '') : '') : (parts[1] || ''),
          price: parseFloat(parts[3]) || 0,
          change: parseFloat(parts[5]) || 0,
          priceDate: parseFundPriceDate(parts),
        };
      });
    } catch (error) {
      console.error('批量获取行情失败:', error.message);
    }
  }

  return quotes;
}

/** TickFlow 获取港股实时行情（带时间戳，可判断休市） */
async function fetchHKQuotesViaTickFlow(codes) {
  const TICKFLOW_KEY = process.env.TICKFLOW_API_KEY || '';
  if (!TICKFLOW_KEY || !codes.length) return {};

  try {
    const symbols = codes.map(c => `${c}.HK`).join(',');
    const resp = await fetch(`https://api.tickflow.org/v1/quotes?symbols=${symbols}`, {
      headers: { 'X-API-Key': TICKFLOW_KEY }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const data = body.data || [];

    const result = {};
    for (const item of quotes) {
      const symbol = item.symbol || '';
      const code = symbol.replace('.HK', '');
      const ts = item.timestamp ? new Date(item.timestamp) : new Date();
      const dateStr = ts.toISOString().slice(0, 10).replace(/-/g, '');
      result[`${code}:0`] = {
        code, isFund: false,
        name: (item.ext?.name || '').replace('[HK] ', ''),
        price: item.last_price || 0,
        change: (item.ext?.change_pct || 0),
        priceDate: dateStr,
      };
    }
    return result;
  } catch (e) {
    // 静默降级
    return {};
  }
}

/** 获取单只股票价格 */
async function fetchStockPrice(code) {
  const quotes = await fetchQuotesBatch([{ code, isFund: false }]);
  const data = quotes[`${code}:0`];
  if (!data) return null;
  return { name: data.name, price: data.price, change: data.change, priceDate: data.priceDate };
}

/** 获取单只基金净值 */
async function fetchFundNetValue(code) {
  const quotes = await fetchQuotesBatch([{ code, isFund: true }]);
  const data = quotes[`${code}:1`];
  if (!data) return null;
  return { name: data.name, netValue: data.price, change: data.change, priceDate: data.priceDate };
}

module.exports = {
  buildQuoteSymbol,
  parseFundPriceDate,
  parseQuoteResponse,
  decodeQtResponse,
  fetchQuotesBatch,
  fetchHKQuotesViaTickFlow,
  fetchStockPrice,
  fetchFundNetValue,
  QUOTES_BATCH_SIZE,
};
