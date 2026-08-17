/**
 * 方案2：方向不平等——做空专项深挖（辩证检验"做空该加强还是降级"）
 *
 * 视角：白银 2012-2026 长期走牛（理论复利做多 107 万 vs 做空 10.9 万，10 倍差距），
 * 样本外验证显示后 2 年做空几乎无机会（仅 1 笔）。本方案回答：
 *   - 做空方向专项寻优后捕获率能提升多少？
 *   - 分年度看做多/做空收益分布：做空的价值到底是"牛市对冲"还是"熊市提款机"？
 *
 * 输出：src/data/AG0_directional.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { computeTheoreticalMax, loadBars } from '../scripts/theoreticalMax';

const CODE = 'AG0';
const DATA_DIR = path.resolve(process.cwd(), 'data-cache-daily-20y');

const BASE_OPTS = {
  minSignalGrade: 'L2',
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

// 拉丁超立方采样（做空专用窄区间）
interface Dim {
  name: string;
  min?: number;
  max?: number;
  values?: (number | string | boolean)[];
}
function latinHypercubeSample(dims: Dim[], n: number): Record<string, number | string | boolean>[] {
  const samples: Record<string, number | string | boolean>[] = [];
  for (let s = 0; s < n; s++) {
    const p: Record<string, number | string | boolean> = {};
    for (const d of dims) {
      const u = (s + 0.5) / n;
      if (d.values) {
        const idx = Math.min(d.values.length - 1, Math.floor(u * d.values.length));
        p[d.name] = d.values[idx];
      } else if (d.min !== undefined && d.max !== undefined) {
        p[d.name] = d.min + u * (d.max - d.min);
      }
    }
    samples.push(p);
  }
  return samples;
}

// 从 trades 计算做空统计（价格收益率口径，与理论同维度）
function calcShortStats(trades: any[]) {
  const st = trades.filter((t) => t.direction === 'SHORT');
  const priceReturn = st.reduce((s: number, t: any) => {
    const e = Math.abs(t.entryPrice);
    if (!e) return s;
    return s + (e - Math.abs(t.exitPrice)) / e;
  }, 0);
  const wins = st.filter((t) => t.pnl > 0).length;
  const winRate = st.length ? wins / st.length : 0;
  const grossW = st.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossL = Math.abs(st.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const pf = grossL > 0 ? grossW / grossL : grossW > 0 ? 99 : 0;
  return { trades: st.length, winRate, pf, pnl: st.reduce((s, t) => s + t.pnl, 0), priceReturn };
}

// 分年方向收益矩阵
function yearlyMatrix(trades: any[]) {
  const map = new Map<string, { long: number; short: number; longW: number; shortW: number; longL: number; shortL: number }>();
  for (const t of trades) {
    const y = String(t.entryDate || '').slice(0, 4);
    if (!y) continue;
    if (!map.has(y)) map.set(y, { long: 0, short: 0, longW: 0, shortW: 0, longL: 0, shortL: 0 });
    const r = map.get(y)!;
    if (t.direction === 'LONG') {
      r.long += t.pnl;
      t.pnl > 0 ? r.longW++ : r.longL++;
    } else {
      r.short += t.pnl;
      t.pnl > 0 ? r.shortW++ : r.shortL++;
    }
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  console.log('[方案2] 做空专项深挖开始...');
  const bars = loadBars(CODE);
  // 预扫描（信号行缓存）
  const rows: any[] = [];
  const warmup = 60;
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(CODE, histBars as any, CODE, {
      minSignalGrade: 'L1', maxHoldDays: 15, stopAtrMult: 1.5, targetAtrMult: 3.0, cooldownBars: 0, trendFilter: false,
    } as any);
    if (row) rows.push(row);
  }
  const signalCache = new Map<string, any[]>();
  signalCache.set(CODE, rows);
  console.log(`预扫描完成: ${rows.length} 个信号行`);

  const theo = computeTheoreticalMax(bars, 3);
  console.log(`理论最大(3%): 做多 ${theo.longReturn.toFixed(2)} / 做空 ${theo.shortReturn.toFixed(2)}`);

  // 基线：当前 SHORT_OPT_PARAMS 的 AG0 参数
  const baseShort = { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' };
  const baseLong = { stopAtrMult: 1.53, targetAtrMult: 5.61, maxHoldDays: 37, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' };
  const baseBt: any = await runBacktest({ ...BASE_OPTS, codes: [CODE], dataDir: DATA_DIR, signalCache, sideParams: { long: baseLong, short: baseShort } } as any);
  const baseShortStats = calcShortStats(baseBt.trades);
  const baseCapture = theo.shortReturn > 0 ? baseShortStats.priceReturn / theo.shortReturn : 0;
  console.log(`\n基线做空: ${baseShortStats.trades} 笔 胜率 ${(baseShortStats.winRate * 100).toFixed(1)}% PF ${baseShortStats.pf.toFixed(2)} 收益 ${baseShortStats.pnl.toFixed(0)} 捕获率 ${(baseCapture * 100).toFixed(1)}%`);

  // 做空专项寻优：窄区间围绕基线 ±40%，目标=做空捕获率，约束胜率>=60%
  const dims: Dim[] = [
    { name: 'stopAtrMult', min: 1.0, max: 4.0 },
    { name: 'targetAtrMult', min: 1.5, max: 6.0 },
    { name: 'maxHoldDays', min: 15, max: 60 },
    { name: 'cooldownBars', min: 0, max: 8 },
    { name: 'trendFilter', values: [false, true] },
    { name: 'minSignalGrade', values: ['L1', 'L2', 'L3'] },
  ];
  const samples = latinHypercubeSample(dims, 600);
  const best: any = { capture: -1 };
  let validCount = 0;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const sideParams: any = {
      long: baseLong,
      short: {
        stopAtrMult: p.stopAtrMult as number,
        targetAtrMult: p.targetAtrMult as number,
        maxHoldDays: p.maxHoldDays as number,
        cooldownBars: p.cooldownBars as number,
        trendFilter: p.trendFilter as boolean,
        minSignalGrade: p.minSignalGrade as string,
      },
    };
    const bt: any = await runBacktest({ ...BASE_OPTS, codes: [CODE], dataDir: DATA_DIR, signalCache, sideParams } as any);
    const st = calcShortStats(bt.trades);
    if (st.trades < 30) continue;
    const capture = theo.shortReturn > 0 ? st.priceReturn / theo.shortReturn : 0;
    if (st.winRate >= 0.60 && capture > best.capture) {
      best.capture = capture;
      best.params = { ...sideParams.short };
      best.stats = st;
      best.totalPnl = bt.stats?.totalPnl ?? (bt.trades || []).reduce((s: number, t: any) => s + t.pnl, 0);
      best.totalTrades = (bt.trades || []).length;
      best.trades = bt.trades;
    }
    validCount++;
  }
  console.log(`\n做空寻优完成: 有效 ${validCount} 组`);
  if (best.capture > 0) {
    console.log(`最优做空: ${JSON.stringify(best.params)}`);
    console.log(`  捕获率 ${(best.capture * 100).toFixed(1)}% (基线 ${(baseCapture * 100).toFixed(1)}%, +${((best.capture - baseCapture) * 100).toFixed(1)}pp)`);
    console.log(`  做空 ${best.stats.trades} 笔 胜率 ${(best.stats.winRate * 100).toFixed(1)}% PF ${best.stats.pf.toFixed(2)} 收益 ${best.stats.pnl.toFixed(0)}`);
    console.log(`  全双向: ${best.totalTrades} 笔 总收益 ${best.totalPnl.toFixed(0)}`);
  }

  // 分年方向收益矩阵（用最优做空参数跑全序列）
  const finalBt: any = best.trades ? best : await runBacktest({ ...BASE_OPTS, codes: [CODE], dataDir: DATA_DIR, signalCache, sideParams: { long: baseLong, short: best.params || baseShort } } as any);
  const matrix = yearlyMatrix(finalBt.trades || []);
  console.log('\n===== 分年方向收益矩阵（最优做空参数）=====');
  console.log(`${'年份'.padEnd(6)}${'做多PnL'.padStart(10)}${'做空PnL'.padStart(10)}${'合计'.padStart(10)}${'多胜/多亏'.padStart(10)}${'空胜/空亏'.padStart(10)}`);
  let yearLongTotal = 0, yearShortTotal = 0;
  for (const [y, r] of matrix) {
    console.log(`${y.padEnd(6)}${String(r.long).padStart(10)}${String(r.short).padStart(10)}${String(r.long + r.short).padStart(10)}${`${r.longW}/${r.longL}`.padStart(10)}${`${r.shortW}/${r.shortL}`.padStart(10)}`);
    yearLongTotal += r.long;
    yearShortTotal += r.short;
  }
  console.log(`\n总计: 做多 ${yearLongTotal.toFixed(0)} / 做空 ${yearShortTotal.toFixed(0)}`);
  const shortPositiveYears = matrix.filter(([, r]) => r.short > 0).length;
  const longPositiveYears = matrix.filter(([, r]) => r.long > 0).length;
  console.log(`做多为正年份: ${longPositiveYears}/${matrix.length}  做空为正年份: ${shortPositiveYears}/${matrix.length}`);

  // 结论判断
  const result = {
    code: CODE,
    theo: { longReturn: theo.longReturn, shortReturn: theo.shortReturn },
    baseline: { short: baseShortStats, capture: baseCapture },
    bestShort: best.params || null,
    bestShortStats: best.stats || null,
    bestShortCapture: best.capture > 0 ? best.capture : baseCapture,
    bestTotalPnl: best.totalPnl ?? null,
    yearly: matrix.map(([y, r]) => ({ year: y, ...r })),
    conclusion: {
      shortPositiveYears,
      longPositiveYears,
      totalYears: matrix.length,
    },
  };
  fs.writeFileSync(path.resolve(process.cwd(), 'src/data/AG0_directional.json'), JSON.stringify(result, null, 2));
  console.log('\n已保存 src/data/AG0_directional.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
