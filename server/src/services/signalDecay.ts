/**
 * 信号衰减服务
 * 
 * 信号生成后，其效力会随时间衰减：
 * - 事件驱动型信号：衰减快（事件影响随时间减弱）
 * - 趋势型信号：衰减慢（趋势有持续性）
 * 
 * 衰减公式：effectiveScore = baseScore * exp(-λ * daysSinceSignal)
 * 
 * λ 值（衰减系数）：
 * - 事件驱动：λ = 0.3（3天后效力降至 45%）
 * - 趋势型：λ = 0.1（3天后效力降至 74%）
 * - 区间型：λ = 0.5（3天后效力降至 22%）
 */

import type { V16Row } from './v16_types.js';

// 衰减系数
const DECAY_LAMBDA: Record<string, number> = {
  '强趋势': 0.08,
  '通道': 0.12,
  '弱趋势': 0.15,
  '区间震荡': 0.25,
  '高波动': 0.35,
};

// 默认衰减系数
const DEFAULT_LAMBDA = 0.15;

export interface SignalDecayResult {
  /** 原始信号分数 */
  baseScore: number;
  /** 衰减后有效分数 */
  effectiveScore: number;
  /** 衰减系数 λ */
  lambda: number;
  /** 信号生成至今的天数 */
  daysSinceSignal: number;
  /** 衰减半衰期（天） */
  halfLife: number;
  /** 效力百分比 */
  effectivenessPct: number;
  /** 衰减等级 */
  decayLevel: 'fresh' | 'aging' | 'decayed' | 'expired';
  /** 建议 */
  suggestion: string;
}

/**
 * 计算信号衰减值
 * 
 * @param baseScore 原始信号分数（0-100）
 * @param daysSinceSignal 信号生成至今的天数
 * @param marketContext 市场环境（影响衰减速度）
 */
export function calcSignalDecay(
  baseScore: number,
  daysSinceSignal: number,
  marketContext?: string,
): SignalDecayResult {
  const lambda = DECAY_LAMBDA[marketContext || ''] ?? DEFAULT_LAMBDA;
  const decayFactor = Math.exp(-lambda * daysSinceSignal);
  const effectiveScore = baseScore * decayFactor;
  const halfLife = Math.log(2) / lambda;
  const effectivenessPct = decayFactor * 100;

  let decayLevel: 'fresh' | 'aging' | 'decayed' | 'expired';
  let suggestion: string;

  if (effectivenessPct >= 80) {
    decayLevel = 'fresh';
    suggestion = '信号效力充足，可以正常参考';
  } else if (effectivenessPct >= 50) {
    decayLevel = 'aging';
    suggestion = '信号开始衰减，建议降低仓位或等待确认';
  } else if (effectivenessPct >= 20) {
    decayLevel = 'decayed';
    suggestion = '信号大幅衰减，仅作为参考，不建议新开仓';
  } else {
    decayLevel = 'expired';
    suggestion = '信号已失效，请等待新信号';
  }

  return {
    baseScore: Math.round(baseScore * 100) / 100,
    effectiveScore: Math.round(effectiveScore * 100) / 100,
    lambda,
    daysSinceSignal: Math.round(daysSinceSignal * 10) / 10,
    halfLife: Math.round(halfLife * 10) / 10,
    effectivenessPct: Math.round(effectivenessPct * 10) / 10,
    decayLevel,
    suggestion,
  };
}

/**
 * 为 V16Row 附加信号衰减信息
 * 基于数据新鲜度字段估算信号天数
 */
export function applySignalDecay(row: V16Row): SignalDecayResult | null {
  // 估算信号天数
  let daysSinceSignal = 0;

  if (row.data_freshness === 'realtime') {
    daysSinceSignal = 0;
  } else if (row.data_freshness === 'cached') {
    daysSinceSignal = 0.5; // 缓存数据假设半天前
  } else if (row.data_freshness === 'stale') {
    daysSinceSignal = 2; // 过期数据假设2天前
  } else {
    daysSinceSignal = 1;
  }

  // 信号分数：P(顺) × 100 作为基础分
  const baseScore = (row.p_follow || 0) * 100;
  if (baseScore <= 0) return null;

  return calcSignalDecay(baseScore, daysSinceSignal, row.market_context);
}

/**
 * 批量计算信号衰减
 */
export function applyDecayToRows(rows: V16Row[]): Map<string, SignalDecayResult> {
  const results = new Map<string, SignalDecayResult>();
  for (const row of rows) {
    const decay = applySignalDecay(row);
    if (decay) {
      results.set(row.code, decay);
    }
  }
  return results;
}
