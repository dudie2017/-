/**
 * 导入回测结果到JSON文件
 */

import { storeBacktestResults, calculateVarietyGrades } from '../services/backtestAnalysis.js';
import { loadAllLocalData, getAllTimeframeData } from '../services/localDataLoader.js';
import { calcEMA, calcATR, calcADXSeries } from '../services/indicators.js';
import type { BarData } from '../services/varieties.js';

function runBacktest(bars: BarData[]): {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
} {
  if (bars.length < 50) {
    return { totalTrades: 0, winRate: 0, profitFactor: 0, totalReturn: 0, maxDrawdown: 0, avgWin: 0, avgLoss: 0 };
  }

  const closes = bars.map(b => b.c);
  
  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  const atr = calcATR(bars, 14);
  const adxValues = calcADXSeries(bars, 14);

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let stopLoss = 0;
  let capital = 100000;
  let maxCapital = 100000;
  let maxDrawdown = 0;
  const trades: { pnl: number; returnPct: number }[] = [];

  for (let i = 21; i < bars.length; i++) {
    const bar = bars[i];
    const adx = adxValues[i];
    
    // 检查EMA交叉信号
    const emaCrossUp = ema5[i] > ema20[i] && ema5[i-1] <= ema20[i-1];
    const emaCrossDown = ema5[i] < ema20[i] && ema5[i-1] >= ema20[i-1];

    if (position === null) {
      // 开仓条件：EMA交叉 + ADX > 20
      if (emaCrossUp && adx > 20) {
        position = 'long';
        entryPrice = bar.c;
        stopLoss = entryPrice - atr[i] * 2;
      } else if (emaCrossDown && adx > 20) {
        position = 'short';
        entryPrice = bar.c;
        stopLoss = entryPrice + atr[i] * 2;
      }
    } else if (position === 'long') {
      // 更新移动止损
      stopLoss = Math.max(stopLoss, bar.c - atr[i] * 2);
      
      // 平仓条件：止损或EMA死叉
      if (bar.l <= stopLoss || emaCrossDown) {
        const exitPrice = Math.max(bar.l, stopLoss);
        const pnl = exitPrice - entryPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct });
        capital *= (1 + returnPct);
        position = null;
      }
    } else if (position === 'short') {
      // 更新移动止损
      stopLoss = Math.min(stopLoss, bar.c + atr[i] * 2);
      
      // 平仓条件：止损或EMA金叉
      if (bar.h >= stopLoss || emaCrossUp) {
        const exitPrice = Math.min(bar.h, stopLoss);
        const pnl = entryPrice - exitPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct });
        capital *= (1 + returnPct);
        position = null;
      }
    }
    
    maxCapital = Math.max(maxCapital, capital);
    const drawdown = (maxCapital - capital) / maxCapital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  if (trades.length === 0) {
    return { totalTrades: 0, winRate: 0, profitFactor: 0, totalReturn: 0, maxDrawdown: 0, avgWin: 0, avgLoss: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const winRate = (wins.length / trades.length) * 100;
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0;
  const totalReturn = ((capital - 100000) / 100000) * 100;
  const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;

  return { totalTrades: trades.length, winRate, profitFactor, totalReturn, maxDrawdown: maxDrawdown * 100, avgWin, avgLoss };
}

async function main() {
  console.log('开始导入回测结果...\n');
  
  const varieties = loadAllLocalData();
  console.log('加载了 ' + varieties.length + ' 个品种\n');
  
  const timeframes = ['1分钟', '5分钟', '15分钟', '30分钟', '60分钟', '日线'] as const;
  const results: Array<{
    code: string;
    name: string;
    exchange: string;
    timeframe: string;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalReturn: number;
    maxDrawdown: number;
    avgWin: number;
    avgLoss: number;
  }> = [];
  
  for (const variety of varieties) {
    console.log('处理 ' + variety.code + ' ' + variety.name + '...');
    
    const allData = getAllTimeframeData(variety.bars);
    
    for (const tf of timeframes) {
      const bars = allData[tf];
      if (!bars || bars.length < 50) continue;
      
      const result = runBacktest(bars);
      
      if (result.totalTrades > 0) {
        results.push({
          code: variety.code,
          name: variety.name,
          exchange: variety.exchange,
          timeframe: tf,
          totalTrades: result.totalTrades,
          winRate: result.winRate,
          profitFactor: result.profitFactor,
          totalReturn: result.totalReturn,
          maxDrawdown: result.maxDrawdown,
          avgWin: result.avgWin,
          avgLoss: result.avgLoss
        });
      }
    }
  }
  
  console.log('\n共 ' + results.length + ' 条回测结果');
  console.log('正在存储到JSON文件...');
  
  storeBacktestResults(results);
  console.log('回测结果已存储');
  
  console.log('\n正在计算品种分级...');
  const grades = calculateVarietyGrades();
  console.log('品种分级完成，共 ' + grades.length + ' 个品种');
  
  const sCount = grades.filter(g => g.grade === 'S').length;
  const aCount = grades.filter(g => g.grade === 'A').length;
  const bCount = grades.filter(g => g.grade === 'B').length;
  const cCount = grades.filter(g => g.grade === 'C').length;
  
  console.log('\n品种分级统计:');
  console.log('  S级: ' + sCount + ' 个');
  console.log('  A级: ' + aCount + ' 个');
  console.log('  B级: ' + bCount + ' 个');
  console.log('  C级: ' + cCount + ' 个');
  
  console.log('\nS级品种:');
  grades.filter(g => g.grade === 'S').forEach(g => {
    console.log('  ' + g.code + ' ' + g.name + ' - 最佳周期: ' + g.bestTimeframe + ', 盈亏比: ' + g.bestProfitFactor.toFixed(2));
  });
  
  console.log('\nA级品种:');
  grades.filter(g => g.grade === 'A').forEach(g => {
    console.log('  ' + g.code + ' ' + g.name + ' - 最佳周期: ' + g.bestTimeframe + ', 盈亏比: ' + g.bestProfitFactor.toFixed(2));
  });
}

main().catch(console.error);
