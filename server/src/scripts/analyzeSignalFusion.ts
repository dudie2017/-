/**
 * 信号融合分析
 * 
 * 将多个技术指标信号（MA/RSI/MACD）进行加权融合，
 * 测试不同权重组合对策略表现的影响。
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';
import { loadBars, runTop1Backtest, calcStats } from './runTop1FullBacktest.js';

const DATA_DIR = path.join(process.cwd(), 'src/data');

// 计算 RSI
function calcRSI(closes: number[], period: number = 14): number[] {
  const rsi: number[] = [];
  let gains = 0, losses = 0;
  
  for (let i = 0; i < closes.length; i++) {
    if (i === 0) {
      rsi.push(50);
      continue;
    }
    const change = closes[i] - closes[i - 1];
    if (i <= period) {
      if (change > 0) gains += change;
      else losses -= change;
      if (i === period) {
        gains /= period;
        losses /= period;
        const rs = losses === 0 ? 100 : gains / losses;
        rsi.push(100 - 100 / (1 + rs));
      } else {
        rsi.push(50);
      }
    } else {
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      gains = (gains * (period - 1) + gain) / period;
      losses = (losses * (period - 1) + loss) / period;
      const rs = losses === 0 ? 100 : gains / losses;
      rsi.push(100 - 100 / (1 + rs));
    }
  }
  return rsi;
}

// 计算 MACD
function calcMACD(closes: number[], fast: number = 12, slow: number = 26, signal: number = 9): { macd: number[]; signal: number[]; histogram: number[] } {
  const ema = (data: number[], period: number) => {
    const k = 2 / (period + 1);
    const result = [data[0]];
    for (let i = 1; i < data.length; i++) {
      result.push(data[i] * k + result[i - 1] * (1 - k));
    }
    return result;
  };
  
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macd = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macd, signal);
  const histogram = macd.map((v, i) => v - signalLine[i]);
  
  return { macd, signal: signalLine, histogram };
}

// 计算 MA
function calcMA(closes: number[], period: number): number[] {
  const ma: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      ma.push(closes[i]);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += closes[j];
      ma.push(sum / period);
    }
  }
  return ma;
}

// 生成融合信号
function generateFusedSignal(
  closes: number[],
  weights: { ma: number; rsi: number; macd: number },
  maPeriod: number = 20,
  rsiPeriod: number = 14,
  rsiOverbought: number = 70,
  rsiOversold: number = 30
): number[] {
  const ma = calcMA(closes, maPeriod);
  const rsi = calcRSI(closes, rsiPeriod);
  const { histogram } = calcMACD(closes);
  
  const signals: number[] = [];
  
  for (let i = 0; i < closes.length; i++) {
    let score = 0;
    
    // MA 信号：价格在 MA 上方为多，下方为空
    const maSignal = closes[i] > ma[i] ? 1 : closes[i] < ma[i] ? -1 : 0;
    score += weights.ma * maSignal;
    
    // RSI 信号：超买为空，超卖为多
    const rsiSignal = rsi[i] > rsiOverbought ? -1 : rsi[i] < rsiOversold ? 1 : 0;
    score += weights.rsi * rsiSignal;
    
    // MACD 信号：柱状图正为多，负为空
    const macdSignal = histogram[i] > 0 ? 1 : histogram[i] < 0 ? -1 : 0;
    score += weights.macd * macdSignal;
    
    signals.push(score);
  }
  
  return signals;
}

// 根据信号过滤交易
function filterTradesBySignal(
  trades: any[],
  signals: number[],
  dates: string[],
  threshold: number = 0.3
): any[] {
  const dateIdx = new Map<string, number>();
  dates.forEach((d, i) => dateIdx.set(d, i));
  
  return trades.filter(t => {
    const idx = dateIdx.get(t.entryDate);
    if (idx === undefined) return true;
    const signal = signals[idx];
    
    // 如果信号方向与交易方向一致，保留
    if (t.direction === 'LONG' && signal > threshold) return true;
    if (t.direction === 'SHORT' && signal < -threshold) return true;
    
    return false;
  });
}

async function main() {
  console.log('=== 信号融合分析 ===\n');
  
  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, any> = {};
  
  // 测试不同的权重组合
  const weightConfigs = [
    { name: 'MA only', weights: { ma: 1, rsi: 0, macd: 0 } },
    { name: 'RSI only', weights: { ma: 0, rsi: 1, macd: 0 } },
    { name: 'MACD only', weights: { ma: 0, rsi: 0, macd: 1 } },
    { name: 'MA+RSI', weights: { ma: 0.5, rsi: 0.5, macd: 0 } },
    { name: 'MA+MACD', weights: { ma: 0.5, rsi: 0, macd: 0.5 } },
    { name: 'RSI+MACD', weights: { ma: 0, rsi: 0.5, macd: 0.5 } },
    { name: 'Equal', weights: { ma: 0.33, rsi: 0.33, macd: 0.34 } },
    { name: 'MA-heavy', weights: { ma: 0.6, rsi: 0.2, macd: 0.2 } },
    { name: 'RSI-heavy', weights: { ma: 0.2, rsi: 0.6, macd: 0.2 } },
    { name: 'MACD-heavy', weights: { ma: 0.2, rsi: 0.2, macd: 0.6 } },
  ];
  
  for (const variety of varieties) {
    console.log(`\n分析 ${variety}...`);
    
    const recipe = TOP1_UNIFIED_PARAMS[variety];
    if (!recipe) {
      console.log(`  跳过：无统一参数`);
      continue;
    }
    
    const bars = loadBars(variety);
    const closes = bars.map(b => b.c);
    const dates = bars.map(b => b.date);
    
    // 基线回测
    const baselineResult = await runTop1Backtest(
      variety,
      recipe as any,
      bars,
      { longReturn: 0, shortReturn: 0 } as any
    );
    const baselineTrades = baselineResult.trades;
    const baselineStats = calcStats(baselineTrades);
    const baselineCalmar = baselineStats.maxDrawdown > 0
      ? baselineStats.totalPnl / baselineStats.maxDrawdown
      : baselineStats.totalPnl > 0 ? 999 : 0;
    
    console.log(`  基线: Calmar=${baselineCalmar.toFixed(2)}, 交易数=${baselineTrades.length}`);
    
    // 测试不同权重组合
    const fusionResults: any[] = [];
    
    for (const config of weightConfigs) {
      const signals = generateFusedSignal(closes, config.weights);
      
      // 测试不同阈值
      for (const threshold of [0.1, 0.3, 0.5]) {
        const filteredTrades = filterTradesBySignal(baselineTrades, signals, dates, threshold);
        
        if (filteredTrades.length === 0) continue;
        
        const stats = calcStats(filteredTrades);
        const calmar = stats.maxDrawdown > 0
          ? stats.totalPnl / stats.maxDrawdown
          : stats.totalPnl > 0 ? 999 : 0;
        
        fusionResults.push({
          config: config.name,
          weights: config.weights,
          threshold,
          calmar,
          totalPnl: stats.totalPnl,
          maxDrawdown: stats.maxDrawdown,
          tradeCount: filteredTrades.length,
          winRate: stats.winRate,
        });
      }
    }
    
    // 找最佳配置
    fusionResults.sort((a, b) => b.calmar - a.calmar);
    const best = fusionResults[0];
    
    console.log(`  最佳: ${best?.config} (threshold=${best?.threshold}), Calmar=${best?.calmar.toFixed(2)}`);
    
    results[variety] = {
      baseline: {
        calmar: baselineCalmar,
        totalPnl: baselineStats.totalPnl,
        maxDrawdown: baselineStats.maxDrawdown,
        tradeCount: baselineTrades.length,
        winRate: baselineStats.winRate,
      },
      best: best || null,
      improvement: best ? {
        calmarChangePct: ((best.calmar / baselineCalmar - 1) * 100),
        tradeCountChange: best.tradeCount - baselineTrades.length,
      } : null,
      allResults: fusionResults.slice(0, 10), // 保留前10个
    };
  }
  
  // 保存结果
  const outputPath = path.join(DATA_DIR, 'signalFusionAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
  
  // 打印汇总
  console.log('\n=== 汇总 ===');
  for (const [variety, result] of Object.entries(results)) {
    console.log(`\n${variety}:`);
    console.log(`  基线 Calmar: ${result.baseline.calmar.toFixed(2)}`);
    if (result.best) {
      console.log(`  最佳: ${result.best.config} (threshold=${result.best.threshold})`);
      console.log(`  最佳 Calmar: ${result.best.calmar.toFixed(2)}`);
      console.log(`  改进: ${result.improvement.calmarChangePct.toFixed(1)}%`);
    }
  }
}

main().catch(console.error);
