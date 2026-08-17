/**
 * 资金流向分析服务
 * 
 * 基于DCE会员成交持仓排名数据，分析主力资金动向
 */

import { getMemberDealPositionRank, getContractList, getDailyQuotes } from './dceApi.js';

// 资金流向分析结果
export interface CapitalFlowAnalysis {
  tradeDate: string;
  variety: string;
  contractId: string;
  
  // 成交量分析
  volumeAnalysis: {
    totalVolume: number;
    top5Volume: number;           // 前5名成交量
    top5VolumeRatio: number;      // 前5名占比
    top5VolumeChange: number;     // 前5名成交量变化
  };
  
  // 多头持仓分析
  longAnalysis: {
    totalLong: number;
    top5Long: number;             // 前5名多头持仓
    top5LongRatio: number;        // 前5名占比
    top5LongChange: number;       // 前5名多头变化
  };
  
  // 空头持仓分析
  shortAnalysis: {
    totalShort: number;
    top5Short: number;            // 前5名空头持仓
    top5ShortRatio: number;       // 前5名占比
    top5ShortChange: number;      // 前5名空头变化
  };
  
  // 资金流向指标
  flowIndicators: {
    netPosition: number;          // 净持仓（多头-空头）
    netPositionChange: number;    // 净持仓变化
    concentrationIndex: number;   // 集中度指数（0-1）
    divergenceIndex: number;      // 分歧指数（0-1）
    smartMoneyDirection: 'LONG' | 'SHORT' | 'NEUTRAL';  // 聪明钱方向
  };
  
  // 主力机构排名
  topPlayers: {
    rank: number;
    name: string;
    volume: number;
    volumeChange: number;
    longPosition: number;
    longChange: number;
    shortPosition: number;
    shortChange: number;
    netPosition: number;          // 净持仓
    positionBias: 'LONG' | 'SHORT' | 'NEUTRAL';  // 持仓偏向
  }[];
  
  // 信号评估
  signals: {
    type: 'STRONG_LONG' | 'STRONG_SHORT' | 'WEAK_LONG' | 'WEAK_SHORT' | 'NEUTRAL';
    confidence: number;           // 置信度 0-100
    description: string;
  };
}

// 品种ID映射（系统代码 -> DCE代码）
const VARIETY_ID_MAP: Record<string, string> = {
  'A': 'a', 'B': 'b', 'C': 'c', 'CS': 'cs', 'M': 'm', 'Y': 'y', 'P': 'p',
  'JD': 'jd', 'L': 'l', 'V': 'v', 'PP': 'pp', 'J': 'j', 'JM': 'jm',
  'I': 'i', 'EG': 'eg', 'EB': 'eb', 'PG': 'pg', 'LH': 'lh',
};

/**
 * 获取品种的DCE ID
 */
function getVarietyId(code: string): string {
  // 移除后缀如 'L8'
  const cleanCode = code.replace(/L8$/, '').toUpperCase();
  return VARIETY_ID_MAP[cleanCode] || cleanCode.toLowerCase();
}

/**
 * 分析单个合约的资金流向
 */
export async function analyzeCapitalFlow(
  contractId: string,
  tradeDate: string
): Promise<CapitalFlowAnalysis> {
  // 获取持仓排名数据
  const rankData = await getMemberDealPositionRank(tradeDate, contractId);
  
  if (!rankData || !rankData.qtyFutureList) {
    throw new Error(`无法获取合约 ${contractId} 的持仓排名数据`);
  }
  
  // 解析数据
  const volumeRank = rankData.qtyFutureList || [];
  const longRank = rankData.buyFutureList || [];
  const shortRank = rankData.sellFutureList || [];
  
  // 计算成交量分析
  const totalVolume = volumeRank.reduce((sum: number, item: any) => sum + (item.todayQty || 0), 0);
  const top5Volume = volumeRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.todayQty || 0), 0);
  const top5VolumeChange = volumeRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.qtySub || 0), 0);
  
  // 计算多头持仓分析
  const totalLong = longRank.reduce((sum: number, item: any) => sum + (item.todayBuyQty || 0), 0);
  const top5Long = longRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.todayBuyQty || 0), 0);
  const top5LongChange = longRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.buySub || 0), 0);
  
  // 计算空头持仓分析
  const totalShort = shortRank.reduce((sum: number, item: any) => sum + (item.todaySellQty || 0), 0);
  const top5Short = shortRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.todaySellQty || 0), 0);
  const top5ShortChange = shortRank.slice(0, 5).reduce((sum: number, item: any) => sum + (item.sellSub || 0), 0);
  
  // 计算资金流向指标
  const netPosition = top5Long - top5Short;
  const netPositionChange = top5LongChange - top5ShortChange;
  
  // 集中度指数：前5名持仓占比的平均值
  const concentrationIndex = (
    (top5Volume / Math.max(totalVolume, 1)) +
    (top5Long / Math.max(totalLong, 1)) +
    (top5Short / Math.max(totalShort, 1))
  ) / 3;
  
  // 分歧指数：多空持仓差异程度
  const divergenceIndex = Math.abs(top5Long - top5Short) / Math.max(top5Long + top5Short, 1);
  
  // 聪明钱方向判断
  let smartMoneyDirection: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
  if (netPosition > 0 && netPositionChange > 0) {
    smartMoneyDirection = 'LONG';
  } else if (netPosition < 0 && netPositionChange < 0) {
    smartMoneyDirection = 'SHORT';
  } else if (netPositionChange > 500) {
    smartMoneyDirection = 'LONG';
  } else if (netPositionChange < -500) {
    smartMoneyDirection = 'SHORT';
  }
  
  // 构建主力机构排名
  const topPlayers = volumeRank.slice(0, 20).map((item: any, index: number) => {
    const longItem = longRank.find((l: any) => l.buyAbbr === item.qtyAbbr);
    const shortItem = shortRank.find((s: any) => s.sellAbbr === item.qtyAbbr);
    
    const longPos = longItem?.todayBuyQty || 0;
    const shortPos = shortItem?.todaySellQty || 0;
    const net = longPos - shortPos;
    
    let positionBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
    if (net > 1000) positionBias = 'LONG';
    else if (net < -1000) positionBias = 'SHORT';
    
    return {
      rank: index + 1,
      name: item.qtyAbbr || '',
      volume: item.todayQty || 0,
      volumeChange: item.qtySub || 0,
      longPosition: longPos,
      longChange: longItem?.buySub || 0,
      shortPosition: shortPos,
      shortChange: shortItem?.sellSub || 0,
      netPosition: net,
      positionBias,
    };
  });
  
  // 生成信号
  const signals = generateSignals({
    smartMoneyDirection,
    concentrationIndex,
    divergenceIndex,
    netPositionChange,
    top5VolumeChange,
  });
  
  // 提取品种信息
  const variety = contractId.replace(/[0-9]/g, '').toUpperCase();
  
  return {
    tradeDate,
    variety,
    contractId,
    volumeAnalysis: {
      totalVolume,
      top5Volume,
      top5VolumeRatio: top5Volume / Math.max(totalVolume, 1),
      top5VolumeChange,
    },
    longAnalysis: {
      totalLong,
      top5Long,
      top5LongRatio: top5Long / Math.max(totalLong, 1),
      top5LongChange,
    },
    shortAnalysis: {
      totalShort,
      top5Short,
      top5ShortRatio: top5Short / Math.max(totalShort, 1),
      top5ShortChange,
    },
    flowIndicators: {
      netPosition,
      netPositionChange,
      concentrationIndex,
      divergenceIndex,
      smartMoneyDirection,
    },
    topPlayers,
    signals,
  };
}

/**
 * 生成交易信号
 */
function generateSignals(data: {
  smartMoneyDirection: 'LONG' | 'SHORT' | 'NEUTRAL';
  concentrationIndex: number;
  divergenceIndex: number;
  netPositionChange: number;
  top5VolumeChange: number;
}): {
  type: 'STRONG_LONG' | 'STRONG_SHORT' | 'WEAK_LONG' | 'WEAK_SHORT' | 'NEUTRAL';
  confidence: number;
  description: string;
} {
  let type: 'STRONG_LONG' | 'STRONG_SHORT' | 'WEAK_LONG' | 'WEAK_SHORT' | 'NEUTRAL' = 'NEUTRAL';
  let confidence = 50;
  const descriptions: string[] = [];
  
  // 聪明钱方向判断
  if (data.smartMoneyDirection === 'LONG') {
    type = 'WEAK_LONG';
    confidence += 15;
    descriptions.push('主力资金偏多');
  } else if (data.smartMoneyDirection === 'SHORT') {
    type = 'WEAK_SHORT';
    confidence += 15;
    descriptions.push('主力资金偏空');
  } else {
    descriptions.push('主力资金中性');
  }
  
  // 集中度判断
  if (data.concentrationIndex > 0.4) {
    confidence += 10;
    descriptions.push('持仓集中度高，趋势可能延续');
  } else if (data.concentrationIndex < 0.2) {
    confidence -= 10;
    descriptions.push('持仓分散，趋势可能减弱');
  }
  
  // 净持仓变化判断
  if (data.netPositionChange > 2000) {
    if (type === 'NEUTRAL' || type === 'WEAK_SHORT') type = 'WEAK_LONG';
    confidence += 10;
    descriptions.push(`多头增仓明显（+${data.netPositionChange}）`);
  } else if (data.netPositionChange < -2000) {
    if (type === 'NEUTRAL' || type === 'WEAK_LONG') type = 'WEAK_SHORT';
    confidence += 10;
    descriptions.push(`空头增仓明显（${data.netPositionChange}）`);
  }
  
  // 成交量变化判断
  if (data.top5VolumeChange > 10000) {
    confidence += 5;
    descriptions.push('主力成交活跃');
  }
  
  // 强信号判断
  if (data.smartMoneyDirection === 'LONG' && data.concentrationIndex > 0.35 && data.netPositionChange > 1000) {
    type = 'STRONG_LONG';
    confidence = Math.min(90, confidence + 15);
  } else if (data.smartMoneyDirection === 'SHORT' && data.concentrationIndex > 0.35 && data.netPositionChange < -1000) {
    type = 'STRONG_SHORT';
    confidence = Math.min(90, confidence + 15);
  }
  
  // 限制置信度范围
  confidence = Math.max(20, Math.min(90, confidence));
  
  return {
    type,
    confidence,
    description: descriptions.join('；'),
  };
}

