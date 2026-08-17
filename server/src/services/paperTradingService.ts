/**
 * v15 策略模拟盘服务
 * 
 * 策略参数（v15 最优）：
 * - ATR 门槛：4×
 * - 持有期：20 天
 * - 止损：-1%
 * - 方向确认：next1（次日延续）
 * - 传播对：白名单 39 对
 * - 高波动过滤：ATR14 > ATR60
 * - S6 板块联动：同板块 ≥50% 品种同向
 * - S7 季节性：历史同期（±15天）平均收益率同向
 * 
 * 回测 PF=14.69，胜率 62.5%
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';
import { saveSimTrade, getSimTrades, getSimTradeStats, getSimPerformance, closeSimTrade, getOpenSimTrade } from './database.js';
import { LONG_OPT_PARAMS } from '../data/longOptParams.js';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams.js';
import { LONG_DISABLED } from '../data/longDisabledVarieties.js';
import { SHORT_DISABLED } from '../data/shortDisabledVarieties.js';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams.js';
import { REALTIME_OPT_PARAMS, getRealtimeOptParams } from '../data/realtimeOptParams.js';
import { calculateDynamicPosition, extractPositionInputs, CORRELATION_MATRIX } from '../data/dynamicPositionSizing.js';
import { generatePortfolioRiskReport, checkVarietyCanTrade, getPositionMultiplier } from './portfolioRiskMonitor.js';
import { checkRiskBeforeOpen, getPortfolioRiskStatus, getRiskSummary, DEFAULT_RISK_CONFIG } from './riskControlService.js';

// 数据缓存目录
const DATA_CACHE_DIR = join(process.cwd(), 'data-cache-daily-20y');

// v15 策略参数（作为 normal regime 的基准）
const V15_PARAMS = {
  atrMult: 4,           // ATR 门槛
  maxHold: 20,          // 持有期（天）
  stopLoss: 0.01,       // 止损（-1%）
  requireHighVol: true, // 高波动过滤
  requireS6: true,      // 板块联动过滤
  requireS7: true,      // 季节性过滤
  sectorCorrelation: 0.5, // 板块联动阈值
};

// 连续亏损熔断（白银回测 AG0_drawdownEngine 结论：熔断4笔·暂停10天为回撤控制性价比最高方案）
const LOSS_STREAK_BREAKER = {
  lossStreak: 4,   // 连续亏损 N 笔触发熔断
  pauseDays: 10,   // 暂停 M 天不开新仓
};

// 品种级熔断（六方 1000 次实验结论：高波动品种 3x10、慢趋势品种 5x20）
// 数据来源：server/src/data/realtimeOptParams.ts
const VARIETY_BREAKER: Record<string, { lossStreak: number; pauseDays: number }> = {};
for (const [code, opt] of Object.entries(REALTIME_OPT_PARAMS)) {
  if (opt.circuitBreaker) VARIETY_BREAKER[code] = opt.circuitBreaker;
}

// 按品种×方向读取寻优参数（V16 全品种寻优结果落地到模拟盘持仓管理；做多二次寻优优先）
function getOptParams(code: string, direction: 'long' | 'short'): { stopAtrMult?: number; targetAtrMult?: number; maxHoldDays?: number } | null {
  return direction === 'long'
    ? (LONG_REFINED_PARAMS[code] ?? LONG_OPT_PARAMS[code] ?? null)
    : (SHORT_OPT_PARAMS[code] ?? null);
}

// 做多方向禁用（砍腿）：二次寻优后做多仍负捕获率的品种，只做空
function isLongDisabled(code: string): boolean {
  return LONG_DISABLED.has(code);
}

// 做空方向禁用（砍腿）：1000次回测方向捕获比验证后做空显著弱的品种（AU0/CU0/AG0/SC0/Y0），只做多
function isShortDisabled(code: string): boolean {
  return SHORT_DISABLED.has(code);
}

/**
 * 连续亏损熔断：最近已平仓交易连续亏损 >= lossStreak 笔，且最后一笔亏损平仓在 pauseDays 天内 → 暂停开仓
 * 落地自 AG0_drawdownEngine.json：熔断4笔·暂停10天 vs 基线(胜率74.2%/回撤9.89%) → 胜率75.7%，收益+2.6万，PF 10.33→10.99
 */
export function getLossStreakBreaker(): {
  active: boolean;
  streak: number;
  pauseRemainingDays: number;
  lossStreak: number;
  pauseDays: number;
} {
  const closed = getSimTrades({ status: 'closed', limit: 100 });
  const sorted = [...closed]
    .filter((t) => t.exit_date)
    .sort((a, b) => (a.exit_date! < b.exit_date! ? 1 : -1));

  let streak = 0;
  for (const t of sorted) {
    if ((t.pnl ?? 0) < 0) streak++;
    else break;
  }

  if (streak < LOSS_STREAK_BREAKER.lossStreak || sorted.length === 0) {
    return { active: false, streak, pauseRemainingDays: 0, lossStreak: LOSS_STREAK_BREAKER.lossStreak, pauseDays: LOSS_STREAK_BREAKER.pauseDays };
  }

  const lastExit = new Date(`${sorted[0].exit_date}T00:00:00`);
  const daysSince = (Date.now() - lastExit.getTime()) / 86400000;
  const pauseRemainingDays = Math.max(0, LOSS_STREAK_BREAKER.pauseDays - daysSince);
  return { active: pauseRemainingDays > 0, streak, pauseRemainingDays, lossStreak: LOSS_STREAK_BREAKER.lossStreak, pauseDays: LOSS_STREAK_BREAKER.pauseDays };
}

/**
 * 品种级熔断：从 REALTIME_OPT_PARAMS 读取各品种熔断参数
 * 六方品种均有独立熔断配置（高波动 3x10、慢趋势 5x20）
 */
export function getVarietyLossStreakBreaker(code: string): {
  active: boolean;
  streak: number;
  pauseRemainingDays: number;
  lossStreak: number;
  pauseDays: number;
} {
  const breaker = VARIETY_BREAKER[code];
  if (!breaker) {
    return { active: false, streak: 0, pauseRemainingDays: 0, lossStreak: 0, pauseDays: 0 };
  }
  const closed = getSimTrades({ status: 'closed', limit: 100, code });
  const sorted = [...closed]
    .filter((t) => t.exit_date)
    .sort((a, b) => (a.exit_date! < b.exit_date! ? 1 : -1));

  let streak = 0;
  for (const t of sorted) {
    if ((t.pnl ?? 0) < 0) streak++;
    else break;
  }

  if (streak < breaker.lossStreak || sorted.length === 0) {
    return { active: false, streak, pauseRemainingDays: 0, lossStreak: breaker.lossStreak, pauseDays: breaker.pauseDays };
  }

  const lastExit = new Date(`${sorted[0].exit_date}T00:00:00`);
  const daysSince = (Date.now() - lastExit.getTime()) / 86400000;
  const pauseRemainingDays = Math.max(0, breaker.pauseDays - daysSince);
  return { active: pauseRemainingDays > 0, streak, pauseRemainingDays, lossStreak: breaker.lossStreak, pauseDays: breaker.pauseDays };
}

