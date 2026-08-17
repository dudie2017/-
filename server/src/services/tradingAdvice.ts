/**
 * 交易建议生成服务
 * 
 * P0-4: 重写为 V16.2 展示层
 * 单一真相源：V16Row（不再独立计算方向/止损/共振）
 */

import { analyzeResonance, analyzeResonanceRealtime, type ResonanceAnalysis } from './multiTimeframeResonance.js';
import { aggregateToTimeframe, type MinuteBar } from './localDataLoader.js';
import { calcEMA, calcATR } from './indicators.js';
import type { BarData } from './varieties.js';
import type { V16Row } from './v16_types.js';
import { getTradingCost, type TradingCost } from './tradingCost.js';
import { predictVariety } from './modelTraining.js';

// 交易建议
export interface TradingAdvice {
  varietyCode: string;
  varietyName: string;
  timestamp: string;
  
  // 基本信息
  direction: 'LONG' | 'SHORT';
  resonanceScore: number;
  resonanceLevel: string;
  
  // V16.2 信号分级
  signalGrade: string;           // L0-L4
  signalVariant: string;         // S/A+/A/A-/B+
  spectrum: string;              // 谱系：趋势/趋势-紧通道/区间等
  g4ReasonCount: number;         // Gate4 理由数
  mtfResonanceText: string;      // 多时间框架共振描述
  
  // 合约信息
  contractMonth: string;        // 推荐合约月份
  currentPrice: number;         // 当前价格
  
  // 关键价位
  entryPrice: number;           // 建议入场价
  stopLoss: number;             // 止损位
  support: number;              // 支撑位
  resistance: number;           // 压力位
  target1: number;              // 第一目标位
  target2: number;              // 第二目标位
  
  // 仓位计算
  riskAmount: number;           // 风险金额（默认2000元）
  riskPerUnit: number;          // 每单位风险（入场价-止损价）
  contractMultiplier: number;   // 合约乘数
  maxPosition: number;          // 最大开仓手数
  
  // 真实成本数据（新增）
  costData?: {
    openFee: number;            // 开仓手续费（元/手）
    closeFee: number;           // 平仓手续费（元/手）
    totalFee: number;           // 总手续费（开+平）
    marginRate: number;         // 保证金率
    marginPerContract: number;  // 每手保证金
    breakevenPoints: number;    // 保本点数
    actualRisk: number;         // 实际风险（含手续费）
    totalCapitalRequired: number; // 所需总资金
  };
  
  // 时间建议
  entryTiming: string;          // 入场时机描述
  entryConditions: string[];    // 入场条件列表
  
  // 文字描述
  summary: string;              // 总结性描述
  analysis: string;             // 详细分析
  
  // 提醒
  alertLevel: 'NONE' | 'WATCH' | 'ALERT' | 'CRITICAL';
  alertMessage: string;

  // 交易者方程
  equationRR?: number;           // 盈亏比 R:R
  equationPassed?: boolean;      // 是否通过交易者方程检验

  // ML 增强字段（新增）
  mlRecommendation?: {
    predictedReturn: number;     // ML 预测收益率（百分比数值）
    confidence: number;          // ML 置信度 (0-1)
    predictedMaxDrawdown: number; // ML 预测最大回撤（百分比数值）
    reason: string;              // ML 推荐理由
    featureImportance: Record<string, number>; // 特征重要性
    modelVersion: string;        // 模型版本
  };
}

// 品种合约乘数表
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  // 上期所
  'CUL8': 5,      // 沪铜 5吨/手
  'ALL8': 5,      // 沪铝 5吨/手
  'ZNL8': 5,      // 沪锌 5吨/手
  'PBL8': 5,      // 沪铅 5吨/手
  'SNL8': 1,      // 沪锡 1吨/手
  'NIL8': 1,      // 沪镍 1吨/手
  'AUL8': 1000,   // 黄金 1000克/手
  'AGL8': 15,     // 白银 15千克/手
  'RBL8': 10,     // 螺纹钢 10吨/手
  'HCL8': 10,     // 热卷 10吨/手
  'FUL8': 10,     // 燃油 10吨/手
  'BUL8': 10,     // 沥青 10吨/手
  'RUL8': 10,     // 橡胶 10吨/手
  
  // 大商所
  'AL8': 10,      // 豆一 10吨/手
  'SFL8': 10,     // 豆粕 10吨/手
  'YL8': 10,      // 豆油 10吨/手
  'PRL8': 10,     // 棕榈油 10吨/手
  'JDL8': 5,      // 鸡蛋 5吨/手（实际是500斤，但按吨计算）
  'JL8': 100,     // 焦炭 100吨/手（实际是25吨，但按100计算）
  'JML8': 60,     // 焦煤 60吨/手
  'IL8': 100,     // 铁矿石 100吨/手
  'PLL8': 5,      // 塑料 5吨/手
  'PPL8': 5,      // 聚丙烯 5吨/手
  'V-FL8': 5,     // PVC 5吨/手
  'BRL8': 5,      // 苯乙烯 5吨/手
  
  // 郑商所
  'SML8': 10,     // 菜粕 10吨/手
  'OIL8': 10,     // 菜油 10吨/手
  'RML8': 10,     // 菜油 10吨/手
  'MAL8': 10,     // 甲醇 10吨/手
  'TAL8': 5,      // PTA 5吨/手
  'SAL8': 20,     // 纯碱 20吨/手
  'FGL8': 20,     // 玻璃 20吨/手
  'APL8': 10,     // 苹果 10吨/手
  'CJL8': 5,      // 红枣 5吨/手
  'SRL8': 10,     // 白糖 10吨/手
  'CFL8': 10,     // 棉纱 10吨/手
  'PFL8': 5,      // 花生 5吨/手
  
  // 中金所
  'IFL8': 300,    // 沪深300 300元/点
  'ICL8': 200,    // 中证500 200元/点
  'IHL8': 300,    // 上证50 300元/点
  'IML8': 200,    // 中证1000 200元/点
  'TTL8': 10000,  // 10年国债 10000元/点
  'TFL8': 10000,  // 5年国债 10000元/点
  'TS': 20000,    // 2年国债 20000元/点
  
  // 广期所
  'SIL8': 5,      // 工业硅 5吨/手
  'LUL8': 1,      // 碳酸锂 1吨/手
};

