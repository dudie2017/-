/**
 * 沪银(AG0) 1000次完全不同实验：24维方法论配方空间探测
 *
 * 核心思想：不是"同引擎换参数"，而是每次实验是一个独立的方法论配方——
 * 从 24 个维度（含 4 个黑天鹅维度）各取一个值，组合成独一无二的回测配置。
 *
 * 24 维度：
 *   1. 信号等级    2. 趋势过滤    3. 冷却期      4. Edge窗口
 *   5. 区间交易    6. 交易员方程  7. P阈值       8. 预热K线
 *   9. 止损ATR    10. 止盈ATR    11. 持仓天数   12. 最小盈亏比
 *   13. 仓位占比   14. 方向模式   15. 数据窗口   16. 非绿K缩放
 *   17. 逆营缩放   18. 营窗口     19. 手续费倍率 20. 起始资金
 *   21. 黑天鹅防护 22. 熔断机制   23. 波动率仓位 24. 日亏损限额
 *
 * 用 LHS(拉丁超立方) 在 24 维空间均匀采样 1000 个不同配方；
 * 每次实验独立回测；最后做方差分解/脆弱点识别/当前参数排名/最优配方对比。
 *
 * 运行：cd server && npx tsx src/scripts/runAG0_1000Experiments.ts
 * 输出：src/data/AG0_1000Experiments.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
// 注意：不导入 theoreticalMax.ts（其顶层会无条件执行 main()），内联实现（无副作用）。
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const CODE = 'AG0';

// ============ 理论最大收益（内联实现，无副作用） ============
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

// ============ PRNG + LHS ============
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Dim { name: string; values: (number | string | boolean)[]; }

/** 生成 N 个互不相同的 LHS 样本（每维均匀分层） */
function lhsUnique(n: number, dims: Dim[], seed: number): Array<Record<string, number | string | boolean>> {
  const rng = mulberry32(seed);
  const perDim: number[][] = dims.map((dim) => {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.map((rank) => (rank + rng()) / n);
  });
  const out: Array<Record<string, number | string | boolean>> = [];
  const seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    const sample: Record<string, number | string | boolean> = {};
    dims.forEach((dim, d) => {
      const v = dim.values[Math.min(dim.values.length - 1, Math.floor(perDim[d][i] * dim.values.length))];
      sample[dim.name] = v;
    });
    const key = dims.map((d) => `${d.name}=${sample[d.name]}`).join('|');
    if (seen.has(key)) continue; // 理论上 LHS 不会撞，保险去重
    seen.add(key);
    out.push(sample);
  }
  return out;
}

// ============ 24 维度变体定义 ============
function buildDims(): Dim[] {
  return [
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3', 'L4'] },
    { name: 'trendFilter', values: [false, true] },
    { name: 'cooldownBars', values: [0, 1, 2, 3, 5] },
    // edgeLookback 只影响预扫描 → 预扫描 3 版本缓存（50/70/100）
    { name: 'edgeLookback', values: [50, 70, 100] },
    { name: 'allowRangeTrading', values: [false, true] },
    { name: 'equationMode', values: ['none', 'soft', 'hard'] },
    { name: 'pThreshold', values: [0.35, 0.4, 0.45, 0.5, 0.55] },
    { name: 'softEquationMul', values: [0.3, 0.5, 0.7, 1.0] }, // soft 模式方程负向仓位倍率
    { name: 'stopAtrMult', values: [0.8, 1.0, 1.2, 1.5, 2.0, 2.5, 3.0] },
    { name: 'targetAtrMult', values: [1.5, 2.0, 3.0, 4.0, 5.0, 6.0] },
    { name: 'maxHoldDays', values: [3, 5, 8, 10, 15, 20, 30] },
    { name: 'minRR', values: [0.5, 0.8, 1.0, 1.2, 1.5, 2.0] },
    { name: 'maxPositionPct', values: [0.05, 0.1, 0.15, 0.2, 0.3] },
    { name: 'directionMode', values: ['both', 'longOnly', 'shortOnly', 'split'] },
    { name: 'dataWindow', values: ['full', 'front70', 'back70', 'last2y', 'last3y'] },
    { name: 'nonGreenMul', values: [0.5, 0.8, 1.0, 1.2, 1.5] },
    { name: 'counterCampMul', values: [0.5, 0.8, 1.0, 1.2, 1.5] },
    { name: 'campWindow', values: [10, 14, 21, 30, 42] },
    { name: 'feeMult', values: [0.5, 1.0, 2.0, 3.0] },
    { name: 'startCapital', values: [200000, 500000, 1000000] },
    { name: 'bsMode', values: ['none', 'riskOff', 'full'] },
    { name: 'circuitBreaker', values: ['off', '3x10', '4x15', '5x20'] },
    { name: 'volReduce', values: ['off', 'atr15xHalf', 'atr2xClear'] },
    { name: 'dailyLossLimit', values: ['off', '3pct', '5pct', '8pct'] },
  ];
}

