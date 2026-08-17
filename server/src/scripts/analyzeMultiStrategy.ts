/**
 * 多策略组合分析
 * 实现趋势跟踪、均值回归、突破三种策略的组合
 */

import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';
import { loadBars, runTop1Backtest, calcStats } from './runTop1FullBacktest.js';

const DATA_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../data');

// 计算 Calmar 比率
function computeCalmar(stats: any): number {
  if (!stats.maxDrawdown || stats.maxDrawdown === 0) return 0;
  return stats.totalPnl / (stats.maxDrawdown * 1000000);
}

interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

// 均值回归策略
function meanReversionStrategy(bars: Bar[], lookback: number = 20, zScoreThreshold: number = 2.0) {
  const trades: any[] = [];
  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryTime = '';

  for (let i = lookback; i < bars.length; i++) {
    const window = bars.slice(i - lookback, i);
    const mean = window.reduce((sum, b) => sum + b.c, 0) / lookback;
    const std = Math.sqrt(window.reduce((sum, b) => sum + (b.c - mean) ** 2, 0) / lookback);
    const zScore = (bars[i].c - mean) / std;

    // 入场信号
    if (position === null) {
      if (zScore < -zScoreThreshold) {
        // 超卖，做多
        position = 'long';
        entryPrice = bars[i].c;
        entryTime = bars[i].t;
      } else if (zScore > zScoreThreshold) {
        // 超买，做空
        position = 'short';
        entryPrice = bars[i].c;
        entryTime = bars[i].t;
      }
    }
    // 出场信号
    else if (position === 'long' && zScore > 0) {
      // 回归均值，平仓
      trades.push({
        entryTime,
        exitTime: bars[i].t,
        direction: 'long',
        entryPrice,
        exitPrice: bars[i].c,
        pnl: bars[i].c - entryPrice,
        pnlPct: (bars[i].c - entryPrice) / entryPrice,
        holdDays: Math.ceil((new Date(bars[i].t).getTime() - new Date(entryTime).getTime()) / (1000 * 60 * 60 * 24)),
      });
      position = null;
    } else if (position === 'short' && zScore < 0) {
      // 回归均值，平仓
      trades.push({
        entryTime,
        exitTime: bars[i].t,
        direction: 'short',
        entryPrice,
        exitPrice: bars[i].c,
        pnl: entryPrice - bars[i].c,
        pnlPct: (entryPrice - bars[i].c) / entryPrice,
        holdDays: Math.ceil((new Date(bars[i].t).getTime() - new Date(entryTime).getTime()) / (1000 * 60 * 60 * 24)),
      });
      position = null;
    }
  }

  return trades;
}

// 突破策略
function breakoutStrategy(bars: Bar[], lookback: number = 20, atrMult: number = 1.5) {
  const trades: any[] = [];
  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let entryTime = '';

  for (let i = lookback; i < bars.length; i++) {
    const window = bars.slice(i - lookback, i);
    const highestHigh = Math.max(...window.map(b => b.h));
    const lowestLow = Math.min(...window.map(b => b.l));
    const atr = window.reduce((sum, b, idx) => {
      if (idx === 0) return sum;
      const tr = Math.max(b.h - b.l, Math.abs(b.h - window[idx - 1].c), Math.abs(b.l - window[idx - 1].c));
      return sum + tr;
    }, 0) / lookback;

    // 入场信号
    if (position === null) {
      if (bars[i].c > highestHigh + atrMult * atr) {
        // 向上突破，做多
        position = 'long';
        entryPrice = bars[i].c;
        entryTime = bars[i].t;
      } else if (bars[i].c < lowestLow - atrMult * atr) {
        // 向下突破，做空
        position = 'short';
        entryPrice = bars[i].c;
        entryTime = bars[i].t;
      }
    }
    // 出场信号（反向突破）
    else if (position === 'long' && bars[i].c < lowestLow) {
      trades.push({
        entryTime,
        exitTime: bars[i].t,
        direction: 'long',
        entryPrice,
        exitPrice: bars[i].c,
        pnl: bars[i].c - entryPrice,
        pnlPct: (bars[i].c - entryPrice) / entryPrice,
        holdDays: Math.ceil((new Date(bars[i].t).getTime() - new Date(entryTime).getTime()) / (1000 * 60 * 60 * 24)),
      });
      position = null;
    } else if (position === 'short' && bars[i].c > highestHigh) {
      trades.push({
        entryTime,
        exitTime: bars[i].t,
        direction: 'short',
        entryPrice,
        exitPrice: bars[i].c,
        pnl: entryPrice - bars[i].c,
        pnlPct: (entryPrice - bars[i].c) / entryPrice,
        holdDays: Math.ceil((new Date(bars[i].t).getTime() - new Date(entryTime).getTime()) / (1000 * 60 * 60 * 24)),
      });
      position = null;
    }
  }

  return trades;
}

