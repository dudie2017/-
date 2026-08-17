/**
 * 全品种做多专项寻优 (runAllLongOptimization)
 *
 * 用途：对全部品种（56个）做做多参数批量寻优，固定做空为每品种已寻优最优参数（SHORT_OPT_PARAMS），
 *       找出每品种最优做多配置，实现双向提升。
 *
 * 流程：
 * 1. 遍历所有品种，预扫描缓存 V16Row 信号（scanV16Variety 输出与交易参数无关）
 * 2. 每品种跑基线（做多默认 + 做空寻优）作为对比基准
 * 3. 对每品种生成 500 组做多参数（拉丁超立方采样），复用缓存做轻量回测
 * 4. 记录每品种做多最优 Top5 组合
 * 5. 汇总输出到 JSON + 生成 longOptParams.ts 配置文件
 *
 * 输出文件：src/data/allLongOptimization.json / src/data/longOptParams.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
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

// ============ 做多参数空间（与做空寻优对称） ============
const LONG_DIMS: ParamDim[] = [
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
  profitFactor: number;
  longTrades: number;
  longWins: number;
  longPnl: number;
  longPF: number;
  shortTrades: number;
  shortWins: number;
  shortPnl: number;
  shortPF: number;
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
  const longWins = longTrades.filter((t) => t.pnl > 0);
  const longLosses = longTrades.filter((t) => t.pnl <= 0);
  const shortWins = shortTrades.filter((t) => t.pnl > 0);
  const shortLosses = shortTrades.filter((t) => t.pnl <= 0);
  const longGrossWin = longWins.reduce((s, t) => s + t.pnl, 0);
  const longGrossLoss = Math.abs(longLosses.reduce((s, t) => s + t.pnl, 0));
  const shortGrossWin = shortWins.reduce((s, t) => s + t.pnl, 0);
  const shortGrossLoss = Math.abs(shortLosses.reduce((s, t) => s + t.pnl, 0));
  // 价格收益率（不含杠杆）
  const totalReturn = trades.reduce((s, t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.pnl / (entryVal * 1)) * 100;
  }, 0);
  // 微利占比：盈利但每笔收益 < 0.05%（相对入场价）
  const microWins = wins.filter((t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return false;
    return t.pnl / entryVal < 0.0005;
  });
  // 平均盈亏比（经典口径）：总盈利 / 总亏损
  const avgRR = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgRR,
    totalPnl,
    totalReturn,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    longTrades: longTrades.length,
    longWins: longTrades.filter((t) => t.pnl > 0).length,
    longPnl,
    longPF: longGrossLoss > 0 ? longGrossWin / longGrossLoss : longGrossWin > 0 ? 99 : 0,
    shortTrades: shortTrades.length,
    shortWins: shortTrades.filter((t) => t.pnl > 0).length,
    shortPnl,
    shortPF: shortGrossLoss > 0 ? shortGrossWin / shortGrossLoss : shortGrossWin > 0 ? 99 : 0,
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
  const longSamples = latinHypercubeSample(500, LONG_DIMS, seed);
  console.log(`已生成 500 组做多参数（拉丁超立方）`);

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

    // 基线（做多默认 + 做空用该品种已寻优参数）
    const optShort = SHORT_OPT_PARAMS[code];
    const sideShort = optShort ? { short: optShort } : undefined;
    const baseline = await runBacktest({
      ...BASE_OPTS,
      codes: [code],
      dataDir: DATA_DIR,
      signalCache,
      sideParams: sideShort,
    } as any);

    // 500组做多寻优（固定做空为该品种寻优参数）
    const variants: any[] = [];
    for (let s = 0; s < longSamples.length; s++) {
      const lp = longSamples[s];
      const res = await runBacktest({
        ...BASE_OPTS,
        codes: [code],
        dataDir: DATA_DIR,
        signalCache,
        sideParams: {
          long: lp,
          ...(sideShort || {}),
        },
      } as any);
      variants.push({
        sample: lp,
        stats: calcStats(res.trades || []),
      });
    }

    // 排序：按做多价格收益（longPnl）降序
    variants.sort((a, b) => b.stats.longPnl - a.stats.longPnl);
    const top5 = variants.slice(0, 5);

    const baselineStats = calcStats(baseline.trades || []);
    const best = top5[0];
    allResults.push({
      code,
      baseline: baselineStats,
      bestLong: best,
      top5: top5.map((v) => ({ sample: v.sample, stats: v.stats })),
    });

    console.log(`  基线: ${baselineStats.totalTrades}笔 做多${baselineStats.longTrades}笔 多赚${Math.round(baselineStats.longPnl)}`);
    console.log(`  最优做多: 止损${best.sample.stopAtrMult} 目标${best.sample.targetAtrMult} 持有${best.sample.maxHoldDays} 冷却${best.sample.cooldownBars} 趋势${best.sample.trendFilter} 门槛${best.sample.minSignalGrade}`);
    console.log(`    做多${best.stats.longTrades}笔 胜率${(best.stats.longWins / Math.max(best.stats.longTrades, 1) * 100).toFixed(1)}% 多赚${Math.round(best.stats.longPnl)} (基线多赚${Math.round(baselineStats.longPnl)})`);
    console.log(`    耗时 ${Date.now() - t0}ms`);
  }

  // 生成 longOptParams.ts 配置文件
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const paramsEntries = allResults.map((r) => {
    const s = r.bestLong.sample;
    return `  '${r.code}': { stopAtrMult: ${s.stopAtrMult}, targetAtrMult: ${s.targetAtrMult}, maxHoldDays: ${s.maxHoldDays}, cooldownBars: ${s.cooldownBars}, trendFilter: ${s.trendFilter}, minSignalGrade: '${s.minSignalGrade}' },`;
  });
  const paramsFile = `/**
 * 全品种做多最优参数（runAllLongOptimization 生成）
 *
 * 结构：{ 品种代码: { stopAtrMult, targetAtrMult, maxHoldDays, cooldownBars, trendFilter, minSignalGrade } }
 */
export const LONG_OPT_PARAMS: Record<string, {
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  cooldownBars: number;
  trendFilter: boolean;
  minSignalGrade: string;
}> = {
${paramsEntries.join('\n')}
};
`;
  const paramsFp = path.join(OUT_DIR, 'longOptParams.ts');
  fs.writeFileSync(paramsFp, paramsFile);

  // 保存 JSON
  const outFp = path.join(OUT_DIR, 'allLongOptimization.json');
  fs.writeFileSync(outFp, JSON.stringify({
    meta: { total, seed, samples: 500, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startAll },
    dims: LONG_DIMS,
    results: allResults,
  }, null, 2));
  console.log(`\n全部完成! 结果已保存到 ${outFp}`);
  console.log(`做多参数配置已生成: ${paramsFp}`);
  console.log(`总耗时: ${((Date.now() - startAll) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
