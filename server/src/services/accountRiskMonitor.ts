/**
 * 账户级风控监控服务
 * 
 * 在单品种风控（riskManager.ts）之上，增加组合层面的风控：
 * 1. 总持仓不超过账户 X%
 * 2. 单一方向暴露不超过 Y%
 * 3. 单日最大亏损触发暂停
 * 4. 相关性集中度预警
 */

import { getSimTrades, type SimTradeRecord } from './database.js';
import { getCalibratedGrade, VARIETY_GRADE_LABELS } from './varietyGrade.js';

// 账户风控配置
export interface AccountRiskConfig {
  /** 最大总持仓占比（保证金/账户净值） */
  maxTotalPositionPct: number;     // 默认 60%
  /** 最大单方向暴露占比 */
  maxSingleDirectionPct: number;   // 默认 40%
  /** 单日最大亏损占比 */
  maxDailyLossPct: number;         // 默认 3%
  /** 单周最大亏损占比 */
  maxWeeklyLossPct: number;        // 默认 5%
  /** 单品种最大持仓占比 */
  maxSingleVarietyPct: number;     // 默认 15%
  /** 高相关品种群最大占比 */
  maxCorrelatedGroupPct: number;   // 默认 25%
  /** 连续亏损笔数触发暂停 */
  maxConsecutiveLosses: number;    // 默认 3
  /** 熔断冷却时间（小时） */
  cooldownHours: number;           // 默认 24
}

const DEFAULT_RISK_CONFIG: AccountRiskConfig = {
  maxTotalPositionPct: 0.60,
  maxSingleDirectionPct: 0.40,
  maxDailyLossPct: 0.03,
  maxWeeklyLossPct: 0.05,
  maxSingleVarietyPct: 0.15,
  maxCorrelatedGroupPct: 0.25,
  maxConsecutiveLosses: 3,
  cooldownHours: 24,
};

// 高相关品种群定义（相关性 > 0.7 的品种组）
export const CORRELATED_GROUPS: Record<string, string[]> = {
  '黑色系': ['RB0', 'HC0', 'I0', 'J0', 'JM0'],
  '有色金属': ['CU0', 'AL0', 'ZN0', 'NI0', 'SN0'],
  '贵金属': ['AU0', 'AG0'],
  '油脂': ['Y0', 'P0', 'OI0'],
  '蛋白粕': ['M0', 'RM0'],
  '化工': ['MA0', 'TA0', 'PP0', 'L0', 'V0', 'EG0', 'EB0'],
  '建材': ['FG0', 'SA0'],
  '股指': ['IF0', 'IC0', 'IH0', 'IM0'],
};

export interface AccountRiskCheck {
  /** 是否通过所有风控检查 */
  passed: boolean;
  /** 账户净值 */
  equity: number;
  /** 各项检查结果 */
  checks: RiskCheckItem[];
  /** 熔断状态 */
  circuitBreaker: {
    active: boolean;
    reason?: string;
    expiresAt?: number;
  };
  /** 预警信息 */
  warnings: string[];
  /** 建议 */
  suggestions: string[];
}

export interface RiskCheckItem {
  name: string;
  passed: boolean;
  currentValue: number;
  limit: number;
  unit: string;
  message: string;
}

// 持仓信息
export interface PositionInfo {
  code: string;
  name: string;
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  currentPrice?: number;
  lots: number;
  margin: number;           // 占用保证金
  unrealizedPnl: number;    // 未实现盈亏
  grade: string;            // 品种分级
}

/**
 * 账户风控检查
 */
