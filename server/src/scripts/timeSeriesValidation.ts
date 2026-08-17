/**
 * 配置建议 —— 第三层：时间序列样本外验证 + 动态再平衡模拟
 *
 * 与随机 bootstrap 不同，本脚本用「逐笔交易 → 月度已实现 PnL」构建时间对齐的
 * 收益序列，消除随机分割带来的数据泄漏：
 *   1) 时间序列 OOS：前 60% 月份训练权重，后 40% 月份样本外验证
 *   2) 动态再平衡：每月用滚动窗口重估权重，模拟真实资金曲线与换仓成本
 *
 * 运行：node --import tsx src/scripts/timeSeriesValidation.ts
 */
import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import {
  loadBars,
  computeTheoreticalMax,
  runTop1Backtest,
  type TradeLike,
} from './runTop1FullBacktest';
import {
  buildCovariance,
  portfolioStats,
  shrinkMu,
  computeThreePortfolios,
} from '../services/portfolioMath';

// ============ 常量（与 generateFullAnalysis 主流程保持一致） ============
const SHRINK_ALPHA = 0.5;
const MIN_WEIGHT = 0.01;
const SPLIT_RATIO = 0.6; // 前 60% 时间训练、后 40% 测试
const WARMUP_MONTHS = 24; // 动态再平衡热身期
const MIN_TRADES = 10; // 品种最少交易笔数，低于此值视为无有效策略信号
const MIN_ACTIVE_MONTHS = 48; // 品种最少活跃月份数，低于此值的新品种无法做时间序列验证
const MIN_ACTIVE_RATIO = 0.3; // 时间对齐时，保留"活跃品种占比 ≥ 此值"的月份
const REBAL_FEE = 0.0003; // 单次再平衡往返费率（手续费+滑点）

const DATA_FILE = path.join(process.cwd(), 'src/data/full_analysis.json');
const OUT_FILE = path.join(process.cwd(), 'src/data/config_time_series.json');

// ============ 类型 ============
interface EligibleVariety {
  code: string;
  sector: string;
}

interface SchemeOos {
  name: string;
  trainSharpe: number;
  testSharpe: number;
  decay: number;
  testAnnualReturn: number;
  testVolatility: number;
  testWinMonths: number; // 测试期正收益月份占比 (%)
}

interface RebalanceScheme {
  name: string;
  sharpe: number;
  annualReturn: number;
  maxDrawdown: number;
  turnoverPerYear: number; // 年化换手率（权重周转，0-1 表示每年换 100%）
  costPerYear: number; // 年化换仓成本（元/手）
  navCurve: number[];
}

// ============ 数值工具 ============
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(Math.max(v, 0));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function correlation(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den < 1e-12 ? 0 : num / den;
}

function annualSharpe(monthly: number[]): number {
  const m = mean(monthly);
  const s = std(monthly);
  if (s < 1e-12) return 0;
  return (m * 12) / (s * Math.sqrt(12));
}

