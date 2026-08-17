// @ts-nocheck
/**
 * 品种扩展测试：对脆弱品种尝试 TOP3 备选配方
 *
 * 目标：将稳健品种从 4 个扩展到 6-8 个
 *
 * 测试对象：
 * - 5 个 P1 脆弱品种：IH0, IC0, I0, M0, PB0
 * - 2 个 P3 过拟合品种：AL0, IM0
 *
 * 测试方法：
 * - 对每个品种，尝试 TOP1/TOP2/TOP3 配方
 * - 对每个配方，跑 5 段 Walk-forward 验证
 * - 判定标准：至少 4/5 段盈利，且全样本盈利
 */

import { TOP1_UNIFIED_PARAMS, TOP3_BACKUP } from '../data/top1UnifiedParams.js';
import { runTop1Backtest, calcStats, loadBars, computeTheoreticalMax, type TradeLike } from './runTop1FullBacktest.js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const FRAGILE_VARIETIES = ['IH0', 'IC0', 'I0', 'M0', 'PB0'];
const OVERFIT_VARIETIES = ['AL0', 'IM0'];
const ALL_TEST_VARIETIES = [...FRAGILE_VARIETIES, ...OVERFIT_VARIETIES];

const SEGMENTS = 5;

interface WalkForwardResult {
  code: string;
  recipeIndex: number; // 0=TOP1, 1=TOP2, 2=TOP3
  recipe: any;
  segments: Array<{
    segmentIndex: number;
    startDate: string;
    endDate: string;
    totalPnl: number;
    totalTrades: number;
    winRate: number;
  }>;
  fullSample: {
    totalPnl: number;
    totalTrades: number;
    winRate: number;
    maxDrawdown: number;
    profitFactor: number;
  };
  robustSegments: number;
  verdict: 'robust' | 'fragile' | 'loss';
}

async function runWalkForwardForRecipe(
  code: string,
  recipe: any,
  recipeIndex: number
): Promise<WalkForwardResult> {
  // 加载全样本数据
  const allBars = loadBars(code);
  const n = allBars.length;
  const segSize = Math.floor(n / SEGMENTS);

  const segments: WalkForwardResult['segments'] = [];

  for (let i = 0; i < SEGMENTS; i++) {
    const startIdx = i * segSize;
    const endIdx = i === SEGMENTS - 1 ? n : (i + 1) * segSize;
    const segBars = allBars.slice(startIdx, endIdx);

    const theo = computeTheoreticalMax(segBars, 0.05);
    const result = await runTop1Backtest(code, recipe, segBars, theo);
    const stats = calcStats(result.trades as TradeLike[], 500000);

    segments.push({
      segmentIndex: i,
      startDate: segBars[0]?.date ?? '',
      endDate: segBars[segBars.length - 1]?.date ?? '',
      totalPnl: stats.totalPnl,
      totalTrades: stats.totalTrades,
      winRate: stats.winRate,
    });
  }

  // 全样本
  const theo = computeTheoreticalMax(allBars, 0.05);
  const fullResult = await runTop1Backtest(code, recipe, allBars, theo);
  const fullStats = calcStats(fullResult.trades as TradeLike[], 500000);

  const robustSegments = segments.filter(s => s.totalPnl > 0).length;
  const verdict = fullStats.totalPnl < 0 ? 'loss' : robustSegments >= 4 ? 'robust' : 'fragile';

  return {
    code,
    recipeIndex,
    recipe,
    segments,
    fullSample: {
      totalPnl: fullStats.totalPnl,
      totalTrades: fullStats.totalTrades,
      winRate: fullStats.winRate,
      maxDrawdown: fullStats.maxDrawdown,
      profitFactor: fullStats.profitFactor,
    },
    robustSegments,
    verdict,
  };
}

async function main() {
  console.log('=== 品种扩展测试：脆弱/过拟合品种 TOP3 备选验证 ===\n');

  const results: WalkForwardResult[] = [];

  for (const code of ALL_TEST_VARIETIES) {
    console.log(`\n测试品种: ${code}`);

    // 获取 TOP1/TOP2/TOP3 配方
    const top1 = TOP1_UNIFIED_PARAMS[code];
    const top3List = TOP3_BACKUP[code] ?? [];

    const recipes = [
      { index: 0, recipe: top1, label: 'TOP1' },
      ...top3List.slice(0, 2).map((r: any, i: number) => ({ index: i + 1, recipe: r, label: `TOP${i + 2}` })),
    ];

    for (const { index, recipe, label } of recipes) {
      if (!recipe) continue;

      console.log(`  测试 ${label}...`);
      const result = await runWalkForwardForRecipe(code, recipe, index);
      results.push(result);

      console.log(`    全样本: ${result.fullSample.totalPnl > 0 ? '+' : ''}${(result.fullSample.totalPnl / 10000).toFixed(1)}万 | ${result.fullSample.totalTrades}笔 | 胜率${(result.fullSample.winRate * 100).toFixed(1)}%`);
      console.log(`    Walk-forward: ${result.robustSegments}/5 段盈利 | 判定: ${result.verdict}`);

      if (result.verdict === 'robust') {
        console.log(`    ✅ ${code} ${label} 通过 Walk-forward 验证！`);
        break; // 找到稳健配方，跳过后续
      }
    }
  }

  // 保存结果
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = join(process.cwd(), 'backtest-results', `variety-expansion-${timestamp}.json`);
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);

  // 汇总
  console.log('\n=== 汇总 ===');
  const robust = results.filter(r => r.verdict === 'robust');
  const fragile = results.filter(r => r.verdict === 'fragile');
  const loss = results.filter(r => r.verdict === 'loss');

  console.log(`✅ 稳健: ${robust.length} 个品种`);
  for (const r of robust) {
    console.log(`   ${r.code} (TOP${r.recipeIndex + 1}): +${(r.fullSample.totalPnl / 10000).toFixed(1)}万, ${r.robustSegments}/5段盈利`);
  }

  console.log(`⚠️  脆弱: ${fragile.length} 个品种`);
  for (const r of fragile) {
    console.log(`   ${r.code} (TOP${r.recipeIndex + 1}): +${(r.fullSample.totalPnl / 10000).toFixed(1)}万, ${r.robustSegments}/5段盈利`);
  }

  console.log(`❌ 亏损: ${loss.length} 个品种`);
  for (const r of loss) {
    console.log(`   ${r.code} (TOP${r.recipeIndex + 1}): ${(r.fullSample.totalPnl / 10000).toFixed(1)}万`);
  }
}

main().catch(console.error);
