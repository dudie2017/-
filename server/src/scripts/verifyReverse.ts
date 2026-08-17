/**
 * 临时验证脚本：测试"饲料→养殖"反向传导及若干弱关联 pair 的正反方向命中率
 * 用于验证农产品饲料传导方向是否写反了
 */
import * as fs from 'fs';
import * as path from 'path';
import { VARIETIES } from '../services/varieties.js';

interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol?: number | null;
  hold?: number | null;
  ret: number | null;
  rollover?: boolean;
}

const DATA_DIR = 'data-cache-daily-20y';

function loadBars(code: string): Bar[] {
  const fp = path.join(DATA_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as Bar[];
  } catch {
    return [];
  }
}

function nameOf(code: string): string {
  return (VARIETIES as Record<string, string>)[code] || code;
}

function computeATR(bars: Bar[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) { trs.push(b.h - b.l); continue; }
    const prevC = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
  }
  const atrs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) { atrs.push(NaN); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trs[j];
    atrs.push(sum / period);
  }
  return atrs;
}

function test(leader: string, follower: string, lag: number) {
  const leaderBars = loadBars(leader);
  const followerBars = loadBars(follower);
  if (leaderBars.length < 60 || followerBars.length < 60) {
    console.log(`${leader}→${follower}  数据不足`);
    return;
  }
  const atrs = computeATR(leaderBars);
  const followerByIdx = new Map<string, number>();
  followerBars.forEach((b, i) => followerByIdx.set(b.date, i));

  for (const threshold of [2.0]) {
    let n = 0, hit = 0;
    for (let i = 14; i < leaderBars.length - 1; i++) {
      const b = leaderBars[i];
      if (b.rollover || b.ret === null || b.ret === undefined) continue;
      const atr = atrs[i];
      if (!isFinite(atr) || atr <= 0 || b.c <= 0) continue;
      const atrPct = atr / b.c;
      if (Math.abs(b.ret) < threshold * atrPct) continue;

      const leaderUp = b.ret >= 0;
      const fIdx = followerByIdx.get(b.date);
      if (fIdx === undefined) continue;
      const fTarget = followerBars[fIdx + lag];
      const fStart = followerBars[fIdx];
      if (!fTarget || !fStart || fStart.c <= 0) continue;
      const fCumRet = (fTarget.c - fStart.c) / fStart.c;
      const sameDir = leaderUp === (fCumRet >= 0);

      const nextLeader = leaderBars[i + 1];
      const confirmed = nextLeader && nextLeader.ret !== null && nextLeader.ret !== undefined
        ? (leaderUp ? nextLeader.ret >= 0 : nextLeader.ret < 0) : false;
      if (!confirmed) continue;

      n++;
      if (sameDir) hit++;
    }
    const wr = n >= 10 ? `${((hit / n) * 100).toFixed(0)}% N=${n}` : (n > 0 ? `${((hit / n) * 100).toFixed(0)}% N=${n}(样本少)` : '无样本');
    console.log(`${leader.padEnd(4)}(${nameOf(leader).padEnd(5)})→${follower.padEnd(4)}(${nameOf(follower).padEnd(5)}) lag=${lag}  2×ATR+确认: ${wr}`);
  }
}

console.log('========== 农产品饲料传导（正/反向对比） ==========');
// 当前正向（养殖→饲料，疑似方向反了）
test('JD0', 'M0', 2);
test('JD0', 'C0', 2);
test('LH0', 'M0', 3);
test('LH0', 'C0', 3);
// 反向（饲料→养殖，产业链正确方向）
test('M0', 'JD0', 2);
test('C0', 'JD0', 2);
test('M0', 'LH0', 3);
test('C0', 'LH0', 3);

console.log('');
console.log('========== 弱关联 pair 正/反向对比 ==========');
test('FU0', 'FG0', 2);
test('FG0', 'FU0', 2);
test('FU0', 'JM0', 1);
test('JM0', 'FU0', 1);
test('SF0', 'RB0', 2);
test('RB0', 'SF0', 2);
test('SA0', 'RB0', 2);
test('RB0', 'SA0', 2);
test('EC0', 'RB0', 3);
test('RB0', 'EC0', 3);
