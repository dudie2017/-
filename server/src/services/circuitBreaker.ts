/**
 * 风控熔断机制
 * 基于Brooks Price Action交易系统的风险控制规则
 */

import * as db from './database.js';

/**
 * 熔断类型
 */
export type CircuitBreakerType = 'basis_deviation' | 'warehouse_receipt' | 'price_limit';

/**
 * 熔断状态
 */
export type CircuitBreakerStatus = 'normal' | 'warning' | 'triggered';

/**
 * 熔断规则
 */
export interface CircuitBreakerRule {
  type: CircuitBreakerType;
  code: string;
  threshold: number;
  currentValue: number;
  status: CircuitBreakerStatus;
  message: string;
}

/**
 * 熔断检查结果
 */
export interface CircuitBreakerResult {
  hasCircuitBreaker: boolean;
  triggeredBreakers: CircuitBreakerRule[];
  warningBreakers: CircuitBreakerRule[];
  allBreakers: CircuitBreakerRule[];
  canTrade: boolean;
  riskLevel: 'low' | 'medium' | 'high';
}

/**
 * 生猪基差偏离度熔断
 * 规则：基差升水 > 30% 时暂停多头信号
 */
export function checkBasisDeviationBreaker(code: string): CircuitBreakerRule | null {
  // 只有生猪(JD)需要检查基差偏离度
  if (code !== 'JD' && code !== 'LH') {
    return null;
  }

  // 获取最新的仓单数据来计算基差
  const warehouseData = db.getWarehouseReceiptHistory({ code, limit: 1 });
  if (warehouseData.length === 0) {
    return null;
  }

  // 获取最新的日行情数据
  const dailyData = db.getDailyQuotesHistory({ variety: code, limit: 1 });
  if (dailyData.length === 0) {
    return null;
  }

  // 计算基差偏离度（这里简化处理，实际应该用现货价格 - 期货价格）
  // 暂时使用仓单变化率作为替代指标
  const latest = warehouseData[0];
  const previous = warehouseData.length > 1 ? warehouseData[1] : latest;
  
  const currentReceipt = latest.warehouse_receipt_qty || 0;
  const previousReceipt = previous.warehouse_receipt_qty || 0;
  
  if (previousReceipt === 0) {
    return null;
  }

  const deviationRate = ((currentReceipt - previousReceipt) / previousReceipt) * 100;
  
  let status: CircuitBreakerStatus = 'normal';
  let message = '基差偏离度正常';

  // 生猪基差升水 > 30% 时触发熔断
  if (Math.abs(deviationRate) > 30) {
    status = 'triggered';
    message = `基差偏离度 ${deviationRate.toFixed(1)}% 超过30%阈值，暂停多头信号`;
  } else if (Math.abs(deviationRate) > 20) {
    status = 'warning';
    message = `基差偏离度 ${deviationRate.toFixed(1)}% 接近20%警告线`;
  }

  return {
    type: 'basis_deviation',
    code,
    threshold: 30,
    currentValue: deviationRate,
    status,
    message
  };
}

/**
 * 仓单变化熔断
 * 规则：单日仓单变化超过20%时触发警告
 */
export function checkWarehouseReceiptBreaker(code: string): CircuitBreakerRule | null {
  const warehouseData = db.getWarehouseReceiptHistory({ code, limit: 2 });
  if (warehouseData.length < 2) {
    return null;
  }

  const latest = warehouseData[0];
  const previous = warehouseData[1];
  
  const currentReceipt = latest.warehouse_receipt_qty || 0;
  const previousReceipt = previous.warehouse_receipt_qty || 0;
  
  if (previousReceipt === 0) {
    return null;
  }

  const changeRate = ((currentReceipt - previousReceipt) / previousReceipt) * 100;
  
  let status: CircuitBreakerStatus = 'normal';
  let message = '仓单变化正常';

  // 单日仓单变化超过20%时触发熔断
  if (Math.abs(changeRate) > 20) {
    status = 'triggered';
    message = `仓单单日变化 ${changeRate.toFixed(1)}% 超过20%阈值`;
  } else if (Math.abs(changeRate) > 10) {
    status = 'warning';
    message = `仓单单日变化 ${changeRate.toFixed(1)}% 接近10%警告线`;
  }

  return {
    type: 'warehouse_receipt',
    code,
    threshold: 20,
    currentValue: changeRate,
    status,
    message
  };
}

