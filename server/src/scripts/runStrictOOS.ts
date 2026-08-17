/**
 * 严格样本外验证：前18年寻优 + 后2年独立验证
 *
 * 流程（每品种）：
 *   1. 在 TRAIN_DIR（前18年）预扫描 → signalCache
 *   2. 在 train 上做空寻优（固定做多=默认）→ trainBestShort
 *   3. 在 train 上做多寻优（固定做空=trainBestShort）→ trainBestLong
 *   4. 在 TEST_DIR（后2年）预扫描 → testCache
 *   5. 用 trainBestLong + trainBestShort 在 test 上回测 → 验证成功率
 *
 * 输出：src/data/strictOOSResult.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const TRAIN_DIR = path.join(process.cwd(), 'data-cache-train-18y');
const TEST_DIR = path.join(process.cwd(), 'data-cache-test-2y');
const OUT_FILE = path.join(process.cwd(), 'src/data/strictOOSResult.json');

interface ParamDim {
  name: string;
  min?: number;
  max?: number;
  integer?: boolean;
  values?: (number | string | boolean)[];
}

const LONG_DIMS: ParamDim[] = [
  { name: 'stopAtrMult', min: 1.0, max: 3.0 },
  { name: 'targetAtrMult', min: 2.0, max: 6.0 },
  { name: 'maxHoldDays', min: 15, max: 40, integer: true },
  { name: 'cooldownBars', min: 0, max: 5, integer: true },
  { name: 'trendFilter', values: [false, true] },
  { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
];

const SHORT_DIMS: ParamDim[] = [
  { name: 'stopAtrMult', min: 1.0, max: 3.0 },
  { name: 'targetAtrMult', min: 2.0, max: 6.0 },
  { name: 'maxHoldDays', min: 15, max: 40, integer: true },
  { name: 'cooldownBars', min: 0, max: 5, integer: true },
  { name: 'trendFilter', values: [false, true] },
  { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
];

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
function sideStats(trades: any[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  return {
    trades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    pnl,
    pf: grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? 99 : 0,
    avgRR: trades.length ? wins.reduce((s, t) => s + (t.rMultiple || 0), 0) / Math.max(trades.length, 1) : 0,
  };
}

// ============ 拉丁超立方采样 ============
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

function latinHypercubeSample(dims: ParamDim[], n: number, seed: number): Record<string, number | string | boolean>[] {
  const rng = mulberry32(seed);
  const perDim: number[][] = [];
  for (const dim of dims) {
    const order: number[] = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    perDim.push(order.map((rank) => (rank + rng()) / n));
  }
  const rows: Record<string, number | string | boolean>[] = [];
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
    rows.push(row);
  }
  return rows;
}

// ============ 预扫描（参数化数据目录） ============
async function prescanDir(dir: string, code: string): Promise<V16Row[]> {
  const file = path.join(dir, `${code}.json`);
  if (!fs.existsSync(file)) return [];
  const bars = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (bars.length < 80) return [];
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length; i++) {
    const histBars = bars.slice(0, i);
    try {
      const row = await scanV16Variety(code, histBars as any, code, {});
      if (row) rows.push(row);
    } catch (e) {
      // skip scan errors
    }
  }
  return rows;
}

function listVarieties(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();
}

// ============ 单品种寻优（固定另一方向参数） ============
async function optimizeSide(
  code: string,
  dataDir: string,
  signalCache: Map<string, V16Row[]>,
  dims: ParamDim[],
  side: 'long' | 'short',
  fixedOther: Record<string, number | string | boolean> | null,
  n = 500,
  seedBase = 1000
): Promise<{ best: Record<string, number | string | boolean>; bestStats: any; baseStats: any }> {
  const makeOpts = (sample: Record<string, number | string | boolean> | null, runBase: boolean) => {
    const opts: any = {
      ...BASE_OPTS,
      codes: [code],
      dataDir,
      signalCache,
      sideParams: {},
    };
    if (side === 'long') {
      opts.sideParams.long = sample ? { ...sample } : {};
      if (fixedOther) opts.sideParams.short = { ...fixedOther };
    } else {
      opts.sideParams.short = sample ? { ...sample } : {};
      if (fixedOther) opts.sideParams.long = { ...fixedOther };
    }
    return opts;
  };

  const baseRes: any = await runBacktest(makeOpts(null, true) as any);
  const baseTrades: any[] = baseRes?.trades || [];
  const baseStats = sideStats(side === 'long' ? baseTrades.filter((t) => t.direction === 'LONG') : baseTrades.filter((t) => t.direction === 'SHORT'));

  const samples = latinHypercubeSample(dims, n, seedBase + (side === 'long' ? 50000 : 20000));
  let bestStats: any = null;
  let bestSample: Record<string, number | string | boolean> | null = null;

  for (const sample of samples) {
    const res: any = await runBacktest(makeOpts(sample, false) as any);
    const trades: any[] = res?.trades || [];
    const sideTrades = side === 'long'
      ? trades.filter((t) => t.direction === 'LONG')
      : trades.filter((t) => t.direction === 'SHORT');
    const st = sideStats(sideTrades);
    const pass = st.trades >= 5 && st.pnl > 0 && st.winRate >= 0.4 && st.pf >= 1.5;
    if (pass && (!bestStats || st.pnl > bestStats.pnl)) {
      bestStats = st;
      bestSample = sample;
    }
  }

  if (!bestStats || !bestSample) {
    bestStats = baseStats;
    bestSample = {};
  }
  return { best: bestSample, bestStats, baseStats };
}

// ============ main ============
async function main() {
  console.log('=== 严格样本外验证：前18年寻优 + 后2年独立验证 ===');
  const codes = listVarieties(TRAIN_DIR);
  console.log('品种数:', codes.length);

  const results: any[] = [];
  const startTime = Date.now();

  for (let idx = 0; idx < codes.length; idx++) {
    const code = codes[idx];
    const t0 = Date.now();
    try {
      // 1. train 预扫描
      const trainCache = new Map<string, V16Row[]>();
      const trainRows = await prescanDir(TRAIN_DIR, code);
      if (!trainRows.length) {
        console.log(`[${idx + 1}/${codes.length}] ${code} 跳过（train数据不足）`);
        continue;
      }
      trainCache.set(code, trainRows);

      // 2. train 做空寻优（固定做多默认）
      const shortOpt = await optimizeSide(code, TRAIN_DIR, trainCache, SHORT_DIMS, 'short', null);
      const trainShortParams = shortOpt.best as Record<string, number | string | boolean>;

      // 3. train 做多寻优（固定做空 = trainBestShort）
      const longOpt = await optimizeSide(code, TRAIN_DIR, trainCache, LONG_DIMS, 'long', trainShortParams);
      const trainLongParams = longOpt.best as Record<string, number | string | boolean>;

      // 4. test 预扫描 + 回测
      const testCache = new Map<string, V16Row[]>();
      const testRows = await prescanDir(TEST_DIR, code);
      if (testRows.length) testCache.set(code, testRows);

      const testOpts: any = {
        ...BASE_OPTS,
        codes: [code],
        dataDir: TEST_DIR,
        signalCache: testRows.length ? testCache : undefined,
        sideParams: {
          long: { ...trainLongParams },
          short: { ...trainShortParams },
        },
      };
      const testRes: any = await runBacktest(testOpts as any);
      const testTrades: any[] = testRes?.trades || [];
      const testLong = sideStats(testTrades.filter((t) => t.direction === 'LONG'));
      const testShort = sideStats(testTrades.filter((t) => t.direction === 'SHORT'));
      const testTotal = sideStats(testTrades);

      const passLong = testLong.trades >= 5 && testLong.pnl > 0 && testLong.winRate >= 0.45 && testLong.pf >= 1.5;
      const passShort = testShort.trades >= 5 && testShort.pnl > 0 && testShort.winRate >= 0.45 && testShort.pf >= 1.5;

      results.push({
        code,
        train: {
          long: longOpt.bestStats,
          short: shortOpt.bestStats,
        },
        test: {
          long: testLong,
          short: testShort,
          total: testTotal,
          passLong,
          passShort,
          passBoth: passLong && passShort,
        },
      });

      console.log(
        `[${idx + 1}/${codes.length}] ${code} 验证期: 多${testLong.trades}笔/胜${(testLong.winRate * 100).toFixed(0)}%/赚${Math.round(testLong.pnl)}/PF${testLong.pf.toFixed(2)} ${passLong ? '✅' : '❌'} | 空${testShort.trades}笔/胜${(testShort.winRate * 100).toFixed(0)}%/赚${Math.round(testShort.pnl)}/PF${testShort.pf.toFixed(2)} ${passShort ? '✅' : '❌'} (${((Date.now() - t0) / 1000).toFixed(0)}s)`
      );
    } catch (e: any) {
      console.log(`[${idx + 1}/${codes.length}] ${code} 出错: ${e.message}`);
    }
  }

  const done = results.filter((r) => r.test.passBoth).length;
  const doneLong = results.filter((r) => r.test.passLong).length;
  const doneShort = results.filter((r) => r.test.passShort).length;
  const totalPnl = results.reduce((s, r) => s + r.test.total.pnl, 0);
  console.log('');
  console.log('=== 验证期（后2年）成功率 ===');
  console.log(`双方向: ${done}/${results.length} = ${((done / results.length) * 100).toFixed(1)}%`);
  console.log(`做多:   ${doneLong}/${results.length} = ${((doneLong / results.length) * 100).toFixed(1)}%`);
  console.log(`做空:   ${doneShort}/${results.length} = ${((doneShort / results.length) * 100).toFixed(1)}%`);
  console.log(`验证期总收益: ${Math.round(totalPnl)} 元`);
  console.log(`总耗时: ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    meta: { trainPeriod: '前18年', testPeriod: '后2年(2024-08起)', criteria: '胜率≥45% 且 方向PF≥1.5 且 收益>0 且 笔数≥5' },
    summary: {
      total: results.length,
      passBoth: done,
      passLong: doneLong,
      passShort: doneShort,
      rateBoth: results.length ? done / results.length : 0,
      rateLong: results.length ? doneLong / results.length : 0,
      rateShort: results.length ? doneShort / results.length : 0,
      totalPnl,
    },
    results,
  }, null, 2));
  console.log('结果已写入:', OUT_FILE);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
