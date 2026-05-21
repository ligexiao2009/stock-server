-- ============================================================
-- 资产管理系统 — 完整数据库 Schema
-- 可用 psql -f schema.sql 从零创建全部表结构
-- ============================================================

-- ==================== 用户表 ====================
CREATE TABLE IF NOT EXISTS users (
    id          VARCHAR(50) PRIMARY KEY,
    email       VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(200) NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== 配置表 ====================
CREATE TABLE IF NOT EXISTS configs (
    key         VARCHAR(50) PRIMARY KEY,
    value       TEXT NOT NULL,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ==================== 持仓分类表 ====================
CREATE TABLE IF NOT EXISTS categories (
    id          VARCHAR(50) PRIMARY KEY,
    name        VARCHAR(50) NOT NULL,
    sort_order  INT DEFAULT 0
);

-- ==================== 持仓表 ====================
CREATE TABLE IF NOT EXISTS positions (
    id          VARCHAR(50) PRIMARY KEY,
    code        VARCHAR(20) NOT NULL,
    name        VARCHAR(100) NOT NULL,
    shares      DECIMAL(15, 4) NOT NULL DEFAULT 0,
    cost        DECIMAL(15, 4) NOT NULL DEFAULT 0,
    is_fund     BOOLEAN NOT NULL DEFAULT false,
    is_overseas BOOLEAN NOT NULL DEFAULT false,
    plan_buy    DECIMAL(15, 2) NOT NULL DEFAULT 0,
    alert       DECIMAL(5, 2),
    target_price DECIMAL(15, 4),
    category_id VARCHAR(50),
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_positions_code    ON positions(code);
CREATE INDEX IF NOT EXISTS idx_positions_is_fund ON positions(is_fund);
CREATE INDEX IF NOT EXISTS idx_positions_user_id ON positions(user_id);

-- ==================== 待确认交易表 ====================
CREATE TABLE IF NOT EXISTS pending_trades (
    id          VARCHAR(50) PRIMARY KEY,
    row_id      VARCHAR(50) NOT NULL,
    code        VARCHAR(20) NOT NULL,
    name        VARCHAR(100) NOT NULL,
    type        VARCHAR(10) NOT NULL DEFAULT 'add' CHECK (type IN ('add', 'reduce')),
    amount      DECIMAL(15, 2) NOT NULL,
    shares      DECIMAL(15, 4),
    is_before_15 BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMP NOT NULL,
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    FOREIGN KEY (row_id) REFERENCES positions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pending_trades_row_id    ON pending_trades(row_id);
CREATE INDEX IF NOT EXISTS idx_pending_trades_created_at ON pending_trades(created_at);
CREATE INDEX IF NOT EXISTS idx_pending_trades_user_id   ON pending_trades(user_id);

-- ==================== 交易历史表 ====================
CREATE TABLE IF NOT EXISTS trade_history (
    id          VARCHAR(50) PRIMARY KEY,
    row_id      VARCHAR(50) NOT NULL,
    type        VARCHAR(10) NOT NULL CHECK (type IN ('add', 'reduce')),
    amount      DECIMAL(15, 2) NOT NULL,
    shares      DECIMAL(15, 4) NOT NULL,
    net_value   DECIMAL(15, 4) NOT NULL,
    is_before_15 BOOLEAN DEFAULT true,
    created_at  TIMESTAMP NOT NULL,
    local_date  DATE,
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    FOREIGN KEY (row_id) REFERENCES positions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trade_history_row_id    ON trade_history(row_id);
CREATE INDEX IF NOT EXISTS idx_trade_history_created_at ON trade_history(created_at);
CREATE INDEX IF NOT EXISTS idx_trade_history_local_date ON trade_history(local_date);
CREATE INDEX IF NOT EXISTS idx_trade_history_user_id   ON trade_history(user_id);

-- ==================== 每日收益表 ====================
CREATE TABLE IF NOT EXISTS daily_profits (
    id          SERIAL PRIMARY KEY,
    date        DATE NOT NULL,
    stock_today DECIMAL(15, 2) NOT NULL DEFAULT 0,
    fund_today  DECIMAL(15, 2) NOT NULL DEFAULT 0,
    total_today DECIMAL(15, 2) NOT NULL DEFAULT 0,
    details     JSONB DEFAULT '[]',
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (date, user_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_profits_date    ON daily_profits(date);
CREATE INDEX IF NOT EXISTS idx_daily_profits_user_id ON daily_profits(user_id);

-- ==================== 股票涨跌幅提醒规则表 ====================
CREATE TABLE IF NOT EXISTS alert_rules (
    id             VARCHAR(50) PRIMARY KEY,
    position_id    VARCHAR(50) NOT NULL,
    direction      VARCHAR(5) NOT NULL CHECK (direction IN ('up', 'down', 'both')),
    threshold      DECIMAL(5, 2) NOT NULL,
    enabled        BOOLEAN NOT NULL DEFAULT true,
    triggered_today BOOLEAN NOT NULL DEFAULT false,
    trigger_time   TIMESTAMP,
    user_id        VARCHAR(50) NOT NULL DEFAULT 'default',
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (position_id) REFERENCES positions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_position_id ON alert_rules(position_id);
CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled     ON alert_rules(enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_user_id     ON alert_rules(user_id);

-- ==================== 基金每日收益明细表 ====================
CREATE TABLE IF NOT EXISTS fund_daily_profits (
    id          SERIAL PRIMARY KEY,
    position_id VARCHAR(50) NOT NULL,
    code        VARCHAR(20) NOT NULL,
    date        DATE NOT NULL,
    profit      DECIMAL(15, 2) NOT NULL DEFAULT 0,
    nav         DECIMAL(15, 4) NOT NULL DEFAULT 0,
    shares      DECIMAL(15, 4) NOT NULL DEFAULT 0,
    market_value DECIMAL(15, 2) NOT NULL DEFAULT 0,
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (position_id, date)
);

CREATE INDEX IF NOT EXISTS idx_fund_daily_profits_position ON fund_daily_profits(position_id, date);

-- ==================== 资产记录表 ====================
CREATE TABLE IF NOT EXISTS asset_records (
    id          SERIAL PRIMARY KEY,
    recorded_at TIMESTAMP NOT NULL,
    total       DECIMAL(15, 2) NOT NULL,
    alipay      DECIMAL(15, 2) DEFAULT 0,
    wechat      DECIMAL(15, 2) DEFAULT 0,
    ths         DECIMAL(15, 2) DEFAULT 0,
    crypto      DECIMAL(15, 2) DEFAULT 0,
    cmb         DECIMAL(15, 2) DEFAULT 0,
    provident   DECIMAL(15, 2) DEFAULT 0,
    receivable  DECIMAL(15, 2) DEFAULT 0,
    debt        DECIMAL(15, 2) DEFAULT 0,
    user_id     VARCHAR(50) NOT NULL DEFAULT 'default',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_asset_records_recorded_at ON asset_records(recorded_at);
CREATE INDEX IF NOT EXISTS idx_asset_records_user_id     ON asset_records(user_id);

-- ==================== 预设分类 ====================
INSERT INTO categories (id, name, sort_order) VALUES
    ('a_stock_large',  'A股大盘',  1),
    ('a_stock_small',  'A股中小',  2),
    ('hk_stock',       '港股',     3),
    ('us_stock',       '美股',     4),
    ('index_fund',     '指数基金', 5),
    ('sector_fund',    '行业基金', 6),
    ('bond_fund',      '债券基金', 7),
    ('hybrid_fund',    '混合基金', 8),
    ('overseas_fund',  '海外基金', 9)
ON CONFLICT (id) DO NOTHING;

-- ==================== 视图 ====================
DROP VIEW IF EXISTS daily_profits_summary;
CREATE VIEW daily_profits_summary AS
SELECT date, stock_today, fund_today, total_today, user_id, created_at
FROM daily_profits
ORDER BY date DESC;

DROP VIEW IF EXISTS positions_summary;
CREATE VIEW positions_summary AS
SELECT p.*, (p.shares * p.cost) AS estimated_value
FROM positions p
ORDER BY p.code;
