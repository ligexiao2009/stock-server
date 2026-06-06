/**
 * 补仓信号检测 — 上证指数跌幅达到阈值时微信通知
 */
const db = require('../db/db');
const { sendWechatMessage } = require('./wechat');

const lastAlertSent = new Map(); // userId -> date string, prevent duplicate

async function getIndexDrawdown() {
  try {
    const resp = await fetch('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_day&param=sh000001,day,,,90,qfq');
    const text = await resp.text();
    const json = text.includes('=') ? text.slice(text.indexOf('=') + 1).replace(/;$/, '').trim() : text;
    const stockData = JSON.parse(json)?.data?.sh000001;
    const data = (stockData?.qfqday || stockData?.day || []);
    if (data.length < 2) return null;

    const last = data[data.length - 1];
    const current = parseFloat(last[2]);
    let high = current;
    for (const d of data) {
      const close = parseFloat(d[2]);
      if (close > high) high = close;
    }
    return { current, high, drawdown: ((high - current) / high * 100) };
  } catch (e) {
    console.error('获取指数数据失败:', e.message);
    return null;
  }
}

async function checkIndexDrawdownAlerts() {
  console.log('\n========== 补仓信号检测 ==========');
  const today = new Date().toISOString().slice(0, 10);

  // 获取所有启用了信号的用户配置
  const res = await db.query(
    `SELECT user_id, signal_pct, target_pct FROM position_config WHERE signal_enabled = true`
  );
  if (res.rows.length === 0) {
    console.log('无用户启用补仓信号');
    return;
  }

  const index = await getIndexDrawdown();
  if (!index) {
    console.log('获取指数数据失败，跳过');
    return;
  }

  console.log(`上证: ${index.current.toFixed(0)}  高点: ${index.high.toFixed(0)}  跌幅: ${index.drawdown.toFixed(2)}%`);

  for (const row of res.rows) {
    const userId = row.user_id;
    const threshold = Math.abs(parseFloat(row.signal_pct) || 10);
    const actualDrawdown = Math.abs(index.drawdown);

    // Check if already alerted today
    const lastDate = lastAlertSent.get(userId);
    if (lastDate === today) continue;

    if (actualDrawdown >= threshold) {
      // 找到下一个待触发的分批计划
      const plans = await db.getBatchPlans(userId);
      const nextPlan = plans.find(p => p.status === 'pending' && Math.abs(p.triggerPct) <= actualDrawdown);
      const planInfo = nextPlan
        ? `\n下一笔: 第${nextPlan.sortOrder}笔 ¥${(nextPlan.amount/10000).toFixed(1)}万`
        : '';

      const title = `📉 补仓信号触发: 上证跌 ${actualDrawdown.toFixed(1)}%`;
      const content = `上证指数从近期高点 ${index.high.toFixed(0)} 跌至 ${index.current.toFixed(0)}
跌幅 ${index.drawdown.toFixed(2)}%，已达到你设定的 ${threshold}% 阈值
目标仓位 ${row.target_pct}%${planInfo}`;

      await sendWechatMessage(title, content);

      // 标记对应分批计划为已触发
      if (nextPlan) {
        await db.query(
          `UPDATE batch_plans SET status = 'triggered' WHERE id = $1`,
          [nextPlan.id]
        );
        console.log(`用户 ${userId}: 第${nextPlan.sortOrder}笔已标记为触发`);
      }

      lastAlertSent.set(userId, today);
      console.log(`用户 ${userId}: 已发送补仓通知`);
    } else {
      console.log(`用户 ${userId}: 跌幅 ${actualDrawdown.toFixed(1)}% < 阈值 ${threshold}%，跳过`);
    }
  }

  console.log('========== 补仓检测完成 ==========\n');
}

module.exports = { checkIndexDrawdownAlerts, getIndexDrawdown };
