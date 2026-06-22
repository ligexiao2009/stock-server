/**
 * 市场行情路由 — 指数、加密币、K线、股票详情、行情、静态文件
 */
const db = require('../db/db');
const { fetchQuotesBatch, parseQuoteResponse, decodeQtResponse } = require('../utils/quotes');
const { fetchKlineData } = require('../utils/kline');
const { getStockDetail } = require('../utils/stock-detail');
const { servePublicFile } = require('../utils/static-files');

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const CRYPTO_PAIRS = [
  { pair: 'BTC_USDT', code: 'BTC', name: 'Bitcoin' },
  { pair: 'ETH_USDT', code: 'ETH', name: 'Ethereum' },
  { pair: 'OKB_USDT', code: 'OKB', name: 'OKB' },
];

async function fetchSingleGateioQuote(pair, code, name) {
  const url = `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`;
  const resp = await fetch(url);
  const data = await resp.json();
  const ticker = Array.isArray(data) ? data[0] : data;
  return {
    code, name,
    price: parseFloat(ticker.last) || 0,
    change: parseFloat(ticker.change_percentage) || 0,
    priceDate: new Date().toISOString().slice(0, 10).replace(/-/g, ''),
    isFund: false,
  };
}

async function handleMarketRoutes(req, res, { userId, sendCachedJson, QUOTES_CACHE_TTL_MS, KLINE_CACHE_TTL_MS }) {
  // ========== 静态文件 ==========
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/') {
    if (servePublicFile(req, res, '/stock.html')) return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/mobile') {
    if (servePublicFile(req, res, '/index.html')) return true;
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && !req.url.startsWith('/api/')) {
    if (servePublicFile(req, res, req.url)) return true;
  }

  // ========== 市场状态（是否开盘） ==========
  if (req.method === 'GET' && req.url === '/api/market-status') {
    try {
      let shDate = '', hkDate = '';
      try {
        const urls = [
          'http://hq.sinajs.cn/list=sh000001',
          'http://hq.sinajs.cn/list=hkHSI',
        ];
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 5000);
        const headers = { 'Referer': 'https://finance.sina.com.cn' };
        const [shRes, hkRes] = await Promise.all(urls.map(u => fetch(u, { headers, signal: ctrl.signal })));
        clearTimeout(t);
        const [shText, hkText] = await Promise.all([shRes.text(), hkRes.text()]);

        const extractDate = (text) => {
          const parts = text.split(',');
          for (let i = parts.length - 1; i >= 0; i--) {
            const v = parts[i].replace(/"/g, '').trim();
            if (/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(v)) return v.replace(/-/g, '').replace(/\//g, '');
          }
          return '';
        };

        shDate = extractDate(shText);
        hkDate = extractDate(hkText);
      } catch (_) {
        // Sina 不可用，降级到工作日判断
      }

      // Fallback: Sina 无数据时按工作日判断
      if (!shDate || !hkDate) {
        const wd = new Date().getDay();
        const isWeekday = wd >= 1 && wd <= 5;
        if (!shDate) shDate = isWeekday ? 'weekday' : 'weekend';
        if (!hkDate) hkDate = isWeekday ? 'weekday' : 'weekend';
        sendJson(res, 200, { aStockOpen: isWeekday, hkStockOpen: isWeekday, shDate, hkDate });
      } else {
        // 用本地日期（UTC+8）而非 UTC 日期判断
        const now = new Date();
        const localToday = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
        sendJson(res, 200, { aStockOpen: shDate === localToday, hkStockOpen: hkDate === localToday, shDate, hkDate });
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 指数监控页面（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/market/indices') {
    if (servePublicFile(req, res, '/market-indices.html')) return true;
  }

  // ========== 综合 Dashboard（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/market/dashboard') {
    if (servePublicFile(req, res, '/market-dashboard.html')) return true;
  }

  // ========== 指数排序（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/api/index-sort') {
    try {
      const raw = await db.getConfig('index_sort_order');
      const order = raw ? JSON.parse(raw) : [];
      sendJson(res, 200, { success: true, order });
    } catch (e) {
      sendJson(res, 200, { success: true, order: [] });
    }
    return true;
  }
  if (req.method === 'POST' && req.url === '/api/index-sort') {
    try {
      const { order } = await readJsonBody(req);
      await db.setConfig('index_sort_order', JSON.stringify(order || []));
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 指数行情总览（腾讯 API） ==========
  if (req.method === 'GET' && req.url === '/api/indices-top') {
    try {
      await sendCachedJson(req, res, 'indices-top', async () => {
        const symbols = 'sh000001,sh000300,sh000905,sh000016,sh000010,sh000688,sz399001,sz399006,sz399005,sz399673,hkHSI,hkHSTECH';
        const url = `https://qt.gtimg.cn/q=${symbols}`;
        const resp = await fetch(url, { headers: { 'Referer': 'https://finance.qq.com' } });
        const buf = await resp.arrayBuffer();
        const text = new TextDecoder('gbk').decode(buf);
        const leftListObj = {};
        const re = /v_\w+="([^"]*)"/g;
        let m;
        while ((m = re.exec(text)) !== null) {
          const raw = m[1];
          if (!raw || raw === 'pv_none_match="1"') continue;
          const p = raw.split('~');
          if (p.length < 33) continue;
          const market = parseInt(p[0]) || 0;
          const code = p[2] || '';
          const emCode = market === 1 ? '1.' + code : market === 51 ? '0.' + code : '100.' + code;
          leftListObj[emCode] = {
            f2: parseFloat(p[3]) || 0,
            f3: parseFloat(p[32]) || 0,
            f4: parseFloat(p[31]) || 0,
            f12: code,
            f13: market === 100 ? 100 : market === 1 ? 1 : 0,
            f14: p[1] || '',
          };
        }
        const thsData = { upDownData: {}, trading: {} };
        return { leftListObj, thsData };
      }, { ttlMs: 15000 });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 全球指数（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/api/global-indices') {
    try {
      const symbols = 'usNDX,usINX,usDJI';
      const url = `https://qt.gtimg.cn/q=${symbols}`;
      const resp = await fetch(url, { headers: { 'Referer': 'https://finance.qq.com' } });
      const buf = await resp.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      const items = [];
      const re = /v_(\w+)="([^"]*)"/g;
      let m;
      while ((m = re.exec(text)) !== null) {
        const key = m[1], raw = m[2];
        if (!raw || raw === 'pv_none_match="1"') continue;
        const p = raw.split('~');
        if (p.length < 10) continue;
        const name = p[1] || '';
        const code = p[2] || '';
        const price = parseFloat(p[3]) || 0;
        const open = parseFloat(p[5]) || 0;
        const changePercent = parseFloat(p[32]) || 0;
        items.push({ code: key.replace('us','').replace('hk',''), name, price, open, change: changePercent, rawCode: key });
      }
      sendJson(res, 200, { success: true, data: items });
    } catch (e) {
      sendJson(res, 500, { success: false, error: e.message });
    }
    return true;
  }

  // ========== 指数行情 ==========
  if (req.method === 'GET' && req.url === '/api/indices') {
    try {
      await sendCachedJson(req, res, 'indices', async () => {
        const url = 'https://qt.gtimg.cn/q=s_sh000001,s_sz399001,s_sz399006';
        const resp = await fetch(url);
        const text = await decodeQtResponse(resp);
        const parsed = parseQuoteResponse(text);
        const result = {};
        for (const code of ['sh000001', 'sz399001', 'sz399006']) {
          const parts = parsed.get(`s_${code}`);
          if (parts) {
            result[code] = {
              code, name: (parts[1] || '').replace(' ', ''),
              price: parseFloat(parts[3]) || 0, change: parseFloat(parts[5]) || 0,
            };
          }
        }

        try {
          const tUrl = 'https://qt.gtimg.cn/q=hkHSTECH';
          const tResp = await fetch(tUrl, { headers: { 'Referer': 'https://finance.qq.com' } });
          const tBuf = await tResp.arrayBuffer();
          const tText = new TextDecoder('gbk').decode(tBuf);
          const tMatch = /v_hkHSTECH="([^"]*)"/.exec(tText);
          if (tMatch) {
            const p = tMatch[1].split('~');
            if (p.length > 5) {
              result['hkHSTECH'] = {
                code: 'hkHSTECH', name: p[1] || '恒生科技指数',
                price: parseFloat(p[3]) || 0, change: parseFloat(p[32]) || 0,
              };
            }
          }
        } catch (e) {
          console.error('Tencent HSTECH fetch failed:', e.message);
        }

        return result;
      }, { ttlMs: 30000 });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 加密币行情 ==========
  if (req.method === 'GET' && req.url === '/api/crypto-quotes') {
    try {
      await sendCachedJson(req, res, 'crypto-quotes', async () => {
        const result = {};
        for (const { pair, code, name } of CRYPTO_PAIRS) {
          try {
            const quote = await fetchSingleGateioQuote(pair, code, name);
            result[`${code}:crypto`] = quote;
          } catch (e) {
            console.error(`Gate.io ${pair} fetch error:`, e.message);
          }
        }
        return { quotes: result };
      }, { ttlMs: 60000 });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 加密币快照 ==========
  if (req.method === 'GET' && req.url.startsWith('/api/crypto-snapshots')) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const date = requestUrl.searchParams.get('date');
      if (!date) {
        sendJson(res, 400, { error: 'date parameter required (YYYYMMDD)' });
        return true;
      }
      const snapshots = await db.getCryptoSnapshots(date, userId);

      // Find 00:00 base price for each coin
      const basePrices = {};
      for (const s of snapshots) {
        if (s.time === '00:00' && s.price > 0) {
          basePrices[s.code] = s.price;
        }
      }

      // Calculate percentage change from 00:00 base
      const result = snapshots.map(s => ({
        ...s,
        changePercent: basePrices[s.code] ? Math.round((s.price - basePrices[s.code]) / basePrices[s.code] * 10000) / 100 : 0,
      }));

      sendJson(res, 200, { snapshots: result });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // ========== 批量行情 ==========
  if (req.method === 'GET' && req.url.startsWith('/api/quotes')) {
    try {
      const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const fresh = requestUrl.searchParams.get('fresh') === '1';
      const itemsParam = requestUrl.searchParams.get('items');

      let items;
      if (itemsParam) {
        items = itemsParam.split(',').map(entry => entry.trim()).filter(Boolean)
          .map(entry => { const [code, isFundFlag] = entry.split(':'); return { code, isFund: isFundFlag === '1' }; });
      } else {
        const rows = await db.getPositions(userId);
        items = rows.map(row => ({ code: row.code, isFund: row.isFund }));
      }

      const cacheKey = 'quotes:' + items
        .map(item => `${String(item.code || '').trim()}:${item.isFund ? 1 : 0}`)
        .filter(Boolean).sort().join(',');

      await sendCachedJson(req, res, cacheKey, async () => ({
        quotes: await fetchQuotesBatch(items), updatedAt: Date.now(),
      }), { ttlMs: QUOTES_CACHE_TTL_MS, bypassCache: fresh });
    } catch (error) {
      console.error('Error getting quotes:', error);
      sendJson(res, 500, { error: 'Failed to get quotes' });
    }
    return true;
  }

  // ========== K 线代理 ==========
  if (req.method === 'GET' && req.url.startsWith('/api/kline/')) {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
      const pathParts = parsedUrl.pathname.split('/');
      const symbol = pathParts[pathParts.length - 1];
      const scale = parseInt(parsedUrl.searchParams.get('scale')) || 240;
      const datalen = parseInt(parsedUrl.searchParams.get('datalen')) || 1023;

      if (!symbol || !['sh', 'sz', 'hk'].some(p => symbol.startsWith(p))) {
        sendJson(res, 400, { success: false, error: '无效的股票代码格式' });
        return true;
      }

      const cacheKey = `kline:${symbol}:${scale}:${datalen}`;
      await sendCachedJson(req, res, cacheKey, async () => {
        const data = await fetchKlineData(symbol, scale, datalen);
        return { success: true, data, updatedAt: Date.now() };
      }, { ttlMs: KLINE_CACHE_TTL_MS });
    } catch (error) {
      console.error('获取K线数据失败:', error.message);
      sendJson(res, 500, { success: false, error: error.message });
    }
    return true;
  }

  // ========== 股票/ETF 详情 ==========
  if (req.method === 'GET' && req.url.startsWith('/api/stock-detail/')) {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
      const code = parsedUrl.pathname.split('/api/stock-detail/')[1].replace(/\/$/, '');
      const period = parsedUrl.searchParams.get('period') || 'day';
      const detail = await getStockDetail(code, period);
      sendJson(res, 200, detail);
    } catch (e) {
      sendJson(res, 500, { success: false, error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleMarketRoutes };
