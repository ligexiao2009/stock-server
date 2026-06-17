/**
 * 投资助手 - 后端服务主入口
 * 端口 4000，提供持仓管理、行情查询、基金分析等 API
 */
require('dotenv').config();

// 给 console.log/error/warn 加上时间戳
['log', 'error', 'warn'].forEach(method => {
  const original = console[method];
  console[method] = (...args) => {
    const ts = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
    original(`[${ts}]`, ...args);
  };
});

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const db = require('./db/db');

// 中间件
const { authRequired } = require('./middleware/auth');
const { sendCachedJson, invalidateCache, invalidateCacheByPrefix, QUOTES_CACHE_TTL_MS, KLINE_CACHE_TTL_MS } = require('./middleware/cache');

// 工具
const { fetchQuotesBatch } = require('./utils/quotes');

// 服务
const { checkFundsAndAlert } = require('./services/fund-alert');
const { calculateAndSaveDailyProfit } = require('./services/daily-profit');
const { autoConfirmPendingTrades } = require('./services/auto-confirm');
const { sendWechatMessage, initServerchanKey } = require('./services/wechat');
const { takeAssetSnapshot } = require('./services/asset-snapshot');
const { takeSnapshot } = require('./services/intraday-snapshot');
const { takeCryptoSnapshot } = require('./services/crypto-snapshot');

// 路由模块
const { handleAuthRoutes } = require('./routes/auth');
const { handlePositionRoutes } = require('./routes/positions');
const { handleTradeRoutes } = require('./routes/trades');
const { handleCategoryRoutes } = require('./routes/categories');
const { handleAssetRoutes } = require('./routes/assets');
const { handleFundRoutes } = require('./routes/fund');
const { handleMarketRoutes } = require('./routes/market');
const { handleConfigRoutes } = require('./routes/config');
const { handleAIAnalysisRoutes } = require('./routes/ai-analysis');
const { handleDailyProfitRoutes } = require('./routes/daily-profit');
const { handleAlertRulesRoutes, checkPriceAlerts } = require('./routes/alert-rules');
const { handleFundScreenshotRoutes, loadCodeFixMap } = require('./routes/fund-screenshot');
const { handleNotesRoutes } = require('./routes/notes');
const { handleCountdownRoutes } = require('./routes/countdown');
const { handlePositionConfigRoutes } = require('./routes/position-config');

// ==================== ERP 数据获取（PE 1/PE  - 国债收益率） ====================
let erpCache = null;
let erpCacheTime = 0;
const ERP_CACHE_TTL = 4 * 60 * 60 * 1000; // 4小时缓存

function fetchPEData() {
  return new Promise(async (resolve, reject) => {
    const token = await db.getConfig('legulegu_token') || '6ab6759cd8833f9f56093a0bba03095e';
    https.get({
      hostname: 'www.legulegu.com',
      path: '/stockdata',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
    }, (mainRes) => {
      const cookies = (mainRes.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
      let body = '';
      mainRes.on('data', chunk => body += chunk);
      mainRes.on('end', () => {
        https.get({
          hostname: 'www.legulegu.com',
          path: '/api/stockdata/index-basic-pe?indexCode=000300.SH&token=' + token,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
            'Referer': 'https://www.legulegu.com/stockdata',
            'Cookie': cookies,
          },
        }, (apiRes) => {
          let apiBody = '';
          apiRes.on('data', chunk => apiBody += chunk);
          apiRes.on('end', () => {
            try {
              const data = JSON.parse(apiBody);
              resolve(data.data || []);
            } catch (e) {
              reject(new Error('PE数据解析失败: ' + e.message));
            }
          });
        }).on('error', reject);
      });
    }).on('error', reject);
  });
}

function readBondYieldMap() {
  const raw = JSON.parse(fs.readFileSync('/Users/yangyang/data/shinianqi.json', 'utf8'));
  const series = raw.data['c:14583'].series[0];
  const map = new Map();
  for (const [date, value] of series) {
    map.set(date, parseFloat(value));
  }
  return map;
}

