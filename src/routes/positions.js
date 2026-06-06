/**
 * 持仓路由 — CRUD
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

async function handlePositionRoutes(req, res, { userId, sendCachedJson, invalidateCache, invalidateCacheByPrefix, loadCodeFixMap }) {
  // GET /api/data — 获取所有持仓
  if (req.method === 'GET' && req.url === '/api/data') {
    try {
      await sendCachedJson(req, res, 'data', async () => {
        const rows = await db.getPositions(userId);
        return { rows };
      });
    } catch (error) {
      console.error('Error getting positions:', error);
      sendJson(res, 500, { error: 'Failed to get data' });
    }
    return true;
  }

  // POST /api/save-row — 保存单行
  if (req.method === 'POST' && req.url === '/api/save-row') {
    try {
      const rowData = await readJsonBody(req);

      if (typeof rowData.shares === 'number') rowData.shares = parseFloat(rowData.shares.toFixed(4));
      if (typeof rowData.cost === 'number') rowData.cost = parseFloat(rowData.cost.toFixed(4));

      let existingPosition = null;
      if (rowData.id) existingPosition = await db.getPosition(rowData.id);
      if (!existingPosition && rowData.code && rowData.isFund !== undefined) {
        existingPosition = await db.getPositionByCode(rowData.code, rowData.isFund, userId);
      }

      const isOverseas = rowData.categoryId === 'us_stock';
      if (existingPosition) {
        // 如果是0股清仓状态重新加仓，扣除现金
        if (existingPosition.shares === 0 && rowData.shares > 0) {
          const cashAmount = rowData.shares * rowData.cost;
          if (rowData.isFund) {
            await db.adjustAlipayCash(userId, -cashAmount);
            console.log(`[加仓-恢复] ${rowData.code} ${rowData.name} 基金扣减支付宝 ¥${cashAmount.toFixed(0)}`);
          } else {
            await db.adjustThsCash(userId, -cashAmount);
            console.log(`[加仓-恢复] ${rowData.code} ${rowData.name} 股票扣减同花顺 ¥${cashAmount.toFixed(0)}`);
          }
        }
        await db.updatePosition(existingPosition.id, {
          code: rowData.code, name: rowData.name,
          shares: rowData.shares, cost: rowData.cost,
          isFund: rowData.isFund, isOverseas,
          planBuy: rowData.planBuy || 0, alert: rowData.alert || null,
          targetPrice: rowData.targetPrice || null, categoryId: rowData.categoryId || null,
        });
      } else {
        const newId = rowData.id || Date.now().toString() + Math.random().toString(36).substr(2, 9);
        await db.createPosition({
          id: newId, code: rowData.code, name: rowData.name,
          shares: rowData.shares, cost: rowData.cost,
          isFund: rowData.isFund || false, isOverseas,
          planBuy: rowData.planBuy || 0, alert: rowData.alert || null,
          targetPrice: rowData.targetPrice || null, categoryId: rowData.categoryId || null,
          userId,
        });

        // 建仓自动扣减对应现金
        const cashAmount = rowData.shares * rowData.cost;
        if (rowData.isFund) {
          await db.adjustAlipayCash(userId, -cashAmount);
          console.log(`[建仓] ${rowData.code} ${rowData.name} 基金扣减支付宝 ¥${cashAmount.toFixed(0)}`);
        } else {
          await db.adjustThsCash(userId, -cashAmount);
          console.log(`[建仓] ${rowData.code} ${rowData.name} 股票扣减同花顺 ¥${cashAmount.toFixed(0)}`);
        }

        // 建仓自动创建一条交易记录
        const now = new Date();
        const beijingTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const createdAt = beijingTime.toISOString().replace('T', ' ').slice(0, 19);
        const localDate = beijingTime.toISOString().slice(0, 10);
        const amount = (rowData.shares || 0) * (rowData.cost || 0);
        await db.createTradeRecord({
          id: `${newId}-${Date.now()}`,
          rowId: newId,
          type: 'add',
          amount: Math.round(amount * 100) / 100,
          shares: rowData.shares,
          netValue: rowData.cost,
          isBefore15: true,
          createdAt,
          localDate,
          userId,
        });
      }

      invalidateCache('data');
      invalidateCacheByPrefix('quotes:');

      sendJson(res, 200, { success: true, message: '保存成功' });
    } catch (e) {
      console.error('Save row error:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/delete-row — 删除单行
  if (req.method === 'POST' && req.url === '/api/delete-row') {
    try {
      const { id, code, isFund } = await readJsonBody(req);
      let posToDelete = null;
      if (id) posToDelete = await db.getPosition(id);
      if (!posToDelete && code && isFund !== undefined) posToDelete = await db.getPositionByCode(code, isFund, userId);
      if (!posToDelete) { sendJson(res, 404, { error: '持仓不存在' }); return true; }

      await db.deletePosition(posToDelete.id);

      // 删除后退还现金
      const refundAmount = posToDelete.shares * posToDelete.cost;
      if (posToDelete.isFund) {
        await db.adjustAlipayCash(userId, refundAmount);
        console.log(`[清仓] ${posToDelete.code} ${posToDelete.name} 基金退还支付宝 ¥${refundAmount.toFixed(0)}`);
      } else {
        await db.adjustThsCash(userId, refundAmount);
        console.log(`[清仓] ${posToDelete.code} ${posToDelete.name} 股票退还同花顺 ¥${refundAmount.toFixed(0)}`);
      }

      invalidateCache('data');
      invalidateCacheByPrefix('quotes:');

      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('Delete row error:', e);
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  // POST /api/update-category — 更新分类
  if (req.method === 'POST' && req.url === '/api/update-category') {
    try {
      const { id, categoryId } = await readJsonBody(req);
      await db.updatePosition(id, { categoryId, isOverseas: categoryId === 'us_stock' });
      invalidateCache('data');
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 400, { success: false, message: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handlePositionRoutes };
