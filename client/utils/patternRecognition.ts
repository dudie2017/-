import type { CandleBar } from '@/components/chart/CandlestickChart';

// ============ Brooks Price Action 形态识别 ============

export type PatternType =
  | 'bull_flag'        // 牛旗
  | 'bear_flag'        // 熊旗
  | 'wedge'            // 楔形
  | 'triangle'         // 三角形
  | 'double_top'       // 双顶
  | 'double_bottom'    // 双底
  | 'channel_up'       // 上升通道
  | 'channel_down'     // 下降通道
  | 'tight_range'      // 窄幅区间
  | 'wide_range'       // 宽幅区间
  | 'climax'           // 高潮/反转信号
  | 'measuring_gap'    // 测量缺口
  | 'exhaustion_gap';  // 衰竭缺口

export interface PatternMatch {
  type: PatternType;
  name: string;
  confidence: number;  // 0-100
  direction: 'bullish' | 'bearish' | 'neutral';
  startIndex: number;
  endIndex: number;
  description: string;
  brooksNote: string;
}

// ============ 基础计算 ============

function getHigh(bars: CandleBar[], i: number): number { return bars[i].h; }
function getLow(bars: CandleBar[], i: number): number { return bars[i].l; }
function getClose(bars: CandleBar[], i: number): number { return bars[i].c; }
function getOpen(bars: CandleBar[], i: number): number { return bars[i].o; }
function getBody(bars: CandleBar[], i: number): number { return Math.abs(bars[i].c - bars[i].o); }
function getRange(bars: CandleBar[], i: number): number { return bars[i].h - bars[i].l; }
function isBull(bars: CandleBar[], i: number): boolean { return bars[i].c > bars[i].o; }

function avgRange(bars: CandleBar[], start: number, end: number): number {
  let sum = 0;
  for (let i = start; i <= end; i++) sum += getRange(bars, i);
  return sum / (end - start + 1);
}

function ema(bars: CandleBar[], period: number, endIndex: number): number {
  const k = 2 / (period + 1);
  let e = getClose(bars, Math.max(0, endIndex - period + 1));
  for (let i = Math.max(0, endIndex - period + 2); i <= endIndex; i++) {
    e = getClose(bars, i) * k + e * (1 - k);
  }
  return e;
}

// 局部最高点
function findSwingHigh(bars: CandleBar[], index: number, lookback: number = 3): boolean {
  for (let i = Math.max(0, index - lookback); i <= Math.min(bars.length - 1, index + lookback); i++) {
    if (i !== index && getHigh(bars, i) >= getHigh(bars, index)) return false;
  }
  return true;
}

// 局部最低点
function findSwingLow(bars: CandleBar[], index: number, lookback: number = 3): boolean {
  for (let i = Math.max(0, index - lookback); i <= Math.min(bars.length - 1, index + lookback); i++) {
    if (i !== index && getLow(bars, i) <= getLow(bars, index)) return false;
  }
  return true;
}

// ============ 形态识别 ============

/**
 * 检测牛旗/熊旗（趋势中的回调形态）
 */
function detectFlag(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 10) return null;

  // 牛旗：强势上涨后的窄幅回调
  // 条件：前5-10根有明显上涨趋势，最近3-5根小幅回调
  const trendStart = currentIndex - 10;
  const trendEnd = currentIndex - 4;

  // 检查前期趋势
  const trendBars = bars.slice(trendStart, trendEnd + 1);
  const bullTrend = trendBars.filter((_, i) => isBull(bars, trendStart + i)).length;
  const trendMove = getClose(bars, trendEnd) - getOpen(bars, trendStart);

  if (bullTrend >= 6 && trendMove > avgRange(bars, trendStart, trendEnd) * 3) {
    // 检查最近回调
    const pullbackBars = bars.slice(currentIndex - 3, currentIndex + 1);
    const pullbackMove = getClose(bars, currentIndex) - getHigh(bars, currentIndex - 4);
    const pullbackRange = avgRange(bars, currentIndex - 3, currentIndex);

    if (pullbackMove < 0 && pullbackRange < avgRange(bars, trendStart, trendEnd) * 0.6) {
      return {
        type: 'bull_flag',
        name: '牛旗',
        confidence: 75,
        direction: 'bullish',
        startIndex: trendStart,
        endIndex: currentIndex,
        description: '强势上涨后的窄幅回调，通常预示着趋势延续',
        brooksNote: '牛旗是最可靠的延续形态之一。等待突破旗形上沿做多，止损在旗形下沿。',
      };
    }
  }

  // 熊旗：强势下跌后的窄幅反弹
  const bearTrend = trendBars.filter((_, i) => !isBull(bars, trendStart + i)).length;
  const bearMove = getOpen(bars, trendStart) - getClose(bars, trendEnd);

  if (bearTrend >= 6 && bearMove > avgRange(bars, trendStart, trendEnd) * 3) {
    const rallyMove = getClose(bars, currentIndex) - getLow(bars, currentIndex - 4);
    const rallyRange = avgRange(bars, currentIndex - 3, currentIndex);

    if (rallyMove > 0 && rallyRange < avgRange(bars, trendStart, trendEnd) * 0.6) {
      return {
        type: 'bear_flag',
        name: '熊旗',
        confidence: 75,
        direction: 'bearish',
        startIndex: trendStart,
        endIndex: currentIndex,
        description: '强势下跌后的窄幅反弹，通常预示着趋势延续',
        brooksNote: '熊旗是最可靠的延续形态之一。等待跌破旗形下沿做空，止损在旗形上沿。',
      };
    }
  }

  return null;
}

/**
 * 检测双顶/双底
 */
function detectDoubleTopBottom(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 15) return null;

  // 找最近的两个摆动高点
  const swingHighs: number[] = [];
  for (let i = currentIndex - 20; i <= currentIndex; i++) {
    if (i >= 0 && findSwingHigh(bars, i, 2)) {
      swingHighs.push(i);
    }
  }

  if (swingHighs.length >= 2) {
    const last = swingHighs[swingHighs.length - 1];
    const prev = swingHighs[swingHighs.length - 2];
    const highDiff = Math.abs(getHigh(bars, last) - getHigh(bars, prev));
    const avgR = avgRange(bars, prev, last);

    if (highDiff < avgR * 0.5 && last - prev >= 5) {
      return {
        type: 'double_top',
        name: '双顶',
        confidence: 70,
        direction: 'bearish',
        startIndex: prev,
        endIndex: last,
        description: '两个相近的高点形成双顶，可能预示反转',
        brooksNote: '双顶是常见的反转形态。跌破颈线（两顶之间的低点）确认反转。',
      };
    }
  }

  // 找最近的两个摆动低点
  const swingLows: number[] = [];
  for (let i = currentIndex - 20; i <= currentIndex; i++) {
    if (i >= 0 && findSwingLow(bars, i, 2)) {
      swingLows.push(i);
    }
  }

  if (swingLows.length >= 2) {
    const last = swingLows[swingLows.length - 1];
    const prev = swingLows[swingLows.length - 2];
    const lowDiff = Math.abs(getLow(bars, last) - getLow(bars, prev));
    const avgR = avgRange(bars, prev, last);

    if (lowDiff < avgR * 0.5 && last - prev >= 5) {
      return {
        type: 'double_bottom',
        name: '双底',
        confidence: 70,
        direction: 'bullish',
        startIndex: prev,
        endIndex: last,
        description: '两个相近的低点形成双底，可能预示反转',
        brooksNote: '双底是常见的反转形态。突破颈线（两底之间的高点）确认反转。',
      };
    }
  }

  return null;
}

/**
 * 检测趋势通道
 */
function detectChannel(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 15) return null;

  const lookback = Math.min(20, currentIndex);
  const start = currentIndex - lookback;

  // 计算趋势方向和强度
  const firstClose = getClose(bars, start);
  const lastClose = getClose(bars, currentIndex);
  const move = lastClose - firstClose;
  const avgR = avgRange(bars, start, currentIndex);

  // 计算线性回归斜率
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (let i = 0; i <= lookback; i++) {
    sumX += i;
    sumY += getClose(bars, start + i);
    sumXY += i * getClose(bars, start + i);
    sumX2 += i * i;
  }
  const n = lookback + 1;
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

  // 上升通道
  if (slope > avgR * 0.1 && move > avgR * 2) {
    return {
      type: 'channel_up',
      name: '上升通道',
      confidence: 65,
      direction: 'bullish',
      startIndex: start,
      endIndex: currentIndex,
      description: '价格在上升通道内运行，低点不断抬高',
      brooksNote: '上升通道内，回调到通道下沿是做多机会。突破上沿加速上涨，跌破下沿趋势可能反转。',
    };
  }

  // 下降通道
  if (slope < -avgR * 0.1 && move < -avgR * 2) {
    return {
      type: 'channel_down',
      name: '下降通道',
      confidence: 65,
      direction: 'bearish',
      startIndex: start,
      endIndex: currentIndex,
      description: '价格在下降通道内运行，高点不断降低',
      brooksNote: '下降通道内，反弹到通道上沿是做空机会。跌破下沿加速下跌，突破上沿趋势可能反转。',
    };
  }

  return null;
}

/**
 * 检测区间
 */
function detectRange(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 10) return null;

  const lookback = Math.min(15, currentIndex);
  const start = currentIndex - lookback;
  const avgR = avgRange(bars, start, currentIndex);

  // 计算区间
  let highest = -Infinity, lowest = Infinity;
  for (let i = start; i <= currentIndex; i++) {
    highest = Math.max(highest, getHigh(bars, i));
    lowest = Math.min(lowest, getLow(bars, i));
  }

  const rangeSize = highest - lowest;
  const bodySizes = [];
  for (let i = start; i <= currentIndex; i++) {
    bodySizes.push(getBody(bars, i));
  }
  const avgBody = bodySizes.reduce((a, b) => a + b, 0) / bodySizes.length;

  // 窄幅区间
  if (rangeSize < avgR * 3 && avgBody < avgR * 0.4) {
    return {
      type: 'tight_range',
      name: '窄幅区间',
      confidence: 60,
      direction: 'neutral',
      startIndex: start,
      endIndex: currentIndex,
      description: '价格在极窄的区间内横盘整理，等待突破方向',
      brooksNote: '窄幅区间是暴风雨前的宁静。突破方向往往决定下一波趋势，等待突破后跟随。',
    };
  }

  // 宽幅区间
  if (rangeSize > avgR * 5 && avgBody > avgR * 0.6) {
    return {
      type: 'wide_range',
      name: '宽幅区间',
      confidence: 55,
      direction: 'neutral',
      startIndex: start,
      endIndex: currentIndex,
      description: '价格在较宽的区间内震荡，多空力量均衡',
      brooksNote: '宽幅区间内高抛低吸。上沿做空，下沿做多，突破任一边界止损。',
    };
  }

  return null;
}

/**
 * 检测高潮/反转信号
 */
function detectClimax(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 3) return null;

  const bar = currentIndex;
  const prev = currentIndex - 1;
  const avgR = avgRange(bars, Math.max(0, currentIndex - 10), currentIndex);

  // 买入高潮：连续大涨后出现超长阳线
  if (isBull(bars, bar) && getBody(bars, bar) > avgR * 2.5 && getClose(bars, bar) > getClose(bars, prev)) {
    // 检查前面是否有连续上涨
    let consecutiveBull = 0;
    for (let i = Math.max(0, currentIndex - 5); i < currentIndex; i++) {
      if (isBull(bars, i)) consecutiveBull++;
    }
    if (consecutiveBull >= 3) {
      return {
        type: 'climax',
        name: '买入高潮',
        confidence: 80,
        direction: 'bearish',
        startIndex: Math.max(0, currentIndex - 5),
        endIndex: currentIndex,
        description: '连续上涨后出现超长阳线，可能是买入高潮，即将回调',
        brooksNote: '买入高潮是最可靠的反转信号之一。高潮后通常有2-3根回调，不要追多。',
      };
    }
  }

  // 卖出高潮：连续大跌后出现超长阴线
  if (!isBull(bars, bar) && getBody(bars, bar) > avgR * 2.5 && getClose(bars, bar) < getClose(bars, prev)) {
    let consecutiveBear = 0;
    for (let i = Math.max(0, currentIndex - 5); i < currentIndex; i++) {
      if (!isBull(bars, i)) consecutiveBear++;
    }
    if (consecutiveBear >= 3) {
      return {
        type: 'climax',
        name: '卖出高潮',
        confidence: 80,
        direction: 'bullish',
        startIndex: Math.max(0, currentIndex - 5),
        endIndex: currentIndex,
        description: '连续下跌后出现超长阴线，可能是卖出高潮，即将反弹',
        brooksNote: '卖出高潮是最可靠的反转信号之一。高潮后通常有2-3根反弹，不要追空。',
      };
    }
  }

  return null;
}

/**
 * 检测缺口
 */
function detectGap(bars: CandleBar[], currentIndex: number): PatternMatch | null {
  if (currentIndex < 5) return null;

  const bar = currentIndex;
  const prev = currentIndex - 1;
  const avgR = avgRange(bars, Math.max(0, currentIndex - 10), currentIndex);

  // 向上缺口
  if (getLow(bars, bar) > getHigh(bars, prev)) {
    const gapSize = getLow(bars, bar) - getHigh(bars, prev);
    if (gapSize > avgR * 0.3) {
      // 测量缺口（趋势中段）
      const trendStart = Math.max(0, currentIndex - 10);
      const trendMove = getClose(bars, prev) - getClose(bars, trendStart);
      if (trendMove > avgR * 2) {
        return {
          type: 'measuring_gap',
          name: '测量缺口',
          confidence: 70,
          direction: 'bullish',
          startIndex: trendStart,
          endIndex: currentIndex,
          description: '上涨趋势中出现向上缺口，趋势可能加速',
          brooksNote: '测量缺口意味着趋势可能继续。从缺口到下一个目标的距离约等于缺口前的趋势距离。',
        };
      }
    }
  }

  // 向下缺口
  if (getHigh(bars, bar) < getLow(bars, prev)) {
    const gapSize = getLow(bars, prev) - getHigh(bars, bar);
    if (gapSize > avgR * 0.3) {
      const trendStart = Math.max(0, currentIndex - 10);
      const trendMove = getClose(bars, trendStart) - getClose(bars, prev);
      if (trendMove > avgR * 2) {
        return {
          type: 'measuring_gap',
          name: '测量缺口',
          confidence: 70,
          direction: 'bearish',
          startIndex: trendStart,
          endIndex: currentIndex,
          description: '下跌趋势中出现向下缺口，趋势可能加速',
          brooksNote: '测量缺口意味着趋势可能继续。从缺口到下一个目标的距离约等于缺口前的趋势距离。',
        };
      }
    }
  }

  return null;
}

// ============ 主入口 ============

/**
 * 检测当前K线位置的所有形态
 */
export function detectPatterns(bars: CandleBar[], currentIndex: number): PatternMatch[] {
  const patterns: PatternMatch[] = [];

  const detectors = [
    detectFlag,
    detectDoubleTopBottom,
    detectChannel,
    detectRange,
    detectClimax,
    detectGap,
  ];

  for (const detector of detectors) {
    const result = detector(bars, currentIndex);
    if (result) {
      patterns.push(result);
    }
  }

  // 按置信度排序
  return patterns.sort((a, b) => b.confidence - a.confidence);
}

/**
 * 获取当前市场状态（趋势/区间/通道）
 */
export function getMarketState(bars: CandleBar[], currentIndex: number): {
  state: 'trend_up' | 'trend_down' | 'range' | 'transition';
  alwaysIn: 'long' | 'short' | 'flat';
  strength: number;  // 0-100
  description: string;
} {
  if (currentIndex < 10) {
    return { state: 'transition', alwaysIn: 'flat', strength: 0, description: '数据不足' };
  }

  const lookback = Math.min(20, currentIndex);
  const start = currentIndex - lookback;
  const ema20 = ema(bars, Math.min(20, lookback), currentIndex);
  const avgR = avgRange(bars, start, currentIndex);

  // 计算EMA方向
  const emaStart = ema(bars, Math.min(20, lookback), start);
  const emaDirection = ema20 - emaStart;

  // 计算价格在EMA上方/下方的比例
  let aboveCount = 0;
  for (let i = start; i <= currentIndex; i++) {
    if (getClose(bars, i) > ema(bars, Math.min(20, i - start + 1), i)) aboveCount++;
  }
  const aboveRatio = aboveCount / (lookback + 1);

  // 计算趋势强度
  const move = getClose(bars, currentIndex) - getClose(bars, start);
  const strength = Math.min(100, Math.abs(move) / (avgR * 5) * 100);

  // 判断状态
  if (aboveRatio > 0.7 && emaDirection > 0 && strength > 40) {
    return {
      state: 'trend_up',
      alwaysIn: 'long',
      strength: Math.round(strength),
      description: `上涨趋势，EMA20持续向上，${Math.round(aboveRatio * 100)}%K线在EMA上方`,
    };
  }

  if (aboveRatio < 0.3 && emaDirection < 0 && strength > 40) {
    return {
      state: 'trend_down',
      alwaysIn: 'short',
      strength: Math.round(strength),
      description: `下跌趋势，EMA20持续向下，${Math.round((1 - aboveRatio) * 100)}%K线在EMA下方`,
    };
  }

  if (strength < 30) {
    return {
      state: 'range',
      alwaysIn: 'flat',
      strength: Math.round(strength),
      description: '区间震荡，无明确趋势方向',
    };
  }

  return {
    state: 'transition',
    alwaysIn: 'flat',
    strength: Math.round(strength),
    description: '趋势转换中，方向不明确',
  };
}