// 趋势跟踪策略（原有策略）
async function trendFollowingStrategy(variety: string) {
  const unified = TOP1_UNIFIED_PARAMS[variety];
  const bars = loadBars(variety);
  const result = await runTop1Backtest(variety, unified as any, bars, { longReturn: 0, shortReturn: 0 } as any);
  return result.trades;
}

async function analyzeMultiStrategy() {
  console.log('=== 多策略组合分析 ===\n');

  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, any> = {};

  for (const variety of varieties) {
    console.log(`分析 ${variety}...`);

    // 趋势跟踪策略
    const trendTrades = await trendFollowingStrategy(variety);
    const trendStats = calcStats(trendTrades, 0, 0, 1000000);

    // 均值回归策略
    const mrTrades = meanReversionStrategy(loadBars(variety));
    const mrStats = calcStats(mrTrades, 0, 0, 1000000);

    // 突破策略
    const boTrades = breakoutStrategy(loadBars(variety));
    const boStats = calcStats(boTrades, 0, 0, 1000000);

    // 组合策略（等权）
    const allTrades = [...trendTrades, ...mrTrades, ...boTrades];
    allTrades.sort((a, b) => new Date(a.entryTime).getTime() - new Date(b.entryTime).getTime());
    const combinedStats = calcStats(allTrades, 0, 0, 1000000);

    console.log(`  趋势跟踪: ${trendTrades.length} 笔, Calmar ${computeCalmar(trendStats).toFixed(2)}`);
    console.log(`  均值回归: ${mrTrades.length} 笔, Calmar ${computeCalmar(mrStats).toFixed(2)}`);
    console.log(`  突破策略: ${boTrades.length} 笔, Calmar ${computeCalmar(boStats).toFixed(2)}`);
    console.log(`  组合策略: ${allTrades.length} 笔, Calmar ${computeCalmar(combinedStats).toFixed(2)}`);

    results[variety] = {
      trendFollowing: {
        trades: trendTrades.length,
        totalPnl: trendStats.totalPnl,
        maxDrawdown: trendStats.maxDrawdown,
        calmar: computeCalmar(trendStats),
        winRate: trendStats.winRate,
      },
      meanReversion: {
        trades: mrTrades.length,
        totalPnl: mrStats.totalPnl,
        maxDrawdown: mrStats.maxDrawdown,
        calmar: computeCalmar(mrStats),
        winRate: mrStats.winRate,
      },
      breakout: {
        trades: boTrades.length,
        totalPnl: boStats.totalPnl,
        maxDrawdown: boStats.maxDrawdown,
        calmar: computeCalmar(boStats),
        winRate: boStats.winRate,
      },
      combined: {
        trades: allTrades.length,
        totalPnl: combinedStats.totalPnl,
        maxDrawdown: combinedStats.maxDrawdown,
        calmar: computeCalmar(combinedStats),
        winRate: combinedStats.winRate,
      },
    };
  }

  const outputPath = path.join(DATA_DIR, 'multiStrategyAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

analyzeMultiStrategy().catch(console.error);
