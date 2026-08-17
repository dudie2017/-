/**
 * Brooks Price Action 技术分析服务
 * 基于 Al Brooks 三部曲的72维度技术分析系统
 * 
 * 核心功能：
 * 1. K线形态识别（看涨吞没、锤子线、早晨之星等）
 * 2. 关键点突破（日线收盘价突破前10日高点/低点）
 * 3. 周线趋势过滤（周线MA20方向）
 * 4. 突破有效性评分
 * 5. 反转K线质量评分
 */

import { getDailyQuotesHistory } from './database.js';

// ============ 数据结构 ============

export interface KlineBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  hold?: number;
}

export interface CandlePattern {
  name: string;
  type: 'bullish' | 'bearish' | 'neutral';
  strength: number; // 0-5
  description: string;
}

export interface BreakoutResult {
  type: 'bull_breakout' | 'bear_breakout' | 'none';
  score: number; // 0-5
  details: {
    bodyRatio: number;
    closeExtreme: boolean;
    volumeAmplified: boolean;
    extentSufficient: boolean;
    ema20Support: boolean;
  };
  verdict: string;
}

export interface TrendAnalysis {
  daily: {
    direction: 'up' | 'down' | 'sideways';
    ma20: number;
    ma20Slope: number;
    aboveMA20: boolean;
  };
  weekly: {
    direction: 'up' | 'down' | 'sideways';
    ma20: number;
    ma20Slope: number;
    aboveMA20: boolean;
  };
  trendStrength: number; // 0-100
}

export interface TechnicalAnalysis {
  code: string;
  date: string;
  patterns: CandlePattern[];
  breakout: BreakoutResult;
  trend: TrendAnalysis;
  keyLevels: {
    resistance: number[];
    support: number[];
    pivot: number;
  };
  signals: {
    type: 'bullish' | 'bearish' | 'neutral';
    strength: number;
    description: string;
  }[];
  summary: {
    direction: 'bullish' | 'bearish' | 'neutral';
    confidence: number; // 0-100
    description: string;
  };
  // 新增字段：量能对比
  volume?: {
    currentVolume: number;
    avgVolume20: number;
    volumeRatio: number;
    isAmplified: boolean;
    description: string;
  };
  // 新增字段：趋势结构（HH/HL模式）
  trendStructure?: {
    pattern: 'uptrend' | 'downtrend' | 'consolidation' | 'unknown';
    higherHighs: boolean;
    higherLows: boolean;
    lowerHighs: boolean;
    lowerLows: boolean;
    description: string;
  };
  // 新增字段：历史高低点
  historicalLevels?: {
    high6Month: number;
    low6Month: number;
    currentFromHigh: number;
    currentFromLow: number;
    description: string;
  };
}

// ============ K线形态识别 ============

/**
 * 识别看涨吞没形态
 * 条件：前一根阴线 + 当前阳线完全吞没前一根实体
 */
function detectBullishEngulfing(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 2) return null;
  
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  
  // 前一根是阴线
  const prevBearish = prev.close < prev.open;
  // 当前是阳线
  const currBullish = curr.close > curr.open;
  // 当前实体完全吞没前一根实体
  const engulfs = curr.open <= prev.close && curr.close >= prev.open;
  
  if (prevBearish && currBullish && engulfs) {
    const bodyRatio = (curr.close - curr.open) / (curr.high - curr.low + 0.0001);
    return {
      name: '看涨吞没',
      type: 'bullish',
      strength: bodyRatio > 0.7 ? 4 : 3,
      description: `阳线实体(${(curr.close - curr.open).toFixed(2)})完全吞没前一根阴线，多头强势反攻`
    };
  }
  return null;
}

/**
 * 识别看跌吞没形态
 * 条件：前一根阳线 + 当前阴线完全吞没前一根实体
 */
function detectBearishEngulfing(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 2) return null;
  
  const prev = bars[bars.length - 2];
  const curr = bars[bars.length - 1];
  
  // 前一根是阳线
  const prevBullish = prev.close > prev.open;
  // 当前是阴线
  const currBearish = curr.close < curr.open;
  // 当前实体完全吞没前一根实体
  const engulfs = curr.open >= prev.close && curr.close <= prev.open;
  
  if (prevBullish && currBearish && engulfs) {
    const bodyRatio = (curr.open - curr.close) / (curr.high - curr.low + 0.0001);
    return {
      name: '看跌吞没',
      type: 'bearish',
      strength: bodyRatio > 0.7 ? 4 : 3,
      description: `阴线实体(${(curr.open - curr.close).toFixed(2)})完全吞没前一根阳线，空头强势反攻`
    };
  }
  return null;
}

/**
 * 识别锤子线（看涨）
 * 条件：下影线长度 >= 实体2倍 + 上影线很短 + 在下跌趋势中
 */
function detectHammer(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 5) return null;
  
  const curr = bars[bars.length - 1];
  const body = Math.abs(curr.close - curr.open);
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;
  const upperShadow = curr.high - Math.max(curr.open, curr.close);
  const range = curr.high - curr.low;
  
  if (range === 0) return null;
  
  // 下影线 >= 实体2倍
  const longLowerShadow = lowerShadow >= body * 2;
  // 上影线很短
  const shortUpperShadow = upperShadow < body * 0.3;
  // 在下跌趋势中（前5根K线整体向下）
  const prevBars = bars.slice(-6, -1);
  const downtrend = prevBars[prevBars.length - 1].close < prevBars[0].close;
  
  if (longLowerShadow && shortUpperShadow && downtrend) {
    return {
      name: '锤子线',
      type: 'bullish',
      strength: lowerShadow > body * 3 ? 4 : 3,
      description: `下影线(${lowerShadow.toFixed(2)})是实体(${body.toFixed(2)})的${(lowerShadow / (body + 0.0001)).toFixed(1)}倍，空头力竭信号`
    };
  }
  return null;
}

/**
 * 识别上吊线（看跌）
 * 条件：与锤子线相同形态，但在上涨趋势中
 */
function detectHangingMan(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 5) return null;
  
  const curr = bars[bars.length - 1];
  const body = Math.abs(curr.close - curr.open);
  const lowerShadow = Math.min(curr.open, curr.close) - curr.low;
  const upperShadow = curr.high - Math.max(curr.open, curr.close);
  
  if (body === 0) return null;
  
  // 下影线 >= 实体2倍
  const longLowerShadow = lowerShadow >= body * 2;
  // 上影线很短
  const shortUpperShadow = upperShadow < body * 0.3;
  // 在上涨趋势中
  const prevBars = bars.slice(-6, -1);
  const uptrend = prevBars[prevBars.length - 1].close > prevBars[0].close;
  
  if (longLowerShadow && shortUpperShadow && uptrend) {
    return {
      name: '上吊线',
      type: 'bearish',
      strength: lowerShadow > body * 3 ? 4 : 3,
      description: `上涨趋势中出现长下影线，多头力竭信号`
    };
  }
  return null;
}

/**
 * 识别早晨之星（看涨）
 * 条件：大阴线 + 小实体（星线）+ 大阳线
 */
function detectMorningStar(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 3) return null;
  
  const first = bars[bars.length - 3];
  const second = bars[bars.length - 2];
  const third = bars[bars.length - 1];
  
  const firstBody = Math.abs(first.close - first.open);
  const secondBody = Math.abs(second.close - second.open);
  const thirdBody = Math.abs(third.close - third.open);
  const firstRange = first.high - first.low;
  const thirdRange = third.high - third.low;
  
  // 第一根是大阴线
  const firstBearish = first.close < first.open && firstBody > firstRange * 0.5;
  // 第二根是小实体（星线）
  const secondSmall = secondBody < firstBody * 0.3;
  // 第三根是大阳线
  const thirdBullish = third.close > third.open && thirdBody > thirdRange * 0.5;
  // 第三根收盘超过第一根实体中点
  const thirdClosesAboveMid = third.close > (first.open + first.close) / 2;
  
  if (firstBearish && secondSmall && thirdBullish && thirdClosesAboveMid) {
    return {
      name: '早晨之星',
      type: 'bullish',
      strength: 5,
      description: `三根K线形成经典反转形态：大阴线→小实体→大阳线，强烈看涨信号`
    };
  }
  return null;
}

/**
 * 识别黄昏之星（看跌）
 * 条件：大阳线 + 小实体（星线）+ 大阴线
 */
function detectEveningStar(bars: KlineBar[]): CandlePattern | null {
  if (bars.length < 3) return null;
  
  const first = bars[bars.length - 3];
  const second = bars[bars.length - 2];
  const third = bars[bars.length - 1];
  
  const firstBody = Math.abs(first.close - first.open);
  const secondBody = Math.abs(second.close - second.open);
  const thirdBody = Math.abs(third.close - third.open);
  const firstRange = first.high - first.low;
  const thirdRange = third.high - third.low;
  
  // 第一根是大阳线
  const firstBullish = first.close > first.open && firstBody > firstRange * 0.5;
  // 第二根是小实体（星线）
  const secondSmall = secondBody < firstBody * 0.3;
  // 第三根是大阴线
  const thirdBearish = third.close < third.open && thirdBody > thirdRange * 0.5;
  // 第三根收盘低于第一根实体中点
  const thirdClosesBelowMid = third.close < (first.open + first.close) / 2;
  
  if (firstBullish && secondSmall && thirdBearish && thirdClosesBelowMid) {
    return {
      name: '黄昏之星',
      type: 'bearish',
      strength: 5,
      description: `三根K线形成经典反转形态：大阳线→小实体→大阴线，强烈看跌信号`
    };
  }
  return null;
}

/**
 * 识别所有K线形态
 */
export function detectCandlePatterns(bars: KlineBar[]): CandlePattern[] {
  const patterns: CandlePattern[] = [];
  
  const bullishEngulfing = detectBullishEngulfing(bars);
  if (bullishEngulfing) patterns.push(bullishEngulfing);
  
  const bearishEngulfing = detectBearishEngulfing(bars);
  if (bearishEngulfing) patterns.push(bearishEngulfing);
  
  const hammer = detectHammer(bars);
  if (hammer) patterns.push(hammer);
  
  const hangingMan = detectHangingMan(bars);
  if (hangingMan) patterns.push(hangingMan);
  
  const morningStar = detectMorningStar(bars);
  if (morningStar) patterns.push(morningStar);
  
  const eveningStar = detectEveningStar(bars);
  if (eveningStar) patterns.push(eveningStar);
  
  return patterns;
}

// ============ 关键点突破 ============

/**
 * 计算EMA
 */
function calcEMA(values: number[], period: number): number[] {
  const ema: number[] = [];
  const k = 2 / (period + 1);
  
  ema[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  
  return ema;
}

/**
 * 突破有效性评分 (0-5分)
 * 基于Brooks雷达的突破评分逻辑
 */
export function analyzeBreakout(bars: KlineBar[], lookback: number = 20): BreakoutResult {
  if (bars.length < lookback + 1) {
    return {
      type: 'none',
      score: 0,
      details: {
        bodyRatio: 0,
        closeExtreme: false,
        volumeAmplified: false,
        extentSufficient: false,
        ema20Support: false
      },
      verdict: '数据不足'
    };
  }
  
  const curr = bars[bars.length - 1];
  const prevBars = bars.slice(-(lookback + 1), -1);
  
  // 计算前lookback根K线的最高价和最低价
  const highestHigh = Math.max(...prevBars.map(b => b.high));
  const lowestLow = Math.min(...prevBars.map(b => b.low));
  
  // 判断突破类型
  const bullBreakout = curr.close > highestHigh;
  const bearBreakout = curr.close < lowestLow;
  
  if (!bullBreakout && !bearBreakout) {
    return {
      type: 'none',
      score: 0,
      details: {
        bodyRatio: 0,
        closeExtreme: false,
        volumeAmplified: false,
        extentSufficient: false,
        ema20Support: false
      },
      verdict: '无突破'
    };
  }
  
  // 计算评分维度
  const body = Math.abs(curr.close - curr.open);
  const range = curr.high - curr.low;
  const bodyRatio = range > 0 ? body / range : 0;
  
  // 1. 突破K线实体 > 70%
  const strongBody = bodyRatio > 0.7;
  
  // 2. 收盘偏极值
  const mid = (curr.high + curr.low) / 2;
  const closeExtreme = bullBreakout ? curr.close > mid : curr.close < mid;
  
  // 3. 量能放大 > 1.5x
  const avgVolume = prevBars.reduce((sum, b) => sum + (b.volume || 0), 0) / prevBars.length;
  const volumeAmplified = (curr.volume || 0) > avgVolume * 1.5;
  
  // 4. 突破幅度充分
  const extent = bullBreakout 
    ? (curr.close - highestHigh) / highestHigh 
    : (lowestLow - curr.close) / lowestLow;
  const extentSufficient = extent > 0.001; // 0.1%
  
  // 5. EMA20配合
  const closes = bars.map(b => b.close);
  const ema20 = calcEMA(closes, 20);
  const ema20Slope = ema20[ema20.length - 1] - ema20[ema20.length - 2];
  const ema20Support = bullBreakout ? ema20Slope > 0 : ema20Slope < 0;
  
  // 计算总分
  let score = 0;
  if (strongBody) score++;
  if (closeExtreme) score++;
  if (volumeAmplified) score++;
  if (extentSufficient) score++;
  if (ema20Support) score++;
  
  const type = bullBreakout ? 'bull_breakout' : 'bear_breakout';
  const verdict = score >= 3 
    ? `有效突破(${type === 'bull_breakout' ? '向上' : '向下'}，20%失败率)`
    : `假突破概率高(80%失败率)`;
  
  return {
    type,
    score,
    details: {
      bodyRatio,
      closeExtreme,
      volumeAmplified,
      extentSufficient,
      ema20Support
    },
    verdict
  };
}

// ============ 趋势分析 ============

/**
 * 分析日线/周线趋势
 */
export function analyzeTrend(bars: KlineBar[]): TrendAnalysis {
  if (bars.length < 20) {
    return {
      daily: { direction: 'sideways', ma20: 0, ma20Slope: 0, aboveMA20: false },
      weekly: { direction: 'sideways', ma20: 0, ma20Slope: 0, aboveMA20: false },
      trendStrength: 0
    };
  }
  
  const closes = bars.map(b => b.close);
  const ma20 = calcEMA(closes, 20);
  const currentMA20 = ma20[ma20.length - 1];
  const prevMA20 = ma20[ma20.length - 2];
  const ma20Slope = (currentMA20 - prevMA20) / prevMA20;
  
  const currentClose = closes[closes.length - 1];
  const aboveMA20 = currentClose > currentMA20;
  
  // 判断日线趋势方向
  let dailyDirection: 'up' | 'down' | 'sideways';
  if (ma20Slope > 0.001) {
    dailyDirection = 'up';
  } else if (ma20Slope < -0.001) {
    dailyDirection = 'down';
  } else {
    dailyDirection = 'sideways';
  }
  
  // 模拟周线数据（每5根日线合成一根周线）
  const weeklyBars: KlineBar[] = [];
  for (let i = 0; i < bars.length; i += 5) {
    const weekBars = bars.slice(i, i + 5);
    if (weekBars.length > 0) {
      weeklyBars.push({
        date: weekBars[weekBars.length - 1].date,
        open: weekBars[0].open,
        high: Math.max(...weekBars.map(b => b.high)),
        low: Math.min(...weekBars.map(b => b.low)),
        close: weekBars[weekBars.length - 1].close,
        volume: weekBars.reduce((sum, b) => sum + (b.volume || 0), 0)
      });
    }
  }
  
  let weeklyDirection: 'up' | 'down' | 'sideways' = 'sideways';
  let weeklyMA20 = 0;
  let weeklyMA20Slope = 0;
  let weeklyAboveMA20 = false;
  
  if (weeklyBars.length >= 20) {
    const weeklyCloses = weeklyBars.map(b => b.close);
    const weeklyMA20Arr = calcEMA(weeklyCloses, 20);
    weeklyMA20 = weeklyMA20Arr[weeklyMA20Arr.length - 1];
    const weeklyPrevMA20 = weeklyMA20Arr[weeklyMA20Arr.length - 2];
    weeklyMA20Slope = (weeklyMA20 - weeklyPrevMA20) / weeklyPrevMA20;
    weeklyAboveMA20 = weeklyCloses[weeklyCloses.length - 1] > weeklyMA20;
    
    if (weeklyMA20Slope > 0.001) {
      weeklyDirection = 'up';
    } else if (weeklyMA20Slope < -0.001) {
      weeklyDirection = 'down';
    }
  }
  
  // 计算趋势强度 (0-100)
  let trendStrength = 0;
  
  // 日线趋势贡献 (40%)
  if (dailyDirection === 'up' && aboveMA20) trendStrength += 40;
  else if (dailyDirection === 'down' && !aboveMA20) trendStrength += 40;
  else if (dailyDirection !== 'sideways') trendStrength += 20;
  
  // 周线趋势贡献 (40%)
  if (weeklyDirection === 'up' && weeklyAboveMA20) trendStrength += 40;
  else if (weeklyDirection === 'down' && !weeklyAboveMA20) trendStrength += 40;
  else if (weeklyDirection !== 'sideways') trendStrength += 20;
  
  // MA20斜率贡献 (20%)
  const slopeStrength = Math.min(Math.abs(ma20Slope) * 10000, 20);
  trendStrength += slopeStrength;
  
  return {
    daily: {
      direction: dailyDirection,
      ma20: currentMA20,
      ma20Slope,
      aboveMA20
    },
    weekly: {
      direction: weeklyDirection,
      ma20: weeklyMA20,
      ma20Slope,
      aboveMA20: weeklyAboveMA20
    },
    trendStrength: Math.min(trendStrength, 100)
  };
}

// ============ 量能对比分析 ============

/**
 * 分析量能对比（当前成交量 vs 20日均量）
 */
export function analyzeVolume(bars: KlineBar[]): {
  currentVolume: number;
  avgVolume20: number;
  volumeRatio: number;
  isAmplified: boolean;
  description: string;
} {
  if (bars.length < 20) {
    return {
      currentVolume: 0,
      avgVolume20: 0,
      volumeRatio: 0,
      isAmplified: false,
      description: '数据不足，无法分析量能'
    };
  }
  
  const recent20 = bars.slice(-20);
  const currentVolume = recent20[recent20.length - 1].volume || 0;
  const avgVolume20 = recent20.reduce((sum, b) => sum + (b.volume || 0), 0) / 20;
  const volumeRatio = avgVolume20 > 0 ? currentVolume / avgVolume20 : 0;
  const isAmplified = volumeRatio > 1.5;
  
  let description = '';
  if (volumeRatio > 2) {
    description = `显著放量（${volumeRatio.toFixed(1)}倍均量），突破有效性高`;
  } else if (volumeRatio > 1.5) {
    description = `温和放量（${volumeRatio.toFixed(1)}倍均量），突破有一定有效性`;
  } else if (volumeRatio > 0.8) {
    description = `量能平稳（${volumeRatio.toFixed(1)}倍均量），突破需其他确认`;
  } else {
    description = `缩量（${volumeRatio.toFixed(1)}倍均量），突破有效性存疑`;
  }
  
  return {
    currentVolume,
    avgVolume20,
    volumeRatio,
    isAmplified,
    description
  };
}

// ============ 趋势结构识别（HH/HL模式）============

/**
 * 识别趋势结构（Higher Highs/Higher Lows 或 Lower Highs/Lower Lows）
 */
export function identifyTrendStructure(bars: KlineBar[]): {
  pattern: 'uptrend' | 'downtrend' | 'consolidation' | 'unknown';
  higherHighs: boolean;
  higherLows: boolean;
  lowerHighs: boolean;
  lowerLows: boolean;
  description: string;
} {
  if (bars.length < 20) {
    return {
      pattern: 'unknown',
      higherHighs: false,
      higherLows: false,
      lowerHighs: false,
      lowerLows: false,
      description: '数据不足，无法识别趋势结构'
    };
  }
  
  // 寻找局部高点和低点
  const localHighs: number[] = [];
  const localLows: number[] = [];
  
  for (let i = 2; i < bars.length - 2; i++) {
    const bar = bars[i];
    const prev2 = bars[i - 2];
    const prev1 = bars[i - 1];
    const next1 = bars[i + 1];
    const next2 = bars[i + 2];
    
    // 局部高点
    if (bar.high > prev1.high && bar.high > prev2.high && 
        bar.high > next1.high && bar.high > next2.high) {
      localHighs.push(bar.high);
    }
    
    // 局部低点
    if (bar.low < prev1.low && bar.low < prev2.low && 
        bar.low < next1.low && bar.low < next2.low) {
      localLows.push(bar.low);
    }
  }
  
  // 分析高低点模式
  let higherHighs = false;
  let higherLows = false;
  let lowerHighs = false;
  let lowerLows = false;
  
  if (localHighs.length >= 2) {
    const recentHighs = localHighs.slice(-3);
    higherHighs = recentHighs[recentHighs.length - 1] > recentHighs[0];
    lowerHighs = recentHighs[recentHighs.length - 1] < recentHighs[0];
  }
  
  if (localLows.length >= 2) {
    const recentLows = localLows.slice(-3);
    higherLows = recentLows[recentLows.length - 1] > recentLows[0];
    lowerLows = recentLows[recentLows.length - 1] < recentLows[0];
  }
  
  // 判断趋势模式
  let pattern: 'uptrend' | 'downtrend' | 'consolidation' | 'unknown';
  let description = '';
  
  if (higherHighs && higherLows) {
    pattern = 'uptrend';
    description = '上升结构：高点抬升 + 低点抬升（HH + HL）';
  } else if (lowerHighs && lowerLows) {
    pattern = 'downtrend';
    description = '下降结构：高点降低 + 低点降低（LH + LL）';
  } else if (higherHighs && lowerLows) {
    pattern = 'consolidation';
    description = '收敛三角：高点抬升 + 低点降低（等待方向选择）';
  } else if (lowerHighs && higherLows) {
    pattern = 'consolidation';
    description = '扩散三角：高点降低 + 低点抬升（波动加大）';
  } else {
    pattern = 'unknown';
    description = '趋势结构不明确';
  }
  
  return {
    pattern,
    higherHighs,
    higherLows,
    lowerHighs,
    lowerLows,
    description
  };
}

// ============ 历史高低点追踪 ============

/**
 * 追踪历史高低点（近6个月）
 */
export function trackHistoricalLevels(bars: KlineBar[]): {
  high6Month: number;
  low6Month: number;
  currentFromHigh: number;
  currentFromLow: number;
  description: string;
} {
  if (bars.length < 10) {
    return {
      high6Month: 0,
      low6Month: 0,
      currentFromHigh: 0,
      currentFromLow: 0,
      description: '数据不足'
    };
  }
  
  // 取近120个交易日（约6个月）
  const recent = bars.slice(-120);
  const high6Month = Math.max(...recent.map(b => b.high));
  const low6Month = Math.min(...recent.map(b => b.low));
  const currentClose = recent[recent.length - 1].close;
  
  const currentFromHigh = ((currentClose - high6Month) / high6Month) * 100;
  const currentFromLow = ((currentClose - low6Month) / low6Month) * 100;
  
  let description = '';
  if (currentFromHigh > -5) {
    description = `接近6个月高点（${high6Month}），距高点${Math.abs(currentFromHigh).toFixed(1)}%`;
  } else if (currentFromLow < 5) {
    description = `接近6个月低点（${low6Month}），距低点${currentFromLow.toFixed(1)}%`;
  } else {
    description = `6个月区间：${low6Month} - ${high6Month}，当前位于中间位置`;
  }
  
  return {
    high6Month,
    low6Month,
    currentFromHigh,
    currentFromLow,
    description
  };
}

// ============ 关键价位 ============

/**
 * 计算关键支撑/阻力位
 */
export function calculateKeyLevels(bars: KlineBar[]): { resistance: number[]; support: number[]; pivot: number } {
  if (bars.length < 10) {
    return { resistance: [], support: [], pivot: 0 };
  }
  
  const recent = bars.slice(-20);
  const current = recent[recent.length - 1];
  
  // 计算枢轴点
  const pivot = (current.high + current.low + current.close) / 3;
  
  // 寻找阻力位（近期高点）
  const highs = recent.map(b => b.high).sort((a, b) => b - a);
  const resistance = [...new Set(highs.slice(0, 3))].filter(h => h > current.close);
  
  // 寻找支撑位（近期低点）
  const lows = recent.map(b => b.low).sort((a, b) => a - b);
  const support = [...new Set(lows.slice(0, 3))].filter(l => l < current.close);
  
  return { resistance, support, pivot };
}

// ============ 综合技术分析 ============

/**
 * 执行完整的技术分析
 */
export function performTechnicalAnalysis(code: string, bars: KlineBar[]): TechnicalAnalysis {
  const patterns = detectCandlePatterns(bars);
  const breakout = analyzeBreakout(bars);
  const trend = analyzeTrend(bars);
  const keyLevels = calculateKeyLevels(bars);
  
  // 新增分析：量能、趋势结构、历史高低点
  const volume = analyzeVolume(bars);
  const trendStructure = identifyTrendStructure(bars);
  const historicalLevels = trackHistoricalLevels(bars);
  
  // 生成信号
  const signals: { type: 'bullish' | 'bearish' | 'neutral'; strength: number; description: string }[] = [];
  
  // K线形态信号
  for (const pattern of patterns) {
    signals.push({
      type: pattern.type,
      strength: pattern.strength * 20,
      description: pattern.description
    });
  }
  
  // 突破信号
  if (breakout.type !== 'none') {
    signals.push({
      type: breakout.type === 'bull_breakout' ? 'bullish' : 'bearish',
      strength: breakout.score * 20,
      description: breakout.verdict
    });
  }
  
  // 趋势信号
  if (trend.trendStrength > 60) {
    const trendType = trend.daily.direction === 'up' ? 'bullish' : trend.daily.direction === 'down' ? 'bearish' : 'neutral';
    signals.push({
      type: trendType,
      strength: trend.trendStrength,
      description: `${trend.daily.direction === 'up' ? '上升' : trend.daily.direction === 'down' ? '下降' : '震荡'}趋势，强度${trend.trendStrength.toFixed(0)}%`
    });
  }
  
  // 综合判断
  const bullishSignals = signals.filter(s => s.type === 'bullish');
  const bearishSignals = signals.filter(s => s.type === 'bearish');
  
  const bullishStrength = bullishSignals.reduce((sum, s) => sum + s.strength, 0);
  const bearishStrength = bearishSignals.reduce((sum, s) => sum + s.strength, 0);
  
  let direction: 'bullish' | 'bearish' | 'neutral';
  let confidence: number;
  
  if (bullishStrength > bearishStrength * 1.5) {
    direction = 'bullish';
    confidence = Math.min(bullishStrength / (bullishStrength + bearishStrength + 1) * 100, 95);
  } else if (bearishStrength > bullishStrength * 1.5) {
    direction = 'bearish';
    confidence = Math.min(bearishStrength / (bullishStrength + bearishStrength + 1) * 100, 95);
  } else {
    direction = 'neutral';
    confidence = 50;
  }
  
  const description = direction === 'bullish' 
    ? `技术面偏多，${patterns.length > 0 ? '出现看涨形态，' : ''}${breakout.type === 'bull_breakout' ? '有效向上突破，' : ''}趋势强度${trend.trendStrength.toFixed(0)}%`
    : direction === 'bearish'
    ? `技术面偏空，${patterns.length > 0 ? '出现看跌形态，' : ''}${breakout.type === 'bear_breakout' ? '有效向下突破，' : ''}趋势强度${trend.trendStrength.toFixed(0)}%`
    : `技术面中性，趋势不明朗，建议观望`;
  
  return {
    code,
    date: bars[bars.length - 1]?.date || new Date().toISOString().split('T')[0],
    patterns,
    breakout,
    trend,
    keyLevels,
    volume,
    trendStructure,
    historicalLevels,
    signals,
    summary: {
      direction,
      confidence,
      description
    }
  };
}

/**
 * 从数据库获取K线数据并执行技术分析
 */
export function analyzeFromDatabase(code: string, days: number = 60): TechnicalAnalysis | null {
  // 尝试使用code作为variety参数查询
  const records = getDailyQuotesHistory({ variety: code, limit: days });
  
  if (records.length < 10) {
    // 如果variety查询没有结果，尝试使用contractId
    const contractRecords = getDailyQuotesHistory({ contractId: code, limit: days });
    if (contractRecords.length < 10) {
      return null;
    }
    return performTechnicalAnalysisFromRecords(code, contractRecords);
  }
  
  return performTechnicalAnalysisFromRecords(code, records);
}

function performTechnicalAnalysisFromRecords(code: string, records: any[]): TechnicalAnalysis | null {
  if (records.length < 10) {
    return null;
  }
  
  const bars: KlineBar[] = records.map(r => ({
    date: r.trade_date,
    open: r.open_price || r.open || 0,
    high: r.high_price || r.high || 0,
    low: r.low_price || r.low || 0,
    close: r.close_price || r.close || 0,
    volume: r.volume || 0,
    hold: r.hold || r.open_interest || 0
  })).filter(b => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0);
  
  if (bars.length < 10) {
    return null;
  }
  
  return performTechnicalAnalysis(code, bars);
}
