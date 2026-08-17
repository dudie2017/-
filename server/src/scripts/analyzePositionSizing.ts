/**
 * 方向2: 仓位管理优化分析
 * 
 * 对比三种仓位管理策略对入池品种(CF0/CU0/HC0)的影响：
 * 1. 等权（基线）：每个品种使用相同的 maxPositionPct
 * 2. 波动率倒数加权：波动率越高的品种仓位越小
 * 3. 凯利公式仓位：根据胜率和盈亏比计算最优仓位
 * 
 * 同时分析信号强度加权的效果
 */

import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';
import { runTop1Backtest, loadBars, calcStats } from './runTop1FullBacktest.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

// 计算 Calmar 比率
function computeCalmar(totalPnl: number, maxDrawdown: number, years: number = 3): number {
  if (maxDrawdown <= 0) return totalPnl > 0 ? 99 : 0;
  const annualReturn = (totalPnl / 1_000_000) / years;
  return annualReturn / maxDrawdown;
}

// 计算年化波动率
function computeAnnualVolatility(bars: { c: number }[]): number {
  const closes = bars.map(b => b.c);
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
  }
  if (returns.length === 0) return 0;
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + Math.pow(b - meanReturn, 2), 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  return dailyVol * Math.sqrt(252);
}

interface VarietyResult {
  variety: string;
  annualVol: number;
  baseline: {
    maxPositionPct: number;
    totalPnl: number;
    maxDrawdown: number;
    calmar: number;
    winRate: number;
    totalTrades: number;
    profitFactor: number;
  };
  invVolWeight: number;
  invVolResult: {
    maxPositionPct: number;
    totalPnl: number;
    maxDrawdown: number;
    calmar: number;
    winRate: number;
    totalTrades: number;
  };
  kellyResult: {
    kellyFraction: number;
    maxPositionPct: number;
    totalPnl: number;
    maxDrawdown: number;
    calmar: number;
    winRate: number;
    totalTrades: number;
  };
  signalWeightResult: {
    maxPositionPct: number;
    totalPnl: number;
    maxDrawdown: number;
    calmar: number;
    winRate: number;
    totalTrades: number;
  };
}

