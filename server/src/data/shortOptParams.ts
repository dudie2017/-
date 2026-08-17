// 全品种做空专项寻优结果（自动生成，勿手改）
// 来源: runAllShortOptimization.ts 500组参数寻优, 成功率96.4%
export interface SideParams {
  stopAtrMult?: number;
  targetAtrMult?: number;
  minRR?: number;
  maxHoldDays?: number;
  cooldownBars?: number;
  trendFilter?: boolean;
  minSignalGrade?: string;
}

// 每品种做空最优参数（做多保持App默认）
export const SHORT_OPT_PARAMS: Record<string, SideParams> = {
  'A0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'AG0': { stopAtrMult: 2.94, targetAtrMult: 4.41, maxHoldDays: 44, cooldownBars: 5, trendFilter: true, minSignalGrade: 'L1' }, // 白银回测寻优落地(AG0_integrated.optimizedWithCB); 方案C: L2→L1 +5.8%
  'AL0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'AP0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'AU0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +9.6%
  'BC0': { stopAtrMult: 1.18, targetAtrMult: 5.44, maxHoldDays: 15, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'BU0': { stopAtrMult: 2.9, targetAtrMult: 3.94, maxHoldDays: 31, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'C0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' },
  'CF0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'CJ0': { stopAtrMult: 2.98, targetAtrMult: 3.62, maxHoldDays: 38, cooldownBars: 3, trendFilter: true, minSignalGrade: 'L1' },
  'CU0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'EB0': { stopAtrMult: 1.45, targetAtrMult: 2.3, maxHoldDays: 25, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'EG0': { stopAtrMult: 2.49, targetAtrMult: 3.05, maxHoldDays: 35, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L2' },
  'FG0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'FU0': { stopAtrMult: 2.34, targetAtrMult: 2.68, maxHoldDays: 22, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'HC0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'I0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'IC0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'IF0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'IH0': { stopAtrMult: 2.22, targetAtrMult: 4.36, maxHoldDays: 32, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'IM0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'J0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'JD0': { stopAtrMult: 2.72, targetAtrMult: 4.58, maxHoldDays: 37, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'JM0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'L0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  // LH0 生猪做空：2026-08 由 runLH1000Audit 降级（做空 2026 巨亏 -34.9万、OOS 样本外失效、交易占比78%过度）
  // 门槛提升至 L3 大幅减少空头过度交易，参数用含黑天鹅稳健解
  'LH0': { stopAtrMult: 2.14, targetAtrMult: 4.44, maxHoldDays: 20, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L3' },
  'LU0': { stopAtrMult: 2.77, targetAtrMult: 5.45, maxHoldDays: 36, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'M0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'MA0': { stopAtrMult: 1.8, targetAtrMult: 5.9, maxHoldDays: 33, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'NI0': { stopAtrMult: 1.9, targetAtrMult: 3.54, maxHoldDays: 36, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'NR0': { stopAtrMult: 1.8, targetAtrMult: 2.17, maxHoldDays: 36, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'OI0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'P0': { stopAtrMult: 2.29, targetAtrMult: 4.43, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L2' },
  'PB0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'PG0': { stopAtrMult: 1.77, targetAtrMult: 5.16, maxHoldDays: 21, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L2' },
  'PP0': { stopAtrMult: 2.77, targetAtrMult: 5.45, maxHoldDays: 36, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'RB0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' },
  'RM0': { stopAtrMult: 2.78, targetAtrMult: 2.92, maxHoldDays: 34, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L2' },
  'RU0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +9.0%
  'SA0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'SC0': { stopAtrMult: 2.07, targetAtrMult: 4.49, maxHoldDays: 28, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'SF0': { stopAtrMult: 1.92, targetAtrMult: 3.04, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' },
  'SI0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'SM0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'SP0': { stopAtrMult: 2.16, targetAtrMult: 2.55, maxHoldDays: 38, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'SR0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'SS0': { stopAtrMult: 2.22, targetAtrMult: 4.36, maxHoldDays: 32, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'T0': { stopAtrMult: 2.13, targetAtrMult: 2.98, maxHoldDays: 33, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'TA0': { stopAtrMult: 2.77, targetAtrMult: 5.45, maxHoldDays: 36, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'TF0': { stopAtrMult: 1.88, targetAtrMult: 3.48, maxHoldDays: 36, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'UR0': { stopAtrMult: 2.9, targetAtrMult: 3.94, maxHoldDays: 31, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'V0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'WR0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'Y0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'ZC0': { stopAtrMult: 2.21, targetAtrMult: 2.25, maxHoldDays: 23, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'ZN0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
};

// 汇总统计
export const SHORT_OPT_STATS = { total: 56, successRate: 96.4 };