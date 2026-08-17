/**
 * P4-c 尾部风险 CVaR 分析（Conditional Value at Risk）
 *
 * 对全部 59 品种，计算月度收益的尾部风险指标：
 * - VaR(5%): 5% 分位数月度亏损
 * - CVaR(5%): 最差 5% 月份的平均亏损（Expected Shortfall）
 * - 尾部比率: CVaR / 平均月收益（越高说明尾部越肥）
 * - 偏度: 收益分布的偏度（负偏 = 左尾肥）
 * - 峰度: 收益分布的峰度（高峰度 = 极端事件多）
 *
 * 核心问题：卡玛比率好看但尾部肥厚的"隐患品种"
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, computeTheoreticalMax, runTop1Backtest } from './runTop1FullBacktest';
import type { TradeLike } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS, top1UnifiedParams } from '../data/top1UnifiedParams';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

/** 聚合月度收益 */
function aggregateMonthly(trades: TradeLike[], capital: number): number[] {
  const monthly = new Map<string, number>();
  for (const t of trades) {
    const month = t.exitDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + t.pnl / capital);
  }
  return [...monthly.values()].sort((a, b) => a - b);
}

/** 计算分位数 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/** 计算均值 */
function mean(arr: number[]): number {
  return arr.length === 0 ? 0 : arr.reduce((s, v) => s + v, 0) / arr.length;
}

/** 计算标准差 */
function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

/** 计算偏度 */
function skewness(arr: number[]): number {
  if (arr.length < 3) return 0;
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return 0;
  const n = arr.length;
  return (n / ((n - 1) * (n - 2))) * arr.reduce((sum, v) => sum + ((v - m) / s) ** 3, 0);
}

/** 计算超额峰度 */
function kurtosis(arr: number[]): number {
  if (arr.length < 4) return 0;
  const m = mean(arr);
  const s = std(arr);
  if (s === 0) return 0;
  const n = arr.length;
  const m4 = arr.reduce((sum, v) => sum + ((v - m) / s) ** 4, 0) / n;
  return m4 - 3; // 超额峰度（正态分布 = 0）
}

interface TailRiskResult {
  code: string;
  grade: string;
  totalMonths: number;
  profitableMonths: number;
  profitRate: number;
  avgMonthlyReturn: number;
  var5: number;       // VaR 5% (月度)
  cvar5: number;      // CVaR 5% (月度)
  var10: number;      // VaR 10%
  cvar10: number;     // CVaR 10%
  tailRatio5: number; // |CVaR5| / avgMonthlyReturn
  skewness: number;
  kurtosis: number;
  maxMonthlyLoss: number;
  maxMonthlyGain: number;
  verdict: 'clean' | 'fat_tail' | 'dangerous';
}

async function main() {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS);
  console.log(`=== P4-c 尾部风险 CVaR 分析 (${codes.length} 品种) ===\n`);

  const results: TailRiskResult[] = [];

  for (const code of codes) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    if (!recipe) continue;

    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);
    const capital = recipe.startCapital;
    const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');

    if (trades.length === 0) {
      results.push({
        code, grade: top1UnifiedParams[code]?.grade || '?', totalMonths: 0, profitableMonths: 0, profitRate: 0,
        avgMonthlyReturn: 0, var5: 0, cvar5: 0, var10: 0, cvar10: 0, tailRatio5: 0,
        skewness: 0, kurtosis: 0, maxMonthlyLoss: 0, maxMonthlyGain: 0, verdict: 'clean',
      });
      continue;
    }

    const sortedReturns = aggregateMonthly(trades, capital);
    const allReturns = [...sortedReturns]; // already sorted
    const n = allReturns.length;
    const profitable = allReturns.filter(r => r > 0).length;

    const avgRet = mean(allReturns);
    const var5 = quantile(allReturns, 0.05);
    const var10 = quantile(allReturns, 0.10);

    // CVaR = 最差 X% 的平均
    const n5 = Math.max(1, Math.floor(n * 0.05));
    const n10 = Math.max(1, Math.floor(n * 0.10));
    const cvar5 = mean(allReturns.slice(0, n5));
    const cvar10 = mean(allReturns.slice(0, n10));

    const tailRatio5 = avgRet > 0 ? Math.abs(cvar5) / avgRet : 999;
    const skew = skewness(allReturns);
    const kurt = kurtosis(allReturns);

    // 判定
    let verdict: 'clean' | 'fat_tail' | 'dangerous';
    if (tailRatio5 > 10 || cvar5 < -0.05) {
      verdict = 'dangerous';
    } else if (tailRatio5 > 5 || skew < -1 || kurt > 3) {
      verdict = 'fat_tail';
    } else {
      verdict = 'clean';
    }

    results.push({
      code,
      grade: top1UnifiedParams[code]?.grade || '?',
      totalMonths: n,
      profitableMonths: profitable,
      profitRate: +(profitable / n * 100).toFixed(1),
      avgMonthlyReturn: +avgRet.toFixed(4),
      var5: +var5.toFixed(4),
      cvar5: +cvar5.toFixed(4),
      var10: +var10.toFixed(4),
      cvar10: +cvar10.toFixed(4),
      tailRatio5: +tailRatio5.toFixed(2),
      skewness: +skew.toFixed(3),
      kurtosis: +kurt.toFixed(3),
      maxMonthlyLoss: +allReturns[0].toFixed(4),
      maxMonthlyGain: +allReturns[n - 1].toFixed(4),
      verdict,
    });

    const icon = verdict === 'clean' ? '✅' : verdict === 'fat_tail' ? '⚠️' : '❌';
    console.log(`${icon} ${code.padEnd(5)} | 月均 ${(avgRet * 100).toFixed(2)}% | VaR5 ${(var5 * 100).toFixed(2)}% | CVaR5 ${(cvar5 * 100).toFixed(2)}% | 尾比 ${tailRatio5.toFixed(1)} | 偏 ${skew.toFixed(2)} | 峰 ${kurt.toFixed(1)}`);
  }

  // 统计
  const clean = results.filter(r => r.verdict === 'clean');
  const fatTail = results.filter(r => r.verdict === 'fat_tail');
  const dangerous = results.filter(r => r.verdict === 'dangerous');

  console.log(`\n=== 汇总 ===`);
  console.log(`尾部健康: ${clean.length} 个`);
  console.log(`肥尾警告: ${fatTail.length} 个`);
  console.log(`尾部危险: ${dangerous.length} 个`);

  // 输出 JSON
  const outputPath = path.join(DATA_DIR, 'tailRiskCVaR.json');
  const output = {
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, clean: clean.length, fatTail: fatTail.length, dangerous: dangerous.length },
    clean: clean.map(r => ({ code: r.code, grade: r.grade, cvar5: r.cvar5, tailRatio5: r.tailRatio5 })),
    fatTail: fatTail.map(r => ({ code: r.code, grade: r.grade, cvar5: r.cvar5, tailRatio5: r.tailRatio5, skewness: r.skewness, kurtosis: r.kurtosis })),
    dangerous: dangerous.map(r => ({ code: r.code, grade: r.grade, cvar5: r.cvar5, tailRatio5: r.tailRatio5 })),
    details: results.sort((a, b) => b.tailRatio5 - a.tailRatio5),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n已落盘: ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
