/**
 * 全品种 20 年最终形态回测 (runAll20yFinalBacktest)
 *
 * 用途：验证当前 App 最强形态在全部品种 20 年数据上的整体效果
 * 形态：做多 = 每品种定向寻优/专项寻优参数（LONG_REFINED_PARAMS ?? LONG_OPT_PARAMS）；
 *       做空 = 每品种寻优最优参数（SHORT_OPT_PARAMS）；禁用品种砍做多腿
 *
 * 运行：cd server && npx tsx src/scripts/runAll20yFinalBacktest.ts
 * 输出：src/data/all20yFinalBacktest.json
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { computeTheoreticalMax } from './theoreticalMax';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { LONG_DISABLED } from '../data/longDisabledVarieties';
import { type V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OUT_DIR = path.join(process.cwd(), 'src/data');

// ============ 品种清单（数据充足 >=800根） ============
function listVarieties(): string[] {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json'));
  const codes: string[] = [];
  for (const f of files) {
    const code = f.replace('.json', '');
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      const bars = Array.isArray(raw) ? raw : raw.bars || [];
      if (bars.length >= 800) codes.push(code);
    } catch { /* skip */ }
  }
  return codes.sort();
}

// ============ 预扫描缓存 ============
async function prescanVariety(code: string): Promise<V16Row[]> {
  const fp = path.join(DATA_DIR, `${code}.json`);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, {
      edgeLookback: 70,
      allowRangeTrading: true,
    });
    rows.push(row);
  }
  return rows;
}

// ============ 指标计算 ============
interface TradeStat {
  totalTrades: number;
  wins: number;
  winRate: number;
  avgRR: number;
  totalPnl: number;
  totalReturn: number;
  profitFactor: number;
  longTrades: number;
  longWins: number;
  longPnl: number;
  longPF: number;      // 方向级盈亏比（做多）
  longPriceReturn: number; // 做多价格收益率累加（不含杠杆，捕获率分子）
  shortTrades: number;
  shortWins: number;
  shortPnl: number;
  shortPF: number;     // 方向级盈亏比（做空）
  shortPriceReturn: number; // 做空价格收益率累加（不含杠杆，捕获率分子）
  microWinRatio: number;
}

function calcStats(trades: any[]): TradeStat {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const longPnl = longTrades.reduce((s, t) => s + t.pnl, 0);
  const shortPnl = shortTrades.reduce((s, t) => s + t.pnl, 0);
  const longWins = longTrades.filter((t) => t.pnl > 0);
  const longLosses = longTrades.filter((t) => t.pnl <= 0);
  const shortWins = shortTrades.filter((t) => t.pnl > 0);
  const shortLosses = shortTrades.filter((t) => t.pnl <= 0);
  const longGrossWin = longWins.reduce((s, t) => s + t.pnl, 0);
  const longGrossLoss = Math.abs(longLosses.reduce((s, t) => s + t.pnl, 0));
  const shortGrossWin = shortWins.reduce((s, t) => s + t.pnl, 0);
  const shortGrossLoss = Math.abs(shortLosses.reduce((s, t) => s + t.pnl, 0));
  // 价格收益率（不含杠杆）：每笔 pnl 相对于入场合约价值的百分比之和
  const totalReturn = trades.reduce((s, t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    return s + (t.pnl / (entryVal * 1)) * 100;
  }, 0);
  // 方向级价格收益率累加（纯价格口径，与理论最大收益同口径）：
  // 做多 (exit-entry)/entry 累加；做空 (entry-exit)/entry 累加
  const longPriceReturn = longTrades.reduce((s, t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    const exitVal = Math.abs(t.exitPrice ?? t.entryPrice);
    return s + (exitVal - entryVal) / entryVal;
  }, 0);
  const shortPriceReturn = shortTrades.reduce((s, t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return s;
    const exitVal = Math.abs(t.exitPrice ?? t.entryPrice);
    return s + (entryVal - exitVal) / entryVal;
  }, 0);
  // 微利占比：盈利但每笔收益 < 0.05%（相对入场价）
  const microWins = wins.filter((t) => {
    const entryVal = Math.abs(t.entryPrice);
    if (!entryVal) return false;
    return t.pnl / entryVal < 0.0005;
  });
  // 平均盈亏比（经典口径）：总盈利 / 总亏损
  const avgRR = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgRR,
    totalPnl,
    totalReturn,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    longTrades: longTrades.length,
    longWins: longTrades.filter((t) => t.pnl > 0).length,
    longPnl,
    longPF: longGrossLoss > 0 ? longGrossWin / longGrossLoss : longGrossWin > 0 ? 99 : 0,
    longPriceReturn,
    shortTrades: shortTrades.length,
    shortWins: shortTrades.filter((t) => t.pnl > 0).length,
    shortPnl,
    shortPF: shortGrossLoss > 0 ? shortGrossWin / shortGrossLoss : shortGrossWin > 0 ? 99 : 0,
    shortPriceReturn,
    microWinRatio: trades.length ? microWins.length / trades.length : 0,
  };
}

