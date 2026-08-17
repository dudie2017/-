/**
 * P3-c 风险平价组合优化（Risk Parity Portfolio Optimization）
 *
 * 基于月度收益序列，计算最优组合权重：
 * 1. 等权（Equal Weight）基准
 * 2. 逆波动率加权（Inverse Volatility）
 * 3. 风险平价（Risk Parity）— 每个品种对组合风险的贡献相等
 *
 * 输入：
 * - 品种池：通过三重筛选 + 成本稳健 + Regime 稳健的品种
 * - 月度收益：从 TOP1 回测 trades 聚合
 *
 * 输出：
 * - 三种权重方案
 * - 组合级别的 Calmar / Sharpe / MaxDD
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, computeTheoreticalMax, runTop1Backtest } from './runTop1FullBacktest';
import type { TradeLike } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

/** 聚合月度收益 */
function aggregateMonthly(trades: TradeLike[]): Map<string, number> {
  const monthly = new Map<string, number>();
  for (const t of trades) {
    const month = t.exitDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + t.pnl);
  }
  return monthly;
}

/** 计算波动率（年化） */
function annualizedVol(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  return Math.sqrt(variance) * Math.sqrt(12); // 月频 → 年化
}

/** 计算 Pearson 相关系数 */
function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

/** 构建协方差矩阵 */
function buildCovMatrix(returnsMap: Map<string, number[]>, codes: string[]): number[][] {
  const n = codes.length;
  const cov: number[][] = Array.from({ length: n }, () => Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      cov[i][j] = pearsonCorr(returnsMap.get(codes[i])!, returnsMap.get(codes[j])!)
        * annualizedVol(returnsMap.get(codes[i])!) * annualizedVol(returnsMap.get(codes[j])!);
    }
  }
  return cov;
}

/** 风险平价：迭代求解使风险贡献相等的权重 */
function riskParityWeights(cov: number[][], maxIter = 1000, tol = 1e-8): number[] {
  const n = cov.length;
  // 初始化：逆波动率加权
  const vols = cov.map((row, i) => Math.sqrt(row[i]));
  let w = vols.map(v => v > 0 ? 1 / v : 0);
  const wSum = w.reduce((s, v) => s + v, 0);
  w = w.map(v => v / wSum);

  for (let iter = 0; iter < maxIter; iter++) {
    // 组合方差
    const portVar = w.reduce((s, wi, i) => s + w.reduce((s2, wj, j) => s2 + wi * wj * cov[i][j], 0), 0);
    if (portVar <= 0) break;

    // 边际风险贡献
    const mrc = cov.map((row, i) => w.reduce((s, wj, j) => s + wj * row[j], 0) / Math.sqrt(portVar));
    // 风险贡献
    const rc = w.map((wi, i) => wi * mrc[i]);
    // 目标：每个 rc 相等 = portVol / n
    const target = Math.sqrt(portVar) / n;

    // 检查收敛
    const maxDiff = Math.max(...rc.map(r => Math.abs(r - target)));
    if (maxDiff < tol) break;

    // 调整权重：风险贡献低的增加权重，高的减少
    const adj = rc.map(r => r > 0 ? target / r : 1);
    w = w.map((wi, i) => wi * adj[i]);
    const wSum2 = w.reduce((s, v) => s + v, 0);
    w = w.map(v => v / wSum2);
  }

  return w.map(v => +v.toFixed(4));
}

/** 逆波动率加权 */
function inverseVolWeights(cov: number[][]): number[] {
  const vols = cov.map((row, i) => Math.sqrt(row[i]));
  const invVols = vols.map(v => v > 0 ? 1 / v : 0);
  const sum = invVols.reduce((s, v) => s + v, 0);
  return invVols.map(v => +(v / sum).toFixed(4));
}

/** 等权 */
function equalWeights(n: number): number[] {
  return Array(n).fill(+(1 / n).toFixed(4));
}

/** 计算组合月度收益 */
function portfolioReturns(weights: number[], returnsMatrix: number[][]): number[] {
  const nMonths = returnsMatrix[0]?.length || 0;
  const portRet: number[] = [];
  for (let t = 0; t < nMonths; t++) {
    let ret = 0;
    for (let i = 0; i < weights.length; i++) {
      ret += weights[i] * (returnsMatrix[i]?.[t] || 0);
    }
    portRet.push(ret);
  }
  return portRet;
}

/** 计算组合统计 */
function calcPortfolioStats(returns: number[], capital: number) {
  let equity = capital, peak = capital, mdd = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak === 0 ? 0 : (peak - equity) / peak;
    if (dd > mdd) mdd = dd;
  }
  const totalPnl = equity - capital;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std = returns.length > 1
    ? Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = std === 0 ? 0 : (mean / std) * Math.sqrt(12);
  const calmar = mdd === 0 ? (totalPnl > 0 ? 999 : 0) : totalPnl / (mdd * capital);

  return { totalPnl: +totalPnl.toFixed(0), totalReturn: +(totalPnl / capital * 100).toFixed(2), mdd: +(mdd * 100).toFixed(2), sharpe: +sharpe.toFixed(2), calmar: +calmar.toFixed(2) };
}

