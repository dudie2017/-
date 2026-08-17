import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data-cache-daily-20y');

interface Bar { date: string; close: number; }
function loadDaily(v: string): Bar[] {
  const fp = path.join(dataDir, v + '.json');
  if (!fs.existsSync(fp)) return [];
  return JSON.parse(fs.readFileSync(fp, 'utf-8')).map((r: any) => ({ date: r.date, close: r.c }));
}

// 白名单命中率（HR）vs 交易盈利比例 对比分析
// HR：leader 冲击后 follower 同向运动的比例（只看方向，不看幅度，不扣成本）
// 交易盈利比例：用 follower 价格同向开仓、持有 N 天、扣成本后盈利的比例
function analyzePair(leader: string, follower: string, lag: number, label: string) {
  const lb = loadDaily(leader);
  const fb = loadDaily(follower);
  if (lb.length === 0 || fb.length === 0) { console.log(`${leader}→${follower} 数据缺失`); return; }

  let total = 0, sameDir = 0, profitable = 0;
  for (let i = 30; i < Math.min(lb.length - 10, fb.length - 10); i++) {
    const lRet = (lb[i].close - lb[i - 1].close) / lb[i - 1].close;
    if (Math.abs(lRet) < 0.02) continue; // 简化冲击：leader 当日涨跌≥2%
    total++;
    if (total > 200) break;

    const fRet = (fb[i + lag].close - fb[i].close) / fb[i].close;
    const sameDirection = (lRet > 0 && fRet > 0) || (lRet < 0 && fRet < 0);
    if (sameDirection) sameDir++;

    // 模拟交易：同向开仓，持有 lag 天，扣 0.2% 成本
    const entry = fb[i].close;
    const exit = fb[i + lag].close;
    const gross = (lRet > 0) ? (exit - entry) / entry : (entry - exit) / entry;
    const net = gross - 0.002;
    if (net > 0) profitable++;
  }
  console.log(
    `${label} ${leader}→${follower}: HR=${(sameDir / total * 100).toFixed(1)}%, ` +
    `盈利比例=${(profitable / total * 100).toFixed(1)}% (N=${total})`
  );
}

console.log('=== 白名单 HR（方向命中率） vs 实际交易盈利比例 ===\n');
analyzePair('CF0', 'SR0', 1, '软商品');
analyzePair('CF0', 'AP0', 1, '软商品');
analyzePair('WR0', 'I0', 1, '黑色系');
analyzePair('SF0', 'SM0', 1, '黑色系');
analyzePair('FU0', 'BU0', 1, '能源');
analyzePair('FU0', 'L0', 1, '能源');
analyzePair('M0', 'OI0', 2, '油脂');
analyzePair('A0', 'Y0', 1, '油脂');
