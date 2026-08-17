/**
 * 供需分析服务
 * 整合仓单数据分析供需平衡
 */

import { getWarehouseReceiptHistory, getCapitalFlowHistory } from './database.js';
import { VARIETIES } from './varieties.js';
import { VARIETY_MAP } from './tushareApi.js';

export interface SupplyDemandAnalysis {
  code: string;
  name: string;
  tradeDate: string;
  dataSufficient?: boolean;
  
  // 供应端指标
  supply: {
    warehouseReceipts: number;      // 仓单量
    receiptChange: number;          // 仓单变化
    receiptChangePct: number;       // 仓单变化百分比
    supplyTrend: 'increasing' | 'decreasing' | 'stable';  // 供应趋势
    supplyPressure: 'high' | 'medium' | 'low';  // 供应压力
    historyDays?: number;           // 历史数据天数
  };
  
  // 需求端指标
  demand: {
    smartMoneyDirection: string;    // 聪明钱方向
    netPosition: number;            // 净持仓
    positionChange: number;         // 持仓变化
    volumeTrend: 'increasing' | 'decreasing' | 'stable';  // 成交量趋势
    demandStrength: 'strong' | 'medium' | 'weak';  // 需求强度
  };
  
  // 供需平衡指标
  balance: {
    signal: 'supply_excess' | 'demand_excess' | 'balanced';  // 供需信号
    score: number;  // -100到100，负数表示供应过剩，正数表示需求过剩
    description: string;
  };
  
  // 价格影响预判
  priceImpact: {
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number;  // 0-100
    factors: string[];
  };
  
  // 交易建议
  recommendation: {
    action: 'long' | 'short' | 'wait';
    reason: string;
    riskLevel: 'high' | 'medium' | 'low';
  };
}

/**
 * 分析单个品种的供需状况
 */
