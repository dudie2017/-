/**
 * 动态止损策略分析
 * 
 * 实现三种动态止损策略：
 * 1. 移动止损（Breakeven Stop）：盈利超过 1R 后，止损移至成本价
 * 2. ATR 追踪止损：止损 = 最高价 - N × ATR
 * 3. 时间止损：持仓超过 N 天未达目标，强制平仓
 * 
 * 对比固定止损 vs 动态止损的效果
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import { loadBars, runTop1Backtest, calcStats, type Bar, type TradeLike } from './runTop1FullBacktest';

const OUT_DIR = path.resolve('src/data');
const POOL_VARIETIES = ['CF0', 'CU0', 'HC0'];

interface DynamicStopResult {
  strategy: string;
  params: Record<string, number>;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  profitFactor: number;
  avgHoldDays: number;
}

interface VarietyResult {
  variety: string;
  baseline: DynamicStopResult;
  strategies: DynamicStopResult[];
  best: DynamicStopResult;
}

// 计算 ATR
function computeATR(bars: Bar[], period: number = 14): number[] {
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      atr.push(0);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const b = bars[j], prev = bars[j - 1];
      sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    }
    atr.push(sum / period);
  }
  return atr;
}

// 应用移动止损（盈利超过 threshold R 后，止损移至成本价）
function applyBreakevenStop(trades: TradeLike[], threshold: number = 1.0): TradeLike[] {
  return trades.map(t => {
    const risk = Math.abs(t.entryPrice - t.stopPrice);
    if (risk <= 0) return t;
    
    // 如果最大盈利超过 threshold R，检查是否回落到成本价
    const maxProfitR = t.maxFavorableExcursion ? t.maxFavorableExcursion / risk : 0;
    if (maxProfitR >= threshold && t.pnl <= 0) {
      // 原本会亏损的交易，但因为移动止损应该在成本价平仓
      return { ...t, pnl: 0, exitPrice: t.entryPrice, result: 'breakeven' };
    }
    return t;
  });
}

// 应用 ATR 追踪止损
function applyATRTrailingStop(
  trades: TradeLike[],
  bars: Bar[],
  atrMult: number = 2.0
): TradeLike[] {
  const atr = computeATR(bars);
  const dateIdx = new Map<string, number>();
  bars.forEach((b, i) => dateIdx.set(b.date, i));
  
  return trades.map(t => {
    const entryIdx = dateIdx.get(t.entryDate);
    const exitIdx = dateIdx.get(t.exitDate);
    if (entryIdx === undefined || exitIdx === undefined) return t;
    
    if (t.direction === 'long') {
      // 多头：追踪最高价
      let maxHigh = t.entryPrice;
      for (let i = entryIdx; i <= exitIdx; i++) {
        maxHigh = Math.max(maxHigh, bars[i].h);
        const trailingStop = maxHigh - atrMult * atr[i];
        // 如果价格跌破追踪止损
        if (bars[i].l <= trailingStop && i < exitIdx) {
          const newExitPrice = trailingStop;
          const pnl = (newExitPrice - t.entryPrice) * (t.positionSize || 1);
          return { ...t, exitDate: bars[i].date, exitPrice: newExitPrice, pnl, result: 'trailing_stop' };
        }
      }
    } else {
      // 空头：追踪最低价
      let minLow = t.entryPrice;
      for (let i = entryIdx; i <= exitIdx; i++) {
        minLow = Math.min(minLow, bars[i].l);
        const trailingStop = minLow + atrMult * atr[i];
        // 如果价格突破追踪止损
        if (bars[i].h >= trailingStop && i < exitIdx) {
          const newExitPrice = trailingStop;
          const pnl = (t.entryPrice - newExitPrice) * (t.positionSize || 1);
          return { ...t, exitDate: bars[i].date, exitPrice: newExitPrice, pnl, result: 'trailing_stop' };
        }
      }
    }
    return t;
  });
}

// 应用时间止损
function applyTimeStop(trades: TradeLike[], maxDays: number = 20): TradeLike[] {
  return trades.map(t => {
    if (!t.entryDate || !t.exitDate) return t;
    const entry = new Date(t.entryDate);
    const exit = new Date(t.exitDate);
    const holdDays = (exit.getTime() - entry.getTime()) / (1000 * 60 * 60 * 24);
    
    // 如果持仓超过 maxDays 且未盈利，强制平仓
    if (holdDays > maxDays && t.pnl <= 0) {
      // 模拟在第 maxDays 天平仓
      const forcedExitDate = new Date(entry);
      forcedExitDate.setDate(forcedExitDate.getDate() + maxDays);
      return { 
        ...t, 
        exitDate: forcedExitDate.toISOString().slice(0, 10),
        result: 'time_stop'
      };
    }
    return t;
  });
}

function computeCalmar(totalPnl: number, maxDrawdown: number, capital: number): number {
  if (maxDrawdown <= 0) return totalPnl > 0 ? 99 : 0;
  return (totalPnl / capital) / maxDrawdown;
}

async function analyzeVariety(variety: string): Promise<VarietyResult | null> {
  const recipe = TOP1_UNIFIED_PARAMS[variety];
  if (!recipe) return null;
  
  const theo = {
    longReturn: recipe.directionMode === 'shortOnly' ? 0 : 1,
    shortReturn: recipe.directionMode === 'longOnly' ? 0 : 1,
  };
  
  const bars = loadBars(variety);
  if (bars.length === 0) return null;
  
  // 基线回测
  const baselineResult = await runTop1Backtest(variety, recipe, bars, theo);
  const baselineTrades = baselineResult.trades;
  const baselineStats = calcStats(baselineTrades, theo.longReturn, theo.shortReturn, 1_000_000);
  
  const baseline: DynamicStopResult = {
    strategy: 'fixed',
    params: { stopAtrMult: recipe.stopAtrMult, targetAtrMult: recipe.targetAtrMult },
    totalTrades: baselineStats.totalTrades,
    winRate: baselineStats.winRate,
    totalPnl: baselineStats.totalPnl,
    maxDrawdown: baselineStats.maxDrawdown,
    calmar: computeCalmar(baselineStats.totalPnl, baselineStats.maxDrawdown, 1_000_000),
    profitFactor: baselineStats.profitFactor,
    avgHoldDays: baselineTrades.reduce((sum, t) => {
      if (!t.entryDate || !t.exitDate) return sum;
      const days = (new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime()) / (1000 * 60 * 60 * 24);
      return sum + days;
    }, 0) / baselineTrades.length,
  };
  
  const strategies: DynamicStopResult[] = [];
  
  // 策略1: 移动止损（不同阈值）
  for (const threshold of [0.5, 1.0, 1.5, 2.0]) {
    const modifiedTrades = applyBreakevenStop(baselineTrades, threshold);
    const stats = calcStats(modifiedTrades, theo.longReturn, theo.shortReturn, 1_000_000);
    strategies.push({
      strategy: 'breakeven',
      params: { threshold },
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      maxDrawdown: stats.maxDrawdown,
      calmar: computeCalmar(stats.totalPnl, stats.maxDrawdown, 1_000_000),
      profitFactor: stats.profitFactor,
      avgHoldDays: baseline.avgHoldDays,
    });
  }
  
  // 策略2: ATR 追踪止损（不同倍数）
  for (const atrMult of [1.5, 2.0, 2.5, 3.0]) {
    const modifiedTrades = applyATRTrailingStop(baselineTrades, bars, atrMult);
    const stats = calcStats(modifiedTrades, theo.longReturn, theo.shortReturn, 1_000_000);
    strategies.push({
      strategy: 'atr_trailing',
      params: { atrMult },
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      maxDrawdown: stats.maxDrawdown,
      calmar: computeCalmar(stats.totalPnl, stats.maxDrawdown, 1_000_000),
      profitFactor: stats.profitFactor,
      avgHoldDays: modifiedTrades.reduce((sum, t) => {
        if (!t.entryDate || !t.exitDate) return sum;
        const days = (new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime()) / (1000 * 60 * 60 * 24);
        return sum + days;
      }, 0) / modifiedTrades.length,
    });
  }
  
  // 策略3: 时间止损（不同天数）
  for (const maxDays of [10, 15, 20, 30]) {
    const modifiedTrades = applyTimeStop(baselineTrades, maxDays);
    const stats = calcStats(modifiedTrades, theo.longReturn, theo.shortReturn, 1_000_000);
    strategies.push({
      strategy: 'time_stop',
      params: { maxDays },
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
      totalPnl: stats.totalPnl,
      maxDrawdown: stats.maxDrawdown,
      calmar: computeCalmar(stats.totalPnl, stats.maxDrawdown, 1_000_000),
      profitFactor: stats.profitFactor,
      avgHoldDays: modifiedTrades.reduce((sum, t) => {
        if (!t.entryDate || !t.exitDate) return sum;
        const days = (new Date(t.exitDate).getTime() - new Date(t.entryDate).getTime()) / (1000 * 60 * 60 * 24);
        return sum + days;
      }, 0) / modifiedTrades.length,
    });
  }
  
  // 找最佳策略
  const allStrategies = [baseline, ...strategies];
  const best = allStrategies.reduce((a, b) => a.calmar > b.calmar ? a : b);
  
  return { variety, baseline, strategies, best };
}

async function main() {
  const results: Record<string, VarietyResult> = {};
  
  for (const variety of POOL_VARIETIES) {
    const result = await analyzeVariety(variety);
    if (result) {
      results[variety] = result;
      console.log(`${variety}: 基线 Calmar=${result.baseline.calmar.toFixed(2)}, 最佳=${result.best.calmar.toFixed(2)} (${result.best.strategy})`);
    }
  }
  
  const outputPath = path.join(OUT_DIR, 'dynamicStopLossAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已写入: ${outputPath}`);
}

main().catch(console.error);
