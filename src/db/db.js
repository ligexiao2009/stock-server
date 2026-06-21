// Database connection and utility functions for PostgreSQL
require('dotenv').config();
const { Pool } = require('pg');

// Database configuration
let poolConfig;
if (process.env.DATABASE_URL) {
  // Use connection string (e.g., from Supabase)
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    max: 20, // maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  };
} else {
  // Use individual environment variables (for local development)
  poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'yangyang',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

const pool = new Pool({ ...poolConfig, options: '-c timezone=Asia/Shanghai' });

// 每个新连接开启 TCP keepalive，防止中间网络设备断开空闲连接
pool.on('connect', (client) => {
  if (client.connection && client.connection.stream) {
    client.connection.stream.setKeepAlive(true, 60000);
  }
});

pool.on('error', (err) => {
  // 空闲连接被中间网络设备断开属于正常现象，pool 会自动重建，无需记录
  if (err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET') return;
  console.error('Unexpected error on idle client', err);
});

// Utility function to execute queries
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log(`Executed query: ${text}`, { duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Query error:', { text, params, error: error.message });
    throw error;
  }
}

// 修复 DECIMAL 字段：PG 返回字符串，转数字
const NUMERIC_FIELDS = new Set(['amount', 'shares', 'netValue', 'net_value', 'price', 'change', 'cost', 'stockToday', 'stock_today', 'fundToday', 'fund_today', 'totalToday', 'total_today', 'marketValue', 'market_value', 'profitLoss', 'profit', 'nav']);
function fixNumericFields(row) {
  const r = { ...row };
  for (const k of Object.keys(r)) {
    if (NUMERIC_FIELDS.has(k) && typeof r[k] === 'string') {
      r[k] = parseFloat(r[k]) || 0;
    }
  }
  return r;
}

// Convert snake_case to camelCase for database rows
function snakeToCamel(obj) {
  if (!obj) return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Convert snake_case to camelCase
    const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());

    // Convert numeric strings to numbers, EXCEPT for id/code/categoryId/date/storage fields
    const isIdField = ['code', 'id', 'categoryId', 'date', 'storage'].includes(camelKey);
    if (!isIdField && typeof value === 'string' && !isNaN(value) && value !== '') {
      result[camelKey] = parseFloat(value);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

// Convert camelCase to snake_case for database queries
function camelToSnake(obj) {
  if (!obj) return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    // Convert camelCase to snake_case
    const snakeKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    result[snakeKey] = value;
  }
  return result;
}

// Initialize database tables
async function initDatabase() {
  try {
    console.log('Initializing database tables...');

    // Read and execute schema.sql
    const fs = require('fs');
    const path = require('path');
    const schemaPath = path.join(__dirname, 'schema.sql');

    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, 'utf8');
      // Split by semicolon to execute statements one by one
      const statements = schemaSql.split(';').filter(stmt => stmt.trim());

      let successCount = 0;
      let errorCount = 0;

      for (const statement of statements) {
        if (statement.trim()) {
          try {
            await query(statement);
            successCount++;
          } catch (error) {
            errorCount++;
            // Log but continue - many errors are due to tables/objects already existing
            console.warn(`  Statement failed (${error.message.substring(0, 50)}...): ${statement.substring(0, 100)}...`);
          }
        }
      }
      console.log(`Database tables initialization completed: ${successCount} statements succeeded, ${errorCount} failed (tables likely already exist)`);
    } else {
      console.warn('schema.sql not found, skipping table initialization');
    }
  } catch (error) {
    console.error('Failed to initialize database (tables may already exist):', error.message);
    // Don't throw - allow server to start even if tables already exist
  }
}

// ==================== 配置表操作 ====================
async function getConfig(key) {
  const res = await query('SELECT value FROM configs WHERE key = $1', [key]);
  return res.rows[0]?.value || null;
}

async function setConfig(key, value) {
  await query(
    `INSERT INTO configs (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP`,
    [key, value]
  );
}

