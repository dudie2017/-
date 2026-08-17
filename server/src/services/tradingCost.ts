/**
 * 交易成本计算服务
 * 
 * 使用DCE官方API获取真实的手续费和保证金数据
 */

import { getSettlementParams } from './dceApi.js';

// 交易成本信息
export interface TradingCost {
  variety: string;
  contractId: string;
  tradeDate: string;
  
  // 手续费
  openFee: number;           // 开仓手续费（元/手）
  closeFee: number;          // 平仓手续费（元/手）
  totalFee: number;          // 总手续费（开+平）
  
  // 保证金
  marginRate: number;        // 保证金率
  marginPerContract: number; // 每手保证金
  
  // 结算价
  clearPrice: number;        // 结算价
  
  // 成本分析
  costAnalysis: {
    feeRatio: number;        // 手续费占合约价值比例
    breakevenPoints: number; // 保本点数（需要涨/跌多少点才能覆盖手续费）
  };
}

// 品种ID映射（系统代码 -> DCE代码）
const VARIETY_ID_MAP: Record<string, string> = {
  'A': 'a', 'B': 'b', 'C': 'c', 'CS': 'cs', 'M': 'm', 'Y': 'y', 'P': 'p',
  'JD': 'jd', 'L': 'l', 'V': 'v', 'PP': 'pp', 'J': 'j', 'JM': 'jm',
  'I': 'i', 'EG': 'eg', 'EB': 'eb', 'PG': 'pg', 'LH': 'lh',
};

// 合约乘数表（用于计算保证金）
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  'A': 10, 'B': 10, 'C': 10, 'CS': 10, 'M': 10, 'Y': 10, 'P': 10,
  'JD': 5, 'L': 5, 'V': 5, 'PP': 5, 'J': 100, 'JM': 60,
  'I': 100, 'EG': 10, 'EB': 5, 'PG': 20, 'LH': 16,
};

/**
 * 获取品种的DCE ID
 */
function getVarietyId(code: string): string {
  const cleanCode = code.replace(/L8$/, '').toUpperCase();
  return VARIETY_ID_MAP[cleanCode] || cleanCode.toLowerCase();
}

/**
 * 获取合约乘数
 */
function getContractMultiplier(code: string): number {
  const cleanCode = code.replace(/L8$/, '').toUpperCase();
  return CONTRACT_MULTIPLIERS[cleanCode] || 10;
}

/**
 * 解析手续费字符串
 * 可能是固定金额（如"2"）或比例（如"0.0001"）
 */
function parseFee(feeStr: string, price: number, multiplier: number): number {
  if (!feeStr) return 0;
  
  const fee = parseFloat(feeStr);
  if (isNaN(fee)) return 0;
  
  // 如果手续费小于0.01，可能是比例
  if (fee < 0.01) {
    return Math.round(price * multiplier * fee);
  }
  
  // 否则是固定金额
  return fee;
}

/**
 * 解析保证金率字符串
 */
function parseMarginRate(rateStr: string): number {
  if (!rateStr) return 0.1; // 默认10%
  
  const rate = parseFloat(rateStr);
  if (isNaN(rate)) return 0.1;
  
  // 如果小于1，直接使用；否则除以100
  return rate < 1 ? rate : rate / 100;
}

/**
 * 获取交易成本
 * @param varietyCode 品种代码（如 'A', 'M'）
 * @param contractId 合约ID（如 'a2601'）
 * @param tradeDate 交易日期 YYYYMMDD
 * @param currentPrice 当前价格（用于计算比例手续费）
 */
