/**
 * 做多定向二次寻优参数（runWeakLongRefine 生成）
 *
 * 仅包含二次寻优后「做多捕获率」优于原参数（或需保留原参数）的弱品种。
 * 结构：{ 品种代码: { stopAtrMult, targetAtrMult, maxHoldDays, cooldownBars, trendFilter, minSignalGrade } }
 * 使用：v16_engine 读取时优先使用 LONG_REFINED_PARAMS[code]，缺失回退 LONG_OPT_PARAMS
 */
export const LONG_REFINED_PARAMS: Record<string, {
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  cooldownBars: number;
  trendFilter: boolean;
  minSignalGrade: string;
}> = {
  'SI0': { stopAtrMult: 1.31, targetAtrMult: 2.14, maxHoldDays: 25, cooldownBars: 3, trendFilter: false, minSignalGrade: 'L1' },
  'SA0': { stopAtrMult: 2.42, targetAtrMult: 2.91, maxHoldDays: 49, cooldownBars: 5, trendFilter: false, minSignalGrade: 'L1' },
  'EG0': { stopAtrMult: 2.33, targetAtrMult: 4.17, maxHoldDays: 49, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' },
  'NR0': { stopAtrMult: 3.09, targetAtrMult: 4.24, maxHoldDays: 48, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
  // LH0 生猪：2026-08 由 runLH1000Backtest 含黑天鹅口径综合 TOP1 更新（2.14/4.44/20/1/L2）
  // 原 1.84/5.82/49 在含黑天鹅下回撤 76.5%（OOS 样本外留存率 -4%，过拟合风险高）
  // 新参数含黑天鹅回撤降至 39.3%，无黑天鹅 286万/胜率75.4%/回撤10.6%
  // 2026-08 二次调整：minSignalGrade L2→L1（1000次实验结论 L1 为收益最优档、L4 为全局第一脆弱点）
  'LH0': { stopAtrMult: 2.14, targetAtrMult: 4.44, maxHoldDays: 20, cooldownBars: 1, trendFilter: false, minSignalGrade: 'L1' },
};
