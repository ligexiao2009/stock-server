/**
 * 行情数据获取 — 腾讯行情接口 qt.gtimg.cn
 */
const QUOTES_BATCH_SIZE = Number(process.env.QUOTES_BATCH_SIZE || 60);
const HK_CACHE_TTL_MS = 5 * 60 * 1000; // 5分钟缓存
const hkQuoteCache = new Map(); // code -> { data, ts }

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

/** 将港股行情写入缓存（快照服务调用） */
function setHKQuoteCache(quotes) {
  const now = Date.now();
  for (const [key, data] of Object.entries(quotes)) {
    if (key.endsWith(':0') && data.code && data.code.length === 5) {
      hkQuoteCache.set(key, { data, ts: now });
    }
  }
}

/** 批量获取行情数据 */
async function fetchQuotesBatch(items, opts = {}) {
  const { skipCache = false } = opts;
  const normalizedItems = [];
  const seen = new Set();

  for (const item of items || []) {
    const code = String(item.code || '').trim();
    if (!code) continue;
    // 加密币走独立行情（Gate.io），不查腾讯/TickFlow
    if (['BTC','ETH','OKB'].includes(code.toUpperCase())) continue;
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

  // 港股：优先从缓存取（快照服务每5分钟更新），缓存未命中再走 TickFlow
  const hkItems = normalizedItems.filter(item => !item.isFund && item.code.length === 5);
  const now = Date.now();
  const uncachedHK = [];

  for (const item of hkItems) {
    const cached = hkQuoteCache.get(item.key);
    if (!skipCache && cached && now - cached.ts < HK_CACHE_TTL_MS) {
      quotes[item.key] = cached.data;
    } else {
      uncachedHK.push(item);
    }
  }

  if (uncachedHK.length > 0) {
    const hkCodes = uncachedHK.map(item => item.code);
    let tfQuotes = await fetchHKQuotesViaTickFlow(hkCodes);
    if (Object.keys(tfQuotes).length === 0 && hkCodes.length > 0) {
      console.log(`[TickFlow] 首次失败，1秒后重试 codes=${hkCodes.join(',')}`);
      await new Promise(r => setTimeout(r, 1000));
      tfQuotes = await fetchHKQuotesViaTickFlow(hkCodes);
    }
    if (Object.keys(tfQuotes).length > 0) {
      Object.assign(quotes, tfQuotes);
      // 写入缓存供后续使用
      setHKQuoteCache(tfQuotes);
    } else {
      console.error(`[TickFlow] 重试仍失败，港股行情不可用 codes=${hkCodes.join(',')}`);
    }
  }

  // 剩余走腾讯行情（仅非港股）
  const remaining = normalizedItems.filter(item => !quotes[item.key] && !(item.code.length === 5 && !item.isFund));
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
  if (!TICKFLOW_KEY || !codes.length) {
    console.log(`[TickFlow] 未配置 API_KEY 或无港股 codes=${codes.join(',')}`);
    return {};
  }

  try {
    const symbols = codes.map(c => `${c}.HK`).join(',');
    const resp = await fetch(`https://api.tickflow.org/v1/quotes?symbols=${symbols}`, {
      headers: { 'X-API-Key': TICKFLOW_KEY }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const body = await resp.json();
    const data = body.data || [];

    if (data.length === 0) {
      console.log(`[TickFlow] 返回空数据 symbols=${symbols}`);
      return {};
    }

    const result = {};
    for (const item of data) {
      const symbol = item.symbol || '';
      const code = symbol.replace('.HK', '');
      const ts = item.timestamp ? new Date(item.timestamp) : new Date();
      const dateStr = ts.toISOString().slice(0, 10).replace(/-/g, '');
      const price = item.last_price || 0;
      const prevClose = item.prev_close || 0;
      const change = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
      result[`${code}:0`] = {
        code, isFund: false,
        name: (item.ext?.name || '').replace('[HK] ', ''),
        price,
        change,
        priceDate: dateStr,
        prev_close: prevClose,
      };
    }
    console.log(`[TickFlow] 成功 codes=${codes.join(',')} count=${data.length}`);
    return result;
  } catch (e) {
    console.error(`[TickFlow] 请求失败: ${e.message} codes=${codes.join(',')}`);
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
  setHKQuoteCache,
  QUOTES_BATCH_SIZE,
};
