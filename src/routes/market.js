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

  // ========== 综合 Dashboard（无需鉴权） ==========
  if (req.method === 'GET' && req.url === '/market/dashboard') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>投资 Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#f8f9fb;color:#1a1a2e;min-height:100vh;display:flex}

/* Sidebar */
.sidebar{width:200px;background:#fff;border-right:1px solid #e5e7eb;padding:20px 0;flex-shrink:0;position:fixed;top:0;left:0;bottom:0;overflow-y:auto}
.sidebar .logo{font-size:16px;font-weight:700;color:#1a1a2e;padding:0 20px 20px;border-bottom:1px solid #f3f4f6;margin-bottom:12px}
.sidebar .nav-item{display:flex;align-items:center;gap:10px;padding:10px 20px;font-size:13px;color:#6b7280;cursor:pointer;transition:all .15s;border-left:3px solid transparent}
.sidebar .nav-item:hover{background:#f9fafb;color:#1a1a2e}
.sidebar .nav-item.active{background:#eef2ff;color:#6366f1;border-left-color:#6366f1;font-weight:600}
.sidebar .nav-item svg{width:16px;height:16px}
.sidebar .nav-group{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:1px;padding:16px 20px 6px}

/* Main */
.main{margin-left:200px;flex:1;min-height:100vh;padding:24px 28px}

/* Pages */
.page{display:none}
.page.active{display:block}

/* Common */
.page-header{display:flex;align-items:flex-end;justify-content:space-between;margin-bottom:20px}
.page-title{font-size:22px;font-weight:700;color:#1a1a2e;line-height:1.2}
.page-meta{font-size:11px;color:#9ca3af;margin-top:4px;display:flex;align-items:center;gap:6px}
.page-meta .dot{width:5px;height:5px;border-radius:50%;background:#22c55e;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.section-title{font-size:13px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.section-title::before{content:'';width:3px;height:14px;border-radius:2px;background:linear-gradient(135deg,#6366f1,#8b5cf6)}
.refresh-btn{background:none;border:1px solid #e5e7eb;border-radius:8px;padding:6px 14px;font-size:12px;color:#6b7280;cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .2s}
.refresh-btn:hover{border-color:#d1d5db;background:#f9fafb}
.refresh-btn svg{width:14px;height:14px;transition:transform .3s}
.refresh-btn.loading svg{animation:spin .8s linear infinite}
@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
.glass-card{background:#fff;border-radius:14px;border:1px solid #e5e7eb;padding:20px;margin-bottom:16px}

/* Index cards */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-bottom:24px}
.gtag{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.gtag-us{background:#fef3c7;color:#d97706}
.gtag-jp{background:#fef2f2;color:#dc2626}
.gtag-eu{background:#ede9fe;color:#7c3aed}
.gtag-hk{background:#eef2ff;color:#6366f1}
.gtag-cn{background:#fef2f2;color:#dc2626}
.gtag-fund{background:#f0fdf4;color:#16a34a}
.idx-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:18px;transition:all .3s ease;position:relative;overflow:hidden}
.idx-card:hover{border-color:#d1d5db;transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.08)}
.idx-card::after{content:'';position:absolute;top:0;left:0;right:0;height:2px;border-radius:14px 14px 0 0}
.idx-card.up::after{background:linear-gradient(90deg,#ef4444,#f97316)}
.idx-card.down::after{background:linear-gradient(90deg,#22c55e,#10b981)}
.idx-card.flat::after{background:#d1d5db}
.idx-card .name{font-size:12px;color:#6b7280;font-weight:500;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.idx-card .price{font-size:24px;font-weight:700;margin-bottom:4px;font-variant-numeric:tabular-nums}
.idx-card .change{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}
.idx-card .abs{font-size:11px;color:#9ca3af;font-weight:500}
.tag{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:600}
.tag-cn{background:#fef2f2;color:#dc2626}
.tag-hk{background:#eef2ff;color:#6366f1}
.up{color:#dc2626}.down{color:#16a34a}.flat{color:#9ca3af}

/* Breadth */
.breadth-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:16px}
.breadth-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px}
.breadth-item{text-align:center;padding:16px 8px;background:#f9fafb;border-radius:10px;border:1px solid #f3f4f6}
.breadth-item .num{font-size:22px;font-weight:700;margin-bottom:4px}
.breadth-item .label{font-size:11px;color:#9ca3af;font-weight:500}

/* Volume */
.vol-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:24px;text-align:center;margin-bottom:16px}
.vol-card .label{font-size:12px;color:#9ca3af;font-weight:500;margin-bottom:4px}
.vol-card .val{font-size:28px;font-weight:800;color:#6366f1}
.vol-card .sub{font-size:12px;color:#9ca3af;margin-top:8px}
.vol-card .sub span{font-weight:600;color:#374151}

/* ERP */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:10px;margin-bottom:20px}
.kpi-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;display:flex;align-items:center;gap:14px}
.kpi-icon{width:48px;height:48px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700}
.kpi-icon.blue{background:#eff6ff;color:#3b82f6}
.kpi-icon.green{background:#f0fdf4;color:#22c55e}
.kpi-icon.red{background:#fef2f2;color:#ef4444}
.kpi-icon.indigo{background:#e0e7ff;color:#6366f1}
.kpi-icon.orange{background:#fff7ed;color:#f97316}
.kpi-card .text-sm{font-size:12px;color:#6b7280;margin-bottom:2px}
.kpi-card .text-val{font-size:22px;font-weight:800}
.kpi-card .text-sub{font-size:11px;color:#9ca3af;margin-top:2px}

.filter-bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.filter-pills{display:flex;gap:2px;background:#f3f4f6;border-radius:8px;padding:3px}
.filter-pill{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:500;color:#6b7280;cursor:pointer;transition:all .15s;border:none;background:none}
.filter-pill:hover{color:#1a1a2e}
.filter-pill.active{background:#fff;color:#6366f1;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.chart-card{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin-bottom:16px}
.chart-card h3{font-size:15px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}
.chart-legend{display:flex;gap:16px;font-size:12px;color:#6b7280;margin-bottom:12px}
.chart-legend span{display:flex;align-items:center;gap:5px}
.chart-legend .dot{width:8px;height:8px;border-radius:50%}
.insight-card{background:#fffbe6;border:1px solid #ffe58f;border-radius:14px;padding:20px;margin-bottom:16px}
.insight-card p{font-size:13px;color:#6b7280;line-height:1.7}
.insight-card b{color:#1a1a2e}

@media(max-width:768px){
  .sidebar{display:none}
  .main{margin-left:0}
  .grid{grid-template-columns:repeat(2,1fr)}
  .breadth-grid{grid-template-columns:repeat(3,1fr)}
}
</style>
</head>
<body>
<aside class="sidebar">
  <div class="logo">投资 Dashboard</div>
  <div class="nav-group">行情</div>
  <div class="nav-item active" onclick="switchPage('indices')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
    指数行情
  </div>
  <div class="nav-group">分析</div>
  <div class="nav-item" onclick="switchPage('erp')">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20V10M18 20V4M6 20v-4"/></svg>
    ERP 风险溢价
  </div>
</aside>

<main class="main">
  <!-- ========== 指数行情页 ========== -->
  <div class="page active" id="page-indices">
    <div class="page-header">
      <div>
        <div class="page-title">指数行情监控</div>
        <div class="page-meta"><div class="dot"></div><span id="meta">加载中...</span></div>
      </div>
      <button class="refresh-btn" id="refreshBtn" onclick="refreshIndices()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/></svg>
        刷新
      </button>
    </div>
    <div class="grid" id="idxGrid"></div>
    <div class="section-title">市场宽度</div>
    <div class="breadth-card"><div class="breadth-grid" id="breadth"></div></div>
    <div class="section-title">成交额</div>
    <div class="vol-card" id="vol">加载中...</div>
  </div>

  <!-- ========== ERP 页 ========== -->
  <div class="page" id="page-erp">
    <div class="page-header">
      <div>
        <div class="page-title">ERP 风险溢价</div>
        <div class="page-meta"><div class="dot"></div><span id="erpMeta">加载中...</span></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <input id="tokenInput" type="text" placeholder="乐股乐股 Token" style="font-size:12px;padding:6px 10px;border:1px solid #e5e7eb;border-radius:8px;width:240px;outline:none" />
        <button class="refresh-btn" onclick="saveToken()" style="font-size:12px;padding:6px 12px">保存 Token</button>
      </div>
    </div>
    <div class="kpi-grid" id="kpiGrid">
      <div class="kpi-card"><div class="kpi-icon blue">📈</div><div><div class="text-sm">沪深300</div><div class="text-val" id="kpiIndex">--</div><div class="text-sub">指数点位</div></div></div>
      <div class="kpi-card"><div class="kpi-icon green">PE</div><div><div class="text-sm">PE (TTM)</div><div class="text-val" id="kpiPE">--</div><div class="text-sub">市场市盈率</div></div></div>
      <div class="kpi-card"><div class="kpi-icon red">📄</div><div><div class="text-sm">十年期国债</div><div class="text-val" id="kpiBond">--</div><div class="text-sub">到期收益率</div></div></div>
      <div class="kpi-card"><div class="kpi-icon indigo">🛡️</div><div><div class="text-sm">ERP 风险溢价</div><div class="text-val" id="kpiERP">--</div><div class="text-sub">E/P − 国债</div></div></div>
      <div class="kpi-card"><div class="kpi-icon orange">💰</div><div><div class="text-sm">今日成交额</div><div class="text-val" id="kpiTurnoverVal">--</div><div class="text-sub">沪深两市合计</div></div></div>
    </div>
    <div class="filter-bar">
      <div class="filter-pills" id="erpFilter">
        <button class="filter-pill active" data-range="0">全部</button>
        <button class="filter-pill" data-range="1">近 1 年</button>
        <button class="filter-pill" data-range="2">近 2 年</button>
        <button class="filter-pill" data-range="3">近 3 年</button>
        <button class="filter-pill" data-range="5">近 5 年</button>
        <button class="filter-pill" data-range="10">近 10 年</button>
      </div>
      <span id="dateRangeText" style="font-size:12px;color:#9ca3af">--</span>
    </div>
    <div class="chart-card">
      <h3>ERP 风险溢价 + 沪深300 指数</h3>
      <div class="chart-legend">
        <span><span class="dot" style="background:#3b82f6"></span>ERP (左轴)</span>
        <span><span class="dot" style="background:#f97316"></span>沪深300 (右轴)</span>
        <span><span class="dot" style="background:#ef4444"></span>ERP≈6 买点</span>
        <span><span class="dot" style="background:#22c55e"></span>ERP≈2 卖点</span>
      </div>
      <div id="erpChart" style="width:100%;height:420px"></div>
    </div>
    <div class="chart-card">
      <h3>市盈率 vs 国债收益率</h3>
      <div class="chart-legend">
        <span><span class="dot" style="background:#22c55e"></span>PE (左轴)</span>
        <span><span class="dot" style="background:#ef4444"></span>十年期国债 (右轴)</span>
      </div>
      <div id="peBondChart" style="width:100%;height:300px"></div>
    </div>
    <div class="chart-card">
      <h3>A股成交额 + 上证指数</h3>
      <div class="filter-bar" style="margin-bottom:0">
        <div class="filter-pills" id="turnFilter">
          <button class="filter-pill active" data-range="0">全部</button>
          <button class="filter-pill" data-range="1">近 1 年</button>
          <button class="filter-pill" data-range="2">近 2 年</button>
          <button class="filter-pill" data-range="3">近 3 年</button>
          <button class="filter-pill" data-range="5">近 5 年</button>
        </div>
      </div>
      <div id="turnoverChart" style="width:100%;height:460px"></div>
    </div>
    <div class="insight-card" id="insightCard">
      <p id="insightText">加载中...</p>
    </div>
    <p style="text-align:center;font-size:11px;color:#9ca3af;margin-top:8px">ERP = 1/PE − 10年期国债收益率 | 数据来源：<a href="https://www.legulegu.com/stockdata/hs300-ttm-lyr" target="_blank" style="color:#6366f1;text-decoration:none">乐股乐股</a> · 东方财富 · 新浪财经</p>
  </div>
</main>

<script>
// ============ Page Switch ============
function switchPage(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.remove('active'));
  document.getElementById('page-'+name).classList.add('active');
  event.currentTarget.classList.add('active');
  if(name==='indices'&&!idxLoaded)loadIndices();
  if(name==='erp'&&!erpLoaded)loadERP();
}

// ============ Indices ============
let idxPrevData={},idxLoaded=false,idxInterval;
function animIdx(el,val,dec){
  const old=idxPrevData[el.id]||0;
  if(Math.abs(old-val)<0.001){el.textContent=val.toFixed(dec);return}
  const s=performance.now();
  (function tick(now){
    const t=Math.min((now-s)/400,1);
    el.textContent=(old+(val-old)*(1-Math.pow(1-t,3))).toFixed(dec);
    if(t<1)requestAnimationFrame(tick);
  })(s);
  idxPrevData[el.id]=val;
}
async function loadIndices(){
  try{
    const r=await fetch('/api/indices-top');
    const d=await r.json();
    const list=Object.values(d.leftListObj||{});
    const grid=document.getElementById('idxGrid');
    const isFirstLoad=!grid.children.length;
    if(isFirstLoad){
      grid.innerHTML=list.map(i=>{
        const cls=i.f3>0?'up':i.f3<0?'down':'flat';
        const tag=i.f13===1?'<span class="tag tag-cn">A股</span>':'<span class="tag tag-hk">港股</span>';
        return\`<div class="idx-card \${cls}" id="ic_\${i.f12}">
          <div class="name">\${i.f14} \${tag}</div>
          <div class="price" id="ip_\${i.f12}">\${i.f2}</div>
          <div class="change"><span id="ic_\${i.f12}c">\${i.f3>0?'+':''}\${i.f3}%</span><span class="abs" id="ic_\${i.f12}a">\${i.f4>0?'+':''}\${i.f4}</span></div>
        </div>\`;
      }).join('');
    }
    list.forEach(i=>{
      const card=document.getElementById('ic_'+i.f12);
      const p=document.getElementById('ip_'+i.f12);
      const c=document.getElementById('ic_'+i.f12+'c');
      const a=document.getElementById('ic_'+i.f12+'a');
      if(!p)return;
      card.className='idx-card '+(i.f3>0?'up':i.f3<0?'down':'flat');
      p.className='price '+(i.f3>0?'up':i.f3<0?'down':'flat');
      animIdx(p,i.f2,2);
      c.className=i.f3>0?'up':i.f3<0?'down':'flat';
      c.textContent=(i.f3>0?'+':'')+i.f3+'%';
      a.textContent=(i.f4>0?'+':'')+i.f4;
    });
    const th=d.thsData||{},ud=th.upDownData||{};
    const items=[{n:ud.up||0,l:'上涨',c:'up'},{n:ud.limit_up||0,l:'涨停',c:'up'},{n:ud.flat||0,l:'平盘',c:'flat'},{n:ud.down||0,l:'下跌',c:'down'},{n:ud.limit_down||0,l:'跌停',c:'down'}];
    const br=document.getElementById('breadth');
    if(!br.children.length)br.innerHTML=items.map((i,idx)=>\`<div class="breadth-item"><div class="num \${i.c}" id="b\${idx}">\${i.n}</div><div class="label">\${i.l}</div></div>\`).join('');
    items.forEach((i,idx)=>{const el=document.getElementById('b'+idx);if(el)animIdx(el,i.n,0)});
    const tr=th.trading||{},tv=(tr.turnover||0)/1e8,pv=(tr.turnover_pre||0)/1e8,diff=(tr.turnover_change||0)/1e8;
    document.getElementById('vol').innerHTML=\`<div class="label">今日成交额</div><div class="val" id="volV">\${tv.toFixed(0)}</div><div style="font-size:14px;color:#94a3b8;margin-top:-4px">亿元</div><div class="sub">前日 <span>\${pv.toFixed(0)}</span> 亿 · 变化 <span style="color:\${diff>=0?'#dc2626':'#16a34a'}">\${diff>=0?'+':''}\${diff.toFixed(0)}</span> 亿</div>\`;
    animIdx(document.getElementById('volV'),tv,0);
    document.getElementById('meta').textContent='数据来源 52etf.site · '+new Date().toLocaleString('zh-CN');
    idxLoaded=true;
    loadGlobalIndices();
  }catch(e){document.getElementById('meta').textContent='加载失败: '+e.message}
}
function refreshIndices(){
  const btn=document.getElementById('refreshBtn');
  btn.classList.add('loading');
  loadIndices().finally(()=>setTimeout(()=>btn.classList.remove('loading'),600));
}

// ============ ERP ============
let erpData=[],turnoverData=[],erpRange=0,turnRange=0,erpLoaded=false;
let erpChart,peBondChart,turnChart;
function filterByRange(data,range){
  if(range===0)return data;
  const c=new Date();c.setFullYear(c.getFullYear()-range);
  const s=c.toISOString().slice(0,10);
  return data.filter(d=>d.date>=s);
}
async function loadERP(){
  try{
    const [e,t]=await Promise.all([fetch('/api/erp').then(r=>r.json()),fetch('/api/market-turnover').then(r=>r.json())]);
    if(e.success&&e.data.length)erpData=e.data;
    if(t.success&&t.data.length)turnoverData=t.data;
    updateKPIs();renderAllERP();
    document.getElementById('erpMeta').textContent='数据来源 乐股乐股 · 东方财富 · '+new Date().toLocaleString('zh-CN');
    erpLoaded=true;
  }catch(e){document.getElementById('erpMeta').textContent='加载失败'}
  fetch('/api/erp-token').then(r=>r.json()).then(d=>{if(d.success)document.getElementById('tokenInput').value=d.token}).catch(()=>{});
}
async function saveToken(){
  const token=document.getElementById('tokenInput').value.trim();
  if(!token){alert('请输入 Token');return}
  try{
    await fetch('/api/erp-token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    erpData=[];erpLoaded=false;erpCache=null;
    await loadERP();
    alert('Token 已保存并刷新数据');
  }catch(e){alert('保存失败: '+e.message)}
}
function updateKPIs(){
  const l=erpData[erpData.length-1];if(!l)return;
  document.getElementById('kpiIndex').textContent=l.close?l.close.toLocaleString():'--';
  document.getElementById('kpiPE').textContent=l.pe.toFixed(1);
  document.getElementById('kpiBond').textContent=l.bondYield.toFixed(2)+'%';
  document.getElementById('kpiERP').textContent=l.erp.toFixed(2)+'%';
  document.getElementById('dateRangeText').textContent=erpData[0].date+' ~ '+l.date;
  if(turnoverData.length){const t=turnoverData[turnoverData.length-1];document.getElementById('kpiTurnoverVal').textContent=(t.turnover/1e4).toFixed(2)+'万亿'}
  let text='';
  if(l.erp>3)text=\`当前 ERP 为 <b>\${l.erp}%</b>，处于较高水平。股票相对债券的吸引力较强，权益类资产配置性价比较高。<br>PE=\${l.pe}，国债收益率=\${l.bondYield}%。\`;
  else if(l.erp>1)text=\`当前 ERP 为 <b>\${l.erp}%</b>，处于中等水平。建议均衡配置股债。<br>PE=\${l.pe}，国债收益率=\${l.bondYield}%。\`;
  else if(l.erp>0)text=\`当前 ERP 为 <b>\${l.erp}%</b>，处于较低水平。注意风险控制。<br>PE=\${l.pe}，国债收益率=\${l.bondYield}%。\`;
  else text=\`当前 ERP 为 <b>\${l.erp}%</b>，已为负值。债券收益率高于股票收益率，权益资产不具备吸引力。\`;
  document.getElementById('insightText').innerHTML=text;
}
function renderAllERP(){renderERPChart();renderPEBondChart();renderTurnoverChart()}
function renderERPChart(){
  const d=filterByRange(erpData,erpRange);if(!d.length)return;
  if(erpChart)erpChart.dispose();erpChart=echarts.init(document.getElementById('erpChart'));
  erpChart.setOption({tooltip:{trigger:'axis',axisPointer:{type:'cross'},backgroundColor:'rgba(255,255,255,0.96)',borderColor:'#eee',textStyle:{color:'#333'}},grid:{left:'3%',right:'3%',top:10,bottom:60,containLabel:true},xAxis:{type:'category',data:d.map(i=>i.date),axisLine:{lineStyle:{color:'#e5e7eb'}},axisLabel:{color:'#6b7280',formatter:v=>v.slice(0,7)},axisTick:{show:false}},yAxis:[{type:'value',name:'ERP (%)',nameTextStyle:{color:'#3b82f6'},axisLabel:{color:'#3b82f6'},splitLine:{lineStyle:{type:'dashed',color:'#f1f5f9'}}},{type:'value',name:'沪深300',nameTextStyle:{color:'#f97316'},axisLabel:{color:'#f97316',formatter:v=>(v/1000).toFixed(1)+'k'},splitLine:{show:false}}],dataZoom:[{type:'slider',bottom:0,height:28,borderColor:'transparent',backgroundColor:'#f8fafc',fillerColor:'rgba(59,130,246,0.12)',handleStyle:{color:'#fff',borderColor:'#cbd5e1'},textStyle:{color:'transparent'}}],series:[{name:'ERP',type:'line',yAxisIndex:0,data:d.map(i=>i.erp),itemStyle:{color:'#3b82f6'},lineStyle:{width:1.5},showSymbol:false,smooth:true},{name:'沪深300',type:'line',yAxisIndex:1,data:d.map(i=>i.close||0),itemStyle:{color:'#f97316'},lineStyle:{width:1.5},showSymbol:false,smooth:true},{name:'买点',type:'scatter',yAxisIndex:0,symbolSize:6,data:d.map(i=>(i.erp>=5.8&&i.erp<=6.2)?i.erp:null),itemStyle:{color:'#ef4444'}},{name:'卖点',type:'scatter',yAxisIndex:0,symbolSize:6,data:d.map(i=>(i.erp>=1.8&&i.erp<=2.2)?i.erp:null),itemStyle:{color:'#22c55e'}}]});
}
function renderPEBondChart(){
  const d=filterByRange(erpData,erpRange);if(!d.length)return;
  if(peBondChart)peBondChart.dispose();peBondChart=echarts.init(document.getElementById('peBondChart'));
  peBondChart.setOption({tooltip:{trigger:'axis',backgroundColor:'rgba(255,255,255,0.96)',borderColor:'#eee',textStyle:{color:'#333'}},grid:{left:'3%',right:'3%',top:10,bottom:30,containLabel:true},xAxis:{type:'category',data:d.map(i=>i.date),axisLine:{lineStyle:{color:'#e5e7eb'}},axisLabel:{color:'#6b7280',formatter:v=>v.slice(0,7)},axisTick:{show:false}},yAxis:[{type:'value',name:'PE',nameTextStyle:{color:'#22c55e'},axisLabel:{color:'#22c55e'},splitLine:{lineStyle:{type:'dashed',color:'#f1f5f9'}}},{type:'value',name:'%',nameTextStyle:{color:'#ef4444'},axisLabel:{color:'#ef4444'},splitLine:{show:false}}],series:[{name:'PE',type:'line',yAxisIndex:0,data:d.map(i=>i.pe),itemStyle:{color:'#22c55e'},lineStyle:{width:1.5},showSymbol:false,smooth:true},{name:'国债',type:'line',yAxisIndex:1,data:d.map(i=>i.bondYield),itemStyle:{color:'#ef4444'},lineStyle:{width:1.5},showSymbol:false,smooth:true}]});
}
function renderTurnoverChart(){
  const d=filterByRange(turnoverData,turnRange);if(!d.length)return;
  if(turnChart)turnChart.dispose();turnChart=echarts.init(document.getElementById('turnoverChart'));
  turnChart.setOption({tooltip:{trigger:'axis',backgroundColor:'rgba(255,255,255,0.96)',borderColor:'#eee',textStyle:{color:'#333'}},grid:[{left:'3%',right:'8%',top:0,height:'48%'},{left:'3%',right:'8%',top:'55%',height:'45%'}],xAxis:[{type:'category',gridIndex:0,data:d.map(i=>i.date),axisLabel:{show:false},axisTick:{show:false}},{type:'category',gridIndex:1,data:d.map(i=>i.date),axisLine:{lineStyle:{color:'#e5e7eb'}},axisLabel:{color:'#6b7280',formatter:v=>v.slice(0,7)},axisTick:{show:false}}],yAxis:[{type:'value',gridIndex:0,scale:true,name:'上证指数',nameTextStyle:{color:'#ef4444'},axisLabel:{color:'#ef4444'},splitLine:{lineStyle:{type:'dashed',color:'#f1f5f9'}}},{type:'value',gridIndex:1,name:'成交额(亿)',nameTextStyle:{color:'#10b981'},axisLabel:{color:'#10b981',formatter:v=>(v/1e4).toFixed(1)+'万亿'},splitLine:{lineStyle:{type:'dashed',color:'#f1f5f9'}}}],series:[{name:'上证',type:'line',xAxisIndex:0,yAxisIndex:0,data:d.map(i=>i.shIndex),itemStyle:{color:'#ef4444'},lineStyle:{width:1.5},showSymbol:false,smooth:true},{name:'成交额',type:'line',xAxisIndex:1,yAxisIndex:1,data:d.map(i=>i.turnover),itemStyle:{color:'#10b981'},lineStyle:{width:1.5},showSymbol:false,smooth:true}]});
}
document.getElementById('erpFilter').addEventListener('click',function(e){
  const btn=e.target.closest('.filter-pill');if(!btn)return;
  this.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  erpRange=parseInt(btn.dataset.range);renderERPChart();renderPEBondChart();
});
document.getElementById('turnFilter').addEventListener('click',function(e){
  const btn=e.target.closest('.filter-pill');if(!btn)return;
  this.querySelectorAll('.filter-pill').forEach(b=>b.classList.remove('active'));btn.classList.add('active');
  turnRange=parseInt(btn.dataset.range);renderTurnoverChart();
});
window.addEventListener('resize',()=>{if(erpChart)erpChart.resize();if(peBondChart)peBondChart.resize();if(turnChart)turnChart.resize()});

// ============ Global Indices ============
let globalPrevData={};
function animGlobal(el,val,dec){
  const old=globalPrevData[el.id]||0;
  if(Math.abs(old-val)<0.001){el.textContent=val.toFixed(dec);return}
  const s=performance.now();
  (function tick(now){
    const t=Math.min((now-s)/400,1);
    el.textContent=(old+(val-old)*(1-Math.pow(1-t,3))).toFixed(dec);
    if(t<1)requestAnimationFrame(tick);
  })(s);
  globalPrevData[el.id]=val;
}
const GLOBAL_TAG_MAP={NDX:'gtag-us',INX:'gtag-us',DJI:'gtag-us'};
const GLOBAL_LABEL_MAP={NDX:'美股',INX:'美股',DJI:'美股'};
async function loadGlobalIndices(){
  try{
    const r=await fetch('/api/global-indices');
    const d=await r.json();
    if(!d.success)return;
    const list=d.data;
    const grid=document.getElementById('idxGrid');
    const existing=grid.querySelectorAll('[id^="gi_"]');
    if(!existing.length){
      list.forEach(i=>{
        const id=i.code;
        const cls=i.change>0?'up':i.change<0?'down':'flat';
        const tagClass=GLOBAL_TAG_MAP[id]||'gtag-fund';
        const tagLabel=GLOBAL_LABEL_MAP[id]||'指数';
        const div=document.createElement('div');
        div.className='idx-card '+cls;
        div.id='gi_'+id;
        div.innerHTML=\`<div class="name">\${i.name} <span class="gtag \${tagClass}">\${tagLabel}</span></div><div class="price" id="gp_\${id}">\${i.price}</div><div class="change"><span id="gc_\${id}">\${i.change>0?'+':''}\${i.change}%</span></div>\`;
        grid.appendChild(div);
      });
    }
    list.forEach(i=>{
      const id=i.code;
      const card=document.getElementById('gi_'+id);
      const p=document.getElementById('gp_'+id);
      const c=document.getElementById('gc_'+id);
      if(!p)return;
      card.className='idx-card '+(i.change>0?'up':i.change<0?'down':'flat');
      p.className='price '+(i.change>0?'up':i.change<0?'down':'flat');
      animGlobal(p,i.price,2);
      c.className=i.change>0?'up':i.change<0?'down':'flat';
      c.textContent=(i.change>0?'+':'')+i.change+'%';
    });
  }catch(e){}
}

// ============ Init ============
loadIndices();
setInterval(()=>{if(document.getElementById('page-indices').classList.contains('active'))loadIndices()},60000);
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