/**
 * 获取品种的主力合约并分析资金流向
 */
export async function analyzeVarietyCapitalFlow(
  varietyCode: string,
  tradeDate: string
): Promise<CapitalFlowAnalysis | null> {
  const varietyId = getVarietyId(varietyCode);
  
  // 直接获取指定品种的合约列表（避免获取所有品种导致API限流）
  const quotes = await getDailyQuotes(tradeDate, varietyId, '1');
  const contracts: string[] = [];
  
  for (const quote of quotes) {
    const contractId = quote.contractId;
    // 过滤掉月均价合约（以F结尾）和总计行
    if (contractId && !contractId.endsWith('F') && contractId !== '总计') {
      contracts.push(contractId);
    }
  }
  
  if (contracts.length === 0) {
    return null;
  }
  
  // 取第一个作为主力合约（已按成交量排序）
  const mainContract = contracts[0];
  
  return analyzeCapitalFlow(mainContract, tradeDate);
}

/**
 * 批量分析多个品种的资金流向
 */
export async function analyzeMultipleVarieties(
  varietyCodes: string[],
  tradeDate: string
): Promise<CapitalFlowAnalysis[]> {
  const results: CapitalFlowAnalysis[] = [];
  
  for (const code of varietyCodes) {
    try {
      const analysis = await analyzeVarietyCapitalFlow(code, tradeDate);
      if (analysis) {
        results.push(analysis);
      }
      // 避免请求过快
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`分析品种 ${code} 失败:`, error);
    }
  }
  
  return results;
}

/**
 * 获取资金流向排行榜（使用数据库历史数据）
 * 按净持仓排序
 */
export async function getCapitalFlowRanking(
  tradeDate: string,
  topN: number = 20
): Promise<{
  longRanking: any[];  // 多头排行
  shortRanking: any[]; // 空头排行
  volumeRanking: any[]; // 成交活跃排行
}> {
  // 从数据库获取历史数据
  const { getCapitalFlowHistory } = await import('./database.js');
  const historyData = getCapitalFlowHistory({ startDate: tradeDate, endDate: tradeDate, limit: 100 });
  
  if (historyData.length === 0) {
    return { longRanking: [], shortRanking: [], volumeRanking: [] };
  }
  
  // 按净持仓排序（正数表示多头占优，负数表示空头占优）
  const longRanking = [...historyData]
    .sort((a, b) => b.net_position - a.net_position)
    .slice(0, topN)
    .map(r => ({
      code: r.code,
      name: r.name,
      netPosition: r.net_position,
      smartMoneyDirection: r.smart_money_direction,
      top5Long: r.top5_long,
      top5Short: r.top5_short,
    }));
  
  // 按空头排行（净持仓负数越大表示空头越强）
  const shortRanking = [...historyData]
    .sort((a, b) => a.net_position - b.net_position)
    .slice(0, topN)
    .map(r => ({
      code: r.code,
      name: r.name,
      netPosition: r.net_position,
      smartMoneyDirection: r.smart_money_direction,
      top5Long: r.top5_long,
      top5Short: r.top5_short,
    }));
  
  // 按成交量排行
  const volumeRanking = [...historyData]
    .sort((a, b) => b.top5_volume - a.top5_volume)
    .slice(0, topN)
    .map(r => ({
      code: r.code,
      name: r.name,
      top5Volume: r.top5_volume,
      smartMoneyDirection: r.smart_money_direction,
    }));
  
  return { longRanking, shortRanking, volumeRanking };
}
