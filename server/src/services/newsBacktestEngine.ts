/**
 * 新闻/黑天鹅板块全品种回测引擎
 * 基于 20 年日线数据，验证：
 * 1. 异常冲击（黑天鹅代理）后技术位被击穿的概率 —— 技术失效预警
 * 2. 冲击方向与后续走势相反的概率 —— 反直觉/买预期卖事实
 * 3. 共振/背离条件下后续收益差异 —— 新闻面验证价值
 */
import * as fs from 'fs';
import * as path from 'path';

export interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol?: number | null;
  hold?: number | null;
  ret: number | null;
  rollover: boolean;
}

export interface ShockEvent {
  code: string;
  date: string;
  index: number;
  direction: 'up' | 'down';
  reasons: string[];
  ret: number; // 冲击日涨跌幅(%)
  atrPct: number; // 冲击日 ATR 相对幅度(%)
}

export interface AfterStats {
  n: number;
  count: number;
  mean: number; // 平均收益(%)
  median: number; // 中位收益(%)
  winRate: number; // 胜率
  avgMaxDD: number; // 窗口内平均最大回撤(%)
}

export interface ResonanceStats {
  resonanceCount: number;
  resonanceAfter10Mean: number;
  resonanceWinRate: number;
  divergenceCount: number;
  divergenceAfter10Mean: number;
  divergenceWinRate: number;
}

export interface VarietyShockStats {
  code: string;
  totalBars: number;
  shocks: ShockEvent[];
  total: number;
  upCount: number;
  downCount: number;
  after: Record<number, AfterStats>;
  breakdownRate: number; // 技术位击穿率
  contrarianRate10: number; // 10 日反直觉率
  resonance: ResonanceStats;
}

export interface BacktestOptions {
  atrPeriod?: number;
  bigMoveMult?: number; // |ret| > bigMoveMult * atrPct
  gapMult?: number; // 跳空 > gapMult * atrPct
  volMult?: number; // 放量 > volMult * MA20vol
  minInterval?: number; // 冲击最小间隔（根）
  lookback?: number; // 技术位回看窗口（根）
  warmup?: number; // 指标预热根数
  volMaPeriod?: number;
}

const DEFAULT_OPTS: Required<BacktestOptions> = {
  atrPeriod: 14,
  bigMoveMult: 3,
  gapMult: 2,
  volMult: 5,
  minInterval: 5,
  lookback: 20,
  warmup: 60,
  volMaPeriod: 20,
};

/** 计算 ATR 序列，返回每个 bar 的 ATR 值 */
export function computeATR(bars: DailyBar[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) {
      trs.push(b.h - b.l);
      continue;
    }
    const prevC = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
  }
  const atrs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      atrs.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trs[j];
    atrs.push(sum / period);
  }
  return atrs;
}

