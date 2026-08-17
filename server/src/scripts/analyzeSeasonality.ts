/**
 * P4-a 季节性拆解分析
 *
 * 目的：检验策略盈利是否集中在特定月份（季节性 beta），还是全年均匀分布（真 alpha）
 *
 * 方法：
 * 1. 对每个品种，用 top1 参数跑回测获取逐笔 trades
 * 2. 按月份聚合 PnL（1-12月）
 * 3. 计算各月平均 PnL、盈利月份占比、季节性集中度
 * 4. 分类：全年均匀型 vs 季节依赖型
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runTop1Backtest, loadBars, computeTheoreticalMax, type Bar } from './runTop1FullBacktest.js';
import { TOP1_UNIFIED_PARAMS, top1UnifiedParams } from '../data/top1UnifiedParams.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

// 品种列表（59 个）
const ALL_VARIETIES = Object.keys(TOP1_UNIFIED_PARAMS);

interface MonthlyStats {
  month: number;
  avgPnl: number;       // 该月平均 PnL
  totalPnl: number;     // 该月总 PnL
  tradeCount: number;   // 该月交易次数
  winRate: number;      // 该月胜率
  profitMonths: number; // 该月盈利的年份数
  totalYears: number;   // 该月总年份数
}

interface VarietySeasonality {
  variety: string;
  grade: string;
  triplePass: boolean;
  monthlyPnl: number[];         // 12 个月的平均 PnL
  monthlyStd: number;           // 月度 PnL 标准差
  profitMonthCount: number;     // 盈利月份数（0-12）
  profitMonthRatio: number;     // 盈利月份占比
  seasonalConcentration: number; // 季节性集中度（前3月占比）
  bestMonth: number;            // 最佳月份
  worstMonth: number;           // 最差月份
  bestMonthPnl: number;         // 最佳月份 PnL
  worstMonthPnl: number;        // 最差月份 PnL
  monthlyStats: MonthlyStats[]; // 各月详细统计
  verdict: 'all_year' | 'mild_seasonal' | 'strong_seasonal' | 'seasonal_dependent';
}

async function main() {
  console.log('=== P4-a 季节性拆解分析 ===\n');

  const results: VarietySeasonality[] = [];

  for (const variety of ALL_VARIETIES) {
    process.stdout.write(`  ${variety}...`);

    try {
      const recipe = TOP1_UNIFIED_PARAMS[variety];
      if (!recipe) continue;

      const bars = loadBars(variety);
      const theo = computeTheoreticalMax(bars, 3);

      // 跑回测获取 trades
      const { trades } = await runTop1Backtest(variety, recipe, bars, theo, 'full');

      if (!trades || trades.length === 0) {
        console.log(' 无交易');
        results.push({
          variety,
          grade: top1UnifiedParams[variety]?.grade || '?',
          triplePass: false,
          monthlyPnl: new Array(12).fill(0),
          monthlyStd: 0,
          profitMonthCount: 0,
          profitMonthRatio: 0,
          seasonalConcentration: 0,
          bestMonth: 1,
          worstMonth: 1,
          bestMonthPnl: 0,
          worstMonthPnl: 0,
          monthlyStats: [],
          verdict: 'all_year',
        });
        continue;
      }

      // 按月份聚合
      const monthlyData: Map<number, number[]> = new Map();
      for (let m = 1; m <= 12; m++) monthlyData.set(m, []);

      for (const trade of trades) {
        // 用入场日期判断月份
        const entryDate = trade.entryDate || trade.entryTime;
        if (!entryDate) continue;

        // 解析月份（格式可能是 "2020-01-15" 或时间戳）
        let month: number;
        if (typeof entryDate === 'string') {
          month = parseInt(entryDate.split('-')[1]) || 1;
        } else if (typeof entryDate === 'number') {
          month = new Date(entryDate).getMonth() + 1;
        } else {
          continue;
        }

        if (month >= 1 && month <= 12) {
          monthlyData.get(month)!.push(trade.pnl || 0);
        }
      }

      // 计算各月统计
      const monthlyPnl: number[] = [];
      const monthlyStats: MonthlyStats[] = [];
      let totalTradeCount = 0;

      for (let m = 1; m <= 12; m++) {
        const pnls = monthlyData.get(m) || [];
        const totalPnl = pnls.reduce((a, b) => a + b, 0);
        const avgPnl = pnls.length > 0 ? totalPnl / pnls.length : 0;
        const wins = pnls.filter(p => p > 0).length;
        const winRate = pnls.length > 0 ? wins / pnls.length : 0;

        monthlyPnl.push(avgPnl);
        totalTradeCount += pnls.length;

        monthlyStats.push({
          month: m,
          avgPnl,
          totalPnl,
          tradeCount: pnls.length,
          winRate,
          profitMonths: 0, // 简化处理
          totalYears: 0,
        });
      }

      // 计算统计指标
      const mean = monthlyPnl.reduce((a, b) => a + b, 0) / 12;
      const variance = monthlyPnl.reduce((a, b) => a + (b - mean) ** 2, 0) / 12;
      const monthlyStd = Math.sqrt(variance);

      const profitMonthCount = monthlyPnl.filter(p => p > 0).length;
      const profitMonthRatio = profitMonthCount / 12;

      // 季节性集中度：前3大月份占总盈利的比例
      const sortedPnl = [...monthlyPnl].sort((a, b) => b - a);
      const top3Pnl = sortedPnl.slice(0, 3).reduce((a, b) => a + Math.max(0, b), 0);
      const totalPositivePnl = sortedPnl.filter(p => p > 0).reduce((a, b) => a + b, 0);
      const seasonalConcentration = totalPositivePnl > 0 ? top3Pnl / totalPositivePnl : 0;

      const bestMonthIdx = monthlyPnl.indexOf(Math.max(...monthlyPnl));
      const worstMonthIdx = monthlyPnl.indexOf(Math.min(...monthlyPnl));

      // 分类判定
      let verdict: VarietySeasonality['verdict'];
      if (profitMonthRatio >= 0.75 && seasonalConcentration < 0.5) {
        verdict = 'all_year'; // 全年均匀型
      } else if (profitMonthRatio >= 0.5 && seasonalConcentration < 0.6) {
        verdict = 'mild_seasonal'; // 轻度季节性
      } else if (profitMonthRatio >= 0.33) {
        verdict = 'strong_seasonal'; // 强季节性
      } else {
        verdict = 'seasonal_dependent'; // 季节依赖型（只有少数月份盈利）
      }

      console.log(` ${profitMonthCount}/12月盈利, 集中度=${(seasonalConcentration * 100).toFixed(0)}%, ${verdict}`);

      results.push({
        variety,
        grade: top1UnifiedParams[variety]?.grade || '?',
        triplePass: false,
        monthlyPnl,
        monthlyStd,
        profitMonthCount,
        profitMonthRatio,
        seasonalConcentration,
        bestMonth: bestMonthIdx + 1,
        worstMonth: worstMonthIdx + 1,
        bestMonthPnl: monthlyPnl[bestMonthIdx],
        worstMonthPnl: monthlyPnl[worstMonthIdx],
        monthlyStats,
        verdict,
      });
    } catch (err) {
      console.log(` 错误: ${(err as Error).message}`);
    }
  }

  // 输出汇总
  console.log('\n=== 季节性分类汇总 ===');
  const byVerdict = new Map<string, VarietySeasonality[]>();
  for (const r of results) {
    if (!byVerdict.has(r.verdict)) byVerdict.set(r.verdict, []);
    byVerdict.get(r.verdict)!.push(r);
  }

  for (const [verdict, items] of byVerdict) {
    console.log(`\n【${verdict}】${items.length} 个品种:`);
    console.log(`  ${items.map(i => i.variety).join(', ')}`);
  }

  // 三重筛选通过品种的季节性分析
  console.log('\n=== 三重筛选品种季节性 ===');
  const triplePassResults = results.filter(r => r.triplePass);
  for (const r of triplePassResults) {
    console.log(`  ${r.variety}: ${r.profitMonthCount}/12月盈利, 集中度=${(r.seasonalConcentration * 100).toFixed(0)}%, 最佳=${r.bestMonth}月, 最差=${r.worstMonth}月`);
  }

  // 保存结果
  const outputPath = path.join(DATA_DIR, 'seasonalityAnalysis.json');
  await fs.writeFile(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalVarieties: results.length,
    verdictSummary: {
      all_year: results.filter(r => r.verdict === 'all_year').length,
      mild_seasonal: results.filter(r => r.verdict === 'mild_seasonal').length,
      strong_seasonal: results.filter(r => r.verdict === 'strong_seasonal').length,
      seasonal_dependent: results.filter(r => r.verdict === 'seasonal_dependent').length,
    },
    triplePassSeasonality: triplePassResults.map(r => ({
      variety: r.variety,
      profitMonthCount: r.profitMonthCount,
      profitMonthRatio: r.profitMonthRatio,
      seasonalConcentration: r.seasonalConcentration,
      bestMonth: r.bestMonth,
      worstMonth: r.worstMonth,
      verdict: r.verdict,
    })),
    details: results,
  }, null, 2));

  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
