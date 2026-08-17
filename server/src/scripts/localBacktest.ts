/**
 * 多周期回测脚本 - 使用本地1分钟数据
 * 对每个品种的6个周期（1m/5m/15m/30m/60m/daily）运行完整回测
 */
import { loadAllLocalData, getAllTimeframeData } from '../services/localDataLoader.js';
import { calcEMA, calcATR, calcADXSeries } from '../services/indicators.js';
import type { KlineBar } from '../services/localDataLoader.js';

interface Trade {
  entryDate: string;
  entryPrice: number;
  direction: 'long' | 'short';
  exitDate: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  barsHeld: number;
}

interface TimeframeResult {
  period: string;
  label: string;
  barsAvailable: number;
  tradingDays: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgHoldingBars: number;
  sharpe: number;
}

interface VarietyResult {
  code: string;
  name: string;
  timeframes: TimeframeResult[];
  bestPeriod: string;
  worstPeriod: string;
}

/**
 * Brooks维度计算
 */

// 光谱定位：判断市场处于趋势、通道还是区间状态
function calcSpectrum(bars: KlineBar[], index: number, lookback: number = 5): 'trend' | 'channel' | 'range' {
  if (index < lookback) return 'range';
  const recent = bars.slice(index - lookback, index);
  
  // 计算相邻K线的重叠度
  let overlaps = 0;
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    // 检查两根K线的高低点是否重叠
    if (Math.max(prev.l, curr.l) < Math.min(prev.h, curr.h)) {
      overlaps++;
    }
  }
  
  // 重叠度 >= 3: 区间, 1-2: 通道, 0: 趋势
  if (overlaps >= 3) return 'range';
  if (overlaps >= 1) return 'channel';
  return 'trend';
}

// 突破评分：评估当前K线的突破强度
function calcBreakoutScore(bars: KlineBar[], index: number): number {
  if (index < 10) return 0;
  const bar = bars[index];
  const range = bar.h - bar.l;
  if (range <= 0) return 0;
  
  let score = 0;
  const body = Math.abs(bar.c - bar.o);
  const bodyRatio = body / range;
  const isBull = bar.c > bar.o;
  
  // 1. 实体比例 (0-2分)
  if (bodyRatio > 0.7) score += 2;
  else if (bodyRatio > 0.5) score += 1;
  
  // 2. 创近期新高/新低 (0-2分)
  const recentHighs = bars.slice(Math.max(0, index - 10), index).map(b => b.h);
  const recentLows = bars.slice(Math.max(0, index - 10), index).map(b => b.l);
  if (isBull && bar.c > Math.max(...recentHighs)) score += 2;
  if (!isBull && bar.c < Math.min(...recentLows)) score += 2;
  
  // 3. 成交量放大 (0-1分) - 简化处理，用K线振幅代替
  const avgRange = bars.slice(Math.max(0, index - 10), index).reduce((s, b) => s + (b.h - b.l), 0) / 10;
  if (range > avgRange * 1.5) score += 1;
  
  return score;
}

// AI方向：Always In方向
function calcAIDirection(bars: KlineBar[], index: number, ema20: number[]): 'long' | 'short' {
  if (index < 20) return 'long';
  return bars[index].c > ema20[index] ? 'long' : 'short';
}

/**
 * 增强版Brooks信号检测 + ADX趋势过滤 + 多时间框架确认 + Brooks维度
 */
function detectSignal(
  bars: KlineBar[], 
  index: number, 
  ema20: number[], 
  atr14: number[], 
  adx14: number[],
  dailyTrend?: 'long' | 'short'  // 日线趋势方向（多时间框架确认）
): { action: 'buy' | 'sell' | null; stopDistance: number } {
  if (index < 30 || index >= bars.length - 1) return { action: null, stopDistance: 0 };

  const bar = bars[index];
  const prev = bars[index - 1];
  const ema = ema20[index];
  const atr = atr14[index];
  const adx = adx14[index];

  if (!atr || atr <= 0 || !ema) return { action: null, stopDistance: 0 };
  
  // ADX趋势过滤：只在ADX > 20时交易（降低阈值以增加交易机会）
  if (!adx || adx < 20) return { action: null, stopDistance: 0 };

  const body = Math.abs(bar.c - bar.o);
  const range = bar.h - bar.l;
  if (range <= 0) return { action: null, stopDistance: 0 };

  const bodyRatio = body / range;
  const isBull = bar.c > bar.o;
  const isBear = bar.c < bar.o;

  // 趋势方向
  const aboveEMA = bar.c > ema;
  const prevAboveEMA = prev.c > ema20[index - 1];

  // EMA斜率
  const emaSlope = index >= 5 ? (ema - ema20[index - 5]) / ema20[index - 5] : 0;

  // Brooks维度计算
  const spectrum = calcSpectrum(bars, index);
  const breakoutScore = calcBreakoutScore(bars, index);
  const aiDirection = calcAIDirection(bars, index, ema20);

  // 多时间框架确认：如果有日线趋势，只做与日线方向一致的交易
  if (dailyTrend) {
    if (dailyTrend === 'long' && aiDirection === 'short') return { action: null, stopDistance: 0 };
    if (dailyTrend === 'short' && aiDirection === 'long') return { action: null, stopDistance: 0 };
  }

  // 信号1: 趋势延续 - 强趋势K线突破（需要光谱定位为趋势或通道）
  if (spectrum !== 'range' && aboveEMA && emaSlope > 0.0005 && isBull && bodyRatio > 0.5 && breakoutScore >= 3) {
    const recentHighs = bars.slice(Math.max(0, index - 10), index).map(b => b.h);
    const maxRecentHigh = Math.max(...recentHighs);
    if (bar.c > maxRecentHigh) {
      return { action: 'buy', stopDistance: 2 * atr };
    }
  }

  if (spectrum !== 'range' && !aboveEMA && emaSlope < -0.0005 && isBear && bodyRatio > 0.5 && breakoutScore >= 3) {
    const recentLows = bars.slice(Math.max(0, index - 10), index).map(b => b.l);
    const minRecentLow = Math.min(...recentLows);
    if (bar.c < minRecentLow) {
      return { action: 'sell', stopDistance: 2 * atr };
    }
  }

  // 信号2: 反转 - 高潮后的反转K线（需要突破评分低）
  if (breakoutScore < 2 && prevAboveEMA && !aboveEMA && isBear && bodyRatio > 0.6 && body > atr * 0.5) {
    return { action: 'sell', stopDistance: 2 * atr };
  }

  if (breakoutScore < 2 && !prevAboveEMA && aboveEMA && isBull && bodyRatio > 0.6 && body > atr * 0.5) {
    return { action: 'buy', stopDistance: 2 * atr };
  }

  // 信号3: 区间陷阱（只在区间市场中）
  if (spectrum === 'range' && bodyRatio < 0.3 && index >= 2) {
    const prevBar = bars[index - 1];
    const prevBody = Math.abs(prevBar.c - prevBar.o);
    const prevRange = prevBar.h - prevBar.l;
    if (prevRange > 0 && prevBody / prevRange > 0.7) {
      if (prevBar.c > prevBar.o && isBear && bar.c < prevBar.o) {
        return { action: 'sell', stopDistance: 1.5 * atr };
      }
      if (prevBar.c < prevBar.o && isBull && bar.c > prevBar.o) {
        return { action: 'buy', stopDistance: 1.5 * atr };
      }
    }
  }

  return { action: null, stopDistance: 0 };
}

/**
 * 运行单个周期的回测
 * 策略：2倍ATR动态移动止损 + ADX趋势过滤 + 多时间框架确认 + Brooks维度
 */
