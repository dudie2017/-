/**
 * Brooks雷达回测框架
 * 用于验证信号系统的历史准确性
 */

import { fetchDaily } from './dataFetcher.js';
import { calcEMA, calcATR, calcADX } from './indicators.js';
import { VARIETIES } from './varieties.js';

// 回测配置
interface BacktestConfig {
  varietyCode: string;
  lookbackBars: number;      // 用于生成信号的K线数量
  forwardBars: number;       // 向前验证的K线数量
  signalThreshold: number;   // 信号强度阈值
  
  // 出场规则配置
  exitRules: {
    atrStopLoss: boolean;    // 使用ATR止损
    atrMultiplier: number;   // ATR止损倍数（默认2.0）
    targetRR: number;        // 目标风险收益比（默认2.0）
    trailingStop: boolean;   // 移动止损
    trailingAtrMult: number; // 移动止损ATR倍数
    timeExit: boolean;       // 时间出场
    maxHoldBars: number;     // 最大持仓K线数
  };
  
  // 品种适应性过滤
  varietyFilter: {
    minTrendScore: number;   // 最小趋势评分
    minVolume: number;       // 最小成交量
    excludeRange: boolean;   // 排除区间状态
  };
  
  // 多时间框架确认
  multiTimeframe: {
    enabled: boolean;
    higherTimeframe: 'weekly' | '4h';
    requireConfirmation: boolean; // 需要高时间框架确认
  };
}

// 从历史K线数据计算信号（用于回测）
function calculateSignalFromBars(code: string, bars: BarData[]): {
  direction: string;
  signalStrength: number;
  signalLevel: string;
  signals: string[];
} | null {
  if (bars.length < 25) return null;
  
  const last = bars[bars.length - 1];
  const closes = bars.map(b => b.c);
  
  // 计算EMA20
  const ema20Arr = calcEMA(closes, 20);
  const ema20 = ema20Arr[ema20Arr.length - 1];
  
  // AI方向
  const direction = last.c > ema20 ? 'LONG' : 'SHORT';
  
  // 计算趋势强度（简化版）
  let trendStrength = 0;
  const lookback = Math.min(20, bars.length - 1);
  const recentBars = bars.slice(-lookback);
  
  // 计算高低点趋势
  let higherHighs = 0;
  let higherLows = 0;
  for (let i = 1; i < recentBars.length; i++) {
    if (recentBars[i].h > recentBars[i-1].h) higherHighs++;
    if (recentBars[i].l > recentBars[i-1].l) higherLows++;
  }
  const hhRatio = higherHighs / (recentBars.length - 1);
  const hlRatio = higherLows / (recentBars.length - 1);
  
  if (direction === 'LONG') {
    if (hhRatio >= 0.7) trendStrength += 8;
    else if (hhRatio >= 0.5) trendStrength += 4;
    if (hlRatio >= 0.7) trendStrength += 8;
    else if (hlRatio >= 0.5) trendStrength += 4;
  } else {
    if (hhRatio <= 0.3) trendStrength += 8;
    else if (hhRatio <= 0.5) trendStrength += 4;
    if (hlRatio <= 0.3) trendStrength += 8;
    else if (hlRatio <= 0.5) trendStrength += 4;
  }
  
  // 计算ADX
  const adxResult = calcADX(bars);
  const adx = adxResult.adx;
  if (adx > 30) trendStrength += 8;
  else if (adx > 25) trendStrength += 4;
  
  // 计算信号强度（简化版）
  let signalStrength = 0;
  signalStrength += Math.min(trendStrength * 0.3, 30); // 趋势强度贡献30%
  
  // EMA偏离度
  const emaDev = (last.c / ema20 - 1) * 100;
  if (Math.abs(emaDev) > 2) signalStrength += 10;
  else if (Math.abs(emaDev) > 1) signalStrength += 5;
  
  // 买卖压力
  let bullBody = 0, bearBody = 0;
  const pressureLookback = Math.min(10, bars.length);
  for (let i = bars.length - pressureLookback; i < bars.length; i++) {
    const bar = bars[i];
    const body = Math.abs(bar.c - bar.o);
    if (bar.c > bar.o) bullBody += body;
    else bearBody += body;
  }
  const pressureRatio = bearBody > 0 ? bullBody / bearBody : bullBody > 0 ? 10 : 1;
  if (direction === 'LONG' && pressureRatio > 2) signalStrength += 15;
  if (direction === 'SHORT' && pressureRatio < 0.5) signalStrength += 15;
  
  // 信号级别
  let signalLevel = 'none';
  if (signalStrength >= 70) signalLevel = 'strong';
  else if (signalStrength >= 50) signalLevel = 'moderate';
  else if (signalStrength >= 30) signalLevel = 'weak';
  
  // 信号列表
  const signals: string[] = [];
  if (trendStrength >= 50) signals.push('强趋势');
  if (adx > 25) signals.push('ADX确认');
  if (Math.abs(emaDev) > 2) signals.push('超买超卖');
  
  return {
    direction,
    signalStrength: Math.round(signalStrength),
    signalLevel,
    signals,
  };
}