/**
 * 价格涨跌停熔断
 * 规则：价格涨跌停时暂停交易
 */
export function checkPriceLimitBreaker(code: string): CircuitBreakerRule | null {
  const dailyData = db.getDailyQuotesHistory({ variety: code, limit: 2 });
  if (dailyData.length < 2) {
    return null;
  }

  const latest = dailyData[0];
  const previous = dailyData[1];
  
  const currentPrice = latest.close_price || latest.close || 0;
  const previousPrice = previous.close_price || previous.close || 0;
  
  if (previousPrice === 0) {
    return null;
  }

  const changeRate = ((currentPrice - previousPrice) / previousPrice) * 100;
  
  let status: CircuitBreakerStatus = 'normal';
  let message = '价格波动正常';

  // 价格涨跌停（假设涨跌停幅度为8%）
  if (Math.abs(changeRate) >= 8) {
    status = 'triggered';
    message = `价格涨跌停 ${changeRate.toFixed(1)}%，暂停交易`;
  } else if (Math.abs(changeRate) >= 5) {
    status = 'warning';
    message = `价格波动 ${changeRate.toFixed(1)}% 接近涨跌停`;
  }

  return {
    type: 'price_limit',
    code,
    threshold: 8,
    currentValue: changeRate,
    status,
    message
  };
}

/**
 * 检查所有熔断规则
 */
export function checkAllCircuitBreakers(code: string): CircuitBreakerResult {
  const breakers: CircuitBreakerRule[] = [];

  // 检查基差偏离度
  const basisBreaker = checkBasisDeviationBreaker(code);
  if (basisBreaker) breakers.push(basisBreaker);

  // 检查仓单变化
  const warehouseBreaker = checkWarehouseReceiptBreaker(code);
  if (warehouseBreaker) breakers.push(warehouseBreaker);

  // 检查价格涨跌停
  const priceBreaker = checkPriceLimitBreaker(code);
  if (priceBreaker) breakers.push(priceBreaker);

  const triggered = breakers.filter(b => b.status === 'triggered');
  const warnings = breakers.filter(b => b.status === 'warning');

  let riskLevel: 'low' | 'medium' | 'high' = 'low';
  if (triggered.length > 0) {
    riskLevel = 'high';
  } else if (warnings.length > 0) {
    riskLevel = 'medium';
  }

  return {
    hasCircuitBreaker: breakers.length > 0,
    triggeredBreakers: triggered,
    warningBreakers: warnings,
    allBreakers: breakers,
    canTrade: triggered.length === 0,
    riskLevel
  };
}

/**
 * 获取熔断摘要（用于AI助手上下文）
 */
export function getCircuitBreakerSummary(code: string): string {
  const result = checkAllCircuitBreakers(code);
  
  if (!result.hasCircuitBreaker) {
    return '无熔断数据';
  }

  const lines: string[] = [];
  
  if (result.triggeredBreakers.length > 0) {
    lines.push('⚠️ 熔断触发:');
    result.triggeredBreakers.forEach(b => {
      lines.push(`  - ${b.message}`);
    });
  }
  
  if (result.warningBreakers.length > 0) {
    lines.push('⚡ 风险警告:');
    result.warningBreakers.forEach(b => {
      lines.push(`  - ${b.message}`);
    });
  }
  
  if (result.canTrade) {
    lines.push(`✅ 可以交易，风险等级: ${result.riskLevel}`);
  } else {
    lines.push('🚫 暂停交易，风险等级: 高');
  }

  return lines.join('\n');
}
