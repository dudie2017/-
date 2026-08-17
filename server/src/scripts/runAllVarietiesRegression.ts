// @ts-nocheck
/**
 * 全品种回归验证脚本
 *
 * 目的：每次修改生产配置后，用当前实时配置跑所有已回测品种的基线，
 * 与历史基线（*_1000Experiments.json 中的 baseline.stats）对比，确认无劣化。
 *
 * 用法：cd server && npx tsx src/scripts/runAllVarietiesRegression.ts
 */

import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams';
import { SHORT_DISABLED } from '../data/shortDisabledVarieties';
import { LONG_DISABLED } from '../data/longDisabledVarieties';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

// ============ 类型 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }
interface V16Row { date: string; edgeScore: number; rangeScore: number; trendScore: number; campScore: number; signalGrade: string; isNonGreen: boolean; isCounterCamp: boolean; [k: string]: any; }

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const ALL_CODES = ['SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0', 'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0'];

// ============ 核心引擎函数（从 runP0 复制） ============

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

// ============ 预扫描缓存 ============
function buildPrescanCache(code: string, edgeLookback: number, allowRangeTrading: boolean): Map<string, V16Row[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Bar[];
  const warmup = 60;
  const rows: V16Row[] = [];
  // 同步版本的预扫描（使用 scanV16Variety）
  // 注意：scanV16Variety 是异步的，这里需要特殊处理
  return new Map(); // placeholder, will be filled async
}

async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
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
  return rows;
}

// ============ 黑天鹅过滤器 ============
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

// ============ 数据窗口裁剪 ============
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

// ============ 统计指标 ============
interface TradeLike {
  pnl: number;
  direction: 'LONG' | 'SHORT';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  result?: string;
}

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

// ============ 后处理风控层 ============

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

function applyDirectionFilter(trades: TradeLike[], mode: string): TradeLike[] {
  if (mode === 'both' || mode === 'split') return trades;
  if (mode === 'longOnly') return trades.filter((t) => t.direction === 'LONG');
  if (mode === 'shortOnly') return trades.filter((t) => t.direction === 'SHORT');
  return trades;
}

function parsePct(v: string): number {
  if (v === 'off') return 0;
  return Number(v.replace('pct', '')) / 100;
}

// ============ 生产基线参数 ============
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