// K线数据接口
interface BarData {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
}

// 单次回测结果
interface BacktestTrade {
  entryDate: string;
  entryPrice: number;
  direction: 'LONG' | 'SHORT';
  signalStrength: number;
  signals: string[];
  
  // 结果
  exitDate?: string;
  exitPrice?: number;
  pnl?: number;              // 盈亏百分比
  pnlBars?: number;          // 持仓K线数
  
  // 跟踪
  maxFavorable?: number;     // 最大有利偏移
  maxAdverse?: number;       // 最大不利偏移
  
  // 判定
  isWin?: boolean;           // 是否盈利
  exitReason?: string;       // 出场原因
}

// 回测统计
interface BacktestStats {
  varietyCode: string;
  varietyName: string;
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;           // 胜率
  
  avgPnl: number;            // 平均盈亏
  avgWin: number;            // 平均盈利
  avgLoss: number;           // 平均亏损
  profitFactor: number;      // 盈利因子
  
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  
  avgHoldingBars: number;    // 平均持仓K线数
  
  // 按信号强度分组
  bySignalStrength: {
    strong: { trades: number; wins: number; winRate: number };
    moderate: { trades: number; wins: number; winRate: number };
    weak: { trades: number; wins: number; winRate: number };
  };
  
  // 按信号类型分组
  bySignalType: Record<string, { trades: number; wins: number; winRate: number }>;
  
  // 交易列表
  trades: BacktestTrade[];
}

// 默认回测配置
const DEFAULT_CONFIG: BacktestConfig = {
  varietyCode: 'I0',
  lookbackBars: 60,          // 用60根K线生成信号
  forwardBars: 20,           // 向前验证20根K线
  signalThreshold: 30,       // 信号强度>=30才交易
  
  // 出场规则
  exitRules: {
    atrStopLoss: true,       // 使用ATR止损
    atrMultiplier: 2.0,      // ATR止损2倍
    targetRR: 2.0,           // 目标风险收益比2:1
    trailingStop: true,      // 启用移动止损
    trailingAtrMult: 1.5,    // 移动止损1.5倍ATR
    timeExit: true,          // 启用时间出场
    maxHoldBars: 15,         // 最大持仓15根K线
  },
  
  // 品种适应性过滤
  varietyFilter: {
    minTrendScore: 30,       // 最小趋势评分30
    minVolume: 0,            // 不限制成交量
    excludeRange: false,     // 不排除区间状态
  },
  
  // 多时间框架确认
  multiTimeframe: {
    enabled: false,          // 默认关闭（需要更多数据）
    higherTimeframe: 'weekly',
    requireConfirmation: false,
  },
};

// 选择10个代表性品种
const BACKTEST_VARIETIES = [
  'I0',   // 铁矿石 - 黑色系代表
  'RB0',  // 螺纹钢 - 黑色系
  'CU0',  // 铜 - 有色金属代表
  'AU0',  // 黄金 - 贵金属代表
  'SC0',  // 原油 - 能化代表
  'M0',   // 豆粕 - 农产品代表
  'IF0',  // 沪深300 - 股指代表
  'SA0',  // 纯碱 - 高波动品种
  'AG0',  // 白银 - 贵金属
  'JM0',  // 焦煤 - 黑色系
];

/**
 * 在历史数据上运行回测
 */