// ============ 预扫描缓存（多版本：edgeLookback × allowRangeTrading） ============
const cachePool = new Map<string, V16Row[]>();
async function getPrescannedRows(edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const key = `${edgeLookback}_${allowRangeTrading}`;
  if (cachePool.has(key)) return cachePool.get(key)!;
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${CODE}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60; // 必须与引擎 warmupBars 一致，signalCache 索引才对齐
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(CODE, histBars as any, CODE, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  cachePool.set(key, rows);
  console.log(`  预扫描完成: edge=${edgeLookback} range=${allowRangeTrading} → ${rows.length} 行`);
  return rows;
}

// ============ 黑天鹅过滤器（JM0 专用） ============
interface NewsFilter {
  mode: 'none' | 'riskOff' | 'full';
  cooldownMap?: Map<string, boolean[]>;
  shockDirMap?: Map<string, Array<'up' | 'down' | null>>;
  shockDates?: Map<string, Set<string>>;
  resonanceBoost?: number;
  divergenceCut?: number;
}

function buildBlackSwanFilter(mode: 'none' | 'riskOff' | 'full'): NewsFilter | undefined {
  if (mode === 'none') return undefined;
  const bars = loadVarietyBars(CODE, DATA_DIR) as any[];
  const cooldown = new Array<boolean>(bars.length).fill(false);
  const shockDates = new Set<string>();
  const shockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
  try {
    const shocks = detectShocks(bars as any, CODE) as Array<{ index: number; date: string; direction: 'up' | 'down' }>;
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
      if (!ev.varieties || !ev.varieties.includes(CODE)) continue;
      const idx = barDateIdx.get(ev.date);
      if (idx === undefined) continue;
      const until = Math.min(bars.length, idx + 10);
      for (let j = idx; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = ev.direction === '利空' ? 'down' : 'up';
      }
    }
  } catch (e) {
    console.warn('[JM0] 黑天鹅检测异常，回退为空过滤器:', (e as Error).message);
  }
  return {
    mode,
    cooldownMap: new Map([[CODE, cooldown]]),
    shockDirMap: new Map([[CODE, shockDir]]),
    shockDates: new Map([[CODE, shockDates]]),
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

// ============ 统计指标（与 runLH1000Backtest 口径一致） ============
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

// ============ 后处理风控层（黑天鹅维度） ============

/** 熔断：连亏 N 笔暂停 M 天（用日历日，近似交易日为 1.4 倍） */
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

/** 波动率仓位：入场时 ATR(14) 相对长期 ATR(60) 放大时缩减/清仓 */
function applyVolReduce(trades: TradeLike[], bars: Bar[], mode: string): TradeLike[] {
  if (mode === 'off' || bars.length < 60) return trades;
  // 预计算 ATR(14) 序列与长期均值
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
  const longAtrs: number[] = [];
  for (let i = 60; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - 59; j <= i; j++) sum += atr14[j];
    longAtrs.push(sum / 60);
  }
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

/** 日亏损限额：单日累计亏损超过阈值时，当日后续交易取消 */
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
    if (dayPnl <= -limit) continue; // 当日已超限，剩余交易取消
    out.push(t);
    dayPnl += t.pnl;
  }
  return out;
}

