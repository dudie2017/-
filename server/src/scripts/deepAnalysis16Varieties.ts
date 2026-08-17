/**
 * 深度分析脚本：16 品种 1000 次实验数据综合分析
 * 分析维度：
 *   A. 参数敏感度分析（每个品种 top 因子 + 跨品种汇总）
 *   B. 品种聚类验证（基于最优参数组合相似性）
 *   C. 熔断参数交叉对比（off / 3x10 / 4x15 / 5x20）
 *   D. 方向模式交叉对比（both / longOnly / shortOnly / split）
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CODES = ['SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0', 'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0'];
const DATA_DIR = path.join(__dirname, '../data');

interface Stats {
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  winRate: number;
  capture: number;
}

interface Recipe {
  minSignalGrade: string;
  trendFilter: boolean;
  cooldownBars: number;
  edgeLookback: number;
  allowRangeTrading: boolean;
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  directionMode: string;
  circuitBreaker: string;
  volReduce: string;
  dailyLossLimit: string;
  [key: string]: string | number | boolean;
}

interface Experiment {
  id: number;
  recipe: Recipe;
  stats: Stats;
}

function loadVariety(code: string): any {
  const file = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ========== A. 参数敏感度分析 ==========
function analyzeSensitivity(code: string, data: any): void {
  const vd = data.varianceDecomposition?.totalPnl;
  if (!vd || vd.length === 0) return;
  const top3 = vd.slice(0, 5);
  console.log(`  ${code}: top5因子 → ${top3.map((d: any) => `${d.dimension}(${(d.explained * 100).toFixed(0)}%/${d.bestValue})`).join(', ')}`);
}

// ========== B. 品种聚类验证 ==========
// 基于 topPnl/topComposite 的配方做特征提取，用 KMeans 聚类
function extractRecipeFeatures(code: string, data: any): number[] {
  // 从 topComposite（综合得分前几名）提取特征
  const tops = data.topComposite?.slice(0, 3) || [];
  if (tops.length === 0) return [];

  // 特征：directionMode, circuitBreaker, volReduce, dailyLossLimit, edgeLookback, stopAtrMult, targetAtrMult, maxHoldDays, minSignalGrade, trendFilter
  const dirModeMap: Record<string, number> = { both: 0, longOnly: 1, shortOnly: 2, split: 3 };
  const cbMap: Record<string, number> = { off: 0, '3x10': 1, '4x15': 2, '5x20': 3 };
  const volMap: Record<string, number> = { off: 0, atr15xHalf: 1, atr2xClear: 2 };
  const dllMap: Record<string, number> = { off: 0, '3pct': 1, '5pct': 2, '8pct': 3 };
  const gradeMap: Record<string, number> = { L1: 0, L2: 1, L3: 2, L4: 3 };

  // 用第一个 top 配方的参数作为聚类特征
  const r = tops[0].recipe;
  return [
    dirModeMap[r.directionMode] ?? 0,
    cbMap[r.circuitBreaker] ?? 0,
    volMap[r.volReduce] ?? 0,
    dllMap[r.dailyLossLimit] ?? 0,
    (r.edgeLookback as number) / 100,
    (r.stopAtrMult as number) / 5,
    (r.targetAtrMult as number) / 6,
    (r.maxHoldDays as number) / 40,
    gradeMap[r.minSignalGrade] ?? 0,
    r.trendFilter ? 1 : 0,
    r.allowRangeTrading ? 1 : 0,
  ];
}

// ========== C. 熔断参数交叉对比 ==========
function analyzeCircuitBreaker(code: string, data: any): void {
  const results = data.fullResults || [];
  if (results.length === 0) return;

  const groups: Record<string, { pnl: number[]; dd: number[]; pf: number[]; count: number }> = {};

  for (const exp of results) {
    const cb = exp.recipe.circuitBreaker;
    if (!groups[cb]) groups[cb] = { pnl: [], dd: [], pf: [], count: 0 };
    groups[cb].pnl.push(exp.stats.totalPnl);
    groups[cb].dd.push(exp.stats.maxDrawdown);
    groups[cb].pf.push(exp.stats.profitFactor);
    groups[cb].count++;
  }

  const keys = ['off', '3x10', '4x15', '5x20'].filter(k => groups[k]);
  const parts = keys.map(k => {
    const g = groups[k];
    const avgPnl = g.pnl.reduce((a, b) => a + b, 0) / g.pnl.length;
    const avgDD = g.dd.reduce((a, b) => a + b, 0) / g.dd.length;
    const avgPF = g.pf.reduce((a, b) => a + b, 0) / g.pf.length;
    const maxPnl = Math.max(...g.pnl);
    return `${k}: avg=${(avgPnl / 10000).toFixed(0)}万 PF=${avgPF.toFixed(2)} dd=${(avgDD * 100).toFixed(1)}% max=${(maxPnl / 10000).toFixed(0)}万`;
  });
  console.log(`  ${code}: ${parts.join(' | ')}`);
}

// ========== D. 方向模式交叉对比 ==========
function analyzeDirectionMode(code: string, data: any): void {
  const results = data.fullResults || [];
  if (results.length === 0) return;

  const groups: Record<string, { pnl: number[]; pf: number[]; dd: number[]; count: number }> = {};

  for (const exp of results) {
    const dm = exp.recipe.directionMode;
    if (!groups[dm]) groups[dm] = { pnl: [], pf: [], dd: [], count: 0 };
    groups[dm].pnl.push(exp.stats.totalPnl);
    groups[dm].pf.push(exp.stats.profitFactor);
    groups[dm].dd.push(exp.stats.maxDrawdown);
    groups[dm].count++;
  }

  const keys = ['both', 'longOnly', 'shortOnly', 'split'].filter(k => groups[k]);
  const parts = keys.map(k => {
    const g = groups[k];
    const avgPnl = g.pnl.reduce((a, b) => a + b, 0) / g.pnl.length;
    const avgPF = g.pf.reduce((a, b) => a + b, 0) / g.pf.length;
    const avgDD = g.dd.reduce((a, b) => a + b, 0) / g.dd.length;
    return `${k}: avg=${(avgPnl / 10000).toFixed(0)}万 PF=${avgPF.toFixed(2)} dd=${(avgDD * 100).toFixed(1)}%`;
  });
  console.log(`  ${code}: ${parts.join(' | ')}`);
}

// ========== B2. KMeans 简单实现 ==========
function kmeans(data: number[][], k: number, maxIter = 50): number[] {
  const n = data.length;
  const dim = data[0].length;

  // 初始化质心（用前 k 个点）
  const centroids: number[][] = data.slice(0, k).map((d) => [...d]);

  let labels: number[] = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    // 分配
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let j = 0; j < k; j++) {
        let dist = 0;
        for (let d = 0; d < dim; d++) {
          dist += (data[i][d] - centroids[j][d]) ** 2;
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = j;
        }
      }
      if (labels[i] !== best) {
        labels[i] = best;
        changed = true;
      }
    }

    // 更新质心
    for (let j = 0; j < k; j++) {
      const members = data.filter((_, i) => labels[i] === j);
      if (members.length === 0) continue;
      for (let d = 0; d < dim; d++) {
        centroids[j][d] = members.reduce((a, b) => a + b[d], 0) / members.length;
      }
    }

    if (!changed) break;
  }

  return labels;
}

// ========== 主程序 ==========
function main(): void {
  console.log('='.repeat(100));
  console.log('深度分析：16 品种 1000 次实验数据');
  console.log('='.repeat(100));

  const allData: Record<string, any> = {};
  for (const code of CODES) {
    const d = loadVariety(code);
    if (d) allData[code] = d;
  }
  const loaded = Object.keys(allData);
  console.log(`已加载 ${loaded.length} 个品种数据\n`);

  // ===== A. 参数敏感度分析 =====
  console.log('─'.repeat(100));
  console.log('【A. 参数敏感度分析】top5 收益解释因子');
  console.log('─'.repeat(100));
  const dimCount: Record<string, number> = {};
  for (const code of loaded) {
    analyzeSensitivity(code, allData[code]);
    const vd = allData[code].varianceDecomposition?.totalPnl || [];
    vd.slice(0, 5).forEach((d: any) => {
      dimCount[d.dimension] = (dimCount[d.dimension] || 0) + 1;
    });
  }
  console.log('\n  top5 因子出现频次（16 品种）:');
  Object.entries(dimCount)
    .sort((a, b) => b[1] - a[1])
    .forEach(([dim, cnt]) => console.log(`    ${dim.padEnd(20)} ${cnt}/16 品种`));

  // ===== B. 品种聚类验证 =====
  console.log('\n' + '─'.repeat(100));
  console.log('【B. 品种聚类验证】基于 top 配方参数的 KMeans 聚类');
  console.log('─'.repeat(100));

  const features: number[][] = [];
  const codesArr: string[] = [];
  for (const code of loaded) {
    const f = extractRecipeFeatures(code, allData[code]);
    if (f.length > 0) {
      features.push(f);
      codesArr.push(code);
    }
  }

  if (features.length > 0) {
    const k = 3;
    const labels = kmeans(features, k);
    console.log(`\n  KMeans(k=${k}) 聚类结果:`);
    const clusters: Record<number, string[]> = {};
    codesArr.forEach((c, i) => {
      if (!clusters[labels[i]]) clusters[labels[i]] = [];
      clusters[labels[i]].push(c);
    });
    for (const [label, members] of Object.entries(clusters)) {
      console.log(`    簇 ${parseInt(label) + 1}: ${members.join(', ')}`);
    }

    // 对照：原分类
    const slowTrend = ['CF0', 'Y0', 'P0', 'M0', 'TA0', 'RU0', 'I0'];
    const highVol = ['J0', 'AL0', 'SC0', 'AG0', 'CU0'];
    const balanced = ['JM0', 'RB0', 'LH0', 'AU0'];
    console.log(`\n  原分类对照:`);
    console.log(`    慢趋势簇(5x20): ${slowTrend.join(', ')}`);
    console.log(`    高波动簇(3x10): ${highVol.join(', ')}`);
    console.log(`    均衡簇(其他):   ${balanced.join(', ')}`);
  }

  // ===== C. 熔断参数交叉对比 =====
  console.log('\n' + '─'.repeat(100));
  console.log('【C. 熔断参数交叉对比】off / 3x10 / 4x15 / 5x20');
  console.log('─'.repeat(100));
  for (const code of loaded) {
    analyzeCircuitBreaker(code, allData[code]);
  }

  // ===== D. 方向模式交叉对比 =====
  console.log('\n' + '─'.repeat(100));
  console.log('【D. 方向模式交叉对比】both / longOnly / shortOnly / split');
  console.log('─'.repeat(100));
  for (const code of loaded) {
    analyzeDirectionMode(code, allData[code]);
  }

  console.log('\n' + '='.repeat(100));
  console.log('深度分析完成');
  console.log('='.repeat(100));
}

main();
