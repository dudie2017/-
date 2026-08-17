/**
 * 方向H: 信号质量评分回测
 * 
 * 对每个通过过滤链的信号计算质量评分(0-100分)，分为A/B/C/D四个等级，
 * 验证高等级信号是否显著优于低等级信号。
 * 
 * 评分维度(总计100分):
 * 1. 信号类型(25分): 突变=25分, 渐变=10分
 * 2. 白名单历史命中率(30分): pair的历史同向率 × 30
 * 3. 板块联动强度(25分): 同板块同向比例 × 25
 * 4. 季节性匹配强度(20分): 历史同期平均收益方向一致性 × 20
 * 
 * 分级: A(≥70), B(50-69), C(30-49), D(<30)
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

// ============ 常量 ============
const ATR_PERIOD = 14;
const ATR_LONG = 60;
const SHOCK_ATR_MULT = 4;
const GRADUAL_THRESHOLD = 2.5;
const SLIPPAGE = 0.0005;
const COMMISSION = 0.0001;
const MAX_HOLD = 20;
const STOP_LOSS = 0.02;
const SECTOR_CORR_THRESHOLD = 0.5;
const SEASONAL_WINDOW = 15;
const VOLATILITY_FILTER = true;

// ============ 板块映射 ============
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

// ============ 数据类型 ============
interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number | null;
}

interface Shock {
  code: string;
  date: string;
  barIdx: number;
  direction: 'up' | 'down';
  ret: number;
  atrMult: number;
  signalType: 'shock' | 'gradual';
}

interface ScoreDetail {
  signalTypeScore: number;
  whitelistHR: number;
  whitelistScore: number;
  sectorRatio: number;
  sectorScore: number;
  seasonalStrength: number;
  seasonalScore: number;
}

interface ScoredTrade {
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
  pnl: number;
  grossPnl: number;
  code: string;
  direction: 'up' | 'down';
  date: string;
  signalType: 'shock' | 'gradual';
  scoreDetail: ScoreDetail;
}

// ============ 数据加载 ============
const DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

function loadAllData(): Map<string, DailyBar[]> {
  const data = new Map<string, DailyBar[]>();
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
    if (bars.length > 100) data.set(code, bars);
  }
  return data;
}

// ============ ATR计算 ============
function calcATR(bars: DailyBar[], period: number): number[] {
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) { atr.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += bars[j].h - bars[j].l;
    }
    atr.push(sum / period);
  }
  return atr;
}

// ============ 冲击检测 ============
function detectShocks(data: Map<string, DailyBar[]>): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);

    for (let i = ATR_LONG + 1; i < bars.length; i++) {
      const bar = bars[i];
      const prevBar = bars[i - 1];
      if (bar.ret === null || atr[i] === 0) continue;

      const priceChange = Math.abs(bar.c - prevBar.c);
      const mult = priceChange / atr[i];

      if (mult >= SHOCK_ATR_MULT) {
        if (VOLATILITY_FILTER && atrLong[i] > 0 && atr[i] < atrLong[i]) continue;

        shocks.push({
          code,
          date: bar.date,
          barIdx: i,
          direction: bar.ret > 0 ? 'up' : 'down',
          ret: bar.ret,
          atrMult: mult,
          signalType: 'shock',
        });
      }
    }
  }
  return shocks;
}

// ============ 渐变型趋势检测 ============
function detectGradualTrends(data: Map<string, DailyBar[]>): Shock[] {
  const trends: Shock[] = [];
  const CONSECUTIVE_BARS = 3;

  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);

    for (let i = ATR_LONG + CONSECUTIVE_BARS; i < bars.length; i++) {
      if (atr[i] === 0) continue;

      let allUp = true;
      let allDown = true;
      let cumRet = 0;

      for (let j = 0; j < CONSECUTIVE_BARS; j++) {
        const idx = i - CONSECUTIVE_BARS + 1 + j;
        const bar = bars[idx];
        const prevBar = bars[idx - 1];
        if (!bar || !prevBar || bar.ret === null) { allUp = false; allDown = false; break; }

        if (bar.ret <= 0) allUp = false;
        if (bar.ret >= 0) allDown = false;
        cumRet += bar.ret;
      }

      if ((!allUp && !allDown) || cumRet === 0) continue;

      const cumATR = cumRet * bars[i].c / atr[i];
      if (Math.abs(cumATR) < GRADUAL_THRESHOLD) continue;

      if (VOLATILITY_FILTER && atrLong[i] > 0 && atr[i] < atrLong[i]) continue;

      trends.push({
        code,
        date: bars[i].date,
        barIdx: i,
        direction: allUp ? 'up' : 'down',
        ret: cumRet,
        atrMult: Math.abs(cumATR),
        signalType: 'gradual',
      });
    }
  }
  return trends;
}

// ============ 评分维度: 板块联动强度(返回数值比例) ============
function getSectorCorrelationRatio(shock: Shock, data: Map<string, DailyBar[]>): number {
  const leaderSector = SECTOR_MAP[shock.code];
  if (!leaderSector) return 0;

  const sameSectorCodes = Object.entries(SECTOR_MAP)
    .filter(([code, sector]) => sector === leaderSector && code !== shock.code)
    .map(([code]) => code);

  if (sameSectorCodes.length === 0) return 0;

  let sameDirection = 0;
  let total = 0;

  for (const code of sameSectorCodes) {
    const otherBars = data.get(code);
    if (!otherBars) continue;

    const otherBar = otherBars[shock.barIdx];
    if (!otherBar || otherBar.ret === null) continue;

    total++;
    const sameDir = (shock.direction === 'up' && otherBar.ret > 0) ||
                    (shock.direction === 'down' && otherBar.ret < 0);
    if (sameDir) sameDirection++;
  }

  return total > 0 ? sameDirection / total : 0;
}

// ============ 评分维度: 季节性匹配强度(返回数值) ============
function getSeasonalStrength(shock: Shock, data: Map<string, DailyBar[]>): number {
  const bars = data.get(shock.code);
  if (!bars) return 0;

  const seasonalReturns: number[] = [];
  for (let yearOffset = 1; yearOffset <= 5; yearOffset++) {
    for (let dayOffset = -SEASONAL_WINDOW; dayOffset <= SEASONAL_WINDOW; dayOffset++) {
      const targetIdx = shock.barIdx - yearOffset * 252 + dayOffset;
      if (targetIdx < 0 || targetIdx >= bars.length) continue;

      const bar = bars[targetIdx];
      if (bar.ret !== null) {
        seasonalReturns.push(bar.ret);
      }
    }
  }

  if (seasonalReturns.length === 0) return 0;

  const avgReturn = seasonalReturns.reduce((a, b) => a + b, 0) / seasonalReturns.length;
  
  // 方向一致性: 同向返回正值, 反向返回0
  const isSameDir = (shock.direction === 'up' && avgReturn > 0) ||
                    (shock.direction === 'down' && avgReturn < 0);
  
  if (!isSameDir) return 0;
  
  // 强度: |avgReturn| / 典型日收益(0.005), 归一化到[0,1]
  const strength = Math.min(Math.abs(avgReturn) / 0.005, 1.0);
  return strength;
}

// ============ 评分维度: 白名单历史命中率 ============
function calcWhitelistHR(
  leaderCode: string,
  direction: 'up' | 'down',
  data: Map<string, DailyBar[]>
): number {
  const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === leaderCode);
  if (pairs.length === 0) return 0;

  let totalHits = 0;
  let totalChecks = 0;

  for (const pair of pairs) {
    const leaderBars = data.get(pair.leader);
    const followerBars = data.get(pair.follower);
    if (!leaderBars || !followerBars) continue;

    // 统计leader历史冲击后follower的同向率
    const leaderAtr = calcATR(leaderBars, ATR_PERIOD);
    
    // 采样历史冲击点
    const sampleIndices: number[] = [];
    for (let i = ATR_LONG + 1; i < leaderBars.length - 30; i++) {
      if (leaderAtr[i] === 0 || leaderBars[i].ret === null) continue;
      const mult = Math.abs(leaderBars[i].c - leaderBars[i - 1].c) / leaderAtr[i];
      if (mult >= SHOCK_ATR_MULT * 0.8) {
        sampleIndices.push(i);
      }
    }
    
    // 取最近50个样本
    const recentSamples = sampleIndices.slice(-50);
    
    for (const idx of recentSamples) {
      const leaderBar = leaderBars[idx];
      const leaderDir = leaderBar.ret! > 0 ? 'up' : 'down';
      
      const entryIdx = idx + 1 + pair.lag;
      if (entryIdx >= followerBars.length - 1) continue;
      
      const entryBar = followerBars[entryIdx];
      const exitBar = followerBars[Math.min(entryIdx + MAX_HOLD, followerBars.length - 1)];
      
      const followerRet = (exitBar.c - entryBar.c) / entryBar.c;
      const followerDir = followerRet > 0 ? 'up' : 'down';
      
      // 只统计与当前信号方向一致的leader冲击
      if (leaderDir === direction) {
        totalChecks++;
        if (followerDir === direction) totalHits++;
      }
    }
  }

  return totalChecks > 0 ? totalHits / totalChecks : 0.5; // 默认0.5
}

// ============ 综合评分 ============
function calcSignalScore(
  signalType: 'shock' | 'gradual',
  whitelistHR: number,
  sectorRatio: number,
  seasonalStrength: number,
): { score: number; detail: ScoreDetail } {
  // 维度1: 信号类型 (25分)
  const signalTypeScore = signalType === 'shock' ? 25 : 10;

  // 维度2: 白名单历史命中率 (30分)
  const whitelistScore = whitelistHR * 30;

  // 维度3: 板块联动强度 (25分)
  const sectorScore = sectorRatio * 25;

  // 维度4: 季节性匹配强度 (20分)
  const seasonalScore = seasonalStrength * 20;

  const score = signalTypeScore + whitelistScore + sectorScore + seasonalScore;

  return {
    score: Math.round(score * 10) / 10,
    detail: {
      signalTypeScore,
      whitelistHR: Math.round(whitelistHR * 1000) / 1000,
      whitelistScore: Math.round(whitelistScore * 10) / 10,
      sectorRatio: Math.round(sectorRatio * 1000) / 1000,
      sectorScore: Math.round(sectorScore * 10) / 10,
      seasonalStrength: Math.round(seasonalStrength * 1000) / 1000,
      seasonalScore: Math.round(seasonalScore * 10) / 10,
    },
  };
}

function getGrade(score: number): 'A' | 'B' | 'C' | 'D' {
  if (score >= 70) return 'A';
  if (score >= 50) return 'B';
  if (score >= 30) return 'C';
  return 'D';
}

// ============ 交易模拟 ============
function simulateTrade(
  entryPrice: number,
  exitPrice: number,
  direction: 'up' | 'down',
): { pnl: number; grossPnl: number } {
  const slippageCost = SLIPPAGE * 2;
  const commissionCost = COMMISSION * 2;

  const grossPnl = direction === 'up'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;

  const netPnl = grossPnl - slippageCost - commissionCost;

  return { pnl: netPnl * 0.2, grossPnl: grossPnl * 0.2 }; // 固定20%仓位
}

// ============ 主回测流程 ============
function runScoringBacktest(data: Map<string, DailyBar[]>) {
  console.log('=== 信号质量评分回测 ===\n');

  // 1. 检测信号
  const shocks = detectShocks(data);
  const graduals = detectGradualTrends(data);
  const allSignals = [...shocks, ...graduals];
  
  console.log(`突变信号: ${shocks.length}`);
  console.log(`渐变信号: ${graduals.length}`);
  console.log(`总信号数: ${allSignals.length}`);

  // 2. 过滤链 + 评分
  const scoredTrades: ScoredTrade[] = [];
  let funnelL1 = 0;
  let funnelL2 = 0;
  let funnelL3 = 0;
  let funnelL4 = 0;

  // 缓存白名单HR(避免重复计算)
  const hrCache = new Map<string, number>();

  for (const signal of allSignals) {
    // L1: 白名单覆盖
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === signal.code);
    if (pairs.length === 0) continue;
    funnelL1++;

    // L2: 板块联动 (保留数值用于评分)
    const sectorRatio = getSectorCorrelationRatio(signal, data);
    if (sectorRatio < SECTOR_CORR_THRESHOLD) continue;
    funnelL2++;

    // L3: 季节性
    const seasonalStr = getSeasonalStrength(signal, data);
    if (seasonalStr === 0) continue; // 方向不一致
    funnelL3++;

    // L4: next1确认
    const leaderBars = data.get(signal.code);
    if (!leaderBars) continue;
    const nextBar = leaderBars[signal.barIdx + 1];
    if (!nextBar || nextBar.ret === null) continue;
    const next1Confirm = (signal.direction === 'up' && nextBar.ret > 0) ||
                         (signal.direction === 'down' && nextBar.ret < 0);
    if (!next1Confirm) continue;
    funnelL4++;

    // 计算白名单HR(带缓存)
    const hrKey = `${signal.code}_${signal.direction}`;
    if (!hrCache.has(hrKey)) {
      hrCache.set(hrKey, calcWhitelistHR(signal.code, signal.direction, data));
    }
    const whitelistHR = hrCache.get(hrKey)!;

    // 计算评分
    const { score, detail } = calcSignalScore(
      signal.signalType,
      whitelistHR,
      sectorRatio,
      seasonalStr,
    );
    const grade = getGrade(score);

    // 对每个follower模拟交易
    for (const pair of pairs) {
      const followerBars = data.get(pair.follower);
      if (!followerBars) continue;

      const entryIdx = signal.barIdx + 1 + pair.lag;
      if (entryIdx >= followerBars.length) continue;

      const entryBar = followerBars[entryIdx];

      // 持有MAX_HOLD天或止损
      let exitIdx = entryIdx;
      for (let d = 1; d <= MAX_HOLD && entryIdx + d < followerBars.length; d++) {
        const bar = followerBars[entryIdx + d];
        const pnl = signal.direction === 'up'
          ? (bar.c - entryBar.c) / entryBar.c
          : (entryBar.c - bar.c) / entryBar.c;

        if (pnl <= -STOP_LOSS) {
          exitIdx = entryIdx + d;
          break;
        }
        exitIdx = entryIdx + d;
      }

      const exitBar = followerBars[exitIdx];
      const result = simulateTrade(entryBar.c, exitBar.c, signal.direction);

      scoredTrades.push({
        score,
        grade,
        pnl: result.pnl,
        grossPnl: result.grossPnl,
        code: pair.follower,
        direction: signal.direction,
        date: signal.date,
        signalType: signal.signalType,
        scoreDetail: detail,
      });
    }
  }

  // 3. 输出漏斗
  console.log(`\n=== 过滤漏斗 ===`);
  console.log(`L1 白名单: ${funnelL1}`);
  console.log(`L2 板块联动: ${funnelL2} (${funnelL1 > 0 ? ((funnelL2 / funnelL1) * 100).toFixed(1) : 0}%)`);
  console.log(`L3 季节性: ${funnelL3} (${funnelL2 > 0 ? ((funnelL3 / funnelL2) * 100).toFixed(1) : 0}%)`);
  console.log(`L4 next1确认: ${funnelL4} (${funnelL3 > 0 ? ((funnelL4 / funnelL3) * 100).toFixed(1) : 0}%)`);
  console.log(`最终交易数: ${scoredTrades.length}`);

  // 4. 分级统计
  console.log(`\n=== 分级统计 ===`);
  const grades = ['A', 'B', 'C', 'D'] as const;
  
  for (const grade of grades) {
    const gradeTrades = scoredTrades.filter(t => t.grade === grade);
    if (gradeTrades.length === 0) {
      console.log(`\n${grade}级: 0笔交易`);
      continue;
    }

    const wins = gradeTrades.filter(t => t.pnl > 0);
    const losses = gradeTrades.filter(t => t.pnl <= 0);
    const winRate = wins.length / gradeTrades.length;
    const totalPnl = gradeTrades.reduce((a, b) => a + b.pnl, 0);
    const grossPnl = gradeTrades.reduce((a, b) => a + b.grossPnl, 0);
    const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b.pnl, 0) / losses.length) : 0;
    const grossWins = wins.reduce((a, b) => a + b.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : Infinity;

    const avgScore = gradeTrades.reduce((a, b) => a + b.score, 0) / gradeTrades.length;
    const shockCount = gradeTrades.filter(t => t.signalType === 'shock').length;
    const gradualCount = gradeTrades.filter(t => t.signalType === 'gradual').length;

    // 评分维度平均值
    const avgHR = gradeTrades.reduce((a, b) => a + b.scoreDetail.whitelistHR, 0) / gradeTrades.length;
    const avgSector = gradeTrades.reduce((a, b) => a + b.scoreDetail.sectorRatio, 0) / gradeTrades.length;
    const avgSeasonal = gradeTrades.reduce((a, b) => a + b.scoreDetail.seasonalStrength, 0) / gradeTrades.length;

    console.log(`\n${grade}级 (评分≥${grade === 'A' ? 70 : grade === 'B' ? 50 : grade === 'C' ? 30 : 0}): ${gradeTrades.length}笔`);
    console.log(`  平均评分: ${avgScore.toFixed(1)}`);
    console.log(`  胜率: ${(winRate * 100).toFixed(1)}%`);
    console.log(`  盈亏比(PF): ${pf === Infinity ? '∞' : pf.toFixed(2)}`);
    console.log(`  净利润: ${(totalPnl * 100).toFixed(2)}%`);
    console.log(`  毛利润: ${(grossPnl * 100).toFixed(2)}%`);
    console.log(`  平均盈利: ${(avgWin * 100).toFixed(3)}%`);
    console.log(`  平均亏损: ${(avgLoss * 100).toFixed(3)}%`);
    console.log(`  信号类型: 突变${shockCount}笔 / 渐变${gradualCount}笔`);
    console.log(`  平均白名单HR: ${(avgHR * 100).toFixed(1)}%`);
    console.log(`  平均板块联动: ${(avgSector * 100).toFixed(1)}%`);
    console.log(`  平均季节强度: ${(avgSeasonal * 100).toFixed(1)}%`);
  }

  // 5. 评分分布
  console.log(`\n=== 评分分布 ===`);
  const scoreRanges = [
    { label: '80-100', min: 80, max: 101 },
    { label: '70-79', min: 70, max: 80 },
    { label: '60-69', min: 60, max: 70 },
    { label: '50-59', min: 50, max: 60 },
    { label: '40-49', min: 40, max: 50 },
    { label: '30-39', min: 30, max: 40 },
    { label: '<30', min: 0, max: 30 },
  ];

  for (const range of scoreRanges) {
    const rangeTrades = scoredTrades.filter(t => t.score >= range.min && t.score < range.max);
    if (rangeTrades.length === 0) {
      console.log(`${range.label}: 0笔`);
      continue;
    }
    const wins = rangeTrades.filter(t => t.pnl > 0);
    const losses = rangeTrades.filter(t => t.pnl <= 0);
    const winRate = wins.length / rangeTrades.length;
    const totalPnl = rangeTrades.reduce((a, b) => a + b.pnl, 0);
    const grossWins = wins.reduce((a, b) => a + b.pnl, 0);
    const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
    const pf = grossLosses > 0 ? grossWins / grossLosses : Infinity;

    console.log(`${range.label}: ${rangeTrades.length}笔 | 胜率${(winRate * 100).toFixed(1)}% | PF=${pf === Infinity ? '∞' : pf.toFixed(2)} | 净利${(totalPnl * 100).toFixed(2)}%`);
  }

  // 6. 核心结论
  console.log(`\n=== 核心结论 ===`);
  const aGrade = scoredTrades.filter(t => t.grade === 'A');
  const bGrade = scoredTrades.filter(t => t.grade === 'B');
  const cdGrade = scoredTrades.filter(t => t.grade === 'C' || t.grade === 'D');
  
  const aWinRate = aGrade.length > 0 ? aGrade.filter(t => t.pnl > 0).length / aGrade.length : 0;
  const bWinRate = bGrade.length > 0 ? bGrade.filter(t => t.pnl > 0).length / bGrade.length : 0;
  const cdWinRate = cdGrade.length > 0 ? cdGrade.filter(t => t.pnl > 0).length / cdGrade.length : 0;

  const aGrossWins = aGrade.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const aGrossLosses = Math.abs(aGrade.filter(t => t.pnl <= 0).reduce((a, b) => a + b.pnl, 0));
  const aPF = aGrossLosses > 0 ? aGrossWins / aGrossLosses : (aGrossWins > 0 ? Infinity : 0);
  
  const bGrossWins = bGrade.filter(t => t.pnl > 0).reduce((a, b) => a + b.pnl, 0);
  const bGrossLosses = Math.abs(bGrade.filter(t => t.pnl <= 0).reduce((a, b) => a + b.pnl, 0));
  const bPF = bGrossLosses > 0 ? bGrossWins / bGrossLosses : (bGrossWins > 0 ? Infinity : 0);

  console.log(`A级信号: ${aGrade.length}笔, 胜率${(aWinRate * 100).toFixed(1)}%, PF=${aPF === Infinity ? '∞' : aPF.toFixed(2)}`);
  console.log(`B级信号: ${bGrade.length}笔, 胜率${(bWinRate * 100).toFixed(1)}%, PF=${bPF === Infinity ? '∞' : bPF.toFixed(2)}`);
  console.log(`C+D级信号: ${cdGrade.length}笔, 胜率${(cdWinRate * 100).toFixed(1)}%`);
  
  if (aWinRate > bWinRate && aWinRate > cdWinRate) {
    console.log(`\n✅ 结论: 评分分级有效! A级信号胜率(${(aWinRate * 100).toFixed(1)}%)显著高于B级(${(bWinRate * 100).toFixed(1)}%)和C+D级(${(cdWinRate * 100).toFixed(1)}%)`);
  } else if (aWinRate > cdWinRate) {
    console.log(`\n⚠️ 结论: 评分分级部分有效, A级优于C+D级, 但A/B间差异不够显著`);
  } else {
    console.log(`\n⚠️ 结论: 评分分级效果不明显, 需要调整评分权重`);
  }

  // 7. 保存详细结果
  const outputPath = path.resolve('/workspace/projects/server/src/data/signalScoringResult.json');
  const resultSummary = {
    totalSignals: allSignals.length,
    totalTrades: scoredTrades.length,
    funnel: { L1: funnelL1, L2: funnelL2, L3: funnelL3, L4: funnelL4 },
    grades: grades.map(g => {
      const gt = scoredTrades.filter(t => t.grade === g);
      const wins = gt.filter(t => t.pnl > 0);
      const losses = gt.filter(t => t.pnl <= 0);
      const grossWins = wins.reduce((a, b) => a + b.pnl, 0);
      const grossLosses = Math.abs(losses.reduce((a, b) => a + b.pnl, 0));
      return {
        grade: g,
        count: gt.length,
        winRate: gt.length > 0 ? wins.length / gt.length : 0,
        totalPnl: gt.reduce((a, b) => a + b.pnl, 0),
        pf: grossLosses > 0 ? grossWins / grossLosses : null,
      };
    }),
    trades: scoredTrades.map(t => ({
      code: t.code,
      date: t.date,
      direction: t.direction,
      signalType: t.signalType,
      score: t.score,
      grade: t.grade,
      pnl: t.pnl,
      detail: t.scoreDetail,
    })),
  };
  fs.writeFileSync(outputPath, JSON.stringify(resultSummary, null, 2));
  console.log(`\n结果已保存到 ${outputPath}`);
}

// ============ 执行 ============
console.log('加载20年日线数据...');
const data = loadAllData();
console.log(`加载了 ${data.size} 个品种\n`);
runScoringBacktest(data);
