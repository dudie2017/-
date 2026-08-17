/**
 * 多时间框架验证
 * 
 * 将日线数据聚合为不同周期（周线、双周线、月线），
 * 在每种时间框架上使用相同的策略参数回测，
 * 验证策略在不同时间尺度上的稳健性。
 * 
 * 如果策略只在日线上盈利而在更大周期上亏损，
 * 说明策略可能过度拟合了短期噪音。
 */

import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';
import { runTop1Backtest, loadBars, calcStats } from './runTop1FullBacktest.js';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DATA_DIR = join(__dirname, '..', 'data');

interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  rollover: boolean;
  ret: number | null;
}

// 将日线聚合为周线（每5个交易日）
function aggregateToWeekly(dailyBars: Bar[]): Bar[] {
  const weeklyBars: Bar[] = [];
  let chunk: Bar[] = [];

  for (const bar of dailyBars) {
    if (bar.rollover) {
      // 换月bar单独处理，不聚合
      if (chunk.length > 0) {
        weeklyBars.push(aggregateChunk(chunk));
        chunk = [];
      }
      weeklyBars.push({ ...bar });
      continue;
    }
    chunk.push(bar);
    if (chunk.length >= 5) {
      weeklyBars.push(aggregateChunk(chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    weeklyBars.push(aggregateChunk(chunk));
  }
  return weeklyBars;
}

// 将日线聚合为双周线（每10个交易日）
function aggregateToBiWeekly(dailyBars: Bar[]): Bar[] {
  const biWeeklyBars: Bar[] = [];
  let chunk: Bar[] = [];

  for (const bar of dailyBars) {
    if (bar.rollover) {
      if (chunk.length > 0) {
        biWeeklyBars.push(aggregateChunk(chunk));
        chunk = [];
      }
      biWeeklyBars.push({ ...bar });
      continue;
    }
    chunk.push(bar);
    if (chunk.length >= 10) {
      biWeeklyBars.push(aggregateChunk(chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    biWeeklyBars.push(aggregateChunk(chunk));
  }
  return biWeeklyBars;
}

// 将日线聚合为月线（每20个交易日）
function aggregateToMonthly(dailyBars: Bar[]): Bar[] {
  const monthlyBars: Bar[] = [];
  let chunk: Bar[] = [];

  for (const bar of dailyBars) {
    if (bar.rollover) {
      if (chunk.length > 0) {
        monthlyBars.push(aggregateChunk(chunk));
        chunk = [];
      }
      monthlyBars.push({ ...bar });
      continue;
    }
    chunk.push(bar);
    if (chunk.length >= 20) {
      monthlyBars.push(aggregateChunk(chunk));
      chunk = [];
    }
  }
  if (chunk.length > 0) {
    monthlyBars.push(aggregateChunk(chunk));
  }
  return monthlyBars;
}

// 聚合一组bar为一根bar
function aggregateChunk(chunk: Bar[]): Bar {
  if (chunk.length === 0) return chunk[0];
  return {
    date: chunk[0].date,
    o: chunk[0].o,
    h: Math.max(...chunk.map(b => b.h)),
    l: Math.min(...chunk.map(b => b.l)),
    c: chunk[chunk.length - 1].c,
    vol: chunk.reduce((s, b) => s + b.vol, 0),
    hold: chunk[chunk.length - 1].hold,
    rollover: false,
    ret: chunk[chunk.length - 1].ret,
  };
}

// 计算 Calmar
function computeCalmar(totalPnl: number, maxDrawdown: number, years: number = 3): number {
  if (maxDrawdown <= 0) return totalPnl > 0 ? 99 : 0;
  const annualReturn = (totalPnl / 1_000_000) / years;
  return annualReturn / maxDrawdown;
}

interface TimeframeResult {
  timeframe: string;
  barCount: number;
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  calmar: number;
  profitFactor: number;
}

interface VarietyTimeframeResult {
  variety: string;
  timeframes: Record<string, TimeframeResult>;
  consistency: string; // 'robust' | 'partial' | 'fragile'
  notes: string;
}

async function multiTimeframeValidation() {
  console.log('=== 多时间框架验证 ===\n');

  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, VarietyTimeframeResult> = {};

  for (const variety of varieties) {
    console.log(`\n--- ${variety} 多时间框架验证 ---`);

    const recipe = TOP1_UNIFIED_PARAMS[variety] as any;
    if (!recipe) {
      console.log(`  跳过：未找到参数`);
      continue;
    }

    const dailyBars = loadBars(variety);
    if (dailyBars.length === 0) {
      console.log(`  跳过：无数据`);
      continue;
    }

    const theo = {
      longReturn: recipe.directionMode === 'shortOnly' ? 0 : 1,
      shortReturn: recipe.directionMode === 'longOnly' ? 0 : 1,
    };

    // 不同时间框架
    const timeframeConfigs: { name: string; bars: Bar[] }[] = [
      { name: 'daily', bars: dailyBars },
      { name: 'weekly', bars: aggregateToWeekly(dailyBars) },
      { name: 'biweekly', bars: aggregateToBiWeekly(dailyBars) },
      { name: 'monthly', bars: aggregateToMonthly(dailyBars) },
    ];

    const timeframeResults: Record<string, TimeframeResult> = {};
    const profitableTimeframes: string[] = [];

    for (const tf of timeframeConfigs) {
      try {
        const result = await runTop1Backtest(variety, recipe, tf.bars, theo);
        const stats = result.stats;
        const calmar = computeCalmar(stats.totalPnl, stats.maxDrawdown);
        const isProfitable = stats.totalPnl > 0 && stats.profitFactor > 1.0;

        if (isProfitable) profitableTimeframes.push(tf.name);

        timeframeResults[tf.name] = {
          timeframe: tf.name,
          barCount: tf.bars.length,
          totalTrades: stats.totalTrades,
          winRate: stats.winRate,
          totalPnl: stats.totalPnl,
          maxDrawdown: stats.maxDrawdown,
          calmar,
          profitFactor: stats.profitFactor,
        };

        console.log(`  ${tf.name.padEnd(10)} | K线=${tf.bars.length.toString().padStart(5)} | 交易=${stats.totalTrades.toString().padStart(3)} | 胜率=${(stats.winRate * 100).toFixed(1).padStart(5)}% | PnL=${Math.round(stats.totalPnl).toString().padStart(12).toLocaleString()} | 回撤=${(stats.maxDrawdown * 100).toFixed(1).padStart(5)}% | Calmar=${calmar.toFixed(2).padStart(6)} | PF=${stats.profitFactor.toFixed(2)}`);
      } catch (e) {
        console.log(`  ${tf.name}: 回测失败 - ${(e as Error).message}`);
      }
    }

    // 判定一致性
    let consistency: string;
    let notes: string;
    const profitableCount = profitableTimeframes.length;
    const totalCount = Object.keys(timeframeResults).length;

    if (profitableCount === totalCount) {
      consistency = 'robust';
      notes = '所有时间框架均盈利，策略高度稳健';
    } else if (profitableCount >= totalCount * 0.6) {
      consistency = 'partial';
      const failedTFs = Object.entries(timeframeResults)
        .filter(([_, r]) => r.totalPnl <= 0 || r.profitFactor <= 1.0)
        .map(([name]) => name);
      notes = `大部分时间框架盈利，但在 ${failedTFs.join('/')} 上表现不佳`;
    } else {
      consistency = 'fragile';
      notes = '策略仅在特定时间框架有效，可能存在过拟合';
    }

    console.log(`  结论: ${consistency} - ${notes}`);

    results[variety] = {
      variety,
      timeframes: timeframeResults,
      consistency,
      notes,
    };
  }

  // 汇总
  console.log('\n\n=== 多时间框架验证汇总 ===');
  for (const [variety, r] of Object.entries(results)) {
    const icon = r.consistency === 'robust' ? '✅' : r.consistency === 'partial' ? '⚠️' : '❌';
    console.log(`  ${icon} ${variety}: ${r.consistency} - ${r.notes}`);
  }

  const output = {
    timestamp: new Date().toISOString(),
    results,
    summary: {
      robust: Object.values(results).filter(r => r.consistency === 'robust').map(r => r.variety),
      partial: Object.values(results).filter(r => r.consistency === 'partial').map(r => r.variety),
      fragile: Object.values(results).filter(r => r.consistency === 'fragile').map(r => r.variety),
    },
  };

  const outputPath = join(DATA_DIR, 'multiTimeframeValidation.json');
  writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存到: ${outputPath}`);

  return output;
}

multiTimeframeValidation().catch(console.error);