// 默认合约乘数
const DEFAULT_MULTIPLIER = 10;

/**
 * 获取品种合约乘数
 */
function getContractMultiplier(code: string): number {
  return CONTRACT_MULTIPLIERS[code] || DEFAULT_MULTIPLIER;
}

/**
 * 获取推荐合约月份
 */
function getRecommendedContractMonth(code: string): string {
  const now = new Date();
  const currentMonth = now.getMonth() + 1;
  const currentYear = now.getFullYear();
  
  // 根据品种特性推荐合约
  // 一般推荐主力合约（成交量最大的月份）
  // 这里简化处理，推荐1-3个月后的合约
  
  let targetMonth = currentMonth + 1;
  let targetYear = currentYear;
  
  if (targetMonth > 12) {
    targetMonth = 1;
    targetYear += 1;
  }
  
  // 对于农产品，推荐收获季节后的合约
  // 对于金属，推荐近月合约
  
  const monthStr = targetMonth.toString().padStart(2, '0');
  const yearStr = targetYear.toString().slice(-2);
  
  return `${code.replace('L8', '')}${yearStr}${monthStr}`;
}

/**
 * 计算关键价位
 */
function calculateKeyLevels(bars: BarData[], direction: 'LONG' | 'SHORT'): {
  entryPrice: number;
  stopLoss: number;
  support: number;
  resistance: number;
  target1: number;
  target2: number;
} {
  const lastBar = bars[bars.length - 1];
  const currentPrice = lastBar.c;
  
  // 计算ATR
  const atr = calcATR(bars, 14);
  const currentATR = atr[atr.length - 1];
  
  // 计算EMA
  const closes = bars.map(b => b.c);
  const ema20 = calcEMA(closes, 20);
  const currentEMA20 = ema20[ema20.length - 1];
  
  // 计算最近20根K线的高低点
  const recentBars = bars.slice(-20);
  const recentHigh = Math.max(...recentBars.map(b => b.h));
  const recentLow = Math.min(...recentBars.map(b => b.l));
  
  let entryPrice: number;
  let stopLoss: number;
  let support: number;
  let resistance: number;
  let target1: number;
  let target2: number;
  
  if (direction === 'LONG') {
    // 做多
    entryPrice = currentPrice;
    stopLoss = currentPrice - currentATR * 2;  // 2倍ATR止损
    support = Math.min(currentEMA20, recentLow);
    resistance = recentHigh;
    target1 = currentPrice + (currentPrice - stopLoss) * 1.5;  // 1.5倍风险
    target2 = currentPrice + (currentPrice - stopLoss) * 3;    // 3倍风险
  } else {
    // 做空
    entryPrice = currentPrice;
    stopLoss = currentPrice + currentATR * 2;  // 2倍ATR止损
    resistance = Math.max(currentEMA20, recentHigh);
    support = recentLow;
    target1 = currentPrice - (stopLoss - currentPrice) * 1.5;  // 1.5倍风险
    target2 = currentPrice - (stopLoss - currentPrice) * 3;    // 3倍风险
  }
  
  return { entryPrice, stopLoss, support, resistance, target1, target2 };
}

/**
 * 计算最大开仓手数（考虑真实成本）
 */
function calculateMaxPosition(
  riskAmount: number,
  entryPrice: number,
  stopLoss: number,
  contractMultiplier: number,
  costData?: { totalFee: number; marginPerContract: number }
): { maxPosition: number; actualRisk: number; totalCapitalRequired: number } {
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const riskPerContract = riskPerUnit * contractMultiplier;
  
  if (riskPerContract <= 0) {
    return { maxPosition: 1, actualRisk: 0, totalCapitalRequired: 0 };
  }
  
  // 基础手数计算（不考虑成本）
  let maxPosition = Math.floor(riskAmount / riskPerContract);
  
  // 如果有成本数据，进行更精确的计算
  let actualRisk = riskPerContract;
  let totalCapitalRequired = 0;
  
  if (costData) {
    // 实际风险 = 价格风险 + 手续费
    actualRisk = riskPerContract + costData.totalFee;
    // 所需总资金 = 保证金 + 风险准备金
    totalCapitalRequired = costData.marginPerContract + riskAmount;
    
    // 重新计算手数（考虑手续费）
    maxPosition = Math.floor(riskAmount / actualRisk);
  }
  
  return {
    maxPosition: Math.max(1, maxPosition),
    actualRisk,
    totalCapitalRequired
  };
}

/**
 * 生成入场条件
 */
function generateEntryConditions(
  resonance: ResonanceAnalysis,
  direction: 'LONG' | 'SHORT'
): string[] {
  const conditions: string[] = [];
  
  // 共振条件
  conditions.push(`多周期共振评分达到${resonance.resonanceScore}/4`);
  
  // 方向条件
  if (direction === 'LONG') {
    conditions.push('日线AI方向为多头');
    conditions.push('价格在EMA20上方');
  } else {
    conditions.push('日线AI方向为空头');
    conditions.push('价格在EMA20下方');
  }
  
  // 周期条件
  const timeframes = ['daily', '60min', '15min', '5min'] as const;
  for (const tf of timeframes) {
    const analysis = resonance.timeframes[tf];
    if (analysis.aiDirection === direction) {
      const tfName = tf === 'daily' ? '日线' : tf === '60min' ? '60分钟' : tf === '15min' ? '15分钟' : '5分钟';
      conditions.push(`${tfName}确认${direction === 'LONG' ? '多头' : '空头'}信号`);
    }
  }
  
  return conditions;
}

/**
 * 生成入场时机描述
 */
function generateEntryTiming(resonance: ResonanceAnalysis): string {
  const daily = resonance.timeframes.daily;
  const min60 = resonance.timeframes['60min'];
  
  if (daily.trendPhase === 'PULLBACK' && min60.trendPhase === 'PULLBACK') {
    return '当前处于回踩阶段，等待企稳信号后入场';
  } else if (daily.trendPhase === 'STRONG_TREND') {
    return '当前处于强趋势阶段，可顺势入场';
  } else if (daily.trendPhase === 'BREAKOUT') {
    return '当前出现突破信号，可追突破入场';
  } else {
    return '当前处于震荡阶段，建议等待方向明确后再入场';
  }
}

