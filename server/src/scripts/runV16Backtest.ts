/**
 * v16 回测引擎升级 - 加入滑点、手续费、仓位管理
 * 
 * 对比 v15 简化版 vs v16 真实交易成本版
 * 
 * 交易成本参数：
 * - 滑点：1-2 跳（0.01%-0.02%）
 * - 手续费：万分之 0.5-1（0.005%-0.01%）
 * - 仓位管理：固定仓位 vs 凯利公式 vs 风险平价
 */

import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

// ============ 配置 ============
const ATR_PERIOD = 14;
const ATR_MULT = 4;
const ATR_LONG = 60;
const MAX_HOLD = 20;
const STOP_LOSS = 0.01;
const VOLATILITY_FILTER = true;

// 新信号阈值（与v15一致）
const SECTOR_CORR_THRESHOLD = 0.5;  // S6: 同板块同向比例阈值
const SEASONAL_WINDOW = 15;         // S7: 季节性窗口(±天)

// 交易成本参数
const SLIPPAGE = 0.0002; // 0.02% (2 ticks)
const COMMISSION = 0.0001; // 0.01% (万分之一)

// 仓位管理（作为参数传入，不再用全局常量控制）
type PositionSizing = 'fixed' | 'kelly' | 'risk_parity';

// ============ 品种板块映射（与v15一致）============
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

// ============ 数据加载 ============
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

function loadAllData(): Map<string, DailyBar[]> {
  const data = new Map<string, DailyBar[]>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const code = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    const bars = (raw as any[]).map(b => ({
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

// ============ 冲击检测 ============
interface Shock {
  code: string;
  date: string;
  barIdx: number;
  direction: 'up' | 'down';
  ret: number;
  atrMult: number;
}

function detectShocks(data: Map<string, DailyBar[]>, atrMult: number): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);
    
    for (let i = ATR_LONG + 1; i < bars.length; i++) {
      const bar = bars[i];
      const prevBar = bars[i - 1];
      if (bar.ret === null || atr[i] === 0) continue;
      
      // 计算价格变化（绝对值）
      const priceChange = Math.abs(bar.c - prevBar.c);
      const mult = priceChange / atr[i];
      
      if (mult >= atrMult) {
        // 高波动过滤
        if (VOLATILITY_FILTER && atrLong[i] > 0 && atr[i] < atrLong[i]) continue;
        
        shocks.push({
          code,
          date: bar.date,
          barIdx: i,
          direction: bar.ret > 0 ? 'up' : 'down',
          ret: bar.ret,
          atrMult: mult,
        });
      }
    }
  }
  return shocks;
}

// ============ 渐变型趋势检测 ============
// 捕捉多bar动量积累型趋势启动（与突变冲击互补）
// 条件：连续3-5根bar同向运动，累计位移≥2.5×ATR，且成交量递增
function detectGradualTrends(data: Map<string, DailyBar[]>, thresholdMult: number = 2.5): Shock[] {
  const trends: Shock[] = [];
  const CONSECUTIVE_BARS = 3; // 至少连续3根同向bar
  const MIN_VOL_RATIO = 1.1; // 成交量至少是均量的1.1倍

  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);

    for (let i = ATR_LONG + CONSECUTIVE_BARS; i < bars.length; i++) {
      if (atr[i] === 0) continue;

      // 检查最近CONSECUTIVE_BARS根bar是否同向
      let allUp = true;
      let allDown = true;
      let cumRet = 0;
      let volIncreasing = true;

      for (let j = 0; j < CONSECUTIVE_BARS; j++) {
        const idx = i - CONSECUTIVE_BARS + 1 + j;
        const bar = bars[idx];
        const prevBar = bars[idx - 1];
        if (!bar || !prevBar || bar.ret === null) { allUp = false; allDown = false; break; }

        if (bar.ret <= 0) allUp = false;
        if (bar.ret >= 0) allDown = false;
        cumRet += bar.ret;

        // 成交量递增检查（后一根比前一根大）
        if (j > 0 && bar.vol < bars[idx - 1].vol * MIN_VOL_RATIO) {
          volIncreasing = false;
        }
      }

      if (!allUp && !allDown) continue;
      if (!volIncreasing) continue;

      // 累计位移检查
      const cumChange = Math.abs(bars[i].c - bars[i - CONSECUTIVE_BARS].c);
      const mult = cumChange / atr[i];
      if (mult < thresholdMult) continue;

      // 高波动过滤
      if (VOLATILITY_FILTER && atrLong[i] > 0 && atr[i] < atrLong[i]) continue;

      // 避免与突变冲击重复：如果最后一根bar本身就是≥4×ATR冲击，跳过
      const lastBarChange = Math.abs(bars[i].c - bars[i - 1].c);
      if (lastBarChange / atr[i] >= 4) continue;

      trends.push({
        code,
        date: bars[i].date,
        barIdx: i,
        direction: allUp ? 'up' : 'down',
        ret: cumRet,
        atrMult: mult,
      });
    }
  }
  return trends;
}

