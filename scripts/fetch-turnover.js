/**
 * 抓取沪深两市历史成交额，合并保存
 * 用法: node scripts/fetch-turnover.js
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

function fetchEM(secid) {
  return new Promise((resolve, reject) => {
    const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=0&beg=20200101&end=20991231&lmt=2000`;
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'Referer': 'https://quote.eastmoney.com/',
      },
      timeout: 15000,
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve(data.data?.klines || []);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

async function main() {
  console.log('抓取沪市数据...');
  const sh = await fetchEM('1.000001');
  console.log(`沪市: ${sh.length} 条`);

  console.log('抓取深市数据...');
  const sz = await fetchEM('0.399001');
  console.log(`深市: ${sz.length} 条`);

  // Build map: date → { turnH, turnZ, shClose }
  const shMap = new Map();
  for (const line of sh) {
    const p = line.split(',');
    shMap.set(p[0], { shT: parseFloat(p[6]) || 0, shClose: parseFloat(p[2]) || 0 });
  }
  const szMap = new Map();
  for (const line of sz) {
    const p = line.split(',');
    szMap.set(p[0], parseFloat(p[6]) || 0);
  }

  const result = [];
  for (const [date, d] of shMap) {
    const szT = szMap.get(date);
    if (szT != null) {
      result.push({
        date,
        turnover: Math.round((d.shT + szT) / 1e8),
        shIndex: Math.round(d.shClose * 100) / 100,
      });
    }
  }

  const outPath = path.join(__dirname, '..', 'data', 'turnover.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result), 'utf8');

  const latest = result[result.length - 1];
  console.log(`\n完成: ${result.length} 条 (${result[0].date} ~ ${latest.date})`);
  console.log(`最新: ${latest.date} 成交${latest.turnover}亿 上证${latest.shIndex}`);
  process.exit(0);
}

main().catch(e => { console.error('失败:', e.message); process.exit(1); });