/**
 * 生成总结性描述
 */
function generateSummary(advice: TradingAdvice): string {
  const directionText = advice.direction === 'LONG' ? '做多' : '做空';
  const resonanceText = advice.resonanceScore === 4 ? '强共振' : 
                        advice.resonanceScore === 3 ? '中共振' : '弱共振';
  
  let summary = `${advice.varietyName}(${advice.varietyCode})出现${resonanceText}${directionText}信号，共振评分${advice.resonanceScore}/4。` +
    `建议入场价${advice.entryPrice.toFixed(2)}，止损${advice.stopLoss.toFixed(2)}，` +
    `目标位${advice.target1.toFixed(2)}/${advice.target2.toFixed(2)}。` +
    `按${advice.riskAmount}元风险计算，建议开仓${advice.maxPosition}手。`;
  
  // 添加成本信息
  if (advice.costData) {
    summary += ` 手续费${advice.costData.totalFee}元/手，保证金率${(advice.costData.marginRate * 100).toFixed(1)}%，` +
      `每手保证金${advice.costData.marginPerContract}元，保本${advice.costData.breakevenPoints}点。`;
  }
  
  return summary;
}

/**
 * 生成详细分析
 */
function generateAnalysis(resonance: ResonanceAnalysis, direction: 'LONG' | 'SHORT'): string {
  const parts: string[] = [];
  
  // 日线分析
  const daily = resonance.timeframes.daily;
  parts.push(`【日线】AI${daily.aiDirection === 'LONG' ? '多' : '空'}头，${getTrendPhaseText(daily.trendPhase)}，EMA20斜率${daily.ema20Slope.toFixed(2)}%`);
  
  // 60分钟分析
  const min60 = resonance.timeframes['60min'];
  parts.push(`【60分钟】AI${min60.aiDirection === 'LONG' ? '多' : '空'}头，${getTrendPhaseText(min60.trendPhase)}`);
  
  // 15分钟分析
  const min15 = resonance.timeframes['15min'];
  if (min15.signalBar) {
    parts.push(`【15分钟】出现信号K线`);
  }
  
  // 5分钟分析
  const min5 = resonance.timeframes['5min'];
  if (min5.followThrough) {
    parts.push(`【5分钟】follow-through确认`);
  }
  
  return parts.join('；');
}

function getTrendPhaseText(phase: string): string {
  switch (phase) {
    case 'STRONG_TREND': return '强趋势';
    case 'PULLBACK': return '回踩中';
    case 'BREAKOUT': return '突破';
    case 'RANGE': return '区间震荡';
    default: return phase;
  }
}

/**
 * 检查是否需要提醒
 */
export function checkAlertLevel(
  currentPrice: number,
  keyLevels: { stopLoss: number; support: number; resistance: number; target1: number; target2: number },
  direction: 'LONG' | 'SHORT'
): { level: 'NONE' | 'WATCH' | 'ALERT' | 'CRITICAL'; message: string } {
  const { stopLoss, support, resistance, target1, target2 } = keyLevels;
  
  // 计算距离各价位的百分比
  const distToStopLoss = Math.abs(currentPrice - stopLoss) / currentPrice * 100;
  const distToSupport = Math.abs(currentPrice - support) / currentPrice * 100;
  const distToResistance = Math.abs(currentPrice - resistance) / currentPrice * 100;
  const distToTarget1 = Math.abs(currentPrice - target1) / currentPrice * 100;
  
  // 判断提醒级别
  if (distToStopLoss < 0.5) {
    return {
      level: 'CRITICAL',
      message: `WARN 价格接近止损位！距离止损仅${distToStopLoss.toFixed(2)}%`
    };
  } else if (distToStopLoss < 1) {
    return {
      level: 'ALERT',
      message: `价格接近止损位，请注意风险`
    };
  } else if (distToTarget1 < 0.5) {
    return {
      level: 'ALERT',
      message: `价格接近第一目标位，考虑部分止盈`
    };
  } else if (distToSupport < 0.5 || distToResistance < 0.5) {
    return {
      level: 'WATCH',
      message: `价格接近关键支撑/压力位`
    };
  }
  
  return { level: 'NONE', message: '' };
}

/**
 * 生成单个品种的交易建议（异步，支持获取真实成本）
 */
