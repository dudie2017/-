/**
 * TOP1 完整配方统一回测脚本（26 品种）
 *
 * 用途：让 APP 真正对齐 topComposite TOP1 完整配方后，对 26 个品种各跑一次完整回测，
 *       复用 1000 次实验同款引擎（runBacktest + 同一套后处理），保证结果可对比。
 *
 * 用法：npx tsx src/scripts/runTop1FullBacktest.ts
 * 输出：backtest-results/top1-unified-backtest-{timestamp}.json
 */

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';
import { TOP1_UNIFIED_PARAMS, type UnifiedRecipe } from '../data/top1UnifiedParams';
import type { V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OUT_DIR = path.join(process.cwd(), 'backtest-results');

// ============ 类型 ============
export interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }
export interface TradeLike { pnl: number; direction: 'LONG' | 'SHORT'; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; result?: string; [k: string]: any; }
export interface Stats {
  totalTrades: number; longTrades: number; shortTrades: number; wins: number; winRate: number;
  totalPnl: number; profitFactor: number; avgRR: number; longCapture: number; shortCapture: number; capture: number;
  maxDrawdown: number; longPnl: number; shortPnl: number;
  calmar?: number;
  avgHoldDays?: number;
}

// ============ 合约乘数映射（与 1000 次实验一致）============
const CONTRACT_MULTIPLIER: Record<string, number> = {
  IC0: 200, IF0: 300, IH0: 300, IM0: 200,
  RB0: 10, I0: 100, JM0: 60, J0: 100, HC0: 10, SP0: 10,
  CU0: 5, AL0: 5, ZN0: 5, PB0: 5, NI0: 1, SC0: 1000, AU0: 1000, AG0: 15,
  RU0: 10, FU0: 10, BU0: 10, EG0: 10, EB0: 5, FG0: 20, MA0: 10, PP0: 5, V0: 5, PG0: 20, LU0: 10,
  M0: 10, Y0: 10, CF0: 5, SR0: 10, A0: 10, C0: 10, JD0: 5, AP0: 10, CJ0: 5, RM0: 10, OI0: 20,
  LH0: 16, SI0: 5, TA0: 5, P0: 10,
};

function getMultiplier(code: string): number {
  return CONTRACT_MULTIPLIER[code] || 10;
}

// ============ 数据加载 ============
export function loadBars(code: string): Bar[] {
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
      if (price > lastExtreme.price) lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      else if (lastExtreme.price - price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = -1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      }
    } else {
      if (price < lastExtreme.price) lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      else if (price - lastExtreme.price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = 1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      }
    }
  }
  return points;
}

export function computeTheoreticalMax(bars: Bar[], thresholdPct: number) {
  const points = zigzag(bars, thresholdPct);
  let longReturn = 0, shortReturn = 0, longSegments = 0, shortSegments = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (a.type === b.type) continue;
    if (a.type === 'low' && b.type === 'high') { longReturn += (b.price - a.price) / a.price; longSegments++; }
    else if (a.type === 'high' && b.type === 'low') { shortReturn += (a.price - b.price) / a.price; shortSegments++; }
  }
  return { thresholdPct, swingCount: points.length, longSegments, shortSegments, longReturn, shortReturn, totalReturn: longReturn + shortReturn };
}

async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{ date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  return rows;
}

interface NewsFilter {
  mode: 'none' | 'riskOff' | 'full';
  cooldownMap?: Map<string, boolean[]>;
  shockDirMap?: Map<string, Array<'up' | 'down' | null>>;
  shockDates?: Map<string, Set<string>>;
  resonanceBoost?: number;
  divergenceCut?: number;
}

function buildBlackSwanFilter(code: string, mode: 'none' | 'riskOff' | 'full'): NewsFilter | undefined {
  if (mode === 'none') return undefined;
  const bars = loadVarietyBars(code, DATA_DIR) as any[];
  const cooldown = new Array<boolean>(bars.length).fill(false);
  const shockDates = new Set<string>();
  const shockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
  try {
    const shocks = detectShocks(bars as any, code) as Array<{ index: number; date: string; direction: 'up' | 'down' }>;
    for (const s of shocks) {
      shockDates.add(s.date);
      const until = Math.min(bars.length, s.index + 10);
      for (let j = s.index; j < until; j++) { cooldown[j] = true; shockDir[j] = s.direction; }
    }
    const barDateIdx = new Map<string, number>();
    bars.forEach((b: any, idx: number) => barDateIdx.set(b.date, idx));
    for (const ev of BLACK_SWAN_EVENTS) {
      if (!ev.varieties || !ev.varieties.includes(code)) continue;
      const idx = barDateIdx.get(ev.date);
      if (idx === undefined) continue;
      const until = Math.min(bars.length, idx + 10);
      for (let j = idx; j < until; j++) { cooldown[j] = true; shockDir[j] = ev.direction === '利空' ? 'down' : 'up'; }
    }
  } catch (e) {
    console.warn(`[${code}] 黑天鹅检测异常，回退为空过滤器:`, (e as Error).message);
  }
  return {
    mode,
    cooldownMap: new Map([[code, cooldown]]),
    shockDirMap: new Map([[code, shockDir]]),
    shockDates: new Map([[code, shockDates]]),
    resonanceBoost: 1.3,
    divergenceCut: 0.5,
  };
}

