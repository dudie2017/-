/**
 * 方案1：白银(AG0)多目标参数寻优 — 1000组拉丁超立方
 *
 * 视角：当前参数是单目标（收益）寻优产物，从未用
 *   "胜率 + 盈亏比 + 捕获率 + 回撤" 多指标加权评分。
 *
 * 输出：
 *   - 单指标 TOP10（胜率 / avgRR / 捕获率 / 低回撤）
 *   - 综合评分 TOP10（胜率×0.25 + avgRR×0.25 + 捕获率×0.30 + (1-回撤)×0.20）
 *   - Pareto 前沿（胜率-回报-回撤 三维权衡）
 *   - 与当前最优参数（LONG_OPT_PARAMS/SHORT_OPT_PARAMS）对比
 */
import * as path from 'path';
import * as fs from 'fs';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
import { computeTheoreticalMax, loadBars } from './theoreticalMax';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const CODE = 'AG0';

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
    const row: Record<string, number | string | boolean> = {};
    for (let d = 0; d < dims.length; d++) {
      const dim = dims[d];
      const u = perDim[d][i];
      if (dim.values) {
        const idx = Math.min(Math.floor(u * dim.values.length), dim.values.length - 1);
        row[dim.name] = dim.values[idx];
      } else {
        let v = dim.min! + u * (dim.max! - dim.min!);
        if (dim.integer) v = Math.round(v);
        else v = Math.round(v * 100) / 100;
        row[dim.name] = v;
      }
    }
    samples.push(row);
  }
  return samples;
}

// ============ 宽区间参数空间（覆盖全维度） ============
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

// ============ 预扫描缓存（与交易参数无关，可复用） ============
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

// ============ 默认回测参数（与 runSilverRobustAudit 一致） ============
const BASE_OPTS = {
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

// ============ 指标计算（含方向价格收益率 + 最大回撤） ============
function calcStats(trades: any[], theoLong: number, theoShort: number) {
  const longTrades = trades.filter((t: any) => t.direction === 'LONG');
  const shortTrades = trades.filter((t: any) => t.direction === 'SHORT');
  const wins = trades.filter((t: any) => t.pnl > 0);
  const grossWin = wins.reduce((s: number, t: any) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t: any) => t.pnl <= 0).reduce((s: number, t: any) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);
  const longPriceReturn = longTrades.reduce((s: number, t: any) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.exitPrice - t.entryPrice) / ev;
  }, 0);
  const shortPriceReturn = shortTrades.reduce((s: number, t: any) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.entryPrice - t.exitPrice) / ev;
  }, 0);
  const longCapture = theoLong > 0 ? longPriceReturn / theoLong : 0;
  const shortCapture = theoShort > 0 ? shortPriceReturn / theoShort : 0;
  const avgRR = trades.length ? totalPnl / Math.max(grossLoss, 1) : 0;
  // 最大回撤（按入场时间排序的资金曲线）
  const sorted = [...trades].sort((a: any, b: any) => (a.entryDate < b.entryDate ? -1 : 1));
  let equity = 0, peak = 0, maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
  }
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    avgRR,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    longCapture,
    shortCapture,
    capture: (longCapture + shortCapture) / 2,
    maxDrawdown: maxDd,
  };
}

// 综合评分：胜率×0.25 + avgRR(归一化)×0.25 + 捕获率×0.30 + (1-回撤)×0.20
function compositeScore(s: ReturnType<typeof calcStats>): number {
  const winScore = s.winRate;
  const rrScore = Math.min(s.avgRR / 8, 1);
  const capScore = Math.min(s.capture / 2, 1);
  const ddScore = Math.max(0, 1 - s.maxDrawdown);
  return winScore * 0.25 + rrScore * 0.25 + capScore * 0.30 + ddScore * 0.20;
}

// ============ Pareto 前沿（3维：胜率 / avgRR / 回撤） ============
function paretoFrontier(items: any[]) {
  const pts = items.map((it) => ({
    ...it,
    _win: it.stats.winRate,
    _rr: it.stats.avgRR,
    _dd: it.stats.maxDrawdown,
  }));
  const front: typeof pts = [];
  for (const p of pts) {
    let dominated = false;
    for (const q of pts) {
      if (p === q) continue;
      // q 在胜率、盈亏比上不差，且回撤不更差，且至少一项严格更好
      if (q._win >= p._win && q._rr >= p._rr && q._dd <= p._dd && (q._win > p._win || q._rr > p._rr || q._dd < p._dd)) {
        dominated = true;
        break;
      }
    }
    if (!dominated) front.push(p);
  }
  return front;
}

// ============ 主流程 ============
async function main() {
  const t0 = Date.now();
  console.log(`===== 方案1：白银(${CODE})多目标参数寻优 (1000组) =====`);
  const bars = loadBars(CODE);
  if (bars.length < 100) { console.error('数据不足'); process.exit(1); }
  const theo3 = computeTheoreticalMax(bars, 3);
  const theoLong = theo3.longReturn;
  const theoShort = theo3.shortReturn;
  console.log(`理论最大收益: 做多 ${(theoLong * 100).toFixed(0)}% / 做空 ${(theoShort * 100).toFixed(0)}%`);

  console.log(`预扫描 V16 信号 ...`);
  const rows = await getPrescannedRows();
  console.log(`预扫描完成: ${rows.length} 根K线`);

  const dims = buildDims();
  const SAMPLES = 1000;
  const samples = latinHypercubeSample(SAMPLES, dims, 20260901);
  const results: any[] = [];

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i] as any;
    const params = {
      ...p,
      minRR: 1.0,
      warmupBars: 60,
      returnAllTrades: true,
      quiet: true,
    };
    const bt = await runBacktest({
      ...BASE_OPTS,
      codes: [CODE],
      dataDir: DATA_DIR,
      signalCache: new Map<string, any[]>([[CODE, rows]]),
      sideParams: { long: params, short: params },
    } as any);
    const trades = (bt as any).trades || [];
    const stats = calcStats(trades, theoLong, theoShort);
    if (stats.totalTrades < 30) continue; // 样本量下限
    results.push({ params: p, stats });
    if ((i + 1) % 200 === 0) console.log(`  ${i + 1}/${SAMPLES} 完成 (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }

  console.log(`有效结果: ${results.length} 组`);
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // 基线：当前 LONG_OPT_PARAMS/SHORT_OPT_PARAMS（双向分离参数）
  const baseLong = LONG_OPT_PARAMS[CODE] || {};
  const baseShort = SHORT_OPT_PARAMS[CODE] || {};
  const baseParams = {
    ...baseLong,
    maxHoldDays: Math.max(baseLong.maxHoldDays || 37, baseShort.maxHoldDays || 40),
    cooldownBars: Math.min(baseLong.cooldownBars || 0, baseShort.cooldownBars || 4),
    trendFilter: baseLong.trendFilter || baseShort.trendFilter || false,
    minSignalGrade: 'L1',
    minRR: 1.0,
    warmupBars: 60,
    returnAllTrades: true,
    quiet: true,
    sideParams: {
      long: baseLong,
      short: baseShort,
    },
  };
  const baseBt = await runBacktest({
    ...BASE_OPTS,
    codes: [CODE],
    dataDir: DATA_DIR,
    signalCache: new Map<string, any[]>([[CODE, rows]]),
    sideParams: { long: baseLong, short: baseShort },
  } as any);
  const baseStats = calcStats((baseBt as any).trades || [], theoLong, theoShort);
  const baseScore = compositeScore(baseStats);

  const scored = results.map((r) => ({ ...r, score: compositeScore(r.stats) }));

  const out: any = {
    code: CODE,
    generatedAt: new Date().toISOString(),
    sampleCount: SAMPLES,
    theo: { long: theoLong, short: theoShort },
    baseline: {
      params: { long: baseLong, short: baseShort },
      stats: baseStats,
      composite: baseScore,
    },
    bestComposite: { params: scored[0]?.params || {}, stats: scored[0]?.stats || {}, composite: scored[0]?.score || 0 },
  };

  // ===== 输出 =====
  const fmt = (s: any) => ({
    winRate: +(s.winRate * 100).toFixed(1),
    avgRR: +s.avgRR.toFixed(2),
    capture: +(s.capture * 100).toFixed(1),
    maxDrawdown: +(s.maxDrawdown * 100).toFixed(1),
    totalPnl: Math.round(s.totalPnl),
    trades: s.totalTrades,
  });

  console.log(`\n===== 基线（当前最优参数）=====`);
  console.log(`胜率 ${(baseStats.winRate*100).toFixed(1)}% | avgRR ${baseStats.avgRR.toFixed(2)} | 捕获率 ${(baseStats.capture*100).toFixed(1)}% | 回撤 ${(baseStats.maxDrawdown*100).toFixed(1)}% | PnL ${Math.round(baseStats.totalPnl)} | 综合 ${baseScore.toFixed(3)}`);

  const topWin = [...scored].sort((a, b) => b.stats.winRate - a.stats.winRate).slice(0, 5);
  const topRR = [...scored].sort((a, b) => b.stats.avgRR - a.stats.avgRR).slice(0, 5);
  const topCap = [...scored].sort((a, b) => b.stats.capture - a.stats.capture).slice(0, 5);
  const topDD = [...scored].sort((a, b) => a.stats.maxDrawdown - b.stats.maxDrawdown).slice(0, 5);
  const topAll = [...scored].sort((a, b) => b.score - a.score).slice(0, 10);

  const printRow = (r: any) => {
    const p = r.params;
    console.log(`  胜率${(r.stats.winRate*100).toFixed(1)}% 盈亏${r.stats.avgRR.toFixed(2)} 捕获${(r.stats.capture*100).toFixed(1)}% 回撤${(r.stats.maxDrawdown*100).toFixed(1)}% PnL${Math.round(r.stats.totalPnl)} 综合${r.score.toFixed(3)} | stop${p.stopAtrMult} tgt${p.targetAtrMult} hold${p.maxHoldDays} cd${p.cooldownBars} tf${p.trendFilter} ${p.minSignalGrade}`);
  };

  console.log(`\n===== 单指标 TOP5 =====`);
  console.log(`--- 胜率最高 ---`); topWin.forEach(printRow);
  console.log(`--- 盈亏比最高 ---`); topRR.forEach(printRow);
  console.log(`--- 捕获率最高 ---`); topCap.forEach(printRow);
  console.log(`--- 回撤最低 ---`); topDD.forEach(printRow);

  console.log(`\n===== 综合评分 TOP10 =====`);
  topAll.forEach((r, i) => console.log(`#${i+1}`, `stop${r.params.stopAtrMult} tgt${r.params.targetAtrMult} hold${r.params.maxHoldDays} cd${r.params.cooldownBars} tf${r.params.trendFilter} ${r.params.minSignalGrade}`, `=> ${fmt(r.stats)} 综合${r.score.toFixed(3)}`));

  // Pareto 前沿（胜率 / avgRR / 回撤）
  const front = paretoFrontier(scored);
  console.log(`\n===== Pareto 前沿（胜率/盈亏比/回撤三维，${front.length} 个非支配解）=====`);
  front.forEach((r, i) => console.log(`P${i+1}`, `胜率${(r.stats.winRate*100).toFixed(1)}% 盈亏${r.stats.avgRR.toFixed(2)} 回撤${(r.stats.maxDrawdown*100).toFixed(1)}% 捕获${(r.stats.capture*100).toFixed(1)}% 综合${r.score.toFixed(3)}`, `| stop${r.params.stopAtrMult} tgt${r.params.targetAtrMult} hold${r.params.maxHoldDays} cd${r.params.cooldownBars} tf${r.params.trendFilter} ${r.params.minSignalGrade}`));

  out.bestComposite = {
    params: topAll[0]?.params || {}, stats: topAll[0]?.stats || {}, composite: topAll[0]?.score || 0,
  };
  out.topAll = topAll.map((r) => ({ params: r.params, stats: r.stats, composite: r.score }));
  out.pareto = front.map((r) => ({ params: r.params, stats: r.stats, composite: r.score }));

  const outFp = path.join(process.cwd(), 'src/data/AG0_multiObjective.json');
  fs.writeFileSync(outFp, JSON.stringify(out, null, 2));
  console.log(`\n结果已保存: ${outFp}`);
  console.log('完成');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
