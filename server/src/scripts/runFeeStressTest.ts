/**
 * P4 手续费/滑点压力测试（Fee & Slippage Stress Test）
 *
 * 对 P3 筛选出的 4 个安全品种（RB0, SC0, CF0, NI0），
 * 测试在不同费率和滑点倍数下的生存能力。
 *
 * 压力档位：
 * - 费率：1x / 1.5x / 2x / 3x（相对 TOP1 配方的 feeMult）
 * - 滑点：1tick(基准) / 2tick / 3tick
 *
 * 判定标准：
 * - 生存：所有压力档位仍盈利
 * - 脆弱：2x 以上费率或 3tick 滑点导致亏损
 * - 淘汰：1.5x 费率即亏损
 */
import fs from 'fs';
import path from 'path';
import { loadBars, computeTheoreticalMax, runTop1Backtest, calcStats } from './runTop1FullBacktest';
import type { TradeLike, Stats } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';

// P3 筛选出的 4 个安全品种
const CODES = ['RB0', 'SC0', 'CF0', 'NI0'];

// 合约乘数（与 backtestEngine 一致）
const CONTRACT_MULTIPLIER: Record<string, number> = {
  RB0: 10, SC0: 1000, CF0: 5, NI0: 1,
};

// 合约规格（tickSize）
const TICK_SIZE: Record<string, number> = {
  RB0: 1, SC0: 1, CF0: 5, NI0: 10,
};

/** 对 trades 施加额外费率压力 */
function applyFeeStress(trades: TradeLike[], code: string, feeMultiplier: number): TradeLike[] {
  if (feeMultiplier === 1) return trades;
  const multiplier = CONTRACT_MULTIPLIER[code] || 10;
  return trades.map((t) => {
    const contractValue = Math.abs(t.entryPrice) * multiplier;
    const baseFee = contractValue * 0.00015 * 2;
    const extraFee = baseFee * (feeMultiplier - 1);
    return { ...t, pnl: t.pnl - extraFee };
  });
}

/** 对 trades 施加额外滑点压力（额外 N 个 tick） */
function applySlippageStress(trades: TradeLike[], code: string, extraTicks: number): TradeLike[] {
  if (extraTicks === 0) return trades;
  const multiplier = CONTRACT_MULTIPLIER[code] || 10;
  const tickSize = TICK_SIZE[code] || 1;
  const extraSlippage = tickSize * multiplier * extraTicks;
  return trades.map((t) => ({ ...t, pnl: t.pnl - extraSlippage }));
}

/** 计算权益曲线统计 */
function calcEquityStats(trades: TradeLike[], capital: number) {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = capital;
  let peak = capital;
  let mdd = 0;
  const monthly = new Map<string, number>();

  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak === 0 ? 0 : (peak - equity) / peak;
    if (dd > mdd) mdd = dd;

    const month = t.exitDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + t.pnl);
  }

  const totalPnl = equity - capital;
  const totalReturn = totalPnl / capital;

  // 月频夏普
  const rets = [...monthly.values()].map((p) => p / capital);
  const mean = rets.length ? rets.reduce((s, v) => s + v, 0) / rets.length : 0;
  const stdVal = rets.length > 1
    ? Math.sqrt(rets.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (rets.length - 1))
    : 0;
  const sharpe = stdVal === 0 ? 0 : (mean / stdVal) * Math.sqrt(12);

  // 盈亏比
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const profitFactor = avgLoss === 0 ? 999 : (avgWin * wins.length) / (avgLoss * losses.length || 1);

  return { totalPnl, totalReturn, mdd, sharpe, profitFactor, totalTrades: trades.length };
}

interface StressResult {
  code: string;
  baselineFeeMult: number;
  baseline: { totalPnl: number; totalReturn: number; mdd: number; sharpe: number; profitFactor: number; totalTrades: number };
  feeStress: {
    multiplier: number;
    totalPnl: number;
    totalReturn: number;
    mdd: number;
    sharpe: number;
    profitFactor: number;
    pnlChangePct: number;
    verdict: 'survive' | 'fragile' | 'dead';
  }[];
  slippageStress: {
    extraTicks: number;
    totalPnl: number;
    totalReturn: number;
    mdd: number;
    sharpe: number;
    profitFactor: number;
    pnlChangePct: number;
    verdict: 'survive' | 'fragile' | 'dead';
  }[];
  summary: {
    feeBreakPoint: string;  // 费率盈亏平衡点
    slippageBreakPoint: string;  // 滑点盈亏平衡点
    overallVerdict: 'survive' | 'fragile' | 'dead';
  };
}

