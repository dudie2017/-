/**
 * 组合风控监控模块
 * 
 * P0: 单日亏损告警 + 组合回撤控制
 * P1: 连续亏损告警 + 板块集中度控制
 * P2: 信号质量监控 + 相关性告警
 */

import * as db from './database.js';
import { CORRELATION_MATRIX } from '../data/dynamicPositionSizing.js';

// ============================================================
// 配置
// ============================================================

export interface PortfolioRiskConfig {
  // P0: 单日亏损
  maxDailyLossPct: number;        // 单日最大亏损比例 (default 3%)
  
  // P0: 组合回撤
  maxPortfolioDrawdownPct: number; // 组合最大回撤比例 (default 15%)
  
  // P1: 连续亏损
  maxConsecutiveLosses: number;    // 连续亏损笔数告警 (default 3)
  
  // P1: 板块集中度
  maxSectorConcentrationPct: number; // 单板块最大集中度 (default 40%)
  
  // P2: 相关性
  maxCorrelationThreshold: number;   // 相关性告警阈值 (default 0.7)
  
  // P2: 信号质量
  minSignalToTradeRatio: number;     // 信号→成交最低转化率 (default 0.3)
}

const DEFAULT_CONFIG: PortfolioRiskConfig = {
  maxDailyLossPct: 0.03,
  maxPortfolioDrawdownPct: 0.15,
  maxConsecutiveLosses: 3,
  maxSectorConcentrationPct: 0.40,
  maxCorrelationThreshold: 0.7,
  minSignalToTradeRatio: 0.3,
};

// ============================================================
// 板块映射
// ============================================================

const SECTOR_MAP: Record<string, string> = {
  // 黑色系
  RB0: '黑色', HC0: '黑色', I0: '黑色', J0: '黑色', JM0: '黑色',
  // 有色系
  CU0: '有色', AL0: '有色', ZN0: '有色', PB0: '有色', NI0: '有色', SN0: '有色',
  // 能源系
  SC0: '能源', FU0: '能源', LU0: '能源', BU0: '能源',
  // 农产品
  CF0: '农产品', SR0: '农产品', Y0: '农产品', M0: '农产品', RM0: '农产品',
  OI0: '农产品', P0: '农产品', A0: '农产品', B0: '农产品',
  // 化工系
  TA0: '化工', MA0: '化工', PP0: '化工', PE0: '化工', PVC0: '化工',
  EG0: '化工', EB0: '化工', SA0: '化工',
  // 贵金属
  AU0: '贵金属', AG0: '贵金属',
  // 股指
  IF0: '股指', IH0: '股指', IC0: '股指', IM0: '股指',
  // 其他
  LH0: '畜牧', SP0: '其他', SI0: '其他',
};

export function getSector(code: string): string {
  return SECTOR_MAP[code] || '其他';
}

// ============================================================
// 风控检查结果
// ============================================================

export type RiskLevel = 'normal' | 'warning' | 'critical';

export interface RiskCheck {
  name: string;
  level: RiskLevel;
  message: string;
  value: number;
  threshold: number;
  action?: string;
}

export interface PortfolioRiskReport {
  timestamp: number;
  totalCapital: number;
  totalPnl: number;
  dailyPnl: number;
  dailyPnlPct: number;
  peakCapital: number;
  drawdownPct: number;
  riskLevel: RiskLevel;
  checks: RiskCheck[];
  canTrade: boolean;
  blockedReasons: string[];
}

// ============================================================
// P0: 单日亏损告警
// ============================================================

function checkDailyLoss(
  todayTrades: db.SimTradeRecord[],
  capital: number,
  config: PortfolioRiskConfig
): RiskCheck {
  const todayPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const todayPnlPct = todayPnl / capital;
  
  const threshold = config.maxDailyLossPct;
  const isWarning = todayPnlPct < -threshold * 0.7; // 70% 阈值预警
  const isCritical = todayPnlPct < -threshold;
  
  return {
    name: '单日亏损',
    level: isCritical ? 'critical' : isWarning ? 'warning' : 'normal',
    message: isCritical 
      ? `单日亏损 ${(todayPnlPct * 100).toFixed(2)}% 超过阈值 ${(threshold * 100).toFixed(1)}%，当日停止开仓`
      : isWarning
      ? `单日亏损 ${(todayPnlPct * 100).toFixed(2)}% 接近阈值`
      : `单日盈亏 ${(todayPnlPct * 100).toFixed(2)}%`,
    value: todayPnlPct,
    threshold: -threshold,
    action: isCritical ? 'HALT_NEW_TRADES_TODAY' : undefined,
  };
}

