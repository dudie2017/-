/**
 * E1: 信号漏斗诊断 — 定位各层过滤器的通过率瓶颈
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

// ============ 配置（与 runV16Backtest 一致）============
const ATR_PERIOD = 14;
const ATR_MULT = 4;
const ATR_LONG = 60;
const SECTOR_CORR_THRESHOLD = 0.5;
const SEASONAL_WINDOW = 15;

const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', B0: '油脂油料', P0: '油脂油料',
  CF0: '软商品', SR0: '软商品', AP0: '软商品', CJ0: '软商品',
  BU0: '能源', SC0: '能源', LU0: '能源', NR0: '能源', FU0: '能源',
  MA0: '化工', TA0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', PG0: '化工', V0: '化工',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融',
  WR0: '煤炭', ZC0: '煤炭',
  JD0: '农产品', LH0: '农产品',
  LC0: '新能源', SI0: '新能源',
};

interface DailyBar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null; }
interface Shock { code: string; date: string; barIdx: number; direction: 'up' | 'down'; ret: number; atrMult: number; }

const DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

function loadAllData(): Map<string, DailyBar[]> {
  const data = new Map<string, DailyBar[]>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const code = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    const bars = (raw as any[]).map(b => ({
      date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, hold: b.hold || 0, ret: b.ret,
    })).filter(b => b.ret !== null && b.ret !== undefined);
    if (bars.length > 100) data.set(code, bars);
  }
  return data;
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

function detectShocks(data: Map<string, DailyBar[]>, atrMult: number): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);
    for (let i = ATR_LONG + 1; i < bars.length; i++) {
      const bar = bars[i];
      const prevBar = bars[i - 1];
      if (bar.ret === null || atr[i] === 0) continue;
      const priceChange = Math.abs(bar.c - prevBar.c);
      const mult = priceChange / atr[i];
      if (mult >= atrMult) {
        if (atrLong[i] > 0 && atr[i] < atrLong[i]) continue;
        shocks.push({ code, date: bar.date, barIdx: i, direction: bar.ret > 0 ? 'up' : 'down', ret: bar.ret, atrMult: mult });
      }
    }
  }
  return shocks;
}

function checkSectorCorrelation(shock: Shock, data: Map<string, DailyBar[]>): boolean {
  const leaderSector = SECTOR_MAP[shock.code];
  if (!leaderSector) return false;
  const sameSectorCodes = Object.entries(SECTOR_MAP)
    .filter(([c, s]) => s === leaderSector && c !== shock.code)
    .map(([c]) => c);
  if (sameSectorCodes.length === 0) return false;
  let sameDir = 0, total = 0;
  for (const c of sameSectorCodes) {
    const otherBars = data.get(c);
    if (!otherBars) continue;
    const otherBar = otherBars[shock.barIdx];
    if (!otherBar || otherBar.ret === null) continue;
    total++;
    if ((shock.direction === 'up' && otherBar.ret > 0) || (shock.direction === 'down' && otherBar.ret < 0)) sameDir++;
  }
  if (total === 0) return false;
  return (sameDir / total) >= SECTOR_CORR_THRESHOLD;
}

function checkSeasonal(shock: Shock, data: Map<string, DailyBar[]>): boolean {
  const bars = data.get(shock.code);
  if (!bars) return false;
  const seasonalReturns: number[] = [];
  for (let yo = 1; yo <= 5; yo++) {
    for (let d = -SEASONAL_WINDOW; d <= SEASONAL_WINDOW; d++) {
      const idx = shock.barIdx - yo * 252 + d;
      if (idx < 0 || idx >= bars.length) continue;
      const bar = bars[idx];
      if (bar.ret !== null) seasonalReturns.push(bar.ret);
    }
  }
  if (seasonalReturns.length === 0) return false;
  const avg = seasonalReturns.reduce((a, b) => a + b, 0) / seasonalReturns.length;
  return (shock.direction === 'up' && avg > 0) || (shock.direction === 'down' && avg < 0);
}

// ============ 主函数 ============
function main() {
  console.log('=== 信号漏斗诊断 ===\n');
  
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种\n`);
  
  const shocks = detectShocks(data, ATR_MULT);
  console.log(`[L0] 总冲击数: ${shocks.length}`);
  
  // 统计哪些品种是白名单中的 leader
  const leaders = new Set(PROPAGATION_WHITELIST.map(p => p.leader));
  const shocksAsLeader = shocks.filter(s => leaders.has(s.code));
  console.log(`[L1] 冲击品种在白名单中是leader: ${shocksAsLeader.length} (${(shocksAsLeader.length/shocks.length*100).toFixed(1)}%)`);
  
  // 统计 leader 分布
  const leaderCount: Record<string, number> = {};
  for (const s of shocksAsLeader) {
    leaderCount[s.code] = (leaderCount[s.code] || 0) + 1;
  }
  console.log('\n白名单leader冲击分布:');
  const sorted = Object.entries(leaderCount).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of sorted) {
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === code).map(p => p.follower);
    console.log(`  ${code}: ${count}次 → followers: [${pairs.join(', ')}]`);
  }
  
  // 无leader覆盖的品种（有冲击但不在白名单leader中）
  const noLeaderShocks = shocks.filter(s => !leaders.has(s.code));
  const noLeaderCodes = new Set(noLeaderShocks.map(s => s.code));
  console.log(`\n无leader覆盖的冲击品种: ${noLeaderCodes.size}个`);
  const noLeaderCount: Record<string, number> = {};
  for (const s of noLeaderShocks) {
    noLeaderCount[s.code] = (noLeaderCount[s.code] || 0) + 1;
  }
  const noLeaderSorted = Object.entries(noLeaderCount).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of noLeaderSorted.slice(0, 15)) {
    const sector = SECTOR_MAP[code] || '未分类';
    console.log(`  ${code} (${sector}): ${count}次冲击`);
  }
  
  // S6 板块联动过滤
  const afterS6 = shocksAsLeader.filter(s => checkSectorCorrelation(s, data));
  console.log(`\n[L2] S6板块联动通过: ${afterS6.length} (${(afterS6.length/shocksAsLeader.length*100).toFixed(1)}%)`);
  
  // S7 季节性过滤
  const afterS7 = afterS6.filter(s => checkSeasonal(s, data));
  console.log(`[L3] S7季节性通过: ${afterS7.length} (${(afterS7.length/afterS6.length*100).toFixed(1)}%)`);
  
  // next1 确认
  let afterNext1 = 0;
  let next1Details: { code: string; date: string; dir: string; pairs: number }[] = [];
  for (const shock of afterS7) {
    const bars = data.get(shock.code);
    if (!bars) continue;
    const nextBar = bars[shock.barIdx + 1];
    if (!nextBar || nextBar.ret === null) continue;
    const confirm = (shock.direction === 'up' && nextBar.ret > 0) || (shock.direction === 'down' && nextBar.ret < 0);
    if (!confirm) continue;
    afterNext1++;
    const pairCount = PROPAGATION_WHITELIST.filter(p => p.leader === shock.code).length;
    next1Details.push({ code: shock.code, date: nextBar.date, dir: shock.direction, pairs: pairCount });
  }
  console.log(`[L4] next1确认通过: ${afterNext1} (${(afterNext1/afterS7.length*100).toFixed(1)}%)`);
  
  // 最终交易数
  let totalTrades = 0;
  for (const shock of afterS7) {
    const bars = data.get(shock.code);
    if (!bars) continue;
    const nextBar = bars[shock.barIdx + 1];
    if (!nextBar || nextBar.ret === null) continue;
    const confirm = (shock.direction === 'up' && nextBar.ret > 0) || (shock.direction === 'down' && nextBar.ret < 0);
    if (!confirm) continue;
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === shock.code);
    for (const pair of pairs) {
      const fBars = data.get(pair.follower);
      if (!fBars) continue;
      const entryIdx = shock.barIdx + 1 + pair.lag;
      if (entryIdx >= fBars.length) continue;
      totalTrades++;
    }
  }
  console.log(`[L5] 最终交易数: ${totalTrades}`);
  
  // 漏斗总结
  console.log('\n=== 漏斗总结 ===');
  console.log(`L0 总冲击:     ${shocks.length}`);
  console.log(`L1 白名单leader: ${shocksAsLeader.length} (↓${(shocks.length - shocksAsLeader.length)})`);
  console.log(`L2 S6板块联动:  ${afterS6.length} (↓${shocksAsLeader.length - afterS6.length})`);
  console.log(`L3 S7季节性:    ${afterS7.length} (↓${afterS6.length - afterS7.length})`);
  console.log(`L4 next1确认:   ${afterNext1} (↓${afterS7.length - afterNext1})`);
  console.log(`L5 最终交易:    ${totalTrades}`);
  console.log(`\n最大瓶颈层: L1白名单覆盖 (丢失${((1 - shocksAsLeader.length/shocks.length)*100).toFixed(1)}%)`);
}

main();
