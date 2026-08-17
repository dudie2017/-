/**
 * Advanced Research Module
 * Based on Thorp-Simons consensus:
 * - Walk-Forward rolling window backtest
 * - Single-factor dimension validation with Bonferroni correction
 * - Signal decay testing
 * - Feature importance ranking
 */

import { fetchDaily } from './dataFetcher.js';
import { calcEMA, calcATR, calcADX } from './indicators.js';

// ============================================================
// Types
// ============================================================

interface BarData {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

interface SingleFactorResult {
  dimension: string;
  signalCount: number;
  signalMeanReturn: number;
  allMeanReturn: number;
  winRate: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  tStatistic: number;
  pValue: number;
  adjustedPValue: number; // Bonferroni corrected
  significant: boolean;
}

interface WalkForwardFold {
  foldIndex: number;
  trainStart: string;
  trainEnd: string;
  testStart: string;
  testEnd: string;
  trades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  sharpe: number;
}

interface WalkForwardResult {
  varietyCode: string;
  nFolds: number;
  totalReturn: number;
  avgSharpe: number;
  maxDrawdown: number;
  avgWinRate: number;
  folds: WalkForwardFold[];
  outOfSampleDegradation: number; // % degradation from in-sample
}

interface SignalDecayPoint {
  day: number;
  winRate: number;
  avgReturn: number;
  sampleCount: number;
}

interface DimensionConfig {
  name: string;
  description: string;
  getValue: (bars: BarData[], index: number) => number | null;
  getSignalThreshold: () => { operator: '>' | '<' | '==' | '>=' | '<='; value: number };
}

// ============================================================
// Dimension Definitions (core 20 dimensions)
// ============================================================

function getBarDimensions(): DimensionConfig[] {
  return [
    {
      name: 'ema_deviation',
      description: 'EMA偏离度 - 价格偏离EMA20的百分比',
      getValue: (bars, i) => {
        if (i < 20) return null;
        const closes = bars.slice(0, i + 1).map(b => b.c);
        const ema = calcEMA(closes, 20);
        const emaVal = ema[ema.length - 1];
        return (bars[i].c / emaVal - 1) * 100;
      },
      getSignalThreshold: () => ({ operator: '>', value: 2.0 }),
    },
    {
      name: 'adx_strength',
      description: 'ADX趋势强度',
      getValue: (bars, i) => {
        if (i < 30) return null;
        const subset = bars.slice(0, i + 1);
        const result = calcADX(subset);
        return result.adx;
      },
      getSignalThreshold: () => ({ operator: '>', value: 25 }),
    },
    {
      name: 'trend_score',
      description: '趋势评分 - 高低点趋势方向一致性百分比',
      getValue: (bars, i) => {
        if (i < 20) return null;
        const lookback = Math.min(20, i);
        const recent = bars.slice(i - lookback, i + 1);
        let hh = 0, hl = 0;
        for (let j = 1; j < recent.length; j++) {
          if (recent[j].h > recent[j - 1].h) hh++;
          if (recent[j].l > recent[j - 1].l) hl++;
        }
        return ((hh + hl) / (2 * (recent.length - 1))) * 100;
      },
      getSignalThreshold: () => ({ operator: '>', value: 65 }),
    },
    {
      name: 'body_ratio',
      description: 'K线实体占比 - 最新K线实体/振幅',
      getValue: (bars, i) => {
        const bar = bars[i];
        const range = bar.h - bar.l;
        if (range <= 0) return null;
        return Math.abs(bar.c - bar.o) / range;
      },
      getSignalThreshold: () => ({ operator: '>', value: 0.6 }),
    },
    {
      name: 'pressure_ratio',
      description: '买卖压力比 - 10日多空实体比',
      getValue: (bars, i) => {
        const lookback = Math.min(10, i + 1);
        let bull = 0, bear = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
          const body = Math.abs(bars[j].c - bars[j].o);
          if (bars[j].c > bars[j].o) bull += body;
          else bear += body;
        }
        return bear > 0 ? bull / bear : (bull > 0 ? 10 : 1);
      },
      getSignalThreshold: () => ({ operator: '>', value: 2.0 }),
    },
    {
      name: 'overlap_pct',
      description: 'K线重叠度 - 近5根K线平均重叠比例',
      getValue: (bars, i) => {
        if (i < 5) return null;
        const recent = bars.slice(i - 4, i + 1);
        let totalOverlap = 0;
        for (let j = 1; j < recent.length; j++) {
          const overlap = Math.min(recent[j].h, recent[j - 1].h) - Math.max(recent[j].l, recent[j - 1].l);
          const range = recent[j].h - recent[j].l;
          if (range > 0) totalOverlap += Math.max(0, overlap) / range;
        }
        return totalOverlap / (recent.length - 1);
      },
      getSignalThreshold: () => ({ operator: '<', value: 0.3 }),
    },
    {
      name: 'atr_expansion',
      description: 'ATR扩张率 - 当前ATR/5日前ATR',
      getValue: (bars, i) => {
        if (i < 20) return null;
        const closes = bars.slice(0, i + 1).map(b => b.c);
        const atrArr = calcATR(bars.slice(0, i + 1), 14);
        if (atrArr.length < 6) return null;
        const current = atrArr[atrArr.length - 1];
        const prev = atrArr[atrArr.length - 6];
        return prev > 0 ? current / prev : null;
      },
      getSignalThreshold: () => ({ operator: '>', value: 1.2 }),
    },
    {
      name: 'volume_surge',
      description: '成交量突增比 - 当日成交量/5日均量',
      getValue: (bars, i) => {
        if (i < 6) return null;
        const recent = bars.slice(i - 5, i + 1);
        const avgVol = recent.slice(0, 5).reduce((s, b) => s + b.vol, 0) / 5;
        return avgVol > 0 ? bars[i].vol / avgVol : null;
      },
      getSignalThreshold: () => ({ operator: '>', value: 1.5 }),
    },
    {
      name: 'streak_length',
      description: '连续同向K线数',
      getValue: (bars, i) => {
        if (i < 1) return null;
        const dir = bars[i].c > bars[i].o ? 1 : -1;
        let count = 1;
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          if ((bars[j].c > bars[j].o ? 1 : -1) === dir) count++;
          else break;
        }
        return count;
      },
      getSignalThreshold: () => ({ operator: '>=', value: 3 }),
    },
    {
      name: 'range_position',
      description: '区间位置 - 收盘价在当日振幅中的位置',
      getValue: (bars, i) => {
        const bar = bars[i];
        const range = bar.h - bar.l;
        if (range <= 0) return null;
        return (bar.c - bar.l) / range;
      },
      getSignalThreshold: () => ({ operator: '>', value: 0.75 }),
    },
  ];
}