// ============================================================
// P0: 组合回撤控制
// ============================================================

function checkPortfolioDrawdown(
  allTrades: db.SimTradeRecord[],
  capital: number,
  config: PortfolioRiskConfig
): RiskCheck {
  // 计算累计盈亏曲线
  let cumPnl = 0;
  let peak = capital;
  let maxDrawdown = 0;
  
  const sortedTrades = [...allTrades].sort((a, b) => 
    (a.exit_date || a.entry_date || '').localeCompare(b.exit_date || b.entry_date || '')
  );
  
  for (const trade of sortedTrades) {
    cumPnl += trade.pnl || 0;
    const equity = capital + cumPnl;
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  
  const threshold = config.maxPortfolioDrawdownPct;
  const isWarning = maxDrawdown > threshold * 0.7;
  const isCritical = maxDrawdown > threshold;
  
  return {
    name: '组合回撤',
    level: isCritical ? 'critical' : isWarning ? 'warning' : 'normal',
    message: isCritical
      ? `组合回撤 ${(maxDrawdown * 100).toFixed(2)}% 超过阈值 ${(threshold * 100).toFixed(1)}%，全部品种仓位减半`
      : isWarning
      ? `组合回撤 ${(maxDrawdown * 100).toFixed(2)}% 接近阈值`
      : `组合回撤 ${(maxDrawdown * 100).toFixed(2)}%`,
    value: maxDrawdown,
    threshold,
    action: isCritical ? 'REDUCE_ALL_POSITIONS_50PCT' : undefined,
  };
}

// ============================================================
// P1: 连续亏损告警
// ============================================================

function checkConsecutiveLosses(
  codeTrades: db.SimTradeRecord[],
  config: PortfolioRiskConfig
): RiskCheck {
  const closedTrades = codeTrades.filter(t => t.status === 'closed' || t.status === 'CLOSED' || t.status === 'stopped' || t.status === 'STOPPED')
    .sort((a, b) => (b.exit_date || '').localeCompare(a.exit_date || ''));
  
  let consecutiveLosses = 0;
  for (const trade of closedTrades) {
    if ((trade.pnl || 0) < 0) {
      consecutiveLosses++;
    } else {
      break;
    }
  }
  
  const threshold = config.maxConsecutiveLosses;
  const isWarning = consecutiveLosses >= threshold;
  const isCritical = consecutiveLosses >= threshold + 2;
  
  return {
    name: '连续亏损',
    level: isCritical ? 'critical' : isWarning ? 'warning' : 'normal',
    message: isCritical
      ? `连续 ${consecutiveLosses} 笔亏损，暂停该品种交易`
      : isWarning
      ? `连续 ${consecutiveLosses} 笔亏损，降低仓位`
      : `最近无连续亏损`,
    value: consecutiveLosses,
    threshold,
    action: isCritical ? 'HALT_THIS_VARIETY' : isWarning ? 'REDUCE_POSITION_50PCT' : undefined,
  };
}

// ============================================================
// P1: 板块集中度控制
// ============================================================

function checkSectorConcentration(
  openPositions: Array<{ code: string; positionValue: number }>,
  totalCapital: number,
  config: PortfolioRiskConfig
): RiskCheck {
  // 按板块汇总持仓市值
  const sectorExposure: Record<string, number> = {};
  for (const pos of openPositions) {
    const sector = getSector(pos.code);
    sectorExposure[sector] = (sectorExposure[sector] || 0) + Math.abs(pos.positionValue);
  }
  
  // 找最大集中度
  let maxConcentration = 0;
  let maxSector = '';
  for (const [sector, exposure] of Object.entries(sectorExposure)) {
    const concentration = exposure / totalCapital;
    if (concentration > maxConcentration) {
      maxConcentration = concentration;
      maxSector = sector;
    }
  }
  
  const threshold = config.maxSectorConcentrationPct;
  const isWarning = maxConcentration > threshold * 0.8;
  const isCritical = maxConcentration > threshold;
  
  return {
    name: '板块集中度',
    level: isCritical ? 'critical' : isWarning ? 'warning' : 'normal',
    message: isCritical
      ? `${maxSector}板块集中度 ${(maxConcentration * 100).toFixed(1)}% 超过阈值 ${(threshold * 100).toFixed(0)}%`
      : isWarning
      ? `${maxSector}板块集中度 ${(maxConcentration * 100).toFixed(1)}% 接近阈值`
      : `最大板块集中度 ${(maxConcentration * 100).toFixed(1)}% (${maxSector || '无持仓'})`,
    value: maxConcentration,
    threshold,
    action: isCritical ? `REDUCE_${maxSector}_POSITIONS` : undefined,
  };
}

// ============================================================
// P2: 相关性告警
// ============================================================

function checkCorrelationAlert(
  openPositionCodes: string[],
  config: PortfolioRiskConfig
): RiskCheck {
  if (openPositionCodes.length < 2) {
    return {
      name: '相关性',
      level: 'normal',
      message: '持仓品种不足 2 个，无需检查',
      value: 0,
      threshold: config.maxCorrelationThreshold,
    };
  }
  
  // 检查持仓品种间的最高相关性
  let maxCorr = 0;
  let maxPair = '';
  
  for (let i = 0; i < openPositionCodes.length; i++) {
    for (let j = i + 1; j < openPositionCodes.length; j++) {
      const codeA = openPositionCodes[i];
      const codeB = openPositionCodes[j];
      const corr = CORRELATION_MATRIX[codeA]?.[codeB] || 0;
      if (Math.abs(corr) > Math.abs(maxCorr)) {
        maxCorr = corr;
        maxPair = `${codeA}-${codeB}`;
      }
    }
  }
  
  const threshold = config.maxCorrelationThreshold;
  const isWarning = Math.abs(maxCorr) > threshold * 0.85;
  const isCritical = Math.abs(maxCorr) > threshold;
  
  return {
    name: '相关性',
    level: isCritical ? 'critical' : isWarning ? 'warning' : 'normal',
    message: isCritical
      ? `${maxPair} 相关性 ${maxCorr.toFixed(2)} 超过阈值 ${threshold}，建议降仓`
      : isWarning
      ? `${maxPair} 相关性 ${maxCorr.toFixed(2)} 接近阈值`
      : `最高相关性 ${maxCorr.toFixed(2)} (${maxPair})`,
    value: maxCorr,
    threshold,
    action: isCritical ? 'REDUCE_CORRELATED_POSITIONS' : undefined,
  };
}

// ============================================================
// 主函数：生成组合风控报告
// ============================================================

export function generatePortfolioRiskReport(
  config?: Partial<PortfolioRiskConfig>
): PortfolioRiskReport {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const checks: RiskCheck[] = [];
  const blockedReasons: string[] = [];
  
  // 获取所有交易记录
  const allTrades = db.getSimTrades({});
  const closedTrades = allTrades.filter(t => t.status === 'closed' || t.status === 'CLOSED' || t.status === 'stopped' || t.status === 'STOPPED');
  
  // 获取今日交易
  const today = new Date().toISOString().split('T')[0];
  const todayTrades = allTrades.filter(t => {
    const exitDate = t.exit_date || '';
    return exitDate.startsWith(today);
  });
  
  // 获取当前持仓
  const openTrades = allTrades.filter(t => t.status === 'open' || t.status === 'OPEN');
  const openPositions = openTrades.map(t => ({
    code: t.code,
    positionValue: (t.entry_price || 0) * 10, // 简化：假设每手 10 单位
  }));
  
  // 计算总资金和总盈亏
  const totalCapital = 3000000; // 默认 300 万
  const totalPnl = closedTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const dailyPnl = todayTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const dailyPnlPct = dailyPnl / totalCapital;
  
  // 计算峰值资金和回撤
  let cumPnl = 0;
  let peak = totalCapital;
  for (const trade of closedTrades.sort((a, b) => 
    (a.exit_date || '').localeCompare(b.exit_date || '')
  )) {
    cumPnl += trade.pnl || 0;
    const equity = totalCapital + cumPnl;
    if (equity > peak) peak = equity;
  }
  const currentEquity = totalCapital + totalPnl;
  const drawdownPct = peak > 0 ? (peak - currentEquity) / peak : 0;
  
  // P0: 单日亏损
  const dailyLossCheck = checkDailyLoss(todayTrades, totalCapital, cfg);
  checks.push(dailyLossCheck);
  if (dailyLossCheck.level === 'critical') {
    blockedReasons.push(dailyLossCheck.message);
  }
  
  // P0: 组合回撤
  const drawdownCheck = checkPortfolioDrawdown(closedTrades, totalCapital, cfg);
  checks.push(drawdownCheck);
  if (drawdownCheck.level === 'critical') {
    blockedReasons.push(drawdownCheck.message);
  }
  
  // P1: 连续亏损（按品种）
  const codes = [...new Set(closedTrades.map(t => t.code))];
  for (const code of codes) {
    const codeTrades = closedTrades.filter(t => t.code === code);
    const consecCheck = checkConsecutiveLosses(codeTrades, cfg);
    if (consecCheck.level !== 'normal') {
      consecCheck.name = `连续亏损(${code})`;
      checks.push(consecCheck);
      if (consecCheck.level === 'critical') {
        blockedReasons.push(`${code}: ${consecCheck.message}`);
      }
    }
  }
  
  // P1: 板块集中度
  const sectorCheck = checkSectorConcentration(openPositions, totalCapital, cfg);
  checks.push(sectorCheck);
  if (sectorCheck.level === 'critical') {
    blockedReasons.push(sectorCheck.message);
  }
  
  // P2: 相关性
  const openCodes = openPositions.map(p => p.code);
  const corrCheck = checkCorrelationAlert(openCodes, cfg);
  checks.push(corrCheck);
  
  // 综合风险等级
  const hasCritical = checks.some(c => c.level === 'critical');
  const hasWarning = checks.some(c => c.level === 'warning');
  const riskLevel: RiskLevel = hasCritical ? 'critical' : hasWarning ? 'warning' : 'normal';
  
  return {
    timestamp: Date.now(),
    totalCapital,
    totalPnl,
    dailyPnl,
    dailyPnlPct,
    peakCapital: peak,
    drawdownPct,
    riskLevel,
    checks,
    canTrade: !hasCritical,
    blockedReasons,
  };
}

// ============================================================
// 品种级风控检查（用于开仓前检查）
// ============================================================

export function checkVarietyCanTrade(
  code: string,
  report: PortfolioRiskReport
): { canTrade: boolean; reason?: string } {
  // 全局风控
  if (!report.canTrade) {
    return { canTrade: false, reason: report.blockedReasons[0] };
  }
  
  // 品种级连续亏损
  const consecCheck = report.checks.find(c => c.name === `连续亏损(${code})`);
  if (consecCheck?.level === 'critical') {
    return { canTrade: false, reason: consecCheck.message };
  }
  
  return { canTrade: true };
}

// ============================================================
// 仓位调整建议（用于开仓时调整）
// ============================================================

export function getPositionMultiplier(
  code: string,
  report: PortfolioRiskReport
): number {
  let multiplier = 1.0;
  
  // 组合回撤 > 70% 阈值 → 仓位减半
  const drawdownCheck = report.checks.find(c => c.name === '组合回撤');
  if (drawdownCheck?.level === 'critical') {
    multiplier *= 0.5;
  }
  
  // 品种连续亏损 → 仓位减半
  const consecCheck = report.checks.find(c => c.name === `连续亏损(${code})`);
  if (consecCheck?.level === 'warning') {
    multiplier *= 0.5;
  }
  
  // 相关性过高 → 仓位降 30%
  const corrCheck = report.checks.find(c => c.name === '相关性');
  if (corrCheck?.level === 'critical') {
    multiplier *= 0.7;
  }
  
  return Math.max(multiplier, 0.1); // 最低 10%
}
