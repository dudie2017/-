/**
 * 多周期共振分析服务
 * 
 * 分析链路：
 * - 日线：定方向（AI方向、趋势阶段、关键位）
 * - 60min：找结构（回踩形态、EMA支撑阻力、通道位置）
 * - 15min：精确入场（信号K线、入场K线）
 * - 5min：确认执行（follow-through、微形态）
 */

import { calcEMA, calcATR } from './indicators.js';
import type { MinuteBar } from './localDataLoader.js';
import type { KlineBar } from './localDataLoader.js';
import { getMultiTimeframeDataAKShare, type AKShareBar } from './akshareService.js';

// 周期类型
export type TimeframeType = 'daily' | '60min' | '15min' | '5min';

// AI方向
export type AIDirection = 'LONG' | 'SHORT' | 'NEUTRAL';

// 趋势阶段
export type TrendPhase = 
  | 'STRONG_TREND'      // 强趋势（价格远离EMA20）
  | 'PULLBACK'          // 回踩（价格靠近EMA20）
  | 'BREAKOUT'          // 突破（价格穿越EMA20）
  | 'RANGE';            // 区间（价格在EMA20附近震荡）

// 单周期分析结果
export interface TimeframeAnalysis {
  timeframe: TimeframeType;
  aiDirection: AIDirection;
  trendPhase: TrendPhase;
  ema20Slope: number;           // EMA20斜率（正=上升，负=下降）
  distanceFromEMA20: number;    // 距离EMA20的百分比
  atrPercent: number;           // ATR占价格百分比（波动率）
  signalBar: boolean;           // 是否出现信号K线
  followThrough: boolean;       // 是否有follow-through
  keyLevel: {                   // 关键位
    support: number;
    resistance: number;
  } | null;
}

// 共振分析结果
export interface ResonanceAnalysis {
  varietyCode: string;
  varietyName: string;
  timestamp: string;
  
  // 各周期分析
  timeframes: {
    daily: TimeframeAnalysis;
    '60min': TimeframeAnalysis;
    '15min': TimeframeAnalysis;
    '5min': TimeframeAnalysis;
  };
  
  // 共振评分
  resonanceScore: number;       // 0-4分
  resonanceLevel: 'STRONG' | 'MEDIUM' | 'WEAK' | 'CONFLICT';
  
  // 交易建议
  suggestedDirection: AIDirection;
  suggestedPosition: number;    // 建议仓位百分比 0-100
  suggestedAction: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT' | 'REDUCE';
  
  // 分析说明
  analysis: string;
}

// 通用K线类型，兼容MinuteBar和KlineBar
interface GenericBar {
  o: number;
  h: number;
  l: number;
  c: number;
  t?: string;
  datetime?: string;
}

/**
 * 分析单个周期
 */