async function main() {
  // 品种池：通过三重筛选的品种 + 全 Regime 稳健的品种
  const triplePassFile = path.join(DATA_DIR, 'rescoreReport.json');
  const triplePass = ['CF0', 'CU0', 'HC0']; // 已知的三重筛选通过品种

  // 也可以从 volatilityRegimeAnalysis 中获取 all_robust 品种
  const regimeFile = path.join(DATA_DIR, 'volatilityRegimeAnalysis.json');
  let regimeRobust: string[] = [];
  if (fs.existsSync(regimeFile)) {
    const rf = JSON.parse(fs.readFileSync(regimeFile, 'utf8'));
    regimeRobust = (rf.allRobust || []).map((r: { code: string }) => r.code);
  }

  // 品种池：三重筛选通过 ∪ Regime 稳健（取并集，但排除成本敏感的）
  const costFile = path.join(DATA_DIR, 'costSensitivityAnalysis.json');
  let costDead: string[] = [];
  if (fs.existsSync(costFile)) {
    const cf = JSON.parse(fs.readFileSync(costFile, 'utf8'));
    costDead = (cf.dead || []).map((r: { code: string }) => r.code);
  }

  // 候选池 = (triplePass ∪ regimeRobust) - costDead
  const candidateSet = new Set([...triplePass, ...regimeRobust]);
  for (const c of costDead) candidateSet.delete(c);
  const candidates = [...candidateSet].sort();

  console.log(`=== P3-c 风险平价组合优化 ===`);
  console.log(`候选品种池: ${candidates.length} 个`);
  console.log(`  三重筛选: ${triplePass.join(', ')}`);
  console.log(`  Regime 稳健: ${regimeRobust.join(', ')}`);
  console.log(`  排除(成本淘汰): ${costDead.join(', ')}`);
  console.log(`  最终候选: ${candidates.join(', ')}\n`);

  // 跑回测，收集月度收益
  const returnsMap = new Map<string, Map<string, number>>();
  const allMonths = new Set<string>();

  for (const code of candidates) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    if (!recipe) continue;
    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);
    const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');
    const monthly = aggregateMonthly(trades);

    // 构建完整月度序列（缺失月填 0）
    const allM = [...new Set([...monthly.keys()])];
    for (const m of allM) allMonths.add(m);
    returnsMap.set(code, new Map(monthly.entries()));
  }

  // 构建统一的月份列表
  const months = [...allMonths].sort();
  console.log(`月度覆盖: ${months.length} 个月 (${months[0]} ~ ${months[months.length - 1]})\n`);

  // 构建对齐的收益矩阵（每个品种一个月度收益数组）
  const alignedReturns = new Map<string, number[]>();
  for (const code of candidates) {
    const m = returnsMap.get(code)!;
    alignedReturns.set(code, months.map(month => m.get(month) || 0));
  }

  const returnsMatrix: number[][] = candidates.map(c => alignedReturns.get(c)!);

  // 标准化为收益率（除以初始资金）
  const capital = 500000;
  const returnsPctMatrix = returnsMatrix.map(row => row.map(v => v / capital));

  // 用收益率百分比构建协方差矩阵
  const alignedReturnsPct = new Map<string, number[]>();
  for (let i = 0; i < candidates.length; i++) {
    alignedReturnsPct.set(candidates[i], returnsPctMatrix[i]);
  }
  const covMatrix = buildCovMatrix(alignedReturnsPct, candidates);

  // 三种权重方案
  const wEW = equalWeights(candidates.length);
  const wIV = inverseVolWeights(covMatrix);
  const wRP = riskParityWeights(covMatrix);

  // 计算组合表现
  const portEW = calcPortfolioStats(portfolioReturns(wEW, returnsMatrix), capital);
  const portIV = calcPortfolioStats(portfolioReturns(wIV, returnsMatrix), capital);
  const portRP = calcPortfolioStats(portfolioReturns(wRP, returnsMatrix), capital);

  // 输出
  console.log('=== 组合表现对比 ===');
  console.log(`等权:      收益 ${portEW.totalPnl} | 回撤 ${portEW.mdd}% | 夏普 ${portEW.sharpe} | Calmar ${portEW.calmar}`);
  console.log(`逆波动率:  收益 ${portIV.totalPnl} | 回撤 ${portIV.mdd}% | 夏普 ${portIV.sharpe} | Calmar ${portIV.calmar}`);
  console.log(`风险平价:  收益 ${portRP.totalPnl} | 回撤 ${portRP.mdd}% | 夏普 ${portRP.sharpe} | Calmar ${portRP.calmar}`);

  console.log('\n=== 风险平价权重 ===');
  const sortedWeights = candidates.map((code, i) => ({ code, weight: wRP[i], vol: Math.sqrt(covMatrix[i][i]) }))
    .sort((a, b) => b.weight - a.weight);
  for (const w of sortedWeights) {
    const bar = '█'.repeat(Math.round(w.weight * 50));
    console.log(`  ${w.code.padEnd(5)} ${(w.weight * 100).toFixed(1).padStart(5)}% ${bar} (vol: ${(w.vol * 100).toFixed(1)}%)`);
  }

  // 输出 JSON
  const outputPath = path.join(DATA_DIR, 'riskParityPortfolio.json');
  const output = {
    generatedAt: new Date().toISOString(),
    candidates,
    months: { count: months.length, range: `${months[0]} ~ ${months[months.length - 1]}` },
    weights: {
      equalWeight: Object.fromEntries(candidates.map((c, i) => [c, wEW[i]])),
      inverseVol: Object.fromEntries(candidates.map((c, i) => [c, wIV[i]])),
      riskParity: Object.fromEntries(candidates.map((c, i) => [c, wRP[i]])),
    },
    portfolioPerformance: {
      equalWeight: portEW,
      inverseVol: portIV,
      riskParity: portRP,
    },
    varietyStats: candidates.map((code, i) => ({
      code,
      weight: wRP[i],
      volatility: +Math.sqrt(covMatrix[i][i]).toFixed(4),
      monthlyPnl: returnsMatrix[i].filter(v => v !== 0),
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n已落盘: ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
