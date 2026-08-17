/**
 * 交易成本建模服务
 * 
 * 为回测引擎提供真实的手续费 + 滑点模型：
 * - 手续费：按合约规格（固定金额或比例）
 * - 滑点：基于 ATR 百分比估算（流动性差异）
 * - 涨跌停检测：无法成交场景
 * 
 * 目标：让回测结果更接近真实交易
 */

import { getSpec } from './backtestEngine.js';

// 交易成本配置
export interface TradingCostConfig {
  /** 滑点模型：按 ATR 的百分比（默认 0.1 = 10% ATR） */
  slippageAtrPct: number;
  /** 最低滑点（元），防止 ATR 极小时滑点失真 */
  minSlippage: number;
  /** 手续费倍率（考虑券商加收，默认 1.0 = 交易所标准） */
  commissionMultiplier: number;
}

const DEFAULT_COST_CONFIG: TradingCostConfig = {
  slippageAtrPct: 0.1,
  minSlippage: 1,
  commissionMultiplier: 1.0,
};

// 品种手续费率表（按合约价值比例收取的品种，非 DCE 官方数据时使用）
// 格式：{ code: { openRate, closeRate, closeTodayRate } }
const FEE_RATE_TABLE: Record<string, { openRate: number; closeRate: number; closeTodayRate?: number }> = {
  // 上期所（按比例）
  CU: { openRate: 0.00005, closeRate: 0.00005 },
  AL: { openRate: 0.0001, closeRate: 0.0001 },
  ZN: { openRate: 3, closeRate: 3 },  // 固定3元/手
  NI: { openRate: 3, closeRate: 3 },
  AU: { openRate: 10, closeRate: 10 },
  AG: { openRate: 0.00005, closeRate: 0.00005 },
  RB: { openRate: 0.0001, closeRate: 0.0001 },
  HC: { openRate: 0.0001, closeRate: 0.0001 },
  BU: { openRate: 0.0001, closeRate: 0.0001 },
  RU: { openRate: 3, closeRate: 3 },
  FU: { openRate: 0.0001, closeRate: 0.0001 },
  SP: { openRate: 0.00005, closeRate: 0.00005 },
  SS: { openRate: 0.0001, closeRate: 0.0001 },
  // 大商所
  I: { openRate: 0.0001, closeRate: 0.0001 },
  J: { openRate: 0.0001, closeRate: 0.0001, closeTodayRate: 0.0003 },
  JM: { openRate: 0.0001, closeRate: 0.0001, closeTodayRate: 0.0003 },
  M: { openRate: 1.5, closeRate: 1.5 },
  Y: { openRate: 2, closeRate: 2 },
  P: { openRate: 2.5, closeRate: 2.5 },
  C: { openRate: 1.2, closeRate: 1.2 },
  JD: { openRate: 0.00015, closeRate: 0.00015 },
  L: { openRate: 1, closeRate: 1 },
  V: { openRate: 1, closeRate: 1 },
  PP: { openRate: 0.6, closeRate: 0.6 },  // 极低
  EB: { openRate: 0.0001, closeRate: 0.0001, closeTodayRate: 0.0002 },
  EG: { openRate: 3, closeRate: 3 },
  PG: { openRate: 6, closeRate: 6 },
  LH: { openRate: 0.0002, closeRate: 0.0002 },
  // 郑商所
  CF: { openRate: 4.3, closeRate: 4.3 },
  SR: { openRate: 3, closeRate: 3 },
  TA: { openRate: 3, closeRate: 3 },
  MA: { openRate: 2, closeRate: 2, closeTodayRate: 6 },
  FG: { openRate: 6, closeRate: 6, closeTodayRate: 6 },
  SA: { openRate: 3.5, closeRate: 3.5, closeTodayRate: 10 },
  UR: { openRate: 5, closeRate: 5, closeTodayRate: 10 },
  OI: { openRate: 2, closeRate: 2 },
  RM: { openRate: 1.5, closeRate: 1.5 },
  AP: { openRate: 5, closeRate: 5, closeTodayRate: 20 },
  // 广期所
  SI: { openRate: 0.0001, closeRate: 0.0001, closeTodayRate: 0.0004 },
  LC: { openRate: 0.0001, closeRate: 0.0001, closeTodayRate: 0.0002 },
  // 上期能源
  SC: { openRate: 20, closeRate: 20 },
  // 中金所
  IF: { openRate: 0.000023, closeRate: 0.000023, closeTodayRate: 0.00069 },
  IC: { openRate: 0.000023, closeRate: 0.000023, closeTodayRate: 0.00069 },
  IM: { openRate: 0.000023, closeRate: 0.000023, closeTodayRate: 0.00046 },
  IH: { openRate: 0.000023, closeRate: 0.000023, closeTodayRate: 0.00069 },
};

// 合约乘数表（补充 backtestEngine 的 CONTRACT_SPECS）
const MULTIPLIER_TABLE: Record<string, number> = {
  CU: 5, AL: 5, ZN: 5, NI: 1, AU: 1000, AG: 15,
  RB: 10, HC: 10, BU: 10, RU: 10, FU: 10, SP: 10, SS: 5,
  I: 100, J: 100, JM: 60, M: 10, Y: 10, P: 10, C: 10, CS: 10,
  JD: 5, L: 5, V: 5, PP: 5, EB: 5, EG: 10, PG: 20, LH: 16,
  CF: 5, SR: 10, TA: 5, MA: 10, FG: 20, SA: 20, UR: 20,
  OI: 10, RM: 10, AP: 10, PK: 5,
  SI: 5, LC: 500, SC: 1000,
  IF: 300, IC: 200, IM: 200, IH: 300,
  T: 10000, TF: 10000, TS: 20000,
};

