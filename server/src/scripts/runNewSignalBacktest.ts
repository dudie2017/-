/**
 * v15 新信号融合回测：S6板块联动 + S7季节性 + S8持仓量
 * 
 * 基线：v13（ATR4+H20+高波动+SL0.01+next1+白名单）
 * 新信号：
 *   S6: 板块联动 - leader冲击日，同板块其他品种同向比例≥50%
 *   S7: 季节性 - 历史同期(±15天)平均收益>0
 *   S8: 持仓量确认 - 冲击日持仓量>前5日均值
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

// 新信号阈值
const SECTOR_CORR_THRESHOLD = 0.5;  // S6: 同板块同向比例阈值
const SEASONAL_WINDOW = 15;         // S7: 季节性窗口(±天)
const OI_LOOKBACK = 5;              // S8: 持仓量回看天数

// ============ 品种板块映射 ============
const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', B0: '油脂油料', P0: '油脂油料',
  CF0: '软商品', SR0: '软商品', AP0: '软商品',
  BU0: '能源', SC0: '能源', LU0: '能源', NR0: '能源',
  MA0: '化工', TA0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', PG0: '化工', V0: '化工',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融',
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
    for (let i = ATR_PERIOD; i < bars.length; i++) {
      const ret = bars[i].ret;
      if (ret === null || ret === undefined) continue;
      const atrVal = atr[i];
      if (atrVal <= 0) continue;
      // 统一单位：ret是百分比，ATR转为百分比
      const atrPct = atrVal / bars[i].c;
      const mult = Math.abs(ret) / atrPct;
      if (mult >= atrMult) {
        shocks.push({
          code,
          date: bars[i].date,
          barIdx: i,
          direction: ret > 0 ? 'up' : 'down',
          ret,
          atrMult: mult,
        });
      }
    }
  }
  return shocks;
}

// ============ S6: 板块联动检测 ============
function checkSectorCorrelation(
  shock: Shock,
  data: Map<string, DailyBar[]>
): boolean {
  const sector = SECTOR_MAP[shock.code];
  if (!sector) return false;
  
  // 找同板块其他品种
  const peers: string[] = [];
  for (const [code, s] of Object.entries(SECTOR_MAP)) {
    if (s === sector && code !== shock.code && data.has(code)) {
      peers.push(code);
    }
  }
  if (peers.length === 0) return false;
  
  // 检查冲击日同板块品种同向比例
  const shockBar = data.get(shock.code)![shock.barIdx];
  const shockDate = shockBar.date;
  let sameDirCount = 0;
  let validCount = 0;
  
  for (const peer of peers) {
    const peerBars = data.get(peer)!;
    const peerIdx = peerBars.findIndex(b => b.date === shockDate);
    if (peerIdx < 1) continue;
    const peerRet = peerBars[peerIdx].ret;
    if (peerRet === null || peerRet === undefined) continue;
    validCount++;
    if ((shock.direction === 'up' && peerRet > 0) ||
        (shock.direction === 'down' && peerRet < 0)) {
      sameDirCount++;
    }
  }
  
  if (validCount === 0) return false;
  return (sameDirCount / validCount) >= SECTOR_CORR_THRESHOLD;
}

// ============ S7: 季节性检测 ============
function checkSeasonality(
  shock: Shock,
  bars: DailyBar[]
): boolean {
  const shockIdx = shock.barIdx;
  const shockDate = new Date(bars[shockIdx].date);
  const shockMonth = shockDate.getMonth();
  const shockDay = shockDate.getDate();
  
  // 收集历史同期收益
  const historicalReturns: number[] = [];
  for (let i = ATR_PERIOD; i < bars.length; i++) {
    if (i === shockIdx) continue;
    const d = new Date(bars[i].date);
    const m = d.getMonth();
    const day = d.getDate();
    // 检查是否在±SEASONAL_WINDOW天内
    const monthDiff = Math.abs(m - shockMonth);
    const dayDiff = Math.abs(day - shockDay);
    if (monthDiff <= 1 && dayDiff <= SEASONAL_WINDOW) {
      const ret = bars[i].ret;
      if (ret !== null && ret !== undefined) {
        historicalReturns.push(ret);
      }
    }
  }
  
  if (historicalReturns.length < 5) return false;
  const avgRet = historicalReturns.reduce((a, b) => a + b, 0) / historicalReturns.length;
  return (shock.direction === 'up' && avgRet > 0) ||
         (shock.direction === 'down' && avgRet < 0);
}

// ============ S8: 持仓量确认 ============
function checkOpenInterest(
  shock: Shock,
  bars: DailyBar[]
): boolean {
  const shockIdx = shock.barIdx;
  if (shockIdx < OI_LOOKBACK) return false;
  
  const currentOI = bars[shockIdx].hold;
  if (!currentOI || currentOI <= 0) return false;
  
  // 计算前OI_LOOKBACK天均值
  let sumOI = 0;
  let count = 0;
  for (let i = shockIdx - OI_LOOKBACK; i < shockIdx; i++) {
    if (bars[i].hold && bars[i].hold > 0) {
      sumOI += bars[i].hold;
      count++;
    }
  }
  if (count === 0) return false;
  const avgOI = sumOI / count;
  
  // 持仓量增加 = 确认信号
  return currentOI > avgOI;
}

// ============ 白名单匹配 ============
interface WhitelistPair {
  leader: string;
  follower: string;
  lag: number;
  sector: string;
  logic: string;
}

function findWhitelistPairs(leaderCode: string): WhitelistPair[] {
  return PROPAGATION_WHITELIST.filter(p => p.leader === leaderCode);
}

// ============ 交易模拟 ============
interface Trade {
  leader: string;
  follower: string;
  entryDate: string;
  exitDate: string;
  direction: 'up' | 'down';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  holdDays: number;
  filters: string[];
}

function simulateTrade(
  shock: Shock,
  pair: WhitelistPair,
  data: Map<string, DailyBar[]>,
  filters: { sector: boolean; seasonal: boolean; oi: boolean }
): Trade | null {
  const leaderBars = data.get(shock.code);
  const followerBars = data.get(pair.follower);
  if (!leaderBars || !followerBars) return null;
  
  // 高波动过滤
  if (VOLATILITY_FILTER) {
    const atrShort = calcATR(leaderBars, ATR_PERIOD);
    const atrLong = calcATR(leaderBars, ATR_LONG);
    if (shock.barIdx < ATR_LONG) return null;
    if (atrShort[shock.barIdx] <= atrLong[shock.barIdx]) return null;
  }
  
  // next1确认
  if (shock.barIdx + 1 >= leaderBars.length) return null;
  const nextRet = leaderBars[shock.barIdx + 1].ret;
  if (nextRet === null || nextRet === undefined) return null;
  if ((shock.direction === 'up' && nextRet <= 0) ||
      (shock.direction === 'down' && nextRet >= 0)) return null;
  
  // S6: 板块联动过滤
  if (filters.sector && !checkSectorCorrelation(shock, data)) return null;
  
  // S7: 季节性过滤
  if (filters.seasonal && !checkSeasonality(shock, leaderBars)) return null;
  
  // S8: 持仓量过滤
  if (filters.oi && !checkOpenInterest(shock, leaderBars)) return null;
  
  // 找follower入场点（lag天后）
  const shockDate = leaderBars[shock.barIdx].date;
  const followerStartIdx = followerBars.findIndex(b => b.date === shockDate);
  if (followerStartIdx < 0) return null;
  const entryIdx = Math.min(followerStartIdx + pair.lag, followerBars.length - 1);
  if (entryIdx >= followerBars.length - 1) return null;
  
  const entryPrice = followerBars[entryIdx].c;
  const dir = shock.direction === 'up' ? 1 : -1;
  
  // 模拟持有
  let exitIdx = entryIdx;
  let maxPnl = 0;
  for (let i = 1; i <= MAX_HOLD && entryIdx + i < followerBars.length; i++) {
    const bar = followerBars[entryIdx + i];
    const pnl = ((bar.c - entryPrice) / entryPrice) * dir;
    if (pnl < -STOP_LOSS) {
      exitIdx = entryIdx + i;
      maxPnl = -STOP_LOSS;
      break;
    }
    if (pnl > maxPnl) maxPnl = pnl;
    exitIdx = entryIdx + i;
  }
  
  const exitPrice = followerBars[exitIdx].c;
  const pnl = ((exitPrice - entryPrice) / entryPrice) * dir;
  
  const filterList: string[] = ['v13'];
  if (filters.sector) filterList.push('S6');
  if (filters.seasonal) filterList.push('S7');
  if (filters.oi) filterList.push('S8');
  
  return {
    leader: shock.code,
    follower: pair.follower,
    entryDate: followerBars[entryIdx].date,
    exitDate: followerBars[exitIdx].date,
    direction: shock.direction,
    entryPrice,
    exitPrice,
    pnl,
    holdDays: exitIdx - entryIdx,
    filters: filterList,
  };
}

// ============ 回测引擎 ============
interface BacktestResult {
  name: string;
  signalCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  pf: number;
  trades: Trade[];
}

function runBacktest(
  name: string,
  trades: Trade[]
): BacktestResult {
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  
  return {
    name,
    signalCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : 0,
    totalPnl,
    avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
    maxWin: trades.length > 0 ? Math.max(...trades.map(t => t.pnl)) : 0,
    maxLoss: trades.length > 0 ? Math.min(...trades.map(t => t.pnl)) : 0,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0,
    trades,
  };
}

// ============ 主流程 ============
function main() {
  console.log('=== v15 新信号融合回测 ===\n');
  
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种\n`);
  
  // 检测冲击
  const shocks = detectShocks(data, ATR_MULT);
  console.log(`检测到 ${shocks.length} 个 ≥${ATR_MULT}×ATR 冲击\n`);
  
  // 定义测试组合
  const combinations = [
    { name: 'S1(v13基线)', sector: false, seasonal: false, oi: false },
    { name: 'S1+S6(板块联动)', sector: true, seasonal: false, oi: false },
    { name: 'S1+S7(季节性)', sector: false, seasonal: true, oi: false },
    { name: 'S1+S8(持仓量)', sector: false, seasonal: false, oi: true },
    { name: 'S1+S6+S7', sector: true, seasonal: true, oi: false },
    { name: 'S1+S6+S8', sector: true, seasonal: false, oi: true },
    { name: 'S1+S7+S8', sector: false, seasonal: true, oi: true },
    { name: 'S1+S6+S7+S8', sector: true, seasonal: true, oi: true },
  ];
  
  const results: any[] = [];
  
  for (const combo of combinations) {
    const trades: Trade[] = [];
    
    for (const shock of shocks) {
      const pairs = findWhitelistPairs(shock.code);
      for (const pair of pairs) {
        const trade = simulateTrade(shock, pair, data, {
          sector: combo.sector,
          seasonal: combo.seasonal,
          oi: combo.oi,
        });
        if (trade) trades.push(trade);
      }
    }
    
    const result = runBacktest(combo.name, trades);
    results.push({
      name: combo.name,
      signalCount: result.signalCount,
      winCount: result.winCount,
      lossCount: result.lossCount,
      winRate: result.winRate,
      totalPnl: result.totalPnl,
      avgPnl: result.avgPnl,
      maxWin: result.maxWin,
      maxLoss: result.maxLoss,
      pf: result.pf,
    });
    
    console.log(`${combo.name}: ${result.signalCount} 信号, PF=${result.pf.toFixed(2)}, 胜率=${(result.winRate * 100).toFixed(1)}%, 总PnL=${(result.totalPnl * 100).toFixed(2)}%`);
  }
  
  // 保存结果
  const outPath = path.resolve('/workspace/projects/server/src/data/newSignalResult.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main();
