/**
 * 动态再平衡分析
 * 
 * 测试不同再平衡频率对组合表现的影响：
 * - 静态（买入持有）
 * - 月度再平衡
 * - 季度再平衡
 * - 半年度再平衡
 * - 年度再平衡
 * 
 * 使用风险平价权重作为基础权重
 */

import * as fs from 'fs';
import * as path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.ts';
import { loadBars, runTop1Backtest, calcStats } from './runTop1FullBacktest.ts';

const DATA_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../data');
const VARIETIES = ['CF0', 'CU0', 'HC0']; // 三重筛选通过的品种

interface MonthlyPnl {
  month: string; // YYYY-MM
  pnl: number;
}

interface RebalanceResult {
  frequency: string;
  rebalanceCount: number;
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  sharpe: number;
  winRate: number;
  monthlyPnls: MonthlyPnl[];
}

// 聚合月度PnL
function aggregateMonthlyPnl(trades: any[]): MonthlyPnl[] {
  const monthlyMap = new Map<string, number>();
  
  for (const trade of trades) {
    const month = trade.exitDate.substring(0, 7); // YYYY-MM
    const current = monthlyMap.get(month) || 0;
    monthlyMap.set(month, current + trade.pnl);
  }
  
  return Array.from(monthlyMap.entries())
    .map(([month, pnl]) => ({ month, pnl }))
    .sort((a, b) => a.month.localeCompare(b.month));
}

// 计算组合月度PnL（按权重加权）
function computePortfolioMonthlyPnl(
  varietyMonthlyPnls: Map<string, MonthlyPnl[]>,
  weights: Map<string, number>
): MonthlyPnl[] {
  const allMonths = new Set<string>();
  for (const pnls of varietyMonthlyPnls.values()) {
    for (const p of pnls) {
      allMonths.add(p.month);
    }
  }
  
  const sortedMonths = Array.from(allMonths).sort();
  const portfolioPnls: MonthlyPnl[] = [];
  
  for (const month of sortedMonths) {
    let totalPnl = 0;
    for (const [variety, weight] of weights.entries()) {
      const varietyPnls = varietyMonthlyPnls.get(variety) || [];
      const monthPnl = varietyPnls.find(p => p.month === month);
      if (monthPnl) {
        totalPnl += monthPnl.pnl * weight;
      }
    }
    portfolioPnls.push({ month, pnl: totalPnl });
  }
  
  return portfolioPnls;
}

// 计算组合统计
function computePortfolioStats(monthlyPnls: MonthlyPnl[]): {
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  sharpe: number;
  winRate: number;
} {
  let equity = 1000000; // 初始资金100万
  let peak = equity;
  let maxDd = 0;
  
  for (const p of monthlyPnls) {
    equity += p.pnl;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }
  
  const totalPnl = equity - 1000000;
  const calmar = maxDd > 0 ? totalPnl / maxDd : totalPnl > 0 ? 999 : 0;
  
  // 计算夏普比率（年化）
  const returns = monthlyPnls.map(p => p.pnl / 1000000);
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length);
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(12) : 0;
  
  const winRate = monthlyPnls.filter(p => p.pnl > 0).length / monthlyPnls.length;
  
  return { totalPnl, maxDrawdown: maxDd, calmar, sharpe, winRate };
}

// 模拟再平衡
function simulateRebalancing(
  varietyMonthlyPnls: Map<string, MonthlyPnl[]>,
  baseWeights: Map<string, number>,
  frequency: 'static' | 'monthly' | 'quarterly' | 'semi-annual' | 'annual'
): RebalanceResult {
  const allMonths = new Set<string>();
  for (const pnls of varietyMonthlyPnls.values()) {
    for (const p of pnls) {
      allMonths.add(p.month);
    }
  }
  
  const sortedMonths = Array.from(allMonths).sort();
  const weights = new Map(baseWeights);
  const portfolioPnls: MonthlyPnl[] = [];
  let rebalanceCount = 0;
  
  for (let i = 0; i < sortedMonths.length; i++) {
    const month = sortedMonths[i];
    
    // 检查是否需要再平衡
    let shouldRebalance = false;
    if (frequency === 'monthly') {
      shouldRebalance = true;
    } else if (frequency === 'quarterly' && i % 3 === 0) {
      shouldRebalance = true;
    } else if (frequency === 'semi-annual' && i % 6 === 0) {
      shouldRebalance = true;
    } else if (frequency === 'annual' && i % 12 === 0) {
      shouldRebalance = true;
    }
    
    if (shouldRebalance && frequency !== 'static') {
      rebalanceCount++;
      // 再平衡：重置为基础权重
      for (const [variety, weight] of baseWeights.entries()) {
        weights.set(variety, weight);
      }
    }
    
    // 计算当月PnL
    let monthPnl = 0;
    for (const [variety, weight] of weights.entries()) {
      const varietyPnls = varietyMonthlyPnls.get(variety) || [];
      const monthData = varietyPnls.find(p => p.month === month);
      if (monthData) {
        monthPnl += monthData.pnl * weight;
      }
    }
    
    portfolioPnls.push({ month, pnl: monthPnl });
    
    // 更新权重（漂移）
    if (frequency !== 'static') {
      const totalEquity = 1000000 + portfolioPnls.reduce((s, p) => s + p.pnl, 0);
      for (const variety of weights.keys()) {
        const varietyPnls = varietyMonthlyPnls.get(variety) || [];
        const varietyEquity = varietyPnls
          .filter(p => p.month <= month)
          .reduce((s, p) => s + p.pnl, 0) * (baseWeights.get(variety) || 0);
        const newWeight = (1000000 * (baseWeights.get(variety) || 0) + varietyEquity) / totalEquity;
        weights.set(variety, Math.max(0, newWeight));
      }
    }
  }
  
  const stats = computePortfolioStats(portfolioPnls);
  
  return {
    frequency,
    rebalanceCount,
    totalPnl: stats.totalPnl,
    maxDrawdown: stats.maxDrawdown,
    calmar: stats.calmar,
    sharpe: stats.sharpe,
    winRate: stats.winRate,
    monthlyPnls: portfolioPnls,
  };
}

