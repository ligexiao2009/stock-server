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

const PORT = 4000;

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
  const configs = await db.getAllConfigs();
  const cronTime = process.env.ALERT_TIME || configs.alertTime || '0 22 * * *';

  // 清理旧任务
  ['cronJob', 'profitCronJobs', 'confirmCronJob', 'alertCheckCronJob', 'alertResetCronJob', 'intradaySnapshotJob', 'hkCloseSnapshotJob', 'nightSnapshotJob', 'cryptoSnapshotJob', 'snapshotBackupJob']
    .forEach(k => { if (global[k]) { if (Array.isArray(global[k])) global[k].forEach(j => j.stop()); else global[k].stop(); } });

  // 基金提醒
  global.cronJob = cron.schedule(cronTime, () => checkFundsAndAlert(),
    { timezone: 'Asia/Shanghai' });

  // 每日收益（周一到周五 23:00）
  // 每天 20:00/21:00/22:00/23:00 各执行一次，净值更新后尽快记录
  global.profitCronJobs = ['0 0 20 * * 1-5', '0 0 21 * * 1-5', '0 0 22 * * 1-5', '0 0 23 * * 1-5'].map(t =>
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

  // 盘中收益快照（交易时间每5分钟，覆盖A股+港股，16:15后停止）
  global.intradaySnapshotJob = cron.schedule('*/5 9-16 * * 1-5', () => {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    if (h > 16 || (h === 16 && m > 15)) return;
    takeSnapshot().catch(e => console.error('盘中快照失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // 港股收盘快照（16:10）
  global.hkCloseSnapshotJob = cron.schedule('10 16 * * 1-5', () => {
    takeSnapshot().catch(e => console.error('港股收盘快照失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // 晚间最终快照（23:30，等基金净值更新完）
  global.nightSnapshotJob = cron.schedule('30 23 * * 1-5', () => {
    takeSnapshot().catch(e => console.error('晚间快照失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

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

  console.log(`定时任务已设置: 基金提醒 ${cronTime}, AI批量分析 工作日15:20, 收益计算 工作日20:00/21:00/22:00/23:00, 自动确认 09:00, 盘中快照 9:30-15:00每5分钟, 港股收盘 16:10, 晚间 23:30, 加密币 24/7每5分钟, 快照清理 每天00:05`);
}

// ==================== 启动服务器 ====================
async function startServer() {
  try {
    await db.initDatabase();
    console.log('数据库连接初始化完成');

    await initConfig();
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
  const isPublic = !req.url.startsWith('/api/') || req.url === '/api/config' || req.url.startsWith('/api/trigger-') || req.url.startsWith('/api/indices') || req.url.startsWith('/api/ai-analysis') || req.url.startsWith('/api/ai-chat') || req.url === '/api/market-status';
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

  res.writeHead(404);
  res.end('Not Found');
});
