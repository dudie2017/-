/**
 * 方案6：回撤工程（Drawdown Engineering）
 * 视角：不寻优新参数，而是对「最优参数 P1」的交易序列叠加 3 种风控工具，
 *       对比各工具对收益/回撤/胜率的影响，找"性价比最高"的回撤控制手段。
 *
 * 3 种风控工具：
 *   A. 连续亏损熔断：连亏 N 笔 → 暂停 M 天不开新仓
 *   B. 波动率目标仓位：入场时 ATR 高于常态 → 减仓（等效降低 pnl 权重）
 *   C. 组合：A + B
 *
 * 用法：npx tsx src/scripts/runSilverDrawdownEngine.ts
 */
import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const CODE = 'AG0';
const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OUT = path.join(process.cwd(), 'src/data/AG0_drawdownEngine.json');

// 方案1 的 Pareto P1 参数（双向同参）
const P1: any = {
  stopAtrMult: 1.93, targetAtrMult: 6.92, maxHoldDays: 53,
  cooldownBars: 6, trendFilter: false, minSignalGrade: 'L2',
};

const BASE_OPTS: any = {
  startCapital: 100000,
  maxPositionPct: 1.0,
  minSignalGrade: 'L2',
  maxHoldDays: 53,
  minRR: 1.0,
  cooldownBars: 6,
  trendFilter: false,
  warmupBars: 60,
  returnAllTrades: true,
  quiet: true,
};

interface TradeLite {
  signalDate: string;
  exitDate: string;
  direction: 'LONG' | 'SHORT';
  pnl: number;
  rMultiple: number;
}

function getBars(code: string): any[] {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf-8'));
  const bars = Array.isArray(raw) ? raw : (raw.bars || []);
  return bars.filter((b: any) => b && b.c != null);
}

async function prescanVariety(code: string): Promise<V16Row[]> {
  const bars = getBars(code);
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, {
      stopAtrMult: 3.0, targetAtrMult: 3.0, maxHoldDays: 53,
      minSignalGrade: 'L2', trendFilter: false, cooldownBars: 0,
    } as any);
    if (row) rows.push(row);
  }
  return rows;
}

async function runBase(rows: V16Row[]): Promise<{ trades: TradeLite[]; equity: { date: string; equity: number }[] }> {
  const signalCache = new Map<string, V16Row[]>();
  signalCache.set(CODE, rows);
  const res = await runBacktest({
    ...BASE_OPTS,
    codes: [CODE],
    dataDir: DATA_DIR,
    signalCache,
    sideParams: { long: P1, short: P1 },
  } as any);
  const trades: TradeLite[] = (res.trades as any[]).map((t: any) => ({
    signalDate: t.signalDate, exitDate: t.exitDate || t.signalDate,
    direction: t.direction, pnl: t.pnl, rMultiple: t.rMultiple,
  }));
  return { trades, equity: res.equityCurve || [] };
}

function computeDrawdown(equity: { date: string; equity: number }[]): { maxDD: number; endEquity: number } {
  let peak = -Infinity, maxDD = 0;
  let endEquity = 0;
  for (const pt of equity) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDD) maxDD = dd;
    endEquity = pt.equity;
  }
  return { maxDD, endEquity };
}

function calcStats(trades: TradeLite[]): { trades: number; wins: number; winRate: number; pnl: number; pf: number } {
  let wins = 0, grossWin = 0, grossLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { wins++; grossWin += t.pnl; } else grossLoss += -t.pnl;
  }
  const pnl = trades.reduce((s, t) => s + t.pnl, 0);
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 99 : 0);
  return { trades: trades.length, wins, winRate: trades.length ? wins / trades.length : 0, pnl, pf };
}

// 工具A：连续亏损熔断（连亏 N 笔 → 暂停 M 天）
function applyCircuitBreaker(trades: TradeLite[], nLoss: number, pauseDays: number): TradeLite[] {
  const out: TradeLite[] = [];
  let lossStreak = 0;
  let pauseUntil: string | null = null;
  for (const t of trades) {
    if (pauseUntil && t.signalDate < pauseUntil) continue; // 冷却期跳过开仓
    out.push(t);
    if (t.pnl > 0) {
      lossStreak = 0;
    } else {
      lossStreak++;
      if (lossStreak >= nLoss) {
        // 计算暂停截止日（M 天后，用日期字符串近似）
        const d = new Date(t.signalDate);
        d.setDate(d.getDate() + pauseDays);
        pauseUntil = d.toISOString().slice(0, 10);
        lossStreak = 0;
      }
    }
  }
  return out;
}