function runBacktest(
  bars: KlineBar[], 
  period: string, 
  label: string, 
  maxTrades: number = 200,
  dailyBars?: KlineBar[]  // 日线数据，用于多时间框架确认
): TimeframeResult {
  if (bars.length < 30) {
    return {
      period, label, barsAvailable: bars.length, tradingDays: 0,
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      avgProfit: 0, avgLoss: 0, profitFactor: 0, totalReturn: 0,
      maxDrawdown: 0, avgHoldingBars: 0, sharpe: 0,
    };
  }

  // 计算指标
  const closes = bars.map(b => b.c);
  const ema20 = calcEMA(closes, 20);
  const atr14 = calcATR(bars.map(b => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: 0 })), 14);
  // ADX用于趋势过滤
  const adxValues = calcADXSeries(bars.map(b => ({ date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: 0 })), 14);

  // 多时间框架确认：计算日线EMA20（仅对非日线周期）
  let dailyEma20: number[] = [];
  let dailyDates: string[] = [];
  if (dailyBars && period !== 'daily') {
    const dailyCloses = dailyBars.map(b => b.c);
    dailyEma20 = calcEMA(dailyCloses, 20);
    dailyDates = dailyBars.map(b => b.date);
  }

  // 辅助函数：根据当前K线日期获取日线趋势方向
  const getDailyTrend = (currentDate: string): 'long' | 'short' | undefined => {
    if (dailyEma20.length === 0 || dailyDates.length === 0) return undefined;
    // 找到当前日期对应的日线K线索引
    let dailyIndex = -1;
    for (let j = dailyDates.length - 1; j >= 0; j--) {
      if (dailyDates[j] <= currentDate) {
        dailyIndex = j;
        break;
      }
    }
    if (dailyIndex < 20) return undefined;
    const dailyBar = dailyBars![dailyIndex];
    const dailyEma = dailyEma20[dailyIndex];
    if (!dailyBar || !dailyEma) return undefined;
    return dailyBar.c > dailyEma ? 'long' : 'short';
  };

  const trades: Trade[] = [];
  let position: {
    direction: 'long' | 'short';
    entryPrice: number;
    entryDate: string;
    entryIndex: number;
    trailingStop: number;  // 动态移动止损价
    bestPrice: number;     // 持仓期间最优价格（多头=最高价，空头=最低价）
  } | null = null;
  let capital = 100000;
  let peakCapital = capital;
  let maxDrawdown = 0;
  const returns: number[] = [];
  // 止损后冷却：触发止损后需要等待新的反向信号才能再入场
  let coolingDown = false;

  for (let i = 30; i < bars.length && trades.length < maxTrades; i++) {
    const bar = bars[i];
    const atr = atr14[i];
    if (!atr || atr <= 0) continue;
    // 跳过异常数据：ATR相对于价格过大（说明数据有跳变）
    if (atr / bar.c > 0.1) continue;

    // === 检测价格跳变（合约换月导致的数据不连续） ===
    // 检查1: 当前K线的开盘价与前一K线收盘价差异超过30%，视为数据跳变
    // 检查2: K线内部价格范围（最高/最低）超过50%，视为异常数据
    const barRange = bar.h / Math.max(bar.l, 0.01);
    const isBadBar = barRange > 1.5; // 单根K线振幅超过50%视为异常
    if (i > 0) {
      const prevClose = bars[i - 1].c;
      const gapPct = Math.abs(bar.o - prevClose) / prevClose;
      if (gapPct > 0.3 || isBadBar) {
        // 如果持仓中遇到跳变，强制平仓（按开盘价）
        if (position) {
          const exitPrice = bar.o;
          const pnl = position.direction === 'long'
            ? exitPrice - position.entryPrice
            : position.entryPrice - exitPrice;
          const pnlPct = (pnl / position.entryPrice) * 100;
          trades.push({
            entryDate: position.entryDate,
            entryPrice: position.entryPrice,
            direction: position.direction,
            exitDate: bar.date,
            exitPrice,
            pnl,
            pnlPct,
            barsHeld: i - position.entryIndex,
          });
          returns.push(pnlPct);
          // 限制单笔最大亏损为资金的5%
          const cappedReturn = Math.max(pnlPct / 100, -0.05);
          capital *= (1 + cappedReturn);
          position = null;
          coolingDown = true;
        }
        continue; // 跳过这根跳变K线，不产生新信号
      }
    }

    // === 持仓中：更新移动止损并检查是否触发 ===
    if (position) {
      if (position.direction === 'long') {
        // 多头：更新最优价格为最高价
        position.bestPrice = Math.max(position.bestPrice, bar.h);
        // 移动止损 = 最优价格 - 2倍ATR（给趋势呼吸空间）
        const newStop = position.bestPrice - 2 * atr;
        position.trailingStop = Math.max(position.trailingStop, newStop); // 止损只能上移不能下移

        // 检查是否触发止损
        if (bar.l <= position.trailingStop) {
          const exitPrice = position.trailingStop;
          const pnl = exitPrice - position.entryPrice;
          const pnlPct = (pnl / position.entryPrice) * 100;

          trades.push({
            entryDate: position.entryDate,
            entryPrice: position.entryPrice,
            direction: position.direction,
            exitDate: bar.date,
            exitPrice,
            pnl,
            pnlPct,
            barsHeld: i - position.entryIndex,
          });

          returns.push(pnlPct);
          // 限制单笔最大亏损为5%，防止灾难性损失
          const positionReturn = Math.max(pnlPct / 100, -0.05);
          capital *= (1 + positionReturn);
          peakCapital = Math.max(peakCapital, capital);
          const drawdown = (peakCapital - capital) / peakCapital;
          maxDrawdown = Math.max(maxDrawdown, drawdown);

          position = null;
          coolingDown = true; // 止损后进入冷却，等待新信号
          continue;
        }
      } else {
        // 空头：更新最优价格为最低价
        position.bestPrice = Math.min(position.bestPrice, bar.l);
        // 移动止损 = 最优价格 + 2倍ATR（给趋势呼吸空间）
        const newStop = position.bestPrice + 2 * atr;
        position.trailingStop = Math.min(position.trailingStop, newStop); // 止损只能下移不能上移

        // 检查是否触发止损
        if (bar.h >= position.trailingStop) {
          const exitPrice = position.trailingStop;
          const pnl = position.entryPrice - exitPrice;
          const pnlPct = (pnl / position.entryPrice) * 100;

          trades.push({
            entryDate: position.entryDate,
            entryPrice: position.entryPrice,
            direction: position.direction,
            exitDate: bar.date,
            exitPrice,
            pnl,
            pnlPct,
            barsHeld: i - position.entryIndex,
          });

          returns.push(pnlPct);
          // 限制单笔最大亏损为5%，防止灾难性损失
          const positionReturn = Math.max(pnlPct / 100, -0.05);
          capital *= (1 + positionReturn);
          peakCapital = Math.max(peakCapital, capital);
          const drawdown = (peakCapital - capital) / peakCapital;
          maxDrawdown = Math.max(maxDrawdown, drawdown);

          position = null;
          coolingDown = true; // 止损后进入冷却，等待新信号
          continue;
        }
      }
      // 持仓中但未触发止损，继续持有（不检查新信号）
      continue;
    }

    // === 空仓：检测信号 ===
    // 冷却期间也需要检测信号，但只有反向信号才能触发入场
    const dailyTrend = getDailyTrend(bar.date);
    const signal = detectSignal(bars, i, ema20, atr14, adxValues, dailyTrend);
    if (signal.action) {
      // 开仓
      position = {
        direction: signal.action === 'buy' ? 'long' : 'short',
        entryPrice: bar.c,
        entryDate: bar.date,
        entryIndex: i,
        trailingStop: signal.action === 'buy' ? bar.c - 2 * atr : bar.c + 2 * atr, // 初始止损 = 入场价 ± 2倍ATR
        bestPrice: signal.action === 'buy' ? bar.h : bar.l,
      };
      coolingDown = false;
    }
  }

  // 计算统计
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;

  const avgProfit = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0;

  const totalReturn = trades.length > 0 ? trades.reduce((s, t) => s + t.pnlPct, 0) : 0;
  const avgHoldingBars = trades.length > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : 0;

  // Sharpe ratio
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1 ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1)) : 1;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  // 计算交易天数
  const uniqueDates = new Set(bars.map(b => b.date));

  return {
    period,
    label,
    barsAvailable: bars.length,
    tradingDays: uniqueDates.size,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 1000) / 1000,
    avgProfit: Math.round(avgProfit * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalReturn: Math.round(totalReturn * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
    avgHoldingBars: Math.round(avgHoldingBars * 10) / 10,
    sharpe: Math.round(sharpe * 100) / 100,
  };
}

