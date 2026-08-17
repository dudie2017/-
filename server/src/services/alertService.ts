/**
 * 预警服务
 * 检测聪明钱方向与价格趋势的背离，以及其他重要信号
 */

import { getCapitalFlowHistory, getWarehouseReceiptHistory } from './database.js';
import { VARIETIES } from './varieties.js';

export interface Alert {
  id: string;
  type: 'divergence' | 'signal_change' | 'warehouse_anomaly' | 'strong_signal';
  severity: 'high' | 'medium' | 'low';
  code: string;
  name: string;
  title: string;
  message: string;
  timestamp: string;
  data?: any;
}

/**
 * 检测聪明钱方向与价格趋势的背离
 * 背离情况：
 * - 价格上涨但聪明钱做空（看跌背离）
 * - 价格下跌但聪明钱做多（看涨背离）
 */
export function detectSmartMoneyDivergence(code: string, days: number = 5): Alert | null {
  const history = getCapitalFlowHistory({ code, limit: days });
  
  if (history.length < 3) {
    return null;
  }

  const name = VARIETIES[code] || code;
  const latest = history[0];
  
  // 计算价格趋势
  const priceChange = latest.close_price - history[history.length - 1].close_price;
  const priceTrend = priceChange > 0 ? 'up' : priceChange < 0 ? 'down' : 'neutral';
  
  // 聪明钱方向
  const smartMoneyDir = latest.smart_money_direction;
  
  // 检测背离
  let divergenceType: string | null = null;
  let severity: 'high' | 'medium' | 'low' = 'medium';
  
  if (priceTrend === 'up' && smartMoneyDir === 'SHORT') {
    divergenceType = 'bearish_divergence';
    // 如果价格涨幅大且聪明钱持续做空，提高严重性
    if (priceChange > 50 && history.filter(h => h.smart_money_direction === 'SHORT').length >= 3) {
      severity = 'high';
    }
  } else if (priceTrend === 'down' && smartMoneyDir === 'LONG') {
    divergenceType = 'bullish_divergence';
    // 如果价格跌幅大且聪明钱持续做多，提高严重性
    if (priceChange < -50 && history.filter(h => h.smart_money_direction === 'LONG').length >= 3) {
      severity = 'high';
    }
  }
  
  if (!divergenceType) {
    return null;
  }
  
  const isBearish = divergenceType === 'bearish_divergence';
  
  return {
    id: `divergence_${code}_${Date.now()}`,
    type: 'divergence',
    severity,
    code,
    name,
    title: isBearish ? '看跌背离警告' : '看涨背离信号',
    message: isBearish
      ? `${name}价格上涨${priceChange.toFixed(0)}点，但聪明钱持续做空。可能预示趋势反转，建议谨慎追多。`
      : `${name}价格下跌${Math.abs(priceChange).toFixed(0)}点，但聪明钱持续做多。可能预示底部形成，关注做多机会。`,
    timestamp: new Date().toISOString(),
    data: {
      priceChange,
      priceTrend,
      smartMoneyDirection: smartMoneyDir,
      divergenceType,
      days
    }
  };
}

/**
 * 检测信号变化
 * 当品种的信号从强多变为强空，或反之
 */
export function detectSignalChange(code: string): Alert | null {
  const history = getCapitalFlowHistory({ code, limit: 2 });
  
  if (history.length < 2) {
    return null;
  }
  
  const name = VARIETIES[code] || code;
  const current = history[0];
  const previous = history[1];
  
  // 检测信号强度变化
  const currentStrength = current.signal_confidence;
  const previousStrength = previous.signal_confidence;
  const change = currentStrength - previousStrength;
  
  // 检测方向变化
  const currentDir = current.smart_money_direction;
  const previousDir = previous.smart_money_direction;
  
  if (currentDir !== previousDir && Math.abs(change) > 20) {
    const isBullishChange = currentDir === 'LONG' && previousDir === 'SHORT';
    
    return {
      id: `signal_change_${code}_${Date.now()}`,
      type: 'signal_change',
      severity: Math.abs(change) > 40 ? 'high' : 'medium',
      code,
      name,
      title: isBullishChange ? '信号转多' : '信号转空',
      message: `${name}聪明钱方向从${previousDir === 'LONG' ? '多' : '空'}转为${currentDir === 'LONG' ? '多' : '空'}，信号强度变化${change > 0 ? '+' : ''}${change.toFixed(0)}%。`,
      timestamp: new Date().toISOString(),
      data: {
        previousDirection: previousDir,
        currentDirection: currentDir,
        signalChange: change
      }
    };
  }
  
  return null;
}

/**
 * 检测仓单异常
 * 当仓单变化超过阈值时发出预警
 */
