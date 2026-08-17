/**
 * 做多方向禁用清单（longDisabledVarieties）
 *
 * 来源：26 品种 1000 次 LHS 实验 TOP1 完整配方的 directionMode 字段。
 * directionMode === 'shortOnly' 的品种（TOP1 配方判定只做空）纳入做多禁用。
 *
 * shortOnly 品种（禁做多）：
 *   - I0, IH0, J0, M0, RB0, SP0, TA0
 *
 * 历史备注（旧版方向捕获率砍腿已废弃）：
 *   - 旧版 SI0 因做多 20 年仅 5 笔 PF 0.44 被砍多；但 TOP1 配方判定 SI0 为 both（双向），
 *     且 1000 次实验 TOP1 回测做多+做空共 19 笔、PF 17.5，故本次对齐 TOP1 后移除 SI0 的做多禁用。
 *
 * 使用：v16_engine 决策链 / paperTradingService 开仓处统一拦截做多信号。
 */
export const LONG_DISABLED = new Set<string>(['I0', 'IH0', 'J0', 'M0', 'RB0', 'SP0', 'TA0']);