function analyzeTimeframe(bars: GenericBar[], timeframe: TimeframeType): TimeframeAnalysis {
  if (bars.length < 30) {
    return {
      timeframe,
      aiDirection: 'NEUTRAL',
      trendPhase: 'RANGE',
      ema20Slope: 0,
      distanceFromEMA20: 0,
      atrPercent: 0,
      signalBar: false,
      followThrough: false,
      keyLevel: null
    };
  }

  const closes = bars.map(b => b.c);
  const highs = bars.map(b => b.h);
  const lows = bars.map(b => b.l);
  
  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  
  // 手动计算ATR
  const atrValues: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      atrValues.push(bars[i].h - bars[i].l);
    } else {
      const tr = Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i-1].c),
        Math.abs(bars[i].l - bars[i-1].c)
      );
      atrValues.push(tr);
    }
  }
  // 平滑ATR
  const atr: number[] = [];
  for (let i = 0; i < atrValues.length; i++) {
    if (i < 14) {
      atr.push(atrValues[i]);
    } else {
      atr.push((atr[i-1] * 13 + atrValues[i]) / 14);
    }
  }
  
  const lastBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2];
  const lastIdx = bars.length - 1;
  
  // 1. AI方向判断
  // Always In方向 = 价格相对于EMA20的位置 + EMA斜率方向
  let aiDirection: AIDirection = 'NEUTRAL';
  const priceAboveEMA20 = lastBar.c > ema20[lastIdx];
  const ema5AboveEMA20 = ema5[lastIdx] > ema20[lastIdx];
  
  if (priceAboveEMA20 && ema5AboveEMA20) {
    aiDirection = 'LONG';
  } else if (!priceAboveEMA20 && !ema5AboveEMA20) {
    aiDirection = 'SHORT';
  }
  
  // 2. EMA20斜率（最近5根K线的变化率）
  const ema20Slope = (ema20[lastIdx] - ema20[lastIdx - 5]) / ema20[lastIdx - 5] * 100;
  
  // 3. 距离EMA20的百分比
  const distanceFromEMA20 = (lastBar.c - ema20[lastIdx]) / ema20[lastIdx] * 100;
  
  // 4. 趋势阶段判断
  let trendPhase: TrendPhase;
  const absDistance = Math.abs(distanceFromEMA20);
  const atrPct = (atr[lastIdx] / lastBar.c) * 100;
  
  if (absDistance > atrPct * 2) {
    trendPhase = 'STRONG_TREND';
  } else if (absDistance < atrPct * 0.5) {
    // 检查是否在突破
    const prevDistance = Math.abs((prevBar.c - ema20[lastIdx - 1]) / ema20[lastIdx - 1] * 100);
    if (prevDistance > atrPct) {
      trendPhase = 'BREAKOUT';
    } else {
      trendPhase = 'RANGE';
    }
  } else {
    trendPhase = 'PULLBACK';
  }
  
  // 5. 信号K线检测
  // 看涨信号K线：收盘价>开盘价，且下影线较长（有买入意愿）
  // 看跌信号K线：收盘价<开盘价，且上影线较长（有卖出意愿）
  const bodySize = Math.abs(lastBar.c - lastBar.o);
  const upperShadow = lastBar.h - Math.max(lastBar.c, lastBar.o);
  const lowerShadow = Math.min(lastBar.c, lastBar.o) - lastBar.l;
  const totalRange = lastBar.h - lastBar.l;
  
  let signalBar = false;
  if (totalRange > 0) {
    // 看涨信号K线：下影线 > 实体 * 2，且收盘价在上半部分
    if (lowerShadow > bodySize * 2 && lastBar.c > (lastBar.h + lastBar.l) / 2) {
      signalBar = true;
    }
    // 看跌信号K线：上影线 > 实体 * 2，且收盘价在下半部分
    if (upperShadow > bodySize * 2 && lastBar.c < (lastBar.h + lastBar.l) / 2) {
      signalBar = true;
    }
  }
  
  // 6. Follow-through检测
  // 如果前一根是信号K线，当前K线延续方向
  let followThrough = false;
  if (prevBar) {
    const prevBody = prevBar.c - prevBar.o;
    const currBody = lastBar.c - lastBar.o;
    // 同方向延续
    if ((prevBody > 0 && currBody > 0) || (prevBody < 0 && currBody < 0)) {
      if (Math.abs(currBody) > Math.abs(prevBody) * 0.5) {
        followThrough = true;
      }
    }
  }
  
  // 7. 关键位计算（最近20根K线的高低点）
  const recentBars = bars.slice(-20);
  const support = Math.min(...recentBars.map(b => b.l));
  const resistance = Math.max(...recentBars.map(b => b.h));
  
  return {
    timeframe,
    aiDirection,
    trendPhase,
    ema20Slope,
    distanceFromEMA20,
    atrPercent: atrPct,
    signalBar,
    followThrough,
    keyLevel: { support, resistance }
  };
}

/**
 * 计算共振评分
 */