function getMultiplier(code: string): number {
  const key = code.replace(/\d/g, '').replace(/0$/, '').toUpperCase();
  return MULTIPLIER_TABLE[key] || 10;
}

/**
 * 交易成本计算结果
 */
export interface TradeCostResult {
  /** 开仓手续费 */
  openCommission: number;
  /** 平仓手续费 */
  closeCommission: number;
  /** 总手续费 */
  totalCommission: number;
  /** 单边滑点（开仓） */
  openSlippage: number;
  /** 单边滑点（平仓） */
  closeSlippage: number;
  /** 总滑点成本 */
  totalSlippage: number;
  /** 总交易成本（手续费 + 滑点） */
  totalCost: number;
  /** 成本占合约价值比例 */
  costRatio: number;
  /** 保本点数（价格需要移动多少才能覆盖成本） */
  breakevenPoints: number;
}

/**
 * 计算单笔交易的完整成本
 * 
 * @param code 品种代码
 * @param entryPrice 入场价
 * @param exitPrice 出场价
 * @param atr ATR值（用于滑点估算）
 * @param isTodayClose 是否日内平仓（影响平今手续费）
 * @param config 成本配置
 */
export function calcTradeCost(
  code: string,
  entryPrice: number,
  exitPrice: number,
  atr: number,
  isTodayClose: boolean = false,
  config: Partial<TradingCostConfig> = {},
): TradeCostResult {
  const cfg = { ...DEFAULT_COST_CONFIG, ...config };
  const key = code.replace(/\d/g, '').replace(/0$/, '').toUpperCase();
  const multiplier = getMultiplier(code);
  const contractValue = entryPrice * multiplier;

  // === 手续费 ===
  let openCommission = 0;
  let closeCommission = 0;
  const feeRate = FEE_RATE_TABLE[key];

  if (feeRate) {
    const openRate = feeRate.openRate;
    const closeRate = (isTodayClose && feeRate.closeTodayRate) ? feeRate.closeTodayRate : feeRate.closeRate;

    if (openRate < 0.01) {
      // 按比例收取
      openCommission = contractValue * openRate;
      closeCommission = exitPrice * multiplier * closeRate;
    } else {
      // 固定金额
      openCommission = openRate;
      closeCommission = closeRate;
    }
  } else {
    // 兜底：按合约价值的万分之一
    openCommission = contractValue * 0.0001;
    closeCommission = exitPrice * multiplier * 0.0001;
  }

  // 应用手续费倍率
  openCommission *= cfg.commissionMultiplier;
  closeCommission *= cfg.commissionMultiplier;

  // === 滑点 ===
  // 滑点 = ATR × slippageAtrPct，但不低于 minSlippage
  const slippagePerTrade = Math.max(atr * cfg.slippageAtrPct, cfg.minSlippage);
  // 按最小变动价位取整
  const spec = getSpec(code);
  const tick = spec.tickSize || 1;
  const roundedSlippage = Math.ceil(slippagePerTrade / tick) * tick;

  const openSlippage = roundedSlippage * multiplier;
  const closeSlippage = roundedSlippage * multiplier;

  // === 汇总 ===
  const totalCommission = openCommission + closeCommission;
  const totalSlippage = openSlippage + closeSlippage;
  const totalCost = totalCommission + totalSlippage;
  const costRatio = contractValue > 0 ? totalCost / (contractValue * 2) : 0; // 开+平两次
  const breakevenPoints = multiplier > 0 ? totalCost / multiplier : 0;

  return {
    openCommission: Math.round(openCommission * 100) / 100,
    closeCommission: Math.round(closeCommission * 100) / 100,
    totalCommission: Math.round(totalCommission * 100) / 100,
    openSlippage: Math.round(openSlippage * 100) / 100,
    closeSlippage: Math.round(closeSlippage * 100) / 100,
    totalSlippage: Math.round(totalSlippage * 100) / 100,
    totalCost: Math.round(totalCost * 100) / 100,
    costRatio: Math.round(costRatio * 10000) / 10000,
    breakevenPoints: Math.round(breakevenPoints * 100) / 100,
  };
}

/**
 * 估算品种的流动性等级（影响滑点大小）
 * 
 * 基于日均成交量估算：
 * - 高流动性（螺纹、铁矿等）：滑点小
 * - 中流动性（化工品等）：滑点中等
 * - 低流动性（苹果、红枣等）：滑点大
 */
export function estimateLiquidityLevel(code: string): 'high' | 'medium' | 'low' {
  const key = code.replace(/\d/g, '').replace(/0$/, '').toUpperCase();
  const HIGH_LIQUIDITY = ['RB', 'I', 'M', 'AG', 'AU', 'CU', 'AL', 'MA', 'TA', 'PP', 'L', 'HC', 'J', 'JM'];
  const LOW_LIQUIDITY = ['AP', 'CJ', 'PK', 'LH', 'UR', 'SA', 'FG', 'SI', 'LC', 'PS', 'JD'];

  if (HIGH_LIQUIDITY.includes(key)) return 'high';
  if (LOW_LIQUIDITY.includes(key)) return 'low';
  return 'medium';
}

/**
 * 根据流动性等级调整滑点参数
 */
export function getSlippageConfig(code: string): Partial<TradingCostConfig> {
  const level = estimateLiquidityLevel(code);
  switch (level) {
    case 'high':
      return { slippageAtrPct: 0.05, minSlippage: 1 };
    case 'low':
      return { slippageAtrPct: 0.2, minSlippage: 2 };
    default:
      return { slippageAtrPct: 0.1, minSlippage: 1 };
  }
}
