/**
 * 数码设备路由
 */
const db = require('../db/db');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

async function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch) return reject(new Error('No boundary'));

    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const buffer = Buffer.concat(chunks);
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      const parts = [];
      let start = 0;

      while (true) {
        const idx = buffer.indexOf(boundaryBuffer, start);
        if (idx === -1) break;
        if (start > 0) {
          const part = buffer.subarray(start, idx);
          const headerEnd = part.indexOf('\r\n\r\n');
          if (headerEnd !== -1) {
            const header = part.subarray(0, headerEnd).toString();
            const body = part.subarray(headerEnd + 4, part.length - 2); // remove trailing \r\n
            const filenameMatch = header.match(/filename="(.+?)"/);
            if (filenameMatch) {
              parts.push({ filename: filenameMatch[1], data: body });
            }
          }
        }
        start = idx + boundaryBuffer.length + 2; // skip \r\n after boundary
      }
      resolve(parts);
    });
    req.on('error', reject);
  });
}

async function handleDigitalDeviceRoutes(req, res, { userId }) {
  // GET /api/digital-devices/:id (must be before list route)
  if (req.method === 'GET' && req.url.match(/^\/api\/digital-devices\/[^/]+$/) && !req.url.includes('/photos')) {
    try {
      const id = req.url.split('/api/digital-devices/')[1];
      const device = await db.getDigitalDevice(id, userId);
      if (!device) { sendJson(res, 404, { error: '设备不存在' }); return true; }
      sendJson(res, 200, device);
    } catch (e) {
      console.error('获取设备详情失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/digital-devices
  if (req.method === 'GET' && req.url.startsWith('/api/digital-devices') && !req.url.includes('/photos')) {
    try {
      const devices = await db.getDigitalDevices(userId);
      sendJson(res, 200, devices);
    } catch (e) {
      console.error('获取设备列表失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // POST /api/digital-devices
  if (req.method === 'POST' && req.url === '/api/digital-devices') {
    try {
      const body = await readBody(req);
      const device = {
        id: body.id || crypto.randomUUID(),
        userId,
        name: body.name,
        brand: body.brand,
        category: body.category,
        purchasePrice: body.purchasePrice || body.purchase_price,
        purchaseDate: body.purchaseDate || body.purchase_date,
        color: body.color || '',
        storage: body.storage || '',
        purchaseChannel: body.purchaseChannel || body.purchase_channel || '',
        notes: body.notes || '',
        status: body.status || 'inUse',
        salePrice: body.salePrice || body.sale_price || 0,
        saleDate: body.saleDate || body.sale_date || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      const created = await db.createDigitalDevice(device);
      sendJson(res, 201, created);
    } catch (e) {
      console.error('创建设备失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // PUT /api/digital-devices/:id
  if (req.method === 'PUT' && req.url.match(/^\/api\/digital-devices\/[^/]+$/)) {
    try {
      const id = req.url.split('/api/digital-devices/')[1];
      const body = await readBody(req);
      const device = {
        name: body.name,
        brand: body.brand,
        category: body.category,
        purchasePrice: body.purchasePrice || body.purchase_price,
        purchaseDate: body.purchaseDate || body.purchase_date,
        color: body.color || '',
        storage: body.storage || '',
        purchaseChannel: body.purchaseChannel || body.purchase_channel || '',
        notes: body.notes || '',
        status: body.status || 'inUse',
        salePrice: body.salePrice || body.sale_price || 0,
        saleDate: body.saleDate || body.sale_date || null
      };
      const updated = await db.updateDigitalDevice(id, userId, device);
      if (!updated) { sendJson(res, 404, { error: '设备不存在' }); return true; }
      sendJson(res, 200, updated);
    } catch (e) {
      console.error('更新设备失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // DELETE /api/digital-devices/:id
  if (req.method === 'DELETE' && req.url.match(/^\/api\/digital-devices\/[^/]+$/)) {
    try {
      const id = req.url.split('/api/digital-devices/')[1];
      await db.deleteDigitalDevice(id, userId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('删除设备失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // POST /api/digital-devices/:id/photos
  if (req.method === 'POST' && req.url.match(/^\/api\/digital-devices\/[^/]+\/photos$/)) {
    try {
      const deviceId = req.url.split('/api/digital-devices/')[1].split('/')[0];
      const parts = await readMultipart(req);
      if (parts.length === 0) { sendJson(res, 400, { error: '没有文件' }); return true; }

      const uploadDir = path.join(__dirname, '../../uploads/digital-devices', deviceId);
      fs.mkdirSync(uploadDir, { recursive: true });

      const results = [];
      for (const part of parts) {
        const fileName = `${Date.now()}-${part.filename}`;
        const filePath = path.join(uploadDir, fileName);
        fs.writeFileSync(filePath, part.data);
        const photo = await db.addDigitalDevicePhoto(deviceId, userId, fileName, `/uploads/digital-devices/${deviceId}/${fileName}`, results.length);
        results.push(photo);
      }
      sendJson(res, 201, results[0]);
    } catch (e) {
      console.error('上传照片失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // DELETE /api/digital-devices/:deviceId/photos/:photoId
  if (req.method === 'DELETE' && req.url.match(/^\/api\/digital-devices\/[^/]+\/photos\/[^/]+$/)) {
    try {
      const parts = req.url.split('/');
      const photoId = parts[parts.length - 1];
      await db.deleteDigitalDevicePhoto(photoId, userId);
      sendJson(res, 200, { success: true });
    } catch (e) {
      console.error('删除照片失败:', e);
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleDigitalDeviceRoutes };
