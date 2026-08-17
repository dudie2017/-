/**
 * 全品种做空专项寻优 (runAllShortOptimization)
 *
 * 用途：对全部品种（56个）做做空参数批量寻优，固定做多参数，找出每品种最优做空配置
 *
 * 流程：
 * 1. 遍历所有品种，预扫描缓存 V16Row 信号（scanV16Variety 输出与交易参数无关）
 * 2. 每品种跑基线（当前App默认参数）作为对比基准
 * 3. 对每品种生成 500 组做空参数（拉丁超立方采样），复用缓存做轻量回测
 * 4. 记录每品种做空最优 Top5 组合 + 捕获率
 * 5. 汇总输出到 JSON + 终端摘要
 *
 * 输出文件：src/data/allShortOptimization.json
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runBacktest, type BacktestResult } from '../services/backtestEngine';
import { scanV16Variety, evaluateV16Row } from '../services/v16_engine';
import { type V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OUT_DIR = path.join(process.cwd(), 'src/data');

// ============ 品种清单（数据充足 >=800根） ============
function listVarieties(): string[] {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const codes: string[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const bars = Array.isArray(raw) ? raw : raw.bars || [];
      if (bars.length >= 800) codes.push(code);
    } catch { /* skip */ }
  }
  return codes.sort();
}

// ============ 预扫描缓存 ============
async function prescanVariety(code: string): Promise<V16Row[]> {
  const fp = path.join(DATA_DIR, `${code}.json`);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, {
      edgeLookback: 70,
      allowRangeTrading: true,
    });
    rows.push(row);
  }
  return rows;
}

// ============ 拉丁超立方采样 ============
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ParamDim {
  name: string;
  min?: number;
  max?: number;
  integer?: boolean;
  values?: (number | string | boolean)[];
}

export function latinHypercubeSample(
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

// ============ 做空参数空间 ============
const SHORT_DIMS: ParamDim[] = [
  { name: 'stopAtrMult', min: 1.0, max: 3.0 },
  { name: 'targetAtrMult', min: 2.0, max: 6.0 },
  { name: 'maxHoldDays', min: 15, max: 40, integer: true },
  { name: 'cooldownBars', min: 0, max: 5, integer: true },
  { name: 'trendFilter', values: [false, true] },
  { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
];

// ============ 基线参数（当前App默认） ============
const BASE_OPTS = {
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

// ============ 指标计算 ============
interface TradeStat {
  totalTrades: number;
  wins: number;
  winRate: number;
  avgRR: number;
  totalPnl: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
  profitFactor: number;
  longTrades: number;
  longWins: number;
  longPnl: number;
  shortTrades: number;
  shortWins: number;
  shortPnl: number;
  microWinRatio: number;
}

function calcStats(trades: any[]): TradeStat {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  // 价格收益率（不含杠杆）：每笔 pnl 相对于入场合约价值的百分比之和
  const priceReturn = trades.reduce((s, t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.pnl / (entryVal * 1)) * 100;
  }, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0)) / losses.length : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? 99 : 0;
  const microWins = wins.filter((t) => Math.abs(t.pnl / (Math.abs(t.entryPrice) * 1)) < 0.01);
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgRR,
    totalPnl,
    totalReturn: priceReturn,
    maxDrawdown: 0,
    sharpe: 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    longTrades: longTrades.length,
    longWins: longTrades.filter((t) => t.pnl > 0).length,
    longPnl,
    shortTrades: shortTrades.length,
    shortWins: shortTrades.filter((t) => t.pnl > 0).length,
    shortPnl,
    microWinRatio: trades.length ? microWins.length / trades.length : 0,
  };
}

// ============ 主流程 ============
async function main() {
  const argCodes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let codes = listVarieties();
  if (argCodes.length > 0) {
    codes = argCodes.filter((c) => codes.includes(c));
    console.log(`指定品种: ${codes.join(', ')}`);
  }
  const total = codes.length;
  console.log(`发现 ${total} 个数据充足品种`);
  console.log('品种清单:', codes.join(', '));

  const seed = 42;
  const shortSamples = latinHypercubeSample(500, SHORT_DIMS, seed);
  console.log(`已生成 500 组做空参数（拉丁超立方）`);

  const allResults: any[] = [];
  const startAll = Date.now();

  for (let ci = 0; ci < total; ci++) {
    const code = codes[ci];
    const t0 = Date.now();
    console.log(`\n[${ci + 1}/${total}] 处理 ${code} ...`);

    // 预扫描
    const cacheRows = await prescanVariety(code);
    const signalCache = new Map<string, V16Row[]>();
    signalCache.set(code, cacheRows);
    console.log(`  预扫描完成: ${cacheRows.length} 个信号行 (${Date.now() - t0}ms)`);

    // 基线（当前App默认参数，多空一致）
    const baseline = await runBacktest({
      ...BASE_OPTS,
      codes: [code],
      dataDir: DATA_DIR,
      signalCache,
    } as any);

    // 500组做空寻优（固定做多参数）
    const variants: any[] = [];
    for (let s = 0; s < shortSamples.length; s++) {
      const sp = shortSamples[s];
      const res = await runBacktest({
        ...BASE_OPTS,
        codes: [code],
        dataDir: DATA_DIR,
        signalCache,
        sideParams: { short: sp },
      } as any);
      variants.push({
        sample: sp,
        stats: calcStats(res.trades || []),
      });
    }

    // 排序：按做空价格收益（shortPnl）降序
    variants.sort((a, b) => b.stats.shortPnl - a.stats.shortPnl);
    const top5 = variants.slice(0, 5);

    const baselineStats = calcStats(baseline.trades || []);
    const best = top5[0];
    allResults.push({
      code,
      baseline: baselineStats,
      bestShort: best,
      top5: top5.map((v) => ({ sample: v.sample, stats: v.stats })),
    });

    console.log(`  基线: ${baselineStats.totalTrades}笔 做空${baselineStats.shortTrades}笔 空赚${Math.round(baselineStats.shortPnl)}`);
    console.log(`  最优做空: 止损${best.sample.stopAtrMult} 目标${best.sample.targetAtrMult} 持有${best.sample.maxHoldDays} 冷却${best.sample.cooldownBars} 趋势${best.sample.trendFilter} 门槛${best.sample.minSignalGrade}`);
    console.log(`    做空${best.stats.shortTrades}笔 胜率${(best.stats.shortWins / Math.max(best.stats.shortTrades, 1) * 100).toFixed(1)}% 空赚${Math.round(best.stats.shortPnl)} (基线空赚${Math.round(baselineStats.shortPnl)})`);
    console.log(`    耗时 ${Date.now() - t0}ms`);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFp = path.join(OUT_DIR, 'allShortOptimization.json');
  fs.writeFileSync(outFp, JSON.stringify({
    meta: { total, seed, samples: 500, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startAll },
    dims: SHORT_DIMS,
    results: allResults,
  }, null, 2));
  console.log(`\n全部完成! 结果已保存到 ${outFp}`);
  console.log(`总耗时: ${((Date.now() - startAll) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