/**
 * 主函数
 */
export function runLocalMultiTimeframeBacktest(): VarietyResult[] {
  console.log('📂 加载本地数据文件...');
  const varieties = loadAllLocalData();
  console.log(`\n✅ 加载了 ${varieties.length} 个品种\n`);

  const results: VarietyResult[] = [];

  for (const variety of varieties) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`📊 ${variety.code} (${variety.name}) - ${variety.bars.length} bars`);
    console.log(`${'='.repeat(60)}`);

    const allData = getAllTimeframeData(variety.bars);

    const timeframeResults: TimeframeResult[] = [];
    const periodLabels: Record<string, string> = {
      '1m': '1分钟', '5m': '5分钟', '15m': '15分钟',
      '30m': '30分钟', '60m': '60分钟', 'daily': '日线',
    };

    // 获取日线数据用于多时间框架确认
    const dailyBars = allData.daily;

    for (const [period, bars] of Object.entries(allData)) {
      const label = periodLabels[period] || period;
      // 对非日线周期传入日线数据用于趋势过滤
      const result = runBacktest(bars, period, label, 200, period !== 'daily' ? dailyBars : undefined);
      timeframeResults.push(result);

      const winRateStr = `${(result.winRate * 100).toFixed(1)}%`;
      const pfStr = result.profitFactor.toFixed(2);
      const retStr = `${result.totalReturn > 0 ? '+' : ''}${result.totalReturn.toFixed(2)}%`;
      console.log(`  ${label.padEnd(6)} | ${String(result.barsAvailable).padStart(7)} bars | ${String(result.tradingDays).padStart(4)}天 | ${String(result.totalTrades).padStart(3)}笔 | 胜率${winRateStr.padEnd(6)} | 盈亏比${pfStr.padEnd(5)} | 收益${retStr.padEnd(8)} | 回撤${result.maxDrawdown.toFixed(1)}%`);
    }

    // 找最佳/最差周期（按盈亏比排序，至少5笔交易）
    const validResults = timeframeResults.filter(r => r.totalTrades >= 5);
    const sorted = [...validResults].sort((a, b) => b.profitFactor - a.profitFactor);

    const best = sorted[0]?.period || 'N/A';
    const worst = sorted[sorted.length - 1]?.period || 'N/A';

    results.push({
      code: variety.code,
      name: variety.name,
      timeframes: timeframeResults,
      bestPeriod: best,
      worstPeriod: worst,
    });
  }

  // 汇总报告
  console.log(`\n\n${'='.repeat(80)}`);
  console.log('📋 多周期回测汇总报告');
  console.log(`${'='.repeat(80)}`);
  console.log(`\n${'品种'.padEnd(10)} | ${'最佳周期'.padEnd(8)} | ${'最差周期'.padEnd(8)} | 各周期胜率`);
  console.log('-'.repeat(80));

  for (const r of results) {
    const tfWinRates = r.timeframes.map(tf => `${tf.label}:${(tf.winRate * 100).toFixed(0)}%`).join(' | ');
    const bestLabel = r.timeframes.find(tf => tf.period === r.bestPeriod)?.label || r.bestPeriod;
    const worstLabel = r.timeframes.find(tf => tf.period === r.worstPeriod)?.label || r.worstPeriod;
    console.log(`${(r.code + ' ' + r.name).padEnd(10)} | ${bestLabel.padEnd(8)} | ${worstLabel.padEnd(8)} | ${tfWinRates}`);
  }

  // 跨品种最佳周期统计
  const bestCounts: Record<string, number> = {};
  for (const r of results) {
    const bestTF = r.timeframes.find(tf => tf.period === r.bestPeriod);
    const label = bestTF?.label || r.bestPeriod;
    bestCounts[label] = (bestCounts[label] || 0) + 1;
  }

  console.log(`\n📊 跨品种最佳周期统计:`);
  for (const [period, count] of Object.entries(bestCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${period}: ${count}/${results.length} 个品种`);
  }

  return results;
}

// 直接运行
runLocalMultiTimeframeBacktest();
