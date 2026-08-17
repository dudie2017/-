/**
 * 新闻/黑天鹅 × V16 组合策略矩阵回测
 * 目标：用 20 年日线数据回答 —— 新闻过滤/共振增强/持仓管理对回报率的实际影响
 * 12 个方案：S0(基准) ~ S11(全组合梯度) + S12(事件库驱动对照)
 * 隔离原则：只扩展 runBacktest 的 newsFilter 参数（默认 none），不影响 App 其他结构
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import {
  detectShocks,
  loadVarietyBars,
  computeATR,
} from '../services/newsBacktestEngine';
import type { DailyBar } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const ALL_CODES = fs
  .readdirSync(DATA_DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''))
  .sort();

const START_CAPITAL = 1_000_000;
const MAX_POSITION_PCT = 0.1;

// ============ 1. 预计算冲击数据（价格冲击扫描代理） ============
interface ShockPrecompute {
  bars: DailyBar[];
  shockIndexes: Set<number>;                       // 冲击日 bar 索引
  lastShockDir: Array<'up' | 'down' | null>;       // 每根 bar 最近冲击方向
  shockDates: Set<string>;                         // 冲击日期（供提前平仓）
}

function precomputeShocks(): Map<string, ShockPrecompute> {
  const out = new Map<string, ShockPrecompute>();
  for (const code of ALL_CODES) {
    const bars = loadVarietyBars(code, DATA_DIR);
    const shocks = detectShocks(bars, code);
    const shockIndexes = new Set<number>();
    const shockDates = new Set<string>();
    for (const s of shocks) {
      shockIndexes.add(s.index);
      shockDates.add(s.date);
    }
    // 最近冲击方向（不含冷却窗口，只含"最近一次冲击的方向"）
    const lastShockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
    let lastDir: 'up' | 'down' | null = null;
    for (let i = 0; i < bars.length; i++) {
      if (shockIndexes.has(i)) {
        lastDir = bars[i].ret !== null && bars[i].ret! >= 0 ? 'up' : 'down';
      }
      lastShockDir[i] = lastDir;
    }
    out.set(code, { bars, shockIndexes, lastShockDir, shockDates });
  }
  return out;
}

// ============ 2. 预计算事件库冲击（S12 用） ============
function precomputeEventShocks(): Map<string, Set<number>> {
  // 品种 → 事件日对应的 bar 索引集合（事件月之后第一个交易日）
  const eventIndexes = new Map<string, Set<number>>();
  for (const ev of BLACK_SWAN_EVENTS) {
    for (const code of ev.varieties) {
      const fp = path.join(DATA_DIR, `${code}.json`);
      if (!fs.existsSync(fp)) continue;
      const bars = loadVarietyBars(code, DATA_DIR);
      const idx = bars.findIndex((b) => b.date >= ev.date);
      if (idx < 0) continue;
      if (!eventIndexes.has(code)) eventIndexes.set(code, new Set());
      eventIndexes.get(code)!.add(idx);
    }
  }
  return eventIndexes;
}

// ============ 3. 方案定义 ============
export interface MatrixPlan {
  id: string;
  name: string;
  mode: 'none' | 'riskOff' | 'full';
  cooldown: number;            // 冲击冷却天数
  resonanceBoost: number;      // 共振仓位系数
  divergenceCut: number;       // 背离仓位系数
  exitOnShock: boolean;        // C1 冲击时提前平仓
  minAtrMult?: number;         // 冲击强度门槛（ATR 倍数），null=全部
  useEvents?: boolean;         // 用事件库而非价格冲击
}

export const MATRIX_PLANS: MatrixPlan[] = [
  { id: 'S0',  name: '基准:纯V16',              mode: 'none',    cooldown: 0,  resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false },
  { id: 'S1',  name: '冷却5日',                  mode: 'riskOff', cooldown: 5,  resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false },
  { id: 'S2',  name: '冷却10日',                 mode: 'riskOff', cooldown: 10, resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false },
  { id: 'S3',  name: '冷却20日',                 mode: 'riskOff', cooldown: 20, resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false },
  { id: 'S4',  name: '只躲大雷(>4ATR)冷却10日',  mode: 'riskOff', cooldown: 10, resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false, minAtrMult: 4 },
  { id: 'S5',  name: '只躲极端雷(>6ATR)冷却10日', mode: 'riskOff', cooldown: 10, resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false, minAtrMult: 6 },
  { id: 'S6',  name: '冷却10+共振1.3',          mode: 'full',    cooldown: 10, resonanceBoost: 1.3, divergenceCut: 1,   exitOnShock: false },
  { id: 'S7',  name: '冷却10+背离0.5',          mode: 'full',    cooldown: 10, resonanceBoost: 1,   divergenceCut: 0.5, exitOnShock: false },
  { id: 'S8',  name: '冷却10+共振1.3/背离0.5',   mode: 'full',    cooldown: 10, resonanceBoost: 1.3, divergenceCut: 0.5, exitOnShock: false },
  { id: 'S9',  name: '全组合:冷却10+增强+冲击平仓', mode: 'full', cooldown: 10, resonanceBoost: 1.3, divergenceCut: 0.5, exitOnShock: true },
  { id: 'S10', name: '全组合-只躲大雷(>4ATR)',   mode: 'full',    cooldown: 10, resonanceBoost: 1.3, divergenceCut: 0.5, exitOnShock: true, minAtrMult: 4 },
  { id: 'S11', name: '全组合-只躲极端雷(>6ATR)', mode: 'full',    cooldown: 10, resonanceBoost: 1.3, divergenceCut: 0.5, exitOnShock: true, minAtrMult: 6 },
  { id: 'S12', name: '事件库驱动冷却10日',       mode: 'riskOff', cooldown: 10, resonanceBoost: 1,   divergenceCut: 1,   exitOnShock: false, useEvents: true },
];

// ============ 4. 生成某方案的 newsFilter ============
function buildNewsFilter(
  plan: MatrixPlan,
  shocks: Map<string, ShockPrecompute>,
  eventIndexes: Map<string, Set<number>>
) {
  if (plan.mode === 'none') return undefined;

  const cooldownMap = new Map<string, boolean[]>();
  const shockDirMap = new Map<string, Array<'up' | 'down' | null>>();
  const shockDates = new Map<string, Set<string>>();

  for (const code of ALL_CODES) {
    const pre = shocks.get(code)!;
    const bars = pre.bars;
    // 确定冲击索引集合（价格冲击 or 事件库）
    let shockIdxSet = pre.shockIndexes;
    if (plan.useEvents) {
      shockIdxSet = eventIndexes.get(code) ?? new Set();
    }
    // ATR 门槛过滤
    if (plan.minAtrMult && !plan.useEvents) {
      const atrs = computeATR(bars, 14);
      const filtered = new Set<number>();
      for (const si of shockIdxSet) {
        const atrPct = atrs[si] && bars[si].c > 0 ? atrs[si] / bars[si].c : 0;
        const retAbs = bars[si].ret !== null ? Math.abs(bars[si].ret!) : 0;
        if (atrPct > 0 && retAbs > plan.minAtrMult * atrPct) filtered.add(si);
      }
      shockIdxSet = filtered;
    }
    // 冷却窗口
    const cool = new Array(bars.length).fill(false);
    const dir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
    const dates = new Set<string>();
    let lastDir: 'up' | 'down' | null = null;
    for (let i = 0; i < bars.length; i++) {
      if (shockIdxSet.has(i)) {
        lastDir = bars[i].ret !== null && bars[i].ret! >= 0 ? 'up' : 'down';
        dates.add(bars[i].date);
        if (plan.cooldown > 0) {
          for (let j = i; j < Math.min(i + plan.cooldown, bars.length); j++) cool[j] = true;
        }
      }
      dir[i] = lastDir;
    }
    cooldownMap.set(code, cool);
    shockDirMap.set(code, dir);
    if (plan.exitOnShock) shockDates.set(code, dates);
  }

  return {
    mode: plan.mode,
    cooldownMap,
    shockDirMap,
    shockDates: shockDates.size ? shockDates : undefined,
    resonanceBoost: plan.resonanceBoost,
    divergenceCut: plan.divergenceCut,
  };
}

// ============ 5. 主循环 ============
export interface PlanResultRow {
  id: string;
  name: string;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  winRatePct: number;
  avgRR: number;
  totalTrades: number;
  profitFactor?: number;
}

export function pickResult(r: any): Pick<PlanResultRow, 'totalReturnPct' | 'maxDrawdownPct' | 'sharpeRatio' | 'winRatePct' | 'avgRR' | 'totalTrades'> {
  const s = r.summary ?? r;
  return {
    // totalReturn 为净值倍数（如 23.76 = 2376%）
    totalReturnPct: (s.totalReturn ?? 0) * 100,
    maxDrawdownPct: (s.maxDrawdown ?? 0) * 100,
    sharpeRatio: s.sharpeRatio ?? 0,
    winRatePct: (s.winRate ?? 0) * 100,
    avgRR: s.avgRR ?? 0,
    totalTrades: s.totalTrades ?? 0,
  };
}

export async function runMatrix(plans: MatrixPlan[] = MATRIX_PLANS): Promise<PlanResultRow[]> {
  console.log(`[Matrix] 品种数=${ALL_CODES.length}, 方案数=${plans.length}`);
  console.log('[Matrix] 预计算冲击数据...');
  const shocks = precomputeShocks();
  const eventIndexes = precomputeEventShocks();

  const rows: PlanResultRow[] = [];
  for (const plan of plans) {
    const t0 = Date.now();
    console.log(`[Matrix] 执行 ${plan.id} ${plan.name} ...`);
    const newsFilter = buildNewsFilter(plan, shocks, eventIndexes);
    const result: any = await runBacktest({
      startCapital: START_CAPITAL,
      maxPositionPct: MAX_POSITION_PCT,
      dataDir: DATA_DIR,
      codes: ALL_CODES,
      newsFilter,
    });
    const picked = pickResult(result);
    rows.push({ id: plan.id, name: plan.name, ...picked });
    const sec = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `  [${plan.id}] 回报=${picked.totalReturnPct.toFixed(1)}% 回撤=${picked.maxDrawdownPct.toFixed(1)}% ` +
        `夏普=${picked.sharpeRatio.toFixed(2)} 胜率=${(picked.winRatePct).toFixed(1)}% ` +
        `盈亏比=${picked.avgRR.toFixed(2)} 交易=${picked.totalTrades} (耗时${sec}s)`
    );
  }
  return rows;
}

// ============ 6. 入口 ============
if (import.meta.url === `file://${process.argv[1]}`) {
  const start = Date.now();
  runMatrix()
    .then((rows) => {
      const out = path.join(process.cwd(), 'data/newsV16MatrixResult.json');
      fs.writeFileSync(out, JSON.stringify(rows, null, 2));
      console.log(`\n[Matter] 结果已保存: ${out}`);
      console.log(`[Matrix] 总耗时 ${((Date.now() - start) / 1000).toFixed(0)}s`);
    })
    .catch((e) => {
      console.error('[Matrix] 失败:', e);
      process.exit(1);
    });
}

