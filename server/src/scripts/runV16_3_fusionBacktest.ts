/**
 * V16.3 多时间框架融合回测
 * 日线定方向 + 60min 定入场时机
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dailyDataDir = path.join(__dirname, '../../data-cache-daily-20y');
const intradayDataDir = path.join(__dirname, '../../data-cache-60m');

// ============ 参数配置 ============
const SHOCK_ATR_THRESHOLD = 3.0;
const GRADUAL_LOOKBACK = 3;
const GRADUAL_ATR_THRESHOLD = 2.0;
const SEASONAL_WINDOW = 5;
const SEASONAL_THRESHOLD = 0.55;
const NEXT_CONFIRM_THRESHOLD = 0.75;
const ENTRY_WINDOW_BARS = 8; // 60min bars to wait for pullback entry (8 bars = 2 trading days)
const STOP_LOSS_ATR_MULT = 1.5; // 60min ATR multiplier for stop loss
const HOLD_DAYS = [5, 10, 15];
const COMMISSION_RATE = 0.0001;
const SLIPPAGE_RATE = 0.0001;

// ============ 数据结构 ============
interface DailyBar { date: string; open: number; high: number; low: number; close: number; volume: number; oi: number; ret: number; }
interface IntradayBar { date: string; open: number; high: number; low: number; close: number; volume: number; oi: number; ret: number; }
interface Signal { date: string; variety: string; direction: 'long' | 'short'; atr: number; signalType: 'shock' | 'gradual'; }
interface Trade { signal: Signal; entryDate: string; entryPrice: number; exitDate: string; exitPrice: number; pnl: number; exitReason: string; holdDays: number; }

// ============ 数据加载 ============
function loadDailyBars(variety: string): DailyBar[] {
  const fp = path.join(dailyDataDir, `${variety}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return raw.map((r: any) => ({
    date: r.date, open: r.o, high: r.h, low: r.l, close: r.c,
    volume: r.vol, oi: r.hold || 0, ret: r.ret || 0
  }));
}

function loadIntradayBars(variety: string): IntradayBar[] {
  const fp = path.join(intradayDataDir, `${variety}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return raw.map((r: any) => ({
    date: r.date, open: r.o, high: r.h, low: r.l, close: r.c,
    volume: r.vol, oi: r.hold || 0, ret: 0
  }));
}

// ============ ATR 计算 ============
function calcATR(bars: { high: number; low: number; close: number }[], period = 14): number {
  if (bars.length < period + 1) return 0;
  let trSum = 0;
  for (let i = bars.length - period; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trSum += tr;
  }
  return trSum / period;
}

function calcATRAt(bars: { high: number; low: number; close: number }[], idx: number, period = 14): number {
  if (idx < period) return 0;
  let trSum = 0;
  for (let i = idx - period + 1; i <= idx; i++) {
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close)
    );
    trSum += tr;
  }
  return trSum / period;
}

// ============ 信号检测（日线） ============
function detectSignals(variety: string, bars: DailyBar[]): Signal[] {
  const signals: Signal[] = [];
  for (let i = 14; i < bars.length - 1; i++) {
    const atr = calcATRAt(bars, i);
    if (atr <= 0) continue;

    // 突变冲击
    const ret = bars[i].close - bars[i - 1].close;
    const absRet = Math.abs(ret);
    if (absRet >= SHOCK_ATR_THRESHOLD * atr) {
      signals.push({
        date: bars[i].date, variety,
        direction: ret > 0 ? 'long' : 'short',
        atr, signalType: 'shock'
      });
    }

    // 渐变趋势
    if (i >= GRADUAL_LOOKBACK) {
      let allSameDir = true;
      let cumRet = 0;
      for (let j = 0; j < GRADUAL_LOOKBACK; j++) {
        const barRet = bars[i - j].close - bars[i - j - 1].close;
        cumRet += barRet;
        if (j > 0 && Math.abs(barRet) < 0.3 * atr) { allSameDir = false; break; }
      }
      if (allSameDir && Math.abs(cumRet) >= GRADUAL_ATR_THRESHOLD * atr) {
        signals.push({
          date: bars[i].date, variety,
          direction: cumRet > 0 ? 'long' : 'short',
          atr, signalType: 'gradual'
        });
      }
    }
  }
  return signals;
}

// ============ 60min 回调入场 ============
function findPullbackEntry(
  intradayBars: IntradayBar[],
  signalDate: string,
  direction: 'long' | 'short',
  dailyAtr: number
): { entryDate: string; entryPrice: number; stopLoss: number } | null {
  // 找到信号日期对应的 60min bar 索引
  const signalIdx = intradayBars.findIndex(b => b.date.startsWith(signalDate));
  if (signalIdx < 0) return null;

  // 计算 60min ATR
  const intradayAtr = calcATRAt(intradayBars, signalIdx);
  if (intradayAtr <= 0) return null;

  // 计算 20-bar 均线
  const ma20 = (idx: number) => {
    if (idx < 20) return intradayBars[idx].close;
    let sum = 0;
    for (let i = idx - 19; i <= idx; i++) sum += intradayBars[i].close;
    return sum / 20;
  };

  // 在 ENTRY_WINDOW_BARS 内寻找回调入场点
  for (let i = signalIdx + 1; i < Math.min(signalIdx + ENTRY_WINDOW_BARS + 1, intradayBars.length); i++) {
    const ma = ma20(i - 1);
    const bar = intradayBars[i];

    if (direction === 'long') {
      // 看多：等待回调到 MA20 附近（价格触及 MA20 ± 0.5×ATR）
      if (bar.low <= ma + 0.5 * intradayAtr && bar.close > ma) {
        return {
          entryDate: bar.date,
          entryPrice: bar.close,
          stopLoss: bar.close - STOP_LOSS_ATR_MULT * intradayAtr
        };
      }
    } else {
      // 看空：等待反弹到 MA20 附近
      if (bar.high >= ma - 0.5 * intradayAtr && bar.close < ma) {
        return {
          entryDate: bar.date,
          entryPrice: bar.close,
          stopLoss: bar.close + STOP_LOSS_ATR_MULT * intradayAtr
        };
      }
    }
  }

  return null;
}

// ============ 传播链过滤 ============
function buildPropagationMap(): Map<string, { followers: string[]; sector: string; logic: string }[]> {
  const map = new Map<string, { followers: string[]; sector: string; logic: string }[]>();
  for (const pair of PROPAGATION_WHITELIST) {
    if (!map.has(pair.leader)) {
      map.set(pair.leader, []);
    }
    map.get(pair.leader)!.push({
      followers: [pair.follower],
      sector: pair.sector,
      logic: pair.logic
    });
  }
  return map;
}

// ============ 板块联动检查 ============
function checkSectorCorrelation(
  variety: string,
  date: string,
  allBars: Map<string, DailyBar[]>,
  direction: 'long' | 'short'
): boolean {
  const sector = getSector(variety);
  if (!sector) return false;

  const sectorVarieties = getSectorVarieties(sector);
  let sameDir = 0, total = 0;

  for (const v of sectorVarieties) {
    if (v === variety) continue;
    const bars = allBars.get(v);
    if (!bars) continue;
    const idx = bars.findIndex(b => b.date === date);
    if (idx <= 0) continue;
    const ret = bars[idx].close - bars[idx - 1].close;
    if (ret === 0) continue;
    total++;
    if ((direction === 'long' && ret > 0) || (direction === 'short' && ret < 0)) sameDir++;
  }

  return total > 0 && sameDir / total >= 0.5;
}

// ============ 季节性检查 ============
function checkSeasonality(variety: string, date: string, direction: 'long' | 'short'): boolean {
  const bars = loadDailyBars(variety);
  const month = parseInt(date.substring(5, 7));
  const day = parseInt(date.substring(8, 10));

  let winCount = 0, totalCount = 0;
  for (const bar of bars) {
    const barMonth = parseInt(bar.date.substring(5, 7));
    const barDay = parseInt(bar.date.substring(8, 10));
    if (Math.abs(barMonth - month) <= SEASONAL_WINDOW && Math.abs(barDay - day) <= SEASONAL_WINDOW) {
      totalCount++;
      if ((direction === 'long' && bar.ret > 0) || (direction === 'short' && bar.ret < 0)) {
        winCount++;
      }
    }
  }

  return totalCount >= 5 && winCount / totalCount >= SEASONAL_THRESHOLD;
}

// ============ 板块映射 ============
const SECTOR_MAP: Record<string, string> = {
  // 黑色系
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系',
  SF0: '黑色系', SM0: '黑色系', WR0: '黑色系', ZC0: '黑色系',
  // 有色金属
  CU0: '有色金属', AL0: '有色金属', ZN0: '有色金属', PB0: '有色金属',
  NI0: '有色金属', SN0: '有色金属',
  // 贵金属
  AU0: '贵金属', AG0: '贵金属',
  // 能源化工
  SC0: '能源化工', FU0: '能源化工', LU0: '能源化工', BU0: '能源化工',
  L0: '能源化工', V0: '能源化工', PP0: '能源化工', EG0: '能源化工',
  PG0: '能源化工', SA0: '能源化工', TA0: '能源化工', MA0: '能源化工',
  RU0: '能源化工', NR0: '能源化工', PF0: '能源化工', PR0: '能源化工',
  // 农产品
  C0: '农产品', CS0: '农产品', A0: '农产品', B0: '农产品',
  M0: '农产品', Y0: '农产品', P0: '农产品', OI0: '农产品',
  RM0: '农产品', CF0: '农产品', SR0: '农产品', AP0: '农产品',
  CJ0: '农产品', JD0: '农产品', LH0: '农产品',
  // 其他
  T0: '金融', TF0: '金融', TS0: '金融', IH0: '金融', IF0: '金融', IC0: '金融', IM0: '金融',
  SP0: '其他', BC0: '其他', EC0: '其他', LC0: '其他', SI0: '其他',
};

function getSector(variety: string): string | null {
  return SECTOR_MAP[variety] || null;
}

function getSectorVarieties(sector: string): string[] {
  return Object.entries(SECTOR_MAP).filter(([_, s]) => s === sector).map(([v]) => v);
}

// ============ 主回测流程 ============
function runFusionBacktest() {
  console.log('=== V16.3 多时间框架融合回测 ===\n');

  const propMap = buildPropagationMap();
  const allDailyBars = new Map<string, DailyBar[]>();
  const allIntradayBars = new Map<string, IntradayBar[]>();

  // 加载数据
  for (const variety of Object.keys(SECTOR_MAP)) {
    const daily = loadDailyBars(variety);
    if (daily.length > 0) allDailyBars.set(variety, daily);
    const intraday = loadIntradayBars(variety);
    if (intraday.length > 0) allIntradayBars.set(variety, intraday);
  }

  console.log(`加载品种: 日线 ${allDailyBars.size}, 60min ${allIntradayBars.size}`);

  // 检测日线信号
  const allSignals: Signal[] = [];
  for (const [variety, bars] of allDailyBars) {
    if (!propMap.has(variety)) continue;
    const signals = detectSignals(variety, bars);
    allSignals.push(...signals);
  }

  console.log(`\nL0 总信号: ${allSignals.length}`);

  // L1: 白名单过滤
  const l1Signals = allSignals.filter(s => propMap.has(s.variety));
  console.log(`L1 白名单: ${l1Signals.length} (${(l1Signals.length / allSignals.length * 100).toFixed(1)}%)`);

  // L2: 板块联动
  const l2Signals = l1Signals.filter(s => {
    const bars = allDailyBars.get(s.variety);
    if (!bars) return false;
    return checkSectorCorrelation(s.variety, s.date, allDailyBars, s.direction);
  });
  console.log(`L2 板块联动: ${l2Signals.length} (${(l2Signals.length / l1Signals.length * 100).toFixed(1)}%)`);

  // L3: 季节性
  const l3Signals = l2Signals.filter(s => checkSeasonality(s.variety, s.date, s.direction));
  console.log(`L3 季节性: ${l3Signals.length} (${(l3Signals.length / l2Signals.length * 100).toFixed(1)}%)`);

  // L4: next1 确认
  const l4Signals = l3Signals.filter(s => {
    const bars = allDailyBars.get(s.variety);
    if (!bars) return false;
    const idx = bars.findIndex(b => b.date === s.date);
    if (idx < 0 || idx >= bars.length - 1) return false;
    const nextRet = bars[idx + 1].close - bars[idx].close;
    return (s.direction === 'long' && nextRet > 0) || (s.direction === 'short' && nextRet < 0);
  });
  console.log(`L4 next1确认: ${l4Signals.length} (${(l4Signals.length / l3Signals.length * 100).toFixed(1)}%)`);

  // L5: 60min 回调入场（有数据时）或日线入场（回退）
  const trades: Trade[] = [];
  let entryFromIntraday = 0;
  let entryFromDaily = 0;
  for (const signal of l4Signals) {
    const dailyBars = allDailyBars.get(signal.variety)!;
    const signalIdx = dailyBars.findIndex(b => b.date === signal.date);
    if (signalIdx < 0) continue;

    const intradayBars = allIntradayBars.get(signal.variety);
    let entryDate: string;
    let entryPrice: number;
    let stopLoss: number;

    // 尝试 60min 回调入场
    if (intradayBars && intradayBars.length > 0) {
      const entry = findPullbackEntry(intradayBars, signal.date, signal.direction, signal.atr);
      if (entry) {
        entryDate = entry.entryDate;
        entryPrice = entry.entryPrice;
        stopLoss = entry.stopLoss;
        entryFromIntraday++;
      } else {
        // 60min 数据存在但没找到回调入场，用日线收盘价
        entryDate = signal.date;
        entryPrice = dailyBars[signalIdx].close;
        stopLoss = signal.direction === 'long'
          ? entryPrice - 2 * signal.atr
          : entryPrice + 2 * signal.atr;
        entryFromDaily++;
      }
    } else {
      // 无 60min 数据，用日线收盘价
      entryDate = signal.date;
      entryPrice = dailyBars[signalIdx].close;
      stopLoss = signal.direction === 'long'
        ? entryPrice - 2 * signal.atr
        : entryPrice + 2 * signal.atr;
      entryFromDaily++;
    }

    // 模拟交易
    for (const holdDays of HOLD_DAYS) {
      const exitIdx = Math.min(signalIdx + holdDays, dailyBars.length - 1);
      const exitBar = dailyBars[exitIdx];

      let exitPrice = exitBar.close;
      let exitReason = `持有${holdDays}天`;
      let actualHoldDays = holdDays;

      for (let i = signalIdx + 1; i <= exitIdx; i++) {
        const bar = dailyBars[i];
        if (signal.direction === 'long' && bar.low <= stopLoss) {
          exitPrice = stopLoss;
          exitReason = '止损';
          actualHoldDays = i - signalIdx;
          break;
        }
        if (signal.direction === 'short' && bar.high >= stopLoss) {
          exitPrice = stopLoss;
          exitReason = '止损';
          actualHoldDays = i - signalIdx;
          break;
        }
      }

      const rawPnl = signal.direction === 'long'
        ? (exitPrice - entryPrice) / entryPrice
        : (entryPrice - exitPrice) / entryPrice;

      const cost = COMMISSION_RATE * 2 + SLIPPAGE_RATE * 2;
      const netPnl = rawPnl - cost;

      trades.push({
        signal, entryDate, entryPrice,
        exitDate: exitBar.date, exitPrice, pnl: netPnl, exitReason, holdDays: actualHoldDays
      });
    }
  }

  console.log(`L5 入场: ${entryFromIntraday} 个60min回调, ${entryFromDaily} 个日线回退`);
  console.log(`\n总交易: ${trades.length}`);

  // 统计
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
  const netPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const stopLosses = trades.filter(t => t.exitReason === '止损');

  console.log(`\n=== 回测结果 ===`);
  console.log(`交易数: ${trades.length}`);
  console.log(`胜率: ${(wins.length / trades.length * 100).toFixed(1)}%`);
  console.log(`毛PF: ${pf.toFixed(2)}`);
  console.log(`净PnL: ${(netPnl * 100).toFixed(2)}%`);
  console.log(`止损占比: ${(stopLosses.length / trades.length * 100).toFixed(1)}%`);
  console.log(`平均持有: ${(trades.reduce((s, t) => s + t.holdDays, 0) / trades.length).toFixed(1)} 天`);
}

runFusionBacktest();