export function detectWarehouseAnomaly(code: string): Alert | null {
  const history = getWarehouseReceiptHistory({ code, limit: 2 });
  
  if (history.length < 2) {
    return null;
  }
  
  const name = VARIETIES[code] || code;
  const current = history[0];
  const previous = history[1];
  
  const change = current.receipt_qty - previous.receipt_qty;
  const changePct = previous.receipt_qty > 0 ? (change / previous.receipt_qty) * 100 : 0;
  
  // 阈值：变化超过10%或500手
  const threshold = Math.max(500, previous.receipt_qty * 0.1);
  
  if (Math.abs(change) > threshold) {
    const isIncrease = change > 0;
    
    return {
      id: `warehouse_${code}_${Date.now()}`,
      type: 'warehouse_anomaly',
      severity: Math.abs(changePct) > 20 ? 'high' : 'medium',
      code,
      name,
      title: isIncrease ? '仓单大幅增加' : '仓单大幅减少',
      message: isIncrease
        ? `${name}仓单增加${change}手(${changePct.toFixed(1)}%)，供应压力增大，可能利空。`
        : `${name}仓单减少${Math.abs(change)}手(${Math.abs(changePct).toFixed(1)}%)，供应紧张，可能利多。`,
      timestamp: new Date().toISOString(),
      data: {
        previousQty: previous.receipt_qty,
        currentQty: current.receipt_qty,
        change,
        changePct
      }
    };
  }
  
  return null;
}

/**
 * 检测强信号
 * 当信号强度超过阈值时发出预警
 */
export function detectStrongSignal(code: string): Alert | null {
  const history = getCapitalFlowHistory({ code, limit: 1 });
  
  if (history.length === 0) {
    return null;
  }
  
  const name = VARIETIES[code] || code;
  const latest = history[0];
  
  // 阈值：信号强度超过80%
  if (latest.signal_confidence >= 80) {
    const isBullish = latest.signal_type.includes('LONG') || latest.smart_money_direction === 'LONG';
    
    return {
      id: `strong_signal_${code}_${Date.now()}`,
      type: 'strong_signal',
      severity: latest.signal_confidence >= 90 ? 'high' : 'medium',
      code,
      name,
      title: isBullish ? '强做多信号' : '强做空信号',
      message: `${name}出现${isBullish ? '做多' : '做空'}信号，置信度${latest.signal_confidence}%。聪明钱方向一致，建议关注。`,
      timestamp: new Date().toISOString(),
      data: {
        signalType: latest.signal_type,
        confidence: latest.signal_confidence,
        direction: latest.smart_money_direction
      }
    };
  }
  
  return null;
}

/**
 * 获取所有预警
 */
export function getAllAlerts(): Alert[] {
  const alerts: Alert[] = [];
  const dceVarieties = ['A', 'B', 'M', 'Y', 'P', 'C', 'CS', 'JD', 'L', 'V', 'PP', 'J', 'JM', 'I', 'EG', 'EB', 'PG', 'LH'];
  
  for (const code of dceVarieties) {
    // 检测背离
    const divergence = detectSmartMoneyDivergence(code);
    if (divergence) alerts.push(divergence);
    
    // 检测信号变化
    const signalChange = detectSignalChange(code);
    if (signalChange) alerts.push(signalChange);
    
    // 检测仓单异常
    const warehouse = detectWarehouseAnomaly(code);
    if (warehouse) alerts.push(warehouse);
    
    // 检测强信号
    const strongSignal = detectStrongSignal(code);
    if (strongSignal) alerts.push(strongSignal);
  }
  
  // 按严重性排序
  const severityOrder = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);
  
  return alerts;
}

/**
 * 获取特定品种的预警
 */
export function getVarietyAlerts(code: string): Alert[] {
  const alerts: Alert[] = [];
  
  const divergence = detectSmartMoneyDivergence(code);
  if (divergence) alerts.push(divergence);
  
  const signalChange = detectSignalChange(code);
  if (signalChange) alerts.push(signalChange);
  
  const warehouse = detectWarehouseAnomaly(code);
  if (warehouse) alerts.push(warehouse);
  
  const strongSignal = detectStrongSignal(code);
  if (strongSignal) alerts.push(strongSignal);
  
  return alerts;
}

/**
 * 获取智能预警（高严重性）
 */
export function getSmartAlerts(): Alert[] {
  const alerts = getAllAlerts();
  return alerts.filter(a => a.severity === 'high' || a.severity === 'medium');
}

/**
 * 检查并生成预警（同 getAllAlerts）
 */
export function checkAndGenerateAlerts(): Alert[] {
  return getAllAlerts();
}

/**
 * 清除所有预警（内存中无状态，返回成功）
 */
export function clearAlerts(): void {
  // 预警是实时检测的，没有持久化状态需要清除
  console.log('Alerts cleared (no persistent state)');
}