function calculateResonance(analyses: Record<TimeframeType, TimeframeAnalysis>): {
  score: number;
  level: 'STRONG' | 'MEDIUM' | 'WEAK' | 'CONFLICT';
  direction: AIDirection;
  position: number;
  action: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT' | 'REDUCE';
  analysis: string;
} {
  const timeframes: TimeframeType[] = ['daily', '60min', '15min', '5min'];
  
  // 统计各方向的数量
  let longCount = 0;
  let shortCount = 0;
  let neutralCount = 0;
  
  const directions: string[] = [];
  
  for (const tf of timeframes) {
    const analysis = analyses[tf];
    directions.push(`${tf}:${analysis.aiDirection}`);
    
    switch (analysis.aiDirection) {
      case 'LONG':
        longCount++;
        break;
      case 'SHORT':
        shortCount++;
        break;
      case 'NEUTRAL':
        neutralCount++;
        break;
    }
  }
  
  // 计算共振分数
  let score = 0;
  let level: 'STRONG' | 'MEDIUM' | 'WEAK' | 'CONFLICT';
  let direction: AIDirection;
  let position: number;
  let action: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT' | 'REDUCE';
  
  if (longCount >= 3) {
    score = longCount;
    level = longCount === 4 ? 'STRONG' : 'MEDIUM';
    direction = 'LONG';
    position = longCount === 4 ? 100 : 75;
    action = 'ENTER_LONG';
  } else if (shortCount >= 3) {
    score = shortCount;
    level = shortCount === 4 ? 'STRONG' : 'MEDIUM';
    direction = 'SHORT';
    position = shortCount === 4 ? 100 : 75;
    action = 'ENTER_SHORT';
  } else if (longCount === 2 || shortCount === 2) {
    score = 2;
    level = 'WEAK';
    direction = longCount > shortCount ? 'LONG' : 'SHORT';
    position = 50;
    action = longCount > shortCount ? 'ENTER_LONG' : 'ENTER_SHORT';
  } else {
    score = 0;
    level = 'CONFLICT';
    direction = 'NEUTRAL';
    position = 0;
    action = 'WAIT';
  }
  
  // 生成分析说明
  const analysisParts: string[] = [];
  
  // 日线分析
  const daily = analyses.daily;
  analysisParts.push(`日线: AI${daily.aiDirection === 'LONG' ? '多' : daily.aiDirection === 'SHORT' ? '空' : '中性'}, ${getTrendPhaseText(daily.trendPhase)}`);
  
  // 60min分析
  const min60 = analyses['60min'];
  analysisParts.push(`60min: AI${min60.aiDirection === 'LONG' ? '多' : min60.aiDirection === 'SHORT' ? '空' : '中性'}, ${getTrendPhaseText(min60.trendPhase)}`);
  
  // 15min分析
  const min15 = analyses['15min'];
  if (min15.signalBar) {
    analysisParts.push(`15min: 出现信号K线`);
  }
  
  // 5min分析
  const min5 = analyses['5min'];
  if (min5.followThrough) {
    analysisParts.push(`5min: follow-through确认`);
  }
  
  const analysis = analysisParts.join(' | ');
  
  return { score, level, direction, position, action, analysis };
}

function getTrendPhaseText(phase: TrendPhase): string {
  switch (phase) {
    case 'STRONG_TREND': return '强趋势';
    case 'PULLBACK': return '回踩中';
    case 'BREAKOUT': return '突破';
    case 'RANGE': return '区间震荡';
  }
}

/**
 * 执行多周期共振分析
 */
/**
 * 使用实时数据进行共振分析
 * 支持混合数据源：日线数据 + 当日分钟线数据
 */
export function analyzeResonanceRealtime(
  varietyCode: string,
  varietyName: string,
  dailyBars: Array<{ date: string; o: number; h: number; l: number; c: number; vol: number }>,
  minuteBars: Array<{ date: string; time?: string; o: number; h: number; l: number; c: number; vol: number }>
): ResonanceAnalysis {
  // 日线分析：直接使用日线数据
  const dailyAnalysis = analyzeTimeframe(dailyBars as GenericBar[], 'daily');

  // 分钟线分析：使用当日分钟线数据聚合
  let min60Analysis: TimeframeAnalysis;
  let min15Analysis: TimeframeAnalysis;
  let min5Analysis: TimeframeAnalysis;

  if (minuteBars.length > 0) {
    // 聚合分钟线到各周期
    const min60Bars = aggregateMinuteBars(minuteBars, 60);
    const min15Bars = aggregateMinuteBars(minuteBars, 15);
    const min5Bars = aggregateMinuteBars(minuteBars, 5);

    min60Analysis = analyzeTimeframe(min60Bars as GenericBar[], '60min');
    min15Analysis = analyzeTimeframe(min15Bars as GenericBar[], '15min');
    min5Analysis = analyzeTimeframe(min5Bars as GenericBar[], '5min');
  } else {
    // 如果没有分钟线数据，使用日线数据作为fallback
    min60Analysis = analyzeTimeframe(dailyBars.slice(-20) as GenericBar[], '60min');
    min15Analysis = analyzeTimeframe(dailyBars.slice(-20) as GenericBar[], '15min');
    min5Analysis = analyzeTimeframe(dailyBars.slice(-20) as GenericBar[], '5min');
  }

  const timeframes = {
    daily: dailyAnalysis,
    '60min': min60Analysis,
    '15min': min15Analysis,
    '5min': min5Analysis
  };

  // 计算共振
  const resonance = calculateResonance(timeframes);

  // 获取最新时间戳
  const lastBar = minuteBars.length > 0 ? minuteBars[minuteBars.length - 1] : dailyBars[dailyBars.length - 1];
  const lastBarWithTime = lastBar as { date: string; time?: string };
  const timestamp = lastBarWithTime.date + (lastBarWithTime.time ? ' ' + lastBarWithTime.time : '');

  return {
    varietyCode,
    varietyName,
    timestamp,
    timeframes,
    resonanceScore: resonance.score,
    resonanceLevel: resonance.level,
    suggestedDirection: resonance.direction,
    suggestedPosition: resonance.position,
    suggestedAction: resonance.action,
    analysis: resonance.analysis
  };
}

