/**
 * 重新生成 realtimeOptParams.ts（对齐最新 topComposite[0] TOP1 配方）
 *
 * 规则：
 * - maxPositionPct：保留组合回测降仓值（v9 论证，不直接用单品种寻优仓位）
 * - volReduce / dailyLossLimit / circuitBreaker：对齐 topComposite[0] 完整配方
 * - IH0 保持剔除（TOP1 回测亦亏损）
 *
 * 运行：npx tsx src/scripts/regenerateRealtimeOpt.ts
 */
import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams';

const parseCB = (s: string) =>
  s === 'off' ? null : { lossStreak: Number(s.split('x')[0]), pauseDays: Number(s.split('x')[1]) };

const excluded = new Set(['IH0']);

const lines: string[] = [];
lines.push(`/**`);
lines.push(` * 实时交易引擎优化参数（26 品种，IH0 剔除）`);
lines.push(` *`);
lines.push(` * 来源：26 品种 1000 次 LHS 实验 topComposite[0]（TOP1 完整配方，2026-08-15 对齐）`);
lines.push(` * 生效字段：maxPositionPct / volReduce / dailyLossLimit / circuitBreaker`);
lines.push(` * 对齐规则：`);
lines.push(` *   - volReduce / dailyLossLimit / circuitBreaker 直接取自 TOP1 完整配方`);
lines.push(` *   - maxPositionPct 保留组合回测降仓值（单品种寻优仓位 0.15~0.30 不可直接用于组合实盘）`);
lines.push(` *   - IH0 保持剔除（TOP1 回测亦为亏损 -4750）`);
lines.push(` */`);
lines.push(``);
lines.push(`export interface RealtimeOptParams {`);
lines.push(`  /** 品种级最大仓位比例（替代全局 Kelly） */`);
lines.push(`  maxPositionPct: number;`);
lines.push(`  /** 波动率过滤模式 */`);
lines.push(`  volReduce: 'atr2xClear' | 'atr15xHalf' | 'off';`);
lines.push(`  /** 日亏损熔断 */`);
lines.push(`  dailyLossLimit: '5pct' | '8pct' | 'off';`);
lines.push(`  /** 品种级熔断（连续亏损 N 次暂停 M 天） */`);
lines.push(`  circuitBreaker: { lossStreak: number; pauseDays: number } | null;`);
lines.push(`}`);
lines.push(``);
lines.push(`export const REALTIME_OPT_PARAMS: Record<string, RealtimeOptParams> = {`);

const codes = Object.keys(TOP1_UNIFIED_PARAMS);
for (const code of codes) {
  if (excluded.has(code)) continue;
  const top1 = TOP1_UNIFIED_PARAMS[code];
  const mpp = REALTIME_OPT_PARAMS[code]?.maxPositionPct ?? 0.05;
  const cb = parseCB(top1.circuitBreaker);
  const cbStr = cb ? `{ lossStreak: ${cb.lossStreak}, pauseDays: ${cb.pauseDays} }` : `null`;
  lines.push(
    `  ${code}: { maxPositionPct: ${mpp}, volReduce: '${top1.volReduce}', dailyLossLimit: '${top1.dailyLossLimit}', circuitBreaker: ${cbStr} },`
  );
}

lines.push(`  // IH0 上证50：TOP1 回测亦为亏损（-4750，PF 0.37，3笔），已剔除`);
lines.push(`};`);
lines.push(``);
lines.push(`export function getRealtimeOptParams(code: string): RealtimeOptParams | null {`);
lines.push(`  return REALTIME_OPT_PARAMS[code] ?? null;`);
lines.push(`}`);

const target = path.join(process.cwd(), 'src/data/realtimeOptParams.ts');
fs.writeFileSync(target, lines.join('\n') + '\n', 'utf8');
console.log('已生成', target, '共', codes.length - excluded.size, '个品种');