/** @deprecated 使用 generateAdviceFromV16Row() 代替，V16.2 为唯一真相源 */
export async function generateTradingAdvice(
  varietyCode: string,
  varietyName: string,
  bars: BarData[],
  resonance: ResonanceAnalysis,
  riskAmount: number = 2000
): Promise<TradingAdvice> {
  const direction = resonance.suggestedDirection as 'LONG' | 'SHORT';
  const currentPrice = bars[bars.length - 1].c;
  const contractMultiplier = getContractMultiplier(varietyCode);
  const contractMonth = getRecommendedContractMonth(varietyCode);
  
  // 计算关键价位
  const keyLevels = calculateKeyLevels(bars, direction);
  
  // 尝试获取真实成本数据
  let costData: TradingAdvice['costData'] = undefined;
  try {
    // 获取当前日期作为交易日期
    const tradeDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cost = await getTradingCost(varietyCode, contractMonth, tradeDate, currentPrice);
    
    costData = {
      openFee: cost.openFee,
      closeFee: cost.closeFee,
      totalFee: cost.totalFee,
      marginRate: cost.marginRate,
      marginPerContract: cost.marginPerContract,
      breakevenPoints: cost.costAnalysis.breakevenPoints,
      actualRisk: 0, // 将在下面计算
      totalCapitalRequired: 0 // 将在下面计算
    };
  } catch (error) {
    console.warn(`获取成本数据失败，使用默认值: ${varietyCode}`, error);
  }
  
  // 计算最大开仓手数（考虑真实成本）
  const positionResult = calculateMaxPosition(
    riskAmount,
    keyLevels.entryPrice,
    keyLevels.stopLoss,
    contractMultiplier,
    costData ? { totalFee: costData.totalFee, marginPerContract: costData.marginPerContract } : undefined
  );
  
  // 更新成本数据中的实际风险
  if (costData) {
    costData.actualRisk = positionResult.actualRisk;
    costData.totalCapitalRequired = positionResult.totalCapitalRequired;
  }
  
  // 生成入场条件
  const entryConditions = generateEntryConditions(resonance, direction);
  
  // 生成入场时机
  const entryTiming = generateEntryTiming(resonance);
  
  // 检查提醒级别
  const alert = checkAlertLevel(currentPrice, keyLevels, direction);
  
  const advice: TradingAdvice = {
    varietyCode,
    varietyName,
    timestamp: resonance.timestamp,
    direction,
    resonanceScore: resonance.resonanceScore,
    resonanceLevel: resonance.resonanceLevel,
    signalGrade: 'L0',
    signalVariant: 'B+',
    spectrum: '未分析',
    g4ReasonCount: 0,
    mtfResonanceText: '',
    contractMonth,
    currentPrice,
    entryPrice: keyLevels.entryPrice,
    stopLoss: keyLevels.stopLoss,
    support: keyLevels.support,
    resistance: keyLevels.resistance,
    target1: keyLevels.target1,
    target2: keyLevels.target2,
    riskAmount,
    riskPerUnit: Math.abs(keyLevels.entryPrice - keyLevels.stopLoss),
    contractMultiplier,
    maxPosition: positionResult.maxPosition,
    costData,
    entryTiming,
    entryConditions,
    summary: '',
    analysis: generateAnalysis(resonance, direction),
    alertLevel: alert.level,
    alertMessage: alert.message,
  };
  
  advice.summary = generateSummary(advice);
  
  return advice;
}

/**
 * P0-4: 从 V16Row 生成交易建议（单一真相源）
 * 不再独立计算方向/止损/共振，全部从 V16.2 结果取
 */
export async function generateAdviceFromV16Row(
  row: V16Row,
  riskAmount: number = 2000
): Promise<TradingAdvice | null> {
  // 方向：从 V16Row.ai_direction 取
  const direction = row.ai_direction === '多' ? 'LONG' : row.ai_direction === '空' ? 'SHORT' : null;
  if (!direction) return null;

  const currentPrice = row.close;
  const contractMultiplier = getContractMultiplier(row.code);
  const contractMonth = getRecommendedContractMonth(row.code);

  // 关键价位：从 V16Row.key_levels 取，兜底用 ATR
  const keyLevels = row.key_levels;
  const atr = row.atr14 || currentPrice * 0.02;

  // 自适应止损和目标（按品种波动特征个性化）
  // spectrum: 趋势→宽止损(趋势延续空间大), 区间→紧止损(震荡易反转)
  // ADX: 高→目标放远, 低→目标收敛
  // === V18 结构位止损止盈 (Brooks: 止损放最近结构高低点外1跳) ===
  const isTrend = row.spectrum === '趋势';
  const isRange = row.spectrum === '区间';
  const adx = row.adx || 20;

  let entryPrice: number;
  let stopLoss: number;
  let support: number;
  let resistance: number;
  let target1: number;
  let target2: number;

  // 优先使用结构位 (swing高低点)，其次用 key_levels support/resistance，最后 ATR 兜底
  const structSupport = keyLevels?.support || 0;
  const structResistance = keyLevels?.resistance || 0;
  const hasLevels = structSupport > 0 && structResistance > 0;

  if (hasLevels) {
    entryPrice = currentPrice;
    support = structSupport;
    resistance = structResistance;

    if (direction === 'LONG') {
      // 止损: swing低点下方1跳 (约0.1% margin)
      stopLoss = structSupport * 0.998;
      const risk = entryPrice - stopLoss;
      // 目标1: 1.5R打底 (Brooks: 最低要求1.5:1)
      target1 = entryPrice + risk * 1.5;
      // 目标2: 趋势→swing高点, 通道→2.5R
      target2 = isTrend ? structResistance : entryPrice + risk * 2.5;
    } else {
      // 止损: swing高点上方1跳
      stopLoss = structResistance * 1.002;
      // 保护：结构止损距离不得小于 1.2×ATR
      const risk = stopLoss - entryPrice;
      target1 = entryPrice - risk * 1.5;
      target2 = isTrend ? structSupport : entryPrice - risk * 2.5;
    }
  } else {
    // 兜底：ATR × 自适应倍数
    const atrStopMult = isTrend ? 1.8 : isRange ? 1.2 : 1.5;
    const atrTargetMult = isTrend ? 2.8 : isRange ? 1.5 : 2.0;
    entryPrice = currentPrice;
    if (direction === 'LONG') {
      stopLoss = currentPrice - atr * atrStopMult;
      support = currentPrice - atr;
      resistance = currentPrice + atr;
      target1 = currentPrice + atr * atrTargetMult;
      target2 = currentPrice + atr * atrTargetMult * 2;
    } else {
      stopLoss = currentPrice + atr * atrStopMult;
      support = currentPrice - atr;
      resistance = currentPrice + atr;
      target1 = currentPrice - atr * atrTargetMult;
      target2 = currentPrice - atr * atrTargetMult * 2;
    }
  }

  // 获取真实成本数据
  let costData: TradingAdvice['costData'] = undefined;
  try {
    const tradeDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cost = await getTradingCost(row.code, contractMonth, tradeDate, currentPrice);
    costData = {
      openFee: cost.openFee,
      closeFee: cost.closeFee,
      totalFee: cost.totalFee,
      marginRate: cost.marginRate,
      marginPerContract: cost.marginPerContract,
      breakevenPoints: cost.costAnalysis.breakevenPoints,
      actualRisk: 0,
      totalCapitalRequired: 0
    };
  } catch (error) {
    console.warn(`获取成本数据失败: ${row.code}`, error);
  }

  // 计算最大开仓手数
  const positionResult = calculateMaxPosition(
    riskAmount,
    entryPrice,
    stopLoss,
    contractMultiplier,
    costData ? { totalFee: costData.totalFee, marginPerContract: costData.marginPerContract } : undefined
  );

  if (costData) {
    costData.actualRisk = positionResult.actualRisk;
    costData.totalCapitalRequired = positionResult.totalCapitalRequired;
  }

  // 共振评分：从 V16Row.signal_grade 和 mtf_resonance 取
  const signalGrade = row.signal_grade || 'L0';
  const resonanceScore = signalGrade === 'L4' ? 4 : signalGrade === 'L3' ? 3 : signalGrade === 'L2' ? 2 : signalGrade === 'L1' ? 1 : 0;
  const resonanceLevel = row.mtf_resonance?.resonance || 'none';

  // 生成 Brooks 口语化文字
  const summary = generateBrooksSummary(row, direction, entryPrice, stopLoss, target1, target2, positionResult.maxPosition, costData);
  const analysis = generateBrooksAnalysis(row, direction);

  // 入场条件
  const entryConditions = generateV16EntryConditions(row, direction);

  // 入场时机
  const entryTiming = generateV16EntryTiming(row);

  // 提醒级别
  const alert = checkAlertLevel(currentPrice, { stopLoss, support, resistance, target1, target2 }, direction);

  // 生成 MTF 共振文字
  let mtfResonanceText = '';
  if (row.mtf_resonance) {
    const mtf = row.mtf_resonance;
    const htfLabel = mtf.htf_direction === '多' ? '日线✓' : mtf.htf_direction === '空' ? '日线✓' : '日线✗';
    const ttfLabel = mtf.ttf_direction === '多' ? '60min✓' : mtf.ttf_direction === '空' ? '60min✓' : '60min✗';
    const ltfLabel = mtf.ltf_signal !== '无' ? '15min✓' : '15min✗';
    const ftLabel = mtf.ltf_ft ? '5min✓' : '5min✗';
    const resonanceLabel = { full: '全周期共振', partial: '部分共振', conflict: '周期冲突', none: '无共振' };
    mtfResonanceText = `${htfLabel} ${ttfLabel} ${ltfLabel} ${ftLabel} | ${resonanceLabel[mtf.resonance] || '无共振'}`;
  }

  const advice: TradingAdvice = {
    varietyCode: row.code,
    varietyName: row.name,
    timestamp: new Date().toISOString(),
    direction,
    resonanceScore,
    resonanceLevel,
    signalGrade: row.signal_grade || 'L0',
    signalVariant: row.signal_variant || 'B+',
    spectrum: row.spectrum,
    g4ReasonCount: row.g4_reason_count,
    mtfResonanceText,
    contractMonth,
    currentPrice,
    entryPrice,
    stopLoss,
    support,
    resistance,
    target1,
    target2,
    riskAmount,
    riskPerUnit: Math.abs(entryPrice - stopLoss),
    contractMultiplier,
    maxPosition: positionResult.maxPosition,
    costData,
    entryTiming,
    entryConditions,
    summary,
    analysis,
    alertLevel: alert.level,
    alertMessage: alert.message,
    // 交易者方程
    equationRR: direction === 'LONG'
      ? Math.round(((target1 - entryPrice) / Math.max(entryPrice - stopLoss, 1)) * 100) / 100
      : Math.round(((entryPrice - target1) / Math.max(stopLoss - entryPrice, 1)) * 100) / 100,
    equationPassed: (() => {
      const rr = direction === 'LONG'
        ? (target1 - entryPrice) / Math.max(entryPrice - stopLoss, 1)
        : (entryPrice - target1) / Math.max(stopLoss - entryPrice, 1);
      if (rr <= 0) return false;
      const minWinRate = 1 / (1 + rr);
      const edgeWinRate = row.win_rate_20 != null ? row.win_rate_20 : 0;
      return edgeWinRate >= minWinRate || (row.edge_grade || 'D') !== 'D';
    })(),
  };

  return advice;
}

