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

  return false;
}

module.exports = { handlePositionConfigRoutes };
