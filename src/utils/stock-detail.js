/**
 * 股票/ETF 详情模块 — 分时图 + K线 + 实时行情
 * 支持: A股、港股、美股
 */
const fetch = require('node-fetch');

const { getFundDetail } = require('./fund-detail');

function isETF(code) { return code.startsWith('5'); }

// 美股: 非纯数字代码（排除加密币）
function isUSStock(code) {
  if (/^\d+$/.test(code)) return false;
  if (['BTC', 'ETH', 'OKB'].includes(code.toUpperCase())) return false;
  return true;
}

// ========== A股/港股 ==========

function buildSymbol(code) {
  if (code.length === 5) return `hk${code}`;
  return /^[569]/.test(code) ? `sh${code}` : `sz${code}`;
}

async function fetchMinuteData(symbol) {
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${symbol}`;
    const resp = await fetch(url);
    const json = await resp.json();
    if (json.code !== 0 || !json.data) return [];
    const stockData = json.data[symbol];
    if (!stockData?.data?.data) return [];
    return stockData.data.data.map(line => {
      const parts = line.split(' ');
      return { time: parts[0], price: parseFloat(parts[1]), volume: parseFloat(parts[2]) || 0, turnover: parseFloat(parts[3]) || 0 };
    });
  } catch (e) { console.error('获取分时图失败:', e.message); return []; }
}

async function fetchKline(symbol) {
  try {
    const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_day&param=${symbol},day,,,365,qfq`;
    const resp = await fetch(url);
    if (!resp.ok) return [];
    const text = await resp.text();
    const jsonText = text.includes('=') ? text.slice(text.indexOf('=') + 1).replace(/;$/, '').trim() : text;
    const payload = JSON.parse(jsonText);
    const stockData = payload?.data?.[symbol];
    const list = stockData ? (stockData.qfqday || stockData.day || []) : [];
    return list.map(item => {
      if (Array.isArray(item) && item.length >= 5) {
        return { day: String(item[0]), open: String(item[1]), close: String(item[2]), high: String(item[3]), low: String(item[4]), volume: String(item[5] || '0') };
      }
      return null;
    }).filter(Boolean);
  } catch (e) { console.error('获取K线失败:', e.message); return []; }
}

async function fetchQuotes(symbols) {
  const result = {};
  if (!symbols.length) return result;
  try {
    const query = symbols.map(s => `s_${s}`).join(',');
    const url = `https://qt.gtimg.cn/q=${query}`;
    const resp = await fetch(url);
    const buffer = await resp.arrayBuffer();
    const text = new TextDecoder('gb18030').decode(buffer);
    for (const sym of symbols) {
      const pattern = new RegExp(`v_s_${escapeRegex(sym)}="(.*?)";?`);
      const match = text.match(pattern);
      if (match) {
        const f = match[1].split('~');
        const code = sym.replace(/^(sh|sz|hk)/, '');
        result[code] = {
          code, name: f[1] || '', price: parseFloat(f[3]) || 0, change: parseFloat(f[5]) || 0,
          volume: parseFloat(f[6]) || 0, turnover: parseFloat(f[7]) || 0,
          marketCap: parseFloat(f[9]) || 0, high: parseFloat(f[9]) || 0, isHK: sym.startsWith('hk'),
        };
      }
    }
  } catch (e) { console.error('获取行情失败:', e.message); }
  return result;
}

// ========== 美股 (新浪财经) ==========

const iconv = require('iconv-lite');

async function fetchUSQuote(code) {
  const result = { code, name: code, price: 0, change: 0, volume: 0, turnover: 0, marketCap: 0, high: 0, low: 0, isHK: false, prevClose: 0 };
  try {
    const url = `https://hq.sinajs.cn/list=gb_${code.toLowerCase()}`;
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn' } });
    const buffer = await resp.arrayBuffer();
    const text = iconv.decode(Buffer.from(buffer), 'GBK');
    const match = text.match(/"([^"]+)"/);
    if (match) {
      const f = match[1].split(',');
      result.name = f[0] || code;
      result.price = parseFloat(f[1]) || 0;
      result.change = parseFloat(f[2]) || 0;
      result.high = parseFloat(f[6]) || 0;
      result.low = parseFloat(f[7]) || 0;
      result.volume = parseFloat(f[10]) || 0;
      // 市值: f[12] 美元 → 亿
      result.marketCap = parseFloat(f[12]) / 1e8 || 0;
      if (result.price > 0 && result.change !== 0) {
        result.prevClose = result.price / (1 + result.change / 100);
      }
    }
  } catch (e) { console.error('US quote失败:', e.message); }
  return result;
}

