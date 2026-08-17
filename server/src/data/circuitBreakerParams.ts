/**
 * 五方 1000 次回测验证的最优熔断档位
 * - lossStreak: 连续亏损笔数（达到后触发熔断）
 * - pauseBars: 熔断暂停 K 线数（日线级别）
 * - null 表示该品种不启用熔断
 *
 * 依据（五方回测诊断报告 2026-08）：
 * - JM0: 4x15，收益 +13.6%
 * - M0:  4x15，收益 +34%
 * - AG0: 3x10，收益 +24% / 回撤 -40%（生产原 4x10，按回测最优统一为 3x10）
 * - RU0: 3x10，回撤 -40% / 崩溃率最低
 * - LH0: 短样本（5.5年）熔断无益，维持 off
 *
 * 新增（CF0/Y0/J0 十三方 1000 次回测 2026-08）：
 * - CF0: 3x10，深度分析 PF 3.85 最优（4x15 3.67，5x20 3.24），已统一 3x10
 * - Y0:  3x10，均值收益 42.6万 最优（5x20 36.0万，+18%），回撤 3.3% < 4.1%
 * - J0:  3x10，均值收益 171.3万 最优，崩溃率 19.5%，生产即最优档位
 *
 * 新增（P0/TA0/AL0 十六方 1000 次回测 2026-08）：
 * - P0:  3x10，均值收益 51.2万 最优（5x20 41.4万，+24%），崩溃率 20% < 24%
 * - TA0: 3x10，深度分析 PF 5.25 最优（5x20 仅 3.70），已统一 3x10
 * - AL0: 3x10，崩溃率 14% 最低（与 4x15 收益接近，取稳健档）
 *
 * 深度分析统一（2026-09）：3x10 为 15/16 品种 PF 最优，AG0/CU0/RB0/CF0/TA0 熔断统一 3x10
 */
export const CIRCUIT_BREAKER_PARAMS: Record<string, { lossStreak: number; pauseBars: number } | null> = {
  JM0: { lossStreak: 4, pauseBars: 15 },
  M0: { lossStreak: 4, pauseBars: 15 },
  AG0: { lossStreak: 3, pauseBars: 10 },
  RU0: { lossStreak: 3, pauseBars: 10 },
  LH0: null,
  CF0: { lossStreak: 3, pauseBars: 10 },
  Y0: { lossStreak: 3, pauseBars: 10 },
  J0: { lossStreak: 3, pauseBars: 10 },
  P0: { lossStreak: 3, pauseBars: 10 },
  TA0: { lossStreak: 3, pauseBars: 10 },
  AL0: { lossStreak: 3, pauseBars: 10 },
  CU0: { lossStreak: 3, pauseBars: 10 },
  RB0: { lossStreak: 3, pauseBars: 10 },
};

export function getCircuitBreaker(code: string) {
  return CIRCUIT_BREAKER_PARAMS[code] ?? null;
}
