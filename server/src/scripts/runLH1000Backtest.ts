/**
 * 生猪(LH0) 1000次回测：多目标参数寻优 + 黑天鹅双口径审计
 *
 * 目的：
 *   1. 对生猪 LH0（2021 上市，仅 5.6 年数据，128 段理论摆动）做 1000 组拉丁超立方采样寻优
 *   2. 每组分「不含黑天鹅 / 含黑天鹅」双口径回测（黑天鹅 = 价格冲击提前平仓 + 冷却过滤）
 *   3. 对比两口径下：胜率 / avgRR / 捕获率 / 回撤 / PnL 是否漂移
 *   4. 输出：基线对比、单指标 TOP5、综合 TOP10、Pareto、黑天鹅敏感性
 *
 * 输出：src/data/LH0_multiObjective.json（含双口径 stats）
 */
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
// 注意：不导入 theoreticalMax.ts（其顶层会无条件执行 main() 打印 AG0 理论表），
// 这里内联实现理论最大收益计算（无副作用）。
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

// ============ 理论最大收益（内联实现，无副作用） ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; }

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
  return {
    thresholdPct,
    swingCount: points.length,
    longSegments,
    shortSegments,
    longReturn,
    shortReturn,
    totalReturn: longReturn + shortReturn,
  };
}
const CODE = 'LH0';

// ============ PRNG ============
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

interface ParamDim {
  name: string;
  min?: number;
  max?: number;
  values?: (number | string | boolean)[];
  integer?: boolean;
}

function latinHypercubeSample(
  n: number,
  dims: ParamDim[],
  seed: number,
): Array<Record<string, number | string | boolean>> {
  const samples: Array<Record<string, number | string | boolean>> = [];
  const rng = mulberry32(seed);
  const perDim: number[][] = dims.map((dim) => {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.map((rank) => (rank + rng()) / n);
  });
  for (let i = 0; i < n; i++) {
    const sample: Record<string, number | string | boolean> = {};
    dims.forEach((dim, d) => {
      if (dim.values) {
        const v = dim.values[Math.floor(perDim[d][i] * dim.values.length)];
        sample[dim.name] = v;
      } else if (dim.integer) {
        sample[dim.name] = Math.round((dim.min || 0) + perDim[d][i] * ((dim.max || 1) - (dim.min || 0)));
      } else {
        sample[dim.name] = +(dim.min || 0) + perDim[d][i] * ((dim.max || 1) - (dim.min || 0));
      }
    });
    samples.push(sample);
  }
  return samples;
}

// ============ 参数空间（生猪，参考白银但放宽 hold 上限）============
function buildDims(): ParamDim[] {
  return [
    { name: 'stopAtrMult', min: 1.0, max: 4.0 },
    { name: 'targetAtrMult', min: 2.0, max: 8.0 },
    { name: 'maxHoldDays', min: 20, max: 60, integer: true },
    { name: 'cooldownBars', min: 0, max: 8, integer: true },
    { name: 'trendFilter', values: [false, true] },
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
  ];
}

// ============ 预扫描缓存（与交易参数无关，可复用）============
let cachedRows: V16Row[] | null = null;
async function getPrescannedRows(): Promise<V16Row[]> {
  if (cachedRows) return cachedRows;
  const fp = path.join(DATA_DIR, `${CODE}.json`);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(CODE, histBars as any, CODE, {
      edgeLookback: 70,
      allowRangeTrading: true,
    });
    rows.push(row);
  }
  cachedRows = rows;
  return rows;
}

// 采样数量：默认 1000，可用环境变量 LH_SAMPLES 覆盖（冒烟测试用）
const SAMPLE_N = Number(process.env.LH_SAMPLES || 1000);