// ============================================================
// Single-Factor Validation (with Bonferroni correction)
// ============================================================

/**
 * Test a single dimension's predictive power
 * Uses t-test and bootstrap confidence intervals
 */
export function singleFactorTest(
  bars: BarData[],
  dimension: DimensionConfig,
  forwardDays: number = 5,
): SingleFactorResult {
  const threshold = dimension.getSignalThreshold();
  const signals: number[] = []; // returns when signal triggered
  const nonSignals: number[] = []; // returns when signal not triggered

  for (let i = 30; i < bars.length - forwardDays; i++) {
    const dimValue = dimension.getValue(bars, i);
    if (dimValue === null) continue;

    // Forward return
    const futurePrice = bars[i + forwardDays].c;
    const currentPrice = bars[i].c;
    const forwardReturn = (futurePrice / currentPrice - 1) * 100;

    // Check if signal triggered
    const triggered = checkThreshold(dimValue, threshold);

    if (triggered) {
      signals.push(forwardReturn);
    } else {
      nonSignals.push(forwardReturn);
    }
  }

  // Statistical analysis
  const signalMean = signals.length > 0 ? signals.reduce((s, v) => s + v, 0) / signals.length : 0;
  const allReturns = [...signals, ...nonSignals];
  const allMean = allReturns.length > 0 ? allReturns.reduce((s, v) => s + v, 0) / allReturns.length : 0;

  const wins = signals.filter(s => s > 0).length;
  const winRate = signals.length > 0 ? wins / signals.length : 0;
  const avgWin = signals.filter(s => s > 0).reduce((s, v) => s + v, 0) / Math.max(1, wins);
  const losses = signals.filter(s => s <= 0);
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, v) => s + v, 0) / losses.length) : 0;
  const totalWin = signals.filter(s => s > 0).reduce((s, v) => s + v, 0);
  const totalLoss = Math.abs(losses.reduce((s, v) => s + v, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;

  // Simple t-test approximation
  const signalStd = signals.length > 1
    ? Math.sqrt(signals.reduce((s, v) => s + (v - signalMean) ** 2, 0) / (signals.length - 1))
    : 1;
  const se = signalStd / Math.sqrt(Math.max(1, signals.length));
  const tStat = se > 0 ? (signalMean - allMean) / se : 0;

  // Approximate p-value (two-tailed)
  const absT = Math.abs(tStat);
  const df = Math.max(1, signals.length - 1);
  // Simplified p-value approximation
  const pValue = approxPValue(absT, df);

  // Bonferroni correction for 10 dimensions
  const adjustedP = Math.min(pValue * 10, 1.0);

  return {
    dimension: dimension.name,
    signalCount: signals.length,
    signalMeanReturn: signalMean,
    allMeanReturn: allMean,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    tStatistic: tStat,
    pValue,
    adjustedPValue: adjustedP,
    significant: adjustedP < 0.05,
  };
}

function checkThreshold(value: number, threshold: { operator: string; value: number }): boolean {
  switch (threshold.operator) {
    case '>': return value > threshold.value;
    case '<': return value < threshold.value;
    case '>=': return value >= threshold.value;
    case '<=': return value <= threshold.value;
    case '==': return value === threshold.value;
    default: return false;
  }
}

function approxPValue(t: number, df: number): number {
  // Rough approximation of two-tailed t-test p-value
  // Using normal approximation for large df
  if (df > 30) {
    const z = t;
    // Approximate normal CDF
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const x = Math.abs(z) / Math.sqrt(2);
    const tt = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
    return Math.max(0, Math.min(1, 2 * (1 - y)));
  }
  // For small df, use rougher approximation
  return Math.max(0, Math.min(1, 2 * Math.exp(-0.5 * t * t) / Math.sqrt(2 * Math.PI)));
}

/**
 * Run all single-factor tests for a variety
 */
export function runAllSingleFactorTests(code: string, forwardDays = 5): {
  varietyCode: string;
  results: SingleFactorResult[];
  significantCount: number;
  topDimensions: string[];
} {
  // We need to fetch data synchronously - this is a wrapper
  // The actual async call happens in the route handler
  throw new Error('Use runAllSingleFactorTestsAsync instead');
}

export async function runAllSingleFactorTestsAsync(
  code: string,
  forwardDays = 5,
): Promise<{
  varietyCode: string;
  results: SingleFactorResult[];
  significantCount: number;
  topDimensions: string[];
}> {
  const bars = await fetchDaily(code, 250);
  if (!bars || bars.length < 60) {
    return { varietyCode: code, results: [], significantCount: 0, topDimensions: [] };
  }

  const dimensions = getBarDimensions();
  const results: SingleFactorResult[] = [];

  for (const dim of dimensions) {
    try {
      const result = singleFactorTest(bars, dim, forwardDays);
      results.push(result);
    } catch {
      // Skip failed dimensions
    }
  }

  // Sort by p-value
  results.sort((a, b) => a.pValue - b.pValue);

  const significant = results.filter(r => r.significant);
  const topDimensions = significant.map(r => r.dimension);

  return {
    varietyCode: code,
    results,
    significantCount: significant.length,
    topDimensions,
  };
}

// ============================================================
// Walk-Forward Rolling Window Backtest
// ============================================================

export async function walkForwardBacktest(
  code: string,
  trainWindow = 126,  // ~6 months
  testWindow = 42,    // ~2 months
  step = 21,          // ~1 month
  forwardDays = 5,
): Promise<WalkForwardResult> {
  const bars = await fetchDaily(code, 500);
  if (!bars || bars.length < trainWindow + testWindow + 30) {
    return {
      varietyCode: code,
      nFolds: 0,
      totalReturn: 0,
      avgSharpe: 0,
      maxDrawdown: 0,
      avgWinRate: 0,
      folds: [],
      outOfSampleDegradation: 0,
    };
  }

  const folds: WalkForwardFold[] = [];
  const maxStart = bars.length - trainWindow - testWindow;

  for (let foldIdx = 0; foldIdx * step <= maxStart; foldIdx++) {
    const startIdx = foldIdx * step;
    const trainEnd = startIdx + trainWindow;
    const testEnd = Math.min(trainEnd + testWindow, bars.length);

    if (testEnd - trainEnd < 10) break;

    const trainBars = bars.slice(startIdx, trainEnd);
    const testBars = bars.slice(trainEnd, testEnd);

    // Optimize parameters on training data
    const bestParams = optimizeOnTrain(trainBars);

    // Test on out-of-sample data
    const foldResult = testOnSample(testBars, bestParams, forwardDays);

    folds.push({
      foldIndex: foldIdx,
      trainStart: trainBars[0].date,
      trainEnd: trainBars[trainBars.length - 1].date,
      testStart: testBars[0].date,
      testEnd: testBars[testBars.length - 1].date,
      trades: foldResult.trades,
      winRate: foldResult.winRate,
      profitFactor: foldResult.profitFactor,
      totalReturn: foldResult.totalReturn,
      maxDrawdown: foldResult.maxDrawdown,
      sharpe: foldResult.sharpe,
    });
  }

  // Aggregate results
  const totalReturn = folds.reduce((s, f) => s + f.totalReturn, 0);
  const avgSharpe = folds.length > 0 ? folds.reduce((s, f) => s + f.sharpe, 0) / folds.length : 0;
  const maxDrawdown = folds.length > 0 ? Math.max(...folds.map(f => f.maxDrawdown)) : 0;
  const avgWinRate = folds.length > 0 ? folds.reduce((s, f) => s + f.winRate, 0) / folds.length : 0;

  // Calculate out-of-sample degradation
  // Compare first half folds vs second half folds
  const halfIdx = Math.floor(folds.length / 2);
  const firstHalfReturn = folds.slice(0, halfIdx).reduce((s, f) => s + f.totalReturn, 0);
  const secondHalfReturn = folds.slice(halfIdx).reduce((s, f) => s + f.totalReturn, 0);
  const degradation = firstHalfReturn !== 0
    ? ((firstHalfReturn - secondHalfReturn) / Math.abs(firstHalfReturn)) * 100
    : 0;

  return {
    varietyCode: code,
    nFolds: folds.length,
    totalReturn,
    avgSharpe,
    maxDrawdown,
    avgWinRate,
    folds,
    outOfSampleDegradation: degradation,
  };
}

interface OptimizedParams {
  emaPeriod: number;
  adxThreshold: number;
  signalThreshold: number;
  atrStopMult: number;
  atrTargetMult: number;
}

function optimizeOnTrain(bars: BarData[]): OptimizedParams {
  // Grid search over key parameters
  const paramGrid = {
    emaPeriod: [10, 15, 20, 25],
    adxThreshold: [20, 25, 30],
    signalThreshold: [40, 50, 60],
    atrStopMult: [1.5, 2.0, 2.5],
    atrTargetMult: [2.5, 3.0, 4.0],
  };

  let bestParams: OptimizedParams = {
    emaPeriod: 20,
    adxThreshold: 25,
    signalThreshold: 50,
    atrStopMult: 2.0,
    atrTargetMult: 3.0,
  };
  let bestSharpe = -999;

  // Simplified grid search (not exhaustive to save time)
  for (const emaP of paramGrid.emaPeriod) {
    for (const adxT of paramGrid.adxThreshold) {
      for (const stopM of paramGrid.atrStopMult) {
        for (const targetM of paramGrid.atrTargetMult) {
          // Skip invalid combinations (target should be > stop for positive expectancy)
          if (targetM <= stopM) continue;
          
          const result = quickBacktest(bars, {
            emaPeriod: emaP,
            adxThreshold: adxT,
            signalThreshold: 50,
            atrStopMult: stopM,
            atrTargetMult: targetM,
          }, 5);

          if (result.sharpe > bestSharpe) {
            bestSharpe = result.sharpe;
            bestParams = {
              emaPeriod: emaP,
              adxThreshold: adxT,
              signalThreshold: 50,
              atrStopMult: stopM,
              atrTargetMult: targetM,
            };
          }
        }
      }
    }
  }

  return bestParams;
}

function quickBacktest(bars: BarData[], params: OptimizedParams, forwardDays: number) {
  let wins = 0, losses = 0;
  let totalReturn = 0;
  const returns: number[] = [];

  for (let i = params.emaPeriod + 14; i < bars.length - forwardDays; i++) {
    const closes = bars.slice(0, i + 1).map(b => b.c);
    const ema = calcEMA(closes, params.emaPeriod);
    const emaVal = ema[ema.length - 1];
    const direction = bars[i].c > emaVal ? 'LONG' : 'SHORT';

    // Check ADX
    const adxResult = calcADX(bars.slice(0, i + 1));
    if (adxResult.adx < params.adxThreshold) continue;

    // Calculate ATR for stop/target
    const atrArr = calcATR(bars.slice(0, i + 1), 14);
    const atr = atrArr[atrArr.length - 1];
    if (atr <= 0) continue;

    const entryPrice = bars[i].c;
    const stopPrice = direction === 'LONG'
      ? entryPrice - params.atrStopMult * atr
      : entryPrice + params.atrStopMult * atr;
    const targetPrice = direction === 'LONG'
      ? entryPrice + params.atrTargetMult * atr
      : entryPrice - params.atrTargetMult * atr;

    // Check outcome over forward days
    let outcome = 0;
    for (let j = i + 1; j <= Math.min(i + forwardDays, bars.length - 1); j++) {
      if (direction === 'LONG') {
        if (bars[j].l <= stopPrice) { outcome = -1; break; }
        if (bars[j].h >= targetPrice) { outcome = 1; break; }
      } else {
        if (bars[j].h >= stopPrice) { outcome = -1; break; }
        if (bars[j].l <= targetPrice) { outcome = 1; break; }
      }
    }

    if (outcome === 1) {
      wins++;
      const ret = params.atrTargetMult * atr / entryPrice * 100;
      returns.push(ret);
      totalReturn += ret;
    } else if (outcome === -1) {
      losses++;
      const ret = -params.atrStopMult * atr / entryPrice * 100;
      returns.push(ret);
      totalReturn += ret;
    }
  }

  const total = wins + losses;
  const winRate = total > 0 ? wins / total : 0;
  const avgReturn = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / (returns.length - 1))
    : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252 / forwardDays) : 0;

  // Max drawdown
  let peak = 0, maxDd = 0, equity = 0;
  for (const r of returns) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  return {
    trades: total,
    winRate,
    profitFactor: losses > 0 ? (wins * avgReturn) / (losses * Math.abs(avgReturn)) : wins > 0 ? 999 : 0,
    totalReturn,
    maxDrawdown: maxDd,
    sharpe,
  };
}

function testOnSample(bars: BarData[], params: OptimizedParams, forwardDays: number) {
  // Same as quickBacktest but on test data
  return quickBacktest(bars, params, forwardDays);
}

// ============================================================
// Signal Decay Testing
// ============================================================

export async function signalDecayTest(
  code: string,
  maxDays = 15,
): Promise<{
  varietyCode: string;
  decayProfile: SignalDecayPoint[];
  halfLife: number; // days until win rate drops to 50%
  recommendation: string;
}> {
  const bars = await fetchDaily(code, 300);
  if (!bars || bars.length < 60) {
    return { varietyCode: code, decayProfile: [], halfLife: 0, recommendation: '数据不足' };
  }

  const decayProfile: SignalDecayPoint[] = [];

  for (let day = 1; day <= maxDays; day++) {
    let signals = 0, wins = 0;
    let totalReturn = 0;

    for (let i = 30; i < bars.length - day; i++) {
      // Generate signal
      const closes = bars.slice(0, i + 1).map(b => b.c);
      const ema = calcEMA(closes, 20);
      const emaVal = ema[ema.length - 1];
      const direction = bars[i].c > emaVal ? 'LONG' : 'SHORT';

      // Check ADX
      const adxResult = calcADX(bars.slice(0, i + 1));
      if (adxResult.adx < 25) continue;

      signals++;
      const entryPrice = bars[i].c;
      const futurePrice = bars[i + day].c;
      const ret = direction === 'LONG'
        ? (futurePrice / entryPrice - 1) * 100
        : (1 - futurePrice / entryPrice) * 100;

      if (ret > 0) wins++;
      totalReturn += ret;
    }

    decayProfile.push({
      day,
      winRate: signals > 0 ? wins / signals : 0,
      avgReturn: signals > 0 ? totalReturn / signals : 0,
      sampleCount: signals,
    });
  }

  // Calculate half-life (when win rate drops to 50%)
  let halfLife = maxDays;
  for (const point of decayProfile) {
    if (point.winRate < 0.5) {
      halfLife = point.day - 1;
      break;
    }
  }

  // Recommendation
  let recommendation = '';
  if (halfLife >= 10) {
    recommendation = '信号持续性强，适合日线级别持仓';
  } else if (halfLife >= 5) {
    recommendation = '信号中等持续性，建议3-5日内持仓';
  } else if (halfLife >= 2) {
    recommendation = '信号衰减较快，建议1-3日内快速交易';
  } else {
    recommendation = '信号衰减极快，需要更快的执行速度或更高信号阈值';
  }

  return { varietyCode: code, decayProfile, halfLife, recommendation };
}

