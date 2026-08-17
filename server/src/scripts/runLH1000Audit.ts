/**
 * 生猪(LH0) 1000 次回测——防过拟合审计
 * 基于 LH0_multiObjective.json 的最优参数，做：
 *  1. 按年分解（含黑天鹅/无黑天鹅双口径）
 *  2. 剔除 2022 猪价暴跌段（做空利润来源检验）
 *  3. 做空方向专项审计
 *  4. 参数扰动稳健性（±10% × 50，双口径）
 *  5. 样本外验证（2025-01-01 前/后切分）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';
import type { V16Row } from '../services/v16_types';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE = 'LH0';
const DATA_DIR = path.join(__dirname, '..', '..', 'data-cache-daily-20y');
const OUT_FILE = path.join(__dirname, '..', 'data', 'LH0_audit.json');

// ============ 理论最大收益（内联，避免触发 theoreticalMax.ts 顶层副作用） ============

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

function loadBars(code: string): Bar[] {
  try {
    const fp = path.join(DATA_DIR, `${code}.json`);
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data?.bars && Array.isArray(data.bars)) return data.bars;
    return [];
  } catch {
    return [];
  }
}

interface SwingPoint { index: number; date: string; price: number; type: 'high' | 'low'; }

function zigzag(bars: Bar[], thresholdPct: number): SwingPoint[] {
  const th = thresholdPct / 100;
  const points: SwingPoint[] = [];
  const start = bars[0];
  let state = 0;
  let lastExtreme: SwingPoint = { index: 0, date: start.date, price: start.c, type: 'low' };
  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].c;
    if (state === 0) {
      if (price > start.c + start.c * th) {
        state = 1;
        points.push(lastExtreme);
      } else if (price < start.c - start.c * th) {
        state = -1;
        points.push(lastExtreme);
      }
      continue;
    }
    if (state === 1) {
      if (price > lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      } else if (lastExtreme.price - price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = -1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      }
    } else {
      if (price < lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      } else if (price - lastExtreme.price >= lastExtreme.price * th) {
        points.push(lastExtreme);
        state = 1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      }
    }
  }
  let longSegments = 0;
  let shortSegments = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (points[i].type === 'low' && points[i + 1].type === 'high') longSegments++;
    else if (points[i].type === 'high' && points[i + 1].type === 'low') shortSegments++;
  }
  return points;
}

function computeTheoreticalMax(bars: Bar[], thresholdPct: number) {
  const points = zigzag(bars, thresholdPct);
  let longReturn = 0;
  let shortReturn = 0;
  let longSegments = 0;
  let shortSegments = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.type === b.type) continue;
    if (a.type === 'low' && b.type === 'high') {
      longReturn += (b.price - a.price) / a.price;
      longSegments++;
    } else {
      shortReturn += (a.price - b.price) / a.price;
      shortSegments++;
    }
  }
  return {
    thresholdPct,
    swingCount: points.length,
    longSegments,
    shortSegments,
    longReturn,
    shortReturn,
    totalReturn: longReturn + shortReturn,
  };
}

// ============ 黑天鹅过滤器（价格冲击 + 事件库，冷却 10 日） ============

function buildBlackSwanFilter() {
  const bars = loadVarietyBars(CODE, DATA_DIR) as any[];
  const cooldown: boolean[] = new Array(bars.length).fill(false);
  const shockDates = new Set<string>();
  const shockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
  try {
    const shocks = detectShocks(bars as any, CODE) as Array<{ index: number; date: string; direction: 'up' | 'down' }>;
    for (const s of shocks) {
      shockDates.add(s.date);
      const until = Math.min(bars.length, s.index + 10);
      for (let j = s.index; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = s.direction;
      }
    }
    const barDateIdx = new Map<string, number>();
    bars.forEach((b: any, idx: number) => barDateIdx.set(b.date, idx));
    for (const ev of BLACK_SWAN_EVENTS) {
      if (!ev.varieties || !ev.varieties.includes(CODE)) continue;
      const idx = barDateIdx.get(ev.date);
      if (idx === undefined) continue;
      const until = Math.min(bars.length, idx + 10);
      for (let j = idx; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = ev.direction === '利空' ? 'down' : 'up';
      }
    }
  } catch (e) {
    console.warn('黑天鹅检测异常，回退为空过滤器:', (e as Error).message);
  }
  return {
    mode: 'riskOff' as const,
    cooldownMap: new Map([[CODE, cooldown]]),
    shockDirMap: new Map([[CODE, shockDir]]),
    shockDates: new Map([[CODE, shockDates]]),
    resonanceBoost: 0.0,
    divergenceCut: 0.0,
  };
}

// ============ 预扫描缓存 ============

let cachedRows: V16Row[] | null = null;
async function getPrescannedRows(): Promise<V16Row[]> {
  if (cachedRows) return cachedRows;
  const bars = loadBars(CODE);
  const rows: V16Row[] = [];
  for (let i = 60; i < bars.length; i++) {
    const histBars = bars.slice(0, i + 1);
    const row = await scanV16Variety(CODE, histBars, CODE, { edgeLookback: 70, allowRangeTrading: true });
    if (row) rows.push(row);
  }
  cachedRows = rows;
  return rows;
}

// ============ 指标统计（与 runLH1000Backtest 口径一致） ============

interface TradeLike {
  pnl: number;
  direction: 'LONG' | 'SHORT';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
}

interface Stats {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgRR: number;
  profitFactor: number;
  maxDrawdown: number;
  totalPnl: number;
  longPnl: number;
  shortPnl: number;
  capture: number;
  longCapture: number;
  shortCapture: number;
}

function calcStats(trades: TradeLike[], theoLong: number, theoShort: number): Stats {
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const wins = trades.filter((t) => t.pnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const longPriceReturn = longTrades.reduce((s, t) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.exitPrice - t.entryPrice) / ev;
  }, 0);
  const shortPriceReturn = shortTrades.reduce((s, t) => {
    const ev = Math.abs(t.entryPrice);
    if (!ev) return s;
    return s + (t.entryPrice - t.exitPrice) / ev;
  }, 0);
  let equity = 0;
  let peak = 0;
  let maxDrawdown = 0;
  const byEntry = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));
  for (const t of byEntry) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? (peak - equity) / peak : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  return {
    totalTrades: trades.length,
    longTrades: longTrades.length,
    shortTrades: shortTrades.length,
    wins: wins.length,
    losses: trades.length - wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgRR: Math.max(grossLoss, 1) > 0 ? totalPnl / Math.max(grossLoss, 1) : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    maxDrawdown,
    totalPnl,
    longPnl: longTrades.reduce((s, t) => s + t.pnl, 0),
    shortPnl: shortTrades.reduce((s, t) => s + t.pnl, 0),
    capture: theoLong + theoShort > 0 ? (longPriceReturn + shortPriceReturn) / (theoLong + theoShort) : 0,
    longCapture: theoLong > 0 ? longPriceReturn / theoLong : 0,
    shortCapture: theoShort > 0 ? shortPriceReturn / theoShort : 0,
  };
}

// ============ 运行工具 ============

const BASE_OPTS = {
  startCapital: 1_000_000,
  maxPositionPct: 0.1,
  minSignalGrade: 'L2' as const,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  warmupBars: 60,
  returnAllTrades: true,
  quiet: true,
};

async function runSingle(
  params: Record<string, number | string | boolean>,
  signalCache: Map<string, V16Row[]>,
  newsFilter?: { mode: 'riskOff'; cooldownMap: Map<string, boolean[]>; shockDirMap: Map<string, Array<'up' | 'down' | null>>; shockDates: Map<string, Set<string>>; resonanceBoost: number; divergenceCut: number },
) {
  const p = {
    stopAtrMult: params.stopAtrMult as number,
    targetAtrMult: params.targetAtrMult as number,
    maxHoldDays: params.maxHoldDays as number,
    cooldownBars: params.cooldownBars as number,
    trendFilter: params.trendFilter as boolean,
    minSignalGrade: params.minSignalGrade as 'L1' | 'L2' | 'L3',
  };
  const result = await runBacktest({
    ...BASE_OPTS,
    startCapital: 1_000_000,
    maxPositionPct: 0.1,
    dataDir: DATA_DIR,
    codes: [CODE],
    signalCache,
    sideParams: { long: p, short: p },
    newsFilter,
  });
  const trades = (result.trades || []) as TradeLike[];
  return trades;
}

// ============ 审计主流程 ============

function byYearStats(trades: TradeLike[], theoLong: number, theoShort: number) {
  const years = new Map<string, TradeLike[]>();
  for (const t of trades) {
    const y = (t.entryDate || '').slice(0, 4);
    if (!y) continue;
    if (!years.has(y)) years.set(y, []);
    years.get(y)!.push(t);
  }
  const out: Array<{ year: string; trades: number; winRate: number; totalPnl: number; longPnl: number; shortPnl: number; longCapture: number; shortCapture: number }> = [];
  for (const [year, ts] of [...years.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const s = calcStats(ts, theoLong, theoShort);
    out.push({
      year,
      trades: s.totalTrades,
      winRate: +s.winRate.toFixed(4),
      totalPnl: Math.round(s.totalPnl),
      longPnl: Math.round(s.longPnl),
      shortPnl: Math.round(s.shortPnl),
      longCapture: +s.longCapture.toFixed(4),
      shortCapture: +s.shortCapture.toFixed(4),
    });
  }
  return out;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main() {
  const resultPath = path.join(__dirname, '..', 'data', 'LH0_multiObjective.json');
  const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const best = result.topAll[0] as { params: Record<string, number | string | boolean>; stats: Stats; statsNone: Stats };
  const params = best.params;

  console.log('========== LH0 生猪防过拟合审计 ==========');
  console.log('审计参数（含黑天鹅综合 TOP1）:', JSON.stringify(params));
  console.log('含黑天鹅:', JSON.stringify({ winRate: best.stats.winRate, totalPnl: Math.round(best.stats.totalPnl), maxDrawdown: best.stats.maxDrawdown, shortCapture: best.stats.shortCapture }));
  console.log('无黑天鹅:', JSON.stringify({ winRate: best.statsNone.winRate, totalPnl: Math.round(best.statsNone.totalPnl), maxDrawdown: best.statsNone.maxDrawdown, shortCapture: best.statsNone.shortCapture }));

  const bars = loadBars(CODE);
  const theo = computeTheoreticalMax(bars, 3);
  console.log(`理论摆动 ${theo.swingCount} 段 | 做多 ${theo.longSegments} 段 ${(theo.longReturn * 100).toFixed(1)}% | 做空 ${theo.shortSegments} 段 ${(theo.shortReturn * 100).toFixed(1)}%`);

  const rows = await getPrescannedRows();
  const signalCache = new Map<string, V16Row[]>([[CODE, rows]]);
  const bsFilter = buildBlackSwanFilter();

  // ---- 1. 重跑最优参数，获取 trades（双口径） ----
  console.log('\n[1] 重跑最优参数回测（获取交易明细）...');
  const tradesBS = await runSingle(params, signalCache, bsFilter);
  const tradesNone = await runSingle(params, signalCache);
  console.log(`  含黑天鹅交易 ${tradesBS.length} 笔 | 无黑天鹅 ${tradesNone.length} 笔`);

  // ---- 2. 按年分解（含黑天鹅） ----
  console.log('\n[2] 按年分解（含黑天鹅口径）');
  const yearly = byYearStats(tradesBS, theo.longReturn, theo.shortReturn);
  for (const y of yearly) {
    console.log(`  ${y.year}: 交易${y.trades} 胜率${(y.winRate * 100).toFixed(1)}% 收益${y.totalPnl.toLocaleString()}（多${y.longPnl.toLocaleString()}/空${y.shortPnl.toLocaleString()}） 捕获多${(y.longCapture * 100).toFixed(0)}%/空${(y.shortCapture * 100).toFixed(0)}%`);
  }

  // ---- 3. 剔除 2022 猪价暴跌段 ----
  console.log('\n[3] 剔除 2022 年交易（做空利润来源检验）');
  const no2022BS = tradesBS.filter((t) => !(t.entryDate || '').startsWith('2022'));
  const sNo2022 = calcStats(no2022BS, theo.longReturn, theo.shortReturn);
  const sAll = calcStats(tradesBS, theo.longReturn, theo.shortReturn);
  console.log(`  全部: 收益${Math.round(sAll.totalPnl).toLocaleString()} 做空${Math.round(sAll.shortPnl).toLocaleString()} 空捕获${(sAll.shortCapture * 100).toFixed(0)}%`);
  console.log(`  剔除2022: 收益${Math.round(sNo2022.totalPnl).toLocaleString()} 做空${Math.round(sNo2022.shortPnl).toLocaleString()} 空捕获${(sNo2022.shortCapture * 100).toFixed(0)}%`);
  const shortFrom2022 = sAll.shortPnl - sNo2022.shortPnl;
  console.log(`  2022 年做空贡献: ${Math.round(shortFrom2022).toLocaleString()}（占做空总收益 ${sAll.shortPnl > 0 ? ((shortFrom2022 / sAll.shortPnl) * 100).toFixed(0) : 'N/A'}%）`);

  // ---- 4. 做空方向专项 ----
  console.log('\n[4] 做空方向专项（含黑天鹅）');
  const shortBS = tradesBS.filter((t) => t.direction === 'SHORT');
  const shortStats = calcStats(shortBS, 0, theo.shortReturn);
  const longBS = tradesBS.filter((t) => t.direction === 'LONG');
  const longStats = calcStats(longBS, theo.longReturn, 0);
  console.log(`  做多: ${longBS.length}笔 胜率${(longStats.winRate * 100).toFixed(1)}% 收益${Math.round(longStats.totalPnl).toLocaleString()} 捕获${(longStats.longCapture * 100).toFixed(0)}%`);
  console.log(`  做空: ${shortBS.length}笔 胜率${(shortStats.winRate * 100).toFixed(1)}% 收益${Math.round(shortStats.totalPnl).toLocaleString()} 捕获${(shortStats.shortCapture * 100).toFixed(0)}%`);

  // ---- 5. 参数扰动稳健性（±10% × 50，双口径） ----
  console.log('\n[5] 参数扰动稳健性（±10% × 50，双口径）...');
  const rng = mulberry32(20260811);
  const pnlsBS: number[] = [];
  const pnlsNone: number[] = [];
  for (let i = 0; i < 50; i++) {
    const perturb: Record<string, number | string | boolean> = {
      stopAtrMult: Math.max(0.5, (params.stopAtrMult as number) * (0.9 + rng() * 0.2)),
      targetAtrMult: Math.max(1.0, (params.targetAtrMult as number) * (0.9 + rng() * 0.2)),
      maxHoldDays: Math.max(5, Math.round((params.maxHoldDays as number) * (0.9 + rng() * 0.2))),
      cooldownBars: Math.max(0, Math.round((params.cooldownBars as number) * (0.9 + rng() * 0.2))),
      trendFilter: params.trendFilter,
      minSignalGrade: params.minSignalGrade,
    };
    const tBS = await runSingle(perturb, signalCache, bsFilter);
    const tNone = await runSingle(perturb, signalCache);
    pnlsBS.push(tBS.reduce((s, t) => s + t.pnl, 0));
    pnlsNone.push(tNone.reduce((s, t) => s + t.pnl, 0));
  }
  const meanBS = pnlsBS.reduce((s, v) => s + v, 0) / pnlsBS.length;
  const stdBS = Math.sqrt(pnlsBS.reduce((s, v) => s + (v - meanBS) ** 2, 0) / pnlsBS.length);
  const meanNone = pnlsNone.reduce((s, v) => s + v, 0) / pnlsNone.length;
  const stdNone = Math.sqrt(pnlsNone.reduce((s, v) => s + (v - meanNone) ** 2, 0) / pnlsNone.length);
  const cvBS = meanBS !== 0 ? stdBS / Math.abs(meanBS) : 0;
  const cvNone = meanNone !== 0 ? stdNone / Math.abs(meanNone) : 0;
  console.log(`  含黑天鹅: 均值${Math.round(meanBS).toLocaleString()} 标准差${Math.round(stdBS).toLocaleString()} CV=${(cvBS * 100).toFixed(1)}%`);
  console.log(`  无黑天鹅: 均值${Math.round(meanNone).toLocaleString()} 标准差${Math.round(stdNone).toLocaleString()} CV=${(cvNone * 100).toFixed(1)}%`);

  // ---- 6. 样本外验证（2025-01-01 前后） ----
  console.log('\n[6] 样本外验证（2025-01-01 切分，含黑天鹅）');
  const trainBS = tradesBS.filter((t) => (t.entryDate || '') < '2025-01-01');
  const oosBS = tradesBS.filter((t) => (t.entryDate || '') >= '2025-01-01');
  const sTrain = calcStats(trainBS, theo.longReturn, theo.shortReturn);
  const sOos = calcStats(oosBS, theo.longReturn, theo.shortReturn);
  console.log(`  样本内(2021-2024): 交易${sTrain.totalTrades} 收益${Math.round(sTrain.totalPnl).toLocaleString()} 胜率${(sTrain.winRate * 100).toFixed(1)}% 回撤${(sTrain.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`  样本外(2025-2026): 交易${sOos.totalTrades} 收益${Math.round(sOos.totalPnl).toLocaleString()} 胜率${(sOos.winRate * 100).toFixed(1)}% 回撤${(sOos.maxDrawdown * 100).toFixed(1)}%`);
  const keepRatio = sTrain.totalPnl > 0 ? sOos.totalPnl / sTrain.totalPnl : 0;
  console.log(`  OOS 收益留存率: ${(keepRatio * 100).toFixed(0)}%${keepRatio < 0.3 ? '（<30%，过拟合风险高）' : keepRatio < 0.7 ? '（30%~70%，需谨慎）' : '（≥70%，稳健）'}`);

  // ---- 落盘 ----
  const audit = {
    code: CODE,
    auditedAt: new Date().toISOString(),
    params,
    baseline: {
      stats: best.stats,
      statsNone: best.statsNone,
    },
    yearlyBS: yearly,
    no2022: {
      totalPnl: Math.round(sNo2022.totalPnl),
      shortPnl: Math.round(sNo2022.shortPnl),
      shortCapture: +sNo2022.shortCapture.toFixed(4),
      allTotalPnl: Math.round(sAll.totalPnl),
      allShortPnl: Math.round(sAll.shortPnl),
      shortFrom2022: Math.round(shortFrom2022),
    },
    shortDirection: {
      long: { trades: longStats.totalTrades, winRate: +longStats.winRate.toFixed(4), totalPnl: Math.round(longStats.totalPnl), capture: +longStats.longCapture.toFixed(4) },
      short: { trades: shortStats.totalTrades, winRate: +shortStats.winRate.toFixed(4), totalPnl: Math.round(shortStats.totalPnl), capture: +shortStats.shortCapture.toFixed(4) },
    },
    perturbation: {
      n: 50,
      bs: { mean: Math.round(meanBS), std: Math.round(stdBS), cv: +cvBS.toFixed(4) },
      none: { mean: Math.round(meanNone), std: Math.round(stdNone), cv: +cvNone.toFixed(4) },
    },
    oos: {
      train: { trades: sTrain.totalTrades, totalPnl: Math.round(sTrain.totalPnl), winRate: +sTrain.winRate.toFixed(4), maxDrawdown: +sTrain.maxDrawdown.toFixed(4) },
      test: { trades: sOos.totalTrades, totalPnl: Math.round(sOos.totalPnl), winRate: +sOos.winRate.toFixed(4), maxDrawdown: +sOos.maxDrawdown.toFixed(4) },
      keepRatio: +keepRatio.toFixed(4),
    },
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(audit, null, 2));
  console.log(`\n审计结果已保存: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error('审计失败:', e);
  process.exit(1);
});
