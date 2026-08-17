/**
 * 多策略回测引擎
 *
 * 用途：基于 data-cache 真实日线数据，运行多种策略（EMA交叉、RSI、布林带）回测，
 * 综合评估品种表现，生成更可靠的品种分级结果。
 *
 * 运行方式：
 *   cd server && npx tsx src/scripts/generateRealBacktestResults.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { VARIETIES } from '../services/varieties.js';
import { calcEMA, calcATR, calcADXSeries, calcRSI, calcBollinger } from '../services/indicators.js';
import { storeBacktestResults, calculateVarietyGrades } from '../services/backtestAnalysis.js';
import type { BarData } from '../services/varieties.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_CACHE_DIR = path.resolve(__dirname, '../../data-cache');

// 软停用/未列入 VARIETIES 的品种名称补充
const EXTRA_NAMES: Record<string, string> = {
  C0: '玉米', CS0: '淀粉', OI0: '菜油', PF0: '短纤', PK0: '花生',
  SH0: '烧碱', SN0: '锡', SR0: '白糖', TL0: '30年国债', TS0: '2年国债',
  V0: 'PVC', Y0: '豆油',
};

// 交易所映射
const EXCHANGE_MAP: Record<string, string> = {
  CU0: 'SHFE', AL0: 'SHFE', ZN0: 'SHFE', NI0: 'SHFE', PB0: 'SHFE', SN0: 'SHFE',
  AG0: 'SHFE', AU0: 'SHFE', HC0: 'SHFE', RB0: 'SHFE', SP0: 'SHFE', FU0: 'SHFE',
  BU0: 'SHFE', AO0: 'SHFE', SS0: 'SHFE', RU0: 'SHFE', NR0: 'SHFE', WR0: 'SHFE',
  SC0: 'INE', LU0: 'INE', BC0: 'INE', EC0: 'INE',
  I0: 'DCE', JM0: 'DCE', J0: 'DCE', P0: 'DCE', M0: 'DCE', A0: 'DCE', LH0: 'DCE',
  JD0: 'DCE', L0: 'DCE', PP0: 'DCE', EB0: 'DCE', PG0: 'DCE', C0: 'DCE', CS0: 'DCE',
  Y0: 'DCE', V0: 'DCE',
  AP0: 'CZCE', CF0: 'CZCE', SA0: 'CZCE', FG0: 'CZCE', TA0: 'CZCE', EG0: 'CZCE',
  MA0: 'CZCE', RM0: 'CZCE', OI0: 'CZCE', CJ0: 'CZCE', SF0: 'CZCE', SM0: 'CZCE',
  UR0: 'CZCE', PX0: 'CZCE', PF0: 'CZCE', PK0: 'CZCE', SH0: 'CZCE', SR0: 'CZCE',
  IM0: 'CFFEX', IF0: 'CFFEX', IH0: 'CFFEX', IC0: 'CFFEX', T0: 'CFFEX', TF0: 'CFFEX',
  TL0: 'CFFEX', TS0: 'CFFEX',
  SI0: 'GFEX', LC0: 'GFEX',
};

function getName(code: string): string {
  return VARIETIES[code] ?? EXTRA_NAMES[code] ?? code;
}

function getExchange(code: string): string {
  return EXCHANGE_MAP[code] ?? 'UNKNOWN';
}

interface Trade {
  pnl: number;
  returnPct: number;
  strategy: string;
}

interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  sharpeRatio: number;
  trades: Trade[];
}

/**
 * 策略1: EMA 交叉策略（趋势跟踪）
 */