// 工具B：波动率目标仓位——ATR 高时减仓（简化：按 entry 位置前 N 根K线波动率）
// 由于信号序列无法直接取到历史 ATR，这里用"rMultiple 归一化"替代：高波动日 rMultiple 波动更大，
// 保守做法：对 rMultiple 超过阈值(3R)的交易减半仓位（等效 pnl 减半）。
function applyVolTarget(trades: TradeLite[], bigR: number, cutPct: number): TradeLite[] {
  return trades.map((t) => {
    if (Math.abs(t.rMultiple) > bigR) {
      return { ...t, pnl: t.pnl * cutPct };
    }
    return t;
  });
}

// 简化权益曲线：按 trade 顺序累计 pnl（无 equityCurve 时的近似）
function buildEquity(trades: TradeLite[]): { date: string; equity: number }[] {
  let eq = 100000;
  const pts = [{ date: trades[0]?.signalDate || '', equity: eq }];
  for (const t of trades) {
    eq += t.pnl;
    pts.push({ date: t.exitDate, equity: eq });
  }
  return pts;
}

async function main() {
  console.log('[方案6] 回撤工程开始...');
  const rows = await prescanVariety(CODE);
  console.log(`预扫描完成: ${rows.length} 个信号行`);

  const { trades, equity } = await runBase(rows);
  console.log(`基线交易序列: ${trades.length} 笔`);

  const scenarios: { name: string; fn: (t: TradeLite[]) => TradeLite[] }[] = [
    { name: '基线(无风控)', fn: (t) => t },
    { name: '熔断3笔·暂停5天', fn: (t) => applyCircuitBreaker(t, 3, 5) },
    { name: '熔断4笔·暂停10天', fn: (t) => applyCircuitBreaker(t, 4, 10) },
    { name: '熔断5笔·暂停15天', fn: (t) => applyCircuitBreaker(t, 5, 15) },
    { name: '波动率减仓(>3R减半)', fn: (t) => applyVolTarget(t, 3, 0.5) },
    { name: '波动率减仓(>5R减30%)', fn: (t) => applyVolTarget(t, 5, 0.7) },
    { name: '熔断4笔·暂停10天 + 波动率>3R减半', fn: (t) => applyVolTarget(applyCircuitBreaker(t, 4, 10), 3, 0.5) },
  ];

  const results: any[] = [];
  for (const sc of scenarios) {
    const newTrades = sc.fn(trades);
    const s = calcStats(newTrades);
    const eq = buildEquity(newTrades);
    const { maxDD, endEquity } = computeDrawdown(eq);
    const score = s.pnl > 0 ? s.pnl / (maxDD * endEquity || 1) : 0; // 收益/回撤比（简化：风险调整收益）
    results.push({
      name: sc.name,
      trades: s.trades, winRate: s.winRate, pnl: Math.round(s.pnl),
      pf: Number(s.pf.toFixed(2)), maxDrawdown: Number(maxDD.toFixed(4)),
      endEquity: Math.round(endEquity), riskAdjusted: Number(score.toFixed(2)),
    });
  }

  console.log('\n===== 回撤工程对比 =====');
  console.log(`${'方案'.padEnd(30)}${'笔数'.padStart(6)}${'胜率'.padStart(8)}${'收益'.padStart(11)}${'PF'.padStart(7)}${'回撤'.padStart(9)}${'风险调整'.padStart(10)}`);
  for (const r of results) {
    console.log(`${r.name.padEnd(30)}${String(r.trades).padStart(6)}${(r.winRate * 100).toFixed(1).padStart(7)}%${String(r.pnl).padStart(11)}${r.pf.toFixed(2).padStart(7)}${(r.maxDrawdown * 100).toFixed(1).padStart(8)}%${r.riskAdjusted.toFixed(2).padStart(10)}`);
  }

  fs.writeFileSync(OUT, JSON.stringify({ baselineTrades: trades.length, scenarios: results }, null, 2));
  console.log(`\n已保存 ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