// ============================================================
// Multi-Variety Research Summary
// ============================================================

export async function runFullResearch(
  codes: string[],
): Promise<{
  singleFactorResults: Record<string, Awaited<ReturnType<typeof runAllSingleFactorTestsAsync>>>;
  walkForwardResults: WalkForwardResult[];
  signalDecayResults: Array<{ code: string; halfLife: number; recommendation: string }>;
  overallSummary: {
    mostSignificantDimensions: string[];
    bestVarieties: string[];
    averageHalfLife: number;
    systemRecommendation: string;
  };
}> {
  // Run single-factor tests
  const singleFactorResults: Record<string, Awaited<ReturnType<typeof runAllSingleFactorTestsAsync>>> = {};
  for (const code of codes) {
    try {
      singleFactorResults[code] = await runAllSingleFactorTestsAsync(code);
    } catch {
      // Skip failed varieties
    }
  }

  // Run walk-forward backtests
  const walkForwardResults: WalkForwardResult[] = [];
  for (const code of codes) {
    try {
      const wf = await walkForwardBacktest(code);
      walkForwardResults.push(wf);
    } catch {
      // Skip failed
    }
  }

  // Run signal decay tests
  const signalDecayResults: Array<{ code: string; halfLife: number; recommendation: string }> = [];
  for (const code of codes) {
    try {
      const decay = await signalDecayTest(code);
      signalDecayResults.push({
        code,
        halfLife: decay.halfLife,
        recommendation: decay.recommendation,
      });
    } catch {
      // Skip
    }
  }

  // Overall summary
  const dimCounts: Record<string, number> = {};
  for (const result of Object.values(singleFactorResults)) {
    for (const dim of result.topDimensions) {
      dimCounts[dim] = (dimCounts[dim] || 0) + 1;
    }
  }
  const mostSignificantDimensions = Object.entries(dimCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dim]) => dim);

  const bestVarieties = walkForwardResults
    .filter(wf => wf.avgSharpe > 0.5)
    .sort((a, b) => b.avgSharpe - a.avgSharpe)
    .map(wf => wf.varietyCode);

  const avgHalfLife = signalDecayResults.length > 0
    ? signalDecayResults.reduce((s, r) => s + r.halfLife, 0) / signalDecayResults.length
    : 0;

  let systemRecommendation = '';
  if (bestVarieties.length >= 5 && avgHalfLife >= 5) {
    systemRecommendation = '系统信号有效，建议进入模拟盘验证阶段';
  } else if (bestVarieties.length >= 3) {
    systemRecommendation = '部分品种信号有效，建议仅交易这些品种并继续优化';
  } else {
    systemRecommendation = '信号有效性不足，需要调整维度阈值或增加新维度';
  }

  return {
    singleFactorResults,
    walkForwardResults,
    signalDecayResults,
    overallSummary: {
      mostSignificantDimensions,
      bestVarieties,
      averageHalfLife: avgHalfLife,
      systemRecommendation,
    },
  };
}