async function getERPData() {
  if (erpCache && Date.now() - erpCacheTime < ERP_CACHE_TTL) {
    return erpCache;
  }
  const [peData, bondMap] = await Promise.all([
    fetchPEData(),
    Promise.resolve(readBondYieldMap()),
  ]);
  const result = [];
  for (const item of peData) {
    const date = item.date;
    const bondYield = bondMap.get(date);
    if (bondYield != null && item.addTtmPe > 0) {
      result.push({
        date,
        close: Math.round(item.close * 100) / 100,
        pe: Math.round(item.addTtmPe * 100) / 100,
        bondYield,
        erp: Math.round(((100 / item.addTtmPe) - bondYield) * 100) / 100,
      });
    }
  }
  erpCache = result;
  erpCacheTime = Date.now();
  console.log(`[ERP] 数据更新: ${result.length}条, 最新 PE=${result[result.length-1]?.pe} 国债=${result[result.length-1]?.bondYield}% ERP=${result[result.length-1]?.erp}%`);
  return result;
}

// ==================== 两市成交额 ====================
let turnoverCache = null;
let turnoverCacheTime = 0;
const TURNOVER_CACHE_TTL = 60 * 60 * 1000; // 1小时

/** 新浪日K线 → { date, close, volume } */
function fetchIndexKline(symbol) {
  return new Promise((resolve, reject) => {
    const url = `http://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=2000`;
    http.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn/' } }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const buf = Buffer.concat(chunks);
          const text = new TextDecoder('gb18030').decode(buf);
          resolve(JSON.parse(text));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function getMarketTurnover() {
  if (turnoverCache && Date.now() - turnoverCacheTime < TURNOVER_CACHE_TTL) return turnoverCache;

  try {
    const [sh, sz] = await Promise.all([
      fetchIndexKline('sh000001'),
      fetchIndexKline('sz399001'),
    ]);

    // Build map: date → { vol, close }
    const shMap = new Map();
    for (const bar of sh) {
      shMap.set(bar.day, {
        vol: parseFloat(bar.volume) || 0,
        close: parseFloat(bar.close) || 0,
      });
    }
    const szMap = new Map();
    for (const bar of sz) {
      szMap.set(bar.day, parseFloat(bar.volume) || 0);
    }

    const result = [];
    for (const [date, shData] of shMap) {
      const szVol = szMap.get(date);
      if (szVol != null && shData.close > 0) {
        // 新浪volume单位是股, 成交额 ≈ 股数 × 均价
        // 均价 ≈ 指数点位/200（东方财富真实数据拟合）
        const ratio = shData.close / 200;
        const shTurnover = shData.vol * ratio;
        const szTurnover = szVol * ratio;
        result.push({
          date,
          turnover: Math.round((shTurnover + szTurnover) / 1e8),
          shIndex: Math.round(shData.close * 100) / 100,
        });
      }
    }

  turnoverCache = result;
  turnoverCacheTime = Date.now();
  const latest = result[result.length - 1];
  console.log(`[成交额] 数据更新: ${result.length}条, 最新 ${latest?.date} 成交${latest?.turnover}亿 上证${latest?.shIndex}`);
  try { fs.writeFileSync(path.join(__dirname, '..', 'data', 'turnover.json'), JSON.stringify(result), 'utf8'); } catch (_) {}
  return result;
  } catch (e) {
    console.error('[成交额] 请求失败:', e.message);
    if (turnoverCache) return turnoverCache;
    try {
      const raw = fs.readFileSync(path.join(__dirname, '..', 'data', 'turnover.json'), 'utf8');
      const fallback = JSON.parse(raw);
      if (Array.isArray(fallback) && fallback.length > 0) {
        console.log(`[成交额] 使用本地缓存: ${fallback.length}条`);
        return fallback;
      }
    } catch (_) {}
    throw e;
  }
}

const PORT = process.env.SERVER_PORT || 4000;

// ==================== 配置初始化 ====================
async function initConfig() {
  try {
    const configs = await db.getAllConfigs();

    // 设置默认配置
    if (!configs.serverchanKey) {
      await db.setConfig('serverchanKey', process.env.SERVERCHAN_KEY || '');
    }
    if (!configs.alertTime) {
      await db.setConfig('alertTime', process.env.ALERT_TIME || '0 22 * * *');
    }
    if (!configs.editUnlockPassword) {
      await db.setConfig('editUnlockPassword', process.env.EDIT_UNLOCK_PASSWORD || '8957');
    }

    await initServerchanKey();
    await loadCodeFixMap();
  } catch (error) {
    console.error('初始化配置失败:', error);
    await initServerchanKey();
  }
}

// ==================== 定时任务 ====================
async function setupCronJob() {
  if (process.env.CRON_ENABLED === 'false') {
    console.log('定时任务已禁用 (CRON_ENABLED=false)');
    return;
  }
  const configs = await db.getAllConfigs();
  const cronTime = process.env.ALERT_TIME || configs.alertTime || '0 22 * * *';

  // 清理旧任务
  ['cronJob', 'profitCronJobs', 'confirmCronJob', 'alertCheckCronJob', 'alertResetCronJob', 'intradaySnapshotJob', 'hkCloseSnapshotJob', 'cryptoSnapshotJob', 'snapshotBackupJob', 'aiAnalysisJob', 'assetSnapshotJob', 'bondYieldUpdateJob']
    .forEach(k => { if (global[k]) { if (Array.isArray(global[k])) global[k].forEach(j => j.stop()); else global[k].stop(); } });

  // 基金提醒（暂时关闭微信推送）
  // global.cronJob = cron.schedule(cronTime, () => checkFundsAndAlert(),
  //   { timezone: 'Asia/Shanghai' });

  // 每日收益（周一到周五 23:00）
  // 每天 20:00/21:00/22:00/23:00 各执行一次，净值更新后尽快记录
  global.profitCronJobs = ['0 0 20 * * 1-5', '0 0 21 * * 1-5', '0 0 22 * * 1-5', '0 30 22 * * 1-5'].map(t =>
    cron.schedule(t, () => calculateAndSaveDailyProfit(), { timezone: 'Asia/Shanghai' })
  );

  // 自动确认交易（每天 09:00）
  global.confirmCronJob = cron.schedule('0 3 0 * * *', () =>
    autoConfirmPendingTrades(invalidateCache, invalidateCacheByPrefix),
    { timezone: 'Asia/Shanghai' });

  // 股票涨跌幅提醒（交易时间每分钟）
  // global.alertCheckCronJob = cron.schedule('* 9-11,13-14 * * 1-5', () => {
  //   const now = new Date();
  //   const hour = now.getHours();
  //   const minute = now.getMinutes();
  //   const isMorning = (hour === 9 && minute >= 30) || (hour === 10) || (hour === 11 && minute <= 30);
  //   const isAfternoon = hour === 13 || hour === 14 || (hour === 15 && minute === 0);
  //   if (isMorning || isAfternoon) checkPriceAlerts(fetchQuotesBatch, sendWechatMessage);
  // }, { timezone: 'Asia/Shanghai' });

  // 开盘前重置提醒状态
  global.alertResetCronJob = cron.schedule('25 9 * * 1-5', () => {
    console.log('重置股票涨跌幅提醒状态...');
    db.resetAlertRulesDaily();
  }, { timezone: 'Asia/Shanghai' });

  // 盘中收益快照（交易时间每1分钟，覆盖A股+港股，16:15后停止）
  global.intradaySnapshotJob = cron.schedule('* 9-16 * * 1-5', () => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    if (h > 16 || (h === 16 && m > 15)) return;
    takeSnapshot().catch(e => console.error('盘中快照失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // 港股收盘快照（16:10）
  global.hkCloseSnapshotJob = cron.schedule('10 16 * * 1-5', () => {
    takeSnapshot().catch(e => console.error('港股收盘快照失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // 补仓信号检测（工作日 10:00 + 14:30）
  if (process.env.SERVERCHAN_KEY) {
    const { checkIndexDrawdownAlerts } = require('./services/index-alert');
    ['0 10 * * 1-5', '30 14 * * 1-5'].forEach(t =>
      cron.schedule(t, () => checkIndexDrawdownAlerts(), { timezone: 'Asia/Shanghai' })
    );
  }

  // 加密币快照（24/7 每5分钟）
  global.cryptoSnapshotJob = cron.schedule('*/5 * * * *', () => {
    takeCryptoSnapshot().catch(e => console.error('加密币快照失败:', e.message));
  });

  // AI 批量分析持仓股票（工作日 15:20，收盘后触发）
  global.aiAnalysisJob = cron.schedule('20 15 * * 1-5', async () => {
    try {
      const { exec } = require('child_process');
      const positions = await db.getPositions() || [];
      const codes = [...new Set(
        positions
          .filter(p => !p.isFund && /^\d+$/.test(p.code))
          .map(p => p.code)
          .filter(Boolean)
      )];
      if (codes.length === 0) {
        console.log('[AI分析] 没有持仓股票，跳过批量分析');
        return;
      }
      const codeList = codes.join(',');
      const pyDir = process.env.AI_ANALYSIS_DIR || '/Users/yangyang/git/daily_stock_analysis';
      const useProxy = process.env.AI_USE_PROXY ? `HTTP_PROXY=${process.env.AI_USE_PROXY} HTTPS_PROXY=${process.env.AI_USE_PROXY}` : '';
      const python = process.env.AI_USE_VENV === 'true' ? 'venv/bin/python3' : 'python3';
      console.log(`[AI分析] 开始批量分析 ${codes.length} 只股票: ${codeList}`);
      exec(
        `cd ${pyDir} && ${useProxy} ${python} main.py --stocks ${codeList} --no-market-review --force-run`,
        { timeout: 600000 },
        (err, stdout, stderr) => {
          if (err) {
            console.error('[AI分析] 批量分析失败:', err.message);
            if (stderr) console.error('[AI分析] stderr:', stderr);
          } else console.log('[AI分析] 批量分析完成');
        }
      );
    } catch (e) {
      console.error('[AI分析] 定时任务异常:', e.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  // 资产快照（工作日 23:30，自动记录总资产）
  global.assetSnapshotJob = cron.schedule('30 23 * * 1-5', () => {
    takeAssetSnapshot().catch(e => console.error('[资产快照] 失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // 每天 00:05 清理 7 天前的快照数据
  global.snapshotCleanupJob = cron.schedule('5 0 * * *', async () => {
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 7);
      const dateStr = `${cutoff.getFullYear()}${String(cutoff.getMonth() + 1).padStart(2, '0')}${String(cutoff.getDate()).padStart(2, '0')}`;
      const r1 = await db.query('DELETE FROM intraday_snapshots WHERE date < $1', [dateStr]);
      const r2 = await db.query('DELETE FROM crypto_snapshots WHERE date < $1', [dateStr]);
      console.log(`[快照清理] 删除 ${dateStr} 之前数据: intraday=${r1.rowCount}条, crypto=${r2.rowCount}条`);
    } catch (e) {
      console.error('快照清理失败:', e.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每天 16:30 备份当天 intraday_snapshots 到 intraday_snapshots_history
  global.snapshotBackupJob = cron.schedule('30 16 * * *', async () => {
    try {
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const count = await db.backupIntradaySnapshots(dateStr);
      console.log(`[快照备份] ${dateStr} 备份完成: ${count}条`);
    } catch (e) {
      console.error('快照备份失败:', e.message);
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每天 18:00 更新国债收益率数据
  const bondScript = '/Users/yangyang/.codex/worktrees/737a/stock/scripts/update-bond-yield.py';
  const bondPython = '/Users/yangyang/git/daily_stock_analysis/venv/bin/python3';
  global.bondYieldUpdateJob = cron.schedule('0 18 * * *', () => {
    const { exec } = require('child_process');
    exec(`${bondPython} ${bondScript}`, (err, stdout, stderr) => {
      if (err) console.error('[国债更新] 失败:', stderr || err.message);
      else {
        console.log(stdout.trim());
        erpCache = null; // 清 ERP 缓存，下次请求重新加载
      }
    });
  }, { timezone: 'Asia/Shanghai' });

  console.log(`定时任务已设置: 基金提醒 ${cronTime}, AI批量分析 工作日15:20, 收益计算 工作日20:00/21:00/22:00/23:00, 自动确认 09:00, 盘中快照 9:30-15:00每1分钟, 港股收盘 16:10, 资产快照 工作日23:30, 加密币 24/7每5分钟, 快照清理 每天00:05`);
}

// ==================== 启动服务器 ====================
async function startServer() {
  try {
    await db.initDatabase();
    console.log('数据库连接初始化完成');

    await initConfig();
    getMarketTurnover().catch(e => console.error('成交额预加载失败:', e.message));
    await setupCronJob();

    server.listen(PORT, () => {
      console.log(`\n服务器运行在 http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('服务器启动失败:', error);
    process.exit(1);
  }
}

startServer();

// ==================== HTTP 路由调度 ====================
const ctx = { sendCachedJson, invalidateCache, invalidateCacheByPrefix, QUOTES_CACHE_TTL_MS, KLINE_CACHE_TTL_MS, loadCodeFixMap, fetchQuotesBatch, sendWechatMessage };

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // 认证路由（无需登录）
  if (await handleAuthRoutes(req, res)) return;

  // 鉴权
  const isPublic = !req.url.startsWith('/api/') || req.url === '/api/config' || req.url.startsWith('/api/trigger-') || req.url.startsWith('/api/indices') || req.url.startsWith('/api/ai-analysis') || req.url.startsWith('/api/ai-chat') || req.url === '/api/market-status' || req.url === '/api/erp' || req.url === '/api/market-turnover' || req.url === '/api/global-indices';
  const auth = isPublic ? { uid: 'default' } : authRequired(req, res);
  if (!auth) return;
  const userId = auth.uid || 'default';
  if (!global._adminEmail) { global._adminEmail = process.env.ADMIN_EMAIL || (await db.getConfig('admin_email')) || ''; }
  const isAdmin = !!(auth?.email && global._adminEmail && auth.email === global._adminEmail);

  // 分发到各路由模块
  if (await handleConfigRoutes(req, res, { isAdmin, sendCachedJson, invalidateCache })) return;
  if (await handlePositionRoutes(req, res, { userId, sendCachedJson, invalidateCache, invalidateCacheByPrefix, loadCodeFixMap })) return;
  if (await handleTradeRoutes(req, res, { userId, sendCachedJson, invalidateCache, invalidateCacheByPrefix })) return;
  if (await handleCategoryRoutes(req, res, { isAdmin, sendCachedJson, invalidateCache })) return;
  if (await handleAssetRoutes(req, res, { userId, sendCachedJson, invalidateCache })) return;
  if (await handleDailyProfitRoutes(req, res, userId)) return;

  // 触发当前用户资产快照（保存仓位配置后调用）
  if (req.method === 'POST' && req.url === '/api/asset-snapshot' && userId) {
    try {
      await takeAssetSnapshot(userId);
      res.writeHead(200).end(JSON.stringify({ success: true }));
    } catch (e) {
      console.error('[资产快照] 手动触发失败:', e.message);
      res.writeHead(500).end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 盘中收益快照
  if (req.method === 'GET' && req.url.startsWith('/api/intraday-snapshots')) {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const date = urlObj.searchParams.get('date') || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    sendCachedJson(req, res, `intraday-snapshots:${date}:${userId}`, async () => {
      return await db.getIntradaySnapshots(date, userId);
    });
    return true;
  }
  if (await handleAlertRulesRoutes(req, res, ctx)) return;
  if (await handleAIAnalysisRoutes(req, res)) return;
  if (await handleFundRoutes(req, res, { userId, sendCachedJson, invalidateCache, invalidateCacheByPrefix })) return;
  if (await handleMarketRoutes(req, res, { userId, sendCachedJson, QUOTES_CACHE_TTL_MS, KLINE_CACHE_TTL_MS })) return;
  if (await handleFundScreenshotRoutes(req, res, { fetchQuotesBatch })) return;
  if (await handleNotesRoutes(req, res, { userId })) return;
  if (await handleCountdownRoutes(req, res, { userId })) return;
  if (await handlePositionConfigRoutes(req, res, { userId })) return;

  // 手动触发 (测试用)
  if (req.method === 'GET' && req.url === '/api/trigger-check') {
    checkFundsAndAlert();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: '检查已触发' }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/trigger-profit') {
    try {
      await calculateAndSaveDailyProfit();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: '每日收益计算已完成' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }
  if (req.method === 'GET' && req.url === '/api/trigger-confirm') {
    autoConfirmPendingTrades(invalidateCache, invalidateCacheByPrefix);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, message: '自动确认交易已触发' }));
    return;
  }

  // 两市成交额（无需鉴权）
  if (req.method === 'GET' && req.url === '/api/market-turnover') {
    try {
      const data = await getMarketTurnover();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (e) {
      console.error('[成交额] 获取失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  // ERP 风险溢价数据（无需鉴权）
  if (req.method === 'GET' && req.url === '/api/erp') {
    try {
      const data = await getERPData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    } catch (e) {
      console.error('[ERP] 数据获取失败:', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, message: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/api/erp-token') {
    const token = await db.getConfig('legulegu_token') || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, token }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/erp-token') {
    const body = await readJsonBody(req);
    if (body && body.token) {
      await db.setConfig('legulegu_token', body.token);
      erpCache = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});