// ============ 单品种回归基线 ============
async function runRegressionBaseline(code: string): Promise<{
  newStats: Stats;
  histStats: Stats;
  histRecipe: Record<string, any>;
  newRecipe: Record<string, any>;
  dirMode: string;
  cbStr: string;
}> {
  // 1. 加载数据
  const bars = loadBars(code);
  const theo = computeTheoreticalMax(bars, 3);

  // 2. 读取历史基线配方
  const jsonPath = path.join(process.cwd(), 'src', 'data', `${code}_1000Experiments.json`);
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const histRecipe = jsonData.baseline.recipe as Record<string, any>;
  const histStats = jsonData.baseline.stats as Stats;

  // 3. 构造当前实时配置
  const longBase = LONG_REFINED_PARAMS[code] ?? LONG_OPT_PARAMS[code] ?? { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' };
  const shortBase = SHORT_OPT_PARAMS[code] ?? { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' };
  const rt = REALTIME_OPT_PARAMS[code];

  // 方向模式
  let dirMode: string;
  if (SHORT_DISABLED.has(code)) dirMode = 'longOnly';
  else if (LONG_DISABLED.has(code)) dirMode = 'shortOnly';
  else dirMode = 'split';

  // 裂分参数（总是用生产参数，方向过滤在后处理中应用）
  const sideParams = {
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

  // 4. 预扫描信号缓存（只用历史配方中的 edgeLookback/allowRangeTrading）
  const edgeLB = Number(histRecipe.edgeLookback || 70);
  const range = Boolean(histRecipe.allowRangeTrading ?? true);
  console.log(`  预扫描 ${code}: edge=${edgeLB} range=${range}...`);
  const prescanned = await getPrescannedRows(code, edgeLB, range);
  const signalCache: Map<string, V16Row[]> = new Map([[code, prescanned]]);
  console.log(`  预扫描完成: ${prescanned.length} 行`);

  // 5. 运行回测
  const maxPosPct = rt?.maxPositionPct ?? Number(histRecipe.maxPositionPct ?? 0.15);
  const bsMode = String(histRecipe.bsMode ?? 'none') as 'none' | 'riskOff' | 'full';
  const bsFilter = buildBlackSwanFilter(code, bsMode);

  const result: any = await runBacktest({
    ...BASE_OPTS,
    startCapital: Number(histRecipe.startCapital ?? 500000),
    maxPositionPct: maxPosPct,
    dataDir: DATA_DIR,
    codes: [code],
    signalCache,
    newsFilter: bsFilter,
    sideParams,
    edgeLookback: edgeLB,
    allowRangeTrading: range,
    pThreshold: Number(histRecipe.pThreshold ?? 0.5),
    equationMode: (histRecipe.equationMode ?? 'none') as any,
    nonGreenMul: Number(histRecipe.nonGreenMul ?? 1.0),
    counterCampMul: Number(histRecipe.counterCampMul ?? 1.0),
    campWindow: Number(histRecipe.campWindow ?? 21),
    softEquationMul: Number(histRecipe.softEquationMul ?? 0.5),
    chExemptEquation: false,
  });

  let trades = (result.trades || []) as TradeLike[];

  // 6. 后处理
  trades = applyDirectionFilter(trades, dirMode);

  const cb = rt?.circuitBreaker;
  const cbStr = cb ? `${cb.lossStreak}x${cb.pauseDays}` : 'off';
  if (cb) {
    trades = applyCircuitBreaker(trades, cb.lossStreak, cb.pauseDays);
  }

  const volReduceMode = rt?.volReduce ?? 'off';
  trades = applyVolReduce(trades, bars, volReduceMode);

  const dailyLossPct = rt?.dailyLossLimit ? parsePct(rt.dailyLossLimit) : 0;
  trades = applyDailyLossLimit(trades, Number(histRecipe.startCapital ?? 500000), dailyLossPct);

  // 7. 数据窗口
  const dataWindow = String(histRecipe.dataWindow ?? 'full');
  const win = applyWindow(bars, dataWindow);
  let wTheoLong = theo.longReturn;
  let wTheoShort = theo.shortReturn;
  if (win.label !== 'full') {
    const startDate = win.slice[0]?.date || '';
    const endDate = win.slice[win.slice.length - 1]?.date || '';
    trades = trades.filter((t) => t.entryDate >= startDate && t.entryDate <= endDate);
    const wTheo = computeTheoreticalMax(win.slice, 3);
    wTheoLong = wTheo.longReturn;
    wTheoShort = wTheo.shortReturn;
  }

  const startCapital = Number(histRecipe.startCapital ?? 500000);
  const newStats = calcStats(trades, wTheoLong, wTheoShort, startCapital);

  const newRecipe = {
    ...histRecipe,
    directionMode: dirMode,
    circuitBreaker: cbStr,
    maxPositionPct: maxPosPct,
    volReduce: volReduceMode,
    dailyLossLimit: rt?.dailyLossLimit ?? 'off',
  };

  return { newStats, histStats, histRecipe, newRecipe, dirMode, cbStr };
}

// ============ 主流程 ============
async function main() {
  console.log('='.repeat(80));
  console.log('  全品种回归验证 — 当前实时生产配置 vs 历史基线');
  console.log('='.repeat(80));
  console.log(`品种: ${ALL_CODES.length} 个 (${ALL_CODES.join(', ')})`);
  console.log('');

  const results: Array<{
    code: string;
    dirMode: string;
    cbStr: string;
    histPnl: number;
    newPnl: number;
    pnlDelta: number;
    pnlDeltaPct: number;
    histWR: number;
    newWR: number;
    histDD: number;
    newDD: number;
    histPF: number;
    newPF: number;
    histCap: number;
    newCap: number;
    status: string;
  }> = [];

  for (const code of ALL_CODES) {
    console.log(`\n[${code}] 运行回归基线...`);
    try {
      const r = await runRegressionBaseline(code);

      const histPnl = r.histStats.totalPnl;
      const newPnl = r.newStats.totalPnl;
      const pnlDelta = newPnl - histPnl;
      const pnlDeltaPct = histPnl !== 0 ? (pnlDelta / Math.abs(histPnl)) * 100 : 0;

      // 判断状态
      let status: string;
      if (Math.abs(pnlDeltaPct) < 0.1) {
        status = '✅ 一致';
      } else if (pnlDelta > 0) {
        status = '🟢 提升';
      } else if (pnlDeltaPct > -5) {
        status = '🟡 微降';
      } else {
        status = '🔴 劣化';
      }

      results.push({
        code,
        dirMode: r.dirMode,
        cbStr: r.cbStr,
        histPnl,
        newPnl,
        pnlDelta,
        pnlDeltaPct,
        histWR: r.histStats.winRate,
        newWR: r.newStats.winRate,
        histDD: r.histStats.maxDrawdown,
        newDD: r.newStats.maxDrawdown,
        histPF: r.histStats.profitFactor,
        newPF: r.newStats.profitFactor,
        histCap: r.histStats.capture,
        newCap: r.newStats.capture,
        status,
      });

      console.log(`  历史: 收益${(histPnl / 10000).toFixed(1)}万 胜率${(r.histStats.winRate * 100).toFixed(1)}% 回撤${(r.histStats.maxDrawdown * 100).toFixed(1)}% PF${r.histStats.profitFactor.toFixed(2)}`);
      console.log(`  当前: 收益${(newPnl / 10000).toFixed(1)}万 胜率${(r.newStats.winRate * 100).toFixed(1)}% 回撤${(r.newStats.maxDrawdown * 100).toFixed(1)}% PF${r.newStats.profitFactor.toFixed(2)}`);
      console.log(`  变化: ${pnlDelta >= 0 ? '+' : ''}${(pnlDelta / 10000).toFixed(1)}万 (${pnlDeltaPct >= 0 ? '+' : ''}${pnlDeltaPct.toFixed(1)}%) → ${status}`);
    } catch (e) {
      console.error(`  [${code}] 错误: ${(e as Error).message}`);
      results.push({
        code,
        dirMode: '?',
        cbStr: '?',
        histPnl: 0,
        newPnl: 0,
        pnlDelta: 0,
        pnlDeltaPct: 0,
        histWR: 0,
        newWR: 0,
        histDD: 0,
        newDD: 0,
        histPF: 0,
        newPF: 0,
        histCap: 0,
        newCap: 0,
        status: '❌ 错误',
      });
    }
  }

  // ============ 输出汇总对比表 ============
  console.log('\n');
  console.log('='.repeat(120));
  console.log('  回归验证汇总对比表');
  console.log('='.repeat(120));
  console.log(
    '品种'.padEnd(6) +
    '方向'.padEnd(12) +
    '熔断'.padEnd(8) +
    '历史收益(万)'.padEnd(14) +
    '当前收益(万)'.padEnd(14) +
    '变化(万)'.padEnd(12) +
    '变化%'.padEnd(10) +
    '历史PF'.padEnd(10) +
    '当前PF'.padEnd(10) +
    '状态'.padEnd(10)
  );
  console.log('-'.repeat(120));

  let totalHistPnl = 0;
  let totalNewPnl = 0;
  let improvedCount = 0;
  let degradedCount = 0;
  let unchangedCount = 0;
  let errorCount = 0;

  for (const r of results) {
    totalHistPnl += r.histPnl;
    totalNewPnl += r.newPnl;
    if (r.status.includes('提升')) improvedCount++;
    else if (r.status.includes('劣化')) degradedCount++;
    else if (r.status.includes('一致') || r.status.includes('微降')) unchangedCount++;
    else errorCount++;

    console.log(
      r.code.padEnd(6) +
      r.dirMode.padEnd(12) +
      r.cbStr.padEnd(8) +
      (r.histPnl / 10000).toFixed(1).padEnd(14) +
      (r.newPnl / 10000).toFixed(1).padEnd(14) +
      (r.pnlDelta >= 0 ? '+' : '') + (r.pnlDelta / 10000).toFixed(1).padEnd(12) +
      (r.pnlDeltaPct >= 0 ? '+' : '') + r.pnlDeltaPct.toFixed(1).padEnd(10) +
      r.histPF.toFixed(2).padEnd(10) +
      r.newPF.toFixed(2).padEnd(10) +
      r.status
    );
  }

  console.log('-'.repeat(120));
  const totalDelta = totalNewPnl - totalHistPnl;
  const totalDeltaPct = totalHistPnl !== 0 ? (totalDelta / Math.abs(totalHistPnl)) * 100 : 0;
  console.log(
    '合计'.padEnd(6) +
    ''.padEnd(12) +
    ''.padEnd(8) +
    (totalHistPnl / 10000).toFixed(1).padEnd(14) +
    (totalNewPnl / 10000).toFixed(1).padEnd(14) +
    (totalDelta >= 0 ? '+' : '') + (totalDelta / 10000).toFixed(1).padEnd(12) +
    (totalDeltaPct >= 0 ? '+' : '') + totalDeltaPct.toFixed(1).padEnd(10) +
    ''.padEnd(10) +
    ''.padEnd(10) +
    `🟢${improvedCount} 🟡${unchangedCount} 🔴${degradedCount} ❌${errorCount}`
  );

  console.log('\n');
  console.log('='.repeat(80));
  console.log('  回归验证结论');
  console.log('='.repeat(80));

  if (degradedCount === 0 && errorCount === 0) {
    console.log('✅ 全部品种无劣化，修改安全。');
    if (improvedCount > 0) {
      console.log(`   其中 ${improvedCount} 个品种有提升。`);
    }
  } else if (degradedCount > 0) {
    console.log(`⚠️  ${degradedCount} 个品种出现劣化，需要检查：`);
    for (const r of results) {
      if (r.status.includes('劣化')) {
        console.log(`   - ${r.code}: 收益变化 ${r.pnlDeltaPct.toFixed(1)}%`);
      }
    }
  }
  if (errorCount > 0) {
    console.log(`❌  ${errorCount} 个品种运行出错，需要排查。`);
  }

  // 保存回归快照
  const snapshot = {
    timestamp: new Date().toISOString(),
    totalHistPnl,
    totalNewPnl,
    totalDelta,
    totalDeltaPct: +totalDeltaPct.toFixed(2),
    improvedCount,
    degradedCount,
    unchangedCount,
    errorCount,
    results: results.map((r) => ({
      code: r.code,
      dirMode: r.dirMode,
      cbStr: r.cbStr,
      histPnl: +r.histPnl.toFixed(2),
      newPnl: +r.newPnl.toFixed(2),
      pnlDelta: +r.pnlDelta.toFixed(2),
      pnlDeltaPct: +r.pnlDeltaPct.toFixed(2),
      histWR: +r.histWR.toFixed(4),
      newWR: +r.newWR.toFixed(4),
      histDD: +r.histDD.toFixed(4),
      newDD: +r.newDD.toFixed(4),
      histPF: +r.histPF.toFixed(4),
      newPF: +r.newPF.toFixed(4),
      status: r.status,
    })),
  };

  const snapshotPath = path.join(process.cwd(), 'src', 'data', 'regressionSnapshot.json');
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2));
  console.log(`\n回归快照已保存: ${snapshotPath}`);
}

main().catch((e) => {
  console.error('回归验证失败:', e);
  process.exit(1);
});