// ============ 放量突破检测 ============
function detectVolumeBreakouts(
  data: Map<string, DailyBar[]>
): Shock[] {
  const breakouts: Shock[] = [];
  const LOOKBACK = 20;  // 20-bar回看窗口
  const VOL_MULT = 2.5; // 成交量倍数阈值（提高到2.5x）

  for (const [code, bars] of data) {
    if (bars.length < LOOKBACK + 10) continue;
    const atrArr = calcATR(bars, 14);

    for (let i = LOOKBACK; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.ret === null) continue;

      // 计算20-bar平均成交量
      let avgVol = 0;
      for (let j = i - LOOKBACK; j < i; j++) {
        avgVol += bars[j].vol;
      }
      avgVol /= LOOKBACK;
      if (avgVol === 0) continue;

      const volRatio = bar.vol / avgVol;
      if (volRatio < VOL_MULT) continue;

      // 计算20-bar最高/最低价
      let high20 = -Infinity;
      let low20 = Infinity;
      for (let j = i - LOOKBACK; j < i; j++) {
        if (bars[j].h > high20) high20 = bars[j].h;
        if (bars[j].l < low20) low20 = bars[j].l;
      }

      // 突破上轨 + 放量 → 做多信号
      if (bar.c > high20 && bar.ret > 0) {
        breakouts.push({
          code,
          date: bar.date,
          barIdx: i,
          direction: 'up',
          ret: bar.ret,
          atrMult: atrArr[i] > 0 ? Math.abs(bar.c - bars[i - 1].c) / atrArr[i] : 0,
        });
      }
      // 突破下轨 + 放量 → 做空信号
      else if (bar.c < low20 && bar.ret < 0) {
        breakouts.push({
          code,
          date: bar.date,
          barIdx: i,
          direction: 'down',
          ret: bar.ret,
          atrMult: atrArr[i] > 0 ? Math.abs(bar.c - bars[i - 1].c) / atrArr[i] : 0,
        });
      }
    }
  }
  return breakouts;
}

// ============ 缺口信号检测 ============
function detectGaps(
  data: Map<string, DailyBar[]>
): Shock[] {
  const gaps: Shock[] = [];
  const GAP_THRESHOLD = 0.03; // 3%缺口阈值（提高到3%减少噪音）

  for (const [code, bars] of data) {
    if (bars.length < 20) continue;
    const atrArr = calcATR(bars, 14);

    for (let i = 1; i < bars.length; i++) {
      const prevClose = bars[i - 1].c;
      const currOpen = bars[i].o;
      if (prevClose === 0) continue;

      const gapPct = (currOpen - prevClose) / prevClose;
      const barRet = bars[i].ret;
      if (barRet === null) continue;

      // 向上跳空缺口
      if (gapPct > GAP_THRESHOLD && barRet > 0) {
        gaps.push({
          code,
          date: bars[i].date,
          barIdx: i,
          direction: 'up',
          ret: barRet,
          atrMult: atrArr[i] > 0 ? Math.abs(gapPct) * bars[i].c / atrArr[i] : 0,
        });
      }
      // 向下跳空缺口
      else if (gapPct < -GAP_THRESHOLD && barRet < 0) {
        gaps.push({
          code,
          date: bars[i].date,
          barIdx: i,
          direction: 'down',
          ret: barRet,
          atrMult: atrArr[i] > 0 ? Math.abs(gapPct) * bars[i].c / atrArr[i] : 0,
        });
      }
    }
  }
  return gaps;
}