export async function runBacktest(config: Partial<BacktestConfig> = {}): Promise<BacktestStats> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const code = cfg.varietyCode;
  const name = VARIETIES[code] || code;
  
  console.log(`[Backtest] 开始回测 ${name}(${code})...`);
  
  // 获取历史数据（需要更多数据用于回测）
  const dailyData = await fetchDaily(code, 200);
  if (!dailyData || dailyData.length < cfg.lookbackBars + cfg.forwardBars) {
    throw new Error(`数据不足: ${dailyData?.length || 0} bars`);
  }
  
  const trades: BacktestTrade[] = [];
  
  // 从第lookbackBars根K线开始回测
  for (let i = cfg.lookbackBars; i < dailyData.length - cfg.forwardBars; i++) {
    // 截取到当前K线的数据
    const bars = dailyData.slice(0, i + 1);
    
    // 使用历史数据生成信号（直接计算，不调用scanVariety）
    const signalResult = calculateSignalFromBars(code, bars);
    if (!signalResult) continue;
    
    // 检查是否满足交易条件
    if (signalResult.signalStrength < cfg.signalThreshold) continue;
    if (signalResult.signalLevel === 'none') continue;
    
    // 记录入场
    const entryBar = bars[bars.length - 1];
    const direction = signalResult.direction as 'LONG' | 'SHORT';
    
    const trade: BacktestTrade = {
      entryDate: entryBar.date,
      entryPrice: entryBar.c,
      direction,
      signalStrength: signalResult.signalStrength,
      signals: signalResult.signals || [],
    };
    
    // 向前验证 - 使用新的出场规则
    let maxFavorable = 0;
    let maxAdverse = 0;
    let exitIdx = -1;
    let exitReason = '';
    
    // 计算入场时的ATR用于止损
    const atr = calcATR(bars, 14);
    const currentATR = atr.length > 0 ? atr[atr.length - 1] : entryBar.c * 0.02; // 默认2%
    const atrStop = currentATR * (cfg.exitRules?.atrMultiplier || 2.0);
    
    // 计算止损止盈价位
    let stopLoss = 0;
    let takeProfit = 0;
    
    if (direction === 'LONG') {
      stopLoss = entryBar.c - atrStop;
      takeProfit = entryBar.c + atrStop * (cfg.exitRules?.targetRR || 2.0);
    } else {
      stopLoss = entryBar.c + atrStop;
      takeProfit = entryBar.c - atrStop * (cfg.exitRules?.targetRR || 2.0);
    }
    
    // 移动止损追踪
    let trailingStop = stopLoss;
    let highestSinceEntry = entryBar.c;
    let lowestSinceEntry = entryBar.c;
    
    const maxBars = cfg.exitRules?.timeExit 
      ? Math.min(cfg.forwardBars, cfg.exitRules?.maxHoldBars || cfg.forwardBars)
      : cfg.forwardBars;
    
    for (let j = 1; j <= maxBars; j++) {
      const futureBar = dailyData[i + j];
      const pnl = direction === 'LONG' 
        ? (futureBar.c - entryBar.c) / entryBar.c * 100
        : (entryBar.c - futureBar.c) / entryBar.c * 100;
      
      if (pnl > maxFavorable) maxFavorable = pnl;
      if (pnl < maxAdverse) maxAdverse = pnl;
      
      // 更新移动止损
      if (cfg.exitRules?.trailingStop) {
        if (direction === 'LONG') {
          if (futureBar.c > highestSinceEntry) {
            highestSinceEntry = futureBar.c;
            trailingStop = highestSinceEntry - currentATR * (cfg.exitRules?.trailingAtrMult || 1.5);
          }
          // 检查移动止损
          if (futureBar.l <= trailingStop && trailingStop > stopLoss) {
            exitIdx = i + j;
            exitReason = '移动止损';
            break;
          }
        } else {
          if (futureBar.c < lowestSinceEntry) {
            lowestSinceEntry = futureBar.c;
            trailingStop = lowestSinceEntry + currentATR * (cfg.exitRules?.trailingAtrMult || 1.5);
          }
          // 检查移动止损
          if (futureBar.h >= trailingStop && trailingStop < stopLoss) {
            exitIdx = i + j;
            exitReason = '移动止损';
            break;
          }
        }
      }
      
      // 出场条件
      // 1. ATR止损
      if (cfg.exitRules?.atrStopLoss) {
        if (direction === 'LONG' && futureBar.l <= stopLoss) {
          exitIdx = i + j;
          exitReason = 'ATR止损';
          break;
        }
        if (direction === 'SHORT' && futureBar.h >= stopLoss) {
          exitIdx = i + j;
          exitReason = 'ATR止损';
          break;
        }
      }
      
      // 2. 目标止盈
      if (cfg.exitRules?.targetRR && cfg.exitRules.targetRR > 0) {
        if (direction === 'LONG' && futureBar.h >= takeProfit) {
          exitIdx = i + j;
          exitReason = '目标止盈';
          break;
        }
        if (direction === 'SHORT' && futureBar.l <= takeProfit) {
          exitIdx = i + j;
          exitReason = '目标止盈';
          break;
        }
      }
      
      // 3. 时间出场
      if (j === maxBars) {
        exitIdx = i + j;
        exitReason = '时间出场';
      }
    }
    
    // 如果没触发止损止盈，按最后K线出场
    if (exitIdx === -1) {
      exitIdx = i + cfg.forwardBars;
      exitReason = '时间出场';
    }
    
    const exitBar = dailyData[exitIdx];
    const finalPnl = direction === 'LONG'
      ? (exitBar.c - entryBar.c) / entryBar.c * 100
      : (entryBar.c - exitBar.c) / entryBar.c * 100;
    
    trade.exitDate = exitBar.date;
    trade.exitPrice = exitBar.c;
    trade.pnl = Math.round(finalPnl * 100) / 100;
    trade.pnlBars = exitIdx - i;
    trade.maxFavorable = Math.round(maxFavorable * 100) / 100;
    trade.maxAdverse = Math.round(maxAdverse * 100) / 100;
    trade.isWin = finalPnl > 0;
    trade.exitReason = exitReason;
    
    trades.push(trade);
  }
  
  // 计算统计
  return calculateStats(code, name, trades);
}