// ============ 数据窗口 ============
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

// ============ 统计（与 1000 次实验完全一致）============
export function calcStats(trades: TradeLike[], theoLong: number, theoShort: number, startCapital: number): Stats {
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const wins = trades.filter((t) => (t.pnl || 0) > 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => (t.pnl || 0) < 0).reduce((s, t) => s + t.pnl, 0));
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

// ============ 后处理风控层（与 1000 次实验完全一致）============
function addDays(dateStr: string, days: number): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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
    if (mode === 'atr2xClear' && ratio > 2.0) return { ...t, pnl: 0, result: 'volclear' };
    if (mode === 'atr15xHalf' && ratio > 1.5) return { ...t, pnl: t.pnl * 0.5 };
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
    if (key !== dayKey) { dayKey = key; dayPnl = 0; }
    if (dayPnl <= -limit) continue;
    out.push(t);
    dayPnl += t.pnl;
  }
  return out;
}

function applyFeeMult(trades: TradeLike[], mult: number, code: string): TradeLike[] {
  if (mult === 1) return trades;
  const multiplier = getMultiplier(code);
  return trades.map((t) => {
    const contractValue = Math.abs(t.entryPrice) * multiplier;
    const fee = contractValue * 0.00015 * 2;
    return { ...t, pnl: t.pnl + fee * (1 - mult) };
  });
}

function applyDirectionFilter(trades: TradeLike[], mode: string): TradeLike[] {
  if (mode === 'both') return trades;
  if (mode === 'longOnly') return trades.filter((t) => t.direction === 'LONG');
  if (mode === 'shortOnly') return trades.filter((t) => t.direction === 'SHORT');
  return trades;
}