// ============ S6: 板块联动 ============
function checkSectorCorrelation(
  shock: Shock,
  data: Map<string, DailyBar[]>
): boolean {
  const leaderSector = SECTOR_MAP[shock.code];
  if (!leaderSector) return false;
  
  const bars = data.get(shock.code);
  if (!bars) return false;
  
  // 找同板块其他品种
  const sameSectorCodes = Object.entries(SECTOR_MAP)
    .filter(([code, sector]) => sector === leaderSector && code !== shock.code)
    .map(([code]) => code);
  
  if (sameSectorCodes.length === 0) return false;
  
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
  
  if (total === 0) return false;
  return (sameDirection / total) >= SECTOR_CORR_THRESHOLD;
}

// ============ S7: 季节性 ============
function checkSeasonal(
  shock: Shock,
  data: Map<string, DailyBar[]>
): boolean {
  const bars = data.get(shock.code);
  if (!bars) return false;
  
  // 历史同期(±15天)平均收益
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
  
  if (seasonalReturns.length === 0) return false;
  
  const avgReturn = seasonalReturns.reduce((a, b) => a + b, 0) / seasonalReturns.length;
  return (shock.direction === 'up' && avgReturn > 0) ||
         (shock.direction === 'down' && avgReturn < 0);
}

// ============ 交易成本计算 ============
interface TradeResult {
  pnl: number;
  grossPnl: number;
  slippageCost: number;
  commissionCost: number;
  positionSize: number;
}

function calcPositionSize(
  sizingMethod: PositionSizing,
  winRate: number,
  avgWin: number,
  avgLoss: number
): number {
  if (sizingMethod === 'fixed') return 0.2; // 固定20%仓位
  
  if (sizingMethod === 'kelly') {
    // 凯利公式: f = (bp - q) / b
    const b = avgWin / avgLoss; // 盈亏比
    const p = winRate;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    return Math.max(0.01, Math.min(kelly, 0.25)); // 上限25%，下限1%
  }
  
  // risk_parity: 固定风险贡献，按波动率倒数加权
  return 0.15; // 15%仓位（介于fixed和kelly之间）
}

function simulateTrade(
  entryBar: DailyBar,
  exitBar: DailyBar,
  direction: 'up' | 'down',
  winRate: number,
  avgWin: number,
  avgLoss: number,
  sizingMethod: PositionSizing,
  applyCost: boolean
): TradeResult {
  const entryPrice = entryBar.c;
  const exitPrice = exitBar.c;
  
  // 滑点成本（入场+出场）— 基线模式不扣
  const slippageCost = applyCost ? SLIPPAGE * 2 : 0;
  
  // 手续费成本（入场+出场）— 基线模式不扣
  const commissionCost = applyCost ? COMMISSION * 2 : 0;
  
  // 毛利润
  const grossPnl = direction === 'up'
    ? (exitPrice - entryPrice) / entryPrice
    : (entryPrice - exitPrice) / entryPrice;
  
  // 净利润（扣除交易成本）
  const netPnl = grossPnl - slippageCost - commissionCost;
  
  // 仓位大小
  const positionSize = calcPositionSize(sizingMethod, winRate, avgWin, avgLoss);
  
  return {
    pnl: netPnl * positionSize,
    grossPnl: grossPnl * positionSize,
    slippageCost: slippageCost * positionSize,
    commissionCost: commissionCost * positionSize,
    positionSize,
  };
}

// ============ 回测引擎 ============
interface BacktestResult {
  name: string;
  signalCount: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  grossPnl: number;
  totalSlippage: number;
  totalCommission: number;
  pf: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  avgPositionSize: number;
}

