/**
 * 方向L: 动态参数自适应回测
 * 
 * 核心思路：
 * 1. 用ATR百分位识别波动率状态（高/中/低）
 * 2. 不同波动率状态下使用不同参数组合
 * 3. 对比固定参数 vs 自适应参数的效果
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

// 保守版：仅微调，避免过拟合
const REGIME_PARAMS_CONSERVATIVE: Record<VolRegime, RegimeParams> = {
  high:   { atrMult: 4.5, maxHold: 15, stopLoss: 0.012, sectorCorrThreshold: 0.55, gradualAtrMult: 2.8 },
  normal: { atrMult: 4.0, maxHold: 20, stopLoss: 0.01,  sectorCorrThreshold: 0.5,  gradualAtrMult: 2.5 },
  low:    { atrMult: 3.5, maxHold: 22, stopLoss: 0.009, sectorCorrThreshold: 0.45, gradualAtrMult: 2.2 },
};

// 原始激进版
const REGIME_PARAMS: Record<VolRegime, RegimeParams> = {
  high:   { atrMult: 5.0, maxHold: 12, stopLoss: 0.015, sectorCorrThreshold: 0.6, gradualAtrMult: 3.0 },
  normal: { atrMult: 4.0, maxHold: 20, stopLoss: 0.01,  sectorCorrThreshold: 0.5, gradualAtrMult: 2.5 },
  low:    { atrMult: 3.0, maxHold: 25, stopLoss: 0.008, sectorCorrThreshold: 0.4, gradualAtrMult: 2.0 },
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

// ============ 波动率状态识别（优化版）============
/**
 * 预计算每个品种的标准化ATR时间序列，然后按日期聚合
 */
function buildRegimeCacheFast(data: Map<string, DailyBar[]>): Map<string, VolRegime> {
  const cache = new Map<string, VolRegime>();
  
  // 1. 预计算每个品种的标准化ATR序列
  const normalizedAtrByCode = new Map<string, Map<string, number>>(); // code -> date -> normATR
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
  
  // 2. 获取所有日期并排序
  const dateSet = new Set<string>();
  for (const bars of data.values()) {
    for (const bar of bars) dateSet.add(bar.date);
  }
  const allDates = Array.from(dateSet).sort();
  console.log(`  共${allDates.length}个交易日，计算波动率状态...`);
  
  // 3. 对每个日期，计算全市场ATR中位数
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
  
  // 4. 计算滚动百分位（250日窗口）
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
  
  // 统计
  const counts = { high: 0, normal: 0, low: 0 };
  for (const r of cache.values()) counts[r]++;
  console.log(`  波动率分布: 高=${counts.high}天(${(counts.high/cache.size*100).toFixed(1)}%), 正常=${counts.normal}天(${(counts.normal/cache.size*100).toFixed(1)}%), 低=${counts.low}天(${(counts.low/cache.size*100).toFixed(1)}%)`);
  
  return cache;
}

// ============ 冲击检测 ============
interface Shock {
  code: string;
  date: string;
  barIdx: number;
  direction: 'up' | 'down';
  ret: number;
  atrMult: number;
  type: 'shock' | 'gradual';
}

function detectShocksAdaptive(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>): Shock[] {
  return detectShocksWithParams(data, regimeCache, REGIME_PARAMS);
}

function detectShocksWithParams(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>, regimeParams: Record<VolRegime, RegimeParams>): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    for (let i = 1; i < bars.length; i++) {
      if (atr[i] === 0) continue;
      const regime = regimeCache.get(bars[i].date) || 'normal';
      const threshold = regimeParams[regime].atrMult;
      const ret = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
      const atrRatio = Math.abs(ret) / (atr[i] / bars[i - 1].c);
      if (atrRatio >= threshold) {
        shocks.push({ code, date: bars[i].date, barIdx: i, direction: ret > 0 ? 'up' : 'down', ret, atrMult: atrRatio, type: 'shock' });
      }
    }
  }
  return shocks;
}

// ============ 渐变趋势检测 ============
function detectGradualTrendsAdaptive(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>): Shock[] {
  return detectGradualWithParams(data, regimeCache, REGIME_PARAMS);
}