/** 手续费倍率：按入场合约价值调整每笔净收益（引擎固定 fee=0.00015*2） */
function applyFeeMult(trades: TradeLike[], mult: number): TradeLike[] {
  if (mult === 1) return trades;
  const multiplier = 15; // AG0 沪银合约乘数（千克/手）；LH0 为 16，JM0 为 60
  return trades.map((t) => {
    const contractValue = Math.abs(t.entryPrice) * multiplier;
    const fee = contractValue * 0.00015 * 2;
    return { ...t, pnl: t.pnl + fee * (1 - mult) };
  });
}

/** 方向模式：only 时过滤另一方向，split 时用生产分离参数 */
function applyDirectionFilter(trades: TradeLike[], mode: string): TradeLike[] {
  if (mode === 'both') return trades;
  if (mode === 'longOnly') return trades.filter((t) => t.direction === 'LONG');
  if (mode === 'shortOnly') return trades.filter((t) => t.direction === 'SHORT');
  return trades; // split 在引擎参数层面实现
}

// ============ 生产基线参数 ============
function getBaseLong() { return LONG_REFINED_PARAMS[CODE] ?? LONG_OPT_PARAMS[CODE] ?? { stopAtrMult: 2.14, targetAtrMult: 4.44, maxHoldDays: 20, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' }; }
function getBaseShort() { return SHORT_OPT_PARAMS[CODE] ?? { stopAtrMult: 2.14, targetAtrMult: 4.44, maxHoldDays: 20, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L3' }; }

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
  returnAllTrades: true,
  quiet: true,
};

// ============ 单次实验：配方 → 回测 → 后处理 → 统计 ============
interface ExpResult {
  id: number;
  recipe: Record<string, number | string | boolean>;
  stats: Stats;
  recipeKey: string;
}

async function runExperiment(
  id: number,
  recipe: Record<string, number | string | boolean>,
  bars: Bar[],
  theo: { longReturn: number; shortReturn: number },
): Promise<ExpResult> {
  const bsFilter = buildBlackSwanFilter(String(recipe.bsMode) as 'none' | 'riskOff' | 'full');
  const longBase = getBaseLong();
  const shortBase = getBaseShort();

  // 方向模式：split 时多空用生产分离参数；否则统一用配方参数
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

  // 按配方选择对应预扫描缓存（edgeLookback × allowRangeTrading）
  const edgeLB = Number(recipe.edgeLookback);
  const range = Boolean(recipe.allowRangeTrading);
  const signalCache: Map<string, V16Row[]> = new Map([[CODE, await getPrescannedRows(edgeLB, range)]]);

  const result: any = await runBacktest({
    ...BASE_OPTS,
    startCapital: Number(recipe.startCapital),
    maxPositionPct: Number(recipe.maxPositionPct),
    dataDir: DATA_DIR,
    codes: [CODE],
    signalCache,
    newsFilter: bsFilter,
    sideParams,
    edgeLookback: edgeLB,
    allowRangeTrading: range,
    pThreshold: Number(recipe.pThreshold),
    equationMode: recipe.equationMode as any,
    // warmupBars 固定 60（与 signalCache 预扫描起点一致，保证索引对齐）
    nonGreenMul: Number(recipe.nonGreenMul),
    counterCampMul: Number(recipe.counterCampMul),
    campWindow: Number(recipe.campWindow),
    // equationMode=soft 时方程负向仓位倍率来自配方
    softEquationMul: Number(recipe.softEquationMul) || 0.5,
    chExemptEquation: false,
  });

  let trades = (result.trades || []) as TradeLike[];

  // 方向过滤（在引擎后处理，仅做多/仅做空）
  trades = applyDirectionFilter(trades, directionMode);

  // 黑天鹅后处理层（按顺序：熔断 → 波动率 → 日亏损 → 手续费）
  const cb = String(recipe.circuitBreaker);
  if (cb !== 'off') {
    const [n, m] = cb.split('x').map(Number);
    trades = applyCircuitBreaker(trades, n, m);
  }
  trades = applyVolReduce(trades, bars, String(recipe.volReduce));
  trades = applyDailyLossLimit(trades, Number(recipe.startCapital), parsePct(String(recipe.dailyLossLimit)));
  trades = applyFeeMult(trades, Number(recipe.feeMult));

  // 数据窗口过滤：只统计窗口内交易，并按窗口重新计算理论基准（捕获率口径一致）
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

// ============ 方差分解（每维按取值分组 → 组间方差占比） ============
interface DimAnalysis {
  dimension: string;
  groupCount: number;
  betweenVar: number;   // 组间方差（加权）
  totalVar: number;
  explained: number;    // 组间方差/总方差
  bestValue: string;    // 该维度下收益均值最高的取值
  worstValue: string;
  spread: number;       // 最优-最劣组均值差（收益，元）
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
  // 定义崩溃：收益<0 或 回撤>50%
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

// ============ AG0 针对性分析 ============

/** 做多持仓周期分析：按 maxHoldDays 分组，看做多收益/捕获率是否依赖长持仓 */
function analyzeLongHold(results: ExpResult[]): Array<Record<string, number | string>> {
  const groups = new Map<string, Array<{ longPnl: number; longCap: number; longTrades: number }>>();
  for (const r of results) {
    const rec = r.recipe;
    // 只看含做多的实验（directionMode 不是 shortOnly）
    if (String(rec.directionMode) === 'shortOnly') continue;
    const hold = String(rec.maxHoldDays);
    if (!groups.has(hold)) groups.set(hold, []);
    groups.get(hold)!.push({
      longPnl: r.stats.longPnl,
      longCap: r.stats.longCapture,
      longTrades: r.stats.longTrades,
    });
  }
  const out: Array<Record<string, number | string>> = [];
  for (const [hold, arr] of groups) {
    const n = arr.length;
    const avgPnl = arr.reduce((s, x) => s + x.longPnl, 0) / n;
    const avgCap = arr.reduce((s, x) => s + x.longCap, 0) / n;
    const avgTrades = arr.reduce((s, x) => s + x.longTrades, 0) / n;
    const posRatio = arr.filter((x) => x.longPnl > 0).length / n;
    out.push({
      maxHoldDays: hold,
      n,
      avgLongPnl: +avgPnl.toFixed(0),
      avgLongCapture: +avgCap.toFixed(4),
      avgLongTrades: +avgTrades.toFixed(0),
      longProfitableRatio: +posRatio.toFixed(4),
    });
  }
  out.sort((a, b) => Number(a.maxHoldDays) - Number(b.maxHoldDays));
  return out;
}

/** 方向模式对比：split vs both vs longOnly vs shortOnly（做多捕获率异常是否源于方向模式） */
function analyzeDirectionModes(results: ExpResult[]): Array<Record<string, number | string>> {
  const groups = new Map<string, ExpResult[]>();
  for (const r of results) {
    const dm = String(r.recipe.directionMode);
    if (!groups.has(dm)) groups.set(dm, []);
    groups.get(dm)!.push(r);
  }
  const out: Array<Record<string, number | string>> = [];
  for (const [dm, arr] of groups) {
    const n = arr.length;
    const avgPnl = arr.reduce((s, r) => s + r.stats.totalPnl, 0) / n;
    const avgCap = arr.reduce((s, r) => s + r.stats.capture, 0) / n;
    const avgLongCap = arr.reduce((s, r) => s + r.stats.longCapture, 0) / n;
    const avgShortCap = arr.reduce((s, r) => s + r.stats.shortCapture, 0) / n;
    const avgDD = arr.reduce((s, r) => s + r.stats.maxDrawdown, 0) / n;
    const avgWin = arr.reduce((s, r) => s + r.stats.winRate, 0) / n;
    const avgLongPnl = arr.reduce((s, r) => s + r.stats.longPnl, 0) / n;
    const longOver100 = arr.filter((r) => r.stats.longCapture > 1.0).length;
    out.push({
      directionMode: dm,
      n,
      avgPnl: +avgPnl.toFixed(0),
      avgWinRate: +avgWin.toFixed(4),
      avgMaxDD: +avgDD.toFixed(4),
      avgCapture: +avgCap.toFixed(4),
      avgLongCapture: +avgLongCap.toFixed(4),
      avgShortCapture: +avgShortCap.toFixed(4),
      avgLongPnl: +avgLongPnl.toFixed(0),
      longCaptureOver100Ratio: +(longOver100 / n).toFixed(4),
    });
  }
  out.sort((a, b) => Number(b.avgPnl) - Number(a.avgPnl));
  return out;
}

/** 熔断机制分析：circuitBreaker 各档位 vs off 的收益/回撤/脆弱率 */
function analyzeCircuitBreaker(results: ExpResult[]): Array<Record<string, number | string>> {
  const groups = new Map<string, ExpResult[]>();
  for (const r of results) {
    const cb = String(r.recipe.circuitBreaker);
    if (!groups.has(cb)) groups.set(cb, []);
    groups.get(cb)!.push(r);
  }
  const out: Array<Record<string, number | string>> = [];
  for (const [cb, arr] of groups) {
    const n = arr.length;
    const avgPnl = arr.reduce((s, r) => s + r.stats.totalPnl, 0) / n;
    const avgDD = arr.reduce((s, r) => s + r.stats.maxDrawdown, 0) / n;
    const avgWin = arr.reduce((s, r) => s + r.stats.winRate, 0) / n;
    const avgTrades = arr.reduce((s, r) => s + r.stats.totalTrades, 0) / n;
    const fragile = arr.filter((r) => r.stats.totalPnl < 0 || r.stats.maxDrawdown > 0.5).length;
    out.push({
      circuitBreaker: cb,
      n,
      avgPnl: +avgPnl.toFixed(0),
      avgWinRate: +avgWin.toFixed(4),
      avgMaxDD: +avgDD.toFixed(4),
      avgTrades: +avgTrades.toFixed(0),
      fragileRatio: +(fragile / n).toFixed(4),
    });
  }
  out.sort((a, b) => Number(b.avgPnl) - Number(a.avgPnl));
  return out;
}

/** 四方交叉对比：读取 LH0/JM0/M0 三个 JSON，对比脆弱点/最优配方/方向模式/捕获异常 */
function crossCompareAll(ag0Results: ExpResult[]) {
  const lh0Path = path.join(process.cwd(), 'src', 'data', 'LH0_1000Experiments.json');
  const jm0Path = path.join(process.cwd(), 'src', 'data', 'JM0_1000Experiments.json');
  const m0Path = path.join(process.cwd(), 'src', 'data', 'M0_1000Experiments.json');
  let lh0: any = null;
  let jm0: any = null;
  let m0: any = null;
  try {
    lh0 = JSON.parse(fs.readFileSync(lh0Path, 'utf8'));
  } catch {
    lh0 = null;
  }
  try {
    jm0 = JSON.parse(fs.readFileSync(jm0Path, 'utf8'));
  } catch {
    jm0 = null;
  }
  try {
    m0 = JSON.parse(fs.readFileSync(m0Path, 'utf8'));
  } catch {
    m0 = null;
  }
  const ag0Top = [...ag0Results].sort((a, b) => b.stats.totalPnl - a.stats.totalPnl)[0];
  const ag0TopDir = ag0Top?.recipe.directionMode ?? '';
  const lh0TopDir = lh0?.topPnl?.[0]?.recipe?.directionMode ?? null;
  const jm0TopDir = jm0?.topPnl?.[0]?.recipe?.directionMode ?? null;
  const m0TopDir = m0?.topPnl?.[0]?.recipe?.directionMode ?? null;
  const ag0LongOver = ag0Results.filter((r) => r.stats.longCapture > 1.0).length / ag0Results.length;
  const lh0LongOver = lh0?.fullResults
    ? lh0.fullResults.filter((r: any) => r.stats.longCapture > 1.0).length / lh0.fullResults.length
    : null;
  const jm0LongOver = jm0?.fullResults
    ? jm0.fullResults.filter((r: any) => r.stats.longCapture > 1.0).length / jm0.fullResults.length
    : null;
  const m0LongOver = m0?.fullResults
    ? m0.fullResults.filter((r: any) => r.stats.longCapture > 1.0).length / m0.fullResults.length
    : null;
  const ag0ShortOver = ag0Results.filter((r) => r.stats.shortCapture > 1.0).length / ag0Results.length;
  const lh0ShortOver = lh0?.fullResults
    ? lh0.fullResults.filter((r: any) => r.stats.shortCapture > 1.0).length / lh0.fullResults.length
    : null;
  const jm0ShortOver = jm0?.fullResults
    ? jm0.fullResults.filter((r: any) => r.stats.shortCapture > 1.0).length / jm0.fullResults.length
    : null;
  const m0ShortOver = m0?.fullResults
    ? m0.fullResults.filter((r: any) => r.stats.shortCapture > 1.0).length / m0.fullResults.length
    : null;
  return {
    lh0Experiments: lh0?.meta?.experiments ?? null,
    lh0DateRange: lh0?.meta?.dateRange ?? null,
    jm0Experiments: jm0?.meta?.experiments ?? null,
    jm0DateRange: jm0?.meta?.dateRange ?? null,
    m0Experiments: m0?.meta?.experiments ?? null,
    m0DateRange: m0?.meta?.dateRange ?? null,
    topPnlDirectionMode: { ag0: ag0TopDir, lh0: lh0TopDir, jm0: jm0TopDir, m0: m0TopDir },
    longCaptureOver100Ratio: {
      ag0: +ag0LongOver.toFixed(4),
      lh0: lh0LongOver !== null ? +lh0LongOver.toFixed(4) : null,
      jm0: jm0LongOver !== null ? +jm0LongOver.toFixed(4) : null,
      m0: m0LongOver !== null ? +m0LongOver.toFixed(4) : null,
    },
    shortCaptureOver100Ratio: {
      ag0: +ag0ShortOver.toFixed(4),
      lh0: lh0ShortOver !== null ? +lh0ShortOver.toFixed(4) : null,
      jm0: jm0ShortOver !== null ? +jm0ShortOver.toFixed(4) : null,
      m0: m0ShortOver !== null ? +m0ShortOver.toFixed(4) : null,
    },
    lh0TopFragility: lh0?.fragility?.topFactors?.slice(0, 5) ?? [],
    jm0TopFragility: jm0?.fragility?.topFactors?.slice(0, 5) ?? [],
    m0TopFragility: m0?.fragility?.topFactors?.slice(0, 5) ?? [],
    lh0TopVarianceDim: lh0?.varianceDecomposition?.totalPnl?.[0]?.dimension ?? null,
    jm0TopVarianceDim: jm0?.varianceDecomposition?.totalPnl?.[0]?.dimension ?? null,
    m0TopVarianceDim: m0?.varianceDecomposition?.totalPnl?.[0]?.dimension ?? null,
  };
}

// ============ 主流程 ============
const N_EXPERIMENTS = 1000;
const SEED = 20260811;
const OUT_FILE = 'AG0_1000Experiments.json';

function makeRecipeKey(recipe: Record<string, number | string | boolean>): string {
  return Object.entries(recipe).map(([k, v]) => `${k}=${v}`).join('|');
}

async function main() {
  console.log('========== AG0 沪银 1000 次完全不同实验（24 维方法论空间） ==========');
  console.log('1/6 加载数据与理论基准...');
  const bars = loadBars(CODE);
  console.log(`AG0 K线 ${bars.length} 根（${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}）`);
  const theo = computeTheoreticalMax(bars, 3);
  console.log(
    `全量理论: 摆动 ${theo.swingCount} 段 | 做多 ${theo.longSegments} 段 ${(theo.longReturn * 100).toFixed(1)}% | 做空 ${theo.shortSegments} 段 ${(theo.shortReturn * 100).toFixed(1)}%`,
  );

  console.log('2/6 预扫描信号缓存（edgeLookback × allowRangeTrading 变体）...');
  const cacheStats: Array<{ edge: number; range: boolean; rows: number }> = [];
  for (const e of [50, 70, 100]) {
    for (const r of [false, true]) {
      const rows = await getPrescannedRows(e, r);
      cacheStats.push({ edge: e, range: r, rows: rows.length });
    }
  }
  console.log(`缓存组合 ${cacheStats.length} 组: ${cacheStats.map((c) => `e${c.edge}/r${c.range}=${c.rows}行`).join(', ')}`);

  console.log('3/6 运行基线（当前生产参数）...');
  // 当前生产形态：多空分离参数（LONG_OPT_PARAMS['AG0'] + SHORT_OPT_PARAMS['AG0']）
  // directionMode='split' 时 runExperiment 会使用生产分离参数，故此处仅保留框架配方
  // 注意：生产 final 未传 allowRangeTrading → 引擎默认 false（与 runAll20yFinalBacktest 一致）
  // 若设 true 会多出区间交易，基线失真
  const baseRecipe: Record<string, number | string | boolean> = {
    minSignalGrade: 'L2', trendFilter: false, cooldownBars: 6, edgeLookback: 70,
    allowRangeTrading: true, equationMode: 'soft', pThreshold: 0.45, softEquationMul: 0.5,
    stopAtrMult: 1.93, targetAtrMult: 6.92, maxHoldDays: 53, minRR: 1.0,
    maxPositionPct: 0.15, directionMode: 'split', dataWindow: 'full',
    nonGreenMul: 1.0, counterCampMul: 0.8, campWindow: 30, feeMult: 1.0,
    startCapital: 500000, bsMode: 'none',
    circuitBreaker: '5x20', volReduce: 'off', dailyLossLimit: 'off',
  };
  const base = await runExperiment(0, baseRecipe, bars, theo);
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
    const r = await runExperiment(i + 1, recipe, bars, theo);
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

  // 当前参数排名（按收益、回撤、捕获三个口径）
  const rankByPnl = [...results].sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  const rankByDD = [...results].sort((a, b) => a.stats.maxDrawdown - b.stats.maxDrawdown);
  const rankByCap = [...results].sort((a, b) => b.stats.capture - a.stats.capture);
  const baseRankPnl = rankByPnl.findIndex((r) => r.id === 0);
  const baseRankDD = rankByDD.findIndex((r) => r.id === 0);
  const baseRankCap = rankByCap.findIndex((r) => r.id === 0);
  console.log(`--- 当前参数排名: 收益 #${baseRankPnl + 1}/${results.length} | 回撤 #${baseRankDD + 1} | 捕获 #${baseRankCap + 1} ---`);

  // 最优配方对比（综合得分：收益+胜率+捕获 高，回撤 低）
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

  // ============ AG0 针对性分析（做多持仓周期 / 方向模式 / 熔断 / 四方交叉） ============
  console.log('--- AG0 针对性分析 ---');
  const longHold = analyzeLongHold(results);
  console.log('做多持仓周期:');
  longHold.forEach((s) =>
    console.log(`  hold=${s.maxHoldDays} n=${s.n} 做多收益均值${(Number(s.avgLongPnl)).toLocaleString()} 捕获${(Number(s.avgLongCapture) * 100).toFixed(1)}% 盈利组占比${(Number(s.longProfitableRatio) * 100).toFixed(0)}%`),
  );
  const dirModes = analyzeDirectionModes(results);
  console.log('方向模式对比:');
  dirModes.forEach((d) =>
    console.log(`  ${d.directionMode} n=${d.n} 收益${(Number(d.avgPnl)).toLocaleString()} 胜率${(Number(d.avgWinRate) * 100).toFixed(1)}% 回撤${(Number(d.avgMaxDD) * 100).toFixed(1)}% 多捕获${(Number(d.avgLongCapture) * 100).toFixed(1)}% 空捕获${(Number(d.avgShortCapture) * 100).toFixed(1)}% 多>100%占比${(Number(d.longCaptureOver100Ratio) * 100).toFixed(0)}%`),
  );
  const cbAnalysis = analyzeCircuitBreaker(results);
  console.log('熔断机制:');
  cbAnalysis.forEach((c) =>
    console.log(`  ${c.circuitBreaker} n=${c.n} 收益${(Number(c.avgPnl)).toLocaleString()} 回撤${(Number(c.avgMaxDD) * 100).toFixed(1)}% 胜率${(Number(c.avgWinRate) * 100).toFixed(1)}% 崩溃率${(Number(c.fragileRatio) * 100).toFixed(1)}%`),
  );
  const cross = crossCompareAll(results);
  console.log('四方交叉对比:');
  console.log(`  最优方向模式: AG0=${cross.topPnlDirectionMode.ag0} LH0=${cross.topPnlDirectionMode.lh0} JM0=${cross.topPnlDirectionMode.jm0} M0=${cross.topPnlDirectionMode.m0}`);
  console.log(`  做多捕获>100%占比: AG0=${(cross.longCaptureOver100Ratio.ag0 * 100).toFixed(1)}% LH0=${cross.longCaptureOver100Ratio.lh0 !== null ? (cross.longCaptureOver100Ratio.lh0 * 100).toFixed(1) + '%' : 'N/A'} JM0=${cross.longCaptureOver100Ratio.jm0 !== null ? (cross.longCaptureOver100Ratio.jm0 * 100).toFixed(1) + '%' : 'N/A'} M0=${cross.longCaptureOver100Ratio.m0 !== null ? (cross.longCaptureOver100Ratio.m0 * 100).toFixed(1) + '%' : 'N/A'}`);
  console.log(`  做空捕获>100%占比: AG0=${(cross.shortCaptureOver100Ratio.ag0 * 100).toFixed(1)}% LH0=${cross.shortCaptureOver100Ratio.lh0 !== null ? (cross.shortCaptureOver100Ratio.lh0 * 100).toFixed(1) + '%' : 'N/A'} JM0=${cross.shortCaptureOver100Ratio.jm0 !== null ? (cross.shortCaptureOver100Ratio.jm0 * 100).toFixed(1) + '%' : 'N/A'} M0=${cross.shortCaptureOver100Ratio.m0 !== null ? (cross.shortCaptureOver100Ratio.m0 * 100).toFixed(1) + '%' : 'N/A'}`);

  // 落盘
  const output = {
    meta: {
      code: CODE,
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
    ag0Specific: {
      longHold: longHold,
      directionModes: dirModes,
      circuitBreaker: cbAnalysis,
      crossCompareAll: cross,
    },
    fullResults: results.map((r) => ({
      id: r.id,
      recipe: r.recipe,
      stats: pickStats(r.stats),
    })),
  };
  const outPath = path.join(process.cwd(), 'src', 'data', OUT_FILE);
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n结果已落盘: ${outPath}`);
}

function pickStats(s: Stats) {
  return {
    totalTrades: s.totalTrades,
    longTrades: s.longTrades,
    shortTrades: s.shortTrades,
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

main().catch((e) => {
  console.error('[AG0 1000次实验失败]', e);
  process.exit(1);
});