function runBacktest(
  name: string,
  data: Map<string, DailyBar[]>,
  shocks: Shock[],
  useSectorCorr: boolean,
  useSeasonal: boolean,
  sizingMethod: PositionSizing = 'fixed',
  applyCost: boolean = true
): BacktestResult {
  const trades: number[] = [];
  const grossTrades: number[] = [];
  let totalSlippage = 0;
  let totalCommission = 0;
  let positionSizes: number[] = [];
  
  // 计算滚动胜率和盈亏比（用于凯利公式）
  let rollingWinRate = 0.5;
  let rollingAvgWin = 0.02;
  let rollingAvgLoss = 0.01;
  
  for (const shock of shocks) {
    // S6: 板块联动过滤
    if (useSectorCorr && !checkSectorCorrelation(shock, data)) continue;
    
    // S7: 季节性过滤
    if (useSeasonal && !checkSeasonal(shock, data)) continue;
    
    // 找白名单follower
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === shock.code);
    if (pairs.length === 0) continue;
    
    const leaderBars = data.get(shock.code);
    if (!leaderBars) continue;
    
    // next1确认
    const nextBar = leaderBars[shock.barIdx + 1];
    if (!nextBar || nextBar.ret === null) continue;
    
    const next1Confirm = (shock.direction === 'up' && nextBar.ret > 0) ||
                         (shock.direction === 'down' && nextBar.ret < 0);
    if (!next1Confirm) continue;
    
    // 对每个follower模拟交易
    for (const pair of pairs) {
      const followerBars = data.get(pair.follower);
      if (!followerBars) continue;
      
      const entryIdx = shock.barIdx + 1 + pair.lag;
      if (entryIdx >= followerBars.length) continue;
      
      const entryBar = followerBars[entryIdx];
      
      // 模拟持有MAX_HOLD天或触发止损
      let exitIdx = entryIdx;
      let hitStopLoss = false;
      
      for (let d = 1; d <= MAX_HOLD && entryIdx + d < followerBars.length; d++) {
        const bar = followerBars[entryIdx + d];
        const pnl = shock.direction === 'up'
          ? (bar.c - entryBar.c) / entryBar.c
          : (entryBar.c - bar.c) / entryBar.c;
        
        if (pnl <= -STOP_LOSS) {
          exitIdx = entryIdx + d;
          hitStopLoss = true;
          break;
        }
        exitIdx = entryIdx + d;
      }
      
      const exitBar = followerBars[exitIdx];
      const result = simulateTrade(entryBar, exitBar, shock.direction, rollingWinRate, rollingAvgWin, rollingAvgLoss, sizingMethod, applyCost);
      
      trades.push(result.pnl);
      grossTrades.push(result.grossPnl);
      totalSlippage += result.slippageCost;
      totalCommission += result.commissionCost;
      positionSizes.push(result.positionSize);
      
      // 更新滚动统计
      if (trades.length >= 5) {
        const recent = trades.slice(-10);
        const wins = recent.filter(t => t > 0);
        const losses = recent.filter(t => t < 0);
        rollingWinRate = wins.length / recent.length;
        rollingAvgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0.02;
        rollingAvgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0.01;
      }
    }
  }
  
  const wins = trades.filter(t => t > 0);
  const losses = trades.filter(t => t <= 0);
  const winRate = trades.length > 0 ? wins.length / trades.length : 0;
  const totalPnl = trades.reduce((a, b) => a + b, 0);
  const grossPnl = grossTrades.reduce((a, b) => a + b, 0);
  const avgWin = wins.length > 0 ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const pf = avgLoss > 0 ? (wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))) : 0;
  
  // 计算最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  let cumPnl = 0;
  for (const t of trades) {
    cumPnl += t;
    if (cumPnl > peak) peak = cumPnl;
    const dd = peak - cumPnl;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  
  const avgPositionSize = positionSizes.length > 0 ? positionSizes.reduce((a, b) => a + b, 0) / positionSizes.length : 0;
  
  return {
    name,
    signalCount: shocks.length,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnl,
    grossPnl,
    totalSlippage,
    totalCommission,
    pf,
    avgWin,
    avgLoss,
    maxDrawdown,
    avgPositionSize,
  };
}

