/**
 * 元模型服务
 * 基于 26 品种回测数据训练预测模型，优化品种选择和参数配置
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

// 特征工程
function extractFeatures(exp: ExperimentResult): Record<string, number> {
  const recipe = exp.recipe;
  return {
    // 信号质量
    minSignalGrade: recipe.minSignalGrade === 'L1' ? 1 : recipe.minSignalGrade === 'L2' ? 2 : 3,
    
    // 趋势过滤
    trendFilter: recipe.trendFilter ? 1 : 0,
    
    // 止损/目标 ATR 倍数
    stopAtrMult: parseFloat(recipe.stopAtrMult) || 2,
    targetAtrMult: parseFloat(recipe.targetAtrMult) || 3,
    targetStopRatio: (parseFloat(recipe.targetAtrMult) || 3) / (parseFloat(recipe.stopAtrMult) || 2),
    
    // 持仓周期
    maxHoldDays: parseFloat(recipe.maxHoldDays) || 25,
    
    // 方向模式
    directionMode_split: recipe.directionMode === 'split' ? 1 : 0,
    directionMode_both: recipe.directionMode === 'both' ? 1 : 0,
    directionMode_longOnly: recipe.directionMode === 'longOnly' ? 1 : 0,
    directionMode_shortOnly: recipe.directionMode === 'shortOnly' ? 1 : 0,
    
    // 数据窗口
    dataWindow_full: recipe.dataWindow === 'full' ? 1 : 0,
    dataWindow_front70: recipe.dataWindow === 'front70' ? 1 : 0,
    dataWindow_back70: recipe.dataWindow === 'back70' ? 1 : 0,
    dataWindow_last3y: recipe.dataWindow === 'last3y' ? 1 : 0,
    dataWindow_last2y: recipe.dataWindow === 'last2y' ? 1 : 0,
    
    // 熔断
    circuitBreaker_off: recipe.circuitBreaker === 'off' ? 1 : 0,
    circuitBreaker_3x10: recipe.circuitBreaker === '3x10' ? 1 : 0,
    circuitBreaker_4x15: recipe.circuitBreaker === '4x15' ? 1 : 0,
    circuitBreaker_5x20: recipe.circuitBreaker === '5x20' ? 1 : 0,
    
    // 概率阈值
    pThreshold: parseFloat(recipe.pThreshold) || 0.45,
    
    // 方程模式
    equationMode_off: recipe.equationMode === 'off' ? 1 : 0,
    equationMode_strict: recipe.equationMode === 'strict' ? 1 : 0,
    equationMode_soft: recipe.equationMode === 'soft' ? 1 : 0,
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

// 计算特征重要性（基于相关性）
function calculateFeatureImportance(
  varieties: Map<string, VarietyData>,
  targetField: 'totalPnl' | 'profitFactor' | 'capture' | 'winRate'
): { feature: string; correlation: number }[] {
  const features: string[] = [];
  const values: number[] = [];
  
  for (const [, variety] of varieties) {
    for (const exp of variety.experiments) {
      const feat = extractFeatures(exp);
      const target = exp.stats[targetField];
      
      for (const [key, value] of Object.entries(feat)) {
        if (!features.includes(key)) features.push(key);
        values.push(value);
      }
    }
  }
  
  // 简化计算：使用平均值差异
  const importance: { feature: string; correlation: number }[] = [];
  
  for (const feature of features) {
    let highSum = 0, highCount = 0;
    let lowSum = 0, lowCount = 0;
    
    for (const [, variety] of varieties) {
      for (const exp of variety.experiments) {
        const feat = extractFeatures(exp);
        const target = exp.stats[targetField];
        
        if (feat[feature] > 0.5) {
          highSum += target;
          highCount++;
        } else {
          lowSum += target;
          lowCount++;
        }
      }
    }
    
    const highAvg = highCount > 0 ? highSum / highCount : 0;
    const lowAvg = lowCount > 0 ? lowSum / lowCount : 0;
    const correlation = (highAvg - lowAvg) / (Math.abs(highAvg) + Math.abs(lowAvg) + 1);
    
    importance.push({ feature, correlation });
  }
  
  return importance.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

// 生成品种推荐
function generateVarietyRecommendations(
  varieties: Map<string, VarietyData>
): {
  code: string;
  score: number;
  totalPnl: number;
  profitFactor: number;
  capture: number;
  winRate: number;
  bars: number;
  recommendation: string;
}[] {
  const recommendations: any[] = [];
  
  for (const [code, variety] of varieties) {
    const baseline = variety.baseline.stats;
    
    // 综合评分
    const score = 
      baseline.totalPnl * 0.3 +
      baseline.profitFactor * 100000 * 0.3 +
      baseline.capture * 1000000 * 0.2 +
      baseline.winRate * 100000 * 0.2;
    
    // 推荐等级
    let recommendation = '观望';
    if (score > 500000 && baseline.profitFactor > 1.5) {
      recommendation = '强烈推荐';
    } else if (score > 200000 && baseline.profitFactor > 1.2) {
      recommendation = '推荐';
    } else if (score > 50000 && baseline.profitFactor > 1.0) {
      recommendation = '谨慎参与';
    }
    
    recommendations.push({
      code,
      score,
      totalPnl: baseline.totalPnl,
      profitFactor: baseline.profitFactor,
      capture: baseline.capture,
      winRate: baseline.winRate,
      bars: variety.meta.bars,
      recommendation,
    });
  }
  
  return recommendations.sort((a, b) => b.score - a.score);
}

// 主分析函数
export function runMetaModelAnalysis() {
  console.log('🚀 开始元模型分析...\n');
  
  const varieties = loadAllVarieties();
  console.log(`✅ 加载了 ${varieties.size} 个品种的数据\n`);
  
  // 1. 特征重要性分析
  console.log('=== 特征重要性分析 ===\n');
  
  const targets: Array<'totalPnl' | 'profitFactor' | 'capture' | 'winRate'> = [
    'totalPnl', 'profitFactor', 'capture', 'winRate'
  ];
  
  const featureImportance: Record<string, any> = {};
  
  for (const target of targets) {
    const importance = calculateFeatureImportance(varieties, target);
    featureImportance[target] = importance;
    
    console.log(`📊 对 ${target} 最重要的特征:`);
    for (const item of importance.slice(0, 8)) {
      const direction = item.correlation > 0 ? '+' : '-';
      console.log(`  ${item.feature.padEnd(25)} | ${direction}${(Math.abs(item.correlation) * 100).toFixed(1)}%`);
    }
    console.log();
  }
  
  // 2. 品种推荐
  console.log('=== 品种推荐排名 ===\n');
  
  const recommendations = generateVarietyRecommendations(varieties);
  
  for (const rec of recommendations) {
    const stars = rec.recommendation === '强烈推荐' ? '⭐⭐⭐' : 
                  rec.recommendation === '推荐' ? '⭐⭐' : 
                  rec.recommendation === '谨慎参与' ? '⭐' : '';
    
    console.log(`${stars} ${rec.code.padEnd(6)} | 收益：${rec.totalPnl.toFixed(0).padStart(8)} | PF：${rec.profitFactor.toFixed(2)} | 捕获：${(rec.capture * 100).toFixed(1)}% | ${rec.recommendation}`);
  }
  
  // 3. 保存结果
  const outputPath = path.join(DATA_DIR, 'metaModelAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    varietiesCount: varieties.size,
    featureImportance,
    varietyRecommendations: recommendations,
  }, null, 2));
  
  console.log(`\n💾 分析结果已保存到：${outputPath}`);
}

// 仅在直接运行脚本时执行（被路由 import 时不执行）
const isDirectRun = process.argv[1]?.endsWith('metaModelService.ts');
if (isDirectRun) {
  runMetaModelAnalysis();
}
