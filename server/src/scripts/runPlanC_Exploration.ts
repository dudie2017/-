// @ts-nocheck
/**
 * 方案C：聚焦探索脚本
 *
 * 目标：探索新参数空间是否有提升（锁定已知最优维度，只探索新增参数）
 *
 * 探索维度：
 *   - edgeLookback: [60, 80, 120]（新增 3 档，原生产多为 70）
 *   - minSignalGrade: ['L1', 'L1.5', 'L2', 'L3']（新增 L1.5 中间档）
 *   - allowRangeTrading: [false, true]（维持 2 档）
 *
 * 锁定维度（已知最优，不探索）：
 *   - directionMode='split'（16/16 品种第一因子且最优）
 *   - dataWindow='full'（16/16 品种第二因子且最优）
 *   - circuitBreaker/maxPositionPct/volReduce/dailyLossLimit 用生产 REALTIME_OPT_PARAMS
 *
 * 每个品种：生产基线 1 组 + 探索组合 3×4×2=24 组 = 25 组
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

const ALL_CODES = ['SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0', 'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0'];

// 支持命令行指定品种子集：npx tsx runPlanC_Exploration.ts SC0,P0,J0
const CODES = process.argv[2] ? process.argv[2].split(',') : ALL_CODES;

// 探索空间
const EDGE_LOOKBACKS = [60, 80, 120];
const GRADES = ['L1', 'L1.5', 'L2', 'L3'];
const RANGES = [false, true];

// ============ 数据与理论最大 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

function loadBars(code: string): Bar[] {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data as Bar[];
    if (data && Array.isArray((data as any).bars)) return (data as any).bars as Bar[];
  } catch { /* ignore */ }
  return [];
}

interface SwingPoint { index: number; date: string; price: number; type: 'high' | 'low'; }

function zigzag(bars: Bar[], thresholdPct: number): SwingPoint[] {
  const th = thresholdPct / 100;
  const points: SwingPoint[] = [];
  if (bars.length === 0) return points;
  let state = 0;
  let startPrice = bars[0].c;
  let lastExtreme: SwingPoint = { index: 0, date: bars[0].date, price: bars[0].c, type: 'low' };
  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].c;
    if (state === 0) {
      if (price > startPrice * (1 + th)) {
        state = 1;
        points.push({ index: 0, date: bars[0].date, price: startPrice, type: 'low' });
        lastExtreme = { index: 0, date: bars[0].date, price: startPrice, type: 'low' };
      } else if (price < startPrice * (1 - th)) {
        state = -1;
        points.push({ index: 0, date: bars[0].date, price: startPrice, type: 'high' });
        lastExtreme = { index: 0, date: bars[0].date, price: startPrice, type: 'high' };
      }
      continue;
    }
    if (state === 1) {
      if (price > lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      } else if (lastExtreme.price - price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = -1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      }
    } else {
      if (price < lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      } else if (price - lastExtreme.price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = 1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      }
    }
  }
  return points;
}

function computeTheoreticalMax(bars: Bar[], thresholdPct: number) {
  const points = zigzag(bars, thresholdPct);
  let longReturn = 0, shortReturn = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (a.type === b.type) continue;
    if (a.type === 'low' && b.type === 'high') {
      longReturn += (b.price - a.price) / a.price;
    } else if (a.type === 'high' && b.type === 'low') {
      shortReturn += (a.price - b.price) / a.price;
    }
  }
  return { longReturn, shortReturn };
}

// ============ 预扫描缓存 ============
const cachePool = new Map<string, V16Row[]>();
let CURRENT_CODE = '';
async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const key = `${code}_${edgeLookback}_${allowRangeTrading}`;
  if (cachePool.has(key)) return cachePool.get(key)!;
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  cachePool.set(key, rows);
  console.log(`    [${code}] 预扫描完成: edge=${edgeLookback} range=${allowRangeTrading} → ${rows.length} 行`);
  return rows;
}

// ============ 后处理 ============
interface TradeLike {
  pnl: number;
  direction: 'LONG' | 'SHORT';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  result?: string;
}

