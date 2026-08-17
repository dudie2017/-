// @ts-nocheck
/**
 * 品种 1000 次实验回测服务（通用版）
 *
 * 从原 scripts/runVariety1000Experiments.ts 抽取而来，作为统一回测入口。
 * 历史专用脚本（scripts/runXX_1000Experiments.ts）为复制粘贴版本，已由本服务取代，
 * 未来新增品种请统一调用 runVariety1000Experiments(code)。
 *
 * 输出：src/data/{code}_1000Experiments.json（标准格式：meta/baseline/topComposite/fullResults）
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

// ============ 常量 ============
const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const SEED = 20260813; // 统一种子，保证可复现

// ============ 类型 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }
interface V16Row { date: string; edgeScore: number; rangeScore: number; trendScore: number; campScore: number; signalGrade: string; isNonGreen: boolean; isCounterCamp: boolean; [k: string]: any; }
interface TradeLike { pnl: number; direction: 'LONG' | 'SHORT'; entryDate: string; exitDate: string; entryPrice: number; exitPrice: number; result?: string; [k: string]: any; }
interface Stats {
  totalTrades: number; longTrades: number; shortTrades: number; wins: number; winRate: number;
  totalPnl: number; profitFactor: number; avgRR: number; longCapture: number; shortCapture: number; capture: number;
  maxDrawdown: number; longPnl: number; shortPnl: number;
}

// ============ 合约乘数映射（用于手续费计算）============
const CONTRACT_MULTIPLIER: Record<string, number> = {
  // 股指期货
  IC0: 200, IF0: 300, IH0: 300, IM0: 200,
  // 国债期货
  T0: 10000, TF0: 10000,
  // 黑色系
  RB0: 10, I0: 100, JM0: 60, J0: 100, HC0: 10, SP0: 10, WR0: 10,
  // 有色金属
  CU0: 5, AL0: 5, ZN0: 5, PB0: 5, NI0: 1, SC0: 1000, AU0: 1000, AG0: 15, BC0: 5, SS0: 5, AO0: 20,
  // 能源化工
  RU0: 10, FU0: 10, BU0: 10, EG0: 10, EB0: 5, FG0: 20, MA0: 10, PP0: 5, V0: 5, PG0: 20, LU0: 10,
  L0: 5, PX0: 5, UR0: 20, SA0: 20, NR0: 10, ZC0: 100, EC0: 50,
  // 农产品
  M0: 10, Y0: 10, CF0: 5, SR0: 10, A0: 10, C0: 10, JD0: 5, AP0: 10, CJ0: 5, RM0: 10, OI0: 20,
  // 其他
  LH0: 16, SI0: 5, TA0: 5, P0: 10, LC0: 1, SF0: 5, SM0: 5,
};

function getMultiplier(code: string): number {
  return CONTRACT_MULTIPLIER[code] || 10; // 默认 10
}

// ============ LHS 采样 ============
interface Dim { name: string; values: (number | string | boolean)[]; }

function buildDims(): Dim[] {
  return [
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
    { name: 'trendFilter', values: [true, false] },
    { name: 'cooldownBars', values: [0, 1, 2, 4] },
    { name: 'edgeLookback', values: [50, 70, 100] },
    { name: 'allowRangeTrading', values: [false, true] },
    { name: 'equationMode', values: ['strict', 'soft', 'off'] },
    { name: 'pThreshold', values: [0.4, 0.45, 0.5, 0.55, 0.6] },
    { name: 'stopAtrMult', values: [1.5, 2.0, 2.5, 3.0] },
    { name: 'targetAtrMult', values: [2.0, 3.0, 4.0, 5.0] },
    { name: 'maxHoldDays', values: [15, 25, 40, 60] },
    { name: 'minRR', values: [0.8, 1.0, 1.2, 1.5] },
    { name: 'maxPositionPct', values: [0.15, 0.25, 0.3] },
    { name: 'directionMode', values: ['both', 'split', 'longOnly', 'shortOnly'] },
    { name: 'dataWindow', values: ['full', 'front70', 'back70', 'last2y', 'last3y'] },
    { name: 'nonGreenMul', values: [0.5, 1.0, 1.5] },
    { name: 'counterCampMul', values: [0.5, 0.8, 1.0] },
    { name: 'campWindow', values: [20, 30, 40] },
    { name: 'bsMode', values: ['none', 'riskOff', 'full'] },
    { name: 'circuitBreaker', values: ['off', '3x10', '5x20'] },
    { name: 'volReduce', values: ['off', 'atr15xHalf', 'atr2xClear'] },
    { name: 'dailyLossLimit', values: ['off', '5pct', '8pct'] },
    { name: 'softEquationMul', values: [0.5, 0.7, 0.85] },
    { name: 'feeMult', values: [1, 2, 3] },
    { name: 'startCapital', values: [500000, 1000000] },
  ];
}

function mulberry32(seed: number) {
  let s = seed | 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function lhsUnique(n: number, dims: Dim[], seed: number): Record<string, number | string | boolean>[] {
  const rng = mulberry32(seed);
  const seen = new Set<string>();
  const out: Record<string, number | string | boolean>[] = [];
  let attempts = 0;
  while (out.length < n && attempts < n * 20) {
    attempts++;
    const recipe: Record<string, number | string | boolean> = {};
    for (const dim of dims) {
      const idx = Math.floor(rng() * dim.values.length);
      recipe[dim.name] = dim.values[idx];
    }
    const key = Object.entries(recipe).map(([k, v]) => `${k}=${v}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(recipe);
  }
  return out;
}

// ============ 数据加载 ============
function loadBars(code: string): Bar[] {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8');
    const data = JSON.parse(raw);
    let bars: Bar[] = [];
    if (Array.isArray(data)) bars = data as Bar[];
    else if (data && Array.isArray((data as any).bars)) bars = (data as any).bars as Bar[];
    // 防御性过滤：剔除 c 无效的无交易空行（避免 null 污染 zigzag/ATR/信号计算）
    return bars.filter((b) => b.c !== null && b.c !== undefined && isFinite(b.c) && b.c > 0);
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
  let longReturn = 0, shortReturn = 0, longSegments = 0, shortSegments = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (a.type === b.type) continue;
    if (a.type === 'low' && b.type === 'high') {
      longReturn += (b.price - a.price) / a.price;
      longSegments++;
    } else if (a.type === 'high' && b.type === 'low') {
      shortReturn += (a.price - b.price) / a.price;
      shortSegments++;
    }
  }
  return { thresholdPct, swingCount: points.length, longSegments, shortSegments, longReturn, shortReturn, totalReturn: longReturn + shortReturn };
}

// 信号预扫描缓存：同一品种的 6 组 (edgeLookback × allowRangeTrading) 组合只扫描一次，
// 避免 1000 次实验重复遍历全量 K 线（原实现每次实验都重扫，导致单品种耗时数小时）。
const _prescanCache = new Map<string, V16Row[]>();

async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const cacheKey = `${code}|${edgeLookback}|${allowRangeTrading}`;
  const cached = _prescanCache.get(cacheKey);
  if (cached) return cached;

  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const allBars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  // 防御性过滤：剔除 c 无效的无交易空行
  const bars = allBars.filter((b) => b.c !== null && b.c !== undefined && isFinite(b.c) && b.c > 0);
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  _prescanCache.set(cacheKey, rows);
  return rows;
}

// ============ 黑天鹅过滤 ============
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
      for (let j = s.index; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = s.direction;
      }
    }
    const barDateIdx = new Map<string, number>();
    bars.forEach((b: any, idx: number) => barDateIdx.set(b.date, idx));
    for (const ev of BLACK_SWAN_EVENTS) {
      if (!ev.varieties || !ev.varieties.includes(code)) continue;
      const idx = barDateIdx.get(ev.date);
      if (idx === undefined) continue;
      const until = Math.min(bars.length, idx + 10);
      for (let j = idx; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = ev.direction === '利空' ? 'down' : 'up';
      }
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

// ============ 统计 ============
function calcStats(trades: TradeLike[], theoLong: number, theoShort: number, startCapital: number): Stats {
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

// ============ 后处理风控层 ============
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

function addDays(dateStr: string, days: number): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
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

// ============ 生产基线参数 ============
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

// ============ 单次实验 ============
interface ExpResult {
  id: number;
  recipe: Record<string, number | string | boolean>;
  stats: Stats;
  recipeKey: string;
}

async function runExperiment(
  code: string,
  id: number,
  recipe: Record<string, number | string | boolean>,
  bars: Bar[],
  theo: { longReturn: number; shortReturn: number },
): Promise<ExpResult> {
  const bsFilter = buildBlackSwanFilter(code, String(recipe.bsMode) as 'none' | 'riskOff' | 'full');
  const longBase = getBaseLong(code);
  const shortBase = getBaseShort(code);

  const directionMode = String(recipe.directionMode);
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

  const win = applyWindow(bars, String(recipe.dataWindow));
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
  return { id, recipe, stats, recipeKey: '' };
}

function parsePct(v: string): number {
  if (v === 'off') return 0;
  return Number(v.replace('pct', '')) / 100;
}

// ============ 方差分解 ============
interface DimAnalysis {
  dimension: string;
  groupCount: number;
  betweenVar: number;
  totalVar: number;
  explained: number;
  bestValue: string;
  worstValue: string;
  spread: number;
}

function analyzeDimension(results: ExpResult[], dims: Dim[], metric: 'totalPnl' | 'maxDrawdown' | 'capture'): DimAnalysis[] {
  return dims.map((dim) => {
    const groups = new Map<string, number[]>();
    for (const r of results) {
      const v = String(r.recipe[dim.name]);
      if (!groups.has(v)) groups.set(v, []);
      groups.get(v)!.push(r.stats[metric] as number);
    }
    const groupMeans = [...groups.entries()].map(([v, arr]) => ({
      v,
      mean: arr.reduce((s, x) => s + x, 0) / arr.length,
      n: arr.length,
    }));
    const grand = results.reduce((s, r) => s + (r.stats[metric] as number), 0) / Math.max(1, results.length);
    let between = 0;
    for (const g of groupMeans) between += g.n * (g.mean - grand) ** 2;
    const total = results.reduce((s, r) => s + ((r.stats[metric] as number) - grand) ** 2, 0);
    groupMeans.sort((a, b) => b.mean - a.mean);
    return {
      dimension: dim.name,
      groupCount: groupMeans.length,
      betweenVar: between,
      totalVar: total,
      explained: total > 0 ? between / total : 0,
      bestValue: groupMeans[0]?.v ?? '',
      worstValue: groupMeans[groupMeans.length - 1]?.v ?? '',
      spread: (groupMeans[0]?.mean ?? 0) - (groupMeans[groupMeans.length - 1]?.mean ?? 0),
    };
  }).sort((a, b) => b.explained - a.explained);
}

// ============ 脆弱点识别 ============
function findFragility(results: ExpResult[], dims: Dim[]) {
  const fragile = results.filter((r) => r.stats.totalPnl < 0 || r.stats.maxDrawdown > 0.5);
  if (fragile.length === 0) return { count: 0, topFactors: [] };
  const total = results.length;
  const factors: Array<{ dimension: string; value: string; inFragile: number; inAll: number; lift: number }> = [];
  for (const dim of dims) {
    for (const v of dim.values) {
      const key = String(v);
      const inFragile = fragile.filter((r) => String(r.recipe[dim.name]) === key).length;
      const inAll = results.filter((r) => String(r.recipe[dim.name]) === key).length;
      if (inAll === 0) continue;
      const fragRatio = inFragile / Math.max(1, fragile.length);
      const allRatio = inAll / total;
      factors.push({
        dimension: dim.name,
        value: key,
        inFragile,
        inAll,
        lift: allRatio > 0 ? fragRatio / allRatio : 0,
      });
    }
  }
  factors.sort((a, b) => b.lift - a.lift);
  return { count: fragile.length, topFactors: factors.slice(0, 15) };
}

// ============ 主流程 ============
const N_EXPERIMENTS = 1000;

function makeRecipeKey(recipe: Record<string, number | string | boolean>): string {
  return Object.entries(recipe).map(([k, v]) => `${k}=${v}`).join('|');
}

function pickStats(s: Stats) {
  return {
    totalTrades: s.totalTrades,
    longTrades: s.longTrades,
    shortTrades: s.shortTrades,
    wins: s.wins,
    winRate: +s.winRate.toFixed(4),
    totalPnl: +s.totalPnl.toFixed(2),
    maxDrawdown: +s.maxDrawdown.toFixed(4),
    profitFactor: +s.profitFactor.toFixed(4),
    avgRR: +s.avgRR.toFixed(4),
    capture: +s.capture.toFixed(4),
    longCapture: +s.longCapture.toFixed(4),
    shortCapture: +s.shortCapture.toFixed(4),
    longPnl: +s.longPnl.toFixed(2),
    shortPnl: +s.shortPnl.toFixed(2),
  };
}

export async function runVariety1000Experiments(code: string): Promise<string> {
  console.log(`========== ${code} 1000 次实验（24 维方法论空间） ==========`);
  console.log('1/6 加载数据与理论基准...');
  const bars = loadBars(code);
  if (bars.length === 0) {
    throw new Error(`未找到 ${code} 的数据文件`);
  }
  console.log(`${code} K线 ${bars.length} 根（${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}）`);
  const theo = computeTheoreticalMax(bars, 3);
  console.log(
    `全量理论: 摆动 ${theo.swingCount} 段 | 做多 ${theo.longSegments} 段 ${(theo.longReturn * 100).toFixed(1)}% | 做空 ${theo.shortSegments} 段 ${(theo.shortReturn * 100).toFixed(1)}%`,
  );

  console.log('2/6 预扫描信号缓存（edgeLookback × allowRangeTrading 变体）...');
  const cacheStats: Array<{ edge: number; range: boolean; rows: number }> = [];
  for (const e of [50, 70, 100]) {
    for (const r of [false, true]) {
      const rows = await getPrescannedRows(code, e, r);
      cacheStats.push({ edge: e, range: r, rows: rows.length });
    }
  }
  console.log(`缓存组合 ${cacheStats.length} 组: ${cacheStats.map((c) => `e${c.edge}/r${c.range}=${c.rows}行`).join(', ')}`);

  console.log('3/6 运行基线...');
  const baseRecipe: Record<string, number | string | boolean> = {
    minSignalGrade: 'L1', trendFilter: false, cooldownBars: 0, edgeLookback: 70,
    allowRangeTrading: false, equationMode: 'strict', pThreshold: 0.45, softEquationMul: 0.5,
    stopAtrMult: 1.5, targetAtrMult: 3.0, maxHoldDays: 15, minRR: 1.0,
    maxPositionPct: 0.15, directionMode: 'both', dataWindow: 'full',
    nonGreenMul: 1.0, counterCampMul: 1.0, campWindow: 30, feeMult: 1.0,
    startCapital: 500000, bsMode: 'none',
    circuitBreaker: 'off', volReduce: 'off', dailyLossLimit: 'off',
  };
  const base = await runExperiment(code, 0, baseRecipe, bars, theo);
  base.recipeKey = makeRecipeKey(baseRecipe);
  console.log(
    `基线: 交易${base.stats.totalTrades} 胜率${(base.stats.winRate * 100).toFixed(1)}% 收益${Math.round(base.stats.totalPnl).toLocaleString()} 回撤${(base.stats.maxDrawdown * 100).toFixed(1)}% PF${base.stats.profitFactor.toFixed(2)} 捕获${(base.stats.capture * 100).toFixed(1)}%`,
  );

  console.log(`4/6 LHS 采样 ${N_EXPERIMENTS} 个唯一配方...`);
  const dims = buildDims();
  const samples = lhsUnique(N_EXPERIMENTS, dims, SEED);
  console.log(`有效唯一配方 ${samples.length} 个`);
  if (samples.length < N_EXPERIMENTS) {
    console.warn(`警告: 去重后不足 ${N_EXPERIMENTS}，继续使用 ${samples.length} 个`);
  }

  console.log('5/6 逐次执行回测...');
  const results: ExpResult[] = [base];
  for (let i = 0; i < samples.length; i++) {
    const recipe = samples[i];
    const r = await runExperiment(code, i + 1, recipe, bars, theo);
    r.recipeKey = makeRecipeKey(recipe);
    results.push(r);
    if ((i + 1) % 100 === 0) console.log(`  进度 ${i + 1}/${samples.length}（累计 ${results.length}）`);
  }
  console.log(`回测完成，共 ${results.length} 次实验`);

  console.log('6/6 分析：方差分解 / 脆弱点 / 排名 / 最优配方...');
  const vdPnl = analyzeDimension(results, dims, 'totalPnl');
  const vdDD = analyzeDimension(results, dims, 'maxDrawdown');
  const vdCap = analyzeDimension(results, dims, 'capture');
  console.log('--- 收益方差分解 TOP8 ---');
  vdPnl.slice(0, 8).forEach((d) =>
    console.log(`  ${d.dimension}: 解释度${(d.explained * 100).toFixed(1)}% 最优=${d.bestValue} 最劣=${d.worstValue} 极差${Math.round(d.spread).toLocaleString()}元`),
  );
  console.log('--- 回撤方差分解 TOP5 ---');
  vdDD.slice(0, 5).forEach((d) =>
    console.log(`  ${d.dimension}: 解释度${(d.explained * 100).toFixed(1)}% 最优=${d.bestValue} 最劣=${d.worstValue}`),
  );

  const fragility = findFragility(results, dims);
  console.log(`--- 脆弱点: ${fragility.count}/${results.length} 组崩溃（收益<0 或回撤>50%） ---`);
  fragility.topFactors.slice(0, 10).forEach((f) =>
    console.log(`  ${f.dimension}=${f.value}: 崩溃占比${(f.inFragile / Math.max(1, fragility.count) * 100).toFixed(0)}% vs 全局${(f.inAll / results.length * 100).toFixed(0)}% 提升${f.lift.toFixed(2)}x`),
  );

  const rankByPnl = [...results].sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  const rankByDD = [...results].sort((a, b) => a.stats.maxDrawdown - b.stats.maxDrawdown);
  const rankByCap = [...results].sort((a, b) => b.stats.capture - a.stats.capture);
  const baseRankPnl = rankByPnl.findIndex((r) => r.id === 0);
  const baseRankDD = rankByDD.findIndex((r) => r.id === 0);
  const baseRankCap = rankByCap.findIndex((r) => r.id === 0);
  console.log(`--- 当前参数排名: 收益 #${baseRankPnl + 1}/${results.length} | 回撤 #${baseRankDD + 1} | 捕获 #${baseRankCap + 1} ---`);

  const scored = results.map((r) => ({
    ...r,
    score: r.stats.totalPnl * 1.0 - r.stats.maxDrawdown * 1_000_000 * 2 + r.stats.winRate * 500_000 + r.stats.capture * 800_000,
  })).sort((a, b) => b.score - a.score);
  console.log('--- 综合 TOP5 配方 ---');
  scored.slice(0, 5).forEach((r, idx) => {
    const recipeStr = Object.entries(r.recipe)
      .filter(([k]) => ['stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'minSignalGrade', 'trendFilter', 'cooldownBars', 'bsMode', 'circuitBreaker', 'volReduce', 'dailyLossLimit', 'directionMode', 'dataWindow'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(
      `  #${idx + 1} 收益${Math.round(r.stats.totalPnl).toLocaleString()} 胜率${(r.stats.winRate * 100).toFixed(1)}% 回撤${(r.stats.maxDrawdown * 100).toFixed(1)}% 捕获${(r.stats.capture * 100).toFixed(1)}% PF${r.stats.profitFactor.toFixed(2)} | ${recipeStr}`,
    );
  });

  // 落盘
  const output = {
    meta: {
      code,
      experiments: results.length,
      seed: SEED,
      bars: bars.length,
      dateRange: `${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}`,
      theoLong: +theo.longReturn.toFixed(4),
      theoShort: +theo.shortReturn.toFixed(4),
      dimensions: dims.map((d) => ({ name: d.name, values: d.values })),
    },
    baseline: {
      recipe: baseRecipe,
      stats: {
        totalTrades: base.stats.totalTrades,
        winRate: +base.stats.winRate.toFixed(4),
        totalPnl: +base.stats.totalPnl.toFixed(2),
        maxDrawdown: +base.stats.maxDrawdown.toFixed(4),
        profitFactor: +base.stats.profitFactor.toFixed(4),
        capture: +base.stats.capture.toFixed(4),
        longCapture: +base.stats.longCapture.toFixed(4),
        shortCapture: +base.stats.shortCapture.toFixed(4),
      },
      rank: { pnl: baseRankPnl + 1, dd: baseRankDD + 1, capture: baseRankCap + 1, total: results.length },
    },
    varianceDecomposition: { totalPnl: vdPnl, maxDrawdown: vdDD, capture: vdCap },
    fragility: {
      count: fragility.count,
      total: results.length,
      topFactors: fragility.topFactors.map((f) => ({ ...f, inFragile: +f.inFragile, inAll: +f.inAll, lift: +f.lift.toFixed(2) })),
    },
    topPnl: rankByPnl.slice(0, 20).map((r) => ({ id: r.id, recipe: r.recipe, stats: pickStats(r.stats) })),
    topComposite: scored.slice(0, 20).map((r) => ({ id: r.id, recipe: r.recipe, score: +r.score.toFixed(2), stats: pickStats(r.stats) })),
    fullResults: results.map((r) => ({
      id: r.id,
      recipe: r.recipe,
      stats: pickStats(r.stats),
    })),
  };
  const outPath = path.join(process.cwd(), 'src', 'data', `${code}_1000Experiments.json`);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n结果已落盘: ${outPath}`);
  return outPath;
}