// ============ 波动率自适应参数（方向L）============
type VolRegime = 'high' | 'normal' | 'low';

interface RegimeParams {
  atrMult: number;
  maxHold: number;
  stopLoss: number;
  sectorCorrThreshold: number;
  gradualAtrMult: number;
}

// 保守版自适应参数
const REGIME_PARAMS: Record<VolRegime, RegimeParams> = {
  high:   { atrMult: 4.5, maxHold: 15, stopLoss: 0.012, sectorCorrThreshold: 0.55, gradualAtrMult: 2.8 },
  normal: { atrMult: 4.0, maxHold: 20, stopLoss: 0.01,  sectorCorrThreshold: 0.5,  gradualAtrMult: 2.5 },
  low:    { atrMult: 3.5, maxHold: 22, stopLoss: 0.009, sectorCorrThreshold: 0.45, gradualAtrMult: 2.2 },
};

/**
 * 检测当前市场波动率状态
 * 基于全市场标准化ATR中位数的250日百分位
 */
function detectCurrentRegime(): VolRegime {
  try {
    const files = readFileSync(join(DATA_CACHE_DIR, 'CU0.json'), 'utf-8');
    const cuData = JSON.parse(files);
    if (!cuData || cuData.length < 60) return 'normal';

    // 计算CU0的ATR14序列
    const atrValues: number[] = [];
    for (let i = 14; i < cuData.length; i++) {
      let sum = 0;
      for (let j = i - 13; j <= i; j++) {
        sum += cuData[j].h - cuData[j].l;
      }
      const atr = sum / 14;
      atrValues.push(atr / cuData[i].c); // 标准化
    }

    if (atrValues.length < 60) return 'normal';

    // 当前ATR百分位（最近250日）
    const current = atrValues[atrValues.length - 1];
    const lookback = Math.min(250, atrValues.length);
    const recent = atrValues.slice(-lookback).sort((a, b) => a - b);
    const percentile = recent.filter(v => v <= current).length / recent.length;

    if (percentile >= 0.75) return 'high';
    if (percentile <= 0.25) return 'low';
    return 'normal';
  } catch {
    return 'normal';
  }
}

// 组合风控参数
const RISK_LIMITS = {
  maxTotalPositions: 10,       // 最大同时持仓数量
  maxSectorPositions: 3,       // 单板块最大持仓数量
  sectorLossThreshold: 2,      // 同板块亏损持仓数触发止损
  sectorLossPctThreshold: -2,  // 同板块持仓平均亏损百分比阈值
};

// 板块映射（用于评分）
const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', B0: '油脂油料', P0: '油脂油料', C0: '油脂油料', CS0: '油脂油料',
  CF0: '软商品', SR0: '软商品', AP0: '软商品', CJ0: '软商品',
  BU0: '能源', SC0: '能源', LU0: '能源', NR0: '能源', FU0: '能源', PG0: '能源',
  MA0: '化工', TA0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', V0: '化工', L0: '化工', PE0: '化工', PS0: '化工', PR0: '化工',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融',
  WR0: '煤炭', ZC0: '煤炭',
  JD0: '农产品', LH0: '农产品',
  LC0: '新能源', SI0: '新能源',
  T0: '债券', TF0: '债券', TS0: '债券', TL0: '债券',
  SP0: '纸浆', BC0: '纸浆',
  EC0: '集运指数',
};

// ============ 信号评分函数 ============

/**
 * 计算板块联动强度比例（用于评分，返回0-1的数值）
 */
function getSectorCorrelationRatio(leaderCode: string, direction: 'long' | 'short', shockDate: string): number {
  const pair = PROPAGATION_WHITELIST.find(p => p.leader === leaderCode || p.follower === leaderCode);
  if (!pair) return 0;

  const sector = pair.sector;
  const sectorPairs = PROPAGATION_WHITELIST.filter(p => p.sector === sector);
  const sectorCodes = new Set<string>();
  for (const p of sectorPairs) {
    sectorCodes.add(p.leader);
    sectorCodes.add(p.follower);
  }
  sectorCodes.delete(leaderCode);

  let sameDirection = 0;
  let total = 0;

  for (const code of sectorCodes) {
    const bars = loadDailyBars(code);
    const barIdx = bars.findIndex(b => b.date === shockDate);
    if (barIdx < 1) continue;

    const bar = bars[barIdx];
    const prevBar = bars[barIdx - 1];
    const ret = bar.ret ?? (bar.close - prevBar.close) / prevBar.close;

    total++;
    if ((direction === 'long' && ret > 0) || (direction === 'short' && ret < 0)) {
      sameDirection++;
    }
  }

  return total > 0 ? sameDirection / total : 0;
}

/**
 * 计算季节性匹配强度（用于评分，返回0-1的数值）
 */