function addDays(dateStr: string, days: number): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function applyDirectionFilter(trades: TradeLike[], mode: string): TradeLike[] {
  if (mode === 'both' || mode === 'split') return trades;
  if (mode === 'longOnly') return trades.filter((t) => t.direction === 'LONG');
  if (mode === 'shortOnly') return trades.filter((t) => t.direction === 'SHORT');
  return trades;
}

function applyCircuitBreaker(trades: TradeLike[], lossStreak: number, pauseDays: number): TradeLike[] {
  const out: TradeLike[] = [];
  let streak = 0;
  let frozenUntil = '';
  for (const t of trades) {
    if (frozenUntil && (!t.entryDate || t.entryDate < frozenUntil)) continue;
    out.push(t);
    if ((t.pnl || 0) <= 0) {
      streak++;
      if (streak >= lossStreak) {
        frozenUntil = addDays(t.exitDate || t.entryDate || '', pauseDays);
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return out;
}

function applyVolReduce(trades: TradeLike[], bars: Bar[], mode: string): TradeLike[] {
  if (mode === 'off' || bars.length < 60) return trades;
  const atr14: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 14) { atr14.push(0); continue; }
    let sum = 0;
    for (let j = i - 13; j <= i; j++) {
      const b = bars[j], prev = bars[j - 1];
      sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    }
    atr14.push(sum / 14);
  }
  const dateIdx = new Map<string, number>();
  bars.forEach((b, i) => dateIdx.set(b.date, i));
  return trades.map((t) => {
    const idx = dateIdx.get(t.entryDate);
    if (idx === undefined || idx < 60) return t;
    const short = atr14[idx];
    const longAvg = atr14.slice(Math.max(0, idx - 59), idx + 1).reduce((s, v) => s + v, 0) / Math.min(60, idx + 1);
    if (longAvg <= 0) return t;
    const ratio = short / longAvg;
    if (mode === 'atr2xClear' && ratio > 2.0) {
      return { ...t, pnl: 0, result: 'volclear' };
    }
    if (mode === 'atr15xHalf' && ratio > 1.5) {
      return { ...t, pnl: t.pnl * 0.5 };
    }
    return t;
  });
}

function applyDailyLossLimit(trades: TradeLike[], capital: number, pct: number): TradeLike[] {
  if (pct <= 0) return trades;
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  const out: TradeLike[] = [];
  let dayPnl = 0;
  let dayKey = '';
  const limit = capital * pct;
  for (const t of sorted) {
    const key = t.entryDate.slice(0, 10);
    if (key !== dayKey) {
      dayKey = key;
      dayPnl = 0;
    }
    if (dayPnl <= -limit) continue;
    out.push(t);
    dayPnl += t.pnl;
  }
  return out;
}

function applyFeeMult(trades: TradeLike[], mult: number): TradeLike[] {
  if (mult === 1) return trades;
  return trades;
}

function applyWindow(bars: Bar[], window: string): { slice: Bar[]; label: string } {
  const len = bars.length;
  let slice: Bar[];
  if (window === 'full') slice = bars;
  else if (window === 'front70') slice = bars.slice(0, Math.floor(len * 0.7));
  else if (window === 'back70') slice = bars.slice(Math.floor(len * 0.3));
  else if (window === 'last2y') slice = bars.slice(Math.max(0, len - 500));
  else if (window === 'last3y') slice = bars.slice(Math.max(0, len - 750));
  else slice = bars;
  return { slice, label: window };
}

// ============ 统计 ============
interface Stats {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  winRate: number;
  avgRR: number;
  profitFactor: number;
  maxDrawdown: number;
  totalPnl: number;
  longPnl: number;
  shortPnl: number;
  capture: number;
  longCapture: number;
  shortCapture: number;
}

function calcStats(trades: TradeLike[], theoLong: number, theoShort: number, startCapital = 500000): Stats {
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const longPriceReturn = longTrades.reduce((s, t) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.exitPrice - t.entryPrice) / ev;
  }, 0);
  const shortPriceReturn = shortTrades.reduce((s, t) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.entryPrice - t.exitPrice) / ev;
  }, 0);
  const longCapture = theoLong > 0 ? longPriceReturn / theoLong : 0;
  const shortCapture = theoShort > 0 ? shortPriceReturn / theoShort : 0;
  const avgRR = trades.length ? totalPnl / Math.max(grossLoss, 1) : 0;
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  let equity = startCapital;
  let peak = startCapital;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return {
    totalTrades: trades.length,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    avgRR,
    longCapture,
    shortCapture,
    capture: (longCapture + shortCapture) / 2,
    maxDrawdown: maxDd,
    longPnl: longTrades.reduce((s, t) => s + t.pnl, 0),
    shortPnl: shortTrades.reduce((s, t) => s + t.pnl, 0),
  };
}