function maxDrawdown(nav: number[]): number {
  let peak = nav[0] ?? 1;
  let mdd = 0;
  for (const v of nav) {
    if (v > peak) peak = v;
    const dd = peak === 0 ? 0 : (peak - v) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

// ============ 用月度 PnL 计算三种权重（与主流程一致的约束链） ============
function computeWeights(
  trainMatrix: number[][],
  sectors: string[]
): { equal: number[]; riskParity: number[]; maxSharpe: number[]; mu: number[]; Sigma: number[][] } {
  const n = trainMatrix.length;

  // 年化 μ（月度均值 × 12）
  const muAnnual = trainMatrix.map((row) => mean(row) * 12);
  // 年化波动率（月度 std × sqrt(12)）
  const volAnnual = trainMatrix.map((row) => std(row) * Math.sqrt(12));
  // 波动率下限：防止训练期内几乎无交易的品种（std≈0）破坏 ERC 与夏普计算
  const volFloor = Math.max(median(volAnnual.filter((v) => v > 0)) * 0.1, 1e-6);
  const volSafe = volAnnual.map((v) => (v > 0 && v >= volFloor ? v : volFloor));
  // 相关系数矩阵
  const corr: number[][] = [];
  for (let i = 0; i < n; i++) {
    corr.push([]);
    for (let j = 0; j < n; j++) {
      corr[i].push(i === j ? 1 : correlation(trainMatrix[i], trainMatrix[j]));
    }
  }
  const Sigma = buildCovariance(corr, volSafe);

  // μ 收缩：每个品种向全体均值收缩 50%
  const muAllMean = mean(muAnnual);
  const muShrunk = shrinkMu(muAnnual, new Array(n).fill(muAllMean), SHRINK_ALPHA);

  const { equalWeight: equal, riskParity, maxSharpe } = computeThreePortfolios(
    muShrunk,
    Sigma,
    sectors,
    { maxSharpeOpts: { restarts: 5, maxIter: 400, minWeight: MIN_WEIGHT } }
  );

  return { equal, riskParity, maxSharpe, mu: muShrunk, Sigma };
}

// ============ 时间序列 OOS：前 60% 训练、后 40% 测试 ============
function runTimeSeriesOOS(
  matrix: number[][],
  sectors: string[],
  splitIdx: number
): Record<string, SchemeOos> {
  const trainMatrix = matrix.map((row) => row.slice(0, splitIdx));
  const testMatrix = matrix.map((row) => row.slice(splitIdx));
  const testMonths = testMatrix[0]?.length || 0;

  const { equal, riskParity, maxSharpe, mu, Sigma } = computeWeights(trainMatrix, sectors);

  const evaluate = (w: number[], name: string): SchemeOos => {
    const inStats = portfolioStats(w, mu, Sigma);
    // 测试期组合月度收益
    const monthly: number[] = [];
    for (let m = 0; m < testMonths; m++) {
      let r = 0;
      for (let i = 0; i < w.length; i++) r += w[i] * testMatrix[i][m];
      monthly.push(r);
    }
    const testSharpe = annualSharpe(monthly);
    const testAnnualReturn = mean(monthly) * 12;
    const testVolatility = std(monthly) * Math.sqrt(12);
    const winMonths = monthly.filter((r) => r > 0).length;
    const testWinMonths = testMonths > 0 ? (winMonths / testMonths) * 100 : 0;
    return {
      name,
      trainSharpe: inStats.sharpe,
      testSharpe,
      decay: inStats.sharpe - testSharpe,
      testAnnualReturn,
      testVolatility,
      testWinMonths,
    };
  };

  return {
    equalWeight: evaluate(equal, '均衡型'),
    riskParity: evaluate(riskParity, '保守型'),
    maxSharpe: evaluate(maxSharpe, '进取型'),
  };
}

// ============ 动态再平衡：月度滚动重估权重 ============
function runDynamicRebalance(
  matrix: number[][],
  sectors: string[],
  contractValues: number[]
): Record<string, RebalanceScheme> {
  const n = matrix.length;
  const months = matrix[0]?.length || 0;
  if (months <= WARMUP_MONTHS + 1) return {};

  const rebalanceMonths = months - WARMUP_MONTHS;

  const simulate = (label: string, weightFn: (equal: number[], rp: number[], ms: number[]) => number[]): RebalanceScheme => {
    let w = new Array<number>(n).fill(1 / n);
    const nav = [1];
    let totalTurnover = 0;
    let totalCost = 0;
    let equity = 1;
    // 组合基准权益 = 各品种每手名义价值之和，用于把元/手盈亏归一化为收益率
    const totalNotional = contractValues.reduce((a, b) => a + b, 0) || 1;

    for (let m = WARMUP_MONTHS; m < months; m++) {
      // 本月的组合收益 = 上月末权重 × 本月各品种 PnL（收益已按元/手，需归一化为收益率）
      // 这里用「每手基准权益」把元/手换算为收益率，保持净值无量纲
      let pnlThisMonth = 0;
      for (let i = 0; i < n; i++) pnlThisMonth += w[i] * matrix[i][m];

      // 滚动窗口重估权重（用截至上月末的 WARMUP 个月）
      const windowMatrix = matrix.map((row) => row.slice(m - WARMUP_MONTHS, m));
      const { equal, riskParity, maxSharpe } = computeWeights(windowMatrix, sectors);
      const newW = weightFn(equal, riskParity, maxSharpe);

      // 换手率与换仓成本
      let turnover = 0;
      let cost = 0;
      for (let i = 0; i < n; i++) {
        const diff = Math.abs(newW[i] - w[i]);
        turnover += diff;
        cost += diff * contractValues[i] * REBAL_FEE;
      }
      totalTurnover += turnover;
      totalCost += cost;

      w = newW;
      equity *= 1 + (pnlThisMonth - cost) / totalNotional;
      nav.push(equity);
    }

    const navReturns: number[] = [];
    for (let i = 1; i < nav.length; i++) navReturns.push(nav[i] / nav[i - 1] - 1);
    const years = rebalanceMonths / 12;
    return {
      name: label,
      sharpe: annualSharpe(navReturns),
      annualReturn: years > 0 ? Math.pow(equity, 1 / years) - 1 : 0,
      maxDrawdown: maxDrawdown(nav),
      turnoverPerYear: years > 0 ? totalTurnover / years : 0,
      costPerYear: years > 0 ? totalCost / years : 0,
      navCurve: nav,
    };
  };

  return {
    equalWeight: simulate('均衡型', (e) => e),
    riskParity: simulate('保守型', (_e, rp) => rp),
    maxSharpe: simulate('进取型', (_e, _rp, ms) => ms),
  };
}

// ============ 主流程 ============
async function main() {
  console.log('=== 第三层：时间序列验证 ===\n');

  // 1. 读取 eligible 品种（与主流程预筛一致：avgPnlAll > 0）
  const full = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const eligible: EligibleVariety[] = (full.varieties || [])
    .filter((v: any) => v.avgPnlAll > 0)
    .map((v: any) => ({ code: v.code, sector: v.sector }));

  console.log(`eligible 品种：${eligible.length} 个`);

  // 2. 跑 top1 回测，构建月度 PnL
  const monthlyPnlByCode: Record<string, Map<string, number>> = {};
  const contractValues: Record<string, number> = {};
  const avgEntryPrice: Record<string, number> = {};

  for (const v of eligible) {
    const bars = loadBars(v.code);
    if (bars.length < 200) {
      console.log(`  跳过 ${v.code}（日线不足）`);
      continue;
    }
    const recipe = TOP1_UNIFIED_PARAMS[v.code];
    if (!recipe) {
      console.log(`  跳过 ${v.code}（无 TOP1 参数）`);
      continue;
    }
    process.stdout.write(`  回测 ${v.code} ... `);
    const theo = computeTheoreticalMax(bars, 3);
    const { trades } = await runTop1Backtest(v.code, recipe, bars, theo, 'full');
    if (trades.length < MIN_TRADES) {
      console.log(`跳过（交易 ${trades.length} 笔 < ${MIN_TRADES}）`);
      continue;
    }
    const monthly = new Map<string, number>();
    let sumEntry = 0;
    let cntEntry = 0;
    for (const t of trades) {
      if (!t.exitDate) continue;
      const month = t.exitDate.slice(0, 7);
      monthly.set(month, (monthly.get(month) || 0) + t.pnl);
      if (t.entryPrice && t.entryPrice > 0) {
        sumEntry += t.entryPrice;
        cntEntry++;
      }
    }
    if (monthly.size < MIN_ACTIVE_MONTHS) {
      console.log(`跳过（活跃 ${monthly.size} 月 < ${MIN_ACTIVE_MONTHS}，历史过短）`);
      continue;
    }
    monthlyPnlByCode[v.code] = monthly;
    const multiplier = CONTRACT_MULTIPLIER[v.code] || 10;
    const entry = cntEntry > 0 ? sumEntry / cntEntry : 1000;
    avgEntryPrice[v.code] = entry;
    contractValues[v.code] = entry * multiplier;
    console.log(`${trades.length} 笔交易，${monthly.size} 个月`);
  }

  const codes = Object.keys(monthlyPnlByCode);
  if (codes.length < 3) {
    console.log('可用品种不足，终止');
    return;
  }

  // 3. 时间对齐：保留「至少 50% 品种活跃」的月份，避免早期仅有少数品种有数据时大量填 0
  const allMonths = new Set<string>();
  Object.values(monthlyPnlByCode).forEach((m) => m.forEach((_v, k) => allMonths.add(k)));
  const allMonthsSorted = [...allMonths].sort();
  const minActive = Math.max(2, Math.ceil(codes.length * 0.5));
  const months = allMonthsSorted.filter((m) => {
    let active = 0;
    for (const code of codes) if (monthlyPnlByCode[code].has(m)) active++;
    return active >= minActive;
  });
  const matrix = codes.map((code) => months.map((m) => monthlyPnlByCode[code].get(m) || 0));
  const sectors = codes.map((code) => eligible.find((e) => e.code === code)?.sector || '未知');
  const codeContractValues = codes.map((code) => contractValues[code] || 10000);

  console.log(`\n时间窗口：${months[0]} ~ ${months[months.length - 1]}，共 ${months.length} 个月`);

  // 4. 时间序列 OOS
  const splitIdx = Math.floor(months.length * SPLIT_RATIO);
  console.log(`时间序列 OOS：训练 ${splitIdx} 个月（${months[0]}~${months[splitIdx - 1]}），测试 ${months.length - splitIdx} 个月（${months[splitIdx]}~${months[months.length - 1]}）\n`);
  const oos = runTimeSeriesOOS(matrix, sectors, splitIdx);

  // 5. 动态再平衡
  console.log(`动态再平衡：热身 ${WARMUP_MONTHS} 个月，滚动 ${months.length - WARMUP_MONTHS} 个月\n`);
  const rebalance = runDynamicRebalance(matrix, sectors, codeContractValues);

  // 6. 输出
  const result = {
    generatedAt: new Date().toISOString(),
    nVarieties: codes.length,
    months: months.length,
    splitRatio: SPLIT_RATIO,
    warmupMonths: WARMUP_MONTHS,
    window: { start: months[0], end: months[months.length - 1] },
    timeSeriesOOS: oos,
    dynamicRebalance: rebalance,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8');
  console.log(`\n结果已写入 ${OUT_FILE}`);

  // 打印报告
  console.log('\n--- 时间序列 OOS（年化夏普）---');
  for (const [k, v] of Object.entries(oos)) {
    console.log(
      `${v.name.padEnd(4)} 训练 ${v.trainSharpe.toFixed(2)} → 测试 ${v.testSharpe.toFixed(2)}（衰减 ${v.decay.toFixed(2)}），测试年化收益 ${(v.testAnnualReturn / 10000).toFixed(1)} 万，正收益月 ${v.testWinMonths.toFixed(0)}%`
    );
  }

  console.log('\n--- 动态再平衡（年化口径）---');
  for (const [k, v] of Object.entries(rebalance)) {
    console.log(
      `${v.name.padEnd(4)} 夏普 ${v.sharpe.toFixed(2)}，年化收益 ${(v.annualReturn * 100).toFixed(1)}%，最大回撤 ${(v.maxDrawdown * 100).toFixed(1)}%，年换手 ${v.turnoverPerYear.toFixed(2)}，年换仓成本 ${v.costPerYear.toFixed(0)} 元/手`
    );
  }
}

// 合约乘数（与回测引擎一致）
const CONTRACT_MULTIPLIER: Record<string, number> = {
  IC0: 200, IF0: 300, IH0: 300, IM0: 200,
  RB0: 10, I0: 100, JM0: 60, J0: 100, HC0: 10, SP0: 10,
  CU0: 5, AL0: 5, ZN0: 5, PB0: 5, NI0: 1, SC0: 1000, AU0: 1000, AG0: 15,
  RU0: 10, FU0: 10, BU0: 10, EG0: 10, EB0: 5, FG0: 20, MA0: 10, PP0: 5, V0: 5, PG0: 20, LU0: 10,
  M0: 10, Y0: 10, CF0: 5, SR0: 10, A0: 10, C0: 10, JD0: 5, AP0: 10, CJ0: 5, RM0: 10, OI0: 20,
  LH0: 16, SI0: 5, TA0: 5, P0: 10,
};

main().catch((e) => {
  console.error('timeSeriesValidation 失败：', e);
  process.exit(1);
});