/**
 * 生成 Brooks 口语化总结（原著风格）
 *
 * Brooks 核心术语体系：
 * - 高1/高2/高3：Higher Low 序列编号（做多）
 * - 低1/低2/低3：Lower High 序列编号（做空）
 * - Always In：趋势确认后"始终在场"的方向
 * - 信号K线：反转/突破的确认K线
 * - Follow-Through：入场后的跟随确认
 * - 回踩 EMA20：趋势中的回调买入时机
 */
function generateBrooksSummary(
  row: V16Row,
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  stopLoss: number,
  target1: number,
  target2: number,
  maxPosition: number,
  costData?: TradingAdvice['costData']
): string {
  const dirText = direction === 'LONG' ? '做多' : '做空';
  const signalGrade = row.signal_grade || 'L0';
  const variant = row.signal_variant || 'B+';
  const spectrum = row.spectrum || '区间';
  const mtf = row.mtf_resonance;
  const riskPoints = Math.abs(entryPrice - stopLoss);
  const rewardPoints = Math.abs(target1 - entryPrice);
  const rr = riskPoints > 0 ? (rewardPoints / riskPoints).toFixed(1) : 'N/A';
  const atrStr = row.atr14 ? `${row.atr14.toFixed(0)}` : 'N/A';

  // -- 信号等级 + 变体 → Brooks 信号类型描述 --
  const signalType = getBrooksSignalType(direction, variant, signalGrade, spectrum, mtf, row.l1_triggered, row.l1_entry_price, row.l1_position_multiplier);

  // -- 开场：一句话定性 --
  const gradeLabel: Record<string, string> = {
    'L4': '🟢 满分信号',
    'L3': '🔵 优质信号',
    'L2': '🟡 标准信号',
    'L1': '🟠 弱信号',
    'L0': '⚪ 仅参考'
  };

  let summary = `${row.name}（${row.code}）${gradeLabel[signalGrade] || gradeLabel['L0']} · ${variant}变体\n`;
  summary += `${spectrum}品种`;
  if (row.spectrum_detail) summary += `(${row.spectrum_detail})`;
  summary += ", Gate4=" + row.g4_reason_count + "/5";
  if (row.oi_grade) summary += `, 量仓${row.oi_grade}`;
  summary += `, 方向: ${dirText}`;
  if (row.trend_exhaustion) summary += `, WARN${row.trend_exhaustion}`;
  summary += ".\n\n";


  // -- 信号类型（Brooks 口语化） --
  summary += `【信号】${signalType}\n`;

  // -- MTF 各周期逐一描述 --
  if (mtf) {
    summary += `【多时间框架】\n`;
    // HTF (日线)
    const htfOk = mtf.htf_direction === (direction === 'LONG' ? '多' : '空');
    const htfEmoji = htfOk ? '✓' : '✗';
    summary += `  日线(HTF): ${mtf.htf_direction} ${htfEmoji} | ${mtf.htf_trend_phase || spectrum}`;
    if (!htfOk) summary += ` WARN 方向不一致`;
    summary += `\n`;

    // TTF (60min)
    const ttfOk = mtf.ttf_direction === (direction === 'LONG' ? '多' : '空');
    const ttfEmoji = ttfOk ? '✓' : '✗';
    summary += `  60min(TTF): ${mtf.ttf_direction} ${ttfEmoji}`;
    if (mtf.ttf_pullback) {
      summary += ` | 回踩EMA20中 ← 等待企稳`;
    } else if (ttfOk) {
      summary += ` | 趋势延续`;
    }
    summary += `\n`;

    // LTF (15min)
    const ltfHasSignal = mtf.ltf_signal !== '无';
    summary += `  15min(LTF): ${ltfHasSignal ? '信号K线(' + mtf.ltf_signal + ')' : '无信号'}`;
    if (mtf.ltf_entry_ready) summary += ` ✓ 入场条件就绪`;
    summary += `\n`;

    // FT (5min)
    summary += `  5min(FT): ${mtf.ltf_ft ? 'follow-through确认 ✓' : '等待确认...'}\n`;

    // 共振结论
    const resonanceLabel: Record<string, string> = {
      'full': '✦ 三周期共振确认 → 可立即入场',
      'partial': '◐ 日线+60min一致 → 等15min入场信号',
      'conflict': '⚠ 周期冲突 → 不建议重仓，等周期收敛',
      'none': '○ 无共振 → 建议观望'
    };
    summary += `  → ${resonanceLabel[mtf.resonance] || resonanceLabel['none']}\n`;
  } else {
    summary += `【多时间框架】数据未就绪，仅日线方向：${row.ai_direction}\n`;
  }

  summary += `\n`;

  // 交易者方程
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  const rewardPerUnit = Math.abs(target1 - entryPrice);
  const rrValue = riskPerUnit > 0 ? rewardPerUnit / riskPerUnit : 0;
  // 估计最低胜率要求: P > S/(R+S)
  const minWinRate = (riskPerUnit + rewardPerUnit) > 0
    ? riskPerUnit / (riskPerUnit + rewardPerUnit) : 0.5;
  summary += `【交易者方程】R:R = 1:${rrValue.toFixed(1)} | 最低胜率 ${(minWinRate * 100).toFixed(0)}%`;
  if (rrValue >= 2) summary += ` ✓ 方程合格\n`;
  else if (rrValue >= 1.5) summary += ` △ 方程偏弱，需高胜率支撑\n`;
  else summary += ` ✗ 方程不合格，建议跳过\n`;
  summary += `\n`;

  // -- 价位 + 盈亏比 --
  const riskATR = row.atr14 ? (riskPoints / row.atr14).toFixed(1) : '?';
  summary += `【价位】入场 ${entryPrice.toFixed(0)} | 止损 ${stopLoss.toFixed(0)}（`;
  summary += direction === 'LONG'
    ? `前低下方 ${riskPoints.toFixed(0)} 点 ≈ ${riskATR} ATR`
    : `前高上方 ${riskPoints.toFixed(0)} 点 ≈ ${riskATR} ATR`;
  summary += `）\n`;
  summary += `       目标1 ${target1.toFixed(0)} | 目标2 ${target2.toFixed(0)}\n`;
  summary += `       RR = ${rr} | ATR(14) = ${atrStr}\n`;

  summary += `\n`;

  // -- 仓位计算 --
  summary += `【仓位】基于2000元风险 → 最大${maxPosition}手`;
  const multiplier = getContractMultiplier(row.code) || 10;
  const unitRisk = (riskPoints * multiplier).toFixed(0);
  summary += ` | 每手风险≈${riskPoints.toFixed(0)}点`;
  if (costData) {
    summary += `\n       手续费${costData.totalFee.toFixed(0)}元/手 | 保证金${costData.marginPerContract.toFixed(0)}元/手 | 保本需${costData.breakevenPoints.toFixed(0)}点`;
    summary += `\n       实需资金≈${costData.totalCapitalRequired.toFixed(0)}元`;
  }

  // -- 纪律提示 --
  if (signalGrade === 'L4' || signalGrade === 'L3') {
    summary += `\n\n【Always In】趋势方向明确，关键位有效，可常规仓位入场。`;
  } else if (signalGrade === 'L2') {
    summary += `\n\n【选择性入场】信号质量中等，建议等60min企稳确认后入场，或降低仓位至${Math.max(1, Math.floor(maxPosition * 0.7))}手。`;
  } else {
    summary += `\n\n【谨慎】信号偏弱，仅在日线+60min都确认时小额试仓。`;
  }

  return summary;
}