async function getAllConfigs() {
  const res = await query('SELECT key, value FROM configs');
  const configs = {};
  res.rows.forEach(row => {
    configs[row.key] = row.value;
  });
  return configs;
}

// ==================== 持仓表操作 ====================
async function getPositions(userId = null) {
  if (userId) {
    const res = await query('SELECT * FROM positions WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows.map(row => snakeToCamel(row));
  }
  const res = await query('SELECT * FROM positions ORDER BY created_at DESC');
  // Convert snake_case database fields to camelCase for frontend
  return res.rows.map(row => snakeToCamel(row));
}

async function getPosition(id) {
  const res = await query('SELECT * FROM positions WHERE id = $1', [id]);
  return res.rows[0] ? snakeToCamel(res.rows[0]) : null;
}

async function getPositionByCode(code, isFund, userId = 'default') {
  const res = await query(
    'SELECT * FROM positions WHERE code = $1 AND is_fund = $2 AND user_id = $3',
    [code, isFund, userId]
  );
  return res.rows[0] ? snakeToCamel(res.rows[0]) : null;
}

async function createPosition(position) {
  const {
    id, code, name, shares = 0, cost = 0, isFund = false,
    isOverseas = false, planBuy = 0, alert = null, targetPrice = null,
    categoryId = null
  } = position;

  const userId = position.userId || 'default';
  await query(
    `INSERT INTO positions (id, code, name, shares, cost, is_fund, is_overseas, plan_buy, alert, target_price, category_id, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, code, name, shares, cost, isFund, isOverseas, planBuy, alert, targetPrice, categoryId, userId]
  );
  return position;
}

async function updatePosition(id, updates) {
  const fields = [];
  const values = [];
  let paramCount = 1;

  // Build dynamic update query
  for (const [key, value] of Object.entries(updates)) {
    // Convert camelCase to snake_case
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = $${paramCount}`);
    values.push(value);
    paramCount++;
  }

  if (fields.length === 0) return;

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const queryText = `UPDATE positions SET ${fields.join(', ')} WHERE id = $${paramCount}`;
  await query(queryText, values);
}

async function deletePosition(id) {
  await query('DELETE FROM positions WHERE id = $1', [id]);
}

async function deletePositionByCode(code, isFund) {
  await query('DELETE FROM positions WHERE code = $1 AND is_fund = $2', [code, isFund]);
}

