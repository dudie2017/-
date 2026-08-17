/**
 * 「配置建议」模块 Bootstrap 样本外验证
 *
 * 目的：用 58 品种 × 1000 次实验回测数据，对三种配置方案
 * （等权重 / 风险平价 ERC / 最大夏普）做 1000 次蒙特卡洛样本外验证，
 * 检验配置权重在"新采样数据"上是否稳健，暴露过拟合 / 乐观偏差等问题。
 *
 * 方法：
 *   每个品种 1000 次实验随机抽 500 次作训练集、另 500 次作测试集
 *   训练集上算 μ 与协方差 Σ → 生成三种方案权重
 *   测试集上按两种口径评估：
 *     口径 A（对称 Top-K）：测试集前 10% 均值 —— 只看权重稳健性
 *     口径 B（现实）：测试集全体均值 —— 看完整流程的现实可靠性
 *   重复 N_BOOTSTRAP 次，汇总统计分布
 *
 * 运行：cd server && pnpm exec tsx src/scripts/configBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  buildCovariance,
  computeThreePortfolios,
  portfolioStats,
  shrinkMu,
} from '../services/portfolioMath';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');
const N_BOOTSTRAP = 1000;
const TRAIN_SIZE = 500;
const TOP_RATIO = 0.2; // 前 20%（样本外验证显示 20% 比 10% 更稳健）
const SHRINK_ALPHA = 0.5; // μ 收缩系数：μ = α·μ_top + (1-α)·μ_all
const MIN_WEIGHT = 0.01; // 权重下限 1%（低于则归零）
const MIN_HOLDINGS = 5; // 最小持仓数

// ---------------------------------------------------------------------------
// 可复现随机数（mulberry32）
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// 统计工具
// ---------------------------------------------------------------------------
function mean(a: number[]): number {
  if (a.length === 0) return 0;
  return a.reduce((x, y) => x + y, 0) / a.length;
}

function std(a: number[]): number {
  if (a.length === 0) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) * (v - m))));
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[idx];
}

function sum(a: number[]): number {
  return a.reduce((x, y) => x + y, 0);
}

// 条件风险价值：最差 p 分位以下的均值（输入需升序）
function cvar(sorted: number[], p: number): number {
  const cut = Math.max(1, Math.floor(p * sorted.length));
  return mean(sorted.slice(0, cut));
}

// 最大回撤：输入收益序列，返回最大回撤（负值，越负回撤越深）
function maxDrawdown(series: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = v - peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd;
}

// ---------------------------------------------------------------------------
// 数据加载：读全部 *_1000Experiments.json，过滤退化品种（vol=0）
// ---------------------------------------------------------------------------
interface Variety {
  code: string;
  pnls: number[]; // 1000 次实验的 totalPnl
}

function loadAll(): Variety[] {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('_1000Experiments.json'));
  const out: Variety[] = [];
  for (const f of files) {
    const code = f.replace('_1000Experiments.json', '');
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf-8'));
    const pnls: number[] = (d.fullResults || []).map(
      (r: any) => r.stats?.totalPnl || 0
    );
    // 过滤退化品种：全部收益为 0（策略空转）
    if (pnls.length === 0 || std(pnls) < 1e-9) {
      console.log(`  [skip] ${code} 退化（vol=0），已剔除`);
      continue;
    }
    out.push({ code, pnls });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 皮尔逊相关矩阵（series: 每个品种一条收益序列）
// ---------------------------------------------------------------------------
function corrMatrix(series: number[][]): number[][] {
  const n = series.length;
  const m = series[0]?.length ?? 0;
  const means = series.map(mean);
  const stds = series.map((s) => std(s));
  const corr: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n).fill(0);
    row[i] = 1;
    for (let j = 0; j < i; j++) {
      if (stds[i] < 1e-12 || stds[j] < 1e-12) {
        row[j] = 0;
        continue;
      }
      let cov = 0;
      for (let k = 0; k < m; k++) {
        cov += (series[i][k] - means[i]) * (series[j][k] - means[j]);
      }
      cov /= m;
      row[j] = cov / (stds[i] * stds[j]);
    }
    corr.push(row);
  }
  // 对称填充
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      corr[i][j] = corr[j][i];
    }
  }
  return corr;
}

// ---------------------------------------------------------------------------
// 单次 bootstrap 的一个方案结果
// ---------------------------------------------------------------------------
interface SchemeRun {
  inSharpe: number;
  outARet: number;
  outASharpe: number;
  outBRet: number;
  outBSharpe: number;
  positiveCount: number; // 正权重品种数
  maxWeight: number; // 最大权重
}

const EMPTY_SCHEME = (): SchemeRun => ({
  inSharpe: 0,
  outARet: 0,
  outASharpe: 0,
  outBRet: 0,
  outBSharpe: 0,
  positiveCount: 0,
  maxWeight: 0,
});

// ---------------------------------------------------------------------------
// 单次试验结果：三种方案 + 两个对照基准
// ---------------------------------------------------------------------------
interface TrialResult {
  equalWeight: SchemeRun;
  riskParity: SchemeRun;
  maxSharpe: SchemeRun;
  bestSingle: SchemeRun; // 基准 A：全押训练集夏普最高品种
  momentum: SchemeRun; // 基准 B：动量排序前 10 等权重
}

const EMPTY_TRIAL = (): TrialResult => ({
  equalWeight: EMPTY_SCHEME(),
  riskParity: EMPTY_SCHEME(),
  maxSharpe: EMPTY_SCHEME(),
  bestSingle: EMPTY_SCHEME(),
  momentum: EMPTY_SCHEME(),
});

// ---------------------------------------------------------------------------
// 品种预筛：剔除训练集全体均值为负的品种（与 generateFullAnalysis 一致）
// ---------------------------------------------------------------------------
function prefilter(
  trainSeries: number[][],
  testSeries: number[][]
): { n: number; train: number[][]; test: number[][] } {
  const trainMuAll = trainSeries.map(mean);
  const idx = trainMuAll
    .map((mu, i) => (mu > 0 ? i : -1))
    .filter((i) => i >= 0);
  const useIdx = idx.length >= 2 ? idx : trainSeries.map((_, i) => i);
  return {
    n: useIdx.length,
    train: useIdx.map((i) => trainSeries[i]),
    test: useIdx.map((i) => testSeries[i]),
  };
}

// ---------------------------------------------------------------------------
// 单次 bootstrap 试验：训练集算权重，测试集评估
// ---------------------------------------------------------------------------
function trial(
  n: number,
  trainSeries: number[][],
  testSeries: number[][],
  topK: number,
  maxSharpeOpts?: { restarts?: number; maxIter?: number; lr?: number }
): TrialResult {
  // 训练集统计
  const trainVols = trainSeries.map(std);
  const trainMuTop = trainSeries.map((s) => {
    const sorted = s.slice().sort((a, b2) => b2 - a);
    return mean(sorted.slice(0, topK));
  });
  const trainMuAll = trainSeries.map(mean);
  const trainMu = shrinkMu(trainMuTop, trainMuAll, SHRINK_ALPHA);
  const trainSigma = buildCovariance(corrMatrix(trainSeries), trainVols);

  // 测试集统计（两种口径）
  const testVols = testSeries.map(std);
  const testMuTop = testSeries.map((s) => {
    const sorted = s.slice().sort((a, b2) => b2 - a);
    return mean(sorted.slice(0, topK));
  });
  const testMuAll = testSeries.map(mean);
  const testSigma = buildCovariance(corrMatrix(testSeries), testVols);

  const evaluateScheme = (w: number[]): SchemeRun => {
    const inS = portfolioStats(w, trainMu, trainSigma);
    const outA = portfolioStats(w, testMuTop, testSigma);
    const outB = portfolioStats(w, testMuAll, testSigma);
    let positiveCount = 0;
    let maxWeight = 0;
    for (const wi of w) {
      if (wi > 1e-6) positiveCount++;
      if (wi > maxWeight) maxWeight = wi;
    }
    return {
      inSharpe: inS.sharpe,
      outARet: outA.return,
      outASharpe: outA.sharpe,
      outBRet: outB.return,
      outBSharpe: outB.sharpe,
      positiveCount,
      maxWeight,
    };
  };

  // 三种方案权重（应用约束：单品种上限 + 权重下限 + 最小持仓数；无板块信息，跳过板块约束）
  const { equalWeight: wEqual, riskParity: wRiskParity, maxSharpe: wMaxSharpe } =
    computeThreePortfolios(trainMu, trainSigma, undefined, {
      maxWeight: 0.2,
      minWeight: MIN_WEIGHT,
      minHoldings: MIN_HOLDINGS,
      maxSharpeOpts: maxSharpeOpts ?? {
        restarts: 5,
        maxIter: 600,
        lr: 1e-4,
      },
    });

  // 基准 A：全押训练集夏普最高的品种
  const trainSharpe = trainMuTop.map((mu, i) =>
    trainVols[i] > 1e-9 ? mu / trainVols[i] : -Infinity
  );
  const bestIdx = trainSharpe.indexOf(Math.max(...trainSharpe));
  const wBestSingle = new Array<number>(n).fill(0);
  wBestSingle[bestIdx] = 1;

  // 基准 B：动量排序（按训练集 Top-K 收益降序）前 10 等权重
  const momentumRank = trainMuTop
    .map((mu, i) => ({ mu, i }))
    .sort((a, b) => b.mu - a.mu);
  const wMomentum = new Array<number>(n).fill(0);
  const topN = Math.min(10, n);
  for (let k = 0; k < topN; k++) wMomentum[momentumRank[k].i] = 1 / topN;

  return {
    equalWeight: evaluateScheme(wEqual),
    riskParity: evaluateScheme(wRiskParity),
    maxSharpe: evaluateScheme(wMaxSharpe),
    bestSingle: evaluateScheme(wBestSingle),
    momentum: evaluateScheme(wMomentum),
  };
}

// ---------------------------------------------------------------------------
// 主函数
// ---------------------------------------------------------------------------
function run() {
  const varieties = loadAll();
  const n = varieties.length;
  console.log(`加载 ${n} 个有效品种，开始 ${N_BOOTSTRAP} 次 bootstrap 验证...\n`);

  const rand = mulberry32(20260816);

  // 累计器
  const acc = {
    equalWeight: [] as SchemeRun[],
    riskParity: [] as SchemeRun[],
    maxSharpe: [] as SchemeRun[],
    bestSingle: [] as SchemeRun[],
    momentum: [] as SchemeRun[],
  };

  const topK = Math.max(1, Math.round(TRAIN_SIZE * TOP_RATIO)); // 前 20%

  for (let b = 0; b < N_BOOTSTRAP; b++) {
    // 1. 分割训练/测试
    const trainSeries: number[][] = [];
    const testSeries: number[][] = [];
    for (let i = 0; i < n; i++) {
      const arr = varieties[i].pnls.slice();
      // Fisher-Yates shuffle
      for (let k = arr.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [arr[k], arr[j]] = [arr[j], arr[k]];
      }
      trainSeries.push(arr.slice(0, TRAIN_SIZE));
      testSeries.push(arr.slice(TRAIN_SIZE));
    }

    // 2. 品种预筛 + 单次试验
    const pf = prefilter(trainSeries, testSeries);
    const r = trial(pf.n, pf.train, pf.test, topK);
    acc.equalWeight.push(r.equalWeight);
    acc.riskParity.push(r.riskParity);
    acc.maxSharpe.push(r.maxSharpe);
    acc.bestSingle.push(r.bestSingle);
    acc.momentum.push(r.momentum);

    if ((b + 1) % 200 === 0) {
      console.log(`  已完成 ${b + 1}/${N_BOOTSTRAP} 次...`);
    }
  }

  console.log('\n================ 统计报告 ================\n');
  const names: Array<keyof typeof acc> = [
    'equalWeight',
    'riskParity',
    'maxSharpe',
    'bestSingle',
    'momentum',
  ];
  const nameZh: Record<string, string> = {
    equalWeight: '均衡型（等权重）',
    riskParity: '保守型（风险平价 ERC）',
    maxSharpe: '进取型（最大夏普）',
    bestSingle: '基准A（全押单品种最优）',
    momentum: '基准B（动量排序前10）',
  };

  const oosStats: Record<string, OosStats> = {};
  for (const key of names) {
    const runs = acc[key];
    const stats = computeSchemeStats(runs);
    stats.name = nameZh[key];
    oosStats[key] = stats;
    reportScheme(nameZh[key], runs);
  }

  // 写出样本外稳健性统计，供 portfolio 接口读取并在前端展示
  const oosOutput = {
    generatedAt: new Date().toISOString(),
    nBootstrap: N_BOOTSTRAP,
    trainSize: TRAIN_SIZE,
    topRatio: TOP_RATIO,
    shrinkAlpha: SHRINK_ALPHA,
    schemes: oosStats,
  };
  const oosPath = path.join(DATA_DIR, 'config_oos_stats.json');
  fs.writeFileSync(oosPath, JSON.stringify(oosOutput, null, 2), 'utf-8');
  console.log(`\n✅ 样本外稳健性统计已写入 config_oos_stats.json（${N_BOOTSTRAP} 次 bootstrap）`);
}

// ---------------------------------------------------------------------------
// 结构化样本外统计（供 config_oos_stats.json 输出，前端「样本外稳健性」卡片使用）
// ---------------------------------------------------------------------------
interface OosStats {
  name: string;
  inSharpe: number;
  oosSharpe: number;
  winRate: number; // 样本外正收益概率（%）
  mean: number; // 样本外收益均值（元）
  worst: number; // 最差单次收益（元）
  var95: number; // 5% VaR（元）
  cvar95: number; // 5% CVaR（元）
  overfitDecay: number; // 过拟合衰减 = 样本内夏普 - 样本外夏普
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function computeSchemeStats(runs: SchemeRun[]): OosStats {
  const inSharpe = runs.map((r) => r.inSharpe);
  const outBRet = runs.map((r) => r.outBRet);
  const outBSharpe = runs.map((r) => r.outBSharpe);
  const sortedRet = outBRet.slice().sort((a, b) => a - b);
  const posRate = outBRet.filter((r) => r > 0).length / outBRet.length;
  const inS = mean(inSharpe);
  const oosS = mean(outBSharpe);
  return {
    name: '',
    inSharpe: round2(inS),
    oosSharpe: round2(oosS),
    winRate: round2(posRate * 100),
    mean: round2(mean(outBRet)),
    worst: round2(sortedRet[0] ?? 0),
    var95: round2(percentile(sortedRet, 0.05)),
    cvar95: round2(cvar(sortedRet, 0.05)),
    overfitDecay: round2(inS - oosS),
  };
}

// ---------------------------------------------------------------------------
// 输出单个方案的统计
// ---------------------------------------------------------------------------
function reportScheme(name: string, runs: SchemeRun[]) {
  const inSharpe = runs.map((r) => r.inSharpe).sort((a, b) => a - b);
  const outARet = runs.map((r) => r.outARet).sort((a, b) => a - b);
  const outASharpe = runs.map((r) => r.outASharpe).sort((a, b) => a - b);
  const outBRet = runs.map((r) => r.outBRet).sort((a, b) => a - b);
  const outBSharpe = runs.map((r) => r.outBSharpe).sort((a, b) => a - b);

  const posRateA = runs.filter((r) => r.outARet > 0).length / runs.length;
  const posRateB = runs.filter((r) => r.outBRet > 0).length / runs.length;
  const posSharpeB = runs.filter((r) => r.outBSharpe > 0).length / runs.length;
  const avgPosCount = mean(runs.map((r) => r.positiveCount));
  const avgMaxWeight = mean(runs.map((r) => r.maxWeight));

  const fmt = (v: number) => (Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(2) + '万' : v.toFixed(2));

  console.log(`\n【${name}】`);
  console.log('  --- 收益（口径 A：测试集 Top-K，乐观） ---');
  console.log(`    均值 ${fmt(mean(outARet))}  中位数 ${fmt(percentile(outARet, 0.5))}`);
  console.log(`    标准差 ${fmt(std(outARet))}  正收益概率 ${(posRateA * 100).toFixed(1)}%`);
  console.log(`    5%分位 ${fmt(percentile(outARet, 0.05))}  1%分位 ${fmt(percentile(outARet, 0.01))}`);
  const cvar = (sorted: number[], p: number) => {
    const k = Math.max(1, Math.floor(sorted.length * p));
    return mean(sorted.slice(0, k));
  };

  console.log('  --- 收益（口径 B：测试集全体均值，现实） ---');
  console.log(`    均值 ${fmt(mean(outBRet))}  中位数 ${fmt(percentile(outBRet, 0.5))}`);
  console.log(`    标准差 ${fmt(std(outBRet))}  正收益概率 ${(posRateB * 100).toFixed(1)}%`);
  console.log(`    5%分位(VaR) ${fmt(percentile(outBRet, 0.05))}  1%分位(VaR) ${fmt(percentile(outBRet, 0.01))}`);
  console.log(`    5%条件风险(CVaR) ${fmt(cvar(outBRet, 0.05))}  1%条件风险(CVaR) ${fmt(cvar(outBRet, 0.01))}`);
  console.log(`    最差单次收益 ${fmt(outBRet[0])}`);
  console.log('  --- 夏普 ---');
  console.log(`    样本内均值 ${mean(inSharpe).toFixed(2)}  中位数 ${percentile(inSharpe, 0.5).toFixed(2)}`);
  console.log(`    口径A均值 ${mean(outASharpe).toFixed(2)}  中位数 ${percentile(outASharpe, 0.5).toFixed(2)}`);
  console.log(`    口径B均值 ${mean(outBSharpe).toFixed(2)}  中位数 ${percentile(outBSharpe, 0.5).toFixed(2)}  正夏普概率 ${(posSharpeB * 100).toFixed(1)}%`);
  console.log(`    过拟合衰减（样本内-口径B）: ${(mean(inSharpe) - mean(outBSharpe)).toFixed(2)}`);
  console.log(`  --- 权重集中度 ---`);
  console.log(`    平均正权重品种数 ${avgPosCount.toFixed(1)}  平均最大权重 ${(avgMaxWeight * 100).toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// 敏感性分析
// ---------------------------------------------------------------------------
function runBootstrapSweep(
  varieties: Variety[],
  n: number,
  nBoot: number,
  trainSize: number,
  topRatio: number
) {
  const rand = mulberry32(20260816);
  const acc = {
    equalWeight: [] as number[],
    riskParity: [] as number[],
    maxSharpe: [] as number[],
    bestSingle: [] as number[],
    momentum: [] as number[],
  };
  const topK = Math.max(1, Math.round(trainSize * topRatio));

  for (let b = 0; b < nBoot; b++) {
    const trainSeries: number[][] = [];
    const testSeries: number[][] = [];
    for (let i = 0; i < n; i++) {
      const arr = varieties[i].pnls.slice();
      for (let k = arr.length - 1; k > 0; k--) {
        const j = Math.floor(rand() * (k + 1));
        [arr[k], arr[j]] = [arr[j], arr[k]];
      }
      trainSeries.push(arr.slice(0, trainSize));
      testSeries.push(arr.slice(trainSize));
    }
    const pf = prefilter(trainSeries, testSeries);
    const r = trial(pf.n, pf.train, pf.test, topK, {
      restarts: 3,
      maxIter: 400,
      lr: 1e-4,
    });
    acc.equalWeight.push(r.equalWeight.outBSharpe);
    acc.riskParity.push(r.riskParity.outBSharpe);
    acc.maxSharpe.push(r.maxSharpe.outBSharpe);
    acc.bestSingle.push(r.bestSingle.outBSharpe);
    acc.momentum.push(r.momentum.outBSharpe);
  }

  const avg = (a: number[]) => mean(a);
  return {
    equalWeight: avg(acc.equalWeight),
    riskParity: avg(acc.riskParity),
    maxSharpe: avg(acc.maxSharpe),
    bestSingle: avg(acc.bestSingle),
    momentum: avg(acc.momentum),
  };
}

function runSensitivity() {
  const varieties = loadAll();
  const n = varieties.length;

  console.log('\n\n================ 敏感性分析 ================\n');

  // --- 敏感性 1：bootstrap 次数收敛性（固定 500/500, Top20%）---
  console.log('【敏感性1】bootstrap 次数是否收敛（500训练/500测试, Top20%）');
  console.log('  bootstrap次数 | 均衡型 | 保守型 | 进取型 | 基准A | 基准B');
  for (const nBoot of [200, 500, 1000]) {
    const res = runBootstrapSweep(varieties, n, nBoot, 500, 0.2);
    console.log(
      `  ${String(nBoot).padStart(4)}次      | ${res.equalWeight.toFixed(2)} | ${res.riskParity.toFixed(2)} | ${res.maxSharpe.toFixed(2)} | ${res.bestSingle.toFixed(2)} | ${res.momentum.toFixed(2)}`
    );
  }

  // --- 敏感性 2：训练比例 × Top-K 比例（用 300 次）---
  console.log('\n【敏感性2】训练比例 × Top-K 比例（口径B夏普，300次bootstrap）');
  console.log('  训练样本 | Top-K | 均衡型 | 保守型 | 进取型 | 基准A | 基准B');
  for (const trainSize of [300, 500, 700]) {
    for (const topRatio of [0.05, 0.1, 0.2]) {
      const res = runBootstrapSweep(varieties, n, 300, trainSize, topRatio);
      console.log(
        `  ${trainSize}/1000 | ${(topRatio * 100).toFixed(0).padStart(3)}% | ${res.equalWeight.toFixed(2)} | ${res.riskParity.toFixed(2)} | ${res.maxSharpe.toFixed(2)} | ${res.bestSingle.toFixed(2)} | ${res.momentum.toFixed(2)}`
      );
    }
  }
}

run();
runSensitivity();