// ============ 基线参数（当前App默认，与寻优脚本一致） ============
const BASE_OPTS = {
  minSignalGrade: 'L2' as string,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  warmupBars: 60,
  returnAllTrades: true,
  quiet: true,
};

// ============ 品种成功率判定（修正口径：排除微利假成功） ============
function isPassing(code: string, stats: TradeStat, side: 'long' | 'short'): boolean {
  const trades = side === 'long' ? stats.longTrades : stats.shortTrades;
  const pnl = side === 'long' ? stats.longPnl : stats.shortPnl;
  const wins = side === 'long' ? stats.longWins : stats.shortWins;
  const pf = side === 'long' ? stats.longPF : stats.shortPF;
  if (trades < 10) return false;              // 样本不足
  if (pnl <= 0) return false;                 // 必须盈利（收益额）
  const winRate = wins / trades;
  if (winRate < 0.45) return false;           // 胜率 >= 45%
  if (pf < 1.5) return false;                 // 方向级盈亏比 >= 1.5（排除微利假成功）
  return true;
}

// ============ 主流程 ============
async function main() {
  const argCodes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let codes = listVarieties();
  if (argCodes.length > 0) {
    codes = argCodes.filter((c) => codes.includes(c));
    console.log(`指定品种: ${codes.join(', ')}`);
  }
  const total = codes.length;
  console.log(`发现 ${total} 个数据充足品种`);

  const allResults: any[] = [];
  const allTradesBaseline: any[] = [];
  const allTradesFinal: any[] = [];
  const startAll = Date.now();

  for (let ci = 0; ci < total; ci++) {
    const code = codes[ci];
    const t0 = Date.now();
    console.log(`\n[${ci + 1}/${total}] 处理 ${code} ...`);

    // 预扫描缓存（扫描结果与交易参数无关，一次扫描两形态复用）
    const cacheRows = await prescanVariety(code);
    const signalCache = new Map<string, V16Row[]>();
    signalCache.set(code, cacheRows);

    // 理论最大收益（3%阈值，与捕获率基准一致）
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
    const rawBars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{ date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number }>;
    const theo = computeTheoreticalMax(rawBars, 3);
    console.log(`  预扫描完成: ${cacheRows.length} 个信号行 (${Date.now() - t0}ms)`);
    console.log(`  理论最大: 多段${theo.longSegments} 空段${theo.shortSegments} 多收益${(theo.longReturn * 100).toFixed(0)}% 空收益${(theo.shortReturn * 100).toFixed(0)}%`);

    // 形态1: 基线（当前App默认，多空一致）
    const baseline = await runBacktest({
      ...BASE_OPTS,
      codes: [code],
      dataDir: DATA_DIR,
      signalCache,
    } as any);
    const bStats = calcStats(baseline.trades || []);

    // 形态2: 最终形态（做多 = 定向寻优/专项寻优参数；做空 = 每品种寻优参数；禁用品种砍做多腿）
    const optShort = SHORT_OPT_PARAMS[code];
    const optLong = LONG_REFINED_PARAMS[code] ?? LONG_OPT_PARAMS[code];
    const final = await runBacktest({
      ...BASE_OPTS,
      codes: [code],
      dataDir: DATA_DIR,
      signalCache,
      // LH0：1000次实验结论，连亏3笔暂停10根K线（日线≈10个交易日）
      ...(code === 'LH0' ? { circuitBreaker: { lossStreak: 3, pauseBars: 10 } } : {}),
      sideParams: {
        ...(optLong ? { long: optLong } : {}),
        ...(optShort ? { short: optShort } : {}),
      },
    } as any);
    const fStats = calcStats(final.trades || []);

    allTradesBaseline.push(...(baseline.trades || []));
    allTradesFinal.push(...(final.trades || []));

    // 捕获率（价格收益率累加 / 理论最大收益）
    const longCapture = theo.longReturn > 0 ? fStats.longPriceReturn / theo.longReturn : 0;
    const shortCapture = theo.shortReturn > 0 ? fStats.shortPriceReturn / theo.shortReturn : 0;

    allResults.push({
      code,
      baseline: bStats,
      final: fStats,
      optShort: optShort || null,
      optLong: optLong || null,
      longDisabled: LONG_DISABLED.has(code),
      theo3: theo,
      capture: {
        long: longCapture,
        short: shortCapture,
      },
      pass: {
        long: isPassing(code, fStats, 'long'),
        short: isPassing(code, fStats, 'short'),
        both: isPassing(code, fStats, 'long') && isPassing(code, fStats, 'short'),
      },
    });

    console.log(`  基线: ${bStats.totalTrades}笔 多${bStats.longTrades}空${bStats.shortTrades} 赚${Math.round(bStats.totalPnl)}`);
    console.log(`  最终: ${fStats.totalTrades}笔 多${fStats.longTrades}空${fStats.shortTrades} 赚${Math.round(fStats.totalPnl)} 胜率${(fStats.winRate * 100).toFixed(1)}% PF${fStats.profitFactor.toFixed(2)}`);
    console.log(`    捕获率: 多${(longCapture * 100).toFixed(1)}% 空${(shortCapture * 100).toFixed(1)}%${LONG_DISABLED.has(code) ? ' [做多已砍腿]' : ''}`);
    if (optLong) {
      console.log(`    做多参数: 止损${optLong.stopAtrMult} 目标${optLong.targetAtrMult} 持有${optLong.maxHoldDays} 冷却${optLong.cooldownBars}`);
    }
    if (optShort) {
      console.log(`    做空参数: 止损${optShort.stopAtrMult} 目标${optShort.targetAtrMult} 持有${optShort.maxHoldDays} 冷却${optShort.cooldownBars}`);
    }
    console.log(`    耗时 ${Date.now() - t0}ms`);
  }

  // ===== 汇总统计 =====
  const totalBase = calcStats(allTradesBaseline);
  const totalFinal = calcStats(allTradesFinal);

  const passLong = allResults.filter((r) => r.pass.long).length;
  const passShort = allResults.filter((r) => r.pass.short).length;
  const passBoth = allResults.filter((r) => r.pass.both).length;

  console.log('\n' + '='.repeat(70));
  console.log('  全品种 20 年最终形态回测汇总');
  console.log('='.repeat(70));
  console.log(`  品种数: ${total}`);
  console.log('');
  console.log('  ┌──────────┬────────┬────────┬────────┬────────┬────────┬────────┐');
  console.log('  │ 形态      │ 笔数   │ 胜率   │ PF     │ 收益(元)│ 多盈亏  │ 空盈亏  │');
  console.log('  ├──────────┼────────┼────────┼────────┼────────┼────────┼────────┤');
  console.log(`  │ 基线      │ ${String(totalBase.totalTrades).padStart(6)} │ ${(totalBase.winRate * 100).toFixed(1).padStart(5)}% │ ${totalBase.profitFactor.toFixed(2).padStart(6)} │ ${Math.round(totalBase.totalPnl).toLocaleString().padStart(8)} │ ${Math.round(totalBase.longPnl).toLocaleString().padStart(6)} │ ${Math.round(totalBase.shortPnl).toLocaleString().padStart(6)} │`);
  console.log(`  │ 最终形态  │ ${String(totalFinal.totalTrades).padStart(6)} │ ${(totalFinal.winRate * 100).toFixed(1).padStart(5)}% │ ${totalFinal.profitFactor.toFixed(2).padStart(6)} │ ${Math.round(totalFinal.totalPnl).toLocaleString().padStart(8)} │ ${Math.round(totalFinal.longPnl).toLocaleString().padStart(6)} │ ${Math.round(totalFinal.shortPnl).toLocaleString().padStart(6)} │`);
  console.log('  └──────────┴────────┴────────┴────────┴────────┴────────┴────────┘');
  console.log('');
  console.log(`  方向级盈亏比（最终形态）: 做多 PF=${totalFinal.longPF.toFixed(2)}  做空 PF=${totalFinal.shortPF.toFixed(2)}`);
  console.log('');
  console.log(`  成功率（修正口径: 胜率>=45% 且 方向盈亏比>=1.5 且 收益>0）:`);
  console.log(`    做多: ${passLong}/${total} (${(passLong / total * 100).toFixed(1)}%)`);
  console.log(`    做空: ${passShort}/${total} (${(passShort / total * 100).toFixed(1)}%)`);
  console.log(`    双方向: ${passBoth}/${total} (${(passBoth / total * 100).toFixed(1)}%)`);
  console.log('');
  console.log(`  微利占比(最终): ${(totalFinal.microWinRatio * 100).toFixed(1)}%`);

  // 捕获率汇总（仅统计有最终交易的方向）
  const capLong = allResults.filter((r) => r.final.longTrades > 0 && r.theo3.longReturn > 0);
  const capShort = allResults.filter((r) => r.final.shortTrades > 0 && r.theo3.shortReturn > 0);
  const avgCapLong = capLong.length ? capLong.reduce((s, r) => s + r.capture.long, 0) / capLong.length : 0;
  const avgCapShort = capShort.length ? capShort.reduce((s, r) => s + r.capture.short, 0) / capShort.length : 0;
  const disabledCount = allResults.filter((r) => r.longDisabled).length;
  console.log('');
  console.log(`  捕获率（价格收益率累加 / 理论最大收益, 3%阈值）:`);
  console.log(`    做多均值: ${(avgCapLong * 100).toFixed(1)}%  (${capLong.length}品种)  做空均值: ${(avgCapShort * 100).toFixed(1)}%  (${capShort.length}品种)`);
  console.log(`    做多已砍腿品种: ${disabledCount} (${allResults.filter((r) => r.longDisabled).map((r) => r.code).join(', ') || '无'})`);
  console.log(`  总耗时: ${((Date.now() - startAll) / 1000).toFixed(1)}s`);

  // 保存
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFp = path.join(OUT_DIR, 'all20yFinalBacktest.json');
  fs.writeFileSync(outFp, JSON.stringify({
    meta: { total, generatedAt: new Date().toISOString(), elapsedMs: Date.now() - startAll },
    totalBaseline: totalBase,
    totalFinal: totalFinal,
    passCount: { long: passLong, short: passShort, both: passBoth },
    results: allResults,
  }, null, 2));
  console.log(`\n结果已保存到 ${outFp}`);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});

