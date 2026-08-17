/**
 * 方案集成验证：白银 AG0 组合最优解
 * - 做多: 方案1 Pareto P1 (stop 1.93 / target 6.92 / hold 53 / cooldown 6 / L2)
 * - 做空: 方案2 最佳做空 (stop 2.94 / target 4.41 / hold 44 / cooldown 5 / trendFilter true / L2)
 * - 熔断: 连亏 4 笔暂停 10 天（方案6 最优）
 * 对比基线：胜率 / 单次回报(avgRR) / 捕获率 / 回撤 四项指标
 */
import * as fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { computeTheoreticalMax, loadBars } from './theoreticalMax';

const DATA_DIR = path.resolve(process.cwd(), 'data-cache-daily-20y');
const CODE = 'AG0';
const OUT = path.resolve(process.cwd(), 'src/data/AG0_integrated.json');

const BASE_OPTS = {
  warmupBars: 60,
  minSignalGrade: 'L2' as string,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  returnAllTrades: true,
  quiet: true,
};

async function prescan(CODE: string) {
  const bars = loadBars(CODE);
  const rows: any[] = [];
  for (let i = 60; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(CODE, histBars as any, CODE, {
      edgeLookback: 10,
    });
    rows.push(row);
  }
  return rows;
}

interface TradeLike {
  direction?: string;
  pnl?: number;
  entryDate?: string;
  exitDate?: string;
  exitReason?: string;
  entryPrice?: number;
  [k: string]: unknown;
}

interface Stats {
  totalTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  avgRR: number;
  longTrades: number;
  shortTrades: number;
  maxDrawdown: number;
}