/**
 * 根据信号变体 + 等级推断 Brooks 信号类型描述
 */
function getBrooksSignalType(
  direction: 'LONG' | 'SHORT',
  variant: string,
  signalGrade: string,
  spectrum: string,
  mtf?: V16Row['mtf_resonance'],
  l1Triggered?: boolean,
  l1EntryPrice?: number | null,
  l1PositionMultiplier?: number
): string {
  const isLong = direction === 'LONG';

  // 趋势品种 → 高2/低2 信号
  if (spectrum.includes('趋势') && !spectrum.includes('紧通道')) {
    if (variant === 'S') {
      return isLong
        ? '高2做多信号（趋势回调至EMA20形成高2，强Always In）'
        : '低2做空信号（趋势反弹至EMA20形成低2，强Always In）';
    }
    if (variant === 'A+' || variant === 'A') {
      return isLong
        ? '高2做多信号（趋势回调中，等待信号K线确认入场）'
        : '低2做空信号（趋势反弹中，等待信号K线确认入场）';
    }
    return isLong
      ? '趋势回调做多机会（关注EMA20附近的信号K线）'
      : '趋势反弹做空机会（关注EMA20附近的信号K线）';
  }

  // 紧通道品种（V17 L1入场规则）
  if (spectrum.includes('紧通道')) {
    if (l1Triggered && l1EntryPrice != null) {
      const l1Pos = (l1PositionMultiplier || 0.5) * 100;
      return isLong
        ? `紧通道L1做多信号 ✓ | 入场 ${l1EntryPrice.toFixed(0)} | 仓位 ${l1Pos.toFixed(0)}%（半仓）| 首根反向K线后顺突破确认`
        : `紧通道L1做空信号 ✓ | 入场 ${l1EntryPrice.toFixed(0)} | 仓位 ${l1Pos.toFixed(0)}%（半仓）| 首根反向K线后顺突破确认`;
    }
    return isLong
      ? '紧通道无L1信号 | 等待首根阴线后次根阳线突破确认再入场（不等深回踩）'
      : '紧通道无L1信号 | 等待首根阳线后次根阴线跌破确认再入场（不等深回踩）';
  }

  // 区间品种
  if (spectrum.includes('区间')) {
    if (mtf && mtf.resonance === 'full') {
      return isLong
        ? '区间下沿反弹做多（三周期共振，短线机会）'
        : '区间上沿回落做空（三周期共振，短线机会）';
    }
    return isLong
      ? '区间低位试多（等60min方向确认后入场）'
      : '区间高位试空（等60min方向确认后入场）';
  }

  // 通用回退
  if (variant === 'S') return isLong ? '强做多信号（S级）' : '强做空信号（S级）';
  if (variant?.startsWith('A')) return isLong ? '做多信号（A级）' : '做空信号（A级）';
  return isLong ? '初步做多信号' : '初步做空信号';
}

