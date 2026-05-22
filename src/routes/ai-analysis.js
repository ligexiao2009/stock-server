/**
 * AI 股票分析代理 — 转发到 Python 分析服务 (localhost:8000)
 */
const PY_BASE = process.env.AI_ANALYSIS_URL || 'http://localhost:8000';

async function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c.toString());
    req.on('end', () => resolve(body));
  });
}

function parseJson(str) {
  try { return JSON.parse(str); } catch { return {}; }
}

async function handleAIAnalysisRoutes(req, res) {
  const pyDir = process.env.AI_ANALYSIS_DIR || '/Users/yangyang/git/daily_stock_analysis';

  // POST /api/ai-analysis/analyze — 触发分析
  if (req.method === 'POST' && req.url === '/api/ai-analysis/analyze') {
    try {
      const body = await readBody(req);
      const { stockCode } = parseJson(body);
      if (!stockCode) { sendJson(res, 400, { error: '缺少 stock_code' }); return true; }

      const pyResp = await fetch(`${PY_BASE}/api/v1/analysis/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stock_code: stockCode }),
      });
      const data = await pyResp.json();
      sendJson(res, pyResp.status, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/ai-analysis/status/:taskId
  if (req.method === 'GET' && req.url.startsWith('/api/ai-analysis/status/')) {
    try {
      const taskId = req.url.split('/api/ai-analysis/status/')[1];
      const pyResp = await fetch(`${PY_BASE}/api/v1/analysis/status/${taskId}`);
      const data = await pyResp.json();
      sendJson(res, pyResp.status, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/ai-analysis/report?stock_code=600519 — 获取该股票最新分析报告
  if (req.method === 'GET' && req.url.startsWith('/api/ai-analysis/report')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const stockCode = url.searchParams.get('stock_code');
      if (!stockCode) { sendJson(res, 400, { error: '缺少 stock_code' }); return true; }

      const pyResp = await fetch(`${PY_BASE}/api/v1/history?limit=50`);
      const history = await pyResp.json();
      const items = (history.items || []).filter(i => i.stock_code === stockCode);
      if (items.length === 0) {
        sendJson(res, 200, { found: false, message: '暂无分析记录' });
      } else {
        const latest = items[0];
        const detailResp = await fetch(`${PY_BASE}/api/v1/history/${latest.id}`);
        const detail = await detailResp.json();
        const summary = detail.summary || {};
        const strategy = detail.strategy || {};
        const rawResult = (detail.details || {}).raw_result || {};
        const enhanced = ((detail.details || {}).context_snapshot || {}).enhanced_context || {};
        const trend = enhanced.trend_analysis || {};
        const today = enhanced.today || {};
        const rt = enhanced.realtime || {};
        const boards = enhanced.belong_boards || [];
        sendJson(res, 200, { found: true, report: {
          ...latest,
          analysis_summary: summary.analysis_summary || '',
          trend_prediction: summary.trend_prediction || '',
          sentiment_label: summary.sentiment_label || '',
          ideal_buy: strategy.ideal_buy || '',
          stop_loss: strategy.stop_loss || '',
          take_profit: strategy.take_profit || '',
          technical_analysis: rawResult.technical_analysis || '',
          fundamental_analysis: rawResult.fundamental_analysis || '',
          risk_warning: rawResult.risk_warning || '',
          news_content: rawResult.news_content || '',
          ma_status: trend.ma_status || '',
          ma5: today.ma5 || 0,
          ma10: today.ma10 || 0,
          ma20: today.ma20 || 0,
          bias_ma5: trend.bias_ma5 || 0,
          volume: today.volume || 0,
          volume_ratio: rt.volume_ratio || 0,
          pe_ratio: rt.pe_ratio || 0,
          pb_ratio: rt.pb_ratio || 0,
          total_mv: rt.total_mv || 0,
          signal_score: trend.signal_score || 0,
          trend_strength: trend.trend_strength || 0,
          signal_reasons: JSON.stringify(trend.signal_reasons || []),
          risk_factors: JSON.stringify(trend.risk_factors || []),
          boards: JSON.stringify(boards.map(b => ({ name: b.name, code: b.code }))),
          dashboard: JSON.stringify(rawResult.dashboard || {}),
          model_used: latest.model_used || rawResult.model_used || detail.meta?.model_used || '',
        }});
      }
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/ai-analysis/market-review — 获取最新大盘复盘报告
  if (req.method === 'GET' && req.url === '/api/ai-analysis/market-review') {
    try {
      const fs = require('fs');
      const path = require('path');
      const reportsDir = process.env.AI_REPORTS_DIR || `${pyDir}/reports`;
      const files = fs.readdirSync(reportsDir).filter(f => f.startsWith('market_review_')).sort().reverse();
      if (files.length === 0) {
        sendJson(res, 200, { found: false, message: '暂无大盘复盘' });
      } else {
        const content = fs.readFileSync(path.join(reportsDir, files[0]), 'utf8');
        const date = files[0].replace('market_review_', '').replace('.md', '');
        sendJson(res, 200, { found: true, date, content });
      }
    } catch (e) {
      sendJson(res, 200, { found: false, message: e.message });
    }
    return true;
  }

  // POST /api/ai-analysis/market-review — 触发大盘复盘
  if (req.method === 'POST' && req.url === '/api/ai-analysis/market-review') {
    try {
      const { exec } = require('child_process');
      exec(`cd ${pyDir} && python3 main.py`, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) console.error('market review error:', err.message);
        else console.log('market review done');
      });
      sendJson(res, 200, { started: true, message: '大盘复盘已触发，预计2-3分钟完成' });
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // POST /api/ai-chat — Agent 对话 (SSE 流式)
  if (req.method === 'POST' && req.url === '/api/ai-chat') {
    try {
      const body = await readBody(req);
      const { message, sessionId } = parseJson(body);
      if (!message) { sendJson(res, 400, { error: '缺少 message' }); return true; }

      const pyResp = await fetch(`${PY_BASE}/api/v1/agent/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, session_id: sessionId || null }),
      });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      if (pyResp.body && typeof pyResp.body.pipe === 'function') {
        pyResp.body.pipe(res);
      } else {
        const reader = pyResp.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) { res.end(); break; }
            res.write(value);
          }
        };
        pump().catch(() => res.end());
      }
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
    return true;
  }

  // GET /api/ai-chat/sessions — 获取历史会话列表
  if (req.method === 'GET' && req.url === '/api/ai-chat/sessions') {
    try {
      const pyResp = await fetch(`${PY_BASE}/api/v1/agent/chat/sessions`);
      const data = await pyResp.json();
      sendJson(res, pyResp.status, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  // GET /api/ai-chat/sessions/:id — 获取会话消息
  if (req.method === 'GET' && req.url.startsWith('/api/ai-chat/sessions/')) {
    try {
      const sessionId = req.url.split('/api/ai-chat/sessions/')[1];
      const pyResp = await fetch(`${PY_BASE}/api/v1/agent/chat/sessions/${sessionId}`);
      const data = await pyResp.json();
      sendJson(res, pyResp.status, data);
    } catch (e) {
      sendJson(res, 500, { error: e.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleAIAnalysisRoutes };
