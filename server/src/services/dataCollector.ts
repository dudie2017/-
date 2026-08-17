/**
 * 数据收集服务
 * 负责收集和存储历史数据（资金流向、仓单等）
 */

import { analyzeVarietyCapitalFlow } from './capitalFlow';
import { getWarehouseReceiptsSummary } from './dceApi';
import { saveCapitalFlowRecord, saveWarehouseReceiptRecord, getCapitalFlowHistory, getWarehouseReceiptHistory } from './database';
import { VARIETIES } from './varieties';

// DCE品种代码映射
const DCE_VARIETIES: Record<string, string> = {
  'A': 'a', 'B': 'b', 'C': 'c', 'CS': 'cs', 'M': 'm', 'Y': 'y',
  'P': 'p', 'O': 'o', 'L': 'l', 'V': 'v', 'PP': 'pp', 'J': 'j',
  'JM': 'jm', 'I': 'i', 'EG': 'eg', 'EB': 'eb', 'PG': 'pg',
  'LH': 'lh', 'RR': 'rr', 'JD': 'jd', 'FB': 'fb', 'BB': 'bb',
};

/**
 * 收集资金流向数据
 */
export async function collectCapitalFlowData(tradeDate: string): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let collected = 0;

  for (const [code, name] of Object.entries(VARIETIES)) {
    try {
      // 获取资金流向数据
      const flowData = await analyzeVarietyCapitalFlow(code, tradeDate);
      
      if (flowData && flowData.flowIndicators) {
        const indicators = flowData.flowIndicators;
        const volumeAnalysis = flowData.volumeAnalysis || {};
        const signals = flowData.signals || {};
        
        saveCapitalFlowRecord({
          trade_date: tradeDate,
          code: code,
          name: name,
          top5_volume: volumeAnalysis.top5Volume || 0,
          top5_volume_ratio: volumeAnalysis.top5VolumeRatio || 0,
          top5_volume_change: volumeAnalysis.top5VolumeChange || 0,
          top5_long: 0, // 需要从原始数据获取
          top5_short: 0, // 需要从原始数据获取
          net_position: indicators.netPosition || 0,
          net_position_change: indicators.netPositionChange || 0,
          concentration_index: indicators.concentrationIndex || 0,
          smart_money_direction: indicators.smartMoneyDirection || 'NEUTRAL',
          smart_money_confidence: 0, // 需要从原始数据获取
          signal_type: signals.type || 'NEUTRAL',
          signal_confidence: signals.confidence || 0,
          close_price: 0, // 需要从行情数据获取
          price_change_pct: 0,
        });
        collected++;
      }
    } catch (error) {
      errors.push(`${code}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  return { success: errors.length === 0, collected, errors };
}

/**
 * 收集仓单数据
 */
export async function collectWarehouseReceiptData(tradeDate: string): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let collected = 0;

  try {
    // 获取仓单汇总数据 - 返回的是数组
    const summary = await getWarehouseReceiptsSummary(tradeDate);
    
    if (summary && Array.isArray(summary)) {
      for (const item of summary) {
        // 转换品种代码
        const dceCode = item.variety;
        const code = Object.keys(DCE_VARIETIES).find(k => DCE_VARIETIES[k] === dceCode);
        
        if (code && VARIETIES[code]) {
          const name = VARIETIES[code];
          const qty = item.receipt || 0;
          const diff = item.receiptChg || 0;
          const changePct = qty > 0 ? (diff / (qty - diff)) * 100 : 0;
          
          // 判断供需信号
          let signal = 'balanced';
          if (diff > 0 && changePct > 5) signal = 'supply_excess';
          else if (diff < 0 && changePct < -5) signal = 'demand_excess';
          
          saveWarehouseReceiptRecord({
            trade_date: tradeDate,
            code: code,
            name: name,
            receipt_qty: qty,
            receipt_change: diff,
            receipt_change_pct: changePct,
            warehouse_distribution: '{}',
            supply_demand_signal: signal,
            supply_demand_score: Math.round(changePct * 10),
          });
          collected++;
        }
      }
    }
  } catch (error) {
    errors.push(`仓单数据: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  return { success: errors.length === 0, collected, errors };
}

/**
 * 收集所有数据
 */
export async function collectAllData(tradeDate: string): Promise<{
  success: boolean;
  capitalFlow: { collected: number; errors: string[] };
  warehouseReceipt: { collected: number; errors: string[] };
}> {
  const [capitalFlow, warehouseReceipt] = await Promise.all([
    collectCapitalFlowData(tradeDate),
    collectWarehouseReceiptData(tradeDate),
  ]);

  return {
    success: capitalFlow.success && warehouseReceipt.success,
    capitalFlow: { collected: capitalFlow.collected, errors: capitalFlow.errors },
    warehouseReceipt: { collected: warehouseReceipt.collected, errors: warehouseReceipt.errors },
  };
}

/**
 * 获取最新交易日期
 */
export function getLatestTradeDate(): string | null {
  const records = getWarehouseReceiptHistory({ limit: 1 });
  if (records.length > 0) {
    return records[0].trade_date;
  }
  return null;
}

/**
 * 获取品种分析报告
 */
export function getVarietyAnalysisReport(code: string, days: number = 30): {
  capitalFlow: any[];
  warehouseReceipt: any[];
  trend: string;
  recommendation: string;
  overallSignal: string;
  confidence: number;
  bullishFactors: string[];
  bearishFactors: string[];
} {
  const capitalFlow = getCapitalFlowHistory({ code, limit: days });
  const warehouseReceipt = getWarehouseReceiptHistory({ code, limit: days });
  
  // 分析趋势
  let trend = 'neutral';
  let overallSignal = 'NEUTRAL';
  let confidence = 0;
  const bullishFactors: string[] = [];
  const bearishFactors: string[] = [];
  
  if (capitalFlow.length >= 3) {
    const recent = capitalFlow.slice(0, 3);
    const avgNetPosition = recent.reduce((sum, r) => sum + r.net_position, 0) / 3;
    if (avgNetPosition > 0) {
      trend = 'bullish';
      overallSignal = 'LONG';
      confidence = Math.min(80, Math.abs(avgNetPosition) / 1000 * 10);
      bullishFactors.push('主力资金净流入');
    } else if (avgNetPosition < 0) {
      trend = 'bearish';
      overallSignal = 'SHORT';
      confidence = Math.min(80, Math.abs(avgNetPosition) / 1000 * 10);
      bearishFactors.push('主力资金净流出');
    }
  }
  
  // 分析仓单
  if (warehouseReceipt.length > 0) {
    const latestWR = warehouseReceipt[0];
    if (latestWR.supply_demand_signal === 'demand_excess') {
      bullishFactors.push('仓单减少，需求旺盛');
      if (overallSignal === 'NEUTRAL') {
        overallSignal = 'LONG';
        confidence = 60;
      }
    } else if (latestWR.supply_demand_signal === 'supply_excess') {
      bearishFactors.push('仓单增加，供应过剩');
      if (overallSignal === 'NEUTRAL') {
        overallSignal = 'SHORT';
        confidence = 60;
      }
    }
  }
  
  // 生成建议
  let recommendation = '观望';
  if (trend === 'bullish' && warehouseReceipt.length > 0) {
    const latestWR = warehouseReceipt[0];
    if (latestWR.supply_demand_signal === 'demand_excess') {
      recommendation = '逢低做多';
    } else if (latestWR.supply_demand_signal === 'balanced') {
      recommendation = '谨慎做多';
    }
  } else if (trend === 'bearish' && warehouseReceipt.length > 0) {
    const latestWR = warehouseReceipt[0];
    if (latestWR.supply_demand_signal === 'supply_excess') {
      recommendation = '逢高做空';
    } else if (latestWR.supply_demand_signal === 'balanced') {
      recommendation = '谨慎做空';
    }
  }
  
  return {
    capitalFlow,
    warehouseReceipt,
    trend,
    recommendation,
    overallSignal,
    confidence,
    bullishFactors,
    bearishFactors,
  };
}