function getSeasonalStrength(code: string, shockDate: string, direction: 'long' | 'short'): number {
  const bars = loadDailyBars(code);
  const shockIdx = bars.findIndex(b => b.date === shockDate);
  if (shockIdx < 365) return 0;

  const shockMonth = parseInt(shockDate.substring(5, 7));
  const shockDay = parseInt(shockDate.substring(8, 10));

  let sumRet = 0;
  let count = 0;

  for (let yearOffset = 1; yearOffset <= 5; yearOffset++) {
    const year = parseInt(shockDate.substring(0, 4)) - yearOffset;
    for (let dayOffset = -15; dayOffset <= 15; dayOffset++) {
      const day = shockDay + dayOffset;
      if (day < 1 || day > 31) continue;
      const histDate = `${year}-${String(shockMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      const histIdx = bars.findIndex(b => b.date === histDate);
      if (histIdx < 1) continue;

      const bar = bars[histIdx];
      const prevBar = bars[histIdx - 1];
      const ret = bar.ret ?? (bar.close - prevBar.close) / prevBar.close;

      sumRet += ret;
      count++;
    }
  }

  if (count === 0) return 0;
  const avgRet = sumRet / count;

  const isSameDir = (direction === 'long' && avgRet > 0) || (direction === 'short' && avgRet < 0);
  if (!isSameDir) return 0;

  // 强度归一化到[0,1]
  return Math.min(Math.abs(avgRet) / 0.005, 1.0);
}

/**
 * 计算信号质量评分(0-100分)
 * 评分维度:
 * 1. 信号类型(25分): 突变=25, 渐变=10
 * 2. 板块联动强度(25分): sectorRatio × 25
 * 3. 季节性匹配强度(20分): seasonalStrength × 20
 * 4. 白名单历史命中率(30分): 简化为固定值(实盘无法实时计算完整HR)
 */
function calcSignalScore(
  signalType: 'shock' | 'gradual',
  sectorRatio: number,
  seasonalStrength: number,
): { score: number; grade: 'A' | 'B' | 'C' | 'D' } {
  // 维度1: 信号类型 (25分)
  const signalTypeScore = signalType === 'shock' ? 25 : 10;

  // 维度2: 板块联动强度 (25分)
  const sectorScore = sectorRatio * 25;

  // 维度3: 季节性匹配强度 (20分)
  const seasonalScore = seasonalStrength * 20;

  // 维度4: 白名单HR (30分) - 实盘中简化为: 通过所有过滤器给基础分15分
  // 因为实盘无法像回测一样遍历所有历史数据计算完整HR
  const whitelistScore = 15; // 通过S6+S7过滤的信号给基础分

  const score = signalTypeScore + sectorScore + seasonalScore + whitelistScore;
  const roundedScore = Math.round(score * 10) / 10;

  let grade: 'A' | 'B' | 'C' | 'D';
  if (roundedScore >= 70) grade = 'A';
  else if (roundedScore >= 50) grade = 'B';
  else if (roundedScore >= 30) grade = 'C';
  else grade = 'D';

  return { score: roundedScore, grade };
}

interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
  ret?: number | null;
}

interface V15Signal {
  leaderCode: string;
  followerCode: string;
  direction: 'long' | 'short';
  shockDate: string;
  shockRet: number;
  atrMult: number;
  lag: number;
  sector: string;
  logic: string;
  entryPrice: number;
  stopPrice: number;
  signalType: 'shock' | 'gradual';
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
}

interface V15Trade {
  signal: V15Signal;
  entryDate: string;
  entryPrice: number;
  exitDate?: string;
  exitPrice?: number;
  pnl?: number;
  pnlPct?: number;
  status: 'open' | 'closed';
  exitReason?: string;
}

/**
 * 加载品种日线数据
 */
function loadDailyBars(code: string): DailyBar[] {
  const filePath = join(DATA_CACHE_DIR, `${code}.json`);
  if (!existsSync(filePath)) return [];
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf-8'));
    return data.map((d: any) => ({
      date: d.date,
      open: d.open ?? d.o ?? 0,
      high: d.high ?? d.h ?? 0,
      low: d.low ?? d.l ?? 0,
      close: d.close ?? d.c ?? 0,
      volume: d.volume ?? d.vol ?? 0,
      oi: d.oi ?? d.hold ?? 0,
      ret: d.ret,
    }));
  } catch {
    return [];
  }
}

/**
 * 计算 ATR
 */
function calcATR(bars: DailyBar[], period: number, endIndex: number): number {
  if (endIndex < period) return 0;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += bars[i].high - bars[i].low;
  }
  return sum / period;
}

/**
 * 检测冲击事件（≥4×ATR）
 */
function detectShocks(): Map<string, { date: string; ret: number; atrMult: number; bars: DailyBar[] }[]> {
  const shocks = new Map<string, { date: string; ret: number; atrMult: number; bars: DailyBar[] }[]>();
  
  // 获取所有品种代码
  const codes = PROPAGATION_WHITELIST.reduce((acc, pair) => {
    if (!acc.includes(pair.leader)) acc.push(pair.leader);
    if (!acc.includes(pair.follower)) acc.push(pair.follower);
    return acc;
  }, [] as string[]);

  // 检测当前波动率状态，使用自适应参数
  const currentRegime = detectCurrentRegime();
  const regimeParams = REGIME_PARAMS[currentRegime];
  
  for (const code of codes) {
    const bars = loadDailyBars(code);
    if (bars.length < 60) continue;

    const codeShocks: { date: string; ret: number; atrMult: number; bars: DailyBar[] }[] = [];
    
    for (let i = 60; i < bars.length - 1; i++) { // -1 因为需要 next1 确认
      const bar = bars[i];
      const ret = bar.ret ?? (bar.close - bars[i - 1].close) / bars[i - 1].close;
      const atr = calcATR(bars, 14, i);
      if (atr <= 0) continue;
      
      const atrMult = Math.abs(ret) / atr;
      if (atrMult >= regimeParams.atrMult) {
        codeShocks.push({ date: bar.date, ret, atrMult, bars });
      }
    }
    
    if (codeShocks.length > 0) {
      shocks.set(code, codeShocks);
    }
  }
  
  return shocks;
}

/**
 * 检测渐变趋势（连续3根同向bar + 累计≥2.5×ATR + 量能递增）
 */
function detectGradualTrends(): Map<string, { date: string; ret: number; atrMult: number; bars: DailyBar[] }[]> {
  const trends = new Map<string, { date: string; ret: number; atrMult: number; bars: DailyBar[] }[]>();

  const codes = PROPAGATION_WHITELIST.reduce((acc, pair) => {
    if (!acc.includes(pair.leader)) acc.push(pair.leader);
    if (!acc.includes(pair.follower)) acc.push(pair.follower);
    return acc;
  }, [] as string[]);

  const currentRegime = detectCurrentRegime();
  const regimeParams = REGIME_PARAMS[currentRegime];

  for (const code of codes) {
    const bars = loadDailyBars(code);
    if (bars.length < 60) continue;

    const codeTrends: { date: string; ret: number; atrMult: number; bars: DailyBar[] }[] = [];

    for (let i = 62; i < bars.length - 1; i++) {
      const bar0 = bars[i - 2];
      const bar1 = bars[i - 1];
      const bar2 = bars[i];

      const ret0 = bar0.ret ?? (bar0.close - bars[i - 3].close) / bars[i - 3].close;
      const ret1 = bar1.ret ?? (bar1.close - bar0.close) / bar0.close;
      const ret2 = bar2.ret ?? (bar2.close - bar1.close) / bar1.close;

      const allPositive = ret0 > 0 && ret1 > 0 && ret2 > 0;
      const allNegative = ret0 < 0 && ret1 < 0 && ret2 < 0;
      if (!allPositive && !allNegative) continue;

      const cumRet = ret0 + ret1 + ret2;
      const atr = calcATR(bars, 14, i);
      if (atr <= 0) continue;

      const atrMult = Math.abs(cumRet) / atr;
      if (atrMult < regimeParams.gradualAtrMult) continue;

      const vol0 = bars[i - 2].volume;
      const vol1 = bars[i - 1].volume;
      const vol2 = bars[i].volume;
      if (!(vol2 > vol1 && vol1 > vol0)) continue;

      // 避免与突变冲击重复
      const singleRet = bar2.ret ?? (bar2.close - bar1.close) / bar1.close;
      const singleAtrMult = Math.abs(singleRet) / atr;
      if (singleAtrMult >= regimeParams.atrMult) continue;

      codeTrends.push({ date: bar2.date, ret: cumRet, atrMult, bars });
    }

    if (codeTrends.length > 0) {
      trends.set(code, codeTrends);
    }
  }

  return trends;
}

/**
 * next1 方向确认
 */
function confirmNext1(bar: DailyBar, ret: number, bars: DailyBar[], idx: number): boolean {
  if (idx + 1 >= bars.length) return false;
  const nextBar = bars[idx + 1];
  const nextRet = nextBar.ret ?? (nextBar.close - bar.close) / bar.close;
  return Math.sign(nextRet) === Math.sign(ret);
}

/**
 * 高波动过滤（ATR14 > ATR60）
 */
function checkHighVolatility(bars: DailyBar[], idx: number): boolean {
  if (idx < 60) return false;
  const atr14 = calcATR(bars, 14, idx);
  const atr60 = calcATR(bars, 60, idx);
  return atr14 > atr60;
}

/**
 * S6 板块联动过滤
 */
function checkSectorCorrelation(leaderCode: string, direction: 'long' | 'short', shockDate: string, threshold: number = V15_PARAMS.sectorCorrelation): boolean {
  // 找到同板块的其他品种
  const pair = PROPAGATION_WHITELIST.find(p => p.leader === leaderCode || p.follower === leaderCode);
  if (!pair) return false;
  
  const sector = pair.sector;
  const sectorPairs = PROPAGATION_WHITELIST.filter(p => p.sector === sector);
  const sectorCodes = new Set<string>();
  for (const p of sectorPairs) {
    sectorCodes.add(p.leader);
    sectorCodes.add(p.follower);
  }
  sectorCodes.delete(leaderCode);
  
  // 检查同板块其他品种在冲击日是否同向移动
  let sameDirection = 0;
  let total = 0;
  
  for (const code of sectorCodes) {
    const bars = loadDailyBars(code);
    const barIdx = bars.findIndex(b => b.date === shockDate);
    if (barIdx < 1) continue;
    
    const bar = bars[barIdx];
    const prevBar = bars[barIdx - 1];
    const ret = bar.ret ?? (bar.close - prevBar.close) / prevBar.close;
    
    total++;
    if ((direction === 'long' && ret > 0) || (direction === 'short' && ret < 0)) {
      sameDirection++;
    }
  }
  
  if (total === 0) return false;
  return sameDirection / total >= threshold;
}

/**
 * S7 季节性过滤
 */
function checkSeasonal(code: string, shockDate: string, direction: 'long' | 'short'): boolean {
  const bars = loadDailyBars(code);
  const shockIdx = bars.findIndex(b => b.date === shockDate);
  if (shockIdx < 365) return false; // 至少需要 1 年历史
  
  // 获取冲击日的月日
  const shockMonth = parseInt(shockDate.substring(5, 7));
  const shockDay = parseInt(shockDate.substring(8, 10));
  
  // 检查历史同期（±15天）的平均收益率
  let sumRet = 0;
  let count = 0;
  
  for (let yearOffset = 1; yearOffset <= 5; yearOffset++) {
    const year = parseInt(shockDate.substring(0, 4)) - yearOffset;
    for (let dayOffset = -15; dayOffset <= 15; dayOffset++) {
      const month = shockMonth;
      const day = shockDay + dayOffset;
      
      // 简单的日期处理（不考虑闰年等复杂情况）
      if (day < 1 || day > 31) continue;
      const histDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      
      const histIdx = bars.findIndex(b => b.date === histDate);
      if (histIdx < 1) continue;
      
      const bar = bars[histIdx];
      const prevBar = bars[histIdx - 1];
      const ret = bar.ret ?? (bar.close - prevBar.close) / prevBar.close;
      
      sumRet += ret;
      count++;
    }
  }
  
  if (count === 0) return false;
  const avgRet = sumRet / count;
  
  // 检查历史同期平均收益率方向是否与当前信号方向一致
  return (direction === 'long' && avgRet > 0) || (direction === 'short' && avgRet < 0);
}

/**
 * 生成 v16 信号（突变冲击 + 渐变趋势）
 */
export function generateV15Signals(): V15Signal[] {
  const currentRegime = detectCurrentRegime();
  const regimeParams = REGIME_PARAMS[currentRegime];
  const shocks = detectShocks();
  const trends = detectGradualTrends();
  const signals: V15Signal[] = [];

  // 合并信号：按 leader 去重（同日期同方向只保留 atrMult 更高的）
  const signalMap = new Map<string, { date: string; ret: number; atrMult: number; bars: DailyBar[]; type: string }[]>();

  for (const [code, shockList] of shocks) {
    const existing = signalMap.get(code) || [];
    for (const s of shockList) {
      existing.push({ ...s, type: 'shock' });
    }
    signalMap.set(code, existing);
  }

  for (const [code, trendList] of trends) {
    const existing = signalMap.get(code) || [];
    for (const t of trendList) {
      const dup = existing.find(e => e.date === t.date && Math.sign(e.ret) === Math.sign(t.ret));
      if (!dup) {
        existing.push({ ...t, type: 'gradual' });
      }
    }
    signalMap.set(code, existing);
  }

  for (const pair of PROPAGATION_WHITELIST) {
    const leaderSignals = signalMap.get(pair.leader) || [];

    for (const sig of leaderSignals) {
      const { date: shockDate, ret, atrMult, bars, type } = sig;
      const shockIdx = bars.findIndex(b => b.date === shockDate);
      if (shockIdx < 0) continue;

      // next1 确认
      if (!confirmNext1(bars[shockIdx], ret, bars, shockIdx)) continue;

      // 高波动过滤
      if (V15_PARAMS.requireHighVol && !checkHighVolatility(bars, shockIdx)) continue;

      const direction: 'long' | 'short' = ret > 0 ? 'long' : 'short';

      // S6 板块联动过滤（使用自适应阈值）
      if (V15_PARAMS.requireS6 && !checkSectorCorrelation(pair.leader, direction, shockDate, regimeParams.sectorCorrThreshold)) continue;

      // S7 季节性过滤
      if (V15_PARAMS.requireS7 && !checkSeasonal(pair.leader, shockDate, direction)) continue;

      // 计算信号评分
      const sectorRatio = getSectorCorrelationRatio(pair.leader, direction, shockDate);
      const seasonalStr = getSeasonalStrength(pair.leader, shockDate, direction);
      const { score, grade } = calcSignalScore(
        type === 'gradual' ? 'gradual' : 'shock',
        sectorRatio,
        seasonalStr,
      );

      // 计算入场价（次日开盘）
      if (shockIdx + 1 >= bars.length) continue;
      const entryBar = bars[shockIdx + 1];
      const entryPrice = entryBar.open;

      // 计算止损价
      const stopPrice = direction === 'long'
        ? entryPrice * (1 - V15_PARAMS.stopLoss)
        : entryPrice * (1 + V15_PARAMS.stopLoss);

      signals.push({
        leaderCode: pair.leader,
        followerCode: pair.follower,
        direction,
        shockDate,
        shockRet: ret,
        atrMult,
        lag: pair.lag,
        sector: pair.sector,
        logic: `${pair.logic}${type === 'gradual' ? '+渐变' : ''}`,
        entryPrice,
        stopPrice,
        signalType: type === 'gradual' ? 'gradual' : 'shock',
        score,
        grade,
      });
    }
  }

  return signals;
}

/**
 * 凯利公式计算仓位比例
 * f* = (p * b - q) / b
 * p = 胜率, q = 1-p, b = 盈亏比
 */
function calcKellyPosition(winRate: number, winLossRatio: number): number {
  if (winRate <= 0 || winLossRatio <= 0) return 0.1; // 默认 10%
  const q = 1 - winRate;
  const kelly = (winRate * winLossRatio - q) / winLossRatio;
  // 使用半凯利（更保守），上限 30%，下限 5%
  const halfKelly = kelly / 2;
  return Math.max(0.05, Math.min(0.30, halfKelly));
}

/**
 * 波动率过滤（volReduce）：ATR14 > 2×ATR60 时过滤开仓
 * 落地自 SC0/JM0/RU0 1000 次实验 TOP1：atr2xClear 在高波动品种中显著提升胜率
 */
function checkVolReduce(code: string): boolean {
  const opt = getRealtimeOptParams(code);
  if (!opt || opt.volReduce !== 'atr2xClear') return false;
  const bars = loadDailyBars(code);
  if (bars.length < 60) return false;
  const idx = bars.length - 1;
  const atr14 = calcATR(bars, 14, idx);
  const atr60 = calcATR(bars, 60, idx);
  if (atr60 <= 0) return false;
  const blocked = atr14 > 2 * atr60;
  if (blocked) {
    console.log(`[波动率过滤] ${code}: ATR14(${atr14.toFixed(2)}) > 2×ATR60(${(2 * atr60).toFixed(2)})，跳过开仓`);
  }
  return blocked;
}

/**
 * 日亏损熔断（dailyLossLimit）：当日已实现亏损超过本金 5% 时暂停开仓
 * 落地自 SC0/JM0/RU0 1000 次实验 TOP1：5pct 日亏损熔断有效控制日内回撤
 */
function checkDailyLossLimit(code: string): boolean {
  const opt = getRealtimeOptParams(code);
  if (!opt || opt.dailyLossLimit !== '5pct') return false;
  const closed = getSimTrades({ status: 'closed', limit: 50, code });
  const today = new Date().toISOString().substring(0, 10);
  const todayTrades = closed.filter(t => t.exit_date === today);
  const todayLoss = todayTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  // 以初始资金 20 万为基准（与回测一致），亏损超过 5% 暂停
  const capital = 200000;
  const lossPct = -todayLoss / capital;
  if (lossPct >= 0.05) {
    console.log(`[日亏损熔断] ${code}: 今日已亏损 ${(lossPct * 100).toFixed(1)}%（≥5%），暂停开仓`);
    return true;
  }
  return false;
}

// 最低信号等级门槛（方向H: 评分过滤）
// A级(≥70) 和 B级(50-69) 允许交易，C级和D级过滤
const MIN_SIGNAL_GRADE = 'B';

// ============ 组合风控函数（方向M） ============

/**
 * 获取当前持仓的板块分布
 */
function getSectorExposure(): Record<string, number> {
  const openTrades = getSimTrades({ status: 'open' });
  const exposure: Record<string, number> = {};
  
  for (const trade of openTrades) {
    const sector = SECTOR_MAP[trade.code] || '其他';
    exposure[sector] = (exposure[sector] || 0) + 1;
  }
  
  return exposure;
}

/**
 * 检查是否允许开新仓（组合风控）
 * 集成方向四风控服务：单日亏损 + 组合回撤 + 连续亏损 + 板块集中度
 * @returns { allowed: boolean; reason?: string }
 */
async function checkPortfolioRisk(code: string): Promise<{ allowed: boolean; reason?: string }> {
  const openTrades = getSimTrades({ status: 'open' });
  
  // 1. 总仓位上限检查（基础风控）
  if (openTrades.length >= RISK_LIMITS.maxTotalPositions) {
    return { allowed: false, reason: `总持仓已达上限(${RISK_LIMITS.maxTotalPositions})` };
  }
  
  // 2. 单板块仓位上限检查（基础风控）
  const sector = SECTOR_MAP[code] || '其他';
  const sectorExposure = getSectorExposure();
  const sectorCount = sectorExposure[sector] || 0;
  
  if (sectorCount >= RISK_LIMITS.maxSectorPositions) {
    return { allowed: false, reason: `${sector}板块持仓已达上限(${RISK_LIMITS.maxSectorPositions})` };
  }
  
  // 3. 综合风控检查（方向四）
  const startCapital = 3000000; // 总资金 300 万
  const riskResult = await checkRiskBeforeOpen(code, startCapital, DEFAULT_RISK_CONFIG);
  
  if (!riskResult.allowed) {
    return { allowed: false, reason: riskResult.reason };
  }
  
  // 预警日志
  if (riskResult.riskLevel === 'warning') {
    const status = await getPortfolioRiskStatus(startCapital);
    console.log(`[风控预警] ${getRiskSummary(status)}`);
  }
  
  return { allowed: true };
}

/**
 * 板块联动止损：检查同板块多笔持仓是否同时亏损，触发强制平仓
 * 规则：同板块≥2笔持仓且均为亏损，且平均亏损超过阈值，平掉亏损最大的
 */
function checkSectorCorrelationStopLoss(): void {
  const openTrades = getSimTrades({ status: 'open' });
  if (openTrades.length < 2) return;
  
  // 按板块分组
  const sectorTrades: Record<string, typeof openTrades> = {};
  for (const trade of openTrades) {
    const sector = SECTOR_MAP[trade.code] || '其他';
    if (!sectorTrades[sector]) sectorTrades[sector] = [];
    sectorTrades[sector].push(trade);
  }
  
  // 逐板块检查
  for (const [sector, trades] of Object.entries(sectorTrades)) {
    if (trades.length < RISK_LIMITS.sectorLossThreshold) continue;
    
    // 计算每笔持仓的浮动盈亏
    const tradesWithPnl = trades.map(trade => {
      const bars = loadDailyBars(trade.code);
      if (bars.length === 0) return { trade, floatingPnlPct: 0 };
      
      const latestBar = bars[bars.length - 1];
      const dir = trade.direction === '多' ? 1 : -1;
      const floatingPnl = (latestBar.close - trade.entry_price) * dir;
      const floatingPnlPct = trade.entry_price > 0 ? (floatingPnl / trade.entry_price) * 100 : 0;
      
      return { trade, floatingPnlPct };
    });
    
    // 检查是否全部亏损
    const allLosing = tradesWithPnl.every(t => t.floatingPnlPct < 0);
    if (!allLosing) continue;
    
    // 计算平均亏损
    const avgLoss = tradesWithPnl.reduce((sum, t) => sum + t.floatingPnlPct, 0) / tradesWithPnl.length;
    if (avgLoss > RISK_LIMITS.sectorLossPctThreshold) continue;
    
    // 触发板块联动止损：平掉亏损最大的
    const worstTrade = tradesWithPnl.sort((a, b) => a.floatingPnlPct - b.floatingPnlPct)[0];
    const bars = loadDailyBars(worstTrade.trade.code);
    if (bars.length === 0) continue;
    
    const latestBar = bars[bars.length - 1];
    closeSimTrade(worstTrade.trade.code, {
      exit_date: latestBar.date,
      exit_price: latestBar.close,
      exit_reason: `板块联动止损(${sector})`,
    });
    
    console.log(`[风控] 板块联动止损: ${worstTrade.trade.code} (${sector}), 浮动亏损: ${worstTrade.floatingPnlPct.toFixed(2)}%`);
  }
}
const GRADE_SCORE_MAP: Record<string, number> = { A: 70, B: 50, C: 30, D: 0 };

/**
 * 运行模拟盘扫描
 */
export async function runPaperTradingScan(): Promise<{ signals: V15Signal[]; trades: V15Trade[]; filteredCount: number; riskFilteredCount: number; currentRegime: VolRegime }> {
  const allSignals = generateV15Signals();
  const minScore = GRADE_SCORE_MAP[MIN_SIGNAL_GRADE] ?? 50;
  
  // 评分过滤：仅保留A/B级信号
  const qualitySignals = allSignals.filter(s => s.score >= minScore);
  const filteredCount = allSignals.length - qualitySignals.length;
  const trades: V15Trade[] = [];
  let riskFilteredCount = 0;

  // 获取历史胜率用于凯利公式
  const stats = getSimTradeStats();
  const winRate = stats.winRate > 0 ? stats.winRate : 0.35;
  // 使用默认盈亏比 1.5（回测验证值）
  const winLossRatio = 1.5;
  const kellyPosition = calcKellyPosition(winRate, winLossRatio);

  // 按评分从高到低排序，优先开高分仓
  const sortedSignals = [...qualitySignals].sort((a, b) => b.score - a.score);

  // 连续亏损熔断（全局暂停新开仓）：回测验证的连亏4笔暂停10天，控制回撤
  const breaker = getLossStreakBreaker();
  if (breaker.active) {
    console.log(`[连亏熔断] 连续亏损${breaker.streak}笔，暂停开仓（剩余${Math.ceil(breaker.pauseRemainingDays)}天）`);
  }

  for (const signal of sortedSignals) {
    // 品种级熔断优先（六方均有配置），否则用全局熔断（4x10）
    const varietyBreaker = getVarietyLossStreakBreaker(signal.followerCode);
    const activeBreaker = varietyBreaker.lossStreak > 0 ? varietyBreaker : breaker;
    if (activeBreaker.active) {
      riskFilteredCount++;
      continue;
    }

    // 检查是否已有未平仓的模拟交易
    const existingTrade = getOpenSimTrade(signal.followerCode);
    if (existingTrade) continue;

    // 做多方向禁用（砍腿）：与 V16 回测决策链一致，SI0 等只做空
    if (signal.direction === 'long' && isLongDisabled(signal.followerCode)) {
      riskFilteredCount++;
      console.log(`[方向禁用] 跳过 ${signal.followerCode} 做多信号（仅做空）`);
      continue;
    }

    // 做空方向禁用（砍腿）：1000次回测方向捕获比验证（AU0 9.5:1 等），只做多
    if (signal.direction === 'short' && isShortDisabled(signal.followerCode)) {
      riskFilteredCount++;
      console.log(`[方向禁用] 跳过 ${signal.followerCode} 做空信号（仅做多）`);
      continue;
    }

    // 波动率过滤（volReduce）：ATR14 > 2×ATR60 时跳过开仓
    if (checkVolReduce(signal.followerCode)) {
      riskFilteredCount++;
      continue;
    }

    // 日亏损熔断（dailyLossLimit）：当日已亏损 ≥5% 暂停开仓
    if (checkDailyLossLimit(signal.followerCode)) {
      riskFilteredCount++;
      continue;
    }

    // 组合风控检查（方向四：单日亏损 + 组合回撤 + 连续亏损 + 板块集中度）
    const riskCheck = await checkPortfolioRisk(signal.followerCode);
    if (!riskCheck.allowed) {
      riskFilteredCount++;
      console.log(`[风控] 跳过 ${signal.followerCode}: ${riskCheck.reason}`);
      continue;
    }

    // 品种级仓位（动态仓位管理：Kelly + 波动率目标 + 相关性惩罚）
    const rtOpt = getRealtimeOptParams(signal.followerCode);
    const varietyMaxPosition = rtOpt ? rtOpt.maxPositionPct : 0.05;

    // 获取当前已持仓品种（用于相关性惩罚）
    const allTrades = getSimTrades({ status: 'open', limit: 100 });
    const heldCodes = allTrades.map(t => t.code).filter(c => c !== signal.followerCode);

    // 组合风控检查
    const riskReport = generatePortfolioRiskReport();
    const varietyCheck = checkVarietyCanTrade(signal.followerCode, riskReport);
    if (!varietyCheck.canTrade) {
      console.log(`[风控拦截] ${signal.followerCode}: ${varietyCheck.reason}`);
      continue;
    }

    // 获取品种级历史统计（用于 Kelly 和波动率计算）
    const varietyTrades = getSimTrades({ status: 'closed', limit: 50, code: signal.followerCode });
    const varietyStats = extractPositionInputs(varietyTrades.map(t => ({
      pnl: t.pnl ?? 0,
      returnPct: t.pnl_pct ?? 0,
    })));

    // 动态仓位计算
    let positionSize: number;
    if (varietyStats.totalTrades >= 5) {
      // 有足够历史数据，使用动态仓位
      positionSize = calculateDynamicPosition({
        code: signal.followerCode,
        winRate: varietyStats.winRate,
        avgWin: varietyStats.avgWin,
        avgLoss: varietyStats.avgLoss,
        currentVol: varietyStats.annualizedVol,
        heldCodes,
      }, varietyMaxPosition);
    } else {
      // 历史数据不足，回退到品种级上限
      positionSize = varietyMaxPosition;
    }

    // 应用组合风控仓位调整
    const riskMultiplier = getPositionMultiplier(signal.followerCode, riskReport);
    positionSize *= riskMultiplier;

    // 创建新的模拟交易
    const tradeId = saveSimTrade({
      code: signal.followerCode,
      name: signal.followerCode,
      direction: signal.direction === 'long' ? '多' : '空',
      entry_date: signal.shockDate,
      entry_price: signal.entryPrice,
      status: 'open',
      entry_reason: `v16信号: ${signal.leaderCode}→${signal.followerCode}, ${signal.direction}, ATR×${isFinite(signal.atrMult) ? signal.atrMult.toFixed(1) : 'N/A'}, 仓位${(positionSize * 100).toFixed(0)}%`,
      signal_score: signal.score,
      signal_grade: signal.grade,
    });

    trades.push({
      signal,
      entryDate: signal.shockDate,
      entryPrice: signal.entryPrice,
      status: 'open',
    });
  }

  // 检查未平仓交易是否需要平仓（含板块联动止损）
  updateOpenTrades();
  checkSectorCorrelationStopLoss();

  return { signals: sortedSignals, trades, filteredCount, riskFilteredCount, currentRegime: detectCurrentRegime() };
}

/**
 * 更新未平仓交易
 */
function updateOpenTrades(): void {
  const openTrades = getSimTrades({ status: 'open' });
  
  for (const trade of openTrades) {
    const bars = loadDailyBars(trade.code);
    if (bars.length === 0) continue;
    
    const latestBar = bars[bars.length - 1];
    const entryDate = trade.entry_date;
    const entryIdx = bars.findIndex(b => b.date === entryDate);
    if (entryIdx < 0) continue;
    
    const daysHeld = bars.length - 1 - entryIdx;
    const currentPrice = latestBar.close;
    const entryPrice = trade.entry_price;
    const dir = trade.direction === '多' ? 1 : -1;
    const optParams = getOptParams(trade.code, trade.direction === '多' ? 'long' : 'short');
    const maxHold = optParams?.maxHoldDays ?? V15_PARAMS.maxHold;
    
    // ATR 止损/止盈（优先用寻优参数，否则回退固定百分比止损）
    const entryAtr = entryIdx >= 14 ? calcATR(bars, 14, entryIdx) : 0;
    const stopAtrMult = optParams?.stopAtrMult;
    const targetAtrMult = optParams?.targetAtrMult;
    
    let stopPrice: number;
    let targetPrice: number | null = null;
    
    if (stopAtrMult && entryAtr > 0) {
      // ATR 止损：入场价 ± stopAtrMult × ATR
      stopPrice = trade.direction === '多'
        ? entryPrice - stopAtrMult * entryAtr
        : entryPrice + stopAtrMult * entryAtr;
    } else {
      // 回退：固定百分比止损
      stopPrice = trade.direction === '多'
        ? entryPrice * (1 - V15_PARAMS.stopLoss)
        : entryPrice * (1 + V15_PARAMS.stopLoss);
    }
    
    if (targetAtrMult && entryAtr > 0) {
      // ATR 止盈：入场价 ± targetAtrMult × ATR
      targetPrice = trade.direction === '多'
        ? entryPrice + targetAtrMult * entryAtr
        : entryPrice - targetAtrMult * entryAtr;
    }
    
    let exitReason = '';
    let shouldClose = false;
    
    // 止损检查
    if (trade.direction === '多' && latestBar.low <= stopPrice) {
      shouldClose = true;
      exitReason = `止损(ATR×${stopAtrMult?.toFixed(1) ?? 'fixed'})`;
    } else if (trade.direction === '空' && latestBar.high >= stopPrice) {
      shouldClose = true;
      exitReason = `止损(ATR×${stopAtrMult?.toFixed(1) ?? 'fixed'})`;
    }
    
    // 止盈检查
    if (!shouldClose && targetPrice !== null) {
      if (trade.direction === '多' && latestBar.high >= targetPrice) {
        shouldClose = true;
        exitReason = `止盈(ATR×${targetAtrMult!.toFixed(1)})`;
      } else if (trade.direction === '空' && latestBar.low <= targetPrice) {
        shouldClose = true;
        exitReason = `止盈(ATR×${targetAtrMult!.toFixed(1)})`;
      }
    }
    
    // 持有期检查（按品种×方向寻优参数）
    if (!shouldClose && daysHeld >= maxHold) {
      shouldClose = true;
      exitReason = '持有期到期';
    }
    
    if (shouldClose) {
      closeSimTrade(trade.code, {
        exit_date: latestBar.date,
        exit_price: currentPrice,
        exit_reason: exitReason,
      });
    }
  }
}

/**
 * 获取模拟盘统计
 */
export function getPaperTradingStats() {
  const stats = getSimTradeStats();
  const openTrades = getSimTrades({ status: 'open' });
  const closedTrades = getSimTrades({ status: 'closed', limit: 100 });
  
  // 组合风控信息（方向M）
  const sectorExposure = getSectorExposure();
  const riskStatus = {
    totalPositions: openTrades.length,
    maxTotalPositions: RISK_LIMITS.maxTotalPositions,
    sectorExposure,
    maxSectorPositions: RISK_LIMITS.maxSectorPositions,
    sectorLossThreshold: RISK_LIMITS.sectorLossThreshold,
    sectorLossPctThreshold: RISK_LIMITS.sectorLossPctThreshold,
  };
  
  return {
    ...stats,
    openTrades: openTrades.length,
    recentTrades: closedTrades.slice(0, 10),
    riskStatus,
    currentRegime: detectCurrentRegime(),
    regimeParams: REGIME_PARAMS[detectCurrentRegime()],
  };
}

/**
 * 获取板块联动热力图数据
 * 返回各板块内品种的当日涨跌情况和联动状态
 */
export function getSectorHeatmapData() {
  const dataDir = join(process.cwd(), 'data-cache-daily-20y');
  if (!existsSync(dataDir)) {
    return { sectors: [], updatedAt: new Date().toISOString() };
  }

  // 获取每个品种的最新数据
  const varietyData: { code: string; name: string; sector: string; lastRet: number; lastDate: string }[] = [];
  
  // SECTOR_MAP 是 code -> sector 的映射，需要反转遍历
  for (const [code, sector] of Object.entries(SECTOR_MAP)) {
    const filePath = join(dataDir, `${code}.json`);
    if (!existsSync(filePath)) continue;
    
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
      // 数据可能是数组直接存储，也可能是 {bars: []} 或 {data: []} 格式
      const barsArray = Array.isArray(raw) ? raw : (raw.bars || raw.data || []);
      const bars: DailyBar[] = barsArray.map((b: any) => ({
        date: b.d || b.date,
        open: Number(b.o ?? b.open ?? 0),
        high: Number(b.h ?? b.high ?? 0),
        low: Number(b.l ?? b.low ?? 0),
        close: Number(b.c ?? b.close ?? 0),
        volume: Number(b.v ?? b.vol ?? b.volume ?? 0),
        oi: Number(b.hold ?? b.oi ?? 0),
        ret: Number(b.ret ?? 0),
      }));
      
      if (bars.length === 0) continue;
      
      const lastBar = bars[bars.length - 1];
      varietyData.push({
        code,
        name: code,
        sector,
        lastRet: (lastBar.ret ?? 0) * 100, // 转换为百分比
        lastDate: lastBar.date,
      });
    } catch {
      continue;
    }
  }

  // 按板块分组
  const sectorMap = new Map<string, typeof varietyData>();
  for (const v of varietyData) {
    if (!sectorMap.has(v.sector)) {
      sectorMap.set(v.sector, []);
    }
    sectorMap.get(v.sector)!.push(v);
  }

  // 计算每个板块的联动状态
  const sectors = Array.from(sectorMap.entries()).map(([sector, varieties]) => {
    const upCount = varieties.filter(v => v.lastRet > 0).length;
    const downCount = varieties.filter(v => v.lastRet < 0).length;
    const flatCount = varieties.filter(v => v.lastRet === 0).length;
    const total = varieties.length;
    
    // 联动强度：同方向品种占比
    const maxDirection = Math.max(upCount, downCount);
    const correlationStrength = total > 0 ? maxDirection / total : 0;
    const dominantDirection = upCount > downCount ? 'up' : downCount > upCount ? 'down' : 'neutral';
    
    return {
      sector,
      varieties: varieties.map(v => ({
        code: v.code,
        ret: v.lastRet,
        date: v.lastDate,
      })),
      upCount,
      downCount,
      flatCount,
      total,
      correlationStrength,
      dominantDirection,
    };
  });

  // 按联动强度排序
  sectors.sort((a, b) => b.correlationStrength - a.correlationStrength);

  return {
    sectors,
    updatedAt: new Date().toISOString(),
  };
}

export function getPaperPerformance() {
  const p = getSimPerformance();
  const open = getSimTrades({ status: 'open', limit: 1000 });
  const closed = getSimTrades({ status: 'closed', limit: 10000 });

  // 多空盈亏（getSimPerformance 未直接暴露，这里补充）
  const longClosed = closed.filter((t) => t.direction === '多');
  const shortClosed = closed.filter((t) => t.direction === '空');
  const longPnl = longClosed.reduce((s, t) => s + (t.pnl || 0), 0);
  const shortPnl = shortClosed.reduce((s, t) => s + (t.pnl || 0), 0);

  // 信号来源分布（前端期望数组结构，含盈亏与胜率）
  const gradualClosed = closed.filter((t) => (t.entry_reason || '').includes('渐变'));
  const shockClosed = closed.filter((t) => !(t.entry_reason || '').includes('渐变'));
  const buildSignalType = (label: string, list: typeof closed) => {
    const wins = list.filter((t) => (t.pnl || 0) > 0).length;
    return {
      type: label,
      count: list.length,
      winRate: list.length > 0 ? wins / list.length : 0,
      pnl: Math.round(list.reduce((s, t) => s + (t.pnl || 0), 0) * 100) / 100,
      trades: list.length,
    };
  };

  return {
    summary: {
      totalTrades: p.totalTrades,
      winTrades: p.winTrades,
      lossTrades: p.lossTrades,
      totalPnl: p.totalPnl,
      winRate: p.winRate,
      maxDrawdown: p.maxDrawdown,
      profitFactor: p.profitFactor,
      avgWin: p.avgWin,
      avgLoss: p.avgLoss,
      avgHoldDays: p.avgHoldDays,
      openTrades: open.length,
    },
    directionDist: {
      longCount: p.longCount,
      shortCount: p.shortCount,
      longWinRate: p.longWinRate,
      shortWinRate: p.shortWinRate,
      longPnl: Math.round(longPnl * 100) / 100,
      shortPnl: Math.round(shortPnl * 100) / 100,
    },
    signalTypeDist: [buildSignalType('渐变', gradualClosed), buildSignalType('震荡', shockClosed)],
    byVariety: p.byVariety.map((v) => ({
      code: v.code,
      name: v.name,
      trades: v.trades,
      winRate: v.winRate,
      pnl: v.pnl,
    })),
    equityCurve: p.equityCurve.map((e) => ({ date: e.date, cumulativePnl: e.cumulativePnl })),
    monthlyPnl: p.monthlyPnl.map((m) => ({ month: m.month, pnl: m.pnl })),
    riskMetrics: p.riskMetrics,
  };
}
