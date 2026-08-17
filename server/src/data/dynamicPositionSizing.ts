/**
 * 动态仓位管理模块
 *
 * 三种仓位计算方式：
 * 1. Kelly 公式：基于胜率和盈亏比
 * 2. 波动率目标：基于近期 ATR 波动率
 * 3. 相关性惩罚：高相关品种自动降仓
 *
 * 综合仓位 = Kelly × 波动率调整 × 相关性惩罚 × 品种级上限
 */

import { TOP1_UNIFIED_PARAMS } from './top1UnifiedParams.js';

// ===== 1. Kelly 公式仓位 =====

/**
 * Kelly 公式计算最优仓位
 * f* = (p × b - q) / b
 * 其中 p = 胜率, q = 1-p, b = 盈亏比
 *
 * 实际使用半凯利（Half Kelly）降低风险
 */
export function kellyPosition(winRate: number, avgWin: number, avgLoss: number): number {
  if (avgLoss <= 0 || avgWin <= 0) return 0.01; // 默认最小仓位

  const p = winRate;
  const q = 1 - p;
  const b = avgWin / avgLoss; // 盈亏比

  if (b <= 0) return 0.01;

  const kelly = (p * b - q) / b;

  // 半凯利（Half Kelly）降低风险
  const halfKelly = kelly / 2;

  // 限制在 1% ~ 10% 范围
  return Math.max(0.01, Math.min(0.10, halfKelly));
}

// ===== 2. 波动率目标仓位 =====

/**
 * 基于波动率目标调整仓位
 * 目标：组合年化波动率控制在 15%
 *
 * 逻辑：波动率高的品种降仓，波动率低的品种加仓
 */
export function volatilityTargetPosition(
  currentVol: number, // 当前品种年化波动率
  targetVol: number = 0.15, // 组合目标波动率 15%
  basePosition: number = 0.05 // 基础仓位 5%
): number {
  if (currentVol <= 0) return basePosition;

  // 波动率倒数加权
  const volRatio = targetVol / currentVol;

  // 限制调整幅度在 0.5x ~ 2x
  const adjustment = Math.max(0.5, Math.min(2.0, volRatio));

  return basePosition * adjustment;
}

// ===== 3. 相关性惩罚 =====

/**
 * 相关性矩阵（P2 实测数据）
 * 来源：backtest-results/portfolio-risk-2026-08-15T04-32-03.json
 */
export const CORRELATION_MATRIX: Record<string, Record<string, number>> = {
  CF0: { AL0: 0.28, RB0: 0.35, SC0: 0.12, NI0: 0.22 },
  AL0: { CF0: 0.28, RB0: 0.38, SC0: 0.03, NI0: 0.41 },
  RB0: { CF0: 0.35, AL0: 0.38, SC0: 0.15, NI0: 0.32 },
  SC0: { CF0: 0.12, AL0: 0.03, RB0: 0.15, NI0: 0.22 },
  NI0: { CF0: 0.22, AL0: 0.41, RB0: 0.32, SC0: 0.22 },
};

/**
 * 相关性惩罚因子
 *
 * 逻辑：与已持仓品种相关性高的品种降仓
 * - 相关性 < 0.2：无惩罚（1.0）
 * - 相关性 0.2~0.4：轻微惩罚（0.8）
 * - 相关性 > 0.4：显著惩罚（0.6）
 */
export function correlationPenalty(
  code: string,
  heldCodes: string[] // 当前已持仓品种
): number {
  if (heldCodes.length === 0) return 1.0;

  const correlations = CORRELATION_MATRIX[code];
  if (!correlations) return 1.0;

  let maxCorr = 0;
  for (const held of heldCodes) {
    const corr = correlations[held] ?? 0;
    maxCorr = Math.max(maxCorr, Math.abs(corr));
  }

  if (maxCorr < 0.2) return 1.0;
  if (maxCorr < 0.4) return 0.8;
  return 0.6;
}

// ===== 4. 综合仓位计算 =====

export interface PositionInputs {
  code: string;
  winRate: number; // 历史胜率
  avgWin: number; // 平均盈利（元）
  avgLoss: number; // 平均亏损（元）
  currentVol: number; // 当前年化波动率
  heldCodes: string[]; // 当前已持仓品种
}

/**
 * 综合仓位计算
 *
 * 公式：综合仓位 = Kelly × 波动率调整 × 相关性惩罚 × 品种级上限
 *
 * 各因子：
 * - Kelly：基于胜率和盈亏比（Half Kelly）
 * - 波动率调整：基于近期 ATR 波动率
 * - 相关性惩罚：与已持仓品种的相关性
 * - 品种级上限：从 realtimeOptParams 读取
 */
export function calculateDynamicPosition(
  inputs: PositionInputs,
  varietyMaxPosition: number // 品种级最大仓位（从 realtimeOptParams 读取）
): number {
  // 1. Kelly 仓位
  const kelly = kellyPosition(inputs.winRate, inputs.avgWin, inputs.avgLoss);

  // 2. 波动率目标仓位（基础仓位 5%）
  const volTarget = volatilityTargetPosition(inputs.currentVol, 0.15, 0.05);

  // 3. 相关性惩罚
  const corrPenalty = correlationPenalty(inputs.code, inputs.heldCodes);

  // 4. 综合仓位
  let position = kelly * corrPenalty;

  // 5. 与波动率目标仓位取较小值（避免过度集中）
  position = Math.min(position, volTarget);

  // 6. 限制在品种级上限内
  position = Math.min(position, varietyMaxPosition);

  // 7. 限制在 1% ~ 10% 范围
  position = Math.max(0.01, Math.min(0.10, position));

  return position;
}

// ===== 5. 辅助函数：从回测结果计算输入参数 =====

export interface BacktestStats {
  totalTrades: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  annualizedVol: number;
}

/**
 * 从回测交易记录计算动态仓位所需参数
 */
export function extractPositionInputs(trades: Array<{ pnl: number; returnPct: number }>): BacktestStats {
  if (trades.length === 0) {
    return { totalTrades: 0, winRate: 0, avgWin: 0, avgLoss: 0, annualizedVol: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0) / losses.length) : 0;

  // 年化波动率（假设 252 个交易日）
  const returns = trades.map(t => t.returnPct);
  const meanReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualizedVol = dailyVol * Math.sqrt(252);

  return {
    totalTrades: trades.length,
    winRate,
    avgWin,
    avgLoss,
    annualizedVol,
  };
}
