/**
 * 待确认交易 + 交易历史路由
 */
const db = require('../db/db');

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

async function handleTradeRoutes(req, res, { userId, sendCachedJson, invalidateCache, invalidateCacheByPrefix }) {
  // ========== 待确认交易 ==========

  // GET /api/pending-trades
  if (req.method === 'GET' && req.url === '/api/pending-trades') {
    try {
      await sendCachedJson(req, res, 'pending-trades', async () => {
        const trades = await db.getPendingTrades(userId);
        return { trades };
      });
    } catch (error) {
      console.error('Error getting pending trades:', error);
      sendJson(res, 500, { error: 'Failed to get pending trades' });
    }
    return true;
  }

  // POST /api/pending-trades — 新增
  if (req.method === 'POST' && req.url === '/api/pending-trades') {
    try {
      const trade = await readJsonBody(req);
      trade.user_id = userId;
      await db.createPendingTrade(trade);
      invalidateCache('pending-trades');
      sendJson(res, 200, { success: true, message: '保存成功' });
    } catch (e) {
      console.error('Error creating pending trade:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/pending-trades/delete — 删除
  if (req.method === 'POST' && req.url === '/api/pending-trades/delete') {
    try {
      const { id } = await readJsonBody(req);
      await db.deletePendingTrade(id);
      invalidateCache('pending-trades');
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('Error deleting pending trade:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/save-pending-trades — 批量保存
  if (req.method === 'POST' && req.url === '/api/save-pending-trades') {
    try {
      const { trades } = await readJsonBody(req);
      await db.deleteAllPendingTrades(userId);
      for (const trade of trades) {
        trade.user_id = userId;
        await db.createPendingTrade(trade);
      }
      invalidateCache('pending-trades');
      sendJson(res, 200, { success: true, message: '批量保存成功' });
    } catch (e) {
      console.error('Error saving pending trades:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // ========== 交易历史 ==========

  // GET /api/trade-history
  if (req.method === 'GET' && req.url === '/api/trade-history') {
    try {
      await sendCachedJson(req, res, 'trade-history', async () => {
        const history = await db.getTradeHistory(userId);
        return { history };
      });
    } catch (error) {
      console.error('Error getting trade history:', error);
      sendJson(res, 500, { error: 'Failed to get trade history' });
    }
    return true;
  }

  // GET /api/trade-history/today — 当日交易记录
  if (req.method === 'GET' && req.url === '/api/trade-history/today') {
    try {
      const beijingNow = () => {
        const d = new Date();
        d.setHours(d.getHours() + 8); // UTC → Beijing
        return d.toISOString().slice(0, 10);
      };
      const records = await db.getTodayTrades(userId, beijingNow());
      sendJson(res, 200, { records });
    } catch (e) {
      console.error('Error getting today trades:', e);
      sendJson(res, 500, { error: 'Failed to get today trades' });
    }
    return true;
  }

  // GET /api/trade-history/:rowId
  if (req.method === 'GET' && req.url.startsWith('/api/trade-history/')) {
    try {
      const rowId = req.url.split('/api/trade-history/')[1];
      await sendCachedJson(req, res, `trade-history:${rowId}`, async () => {
        const records = await db.getTradeHistoryByRowId(rowId);
        return { records };
      });
    } catch (error) {
      console.error('Error getting trade history by rowId:', error);
      sendJson(res, 500, { error: 'Failed to get trade history' });
    }
    return true;
  }

  // POST /api/trade-history — 新增
  if (req.method === 'POST' && req.url === '/api/trade-history') {
    try {
      const { rowId, record } = await readJsonBody(req);
      const formatted = { ...record };
      if (typeof formatted.shares === 'number') formatted.shares = parseFloat(formatted.shares.toFixed(2));
      if (typeof formatted.netValue === 'number') formatted.netValue = parseFloat(formatted.netValue.toFixed(4));

      await db.createTradeRecord({
        id: formatted.id, rowId, type: formatted.type,
        amount: formatted.amount, shares: formatted.shares,
        netValue: formatted.netValue, isBefore15: formatted.isBefore15 || true,
        createdAt: formatted.createdAt, localDate: formatted.localDate || null,
        user_id: userId,
      });

      invalidateCache('trade-history', `trade-history:${rowId}`);
      sendJson(res, 200, { success: true, message: '保存成功' });
    } catch (e) {
      console.error('Error creating trade record:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/save-trade-history — 批量保存
  if (req.method === 'POST' && req.url === '/api/save-trade-history') {
    try {
      const { history } = await readJsonBody(req);

      await db.query('BEGIN');
      await db.query('DELETE FROM trade_history WHERE user_id = $1', [userId]);

      for (const [rowId, records] of Object.entries(history)) {
        for (const record of records) {
          const formatted = { ...record };
          if (typeof formatted.shares === 'number') formatted.shares = parseFloat(formatted.shares.toFixed(2));
          if (typeof formatted.netValue === 'number') formatted.netValue = parseFloat(formatted.netValue.toFixed(4));

          await db.createTradeRecord({
            id: formatted.id, rowId, type: formatted.type,
            amount: formatted.amount, shares: formatted.shares,
            netValue: formatted.netValue, isBefore15: formatted.isBefore15 || true,
            createdAt: formatted.createdAt, localDate: formatted.localDate || null,
            user_id: userId,
          });
        }
      }

      await db.query('COMMIT');
      invalidateCache('trade-history');
      invalidateCacheByPrefix('trade-history:');
      sendJson(res, 200, { success: true, message: '批量保存成功' });
    } catch (e) {
      await db.query('ROLLBACK').catch(() => {});
      console.error('Error saving trade history:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/stock-trade — 股票直接交易（不走 pending，成交价已知）
  if (req.method === 'POST' && req.url === '/api/stock-trade') {
    try {
      const { rowId, code, type, amount, shares, tradePrice } = await readJsonBody(req);
      const pos = await db.getPosition(rowId);
      if (!pos) { sendJson(res, 404, { error: '持仓不存在' }); return true; }

      const isAdd = type === 'add';
      const totalShares = isAdd ? pos.shares + shares : pos.shares - shares;
      if (totalShares < 0) { sendJson(res, 400, { error: '减仓份额超过持仓' }); return true; }

      const newCost = isAdd
        ? (pos.cost * pos.shares + amount) / totalShares
        : totalShares <= 0 ? pos.cost
        : (pos.cost * pos.shares - amount) / totalShares;

      await db.updatePosition(rowId, { shares: totalShares, cost: parseFloat(newCost.toFixed(4)) });

      const beijingNow = () => {
        const d = new Date();
        d.setHours(d.getHours() + 8);
        return d.toISOString().replace('T', ' ').slice(0, 19);
      };
      const localDate = beijingNow().slice(0, 10);
      const tradeId = `${rowId}-${Date.now()}`;

      await db.createTradeRecord({
        id: tradeId, rowId, type, amount,
        shares: parseFloat(shares.toFixed(2)),
        netValue: parseFloat(tradePrice.toFixed(4)),
        isBefore15: true,
        createdAt: beijingNow(),
        localDate,
        user_id: userId,
      });

      // 股票交易：扣除/增加同花顺现金
      const cashDelta = isAdd ? -amount : shares * tradePrice;
      await db.adjustThsCash(userId, cashDelta);
      console.log(`[${isAdd ? '加仓' : '减仓'}] ${code} 同花顺 ${isAdd ? '扣减' : '增加'} ¥${Math.abs(cashDelta).toFixed(0)}`);

      invalidateCache('trade-history', `trade-history:${rowId}`);
      sendJson(res, 200, { success: true, totalShares, newCost });
    } catch (e) {
      console.error('Error stock trade:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleTradeRoutes };
