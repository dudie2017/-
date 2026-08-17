/**
 * 参数稳健性分析脚本
 * 分析 26 品种的 1000 次 LHS 实验数据
 * 目标：找出跨品种的最优参数区间
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

// 26 个已完成回测的品种
const VARIETIES = [
  'AG0', 'AL0', 'AU0', 'CF0', 'CU0', 'HC0', 'I0', 'IC0', 'IF0', 'IH0',
  'IM0', 'J0', 'JM0', 'LH0', 'M0', 'NI0', 'P0', 'PB0', 'RB0', 'RU0',
  'SC0', 'SI0', 'SP0', 'TA0', 'Y0', 'ZN0'
];

interface ExperimentResult {
  id: number;
  recipe: Record<string, any>;
  stats: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    capture: number;
    longCapture: number;
    shortCapture: number;
  };
}

interface VarietyData {
  code: string;
  experiments: ExperimentResult[];
  baseline: ExperimentResult;
}

// 加载所有品种数据
function loadAllVarieties(): Map<string, VarietyData> {
  const result = new Map<string, VarietyData>();
  
  for (const code of VARIETIES) {
    const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
    if (!fs.existsSync(filePath)) {
      console.warn(`⚠️  ${code} 数据文件不存在，跳过`);
      continue;
    }
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    result.set(code, {
      code,
      experiments: data.fullResults as ExperimentResult[],
      baseline: data.baseline as ExperimentResult,
    });
  }
  
  return result;
}

// 分析单个参数的分布
function analyzeParameter(
  varieties: Map<string, VarietyData>,
  paramName: string
): {
  values: Map<string, { count: number; avgPnl: number; avgPF: number; avgCapture: number }>;
  totalExperiments: number;
} {
  const valueStats = new Map<string, { 
    count: number; 
    totalPnl: number; 
    totalPF: number; 
    totalCapture: number;
  }>();
  
  let totalExperiments = 0;
  
  for (const [, variety] of varieties) {
    for (const exp of variety.experiments) {
      const value = exp.recipe[paramName];
      if (value === undefined) continue;
      
      const key = String(value);
      if (!valueStats.has(key)) {
        valueStats.set(key, { count: 0, totalPnl: 0, totalPF: 0, totalCapture: 0 });
      }
      
      const stats = valueStats.get(key)!;
      stats.count++;
      stats.totalPnl += exp.stats.totalPnl;
      stats.totalPF += exp.stats.profitFactor;
      stats.totalCapture += exp.stats.capture;
      totalExperiments++;
    }
  }
  
  const result = new Map<string, { count: number; avgPnl: number; avgPF: number; avgCapture: number }>();
  for (const [value, stats] of valueStats) {
    result.set(value, {
      count: stats.count,
      avgPnl: stats.totalPnl / stats.count,
      avgPF: stats.totalPF / stats.count,
      avgCapture: stats.totalCapture / stats.count,
    });
  }
  
  return { values: result, totalExperiments };
}

// 找出每个品种的最优实验
function findTopExperiments(
  varieties: Map<string, VarietyData>,
  topN: number = 20
): Map<string, ExperimentResult[]> {
  const result = new Map<string, ExperimentResult[]>();
  
  for (const [code, variety] of varieties) {
    const sorted = [...variety.experiments].sort((a, b) => {
      // 综合评分：收益 40% + 利润因子 30% + 捕获率 30%
      const scoreA = a.stats.totalPnl * 0.4 + a.stats.profitFactor * 10000 * 0.3 + a.stats.capture * 100000 * 0.3;
      const scoreB = b.stats.totalPnl * 0.4 + b.stats.profitFactor * 10000 * 0.3 + b.stats.capture * 100000 * 0.3;
      return scoreB - scoreA;
    });
    
    result.set(code, sorted.slice(0, topN));
  }
  
  return result;
}

// 分析最优实验的参数分布
function analyzeTopParameters(
  topExperiments: Map<string, ExperimentResult[]>,
  paramName: string
): Map<string, number> {
  const valueCount = new Map<string, number>();
  
  for (const [, experiments] of topExperiments) {
    for (const exp of experiments) {
      const value = String(exp.recipe[paramName]);
      valueCount.set(value, (valueCount.get(value) || 0) + 1);
    }
  }
  
  return valueCount;
}

// 主分析函数
function runAnalysis() {
  console.log('🚀 开始参数稳健性分析...\n');
  
  // 1. 加载所有品种数据
  const varieties = loadAllVarieties();
  console.log(`✅ 加载了 ${varieties.size} 个品种的数据\n`);
  
  // 2. 分析关键参数
  const keyParams = [
    'minSignalGrade',
    'trendFilter',
    'stopAtrMult',
    'targetAtrMult',
    'maxHoldDays',
    'directionMode',
    'dataWindow',
    'circuitBreaker',
    'pThreshold',
    'equationMode',
  ];
  
  console.log('=== 参数分布分析 ===\n');
  
  for (const param of keyParams) {
    const { values, totalExperiments } = analyzeParameter(varieties, param);
    
    console.log(`📊 ${param} (${totalExperiments} 次实验):`);
    
    // 按平均收益排序
    const sorted = [...values.entries()].sort((a, b) => b[1].avgPnl - a[1].avgPnl);
    
    for (const [value, stats] of sorted) {
      const pct = ((stats.count / totalExperiments) * 100).toFixed(1);
      console.log(`  ${value.padEnd(12)} | 实验：${stats.count.toString().padStart(5)} (${pct}%) | 平均收益：${stats.avgPnl.toFixed(0).padStart(8)} | PF：${stats.avgPF.toFixed(2)} | 捕获：${(stats.avgCapture * 100).toFixed(1)}%`);
    }
    console.log();
  }
  
  // 3. 找出每个品种的最优实验
  const topExperiments = findTopExperiments(varieties, 20);
  
  console.log('=== 最优实验参数分布 (Top 20 × 26 品种 = 520 次) ===\n');
  
  for (const param of keyParams) {
    const valueCount = analyzeTopParameters(topExperiments, param);
    const total = 26 * 20;
    
    console.log(`🏆 ${param}:`);
    
    const sorted = [...valueCount.entries()].sort((a, b) => b[1] - a[1]);
    
    for (const [value, count] of sorted) {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${value.padEnd(12)} | 出现：${count.toString().padStart(3)} 次 (${pct}%)`);
    }
    console.log();
  }
  
  // 4. 生成稳健参数推荐
  console.log('=== 稳健参数推荐 ===\n');
  
  const recommendations: Record<string, string> = {};
  
  for (const param of keyParams) {
    const valueCount = analyzeTopParameters(topExperiments, param);
    const sorted = [...valueCount.entries()].sort((a, b) => b[1] - a[1]);
    
    if (sorted.length > 0) {
      recommendations[param] = sorted[0][0];
      console.log(`✅ ${param}: ${sorted[0][0]} (${((sorted[0][1] / (26 * 20)) * 100).toFixed(1)}% 品种采用)`);
    }
  }
  
  console.log('\n📋 推荐参数配置:');
  console.log(JSON.stringify(recommendations, null, 2));
  
  // 5. 保存分析结果
  const outputPath = path.join(DATA_DIR, 'parameterRobustnessAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    varietiesCount: varieties.size,
    recommendations,
    parameterAnalysis: keyParams.map(param => {
      const { values } = analyzeParameter(varieties, param);
      const valueCount = analyzeTopParameters(topExperiments, param);
      return {
        param,
        allExperiments: Object.fromEntries(values),
        topExperiments: Object.fromEntries(valueCount),
      };
    }),
  }, null, 2));
  
  console.log(`\n💾 分析结果已保存到：${outputPath}`);
}

// 执行分析
runAnalysis();