function calcStats(trades: TradeLike[]): Stats {
  const wins = trades.filter((t) => (t.pnl || 0) > 0).length;
  const losses = trades.length - wins;
  const grossWin = trades.filter((t) => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(trades.filter((t) => (t.pnl || 0) <= 0).reduce((s, t) => s + (t.pnl || 0), 0));
  // 资金曲线回撤（按 exitDate 排序）
  const sorted = [...trades].sort((a, b) => String(a.exitDate || '').localeCompare(String(b.exitDate || '')));
  let peak = 0;
  let equity = 0;
  let maxDd = 0;
  for (const t of sorted) {
    equity += t.pnl || 0;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / Math.abs(peak) : 0;
    if (dd > maxDd) maxDd = dd;
  }
  return {
    totalTrades: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    totalPnl: trades.reduce((s, t) => s + (t.pnl || 0), 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0),
    avgRR: losses > 0 ? (grossWin / wins) / (grossLoss / losses) : (wins ? 99 : 0),
    longTrades: trades.filter((t) => t.direction === 'LONG').length,
    shortTrades: trades.filter((t) => t.direction === 'SHORT').length,
    maxDrawdown: maxDd,
  };
}

function applyCircuitBreaker(trades: TradeLike[], lossStreak: number, pauseDays: number): TradeLike[] {
  const out: TradeLike[] = [];
  let streak = 0;
  let frozenUntil = '';
  for (const t of trades) {
    if (frozenUntil && (!t.entryDate || t.entryDate < frozenUntil)) continue;
    out.push(t);
    if ((t.pnl || 0) <= 0) {
      streak++;
      if (streak >= lossStreak) {
        frozenUntil = addDays(t.exitDate || t.entryDate || '', pauseDays);
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return out;
}

function addDays(dateStr: string, days: number): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function calcPriceReturn(trades: TradeLike[], dir: string): number {
  return trades
    .filter((t) => t.direction === dir && Math.abs(Number((t as any).entryPrice) || 0) > 0)
    .reduce((s, t) => {
      const entry = Math.abs(Number((t as any).entryPrice) || 0);
      const exit = Math.abs(Number((t as any).exitPrice) || 0);
      if (!entry || !exit) return s;
      const move = dir === 'LONG' ? (exit - entry) / entry : (entry - exit) / entry;
      return s + move;
    }, 0);
}

async function main() {
  const rows = await prescan(CODE);
  console.log(`预扫描完成: ${rows.length} 个信号行`);

  const bars = loadBars(CODE) as any[];
  const theo = await computeTheoreticalMax(bars, 3);
  const signalCache = new Map<string, any[]>();
  signalCache.set(CODE, rows);

  // 基线：当前实盘参数（LONG_OPT_PARAMS/SHORT_OPT_PARAMS AG0）
  const baseLong = { stopAtrMult: 1.53, targetAtrMult: 5.61, maxHoldDays: 37, cooldownBars: 0, trendFilter: false, minSignalGrade: 'L1' };
  const baseShort = { stopAtrMult: 2.45, targetAtrMult: 2.85, maxHoldDays: 40, cooldownBars: 4, trendFilter: false, minSignalGrade: 'L1' };

  // 组合：P1 做多 + bestShort 做空
  const optLong = { stopAtrMult: 1.93, targetAtrMult: 6.92, maxHoldDays: 53, cooldownBars: 6, trendFilter: false, minSignalGrade: 'L2' };
  const optShort = { stopAtrMult: 2.94, targetAtrMult: 4.41, maxHoldDays: 44, cooldownBars: 5, trendFilter: true, minSignalGrade: 'L2' };

  const runBt = async (longP: any, shortP: any) => {
    const res = await runBacktest({
      ...BASE_OPTS,
      codes: [CODE],
      dataDir: DATA_DIR,
      signalCache,
      sideParams: { long: { ...BASE_OPTS, ...longP }, short: { ...BASE_OPTS, ...shortP } },
    } as any);
    return ((res?.trades || []) as unknown) as TradeLike[];
  };

  const baseTrades = await runBt(baseLong, baseShort);
  const optTrades = await runBt(optLong, optShort);
  const cbTrades = applyCircuitBreaker(optTrades, 4, 10);

  const baseStats = calcStats(baseTrades);
  const optStats = calcStats(optTrades);
  const cbStats = calcStats(cbTrades);

  // 捕获率（按方向）
  const longReturn = (theo as any).longReturn || 0;
  const shortReturn = (theo as any).shortReturn || 0;
  const captureOf = (tr: TradeLike[]) => ({
    long: longReturn > 0 ? calcPriceReturn(tr, 'LONG') / longReturn : 0,
    short: shortReturn > 0 ? calcPriceReturn(tr, 'SHORT') / shortReturn : 0,
  });

  const out = {
    code: CODE,
    theo: { longReturn, shortReturn },
    baseline: { params: { long: baseLong, short: baseShort }, stats: baseStats, capture: captureOf(baseTrades) },
    optimized: { params: { long: optLong, short: optShort }, stats: optStats, capture: captureOf(optTrades) },
    optimizedWithCB: { params: { long: optLong, short: optShort, circuitBreaker: { lossStreak: 4, pauseDays: 10 } }, stats: cbStats, capture: captureOf(cbTrades) },
    conclusion: '',
  };

  const base = baseStats;
  const cb = cbStats;
  const bc = captureOf(baseTrades);
  const cc = captureOf(cbTrades);
  const improvements = {
    winRate: (cb.winRate - base.winRate) * 100,
    avgRR: cb.avgRR - base.avgRR,
    capture: ((cc.long + cc.short) - (bc.long + bc.short)) * 100,
    maxDrawdown: (cb.maxDrawdown - base.maxDrawdown) * 100,
    pnl: (cb.totalPnl - base.totalPnl) / 10000,
  };
  out.conclusion = JSON.stringify(improvements);
  console.log('===== 基线 vs 组合最优(含熔断) =====');
  console.log('指标          基线       组合+熔断');
  console.log(`胜率       ${(base.winRate * 100).toFixed(1)}%   ${(cb.winRate * 100).toFixed(1)}%`);
  console.log(`avgRR      ${base.avgRR.toFixed(2)}     ${cb.avgRR.toFixed(2)}`);
  console.log(`收益(万)   ${(base.totalPnl / 10000).toFixed(1)}     ${(cb.totalPnl / 10000).toFixed(1)}`);
  console.log(`捕获率L    ${(bc.long * 100).toFixed(1)}%   ${(cc.long * 100).toFixed(1)}%`);
  console.log(`捕获率S    ${(bc.short * 100).toFixed(1)}%   ${(cc.short * 100).toFixed(1)}%`);
  console.log(`最大回撤   ${(base.maxDrawdown * 100).toFixed(1)}%   ${(cb.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`交易数     ${base.totalTrades}     ${cb.totalTrades}`);
  console.log('');
  console.log('四项改善:', JSON.stringify(improvements));
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('已保存:', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