// ==================== 待确认交易表操作 ====================
async function getPendingTrades(userId = null) {
  if (userId) {
    const res = await query('SELECT * FROM pending_trades WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
    return res.rows.map(r => fixNumericFields(snakeToCamel(r)));
  }
  const res = await query('SELECT * FROM pending_trades ORDER BY created_at DESC');
  return res.rows.map(row => snakeToCamel(row));
}

async function getPendingTrade(id) {
  const res = await query('SELECT * FROM pending_trades WHERE id = $1', [id]);
  return res.rows[0] ? snakeToCamel(res.rows[0]) : null;
}

async function getPendingTradesByRowId(rowId) {
  const res = await query('SELECT * FROM pending_trades WHERE row_id = $1 ORDER BY created_at DESC', [rowId]);
  return res.rows.map(row => snakeToCamel(row));
}

async function createPendingTrade(trade) {
  const {
    id, rowId, code, name, type = 'add', amount, shares = null, isBefore15 = true, createdAt
  } = trade;
  const userId = trade.user_id || 'default';

  await query(
    `INSERT INTO pending_trades (id, row_id, code, name, type, amount, shares, is_before_15, created_at, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, rowId, code, name, type, amount, shares, isBefore15, createdAt, userId]
  );
  return trade;
}

async function deletePendingTrade(id) {
  await query('DELETE FROM pending_trades WHERE id = $1', [id]);
}

async function deleteAllPendingTrades(userId = null) {
  if (userId) {
    await query('DELETE FROM pending_trades WHERE user_id = $1', [userId]);
  } else {
    await query('DELETE FROM pending_trades');
  }
}

// ==================== 交易历史表操作 ====================
async function getTradeHistory(userId = null) {
  const filter = userId ? 'WHERE user_id = $1' : '';
  const params = userId ? [userId] : [];
  const res = await query(`
    SELECT row_id, json_agg(
      json_build_object(
        'id', id,
        'type', type,
        'amount', amount,
        'shares', shares,
        'netValue', net_value,
        'isBefore15', is_before_15,
        'createdAt', created_at,
        'localDate', local_date
      ) ORDER BY created_at DESC
    ) as records
    FROM trade_history
    ${filter}
    GROUP BY row_id
  `, params);

  const history = {};
  res.rows.forEach(row => {
    history[row.row_id] = row.records;
  });
  return history;
}

async function getTradeHistoryByRowId(rowId) {
  const res = await query(`
    SELECT * FROM trade_history
    WHERE row_id = $1
    ORDER BY created_at DESC
  `, [rowId]);
  return res.rows.map(row => {
    const r = fixNumericFields(snakeToCamel(row));
    if (r.localDate) {
      const d = new Date(r.localDate);
      r.localDate = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
    }
    return r;
  });
}

async function createTradeRecord(record) {
  const {
    id, rowId, type, amount, shares, netValue, isBefore15 = true, createdAt, localDate
  } = record;
  const userId = record.user_id || record.userId || 'default';

  await query(
    `INSERT INTO trade_history (id, row_id, type, amount, shares, net_value, is_before_15, created_at, local_date, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, rowId, type, amount, shares, netValue, isBefore15, createdAt, localDate, userId]
  );
  return record;
}

async function getTodayTrades(userId, date) {
  const res = await query(
    `SELECT id, row_id, type, amount, shares, net_value, is_before_15, created_at, local_date, user_id
     FROM trade_history
     WHERE user_id = $1 AND local_date = $2
     ORDER BY created_at`,
    [userId || 'default', date]
  );
  return res.rows.map(row => ({
    id: row.id,
    rowId: row.row_id,
    type: row.type,
    amount: parseFloat(row.amount) || 0,
    shares: parseFloat(row.shares) || 0,
    netValue: parseFloat(row.net_value) || 0,
    isBefore15: row.is_before_15,
    createdAt: row.created_at,
    localDate: row.local_date,
  }));
}

async function deleteTradeRecord(id) {
  await query('DELETE FROM trade_history WHERE id = $1', [id]);
}

// ==================== 每日收益表操作 ====================
async function getDailyProfits(userId = null) {
  if (userId) {
    const res = await query('SELECT * FROM daily_profits WHERE user_id = $1 ORDER BY date DESC', [userId]);
    return res.rows.map(row => {
      const converted = snakeToCamel(row);
      converted.stockToday = parseFloat(converted.stockToday) || 0;
      converted.fundToday = parseFloat(converted.fundToday) || 0;
      converted.totalToday = parseFloat(converted.totalToday) || 0;
      if (converted.date) {
  const d = new Date(converted.date);
  converted.date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
      return converted;
    });
  }
  const res = await query('SELECT * FROM daily_profits ORDER BY date DESC');
  // Convert snake_case database fields to camelCase for frontend
  return res.rows.map(row => {
    const converted = snakeToCamel(row);
    // Convert numeric strings to numbers
    if (typeof converted.stockToday === 'string') {
      converted.stockToday = parseFloat(converted.stockToday);
    }
    if (typeof converted.fundToday === 'string') {
      converted.fundToday = parseFloat(converted.fundToday);
    }
    if (typeof converted.totalToday === 'string') {
      converted.totalToday = parseFloat(converted.totalToday);
    }
    // Format date as YYYY-MM-DD string
    if (converted.date) {
      const d = new Date(converted.date);
      converted.date = d.getFullYear() + '-' +
                      (d.getMonth() + 1).toString().padStart(2, '0') + '-' +
                      d.getDate().toString().padStart(2, '0');
    }
    return converted;
  });
}

async function getDailyProfitByDateAndUser(date, userId) {
  const res = await query('SELECT * FROM daily_profits WHERE date = $1 AND user_id = $2', [date, userId]);
  return res.rows[0] || null;
}

async function getDailyProfitByDate(date) {
  const res = await query('SELECT * FROM daily_profits WHERE date = $1', [date]);
  return res.rows[0] || null;
}

async function createDailyProfit(record) {
  const { date, stockToday, fundToday, totalToday, details } = record;
  const userId = record.userId || (record.user_id || 'default');
  const hasDetails = details != null;

  const sql = hasDetails
    ? `INSERT INTO daily_profits (date, stock_today, fund_today, total_today, user_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (date, user_id) DO UPDATE SET
         stock_today = EXCLUDED.stock_today,
         fund_today = EXCLUDED.fund_today,
         total_today = EXCLUDED.total_today,
         details = EXCLUDED.details,
         created_at = CURRENT_TIMESTAMP`
    : `INSERT INTO daily_profits (date, stock_today, fund_today, total_today, user_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (date, user_id) DO UPDATE SET
         stock_today = EXCLUDED.stock_today,
         fund_today = EXCLUDED.fund_today,
         total_today = EXCLUDED.total_today,
         created_at = CURRENT_TIMESTAMP`;

  const params = hasDetails
    ? [date, stockToday, fundToday, totalToday, userId, details]
    : [date, stockToday, fundToday, totalToday, userId];

  await query(sql, params);
  return record;
}

async function deleteDailyProfit(date) {
  await query('DELETE FROM daily_profits WHERE date = $1', [date]);
}

// ==================== 基金每日收益明细表操作 ====================

async function getFundDailyProfits(positionId) {
  const res = await query(
    'SELECT date::text, profit, nav, shares, market_value FROM fund_daily_profits WHERE position_id = $1 ORDER BY date ASC',
    [positionId]
  );
  return res.rows.map(fixNumericFields);
}

async function saveFundDailyProfit(record) {
  const { positionId, code, date, profit, nav, shares, marketValue, userId } = record;
  await query(
    `INSERT INTO fund_daily_profits (position_id, code, date, profit, nav, shares, market_value, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (position_id, date) DO UPDATE SET profit = $4, nav = $5, shares = $6, market_value = $7`,
    [positionId, code, date, profit, nav, shares, marketValue, userId || 'default']
  );
}

// ==================== 股票涨跌幅提醒规则表操作 ====================
async function getAlertRules() {
  const res = await query('SELECT * FROM alert_rules ORDER BY created_at ASC');
  return res.rows.map(row => snakeToCamel(row));
}

async function getAlertRulesByPositionId(positionId) {
  const res = await query('SELECT * FROM alert_rules WHERE position_id = $1 ORDER BY created_at ASC', [positionId]);
  return res.rows.map(row => snakeToCamel(row));
}

async function getAlertRule(id) {
  const res = await query('SELECT * FROM alert_rules WHERE id = $1', [id]);
  return res.rows[0] ? snakeToCamel(res.rows[0]) : null;
}

async function createAlertRule(rule) {
  const { id, positionId, direction, threshold, enabled = true } = rule;
  await query(
    `INSERT INTO alert_rules (id, position_id, direction, threshold, enabled)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, positionId, direction, threshold, enabled]
  );
  return rule;
}

async function updateAlertRule(id, updates) {
  const fields = [];
  const values = [];
  let paramCount = 1;

  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = $${paramCount}`);
    values.push(value);
    paramCount++;
  }

  if (fields.length === 0) return;

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const queryText = `UPDATE alert_rules SET ${fields.join(', ')} WHERE id = $${paramCount}`;
  await query(queryText, values);
}

async function deleteAlertRule(id) {
  await query('DELETE FROM alert_rules WHERE id = $1', [id]);
}

async function deleteAlertRulesByPositionId(positionId) {
  await query('DELETE FROM alert_rules WHERE position_id = $1', [positionId]);
}

async function resetAlertRulesDaily() {
  await query('UPDATE alert_rules SET triggered_today = false, trigger_time = NULL');
}

async function getEnabledAlertRules() {
  const res = await query('SELECT * FROM alert_rules WHERE enabled = true ORDER BY created_at ASC');
  return res.rows.map(row => snakeToCamel(row));
}

// ==================== 资产记录表操作 ====================
async function getAssetRecords(userId = null) {
  if (userId) {
    const res = await query('SELECT * FROM asset_records WHERE user_id = $1 ORDER BY recorded_at DESC', [userId]);
    return res.rows.map(row => {
      const converted = snakeToCamel(row);
      if (converted.recordedAt) {
        const d = new Date(converted.recordedAt);
        const offset = d.getTimezoneOffset();
        converted.recordedAt = new Date(d.getTime() - offset * 60000).toISOString();
      }
      return converted;
    });
  }
  const res = await query('SELECT * FROM asset_records ORDER BY recorded_at DESC');
  return res.rows.map(row => {
    const converted = snakeToCamel(row);
    if (converted.recordedAt) {
      const d = new Date(converted.recordedAt);
      converted.recordedAt = d.getFullYear() + '/' +
        (d.getMonth() + 1).toString().padStart(2, '0') + '/' +
        d.getDate().toString().padStart(2, '0') + ' ' +
        d.getHours().toString().padStart(2, '0') + ':' +
        d.getMinutes().toString().padStart(2, '0');
      converted.day = (d.getMonth() + 1) + '-' + d.getDate();
    }
    return converted;
  });
}

async function createAssetRecord(record) {
  const { recordedAt, total, alipay, wechat, ths, crypto, cash, cmb, provident, receivable, debt } = record;
  const userId = record.user_id || record.userId || 'default';
  const res = await query(
    `INSERT INTO asset_records (recorded_at, total, alipay, wechat, ths, crypto, cash, cmb, provident, receivable, debt, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [recordedAt, total, alipay || 0, wechat || 0, ths || 0, crypto || 0, cash || 0, cmb || 0, provident || 0, receivable || 0, debt || 0, userId]
  );
  return res.rows[0].id;
}

async function deleteAssetRecord(id) {
  await query('DELETE FROM asset_records WHERE id = $1', [id]);
}

async function deleteAllAssetRecords() {
  await query('DELETE FROM asset_records');
}

async function getCategories() {
  const res = await query('SELECT id, name, sort_order FROM categories ORDER BY sort_order');
  return res.rows.map(row => snakeToCamel(row));
}

async function createCategory(category) {
  const { id, name, sortOrder = 0 } = category;
  await query(
    'INSERT INTO categories (id, name, sort_order) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET name = $2, sort_order = $3',
    [id, name, sortOrder]
  );
}

async function updateCategory(id, updates) {
  const fields = [];
  const values = [];
  let paramCount = 1;
  for (const [key, value] of Object.entries(updates)) {
    const dbKey = key.replace(/([A-Z])/g, '_$1').toLowerCase();
    fields.push(`${dbKey} = $${paramCount}`);
    values.push(value);
    paramCount++;
  }
  if (fields.length === 0) return;
  values.push(id);
  await query(`UPDATE categories SET ${fields.join(', ')} WHERE id = $${paramCount}`, values);
}

async function deleteCategory(id) {
  await query('UPDATE positions SET category_id = NULL WHERE category_id = $1', [id]);
  await query('DELETE FROM categories WHERE id = $1', [id]);
}

// ==================== Intraday Snapshots ====================
async function saveIntradaySnapshot({ userId, date, time, stockProfit, fundProfit, totalProfit, stockMarket, fundMarket, totalMarket }) {
  await query(
    `INSERT INTO intraday_snapshots (user_id, date, time, stock_profit, fund_profit, total_profit, stock_market, fund_market, total_market)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (date, time, user_id) DO NOTHING`,
    [userId || 'default', date, time, stockProfit || 0, fundProfit || 0, totalProfit || 0, stockMarket || 0, fundMarket || 0, totalMarket || 0]
  );
}

async function getIntradaySnapshots(date, userId = null) {
  const uid = userId || 'default';
  const res = await query(
    'SELECT * FROM intraday_snapshots WHERE date = $1 AND user_id = $2 ORDER BY time ASC',
    [date, uid]
  );
  return res.rows.map(r => snakeToCamel(fixNumericFields(r)));
}

async function backupIntradaySnapshots(dateStr) {
  const res = await query(
    `INSERT INTO intraday_snapshots_history (user_id, date, time, stock_profit, fund_profit, total_profit, stock_market, fund_market, total_market)
     SELECT user_id, date, time, stock_profit, fund_profit, total_profit, stock_market, fund_market, total_market
     FROM intraday_snapshots
     WHERE date = $1
     ON CONFLICT (date, time, user_id) DO NOTHING`,
    [dateStr]
  );
  return res.rowCount;
}

// ==================== Crypto Snapshots ====================
async function saveCryptoSnapshot({ userId, date, time, code, name, price, cost, shares, profit }) {
  await query(
    `INSERT INTO crypto_snapshots (user_id, date, time, code, name, price, cost, shares, profit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (date, time, code, user_id) DO NOTHING`,
    [userId || 'default', date, time, code, name || '', price || 0, cost || 0, shares || 0, profit || 0]
  );
}

async function getCryptoSnapshots(startDate, userId = null) {
  const uid = userId || 'default';
  const res = await query(
    `SELECT * FROM crypto_snapshots
     WHERE (date || ' ' || time) >= $1 AND user_id = $2
     ORDER BY (date || ' ' || time) ASC`,
    [startDate, uid]
  );
  return res.rows.map(r => snakeToCamel(fixNumericFields(r)));
}

// ==================== 倒计时事件 ====================
async function getCountdownEvents(userId) {
  const res = await query(
    'SELECT id, name, event_date FROM countdown_events WHERE user_id = $1 ORDER BY event_date',
    [userId || 'default']
  );
  return res.rows.map(r => {
    const d = r.event_date;
    const dateStr = d instanceof Date
      ? d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
      : String(d).slice(0, 10);
    return { id: r.id, name: r.name, date: dateStr };
  });
}

async function createCountdownEvent({ name, date, userId }) {
  const res = await query(
    'INSERT INTO countdown_events (name, event_date, user_id) VALUES ($1, $2, $3) RETURNING id',
    [name, date, userId || 'default']
  );
  return res.rows[0].id;
}

async function deleteCountdownEvent(id, userId) {
  await query(
    'DELETE FROM countdown_events WHERE id = $1 AND user_id = $2',
    [id, userId || 'default']
  );
}

async function updateCountdownEvent(id, { name, date, userId }) {
  await query(
    'UPDATE countdown_events SET name = $1, event_date = $2 WHERE id = $3 AND user_id = $4',
    [name, date, id, userId || 'default']
  );
}

// ==================== 仓位管理 ====================

async function getPositionConfig(userId) {
  const res = await query(
    'SELECT * FROM position_config WHERE user_id = $1',
    [userId || 'default']
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    target_pct: parseInt(row.target_pct) || 80,
    cash_reserve: parseFloat(row.cash_reserve) || 0,
    alipay_cash: parseFloat(row.alipay_cash) || 0,
    ths_cash: parseFloat(row.ths_cash) || 0,
    bank_cash: parseFloat(row.bank_cash) || 0,
    batch_count: parseInt(row.batch_count) || 4,
    signal_enabled: row.signal_enabled === true || row.signal_enabled === 'true',
    signal_pct: parseFloat(row.signal_pct) || -10,
  };
}

async function savePositionConfig(userId, data) {
  const { targetPct, cashReserve, alipayCash, thsCash, bankCash, batchCount, signalEnabled, signalPct } = data;
  await query(
    `INSERT INTO position_config (user_id, target_pct, cash_reserve, alipay_cash, ths_cash, bank_cash, batch_count, signal_enabled, signal_pct, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       target_pct = EXCLUDED.target_pct,
       cash_reserve = EXCLUDED.cash_reserve,
       alipay_cash = EXCLUDED.alipay_cash,
       ths_cash = EXCLUDED.ths_cash,
       bank_cash = EXCLUDED.bank_cash,
       batch_count = EXCLUDED.batch_count,
       signal_enabled = EXCLUDED.signal_enabled,
       signal_pct = EXCLUDED.signal_pct,
       updated_at = NOW()`,
    [userId || 'default', targetPct ?? 80, cashReserve ?? 0, alipayCash ?? 0, thsCash ?? 0, bankCash ?? 0, batchCount ?? 4, signalEnabled ?? false, signalPct ?? -10]
  );
}

async function adjustCashReserve(userId, delta) {
  await query(
    `UPDATE position_config SET cash_reserve = GREATEST(0, cash_reserve + $1), updated_at = NOW() WHERE user_id = $2`,
    [delta, userId || 'default']
  );
}

async function adjustAlipayCash(userId, delta) {
  await query(
    `UPDATE position_config SET alipay_cash = GREATEST(0, alipay_cash + $1), updated_at = NOW() WHERE user_id = $2`,
    [delta, userId || 'default']
  );
  await syncTotalCash(userId);
}

async function adjustThsCash(userId, delta) {
  await query(
    `UPDATE position_config SET ths_cash = GREATEST(0, ths_cash + $1), updated_at = NOW() WHERE user_id = $2`,
    [delta, userId || 'default']
  );
  await syncTotalCash(userId);
}

async function syncTotalCash(userId) {
  await query(
    `UPDATE position_config SET cash_reserve = alipay_cash + ths_cash + bank_cash, updated_at = NOW() WHERE user_id = $1`,
    [userId || 'default']
  );
}

async function getBatchPlans(userId) {
  const res = await query(
    'SELECT * FROM batch_plans WHERE user_id = $1 ORDER BY sort_order',
    [userId || 'default']
  );
  return res.rows.map(r => ({
    id: r.id, sortOrder: r.sort_order, amount: parseFloat(r.amount) || 0,
    triggerPct: parseFloat(r.trigger_pct) || 0, status: r.status,
  }));
}

async function saveBatchPlans(userId, plans) {
  await query('DELETE FROM batch_plans WHERE user_id = $1', [userId || 'default']);
  for (const p of plans) {
    await query(
      `INSERT INTO batch_plans (user_id, sort_order, amount, trigger_pct, status)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId || 'default', p.sortOrder, p.amount, p.triggerPct ?? 0, p.status || 'pending']
    );
  }
}

// ==================== Digital Devices ====================

async function getDigitalDevices(userId) {
  const res = await query(
    'SELECT * FROM digital_devices WHERE user_id = $1 ORDER BY purchase_date DESC',
    [userId]
  );
  const devices = res.rows.map(r => snakeToCamel(r));
  
  // Load photos for each device
  for (const device of devices) {
    const photosRes = await query(
      'SELECT * FROM digital_device_photos WHERE device_id = $1 ORDER BY sort_order',
      [device.id]
    );
    device.photos = photosRes.rows.map(p => snakeToCamel(p));
  }
  
  return devices;
}

async function getDigitalDevice(id, userId) {
  const res = await query(
    'SELECT * FROM digital_devices WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  if (res.rows.length === 0) return null;
  const device = snakeToCamel(res.rows[0]);
  const photosRes = await query(
    'SELECT * FROM digital_device_photos WHERE device_id = $1 ORDER BY sort_order',
    [id]
  );
  device.photos = photosRes.rows.map(p => snakeToCamel(p));
  return device;
}

async function createDigitalDevice(device) {
  const res = await query(
    `INSERT INTO digital_devices (id, user_id, name, brand, category, purchase_price, purchase_date, color, storage, purchase_channel, notes, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
    [device.id, device.userId, device.name, device.brand, device.category, device.purchasePrice, device.purchaseDate, device.color || '', device.storage || '', device.purchaseChannel || '', device.notes || '', device.status || 'inUse', device.createdAt || new Date().toISOString(), device.updatedAt || new Date().toISOString()]
  );
  return snakeToCamel(res.rows[0]);
}

async function updateDigitalDevice(id, userId, device) {
  const res = await query(
    `UPDATE digital_devices SET name = $3, brand = $4, category = $5, purchase_price = $6, purchase_date = $7, color = $8, storage = $9, purchase_channel = $10, notes = $11, status = $12, updated_at = $13
     WHERE id = $1 AND user_id = $2 RETURNING *`,
    [id, userId, device.name, device.brand, device.category, device.purchasePrice, device.purchaseDate, device.color || '', device.storage || '', device.purchaseChannel || '', device.notes || '', device.status || 'inUse', new Date().toISOString()]
  );
  return res.rows[0] ? snakeToCamel(res.rows[0]) : null;
}

async function deleteDigitalDevice(id, userId) {
  await query('DELETE FROM digital_device_photos WHERE device_id = $1', [id]);
  await query('DELETE FROM digital_devices WHERE id = $1 AND user_id = $2', [id, userId]);
}

async function addDigitalDevicePhoto(deviceId, userId, fileName, filePath, sortOrder) {
  const res = await query(
    `INSERT INTO digital_device_photos (id, user_id, device_id, file_name, file_path, sort_order, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [require('crypto').randomUUID(), userId, deviceId, fileName, filePath, sortOrder || 0, new Date().toISOString()]
  );
  return snakeToCamel(res.rows[0]);
}

async function deleteDigitalDevicePhoto(photoId, userId) {
  await query('DELETE FROM digital_device_photos WHERE id = $1 AND user_id = $2', [photoId, userId]);
}

module.exports = {
  // Database connection
  pool,
  query,
  initDatabase,

  // Config operations
  getConfig,
  setConfig,
  getAllConfigs,

  // Position operations
  getPositions,
  getPosition,
  getPositionByCode,
  createPosition,
  updatePosition,
  deletePosition,
  deletePositionByCode,

  // Pending trades operations
  getPendingTrades,
  getPendingTrade,
  getPendingTradesByRowId,
  createPendingTrade,
  deletePendingTrade,
  deleteAllPendingTrades,

  // Trade history operations
  getTradeHistory,
  getTradeHistoryByRowId,
  createTradeRecord,
  getTodayTrades,
  deleteTradeRecord,

  // Daily profits operations
  getDailyProfits,
  getDailyProfitByDate,
  getDailyProfitByDateAndUser,
  createDailyProfit,
  deleteDailyProfit,
  getFundDailyProfits,
  saveFundDailyProfit,

  // Alert rules operations
  getAlertRules,
  getAlertRulesByPositionId,
  getAlertRule,
  createAlertRule,
  updateAlertRule,
  deleteAlertRule,
  deleteAlertRulesByPositionId,
  resetAlertRulesDaily,
  getEnabledAlertRules,

  // Asset records operations
  getAssetRecords,
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  createAssetRecord,
  deleteAssetRecord,
  deleteAllAssetRecords,

  // Intraday snapshots
  saveIntradaySnapshot,
  getIntradaySnapshots,
  backupIntradaySnapshots,

  // Crypto snapshots
  saveCryptoSnapshot,
  getCryptoSnapshots,

  // Countdown events
  getCountdownEvents,
  createCountdownEvent,
  deleteCountdownEvent,
  updateCountdownEvent,

  // Position management
  getPositionConfig,
  savePositionConfig,
  adjustCashReserve,
  adjustAlipayCash,
  adjustThsCash,
  syncTotalCash,
  getBatchPlans,
  saveBatchPlans,

  // Digital devices
  getDigitalDevices,
  getDigitalDevice,
  createDigitalDevice,
  updateDigitalDevice,
  deleteDigitalDevice,
  addDigitalDevicePhoto,
  deleteDigitalDevicePhoto,

};
