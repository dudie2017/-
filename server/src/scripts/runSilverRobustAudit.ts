/**
 * 方案7：白银（AG0）稳健性审计 —— 辩证检验"哪些提升是真实的"
 *
 * 三个子审计：
 *  A. 参数扰动测试：最优参数 ±10% 扰动 × 200 组随机扰动，看收益/胜率/PF/回撤的稳定性
 *     → 稳健解波动小；若扰动导致收益波动 >30%，说明参数敏感（过拟合信号）
 *  B. 按年收益分布：用最终参数跑全量，按 entryDate 年份分解，看是否靠单一年份撑起全部收益
 *     → 若单年贡献 >50%，说明收益集中度风险高
 *  C. 样本外验证：引用 runStrictOOS 结果（前18年寻优+后2年独立验证），验证参数非过拟合
 *
 * 用法：npx tsx src/scripts/runSilverRobustAudit.ts
 * 输出：src/data/silverRobustAudit.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
import { computeTheoreticalMax } from '../scripts/theoreticalMax';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const CODE = 'AG0';

// 预扫描信号行（与 runAll20yFinalBacktest 同实现，避免 import 副作用模块）
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

// 与 runAll20yFinalBacktest 一致的方向统计
function calcStats(trades: any[]) {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const longWins = longTrades.filter((t) => t.pnl > 0);
  const longLosses = longTrades.filter((t) => t.pnl <= 0);
  const shortWins = shortTrades.filter((t) => t.pnl > 0);
  const shortLosses = shortTrades.filter((t) => t.pnl <= 0);
  const lgw = longWins.reduce((s, t) => s + t.pnl, 0);
  const lgl = -longLosses.reduce((s, t) => s + t.pnl, 0);
  const sgw = shortWins.reduce((s, t) => s + t.pnl, 0);
  const sgl = -shortLosses.reduce((s, t) => s + t.pnl, 0);
  const longPriceReturn = longTrades.reduce((s: number, t: any) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.pnl / (entryVal * 1));
  }, 0);
  const shortPriceReturn = shortTrades.reduce((s: number, t: any) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.pnl / (entryVal * 1));
  }, 0);
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    longTrades: longTrades.length,
    longWins: longWins.length,
    longPnl: longTrades.reduce((s, t) => s + t.pnl, 0),
    longPF: lgl > 0 ? lgw / lgl : lgw > 0 ? 99 : 0,
    shortTrades: shortTrades.length,
    shortWins: shortWins.length,
    shortPnl: shortTrades.reduce((s, t) => s + t.pnl, 0),
    shortPF: sgl > 0 ? sgw / sgl : sgw > 0 ? 99 : 0,
    longPriceReturn,
    shortPriceReturn,
  };
}

// 最大回撤（按交易序列的累计资金曲线）
function calcMaxDrawdown(trades: any[]) {
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

// 按年收益分布
function calcByYear(trades: any[]) {
  const map: Record<string, { pnl: number; trades: number; wins: number }> = {};
  for (const t of trades) {
    const year = (t.entryDate || 'unknown').slice(0, 4);
    if (!map[year]) map[year] = { pnl: 0, trades: 0, wins: 0 };
    map[year].pnl += t.pnl;
    map[year].trades += 1;
    if (t.pnl > 0) map[year].wins += 1;
  }
  return Object.keys(map)
    .sort()
    .map((y) => ({ year: y, ...map[y] }));
}

async function main() {
  const startAll = Date.now();
  console.log(`===== 方案7：白银(AG0)稳健性审计 =====`);

  // 预扫描缓存
  const cacheRows = await prescanVariety(CODE);
  const signalCache = new Map<string, any[]>();
  signalCache.set(CODE, cacheRows);
  console.log(`预扫描完成: ${cacheRows.length} 个信号行`);

  const optLong = LONG_OPT_PARAMS[CODE] || {};
  const optShort = SHORT_OPT_PARAMS[CODE] || {};
  console.log(`当前做多参数: ${JSON.stringify(optLong)}`);
  console.log(`当前做空参数: ${JSON.stringify(optShort)}`);

  // ========== A. 参数扰动测试 ==========
  console.log('\n----- A. 参数扰动测试（±10% × 200组） -----');
  const seed = 42;
  const rand = () => {
    // LCG 伪随机（确定性，可复现）
    let s = seed;
    const next = () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
    return next;
  };

  // 对指定参数做 ±10% 随机扰动
  function perturb(p: Record<string, any>, rnd: () => number): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(p)) {
      if (typeof v === 'number') {
        const factor = 1 + (rnd() * 2 - 1) * 0.1; // ±10%
        out[k] = Math.round(v * factor * 100) / 100;
      } else if (typeof v === 'boolean') {
        out[k] = v; // 布尔参数不扰动（保持原值）
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  const rnd = rand();
  const perturbResults: any[] = [];
  const N_PERTURB = 200;
  for (let i = 0; i < N_PERTURB; i++) {
    const pLong = perturb(optLong, rnd);
    const pShort = perturb(optShort, rnd);
    const res = await runBacktest({
      ...BASE_OPTS,
      codes: [CODE],
      dataDir: DATA_DIR,
      signalCache,
      sideParams: { long: pLong, short: pShort },
    } as any);
    const st = calcStats(res.trades || []);
    const dd = calcMaxDrawdown(res.trades || []);
    perturbResults.push({
      iter: i,
      long: pLong,
      short: pShort,
      totalPnl: st.totalPnl,
      winRate: st.winRate,
      pf: st.profitFactor,
      maxDd: dd,
      longPnl: st.longPnl,
      shortPnl: st.shortPnl,
    });
  }

  const pnls = perturbResults.map((r) => r.totalPnl);
  const wins = perturbResults.map((r) => r.winRate);
  const pfs = perturbResults.map((r) => r.pf);
  const dds = perturbResults.map((r) => r.maxDd);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const std = (a: number[]) => {
    const m = mean(a);
    return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length);
  };
  const basePnl = (() => {
    // 基线：不扰动
    return perturbResults[0].totalPnl;
  })();
  const minPnl = Math.min(...pnls);
  const maxPnl = Math.max(...pnls);
  const cv = std(pnls) / Math.max(Math.abs(mean(pnls)), 1e-9);

  console.log(`扰动后收益: 均值 ${Math.round(mean(pnls))} | 标准差 ${Math.round(std(pnls))} | CV(变异系数) ${(cv * 100).toFixed(1)}%`);
  console.log(`收益区间: ${Math.round(minPnl)} ~ ${Math.round(maxPnl)} (相对均值波动 ±${((maxPnl - minPnl) / 2 / Math.max(Math.abs(mean(pnls)), 1e-9) * 100).toFixed(0)}%)`);
  console.log(`胜率: 均值 ${(mean(wins) * 100).toFixed(1)}% 波动 ${(std(wins) * 100).toFixed(1)}pp`);
  console.log(`PF: 均值 ${mean(pfs).toFixed(2)} 波动 ±${std(pfs).toFixed(2)}`);
  console.log(`最大回撤: 均值 ${(mean(dds) * 100).toFixed(1)}% 波动 ±${(std(dds) * 100).toFixed(1)}pp`);

  // ========== B. 按年收益分布 ==========
  console.log('\n----- B. 按年收益分布（最终参数全量） -----');
  const finalRes = await runBacktest({
    ...BASE_OPTS,
    codes: [CODE],
    dataDir: DATA_DIR,
    signalCache,
    sideParams: { long: optLong, short: optShort },
  } as any);
  const finalStats = calcStats(finalRes.trades || []);
  const byYear = calcByYear(finalRes.trades || []);
  const totalPnl = byYear.reduce((s, y) => s + y.pnl, 0);
  console.log('年份        PnL       笔数   胜率    占比');
  for (const y of byYear) {
    const pct = totalPnl ? (y.pnl / totalPnl) * 100 : 0;
    const wr = y.trades ? (y.wins / y.trades) * 100 : 0;
    console.log(`${y.year}    ${Math.round(y.pnl).toLocaleString().padStart(10)}  ${String(y.trades).padStart(4)}  ${wr.toFixed(1).padStart(6)}%  ${pct.toFixed(1).padStart(6)}%`);
  }
  const topYear = byYear.reduce((a, b) => (a.pnl > b.pnl ? a : b));
  console.log(`单年最大贡献: ${topYear.year} 年 ${Math.round(topYear.pnl)} (占 ${totalPnl ? ((topYear.pnl / totalPnl) * 100).toFixed(1) : 0}%)`);

  // 收益集中度：正收益年份是否集中在少数年份
  const positiveYears = byYear.filter((y) => y.pnl > 0);
  const top3 = [...byYear].sort((a, b) => b.pnl - a.pnl).slice(0, 3);
  const top3Sum = top3.reduce((s, y) => s + y.pnl, 0);
  console.log(`TOP3年份贡献占比: ${totalPnl ? ((top3Sum / totalPnl) * 100).toFixed(1) : 0}%`);

  // ========== C. 样本外验证（引用 strictOOS） ==========
  console.log('\n----- C. 样本外验证（引用 runStrictOOS 结果） -----');
  let oos: any = null;
  try {
    const oosRaw = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data/strictOOSResult.json'), 'utf8'));
    for (const r of oosRaw.results || []) {
      if (r.code === CODE) {
        oos = r;
        break;
      }
    }
  } catch (e) {
    console.log('未找到 strictOOSResult.json:', e);
  }

  if (oos) {
    const tLong = oos.test?.long || {};
    const tShort = oos.test?.short || {};
    const tTotal = oos.test?.total || {};
    const oosYears = oos.meta?.testYears || 2;
    const fmt = (v: number | undefined, d = 0) => (v === undefined || v === null || Number.isNaN(v) ? '-' : v.toFixed(d));
    console.log(`样本外(后${oosYears}年): 做多 ${tLong.trades ?? '-'}笔 胜率${fmt(tLong.winRate ? tLong.winRate * 100 : tLong.winRate, 1)}% PF${fmt(tLong.pf, 2)} PnL ${tLong.pnl !== undefined ? Math.round(tLong.pnl) : '-'}`);
    console.log(`样本外(后${oosYears}年): 做空 ${tShort.trades ?? '-'}笔 胜率${fmt(tShort.winRate ? tShort.winRate * 100 : tShort.winRate, 1)}% PF${fmt(tShort.pf, 2)} PnL ${tShort.pnl !== undefined ? Math.round(tShort.pnl) : '-'}`);
    console.log(`样本外总收益: ${tTotal.pnl !== undefined ? Math.round(tTotal.pnl) : '-'} (年化 ${tTotal.pnl !== undefined ? Math.round(tTotal.pnl / Math.max(oosYears, 1)) : '-'})`);
  } else {
    console.log('strictOOSResult.json 未包含 AG0 数据，跳过（不影响 A/B 审计）');
  }

  // ========== 汇总 ==========
  const summary = {
    code: CODE,
    perturbation: {
      n: N_PERTURB,
      pnlMean: mean(pnls),
      pnlStd: std(pnls),
      pnlCV: cv,
      pnlMin: minPnl,
      pnlMax: maxPnl,
      winRateMean: mean(wins),
      winRateStd: std(wins),
      pfMean: mean(pfs),
      pfStd: std(pfs),
      maxDdMean: mean(dds),
      maxDdStd: std(dds),
    },
    byYear,
    concentration: {
      totalPnl,
      topYear: topYear.year,
      topYearPnl: topYear.pnl,
      topYearRatio: totalPnl ? topYear.pnl / totalPnl : 0,
      top3Ratio: totalPnl ? top3Sum / totalPnl : 0,
      positiveYears: positiveYears.length,
    },
    final: finalStats,
    oos,
    verdict: {
      perturbStable: cv < 0.3 ? '稳健（CV<30%）' : cv < 0.5 ? '中等' : '敏感（可能过拟合）',
      yearlyConcentrated: totalPnl && topYear.pnl / totalPnl > 0.5 ? '集中（单年>50%）' : '分散',
    },
  };

  fs.writeFileSync(path.join(process.cwd(), 'src/data/silverRobustAudit.json'), JSON.stringify(summary, null, 2));
  console.log('\n===== 审计完成，结果已保存到 src/data/silverRobustAudit.json =====');
  console.log(`总耗时 ${((Date.now() - startAll) / 1000).toFixed(1)}s`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
