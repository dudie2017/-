/**
 * 全品种做多最优参数（runAllLongOptimization 生成）
 *
 * 结构：{ 品种代码: { stopAtrMult, targetAtrMult, maxHoldDays, cooldownBars, trendFilter, minSignalGrade } }
 */
export const LONG_OPT_PARAMS: Record<string, {
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  cooldownBars: number;
  trendFilter: boolean;
  minSignalGrade: string;
}> = {
  'A0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'AG0': { stopAtrMult: 1.93, targetAtrMult: 6.92, maxHoldDays: 53, cooldownBars: 6, trendFilter: false, minSignalGrade: 'L1' }, // 白银回测寻优落地(AG0_integrated.optimizedWithCB): 胜率77.7% 回撤47.6%→18.7%; 方案C: L2→L1 +5.8%
  'AL0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'AP0': { stopAtrMult: 1.7, targetAtrMult: 5.72, maxHoldDays: 21, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'AU0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +9.6%
  'BC0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'BU0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'C0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' },
  'CF0': { stopAtrMult: 1.95, targetAtrMult: 4.99, maxHoldDays: 40, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +15.8%
  'CJ0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'CU0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'EB0': { stopAtrMult: 1.95, targetAtrMult: 4.99, maxHoldDays: 40, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L2' },
  'EG0': { stopAtrMult: 2.29, targetAtrMult: 4.43, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L2' },
  'FG0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'FU0': { stopAtrMult: 2.98, targetAtrMult: 3.62, maxHoldDays: 38, cooldownBars: 3, trendFilter: true, minSignalGrade: 'L1' },
  'HC0': { stopAtrMult: 2.72, targetAtrMult: 4.58, maxHoldDays: 37, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'I0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +11.6%
  'IC0': { stopAtrMult: 2.05, targetAtrMult: 2.12, maxHoldDays: 28, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'IF0': { stopAtrMult: 2.89, targetAtrMult: 4.44, maxHoldDays: 32, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'IH0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'IM0': { stopAtrMult: 1.55, targetAtrMult: 5.52, maxHoldDays: 22, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'J0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'JD0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'JM0': { stopAtrMult: 1.55, targetAtrMult: 5.52, maxHoldDays: 22, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'L0': { stopAtrMult: 2.42, targetAtrMult: 3.33, maxHoldDays: 34, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'LH0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'LU0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'M0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'MA0': { stopAtrMult: 1.99, targetAtrMult: 4.31, maxHoldDays: 37, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'NI0': { stopAtrMult: 2.42, targetAtrMult: 3.33, maxHoldDays: 34, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'NR0': { stopAtrMult: 2.48, targetAtrMult: 3.82, maxHoldDays: 39, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'OI0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'P0': { stopAtrMult: 2.89, targetAtrMult: 4.44, maxHoldDays: 32, cooldownBars: 2, trendFilter: false, minSignalGrade: 'L1' },
  'PB0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'PG0': { stopAtrMult: 2.83, targetAtrMult: 2.03, maxHoldDays: 40, cooldownBars: 1, trendFilter: true, minSignalGrade: 'L2' },
  'PP0': { stopAtrMult: 1.02, targetAtrMult: 3.35, maxHoldDays: 40, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'RB0': { stopAtrMult: 2.77, targetAtrMult: 5.45, maxHoldDays: 36, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'RM0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'RU0': { stopAtrMult: 2.85, targetAtrMult: 3.98, maxHoldDays: 39, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +9.0%
  'SA0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'SC0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'SF0': { stopAtrMult: 2.72, targetAtrMult: 4.58, maxHoldDays: 37, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'SI0': { stopAtrMult: 1.48, targetAtrMult: 2.07, maxHoldDays: 22, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L2' },
  'SM0': { stopAtrMult: 1.01, targetAtrMult: 5.46, maxHoldDays: 39, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'SP0': { stopAtrMult: 2.16, targetAtrMult: 2.55, maxHoldDays: 38, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'SR0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'SS0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'T0': { stopAtrMult: 2.69, targetAtrMult: 5.22, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'TA0': { stopAtrMult: 2.63, targetAtrMult: 5.55, maxHoldDays: 38, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' }, // 方案C: L2→L1 +9.7%
  'TF0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'UR0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'V0': { stopAtrMult: 2.47, targetAtrMult: 5.99, maxHoldDays: 38, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  'WR0': { stopAtrMult: 2.77, targetAtrMult: 5.45, maxHoldDays: 36, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
  'Y0': { stopAtrMult: 2.3, targetAtrMult: 5.03, maxHoldDays: 39, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'ZC0': { stopAtrMult: 1.95, targetAtrMult: 4.99, maxHoldDays: 40, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L2' },
  'ZN0': { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' },
};