function runEMAStrategy(bars: BarData[]): BacktestMetrics {
  if (bars.length < 50) {
    return emptyMetrics();
  }

  const closes = bars.map((b) => b.c);
  const ema5 = calcEMA(closes, 5);
  const ema20 = calcEMA(closes, 20);
  const atr = calcATR(bars, 14);
  const adxValues = calcADXSeries(bars, 14);

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let stopLoss = 0;
  let capital = 100000;
  let maxCapital = 100000;
  let maxDrawdown = 0;
  const trades: Trade[] = [];

  for (let i = 21; i < bars.length; i++) {
    const bar = bars[i];
    const adx = adxValues[i];

    const emaCrossUp = ema5[i] > ema20[i] && ema5[i - 1] <= ema20[i - 1];
    const emaCrossDown = ema5[i] < ema20[i] && ema5[i - 1] >= ema20[i - 1];

    if (position === null) {
      if (emaCrossUp && adx > 20) {
        position = 'long';
        entryPrice = bar.c;
        stopLoss = entryPrice - atr[i] * 2;
      } else if (emaCrossDown && adx > 20) {
        position = 'short';
        entryPrice = bar.c;
        stopLoss = entryPrice + atr[i] * 2;
      }
    } else if (position === 'long') {
      stopLoss = Math.max(stopLoss, bar.c - atr[i] * 2);
      if (bar.l <= stopLoss || emaCrossDown) {
        const exitPrice = Math.max(bar.l, stopLoss);
        const pnl = exitPrice - entryPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'EMA' });
        capital *= 1 + returnPct;
        position = null;
      }
    } else if (position === 'short') {
      stopLoss = Math.min(stopLoss, bar.c + atr[i] * 2);
      if (bar.h >= stopLoss || emaCrossUp) {
        const exitPrice = Math.min(bar.h, stopLoss);
        const pnl = entryPrice - exitPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'EMA' });
        capital *= 1 + returnPct;
        position = null;
      }
    }

    maxCapital = Math.max(maxCapital, capital);
    const drawdown = (maxCapital - capital) / maxCapital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return calculateMetrics(trades, capital, maxDrawdown);
}

/**
 * 策略2: RSI 超买超卖策略（震荡反转）
 */
function runRSIStrategy(bars: BarData[]): BacktestMetrics {
  if (bars.length < 50) {
    return emptyMetrics();
  }

  const closes = bars.map((b) => b.c);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(bars, 14);

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let stopLoss = 0;
  let capital = 100000;
  let maxCapital = 100000;
  let maxDrawdown = 0;
  const trades: Trade[] = [];

  for (let i = 15; i < bars.length; i++) {
    const bar = bars[i];
    const currentRSI = rsi[i];
    const prevRSI = rsi[i - 1];

    if (isNaN(currentRSI) || isNaN(prevRSI)) continue;

    // RSI 从超卖区回升 → 做多
    const rsiBullish = prevRSI < 30 && currentRSI >= 30;
    // RSI 从超买区回落 → 做空
    const rsiBearish = prevRSI > 70 && currentRSI <= 70;

    if (position === null) {
      if (rsiBullish) {
        position = 'long';
        entryPrice = bar.c;
        stopLoss = entryPrice - atr[i] * 1.5;
      } else if (rsiBearish) {
        position = 'short';
        entryPrice = bar.c;
        stopLoss = entryPrice + atr[i] * 1.5;
      }
    } else if (position === 'long') {
      // 止盈：RSI 进入超买区
      // 止损：价格跌破止损位
      if (currentRSI > 70 || bar.l <= stopLoss) {
        const exitPrice = bar.l <= stopLoss ? Math.max(bar.l, stopLoss) : bar.c;
        const pnl = exitPrice - entryPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'RSI' });
        capital *= 1 + returnPct;
        position = null;
      } else {
        stopLoss = Math.max(stopLoss, bar.c - atr[i] * 1.5);
      }
    } else if (position === 'short') {
      if (currentRSI < 30 || bar.h >= stopLoss) {
        const exitPrice = bar.h >= stopLoss ? Math.min(bar.h, stopLoss) : bar.c;
        const pnl = entryPrice - exitPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'RSI' });
        capital *= 1 + returnPct;
        position = null;
      } else {
        stopLoss = Math.min(stopLoss, bar.c + atr[i] * 1.5);
      }
    }

    maxCapital = Math.max(maxCapital, capital);
    const drawdown = (maxCapital - capital) / maxCapital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return calculateMetrics(trades, capital, maxDrawdown);
}

/**
 * 策略3: 布林带策略（均值回归）
 */