/**
 * 聚合分钟线到指定周期
 */
function aggregateMinuteBars(
  bars: Array<{ date: string; time?: string; o: number; h: number; l: number; c: number; vol: number }>,
  minutes: number
): Array<{ date: string; time: string; o: number; h: number; l: number; c: number; vol: number }> {
  if (bars.length === 0) return [];

  const result: Array<{ date: string; time: string; o: number; h: number; l: number; c: number; vol: number }> = [];
  let currentBar: typeof result[0] | null = null;

  for (const bar of bars) {
    // 如果没有time字段，使用date作为标识
    const timeStr = bar.time || '00:00';
    const [hour, min] = timeStr.split(':').map(Number);
    const totalMinutes = hour * 60 + min;
    const windowStart = Math.floor(totalMinutes / minutes) * minutes;
    const windowTime = `${String(Math.floor(windowStart / 60)).padStart(2, '0')}:${String(windowStart % 60).padStart(2, '0')}`;

    if (!currentBar || currentBar.time !== windowTime) {
      if (currentBar) {
        result.push({ ...currentBar });
      }
      currentBar = {
        date: bar.date,
        time: windowTime,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        vol: bar.vol
      };
    } else {
      currentBar.h = Math.max(currentBar.h, bar.h);
      currentBar.l = Math.min(currentBar.l, bar.l);
      currentBar.c = bar.c;
      currentBar.vol += bar.vol;
    }
  }

  if (currentBar) {
    result.push({ ...currentBar });
  }

  return result;
}

export function analyzeResonance(
  varietyCode: string,
  varietyName: string,
  bars: MinuteBar[],
  aggregateFn: (bars: MinuteBar[], minutes: number) => KlineBar[]
): ResonanceAnalysis {
  // 聚合到各周期
  const dailyBars = aggregateFn(bars, 24 * 60);  // 日线
  const min60Bars = aggregateFn(bars, 60);        // 60分钟
  const min15Bars = aggregateFn(bars, 15);        // 15分钟
  const min5Bars = aggregateFn(bars, 5);          // 5分钟
  
  // 分析各周期
  const dailyAnalysis = analyzeTimeframe(dailyBars, 'daily');
  const min60Analysis = analyzeTimeframe(min60Bars, '60min');
  const min15Analysis = analyzeTimeframe(min15Bars, '15min');
  const min5Analysis = analyzeTimeframe(min5Bars, '5min');
  
  const timeframes = {
    daily: dailyAnalysis,
    '60min': min60Analysis,
    '15min': min15Analysis,
    '5min': min5Analysis
  };
  
  // 计算共振
  const resonance = calculateResonance(timeframes);
  
  // 获取最新时间戳
  const lastBar = bars[bars.length - 1];
  const timestamp = lastBar.datetime || lastBar.date + ' ' + lastBar.time;
  
  return {
    varietyCode,
    varietyName,
    timestamp,
    timeframes,
    resonanceScore: resonance.score,
    resonanceLevel: resonance.level,
    suggestedDirection: resonance.direction,
    suggestedPosition: resonance.position,
    suggestedAction: resonance.action,
    analysis: resonance.analysis
  };
}

/**
 * 批量分析多个品种的共振
 */