export async function getTradingCost(
  varietyCode: string,
  contractId: string,
  tradeDate: string,
  currentPrice: number
): Promise<TradingCost> {
  const varietyId = getVarietyId(varietyCode);
  const multiplier = getContractMultiplier(varietyCode);
  
  try {
    // 从DCE API获取结算参数
    const params = await getSettlementParams(varietyId, tradeDate);
    
    // 找到对应合约的参数
    const contractParams = params.find(p => p.contractId === contractId);
    
    if (!contractParams) {
      throw new Error(`未找到合约 ${contractId} 的结算参数`);
    }
    
    // 解析手续费
    const openFee = parseFee(contractParams.openFee, currentPrice, multiplier);
    const closeFee = parseFee(contractParams.offsetFee || contractParams.openFee, currentPrice, multiplier);
    const totalFee = openFee + closeFee;
    
    // 解析保证金率
    const marginRate = parseMarginRate(contractParams.specBuyRate || contractParams.specSellRate);
    const marginPerContract = Math.round(currentPrice * multiplier * marginRate);
    
    // 结算价
    const clearPrice = parseFloat(contractParams.clearPrice) || currentPrice;
    
    // 成本分析
    const contractValue = currentPrice * multiplier;
    const feeRatio = totalFee / contractValue;
    const breakevenPoints = Math.ceil(totalFee / multiplier);
    
    return {
      variety: varietyCode,
      contractId,
      tradeDate,
      openFee,
      closeFee,
      totalFee,
      marginRate,
      marginPerContract,
      clearPrice,
      costAnalysis: {
        feeRatio,
        breakevenPoints,
      },
    };
  } catch (error) {
    console.error(`获取交易成本失败: ${varietyCode} ${contractId}`, error);
    
    // 返回默认成本估算
    const defaultOpenFee = Math.round(currentPrice * multiplier * 0.0001); // 万分之一
    const defaultMarginRate = 0.1; // 10%
    
    return {
      variety: varietyCode,
      contractId,
      tradeDate,
      openFee: defaultOpenFee,
      closeFee: defaultOpenFee,
      totalFee: defaultOpenFee * 2,
      marginRate: defaultMarginRate,
      marginPerContract: Math.round(currentPrice * multiplier * defaultMarginRate),
      clearPrice: currentPrice,
      costAnalysis: {
        feeRatio: 0.0002,
        breakevenPoints: 2,
      },
    };
  }
}

/**
 * 批量获取交易成本
 */
export async function getBatchTradingCosts(
  contracts: Array<{ varietyCode: string; contractId: string; currentPrice: number }>,
  tradeDate: string
): Promise<TradingCost[]> {
  const results: TradingCost[] = [];
  
  for (const contract of contracts) {
    try {
      const cost = await getTradingCost(
        contract.varietyCode,
        contract.contractId,
        tradeDate,
        contract.currentPrice
      );
      results.push(cost);
      
      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`获取 ${contract.contractId} 成本失败:`, error);
    }
  }
  
  return results;
}

/**
 * 增强交易建议，添加成本信息
 */
export function enhanceTradingAdviceWithCost(
  advice: any,
  cost: TradingCost
): any {
  return {
    ...advice,
    // 成本信息
    tradingCost: {
      openFee: cost.openFee,
      closeFee: cost.closeFee,
      totalFee: cost.totalFee,
      marginRate: cost.marginRate,
      marginPerContract: cost.marginPerContract,
      breakevenPoints: cost.costAnalysis.breakevenPoints,
    },
    // 更新最大开仓手数（考虑保证金）
    adjustedMaxPosition: Math.min(
      advice.maxPosition,
      Math.floor(50000 / cost.marginPerContract) // 假设账户资金5万
    ),
    // 更新风险收益比（考虑手续费）
    adjustedRiskReward: calculateAdjustedRiskReward(
      advice.entryPrice,
      advice.stopLoss,
      advice.target1,
      advice.contractMultiplier,
      cost.totalFee
    ),
  };
}

/**
 * 计算调整后的风险收益比（考虑手续费）
 */
function calculateAdjustedRiskReward(
  entryPrice: number,
  stopLoss: number,
  target: number,
  multiplier: number,
  fee: number
): number {
  const risk = Math.abs(entryPrice - stopLoss) * multiplier + fee;
  const reward = Math.abs(target - entryPrice) * multiplier - fee;
  
  if (risk <= 0) return 0;
  return Math.round((reward / risk) * 100) / 100;
}
