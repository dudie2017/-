/**
 * 做空方向禁用清单（shortDisabledVarieties）
 *
 * 来源：26 品种 1000 次 LHS 实验 TOP1 完整配方的 directionMode 字段。
 * directionMode === 'longOnly' 的品种（TOP1 配方判定只做多）纳入做空禁用。
 *
 * longOnly 品种（禁做空）：
 *   - AG0, AL0, IC0, LH0, NI0, PB0, SC0, Y0
 *
 * 历史备注（旧版为空）：
 *   - 旧版 16 品种做空方向均盈利、过滤后总收益下降，集合为空。
 *   - 本次对齐 TOP1 完整配方后，按 directionMode 重新推导出 8 个 longOnly 品种禁做空。
 *
 * 使用：v16_engine 决策链 / paperTradingService 开仓处统一拦截做空信号。
 */
export const SHORT_DISABLED = new Set<string>(['AG0', 'AL0', 'IC0', 'LH0', 'NI0', 'PB0', 'SC0', 'Y0']);