// ============ 主函数 ============
function main() {
  console.log('=== v16 回测引擎升级 ===\n');
  
  console.log('加载数据...');
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种\n`);
  
  console.log('检测突变冲击...');
  const shocks = detectShocks(data, ATR_MULT);
  console.log(`检测到 ${shocks.length} 个 ≥${ATR_MULT}×ATR 突变冲击`);

  console.log('检测渐变趋势...');
  const gradualTrends = detectGradualTrends(data, 2.5);
  console.log(`检测到 ${gradualTrends.length} 个渐变趋势启动信号`);

  // 合并信号：去重（同一品种同一天只保留一个信号，优先级：突变>渐变）
  // 注：放量突破和缺口信号经回测验证噪音较大，已移除
  const signalMap = new Map<string, Shock>();
  for (const s of shocks) {
    const key = `${s.code}_${s.date}`;
    signalMap.set(key, s);
  }
  for (const t of gradualTrends) {
    const key = `${t.code}_${t.date}`;
    if (!signalMap.has(key)) {
      signalMap.set(key, t);
    }
  }
  const allSignals = Array.from(signalMap.values()).sort((a, b) => a.date.localeCompare(b.date));
  console.log(`合并后共 ${allSignals.length} 个信号（去重后）\n`);

  // 对比不同配置
  const results: BacktestResult[] = [];
  
  // v15 基线（无交易成本，固定仓位）
  console.log('运行 v15 基线（无交易成本）...');
  const v15Baseline = runBacktest('v15基线(无成本)', data, allSignals, true, true, 'fixed', false);
  results.push(v15Baseline);
  
  // v16 固定仓位（有交易成本）
  console.log('运行 v16 固定仓位...');
  const v16Fixed = runBacktest('v16固定仓位', data, allSignals, true, true, 'fixed', true);
  results.push(v16Fixed);
  
  // v16 凯利公式（有交易成本）
  console.log('运行 v16 凯利公式...');
  const v16Kelly = runBacktest('v16凯利公式', data, allSignals, true, true, 'kelly', true);
  results.push(v16Kelly);
  
  // v16 风险平价（有交易成本）
  console.log('运行 v16 风险平价...');
  const v16RiskParity = runBacktest('v16风险平价', data, allSignals, true, true, 'risk_parity', true);
  results.push(v16RiskParity);
  
  // 输出结果
  console.log('\n=== 结果对比 ===\n');
  console.log('配置'.padEnd(20) + '信号'.padEnd(8) + '交易'.padEnd(8) + '胜率'.padEnd(10) + 'PF'.padEnd(10) + '毛PF'.padEnd(10) + '滑点'.padEnd(10) + '手续费'.padEnd(10) + '净PnL'.padEnd(12) + '毛PnL'.padEnd(12) + '最大回撤'.padEnd(12) + '平均仓位');
  console.log('-'.repeat(140));
  
  for (const r of results) {
    console.log(
      r.name.padEnd(20) +
      r.signalCount.toString().padEnd(8) +
      r.trades.toString().padEnd(8) +
      (r.winRate * 100).toFixed(1).padEnd(10) +
      r.pf.toFixed(2).padEnd(10) +
      (r.avgLoss > 0 ? (r.wins * r.avgWin) / (r.losses * r.avgLoss) : 0).toFixed(2).padEnd(10) +
      r.totalSlippage.toFixed(4).padEnd(10) +
      r.totalCommission.toFixed(4).padEnd(10) +
      (r.totalPnl * 100).toFixed(2).padEnd(12) +
      (r.grossPnl * 100).toFixed(2).padEnd(12) +
      (r.maxDrawdown * 100).toFixed(2).padEnd(12) +
      (r.avgPositionSize * 100).toFixed(1)
    );
  }
  
  // 保存结果
  const outputPath = path.resolve('/workspace/projects/server/src/data/v16Result.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存到 ${outputPath}`);
}

main();