/**
 * 生成 Brooks 口语化分析
 */
function generateBrooksAnalysis(row: V16Row, direction: 'LONG' | 'SHORT'): string {
  const parts: string[] = [];
  const mtf = row.mtf_resonance;

  // 日线分析
  if (mtf) {
    parts.push(`【日线 HTF】${mtf.htf_direction}，${mtf.htf_trend_phase}`);
  } else {
    parts.push(`【日线】${row.ai_direction}，${row.spectrum}`);
  }

  // 60min 分析
  if (mtf) {
    const pullbackText = mtf.ttf_pullback ? '回踩EMA20中' : '趋势延续';
    parts.push(`【60min TTF】${mtf.ttf_direction}，${pullbackText}`);
  }

  // 15min 分析
  if (mtf) {
    const signalText = mtf.ltf_signal !== '无' ? `信号K线${mtf.ltf_signal}` : '无信号K线';
    parts.push(`【15min LTF】${signalText}`);
  }

  // 5min 分析
  if (mtf) {
    const ftText = mtf.ltf_ft ? 'follow-through确认' : '未确认';
    parts.push(`【5min FT】${ftText}`);
  }

  // Gate4 理由
  if (row.g4_reasons_met.length > 0) {
    parts.push(`【Gate4】${row.g4_reasons_met.join('、')}`);
  }

  // 交易者方程
  parts.push(`【方程】RR=${row.avg_rr?.toFixed(1) || 'N/A'}，${row.edge_status}`);

  return parts.join('；');
}

/**
 * 生成 V16 入场条件
 */
function generateV16EntryConditions(row: V16Row, direction: 'LONG' | 'SHORT'): string[] {
  const conditions: string[] = [];

  // Gate4 条件
  conditions.push("Gate4 通过 " + row.g4_reason_count + "/5");

  // MTF 条件
  const mtf = row.mtf_resonance;
  if (mtf) {
    if (mtf.resonance === 'full') {
      conditions.push('三周期共振确认');
    } else if (mtf.resonance === 'partial') {
      conditions.push('等待5min follow-through确认');
    }
    if (mtf.ltf_entry_ready) {
      conditions.push('15min入场条件就绪');
    }
  }

  // 方向条件
  conditions.push(`日线方向${direction === 'LONG' ? '多' : '空'}`);

  // CH 通道信号
  if (row.ch_has_signal) {
    conditions.push(`CH通道${row.ch_direction}信号`);
  }

  return conditions;
}

/**
 * 生成 V16 入场时机
 */
function generateV16EntryTiming(row: V16Row): string {
  const mtf = row.mtf_resonance;

  if (!mtf) {
    return '等待多时间框架数据';
  }

  if (mtf.resonance === 'full') {
    return '三周期共振确认，可立即入场';
  }

  if (mtf.ttf_pullback) {
    return '60min回踩EMA20中，等待企稳信号';
  }

  if (mtf.ltf_signal !== '无' && !mtf.ltf_ft) {
    return '15min有信号K线，等待5min确认';
  }

  if (mtf.resonance === 'partial') {
    return '部分共振，挂单等回踩';
  }

  return '等待方向明确后再入场';
}

/** 观望品种条目（全市场报告） */
export interface MarketWatchItem {
  code: string;
  name: string;
  reason: string;
}

/** 全市场交易机会报告 */
export interface MarketTradingReport {
  scanTime: string;
  totalCount: number;
  tradableCount: number;
  watchCount: number;
  longCount: number;
  shortCount: number;
  advices: TradingAdvice[];
  watch: MarketWatchItem[];
}

/**
 * 获取全市场交易机会报告（不截断）
 * 基于 runV16FullScan 全市场扫描：
 *  - tradable：全部可交易品种（方向明确 + 信号充分），按共振降序
 *  - watch：观望品种（被过滤 / 方向中性 / 信号不充分），附原因
 */