async function main() {
  console.log('=== 动态再平衡分析 ===\n');
  
  // 获取风险平价权重（从之前的分析结果）
  const riskParityPath = path.join(DATA_DIR, 'riskParityPortfolio.json');
  let baseWeights = new Map<string, number>();
  
  if (fs.existsSync(riskParityPath)) {
    const rpData = JSON.parse(fs.readFileSync(riskParityPath, 'utf-8'));
    for (const variety of VARIETIES) {
      const weight = rpData.weights?.[variety] || 1 / VARIETIES.length;
      baseWeights.set(variety, weight);
    }
  } else {
    // 默认等权
    for (const variety of VARIETIES) {
      baseWeights.set(variety, 1 / VARIETIES.length);
    }
  }
  
  console.log('基础权重:', Object.fromEntries(baseWeights));
  
  // 获取每个品种的月度PnL
  const varietyMonthlyPnls = new Map<string, MonthlyPnl[]>();
  
  for (const variety of VARIETIES) {
    console.log(`\n分析 ${variety}...`);
    const recipe = TOP1_UNIFIED_PARAMS[variety];
    if (!recipe) {
      console.log(`  跳过 ${variety}（无参数）`);
      continue;
    }
    
    const bars = loadBars(variety);
    const result = await runTop1Backtest(
      variety,
      recipe as any,
      bars,
      { longReturn: 0, shortReturn: 0 } as any
    );
    
    const monthlyPnls = aggregateMonthlyPnl(result.trades);
    varietyMonthlyPnls.set(variety, monthlyPnls);
    console.log(`  月度数据点: ${monthlyPnls.length}`);
  }
  
  // 测试不同再平衡频率
  const frequencies: Array<'static' | 'monthly' | 'quarterly' | 'semi-annual' | 'annual'> = [
    'static',
    'monthly',
    'quarterly',
    'semi-annual',
    'annual',
  ];
  
  const results: RebalanceResult[] = [];
  
  console.log('\n=== 再平衡频率测试 ===');
  
  for (const freq of frequencies) {
    const result = simulateRebalancing(varietyMonthlyPnls, baseWeights, freq);
    results.push(result);
    console.log(`\n${freq}:`);
    console.log(`  再平衡次数: ${result.rebalanceCount}`);
    console.log(`  总PnL: ${(result.totalPnl / 10000).toFixed(0)}万`);
    console.log(`  最大回撤: ${(result.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`  Calmar: ${result.calmar.toFixed(2)}`);
    console.log(`  夏普: ${result.sharpe.toFixed(2)}`);
    console.log(`  月度胜率: ${(result.winRate * 100).toFixed(1)}%`);
  }
  
  // 找出最佳频率
  const best = results.reduce((a, b) => a.calmar > b.calmar ? a : b);
  console.log(`\n=== 最佳频率: ${best.frequency} ===`);
  
  // 保存结果
  const output = {
    baseWeights: Object.fromEntries(baseWeights),
    results: results.map(r => ({
      frequency: r.frequency,
      rebalanceCount: r.rebalanceCount,
      totalPnl: r.totalPnl,
      maxDrawdown: r.maxDrawdown,
      calmar: r.calmar,
      sharpe: r.sharpe,
      winRate: r.winRate,
    })),
    best: {
      frequency: best.frequency,
      calmar: best.calmar,
      maxDrawdown: best.maxDrawdown,
    },
  };
  
  const outputPath = path.join(DATA_DIR, 'dynamicRebalancingAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