/** 计算简单均线序列 */
export function computeSMA(values: number[], period: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      out.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

/** 检测异常冲击日 */
export function detectShocks(bars: DailyBar[], code: string, opts: BacktestOptions = {}): ShockEvent[] {
  const o = { ...DEFAULT_OPTS, ...opts };
  const atrs = computeATR(bars, o.atrPeriod);
  const vols = bars.map((b) => (typeof b.vol === 'number' && b.vol > 0 ? b.vol : NaN));
  const volMa = computeSMA(
    vols.map((v) => (isNaN(v) ? 0 : v)),
    o.volMaPeriod
  );

  const shocks: ShockEvent[] = [];
  let lastShockIdx = -999;

  for (let i = o.warmup; i < bars.length; i++) {
    const b = bars[i];
    if (b.rollover) continue; // 跳过换月日
    const atr = atrs[i];
    if (!isFinite(atr) || atr <= 0 || b.c <= 0) continue;
    const atrPct = atr / b.c;
    const prevC = bars[i - 1].c;
    if (prevC <= 0) continue;

    const reasons: string[] = [];
    // 1. 大幅波动
    if (b.ret !== null && Math.abs(b.ret) > o.bigMoveMult * atrPct) {
      reasons.push('bigMove');
    }
    // 2. 跳空
    const gap = (b.o - prevC) / prevC;
    if (Math.abs(gap) > o.gapMult * atrPct && b.ret !== null && Math.abs(b.ret) > 1.5 * atrPct) {
      reasons.push('gap');
    }
    // 3. 放量异动
    const vma = volMa[i];
    const vol = vols[i];
    if (!isNaN(vol) && !isNaN(vma) && vma > 0 && vol > o.volMult * vma && b.ret !== null && Math.abs(b.ret) > 2 * atrPct) {
      reasons.push('volume');
    }

    if (reasons.length === 0) continue;
    if (i - lastShockIdx < o.minInterval) continue; // 冲击最小间隔，避免重复计数

    lastShockIdx = i;
    shocks.push({
      code,
      date: b.date,
      index: i,
      direction: b.ret !== null && b.ret >= 0 ? 'up' : 'down',
      reasons,
      ret: (b.ret ?? 0) * 100,
      atrPct: atrPct * 100,
    });
  }
  return shocks;
}

/** 计算单个冲击后 N 日统计 */
export function computeAfterStats(bars: DailyBar[], shockIndex: number, n: number): AfterStats {
  const i = shockIndex;
  const baseClose = bars[i].c;
  const end = Math.min(i + n, bars.length - 1);
  if (end <= i) return { n, count: 0, mean: 0, median: 0, winRate: 0, avgMaxDD: 0 };

  const retPct = (bars[end].c / baseClose - 1) * 100;

  let minLow = Infinity;
  for (let j = i + 1; j <= end; j++) minLow = Math.min(minLow, bars[j].l);
  const maxDD = minLow < Infinity ? (minLow / baseClose - 1) * 100 : 0;

  return {
    n,
    count: 1,
    mean: retPct,
    median: retPct,
    winRate: retPct > 0 ? 1 : 0,
    avgMaxDD: maxDD,
  };
}

/** 聚合多个冲击的统计 */
export function aggregateAfter(all: AfterStats[], n: number): AfterStats {
  if (all.length === 0) return { n, count: 0, mean: 0, median: 0, winRate: 0, avgMaxDD: 0 };
  const rets = all.map((a) => a.mean).sort((x, y) => x - y);
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const median = rets.length % 2 === 1 ? rets[(rets.length - 1) / 2] : (rets[rets.length / 2 - 1] + rets[rets.length / 2]) / 2;
  const winRate = rets.filter((r) => r > 0).length / rets.length;
  const avgMaxDD = all.reduce((s, a) => s + a.avgMaxDD, 0) / all.length;
  return { n, count: rets.length, mean, median, winRate, avgMaxDD };
}

/** 单品种完整分析 */
export function analyzeVariety(code: string, bars: DailyBar[], opts: BacktestOptions = {}): VarietyShockStats {
  const o = { ...DEFAULT_OPTS, ...opts };
  const shocks = detectShocks(bars, code, o);

  const after: Record<number, AfterStats> = {};
  for (const n of [3, 5, 10, 20]) {
    const list = shocks.map((s) => computeAfterStats(bars, s.index, n));
    after[n] = aggregateAfter(list, n);
  }

  // 技术位击穿率 + 反直觉率 + 共振背离
  let breakdown = 0;
  let contrarian = 0;
  const resonanceAfter10: number[] = [];
  const divergenceAfter10: number[] = [];

  for (const s of shocks) {
    const i = s.index;
    if (i < o.lookback) continue;
    // 冲击前 lookback 根支撑/阻力
    let support = Infinity;
    let resistance = -Infinity;
    for (let j = i - o.lookback; j < i; j++) {
      support = Math.min(support, bars[j].l);
      resistance = Math.max(resistance, bars[j].h);
    }
    const end10 = Math.min(i + 10, bars.length - 1);

    // 技术位击穿：向上冲击后跌破支撑 / 向下冲击后涨破阻力
    let hit = false;
    for (let j = i + 1; j <= end10; j++) {
      if (s.direction === 'up' && bars[j].c < support) {
        hit = true;
        break;
      }
      if (s.direction === 'down' && bars[j].c > resistance) {
        hit = true;
        break;
      }
    }
    if (hit) breakdown++;

    // 反直觉：冲击方向 vs 10 日走势
    if (end10 > i) {
      const after10 = (bars[end10].c / bars[i].c - 1) * 100;
      if ((s.direction === 'up' && after10 < 0) || (s.direction === 'down' && after10 > 0)) {
        contrarian++;
      }
      // 技术方向（冲击前 20 根收盘变化方向）
      const techUp = bars[i].c >= bars[i - o.lookback].c;
      const sameDir = (s.direction === 'up' && techUp) || (s.direction === 'down' && !techUp);
      if (sameDir) resonanceAfter10.push(after10);
      else divergenceAfter10.push(after10);
    }
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
  const winR = (arr: number[]) => (arr.length ? arr.filter((x) => x > 0).length / arr.length : 0);

  return {
    code,
    totalBars: bars.length,
    shocks,
    total: shocks.length,
    upCount: shocks.filter((s) => s.direction === 'up').length,
    downCount: shocks.filter((s) => s.direction === 'down').length,
    after,
    breakdownRate: shocks.length ? breakdown / shocks.length : 0,
    contrarianRate10: shocks.length ? contrarian / shocks.length : 0,
    resonance: {
      resonanceCount: resonanceAfter10.length,
      resonanceAfter10Mean: avg(resonanceAfter10),
      resonanceWinRate: winR(resonanceAfter10),
      divergenceCount: divergenceAfter10.length,
      divergenceAfter10Mean: avg(divergenceAfter10),
      divergenceWinRate: winR(divergenceAfter10),
    },
  };
}

/** 加载数据缓存 */
export function loadVarietyBars(code: string, dataDir = 'data-cache-daily-20y'): DailyBar[] {
  const fp = path.join(dataDir, `${code}.json`);
  if (!fs.existsSync(fp)) throw new Error(`数据文件不存在: ${fp}`);
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as DailyBar[];
  return raw;
}

/** 获取全部品种代码（按缓存目录） */
export function listVarietyCodes(dataDir = 'data-cache-daily-20y'): string[] {
  if (!fs.existsSync(dataDir)) return [];
  return fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', '')).sort();
}
