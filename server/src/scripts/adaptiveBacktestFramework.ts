/**
 * 市场状态自适应回测框架
 * 根据市场状态（波动率、趋势）动态调整策略参数
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

// 市场状态定义
export type VolatilityRegime = 'low' | 'medium' | 'high';
export type TrendRegime = 'strong_up' | 'weak_up' | 'neutral' | 'weak_down' | 'strong_down';

export interface MarketRegime {
  code: string;
  date: string;
  volatility: VolatilityRegime;
  trend: TrendRegime;
  atr14: number;
  atr60: number;
  adx: number;
  trendStrength: number; // -1 to 1
}

// 参数配置
export interface StrategyParams {
  minSignalGrade: string;
  trendFilter: boolean;
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  directionMode: string;
  dataWindow: string;
  circuitBreaker: string;
  pThreshold: number;
  equationMode: string;
}

// 市场状态 → 参数映射
export const REGIME_PARAM_MAP: Record<string, Partial<StrategyParams>> = {
  // 高波动 + 强趋势
  'high_strong_up': {
    stopAtrMult: 3,
    targetAtrMult: 5,
    maxHoldDays: 40,
    directionMode: 'split',
  },
  'high_strong_down': {
    stopAtrMult: 3,
    targetAtrMult: 5,
    maxHoldDays: 40,
    directionMode: 'split',
  },
  
  // 高波动 + 中性
  'high_neutral': {
    stopAtrMult: 2,
    targetAtrMult: 3,
    maxHoldDays: 25,
    directionMode: 'both',
    circuitBreaker: '3x10',
  },
  
  // 中波动 + 趋势
  'medium_strong_up': {
    stopAtrMult: 2.5,
    targetAtrMult: 4,
    maxHoldDays: 30,
    directionMode: 'split',
  },
  'medium_strong_down': {
    stopAtrMult: 2.5,
    targetAtrMult: 4,
    maxHoldDays: 30,
    directionMode: 'split',
  },
  
  // 中波动 + 中性
  'medium_neutral': {
    stopAtrMult: 2,
    targetAtrMult: 3,
    maxHoldDays: 25,
    directionMode: 'both',
  },
  
  // 低波动
  'low_strong_up': {
    stopAtrMult: 1.5,
    targetAtrMult: 2,
    maxHoldDays: 20,
    directionMode: 'longOnly',
  },
  'low_strong_down': {
    stopAtrMult: 1.5,
    targetAtrMult: 2,
    maxHoldDays: 20,
    directionMode: 'shortOnly',
  },
  'low_neutral': {
    stopAtrMult: 1.5,
    targetAtrMult: 2,
    maxHoldDays: 15,
    directionMode: 'both',
    minSignalGrade: 'L2',
  },
};

// 默认参数
export const DEFAULT_PARAMS: StrategyParams = {
  minSignalGrade: 'L2',
  trendFilter: false,
  stopAtrMult: 2,
  targetAtrMult: 3,
  maxHoldDays: 25,
  directionMode: 'split',
  dataWindow: 'full',
  circuitBreaker: 'off',
  pThreshold: 0.45,
  equationMode: 'off',
};

// 获取自适应参数
export function getAdaptiveParams(
  regime: MarketRegime
): StrategyParams {
  const key = `${regime.volatility}_${regime.trend}`;
  const adjustments = REGIME_PARAM_MAP[key] || {};
  
  return {
    ...DEFAULT_PARAMS,
    ...adjustments,
  };
}

// 加载实验数据
function loadExperimentData(code: string) {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// 分析市场状态分布
function analyzeRegimeDistribution(code: string) {
  const data = loadExperimentData(code);
  if (!data) return null;
  
  // 这里简化处理，实际应该从 K 线数据计算
  // 使用实验数据中的统计信息推断
  const experiments = data.fullResults;
  const baseline = data.baseline;
  
  // 估算波动率状态（基于 ATR 倍数）
  const avgStopAtr = experiments.reduce((sum: number, e: any) => sum + (e.recipe.stopAtrMult || 2), 0) / experiments.length;
  const avgTargetAtr = experiments.reduce((sum: number, e: any) => sum + (e.recipe.targetAtrMult || 3), 0) / experiments.length;
  
  // 估算趋势状态（基于方向模式）
  const splitCount = experiments.filter((e: any) => e.recipe.directionMode === 'split').length;
  const bothCount = experiments.filter((e: any) => e.recipe.directionMode === 'both').length;
  const longOnlyCount = experiments.filter((e: any) => e.recipe.directionMode === 'longOnly').length;
  const shortOnlyCount = experiments.filter((e: any) => e.recipe.directionMode === 'shortOnly').length;
  
  return {
    code,
    bars: data.meta.bars,
    dateRange: data.meta.dateRange,
    avgStopAtr: avgStopAtr.toFixed(2),
    avgTargetAtr: avgTargetAtr.toFixed(2),
    directionModeDistribution: {
      split: ((splitCount / experiments.length) * 100).toFixed(1) + '%',
      both: ((bothCount / experiments.length) * 100).toFixed(1) + '%',
      longOnly: ((longOnlyCount / experiments.length) * 100).toFixed(1) + '%',
      shortOnly: ((shortOnlyCount / experiments.length) * 100).toFixed(1) + '%',
    },
    baseline: {
      totalPnl: baseline.stats.totalPnl,
      profitFactor: baseline.stats.profitFactor,
      capture: baseline.stats.capture,
      winRate: baseline.stats.winRate,
    },
  };
}

// 主分析函数
export function runAdaptiveAnalysis() {
  console.log('🚀 开始市场状态自适应分析...\n');
  
  const results: any[] = [];
  
  for (const code of VARIETIES) {
    const regime = analyzeRegimeDistribution(code);
    if (regime) {
      results.push(regime);
    }
  }
  
  console.log(`✅ 分析了 ${results.length} 个品种\n`);
  
  // 输出摘要
  console.log('=== 市场状态分布摘要 ===\n');
  
  for (const r of results) {
    console.log(` ${r.code} (${r.bars} bars, ${r.dateRange})`);
    console.log(`  ATR 倍数：止损 ${r.avgStopAtr}x / 目标 ${r.avgTargetAtr}x`);
    console.log(`  方向模式分布：`);
    for (const [mode, pct] of Object.entries(r.directionModeDistribution)) {
      console.log(`    ${mode}: ${pct}`);
    }
    console.log(`  Baseline：收益 ${r.baseline.totalPnl.toFixed(0)} / PF ${r.baseline.profitFactor.toFixed(2)} / 捕获 ${(r.baseline.capture * 100).toFixed(1)}%`);
    console.log();
  }
  
  // 保存结果
  const outputPath = path.join(DATA_DIR, 'marketRegimeAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    varietiesCount: results.length,
    results,
    adaptiveParamMap: REGIME_PARAM_MAP,
  }, null, 2));
  
  console.log(`💾 分析结果已保存到：${outputPath}`);
}

// 仅在直接运行脚本时执行（被路由 import 时不执行）
const isDirectRun = process.argv[1]?.endsWith('adaptiveBacktestFramework.ts');
if (isDirectRun) {
  runAdaptiveAnalysis();
}