// ============ 生产基线参数（用于 directionMode=split）============
function getBaseLong(code: string) { return LONG_REFINED_PARAMS[code] ?? LONG_OPT_PARAMS[code] ?? { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' }; }
function getBaseShort(code: string) { return SHORT_OPT_PARAMS[code] ?? { stopAtrMult: 2.07, targetAtrMult: 4.49, maxHoldDays: 28, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }; }

const BASE_OPTS = {
  startCapital: 500000,
  maxPositionPct: 0.15,
  minSignalGrade: 'L1' as string,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  warmupBars: 60,
  returnAllTrades: true,
  quiet: true,
};

function parsePct(v: string): number {
  if (v === 'off') return 0;
  return Number(v.replace('pct', '')) / 100;
}

// ============ TOP1 配方单品种回测（复刻 runExperiment 逻辑）============
export async function runTop1Backtest(code: string, recipe: UnifiedRecipe, bars: Bar[], theo: { longReturn: number; shortReturn: number }, windowOverride?: string) {
  const bsFilter = buildBlackSwanFilter(code, recipe.bsMode as 'none' | 'riskOff' | 'full');
  const longBase = getBaseLong(code);
  const shortBase = getBaseShort(code);

  const directionMode = recipe.directionMode;
  let sideParams: any = {};
  if (directionMode === 'split') {
    sideParams = {
      long: {
        stopAtrMult: longBase.stopAtrMult,
        targetAtrMult: longBase.targetAtrMult,
        maxHoldDays: longBase.maxHoldDays,
        cooldownBars: longBase.cooldownBars,
        trendFilter: longBase.trendFilter,
        minSignalGrade: longBase.minSignalGrade,
      },
      short: {
        stopAtrMult: shortBase.stopAtrMult,
        targetAtrMult: shortBase.targetAtrMult,
        maxHoldDays: shortBase.maxHoldDays,
        cooldownBars: shortBase.cooldownBars,
        trendFilter: shortBase.trendFilter,
        minSignalGrade: shortBase.minSignalGrade,
      },
    };
  } else {
    sideParams = {
      long: {
        stopAtrMult: recipe.stopAtrMult,
        targetAtrMult: recipe.targetAtrMult,
        maxHoldDays: recipe.maxHoldDays,
        cooldownBars: recipe.cooldownBars,
        trendFilter: recipe.trendFilter,
        minSignalGrade: recipe.minSignalGrade,
        minRR: recipe.minRR,
      },
      short: {
        stopAtrMult: recipe.stopAtrMult,
        targetAtrMult: recipe.targetAtrMult,
        maxHoldDays: recipe.maxHoldDays,
        cooldownBars: recipe.cooldownBars,
        trendFilter: recipe.trendFilter,
        minSignalGrade: recipe.minSignalGrade,
        minRR: recipe.minRR,
      },
    };
  }

  const edgeLB = Number(recipe.edgeLookback);
  const range = Boolean(recipe.allowRangeTrading);
  const signalCache: Map<string, V16Row[]> = new Map([[code, await getPrescannedRows(code, edgeLB, range)]]);

  const result: any = await runBacktest({
    ...BASE_OPTS,
    startCapital: Number(recipe.startCapital),
    maxPositionPct: Number(recipe.maxPositionPct),
    dataDir: DATA_DIR,
    codes: [code],
    signalCache,
    newsFilter: bsFilter,
    sideParams,
    edgeLookback: edgeLB,
    allowRangeTrading: range,
    pThreshold: Number(recipe.pThreshold),
    equationMode: recipe.equationMode as any,
    nonGreenMul: Number(recipe.nonGreenMul),
    counterCampMul: Number(recipe.counterCampMul),
    campWindow: Number(recipe.campWindow),
    softEquationMul: Number(recipe.softEquationMul) || 0.5,
    chExemptEquation: false,
  });

  let trades = (result.trades || []) as TradeLike[];
  trades = applyDirectionFilter(trades, directionMode);

  const cb = String(recipe.circuitBreaker);
  if (cb !== 'off') {
    const [n, m] = cb.split('x').map(Number);
    trades = applyCircuitBreaker(trades, n, m);
  }
  trades = applyVolReduce(trades, bars, String(recipe.volReduce));
  trades = applyDailyLossLimit(trades, Number(recipe.startCapital), parsePct(String(recipe.dailyLossLimit)));
  trades = applyFeeMult(trades, Number(recipe.feeMult), code);

  const win = applyWindow(bars, windowOverride ?? String(recipe.dataWindow));
  const startDate = win.slice[0]?.date || '';
  const endDate = win.slice[win.slice.length - 1]?.date || '';
  let wTheoLong = theo.longReturn;
  let wTheoShort = theo.shortReturn;
  if (win.label !== 'full') {
    trades = trades.filter((t) => t.entryDate >= startDate && t.entryDate <= endDate);
    const wTheo = computeTheoreticalMax(win.slice, 3);
    wTheoLong = wTheo.longReturn;
    wTheoShort = wTheo.shortReturn;
  }

  const stats = calcStats(trades, wTheoLong, wTheoShort, Number(recipe.startCapital));
  return { recipe, stats, trades };
}

// ============ 主流程 ============
async function main() {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS).sort();
  // 命令行参数：可选的窗口覆盖值（如 `full`），不传则使用配方自身 dataWindow
  const windowOverride = process.argv[2] || undefined;
  const modeLabel = windowOverride ? `窗口覆盖=${windowOverride}` : '窗口=配方自身dataWindow';
  console.log(`========== TOP1 完整配方统一回测（${codes.length} 个品种，${modeLabel}） ==========`);
  const results: Record<string, any> = {};

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const recipe = TOP1_UNIFIED_PARAMS[code];
    const bars = loadBars(code);
    if (bars.length === 0) {
      console.error(`[${code}] 未找到数据文件，跳过`);
      results[code] = { code, error: 'no_data' };
      continue;
    }
    const theo = computeTheoreticalMax(bars, 3);
    const appliedWindow = windowOverride ?? String(recipe.dataWindow);
    console.log(`[${i + 1}/${codes.length}] ${code} 回测中（K线 ${bars.length} 根，方向 ${recipe.directionMode}，窗口 ${appliedWindow}）...`);
    try {
      const r = await runTop1Backtest(code, recipe, bars, theo, windowOverride);
      results[code] = {
        code,
        recipe: { ...recipe, dataWindow: appliedWindow },
        stats: r.stats,
      };
      console.log(
        `  结果: 交易${r.stats.totalTrades} 胜率${(r.stats.winRate * 100).toFixed(1)}% 收益${Math.round(r.stats.totalPnl).toLocaleString()} 回撤${(r.stats.maxDrawdown * 100).toFixed(1)}% PF${r.stats.profitFactor.toFixed(2)}`,
      );
    } catch (e) {
      console.error(`[${code}] 回测失败:`, (e as Error).message);
      results[code] = { code, error: String((e as Error).message) };
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix = windowOverride ? `top1-fullwindow-backtest` : `top1-unified-backtest`;
  const outPath = path.join(OUT_DIR, `${prefix}-${ts}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ meta: { generatedAt: ts, codes: codes.length, windowOverride: windowOverride ?? null }, results }, null, 2), 'utf8');
  console.log(`\n结果已落盘: ${outPath}`);
}

// 仅在作为 CLI 脚本直接运行时执行 main；被 import 复用时不执行
if (process.argv[1]?.includes('runTop1FullBacktest.ts')) {
  main().catch((e) => {
    console.error('[TOP1 统一回测失败]', e);
    process.exit(1);
  });
}

