/**
 * 事件严重程度分级分析
 * 
 * 将 ATR 冲击按严重程度分为 4 级：
 * - L1 小冲击 (1-2×ATR): 日常波动
 * - L2 中冲击 (2-3×ATR): 显著异动
 * - L3 大冲击 (3-6×ATR): 重大事件
 * - L4 极端冲击 (>6×ATR): 黑天鹅级别
 * 
 * 对每级分别计算冲击后收益、延续率、反直觉率，
 * 回答核心问题："多严重的冲击才值得改变策略？"
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, '../../data-cache-daily-20y');

// ============ Types ============

interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number;
}

interface Shock {
  date: string;
  idx: number;
  atr: number;
  bigMove: number;
  atrMult: number;
  gap: number;
  volRatio: number;
  direction: 'up' | 'down';
  severity: 1 | 2 | 3 | 4;
  hasEvent: boolean;
  eventCategory?: number;
}

interface SeverityStats {
  count: number;
  avgAtrMult: number;
  after1d: number;
  after3d: number;
  after5d: number;
  after10d: number;
  after20d: number;
  continuationRate: number;
  contrarianRate: number;
  maxAdverse10d: number;
}

interface VarietyResult {
  code: string;
  sector: string;
  totalBars: number;
  totalShocks: number;
  severityLevels: {
    L1: SeverityStats;
    L2: SeverityStats;
    L3: SeverityStats;
    L4: SeverityStats;
  };
  // Event-matched shocks only
  eventShocks: {
    total: number;
    bySeverity: {
      L1: SeverityStats;
      L2: SeverityStats;
      L3: SeverityStats;
      L4: SeverityStats;
    };
  };
}

// ============ Helpers ============

function computeATR(bars: DailyBar[], period: number = 14): number[] {
  const atrs: number[] = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    if (i < period) {
      atrs[i] = tr;
    } else if (i === period) {
      let sum = tr;
      for (let j = 1; j < period; j++) {
        sum += Math.max(
          bars[j].h - bars[j].l,
          Math.abs(bars[j].h - bars[j - 1].c),
          Math.abs(bars[j].l - bars[j - 1].c),
        );
      }
      atrs[i] = sum / period;
    } else {
      atrs[i] = (atrs[i - 1] * (period - 1) + tr) / period;
    }
  }
  return atrs;
}

function computeVolMA(bars: DailyBar[], period: number = 20): number[] {
  const ma: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - period + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j <= i; j++) {
      sum += bars[j].vol;
      count++;
    }
    ma[i] = count > 0 ? sum / count : 0;
  }
  return ma;
}

function detectShocks(bars: DailyBar[], atrs: number[], volMA: number[]): Shock[] {
  const shocks: Shock[] = [];
  for (let i = 1; i < bars.length; i++) {
    const atr = atrs[i - 1];
    if (atr <= 0) continue;

    const body = Math.abs(bars[i].c - bars[i].o);
    const range = bars[i].h - bars[i].l;
    const bigMove = Math.max(body, range);
    const atrMult = bigMove / atr;

    const gap = bars[i].o > 0
      ? Math.abs(bars[i].o - bars[i - 1].c) / bars[i - 1].c
      : 0;

    const volRatio = volMA[i] > 0 ? bars[i].vol / volMA[i] : 1;

    const isShock = atrMult >= 1.0 || gap >= 0.015 || volRatio >= 3.0;
    if (!isShock) continue;

    const direction: 'up' | 'down' = bars[i].c >= bars[i].o ? 'up' : 'down';

    let severity: 1 | 2 | 3 | 4;
    if (atrMult >= 6) severity = 4;
    else if (atrMult >= 3) severity = 3;
    else if (atrMult >= 2) severity = 2;
    else severity = 1;

    shocks.push({
      date: bars[i].date,
      idx: i,
      atr,
      bigMove,
      atrMult,
      gap,
      volRatio,
      direction,
      severity,
      hasEvent: false,
    });
  }
  return shocks;
}

function matchEvents(shocks: Shock[], bars: DailyBar[], events: typeof BLACK_SWAN_EVENTS, varietyCode: string): void {
  const dateIdx = new Map<string, number>();
  bars.forEach((b, i) => dateIdx.set(b.date, i));

  for (const shock of shocks) {
    const shockIdx = dateIdx.get(shock.date);
    if (shockIdx === undefined) continue;

    for (const evt of events) {
      if (!evt.varieties.includes(varietyCode)) continue;

      const evtIdx = dateIdx.get(evt.date);
      if (evtIdx === undefined) continue;

      if (Math.abs(shockIdx - evtIdx) <= 5) {
        shock.hasEvent = true;
        shock.eventCategory = evt.category;
        break;
      }
    }
  }
}

function computeAfterN(bars: DailyBar[], shockIdx: number, direction: 'up' | 'down', n: number): number {
  if (shockIdx + n >= bars.length) return NaN;
  const entryPrice = bars[shockIdx].c;
  if (entryPrice <= 0) return NaN;
  const exitPrice = bars[shockIdx + n].c;
  const ret = (exitPrice - entryPrice) / entryPrice;
  return direction === 'up' ? ret : -ret;
}

function computeMaxAdverse(bars: DailyBar[], shockIdx: number, direction: 'up' | 'down', n: number): number {
  if (shockIdx + n >= bars.length) return NaN;
  const entryPrice = bars[shockIdx].c;
  if (entryPrice <= 0) return NaN;
  let maxAdverse = 0;
  for (let i = shockIdx + 1; i <= shockIdx + n; i++) {
    const ret = (bars[i].c - entryPrice) / entryPrice;
    const directionalRet = direction === 'up' ? ret : -ret;
    if (directionalRet < maxAdverse) maxAdverse = directionalRet;
  }
  return maxAdverse;
}

function computeStats(bars: DailyBar[], shocks: Shock[]): SeverityStats {
  const valid = shocks.filter(s => s.idx + 20 < bars.length);
  if (valid.length === 0) {
    return {
      count: 0, avgAtrMult: 0,
      after1d: 0, after3d: 0, after5d: 0, after10d: 0, after20d: 0,
      continuationRate: 0, contrarianRate: 0, maxAdverse10d: 0,
    };
  }

  let sumAtrMult = 0;
  let sum1d = 0, sum3d = 0, sum5d = 0, sum10d = 0, sum20d = 0;
  let count1d = 0, count3d = 0, count5d = 0, count10d = 0, count20d = 0;
  let continuations = 0, contrarians = 0;
  let sumMaxAdverse = 0;
  let countMaxAdverse = 0;

  for (const s of valid) {
    sumAtrMult += s.atrMult;

    const r1 = computeAfterN(bars, s.idx, s.direction, 1);
    if (!isNaN(r1)) { sum1d += r1; count1d++; if (r1 > 0) continuations++; else contrarians++; }

    const r3 = computeAfterN(bars, s.idx, s.direction, 3);
    if (!isNaN(r3)) { sum3d += r3; count3d++; }

    const r5 = computeAfterN(bars, s.idx, s.direction, 5);
    if (!isNaN(r5)) { sum5d += r5; count5d++; }

    const r10 = computeAfterN(bars, s.idx, s.direction, 10);
    if (!isNaN(r10)) { sum10d += r10; count10d++; }

    const r20 = computeAfterN(bars, s.idx, s.direction, 20);
    if (!isNaN(r20)) { sum20d += r20; count20d++; }

    const ma = computeMaxAdverse(bars, s.idx, s.direction, 10);
    if (!isNaN(ma)) { sumMaxAdverse += ma; countMaxAdverse++; }
  }

  const total = count1d || 1;
  return {
    count: valid.length,
    avgAtrMult: sumAtrMult / valid.length,
    after1d: (sum1d / (count1d || 1)) * 100,
    after3d: (sum3d / (count3d || 1)) * 100,
    after5d: (sum5d / (count5d || 1)) * 100,
    after10d: (sum10d / (count10d || 1)) * 100,
    after20d: (sum20d / (count20d || 1)) * 100,
    continuationRate: (continuations / total) * 100,
    contrarianRate: (contrarians / total) * 100,
    maxAdverse10d: (sumMaxAdverse / (countMaxAdverse || 1)) * 100,
  };
}

function getSector(code: string): string {
  const map: Record<string, string> = {
    AU0: '贵金属', AG0: '贵金属',
    CU0: '有色', AL0: '有色', ZN0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', AO0: '有色', BC0: '有色',
    RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SS0: '黑色系',
    SC0: '能源', FU0: '能源', LU0: '能源', BU0: '能源', PG0: '能源',
    L0: '化工', V0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', SA0: '化工', MA0: '化工', RU0: '化工', NR0: '化工', PX0: '化工',
    M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', P0: '油脂油料', A0: '油脂油料',
    CF0: '软商品', SR0: '软商品', AP0: '软商品', CJ0: '软商品', WH0: '软商品', WR0: '软商品',
    C0: '软商品', JD0: '养殖', LH0: '养殖',
    IF0: '金融', IC0: '金融', IH0: '金融', IM0: '金融', T0: '金融', TF0: '金融',
    SI0: '新兴', CO0: '新兴', LC0: '新兴',
    EU0: '建材', FG0: '建材',
    SP0: '其他',
  };
  return map[code] || '其他';
}

// ============ Main ============

async function main(): Promise<void> {
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json')).sort();
  const results: VarietyResult[] = [];

  // Aggregate stats across all varieties
  const globalSeverity: Record<number, Shock[]> = { 1: [], 2: [], 3: [], 4: [] };
  const globalEventSeverity: Record<number, Shock[]> = { 1: [], 2: [], 3: [], 4: [] };

  for (const file of files) {
    const code = file.replace('.json', '');
    const bars: DailyBar[] = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
    if (bars.length < 100) continue;

    const atrs = computeATR(bars);
    const volMA = computeVolMA(bars);
    const shocks = detectShocks(bars, atrs, volMA);
    matchEvents(shocks, bars, BLACK_SWAN_EVENTS, code);

    // Split by severity
    const bySeverity: Record<number, Shock[]> = { 1: [], 2: [], 3: [], 4: [] };
    const eventBySeverity: Record<number, Shock[]> = { 1: [], 2: [], 3: [], 4: [] };

    for (const s of shocks) {
      bySeverity[s.severity].push(s);
      globalSeverity[s.severity].push(s);
      if (s.hasEvent) {
        eventBySeverity[s.severity].push(s);
        globalEventSeverity[s.severity].push(s);
      }
    }

    const result: VarietyResult = {
      code,
      sector: getSector(code),
      totalBars: bars.length,
      totalShocks: shocks.length,
      severityLevels: {
        L1: computeStats(bars, bySeverity[1]),
        L2: computeStats(bars, bySeverity[2]),
        L3: computeStats(bars, bySeverity[3]),
        L4: computeStats(bars, bySeverity[4]),
      },
      eventShocks: {
        total: shocks.filter(s => s.hasEvent).length,
        bySeverity: {
          L1: computeStats(bars, eventBySeverity[1]),
          L2: computeStats(bars, eventBySeverity[2]),
          L3: computeStats(bars, eventBySeverity[3]),
          L4: computeStats(bars, eventBySeverity[4]),
        },
      },
    };

    results.push(result);
    console.log(`[${code}] ${result.totalShocks} shocks (L1:${bySeverity[1].length} L2:${bySeverity[2].length} L3:${bySeverity[3].length} L4:${bySeverity[4].length}), ${result.eventShocks.total} event-matched`);
  }

  // Global severity stats
  const globalStats: Record<string, SeverityStats> = {};
  for (const level of [1, 2, 3, 4]) {
    const label = `L${level}`;
    // We need bars for global stats - use a dummy approach: compute from all shocks
    // Actually we need to compute from the variety data. Let's aggregate.
    const allShocks = globalSeverity[level];
    const allEventShocks = globalEventSeverity[level];
    
    // For global stats, we need to recompute from each variety's bars
    // Simpler: just aggregate the per-variety stats weighted by count
    let totalCount = 0, sumAtrMult = 0;
    let sum1d = 0, sum3d = 0, sum5d = 0, sum10d = 0, sum20d = 0;
    let sumCont = 0, sumContra = 0, sumAdverse = 0;
    
    for (const r of results) {
      const s = r.severityLevels[label as keyof typeof r.severityLevels];
      if (s.count > 0) {
        totalCount += s.count;
        sumAtrMult += s.avgAtrMult * s.count;
        sum1d += s.after1d * s.count;
        sum3d += s.after3d * s.count;
        sum5d += s.after5d * s.count;
        sum10d += s.after10d * s.count;
        sum20d += s.after20d * s.count;
        sumCont += s.continuationRate * s.count;
        sumContra += s.contrarianRate * s.count;
        sumAdverse += s.maxAdverse10d * s.count;
      }
    }
    
    globalStats[label] = {
      count: allShocks.length,
      avgAtrMult: totalCount > 0 ? sumAtrMult / totalCount : 0,
      after1d: totalCount > 0 ? sum1d / totalCount : 0,
      after3d: totalCount > 0 ? sum3d / totalCount : 0,
      after5d: totalCount > 0 ? sum5d / totalCount : 0,
      after10d: totalCount > 0 ? sum10d / totalCount : 0,
      after20d: totalCount > 0 ? sum20d / totalCount : 0,
      continuationRate: totalCount > 0 ? sumCont / totalCount : 0,
      contrarianRate: totalCount > 0 ? sumContra / totalCount : 0,
      maxAdverse10d: totalCount > 0 ? sumAdverse / totalCount : 0,
    };

    // Event-matched global
    let eTotalCount = 0, eSumAtrMult = 0;
    let eSum1d = 0, eSum3d = 0, eSum5d = 0, eSum10d = 0, eSum20d = 0;
    let eSumCont = 0, eSumContra = 0, eSumAdverse = 0;
    
    for (const r of results) {
      const s = r.eventShocks.bySeverity[label as keyof typeof r.eventShocks.bySeverity];
      if (s.count > 0) {
        eTotalCount += s.count;
        eSumAtrMult += s.avgAtrMult * s.count;
        eSum1d += s.after1d * s.count;
        eSum3d += s.after3d * s.count;
        eSum5d += s.after5d * s.count;
        eSum10d += s.after10d * s.count;
        eSum20d += s.after20d * s.count;
        eSumCont += s.continuationRate * s.count;
        eSumContra += s.contrarianRate * s.count;
        eSumAdverse += s.maxAdverse10d * s.count;
      }
    }
    
    globalStats[`E${label}`] = {
      count: allEventShocks.length,
      avgAtrMult: eTotalCount > 0 ? eSumAtrMult / eTotalCount : 0,
      after1d: eTotalCount > 0 ? eSum1d / eTotalCount : 0,
      after3d: eTotalCount > 0 ? eSum3d / eTotalCount : 0,
      after5d: eTotalCount > 0 ? eSum5d / eTotalCount : 0,
      after10d: eTotalCount > 0 ? eSum10d / eTotalCount : 0,
      after20d: eTotalCount > 0 ? eSum20d / eTotalCount : 0,
      continuationRate: eTotalCount > 0 ? eSumCont / eTotalCount : 0,
      contrarianRate: eTotalCount > 0 ? eSumContra / eTotalCount : 0,
      maxAdverse10d: eTotalCount > 0 ? eSumAdverse / eTotalCount : 0,
    };
  }

  const output = {
    globalStats,
    varieties: results,
  };

  const outDir = path.resolve(__dirname, '../data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'severityClassificationResult.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nDone! ${results.length} varieties, saved to ${outPath}`);
}

main().catch(console.error);
