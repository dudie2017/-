/**
 * 止损止盈参数网格搜索
 * 
 * 对入池 3 个品种（CF0, CU0, HC0），测试不同的止损止盈参数组合：
 * - stopAtrMult: [1.0, 1.5, 2.0, 2.5, 3.0]
 * - targetAtrMult: [2.0, 3.0, 4.0, 5.0, 6.0]
 * - minRR: [1.0, 1.5, 2.0, 2.5]
 * 
 * 组合总数：5 × 5 × 4 = 100 种
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import { loadBars, runTop1Backtest, calcStats, type Bar, type TradeLike } from './runTop1FullBacktest.js';

const DATA_DIR = path.resolve('src/data');
const OUT_DIR = path.resolve('src/data');

// 入池品种
const POOL_VARIETIES = ['CF0', 'CU0', 'HC0'];

// 参数网格
const STOP_ATR_MULTS = [1.0, 1.5, 2.0, 2.5, 3.0];
const TARGET_ATR_MULTS = [2.0, 3.0, 4.0, 5.0, 6.0];
const MIN_RRS = [1.0, 1.5, 2.0, 2.5];

interface GridResult {
  stopAtrMult: number;
  targetAtrMult: number;
  minRR: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  profitFactor: number;
  avgRR: number;
}

interface VarietyResult {
  variety: string;
  baseline: {
    stopAtrMult: number;
    targetAtrMult: number;
    minRR: number;
    calmar: number;
    maxDrawdown: number;
    totalPnl: number;
    winRate: number;
  };
  optimal: GridResult;
  top5: GridResult[];
  allResults: GridResult[];
  improvement: {
    calmarChange: number;
    calmarChangePct: number;
    drawdownChange: number;
    drawdownChangePct: number;
  };
}

function computeCalmar(totalPnl: number, maxDrawdown: number, capital: number): number {
  if (maxDrawdown <= 0) return totalPnl > 0 ? 99 : 0;
  const annualReturn = totalPnl / capital;
  return annualReturn / maxDrawdown;
}

async function runGridSearch(
  variety: string,
  bars: Bar[],
  baseRecipe: any,
  theo: any
): Promise<GridResult[]> {
  const results: GridResult[] = [];
  const capital = 1_000_000;
  
  for (const stopAtrMult of STOP_ATR_MULTS) {
    for (const targetAtrMult of TARGET_ATR_MULTS) {
      for (const minRR of MIN_RRS) {
        // 跳过无效组合（target 必须 > stop）
        if (targetAtrMult <= stopAtrMult) continue;
        
        // 修改 recipe 参数
        const recipe = {
          ...baseRecipe,
          stopAtrMult,
          targetAtrMult,
          minRR,
        };
        
        // 运行回测
        const result = await runTop1Backtest(variety, recipe, bars, theo);
        const trades = result.trades;
        
        if (trades.length === 0) {
          results.push({
            stopAtrMult,
            targetAtrMult,
            minRR,
            totalTrades: 0,
            winRate: 0,
            totalPnl: 0,
            maxDrawdown: 0,
            calmar: 0,
            profitFactor: 0,
            avgRR: 0,
          });
          continue;
        }
        
        // 计算统计
        const stats = calcStats(trades, theo.longReturn, theo.shortReturn, capital);
        const calmar = computeCalmar(stats.totalPnl, stats.maxDrawdown, capital);
        
        results.push({
          stopAtrMult,
          targetAtrMult,
          minRR,
          totalTrades: stats.totalTrades,
          winRate: stats.winRate,
          totalPnl: stats.totalPnl,
          maxDrawdown: stats.maxDrawdown,
          calmar,
          profitFactor: stats.profitFactor,
          avgRR: stats.avgRR,
        });
      }
    }
  }
  
  return results;
}

async function main() {
  const results: Record<string, VarietyResult> = {};
  
  for (const variety of POOL_VARIETIES) {
    const recipe = TOP1_UNIFIED_PARAMS[variety];
    if (!recipe) continue;
    
    // 构造 theo 对象（runTop1Backtest 需要）
    const theo = {
      longReturn: recipe.directionMode === 'shortOnly' ? 0 : 1,
      shortReturn: recipe.directionMode === 'longOnly' ? 0 : 1,
    };
    
    const bars = loadBars(variety);
    if (bars.length === 0) continue;
    
    // 基线参数
    const baselineRecipe = { ...recipe };
    const baselineResult = await runTop1Backtest(variety, baselineRecipe, bars, theo);
    const baselineTrades = baselineResult.trades;
    const baselineStats = calcStats(baselineTrades, theo.longReturn, theo.shortReturn, 1_000_000);
    const baselineCalmar = computeCalmar(baselineStats.totalPnl, baselineStats.maxDrawdown, 1_000_000);
    
    // 网格搜索
    const gridResults = await runGridSearch(variety, bars, recipe, theo);
    
    // 按 Calmar 排序
    const sorted = [...gridResults].sort((a, b) => b.calmar - a.calmar);
    const optimal = sorted[0];
    const top5 = sorted.slice(0, 5);
    
    const calmarChange = optimal.calmar - baselineCalmar;
    const calmarChangePct = baselineCalmar !== 0 ? (calmarChange / Math.abs(baselineCalmar)) * 100 : 0;
    const drawdownChange = optimal.maxDrawdown - baselineStats.maxDrawdown;
    const drawdownChangePct = baselineStats.maxDrawdown !== 0 
      ? (drawdownChange / baselineStats.maxDrawdown) * 100 
      : 0;
    
    results[variety] = {
      variety,
      baseline: {
        stopAtrMult: recipe.stopAtrMult,
        targetAtrMult: recipe.targetAtrMult,
        minRR: recipe.minRR,
        calmar: baselineCalmar,
        maxDrawdown: baselineStats.maxDrawdown,
        totalPnl: baselineStats.totalPnl,
        winRate: baselineStats.winRate,
      },
      optimal,
      top5,
      allResults: gridResults,
      improvement: {
        calmarChange,
        calmarChangePct,
        drawdownChange,
        drawdownChangePct,
      },
    };
  }
  
  // 输出结果
  const outputPath = path.join(OUT_DIR, 'stopLossOptimization.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  
  // 打印摘要
  for (const [variety, result] of Object.entries(results)) {
    console.log(`${variety}: Calmar ${result.baseline.calmar.toFixed(2)} -> ${result.optimal.calmar.toFixed(2)} (${result.improvement.calmarChangePct.toFixed(1)}%)`);
  }
}

main().catch(console.error);
