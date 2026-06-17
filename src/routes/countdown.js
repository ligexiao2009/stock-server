/**
 * 倒计时事件路由
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
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

async function handleCountdownRoutes(req, res, { userId }) {
  // GET /api/countdown-events
  if (req.method === 'GET' && req.url === '/api/countdown-events') {
    try {
      const events = await db.getCountdownEvents(userId);
      sendJson(res, 200, { events });
    } catch (e) {
      console.error('获取事件失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // POST /api/countdown-events
  if (req.method === 'POST' && req.url === '/api/countdown-events') {
    try {
      const { name, date } = await readBody(req);
      if (!name || !date) { sendJson(res, 400, { error: '缺少参数' }); return true; }
      const id = await db.createCountdownEvent({ name, date, userId });
      sendJson(res, 200, { success: true, id });
    } catch (e) {
      console.error('创建事件失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // DELETE /api/countdown-events/:id
  if (req.method === 'DELETE' && req.url.startsWith('/api/countdown-events/')) {
    try {
      const id = req.url.split('/api/countdown-events/')[1];
      await db.deleteCountdownEvent(id, userId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('删除事件失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // PUT /api/countdown-events/:id
  if (req.method === 'PUT' && req.url.startsWith('/api/countdown-events/')) {
    try {
      const id = req.url.split('/api/countdown-events/')[1];
      const { name, date } = await readBody(req);
      if (!name || !date) { sendJson(res, 400, { error: '缺少参数' }); return true; }
      await db.updateCountdownEvent(id, { name, date, userId });
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('更新事件失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleCountdownRoutes };
