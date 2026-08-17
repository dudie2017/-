import type { BarData } from './varieties.js';

/**
 * 技术指标计算
 */

// EMA 指数移动平均线
export function calcEMA(data: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = new Array(data.length).fill(NaN);
  if (data.length < period) return ema;

  // 初始值用 SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += data[i];
  ema[period - 1] = sum / period;

  for (let i = period; i < data.length; i++) {
    ema[i] = data[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// ATR 平均真实波幅 (Wilder平滑)
export function calcATR(bars: BarData[], period = 14): number[] {
  const n = bars.length;
  const atr: number[] = new Array(n).fill(NaN);
  if (n < period + 1) return atr;

  const tr: number[] = new Array(n).fill(0);
  tr[0] = bars[0].h - bars[0].l;

  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
  }

  // 初始 SMA
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  atr[period - 1] = sum / period;

  // Wilder 平滑
  for (let i = period; i < n; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// ADX 平均趋向指数
export function calcADX(bars: BarData[], period = 14): { adx: number; plusDI: number; minusDI: number } {
  const n = bars.length;
  const result = { adx: NaN, plusDI: NaN, minusDI: NaN };
  if (n < period * 2 + 2) return result;

  // True Range, +DM, -DM
  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );

    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    if (up > down && up > 0) plusDM[i] = up;
    if (down > up && down > 0) minusDM[i] = down;
  }

  // Wilder 平滑
  const atrS: number[] = new Array(n).fill(0);
  const plusS: number[] = new Array(n).fill(0);
  const minusS: number[] = new Array(n).fill(0);

  for (let i = 1; i <= period; i++) {
    atrS[period] += tr[i];
    plusS[period] += plusDM[i];
    minusS[period] += minusDM[i];
  }

  for (let i = period + 1; i < n; i++) {
    atrS[i] = atrS[i - 1] - atrS[i - 1] / period + tr[i];
    plusS[i] = plusS[i - 1] - plusS[i - 1] / period + plusDM[i];
    minusS[i] = minusS[i - 1] - minusS[i - 1] / period + minusDM[i];
  }

  // DI & DX
  const dx: number[] = new Array(n).fill(NaN);
  const plusDI: number[] = new Array(n).fill(NaN);
  const minusDI: number[] = new Array(n).fill(NaN);

  for (let i = period; i < n; i++) {
    if (atrS[i] > 0) {
      plusDI[i] = 100 * plusS[i] / atrS[i];
      minusDI[i] = 100 * minusS[i] / atrS[i];
      const diSum = plusDI[i] + minusDI[i];
      if (diSum > 0) {
        dx[i] = 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum;
      }
    }
  }

  // ADX (Wilder 平滑)
  const validDx: { idx: number; val: number }[] = [];
  for (let i = period; i < n; i++) {
    if (!isNaN(dx[i])) validDx.push({ idx: i, val: dx[i] });
  }

  if (validDx.length < period) return result;

  const adxArr: number[] = new Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += validDx[i].val;
  adxArr[validDx[period - 1].idx] = sum / period;

  for (let j = period; j < validDx.length; j++) {
    const idx = validDx[j].idx;
    const prevIdx = validDx[j - 1].idx;
    adxArr[idx] = (adxArr[prevIdx] * (period - 1) + validDx[j].val) / period;
  }

  const last = n - 1;
  result.adx = adxArr[last];
  result.plusDI = plusDI[last];
  result.minusDI = minusDI[last];
  return result;
}

// ADX 序列（返回每个bar的ADX值）
export function calcADXSeries(bars: BarData[], period = 14): number[] {
  const n = bars.length;
  if (n < period * 2 + 2) return new Array(n).fill(NaN);

  // True Range, +DM, -DM
  const tr: number[] = new Array(n).fill(0);
  const plusDM: number[] = new Array(n).fill(0);
  const minusDM: number[] = new Array(n).fill(0);

  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );

    const up = bars[i].h - bars[i - 1].h;
    const down = bars[i - 1].l - bars[i].l;
    if (up > down && up > 0) plusDM[i] = up;
    if (down > up && down > 0) minusDM[i] = down;
  }

  // Wilder 平滑
  const atrS: number[] = new Array(n).fill(0);
  const plusS: number[] = new Array(n).fill(0);
  const minusS: number[] = new Array(n).fill(0);

  for (let i = 1; i <= period; i++) {
    atrS[period] += tr[i];
    plusS[period] += plusDM[i];
    minusS[period] += minusDM[i];
  }

  for (let i = period + 1; i < n; i++) {
    atrS[i] = atrS[i - 1] - atrS[i - 1] / period + tr[i];
    plusS[i] = plusS[i - 1] - plusS[i - 1] / period + plusDM[i];
    minusS[i] = minusS[i - 1] - minusS[i - 1] / period + minusDM[i];
  }

  // DI & DX
  const dx: number[] = new Array(n).fill(NaN);
  const plusDI: number[] = new Array(n).fill(NaN);
  const minusDI: number[] = new Array(n).fill(NaN);

  for (let i = period; i < n; i++) {
    if (atrS[i] > 0) {
      plusDI[i] = 100 * plusS[i] / atrS[i];
      minusDI[i] = 100 * minusS[i] / atrS[i];
      const diSum = plusDI[i] + minusDI[i];
      if (diSum > 0) {
        dx[i] = 100 * Math.abs(plusDI[i] - minusDI[i]) / diSum;
      }
    }
  }

  // ADX (Wilder 平滑)
  const validDx: { idx: number; val: number }[] = [];
  for (let i = period; i < n; i++) {
    if (!isNaN(dx[i])) validDx.push({ idx: i, val: dx[i] });
  }

  const adxArr: number[] = new Array(n).fill(NaN);
  if (validDx.length < period) return adxArr;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += validDx[i].val;
  adxArr[validDx[period - 1].idx] = sum / period;

  for (let j = period; j < validDx.length; j++) {
    const idx = validDx[j].idx;
    const prevIdx = validDx[j - 1].idx;
    adxArr[idx] = (adxArr[prevIdx] * (period - 1) + validDx[j].val) / period;
  }

  return adxArr;
}

// 计算 SMA
export function calcSMA(data: number[], period: number): number[] {
  const sma: number[] = new Array(data.length).fill(NaN);
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j];
    sma[i] = sum / period;
  }
  return sma;
}

// RSI 相对强弱指数
export function calcRSI(data: number[], period = 14): number[] {
  const rsi: number[] = new Array(data.length).fill(NaN);
  if (data.length < period + 1) return rsi;

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < data.length; i++) {
    const change = data[i] - data[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? Math.abs(change) : 0);
  }

  // 初始平均涨幅/跌幅
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 0; i < period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) {
    rsi[period] = 100;
  } else {
    const rs = avgGain / avgLoss;
    rsi[period] = 100 - 100 / (1 + rs);
  }

  // Wilder 平滑
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    if (avgLoss === 0) {
      rsi[i + 1] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsi[i + 1] = 100 - 100 / (1 + rs);
    }
  }

  return rsi;
}

// 布林带 (Bollinger Bands)
export function calcBollinger(
  data: number[],
  period = 20,
  stdDevMultiplier = 2
): { upper: number[]; middle: number[]; lower: number[] } {
  const n = data.length;
  const upper: number[] = new Array(n).fill(NaN);
  const middle: number[] = new Array(n).fill(NaN);
  const lower: number[] = new Array(n).fill(NaN);

  if (n < period) return { upper, middle, lower };

  for (let i = period - 1; i < n; i++) {
    // 计算 SMA
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j];
    }
    const sma = sum / period;
    middle[i] = sma;

    // 计算标准差
    let squaredDiffSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      squaredDiffSum += Math.pow(data[j] - sma, 2);
    }
    const stdDev = Math.sqrt(squaredDiffSum / period);

    upper[i] = sma + stdDevMultiplier * stdDev;
    lower[i] = sma - stdDevMultiplier * stdDev;
  }

  return { upper, middle, lower };
}

// ============================================================================
// Brooks 专有指标
// ============================================================================

/**
 * 检测 Inside Inside (ii) - 内包内包
 * ii: 当前K线被前一根K线完全包含，且前一根K线也被更前一根完全包含
 * @param bars K线数据
 * @param index 当前K线索引
 * @returns 是否为ii形态
 */
export function detectII(bars: BarData[], index: number): boolean {
  if (index < 2) return false;
  
  const curr = bars[index];
  const prev = bars[index - 1];
  const prev2 = bars[index - 2];
  
  // 当前K线被前一根完全包含
  const currInsidePrev = curr.h <= prev.h && curr.l >= prev.l;
  // 前一根被更前一根完全包含
  const prevInsidePrev2 = prev.h <= prev2.h && prev.l >= prev2.l;
  
  return currInsidePrev && prevInsidePrev2;
}

/**
 * 检测 Inside-Outside-Inside (ioi) - 内包外包内包
 * ioi: 当前K线被前一根包含，前一根外包更前一根
 * @param bars K线数据
 * @param index 当前K线索引
 * @returns 是否为ioi形态
 */
export function detectIOI(bars: BarData[], index: number): boolean {
  if (index < 2) return false;
  
  const curr = bars[index];
  const prev = bars[index - 1];
  const prev2 = bars[index - 2];
  
  // 当前K线被前一根完全包含 (Inside)
  const currInsidePrev = curr.h <= prev.h && curr.l >= prev.l;
  // 前一根外包更前一根 (Outside)
  const prevOutsidePrev2 = prev.h >= prev2.h && prev.l <= prev2.l;
  
  return currInsidePrev && prevOutsidePrev2;
}

/**
 * 评估 Signal Bar 质量
 * Signal Bar 是触发入场的那根K线
 * @param bar 当前K线
 * @param prevBar 前一根K线
 * @param direction 预期方向 ('bull' | 'bear')
 * @returns 评分(0-100)和类型
 */
export function evaluateSignalBar(
  bar: BarData, 
  prevBar: BarData, 
  direction: 'bull' | 'bear'
): { score: number; type: string } {
  const range = bar.h - bar.l;
  if (range === 0) return { score: 0, type: 'doji' };
  
  const body = Math.abs(bar.c - bar.o);
  const bodyRatio = body / range;
  
  // 上影线和下影线
  const upperWick = bar.h - Math.max(bar.o, bar.c);
  const lowerWick = Math.min(bar.o, bar.c) - bar.l;
  
  let score = 0;
  let type = 'neutral';
  
  if (direction === 'bull') {
    // 看涨信号K线评估
    const isBullish = bar.c > bar.o;
    
    // 1. 实体比例 (0-30分)
    score += Math.min(30, bodyRatio * 40);
    
    // 2. 收盘位置 (0-25分) - 收盘在高位更好
    const closePosition = (bar.c - bar.l) / range;
    score += closePosition * 25;
    
    // 3. 下影线长度 (0-20分) - 下影线长表示买盘强
    const lowerWickRatio = lowerWick / range;
    score += Math.min(20, lowerWickRatio * 40);
    
    // 4. 与前K线关系 (0-25分)
    if (isBullish && prevBar.c < prevBar.o) {
      // 看涨吞没前一根阴线
      score += 25;
      type = 'bullish_engulfing';
    } else if (isBullish) {
      score += 15;
      type = 'bull_signal';
    }
    
    // 5. 是否是锤子线
    if (lowerWick > body * 2 && upperWick < body * 0.5) {
      score += 10;
      type = 'hammer';
    }
    
  } else {
    // 看跌信号K线评估
    const isBearish = bar.c < bar.o;
    
    // 1. 实体比例 (0-30分)
    score += Math.min(30, bodyRatio * 40);
    
    // 2. 收盘位置 (0-25分) - 收盘在低位更好
    const closePosition = (bar.h - bar.c) / range;
    score += closePosition * 25;
    
    // 3. 上影线长度 (0-20分) - 上影线长表示卖盘强
    const upperWickRatio = upperWick / range;
    score += Math.min(20, upperWickRatio * 40);
    
    // 4. 与前K线关系 (0-25分)
    if (isBearish && prevBar.c > prevBar.o) {
      // 看跌吞没前一根阳线
      score += 25;
      type = 'bearish_engulfing';
    } else if (isBearish) {
      score += 15;
      type = 'bear_signal';
    }
    
    // 5. 是否是上吊线/射击之星
    if (upperWick > body * 2 && lowerWick < body * 0.5) {
      score += 10;
      type = 'shooting_star';
    }
  }
  
  return { score: Math.min(100, score), type };
}

/**
 * 检测 Micro Channel - 微型通道
 * Micro Channel: 连续多根K线有显著重叠，形成窄幅通道
 * @param bars K线数据
 * @param lookback 回溯周期
 * @returns 是否检测到Micro Channel及方向
 */
export function detectMicroChannel(
  bars: BarData[], 
  lookback: number = 8
): { detected: boolean; direction: 'bull' | 'bear' | 'none'; overlapPct: number } {
  if (bars.length < lookback) {
    return { detected: false, direction: 'none', overlapPct: 0 };
  }
  
  const recent = bars.slice(-lookback);
  
  // 计算相邻K线的重叠度
  let totalOverlap = 0;
  let overlapCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    
    // 计算重叠区域
    const overlapHigh = Math.min(prev.h, curr.h);
    const overlapLow = Math.max(prev.l, curr.l);
    const overlap = Math.max(0, overlapHigh - overlapLow);
    const avgRange = ((prev.h - prev.l) + (curr.h - curr.l)) / 2;
    
    if (avgRange > 0) {
      totalOverlap += overlap / avgRange;
      overlapCount++;
    }
  }
  
  const avgOverlap = overlapCount > 0 ? totalOverlap / overlapCount : 0;
  
  // 重叠度 > 60% 认为是 Micro Channel
  const detected = avgOverlap > 0.6;
  
  // 判断方向
  let direction: 'bull' | 'bear' | 'none' = 'none';
  if (detected) {
    const firstClose = recent[0].c;
    const lastClose = recent[recent.length - 1].c;
    if (lastClose > firstClose) {
      direction = 'bull';
    } else if (lastClose < firstClose) {
      direction = 'bear';
    }
  }
  
  return { detected, direction, overlapPct: avgOverlap * 100 };
}

/**
 * 计算楔形测量运动目标
 * 楔形三推后的测量目标 = 楔形起点到第三推的距离
 * @param wedgeBars 楔形相关的K线
 * @returns 测量目标价格
 */
export function calcWedgeMeasurement(wedgeBars: BarData[]): number {
  if (wedgeBars.length < 2) return 0;
  
  const start = wedgeBars[0];
  const end = wedgeBars[wedgeBars.length - 1];
  
  // 测量距离 = 起点到终点的价格距离
  const distance = Math.abs(end.c - start.c);
  
  return distance;
}

/**
 * 统计趋势K线数量
 * @param bars K线数据
 * @param lookback 回溯周期
 * @returns 看涨/看跌K线数量
 */
export function countTrendBars(
  bars: BarData[], 
  lookback: number = 20
): { bullBars: number; bearBars: number; totalBars: number } {
  const recent = bars.slice(-lookback);
  
  let bullBars = 0;
  let bearBars = 0;
  
  for (const bar of recent) {
    const body = Math.abs(bar.c - bar.o);
    const range = bar.h - bar.l;
    
    // 趋势K线：实体占比 > 50%
    if (range > 0 && body / range > 0.5) {
      if (bar.c > bar.o) {
        bullBars++;
      } else {
        bearBars++;
      }
    }
  }
  
  return { bullBars, bearBars, totalBars: recent.length };
}

/**
 * 检测 Tight Trading Range (Tight TR)
 * Tight TR: 连续≥20根K线，重叠度>60%，波动率低
 * @param bars K线数据
 * @param lookback 回溯周期
 * @returns 是否检测到Tight TR及特征
 */
export function detectTightTR(
  bars: BarData[], 
  lookback: number = 30
): { detected: boolean; overlapPct: number; barsCount: number; magnetZone: { high: number; low: number } } {
  if (bars.length < 20) {
    return { detected: false, overlapPct: 0, barsCount: 0, magnetZone: { high: 0, low: 0 } };
  }
  
  const recent = bars.slice(-lookback);
  
  // 计算重叠度
  let totalOverlap = 0;
  let overlapCount = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    
    const overlapHigh = Math.min(prev.h, curr.h);
    const overlapLow = Math.max(prev.l, curr.l);
    const overlap = Math.max(0, overlapHigh - overlapLow);
    const avgRange = ((prev.h - prev.l) + (curr.h - curr.l)) / 2;
    
    if (avgRange > 0) {
      totalOverlap += overlap / avgRange;
      overlapCount++;
    }
  }
  
  const avgOverlap = overlapCount > 0 ? totalOverlap / overlapCount : 0;
  
  // 计算波动率
  const closes = recent.map(b => b.c);
  const mean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const variance = closes.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / closes.length;
  const volatility = Math.sqrt(variance) / mean;
  
  // Tight TR 条件：重叠度 > 60% 且 波动率 < 2%
  const detected = avgOverlap > 0.6 && volatility < 0.02;
  
  // 磁铁区域：Tight TR 的高低点
  const high = Math.max(...recent.map(b => b.h));
  const low = Math.min(...recent.map(b => b.l));
  
  return {
    detected,
    overlapPct: avgOverlap * 100,
    barsCount: recent.length,
    magnetZone: { high, low }
  };
}