async function fetchUSMinuteData(code) {
  try {
    const url = `https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_MinKService.getMinK?symbol=${code.toLowerCase()}&type=1&num=400`;
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (!data.length) return [];
    // 取最新一个交易日的分钟数据
    const lastDate = data[data.length - 1].d.slice(0, 10);
    return data
      .filter(item => item.d.startsWith(lastDate))
      .map(item => ({
        time: item.d.slice(11, 16),
        price: parseFloat(item.c),
        volume: parseInt(item.v) || 0,
        turnover: 0,
      }));
  } catch (e) { console.error('US minute失败:', e.message); return []; }
}

async function fetchUSKline(code) {
  try {
    const url = `https://stock.finance.sina.com.cn/usstock/api/json_v2.php/US_MinKService.getDailyK?symbol=${code.toLowerCase()}&type=daily&num=365`;
    const resp = await fetch(url, { headers: { 'Referer': 'https://finance.sina.com.cn' } });
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.slice(-365).map(item => ({
      day: item.d,
      open: String(item.o),
      close: String(item.c),
      high: String(item.h),
      low: String(item.l),
      volume: String(item.v),
    }));
  } catch (e) { console.error('US kline失败:', e.message); return []; }
}

// ========== 工具 ==========

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ========== 主入口 ==========

async function getStockDetail(code) {
  // 美股
  if (isUSStock(code)) {
    const [minuteData, klineData, quote] = await Promise.all([
      fetchUSMinuteData(code),
      fetchUSKline(code),
      fetchUSQuote(code),
    ]);

    const prevClose = quote.prevClose || 0;
    return {
      success: true,
      code,
      symbol: `us.${code}`,
      name: quote.name,
      isHK: false,
      isUS: true,
      quote: {
        price: quote.price,
        change: quote.change,
        prevClose: Math.round(prevClose * 1000) / 1000,
        volume: quote.volume,
        turnover: quote.turnover,
        marketCap: quote.marketCap,
        high: quote.high,
        low: quote.low,
      },
      minuteData,
      klineData,
      topHoldings: null,
    };
  }

  // A股/港股
  const symbol = buildSymbol(code);
  const [minuteData, klineData, quotes] = await Promise.all([
    fetchMinuteData(symbol),
    fetchKline(symbol),
    fetchQuotes([symbol]),
  ]);

  const quote = quotes[code] || { code, name: '', price: 0, change: 0, volume: 0, turnover: 0, marketCap: 0, isHK: code.length === 5 };

  let topHoldings = null;
  if (isETF(code)) {
    try { const fd = await getFundDetail(code); topHoldings = fd.topHoldings; } catch (_) {}
  }

  let prevClose = 0;
  if (quote.price > 0 && quote.change !== 0) {
    prevClose = quote.price / (1 + quote.change / 100);
  }

  const lastK = klineData.length > 0 ? klineData[klineData.length - 1] : null;

  return {
    success: true,
    code,
    symbol,
    name: quote.name,
    isHK: quote.isHK,
    isUS: false,
    quote: {
      price: quote.price,
      change: quote.change,
      prevClose: Math.round(prevClose * 1000) / 1000,
      volume: quote.volume,
      turnover: quote.turnover,
      marketCap: quote.marketCap,
      high: parseFloat(lastK?.high) || 0,
      low: parseFloat(lastK?.low) || 0,
    },
    minuteData,
    klineData,
    topHoldings,
  };
}

module.exports = { getStockDetail };