export function analyzeResonanceBatch(
  varieties: Array<{
    code: string;
    name: string;
    bars: MinuteBar[];
  }>,
  aggregateFn: (bars: MinuteBar[], minutes: number) => KlineBar[]
): ResonanceAnalysis[] {
  return varieties.map(v => analyzeResonance(v.code, v.name, v.bars, aggregateFn));
}

/**
 * 筛选高共振品种
 */
export function filterHighResonance(
  analyses: ResonanceAnalysis[],
  minScore: number = 3
): ResonanceAnalysis[] {
  return analyses
    .filter(a => a.resonanceScore >= minScore)
    .sort((a, b) => b.resonanceScore - a.resonanceScore);
}

// ==================== Tushare真实数据源支持 ====================

import { getMultiTimeframeData, convertToBarData } from './tushareService.js';

/**
 * 使用Tushare真实数据源进行多周期共振分析
 * 直接获取日线、60min、15min、5min数据，不再从分钟线聚合
 */
export async function analyzeResonanceWithTushare(
  varietyCode: string,
  varietyName: string
): Promise<ResonanceAnalysis> {
  // 获取各周期真实数据
  const data = await getMultiTimeframeData(varietyCode);
  
  // 转换为KlineBar格式
  const dailyBars = convertToKlineBars(data.daily);
  const h1Bars = convertToKlineBars(data.h1);
  const m15Bars = convertToKlineBars(data.m15);
  const m5Bars = convertToKlineBars(data.m5);
  
  // 分析各周期
  const dailyAnalysis = analyzeTimeframe(dailyBars, 'daily');
  const h1Analysis = analyzeTimeframe(h1Bars, '60min');
  const m15Analysis = analyzeTimeframe(m15Bars, '15min');
  const m5Analysis = analyzeTimeframe(m5Bars, '5min');
  
  // 计算共振
  const resonance = calculateResonanceScore(dailyAnalysis, h1Analysis, m15Analysis);
  
  return {
    varietyCode,
    varietyName,
    timeframes: {
      daily: dailyAnalysis,
      '60min': h1Analysis,
      '15min': m15Analysis,
      '5min': m5Analysis
    },
    resonanceScore: resonance.score,
    resonanceLevel: resonance.score >= 3 ? 'STRONG' : resonance.score >= 2 ? 'MEDIUM' : resonance.score >= 1 ? 'WEAK' : 'CONFLICT',
    suggestedDirection: resonance.direction,
    suggestedPosition: resonance.position * 100,
    suggestedAction: resonance.action,
    analysis: resonance.analysis,
    timestamp: new Date().toISOString()
  };
}

/**
 * 转换Tushare数据格式为KlineBar
 */
function convertToKlineBars(bars: Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>): KlineBar[] {
  return bars.map(bar => ({
    date: bar.date,
    o: bar.o,
    h: bar.h,
    l: bar.l,
    c: bar.c,
    vol: bar.v
  }));
}

/**
 * 计算共振评分
 */
function calculateResonanceScore(
  daily: TimeframeAnalysis,
  h1: TimeframeAnalysis,
  m15: TimeframeAnalysis
): { score: number; direction: AIDirection; position: number; action: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT' | 'REDUCE'; analysis: string } {
  let score = 0;
  const directions: AIDirection[] = [];
  
  if (daily.aiDirection) directions.push(daily.aiDirection);
  if (h1.aiDirection) directions.push(h1.aiDirection);
  if (m15.aiDirection) directions.push(m15.aiDirection);
  
  // 计算方向一致性
  const bullCount = directions.filter(d => d === 'LONG').length;
  const bearCount = directions.filter(d => d === 'SHORT').length;
  
  if (bullCount >= 2) {
    score = bullCount;
    if (bullCount === 3) score = 4; // 三周期共振
  } else if (bearCount >= 2) {
    score = bearCount;
    if (bearCount === 3) score = 4;
  }
  
  const direction: AIDirection = bullCount > bearCount ? 'LONG' : bearCount > bullCount ? 'SHORT' : 'NEUTRAL';
  
  // 计算仓位
  let position = 0.3; // 基础仓位
  if (score >= 3) position = 0.6; // 强共振
  else if (score >= 2) position = 0.4; // 中共振
  
  // 交易信号
  let action: 'ENTER_LONG' | 'ENTER_SHORT' | 'WAIT' | 'REDUCE' = 'WAIT';
  if (score >= 2 && direction === 'LONG') action = 'ENTER_LONG';
  else if (score >= 2 && direction === 'SHORT') action = 'ENTER_SHORT';
  else if (score === 0) action = 'REDUCE';
  
  const analysis = `共振评分:${score}, 方向:${direction}, 周期一致性:${bullCount}多/${bearCount}空`;
  
  return { score, direction, position, action, analysis };
}