async function main() {
  const results: StressResult[] = [];

  for (const code of CODES) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`${code} 费率/滑点压力测试`);
    console.log('='.repeat(50));

    const recipe = TOP1_UNIFIED_PARAMS[code];
    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);
    const capital = recipe.startCapital;

    // 跑 baseline（用 TOP1 原始 feeMult）
    const { trades: baselineTrades } = await runTop1Backtest(code, recipe, bars, theo, 'full');
    const baselineStats = calcEquityStats(baselineTrades, capital);
    console.log(`  Baseline (feeMult=${recipe.feeMult}): 收益 ${baselineStats.totalPnl.toFixed(0)} | 回撤 ${(baselineStats.mdd * 100).toFixed(1)}% | 夏普 ${baselineStats.sharpe.toFixed(2)} | 交易 ${baselineStats.totalTrades}`);

    // 费率压力测试：1x, 1.5x, 2x, 3x（相对 baseline 的 feeMult）
    const feeMultipliers = [1, 1.5, 2, 3];
    const feeStress: StressResult['feeStress'] = [];

    for (const mult of feeMultipliers) {
      const stressedTrades = applyFeeStress(baselineTrades, code, mult);
      const stats = calcEquityStats(stressedTrades, capital);
      const changePct = baselineStats.totalPnl !== 0
        ? (stats.totalPnl - baselineStats.totalPnl) / Math.abs(baselineStats.totalPnl) * 100
        : 0;

      let verdict: 'survive' | 'fragile' | 'dead';
      if (stats.totalPnl < 0) {
        verdict = 'dead';
      } else if (mult >= 2 && changePct < -50) {
        verdict = 'fragile';
      } else {
        verdict = 'survive';
      }

      feeStress.push({
        multiplier: mult,
        totalPnl: stats.totalPnl,
        totalReturn: stats.totalReturn,
        mdd: stats.mdd,
        sharpe: stats.sharpe,
        profitFactor: stats.profitFactor,
        pnlChangePct: +changePct.toFixed(1),
        verdict,
      });

      const icon = verdict === 'survive' ? '✅' : verdict === 'fragile' ? '⚠️' : '❌';
      console.log(`  ${icon} 费率 ${mult}x: 收益 ${stats.totalPnl.toFixed(0)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`);
    }

    // 滑点压力测试：基准 1tick，额外 +0, +1, +2 tick
    const extraTicksList = [0, 1, 2];
    const slippageStress: StressResult['slippageStress'] = [];

    for (const extraTicks of extraTicksList) {
      const stressedTrades = applySlippageStress(baselineTrades, code, extraTicks);
      const stats = calcEquityStats(stressedTrades, capital);
      const changePct = baselineStats.totalPnl !== 0
        ? (stats.totalPnl - baselineStats.totalPnl) / Math.abs(baselineStats.totalPnl) * 100
        : 0;

      let verdict: 'survive' | 'fragile' | 'dead';
      if (stats.totalPnl < 0) {
        verdict = 'dead';
      } else if (extraTicks >= 2 && changePct < -50) {
        verdict = 'fragile';
      } else {
        verdict = 'survive';
      }

      slippageStress.push({
        extraTicks,
        totalPnl: stats.totalPnl,
        totalReturn: stats.totalReturn,
        mdd: stats.mdd,
        sharpe: stats.sharpe,
        profitFactor: stats.profitFactor,
        pnlChangePct: +changePct.toFixed(1),
        verdict,
      });

      const icon = verdict === 'survive' ? '✅' : verdict === 'fragile' ? '⚠️' : '❌';
      console.log(`  ${icon} 滑点 +${extraTicks}tick: 收益 ${stats.totalPnl.toFixed(0)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%)`);
    }

    // 找盈亏平衡点
    let feeBreakPoint = '>3x';
    for (const f of feeStress) {
      if (f.totalPnl < 0) { feeBreakPoint = `${f.multiplier}x`; break; }
    }
    let slippageBreakPoint = '>+2tick';
    for (const s of slippageStress) {
      if (s.totalPnl < 0) { slippageBreakPoint = `+${s.extraTicks}tick`; break; }
    }

    const hasDead = feeStress.some((f) => f.verdict === 'dead') || slippageStress.some((s) => s.verdict === 'dead');
    const hasFragile = feeStress.some((f) => f.verdict === 'fragile') || slippageStress.some((s) => s.verdict === 'fragile');
    const overallVerdict: 'survive' | 'fragile' | 'dead' = hasDead ? 'dead' : hasFragile ? 'fragile' : 'survive';

    const summary = { feeBreakPoint, slippageBreakPoint, overallVerdict };
    console.log(`\n  汇总: 费率盈亏平衡 ${feeBreakPoint} | 滑点盈亏平衡 ${slippageBreakPoint} | 总评: ${overallVerdict}`);

    results.push({
      code,
      baselineFeeMult: recipe.feeMult,
      baseline: baselineStats,
      feeStress,
      slippageStress,
      summary,
    });
  }

  // 输出 JSON
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `fee-stress-test-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\n已输出: ${outPath}`);

  // 总评
  console.log('\n' + '='.repeat(60));
  console.log('P4 费率/滑点压力测试 — 总评');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.summary.overallVerdict === 'survive' ? '✅' : r.summary.overallVerdict === 'fragile' ? '⚠️' : '❌';
    console.log(`  ${icon} ${r.code}: ${r.summary.overallVerdict} (费率平衡 ${r.summary.feeBreakPoint} | 滑点平衡 ${r.summary.slippageBreakPoint})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
