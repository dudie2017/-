/**
 * 策略风控服务（方向四）
 * 
 * P0：单日亏损告警 + 组合回撤控制
 * P1：连续亏损告警 + 板块集中度控制
 * 
 * 集成到 paperTradingService，在开仓前检查风控条件
 */

import db from './database.js';

// ===== 类型定义 =====

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
  riskLevel: 'normal' | 'warning' | 'danger';
}

export interface DailyPnL {
  date: string;
  pnl: number;
  cumPnl: number;
}

export interface ConsecutiveLossInfo {
  code: string;
  consecutiveLosses: number;
  lastLossDate: string;
  totalLossAmount: number;
}

export interface PortfolioRiskStatus {
  // 组合级
  totalCapital: number;
  currentEquity: number;
  drawdown: number;           // 当前回撤 %
  drawdownPeak: number;       // 历史最大回撤 %
  
  // 单日
  todayPnl: number;
  todayPnlPct: number;
  
  // 连续亏损
  consecutiveLosses: ConsecutiveLossInfo[];
  
  // 板块集中度
  sectorExposure: Record<string, number>;  // 板块 → 持仓占比
}

// ===== 风控配置 =====

export interface RiskConfig {
  // 单日亏损限制
  dailyLossLimitPct: number;      // 单日最大亏损比例（默认 2%）
  
  // 组合回撤控制
  drawdownWarningPct: number;     // 回撤预警线（默认 10%）
  drawdownDangerPct: number;      // 回撤危险线（默认 15%）
  drawdownHaltPct: number;        // 回撤暂停线（默认 20%）
  
  // 连续亏损告警
  consecutiveLossWarning: number; // 连续亏损预警笔数（默认 3）
  consecutiveLossHalt: number;    // 连续亏损暂停笔数（默认 5）
  
  // 板块集中度
  sectorMaxExposurePct: number;   // 单板块最大持仓占比（默认 40%）
  sectorWarningExposurePct: number; // 单板块预警占比（默认 30%）
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  dailyLossLimitPct: 0.02,
  drawdownWarningPct: 0.10,
  drawdownDangerPct: 0.15,
  drawdownHaltPct: 0.20,
  consecutiveLossWarning: 3,
  consecutiveLossHalt: 5,
  sectorMaxExposurePct: 0.40,
  sectorWarningExposurePct: 0.30,
};

// ===== 板块映射 =====

const SECTOR_MAP: Record<string, string> = {
  // 黑色系
  RB0: '黑色', HC0: '黑色', I0: '黑色', J0: '黑色', JM0: '黑色',
  // 有色
  CU0: '有色', AL0: '有色', ZN0: '有色', PB0: '有色', NI0: '有色', SN0: '有色',
  // 农产品
  CF0: '农产品', SR0: '农产品', TA0: '农产品', OI0: '农产品', RM0: '农产品',
  Y0: '农产品', M0: '农产品', P0: '农产品', AP0: '农产品', CJ0: '农产品',
  // 能源化工
  SC0: '能源', FU0: '能源', LU0: '能源', BU0: '能源',
  MA0: '化工', PP0: '化工', PE0: '化工', EG0: '化工', EB0: '化工',
  // 股指
  IF0: '股指', IH0: '股指', IC0: '股指', IM0: '股指',
  // 其他
  AU0: '贵金属', AG0: '贵金属',
  SP0: '其他', LH0: '其他',
};

export function getSector(code: string): string {
  return SECTOR_MAP[code] || '其他';
}

// ===== 核心风控函数 =====

/**
 * 计算组合风险状态
 */