function parsePct(v: string): number {
  if (v === 'off') return 0;
  return Number(v.replace('pct', '')) / 100;
}

// ============ 聚焦探索实验（锁定最优维度，只探索 edgeLookback/grade/range） ============
const BASE_OPTS = {
  startCapital: 500000,
  maxPositionPct: 0.15,
  minSignalGrade: 'L2' as string,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  warmupBars: 60,
  equationMode: 'none',
  softEquationMul: 0.5,
  pThreshold: 0.5,
  nonGreenMul: 1.0,
  counterCampMul: 1.0,
  feeMult: 1.0,
  returnAllTrades: true,
  quiet: true,
};

interface PlanCConfig {
  code: string;
  edgeLookback: number;
  allowRangeTrading: boolean;
  minSignalGrade: string;
  isProduction: boolean;
}

async function runFocusedExperiment(cfg: PlanCConfig, baseRecipe: Record<string, any>): Promise<Stats | null> {
  const { code } = cfg;
  const bars = loadBars(code);
  if (bars.length === 0) return null;

  // 基础配方 = baseline.recipe（品种专属，含 equationMode/pThreshold/soft 等）
  const startCapital = Number(baseRecipe.startCapital) || 500000;
  const maxPositionPct = Number(baseRecipe.maxPositionPct) ?? 0.15;
  const volReduce = String(baseRecipe.volReduce || 'off');
  const dailyLossLimit = String(baseRecipe.dailyLossLimit || 'off');
  const cbStr = String(baseRecipe.circuitBreaker || 'off');
  // 方案C口径：多空同参（完全基于 baseRecipe），不依赖品种脚本硬编码裂分
  // 这样生产基线与探索组合严格同口径，对比结论可靠
  const directionMode = 'both';
  const baseParams = {
    stopAtrMult: Number(baseRecipe.stopAtrMult) ?? 2.14,
    targetAtrMult: Number(baseRecipe.targetAtrMult) ?? 4.44,
    maxHoldDays: Number(baseRecipe.maxHoldDays) ?? 20,
    cooldownBars: Number(baseRecipe.cooldownBars) ?? 1,
    trendFilter: Boolean(baseRecipe.trendFilter),
    minSignalGrade: String(baseRecipe.minSignalGrade || 'L1'),
  };

  // 探索 minSignalGrade 时覆盖多空 grade
  const sideParams = {
    long: { ...baseParams, minSignalGrade: cfg.minSignalGrade },
    short: { ...baseParams, minSignalGrade: cfg.minSignalGrade },
  };

  const prescanned = await getPrescannedRows(code, cfg.edgeLookback, cfg.allowRangeTrading);
  const signalCache: Map<string, V16Row[]> = new Map([[code, prescanned]]);

  const result: any = await runBacktest({
    ...BASE_OPTS,
    startCapital,
    maxPositionPct,
    dataDir: DATA_DIR,
    codes: [code],
    signalCache,
    newsFilter: undefined,
    sideParams,
    edgeLookback: cfg.edgeLookback,
    allowRangeTrading: cfg.allowRangeTrading,
    pThreshold: Number(baseRecipe.pThreshold) ?? 0.5,
    equationMode: (baseRecipe.equationMode as any) ?? 'none',
    nonGreenMul: Number(baseRecipe.nonGreenMul) ?? 1.0,
    counterCampMul: Number(baseRecipe.counterCampMul) ?? 1.0,
    campWindow: Number(baseRecipe.campWindow) ?? 21,
    softEquationMul: Number(baseRecipe.softEquationMul) || 0.5,
    chExemptEquation: false,
    quiet: true,
    returnAllTrades: true,
  });

  let trades = (result.trades || []) as TradeLike[];
  trades = applyDirectionFilter(trades, directionMode);
  if (cbStr !== 'off') {
    const parts = cbStr.split('x').map(Number);
    if (parts.length === 2) trades = applyCircuitBreaker(trades, parts[0], parts[1]);
  }
  trades = applyVolReduce(trades, bars, volReduce);
  trades = applyDailyLossLimit(trades, startCapital, parsePct(dailyLossLimit));

  const theo = computeTheoreticalMax(bars, 3);
  return calcStats(trades, theo.longReturn, theo.shortReturn, startCapital);
}

