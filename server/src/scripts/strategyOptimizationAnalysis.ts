/**
 * 市场状态分析（基于实验数据）
 * 从 1000 次实验结果中分析参数与市场状态的关系
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

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
  meta: {
    bars: number;
    dateRange: string;
    theoLong: number;
    theoShort: number;
  };
}

// 加载所有品种数据
function loadAllVarieties(): Map<string, VarietyData> {
  const result = new Map<string, VarietyData>();
  
  for (const code of VARIETIES) {
    const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
    if (!fs.existsSync(filePath)) continue;
    
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    result.set(code, {
      code,
      experiments: data.fullResults as ExperimentResult[],
      baseline: data.baseline as ExperimentResult,
      meta: data.meta,
    });
  }
  
  return result;
}

// 分析参数与收益的关系
function analyzeParameterPerformance(
  varieties: Map<string, VarietyData>,
  paramName: string
): {
  value: string;
  avgPnl: number;
  avgPF: number;
  avgCapture: number;
  avgWinRate: number;
  count: number;
}[] {
  const valueStats = new Map<string, { 
    count: number; 
    totalPnl: number; 
    totalPF: number; 
    totalCapture: number;
    totalWinRate: number;
  }>();
  
  for (const [, variety] of varieties) {
    for (const exp of variety.experiments) {
      const value = String(exp.recipe[paramName]);
      if (!valueStats.has(value)) {
        valueStats.set(value, { count: 0, totalPnl: 0, totalPF: 0, totalCapture: 0, totalWinRate: 0 });
      }
      
      const stats = valueStats.get(value)!;
      stats.count++;
      stats.totalPnl += exp.stats.totalPnl;
      stats.totalPF += exp.stats.profitFactor;
      stats.totalCapture += exp.stats.capture;
      stats.totalWinRate += exp.stats.winRate;
    }
  }
  
  const result: { value: string; avgPnl: number; avgPF: number; avgCapture: number; avgWinRate: number; count: number }[] = [];
  
  for (const [value, stats] of valueStats) {
    result.push({
      value,
      avgPnl: stats.totalPnl / stats.count,
      avgPF: stats.totalPF / stats.count,
      avgCapture: stats.totalCapture / stats.count,
      avgWinRate: stats.totalWinRate / stats.count,
      count: stats.count,
    });
  }
  
  return result.sort((a, b) => b.avgPnl - a.avgPnl);
}

// 找出每个品种的最优参数
function findOptimalParameters(
  varieties: Map<string, VarietyData>,
  topN: number = 20
): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  
  for (const [code, variety] of varieties) {
    const sorted = [...variety.experiments].sort((a, b) => {
      const scoreA = a.stats.totalPnl * 0.4 + a.stats.profitFactor * 10000 * 0.3 + a.stats.capture * 100000 * 0.3;
      const scoreB = b.stats.totalPnl * 0.4 + b.stats.profitFactor * 10000 * 0.3 + b.stats.capture * 100000 * 0.3;
      return scoreB - scoreA;
    });
    
    const topExperiments = sorted.slice(0, topN);
    const paramCounts: Record<string, Record<string, number>> = {};
    
    for (const exp of topExperiments) {
      for (const [key, value] of Object.entries(exp.recipe)) {
        if (!paramCounts[key]) paramCounts[key] = {};
        const v = String(value);
        paramCounts[key][v] = (paramCounts[key][v] || 0) + 1;
      }
    }
    
    const optimal: Record<string, string> = {};
    for (const [key, counts] of Object.entries(paramCounts)) {
      const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      optimal[key] = sorted[0][0];
    }
    
    result.set(code, optimal);
  }
  
  return result;
}

// 主分析函数
export function runAnalysis() {
  console.log('🚀 开始市场状态与参数分析...\n');
  
  const varieties = loadAllVarieties();
  console.log(`✅ 加载了 ${varieties.size} 个品种的数据\n`);
  
  // 1. 分析关键参数的表现
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
  
  console.log('=== 参数表现分析（按平均收益排序）===\n');
  
  const paramAnalysis: Record<string, any> = {};
  
  for (const param of keyParams) {
    const analysis = analyzeParameterPerformance(varieties, param);
    paramAnalysis[param] = analysis;
    
    console.log(`📊 ${param}:`);
    for (const item of analysis.slice(0, 5)) {
      const pct = ((item.count / (varieties.size * 1001)) * 100).toFixed(1);
      console.log(`  ${item.value.padEnd(12)} | 收益：${item.avgPnl.toFixed(0).padStart(8)} | PF：${item.avgPF.toFixed(2)} | 捕获：${(item.avgCapture * 100).toFixed(1)}% | 胜率：${(item.avgWinRate * 100).toFixed(1)}%`);
    }
    console.log();
  }
  
  // 2. 找出每个品种的最优参数
  const optimalParams = findOptimalParameters(varieties, 20);
  
  console.log('=== 各品种最优参数 ===\n');
  
  const paramFrequency: Record<string, Record<string, number>> = {};
  
  for (const [code, params] of optimalParams) {
    console.log(`🏆 ${code}:`);
    for (const [key, value] of Object.entries(params)) {
      if (keyParams.includes(key)) {
        console.log(`  ${key}: ${value}`);
        if (!paramFrequency[key]) paramFrequency[key] = {};
        paramFrequency[key][value] = (paramFrequency[key][value] || 0) + 1;
      }
    }
    console.log();
  }
  
  // 3. 计算参数频率
  console.log('=== 最优参数频率统计 ===\n');
  
  const recommendations: Record<string, string> = {};
  
  for (const [param, counts] of Object.entries(paramFrequency)) {
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const total = varieties.size;
    
    console.log(` ${param}:`);
    for (const [value, count] of sorted) {
      const pct = ((count / total) * 100).toFixed(1);
      console.log(`  ${value.padEnd(12)} | ${count.toString().padStart(2)} 品种 (${pct}%)`);
    }
    
    if (sorted.length > 0) {
      recommendations[param] = sorted[0][0];
    }
    console.log();
  }
  
  // 4. 保存结果
  const outputPath = path.join(DATA_DIR, 'strategyOptimizationAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    varietiesCount: varieties.size,
    recommendations,
    paramAnalysis,
    paramFrequency,
  }, null, 2));
  
  console.log(`💾 分析结果已保存到：${outputPath}`);
}

// 仅在直接运行脚本时执行（被路由 import 时不执行）
const isDirectRun = process.argv[1]?.endsWith('strategyOptimizationAnalysis.ts');
if (isDirectRun) {
  runAnalysis();
}