export function analyzeSupplyDemand(code: string): SupplyDemandAnalysis | null {
  // 优先使用 Tushare 的品种名称映射，其次使用本地的 VARIETIES（带0后缀）
  const name = VARIETY_MAP[code] || VARIETIES[code + '0'] || VARIETIES[code] || code;
  
  // 获取仓单历史
  const warehouseHistory = getWarehouseReceiptHistory({ code, limit: 7 });
  if (warehouseHistory.length === 0) {
    return null;
  }
  
  // 获取资金流向历史
  const capitalFlowHistory = getCapitalFlowHistory({ code, limit: 7 });
  
  const latestWarehouse = warehouseHistory[0];
  const previousWarehouse = warehouseHistory.length > 1 ? warehouseHistory[1] : null;
  
  // 计算供应端指标
  const warehouseReceipts = latestWarehouse.receipt_qty;
  const receiptChange = previousWarehouse 
    ? warehouseReceipts - previousWarehouse.receipt_qty 
    : latestWarehouse.receipt_change;
  const receiptChangePct = previousWarehouse && previousWarehouse.receipt_qty > 0
    ? (receiptChange / previousWarehouse.receipt_qty) * 100
    : 0;
  
  // 供应趋势
  let supplyTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  if (warehouseHistory.length >= 3) {
    const recentChanges = warehouseHistory.slice(0, 3).map(w => w.receipt_change);
    const avgChange = recentChanges.reduce((a, b) => a + b, 0) / recentChanges.length;
    if (avgChange > 100) supplyTrend = 'increasing';
    else if (avgChange < -100) supplyTrend = 'decreasing';
  }
  
  // 供应压力
  let supplyPressure: 'high' | 'medium' | 'low' = 'medium';
  if (supplyTrend === 'increasing' && receiptChangePct > 5) supplyPressure = 'high';
  else if (supplyTrend === 'decreasing' && receiptChangePct < -5) supplyPressure = 'low';
  
  // 计算需求端指标
  let smartMoneyDirection = 'NEUTRAL';
  let netPosition = 0;
  let positionChange = 0;
  let volumeTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
  
  if (capitalFlowHistory.length > 0) {
    const latestCapital = capitalFlowHistory[0];
    smartMoneyDirection = latestCapital.smart_money_direction;
    netPosition = latestCapital.net_position;
    positionChange = latestCapital.net_position_change;
    
    if (capitalFlowHistory.length >= 3) {
      const recentVolumes = capitalFlowHistory.slice(0, 3).map(c => c.top5_volume);
      const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
      const latestVolume = recentVolumes[0];
      if (latestVolume > avgVolume * 1.1) volumeTrend = 'increasing';
      else if (latestVolume < avgVolume * 0.9) volumeTrend = 'decreasing';
    }
  }
  
  // 需求强度
  let demandStrength: 'strong' | 'medium' | 'weak' = 'medium';
  if (smartMoneyDirection === 'LONG' && netPosition > 0) demandStrength = 'strong';
  else if (smartMoneyDirection === 'SHORT' && netPosition < 0) demandStrength = 'weak';
  
  // 计算供需平衡指标
  let balanceScore = 0;
  const factors: string[] = [];
  
  // 仓单变化影响（-30到30分）
  if (receiptChangePct > 10) {
    balanceScore -= 30;
    factors.push('仓单大幅增加，供应压力增大');
  } else if (receiptChangePct > 5) {
    balanceScore -= 15;
    factors.push('仓单增加，供应压力上升');
  } else if (receiptChangePct < -10) {
    balanceScore += 30;
    factors.push('仓单大幅减少，供应紧张');
  } else if (receiptChangePct < -5) {
    balanceScore += 15;
    factors.push('仓单减少，供应趋紧');
  }
  
  // 聪明钱方向影响（-40到40分）
  if (smartMoneyDirection === 'LONG' && netPosition > 1000) {
    balanceScore += 40;
    factors.push('聪明钱大幅做多');
  } else if (smartMoneyDirection === 'LONG') {
    balanceScore += 20;
    factors.push('聪明钱做多');
  } else if (smartMoneyDirection === 'SHORT' && netPosition < -1000) {
    balanceScore -= 40;
    factors.push('聪明钱大幅做空');
  } else if (smartMoneyDirection === 'SHORT') {
    balanceScore -= 20;
    factors.push('聪明钱做空');
  }
  
  // 仓单绝对值影响（用于数据不足时的补充判断）
  // 高仓单 = 供应压力大，低仓单 = 供应紧张
  if (warehouseReceipts > 10000) {
    balanceScore -= 10;
    factors.push('仓单处于高位，供应压力');
  } else if (warehouseReceipts < 1000 && warehouseReceipts > 0) {
    balanceScore += 10;
    factors.push('仓单处于低位，供应紧张');
  }
  
  // 供需信号（降低阈值，使分析更敏感）
  let balanceSignal: 'supply_excess' | 'demand_excess' | 'balanced' = 'balanced';
  if (balanceScore < -15) balanceSignal = 'supply_excess';
  else if (balanceScore > 15) balanceSignal = 'demand_excess';
  
  // 数据充足性判断
  const hasWarehouseHistory = warehouseHistory.length >= 2;
  const hasCapitalHistory = capitalFlowHistory.length >= 2;
  const dataSufficient = hasWarehouseHistory || hasCapitalHistory;
  
  let balanceDescription = '';
  if (!dataSufficient && balanceScore === 0) {
    balanceDescription = '数据不足，需要积累更多历史数据';
  } else if (balanceSignal === 'supply_excess') {
    balanceDescription = '供应过剩，仓单增加且聪明钱看空';
  } else if (balanceSignal === 'demand_excess') {
    balanceDescription = '需求旺盛，仓单减少且聪明钱看多';
  } else {
    balanceDescription = '供需平衡，市场处于观望状态';
  }
  
  // 价格影响预判
  let priceDirection: 'bullish' | 'bearish' | 'neutral' = 'neutral';
  let priceConfidence = 50;
  
  if (balanceScore > 30) {
    priceDirection = 'bullish';
    priceConfidence = Math.min(90, 50 + balanceScore);
  } else if (balanceScore < -30) {
    priceDirection = 'bearish';
    priceConfidence = Math.min(90, 50 + Math.abs(balanceScore));
  }
  
  // 交易建议
  let action: 'long' | 'short' | 'wait' = 'wait';
  let reason = '供需平衡，建议观望';
  let riskLevel: 'high' | 'medium' | 'low' = 'medium';
  
  if (balanceScore > 40 && priceDirection === 'bullish') {
    action = 'long';
    reason = '需求旺盛，供应趋紧，建议逢低做多';
    riskLevel = balanceScore > 60 ? 'low' : 'medium';
  } else if (balanceScore < -40 && priceDirection === 'bearish') {
    action = 'short';
    reason = '供应过剩，需求疲软，建议逢高做空';
    riskLevel = balanceScore < -60 ? 'low' : 'medium';
  }
  
  return {
    code,
    name,
    tradeDate: latestWarehouse.trade_date,
    dataSufficient,
    supply: {
      warehouseReceipts,
      receiptChange,
      receiptChangePct,
      supplyTrend,
      supplyPressure,
      historyDays: warehouseHistory.length
    },
    demand: {
      smartMoneyDirection,
      netPosition,
      positionChange,
      volumeTrend,
      demandStrength
    },
    balance: {
      signal: balanceSignal,
      score: balanceScore,
      description: balanceDescription
    },
    priceImpact: {
      direction: priceDirection,
      confidence: priceConfidence,
      factors
    },
    recommendation: {
      action,
      reason,
      riskLevel
    }
  };
}

/**
 * 获取所有品种的供需分析
 */
export function getAllSupplyDemandAnalysis(): SupplyDemandAnalysis[] {
  // 所有交易所的品种代码
  const allVarieties = [
    // 大商所
    'A', 'B', 'M', 'Y', 'P', 'C', 'CS', 'JD', 'L', 'V', 'PP', 'J', 'JM', 'I', 'EG', 'EB', 'PG', 'LH',
    // 郑商所
    'CF', 'CY', 'SR', 'TA', 'OI', 'RM', 'MA', 'FG', 'SA', 'UR', 'AP', 'CJ', 'PK', 'SF', 'SM',
    // 上期所
    'CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'AU', 'AG', 'RB', 'HC', 'SS', 'BU', 'RU', 'FU', 'SP', 'NR', 'LU', 'BC', 'AO', 'BR',
    // 中金所
    'IF', 'IH', 'IC', 'IM', 'T', 'TF', 'TS', 'TL',
    // 广期所
    'SI', 'LC',
  ];
  
  const results: SupplyDemandAnalysis[] = [];
  
  for (const code of allVarieties) {
    const analysis = analyzeSupplyDemand(code);
    if (analysis) {
      results.push(analysis);
    }
  }
  
  // 按供需评分排序
  results.sort((a, b) => b.balance.score - a.balance.score);
  
  return results;
}

/**
 * 获取供需失衡的品种（供应过剩或需求过剩）
 */
export function getImbalancedVarieties(): SupplyDemandAnalysis[] {
  const all = getAllSupplyDemandAnalysis();
  return all.filter(a => a.balance.signal !== 'balanced');
}
