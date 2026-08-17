import * as fs from 'fs';
import * as path from 'path';

// 复现原始白名单 HR 计算（与 runWhitelistExpansion.ts 相同口径）
const ATR_PERIOD = 14;
const ATR_MULT = 4;
const ATR_LONG = 60;

const DATA_DIR = '/workspace/projects/server/data-cache-daily-20y';

interface DailyBar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null; }

function loadData(code: string): DailyBar[] {
  const fp = path.join(DATA_DIR, code + '.json');
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return (raw as any[]).map(b => ({
    date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, hold: b.hold || 0, ret: b.ret,
  })).filter(b => b.ret !== null && b.ret !== undefined);
}

function calcATR(bars: DailyBar[], period: number): number[] {
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) { atr.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].h - bars[j].l;
    atr.push(sum / period);
  }
  return atr;
}

function detectShocks(bars: DailyBar[]): { barIdx: number; direction: 'up' | 'down' }[] {
  const shocks: { barIdx: number; direction: 'up' | 'down' }[] = [];
  const atr = calcATR(bars, ATR_PERIOD);
  const atrLong = calcATR(bars, ATR_LONG);
  for (let i = ATR_LONG + 1; i < bars.length; i++) {
    const bar = bars[i];
    const prevBar = bars[i - 1];
    if (bar.ret === null || atr[i] === 0) continue;
    const priceChange = Math.abs(bar.c - prevBar.c);
    const mult = priceChange / atr[i];
    if (mult >= ATR_MULT) {
      if (atrLong[i] > 0 && atr[i] < atrLong[i]) continue;
      shocks.push({ barIdx: i, direction: bar.ret > 0 ? 'up' : 'down' });
    }
  }
  return shocks;
}

// 用原始口径复现 HR（单日 ret 方向一致率）
function calcOriginalHR(leaderCode: string, followerCode: string, lag: number) {
  const lb = loadData(leaderCode);
  const fb = loadData(followerCode);
  if (lb.length === 0 || fb.length === 0) return { hr: 0, total: 0, shocks: 0 };
  const shocks = detectShocks(lb);
  let hits = 0, total = 0;
  for (const s of shocks) {
    const fIdx = s.barIdx + lag;
    if (fIdx >= fb.length) continue;
    const fBar = fb[fIdx];
    if (fBar.ret === null) continue;
    total++;
    const sameDir = (s.direction === 'up' && fBar.ret > 0) || (s.direction === 'down' && fBar.ret < 0);
    if (sameDir) hits++;
  }
  return { hr: total > 0 ? hits / total : 0, total, shocks: shocks.length };
}

// 用"持有 lag 天 + 扣成本"口径计算真实盈利比例
function calcTradingWinRate(leaderCode: string, followerCode: string, lag: number) {
  const lb = loadData(leaderCode);
  const fb = loadData(followerCode);
  const shocks = detectShocks(lb);
  let wins = 0, total = 0;
  for (const s of shocks) {
    const entryIdx = s.barIdx;
    const exitIdx = s.barIdx + lag;
    if (entryIdx >= fb.length || exitIdx >= fb.length) continue;
    const entry = fb[entryIdx].c;
    const exit = fb[exitIdx].c;
    if (entry === 0) continue;
    total++;
    const gross = s.direction === 'up' ? (exit - entry) / entry : (entry - exit) / entry;
    const net = gross - 0.002; // 扣 0.2% 成本
    if (net > 0) wins++;
  }
  return { winRate: total > 0 ? wins / total : 0, total };
}

const pairs = [
  ['CF0', 'SR0', 1],
  ['CF0', 'AP0', 1],
  ['WR0', 'I0', 1],
  ['SF0', 'SM0', 1],
  ['FU0', 'BU0', 1],
  ['FU0', 'L0', 1],
  ['M0', 'OI0', 2],
  ['A0', 'Y0', 1],
];

console.log('白名单标注HR | 原始口径HR(单日方向) | 交易盈利比例(持有+扣成本) | 差异');
console.log('--------------------------------------------------------------------------');
for (const [l, f, lag] of pairs as [string, string, number][]) {
  const orig = calcOriginalHR(l, f, lag);
  const trade = calcTradingWinRate(l, f, lag);
  const label = `${l}→${f}(lag${lag})`;
  console.log(
    `${label.padEnd(16)} HR=${(orig.hr * 100).toFixed(1).padStart(5)}% ` +
    `(N=${orig.total.toString().padStart(3)},冲击${orig.shocks}) | ` +
    `交易胜率=${(trade.winRate * 100).toFixed(1).padStart(5)}% (N=${trade.total}) | ` +
    `差距=${(trade.winRate * 100 - orig.hr * 100).toFixed(1)}pt`
  );
}