// ============ Main ============
async function main() {
  console.log('=== 方案C：聚焦探索（edgeLookback × minSignalGrade × allowRangeTrading）===\n');

  const allSummary: Array<{
    code: string;
    prodPnl: number;
    prodPF: number;
    prodDD: number;
    prodWR: number;
    bestPnl: number;
    bestPF: number;
    bestDD: number;
    bestCombo: string;
    improvePnl: boolean;
    improvePF: boolean;
    improved: number;
    totalExplored: number;
  }> = [];

  for (const code of CODES) {
    CURRENT_CODE = code;
    console.log(`\n========== [${code}] ==========`);

    // 读取品种专属 baseline.recipe 作为基础配方
    let baseRecipe: Record<string, any> = {};
    try {
      const histPath = path.join(process.cwd(), 'src/data', code + '_1000Experiments.json');
      if (fs.existsSync(histPath)) {
        const hist = JSON.parse(fs.readFileSync(histPath, 'utf8'));
        baseRecipe = hist.baseline?.recipe || {};
      }
    } catch (e) { /* 无历史基线 */ }
    const prodGrade = String(baseRecipe.minSignalGrade || 'L1');

    // 生产基线：baseRecipe 原样（应重现基线收益）
    const prodStats = await runFocusedExperiment({
      code, edgeLookback: Number(baseRecipe.edgeLookback) || 70, allowRangeTrading: baseRecipe.allowRangeTrading !== false, minSignalGrade: prodGrade, isProduction: true,
    }, baseRecipe);
    if (!prodStats) {
      console.log(`  无数据，跳过`);
      continue;
    }
    console.log(`  生产基线: 收益=${(prodStats.totalPnl / 10000).toFixed(1)}万 胜率=${(prodStats.winRate * 100).toFixed(1)}% 回撤=${(prodStats.maxDrawdown * 100).toFixed(1)}% PF=${prodStats.profitFactor.toFixed(2)}`);

    // 探索组合：baseRecipe 基础上只改 edge/range/grade
    const results: Array<{ cfg: PlanCConfig; stats: Stats }> = [];
    for (const edge of EDGE_LOOKBACKS) {
      for (const grade of GRADES) {
        for (const range of RANGES) {
          const stats = await runFocusedExperiment({
            code, edgeLookback: edge, allowRangeTrading: range, minSignalGrade: grade, isProduction: false,
          }, baseRecipe);
          if (stats) results.push({ cfg: { code, edgeLookback: edge, allowRangeTrading: range, minSignalGrade: grade, isProduction: false }, stats });
        }
      }
    }

    // 排序：按收益
    const sortedByPnl = [...results].sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
    const sortedByPF = [...results].sort((a, b) => b.stats.profitFactor - a.stats.profitFactor);

    console.log(`  --- 收益 Top5 ---`);
    for (let i = 0; i < Math.min(5, sortedByPnl.length); i++) {
      const r = sortedByPnl[i];
      const pct = ((r.stats.totalPnl - prodStats.totalPnl) / Math.abs(prodStats.totalPnl) * 100).toFixed(1);
      console.log(`    #${i + 1} edge=${r.cfg.edgeLookback} grade=${r.cfg.minSignalGrade} range=${r.cfg.allowRangeTrading} → ${(r.stats.totalPnl / 10000).toFixed(1)}万 (${pct >= 0 ? '+' : ''}${pct}%) PF=${r.stats.profitFactor.toFixed(2)} dd=${(r.stats.maxDrawdown * 100).toFixed(1)}%`);
    }
    console.log(`  --- PF Top5 ---`);
    for (let i = 0; i < Math.min(5, sortedByPF.length); i++) {
      const r = sortedByPF[i];
      console.log(`    #${i + 1} edge=${r.cfg.edgeLookback} grade=${r.cfg.minSignalGrade} range=${r.cfg.allowRangeTrading} → PF=${r.stats.profitFactor.toFixed(2)} 收益=${(r.stats.totalPnl / 10000).toFixed(1)}万 dd=${(r.stats.maxDrawdown * 100).toFixed(1)}%`);
    }

    // 汇总：优于生产的组合数（收益↑ 且 PF↑）
    const improved = results.filter((r) => r.stats.totalPnl > prodStats.totalPnl && r.stats.profitFactor >= prodStats.profitFactor);
    const best = sortedByPnl[0];
    allSummary.push({
      code,
      prodPnl: prodStats.totalPnl,
      prodPF: prodStats.profitFactor,
      prodDD: prodStats.maxDrawdown,
      prodWR: prodStats.winRate,
      bestPnl: best ? best.stats.totalPnl : 0,
      bestPF: best ? best.stats.profitFactor : 0,
      bestDD: best ? best.stats.maxDrawdown : 0,
      bestCombo: best ? `edge=${best.cfg.edgeLookback} grade=${best.cfg.minSignalGrade} range=${best.cfg.allowRangeTrading}` : '',
      improvePnl: best ? best.stats.totalPnl > prodStats.totalPnl : false,
      improvePF: best ? best.stats.profitFactor > prodStats.profitFactor : false,
      improved: improved.length,
      totalExplored: results.length,
    });
  }

  // ============ 汇总表 ============
  console.log('\n\n=========== 汇总：探索结果 vs 生产基线 ===========');
  console.log('品种   生产收益(万)  最优收益(万)  提升%   最优PF  生产PF  最优组合                       收益↑PF↑组合数');
  console.log('-'.repeat(120));
  let totalProd = 0, totalBest = 0, totalImprovedVarieties = 0;
  for (const s of allSummary) {
    const pct = ((s.bestPnl - s.prodPnl) / Math.abs(s.prodPnl) * 100).toFixed(1);
    totalProd += s.prodPnl;
    totalBest += s.bestPnl;
    if (s.improvePnl && s.improvePF) totalImprovedVarieties++;
    console.log(
      s.code.padEnd(7) +
      (s.prodPnl / 10000).toFixed(1).padStart(12) +
      (s.bestPnl / 10000).toFixed(1).padStart(12) +
      (pct + '%').padStart(9) +
      s.bestPF.toFixed(2).padStart(9) +
      s.prodPF.toFixed(2).padStart(9) +
      s.bestCombo.padStart(34) +
      `  ${s.improved}/${s.totalExplored}`
    );
  }
  console.log('-'.repeat(120));
  console.log(
    '合计'.padEnd(7) +
    (totalProd / 10000).toFixed(1).padStart(12) +
    (totalBest / 10000).toFixed(1).padStart(12) +
    (((totalBest - totalProd) / Math.abs(totalProd)) * 100).toFixed(1).padStart(9) + '%' +
    `\n品种数(收益↑且PF↑): ${totalImprovedVarieties}/${allSummary.length}`
  );
}

main().catch((e) => {
  console.error('ERROR:', e);
  process.exit(1);
});