export async function getPortfolioRiskStatus(
  startCapital: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): Promise<PortfolioRiskStatus> {
  // 获取所有模拟交易
  const allTrades = db.prepare(`
    SELECT code, side, pnl, exit_date, exit_price
    FROM sim_trades
    WHERE exit_date IS NOT NULL
    ORDER BY exit_date
  `).all() as Array<{ code: string; side: string; pnl: number; exit_date: string; exit_price: number }>;

  // 计算当前权益
  const totalPnl = allTrades.reduce((sum, t) => sum + t.pnl, 0);
  const currentEquity = startCapital + totalPnl;
  
  // 计算回撤
  let peakEquity = startCapital;
  let maxDrawdown = 0;
  let cumPnl = 0;
  
  for (const trade of allTrades) {
    cumPnl += trade.pnl;
    const equity = startCapital + cumPnl;
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const currentDrawdown = peakEquity > 0 ? (peakEquity - currentEquity) / peakEquity : 0;
  
  // 计算今日盈亏
  const today = new Date().toISOString().split('T')[0];
  const todayPnl = allTrades
    .filter(t => t.exit_date === today)
    .reduce((sum, t) => sum + t.pnl, 0);
  
  // 计算连续亏损
  const consecutiveLosses = calcConsecutiveLosses(allTrades);
  
  // 计算板块集中度
  const sectorExposure = calcSectorExposure(allTrades, currentEquity);
  
  return {
    totalCapital: startCapital,
    currentEquity,
    drawdown: currentDrawdown,
    drawdownPeak: maxDrawdown,
    todayPnl,
    todayPnlPct: todayPnl / startCapital,
    consecutiveLosses,
    sectorExposure,
  };
}

/**
 * 计算各品种连续亏损
 */
function calcConsecutiveLosses(trades: Array<{ code: string; pnl: number; exit_date: string }>): ConsecutiveLossInfo[] {
  const byCode: Record<string, Array<{ pnl: number; exit_date: string }>> = {};
  
  for (const t of trades) {
    if (!byCode[t.code]) byCode[t.code] = [];
    byCode[t.code].push({ pnl: t.pnl, exit_date: t.exit_date });
  }
  
  const result: ConsecutiveLossInfo[] = [];
  
  for (const [code, codeTrades] of Object.entries(byCode)) {
    // 按日期排序
    codeTrades.sort((a, b) => a.exit_date.localeCompare(b.exit_date));
    
    // 从后往前数连续亏损
    let consecutive = 0;
    let totalLoss = 0;
    let lastLossDate = '';
    
    for (let i = codeTrades.length - 1; i >= 0; i--) {
      if (codeTrades[i].pnl < 0) {
        consecutive++;
        totalLoss += codeTrades[i].pnl;
        lastLossDate = codeTrades[i].exit_date;
      } else {
        break;
      }
    }
    
    if (consecutive > 0) {
      result.push({
        code,
        consecutiveLosses: consecutive,
        lastLossDate,
        totalLossAmount: totalLoss,
      });
    }
  }
  
  return result.sort((a, b) => b.consecutiveLosses - a.consecutiveLosses);
}

/**
 * 计算板块集中度
 */
function calcSectorExposure(
  trades: Array<{ code: string; side: string; exit_price: number }>,
  totalEquity: number
): Record<string, number> {
  // 获取当前持仓
  const positions = db.prepare(`
    SELECT code, side, quantity, entry_price
    FROM sim_trades
    WHERE exit_date IS NULL
  `).all() as Array<{ code: string; side: string; quantity: number; entry_price: number }>;
  
  const sectorExposure: Record<string, number> = {};
  
  for (const pos of positions) {
    const sector = getSector(pos.code);
    // 简化计算：用持仓市值近似
    const positionValue = pos.quantity * pos.entry_price;
    sectorExposure[sector] = (sectorExposure[sector] || 0) + positionValue;
  }
  
  // 转换为占比
  if (totalEquity > 0) {
    for (const sector of Object.keys(sectorExposure)) {
      sectorExposure[sector] = sectorExposure[sector] / totalEquity;
    }
  }
  
  return sectorExposure;
}

// ===== 开仓前风控检查 =====

/**
 * 综合风控检查（开仓前调用）
 */
export async function checkRiskBeforeOpen(
  code: string,
  startCapital: number,
  config: RiskConfig = DEFAULT_RISK_CONFIG
): Promise<RiskCheckResult> {
  const status = await getPortfolioRiskStatus(startCapital, config);
  
  // 1. 单日亏损检查
  if (status.todayPnlPct < -config.dailyLossLimitPct) {
    return {
      allowed: false,
      reason: `单日亏损已达 ${(status.todayPnlPct * 100).toFixed(2)}%，超过限制 ${config.dailyLossLimitPct * 100}%`,
      riskLevel: 'danger',
    };
  }
  
  // 2. 组合回撤检查
  if (status.drawdown >= config.drawdownHaltPct) {
    return {
      allowed: false,
      reason: `组合回撤 ${(status.drawdown * 100).toFixed(2)}%，已达暂停线 ${config.drawdownHaltPct * 100}%`,
      riskLevel: 'danger',
    };
  }
  
  // 3. 连续亏损检查
  const codeLoss = status.consecutiveLosses.find(l => l.code === code);
  if (codeLoss && codeLoss.consecutiveLosses >= config.consecutiveLossHalt) {
    return {
      allowed: false,
      reason: `${code} 连续亏损 ${codeLoss.consecutiveLosses} 笔，已达暂停线 ${config.consecutiveLossHalt} 笔`,
      riskLevel: 'danger',
    };
  }
  
  // 4. 板块集中度检查
  const sector = getSector(code);
  const sectorExposure = status.sectorExposure[sector] || 0;
  if (sectorExposure >= config.sectorMaxExposurePct) {
    return {
      allowed: false,
      reason: `${sector} 板块持仓占比 ${(sectorExposure * 100).toFixed(1)}%，已达上限 ${config.sectorMaxExposurePct * 100}%`,
      riskLevel: 'danger',
    };
  }
  
  // 预警级别判断
  if (status.drawdown >= config.drawdownDangerPct) {
    return { allowed: true, riskLevel: 'danger' };
  }
  
  if (status.drawdown >= config.drawdownWarningPct) {
    return { allowed: true, riskLevel: 'warning' };
  }
  
  if (codeLoss && codeLoss.consecutiveLosses >= config.consecutiveLossWarning) {
    return { allowed: true, riskLevel: 'warning' };
  }
  
  if (sectorExposure >= config.sectorWarningExposurePct) {
    return { allowed: true, riskLevel: 'warning' };
  }
  
  return { allowed: true, riskLevel: 'normal' };
}

/**
 * 获取风控状态摘要（用于日志/展示）
 */
export function getRiskSummary(status: PortfolioRiskStatus): string {
  const lines: string[] = [];
  
  lines.push(`=== 组合风控状态 ===`);
  lines.push(`权益: ${(status.currentEquity / 10000).toFixed(2)}万 | 回撤: ${(status.drawdown * 100).toFixed(2)}%`);
  lines.push(`今日盈亏: ${(status.todayPnl / 10000).toFixed(2)}万 (${(status.todayPnlPct * 100).toFixed(2)}%)`);
  
  if (status.consecutiveLosses.length > 0) {
    lines.push(`连续亏损:`);
    for (const l of status.consecutiveLosses.slice(0, 3)) {
      lines.push(`  ${l.code}: ${l.consecutiveLosses}笔 (${(l.totalLossAmount / 10000).toFixed(2)}万)`);
    }
  }
  
  if (Object.keys(status.sectorExposure).length > 0) {
    lines.push(`板块集中度:`);
    for (const [sector, pct] of Object.entries(status.sectorExposure)) {
      if (pct > 0.05) {  // 只显示 >5% 的
        lines.push(`  ${sector}: ${(pct * 100).toFixed(1)}%`);
      }
    }
  }
  
  return lines.join('\n');
}