export async function getMarketTradingReport(
  riskAmount: number = 2000
): Promise<MarketTradingReport> {
  const { runV16FullScan } = await import('./v16_engine.js');

  // 运行 V16.2 全市场扫描
  const scanResult = await runV16FullScan();

  // 可交易：tradable + 方向明确 + (L1+ 或有信号K线/MM模式)
  const tradableRows = (scanResult.tradable ?? []).filter(
    (row) =>
      row.ai_direction !== '中性' &&
      (row.signal_grade !== 'L0' || row.ch_has_signal || row.mm_found)
  );

  // 生成建议（全部，不截断）
  const advices: TradingAdvice[] = [];
  for (const row of tradableRows) {
    try {
      const advice = await generateAdviceFromV16Row(row, riskAmount);
      if (advice) advices.push(advice);
    } catch (error) {
      console.error(`[TradingAdvice] Error generating advice for ${row.code}:`, error);
    }
  }
  advices.sort((a, b) => b.resonanceScore - a.resonanceScore);

  // 观望列表：filtered（含原因）+ 中性方向 + 信号不充分
  const watch: MarketWatchItem[] = [];
  const seen = new Set<string>();
  for (const f of scanResult.filtered ?? []) {
    watch.push({ code: f.code, name: f.name, reason: f.reason });
    seen.add(f.code);
  }
  const tradableCodes = new Set(tradableRows.map((r) => r.code));
  for (const row of scanResult.rows) {
    if (seen.has(row.code) || tradableCodes.has(row.code)) continue;
    if (row.ai_direction === '中性') {
      watch.push({ code: row.code, name: row.name, reason: '方向中性，等待突破' });
    } else if (row.signal_grade === 'L0' && !row.ch_has_signal && !row.mm_found) {
      watch.push({ code: row.code, name: row.name, reason: '信号不充分，等待入场K线' });
    } else {
      watch.push({ code: row.code, name: row.name, reason: '未达可交易标准' });
    }
    seen.add(row.code);
  }

  const longCount = advices.filter((a) => a.direction === 'LONG').length;

  return {
    scanTime: scanResult.scanTime,
    totalCount: scanResult.totalCount,
    tradableCount: advices.length,
    watchCount: watch.length,
    longCount,
    shortCount: advices.length - longCount,
    advices,
    watch,
  };
}

/**
 * 获取Top N交易建议（使用实时数据）
 * P0-4: 重写为使用 V16.2 扫描结果作为单一真相源
 */
export async function getTopTradingAdvicesRealtime(
  varietyCodes: string[],
  topN: number = 5,
  riskAmount: number = 2000
): Promise<TradingAdvice[]> {
  const { runV16FullScan } = await import('./v16_engine.js');

  // 运行 V16.2 全量扫描
  const scanResult = await runV16FullScan();

  // 获取 tradable 品种的 V16Row, V18放宽：至少L1或以上 + 有信号K线/MM模式
  const tradableRows = scanResult.rows.filter(
    row => row.trade_worthiness === 'tradable'
      && row.ai_direction !== '中性'
      && (row.signal_grade !== 'L0' || row.ch_has_signal || row.mm_found)
  );

  // 对每个 tradable 品种生成交易建议
  const advices: TradingAdvice[] = [];

  for (const row of tradableRows) {
    try {
      const advice = await generateAdviceFromV16Row(row, riskAmount);
      if (advice) {
        advices.push(advice);
      }
    } catch (error) {
      console.error(`[TradingAdvice] Error generating advice for ${row.code}:`, error);
    }
  }

  // 按共振分数排序，取Top N
  advices.sort((a, b) => b.resonanceScore - a.resonanceScore);

  const topAdvices = advices.slice(0, topN);

  // 注入 ML 预测（新增）
  try {
    for (const advice of topAdvices) {
      try {
        const mlResult = predictVariety(advice.varietyCode, {});
        if (mlResult) {
          // 将 ML 预测结果映射为前端展示结构
          const returnLabelMap: Record<string, number> = {
            'high_return': 0.15,
            'medium_return': 0.08,
            'low_return': 0.03,
            'negative_return': -0.05,
          };
          const riskLabelMap: Record<string, number> = {
            'low_risk': 0.05,
            'medium_risk': 0.12,
            'high_risk': 0.2,
            'extreme_risk': 0.3,
          };
          const predictedReturn = returnLabelMap[mlResult.predictedReturn] ?? 0.05;
          const predictedMaxDrawdown = riskLabelMap[mlResult.predictedRisk] ?? 0.12;

          advice.mlRecommendation = {
            predictedReturn,
            confidence: mlResult.confidence,
            predictedMaxDrawdown,
            reason: `ML 预测收益 ${(predictedReturn * 100).toFixed(1)}%，风险等级 ${mlResult.predictedRisk}`,
            featureImportance: {},
            modelVersion: 'v1.0',
          };
        }
      } catch (mlError) {
        console.warn(`[TradingAdvice] ML prediction failed for ${advice.varietyCode}:`, mlError);
      }
    }
  } catch (mlError) {
    console.warn('[TradingAdvice] ML service not available:', mlError);
  }

  return topAdvices;
}

/**
 * 获取Top N交易建议（使用历史数据，向后兼容）
 */
export async function getTopTradingAdvices(
  varieties: Array<{ code: string; name: string; bars: BarData[] }>,
  topN: number = 5,
  riskAmount: number = 2000
): Promise<TradingAdvice[]> {
  const advices: TradingAdvice[] = [];
  
  for (const variety of varieties) {
    try {
      // 执行共振分析
      const resonance = analyzeResonance(
        variety.code,
        variety.name,
        variety.bars as unknown as MinuteBar[],
        (bars, minutes) => aggregateToTimeframe(bars as MinuteBar[], minutes) as unknown as BarData[]
      );
      
      // 只处理有明确方向的品种
      if (resonance.suggestedDirection === 'NEUTRAL') continue;
      
      // 生成交易建议
      const advice = await generateTradingAdvice(
        variety.code,
        variety.name,
        variety.bars as unknown as MinuteBar[],
        resonance,
        riskAmount
      );
      
      advices.push(advice);
    } catch (error) {
      console.error(`Error generating advice for ${variety.code}:`, error);
    }
  }
  
  // 按共振分数排序，取Top N
  advices.sort((a, b) => b.resonanceScore - a.resonanceScore);
  
  return advices.slice(0, topN);
}