export function checkAccountRisk(
  positions: PositionInfo[],
  closedTrades: SimTradeRecord[],
  equity: number,
  config: Partial<AccountRiskConfig> = {},
): AccountRiskCheck {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...config };
  const checks: RiskCheckItem[] = [];
  const warnings: string[] = [];
  const suggestions: string[] = [];

  if (equity <= 0) {
    return {
      passed: false,
      equity: 0,
      checks: [],
      circuitBreaker: { active: true, reason: '账户净值为零或负数' },
      warnings: ['账户资金异常'],
      suggestions: ['请检查账户资金'],
    };
  }

  // === 1. 总持仓检查 ===
  const totalMargin = positions.reduce((sum, p) => sum + p.margin, 0);
  const totalPositionPct = totalMargin / equity;
  checks.push({
    name: '总持仓占比',
    passed: totalPositionPct <= cfg.maxTotalPositionPct,
    currentValue: Math.round(totalPositionPct * 10000) / 100,
    limit: cfg.maxTotalPositionPct * 100,
    unit: '%',
    message: totalPositionPct <= cfg.maxTotalPositionPct
      ? `总持仓 ${totalPositionPct.toFixed(1)}%，在安全范围内`
      : `总持仓 ${totalPositionPct.toFixed(1)}% 超过上限 ${cfg.maxTotalPositionPct * 100}%`,
  });

  // === 2. 单方向暴露检查 ===
  const longMargin = positions.filter(p => p.direction === 'LONG').reduce((s, p) => s + p.margin, 0);
  const shortMargin = positions.filter(p => p.direction === 'SHORT').reduce((s, p) => s + p.margin, 0);
  const maxDirectionPct = Math.max(longMargin, shortMargin) / equity;
  const dominantDir = longMargin >= shortMargin ? '多' : '空';
  checks.push({
    name: '单方向暴露',
    passed: maxDirectionPct <= cfg.maxSingleDirectionPct,
    currentValue: Math.round(maxDirectionPct * 10000) / 100,
    limit: cfg.maxSingleDirectionPct * 100,
    unit: '%',
    message: maxDirectionPct <= cfg.maxSingleDirectionPct
      ? `${dominantDir}方暴露 ${maxDirectionPct.toFixed(1)}%，安全`
      : `${dominantDir}方暴露 ${maxDirectionPct.toFixed(1)}% 超过上限`,
  });

  // === 3. 单品种集中度检查 ===
  const byVariety = new Map<string, number>();
  for (const p of positions) {
    byVariety.set(p.code, (byVariety.get(p.code) || 0) + p.margin);
  }
  let maxSinglePct = 0;
  let maxSingleCode = '';
  for (const [code, margin] of byVariety) {
    const pct = margin / equity;
    if (pct > maxSinglePct) {
      maxSinglePct = pct;
      maxSingleCode = code;
    }
  }
  checks.push({
    name: '单品种集中度',
    passed: maxSinglePct <= cfg.maxSingleVarietyPct,
    currentValue: Math.round(maxSinglePct * 10000) / 100,
    limit: cfg.maxSingleVarietyPct * 100,
    unit: '%',
    message: maxSingleCode
      ? `${maxSingleCode} 占比 ${maxSinglePct.toFixed(1)}%${maxSinglePct > cfg.maxSingleVarietyPct ? '，超过上限' : ''}`
      : '无持仓',
  });

  // === 4. 相关性集中度检查 ===
  for (const [groupName, groupCodes] of Object.entries(CORRELATED_GROUPS)) {
    const groupMargin = positions
      .filter(p => groupCodes.includes(p.code))
      .reduce((s, p) => s + p.margin, 0);
    const groupPct = groupMargin / equity;
    if (groupPct > cfg.maxCorrelatedGroupPct) {
      warnings.push(`${groupName}持仓集中度过高：${(groupPct * 100).toFixed(1)}%（上限 ${(cfg.maxCorrelatedGroupPct * 100).toFixed(0)}%）`);
      suggestions.push(`建议减少${groupName}品种持仓，降低相关性风险`);
    }
  }

  // === 5. 日内亏损检查 ===
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = closedTrades.filter(t => {
    if (!t.exit_date) return false;
    return new Date(t.exit_date).getTime() >= todayStart.getTime();
  });
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const dailyLossPct = todayPnl < 0 ? Math.abs(todayPnl) / equity : 0;
  checks.push({
    name: '日内亏损',
    passed: dailyLossPct <= cfg.maxDailyLossPct,
    currentValue: Math.round(dailyLossPct * 10000) / 100,
    limit: cfg.maxDailyLossPct * 100,
    unit: '%',
    message: todayPnl >= 0
      ? `今日盈利 ${todayPnl.toFixed(0)} 元`
      : `今日亏损 ${Math.abs(todayPnl).toFixed(0)} 元（${dailyLossPct.toFixed(1)}%）`,
  });

  // === 6. 连续亏损检查 ===
  const sorted = [...closedTrades]
    .filter(t => t.exit_date)
    .sort((a, b) => new Date(b.exit_date!).getTime() - new Date(a.exit_date!).getTime());
  let consecutiveLosses = 0;
  for (const t of sorted) {
    if ((t.pnl || 0) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }
  checks.push({
    name: '连续亏损',
    passed: consecutiveLosses < cfg.maxConsecutiveLosses,
    currentValue: consecutiveLosses,
    limit: cfg.maxConsecutiveLosses,
    unit: '笔',
    message: consecutiveLosses >= cfg.maxConsecutiveLosses
      ? `连续亏损 ${consecutiveLosses} 笔，触发熔断`
      : `连续亏损 ${consecutiveLosses} 笔`,
  });

  // === 熔断判断 ===
  const circuitBreaker = {
    active: false as boolean,
    reason: undefined as string | undefined,
    expiresAt: undefined as number | undefined,
  };

  // 日内亏损超限
  if (dailyLossPct > cfg.maxDailyLossPct) {
    circuitBreaker.active = true;
    circuitBreaker.reason = `日内亏损 ${(dailyLossPct * 100).toFixed(1)}% 超过上限 ${(cfg.maxDailyLossPct * 100).toFixed(0)}%`;
    circuitBreaker.expiresAt = now + cfg.cooldownHours * 3600 * 1000;
  }

  // 连续亏损超限
  if (consecutiveLosses >= cfg.maxConsecutiveLosses) {
    circuitBreaker.active = true;
    circuitBreaker.reason = `连续亏损 ${consecutiveLosses} 笔`;
    circuitBreaker.expiresAt = now + cfg.cooldownHours * 3600 * 1000;
  }

  // === 品种分级预警 ===
  for (const p of positions) {
    const grade = getCalibratedGrade(p.code);
    if (grade.calibratedGrade === 'C' || grade.calibratedGrade === 'D') {
      warnings.push(`${p.code} 品种评级为 ${grade.calibratedGrade}（${VARIETY_GRADE_LABELS[grade.calibratedGrade]}），建议减仓或平仓`);
    }
  }

  const passed = checks.every(c => c.passed) && !circuitBreaker.active;

  return {
    passed,
    equity,
    checks,
    circuitBreaker,
    warnings,
    suggestions,
  };
}

