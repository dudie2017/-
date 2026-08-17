/**
 * 做多定向二次寻优 (runWeakLongRefine)
 *
 * 用途：针对全品种回测中「做多捕获率」显著不足的弱品种，做窄区间加密二次寻优。
 *       以现有 LONG_OPT_PARAMS 最优参数为中心 ±30% 波动，每品种 3000 组采样，
 *       目标函数从「绝对做多金额 longPnl」升级为「做多捕获率」：
 *         做多捕获率 = 策略做多价格收益率累加 / 理论做多最大收益(3% ZigZag)
 *       并加约束：做多笔数 >= 理论做多段数×0.8、做多 PF >= 1.5（防牺牲质量换捕获率）。
 *
 * 用法：
 *   npx tsx src/scripts/runWeakLongRefine.ts SI0 SA0 EG0 NR0 LH0
 *
 * 输出：
 *   src/data/longRefinedParams.ts     每品种二次寻优做多参数（优于原参数才更新）
 *   src/data/weakLongRefineResult.json 完整结果（含捕获率对比）
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { loadBars, computeTheoreticalMax } from './theoreticalMax';
import { type V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OUT_DIR = path.join(process.cwd(), 'src/data');

// ============ 拉丁超立方采样（本地实现，避免 import 有顶层副作用的 runAllLongOptimization） ============
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

// ============ 基线参数（与 runAllLongOptimization 一致） ============
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

// ============ 指标计算（含方向级价格收益率） ============
function calcLongStats(trades: any[]) {
  const longTrades = trades.filter((t: any) => t.direction === 'LONG');
  const longWins = longTrades.filter((t: any) => t.pnl > 0);
  const longLosses = longTrades.filter((t: any) => t.pnl <= 0);
  const longGrossWin = longWins.reduce((s: number, t: any) => s + t.pnl, 0);
  const longGrossLoss = Math.abs(longLosses.reduce((s: number, t: any) => s + t.pnl, 0));
  // 做多价格收益率累加（无杠杆、无手续费，与理论最大收益同口径）
  const longPriceReturn = longTrades.reduce((s: number, t: any) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.exitPrice - t.entryPrice) / entryVal;
  }, 0);
  const longPF = longGrossLoss > 0 ? longGrossWin / longGrossLoss : longGrossWin > 0 ? 99 : 0;
  return { longTrades: longTrades.length, longWins: longWins.length, longPnl: longGrossWin - longGrossLoss, longPF, longPriceReturn };
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

// ============ 窄区间参数空间（以现有最优为中心 ±30%） ============
function buildRefineDims(base: Record<string, any>): ParamDim[] {
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const c = (v: number | undefined, def: number) => (typeof v === 'number' && isFinite(v) ? v : def);
  const stop = c(base.stopAtrMult, 1.5);
  const target = c(base.targetAtrMult, 3.0);
  const hold = c(base.maxHoldDays, 15);
  const cooldown = c(base.cooldownBars, 0);
  return [
    { name: 'stopAtrMult', min: clamp(stop * 0.7, 0.8, 3.5), max: clamp(stop * 1.3, 1.0, 4.0) },
    { name: 'targetAtrMult', min: clamp(target * 0.7, 1.5, 7.0), max: clamp(target * 1.3, 2.0, 8.0) },
    { name: 'maxHoldDays', min: clamp(hold * 0.7, 8, 60), max: clamp(hold * 1.3, 12, 60), integer: true },
    { name: 'cooldownBars', min: clamp(cooldown - 2, 0, 5), max: clamp(cooldown + 2, 0, 7), integer: true },
    { name: 'trendFilter', values: [false, true] },
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
  ];
}

// ============ 主流程 ============
async function main() {
  const argCodes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (argCodes.length === 0) {
    console.error('用法: npx tsx src/scripts/runWeakLongRefine.ts SI0 SA0 EG0 NR0 LH0');
    process.exit(1);
  }
  const codes = [...new Set(argCodes.map((c) => c.toUpperCase()))];
  console.log(`定向二次寻优品种 (${codes.length}): ${codes.join(', ')}`);

  const seed = 20260812;
  const SAMPLES = 3000;
  const allResults: any[] = [];
  const startAll = Date.now();

  for (let ci = 0; ci < codes.length; ci++) {
    const code = codes[ci];
    const t0 = Date.now();
    console.log(`\n[${ci + 1}/${codes.length}] ${code} ...`);

    const bars = loadBars(code);
    if (bars.length < 100) { console.log(`  数据不足，跳过`); continue; }
    const theo3 = computeTheoreticalMax(bars, 3);
    const theoLong = theo3.longReturn;
    const theoLongSeg = theo3.longSegments;
    console.log(`  理论做多: 收益${(theoLong * 100).toFixed(0)}% / ${theoLongSeg}段 (3% ZigZag)`);

    // 预扫描
    const cacheRows = await prescanVariety(code);
    const signalCache = new Map<string, V16Row[]>();
    signalCache.set(code, cacheRows);
    console.log(`  预扫描完成: ${cacheRows.length} 行 (${Date.now() - t0}ms)`);

    const optShort = SHORT_OPT_PARAMS[code];
    const sideShort = optShort ? { short: optShort } : undefined;
    const baseLong = LONG_OPT_PARAMS[code];

    // 当前基线（现有 LONG_OPT_PARAMS 做多 + 做空寻优）
    const baselineRes = await runBacktest({
      ...BASE_OPTS,
      codes: [code],
      dataDir: DATA_DIR,
      signalCache,
      sideParams: {
        long: baseLong,
        ...(sideShort || {}),
      },
    } as any);
    const baseStats = calcLongStats(baselineRes.trades || []);
    const baseCapture = theoLong > 0 ? baseStats.longPriceReturn / theoLong : 0;
    console.log(`  基线: 做多${baseStats.longTrades}笔 PF=${baseStats.longPF.toFixed(2)} 捕获率=${(baseCapture * 100).toFixed(1)}% (理论${(theoLong * 100).toFixed(0)}%)`);

    // 3000 组窄区间寻优
    const refineDims = buildRefineDims(baseLong || {});
    const samples = latinHypercubeSample(SAMPLES, refineDims, seed + codes.indexOf(code));
    const variants: any[] = [];
    for (let s = 0; s < samples.length; s++) {
      const lp = samples[s];
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
      const st = calcLongStats(res.trades || []);
      variants.push({
        sample: lp,
        stats: st,
        capture: theoLong > 0 ? st.longPriceReturn / theoLong : 0,
      });
    }

    // 评分：满足约束（笔数>=理论段×0.8 且 PF>=1.5）按捕获率降序；无满足约束者按捕获率降序
    const constraintOk = variants.filter((v) => v.stats.longTrades >= Math.max(5, Math.floor(theoLongSeg * 0.8)) && v.stats.longPF >= 1.5);
    const candidatePool = constraintOk.length > 0 ? constraintOk : variants;
    candidatePool.sort((a, b) => b.capture - a.capture);
    const best = candidatePool[0];

    const improved = best.capture > baseCapture;
    console.log(`  最优: 做多${best.stats.longTrades}笔 PF=${best.stats.longPF.toFixed(2)} 捕获率=${(best.capture * 100).toFixed(1)}% ${improved ? '✓优于基线' : '(未超基线)'}`);
    console.log(`    参数: 止损${best.sample.stopAtrMult} 目标${best.sample.targetAtrMult} 持有${best.sample.maxHoldDays} 冷却${best.sample.cooldownBars} 趋势${best.sample.trendFilter} 门槛${best.sample.minSignalGrade}`);

    allResults.push({
      code,
      theoLong: theoLong * 100,
      theoLongSeg,
      baseline: { ...baseStats, captureRate: baseCapture * 100 },
      best: {
        ...best,
        captureRate: best.capture * 100,
        improved,
      },
      // 决定最终落库参数：寻优更优则用寻优参数，否则保留原参数
      finalParams: improved ? best.sample : baseLong,
      reason: improved ? 'refined' : 'keep-baseline',
    });
    console.log(`  耗时 ${Date.now() - t0}ms`);
  }

  // 生成 longRefinedParams.ts
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const entries = allResults
    .filter((r) => r.finalParams)
    .map((r) => {
      const s = r.finalParams;
      return `  '${r.code}': { stopAtrMult: ${s.stopAtrMult}, targetAtrMult: ${s.targetAtrMult}, maxHoldDays: ${s.maxHoldDays}, cooldownBars: ${s.cooldownBars}, trendFilter: ${s.trendFilter}, minSignalGrade: '${s.minSignalGrade}' },`;
    });
  const paramsFile = `/**
 * 做多定向二次寻优参数（runWeakLongRefine 生成）
 *
 * 仅包含二次寻优后「做多捕获率」优于原参数（或需保留原参数）的弱品种。
 * 结构：{ 品种代码: { stopAtrMult, targetAtrMult, maxHoldDays, cooldownBars, trendFilter, minSignalGrade } }
 * 使用：v16_engine 读取时优先使用 LONG_REFINED_PARAMS[code]，缺失回退 LONG_OPT_PARAMS
 */
export const LONG_REFINED_PARAMS: Record<string, {
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  cooldownBars: number;
  trendFilter: boolean;
  minSignalGrade: string;
}> = {
${entries.join('\n')}
};
`;
  fs.writeFileSync(path.join(OUT_DIR, 'longRefinedParams.ts'), paramsFile);

  // 保存 JSON
  fs.writeFileSync(path.join(OUT_DIR, 'weakLongRefineResult.json'), JSON.stringify({
    meta: { codes, samplesPerVariety: SAMPLES, seed, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startAll },
    results: allResults,
  }, null, 2));

  console.log(`\n完成: ${allResults.length} 品种，总耗时 ${((Date.now() - startAll) / 1000).toFixed(0)}s`);
  console.log('输出: src/data/longRefinedParams.ts / src/data/weakLongRefineResult.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
