const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db/db');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function handleNotesRoutes(req, res, { userId }) {
  // POST /api/notes - 创建笔记
  if (req.method === 'POST' && req.url === '/api/notes') {
    try {
      const { title, ciphertext, iv, tag } = await parseBody(req);
      if (!title || !ciphertext || !iv || !tag) {
        sendJson(res, 400, { error: '缺少必要字段' });
        return true;
      }
      const id = crypto.randomUUID();
      await db.query(
        'INSERT INTO notes (id, user_id, title, ciphertext, iv, tag) VALUES ($1, $2, $3, $4, $5, $6)',
        [id, userId, title, ciphertext, iv, tag]
      );
      sendJson(res, 201, { id, title, createdAt: new Date().toISOString() });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/notes - 笔记列表
  if (req.method === 'GET' && req.url === '/api/notes') {
    try {
      const result = await db.query(
        'SELECT id, title, created_at FROM notes WHERE user_id = $1 ORDER BY created_at DESC',
        [userId]
      );
      sendJson(res, 200, result.rows.map(r => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
      })));
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/notes/:id - 笔记详情（含密文）
  if (req.method === 'GET' && req.url.startsWith('/api/notes/')) {
    try {
      const id = req.url.split('/api/notes/')[1];
      if (!id) { sendJson(res, 400, { error: '缺少笔记ID' }); return true; }
      const result = await db.query(
        'SELECT id, title, ciphertext, iv, tag, created_at FROM notes WHERE id = $1 AND user_id = $2',
        [id, userId]
      );
      if (result.rows.length === 0) {
        sendJson(res, 404, { error: '笔记不存在' });
        return true;
      }
      const r = result.rows[0];
      sendJson(res, 200, {
        id: r.id,
        title: r.title,
        ciphertext: r.ciphertext,
        iv: r.iv,
        tag: r.tag,
        createdAt: r.created_at,
      });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // DELETE /api/notes/:id - 删除笔记
  if (req.method === 'DELETE' && req.url.startsWith('/api/notes/')) {
    try {
      const id = req.url.split('/api/notes/')[1];
      if (!id) { sendJson(res, 400, { error: '缺少笔记ID' }); return true; }
      await db.query('DELETE FROM notes WHERE id = $1 AND user_id = $2', [id, userId]);
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // PUT /api/user-keys — 存储加密后的 AES 密钥
  if (req.method === 'PUT' && req.url === '/api/user-keys') {
    try {
      const { encryptedKey, iv, tag } = await parseBody(req);
      if (!encryptedKey || !iv || !tag) {
        sendJson(res, 400, { error: '缺少必要字段' });
        return true;
      }
      await db.query(
        'INSERT INTO user_keys (user_id, encrypted_key, iv, tag, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id) DO UPDATE SET encrypted_key = $2, iv = $3, tag = $4, updated_at = NOW()',
        [userId, encryptedKey, iv, tag]
      );
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/user-keys — 获取加密后的 AES 密钥
  if (req.method === 'GET' && req.url === '/api/user-keys') {
    try {
      const result = await db.query(
        'SELECT encrypted_key, iv, tag FROM user_keys WHERE user_id = $1',
        [userId]
      );
      if (result.rows.length === 0) {
        sendJson(res, 404, { error: '未找到密钥' });
        return true;
      }
      const r = result.rows[0];
      sendJson(res, 200, { encryptedKey: r.encrypted_key, iv: r.iv, tag: r.tag });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // POST /api/change-password — 修改密码
  if (req.method === 'POST' && req.url === '/api/change-password') {
    try {
      const { oldPassword, newPassword, encryptedKey, iv, tag } = await parseBody(req);
      if (!oldPassword || !newPassword || newPassword.length < 4) {
        sendJson(res, 400, { error: '密码至少4位' });
        return true;
      }
      // 验证旧密码
      const userRes = await db.query('SELECT * FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        sendJson(res, 404, { error: '用户不存在' });
        return true;
      }
      const user = userRes.rows[0];
      const valid = await bcrypt.compare(oldPassword, user.password_hash);
      if (!valid) {
        sendJson(res, 401, { error: '旧密码错误' });
        return true;
      }
      // 更新密码
      const hash = await bcrypt.hash(newPassword, 10);
      await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, userId]);

      // 如果带了新加密的密钥，同步更新
      if (encryptedKey && iv && tag) {
        await db.query(
          'INSERT INTO user_keys (user_id, encrypted_key, iv, tag, updated_at) VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (user_id) DO UPDATE SET encrypted_key = $2, iv = $3, tag = $4, updated_at = NOW()',
          [userId, encryptedKey, iv, tag]
        );
      }
      sendJson(res, 200, { success: true });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleNotesRoutes };
