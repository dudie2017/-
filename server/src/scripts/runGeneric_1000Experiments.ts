// @ts-nocheck
/**
 * 通用 1000 次 LHS 回测脚本
 * 用法：npx tsx src/scripts/runGeneric_1000Experiments.ts <CODE> [multiplier]
 * 示例：npx tsx src/scripts/runGeneric_1000Experiments.ts MA0 10
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { loadVarietyBars } from '../services/newsBacktestEngine';
import { detectEventsFromNews } from '../services/newsService';
import { scanV16Variety } from '../services/v16_engine';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data-cache-daily-20y');
const OUT_DIR = path.resolve(__dirname, '../data');

// ============ 命令行参数 ============
const args = process.argv.slice(2);
const CODE = args[0] || 'MA0';
const MULTIPLIER = parseInt(args[1] || '10', 10);
// 是否落盘逐笔 trades（用于后续时间序列分析；默认关闭以控制文件体积）
const STORE_TRADES = process.env.STORE_TRADES === '1';

// ============ 品种特定配置 ============
const VARIETY_CONFIG: Record<string, { multiplier: number; baseRecipe: Record<string, any> }> = {
  MA0: {
    multiplier: 10,
    baseRecipe: {
      minSignalGrade: 'L2', trendFilter: false, cooldownBars: 1, edgeLookback: 70,
      allowRangeTrading: true, equationMode: 'soft', pThreshold: 0.45,
      stopAtrMult: 1.5, targetAtrMult: 3.0, maxHoldDays: 15, minRR: 1.0,
      maxPositionPct: 0.15, directionMode: 'split', dataWindow: 'full',
      nonGreenMul: 1.0, counterCampMul: 1.0, campWindow: 21, feeMult: 1.0,
      startCapital: 500000, softEquationMul: 0.5,
      bsMode: 'none', circuitBreaker: '3x10', volReduce: 'off', dailyLossLimit: 'off',
    },
  },
  EG0: { multiplier: 10, baseRecipe: null },
  EB0: { multiplier: 5, baseRecipe: null },
  C0: { multiplier: 10, baseRecipe: null },
  CS0: { multiplier: 10, baseRecipe: null },
  JD0: { multiplier: 10, baseRecipe: null },
  RM0: { multiplier: 10, baseRecipe: null },
  CJ0: { multiplier: 5, baseRecipe: null },
  PK0: { multiplier: 5, baseRecipe: null },
  OI0: { multiplier: 10, baseRecipe: null },
  FG0: { multiplier: 20, baseRecipe: null },
  SA0: { multiplier: 20, baseRecipe: null },
  UR0: { multiplier: 20, baseRecipe: null },
};

const config = VARIETY_CONFIG[CODE] || { multiplier: MULTIPLIER, baseRecipe: null };
const contractMultiplier = config.multiplier;

// 如果未指定 baseRecipe，使用默认配置
const baseRecipe = config.baseRecipe || {
  minSignalGrade: 'L2', trendFilter: false, cooldownBars: 1, edgeLookback: 70,
  allowRangeTrading: true, equationMode: 'soft', pThreshold: 0.45,
  stopAtrMult: 1.5, targetAtrMult: 3.0, maxHoldDays: 15, minRR: 1.0,
  maxPositionPct: 0.15, directionMode: 'split', dataWindow: 'full',
  nonGreenMul: 1.0, counterCampMul: 1.0, campWindow: 21, feeMult: 1.0,
  startCapital: 500000, softEquationMul: 0.5,
  bsMode: 'none', circuitBreaker: '3x10', volReduce: 'off', dailyLossLimit: 'off',
};

// ============ 类型定义 ============
interface Bar {
  date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
}

interface V16Row {
  date: string;
  signal: string;
  direction: 'up' | 'down' | 'neutral';
  strength: number;
  atr14: number;
  atr60: number;
  momentum: number;
  regime: string;
  [key: string]: any;
}

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

interface ExpResult {
  id: number;
  recipe: Record<string, any>;
  stats: Stats;
  trades: TradeLike[];
  recipeKey?: string;
}

interface Dim {
  name: string;
  values: any[];
}

// ============ 数据加载 ============
function loadBars(code: string): Bar[] {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  return (Array.isArray(raw) ? raw : raw.bars || []) as Bar[];
}

// ============ 理论最大收益计算 ============
function computeTheoreticalMax(bars: Bar[], minSwingPct: number) {
  let longReturn = 0, shortReturn = 0;
  let longSegments = 0, shortSegments = 0;
  let swingCount = 0;
  for (let i = 1; i < bars.length; i++) {
    const ret = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
    if (Math.abs(ret) >= minSwingPct / 100) {
      swingCount++;
      if (ret > 0) { longReturn += ret; longSegments++; }
      else { shortReturn += Math.abs(ret); shortSegments++; }
    }
  }
  return { longReturn, shortReturn, longSegments, shortSegments, swingCount };
}

// ============ 24 维度变体定义 ============
function buildDims(): Dim[] {
  return [
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3', 'L4'] },
    { name: 'trendFilter', values: [false, true] },
    { name: 'cooldownBars', values: [0, 1, 2, 3, 5] },
    { name: 'edgeLookback', values: [50, 70, 100] },
    { name: 'allowRangeTrading', values: [false, true] },
    { name: 'equationMode', values: ['none', 'soft', 'hard'] },
    { name: 'pThreshold', values: [0.35, 0.4, 0.45, 0.5, 0.55] },
    { name: 'softEquationMul', values: [0.3, 0.5, 0.7, 1.0] },
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

// ============ 预扫描缓存 ============
const cachePool = new Map<string, V16Row[]>();
async function getPrescannedRows(edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const key = `${edgeLookback}_${allowRangeTrading}`;
  if (cachePool.has(key)) return cachePool.get(key)!;
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${CODE}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Bar[];
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(CODE, histBars as any, CODE, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  cachePool.set(key, rows);
  console.log(`  预扫描完成：edge=${edgeLookback} range=${allowRangeTrading} → ${rows.length} 行`);
  return rows;
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

// ============ 回测执行 ============
async function runExperiment(id: number, recipe: Record<string, any>, bars: Bar[], theo: any): Promise<ExpResult> {
  const { slice } = applyWindow(bars, String(recipe.dataWindow || 'full'));
  const rows = await getPrescannedRows(Number(recipe.edgeLookback || 70), Boolean(recipe.allowRangeTrading));
  const filteredRows = rows.filter((r) => {
    const gradeOrder: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
    const minGrade = gradeOrder[String(recipe.minSignalGrade || 'L2')] || 2;
    const rowGrade = gradeOrder[r.signal] || 99;
    return rowGrade <= minGrade;
  });
  const trades: TradeLike[] = [];
  for (const row of filteredRows) {
    const engineResult = await runV16Engine(row, slice as any, recipe);
    if (engineResult.trades) {
      trades.push(...engineResult.trades.map((t: any) => ({
        ...t,
        pnl: t.pnl * contractMultiplier,
      })));
    }
  }
  const stats = calcStats(trades, theo.longReturn, theo.shortReturn, Number(recipe.startCapital || 500000));
  return { id, recipe, stats, trades };
}

// 精简逐笔交易（仅保留时间序列分析必需字段，控制落盘体积）
function pickTrades(trades: TradeLike[]): Array<Record<string, any>> {
  return trades.map((t) => ({
    entryDate: t.entryDate,
    exitDate: t.exitDate,
    pnl: +t.pnl.toFixed(2),
    direction: t.direction,
  }));
}

// ============ LHS 采样 ============
function mulberry32(seed: number) {
  let s = seed;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lhsUnique(n: number, dims: Dim[], seed: number): Record<string, any>[] {
  const rng = mulberry32(seed);
  const samples = new Set<string>();
  const results: Record<string, any>[] = [];
  let attempts = 0;
  while (results.length < n && attempts < n * 10) {
    attempts++;
    const recipe: Record<string, any> = {};
    for (const dim of dims) {
      const idx = Math.floor(rng() * dim.values.length);
      recipe[dim.name] = dim.values[idx];
    }
    const key = JSON.stringify(recipe);
    if (!samples.has(key)) {
      samples.add(key);
      results.push(recipe);
    }
  }
  return results;
}

// ============ 方差分解分析 ============
function analyzeDimension(results: ExpResult[], dims: Dim[], metric: 'totalPnl' | 'maxDrawdown' | 'capture') {
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
const SEED = 20260901;
const OUT_FILE = `${CODE}_1000Experiments.json`;

function makeRecipeKey(recipe: Record<string, any>): string {
  return Object.entries(recipe).map(([k, v]) => `${k}=${v}`).join('|');
}

async function main() {
  console.log(`========== ${CODE} 1000 次 LHS 回测（24 维方法论空间）==========`);
  console.log(`合约乘数：${contractMultiplier}`);
  console.log('1/6 加载数据与理论基准...');
  const bars = loadBars(CODE);
  console.log(`${CODE} K 线 ${bars.length} 根（${bars[0]?.date} ~ ${bars[bars.length - 1]?.date}）`);
  const theo = computeTheoreticalMax(bars, 3);
  console.log(
    `全量理论：摆动 ${theo.swingCount} 段 | 做多 ${theo.longSegments} 段 ${(theo.longReturn * 100).toFixed(1)}% | 做空 ${theo.shortSegments} 段 ${(theo.shortReturn * 100).toFixed(1)}%`,
  );

  console.log('2/6 预扫描信号缓存（edgeLookback × allowRangeTrading 变体）...');
  const cacheStats: Array<{ edge: number; range: boolean; rows: number }> = [];
  for (const e of [50, 70, 100]) {
    for (const r of [false, true]) {
      const rows = await getPrescannedRows(e, r);
      cacheStats.push({ edge: e, range: r, rows: rows.length });
    }
  }
  console.log(`缓存组合 ${cacheStats.length} 组：${cacheStats.map((c) => `e${c.edge}/r${c.range}=${c.rows}行`).join(', ')}`);

  console.log('3/6 运行基线（默认参数：split + 3x10）...');
  const base = await runExperiment(0, baseRecipe, bars, theo);
  base.recipeKey = makeRecipeKey(baseRecipe);
  console.log(
    `基线：交易${base.stats.totalTrades} 胜率${(base.stats.winRate * 100).toFixed(1)}% 收益${Math.round(base.stats.totalPnl).toLocaleString()} 回撤${(base.stats.maxDrawdown * 100).toFixed(1)}% PF${base.stats.profitFactor.toFixed(2)} 捕获${(base.stats.capture * 100).toFixed(1)}%`,
  );

  console.log(`4/6 LHS 采样 ${N_EXPERIMENTS} 个唯一配方...`);
  const dims = buildDims();
  const samples = lhsUnique(N_EXPERIMENTS, dims, SEED);
  console.log(`有效唯一配方 ${samples.length} 个`);
  if (samples.length < N_EXPERIMENTS) {
    console.warn(`警告：去重后不足 ${N_EXPERIMENTS}，继续使用 ${samples.length} 个`);
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

  const fragility = findFragility(results, dims);
  console.log(`--- 脆弱点：${fragility.count}/${results.length} 组崩溃（收益<0 或回撤>50%）---`);
  fragility.topFactors.slice(0, 10).forEach((f) =>
    console.log(`  ${f.dimension}=${f.value}: 崩溃占比${(f.inFragile / Math.max(1, fragility.count) * 100).toFixed(0)}% vs 全局${(f.inAll / results.length * 100).toFixed(0)}% 提升${f.lift.toFixed(2)}x`),
  );

  const rankByPnl = [...results].sort((a, b) => b.stats.totalPnl - a.stats.totalPnl);
  const baseRankPnl = rankByPnl.findIndex((r) => r.id === 0);
  console.log(`--- 当前参数排名：收益 #${baseRankPnl + 1}/${results.length} ---`);

  const scored = results.map((r) => ({
    ...r,
    score: r.stats.totalPnl * 1.0 - r.stats.maxDrawdown * 1_000_000 * 2 + r.stats.winRate * 500_000 + r.stats.capture * 800_000,
  })).sort((a, b) => b.score - a.score);
  console.log('--- 综合 TOP5 配方 ---');
  scored.slice(0, 5).forEach((r, idx) => {
    const recipeStr = Object.entries(r.recipe)
      .filter(([k]) => ['stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'minSignalGrade', 'directionMode', 'circuitBreaker'].includes(k))
      .map(([k, v]) => `${k}=${v}`).join(' ');
    console.log(
      `  #${idx + 1} 收益${Math.round(r.stats.totalPnl).toLocaleString()} 胜率${(r.stats.winRate * 100).toFixed(1)}% 回撤${(r.stats.maxDrawdown * 100).toFixed(1)}% 捕获${(r.stats.capture * 100).toFixed(1)}% PF${r.stats.profitFactor.toFixed(2)} | ${recipeStr}`,
    );
  });

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
    },
    fullResults: results.map((r) => {
      const entry: any = {
        id: r.id,
        recipe: r.recipe,
        stats: {
          totalTrades: r.stats.totalTrades,
          winRate: +r.stats.winRate.toFixed(4),
          totalPnl: +r.stats.totalPnl.toFixed(2),
          maxDrawdown: +r.stats.maxDrawdown.toFixed(4),
          profitFactor: +r.stats.profitFactor.toFixed(4),
          capture: +r.stats.capture.toFixed(4),
          longCapture: +r.stats.longCapture.toFixed(4),
          shortCapture: +r.stats.shortCapture.toFixed(4),
        },
      };
      // P0: 按需落盘逐笔 trades，供后续时间序列分析（walk-forward/相关性/权益曲线）
      if (STORE_TRADES) {
        entry.trades = pickTrades(r.trades);
      }
      return entry;
    }),
    varianceDecomposition: {
      pnl: vdPnl,
      drawdown: vdDD,
      capture: vdCap,
    },
    fragility,
    top5: scored.slice(0, 5).map((r) => ({
      id: r.id,
      recipe: r.recipe,
      stats: r.stats,
      score: r.score,
    })),
  };

  fs.writeFileSync(path.join(OUT_DIR, OUT_FILE), JSON.stringify(output, null, 2));
  console.log(`\n结果已保存：${path.join(OUT_DIR, OUT_FILE)}`);
  console.log('========== 完成 ==========');
}

main().catch((err) => {
  console.error('错误:', err);
  process.exit(1);
});