/**
 * 计算回测统计
 */
function calculateStats(code: string, name: string, trades: BacktestTrade[]): BacktestStats {
  const totalTrades = trades.length;
  const winningTrades = trades.filter(t => t.isWin).length;
  const losingTrades = totalTrades - winningTrades;
  const winRate = totalTrades > 0 ? winningTrades / totalTrades : 0;
  
  const pnls = trades.map(t => t.pnl || 0);
  const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
  
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  
  const totalWin = wins.reduce((a, b) => a + b, 0);
  const totalLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0;
  
  // 最大连续盈亏
  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;
  
  for (const trade of trades) {
    if (trade.isWin) {
      currentWins++;
      currentLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    } else {
      currentLosses++;
      currentWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    }
  }
  
  // 平均持仓K线数
  const holdingBars = trades.map(t => t.pnlBars || 0);
  const avgHoldingBars = holdingBars.length > 0 
    ? holdingBars.reduce((a, b) => a + b, 0) / holdingBars.length 
    : 0;
  
  // 按信号强度分组
  const strong = trades.filter(t => t.signalStrength >= 70);
  const moderate = trades.filter(t => t.signalStrength >= 50 && t.signalStrength < 70);
  const weak = trades.filter(t => t.signalStrength >= 30 && t.signalStrength < 50);
  
  // 按信号类型分组
  const bySignalType: Record<string, { trades: number; wins: number; winRate: number }> = {};
  for (const trade of trades) {
    for (const signal of trade.signals) {
      if (!bySignalType[signal]) {
        bySignalType[signal] = { trades: 0, wins: 0, winRate: 0 };
      }
      bySignalType[signal].trades++;
      if (trade.isWin) bySignalType[signal].wins++;
    }
  }
  for (const key of Object.keys(bySignalType)) {
    const s = bySignalType[key];
    s.winRate = s.trades > 0 ? s.wins / s.trades : 0;
  }
  
  return {
    varietyCode: code,
    varietyName: name,
    totalTrades,
    winningTrades,
    losingTrades,
    winRate: Math.round(winRate * 10000) / 100,
    avgPnl: Math.round(avgPnl * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgHoldingBars: Math.round(avgHoldingBars * 10) / 10,
    bySignalStrength: {
      strong: {
        trades: strong.length,
        wins: strong.filter(t => t.isWin).length,
        winRate: strong.length > 0 ? Math.round(strong.filter(t => t.isWin).length / strong.length * 10000) / 100 : 0,
      },
      moderate: {
        trades: moderate.length,
        wins: moderate.filter(t => t.isWin).length,
        winRate: moderate.length > 0 ? Math.round(moderate.filter(t => t.isWin).length / moderate.length * 10000) / 100 : 0,
      },
      weak: {
        trades: weak.length,
        wins: weak.filter(t => t.isWin).length,
        winRate: weak.length > 0 ? Math.round(weak.filter(t => t.isWin).length / weak.length * 10000) / 100 : 0,
      },
    },
    bySignalType,
    trades,
  };
}

/**
 * 运行所有品种的回测
 */
export async function runAllBacktests(): Promise<BacktestStats[]> {
  const results: BacktestStats[] = [];
  
  for (const code of BACKTEST_VARIETIES) {
    try {
      const stats = await runBacktest({ varietyCode: code });
      results.push(stats);
      console.log(`[Backtest] ${stats.varietyName}: ${stats.totalTrades}笔交易, 胜率${stats.winRate}%`);
    } catch (error) {
      console.error(`[Backtest] ${code} 失败:`, error);
    }
  }
  
  return results;
}

/**
 * 生成回测报告
 */
export function generateBacktestReport(results: BacktestStats[]): string {
  let report = '# Brooks雷达回测报告\n\n';
  report += `生成时间: ${new Date().toISOString()}\n\n`;
  
  // 总体统计
  const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);
  const totalWins = results.reduce((sum, r) => sum + r.winningTrades, 0);
  const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(2) : '0';
  
  report += '## 总体统计\n\n';
  report += `| 指标 | 数值 |\n`;
  report += `|------|------|\n`;
  report += `| 总交易数 | ${totalTrades} |\n`;
  report += `| 盈利交易 | ${totalWins} |\n`;
  report += `| 亏损交易 | ${totalTrades - totalWins} |\n`;
  report += `| 总体胜率 | ${overallWinRate}% |\n\n`;
  
  // 各品种统计
  report += '## 各品种统计\n\n';
  report += `| 品种 | 交易数 | 胜率 | 平均盈亏 | 盈利因子 | 最大连胜 | 最大连亏 |\n`;
  report += `|------|--------|------|----------|----------|----------|----------|\n`;
  
  for (const r of results) {
    report += `| ${r.varietyName} | ${r.totalTrades} | ${r.winRate}% | ${r.avgPnl}% | ${r.profitFactor} | ${r.maxConsecutiveWins} | ${r.maxConsecutiveLosses} |\n`;
  }
  
  // 按信号强度分组统计
  report += '\n## 按信号强度分组\n\n';
  report += `| 信号强度 | 交易数 | 胜率 |\n`;
  report += `|----------|--------|------|\n`;
  
  const strongTrades = results.reduce((sum, r) => sum + r.bySignalStrength.strong.trades, 0);
  const strongWins = results.reduce((sum, r) => sum + r.bySignalStrength.strong.wins, 0);
  const moderateTrades = results.reduce((sum, r) => sum + r.bySignalStrength.moderate.trades, 0);
  const moderateWins = results.reduce((sum, r) => sum + r.bySignalStrength.moderate.wins, 0);
  const weakTrades = results.reduce((sum, r) => sum + r.bySignalStrength.weak.trades, 0);
  const weakWins = results.reduce((sum, r) => sum + r.bySignalStrength.weak.wins, 0);
  
  report += `| 强信号(≥70) | ${strongTrades} | ${strongTrades > 0 ? (strongWins / strongTrades * 100).toFixed(2) : 0}% |\n`;
  report += `| 中等信号(50-70) | ${moderateTrades} | ${moderateTrades > 0 ? (moderateWins / moderateTrades * 100).toFixed(2) : 0}% |\n`;
  report += `| 弱信号(30-50) | ${weakTrades} | ${weakTrades > 0 ? (weakWins / weakTrades * 100).toFixed(2) : 0}% |\n`;
  
  // 按信号类型统计
  report += '\n## 按信号类型统计\n\n';
  const allSignalTypes: Record<string, { trades: number; wins: number }> = {};
  
  for (const r of results) {
    for (const [type, stats] of Object.entries(r.bySignalType)) {
      if (!allSignalTypes[type]) {
        allSignalTypes[type] = { trades: 0, wins: 0 };
      }
      allSignalTypes[type].trades += stats.trades;
      allSignalTypes[type].wins += stats.wins;
    }
  }
  
  report += `| 信号类型 | 交易数 | 胜率 |\n`;
  report += `|----------|--------|------|\n`;
  
  const sortedTypes = Object.entries(allSignalTypes).sort((a, b) => b[1].trades - a[1].trades);
  for (const [type, stats] of sortedTypes.slice(0, 15)) {
    const winRate = stats.trades > 0 ? (stats.wins / stats.trades * 100).toFixed(2) : '0';
    report += `| ${type} | ${stats.trades} | ${winRate}% |\n`;
  }
  
  return report;
}
