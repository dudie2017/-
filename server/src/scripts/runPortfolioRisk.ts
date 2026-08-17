/**
 * P2 组合风控分析：对 P1 筛选出的稳健品种做组合级回测与仓位优化
 *
 * 1. 相关性矩阵：6 品种日收益率 Pearson 相关 + 板块集中度
 * 2. 组合回测：日收益合成（等权 + 波动率加权）→ 组合权益/回撤/夏普
 * 3. 仓位优化：波动率倒数加权 + 目标回撤反推仓位上限
 */
import fs from 'fs';
import path from 'path';
import { loadBars, computeTheoreticalMax, runTop1Backtest } from './runTop1FullBacktest';
import type { TradeLike, Bar } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';

const CODES = ['CF0', 'AL0', 'RB0', 'SC0', 'NI0', 'IM0'];
const SECTORS: Record<string, string> = {
  CF0: '农产品',
  AL0: '有色',
  RB0: '黑色',
  SC0: '能源',
  NI0: '有色',
  IM0: '黑色',
};
const CAPITAL = 500_000;

// ============ 数学工具 ============
function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;
}
function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) * (v - m), 0) / (xs.length - 1));
}
function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return 0;
  const x = xs.slice(0, n);
  const y = ys.slice(0, n);
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    dx += (x[i] - mx) * (x[i] - mx);
    dy += (y[i] - my) * (y[i] - my);
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}
function maxDrawdown(equity: number[]): number {
  if (!equity.length) return 0;
  let peak = equity[0];
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = peak === 0 ? 0 : (peak - v) / peak;
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}
function sharpe(dailyReturns: number[]): number {
  const s = std(dailyReturns);
  return s === 0 ? 0 : (mean(dailyReturns) / s) * Math.sqrt(252);
}

// ============ 日收益率与持仓重建 ============
function dailyReturns(bars: { date: string; c: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].c;
    if (prev > 0) m.set(bars[i].date, bars[i].c / prev - 1);
  }
  return m;
}

/** 组合权益统计（已实现口径）：按平仓日累加 pnl */
function portfolioStats(trades: { exitDate: string; pnl: number }[], capital: number) {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = capital;
  let peak = capital;
  let mdd = 0;
  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak === 0 ? 0 : (peak - equity) / peak;
    if (dd > mdd) mdd = dd;
  }
  return { totalPnl: equity - capital, totalReturn: (equity - capital) / capital, mdd };
}

/** 月度夏普：按月聚合 pnl，月频收益序列 → 年化 */
function monthlySharpe(trades: { exitDate: string; pnl: number }[], capital: number): number {
  const monthly = new Map<string, number>();
  for (const t of trades) {
    const month = t.exitDate.slice(0, 7);
    monthly.set(month, (monthly.get(month) || 0) + t.pnl);
  }
  const rets = [...monthly.values()].map((p) => p / capital);
  const s = std(rets);
  return s === 0 ? 0 : (mean(rets) / s) * Math.sqrt(12);
}

// ============ 主流程 ============
async function main() {
  // 1. 加载 6 品种 bars + 跑回测拿 trades
  const varietyData: Record<string, { bars: { date: string; c: number }[]; trades: TradeLike[] }> = {};
  for (const code of CODES) {
    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);
    const recipe = TOP1_UNIFIED_PARAMS[code];
    const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');
    varietyData[code] = { bars, trades };
    console.log(`  ${code}: ${trades.length} 笔交易`);
  }

  // 2. 相关性矩阵（价格日收益率）
  const retMaps: Record<string, Map<string, number>> = {};
  for (const code of CODES) retMaps[code] = dailyReturns(varietyData[code].bars);

  const commonDates = [...retMaps[CODES[0]].keys()]
    .filter((d) => CODES.every((c) => retMaps[c].has(d)))
    .sort();

  const retSeries: Record<string, number[]> = {};
  for (const code of CODES) retSeries[code] = commonDates.map((d) => retMaps[code].get(d)!);

  const corrMatrix: Record<string, Record<string, number>> = {};
  for (const a of CODES) {
    corrMatrix[a] = {};
    for (const b of CODES) {
      corrMatrix[a][b] = a === b ? 1 : +pearson(retSeries[a], retSeries[b]).toFixed(3);
    }
  }

  // 年化波动率（价格日收益率）
  const vols: Record<string, number> = {};
  for (const code of CODES) vols[code] = std(retSeries[code]) * Math.sqrt(252);

  // 3. 组合回测（pnl 累加，已实现口径）
  const totalCapital = CAPITAL * CODES.length;
  const allTrades = CODES.flatMap((c) =>
    varietyData[c].trades.map((t) => ({ exitDate: t.exitDate, pnl: t.pnl, code: c }))
  );

  // 等权：每品种满仓 50 万，直接累加 pnl
  const eqPort = portfolioStats(allTrades, totalCapital);
  const eqSharpe = monthlySharpe(allTrades, totalCapital);

  // 波动率倒数加权：高波动品种降仓
  const invVol = CODES.map((c) => 1 / (vols[c] || 1e-9));
  const invVolSum = invVol.reduce((s, v) => s + v, 0);
  const volWeights: Record<string, number> = {};
  CODES.forEach((c, i) => (volWeights[c] = +(invVol[i] / invVolSum).toFixed(4)));
  const volTrades = allTrades.map((t) => ({ ...t, pnl: t.pnl * volWeights[t.code] * CODES.length }));
  const vwPort = portfolioStats(volTrades, totalCapital);
  const vwSharpe = monthlySharpe(volTrades, totalCapital);

  // 4. 仓位建议：目标组合波动率 10%
  const targetVol = 0.1;
  const positionSuggestion: Record<string, number> = {};
  for (const code of CODES) {
    positionSuggestion[code] = +(targetVol / (vols[code] * Math.sqrt(CODES.length))).toFixed(3);
  }

  // 板块集中度
  const sectorCount: Record<string, number> = {};
  for (const code of CODES) sectorCount[SECTORS[code]] = (sectorCount[SECTORS[code]] || 0) + 1;

  const result = {
    meta: { codes: CODES, generatedAt: new Date().toISOString(), targetVol, capitalPerVariety: CAPITAL, totalCapital },
    correlation: corrMatrix,
    volatility: vols,
    volWeights,
    positionSuggestion,
    sectorCount,
    equalWeight: { ...eqPort, sharpe: eqSharpe },
    volWeight: { ...vwPort, sharpe: vwSharpe },
  };

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `portfolio-risk-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log('\n已输出:', outPath);
  console.log('板块分布:', JSON.stringify(sectorCount));
  console.log('等权组合: 收益', (eqPort.totalReturn * 100).toFixed(1) + '%', '| 回撤', (eqPort.mdd * 100).toFixed(1) + '%', '| 夏普', eqSharpe.toFixed(2));
  console.log('波动率加权: 收益', (vwPort.totalReturn * 100).toFixed(1) + '%', '| 回撤', (vwPort.mdd * 100).toFixed(1) + '%', '| 夏普', vwSharpe.toFixed(2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
