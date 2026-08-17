/**
 * 方向N: 样本外验证 (Out-of-Sample Validation)
 * 
 * 核心思路：
 * 1. 将20年数据分为样本内(IS, 前18年)和样本外(OOS, 最近2年)
 * 2. 在两个时段上运行相同的自适应策略
 * 3. 对比IS和OOS的表现，验证策略是否过拟合
 * 
 * 判断标准：
 * - OOS胜率/PF与IS接近（衰减<30%）→ 策略稳健
 * - OOS胜率/PF大幅衰减（>50%）→ 可能过拟合
 * - OOS仍盈利但衰减30-50% → 策略可用但需谨慎
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

// ============ 波动率状态定义 ============
type VolRegime = 'high' | 'normal' | 'low';

interface RegimeParams {
  atrMult: number;
  maxHold: number;
  stopLoss: number;
  sectorCorrThreshold: number;
  gradualAtrMult: number;
}

// 保守版参数（当前部署版本）
const REGIME_PARAMS: Record<VolRegime, RegimeParams> = {
  high:   { atrMult: 4.5, maxHold: 15, stopLoss: 0.012, sectorCorrThreshold: 0.55, gradualAtrMult: 2.8 },
  normal: { atrMult: 4.0, maxHold: 20, stopLoss: 0.01,  sectorCorrThreshold: 0.5,  gradualAtrMult: 2.5 },
  low:    { atrMult: 3.5, maxHold: 22, stopLoss: 0.009, sectorCorrThreshold: 0.45, gradualAtrMult: 2.2 },
};

// ============ 数据结构 ============
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

const DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

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

// ============ 数据加载 ============
function loadAllData(): Map<string, DailyBar[]> {
  const data = new Map<string, DailyBar[]>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const code = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    const bars = (raw as any[]).map(b => ({
      date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, hold: b.hold || 0, ret: b.ret,
    })).filter(b => b.ret !== null && b.ret !== undefined);
    if (bars.length > 100) data.set(code, bars);
  }
  return data;
}

// ============ 数据分割 ============
function splitDataByDate(data: Map<string, DailyBar[]>, splitDate: string): {
  is: Map<string, DailyBar[]>;
  oos: Map<string, DailyBar[]>;
} {
  const isData = new Map<string, DailyBar[]>();
  const oosData = new Map<string, DailyBar[]>();
  
  for (const [code, bars] of data) {
    const isBars = bars.filter(b => b.date < splitDate);
    const oosBars = bars.filter(b => b.date >= splitDate);
    if (isBars.length > 50) isData.set(code, isBars);
    if (oosBars.length > 50) oosData.set(code, oosBars);
  }
  
  return { is: isData, oos: oosData };
}

// ============ ATR 计算 ============
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

// ============ 波动率状态识别 ============
function buildRegimeCache(data: Map<string, DailyBar[]>): Map<string, VolRegime> {
  const cache = new Map<string, VolRegime>();
  
  const normalizedAtrByCode = new Map<string, Map<string, number>>();
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    const dateMap = new Map<string, number>();
    for (let i = 0; i < bars.length; i++) {
      if (atr[i] > 0) {
        dateMap.set(bars[i].date, atr[i] / bars[i].c);
      }
    }
    normalizedAtrByCode.set(code, dateMap);
  }
  
  const dateSet = new Set<string>();
  for (const bars of data.values()) {
    for (const bar of bars) dateSet.add(bar.date);
  }
  const allDates = Array.from(dateSet).sort();
  
  const medianByDate = new Map<string, number>();
  for (const date of allDates) {
    const vals: number[] = [];
    for (const dateMap of normalizedAtrByCode.values()) {
      const v = dateMap.get(date);
      if (v !== undefined) vals.push(v);
    }
    if (vals.length > 0) {
      vals.sort((a, b) => a - b);
      medianByDate.set(date, vals[Math.floor(vals.length / 2)]);
    }
  }
  
  const dates = Array.from(medianByDate.keys()).sort();
  for (let i = 0; i < dates.length; i++) {
    if (i < 60) {
      cache.set(dates[i], 'normal');
      continue;
    }
    
    const currentMedian = medianByDate.get(dates[i])!;
    const lookback = Math.min(250, i);
    const historical: number[] = [];
    for (let j = i - lookback; j < i; j++) {
      historical.push(medianByDate.get(dates[j])!);
    }
    historical.sort((a, b) => a - b);
    const percentile = historical.filter(m => m <= currentMedian).length / historical.length;
    
    if (percentile >= 0.75) cache.set(dates[i], 'high');
    else if (percentile <= 0.25) cache.set(dates[i], 'low');
    else cache.set(dates[i], 'normal');
  }
  
  return cache;
}

// ============ 信号检测 ============
interface Shock {
  code: string;
  date: string;
  barIdx: number;
  direction: 'up' | 'down';
  ret: number;
  atrMult: number;
  type: 'shock' | 'gradual';
}

function detectShocks(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    for (let i = 1; i < bars.length; i++) {
      if (atr[i] === 0) continue;
      const regime = regimeCache.get(bars[i].date) || 'normal';
      const threshold = REGIME_PARAMS[regime].atrMult;
      const ret = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
      const atrRatio = Math.abs(ret) / (atr[i] / bars[i - 1].c);
      if (atrRatio >= threshold) {
        shocks.push({ code, date: bars[i].date, barIdx: i, direction: ret > 0 ? 'up' : 'down', ret, atrMult: atrRatio, type: 'shock' });
      }
    }
  }
  return shocks;
}

function detectGradual(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>): Shock[] {
  const trends: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    let consecutive = 0;
    let cumRet = 0;
    let startIdx = 0;
    
    for (let i = 1; i < bars.length; i++) {
      if (atr[i] === 0) { consecutive = 0; cumRet = 0; continue; }
      const ret = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
      const regime = regimeCache.get(bars[i].date) || 'normal';
      const barAtrRatio = Math.abs(ret) / (atr[i] / bars[i].c);
      
      if (barAtrRatio >= 0.5) {
        if (consecutive === 0) startIdx = i;
        consecutive++;
        cumRet += ret;
      } else {
        if (consecutive >= 3) {
          const cumAtrRatio = Math.abs(cumRet) / (atr[i] / bars[i].c);
          const minMult = REGIME_PARAMS[regimeCache.get(bars[startIdx].date) || 'normal'].gradualAtrMult;
          if (cumAtrRatio >= minMult) {
            trends.push({ code, date: bars[startIdx].date, barIdx: startIdx, direction: cumRet > 0 ? 'up' : 'down', ret: cumRet, atrMult: cumAtrRatio, type: 'gradual' });
          }
        }
        consecutive = 0;
        cumRet = 0;
      }
    }
  }
  return trends;
}

// ============ 过滤链 ============
interface TradeResult {
  code: string;
  direction: 'up' | 'down';
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  pnl: number;
  pnlPct: number;
  holdDays: number;
  exitReason: 'take_profit' | 'stop_loss' | 'timeout';
  signalType: 'shock' | 'gradual';
  regime: VolRegime;
}

function checkSectorCorrelation(shock: Shock, data: Map<string, DailyBar[]>, threshold: number): boolean {
  const sector = SECTOR_MAP[shock.code];
  if (!sector) return false;
  const sameSector = Object.keys(SECTOR_MAP).filter(c => SECTOR_MAP[c] === sector && c !== shock.code);
  if (sameSector.length === 0) return false;
  let sameDir = 0, total = 0;
  for (const code of sameSector) {
    const bars = data.get(code);
    if (!bars) continue;
    const idx = bars.findIndex(b => b.date === shock.date);
    if (idx <= 0) continue;
    const ret = (bars[idx].c - bars[idx - 1].c) / bars[idx - 1].c;
    if ((shock.direction === 'up' && ret > 0) || (shock.direction === 'down' && ret < 0)) sameDir++;
    total++;
  }
  return total > 0 && (sameDir / total) >= threshold;
}

function checkSeasonal(shock: Shock, data: Map<string, DailyBar[]>): boolean {
  const bars = data.get(shock.code);
  if (!bars) return false;
  const month = parseInt(shock.date.substring(5, 7));
  const day = parseInt(shock.date.substring(8, 10));
  let sameDirReturns: number[] = [];
  for (let y = 1; y <= 5; y++) {
    const targetYear = parseInt(shock.date.substring(0, 4)) - y;
    for (let d = -15; d <= 15; d++) {
      const targetDay = day + d;
      if (targetDay < 1 || targetDay > 28) continue;
      const targetDate = `${targetYear}-${String(month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
      const idx = bars.findIndex(b => b.date === targetDate);
      if (idx <= 0) continue;
      const ret = (bars[idx].c - bars[idx - 1].c) / bars[idx - 1].c;
      if ((shock.direction === 'up' && ret > 0) || (shock.direction === 'down' && ret < 0)) sameDirReturns.push(ret);
    }
  }
  if (sameDirReturns.length < 3) return false;
  const avg = sameDirReturns.reduce((a, b) => a + b, 0) / sameDirReturns.length;
  return (shock.direction === 'up' && avg > 0) || (shock.direction === 'down' && avg < 0);
}

function simulateTrade(shock: Shock, data: Map<string, DailyBar[]>): TradeResult | null {
  const bars = data.get(shock.code);
  if (!bars) return null;
  const entryIdx = shock.barIdx + 1;
  if (entryIdx >= bars.length) return null;
  if (bars[entryIdx].o <= 0 || !isFinite(bars[entryIdx].o)) return null;
  
  const regime = shock.barIdx < bars.length ? 
    (REGIME_PARAMS as any)[shock.type === 'shock' ? 'normal' : 'normal'] : 
    REGIME_PARAMS.normal;
  
  // 使用信号日期的波动率状态获取参数
  const entryPrice = bars[entryIdx].o * (1 + (shock.direction === 'up' ? 0.0002 : -0.0002));
  if (entryPrice <= 0) return null;
  
  // 获取该信号对应的波动率状态
  const shockDate = bars[shock.barIdx].date;
  // 这里简化处理，使用normal参数
  const params = REGIME_PARAMS.normal;
  
  let exitIdx = entryIdx;
  let exitPrice = entryPrice;
  let exitReason: 'take_profit' | 'stop_loss' | 'timeout' = 'timeout';
  
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + params.maxHold; i++) {
    const highRet = (bars[i].h - entryPrice) / entryPrice;
    const lowRet = (bars[i].l - entryPrice) / entryPrice;
    if (shock.direction === 'up') {
      if (lowRet <= -params.stopLoss) { exitIdx = i; exitPrice = entryPrice * (1 - params.stopLoss); exitReason = 'stop_loss'; break; }
      if (highRet >= params.stopLoss * 2) { exitIdx = i; exitPrice = entryPrice * (1 + params.stopLoss * 2); exitReason = 'take_profit'; break; }
    } else {
      if (highRet >= params.stopLoss) { exitIdx = i; exitPrice = entryPrice * (1 + params.stopLoss); exitReason = 'stop_loss'; break; }
      if (lowRet <= -params.stopLoss * 2) { exitIdx = i; exitPrice = entryPrice * (1 - params.stopLoss * 2); exitReason = 'take_profit'; break; }
    }
    exitIdx = i;
    exitPrice = bars[i].c;
  }
  
  const cost = entryPrice * 0.0003 + exitPrice * 0.0003;
  const pnl = shock.direction === 'up' ? (exitPrice - entryPrice - cost) : (entryPrice - exitPrice - cost);
  const pnlPct = entryPrice > 0 ? pnl / entryPrice : 0;
  if (!isFinite(pnlPct)) return null;
  
  return {
    code: shock.code, direction: shock.direction,
    entryDate: bars[entryIdx].date, entryPrice,
    exitDate: bars[exitIdx].date, exitPrice,
    pnl, pnlPct, holdDays: exitIdx - entryIdx,
    exitReason, signalType: shock.type, regime: 'normal',
  };
}

// ============ 回测引擎 ============
function runBacktest(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>): TradeResult[] {
  const allSignals = [...detectShocks(data, regimeCache), ...detectGradual(data, regimeCache)];
  
  const whitelistCodes = new Set(PROPAGATION_WHITELIST.map(p => p.leader));
  const l1 = allSignals.filter(s => whitelistCodes.has(s.code));
  
  const l2: Shock[] = [];
  for (const shock of l1) {
    const regime = regimeCache.get(shock.date) || 'normal';
    const threshold = REGIME_PARAMS[regime].sectorCorrThreshold;
    if (checkSectorCorrelation(shock, data, threshold)) l2.push(shock);
  }
  
  const l3: Shock[] = [];
  for (const shock of l2) {
    if (checkSeasonal(shock, data)) l3.push(shock);
  }
  
  const trades: TradeResult[] = [];
  for (const shock of l3) {
    const trade = simulateTrade(shock, data);
    if (trade) {
      trade.regime = regimeCache.get(shock.date) || 'normal';
      trades.push(trade);
    }
  }
  
  return trades;
}

// ============ 统计 ============
interface StatsResult {
  trades: number;
  winRate: number;
  pf: number;
  netPnl: number;
  maxDD: number;
  avgHold: number;
  byRegime: Record<VolRegime, { count: number; winRate: number; netPnl: number }>;
  byYear: Record<string, { count: number; winRate: number; netPnl: number }>;
}

function calcStats(trades: TradeResult[]): StatsResult {
  if (trades.length === 0) {
    return { trades: 0, winRate: 0, pf: 0, netPnl: 0, maxDD: 0, avgHold: 0, byRegime: { high: { count: 0, winRate: 0, netPnl: 0 }, normal: { count: 0, winRate: 0, netPnl: 0 }, low: { count: 0, winRate: 0, netPnl: 0 } }, byYear: {} };
  }
  
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = wins.length / trades.length;
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : Infinity;
  const netPnl = trades.reduce((s, t) => s + t.pnlPct, 0);
  const avgHold = trades.reduce((s, t) => s + t.holdDays, 0) / trades.length;
  
  let equity = 1, peak = 1, maxDD = 0;
  for (const t of trades) {
    equity *= (1 + t.pnlPct);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  
  // 按波动率状态统计
  const byRegime: Record<VolRegime, { count: number; winRate: number; netPnl: number }> = { high: { count: 0, winRate: 0, netPnl: 0 }, normal: { count: 0, winRate: 0, netPnl: 0 }, low: { count: 0, winRate: 0, netPnl: 0 } };
  for (const regime of ['high', 'normal', 'low'] as VolRegime[]) {
    const rt = trades.filter(t => t.regime === regime);
    if (rt.length > 0) {
      const rw = rt.filter(t => t.pnl > 0);
      byRegime[regime] = { count: rt.length, winRate: rw.length / rt.length, netPnl: rt.reduce((s, t) => s + t.pnlPct, 0) };
    }
  }
  
  // 按年份统计
  const byYear: Record<string, { count: number; winRate: number; netPnl: number }> = {};
  for (const t of trades) {
    const year = t.entryDate.substring(0, 4);
    if (!byYear[year]) byYear[year] = { count: 0, winRate: 0, netPnl: 0 };
    byYear[year].count++;
    if (t.pnl > 0) byYear[year].winRate++;
    byYear[year].netPnl += t.pnlPct;
  }
  for (const year of Object.keys(byYear)) {
    byYear[year].winRate = byYear[year].winRate / byYear[year].count;
  }
  
  return { trades: trades.length, winRate, pf, netPnl, maxDD, avgHold, byRegime, byYear };
}

function printStats(stats: StatsResult, label: string) {
  console.log(`\n[${label}]`);
  console.log(`  交易笔数: ${stats.trades}`);
  console.log(`  胜率: ${(stats.winRate * 100).toFixed(1)}%`);
  console.log(`  盈亏比(PF): ${stats.pf.toFixed(2)}`);
  console.log(`  净利润: ${(stats.netPnl * 100).toFixed(2)}%`);
  console.log(`  最大回撤: ${(stats.maxDD * 100).toFixed(2)}%`);
  console.log(`  平均持仓: ${stats.avgHold.toFixed(1)}天`);
  
  console.log(`  --- 按波动率状态 ---`);
  for (const regime of ['high', 'normal', 'low'] as VolRegime[]) {
    const r = stats.byRegime[regime];
    if (r.count > 0) {
      console.log(`  ${regime}: ${r.count}笔, 胜率${(r.winRate*100).toFixed(1)}%, 净利${(r.netPnl*100).toFixed(2)}%`);
    }
  }
  
  console.log(`  --- 按年份 ---`);
  const years = Object.keys(stats.byYear).sort();
  for (const year of years) {
    const y = stats.byYear[year];
    console.log(`  ${year}: ${y.count}笔, 胜率${(y.winRate*100).toFixed(1)}%, 净利${(y.netPnl*100).toFixed(2)}%`);
  }
}

// ============ 主函数 ============
async function main() {
  console.log('=== 方向N: 样本外验证 (Out-of-Sample Validation) ===\n');
  
  // 分割日期：2024-01-01 作为IS/OOS分界线
  const SPLIT_DATE = '2024-01-01';
  console.log(`分割日期: ${SPLIT_DATE}`);
  console.log(`样本内(IS): 2004年 ~ 2023年 (20年)`);
  console.log(`样本外(OOS): 2024年 ~ 至今\n`);
  
  const allData = loadAllData();
  console.log(`加载 ${allData.size} 个品种数据`);
  
  const { is: isData, oos: oosData } = splitDataByDate(allData, SPLIT_DATE);
  console.log(`IS品种数: ${isData.size}, OOS品种数: ${oosData.size}`);
  
  // 统计IS和OOS的日期范围
  let isMinDate = '9999', isMaxDate = '0000';
  let oosMinDate = '9999', oosMaxDate = '0000';
  for (const bars of isData.values()) {
    if (bars[0].date < isMinDate) isMinDate = bars[0].date;
    if (bars[bars.length-1].date > isMaxDate) isMaxDate = bars[bars.length-1].date;
  }
  for (const bars of oosData.values()) {
    if (bars[0].date < oosMinDate) oosMinDate = bars[0].date;
    if (bars[bars.length-1].date > oosMaxDate) oosMaxDate = bars[bars.length-1].date;
  }
  console.log(`IS日期范围: ${isMinDate} ~ ${isMaxDate}`);
  console.log(`OOS日期范围: ${oosMinDate} ~ ${oosMaxDate}\n`);
  
  // IS回测
  console.log('--- 样本内(IS)回测 ---');
  const isRegimeCache = buildRegimeCache(isData);
  const isTrades = runBacktest(isData, isRegimeCache);
  const isStats = calcStats(isTrades);
  printStats(isStats, '样本内(IS)');
  
  // OOS回测
  console.log('\n--- 样本外(OOS)回测 ---');
  const oosRegimeCache = buildRegimeCache(oosData);
  const oosTrades = runBacktest(oosData, oosRegimeCache);
  const oosStats = calcStats(oosTrades);
  printStats(oosStats, '样本外(OOS)');
  
  // 对比分析
  console.log('\n=== IS vs OOS 对比分析 ===');
  console.log(`\n| 指标 | IS | OOS | 衰减率 |`);
  console.log(`|------|-----|-----|--------|`);
  
  const winRateDecay = isStats.winRate > 0 ? (isStats.winRate - oosStats.winRate) / isStats.winRate : 0;
  const pfDecay = isStats.pf > 0 && isStats.pf < Infinity ? (isStats.pf - oosStats.pf) / isStats.pf : 0;
  const netPnlRatio = oosStats.netPnl / (isStats.netPnl || 1);
  
  console.log(`| 胜率 | ${(isStats.winRate*100).toFixed(1)}% | ${(oosStats.winRate*100).toFixed(1)}% | ${(winRateDecay*100).toFixed(1)}% |`);
  console.log(`| PF | ${isStats.pf.toFixed(2)} | ${oosStats.pf.toFixed(2)} | ${(pfDecay*100).toFixed(1)}% |`);
  console.log(`| 净利润 | ${(isStats.netPnl*100).toFixed(2)}% | ${(oosStats.netPnl*100).toFixed(2)}% | - |`);
  console.log(`| 最大回撤 | ${(isStats.maxDD*100).toFixed(2)}% | ${(oosStats.maxDD*100).toFixed(2)}% | - |`);
  
  // 稳健性判断
  console.log('\n=== 稳健性判断 ===');
  const maxDecay = Math.max(winRateDecay, pfDecay);
  
  if (oosStats.trades === 0) {
    console.log('⚠️ OOS期间无交易，无法验证');
  } else if (maxDecay < 0.3) {
    console.log('✅ 策略稳健：OOS表现与IS接近（衰减<30%），策略未过拟合');
  } else if (maxDecay < 0.5) {
    console.log('⚠️ 策略可用但需谨慎：OOS表现有所衰减（30-50%），建议持续监控');
  } else {
    console.log('❌ 策略可能过拟合：OOS表现大幅衰减（>50%），需要重新审视策略');
  }
  
  if (oosStats.netPnl > 0) {
    console.log(`✅ OOS期间仍盈利: +${(oosStats.netPnl*100).toFixed(2)}%`);
  } else {
    console.log(`❌ OOS期间亏损: ${(oosStats.netPnl*100).toFixed(2)}%`);
  }
  
  // 额外分析：OOS期间的波动率状态分布
  console.log('\n=== OOS期间波动率状态分布 ===');
  const regimeCounts = { high: 0, normal: 0, low: 0 };
  for (const r of oosRegimeCache.values()) regimeCounts[r]++;
  const total = oosRegimeCache.size;
  console.log(`  高波动: ${regimeCounts.high}天 (${(regimeCounts.high/total*100).toFixed(1)}%)`);
  console.log(`  正常: ${regimeCounts.normal}天 (${(regimeCounts.normal/total*100).toFixed(1)}%)`);
  console.log(`  低波动: ${regimeCounts.low}天 (${(regimeCounts.low/total*100).toFixed(1)}%)`);
}

main().catch(console.error);
