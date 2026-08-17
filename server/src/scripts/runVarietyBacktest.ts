/**
 * 单品种回测对比脚本
 *
 * 用途：对单个品种运行策略回测，并与"理论最大收益（完美摆动交易者）"对比捕获率
 *
 * 用法：
 *   npx tsx src/scripts/runVarietyBacktest.ts AG0 [stopAtrMult] [targetAtrMult] [maxHoldDays] [minSignalGrade] [trendFilter] [cooldownBars]
 *
 * 口径说明：
 * - 理论最大收益：无杠杆的价格收益率（每段 swing 低→高 吃满涨幅、高→低 吃满跌幅，反手开仓）
 * - 策略收益：按"价格收益率"计算（单笔 = 价差/入场价，不含仓位杠杆），与理论基准同口径
 * - 捕获率 = 策略价格收益率累加 / 理论价格收益率
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { loadBars, computeTheoreticalMax } from './theoreticalMax';

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

export const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
export const THRESHOLDS = [3, 5, 8];

export interface TradeRecord {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  signalDate: string;
  exitDate: string | null;
}

interface StrategyStat {
  code: string;
  params: Record<string, unknown>;
  totalTrades: number;
  winRate: number;
  avgRR: number;
  profitFactor: number;
  maxDrawdown: number;
  sharpe: number;
  capitalReturn: number;       // 资金收益率（杠杆，仅参考）
  priceReturn: number;         // 价格收益率累加（无杠杆，与理论对比用）
  longTrades: number;
  longWins: number;
  longPriceReturn: number;
  shortTrades: number;
  shortWins: number;
  shortPriceReturn: number;
  microWinRatio: number;       // 微利占比（单笔价格收益 < 0.5%）
}

export function calcPriceReturn(t: TradeRecord): number {
  if (t.direction === 'LONG') return (t.exitPrice - t.entryPrice) / t.entryPrice;
  return (t.entryPrice - t.exitPrice) / t.entryPrice;
}

export function analyzeTrades(trades: TradeRecord[], code: string): Omit<StrategyStat, 'params' | 'code'> {
  const total = trades.length;
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let priceReturn = 0;
  let longTrades = 0, longWins = 0, longPriceReturn = 0;
  let shortTrades = 0, shortWins = 0, shortPriceReturn = 0;
  let microCount = 0;

  for (const t of trades) {
    const pr = calcPriceReturn(t);
    priceReturn += pr;
    if (pr > 0) {
      wins++;
      grossWin += pr;
    } else {
      grossLoss += Math.abs(pr);
    }
    if (Math.abs(pr) < 0.005) microCount++;

    if (t.direction === 'LONG') {
      longTrades++;
      longPriceReturn += pr;
      if (pr > 0) longWins++;
    } else {
      shortTrades++;
      shortPriceReturn += pr;
      if (pr > 0) shortWins++;
    }
  }

  const winRate = total ? wins / total : 0;
  const avgWin = wins ? grossWin / wins : 0;
  const avgLoss = total - wins ? grossLoss / (total - wins) : 0;
  const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (wins > 0 ? 99 : 0);
  const microWinRatio = total ? microCount / total : 0;

  return {
    totalTrades: total,
    winRate,
    avgRR,
    profitFactor,
    maxDrawdown: 0, // 由 runBacktest summary 覆盖
    sharpe: 0,
    capitalReturn: 0,
    priceReturn,
    longTrades,
    longWins,
    longPriceReturn,
    shortTrades,
    shortWins,
    shortPriceReturn,
    microWinRatio,
  };
}

async function main() {
  const code = (process.argv[2] || 'AG0').toUpperCase();
  const stopAtrMult = process.argv[3] ? parseFloat(process.argv[3]) : 1.5;
  const targetAtrMult = process.argv[4] ? parseFloat(process.argv[4]) : 3.0;
  const maxHoldDays = process.argv[5] ? parseInt(process.argv[5]) : 15;
  const minSignalGrade = process.argv[6] || 'L2';
  const trendFilter = process.argv[7] ? process.argv[7] === '1' : false;
  const cooldownBars = process.argv[8] ? parseInt(process.argv[8]) : 0;

  const bars = loadBars(code) as unknown as Bar[];
  if (!bars.length) {
    console.error(`[错误] 未找到 ${code} 的数据`);
    return;
  }
  console.log(`\n[品种] ${code} | 数据: ${bars.length}根日线 (${bars[0].date} ~ ${bars[bars.length - 1].date})\n`);

  // ========== 1. 理论最大收益基准 ==========
  console.log('【理论最大收益基准（完美摆动交易者）】');
  console.log('阈值    做多段  做空段  做多收益   做空收益   合计收益    平均做多/段 平均做空/段  计费后');
  const theory: Record<number, ReturnType<typeof computeTheoreticalMax>> = {};
  for (const th of THRESHOLDS) {
    const r = computeTheoreticalMax(bars, th);
    theory[th] = r;
    console.log(
      `${th}%     ${String(r.longSegments).padStart(4)}   ${String(r.shortSegments).padStart(5)}   ` +
      `${(r.longReturn * 100).toFixed(0).padStart(6)}%   ${(r.shortReturn * 100).toFixed(0).padStart(6)}%   ` +
      `${(r.totalReturn * 100).toFixed(0).padStart(6)}%   ${(r.avgLongMovePct * 100).toFixed(1).padStart(6)}%   ` +
      `${(r.avgShortMovePct * 100).toFixed(1).padStart(6)}%   ${(r.withFeeReturn * 100).toFixed(0)}%`
    );
  }

  // ========== 2. 策略回测（复用 runBacktest） ==========
  const params = {
    codes: [code],
    dataDir: DATA_DIR,
    minSignalGrade,
    maxHoldDays,
    stopAtrMult,
    targetAtrMult,
    minRR: 1.0,
    cooldownBars,
    trendFilter,
    warmupBars: 60,
    returnAllTrades: true,
  };

  console.log(`\n【策略回测】止损${stopAtrMult}×ATR 目标${targetAtrMult}×ATR 持有${maxHoldDays}天 ${minSignalGrade} 趋势过滤:${trendFilter ? '开' : '关'} 冷却:${cooldownBars}天`);
  const result = await runBacktest(params as never);
  const s = result.summary as {
    totalSignals?: number;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    totalReturn: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
  const trades = (result.trades || []) as unknown as TradeRecord[];
  const stat = analyzeTrades(trades, code);
  stat.maxDrawdown = s.maxDrawdown;
  stat.sharpe = s.sharpeRatio;
  stat.capitalReturn = s.totalReturn;

  console.log(`\n策略资金收益率(15%仓+杠杆): ${(s.totalReturn * 100).toFixed(1)}%`);
  console.log(`策略价格收益率(无杠杆,同口径): ${(stat.priceReturn * 100).toFixed(1)}%`);
  console.log(`笔数: ${stat.totalTrades} | 胜率: ${(stat.winRate * 100).toFixed(1)}% | 盈亏比: ${stat.avgRR.toFixed(2)} | PF: ${stat.profitFactor.toFixed(2)} | 回撤: ${(stat.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`做多: ${stat.longTrades}笔 胜率${stat.longTrades ? (stat.longWins / stat.longTrades * 100).toFixed(1) : '0'}% 价格收益${(stat.longPriceReturn * 100).toFixed(1)}%`);
  console.log(`做空: ${stat.shortTrades}笔 胜率${stat.shortTrades ? (stat.shortWins / stat.shortTrades * 100).toFixed(1) : '0'}% 价格收益${(stat.shortPriceReturn * 100).toFixed(1)}%`);
  console.log(`微利占比(单笔<0.5%): ${(stat.microWinRatio * 100).toFixed(1)}%`);

  // ========== 3. 捕获率对比 ==========
  console.log('\n【捕获率对比】（策略价格收益率 ÷ 理论最大收益）');
  console.log('阈值    理论最大    策略价格收益   捕获率');
  for (const th of THRESHOLDS) {
    const theo = theory[th];
    const capRate = theo.totalReturn > 0 ? stat.priceReturn / theo.totalReturn : 0;
    console.log(
      `${th}%     ${(theo.totalReturn * 100).toFixed(0).padStart(6)}%   ` +
      `${(stat.priceReturn * 100).toFixed(1).padStart(8)}%   ${(capRate * 100).toFixed(1).padStart(5)}%`
    );
  }

  // 做多/做空捕获率（用3%阈值做参考）
  const theo3 = theory[3];
  const longCap = theo3.longReturn > 0 ? stat.longPriceReturn / theo3.longReturn : 0;
  const shortCap = theo3.shortReturn > 0 ? stat.shortPriceReturn / theo3.shortReturn : 0;
  console.log(`\n做多捕获率(3%基准): ${(longCap * 100).toFixed(1)}% | 做空捕获率(3%基准): ${(shortCap * 100).toFixed(1)}%`);

  // 保存结果
  const outDir = path.join(process.cwd(), 'src', 'data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${code}_backtest.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    code,
    params: { stopAtrMult, targetAtrMult, maxHoldDays, minSignalGrade, trendFilter, cooldownBars },
    theory,
    strategy: { summary: s, stat, trades: trades.slice(-50) },
  }, null, 2));
  console.log(`\n[已保存] ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