/**
 * 计算建议仓位大小
 */
export function suggestPositionSize(
  equity: number,
  currentMargin: number,
  newTradeMargin: number,
  code: string,
  config: Partial<AccountRiskConfig> = {},
): { allowed: boolean; adjustedMargin: number; reason: string } {
  const cfg = { ...DEFAULT_RISK_CONFIG, ...config };
  const remaining = equity * cfg.maxTotalPositionPct - currentMargin;

  if (remaining <= 0) {
    return { allowed: false, adjustedMargin: 0, reason: '总持仓已达上限，无法开新仓' };
  }

  // 单品种上限
  const singleLimit = equity * cfg.maxSingleVarietyPct;
  // 分级系数
  const grade = getCalibratedGrade(code);
  const gradeCoef: Record<string, number> = { A: 1.0, B: 0.6, C: 0.3, D: 0 };
  const coef = gradeCoef[grade.calibratedGrade] ?? 0.5;

  let adjustedMargin = Math.min(newTradeMargin, remaining, singleLimit) * coef;

  if (adjustedMargin < newTradeMargin * 0.1) {
    return { allowed: false, adjustedMargin: 0, reason: `品种评级 ${grade.calibratedGrade}，建议仓位过小` };
  }

  return {
    allowed: true,
    adjustedMargin: Math.round(adjustedMargin),
    reason: adjustedMargin < newTradeMargin
      ? `因风控限制，仓位从 ${newTradeMargin.toFixed(0)} 调整为 ${adjustedMargin.toFixed(0)}`
      : '仓位在安全范围内',
  };
}