async function analyzePositionSizing() {
  console.log('=== 仓位管理优化分析 ===\n');

  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, VarietyResult> = {};
  const volatilities: Record<string, number> = {};

  // Step 1: 基线回测 + 计算波动率
  for (const variety of varieties) {
    console.log(`\n--- ${variety} 基线回测 ---`);

    const recipe = TOP1_UNIFIED_PARAMS[variety] as any;
    if (!recipe) {
      console.log(`  跳过：未找到参数`);
      continue;
    }

    const bars = loadBars(variety);
    if (bars.length === 0) {
      console.log(`  跳过：无数据`);
      continue;
    }

    const theo = {
      longReturn: recipe.directionMode === 'shortOnly' ? 0 : 1,
      shortReturn: recipe.directionMode === 'longOnly' ? 0 : 1,
    };

    // 基线回测
    const baselineResult = await runTop1Backtest(variety, recipe, bars, theo);
    const baselineStats = baselineResult.stats;
    const baselineCalmar = computeCalmar(baselineStats.totalPnl, baselineStats.maxDrawdown);
    const annualVol = computeAnnualVolatility(bars);

    volatilities[variety] = annualVol;

    console.log(`  基线: PnL=${Math.round(baselineStats.totalPnl).toLocaleString()}, 回撤=${(baselineStats.maxDrawdown * 100).toFixed(1)}%, Calmar=${baselineCalmar.toFixed(2)}, 波动率=${(annualVol * 100).toFixed(1)}%`);
    console.log(`  交易数=${baselineStats.totalTrades}, 胜率=${(baselineStats.winRate * 100).toFixed(1)}%, PF=${baselineStats.profitFactor.toFixed(2)}`);

    // Step 2: 波动率倒数加权回测
    // 波动率越低 → 权重越大 → 可以给更大仓位
    const avgVol = Object.values(volatilities).reduce((a, b) => a + b, 0) / Object.keys(volatilities).length;
    const volRatio = avgVol / Math.max(annualVol, 0.001);
    // 将波动率比映射到仓位调整：波动率低于平均的品种增大仓位，高于平均的减小
    const invVolMaxPosPct = Math.min(Math.max(recipe.maxPositionPct * volRatio, 0.02), 0.30);

    const invVolRecipe = { ...recipe, maxPositionPct: invVolMaxPosPct };
    const invVolResult = await runTop1Backtest(variety, invVolRecipe, bars, theo);
    const invVolStats = invVolResult.stats;
    const invVolCalmar = computeCalmar(invVolStats.totalPnl, invVolStats.maxDrawdown);

    console.log(`  波动率倒数加权: maxPos=${(invVolMaxPosPct * 100).toFixed(1)}%, PnL=${Math.round(invVolStats.totalPnl).toLocaleString()}, 回撤=${(invVolStats.maxDrawdown * 100).toFixed(1)}%, Calmar=${invVolCalmar.toFixed(2)}`);

    // Step 3: 凯利公式仓位
    // Kelly% = W - (1-W)/R, where W=winRate, R=avgWin/avgLoss
    const winRate = baselineStats.winRate;
    const profitFactor = baselineStats.profitFactor;
    // Kelly fraction = winRate - (1 - winRate) / profitFactor
    const kellyFraction = Math.max(winRate - (1 - winRate) / Math.max(profitFactor, 0.01), 0);
    // 使用半凯利（更保守）
    const halfKelly = kellyFraction / 2;
    const kellyMaxPosPct = Math.min(Math.max(halfKelly, 0.02), 0.25);

    const kellyRecipe = { ...recipe, maxPositionPct: kellyMaxPosPct };
    const kellyResult = await runTop1Backtest(variety, kellyRecipe, bars, theo);
    const kellyStats = kellyResult.stats;
    const kellyCalmar = computeCalmar(kellyStats.totalPnl, kellyStats.maxDrawdown);

    console.log(`  凯利公式: kelly=${(kellyFraction * 100).toFixed(1)}%, halfKelly maxPos=${(kellyMaxPosPct * 100).toFixed(1)}%, PnL=${Math.round(kellyStats.totalPnl).toLocaleString()}, 回撤=${(kellyStats.maxDrawdown * 100).toFixed(1)}%, Calmar=${kellyCalmar.toFixed(2)}`);

    // Step 4: 信号强度加权（根据 profitFactor 调整仓位）
    // PF 越高说明信号质量越好，可以给更大仓位
    const signalWeight = Math.min(Math.max(recipe.maxPositionPct * (profitFactor / 2), 0.02), 0.25);
    const signalRecipe = { ...recipe, maxPositionPct: signalWeight };
    const signalResult = await runTop1Backtest(variety, signalRecipe, bars, theo);
    const signalStats = signalResult.stats;
    const signalCalmar = computeCalmar(signalStats.totalPnl, signalStats.maxDrawdown);

    console.log(`  信号强度加权: maxPos=${(signalWeight * 100).toFixed(1)}%, PnL=${Math.round(signalStats.totalPnl).toLocaleString()}, 回撤=${(signalStats.maxDrawdown * 100).toFixed(1)}%, Calmar=${signalCalmar.toFixed(2)}`);

    results[variety] = {
      variety,
      annualVol,
      baseline: {
        maxPositionPct: recipe.maxPositionPct,
        totalPnl: baselineStats.totalPnl,
        maxDrawdown: baselineStats.maxDrawdown,
        calmar: baselineCalmar,
        winRate: baselineStats.winRate,
        totalTrades: baselineStats.totalTrades,
        profitFactor: baselineStats.profitFactor,
      },
      invVolWeight: volRatio,
      invVolResult: {
        maxPositionPct: invVolMaxPosPct,
        totalPnl: invVolStats.totalPnl,
        maxDrawdown: invVolStats.maxDrawdown,
        calmar: invVolCalmar,
        winRate: invVolStats.winRate,
        totalTrades: invVolStats.totalTrades,
      },
      kellyResult: {
        kellyFraction: kellyFraction,
        maxPositionPct: kellyMaxPosPct,
        totalPnl: kellyStats.totalPnl,
        maxDrawdown: kellyStats.maxDrawdown,
        calmar: kellyCalmar,
        winRate: kellyStats.winRate,
        totalTrades: kellyStats.totalTrades,
      },
      signalWeightResult: {
        maxPositionPct: signalWeight,
        totalPnl: signalStats.totalPnl,
        maxDrawdown: signalStats.maxDrawdown,
        calmar: signalCalmar,
        winRate: signalStats.winRate,
        totalTrades: signalStats.totalTrades,
      },
    };
  }

  // 组合层面分析
  console.log('\n\n=== 组合层面分析 ===');

  // 计算波动率倒数权重（归一化）
  const totalInvVol = Object.values(volatilities).reduce((sum, vol) => sum + 1 / Math.max(vol, 0.001), 0);
  const portfolioWeights: Record<string, number> = {};
  for (const v of varieties) {
    portfolioWeights[v] = (1 / Math.max(volatilities[v], 0.001)) / totalInvVol;
  }

  console.log('\n波动率倒数权重（归一化）:');
  for (const [v, w] of Object.entries(portfolioWeights)) {
    console.log(`  ${v}: ${(w * 100).toFixed(1)}%`);
  }

  // 等权组合 vs 波动率倒数加权组合
  const baselineCalmars = Object.values(results).map(r => r.baseline.calmar);
  const equalWeightAvgCalmar = baselineCalmars.reduce((a, b) => a + b, 0) / baselineCalmars.length;

  const invVolWeightedCalmar = Object.values(results).reduce((sum, r) => {
    return sum + r.invVolResult.calmar * portfolioWeights[r.variety];
  }, 0);

  const kellyWeightedCalmar = Object.values(results).reduce((sum, r) => {
    return sum + r.kellyResult.calmar * portfolioWeights[r.variety];
  }, 0);

  console.log(`\n组合 Calmar 对比:`);
  console.log(`  等权 + 原始仓位: ${equalWeightAvgCalmar.toFixed(2)}`);
  console.log(`  波动率倒数加权: ${invVolWeightedCalmar.toFixed(2)}`);
  console.log(`  凯利公式加权: ${kellyWeightedCalmar.toFixed(2)}`);

  // 确定每个品种的最佳策略
  console.log('\n=== 各品种最佳策略推荐 ===');
  for (const [variety, r] of Object.entries(results)) {
    const strategies = [
      { name: '原始(基线)', calmar: r.baseline.calmar, maxPos: r.baseline.maxPositionPct },
      { name: '波动率倒数加权', calmar: r.invVolResult.calmar, maxPos: r.invVolResult.maxPositionPct },
      { name: '凯利公式(半凯利)', calmar: r.kellyResult.calmar, maxPos: r.kellyResult.maxPositionPct },
      { name: '信号强度加权', calmar: r.signalWeightResult.calmar, maxPos: r.signalWeightResult.maxPositionPct },
    ];
    const best = strategies.reduce((a, b) => a.calmar > b.calmar ? a : b);
    console.log(`  ${variety}: 最佳=${best.name} (Calmar=${best.calmar.toFixed(2)}, maxPos=${(best.maxPos * 100).toFixed(1)}%)`);
  }

  // 保存结果
  const output = {
    timestamp: new Date().toISOString(),
    varieties: results,
    portfolioWeights,
    portfolioComparison: {
      equalWeightCalmar: equalWeightAvgCalmar,
      invVolWeightedCalmar,
      kellyWeightedCalmar,
    },
    recommendations: Object.fromEntries(
      Object.entries(results).map(([variety, r]) => {
        const strategies = [
          { name: 'baseline', calmar: r.baseline.calmar, maxPos: r.baseline.maxPositionPct },
          { name: 'invVolWeight', calmar: r.invVolResult.calmar, maxPos: r.invVolResult.maxPositionPct },
          { name: 'kelly', calmar: r.kellyResult.calmar, maxPos: r.kellyResult.maxPositionPct },
          { name: 'signalWeight', calmar: r.signalWeightResult.calmar, maxPos: r.signalWeightResult.maxPositionPct },
        ];
        const best = strategies.reduce((a, b) => a.calmar > b.calmar ? a : b);
        return [variety, best];
      })
    ),
  };

  const outputPath = join(DATA_DIR, 'positionSizingAnalysis.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存到: ${outputPath}`);

  return output;
}

analyzePositionSizing().catch(console.error);
