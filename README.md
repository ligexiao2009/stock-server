# 投资助手后端 API

Node.js 后端服务，提供持仓管理、行情查询、基金分析、AI 分析代理、加密笔记等 API。

## 功能

- **持仓管理** — 股票/基金/加密币 CRUD、分类、加仓减仓、基金转换
- **行情数据** — 腾讯财经 + TickFlow 多源行情，A 股/港股/美股实时价格
- **AI 分析** — 代理 Python 分析服务，批量分析、进度追踪、历史摘要
- **加密笔记** — 端到端加密存储，服务端只存密文，密钥永不落地
- **定时任务** — 每日收益计算（自动跳过休市市场）、基金净值提醒、15 点自动确认交易
- **市场状态** — Sina API 实时检测 A 股/港股开盘状态，休市期间收益计算自动排除
- **数据库备份** — launchd 定时备份到本地

## 技术栈

- **运行时**: Node.js
- **数据库**: PostgreSQL
- **定时任务**: node-cron
- **行情源**: 腾讯 `qt.gtimg.cn`、TickFlow `api.tickflow.org`、Sina `hq.sinajs.cn`
- **AI 服务**: Python FastAPI (端口 8000)

## 配置

复制 `.env.example` 为 `.env`，按需配置：

```bash
DATABASE_URL=postgresql://...
JWT_SECRET=your-secret
TICKFLOW_API_KEY=tk_xxx        # 港股实时行情（可选）
AI_ANALYSIS_DIR=/path/to/analysis  # Python 分析服务路径
```

## 启动

```bash
npm install
node src/server.js
# 服务运行在 http://localhost:4000
```
