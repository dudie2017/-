/**
 * 做空优化方案对比回测 (runShortOptimization)
 *
 * 目的：对白银 AG0 的4个做空优化方案分别回测，对比选出最优方案
 *
 * 方案：
 *   A. 做空放宽止损至 2.0×ATR
 *   B. 做空加趋势过滤（EMA20向下才做空）
 *   C. 做空提高信号门槛至 L3
 *   D. 做空延长持有期至 25 天
 *
 * 对比维度：
 *   - 做空捕获率（策略做空收益 / 理论做空收益）
 *   - 整体 PF / 胜率 / 回撤 / 微利占比
 *   - 做多不受影响（sideParams 只改 short）
 *
 * 用法：npx tsx src/scripts/runShortOptimization.ts AG0
 */
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { loadBars, computeTheoreticalMax } from './theoreticalMax';
import { analyzeTrades, calcPriceReturn } from './runVarietyBacktest';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const THRESHOLDS = [3, 5, 8]; // 百分比

interface SchemeResult {
  name: string;
  desc: string;
  params: Record<string, unknown>;
  stat: ReturnType<typeof analyzeTrades>;
  shortCapture: number;
  longCapture: number;
}

async function main() {
  const code = process.argv[2] || 'AG0';

  // 1. 加载数据 + 理论基准
  const bars = loadBars(code);
  console.log(`品种 ${code}: ${bars.length} 根日线`);
  const theory: Record<number, { longReturn: number; shortReturn: number; totalReturn: number }> = {};
  for (const th of THRESHOLDS) {
    const r = computeTheoreticalMax(bars, th);
    theory[th] = {
      longReturn: r.longReturn,
      shortReturn: r.shortReturn,
      totalReturn: r.totalReturn,
    };
  }
  console.log('\n=== 理论最大收益（完美摆动） ===');
  for (const th of THRESHOLDS) {
    const t = theory[th];
    console.log(`  ${th}%阈值: 做多+${(t.longReturn * 100).toFixed(0)}% 做空+${(t.shortReturn * 100).toFixed(0)}% 合计+${(t.totalReturn * 100).toFixed(0)}%`);
  }

  // 2. 定义方案（sideParams 只影响做空）
  const baseParams = {
    codes: [code],
    dataDir: DATA_DIR,
    warmupBars: 60,
    minSignalGrade: 'L2',
    maxHoldDays: 15,
    stopAtrMult: 1.5,
    targetAtrMult: 3.0,
    minRR: 1.0,
    cooldownBars: 0,
    trendFilter: false,
    returnAllTrades: true,
  };

  const schemes: { name: string; desc: string; params: Record<string, unknown> }[] = [
    { name: '基线', desc: '多空相同参数', params: {} },
    { name: '方案A', desc: '做空止损2.0×ATR', params: { sideParams: { short: { stopAtrMult: 2.0 } } } },
    { name: '方案B', desc: '做空趋势过滤', params: { sideParams: { short: { trendFilter: true } } } },
    { name: '方案C', desc: '做空门槛L3', params: { sideParams: { short: { minSignalGrade: 'L3' } } } },
    { name: '方案D', desc: '做空持有25天', params: { sideParams: { short: { maxHoldDays: 25 } } } },
  ];

  const results: SchemeResult[] = [];

  for (const scheme of schemes) {
    const opts = { ...baseParams, ...scheme.params };
    const res = await runBacktest(opts as any);
    const stat = analyzeTrades(res.trades as any, code);

    // 捕获率：策略价格收益 / 理论价格收益（用5%阈值作为主参考）
    const th5 = theory[5];
    const longCapture = th5.longReturn > 0 ? stat.longPriceReturn / th5.longReturn * 100 : 0;
    const shortCapture = th5.shortReturn > 0 ? stat.shortPriceReturn / th5.shortReturn * 100 : 0;

    results.push({
      name: scheme.name,
      desc: scheme.desc,
      params: scheme.params,
      stat,
      shortCapture,
      longCapture,
    });

    console.log(`\n──────── ${scheme.name}（${scheme.desc}）────────`);
    console.log(`  笔数: ${stat.totalTrades} | 胜率: ${(stat.winRate * 100).toFixed(1)}% | 盈亏比: ${stat.avgRR.toFixed(2)} | PF: ${stat.profitFactor.toFixed(2)}`);
    console.log(`  资金收益: ${(stat.capitalReturn * 100).toFixed(1)}% | 价格收益: ${(stat.priceReturn * 100).toFixed(1)}% | 回撤: ${(stat.maxDrawdown * 100).toFixed(1)}% | Sharpe: ${stat.sharpe.toFixed(2)}`);
    console.log(`  做多: ${stat.longTrades}笔 胜率${(stat.longWins / Math.max(stat.longTrades, 1) * 100).toFixed(1)}% 价格收益${(stat.longPriceReturn * 100).toFixed(0)}% (捕获率${longCapture.toFixed(1)}%)`);
    console.log(`  做空: ${stat.shortTrades}笔 胜率${(stat.shortWins / Math.max(stat.shortTrades, 1) * 100).toFixed(1)}% 价格收益${(stat.shortPriceReturn * 100).toFixed(0)}% (捕获率${shortCapture.toFixed(1)}%)`);
    console.log(`  微利占比: ${(stat.microWinRatio * 100).toFixed(1)}%`);
  }

  // 3. 汇总对比表
  console.log('\n\n========== 方案汇总对比 ==========');
  console.log('方案        做空捕获率   做多捕获率   整体PF    胜率    价格收益    回撤    微利占比   做空笔数');
  console.log('─'.repeat(110));
  for (const r of results) {
    const s = r.stat;
    console.log(
      `${r.name.padEnd(12)} ${r.shortCapture.toFixed(1).padStart(6)}%   ${r.longCapture.toFixed(1).padStart(6)}%    ` +
      `${s.profitFactor.toFixed(2).padStart(6)}   ${(s.winRate * 100).toFixed(1).padStart(5)}%  ` +
      `${(s.priceReturn * 100).toFixed(0).padStart(6)}%    ${(s.maxDrawdown * 100).toFixed(1).padStart(5)}%  ` +
      `${(s.microWinRatio * 100).toFixed(1).padStart(6)}%   ${s.shortTrades}`
    );
  }

  // 4. 选出最优方案
  console.log('\n========== 最优方案判定 ==========');
  // 主标准：做空捕获率最高（短板优先改善），次标准：整体PF最高
  const sortedByShort = [...results].sort((a, b) => b.shortCapture - a.shortCapture);
  const bestByShort = sortedByShort[0];
  const sortedByPF = [...results].sort((a, b) => b.stat.profitFactor - a.stat.profitFactor);
  const bestByPF = sortedByPF[0];

  console.log(`做空捕获率最优: ${bestByShort.name}（${bestByShort.shortCapture.toFixed(1)}%）`);
  console.log(`整体PF最优: ${bestByPF.name}（PF=${bestByPF.stat.profitFactor.toFixed(2)}）`);

  const finalBest = sortedByShort[0];
  console.log(`\n综合推荐: ${finalBest.name}（${finalBest.desc}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
