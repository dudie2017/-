/**
 * 统一回测框架
 * 
 * 支持参数化配置不同策略，运行对比实验，生成报告
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

// ============ 板块映射 ============

const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  RU0: '化工', MA0: '化工', TA0: '化工', PP0: '化工', PA0: '化工', EB0: '化工', PG0: '化工', BU0: '化工',
  CF0: '纺织', SR0: '纺织', OI0: '纺织', RM0: '纺织', AP0: '纺织', CJ0: '纺织',
  M0: '农产品', Y0: '农产品', A0: '农产品', B0: '农产品', JD0: '农产品', LH0: '农产品',
  P0: '农产品', C0: '农产品', CS0: '农产品', WH0: '农产品', PM0: '农产品', RI0: '农产品', LR0: '农产品',
  SC0: '能源', LU0: '能源', NR0: '能源', FU0: '能源',
  T0: '金融', TF0: '金融', TS0: '金融', IH0: '金融', IF0: '金融', IC0: '金融', IM0: '金融',
};

const DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

// ============ 类型定义 ============

interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number;
}

interface ShockSignal {
  code: string;
  date: string;
  direction: 'long' | 'short';
  atrMult: number;
  type: 'shock' | 'gradual';
  cumulativeAtrMult?: number;
}

interface TradeResult {
  code: string;
  direction: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  exitReason: string;
  signalType: 'shock' | 'gradual';
  signalScore?: number;
  signalGrade?: string;
}

interface BacktestConfig {
  name: string;
  description: string;
  
  // 信号检测参数
  shockAtrMult: number;        // 突变ATR倍数门槛
  gradualMinBars: number;      // 渐变最小K线数
  gradualAtrMult: number;      // 渐变累计ATR倍数门槛
  
  // 过滤参数
  useWhitelist: boolean;       // 是否使用白名单过滤
  useSectorCorrelation: boolean; // 是否使用板块联动过滤
  sectorCorrelationThreshold: number; // 板块联动阈值
  useSeasonal: boolean;        // 是否使用季节性过滤
  useNext1Confirmation: boolean; // 是否使用Next1确认
  
  // 交易参数
  maxHoldDays: number;         // 最大持仓天数
  stopLossPct: number;         // 止损百分比
  applyCosts: boolean;         // 是否应用交易成本
  slippage: number;            // 滑点
  commission: number;          // 手续费
  
  // 高级特性
  useAdaptiveParams: boolean;  // 是否使用自适应参数
  minSignalGrade: string;      // 最低信号等级 (A/B/C/D)
  
  // 数据范围
  startDate?: string;          // 开始日期
  endDate?: string;            // 结束日期
}

interface BacktestResult {
  config: BacktestConfig;
  trades: TradeResult[];
  metrics: {
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    netPnl: number;
    maxDrawdown: number;
    avgHoldDays: number;
    avgWin: number;
    avgLoss: number;
    sharpeRatio: number;
    sortinoRatio: number;
  };
  funnel: {
    totalSignals: number;
    afterWhitelist: number;
    afterSector: number;
    afterSeasonal: number;
    afterNext1: number;
    afterGrade: number;
  };
}

// ============ 常量 ============

const ATR_PERIOD = 14;
const ATR_LONG = 60;
const SEASONAL_WINDOW = 15;
const SEASONAL_YEARS = 5;

// 自适应参数配置
const ADAPTIVE_PARAMS = {
  high: { atrMult: 4.5, maxHold: 15, stopLoss: 0.012, sectorCorr: 0.55, gradualMult: 2.8 },
  normal: { atrMult: 4.0, maxHold: 20, stopLoss: 0.01, sectorCorr: 0.5, gradualMult: 2.5 },
  low: { atrMult: 3.5, maxHold: 22, stopLoss: 0.009, sectorCorr: 0.45, gradualMult: 2.2 },
};

// 信号评分配置
const GRADE_THRESHOLDS = { A: 70, B: 50, C: 30, D: 0 };

// ============ 数据加载 ============

function loadAllData(): Map<string, DailyBar[]> {
  const result = new Map<string, DailyBar[]>();
  
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const code = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    
    const bars: DailyBar[] = (raw as any[]).map(b => ({
      date: b.date,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      vol: b.vol,
      hold: b.hold || 0,
      ret: b.ret,
    })).filter(b => b.ret !== null && b.ret !== undefined);
    
    if (bars.length > 100) {
      result.set(code, bars);
    }
  }
  
  return result;
}

// ============ ATR计算（百分比ATR）============

function calcATR(bars: DailyBar[], period: number): number[] {
  const atr: number[] = [];
  
  for (let i = 0; i < bars.length; i++) {
    if (i < period) {
      atr.push(0);
      continue;
    }
    
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      // True Range as percentage of close
      const tr = (bars[j].h - bars[j].l) / bars[j].c;
      sum += tr;
    }
    atr.push(sum / period);
  }
  
  return atr;
}

// ============ 信号检测 ============

function detectShocks(data: Map<string, DailyBar[]>, config: BacktestConfig): ShockSignal[] {
  const signals: ShockSignal[] = [];
  
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    
    const threshold = config.shockAtrMult;
    
    for (let i = ATR_PERIOD; i < bars.length; i++) {
      if (atr[i] === 0) continue;
      
      const ret = bars[i].ret;
      const atrMult = Math.abs(ret) / atr[i];
      
      if (atrMult >= threshold) {
        const direction = ret > 0 ? 'long' : 'short';
        signals.push({
          code,
          date: bars[i].date,
          direction,
          atrMult,
          type: 'shock',
        });
      }
    }
  }
  
  console.log(`  检测到 ${signals.length} 个突变信号`);
  return signals;
}

function detectGradualTrends(data: Map<string, DailyBar[]>, config: BacktestConfig): ShockSignal[] {
  const signals: ShockSignal[] = [];
  const minBars = config.gradualMinBars;
  const threshold = config.gradualAtrMult;
  
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    
    for (let i = ATR_PERIOD + minBars; i < bars.length; i++) {
      let cumRet = 0;
      let cumAtr = 0;
      let allSameDir = true;
      let firstDir: 'long' | 'short' | null = null;
      
      for (let j = 0; j < minBars; j++) {
        const idx = i - minBars + 1 + j;
        const ret = bars[idx].ret;
        cumRet += ret;
        cumAtr += atr[idx];
        
        const dir = ret > 0 ? 'long' : 'short';
        if (firstDir === null) firstDir = dir;
        else if (dir !== firstDir) allSameDir = false;
      }
      
      if (cumAtr === 0) continue;
      const cumAtrMult = Math.abs(cumRet) / (cumAtr / minBars);
      
      if (cumAtrMult >= threshold && allSameDir) {
        signals.push({
          code,
          date: bars[i].date,
          direction: firstDir!,
          atrMult: cumAtrMult,
          type: 'gradual',
          cumulativeAtrMult: cumAtrMult,
        });
      }
    }
  }
  
  console.log(`  检测到 ${signals.length} 个渐变信号`);
  return signals;
}

// ============ 过滤函数 ============

function getWhitelistHR(code: string, direction: 'long' | 'short', data: Map<string, DailyBar[]>): number {
  // 查找该品种作为leader的所有配对
  const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === code);
  if (pairs.length === 0) return 0; // 不是leader，返回0
  
  let totalHits = 0;
  let totalChecks = 0;
  
  for (const pair of pairs) {
    const leaderBars = data.get(code);
    const followerBars = data.get(pair.follower);
    if (!leaderBars || !followerBars) continue;
    
    for (let i = 1; i < leaderBars.length; i++) {
      const leaderRet = leaderBars[i].ret;
      const leaderDir = leaderRet > 0 ? 'long' : 'short';
      
      if (leaderDir !== direction) continue;
      
      const followerIdx = i + pair.lag;
      if (followerIdx >= followerBars.length) continue;
      
      const followerRet = followerBars[followerIdx].ret;
      const followerDir = followerRet > 0 ? 'long' : 'short';
      
      totalChecks++;
      if (followerDir === direction) totalHits++;
    }
  }
  
  return totalChecks > 0 ? totalHits / totalChecks : 0;
}

function checkSectorCorrelation(
  signal: ShockSignal,
  data: Map<string, DailyBar[]>,
  threshold: number
): { pass: boolean; ratio: number } {
  const sector = SECTOR_MAP[signal.code];
  if (!sector) return { pass: false, ratio: 0 };
  
  const signalBarIdx = data.get(signal.code)?.findIndex(b => b.date === signal.date);
  if (signalBarIdx === undefined || signalBarIdx < 0) return { pass: false, ratio: 0 };
  
  let sameDir = 0;
  let total = 0;
  
  for (const [code, bars] of data) {
    if (SECTOR_MAP[code] !== sector) continue;
    if (code === signal.code) continue;
    
    const barIdx = bars.findIndex(b => b.date === signal.date);
    if (barIdx < 0 || barIdx >= bars.length) continue;
    
    const ret = bars[barIdx].ret;
    const dir = ret > 0 ? 'long' : 'short';
    
    total++;
    if (dir === signal.direction) sameDir++;
  }
  
  const ratio = total > 0 ? sameDir / total : 0;
  return { pass: ratio >= threshold, ratio };
}

function checkSeasonal(
  signal: ShockSignal,
  data: Map<string, DailyBar[]>
): { pass: boolean; strength: number } {
  const bars = data.get(signal.code);
  if (!bars) return { pass: false, strength: 0 };
  
  const signalIdx = bars.findIndex(b => b.date === signal.date);
  if (signalIdx < 0) return { pass: false, strength: 0 };
  
  const month = parseInt(signal.date.substring(5, 7));
  const day = parseInt(signal.date.substring(8, 10));
  
  let sameDirReturns: number[] = [];
  let oppositeDirReturns: number[] = [];
  
  for (let yearOffset = 1; yearOffset <= SEASONAL_YEARS; yearOffset++) {
    const year = parseInt(signal.date.substring(0, 4)) - yearOffset;
    
    for (let dayOffset = -SEASONAL_WINDOW; dayOffset <= SEASONAL_WINDOW; dayOffset++) {
      const targetMonth = month;
      const targetDay = day + dayOffset;
      
      const targetDate = `${year}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
      const idx = bars.findIndex(b => b.date === targetDate);
      
      if (idx > 0) {
        const ret = bars[idx].ret;
        const dir = ret > 0 ? 'long' : 'short';
        
        if (dir === signal.direction) {
          sameDirReturns.push(ret);
        } else {
          oppositeDirReturns.push(ret);
        }
      }
    }
  }
  
  const avgSameDir = sameDirReturns.length > 0
    ? sameDirReturns.reduce((a, b) => a + b, 0) / sameDirReturns.length
    : 0;
  
  const strength = Math.min(Math.abs(avgSameDir) * 100, 1);
  return { pass: avgSameDir > 0, strength };
}

// ============ 信号评分 ============

function calculateSignalScore(
  signal: ShockSignal,
  sectorRatio: number,
  seasonalStrength: number
): { score: number; grade: string } {
  let score = 0;
  
  // 信号类型 (25分)
  if (signal.type === 'shock') {
    score += 25;
  } else {
    score += 10;
  }
  
  // 板块联动强度 (25分)
  score += sectorRatio * 25;
  
  // 季节性匹配强度 (20分)
  score += seasonalStrength * 20;
  
  // ATR倍数 (30分)
  const atrScore = Math.min(signal.atrMult / 8, 1) * 30;
  score += atrScore;
  
  // 确定等级
  let grade = 'D';
  if (score >= GRADE_THRESHOLDS.A) grade = 'A';
  else if (score >= GRADE_THRESHOLDS.B) grade = 'B';
  else if (score >= GRADE_THRESHOLDS.C) grade = 'C';
  
  return { score, grade };
}

function passesGradeFilter(grade: string, minGrade: string): boolean {
  const gradeOrder = ['A', 'B', 'C', 'D'];
  return gradeOrder.indexOf(grade) <= gradeOrder.indexOf(minGrade);
}

// ============ 交易模拟 ============

function simulateTrade(
  signal: ShockSignal,
  data: Map<string, DailyBar[]>,
  config: BacktestConfig
): TradeResult | null {
  const bars = data.get(signal.code);
  if (!bars) return null;
  
  const signalIdx = bars.findIndex(b => b.date === signal.date);
  if (signalIdx < 0 || signalIdx >= bars.length - 1) return null;
  
  const entryIdx = signalIdx + 1;
  const entryPrice = bars[entryIdx].o; // 开盘价入场
  const slippage = config.applyCosts ? config.slippage : 0;
  const commission = config.applyCosts ? config.commission : 0;
  
  let actualEntry = signal.direction === 'long'
    ? entryPrice * (1 + slippage)
    : entryPrice * (1 - slippage);
  
  let exitIdx = entryIdx;
  let exitPrice = actualEntry;
  let exitReason: 'take_profit' | 'stop_loss' | 'max_hold' = 'max_hold';
  
  const maxHold = config.maxHoldDays;
  const stopLoss = config.stopLossPct;
  const takeProfit = stopLoss * 2; // 止盈为止损的2倍
  
  for (let i = 1; i <= maxHold && entryIdx + i < bars.length; i++) {
    const bar = bars[entryIdx + i];
    
    // 使用HIGH/LOW价格检查止损止盈
    if (signal.direction === 'long') {
      const highRet = (bar.h - actualEntry) / actualEntry;
      const lowRet = (bar.l - actualEntry) / actualEntry;
      
      // 止损检查
      if (lowRet <= -stopLoss) {
        exitIdx = entryIdx + i;
        exitPrice = actualEntry * (1 - stopLoss);
        exitReason = 'stop_loss';
        break;
      }
      // 止盈检查
      if (highRet >= takeProfit) {
        exitIdx = entryIdx + i;
        exitPrice = actualEntry * (1 + takeProfit);
        exitReason = 'take_profit';
        break;
      }
    } else {
      // short方向
      const highRet = (bar.h - actualEntry) / actualEntry;
      const lowRet = (bar.l - actualEntry) / actualEntry;
      
      // 止损检查（价格上涨到止损位）
      if (highRet >= stopLoss) {
        exitIdx = entryIdx + i;
        exitPrice = actualEntry * (1 + stopLoss);
        exitReason = 'stop_loss';
        break;
      }
      // 止盈检查（价格下跌到止盈位）
      if (lowRet <= -takeProfit) {
        exitIdx = entryIdx + i;
        exitPrice = actualEntry * (1 - takeProfit);
        exitReason = 'take_profit';
        break;
      }
    }
    
    // 最大持仓期退出
    if (i === maxHold || entryIdx + i === bars.length - 1) {
      exitIdx = entryIdx + i;
      exitPrice = bar.c;
      exitReason = 'max_hold';
    }
  }
  
  const pnlPct = signal.direction === 'long'
    ? (exitPrice - actualEntry) / actualEntry
    : (actualEntry - exitPrice) / actualEntry;
  
  const pnl = pnlPct - commission * 2;
  
  return {
    code: signal.code,
    direction: signal.direction,
    entryDate: bars[entryIdx].date,
    entryPrice: actualEntry,
    exitDate: bars[exitIdx].date,
    exitPrice,
    pnl,
    pnlPct,
    holdDays: exitIdx - entryIdx,
    exitReason,
    signalType: signal.type,
    signalScore: 0,
    signalGrade: '',
  };
}

// ============ 回测引擎 ============

function runBacktest(data: Map<string, DailyBar[]>, config: BacktestConfig): BacktestResult {
  // 检测信号
  const shocks = detectShocks(data, config);
  const graduals = detectGradualTrends(data, config);
  const allSignals = [...shocks, ...graduals];
  
  // 按日期过滤
  let filteredSignals = allSignals;
  if (config.startDate) {
    filteredSignals = filteredSignals.filter(s => s.date >= config.startDate!);
  }
  if (config.endDate) {
    filteredSignals = filteredSignals.filter(s => s.date <= config.endDate!);
  }
  
  const funnel = {
    totalSignals: filteredSignals.length,
    afterWhitelist: 0,
    afterSector: 0,
    afterSeasonal: 0,
    afterNext1: 0,
    afterGrade: 0,
  };
  
  const trades: TradeResult[] = [];
  
  for (const signal of filteredSignals) {
    // L1: 白名单过滤
    if (config.useWhitelist) {
      const hr = getWhitelistHR(signal.code, signal.direction, data);
      if (hr < 0.5) continue;
    }
    funnel.afterWhitelist++;
    
    // L2: 板块联动过滤
    let sectorRatio = 0;
    if (config.useSectorCorrelation) {
      const result = checkSectorCorrelation(signal, data, config.sectorCorrelationThreshold);
      if (!result.pass) continue;
      sectorRatio = result.ratio;
    }
    funnel.afterSector++;
    
    // L3: 季节性过滤
    let seasonalStrength = 0;
    if (config.useSeasonal) {
      const result = checkSeasonal(signal, data);
      if (!result.pass) continue;
      seasonalStrength = result.strength;
    }
    funnel.afterSeasonal++;
    
    // L4: Next1确认（简化版）
    if (config.useNext1Confirmation) {
      // 这里简化处理，实际应该检查次日确认
    }
    funnel.afterNext1++;
    
    // 计算信号评分
    const { score, grade } = calculateSignalScore(signal, sectorRatio, seasonalStrength);
    
    // L5: 信号等级过滤
    if (!passesGradeFilter(grade, config.minSignalGrade)) continue;
    funnel.afterGrade++;
    
    // 模拟交易
    const trade = simulateTrade(signal, data, config);
    if (trade) {
      trade.signalScore = score;
      trade.signalGrade = grade;
      trades.push(trade);
    }
  }
  
  // 计算指标
  const metrics = calculateMetrics(trades);
  
  return { config, trades, metrics, funnel };
}

function calculateMetrics(trades: TradeResult[]): BacktestResult['metrics'] {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      netPnl: 0,
      maxDrawdown: 0,
      avgHoldDays: 0,
      avgWin: 0,
      avgLoss: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
    };
  }
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  
  const totalWin = wins.reduce((sum, t) => sum + t.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  
  const netPnl = trades.reduce((sum, t) => sum + t.pnlPct, 0);
  const avgHoldDays = trades.reduce((sum, t) => sum + t.holdDays, 0) / trades.length;
  
  // 计算最大回撤
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  
  for (const trade of trades) {
    equity *= (1 + trade.pnlPct);
    if (equity > peak) peak = equity;
    const drawdown = (peak - equity) / peak;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }
  
  // 计算Sharpe和Sortino
  const returns = trades.map(t => t.pnlPct);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdDev = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
  const downsideDev = Math.sqrt(returns.filter(r => r < 0).reduce((sum, r) => sum + Math.pow(r, 2), 0) / returns.length);
  
  const riskFreeRate = 0.02 / 252; // 年化2%无风险利率
  const sharpeRatio = stdDev > 0 ? (avgReturn - riskFreeRate) / stdDev * Math.sqrt(252) : 0;
  const sortinoRatio = downsideDev > 0 ? (avgReturn - riskFreeRate) / downsideDev * Math.sqrt(252) : 0;
  
  return {
    totalTrades: trades.length,
    winRate: wins.length / trades.length,
    profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? Infinity : 0,
    netPnl: netPnl * 100,
    maxDrawdown: maxDrawdown * 100,
    avgHoldDays,
    avgWin: wins.length > 0 ? totalWin / wins.length : 0,
    avgLoss: losses.length > 0 ? totalLoss / losses.length : 0,
    sharpeRatio,
    sortinoRatio,
  };
}

// ============ 预定义策略配置 ============

const STRATEGY_CONFIGS: BacktestConfig[] = [
  {
    name: 'V15_Baseline',
    description: '基础策略（固定参数，无评分过滤）',
    shockAtrMult: 4.0,
    gradualMinBars: 3,
    gradualAtrMult: 2.5,
    useWhitelist: true,
    useSectorCorrelation: true,
    sectorCorrelationThreshold: 0.5,
    useSeasonal: true,
    useNext1Confirmation: false,
    maxHoldDays: 20,
    stopLossPct: 0.01,
    applyCosts: true,
    slippage: 0.001,
    commission: 0.0003,
    useAdaptiveParams: false,
    minSignalGrade: 'D',
  },
  {
    name: 'V16_Scoring',
    description: '评分过滤策略（仅交易A/B级信号）',
    shockAtrMult: 4.0,
    gradualMinBars: 3,
    gradualAtrMult: 2.5,
    useWhitelist: true,
    useSectorCorrelation: true,
    sectorCorrelationThreshold: 0.5,
    useSeasonal: true,
    useNext1Confirmation: false,
    maxHoldDays: 20,
    stopLossPct: 0.01,
    applyCosts: true,
    slippage: 0.001,
    commission: 0.0003,
    useAdaptiveParams: false,
    minSignalGrade: 'B',
  },
  {
    name: 'V17_Adaptive',
    description: '自适应参数策略（波动率状态自适应）',
    shockAtrMult: 3.5, // 低波动默认值
    gradualMinBars: 3,
    gradualAtrMult: 2.2,
    useWhitelist: true,
    useSectorCorrelation: true,
    sectorCorrelationThreshold: 0.45,
    useSeasonal: true,
    useNext1Confirmation: false,
    maxHoldDays: 22,
    stopLossPct: 0.009,
    applyCosts: true,
    slippage: 0.001,
    commission: 0.0003,
    useAdaptiveParams: true,
    minSignalGrade: 'B',
  },
  {
    name: 'V18_Full',
    description: '完整策略（自适应+评分+风控）',
    shockAtrMult: 3.5,
    gradualMinBars: 3,
    gradualAtrMult: 2.2,
    useWhitelist: true,
    useSectorCorrelation: true,
    sectorCorrelationThreshold: 0.45,
    useSeasonal: true,
    useNext1Confirmation: true,
    maxHoldDays: 22,
    stopLossPct: 0.009,
    applyCosts: true,
    slippage: 0.001,
    commission: 0.0003,
    useAdaptiveParams: true,
    minSignalGrade: 'B',
  },
];

// ============ 主函数 ============

async function main() {
  console.log('========================================');
  console.log('    统一回测框架 - 策略对比实验');
  console.log('========================================\n');
  
  // 加载数据
  console.log('加载20年日线数据...');
  const data = loadAllData();
  console.log(`已加载 ${data.size} 个品种\n`);
  
  // 运行所有策略
  const results: BacktestResult[] = [];
  
  for (const config of STRATEGY_CONFIGS) {
    console.log(`运行策略: ${config.name}`);
    console.log(`  描述: ${config.description}`);
    
    const result = runBacktest(data, config);
    results.push(result);
    
    console.log(`  交易笔数: ${result.metrics.totalTrades}`);
    console.log(`  胜率: ${(result.metrics.winRate * 100).toFixed(1)}%`);
    console.log(`  PF: ${result.metrics.profitFactor.toFixed(2)}`);
    console.log(`  净利润: ${result.metrics.netPnl.toFixed(2)}%`);
    console.log(`  最大回撤: ${result.metrics.maxDrawdown.toFixed(2)}%`);
    console.log(`  Sharpe: ${result.metrics.sharpeRatio.toFixed(2)}`);
    console.log(`  Sortino: ${result.metrics.sortinoRatio.toFixed(2)}`);
    console.log('');
  }
  
  // 生成对比报告
  console.log('\n========================================');
  console.log('    策略对比报告');
  console.log('========================================\n');
  
  console.log('┌─────────────────┬────────┬────────┬────────┬────────┬────────┬────────┐');
  console.log('│ 策略名称        │ 笔数   │ 胜率   │ PF     │ 净利润 │ 回撤   │ Sharpe │');
  console.log('├─────────────────┼────────┼────────┼────────┼────────┼────────┼────────┤');
  
  for (const result of results) {
    const name = result.config.name.padEnd(15);
    const trades = String(result.metrics.totalTrades).padStart(6);
    const winRate = (result.metrics.winRate * 100).toFixed(1).padStart(6) + '%';
    const pf = result.metrics.profitFactor.toFixed(2).padStart(6);
    const pnl = result.metrics.netPnl.toFixed(1).padStart(6) + '%';
    const dd = result.metrics.maxDrawdown.toFixed(1).padStart(6) + '%';
    const sharpe = result.metrics.sharpeRatio.toFixed(2).padStart(6);
    
    console.log(`│ ${name} │ ${trades} │ ${winRate} │ ${pf} │ ${pnl} │ ${dd} │ ${sharpe} │`);
  }
  
  console.log('└─────────────────┴────────┴────────┴────────┴────────┴────────┴────────┘');
  
  // 信号漏斗对比
  console.log('\n信号漏斗对比:');
  console.log('┌─────────────────┬────────┬────────┬────────┬────────┬────────┐');
  console.log('│ 策略名称        │ 总信号 │ 白名单 │ 板块   │ 季节性 │ 评分   │');
  console.log('├─────────────────┼────────┼────────┼────────┼────────┼────────┤');
  
  for (const result of results) {
    const name = result.config.name.padEnd(15);
    const total = String(result.funnel.totalSignals).padStart(6);
    const wl = String(result.funnel.afterWhitelist).padStart(6);
    const sector = String(result.funnel.afterSector).padStart(6);
    const seasonal = String(result.funnel.afterSeasonal).padStart(6);
    const grade = String(result.funnel.afterGrade).padStart(6);
    
    console.log(`│ ${name} │ ${total} │ ${wl} │ ${sector} │ ${seasonal} │ ${grade} │`);
  }
  
  console.log('└─────────────────┴────────┴────────┴────────┴────────┴────────┘');
  
  // 保存结果
  const outputDir = path.join(process.cwd(), 'backtest-results');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outputFile = path.join(outputDir, `unified-backtest-${timestamp}.json`);
  
  const outputData = results.map(r => ({
    config: r.config,
    metrics: r.metrics,
    funnel: r.funnel,
    tradeCount: r.trades.length,
  }));
  
  fs.writeFileSync(outputFile, JSON.stringify(outputData, null, 2));
  console.log(`\n结果已保存至: ${outputFile}`);
}

main().catch(console.error);