function runBollingerStrategy(bars: BarData[]): BacktestMetrics {
  if (bars.length < 50) {
    return emptyMetrics();
  }

  const closes = bars.map((b) => b.c);
  const bollinger = calcBollinger(closes, 20, 2);
  const atr = calcATR(bars, 14);

  let position: 'long' | 'short' | null = null;
  let entryPrice = 0;
  let stopLoss = 0;
  let capital = 100000;
  let maxCapital = 100000;
  let maxDrawdown = 0;
  const trades: Trade[] = [];

  for (let i = 21; i < bars.length; i++) {
    const bar = bars[i];
    const currentClose = bar.c;
    const upper = bollinger.upper[i];
    const lower = bollinger.lower[i];
    const middle = bollinger.middle[i];

    if (isNaN(upper) || isNaN(lower) || isNaN(middle)) continue;

    // 价格触及下轨 → 做多（均值回归）
    const touchLower = currentClose <= lower;
    // 价格触及上轨 → 做空（均值回归）
    const touchUpper = currentClose >= upper;

    if (position === null) {
      if (touchLower) {
        position = 'long';
        entryPrice = bar.c;
        stopLoss = entryPrice - atr[i] * 2;
      } else if (touchUpper) {
        position = 'short';
        entryPrice = bar.c;
        stopLoss = entryPrice + atr[i] * 2;
      }
    } else if (position === 'long') {
      // 止盈：价格回到中轨
      // 止损：价格跌破止损位
      if (currentClose >= middle || bar.l <= stopLoss) {
        const exitPrice = bar.l <= stopLoss ? Math.max(bar.l, stopLoss) : bar.c;
        const pnl = exitPrice - entryPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'Bollinger' });
        capital *= 1 + returnPct;
        position = null;
      } else {
        stopLoss = Math.max(stopLoss, bar.c - atr[i] * 2);
      }
    } else if (position === 'short') {
      if (currentClose <= middle || bar.h >= stopLoss) {
        const exitPrice = bar.h >= stopLoss ? Math.min(bar.h, stopLoss) : bar.c;
        const pnl = entryPrice - exitPrice;
        const returnPct = pnl / entryPrice;
        trades.push({ pnl, returnPct, strategy: 'Bollinger' });
        capital *= 1 + returnPct;
        position = null;
      } else {
        stopLoss = Math.min(stopLoss, bar.c + atr[i] * 2);
      }
    }

    maxCapital = Math.max(maxCapital, capital);
    const drawdown = (maxCapital - capital) / maxCapital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  return calculateMetrics(trades, capital, maxDrawdown);
}

function emptyMetrics(): BacktestMetrics {
  return {
    totalTrades: 0,
    winRate: 0,
    profitFactor: 0,
    totalReturn: 0,
    maxDrawdown: 0,
    avgWin: 0,
    avgLoss: 0,
    sharpeRatio: 0,
    trades: [],
  };
}

function calculateMetrics(trades: Trade[], finalCapital: number, maxDrawdown: number): BacktestMetrics {
  if (trades.length === 0) {
    return emptyMetrics();
  }

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const totalWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  const winRate = (wins.length / trades.length) * 100;
  
  // 无亏损交易时封顶为 5
  const rawPF = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 5 : 0;
  const profitFactor = Math.min(rawPF, 5);
  
  const totalReturn = ((finalCapital - 100000) / 100000) * 100;
  const avgWin = wins.length > 0 ? totalWin / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLoss / losses.length : 0;

  // 计算夏普比率（简化版：假设无风险利率为 0）
  const returns = trades.map((t) => t.returnPct);
  const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const stdDev = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  );
  const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // 年化

  return {
    totalTrades: trades.length,
    winRate,
    profitFactor,
    totalReturn,
    maxDrawdown: maxDrawdown * 100,
    avgWin,
    avgLoss,
    sharpeRatio,
    trades,
  };
}

/**
 * 综合多策略回测
 */
function runMultiStrategyBacktest(bars: BarData[]): {
  ema: BacktestMetrics;
  rsi: BacktestMetrics;
  bollinger: BacktestMetrics;
  combined: BacktestMetrics;
} {
  const ema = runEMAStrategy(bars);
  const rsi = runRSIStrategy(bars);
  const bollinger = runBollingerStrategy(bars);

  // 合并所有策略的交易记录
  const allTrades = [...ema.trades, ...rsi.trades, ...bollinger.trades];
  
  // 计算综合指标
  let finalCapital = 100000;
  let maxCapital = 100000;
  let maxDrawdown = 0;
  
  // 按时间顺序模拟（这里简化处理，假设交易不重叠）
  for (const trade of allTrades) {
    finalCapital *= 1 + trade.returnPct;
    maxCapital = Math.max(maxCapital, finalCapital);
    const drawdown = (maxCapital - finalCapital) / maxCapital;
    maxDrawdown = Math.max(maxDrawdown, drawdown);
  }

  const combined = calculateMetrics(allTrades, finalCapital, maxDrawdown);

  return { ema, rsi, bollinger, combined };
}

interface BacktestResult {
  code: string;
  name: string;
  exchange: string;
  timeframe: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  sharpeRatio: number;
  emaTrades: number;
  rsiTrades: number;
  bollingerTrades: number;
  bestStrategy: string;
}

