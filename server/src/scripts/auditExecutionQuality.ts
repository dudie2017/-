/**
 * P5-a 执行质量审计
 *
 * 目的：检查回测中的成交是否真的可以在实盘中执行
 *
 * 检查项：
 * 1. 成交量充足性：成交是否在成交量充足的 bar 上？
 * 2. 涨跌停检查：成交是否发生在涨跌停的 bar 上？
 * 3. 跳空风险：入场/出场价是否有显著跳空？
 * 4. 滑点估计：基于波动率估计买卖价差影响
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runTop1Backtest, loadBars, computeTheoreticalMax, type Bar } from './runTop1FullBacktest.js';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const ALL_VARIETIES = Object.keys(TOP1_UNIFIED_PARAMS);

interface ExecutionAudit {
  variety: string;
  grade: string;
  triplePass: boolean;
  totalTrades: number;

  // 成交量检查
  lowVolumeTrades: number;      // 低成交量 bar 上的交易数
  lowVolumeRatio: number;       // 低成交量交易占比
  avgVolumePercentile: number;  // 平均成交量百分位

  // 涨跌停检查
  limitHitTrades: number;       // 涨跌停 bar 上的交易数
  limitHitRatio: number;        // 涨跌停交易占比

  // 跳空检查
  gapRiskTrades: number;        // 高跳空风险交易数
  gapRiskRatio: number;         // 高跳空风险占比
  avgGapPct: number;            // 平均跳空幅度

  // 滑点估计
  estimatedSlippagePct: number; // 估计滑点 (%)
  slippageAdjustedPnl: number;  // 滑点调整后 PnL
  slippageImpactRatio: number;  // 滑点影响比例

  // 综合评分
  executionScore: number;       // 执行质量评分 0-100
  verdict: 'excellent' | 'good' | 'fair' | 'poor';
}

async function main() {
  console.log('=== P5-a 执行质量审计 ===\n');

  const results: ExecutionAudit[] = [];

  for (const variety of ALL_VARIETIES) {
    process.stdout.write(`  ${variety}...`);

    try {
      const bars = loadBars(variety);
      const recipe = TOP1_UNIFIED_PARAMS[variety];
      if (!recipe) continue;

      const theo = computeTheoreticalMax(bars, 3);
      const { trades } = await runTop1Backtest(variety, recipe, bars, theo, 'full');

      if (trades.length === 0) {
        console.log(' 无交易');
        continue;
      }

      // 建立日期到 bar 的映射
      const barByDate = new Map<string, Bar>();
      for (const bar of bars) {
        barByDate.set(bar.date, bar);
      }

      // 计算成交量百分位
      const volumes = bars.map(b => b.vol || 0).filter(v => v > 0);
      volumes.sort((a, b) => a - b);
      const p25 = volumes[Math.floor(volumes.length * 0.25)] || 0;

      let lowVolumeTrades = 0;
      let limitHitTrades = 0;
      let gapRiskTrades = 0;
      let totalVolumePercentile = 0;
      let totalGapPct = 0;
      let validCount = 0;

      for (const trade of trades) {
        const entryBar = barByDate.get(trade.entryDate);
        const exitBar = barByDate.get(trade.exitDate);

        if (entryBar) {
          // 成交量检查
          const vol = entryBar.vol || 0;
          if (vol > 0) {
            const percentile = volumes.filter(v => v <= vol).length / volumes.length;
            totalVolumePercentile += percentile;
            if (vol < p25) lowVolumeTrades++;
          }

          // 涨跌停检查（简化：检查价格是否在 bar 的极值）
          const isAtLimit = Math.abs(trade.entryPrice - entryBar.h) < 0.001 ||
                           Math.abs(trade.entryPrice - entryBar.l) < 0.001;
          if (isAtLimit) limitHitTrades++;

          // 跳空检查
          const barIdx = bars.indexOf(entryBar);
          if (barIdx > 0) {
            const prevClose = bars[barIdx - 1].c;
            const gapPct = Math.abs(entryBar.o - prevClose) / prevClose;
            totalGapPct += gapPct;
            if (gapPct > 0.02) gapRiskTrades++; // >2% 跳空
          }

          validCount++;
        }
      }

      const lowVolumeRatio = validCount > 0 ? lowVolumeTrades / validCount : 0;
      const limitHitRatio = validCount > 0 ? limitHitTrades / validCount : 0;
      const gapRiskRatio = validCount > 0 ? gapRiskTrades / validCount : 0;
      const avgVolumePercentile = validCount > 0 ? totalVolumePercentile / validCount : 0;
      const avgGapPct = validCount > 0 ? totalGapPct / validCount : 0;

      // 滑点估计（基于波动率）
      const atrValues: number[] = [];
      for (let i = 14; i < bars.length; i++) {
        let trSum = 0;
        for (let j = i - 13; j <= i; j++) {
          const tr = Math.max(
            bars[j].h - bars[j].l,
            Math.abs(bars[j].h - bars[j - 1].c),
            Math.abs(bars[j].l - bars[j - 1].c)
          );
          trSum += tr;
        }
        atrValues.push(trSum / 14);
      }
      const avgAtr = atrValues.reduce((a, b) => a + b, 0) / atrValues.length;
      const avgPrice = bars.reduce((a, b) => a + b.c, 0) / bars.length;
      const atrPct = avgAtr / avgPrice;

      // 估计滑点 = ATR% * 0.1（假设能拿到 1/10 ATR 的价格改善）
      const estimatedSlippagePct = atrPct * 0.1 * 100;

      // 滑点调整后 PnL
      const totalPnl = trades.reduce((a, b) => a + b.pnl, 0);
      const avgTradeSize = Math.abs(totalPnl / trades.length);
      const slippageCost = trades.length * avgTradeSize * estimatedSlippagePct / 100;
      const slippageAdjustedPnl = totalPnl - slippageCost;
      const slippageImpactRatio = totalPnl !== 0 ? slippageCost / Math.abs(totalPnl) : 0;

      // 综合评分
      let executionScore = 100;
      executionScore -= lowVolumeRatio * 30;      // 低成交量交易扣分
      executionScore -= limitHitRatio * 40;       // 涨跌停交易重扣分
      executionScore -= gapRiskRatio * 25;        // 跳空风险扣分
      executionScore -= Math.min(slippageImpactRatio * 20, 20); // 滑点影响扣分
      executionScore = Math.max(0, Math.min(100, executionScore));

      let verdict: ExecutionAudit['verdict'];
      if (executionScore >= 80) verdict = 'excellent';
      else if (executionScore >= 60) verdict = 'good';
      else if (executionScore >= 40) verdict = 'fair';
      else verdict = 'poor';

      console.log(` 评分=${executionScore.toFixed(0)}, ${verdict}, 低量=${(lowVolumeRatio * 100).toFixed(0)}%, 涨跌停=${(limitHitRatio * 100).toFixed(0)}%, 跳空=${(gapRiskRatio * 100).toFixed(0)}%`);

      results.push({
        variety,
        grade: (TOP1_UNIFIED_PARAMS[variety] as any)?.grade || '?',
        triplePass: (TOP1_UNIFIED_PARAMS[variety] as any)?.triplePass || false,
        totalTrades: trades.length,
        lowVolumeTrades,
        lowVolumeRatio,
        avgVolumePercentile,
        limitHitTrades,
        limitHitRatio,
        gapRiskTrades,
        gapRiskRatio,
        avgGapPct,
        estimatedSlippagePct,
        slippageAdjustedPnl,
        slippageImpactRatio,
        executionScore,
        verdict,
      });
    } catch (err) {
      console.log(` 错误: ${(err as Error).message}`);
    }
  }

  // 汇总
  console.log('\n=== 执行质量汇总 ===');
  const byVerdict = new Map<string, ExecutionAudit[]>();
  for (const r of results) {
    if (!byVerdict.has(r.verdict)) byVerdict.set(r.verdict, []);
    byVerdict.get(r.verdict)!.push(r);
  }

  for (const [verdict, items] of byVerdict) {
    console.log(`\n【${verdict}】${items.length} 个品种:`);
    console.log(`  ${items.map(i => i.variety).join(', ')}`);
  }

  // 三重筛选品种
  console.log('\n=== 三重筛选品种执行质量 ===');
  for (const r of results.filter(r => r.triplePass)) {
    console.log(`  ${r.variety}: 评分=${r.executionScore.toFixed(0)}, ${r.verdict}, 滑点影响=${(r.slippageImpactRatio * 100).toFixed(1)}%`);
  }

  // 保存
  const outputPath = path.join(DATA_DIR, 'executionQualityAudit.json');
  await fs.writeFile(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      excellent: results.filter(r => r.verdict === 'excellent').length,
      good: results.filter(r => r.verdict === 'good').length,
      fair: results.filter(r => r.verdict === 'fair').length,
      poor: results.filter(r => r.verdict === 'poor').length,
    },
    triplePassAudit: results.filter(r => r.triplePass).map(r => ({
      variety: r.variety,
      executionScore: r.executionScore,
      verdict: r.verdict,
      lowVolumeRatio: r.lowVolumeRatio,
      limitHitRatio: r.limitHitRatio,
      gapRiskRatio: r.gapRiskRatio,
      slippageImpactRatio: r.slippageImpactRatio,
    })),
    details: results,
  }, null, 2));

  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