// ==================== AKShare 真实数据源支持 ====================

/**
 * 使用AKShare真实数据源进行多周期共振分析
 * AKShare 是免费的，可以获取期货分钟数据
 * 
 * 数据源优先级：
 * 1. AKShare（免费，新浪数据源）
 * 2. 如果AKShare失败，使用日线数据作为降级方案
 */
export async function analyzeResonanceWithAKShare(
  varietyCode: string,
  varietyName: string
): Promise<ResonanceAnalysis> {
  // 转换品种代码格式: AG -> ag0 (主力合约)
  const akSymbol = varietyCode.toLowerCase() + '0';
  
  try {
    // 获取各周期真实数据
    const data = await getMultiTimeframeDataAKShare(akSymbol);
    
    if (!data.success || !data.data) {
      throw new Error(`AKShare数据获取失败: ${data.error}`);
    }
    
    // 转换为KlineBar格式
    const m60Bars = convertAKShareToKlineBars(data.data.m60);
    const m15Bars = convertAKShareToKlineBars(data.data.m15);
    const m5Bars = convertAKShareToKlineBars(data.data.m5);
    
    // 分析各周期
    const m60Analysis = analyzeTimeframe(m60Bars, '60min');
    const m15Analysis = analyzeTimeframe(m15Bars, '15min');
    const m5Analysis = analyzeTimeframe(m5Bars, '5min');
    
    // 计算共振
    const resonance = calculateResonanceScore(m60Analysis, m15Analysis, m5Analysis);
    
    return {
      varietyCode,
      varietyName,
      timeframes: {
        daily: m60Analysis, // 使用60min作为日线替代（因为AKShare没有日线）
        '60min': m60Analysis,
        '15min': m15Analysis,
        '5min': m5Analysis
      },
      resonanceScore: resonance.score,
      resonanceLevel: resonance.score >= 3 ? 'STRONG' : resonance.score >= 2 ? 'MEDIUM' : resonance.score >= 1 ? 'WEAK' : 'CONFLICT',
      suggestedDirection: resonance.direction,
      suggestedPosition: resonance.position * 100,
      suggestedAction: resonance.action,
      analysis: resonance.analysis,
      timestamp: new Date().toISOString()
    };
  } catch (error: any) {
    console.error(`AKShare分析失败，使用降级方案: ${error.message}`);
    
    // 降级方案：使用模拟数据
    return createFallbackAnalysis(varietyCode, varietyName);
  }
}

/**
 * 降级方案：当AKShare不可用时返回基础分析
 */
function createFallbackAnalysis(varietyCode: string, varietyName: string): ResonanceAnalysis {
  const fallbackAnalysis: TimeframeAnalysis = {
    timeframe: '60min',
    aiDirection: 'NEUTRAL',
    trendPhase: 'RANGE',
    ema20Slope: 0,
    distanceFromEMA20: 0,
    atrPercent: 0,
    signalBar: false,
    followThrough: false,
    keyLevel: null
  };
  
  return {
    varietyCode,
    varietyName,
    timeframes: {
      daily: fallbackAnalysis,
      '60min': fallbackAnalysis,
      '15min': fallbackAnalysis,
      '5min': fallbackAnalysis
    },
    resonanceScore: 0,
    resonanceLevel: 'CONFLICT',
    suggestedDirection: 'NEUTRAL',
    suggestedPosition: 0,
    suggestedAction: 'WAIT',
    analysis: '数据源不可用，请稍后重试',
    timestamp: new Date().toISOString()
  };
}

/**
 * 转换AKShare数据格式为KlineBar
 */
function convertAKShareToKlineBars(bars: AKShareBar[]): KlineBar[] {
  return bars.map(bar => ({
    date: bar.datetime,
    o: bar.open,
    h: bar.high,
    l: bar.low,
    c: bar.close,
    vol: bar.volume
  }));
}
