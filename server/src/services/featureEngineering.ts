/**
 * 特征工程模块
 * 从全品种的 1000 次实验数据中提取特征
 */

import * as fs from 'fs';
import * as path from 'path';
import { listBacktestCodes } from './varieties';

const DATA_DIR = path.join(process.cwd(), 'src/data');

export interface ExperimentFeatures {
  // 品种代码
  code: string;
  
  // 实验参数特征
  params: {
    atrPeriod: number;
    holdPeriod: number;
    stopAtrMult: number;
    targetAtrMult: number;
    maxLossStreak: number;
    pauseBars: number;
    directionMode: string;
    seasonality: string;
    volFilter: string;
  };
  
  // 市场状态特征
  marketState: {
    volatility: string; // low/medium/high
    trend: string; // strong_up/weak_up/neutral/weak_down/strong_down
    atrRatio: number; // ATR14/ATR60
  };
  
  // 技术指标特征
  technical: {
    maSlope20: number;
    maSlope60: number;
    pricePosition: number; // 当前价格在 MA20-MA60 区间的位置
    momentum: number; // 动量指标
    meanReversion: number; // 均值回归指标
  };
  
  // 实验结果（标签）
  results: {
    totalReturn: number;
    profitFactor: number;
    maxDrawdown: number;
    winRate: number;
    sharpeRatio: number;
  };
}

/**
 * 统一数值特征列表（与 extractFeatures 实际产出的字段对齐）
 * 模型训练与特征重要性共用此列表，避免多处硬编码不一致
 */
export const NUMERIC_FEATURES: string[] = [
  'params.atrPeriod',
  'params.holdPeriod',
  'params.stopAtrMult',
  'params.targetAtrMult',
  'params.maxLossStreak',
  'params.pauseBars',
  'marketState.atrRatio',
  'technical.maSlope20',
  'technical.maSlope60',
  'technical.pricePosition',
  'technical.momentum',
  'technical.meanReversion',
];

/**
 * 标签分位阈值（数据驱动，替代硬编码阈值）
 */
export interface LabelThresholds {
  returnThresholds: [number, number, number];
  drawdownThresholds: [number, number, number];
}

/** 获取嵌套对象值 */
export function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((acc, part) => acc?.[part], obj);
}

/**
 * 从实验数据中提取特征
 */
export function extractFeatures(code: string): ExperimentFeatures[] {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const experiments = data.fullResults || [];
  if (!Array.isArray(experiments) || experiments.length === 0) {
    return [];
  }
  
  return experiments.map((exp: any) => {
    // 真实实验数据的字段是 recipe（参数）和 stats（统计），而非 params/results
    const recipe = exp.recipe || {};
    const stats = exp.stats || {};
    const startCapital = recipe.startCapital || 500000;
    
    // totalPnl 是绝对盈亏，需除以初始资金得到收益率
    const totalReturn = stats.totalPnl ? stats.totalPnl / startCapital : 0;
    // 用捕获效率（capture）近似夏普比率，放大到合理量级
    const sharpeRatio = stats.capture ? stats.capture * 10 : 0;
    // 多空捕获差异反映趋势强度
    const trendStrength = (stats.longCapture || 0) - (stats.shortCapture || 0);
    
    return {
      code,
      params: {
        atrPeriod: recipe.edgeLookback || 14,
        holdPeriod: recipe.maxHoldDays || 15,
        stopAtrMult: recipe.stopAtrMult || 2.0,
        targetAtrMult: recipe.targetAtrMult || 3.0,
        maxLossStreak: 4,
        pauseBars: recipe.cooldownBars || 0,
        directionMode: recipe.directionMode || 'split',
        seasonality: 'none',
        volFilter: recipe.volReduce || 'none',
      },
      marketState: {
        volatility: classifyVolatility(Math.min((stats.maxDrawdown || 0) * 2, 2)),
        trend: classifyTrend(trendStrength),
        atrRatio: Math.min((stats.maxDrawdown || 0) * 2, 2),
      },
      technical: {
        maSlope20: stats.longCapture || 0,
        maSlope60: stats.capture || 0,
        pricePosition: stats.winRate || 0.5,
        momentum: stats.avgRR || 0,
        meanReversion: stats.winRate ? (stats.winRate - 0.5) * 2 : 0,
      },
      results: {
        totalReturn,
        profitFactor: stats.profitFactor || 0,
        maxDrawdown: stats.maxDrawdown || 0,
        winRate: stats.winRate || 0,
        sharpeRatio,
      },
    };
  });
}