function main() {
  if (!fs.existsSync(DATA_CACHE_DIR)) {
    console.error('data-cache 目录不存在: ' + DATA_CACHE_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(DATA_CACHE_DIR).filter((f) => f.endsWith('.json'));
  console.log('从 data-cache 加载 ' + files.length + ' 个品种的日线数据\n');
  console.log('运行多策略回测（EMA + RSI + 布林带）...\n');

  const results: BacktestResult[] = [];

  for (const file of files) {
    const code = file.replace(/\.json$/, '');
    const filePath = path.join(DATA_CACHE_DIR, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const bars: BarData[] = raw.bars || [];
      if (bars.length < 50) {
        console.log(`跳过 ${code}: K线不足 (${bars.length})`);
        continue;
      }

      // 按日期排序
      bars.sort((a, b) => a.date.localeCompare(b.date));

      const { ema, rsi, bollinger, combined } = runMultiStrategyBacktest(bars);
      
      if (combined.totalTrades > 0) {
        // 小样本惩罚
        const samplePenalty = combined.totalTrades < 5 ? 0.6 : combined.totalTrades < 10 ? 0.8 : 1;
        const adjustedPF = combined.profitFactor * samplePenalty;

        // 确定最佳策略
        const strategies = [
          { name: 'EMA', trades: ema.totalTrades, pf: ema.profitFactor },
          { name: 'RSI', trades: rsi.totalTrades, pf: rsi.profitFactor },
          { name: 'Bollinger', trades: bollinger.totalTrades, pf: bollinger.profitFactor },
        ];
        const bestStrategy = strategies.sort((a, b) => b.pf - a.pf)[0];

        results.push({
          code,
          name: getName(code),
          exchange: getExchange(code),
          timeframe: '日线',
          totalTrades: combined.totalTrades,
          winRate: combined.winRate,
          profitFactor: Math.round(adjustedPF * 100) / 100,
          totalReturn: combined.totalReturn,
          maxDrawdown: combined.maxDrawdown,
          avgWin: combined.avgWin,
          avgLoss: combined.avgLoss,
          sharpeRatio: Math.round(combined.sharpeRatio * 100) / 100,
          emaTrades: ema.totalTrades,
          rsiTrades: rsi.totalTrades,
          bollingerTrades: bollinger.totalTrades,
          bestStrategy: bestStrategy.name,
        });

        console.log(
          `${code} ${getName(code)}: ${combined.totalTrades}笔(EMA${ema.totalTrades}/RSI${rsi.totalTrades}/BB${bollinger.totalTrades}), ` +
          `胜率${combined.winRate.toFixed(0)}%, PF=${adjustedPF.toFixed(2)}, 夏普=${combined.sharpeRatio.toFixed(2)}, 最佳=${bestStrategy.name}`
        );
      } else {
        console.log(`${code} ${getName(code)}: 无有效交易信号`);
      }
    } catch (err) {
      console.error(`处理 ${code} 失败:`, err);
    }
  }

  console.log(`\n共生成 ${results.length} 条回测结果`);
  storeBacktestResults(results);
  console.log('已写入 /tmp/data/backtest_results.json');

  // 同步写入 server/data 作为持久化兜底
  const serverDataDir = path.resolve(__dirname, '../../data');
  const serverDataFile = path.join(serverDataDir, 'backtest_results.json');
  fs.writeFileSync(serverDataFile, JSON.stringify(results, null, 2), 'utf-8');
  console.log('已同步写入 ' + serverDataFile + '\n');

  console.log('计算品种分级...');
  const grades = calculateVarietyGrades();
  const stat: Record<string, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const g of grades) stat[g.grade]++;

  console.log('\n=== 分级统计 ===');
  console.log('S级: ' + stat.S + ' (' + ((stat.S / grades.length) * 100).toFixed(1) + '%)');
  console.log('A级: ' + stat.A + ' (' + ((stat.A / grades.length) * 100).toFixed(1) + '%)');
  console.log('B级: ' + stat.B + ' (' + ((stat.B / grades.length) * 100).toFixed(1) + '%)');
  console.log('C级: ' + stat.C + ' (' + ((stat.C / grades.length) * 100).toFixed(1) + '%)');

  console.log('\n=== S级品种 ===');
  grades.filter((g) => g.grade === 'S').forEach((g) => {
    console.log(`  ${g.code} ${g.name} - PF=${g.bestProfitFactor.toFixed(2)}, 夏普=${g.sharpeRatio?.toFixed(2) || 'N/A'}`);
  });

  console.log('\n=== A级品种 ===');
  grades.filter((g) => g.grade === 'A').forEach((g) => {
    console.log(`  ${g.code} ${g.name} - PF=${g.bestProfitFactor.toFixed(2)}, 夏普=${g.sharpeRatio?.toFixed(2) || 'N/A'}`);
  });
}

main();
