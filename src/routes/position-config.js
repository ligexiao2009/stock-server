/**
 * 仓位管理配置路由
 */
const db = require('../db/db');

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handlePositionConfigRoutes(req, res, { userId }) {
  // GET /api/position-config
  if (req.method === 'GET' && req.url === '/api/position-config') {
    try {
      const [config, plans] = await Promise.all([
        db.getPositionConfig(userId),
        db.getBatchPlans(userId),
      ]);
      sendJson(res, 200, { config: config || {}, plans });
    } catch (e) {
      console.error('获取仓位配置失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // PUT /api/position-config
  if (req.method === 'PUT' && req.url === '/api/position-config') {
    try {
      const { config, plans } = await readBody(req);
      if (config) await db.savePositionConfig(userId, config);
      if (plans) await db.saveBatchPlans(userId, plans);
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('保存仓位配置失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/portfolio-metrics — 年化收益率 + 最大回撤
  if (req.method === 'GET' && req.url === '/api/portfolio-metrics') {
    try {
      const year = new Date().getFullYear();
      const startDate = `${year}-01-01`;
      const endDate = new Date().toISOString().slice(0, 10);

      const profits = await db.query(
        `SELECT date, total_today FROM daily_profits WHERE user_id = $1 AND date >= $2 AND date <= $3 ORDER BY date`,
        [userId || 'default', startDate, endDate]
      );

      if (profits.rows.length < 2) {
        sendJson(res, 200, { annualizedReturn: 0, maxDrawdown: 0, days: 0 });
        return true;
      }

      // Build NAV: work backwards from current value
      // Current value = positions cost + cash + today's accumulated profit
      const posConfig = await db.getPositionConfig(userId);
      const cashReserve = parseFloat(posConfig?.cash_reserve || 0);
      const positions = await db.query(
        `SELECT SUM(shares * cost) as total_cost FROM positions WHERE user_id = $1`,
        [userId || 'default']
      );
      const totalCost = parseFloat(positions.rows[0]?.total_cost || 0);

      // Start from current, subtract daily profits to get initial
      const navList = [];
      let cumulative = totalCost + cashReserve;
      navList.push({ date: profits.rows[profits.rows.length - 1].date, nav: cumulative });
      for (let i = profits.rows.length - 1; i >= 0; i--) {
        cumulative -= parseFloat(profits.rows[i].total_today) || 0;
        navList.unshift({ date: profits.rows[i].date, nav: cumulative });
      }
      const initialAsset = navList[0].nav; // This is the actual starting value, not current cost

      // Annualized return (use calendar days from first record to today)
      const firstDate = new Date(profits.rows[0].date);
      const lastDate = new Date();
      const calDays = Math.max(1, (lastDate - firstDate) / (1000 * 60 * 60 * 24));
      const days = navList.length - 1;
      const finalNav = navList[navList.length - 1].nav;
      const annualizedReturn = (Math.pow(finalNav / initialAsset, 365 / calDays) - 1) * 100;

      // Max drawdown
      let maxDD = 0;
      let peakDate = startDate;
      let troughDate = startDate;
      let peak = navList[0].nav;
      let peakAtDD = navList[0].nav;
      let peakDateAtDD = startDate;

      for (let i = 1; i < navList.length; i++) {
        const point = navList[i];
        if (point.nav > peak) {
          peak = point.nav;
          peakDate = point.date;
        }
        const dd = (peak - point.nav) / peak * 100;
        if (dd > maxDD) {
          maxDD = dd;
          peakAtDD = peak;
          troughDate = point.date;
          peakDateAtDD = peakDate;
        }
      }

      sendJson(res, 200, {
        annualizedReturn: Math.round(annualizedReturn * 100) / 100,
        maxDrawdown: Math.round(maxDD * 100) / 100,
        maxDrawdownStart: peakDateAtDD,
        maxDrawdownEnd: troughDate,
        days,
        initialAsset: Math.round(initialAsset),
        finalNav: Math.round(finalNav),
      });
    } catch (e) {
      console.error('获取投资组合指标失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/index-drawdown — 上证指数从近期高点跌幅
  if (req.method === 'GET' && req.url === '/api/index-drawdown') {
    try {
      const shIndex = await fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_day&param=sh000001,day,,,90,qfq')
        .then(r => r.text())
        .then(t => {
          const json = t.includes('=') ? t.slice(t.indexOf('=') + 1).replace(/;$/, '').trim() : t;
          const stockData = JSON.parse(json)?.data?.sh000001;
          const d = (stockData?.qfqday || stockData?.day || []);
          return d.map(item => ({ date: String(item[0]), close: parseFloat(item[2]) }));
        })
        .catch(() => []);
      if (shIndex.length < 2) {
        sendJson(res, 200, { drawdown: 0, high: 0, current: 0, highDate: '' });
        return true;
      }
      let high = shIndex[0].close, highDate = shIndex[0].date;
      for (const p of shIndex) {
        if (p.close > high) { high = p.close; highDate = p.date; }
      }
      const current = shIndex[shIndex.length - 1].close;
      const drawdown = ((high - current) / high * 100);
      sendJson(res, 200, {
        drawdown: Math.round(drawdown * 100) / 100,
        high: Math.round(high * 100) / 100,
        current,
        highDate,
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handlePositionConfigRoutes };
