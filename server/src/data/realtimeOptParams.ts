/**
 * 实时交易引擎优化参数（26 品种，IH0 剔除）
 *
 * 来源：26 品种 1000 次 LHS 实验 topComposite[0]（TOP1 完整配方，2026-08-15 对齐）
 * 生效字段：maxPositionPct / volReduce / dailyLossLimit / circuitBreaker / validationStatus / robustPct
 * 对齐规则：
 *   - volReduce / dailyLossLimit / circuitBreaker 直接取自 TOP1 完整配方
 *   - maxPositionPct 基于 P2 组合风控 + P3 参数敏感性 + P4 费率压力测试综合调整
 *   - robustPct 取自 1000 次 LHS 实验中「稳健盈利」的比例（topComposite.robustPct）
 *   - IH0 保持剔除（TOP1 回测亦为亏损 -4750）
 *
 * P0-P4 验证状态（2026-08-15）：
 *   - RB0: ✅ 全链路通过（P1稳健 + P3铁底23/23 + P4费率/滑点全部通过）→ maxPositionPct 0.05
 *   - SC0: ✅ 全链路通过（P1稳健 + P3稳健22/23 + P4全部通过）→ maxPositionPct 0.05
 *   - CF0: ⚠️ 敏感但安全（P1稳健 + P3敏感16/23 + P4全部通过）→ maxPositionPct 0.04（降仓）
 *   - NI0: ⚠️ 敏感但安全（P1稳健 + P3敏感17/23 + P4全部通过）→ maxPositionPct 0.03（降仓）
 *   - AL0: ❌ 过拟合（P3 minSignalGrade过拟合）→ maxPositionPct 0.02（最低仓位观察）
 *   - IM0: ❌ 过拟合（P3 minSignalGrade过拟合）→ maxPositionPct 0.02（最低仓位观察）
 *   - 其余品种：未通过P1 Walk-forward验证，保持默认仓位
 */

export interface RealtimeOptParams {
  /** 品种级最大仓位比例（基于P2/P3/P4综合调整） */
  maxPositionPct: number;
  /** 波动率过滤模式 */
  volReduce: 'atr2xClear' | 'atr15xHalf' | 'off';
  /** 日亏损熔断 */
  dailyLossLimit: '5pct' | '8pct' | 'off';
  /** 品种级熔断（连续亏损 N 次暂停 M 天） */
  circuitBreaker: { lossStreak: number; pauseDays: number } | null;
  /** P0-P4 验证状态 */
  validationStatus: 'iron_clad' | 'robust' | 'sensitive' | 'overfit' | 'untested';
  /** 验证备注 */
  validationNote?: string;
  /** 1000 次 LHS 实验中「稳健盈利」的比例（0-100，越高越稳健） */
  robustPct: number;
  /** 样本可信度：high=100笔以上，medium=30-100笔，low=30笔以下（不足样本稳健性存疑） */
  sampleReliability: 'high' | 'medium' | 'low';
}

export const REALTIME_OPT_PARAMS: Record<string, RealtimeOptParams> = {
  // ===== P0-P4 全链路验证品种 =====
  RB0: { maxPositionPct: 0.05, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: null, validationStatus: 'iron_clad', validationNote: 'P1稳健+P3铁底23/23+P4全通过', robustPct: 37.9, sampleReliability: 'high' },
  SC0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'robust', validationNote: 'P1稳健+P3稳健22/23+P4全通过', robustPct: 8.2, sampleReliability: 'medium' },
  CF0: { maxPositionPct: 0.04, volReduce: 'off', dailyLossLimit: '5pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'sensitive', validationNote: 'P1稳健+P3敏感16/23(trendFilter)+P4全通过', robustPct: 63.5, sampleReliability: 'high' },
  NI0: { maxPositionPct: 0.03, volReduce: 'off', dailyLossLimit: '5pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'sensitive', validationNote: 'P1稳健+P3敏感17/23(trendFilter)+P4全通过', robustPct: 8.2, sampleReliability: 'medium' },
  // ===== 品种扩展测试新增稳健品种 =====
  M0: { maxPositionPct: 0.04, volReduce: 'off', dailyLossLimit: '8pct', circuitBreaker: null, validationStatus: 'robust', validationNote: 'TOP3配方 Walk-forward 4/5段盈利 +158.2万', robustPct: 11.8, sampleReliability: 'high' },
  AL0: { maxPositionPct: 0.03, volReduce: 'atr15xHalf', dailyLossLimit: 'off', circuitBreaker: null, validationStatus: 'robust', validationNote: 'TOP1配方 Walk-forward 4/5段盈利 +31.2万', robustPct: 15.0, sampleReliability: 'high' },
  IM0: { maxPositionPct: 0.04, volReduce: 'atr15xHalf', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'robust', validationNote: 'TOP1配方 Walk-forward 4/5段盈利 +89.4万', robustPct: 29.5, sampleReliability: 'medium' },
  // ===== 未通过P1 Walk-forward验证品种 =====
  AG0: { maxPositionPct: 0.05, volReduce: 'off', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 57.6, sampleReliability: 'low' },
  AU0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 52.1, sampleReliability: 'medium' },
  CU0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: 'off', circuitBreaker: null, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 65.1, sampleReliability: 'high' },
  HC0: { maxPositionPct: 0.05, volReduce: 'off', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 39.3, sampleReliability: 'high' },
  I0: { maxPositionPct: 0.03, volReduce: 'off', dailyLossLimit: '5pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 11.8, sampleReliability: 'medium' },
  IC0: { maxPositionPct: 0.05, volReduce: 'atr15xHalf', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 27.5, sampleReliability: 'medium' },
  IF0: { maxPositionPct: 0.05, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 21.1, sampleReliability: 'high' },
  J0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 29.4, sampleReliability: 'high' },
  JM0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 39.6, sampleReliability: 'medium' },
  LH0: { maxPositionPct: 0.05, volReduce: 'atr15xHalf', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 25.9, sampleReliability: 'low' },
  P0: { maxPositionPct: 0.03, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: null, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 26.4, sampleReliability: 'high' },
  PB0: { maxPositionPct: 0.02, volReduce: 'atr15xHalf', dailyLossLimit: '5pct', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 11.6, sampleReliability: 'medium' },
  RU0: { maxPositionPct: 0.05, volReduce: 'off', dailyLossLimit: '5pct', circuitBreaker: null, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 53.8, sampleReliability: 'high' },
  SI0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 61.9, sampleReliability: 'medium' },
  SP0: { maxPositionPct: 0.02, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 5, pauseDays: 20 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 20.0, sampleReliability: 'medium' },
  TA0: { maxPositionPct: 0.05, volReduce: 'atr2xClear', dailyLossLimit: '8pct', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 28.1, sampleReliability: 'high' },
  Y0: { maxPositionPct: 0.03, volReduce: 'atr15xHalf', dailyLossLimit: 'off', circuitBreaker: { lossStreak: 3, pauseDays: 10 }, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 24.0, sampleReliability: 'high' },
  ZN0: { maxPositionPct: 0.05, volReduce: 'atr15xHalf', dailyLossLimit: 'off', circuitBreaker: null, validationStatus: 'untested', validationNote: 'P1脆弱', robustPct: 17.8, sampleReliability: 'high' },
  // IH0 上证50：TOP1 回测亦为亏损（-4750，PF 0.37，3笔），已剔除
};

export function getRealtimeOptParams(code: string): RealtimeOptParams | null {
  return REALTIME_OPT_PARAMS[code] ?? null;
}