function detectGradualWithParams(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>, regimeParams: Record<VolRegime, RegimeParams>): Shock[] {
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
          const minMult = regimeParams[regimeCache.get(bars[startIdx].date) || 'normal'].gradualAtrMult;
          if (cumAtrRatio >= minMult) {
            trends.push({ code, date: bars[startIdx].date, barIdx: startIdx, direction: cumRet > 0 ? 'up' : 'down', ret: cumRet, atrMult: cumAtrRatio, type: 'gradual' });
          }
        }
        consecutive = 0;
        cumRet = 0;
      }
    }
    if (consecutive >= 3) {
      const lastIdx = bars.length - 1;
      const cumAtrRatio = Math.abs(cumRet) / (atr[lastIdx] / bars[lastIdx].c);
      const minMult = REGIME_PARAMS[regimeCache.get(bars[startIdx].date) || 'normal'].gradualAtrMult;
      if (cumAtrRatio >= minMult) {
        trends.push({ code, date: bars[startIdx].date, barIdx: startIdx, direction: cumRet > 0 ? 'up' : 'down', ret: cumRet, atrMult: cumAtrRatio, type: 'gradual' });
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

function simulateTrade(shock: Shock, data: Map<string, DailyBar[]>, params: RegimeParams, regime: VolRegime): TradeResult | null {
  const bars = data.get(shock.code);
  if (!bars) return null;
  const entryIdx = shock.barIdx + 1;
  if (entryIdx >= bars.length) return null;
  if (bars[entryIdx].o <= 0 || !isFinite(bars[entryIdx].o)) return null;

  // [FIX-1] 跳空确认：如果下一根bar的open已经反向跳空超过0.3%，放弃入场
  const gapRet = (bars[entryIdx].o - bars[shock.barIdx].c) / bars[shock.barIdx].c;
  if (shock.direction === 'up' && gapRet < -0.003) return null;
  if (shock.direction === 'down' && gapRet > 0.003) return null;

  const entryPrice = bars[entryIdx].o * (1 + (shock.direction === 'up' ? 0.0002 : -0.0002));
  if (entryPrice <= 0) return null;
  let exitIdx = entryIdx;
  let exitPrice = entryPrice;
  let exitReason: 'take_profit' | 'stop_loss' | 'timeout' = 'timeout';
  for (let i = entryIdx + 1; i < bars.length && i <= entryIdx + params.maxHold; i++) {
    const highRet = (bars[i].h - entryPrice) / entryPrice;
    const lowRet = (bars[i].l - entryPrice) / entryPrice;
    if (shock.direction === 'up') {
      const hitStop = lowRet <= -params.stopLoss;
      const hitTarget = highRet >= params.stopLoss * 2;
      // [FIX-2] 同根K线冲突：同时触及算止损（保守）
      if (hitStop && hitTarget) { exitIdx = i; exitPrice = entryPrice * (1 - params.stopLoss); exitReason = 'stop_loss'; break; }
      if (hitTarget) { exitIdx = i; exitPrice = entryPrice * (1 + params.stopLoss * 2); exitReason = 'take_profit'; break; }
      if (hitStop) { exitIdx = i; exitPrice = entryPrice * (1 - params.stopLoss); exitReason = 'stop_loss'; break; }
    } else {
      const hitStop = highRet >= params.stopLoss;
      const hitTarget = lowRet <= -params.stopLoss * 2;
      if (hitStop && hitTarget) { exitIdx = i; exitPrice = entryPrice * (1 + params.stopLoss); exitReason = 'stop_loss'; break; }
      if (hitTarget) { exitIdx = i; exitPrice = entryPrice * (1 - params.stopLoss * 2); exitReason = 'take_profit'; break; }
      if (hitStop) { exitIdx = i; exitPrice = entryPrice * (1 + params.stopLoss); exitReason = 'stop_loss'; break; }
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
    exitReason, signalType: shock.type, regime,
  };
}

// ============ 回测引擎 ============
function runBacktest(data: Map<string, DailyBar[]>, regimeCache: Map<string, VolRegime>, useAdaptive: boolean, regimeParams: Record<VolRegime, RegimeParams> = REGIME_PARAMS): TradeResult[] {
  const allSignals = useAdaptive
    ? [...detectShocksWithParams(data, regimeCache, regimeParams), ...detectGradualWithParams(data, regimeCache, regimeParams)]
    : detectShocksFixed(data);
  
  console.log(`  总信号: ${allSignals.length}`);
  
  const whitelistCodes = new Set(PROPAGATION_WHITELIST.map(p => p.leader));
  const l1 = allSignals.filter(s => whitelistCodes.has(s.code));
  console.log(`  L1 白名单: ${l1.length}`);
  
  const l2: Shock[] = [];
  for (const shock of l1) {
    const regime = regimeCache.get(shock.date) || 'normal';
    const threshold = useAdaptive ? regimeParams[regime].sectorCorrThreshold : REGIME_PARAMS.normal.sectorCorrThreshold;
    if (checkSectorCorrelation(shock, data, threshold)) l2.push(shock);
  }
  console.log(`  L2 板块联动: ${l2.length}`);
  
  const l3: Shock[] = [];
  for (const shock of l2) {
    if (checkSeasonal(shock, data)) l3.push(shock);
  }
  console.log(`  L3 季节性: ${l3.length}`);
  
  const trades: TradeResult[] = [];
  for (const shock of l3) {
    const regime = regimeCache.get(shock.date) || 'normal';
    const p = useAdaptive ? regimeParams[regime] : REGIME_PARAMS.normal;
    const trade = simulateTrade(shock, data, p, regime);
    if (trade) {
      trades.push(trade);
    }
  }
  return trades;
}

function detectShocksFixed(data: Map<string, DailyBar[]>): Shock[] {
  const shocks: Shock[] = [];
  const params = REGIME_PARAMS.normal;
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    for (let i = 1; i < bars.length; i++) {
      if (atr[i] === 0) continue;
      const ret = (bars[i].c - bars[i - 1].c) / bars[i - 1].c;
      const atrRatio = Math.abs(ret) / (atr[i] / bars[i - 1].c);
      if (atrRatio >= params.atrMult) {
        shocks.push({ code, date: bars[i].date, barIdx: i, direction: ret > 0 ? 'up' : 'down', ret, atrMult: atrRatio, type: 'shock' });
      }
    }
  }
  return shocks;
}

// ============ 统计 ============
function calcStats(trades: TradeResult[], label: string) {
  if (trades.length === 0) { console.log(`\n[${label}] 无交易`); return; }
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
  
  console.log(`\n[${label}]`);
  console.log(`  交易笔数: ${trades.length}`);
  console.log(`  胜率: ${(winRate * 100).toFixed(1)}%`);
  console.log(`  盈亏比(PF): ${pf.toFixed(2)}`);
  console.log(`  净利润: ${(netPnl * 100).toFixed(2)}%`);
  console.log(`  最大回撤: ${(maxDD * 100).toFixed(2)}%`);
  console.log(`  平均持仓: ${avgHold.toFixed(1)}天`);
  
  const byRegime: Record<VolRegime, TradeResult[]> = { high: [], normal: [], low: [] };
  for (const t of trades) byRegime[t.regime].push(t);
  console.log(`  --- 按波动率状态 ---`);
  for (const regime of ['high', 'normal', 'low'] as VolRegime[]) {
    const rt = byRegime[regime];
    if (rt.length === 0) { console.log(`  ${regime}: 0笔`); continue; }
    const rw = rt.filter(t => t.pnl > 0);
    const rwr = rw.length / rt.length;
    const rpnl = rt.reduce((s, t) => s + t.pnlPct, 0);
    console.log(`  ${regime}: ${rt.length}笔, 胜率${(rwr*100).toFixed(1)}%, 净利${(rpnl*100).toFixed(2)}%`);
  }
}

// ============ 主函数 ============
async function main() {
  console.log('=== 方向L: 动态参数自适应回测 ===\n');
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种数据\n`);
  
  const regimeCache = buildRegimeCacheFast(data);
  
  console.log('\n--- 固定参数回测 ---');
  const fixedTrades = runBacktest(data, regimeCache, false);
  calcStats(fixedTrades, '固定参数');
  
  console.log('\n--- 自适应参数回测（激进） ---');
  const adaptiveTrades = runBacktest(data, regimeCache, true);
  calcStats(adaptiveTrades, '自适应参数（激进）');
  
  console.log('\n--- 自适应参数回测（保守） ---');
  const conservativeTrades = runBacktest(data, regimeCache, true, REGIME_PARAMS_CONSERVATIVE);
  calcStats(conservativeTrades, '自适应参数（保守）');
  
  console.log('\n=== 对比总结 ===');
  const fixedNet = fixedTrades.reduce((s, t) => s + t.pnlPct, 0);
  const adaptiveNet = adaptiveTrades.reduce((s, t) => s + t.pnlPct, 0);
  const conservativeNet = conservativeTrades.reduce((s, t) => s + t.pnlPct, 0);
  const fixedWR = fixedTrades.filter(t => t.pnl > 0).length / fixedTrades.length;
  const adaptiveWR = adaptiveTrades.filter(t => t.pnl > 0).length / adaptiveTrades.length;
  const conservativeWR = conservativeTrades.filter(t => t.pnl > 0).length / conservativeTrades.length;
  console.log(`  固定参数:     ${fixedTrades.length}笔, 胜率${(fixedWR*100).toFixed(1)}%, 净利${(fixedNet*100).toFixed(2)}%`);
  console.log(`  自适应(激进): ${adaptiveTrades.length}笔, 胜率${(adaptiveWR*100).toFixed(1)}%, 净利${(adaptiveNet*100).toFixed(2)}%`);
  console.log(`  自适应(保守): ${conservativeTrades.length}笔, 胜率${(conservativeWR*100).toFixed(1)}%, 净利${(conservativeNet*100).toFixed(2)}%`);
}

main().catch(console.error);
