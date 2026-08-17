/**
 * 周度/月度绩效报告服务
 * 
 * 自动生成交易绩效报告：
 * - 本周/本月信号命中率
 * - 最佳/最差品种
 * - 盈亏分析
 * - 风控执行情况
 */

import { getSimTrades, type SimTradeRecord } from './database.js';
import { getCalibratedGrade, VARIETY_GRADE_LABELS } from './varietyGrade.js';

export interface PerformanceReport {
  period: {
    type: 'weekly' | 'monthly';
    startDate: string;
    endDate: string;
    tradingDays: number;
  };
  summary: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    profitFactor: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
  bestVarieties: Array<{
    code: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  worstVarieties: Array<{
    code: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  directionAnalysis: {
    longTrades: number;
    longWinRate: number;
    longPnl: number;
    shortTrades: number;
    shortWinRate: number;
    shortPnl: number;
  };
  gradeAnalysis: Array<{
    grade: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  riskMetrics: {
    avgHoldDays: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    avgWinPnl: number;
    avgLossPnl: number;
    largestWin: number;
    largestLoss: number;
  };
  suggestions: string[];
}

/**
 * 生成绩效报告
 */
export function generatePerformanceReport(
  type: 'weekly' | 'monthly' = 'weekly',
): PerformanceReport {
  const now = new Date();
  let startDate: Date;

  if (type === 'weekly') {
    startDate = new Date(now);
    startDate.setDate(startDate.getDate() - 7);
  } else {
    startDate = new Date(now);
    startDate.setMonth(startDate.getMonth() - 1);
  }

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = now.toISOString().split('T')[0];

  // 获取时间段内的已平仓交易
  const allTrades = getSimTrades({ status: 'closed', limit: 10000 });
  const trades = allTrades.filter(t => {
    if (!t.exit_date) return false;
    return t.exit_date >= startStr && t.exit_date <= endStr;
  });

  // 基础统计
  const winTrades = trades.filter(t => (t.pnl || 0) > 0);
  const lossTrades = trades.filter(t => (t.pnl || 0) <= 0);
  const totalPnl = trades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalWin = winTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const totalLoss = Math.abs(lossTrades.reduce((s, t) => s + (t.pnl || 0), 0));

  // 最大回撤
  let maxDrawdown = 0;
  let peak = 0;
  let runningPnl = 0;
  const sorted = [...trades].sort((a, b) => (a.exit_date || '').localeCompare(b.exit_date || ''));
  for (const t of sorted) {
    runningPnl += (t.pnl || 0);
    if (runningPnl > peak) peak = runningPnl;
    const dd = peak - runningPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // Sharpe Ratio（简化版）
  const returns = trades.map(t => t.pnl || 0);
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 1;
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  // 按品种统计
  const byCode = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of trades) {
    if (!t.code) continue;
    const entry = byCode.get(t.code) || { trades: 0, wins: 0, pnl: 0 };
    entry.trades++;
    if ((t.pnl || 0) > 0) entry.wins++;
    entry.pnl += (t.pnl || 0);
    byCode.set(t.code, entry);
  }

  const codeStats = Array.from(byCode.entries()).map(([code, s]) => ({
    code,
    trades: s.trades,
    winRate: s.trades > 0 ? Math.round(s.wins / s.trades * 10000) / 100 : 0,
    pnl: Math.round(s.pnl * 100) / 100,
  }));

  const bestVarieties = [...codeStats].sort((a, b) => b.pnl - a.pnl).slice(0, 5);
  const worstVarieties = [...codeStats].sort((a, b) => a.pnl - b.pnl).slice(0, 5).filter(v => v.pnl < 0);

  // 方向分析
  const longTrades = trades.filter(t => t.direction === 'LONG' || t.direction === '多');
  const shortTrades = trades.filter(t => t.direction === 'SHORT' || t.direction === '空');
  const longWins = longTrades.filter(t => (t.pnl || 0) > 0);
  const shortWins = shortTrades.filter(t => (t.pnl || 0) > 0);

  // 分级分析
  const byGrade = new Map<string, { trades: number; wins: number; pnl: number }>();
  for (const t of trades) {
    if (!t.code) continue;
    const grade = getCalibratedGrade(t.code);
    const g = grade.calibratedGrade;
    const entry = byGrade.get(g) || { trades: 0, wins: 0, pnl: 0 };
    entry.trades++;
    if ((t.pnl || 0) > 0) entry.wins++;
    entry.pnl += (t.pnl || 0);
    byGrade.set(g, entry);
  }

  const gradeAnalysis = Array.from(byGrade.entries()).map(([grade, s]) => ({
    grade: `${grade}（${VARIETY_GRADE_LABELS[grade] || '未知'}）`,
    trades: s.trades,
    winRate: s.trades > 0 ? Math.round(s.wins / s.trades * 10000) / 100 : 0,
    pnl: Math.round(s.pnl * 100) / 100,
  }));

  // 风控指标
  let maxConsecutiveWins = 0, maxConsecutiveLosses = 0;
  let curWins = 0, curLosses = 0;
  for (const t of sorted) {
    if ((t.pnl || 0) > 0) {
      curWins++;
      curLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, curWins);
    } else {
      curLosses++;
      curWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, curLosses);
    }
  }

  const avgWinPnl = winTrades.length > 0 ? totalWin / winTrades.length : 0;
  const avgLossPnl = lossTrades.length > 0 ? -totalLoss / lossTrades.length : 0;
  const largestWin = trades.reduce((m, t) => Math.max(m, t.pnl || 0), 0);
  const largestLoss = trades.reduce((m, t) => Math.min(m, t.pnl || 0), 0);

  // 平均持仓天数
  let totalHoldDays = 0;
  let holdDaysCount = 0;
  for (const t of sorted) {
    if (t.exit_date && t.entry_date) {
      const days = (new Date(t.exit_date).getTime() - new Date(t.entry_date).getTime()) / (1000 * 60 * 60 * 24);
      totalHoldDays += days;
      holdDaysCount++;
    }
  }

  // 生成建议
  const suggestions: string[] = [];
  const winRate = trades.length > 0 ? winTrades.length / trades.length : 0;
  if (winRate < 0.4) {
    suggestions.push('胜率偏低，建议提高入场信号质量门槛');
  }
  if (totalLoss > totalWin * 1.5) {
    suggestions.push('亏损大于盈利的1.5倍，建议加强止损执行');
  }
  if (maxConsecutiveLosses >= 3) {
    suggestions.push(`连续亏损 ${maxConsecutiveLosses} 笔，建议触发熔断机制，暂停交易`);
  }
  if (worstVarieties.length > 0) {
    suggestions.push(`表现最差品种：${worstVarieties.map(v => v.code).join('、')}，建议降低仓位或暂停交易`);
  }
  // 分级建议
  const dGradeTrades = byGrade.get('D');
  if (dGradeTrades && dGradeTrades.trades > 0) {
    suggestions.push('D级品种仍有交易记录，建议严格执行分级仓位规则');
  }
  if (suggestions.length === 0) {
    suggestions.push('整体表现良好，继续保持纪律执行');
  }

  // 交易日数估算
  const tradingDays = holdDaysCount > 0 ? Math.ceil(holdDaysCount / Math.max(1, trades.length)) * trades.length : 0;

  return {
    period: {
      type,
      startDate: startStr,
      endDate: endStr,
      tradingDays: Math.max(tradingDays, 1),
    },
    summary: {
      totalTrades: trades.length,
      winTrades: winTrades.length,
      lossTrades: lossTrades.length,
      winRate: Math.round(winRate * 10000) / 100,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgPnl: Math.round(avgReturn * 100) / 100,
      profitFactor: totalLoss > 0 ? Math.round(totalWin / totalLoss * 100) / 100 : totalWin > 0 ? 999 : 0,
      maxDrawdown: Math.round(maxDrawdown * 100) / 100,
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    },
    bestVarieties,
    worstVarieties,
    directionAnalysis: {
      longTrades: longTrades.length,
      longWinRate: longTrades.length > 0 ? Math.round(longWins.length / longTrades.length * 10000) / 100 : 0,
      longPnl: Math.round(longTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100,
      shortTrades: shortTrades.length,
      shortWinRate: shortTrades.length > 0 ? Math.round(shortWins.length / shortTrades.length * 10000) / 100 : 0,
      shortPnl: Math.round(shortTrades.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100,
    },
    gradeAnalysis,
    riskMetrics: {
      avgHoldDays: holdDaysCount > 0 ? Math.round(totalHoldDays / holdDaysCount * 10) / 10 : 0,
      maxConsecutiveWins,
      maxConsecutiveLosses,
      avgWinPnl: Math.round(avgWinPnl * 100) / 100,
      avgLossPnl: Math.round(avgLossPnl * 100) / 100,
      largestWin: Math.round(largestWin * 100) / 100,
      largestLoss: Math.round(largestLoss * 100) / 100,
    },
    suggestions,
  };
}
