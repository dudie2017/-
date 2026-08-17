/**
 * 分批止盈策略分析
 * 
 * 实现分批止盈逻辑：
 * - 达到 1R 盈利时，平仓 50%，止损移至成本价
 * - 达到 2R 盈利时，再平仓 25%
 * - 剩余 25% 持有至原目标
 * 
 * 对比固定止盈 vs 分批止盈的效果
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import { loadBars, runTop1Backtest, calcStats, type Bar, type TradeLike } from './runTop1FullBacktest';

const OUT_DIR = path.resolve('src/data');
const POOL_VARIETIES = ['CF0', 'CU0', 'HC0'];

interface BatchTakeProfitResult {
  strategy: string;
  params: Record<string, number>;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  profitFactor: number;
  avgHoldDays: number;
  avgPnlPerTrade: number;
}

interface VarietyResult {
  variety: string;
  baseline: BatchTakeProfitResult;
  strategies: BatchTakeProfitResult[];
  best: BatchTakeProfitResult;
  improvement: { calmarChangePct: number; drawdownChangePct: number };
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

// 应用分批止盈
function applyBatchTakeProfit(
  trades: TradeLike[],
  bars: Bar[],
  firstTargetR: number = 1.0,
  firstClosePct: number = 0.5,
  secondTargetR: number = 2.0,
  secondClosePct: number = 0.25
): TradeLike[] {
  const atr = computeATR(bars);
  const dateIdx = new Map<string, number>();
  bars.forEach((b, i) => dateIdx.set(b.date, i));
  
  const newTrades: TradeLike[] = [];
  
  for (const t of trades) {
    const entryIdx = dateIdx.get(t.entryDate);
    const exitIdx = dateIdx.get(t.exitDate);
    if (entryIdx === undefined || exitIdx === undefined) {
      newTrades.push(t);
      continue;
    }
    
    const risk = Math.abs(t.entryPrice - t.stopPrice);
    if (risk <= 0) {
      newTrades.push(t);
      continue;
    }
    
    const positionSize = t.positionSize || 1;
    let remainingSize = positionSize;
    let firstClosed = false;
    let secondClosed = false;
    let totalPnl = 0;
    let lastExitDate = t.entryDate;
    let lastExitPrice = t.entryPrice;
    
    if (t.direction === 'long') {
      for (let i = entryIdx; i <= exitIdx; i++) {
        const profitR = (bars[i].h - t.entryPrice) / risk;
        
        // 第一目标：平仓 firstClosePct
        if (!firstClosed && profitR >= firstTargetR) {
          const closeSize = positionSize * firstClosePct;
          const closePrice = t.entryPrice + firstTargetR * risk;
          totalPnl += (closePrice - t.entryPrice) * closeSize;
          remainingSize -= closeSize;
          firstClosed = true;
          lastExitDate = bars[i].date;
          lastExitPrice = closePrice;
        }
        
        // 第二目标：平仓 secondClosePct
        if (firstClosed && !secondClosed && profitR >= secondTargetR) {
          const closeSize = positionSize * secondClosePct;
          const closePrice = t.entryPrice + secondTargetR * risk;
          totalPnl += (closePrice - t.entryPrice) * closeSize;
          remainingSize -= closeSize;
          secondClosed = true;
          lastExitDate = bars[i].date;
          lastExitPrice = closePrice;
        }
      }
      
      // 剩余仓位按原止盈/止损退出
      if (remainingSize > 0) {
        totalPnl += t.pnl * (remainingSize / positionSize);
        lastExitDate = t.exitDate;
        lastExitPrice = t.exitPrice;
      }
    } else {
      // 空头
      for (let i = entryIdx; i <= exitIdx; i++) {
        const profitR = (t.entryPrice - bars[i].l) / risk;
        
        if (!firstClosed && profitR >= firstTargetR) {
          const closeSize = positionSize * firstClosePct;
          const closePrice = t.entryPrice - firstTargetR * risk;
          totalPnl += (t.entryPrice - closePrice) * closeSize;
          remainingSize -= closeSize;
          firstClosed = true;
          lastExitDate = bars[i].date;
          lastExitPrice = closePrice;
        }
        
        if (firstClosed && !secondClosed && profitR >= secondTargetR) {
          const closeSize = positionSize * secondClosePct;
          const closePrice = t.entryPrice - secondTargetR * risk;
          totalPnl += (t.entryPrice - closePrice) * closeSize;
          remainingSize -= closeSize;
          secondClosed = true;
          lastExitDate = bars[i].date;
          lastExitPrice = closePrice;
        }
      }
      
      if (remainingSize > 0) {
        totalPnl += t.pnl * (remainingSize / positionSize);
        lastExitDate = t.exitDate;
        lastExitPrice = t.exitPrice;
      }
    }
    
    // 创建分批止盈后的交易记录
    newTrades.push({
      ...t,
      pnl: totalPnl,
      exitDate: lastExitDate,
      exitPrice: lastExitPrice,
      result: totalPnl > 0 ? 'win' : totalPnl < 0 ? 'loss' : 'breakeven',
    });
  }
  
  return newTrades;
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
  
  const baseline: BatchTakeProfitResult = {
    strategy: 'fixed',
    params: { targetAtrMult: recipe.targetAtrMult },
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
    avgPnlPerTrade: baselineStats.totalPnl / baselineStats.totalTrades,
  };
  
  const strategies: BatchTakeProfitResult[] = [];
  
  // 分批止盈参数组合
  const paramCombinations = [
    { firstTargetR: 1.0, firstClosePct: 0.5, secondTargetR: 2.0, secondClosePct: 0.25 },
    { firstTargetR: 1.0, firstClosePct: 0.33, secondTargetR: 2.0, secondClosePct: 0.33 },
    { firstTargetR: 1.5, firstClosePct: 0.5, secondTargetR: 3.0, secondClosePct: 0.25 },
    { firstTargetR: 0.5, firstClosePct: 0.5, secondTargetR: 1.5, secondClosePct: 0.25 },
    { firstTargetR: 1.0, firstClosePct: 0.25, secondTargetR: 2.0, secondClosePct: 0.25 },
  ];
  
  for (const params of paramCombinations) {
    const modifiedTrades = applyBatchTakeProfit(
      baselineTrades, bars,
      params.firstTargetR, params.firstClosePct,
      params.secondTargetR, params.secondClosePct
    );
    const stats = calcStats(modifiedTrades, theo.longReturn, theo.shortReturn, 1_000_000);
    strategies.push({
      strategy: 'batch_take_profit',
      params,
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
      avgPnlPerTrade: stats.totalPnl / stats.totalTrades,
    });
  }
  
  // 找最佳策略
  const allStrategies = [baseline, ...strategies];
  const best = allStrategies.reduce((a, b) => a.calmar > b.calmar ? a : b);
  
  return {
    variety,
    baseline,
    strategies,
    best,
    improvement: {
      calmarChangePct: (best.calmar / baseline.calmar - 1) * 100,
      drawdownChangePct: (best.maxDrawdown / baseline.maxDrawdown - 1) * 100,
    },
  };
}

async function main() {
  const results: Record<string, VarietyResult> = {};
  
  for (const variety of POOL_VARIETIES) {
    const result = await analyzeVariety(variety);
    if (result) {
      results[variety] = result;
      console.log(`${variety}: 基线 Calmar=${result.baseline.calmar.toFixed(2)}, 最佳=${result.best.calmar.toFixed(2)} (${result.best.strategy}), 改进=${result.improvement.calmarChangePct.toFixed(1)}%`);
    }
  }
  
  const outputPath = path.join(OUT_DIR, 'batchTakeProfitAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已写入: ${outputPath}`);
}

main().catch(console.error);
