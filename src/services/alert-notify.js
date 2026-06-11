/**
 * 涨跌幅提醒服务 — 盘中快照触发，邮件通知
 *
 * 配置（.env）：
 *   ALERT_CHANGE_THRESHOLD=3,5,8  逗号分隔的阈值列表
 *   ALERT_EMAIL=xxx@qq.com       接收邮箱（可选，默认 SMTP 发件人）
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const ALERT_FILE = path.join(__dirname, '../../data/alert-sent.json');

// 解析涨跌幅阈值
const thresholds = (process.env.ALERT_CHANGE_THRESHOLD || '5')
  .split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0)
  .sort((a, b) => b - a); // 从大到小

// 解析反弹阈值
const reboundThresholds = (process.env.ALERT_REBOUND_THRESHOLD || '3,5,8')
  .split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n) && n > 0)
  .sort((a, b) => b - a);

// ========== 持久化 ==========
function loadSent() {
  try { return JSON.parse(fs.readFileSync(ALERT_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function saveSent(data) {
  fs.mkdirSync(path.dirname(ALERT_FILE), { recursive: true });
  fs.writeFileSync(ALERT_FILE, JSON.stringify(data, null, 2));
}

// ========== 邮件 ==========
let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (process.env.SMTP_HOST) {
    mailer = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '465'),
      secure: process.env.SMTP_SECURE !== 'false',
      auth: { user: process.env.EMAIL_SENDER, pass: process.env.EMAIL_PASSWORD },
    });
  }
  return mailer;
}

async function sendAlertEmail(dateStr, items) {
  const transport = getMailer();
  if (!transport) { console.log('[告警] SMTP 未配置，跳过邮件'); return; }

  const to = process.env.ALERT_EMAIL || process.env.EMAIL_SENDER;

  const changeItems = items.filter(i => i.changePct !== undefined);
  const reboundItems = items.filter(i => i.reboundPct !== undefined);
  const upItems = changeItems.filter(i => i.changePct > 0);
  const downItems = changeItems.filter(i => i.changePct < 0);

  let body = '';
  if (upItems.length) {
    body += `▲ 涨幅超阈值:\n\n`;
    for (const i of upItems) {
      body += `  ${i.code} ${i.name}  +${i.changePct.toFixed(2)}%（当前 ${i.price}）\n`;
    }
    body += '\n';
  }
  if (downItems.length) {
    body += `▼ 跌幅超阈值:\n\n`;
    for (const i of downItems) {
      body += `  ${i.code} ${i.name}  ${i.changePct.toFixed(2)}%（当前 ${i.price}）\n`;
    }
    body += '\n';
  }
  if (reboundItems.length) {
    body += `↗ 日内反弹超阈值:\n\n`;
    for (const i of reboundItems) {
      body += `  ${i.code} ${i.name}  +${i.reboundPct.toFixed(2)}%（从日内低点反弹，当前 ${i.price}）\n`;
    }
    body += '\n';
  }
  body += `———\n涨跌阈值: ${thresholds.join('%、')}%  |  反弹阈值: ${reboundThresholds.join('%、')}%\n共 ${items.length} 条提醒`;

  try {
    await transport.sendMail({
      from: process.env.EMAIL_SENDER,
      to,
      subject: `[涨跌提醒] ${dateStr}`,
      text: body,
    });
    console.log(`[告警] 邮件已发送 → ${to} (${items.length}只)`);
  } catch (e) {
    console.error(`[告警] 邮件发送失败: ${e.message}`);
  }
}

// ========== 核心：检查是否需要告警 ==========
/**
 * 单只股票检查
 * @returns {{ fire: boolean, threshold: number }} fire=true 表示该发
 */
function checkStock(code, changePct, dateStr) {
  if (thresholds.length === 0) return { fire: false, threshold: 0 };

  // 找到 change 超过的最高阈值
  let matched = 0;
  for (const t of thresholds) {
    if (Math.abs(changePct) >= t) { matched = t; break; }
  }
  if (matched === 0) return { fire: false, threshold: 0 };

  // 去重：当天该股票是否已经用这个或更高阈值发过
  const sent = loadSent();
  const todayData = sent[dateStr] || {};
  const prevMax = todayData[code] || 0;

  if (matched > prevMax) {
    todayData[code] = matched;
    sent[dateStr] = todayData;
    // 清理 7 天前的数据
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');
    for (const d of Object.keys(sent)) {
      if (d < cutoffStr) delete sent[d];
    }
    saveSent(sent);
    return { fire: true, threshold: matched };
  }

  return { fire: false, threshold: 0 };
}

// ========== 反弹检查 ==========
function checkRebound(code, currentPrice, lowPrice, dateStr) {
  if (reboundThresholds.length === 0 || lowPrice <= 0 || currentPrice <= lowPrice) return { fire: false, threshold: 0 };

  const reboundPct = ((currentPrice - lowPrice) / lowPrice) * 100;
  let matched = 0;
  for (const t of reboundThresholds) {
    if (reboundPct >= t) { matched = t; break; }
  }
  if (matched === 0) return { fire: false, threshold: 0 };

  const sent = loadSent();
  if (!sent[dateStr]) sent[dateStr] = {};
  if (!sent[dateStr].rebound) sent[dateStr].rebound = {};
  const prevMax = sent[dateStr].rebound[code] || 0;

  if (matched > prevMax) {
    sent[dateStr].rebound[code] = matched;
    // 清理旧数据
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 7);
    const cutoffStr = cutoff.toISOString().slice(0, 10).replace(/-/g, '');
    for (const d of Object.keys(sent)) {
      if (d < cutoffStr) delete sent[d];
    }
    saveSent(sent);
    return { fire: true, threshold: matched, reboundPct };
  }
  return { fire: false, threshold: 0 };
}

module.exports = { checkStock, checkRebound, sendAlertEmail };
