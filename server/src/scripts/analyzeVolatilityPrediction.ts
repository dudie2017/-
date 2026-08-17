/**
 * 波动率预测分析
 * 
 * 使用 EWMA (Exponentially Weighted Moving Average) 和 Historical Volatility
 * 预测未来波动率，并据此动态调整仓位。
 * 
 * 目标：在高波动时降低仓位，低波动时增加仓位，降低回撤。
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.ts';
import { loadBars, runTop1Backtest, calcStats } from './runTop1FullBacktest.ts';

const DATA_DIR = path.join(process.cwd(), 'src/data');

// 计算 Historical Volatility (HV)
function calcHV(closes: number[], window: number = 20): number[] {
  const hv: number[] = [];
  const returns: number[] = [];
  
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  
  for (let i = 0; i < closes.length; i++) {
    if (i < window) {
      hv.push(0);
    } else {
      const slice = returns.slice(i - window, i);
      const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
      const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
      hv.push(Math.sqrt(variance * 252)); // Annualized
    }
  }
  
  return hv;
}

// 计算 EWMA Volatility
function calcEWMAVol(closes: number[], lambda: number = 0.94): number[] {
  const vol: number[] = [];
  const returns: number[] = [];
  
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  
  let variance = returns[0] ** 2;
  vol.push(0);
  
  for (let i = 1; i < closes.length; i++) {
    variance = lambda * variance + (1 - lambda) * returns[i - 1] ** 2;
    vol.push(Math.sqrt(variance * 252)); // Annualized
  }
  
  return vol;
}

// 波动率分位数
function calcVolQuantiles(vol: number[]): { p25: number; p50: number; p75: number } {
  const sorted = [...vol].filter(v => v > 0).sort((a, b) => a - b);
  const n = sorted.length;
  return {
    p25: sorted[Math.floor(n * 0.25)] || 0,
    p50: sorted[Math.floor(n * 0.5)] || 0,
    p75: sorted[Math.floor(n * 0.75)] || 0,
  };
}

// 根据波动率调整仓位
function adjustPositionByVol(
  trades: any[],
  dates: string[],
  vol: number[],
  quantiles: { p25: number; p50: number; p75: number },
  mode: 'inverse' | 'threshold' | 'scaled'
): any[] {
  const dateIdx = new Map<string, number>();
  dates.forEach((d, i) => dateIdx.set(d, i));
  
  return trades.map(t => {
    const idx = dateIdx.get(t.entryDate);
    if (idx === undefined || vol[idx] === 0) return t;
    
    const currentVol = vol[idx];
    let multiplier = 1;
    
    if (mode === 'inverse') {
      // 波动率倒数加权
      const avgVol = quantiles.p50;
      multiplier = avgVol / currentVol;
      multiplier = Math.max(0.2, Math.min(2, multiplier)); // Clamp
    } else if (mode === 'threshold') {
      // 高波动时减仓
      if (currentVol > quantiles.p75) multiplier = 0.5;
      else if (currentVol < quantiles.p25) multiplier = 1.5;
    } else if (mode === 'scaled') {
      // 线性缩放
      const volRange = quantiles.p75 - quantiles.p25;
      if (volRange > 0) {
        const normalized = (currentVol - quantiles.p25) / volRange;
        multiplier = 1.5 - normalized; // 高波动时 multiplier 小
        multiplier = Math.max(0.3, Math.min(1.5, multiplier));
      }
    }
    
    return {
      ...t,
      pnl: t.pnl * multiplier,
      positionMultiplier: multiplier,
    };
  });
}

async function main() {
  console.log('=== 波动率预测分析 ===\n');
  
  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, any> = {};
  
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
    
    // 计算波动率
    const hv = calcHV(closes, 20);
    const ewmaVol = calcEWMAVol(closes, 0.94);
    
    const hvQuantiles = calcVolQuantiles(hv);
    const ewmaQuantiles = calcVolQuantiles(ewmaVol);
    
    console.log(`  HV 分位数: P25=${(hvQuantiles.p25 * 100).toFixed(1)}%, P50=${(hvQuantiles.p50 * 100).toFixed(1)}%, P75=${(hvQuantiles.p75 * 100).toFixed(1)}%`);
    console.log(`  EWMA 分位数: P25=${(ewmaQuantiles.p25 * 100).toFixed(1)}%, P50=${(ewmaQuantiles.p50 * 100).toFixed(1)}%, P75=${(ewmaQuantiles.p75 * 100).toFixed(1)}%`);
    
    // 基线回测
    const baselineResult = await runTop1Backtest(
      variety,
      recipe as any,
      bars,
      { longReturn: 0, shortReturn: 0 } as any
    );
    const baselineTrades = baselineResult.trades;
    const baselineStats = calcStats(baselineTrades, 0, 0, 1000000);
    const baselineCalmar = baselineStats.maxDrawdown > 0
      ? baselineStats.totalPnl / baselineStats.maxDrawdown
      : baselineStats.totalPnl > 0 ? 999 : 0;
    
    console.log(`  基线: Calmar=${baselineCalmar.toFixed(2)}, 回撤=${(baselineStats.maxDrawdown * 100).toFixed(1)}%`);
    
    // 测试不同波动率调整模式
    const modes: Array<{ name: string; mode: 'inverse' | 'threshold' | 'scaled'; volType: 'hv' | 'ewma' }> = [
      { name: 'HV-inverse', mode: 'inverse', volType: 'hv' },
      { name: 'HV-threshold', mode: 'threshold', volType: 'hv' },
      { name: 'HV-scaled', mode: 'scaled', volType: 'hv' },
      { name: 'EWMA-inverse', mode: 'inverse', volType: 'ewma' },
      { name: 'EWMA-threshold', mode: 'threshold', volType: 'ewma' },
      { name: 'EWMA-scaled', mode: 'scaled', volType: 'ewma' },
    ];
    
    const modeResults: any[] = [];
    
    for (const m of modes) {
      const vol = m.volType === 'hv' ? hv : ewmaVol;
      const quantiles = m.volType === 'hv' ? hvQuantiles : ewmaQuantiles;
      
      const adjustedTrades = adjustPositionByVol(baselineTrades, dates, vol, quantiles, m.mode);
      const stats = calcStats(adjustedTrades, 0, 0, 1000000);
      const calmar = stats.maxDrawdown > 0
        ? stats.totalPnl / stats.maxDrawdown
        : stats.totalPnl > 0 ? 999 : 0;
      
      modeResults.push({
        mode: m.name,
        calmar,
        totalPnl: stats.totalPnl,
        maxDrawdown: stats.maxDrawdown,
        winRate: stats.winRate,
        tradeCount: adjustedTrades.length,
      });
    }
    
    // 找最佳模式
    modeResults.sort((a, b) => b.calmar - a.calmar);
    const best = modeResults[0];
    
    console.log(`  最佳: ${best?.mode}, Calmar=${best?.calmar.toFixed(2)}, 回撤=${(best?.maxDrawdown * 100).toFixed(1)}%`);
    
    results[variety] = {
      baseline: {
        calmar: baselineCalmar,
        totalPnl: baselineStats.totalPnl,
        maxDrawdown: baselineStats.maxDrawdown,
        tradeCount: baselineTrades.length,
      },
      volStats: {
        hv: hvQuantiles,
        ewma: ewmaQuantiles,
      },
      best: best || null,
      improvement: best ? {
        calmarChangePct: ((best.calmar / baselineCalmar - 1) * 100),
        drawdownChangePct: ((best.maxDrawdown / baselineStats.maxDrawdown - 1) * 100),
      } : null,
      allModes: modeResults,
    };
  }
  
  // 保存结果
  const outputPath = path.join(DATA_DIR, 'volatilityPredictionAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
  
  // 打印汇总
  console.log('\n=== 汇总 ===');
  for (const [variety, result] of Object.entries(results)) {
    console.log(`\n${variety}:`);
    console.log(`  基线 Calmar: ${result.baseline.calmar.toFixed(2)}, 回撤: ${(result.baseline.maxDrawdown * 100).toFixed(1)}%`);
    if (result.best) {
      console.log(`  最佳: ${result.best.mode}`);
      console.log(`  最佳 Calmar: ${result.best.calmar.toFixed(2)}, 回撤: ${(result.best.maxDrawdown * 100).toFixed(1)}%`);
      console.log(`  Calmar 改进: ${result.improvement.calmarChangePct.toFixed(1)}%`);
      console.log(`  回撤改进: ${result.improvement.drawdownChangePct.toFixed(1)}%`);
    }
  }
}

main().catch(console.error);
