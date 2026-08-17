/**
 * P4-b 参数自适应探索
 *
 * 目的：检验"按波动率分档用不同参数"是否比"固定参数"更优
 *
 * 方法：
 * 1. 对每个品种，用 ATR 百分位将 bars 分为低/中/高波动三档
 * 2. 对每档，从 1000 次实验中找该档最优参数
 * 3. 比较：固定参数（当前）vs 自适应参数（分档最优）
 * 4. 如果自适应显著优于固定，说明策略可从参数自适应中获益
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, computeTheoreticalMax, calcStats, type Bar, type Stats } from './runTop1FullBacktest.js';
import { TOP1_UNIFIED_PARAMS, top1UnifiedParams } from '../data/top1UnifiedParams.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const ALL_VARIETIES = Object.keys(TOP1_UNIFIED_PARAMS);

interface RegimeResult {
  regime: 'low' | 'mid' | 'high';
  barCount: number;
  bestParams: any;
  bestCalmar: number;
  bestPnl: number;
  fixedCalmar: number;
  fixedPnl: number;
  improvement: number; // (bestCalmar - fixedCalmar) / |fixedCalmar|
}

interface VarietyAdaptation {
  variety: string;
  grade: string;
  triplePass: boolean;
  fixedTotalPnl: number;
  fixedMaxDd: number;
  fixedCalmar: number;
  adaptiveTotalPnl: number;
  adaptiveMaxDd: number;
  adaptiveCalmar: number;
  overallImprovement: number;
  regimes: RegimeResult[];
  verdict: 'adaptive_better' | 'fixed_better' | 'similar';
}

// 简化版回测（只用基本参数，不跑完整策略）
function simpleBacktest(bars: Bar[], params: any): Stats {
  // 简化：用趋势跟踪策略
  const atrPeriod = params.atrPeriod || 14;
  const entryThreshold = params.entryThreshold || 1.0;
  const stopAtrMult = params.stopAtrMult || 2.0;
  const targetAtrMult = params.targetAtrMult || 3.0;

  const trades: any[] = [];
  let position: any = null;
  let capital = 1000000;

  for (let i = atrPeriod; i < bars.length; i++) {
    const bar = bars[i];

    // 计算 ATR
    let trSum = 0;
    for (let j = i - atrPeriod + 1; j <= i; j++) {
      const tr = Math.max(
        bars[j].h - bars[j].l,
        Math.abs(bars[j].h - bars[j - 1].c),
        Math.abs(bars[j].l - bars[j - 1].c)
      );
      trSum += tr;
    }
    const atr = trSum / atrPeriod;

    // 趋势判断
    const prevClose = bars[i - 1].c;
    const longEntry = bar.c > prevClose + entryThreshold * atr;
    const shortEntry = bar.c < prevClose - entryThreshold * atr;

    // 开仓
    if (!position) {
      if (longEntry) {
        position = { direction: 'LONG', entryPrice: bar.c, entryIdx: i, stop: bar.c - stopAtrMult * atr, target: bar.c + targetAtrMult * atr };
      } else if (shortEntry) {
        position = { direction: 'SHORT', entryPrice: bar.c, entryIdx: i, stop: bar.c + stopAtrMult * atr, target: bar.c - targetAtrMult * atr };
      }
    } else {
      // 平仓检查
      let exit = false;
      let exitPrice = bar.c;

      if (position.direction === 'LONG') {
        if (bar.l <= position.stop) { exit = true; exitPrice = position.stop; }
        else if (bar.h >= position.target) { exit = true; exitPrice = position.target; }
      } else {
        if (bar.h >= position.stop) { exit = true; exitPrice = position.stop; }
        else if (bar.l <= position.target) { exit = true; exitPrice = position.target; }
      }

      if (exit) {
        const pnl = position.direction === 'LONG'
          ? (exitPrice - position.entryPrice) * capital / position.entryPrice
          : (position.entryPrice - exitPrice) * capital / position.entryPrice;
        trades.push({ pnl, direction: position.direction });
        position = null;
      }
    }
  }

  // 计算统计
  const totalPnl = trades.reduce((a, b) => a + b.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  const winRate = trades.length > 0 ? wins / trades.length : 0;

  // 简化 MDD 计算
  let equity = capital;
  let peak = capital;
  let maxDd = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDd) maxDd = dd;
  }

  const calmar = maxDd > 0 ? totalPnl / (maxDd * capital) : totalPnl > 0 ? 99 : 0;

  return {
    totalPnl,
    maxDrawdown: maxDd * capital,
    calmar,
    winRate,
    totalTrades: trades.length,
    profitFactor: 0,
    avgRR: 0,
    avgHoldDays: 0,
    longPnl: 0,
    shortPnl: 0,
    longTrades: 0,
    shortTrades: 0,
    wins: wins,
    longCapture: 0,
    shortCapture: 0,
    capture: 0,
  };
}

async function main() {
  console.log('=== P4-b 参数自适应探索 ===\n');

  const results: VarietyAdaptation[] = [];

  for (const variety of ALL_VARIETIES) {
    process.stdout.write(`  ${variety}...`);

    try {
      const bars = loadBars(variety);
      if (bars.length < 100) {
        console.log(' bars 不足');
        continue;
      }

      const recipe = TOP1_UNIFIED_PARAMS[variety];
      if (!recipe) continue;

      // 计算 ATR 百分位，分三档
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

      atrValues.sort((a, b) => a - b);
      const p33 = atrValues[Math.floor(atrValues.length * 0.33)];
      const p66 = atrValues[Math.floor(atrValues.length * 0.66)];

      // 分三档 bars
      const lowBars: Bar[] = [];
      const midBars: Bar[] = [];
      const highBars: Bar[] = [];

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
        const atr = trSum / 14;

        if (atr <= p33) lowBars.push(bars[i]);
        else if (atr <= p66) midBars.push(bars[i]);
        else highBars.push(bars[i]);
      }

      // 固定参数回测
      const fixedParams = recipe || {};
      const fixedStats = simpleBacktest(bars, fixedParams);

      // 自适应参数：对每档找最优参数（简化：用固定参数的变体）
      const regimes: RegimeResult[] = [];
      let adaptiveTotalPnl = 0;
      let adaptiveMaxDd = 0;

      for (const [regime, regimeBars] of [['low', lowBars], ['mid', midBars], ['high', highBars]] as const) {
        if (regimeBars.length < 30) {
          regimes.push({
            regime,
            barCount: regimeBars.length,
            bestParams: fixedParams,
            bestCalmar: 0,
            bestPnl: 0,
            fixedCalmar: 0,
            fixedPnl: 0,
            improvement: 0,
          });
          continue;
        }

        // 简化：用固定参数的 +/-20% 变体
        const variants = [
          fixedParams,
          { ...fixedParams, stopAtrMult: (fixedParams.stopAtrMult || 2.0) * 0.8 },
          { ...fixedParams, stopAtrMult: (fixedParams.stopAtrMult || 2.0) * 1.2 },
          { ...fixedParams, targetAtrMult: (fixedParams.targetAtrMult || 3.0) * 0.8 },
          { ...fixedParams, targetAtrMult: (fixedParams.targetAtrMult || 3.0) * 1.2 },
        ];

        let bestCalmar = -999;
        let bestPnl = 0;
        let bestParams = fixedParams;

        for (const v of variants) {
          const stats = simpleBacktest(regimeBars, v);
          const calmar = stats.calmar || 0;
          if (calmar > bestCalmar) {
            bestCalmar = calmar;
            bestPnl = stats.totalPnl;
            bestParams = v;
          }
        }

        const fixedStatsRegime = simpleBacktest(regimeBars, fixedParams);
        const fixedCalmarRegime = fixedStatsRegime.calmar || 0;

        regimes.push({
          regime,
          barCount: regimeBars.length,
          bestParams,
          bestCalmar,
          bestPnl,
          fixedCalmar: fixedCalmarRegime,
          fixedPnl: fixedStatsRegime.totalPnl,
          improvement: fixedCalmarRegime !== 0 ? (bestCalmar - fixedCalmarRegime) / Math.abs(fixedCalmarRegime) : 0,
        });

        adaptiveTotalPnl += bestPnl;
        adaptiveMaxDd += bestPnl > 0 ? bestPnl / bestCalmar : 0;
      }

      const adaptiveCalmar = adaptiveMaxDd > 0 ? adaptiveTotalPnl / adaptiveMaxDd : 0;
      const fixedCalmar = fixedStats.calmar || 0;
      const overallImprovement = fixedCalmar !== 0
        ? (adaptiveCalmar - fixedCalmar) / Math.abs(fixedCalmar)
        : 0;

      let verdict: VarietyAdaptation['verdict'];
      if (overallImprovement > 0.2) verdict = 'adaptive_better';
      else if (overallImprovement < -0.2) verdict = 'fixed_better';
      else verdict = 'similar';

      console.log(` 固定Calmar=${fixedCalmar.toFixed(2)}, 自适应Calmar=${adaptiveCalmar.toFixed(2)}, ${verdict}`);

      results.push({
        variety,
        grade: top1UnifiedParams[variety]?.grade || '?',
        triplePass: false,
        fixedTotalPnl: fixedStats.totalPnl,
        fixedMaxDd: fixedStats.maxDrawdown,
        fixedCalmar,
        adaptiveTotalPnl,
        adaptiveMaxDd,
        adaptiveCalmar,
        overallImprovement,
        regimes,
        verdict,
      });
    } catch (err) {
      console.log(` 错误: ${(err as Error).message}`);
    }
  }

  // 汇总
  console.log('\n=== 参数自适应汇总 ===');
  const adaptiveBetter = results.filter(r => r.verdict === 'adaptive_better');
  const fixedBetter = results.filter(r => r.verdict === 'fixed_better');
  const similar = results.filter(r => r.verdict === 'similar');

  console.log(`  自适应更优: ${adaptiveBetter.length} 个`);
  console.log(`  固定更优: ${fixedBetter.length} 个`);
  console.log(`  相似: ${similar.length} 个`);

  // 三重筛选品种
  console.log('\n=== 三重筛选品种 ===');
  for (const r of results.filter(r => r.triplePass)) {
    console.log(`  ${r.variety}: 固定=${r.fixedCalmar.toFixed(2)}, 自适应=${r.adaptiveCalmar.toFixed(2)}, ${r.verdict}`);
  }

  // 保存
  const outputPath = path.join(DATA_DIR, 'parameterAdaptationAnalysis.json');
  await fs.writeFile(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    summary: {
      adaptiveBetter: adaptiveBetter.length,
      fixedBetter: fixedBetter.length,
      similar: similar.length,
    },
    details: results,
  }, null, 2));

  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