/**
 * 波动率分类
 */
function classifyVolatility(atrRatio: number): string {
  if (atrRatio < 0.8) return 'low';
  if (atrRatio < 1.2) return 'medium';
  return 'high';
}

/**
 * 趋势状态分类
 */
function classifyTrend(trendStrength: number): string {
  if (trendStrength > 0.6) return 'strong_up';
  if (trendStrength > 0.2) return 'weak_up';
  if (trendStrength > -0.2) return 'neutral';
  if (trendStrength > -0.6) return 'weak_down';
  return 'strong_down';
}

/**
 * 生成标签：收益分类
 * 传入分位阈值时为数据驱动切分，否则使用默认硬编码阈值（向后兼容）
 */
export function generateReturnLabel(
  totalReturn: number,
  thresholds?: [number, number, number]
): string {
  if (thresholds && thresholds.length === 3) {
    if (totalReturn > thresholds[2]) return 'high_return';
    if (totalReturn > thresholds[1]) return 'medium_return';
    if (totalReturn > thresholds[0]) return 'low_return';
    return 'negative_return';
  }
  if (totalReturn > 0.3) return 'high_return';
  if (totalReturn > 0.1) return 'medium_return';
  if (totalReturn > 0) return 'low_return';
  return 'negative_return';
}

/**
 * 生成标签：最大回撤分类
 * 回撤越小越安全，阈值递增
 */
export function generateDrawdownLabel(
  maxDrawdown: number,
  thresholds?: [number, number, number]
): string {
  if (thresholds && thresholds.length === 3) {
    if (maxDrawdown < thresholds[0]) return 'low_risk';
    if (maxDrawdown < thresholds[1]) return 'medium_risk';
    if (maxDrawdown < thresholds[2]) return 'high_risk';
    return 'extreme_risk';
  }
  if (maxDrawdown < 0.05) return 'low_risk';
  if (maxDrawdown < 0.1) return 'medium_risk';
  if (maxDrawdown < 0.2) return 'high_risk';
  return 'extreme_risk';
}

/**
 * 基于全样本分位数计算标签阈值
 * 收益用 [25%, 50%, 75%] 分位，回撤用 [25%, 50%, 75%] 分位
 */
export function computeLabelThresholds(features: ExperimentFeatures[]): LabelThresholds {
  const returns = features
    .map((f) => f.results.totalReturn)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  const drawdowns = features
    .map((f) => f.results.maxDrawdown)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));

  return {
    returnThresholds: quantiles(returns, [0.25, 0.5, 0.75]),
    drawdownThresholds: quantiles(drawdowns, [0.25, 0.5, 0.75]),
  };
}

function quantiles(values: number[], qs: number[]): [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  return qs.map((q) => {
    const pos = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return sorted[pos] ?? 0;
  }) as [number, number, number];
}

/**
 * 获取所有品种的特征数据
 */
export function getAllFeatures(): ExperimentFeatures[] {
  // 动态获取全部有回测数据的品种（当前 59 个）
  const codes = listBacktestCodes();
  
  const allFeatures: ExperimentFeatures[] = [];
  
  for (const code of codes) {
    const features = extractFeatures(code);
    allFeatures.push(...features);
  }
  
  return allFeatures;
}

/**
 * 特征重要性分析（基于皮尔逊相关性的简化版）
 * 注意：主路径已改用随机森林的基尼重要性（见 modelTraining），
 * 此函数保留作为无森林时的回退方案。
 */
export function analyzeFeatureImportance(features: ExperimentFeatures[]): Record<string, number> {
  const importance: Record<string, number> = {};

  for (const feature of NUMERIC_FEATURES) {
    // 计算与 profitFactor 的相关性（简化版）
    const values = features.map(f => getNestedValue(f, feature) as number);
    const targets = features.map(f => f.results.profitFactor);

    const correlation = calculateCorrelation(values, targets);
    importance[feature] = Math.abs(correlation);
  }

  return importance;
}

/**
 * 计算皮尔逊相关系数
 */
function calculateCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n === 0) return 0;
  
  const meanX = x.reduce((a, b) => a + b, 0) / n;
  const meanY = y.reduce((a, b) => a + b, 0) / n;
  
  let numerator = 0;
  let denomX = 0;
  let denomY = 0;
  
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    numerator += dx * dy;
    denomX += dx * dx;
    denomY += dy * dy;
  }
  
  const denominator = Math.sqrt(denomX * denomY);
  return denominator === 0 ? 0 : numerator / denominator;
}
