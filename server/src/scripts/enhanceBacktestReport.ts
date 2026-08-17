/**
 * 回测报告增强 - 生成可视化数据
 * 
 * 功能：
 * 1. 权益曲线数据
 * 2. 回撤热力图数据
 * 3. 月度收益热力图数据
 * 4. 年度收益统计
 * 5. 滚动指标数据
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.js';
import { loadBars, runTop1Backtest } from './runTop1FullBacktest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

const VARIETIES = ['CF0', 'CU0', 'HC0'];

interface EquityPoint {
  date: string;
  equity: number;
  drawdown: number;
  drawdownPct: number;
}

interface MonthlyReturn {
  year: number;
  month: number;
  returnPct: number;
  pnl: number;
}

interface YearlyStats {
  year: number;
  totalPnl: number;
  returnPct: number;
  maxDrawdown: number;
  sharpe: number;
  winRate: number;
  tradeCount: number;
}

interface RollingMetrics {
  date: string;
  rolling6mReturn: number;
  rolling12mReturn: number;
  rolling6mVol: number;
  rolling12mVol: number;
  rolling6mSharpe: number;
  rolling12mSharpe: number;
}

interface VarietyReport {
  variety: string;
  equityCurve: EquityPoint[];
  monthlyReturns: MonthlyReturn[];
  yearlyStats: YearlyStats[];
  rollingMetrics: RollingMetrics[];
  summary: {
    totalPnl: number;
    totalReturn: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    calmar: number;
    sharpe: number;
    winRate: number;
    profitFactor: number;
    avgTradePnl: number;
    totalTrades: number;
    avgHoldDays: number;
  };
}

function calcEquityCurve(trades: any[], startCapital: number): EquityPoint[] {
  const points: EquityPoint[] = [];
  let equity = startCapital;
  let peak = startCapital;

  // Group trades by exit date
  const tradesByDate = new Map<string, number>();
  for (const t of trades) {
    const date = t.exitDate;
    const pnl = t.pnl || 0;
    tradesByDate.set(date, (tradesByDate.get(date) || 0) + pnl);
  }

  // Sort dates
  const dates = Array.from(tradesByDate.keys()).sort();

  for (const date of dates) {
    const pnl = tradesByDate.get(date) || 0;
    equity += pnl;
    peak = Math.max(peak, equity);
    const drawdown = equity - peak;
    const drawdownPct = peak > 0 ? drawdown / peak : 0;

    points.push({
      date,
      equity,
      drawdown,
      drawdownPct,
    });
  }

  return points;
}

function calcMonthlyReturns(trades: any[]): MonthlyReturn[] {
  const monthlyPnl = new Map<string, number>();

  for (const t of trades) {
    const exitDate = new Date(t.exitDate);
    const key = `${exitDate.getFullYear()}-${exitDate.getMonth() + 1}`;
    const pnl = t.pnl || 0;
    monthlyPnl.set(key, (monthlyPnl.get(key) || 0) + pnl);
  }

  const returns: MonthlyReturn[] = [];
  const startCapital = 1000000;
  let cumPnl = 0;

  const sortedKeys = Array.from(monthlyPnl.keys()).sort();
  for (const key of sortedKeys) {
    const [year, month] = key.split('-').map(Number);
    const pnl = monthlyPnl.get(key) || 0;
    cumPnl += pnl;
    const capital = startCapital + cumPnl - pnl;
    const returnPct = capital > 0 ? (pnl / capital) * 100 : 0;

    returns.push({ year, month, returnPct, pnl });
  }

  return returns;
}

function calcYearlyStats(trades: any[]): YearlyStats[] {
  const yearlyData = new Map<number, { pnls: number[]; trades: any[] }>();

  for (const t of trades) {
    const year = new Date(t.exitDate).getFullYear();
    if (!yearlyData.has(year)) {
      yearlyData.set(year, { pnls: [], trades: [] });
    }
    yearlyData.get(year)!.pnls.push(t.pnl || 0);
    yearlyData.get(year)!.trades.push(t);
  }

  const stats: YearlyStats[] = [];
  const startCapital = 1000000;

  for (const [year, data] of yearlyData) {
    const totalPnl = data.pnls.reduce((a, b) => a + b, 0);
    const returnPct = (totalPnl / startCapital) * 100;

    // Calculate max drawdown for the year
    let equity = startCapital;
    let peak = startCapital;
    let maxDd = 0;
    for (const pnl of data.pnls) {
      equity += pnl;
      peak = Math.max(peak, equity);
      const dd = (peak - equity) / peak;
      maxDd = Math.max(maxDd, dd);
    }

    // Calculate Sharpe
    const avgPnl = totalPnl / data.pnls.length;
    const stdPnl = Math.sqrt(data.pnls.reduce((sum, p) => sum + Math.pow(p - avgPnl, 2), 0) / data.pnls.length);
    const sharpe = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(12) : 0;

    // Win rate
    const wins = data.pnls.filter(p => p > 0).length;
    const winRate = data.pnls.length > 0 ? (wins / data.pnls.length) * 100 : 0;

    stats.push({
      year,
      totalPnl,
      returnPct,
      maxDrawdown: maxDd * 100,
      sharpe,
      winRate,
      tradeCount: data.trades.length,
    });
  }

  return stats.sort((a, b) => a.year - b.year);
}

function calcRollingMetrics(equityCurve: EquityPoint[]): RollingMetrics[] {
  const metrics: RollingMetrics[] = [];
  const window6m = 126; // ~6 months of trading days
  const window12m = 252; // ~12 months of trading days

  for (let i = 0; i < equityCurve.length; i++) {
    const point = equityCurve[i];

    // 6-month rolling
    const start6m = Math.max(0, i - window6m);
    const equity6m = equityCurve[start6m].equity;
    const return6m = equity6m > 0 ? ((point.equity - equity6m) / equity6m) * 100 : 0;

    // Calculate 6-month volatility
    const returns6m: number[] = [];
    for (let j = start6m + 1; j <= i; j++) {
      const prev = equityCurve[j - 1].equity;
      const curr = equityCurve[j].equity;
      if (prev > 0) returns6m.push((curr - prev) / prev);
    }
    const avg6m = returns6m.reduce((a, b) => a + b, 0) / returns6m.length;
    const vol6m = Math.sqrt(returns6m.reduce((sum, r) => sum + Math.pow(r - avg6m, 2), 0) / returns6m.length) * Math.sqrt(252);
    const sharpe6m = vol6m > 0 ? (return6m / 100) / vol6m : 0;

    // 12-month rolling
    const start12m = Math.max(0, i - window12m);
    const equity12m = equityCurve[start12m].equity;
    const return12m = equity12m > 0 ? ((point.equity - equity12m) / equity12m) * 100 : 0;

    const returns12m: number[] = [];
    for (let j = start12m + 1; j <= i; j++) {
      const prev = equityCurve[j - 1].equity;
      const curr = equityCurve[j].equity;
      if (prev > 0) returns12m.push((curr - prev) / prev);
    }
    const avg12m = returns12m.reduce((a, b) => a + b, 0) / returns12m.length;
    const vol12m = Math.sqrt(returns12m.reduce((sum, r) => sum + Math.pow(r - avg12m, 2), 0) / returns12m.length) * Math.sqrt(252);
    const sharpe12m = vol12m > 0 ? (return12m / 100) / vol12m : 0;

    metrics.push({
      date: point.date,
      rolling6mReturn: return6m,
      rolling12mReturn: return12m,
      rolling6mVol: vol6m * 100,
      rolling12mVol: vol12m * 100,
      rolling6mSharpe: sharpe6m,
      rolling12mSharpe: sharpe12m,
    });
  }

  return metrics;
}

async function analyzeVariety(variety: string): Promise<VarietyReport> {
  console.log(`\n分析 ${variety}...`);

  const unified = TOP1_UNIFIED_PARAMS[variety];
  if (!unified) throw new Error(`品种 ${variety} 不存在`);

  // Recipe fields are at top level of unified object
  const recipe = unified as any;
  const bars = loadBars(variety);
  const theo = { longReturn: 0, shortReturn: 0 };

  const result = await runTop1Backtest(variety, recipe, bars, theo as any);
  const trades = result.trades;

  console.log(`  交易数量: ${trades.length}`);

  // Calculate equity curve
  const equityCurve = calcEquityCurve(trades, 1000000);
  console.log(`  权益曲线点数: ${equityCurve.length}`);

  // Calculate monthly returns
  const monthlyReturns = calcMonthlyReturns(trades);
  console.log(`  月度收益数据: ${monthlyReturns.length}`);

  // Calculate yearly stats
  const yearlyStats = calcYearlyStats(trades);
  console.log(`  年度统计: ${yearlyStats.length} 年`);

  // Calculate rolling metrics
  const rollingMetrics = calcRollingMetrics(equityCurve);
  console.log(`  滚动指标: ${rollingMetrics.length}`);

  // Calculate summary
  const totalPnl = trades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalReturn = (totalPnl / 1000000) * 100;
  const maxDrawdown = Math.min(...equityCurve.map(p => p.drawdown));
  const maxDrawdownPct = Math.min(...equityCurve.map(p => p.drawdownPct)) * 100;
  const calmar = maxDrawdown !== 0 ? Math.abs(totalPnl / maxDrawdown) : 999;
  
  const wins = trades.filter(t => (t.pnl || 0) > 0).length;
  const losses = trades.filter(t => (t.pnl || 0) < 0).length;
  const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0;
  
  const grossProfit = trades.filter(t => (t.pnl || 0) > 0).reduce((sum, t) => sum + (t.pnl || 0), 0);
  const grossLoss = Math.abs(trades.filter(t => (t.pnl || 0) < 0).reduce((sum, t) => sum + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : 999;
  
  const avgTradePnl = trades.length > 0 ? totalPnl / trades.length : 0;
  const avgHoldDays = trades.length > 0 
    ? trades.reduce((sum, t) => sum + (t.holdDays || 0), 0) / trades.length 
    : 0;

  // Calculate Sharpe
  const monthlyPnls = new Map<string, number>();
  for (const t of trades) {
    const key = t.exitDate.substring(0, 7);
    monthlyPnls.set(key, (monthlyPnls.get(key) || 0) + (t.pnl || 0));
  }
  const monthlyReturnsArr = Array.from(monthlyPnls.values());
  const avgMonthly = monthlyReturnsArr.reduce((a, b) => a + b, 0) / monthlyReturnsArr.length;
  const stdMonthly = Math.sqrt(monthlyReturnsArr.reduce((sum, r) => sum + Math.pow(r - avgMonthly, 2), 0) / monthlyReturnsArr.length);
  const sharpe = stdMonthly > 0 ? (avgMonthly / stdMonthly) * Math.sqrt(12) : 0;

  const summary = {
    totalPnl,
    totalReturn,
    maxDrawdown: Math.abs(maxDrawdown),
    maxDrawdownPct: Math.abs(maxDrawdownPct),
    calmar,
    sharpe,
    winRate,
    profitFactor,
    avgTradePnl,
    totalTrades: trades.length,
    avgHoldDays,
  };

  console.log(`  总收益: ${totalPnl.toFixed(0)}`);
  console.log(`  最大回撤: ${(maxDrawdownPct * -1).toFixed(2)}%`);
  console.log(`  Calmar: ${calmar.toFixed(2)}`);

  return {
    variety,
    equityCurve,
    monthlyReturns,
    yearlyStats,
    rollingMetrics,
    summary,
  };
}

async function main() {
  console.log('=== 回测报告增强分析 ===\n');

  const reports: Record<string, VarietyReport> = {};

  for (const variety of VARIETIES) {
    try {
      reports[variety] = await analyzeVariety(variety);
    } catch (err) {
      console.error(`分析 ${variety} 失败:`, err);
    }
  }

  // Save results
  const outputPath = path.join(DATA_DIR, 'enhancedBacktestReport.json');
  fs.writeFileSync(outputPath, JSON.stringify(reports, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
