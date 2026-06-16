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
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>指数行情监控</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f9fb;color:#1a1a2e;min-height:100vh}

.header{background:#fff;padding:16px 32px;border-bottom:1px solid #e5e7eb}
.header .meta{font-size:12px;color:#9ca3af}
.header .right{display:flex;align-items:center;gap:12px}
.refresh-btn{background:none;border:1px solid #e5e7eb;border-radius:8px;padding:6px 14px;font-size:12px;color:#6b7280;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s}
.refresh-btn:hover{border-color:#d1d5db;background:#f9fafb}
.refresh-btn svg{width:14px;height:14px;transition:transform .3s}
.refresh-btn.loading svg{animation:spin .8s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

.container{max-width:1400px;margin:0 auto;padding:24px}

.section-title{font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';width:3px;height:14px;border-radius:2px;background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.page-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:20px}
.page-title{font-size:22px;font-weight:700;color:#1a1a2e;line-height:1.2}
.page-meta{font-size:11px;color:#9ca3af;margin-top:4px;display:flex;align-items:center;gap:6px}
.page-meta .dot{width:5px;height:5px;border-radius:50%;background:#22c55e}

.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:32px}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;transition:all .3s ease;cursor:default;position:relative;overflow:hidden}
.card:hover{border-color:#d1d5db;transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
.card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:14px 14px 0 0}
.card.up::after{background:linear-gradient(90deg,#ef4444,#f97316)}
.card.down::after{background:linear-gradient(90deg,#22c55e,#10b981)}
.card.flat::after{background:#d1d5db}
.card .name{font-size:12px;color:#6b7280;font-weight:500;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.card .price{font-size:24px;font-weight:700;margin-bottom:4px;font-variant-numeric:tabular-nums}
.card .change{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.card .abs{font-size:11px;color:#9ca3af;font-weight:500}
.tag{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.tag-cn{background:#fef2f2;color:#dc2626}
.tag-hk{background:#eef2ff;color:#6366f1}
.up{color:#dc2626}.down{color:#16a34a}.flat{color:#9ca3af}

.breadth-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:16px}
.breadth-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.breadth-item{text-align:center;padding:16px 8px;background:#f9fafb;border-radius:10px;border:1px solid #f3f4f6}
.breadth-item .num{font-size:22px;font-weight:700;margin-bottom:4px}
.breadth-item .label{font-size:11px;color:#9ca3af;font-weight:500}

.vol-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;text-align:center}
.vol-card .label{font-size:12px;color:#9ca3af;font-weight:500;margin-bottom:4px}
.vol-card .val{font-size:28px;font-weight:800;color:#6366f1}
.vol-card .sub{font-size:12px;color:#9ca3af;margin-top:8px}
.vol-card .sub span{font-weight:600;color:#374151}

@media(max-width:640px){
  .container{padding:16px}
  .grid{grid-template-columns:repeat(2,1fr);gap:8px}
  .card{padding:14px}
  .card .price{font-size:20px}
  .breadth-grid{grid-template-columns:repeat(3,1fr)}
}
</style>
</head>
<body>
<div class="container">
  <div class="page-header">
    <div>
      <div class="page-title">指数行情监控</div>
      <div class="page-meta"><div class="dot"></div><span id="meta">加载中...</span></div>
    </div>
    <button class="refresh-btn" id="refreshBtn" onclick="refresh()">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
      刷新
    </button>
  </div>

  <div class="grid" id="grid"></div>
  <div class="section-title">市场宽度</div>
  <div class="breadth-card"><div class="breadth-grid" id="breadth"></div></div>

  <div class="section-title">成交额</div>
  <div class="vol-card" id="vol">加载中...</div>
</div>
<script>
let prevData={};
function anim(el,val,dec){
  const old=prevData[el.id]||0;
  if(Math.abs(old-val)<0.001){el.textContent=val.toFixed(dec);return}
  const start=performance.now();
  function tick(now){
    const t=Math.min((now-start)/400,1);
    const ease=1-Math.pow(1-t,3);
    el.textContent=(old+(val-old)*ease).toFixed(dec);
    if(t<1)requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  prevData[el.id]=val;
}
async function load(){
  try{
    const r=await fetch('/api/indices-top');
    const d=await r.json();
    const list=Object.values(d.leftListObj||{});
    const grid=document.getElementById('grid');
    const isFirstLoad=!grid.children.length;
    if(isFirstLoad){
      grid.innerHTML=list.map(i=>{
        const cls=i.f3>0?'up':i.f3<0?'down':'flat';
        const tag=i.f13===1?'<span class="tag tag-cn">A股</span>':'<span class="tag tag-hk">港股</span>';
        return\`<div class="card \${cls}" id="card_\${i.f12}">
          <div class="name">\${i.f14} \${tag}</div>
          <div class="price" id="p_\${i.f12}">\${i.f2}</div>
          <div class="change">
            <span id="c_\${i.f12}">\${i.f3>0?'+':''}\${i.f3}%</span>
            <span class="abs" id="a_\${i.f12}">\${i.f4>0?'+':''}\${i.f4}</span>
          </div>
        </div>\`;
      }).join('');
    }
    list.forEach(i=>{
      const card=document.getElementById('card_'+i.f12);
      const p=document.getElementById('p_'+i.f12);
      const c=document.getElementById('c_'+i.f12);
      const a=document.getElementById('a_'+i.f12);
      if(!p)return;
      const cls=i.f3>0?'up':i.f3<0?'down':'flat';
      card.className='card '+cls;
      p.className='price '+cls;
      anim(p,i.f2,2);
      c.className=cls;
      c.textContent=(i.f3>0?'+':'')+i.f3+'%';
      a.textContent=(i.f4>0?'+':'')+i.f4;
    });
    const th=d.thsData||{};
    const ud=th.upDownData||{};
    const items=[
      {n:ud.up||0,l:'上涨',c:'up'},{n:ud.limit_up||0,l:'涨停',c:'up'},
      {n:ud.flat||0,l:'平盘',c:'flat'},
      {n:ud.down||0,l:'下跌',c:'down'},{n:ud.limit_down||0,l:'跌停',c:'down'}
    ];
    const br=document.getElementById('breadth');
    if(!br.children.length){
      br.innerHTML=items.map((i,idx)=>\`<div class="breadth-item"><div class="num \${i.c}" id="b\${idx}">\${i.n}</div><div class="label">\${i.l}</div></div>\`).join('');
    }
    items.forEach((i,idx)=>{const el=document.getElementById('b'+idx);if(el)anim(el,i.n,0)});

    const tr=th.trading||{};
    const tv=(tr.turnover||0)/1e8;
    const pv=(tr.turnover_pre||0)/1e8;
    const diff=(tr.turnover_change||0)/1e8;
    const vol=document.getElementById('vol');
    vol.innerHTML=\`<div class="label">今日成交额</div><div class="val" id="volVal">\${tv.toFixed(0)}</div><div style="font-size:14px;color:#94a3b8;margin-top:-4px">亿元</div><div class="sub">前日 <span>\${pv.toFixed(0)}</span> 亿 · 变化 <span style="color:\${diff>=0?'#f87171':'#4ade80'}">\${diff>=0?'+':''}\${diff.toFixed(0)}</span> 亿</div>\`;
    anim(document.getElementById('volVal'),tv,0);
    document.getElementById('meta').textContent='数据来源 52etf.site · '+new Date().toLocaleString('zh-CN');
  }catch(e){document.getElementById('meta').textContent='加载失败: '+e.message}
}
function refresh(){
  const btn=document.getElementById('refreshBtn');
  btn.classList.add('loading');
  load().finally(()=>setTimeout(()=>btn.classList.remove('loading'),600));
}
load();setInterval(load,60000);
</script>
</body></html>`);
    return true;
  }

  // ========== 52etf 代理接口（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/api/indices-top') {
    try {
      const resp = await fetch('https://52etf.site/api/market/topstock');
      const data = await resp.json();
      sendJson(res, 200, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
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
          const etfResp = await fetch('https://52etf.site/api/market/topstock');
          const etfData = await etfResp.json();
          const hsTech = etfData.leftListObj?.['124.HSTECH'];
          if (hsTech) {
            result['hkHSTECH'] = {
              code: 'hkHSTECH', name: hsTech.f14 || '恒生科技指数',
              price: hsTech.f2 || 0, change: hsTech.f3 || 0,
            };
          }
        } catch (e) {
          console.error('52etf HSTECH fetch failed:', e.message);
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