// ============ 默认回测参数（与 runSilverMultiObjective 一致） ============
const BASE_OPTS = {
  startCapital: 1_000_000,
  maxPositionPct: 0.1,
  minSignalGrade: 'L2' as const,
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

// ============ 指标统计（与 runSilverMultiObjective 口径一致） ============
interface TradeLike {
  pnl: number;
  direction: 'LONG' | 'SHORT';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
}

interface Stats {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
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

function calcStats(trades: TradeLike[], theoLong: number, theoShort: number): Stats {
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
  // 最大回撤（按入场时间排序的资金曲线）
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  let equity = 0;
  let peak = 0;
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
    losses: trades.length - wins.length,
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

function compositeScore(s: Stats): number {
  return (
    s.winRate * 0.25 +
    Math.min(s.avgRR, 10) * 0.25 +
    Math.min(Math.max(s.capture, 0), 2.5) * 0.3 +
    Math.max(0, 1 - s.maxDrawdown) * 0.2
  );
}

function paretoFrontier(items: Array<{ stats: Stats; params: unknown }>) {
  const scores = items.map((it) => ({
    win: it.stats.winRate,
    rr: it.stats.avgRR,
    dd: it.stats.maxDrawdown,
  }));
  const pareto: typeof items = [];
  for (let i = 0; i < items.length; i++) {
    let dominated = false;
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      if (
        scores[j].win >= scores[i].win &&
        scores[j].rr >= scores[i].rr &&
        scores[j].dd <= scores[i].dd &&
        (scores[j].win > scores[i].win ||
          scores[j].rr > scores[i].rr ||
          scores[j].dd < scores[i].dd)
      ) {
        dominated = true;
        break;
      }
    }
    if (!dominated) pareto.push(items[i]);
  }
  return pareto;
}

// ============ 黑天鹅过滤器（LH0 专用） ============
// 事件库 BLACK_SWAN_EVENTS 中 LH0 相关事件均在 2003-2004（生猪 2021 上市，区间外无效），
// 因此生猪黑天鹅以「价格冲击扫描 detectShocks」为主 + 事件库叠加兜底。
// 语义：冲击日后 10 根 K 线进入冷却（禁止开仓），冲击日持仓按收盘提前平仓。
function buildBlackSwanFilter() {
  const bars = loadVarietyBars(CODE, DATA_DIR) as any[];
  const cooldown = new Array<boolean>(bars.length).fill(false);
  const shockDates = new Set<string>();
  const shockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
  try {
    const shocks = detectShocks(bars as any, CODE) as Array<{
      index: number;
      date: string;
      direction: 'up' | 'down';
    }>;
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
    console.warn('[LH0] 黑天鹅检测异常，回退为空过滤器:', (e as Error).message);
  }
  return {
    mode: 'riskOff' as const,
    cooldownMap: new Map([[CODE, cooldown]]),
    shockDirMap: new Map([[CODE, shockDir]]),
    shockDates: new Map([[CODE, shockDates]]),
    resonanceBoost: 0,
    divergenceCut: 0,
  };
}

// ============ 多头基线参数（生产优先 refined） ============
function getBaseLong() {
  return LONG_REFINED_PARAMS[CODE] ?? LONG_OPT_PARAMS[CODE];
}
function getBaseShort() {
  return SHORT_OPT_PARAMS[CODE];
}

// ============ 主流程：双口径 1000 次回测 ============
interface SampleResult {
  params: Record<string, number | string | boolean>;
  statsNone: Stats;
  statsBS: Stats;
}

interface NewsFilter {
  mode: 'none' | 'riskOff' | 'full';
  cooldownMap?: Map<string, boolean[]>;
  shockDirMap?: Map<string, Array<'up' | 'down' | null>>;
  shockDates?: Map<string, Set<string>>;
  resonanceBoost?: number;
  divergenceCut?: number;
}

async function runSingle(
  p: Record<string, number | string | boolean>,
  signalCache: Map<string, V16Row[]>,
  newsFilter?: NewsFilter,
): Promise<{ trades: TradeLike[]; stats: Stats }> {
  const result: any = await runBacktest({
    ...BASE_OPTS,
    startCapital: 1_000_000,
    maxPositionPct: 0.1,
    dataDir: DATA_DIR,
    codes: [CODE],
    signalCache,
    newsFilter,
    sideParams: { long: p as any, short: p as any },
  });
  const trades = (result.trades || []) as TradeLike[];
  const stats = calcStats(trades, THEO_LONG, THEO_SHORT);
  return { trades, stats };
}

let THEO_LONG = 0;
let THEO_SHORT = 0;

async function main() {
  console.log('========== LH0 生猪 1000 次回测（黑天鹅双口径） ==========');
  console.log('加载数据与预扫描...');

  // 1. 数据与理论基准
  const bars = loadBars(CODE);
  const theo = computeTheoreticalMax(bars, 3);
  THEO_LONG = theo.longReturn;
  THEO_SHORT = theo.shortReturn;
  console.log(`理论摆动 ${theo.swingCount} 段 | 做多 ${theo.longSegments} 段 ${THEO_LONG.toFixed(2)}% | 做空 ${theo.shortSegments} 段 ${THEO_SHORT.toFixed(2)}%`);

  // 2. 预扫描缓存
  const rows = await getPrescannedRows();
  const signalCache: Map<string, V16Row[]> = new Map([[CODE, rows]]);
  console.log(`预扫描完成，信号行 ${rows.length} 条`);

  // 3. 黑天鹅过滤器（含冷却10日 + 冲击日提前平仓）
  const bsFilter = buildBlackSwanFilter();

  // 4. 基线（当前生产参数）双口径
  const baseLong = getBaseLong();
  const baseShort = getBaseShort();
  const baseParams = { ...baseLong, ...baseShort };
  const baseNone = await runSingle(baseParams, signalCache);
  const baseBS = await runSingle(baseParams, signalCache, bsFilter);
  console.log('--- 基线（生产参数） ---');
  console.log(
    `无黑天鹅: 交易${baseNone.stats.totalTrades} 胜率${(baseNone.stats.winRate * 100).toFixed(1)}% 收益${Math.round(baseNone.stats.totalPnl).toLocaleString()} 回撤${(baseNone.stats.maxDrawdown * 100).toFixed(1)}% 捕获做多${(baseNone.stats.longCapture * 100).toFixed(1)}% 做空${(baseNone.stats.shortCapture * 100).toFixed(1)}%`,
  );
  console.log(
    `含黑天鹅: 交易${baseBS.stats.totalTrades} 胜率${(baseBS.stats.winRate * 100).toFixed(1)}% 收益${Math.round(baseBS.stats.totalPnl).toLocaleString()} 回撤${(baseBS.stats.maxDrawdown * 100).toFixed(1)}% 捕获做多${(baseBS.stats.longCapture * 100).toFixed(1)}% 做空${(baseBS.stats.shortCapture * 100).toFixed(1)}%`,
  );

  // 5. 采样 × 双口径
  const seed = 20260811;
  const samples = latinHypercubeSample(SAMPLE_N, buildDims(), seed);
  console.log(`采样 ${SAMPLE_N} 组参数，开始双口径回测（无黑天鹅 + 含黑天鹅）...`);

  const results: SampleResult[] = [];
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const rNone = await runSingle(p, signalCache);
    const rBS = await runSingle(p, signalCache, bsFilter);
    if (rNone.stats.totalTrades < 30 && rBS.stats.totalTrades < 30) continue;
    results.push({ params: p, statsNone: rNone.stats, statsBS: rBS.stats });
    if ((i + 1) % 100 === 0) {
      console.log(`  进度 ${i + 1}/${SAMPLE_N}（有效 ${results.length} 组）`);
    }
  }
  console.log(`回测完成，有效 ${results.length} 组`);

  // 6. 黑天鹅影响分析
  const pnlDrop = results.map((r) => {
    const base = Math.abs(r.statsNone.totalPnl);
    return base > 0 ? (r.statsBS.totalPnl - r.statsNone.totalPnl) / base : 0;
  });
  const pnlDropSorted = [...pnlDrop].sort((a, b) => a - b);
  const medianDrop = pnlDropSorted[Math.floor(pnlDropSorted.length / 2)];
  const dropPct = pnlDrop.filter((d) => d < -0.1).length / Math.max(1, pnlDrop.length);
  console.log('--- 黑天鹅影响（1000 组收益变化率分布） ---');
  console.log(
    `中位数 ${(medianDrop * 100).toFixed(1)}% | P10 ${(pnlDropSorted[Math.floor(pnlDropSorted.length * 0.1)] * 100).toFixed(1)}% | P90 ${(pnlDropSorted[Math.floor(pnlDropSorted.length * 0.9)] * 100).toFixed(1)}% | 恶化>10%占比 ${(dropPct * 100).toFixed(1)}%`,
  );

  // 7. 综合评分（含黑天鹅口径为主）
  const withScore = results.map((r) => ({ ...r, score: compositeScore(r.statsBS) }));
  withScore.sort((a, b) => b.score - a.score);
  const topAll = withScore.slice(0, 10).map((r) => ({
    params: r.params,
    composite: +r.score.toFixed(4),
    stats: {
      totalTrades: r.statsBS.totalTrades,
      winRate: +r.statsBS.winRate.toFixed(4),
      avgRR: +r.statsBS.avgRR.toFixed(4),
      capture: +r.statsBS.capture.toFixed(4),
      longCapture: +r.statsBS.longCapture.toFixed(4),
      shortCapture: +r.statsBS.shortCapture.toFixed(4),
      maxDrawdown: +r.statsBS.maxDrawdown.toFixed(4),
      totalPnl: +r.statsBS.totalPnl.toFixed(2),
      profitFactor: +r.statsBS.profitFactor.toFixed(4),
    },
    statsNone: {
      totalTrades: r.statsNone.totalTrades,
      winRate: +r.statsNone.winRate.toFixed(4),
      maxDrawdown: +r.statsNone.maxDrawdown.toFixed(4),
      totalPnl: +r.statsNone.totalPnl.toFixed(2),
    },
  }));

  // 8. 单指标 TOP5（含黑天鹅口径）
  const topWin = [...results].sort((a, b) => b.statsBS.winRate - a.statsBS.winRate).slice(0, 5).map((r) => ({ params: r.params, value: +r.statsBS.winRate.toFixed(4) }));
  const topRR = [...results].sort((a, b) => b.statsBS.avgRR - a.statsBS.avgRR).slice(0, 5).map((r) => ({ params: r.params, value: +r.statsBS.avgRR.toFixed(4) }));
  const topCap = [...results].sort((a, b) => b.statsBS.capture - a.statsBS.capture).slice(0, 5).map((r) => ({ params: r.params, value: +r.statsBS.capture.toFixed(4) }));
  const topDD = [...results].sort((a, b) => a.statsBS.maxDrawdown - b.statsBS.maxDrawdown).slice(0, 5).map((r) => ({ params: r.params, value: +r.statsBS.maxDrawdown.toFixed(4) }));

  // 9. Pareto 前沿（含黑天鹅口径）
  const pareto = paretoFrontier(results.map((r) => ({ stats: r.statsBS, params: r.params })));

  // 10. 控制台输出 TOP
  console.log('\n--- 综合评分 TOP10（含黑天鹅口径） ---');
  topAll.forEach((r, i) => {
    console.log(
      `#${i + 1} 胜率${(r.stats.winRate * 100).toFixed(1)}% RR${r.stats.avgRR.toFixed(2)} 捕获${(r.stats.capture * 100).toFixed(1)}%(多${(r.stats.longCapture * 100).toFixed(0)}%/空${(r.stats.shortCapture * 100).toFixed(0)}%) 回撤${(r.stats.maxDrawdown * 100).toFixed(1)}% 收益${Math.round(r.stats.totalPnl).toLocaleString()} | stop${String(r.params.stopAtrMult)} tgt${String(r.params.targetAtrMult)} hold${String(r.params.maxHoldDays)} cd${String(r.params.cooldownBars)} tf${String(r.params.trendFilter)} ${String(r.params.minSignalGrade)}`,
    );
  });
  console.log(`\nPareto 前沿 ${pareto.length} 个非支配解`);

  // 11. 落盘
  const output = {
    code: CODE,
    generatedAt: new Date().toISOString(),
    sampleCount: SAMPLE_N,
    seed,
    theo: { totalSwingPoints: theo.swingCount, longSegments: theo.longSegments, shortSegments: theo.shortSegments, longReturn: THEO_LONG, shortReturn: THEO_SHORT },
    baseline: { params: { long: baseLong, short: baseShort }, stats: baseNone.stats, statsBS: baseBS.stats },
    blackSwanImpact: {
      medianDrop: +medianDrop.toFixed(4),
      p10Drop: +pnlDropSorted[Math.floor(pnlDropSorted.length * 0.1)].toFixed(4),
      p90Drop: +pnlDropSorted[Math.floor(pnlDropSorted.length * 0.9)].toFixed(4),
      worseThan10pctRatio: +dropPct.toFixed(4),
    },
    topAll,
    topWin,
    topRR,
    topCap,
    topDD,
    pareto: pareto.map((r) => ({
      params: r.params,
      stats: {
        winRate: +r.stats.winRate.toFixed(4),
        avgRR: +r.stats.avgRR.toFixed(4),
        maxDrawdown: +r.stats.maxDrawdown.toFixed(4),
        capture: +r.stats.capture.toFixed(4),
        totalPnl: +r.stats.totalPnl.toFixed(2),
      },
    })),
    fullResults: results.map((r) => ({
      params: r.params,
      statsNone: {
        totalTrades: r.statsNone.totalTrades,
        winRate: +r.statsNone.winRate.toFixed(4),
        avgRR: +r.statsNone.avgRR.toFixed(4),
        capture: +r.statsNone.capture.toFixed(4),
        maxDrawdown: +r.statsNone.maxDrawdown.toFixed(4),
        totalPnl: +r.statsNone.totalPnl.toFixed(2),
      },
      statsBS: {
        totalTrades: r.statsBS.totalTrades,
        winRate: +r.statsBS.winRate.toFixed(4),
        avgRR: +r.statsBS.avgRR.toFixed(4),
        capture: +r.statsBS.capture.toFixed(4),
        maxDrawdown: +r.statsBS.maxDrawdown.toFixed(4),
        totalPnl: +r.statsBS.totalPnl.toFixed(2),
      },
    })),
  };
  const outPath = path.join(fileURLToPath(new URL('..', import.meta.url)), 'data', 'LH0_multiObjective.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`\n结果已落盘: ${outPath}`);
}

main().catch((e) => {
  console.error('[LH0 回测失败]', e);
  process.exit(1);
});
