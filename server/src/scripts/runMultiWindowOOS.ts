/**
 * 多窗口 OOS 稳健性验证脚本
 *
 * 用 top1UnifiedParams（改进评分后的新参数）对 59 品种各跑一次全量回测，
 * 得到完整逐笔 trades 后，按 5 个时间窗口切分统计，衡量"参数跨时间段稳健性"。
 *
 * 局限说明（重要）：
 *  - 参数仍是「全样本寻优」得来，signalCache 也是全量逐 bar 扫描；
 *  - 因此本脚本衡量的是「参数的时间稳健性」，不是严格的样本外预测能力；
 *  - 真正的 walk-forward（前段寻优 → 后段验证）需要 P0 补存 trades 后分段重跑。
 *
 * 用法：npx tsx src/scripts/runMultiWindowOOS.ts
 * 输出：backtest-results/multi-window-oos-{timestamp}.json
 */

import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import {
  runTop1Backtest,
  loadBars,
  computeTheoreticalMax,
  calcStats,
  type Bar,
  type TradeLike,
} from './runTop1FullBacktest';

const OUT_DIR = path.join(process.cwd(), 'backtest-results');

// 5 个时间窗口（数据范围约 2012-05 ~ 2026-08）
const WINDOWS = [
  { name: 'W1_2012-2015', start: '2012-01-01', end: '2015-12-31' },
  { name: 'W2_2016-2018', start: '2016-01-01', end: '2018-12-31' },
  { name: 'W3_2019-2021', start: '2019-01-01', end: '2021-12-31' },
  { name: 'W4_2022-2024', start: '2022-01-01', end: '2024-12-31' },
  { name: 'W5_2025-now', start: '2025-01-01', end: '2030-12-31' },
];

function filterTrades(trades: TradeLike[], start: string, end: string): TradeLike[] {
  return trades.filter((t) => t.entryDate >= start && t.entryDate <= end);
}

function sliceBars(bars: Bar[], start: string, end: string): Bar[] {
  return bars.filter((b) => b.date >= start && b.date <= end);
}

// 单品种多窗口统计
function multiWindowStats(code: string, trades: TradeLike[], bars: Bar[], capital: number) {
  const windows = WINDOWS.map((w) => {
    const wBars = sliceBars(bars, w.start, w.end);
    const wTrades = filterTrades(trades, w.start, w.end);
    const theo = wBars.length >= 30 ? computeTheoreticalMax(wBars, 3) : { longReturn: 0, shortReturn: 0 };
    const stats = calcStats(wTrades, theo.longReturn, theo.shortReturn, capital);
    return {
      name: w.name,
      bars: wBars.length,
      trades: stats.totalTrades,
      pnl: stats.totalPnl,
      dd: stats.maxDrawdown,
      winRate: stats.winRate,
      pf: stats.profitFactor,
      capture: stats.capture,
      profitable: stats.totalPnl > 0 && stats.totalTrades >= 5,
    };
  });

  const activeWindows = windows.filter((w) => w.trades >= 5);
  const profitableWindows = activeWindows.filter((w) => w.profitable);
  const robustRate = activeWindows.length > 0 ? profitableWindows.length / activeWindows.length : 0;

  return { code, windows, activeWindows: activeWindows.length, profitableWindows: profitableWindows.length, robustRate };
}

async function main() {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS).sort();
  console.log(`========== 多窗口 OOS 稳健性验证（${codes.length} 个品种 × 5 窗口） ==========`);
  const results: Record<string, any> = {};

  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    const recipe = TOP1_UNIFIED_PARAMS[code];
    const bars = loadBars(code);
    if (bars.length === 0) {
      results[code] = { code, error: 'no_data' };
      console.error(`[${i + 1}/${codes.length}] ${code} 无数据，跳过`);
      continue;
    }
    const theo = computeTheoreticalMax(bars, 3);
    console.log(`[${i + 1}/${codes.length}] ${code} 回测中（${bars.length} 根K线）...`);
    try {
      const r = await runTop1Backtest(code, recipe, bars, theo);
      const mw = multiWindowStats(code, r.trades, bars, Number(recipe.startCapital));
      results[code] = mw;
      console.log(
        `  ${code}: 跨窗口稳健率 ${(mw.robustRate * 100).toFixed(0)}%（${mw.profitableWindows}/${mw.activeWindows}），窗口收益 ${mw.windows.map((w) => `${Math.round(w.pnl).toLocaleString()}`).join(' / ')}`,
      );
    } catch (e) {
      console.error(`[${code}] 回测失败:`, (e as Error).message);
      results[code] = { code, error: String((e as Error).message) };
    }
  }

  // 汇总分级
  const graded = Object.values(results).filter((r) => !r.error);
  const high = graded.filter((r) => r.robustRate >= 0.6).length;   // 稳健率 ≥60%
  const mid = graded.filter((r) => r.robustRate >= 0.4 && r.robustRate < 0.6).length;
  const low = graded.filter((r) => r.robustRate < 0.4).length;

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(OUT_DIR, `multi-window-oos-${ts}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    outPath,
    JSON.stringify({
      meta: { generatedAt: ts, codes: codes.length, windows: WINDOWS.map((w) => w.name), note: '参数为全样本寻优，衡量时间稳健性而非严格样本外' },
      summary: { high: high, mid: mid, low: low },
      results,
    }, null, 2),
    'utf8',
  );
  console.log(`\n========== 汇总 ==========`);
  console.log(`稳健率≥60%: ${high} 个，40-60%: ${mid} 个，<40%: ${low} 个`);
  console.log(`结果已落盘: ${outPath}`);
}

if (process.argv[1]?.includes('runMultiWindowOOS.ts')) {
  main().catch((e) => {
    console.error('[多窗口 OOS 失败]', e);
    process.exit(1);
  });
}
