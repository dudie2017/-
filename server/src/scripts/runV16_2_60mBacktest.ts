/**
 * V16.2 回测引擎 — 60min 级别
 * 
 * 基于 V16 引擎适配 60min K 线数据
 * 
 * 与日线回测的关键差异：
 * 1. 数据格式: o/h/l/c/vol/hold (非 open/high/low/close/volume/oi)
 * 2. ATR 阈值调整: 60min bar 波动更小，冲击阈值从 4× 降到 3×ATR
 * 3. 渐变趋势: 连续 3 bar 同向 + 累计 1.5×ATR (日线是 2.5×)
 * 4. 持有期: 从日线 3-5 天缩短到 60min 12-24 根 bar (约 1.5-3 个交易日)
 * 5. 季节性: 60min 无季节性概念，跳过 S7 过滤
 * 6. 数据范围: ~8 个月 vs 20 年
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data-cache-60m');

// ===== 60min 级别参数 =====
const SHOCK_ATR_MULT = 4.0;        // 冲击阈值: 4×ATR (精选大冲击)
const GRADUAL_ATR_MULT = 1.5;      // 渐变趋势: 1.5×ATR
const GRADUAL_CONS_BARS = 3;       // 连续同向 bar 数
const VOL_INCREASE_RATIO = 1.1;    // 成交量递增比例
const SECTOR_CORR_THRESHOLD = 0.5; // S6 板块联动阈值
const NEXT1_THRESHOLD = 0.75;      // next1 确认阈值
const ATR_PERIOD = 14;             // ATR 周期

// 60min 持有期: 12-24 根 bar (约 1.5-3 个交易日)
const MIN_HOLD_BARS = 12;
const MAX_HOLD_BARS = 24;
const STOP_LOSS_ATR = 2.0;         // 止损: 2×ATR
const TAKE_PROFIT_ATR = 4.0;       // 止盈: 4×ATR

// 仅使用突变冲击（渐变趋势在 60min 级别表现差）
const USE_GRADUAL = false;

// 交易成本 (60min 级别滑点相对更小)
const SLIPPAGE_PCT = 0.0003;       // 0.03% 滑点
const COMMISSION_PCT = 0.00005;    // 0.005% 手续费

interface Bar60m {
  date: string;
  o: number; h: number; l: number; c: number;
  vol: number; hold: number;
}

interface Signal {
  variety: string;
  barIndex: number;
  direction: 1 | -1;
  type: 'shock' | 'gradual';
  atr: number;
  strength: number;
  date: string;
}

interface Trade {
  variety: string;
  direction: 1 | -1;
  entryPrice: number;
  exitPrice: number;
  entryDate: string;
  exitDate: string;
  pnl: number;
  pnlPct: number;
  exitReason: 'tp' | 'sl' | 'timeout';
  holdBars: number;
  signalType: string;
}

// ===== 数据加载 =====
function loadBars(variety: string): Bar60m[] {
  const fp = path.join(dataDir, `${variety}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
    return raw.map((r: any) => ({
      date: r.date, o: r.o, h: r.h, l: r.l, c: r.c,
      vol: r.vol ?? 0, hold: r.hold ?? 0,
    }));
  } catch { return []; }
}

// ===== ATR 计算 =====
function calcATR(bars: Bar60m[], endIdx: number, period: number): number {
  if (endIdx < period) return 0;
  let sum = 0;
  for (let i = endIdx - period + 1; i <= endIdx; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

// ===== 板块映射 =====
const SECTOR_MAP: Record<string, string> = {
  // 黑色系
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系',
  SF0: '黑色系', SM0: '黑色系', WR0: '黑色系', ZC0: '黑色系',
  // 有色金属
  CU0: '有色金属', AL0: '有色金属', ZN0: '有色金属', PB0: '有色金属',
  NI0: '有色金属', SN0: '有色金属', AU0: '有色金属', AG0: '有色金属',
  // 能源化工
  SC0: '能源化工', FU0: '能源化工', LU0: '能源化工', BU0: '能源化工',
  FG0: '能源化工', SA0: '能源化工', PP0: '能源化工', L0: '能源化工',
  V0: '能源化工', EG0: '能源化工', EB0: '能源化工', PG0: '能源化工',
  TA0: '能源化工', MA0: '能源化工', RU0: '能源化工', NR0: '能源化工',
  // 农产品
  A0: '农产品', C0: '农产品', CS0: '农产品', JD0: '农产品',
  LH0: '农产品', M0: '农产品', Y0: '农产品', P0: '农产品',
  OI0: '农产品', RM0: '农产品', CF0: '农产品', SR0: '农产品',
  AP0: '农产品', CJ0: '农产品',
  // 其他
  BC0: '其他', EC0: '其他', SP0: '其他',
};

function getSector(variety: string): string {
  return SECTOR_MAP[variety] || '未分类';
}

// ===== 冲击检测 =====
function detectShocks(bars: Bar60m[], variety: string): Signal[] {
  const signals: Signal[] = [];
  for (let i = ATR_PERIOD + 1; i < bars.length; i++) {
    const atr = calcATR(bars, i - 1, ATR_PERIOD);
    if (atr <= 0) continue;

    const barRet = bars[i].c - bars[i - 1].c;
    const absRet = Math.abs(barRet);

    if (absRet >= SHOCK_ATR_MULT * atr) {
      const direction = barRet > 0 ? 1 : -1;
      signals.push({
        variety, barIndex: i, direction,
        type: 'shock', atr,
        strength: absRet / atr,
        date: bars[i].date,
      });
    }
  }
  return signals;
}

// ===== 渐变趋势检测 =====
function detectGradualTrends(bars: Bar60m[], variety: string): Signal[] {
  const signals: Signal[] = [];
  for (let i = ATR_PERIOD + GRADUAL_CONS_BARS; i < bars.length; i++) {
    const atr = calcATR(bars, i - 1, ATR_PERIOD);
    if (atr <= 0) continue;

    let allSameDir = true;
    let cumRet = 0;
    let volIncreasing = true;

    for (let j = 0; j < GRADUAL_CONS_BARS; j++) {
      const idx = i - GRADUAL_CONS_BARS + 1 + j;
      const ret = bars[idx].c - bars[idx - 1].c;
      cumRet += ret;
      if (j > 0 && (ret > 0) !== (bars[i - 1].c - bars[i - 2].c > 0)) {
        allSameDir = false;
        break;
      }
      if (j > 0 && bars[idx].vol < bars[idx - 1].vol * VOL_INCREASE_RATIO) {
        volIncreasing = false;
      }
    }

    if (!allSameDir) continue;
    if (Math.abs(cumRet) < GRADUAL_ATR_MULT * atr) continue;
    if (!volIncreasing) continue;

    const direction = cumRet > 0 ? 1 : -1;
    signals.push({
      variety, barIndex: i, direction,
      type: 'gradual', atr,
      strength: Math.abs(cumRet) / atr,
      date: bars[i].date,
    });
  }
  return signals;
}

// ===== S6: 板块联动检查 =====
function checkSectorCorrelation(
  signals: Map<string, Signal[]>,
  variety: string,
  barIndex: number,
  direction: 1 | -1,
): boolean {
  const sector = getSector(variety);
  if (sector === '未分类') return false;

  const sectorVarieties = Object.keys(SECTOR_MAP).filter(
    v => SECTOR_MAP[v] === sector && v !== variety
  );
  if (sectorVarieties.length === 0) return false;

  let sameDirCount = 0;
  let totalChecked = 0;

  for (const sv of sectorVarieties) {
    const svSignals = signals.get(sv);
    if (!svSignals) continue;
    const nearby = svSignals.find(
      s => Math.abs(s.barIndex - barIndex) <= 3
    );
    if (nearby) {
      totalChecked++;
      if (nearby.direction === direction) sameDirCount++;
    }
  }

  if (totalChecked === 0) return false;
  return (sameDirCount / totalChecked) >= SECTOR_CORR_THRESHOLD;
}

// ===== 交易模拟 =====
function simulateTrade(
  bars: Bar60m[],
  entryIdx: number,
  direction: 1 | -1,
  atr: number,
): Trade | null {
  if (entryIdx >= bars.length - 1) return null;

  const entryPrice = bars[entryIdx].c;
  const slPrice = direction === 1
    ? entryPrice - STOP_LOSS_ATR * atr
    : entryPrice + STOP_LOSS_ATR * atr;
  const tpPrice = direction === 1
    ? entryPrice + TAKE_PROFIT_ATR * atr
    : entryPrice - TAKE_PROFIT_ATR * atr;

  let exitPrice = entryPrice;
  let exitIdx = entryIdx;
  let exitReason: 'tp' | 'sl' | 'timeout' = 'timeout';

  for (let i = entryIdx + 1; i <= Math.min(entryIdx + MAX_HOLD_BARS, bars.length - 1); i++) {
    const bar = bars[i];
    if (direction === 1) {
      if (bar.l <= slPrice) { exitPrice = slPrice; exitReason = 'sl'; exitIdx = i; break; }
      if (bar.h >= tpPrice) { exitPrice = tpPrice; exitReason = 'tp'; exitIdx = i; break; }
    } else {
      if (bar.h >= slPrice) { exitPrice = slPrice; exitReason = 'sl'; exitIdx = i; break; }
      if (bar.l <= tpPrice) { exitPrice = tpPrice; exitReason = 'tp'; exitIdx = i; break; }
    }
    exitIdx = i;
    exitPrice = bar.c;
  }

  if (exitIdx === entryIdx) return null;
  if (exitIdx - entryIdx < MIN_HOLD_BARS && exitReason === 'timeout') return null;

  const pnl = direction * (exitPrice - entryPrice);
  const pnlPct = pnl / entryPrice;

  return {
    variety: '', direction, entryPrice, exitPrice,
    entryDate: bars[entryIdx].date,
    exitDate: bars[exitIdx].date,
    pnl, pnlPct, exitReason,
    holdBars: exitIdx - entryIdx,
    signalType: '',
  };
}

// ===== 主函数 =====
function main() {
  console.log('=== V16.2 回测引擎 — 60min 级别 ===\n');

  // 1. 加载数据
  const allBars: Record<string, Bar60m[]> = {};
  const varieties = Object.keys(SECTOR_MAP);
  for (const v of varieties) {
    const bars = loadBars(v);
    if (bars.length >= 100) allBars[v] = bars;
  }
  console.log(`加载 ${Object.keys(allBars).length} 个品种的 60min 数据`);

  // 2. 检测信号
  const allSignals = new Map<string, Signal[]>();
  let totalShocks = 0, totalGradual = 0;

  for (const [v, bars] of Object.entries(allBars)) {
    const shocks = detectShocks(bars, v);
    const gradual = USE_GRADUAL ? detectGradualTrends(bars, v) : [];
    const combined = [...shocks, ...gradual];
    if (combined.length > 0) allSignals.set(v, combined);
    totalShocks += shocks.length;
    totalGradual += gradual.length;
  }

  console.log(`信号检测: ${totalShocks} 突变 + ${totalGradual} 渐变 = ${totalShocks + totalGradual} 总计`);

  // Debug: 哪些品种有信号
  const signalVarieties = Array.from(allSignals.keys()).sort();
  console.log(`有信号的品种 (${signalVarieties.length}): ${signalVarieties.slice(0, 15).join(', ')}${signalVarieties.length > 15 ? '...' : ''}`);
  const whitelistLeaders = [...new Set(PROPAGATION_WHITELIST.map(p => p.leader))];
  console.log(`白名单 leaders (${whitelistLeaders.length}): ${whitelistLeaders.slice(0, 15).join(', ')}${whitelistLeaders.length > 15 ? '...' : ''}`);
  const matched = signalVarieties.filter(v => whitelistLeaders.includes(v));
  console.log(`匹配品种: ${matched.length} — ${matched.join(', ') || '无'}`);
  console.log('');

  // 3. 过滤 + 生成交易
  let l1Pass = 0, l2Pass = 0, l3Pass = 0;
  const candidateTrades: { signal: Signal; trade: Trade }[] = [];

  for (const [leader, signals] of allSignals.entries()) {
    // 查找该 leader 的所有白名单 follower
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === leader);
    if (pairs.length === 0) continue;
    const followers = pairs.map(p => p.follower);

    for (const signal of signals) {
      l1Pass++;

      // S6: 板块联动
      const bars = allBars[leader];
      if (!bars) continue;
      if (!checkSectorCorrelation(allSignals, leader, signal.barIndex, signal.direction)) {
        continue;
      }
      l2Pass++;

      // next1 确认
      const nextIdx = signal.barIndex + 1;
      if (nextIdx >= bars.length) continue;
      const nextRet = bars[nextIdx].c - bars[signal.barIndex].c;
      if (nextRet * signal.direction <= 0) continue;
      l3Pass++;

      // 为每个 follower 生成交易
      for (const follower of followers) {
        const fBars = allBars[follower];
        if (!fBars) continue;

        // follower 在 leader 信号后的 1-3 根 bar 内入场
        for (const lag of [1, 2, 3]) {
          const fIdx = signal.barIndex + lag;
          if (fIdx >= fBars.length - MIN_HOLD_BARS) continue;

          const trade = simulateTrade(fBars, fIdx, signal.direction, signal.atr);
          if (trade) {
            trade.variety = `${leader}→${follower}`;
            trade.signalType = signal.type;
            candidateTrades.push({ signal, trade });
            break; // 只取第一个有效 lag
          }
        }
      }
    }
  }

  console.log(`信号漏斗:`);
  console.log(`  L1 白名单: ${l1Pass}`);
  console.log(`  L2 S6板块: ${l2Pass}`);
  console.log(`  L3 next1:  ${l3Pass}`);
  console.log(`  候选交易:  ${candidateTrades.length}\n`);

  // 4. 计算绩效
  const trades = candidateTrades.map(ct => ct.trade);
  if (trades.length === 0) {
    console.log('无交易产生');
    return;
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));

  // 扣除交易成本
  const totalCost = trades.length * (SLIPPAGE_PCT * 2 + COMMISSION_PCT * 2);
  const netPnl = trades.reduce((s, t) => s + t.pnlPct, 0) - totalCost;

  // 最大回撤
  let peak = 0, maxDD = 0, cumPnl = 0;
  for (const t of trades) {
    cumPnl += t.pnlPct;
    peak = Math.max(peak, cumPnl);
    maxDD = Math.max(maxDD, peak - cumPnl);
  }

  // 按信号类型分组
  const shockTrades = trades.filter(t => t.signalType === 'shock');
  const gradualTrades = trades.filter(t => t.signalType === 'gradual');

  console.log('=== 60min 回测结果 ===');
  console.log(`交易数: ${trades.length}`);
  console.log(`  突变冲击: ${shockTrades.length}`);
  console.log(`  渐变趋势: ${gradualTrades.length}`);
  console.log(`胜率: ${(wins.length / trades.length * 100).toFixed(1)}%`);
  console.log(`总盈亏: ${(trades.reduce((s, t) => s + t.pnlPct, 0) * 100).toFixed(2)}%`);
  console.log(`交易成本: ${(totalCost * 100).toFixed(2)}%`);
  console.log(`净盈亏: ${(netPnl * 100).toFixed(2)}%`);
  console.log(`毛利: ${(grossProfit * 100).toFixed(2)}%`);
  console.log(`毛损: ${(grossLoss * 100).toFixed(2)}%`);
  console.log(`PF: ${grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : 'N/A'}`);
  console.log(`最大回撤: ${(maxDD * 100).toFixed(2)}%`);
  console.log(`平均持仓: ${(trades.reduce((s, t) => s + t.holdBars, 0) / trades.length).toFixed(1)} bars`);

  // 按信号类型统计
  console.log('\n=== 按信号类型 ===');
  for (const [label, group] of [['突变', shockTrades], ['渐变', gradualTrades]] as [string, Trade[]][]) {
    if (group.length === 0) continue;
    const gw = group.filter(t => t.pnl > 0);
    const gp = group.reduce((s, t) => s + t.pnlPct, 0);
    const gCost = group.length * (SLIPPAGE_PCT * 2 + COMMISSION_PCT * 2);
    console.log(`  ${label}: ${group.length}笔, 胜率${(gw.length / group.length * 100).toFixed(0)}%, 净PnL${((gp - gCost) * 100).toFixed(2)}%`);
  }

  // 按退出原因统计
  console.log('\n=== 按退出原因 ===');
  for (const reason of ['tp', 'sl', 'timeout'] as const) {
    const group = trades.filter(t => t.exitReason === reason);
    if (group.length === 0) continue;
    const gp = group.reduce((s, t) => s + t.pnlPct, 0);
    console.log(`  ${reason}: ${group.length}笔, PnL${(gp * 100).toFixed(2)}%`);
  }

  // 保存结果
  const result = {
    timestamp: new Date().toISOString(),
    timeframe: '60min',
    dataRange: `${Object.values(allBars)[0]?.[0]?.date} ~ ${Object.values(allBars)[0]?.at(-1)?.date}`,
    totalBars: Object.values(allBars)[0]?.length ?? 0,
    varietiesLoaded: Object.keys(allBars).length,
    totalSignals: totalShocks + totalGradual,
    shockSignals: totalShocks,
    gradualSignals: totalGradual,
    funnel: { l1: l1Pass, l2: l2Pass, l3: l3Pass },
    tradeCount: trades.length,
    winRate: wins.length / trades.length,
    grossPF: grossLoss > 0 ? grossProfit / grossLoss : 0,
    netPnl: netPnl,
    maxDrawdown: maxDD,
    avgHoldBars: trades.reduce((s, t) => s + t.holdBars, 0) / trades.length,
    trades: trades.slice(0, 50),
  };

  const outPath = path.join(__dirname, '../data/v16_2_60mResult.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\n结果已保存到 ${outPath}`);
}

main();
