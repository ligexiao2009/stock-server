/**
 * 内存缓存中间件 — ETag / If-None-Match + TTL
 */
const crypto = require('crypto');

const store = new Map();
const DEFAULT_TTL_MS = 5 * 60 * 1000;

// 行情数据缓存 TTL 常量
const QUOTES_CACHE_TTL_MS = Number(process.env.QUOTES_CACHE_TTL_MS || 30000);
const KLINE_CACHE_TTL_MS = Number(process.env.KLINE_CACHE_TTL_MS || 5 * 60 * 1000);

function makeETag(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex').substring(0, 16);
}

/** 无缓存 JSON 响应 — 每次返回最新数据 */
async function sendCachedJson(req, res, key, dataFn, opts = {}) {
  const data = await dataFn();
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });
  res.end(JSON.stringify(data));
}

/** 使指定缓存键失效 */
function invalidateCache(...keys) {
  for (const key of keys) {
    store.delete(key);
  }
}

/** 按前缀失效缓存 */
function invalidateCacheByPrefix(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) {
      store.delete(key);
    }
  }
}

module.exports = {
  sendCachedJson,
  invalidateCache,
  invalidateCacheByPrefix,
  QUOTES_CACHE_TTL_MS,
  KLINE_CACHE_TTL_MS,
};
