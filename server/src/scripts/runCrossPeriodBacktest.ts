/**
 * 跨周期稳健性验证：sr0.68+L4 最优方案在 2006-2016 / 2016-2026 两段的表现
 * 运行：npx tsx src/scripts/runCrossPeriodBacktest.ts
 * 输出：src/data/crossPeriodResult.json + 控制台对比
 *
 * 验证目标：
 *   1. 独立分段：每段各自学习传播对并评估（检验方案普适性）
 *   2. 前向验证：P1 学习传播对 → P2 评估（检验传播对跨周期持续性，无前视偏差）
 *   3. 反向验证：P2 学习传播对 → P1 评估（对称性检验）
 *   4. 全周期对照：20 年合并（基线）
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null }

const CACHE_DIR = join(__dirname, '../../data-cache-daily-20y');

function loadVarietyBars(code: string): Bar[] {
  const fp = join(CACHE_DIR, `${code}.json`);
  if (!existsSync(fp)) return [];
  return JSON.parse(readFileSync(fp, 'utf8'));
}

function computeATR(bars: Bar[], i: number, period = 14): number {
  if (i < period) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const prev = bars[k - 1]?.c ?? bars[k].o;
    const tr = Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - prev), Math.abs(bars[k].l - prev));
    sum += tr;
  }
  return sum / period;
}

// ============ 冲击检测 ============
interface Shock { code: string; barDate: string; atrMult: number; dir: 'up' | 'down'; dayRetPct: number }

function detectShocks(bars: Bar[], code: string, threshold: number): Shock[] {
  const shocks: Shock[] = [];
  const atrVals: number[] = [];
  const retVals: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    atrVals.push(computeATR(bars, i));
    retVals.push(bars[i].ret ?? 0);
  }
  for (let i = 1; i < bars.length; i++) {
    const atr = atrVals[i];
    if (atr <= 0) continue;
    const ret = retVals[i];
    const atrMult = Math.abs(ret) / (atr / bars[i - 1].c);
    if (atrMult >= threshold) {
      shocks.push({
        code,
        barDate: bars[i].date,
        atrMult,
        dir: ret > 0 ? 'up' : 'down',
        dayRetPct: ret * 100,
      });
    }
  }
  return shocks;
}

// ============ 严重度工具 ============
// L1: 1-2×ATR, L2: 2-3×ATR, L3: 3-6×ATR, L4: >6×ATR
function severityOf(atrMult: number): number {
  if (atrMult > 6) return 4;
  if (atrMult > 3) return 3;
  if (atrMult > 2) return 2;
  return 1;
}

// ============ 事件类别工具 ============
function buildCodeCategoryMap(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const ev of BLACK_SWAN_EVENTS) {
    for (const code of ev.varieties) {
      if (!map.has(code)) map.set(code, new Set());
      map.get(code)!.add(ev.categoryName);
    }
  }
  return map;
}

// ============ 传播对学习（同向率约束）============
interface PropagPair { leader: string; follower: string; lag: number; sameRate?: number; total?: number; weight?: number; source?: string }

function learnPropagationPairs(
  allShocks: Map<string, Shock[]>,
  allBars: Map<string, Bar[]>,
  window: number,
  lagLimit: number,
  threshold: number,
  sameRateMin: number,
  codeCategoryMap: Map<string, Set<string>>,
): PropagPair[] {
  const pairStats = new Map<string, { leader: string; follower: string; total: number; same: number; lagSum: number }>();

  const codes = Array.from(allBars.keys());
  const minThreshold = Math.max(2, threshold - 1);

  for (const leader of codes) {
    const shocks = allShocks.get(leader) || [];
    if (shocks.length === 0) continue;
    const lb = allBars.get(leader);
    if (!lb) continue;

    for (const sh of shocks) {
      if (sh.atrMult < minThreshold) continue;
      const lIdx = lb.findIndex(b => b.date === sh.barDate);
      if (lIdx < 0) continue;

      // leader 冲击后窗口累计收益方向
      const lStart = lIdx + 1;
      const lEnd = Math.min(lIdx + window + 1, lb.length);
      let leadCum = 0;
      for (let k = lStart; k < lEnd; k++) leadCum += (lb[k]?.ret ?? 0);
      if (Math.abs(leadCum) < 0.005) continue;

      for (const follower of codes) {
        if (follower === leader) continue;
        const fb = allBars.get(follower);
        if (!fb) continue;
        const leadDate = sh.barDate;
        const fStart = fb.findIndex(b => b.date > leadDate);
        if (fStart < 0) continue;
        const fEnd = Math.min(fStart + Math.max(lagLimit, 1) + window, fb.length);

        let follCum = 0;
        for (let k = fStart; k < fEnd; k++) follCum += (fb[k]?.ret ?? 0);
        if (Math.abs(follCum) < 0.008) continue;

        const key = `${leader}->${follower}`;
        if (!pairStats.has(key)) {
          pairStats.set(key, { leader, follower, total: 0, same: 0, lagSum: 0 });
        }
        const stat = pairStats.get(key)!;
        stat.total++;
        let firstMoveIdx = -1;
        for (let k = fStart; k < fEnd; k++) {
          if (Math.abs(fb[k]?.ret ?? 0) > 0.003) { firstMoveIdx = k; break; }
        }
        if (firstMoveIdx >= 0) stat.lagSum += (firstMoveIdx - fStart);
        if ((leadCum > 0 && follCum > 0) || (leadCum < 0 && follCum < 0)) stat.same++;
      }
    }
  }

  // 过滤传播对
  const result: PropagPair[] = [];
  const sorted = [...pairStats.values()].sort((a, b) => b.total - a.total);
  for (const stat of sorted) {
    const sameRate = stat.total > 0 ? stat.same / stat.total : 0;
    if (stat.total < 2) continue;
    if (sameRate < sameRateMin) continue;
    result.push({
      leader: stat.leader,
      follower: stat.follower,
      lag: Math.max(1, Math.round(stat.lagSum / stat.total)),
      sameRate,
      total: stat.total,
    });
    if (result.length >= 30) break;
  }
  return result;
}

// ============ M4 评估 ============
interface EvalResult {
  id: string;
  period: string;
  warnings: number;
  correct: number;
  accuracy: number;
  falseAlarmRate: number;
  winTrades: number;
  loseTrades: number;
  avgWin: number;
  avgLose: number;
  profitFactor: number;
  perTradeAvg: number;
  returnImprov: number;
  alertPerYear: number;
  pairCount: number;
  years: number;
}

function evaluateM4(
  propagationPairs: PropagPair[],
  allBars: Map<string, Bar[]>,
  allShocks: Map<string, Shock[]>,
  window: number,
  threshold: number,
  levels: 'all' | 'warn-severe' | 'severe-only',
  minSeverity: number,
  id: string,
  period: string,
  years: number,
): EvalResult {
  let warnings = 0;
  let correct = 0;
  let falseAlarm = 0;
  let sumWin = 0;
  let sumLose = 0;

  for (const pair of propagationPairs) {
    const lb = allBars.get(pair.leader);
    const fb = allBars.get(pair.follower);
    if (!lb || !fb) continue;
    const followerShockDates = new Set((allShocks.get(pair.follower) || []).map(s => s.barDate));

    for (const sh of allShocks.get(pair.leader) || []) {
      const lIdx = lb.findIndex(b => b.date === sh.barDate);
      if (lIdx < 0) continue;

      // 预警级别过滤
      const isWarnLevel = levels === 'all'
        ? sh.atrMult >= threshold
        : levels === 'warn-severe'
          ? sh.atrMult >= threshold + 1
          : sh.atrMult >= threshold + 2;
      if (!isWarnLevel) continue;

      // 严重度过滤
      if (minSeverity > 0 && severityOf(sh.atrMult) < minSeverity) continue;

      const leadDir = sh.dir;
      const leadDate = sh.barDate;
      let fStart = fb.findIndex(b => b.date > leadDate);
      if (fStart < 0) continue;
      let afterRet = 0;
      let hasLaterMove = false;
      const maxLook = Math.min(fStart + Math.max(pair.lag, 1) + window, fb.length);
      for (let k = fStart; k < maxLook; k++) {
        const ret = fb[k]?.ret ?? 0;
        afterRet += ret;
        const fbDate = fb[k]?.date || '';
        if (followerShockDates.has(fbDate)) continue;
        if (!hasLaterMove && Math.abs(ret) > 0.003) {
          hasLaterMove = true;
        }
      }

      warnings++;
      const correctDir = (leadDir === 'up' && afterRet > 0) || (leadDir === 'down' && afterRet < 0);
      const hasMove = Math.abs(afterRet) > 0.01;
      // 跟随方向交易：leadDir up 做多 follower，leadDir down 做空 follower
      const pnl = leadDir === 'up' ? afterRet : -afterRet;
      if (hasLaterMove && correctDir && hasMove) {
        correct++;
        sumWin += pnl * 100;
      } else {
        falseAlarm++;
        sumLose += Math.abs(pnl) * 100;
      }
    }
  }

  const accuracy = warnings > 0 ? correct / warnings : 0;
  const falseAlarmRate = warnings > 0 ? falseAlarm / warnings : 0;
  const winTrades = correct;
  const loseTrades = falseAlarm;
  const avgWin = winTrades > 0 ? sumWin / winTrades : 0;
  const avgLose = loseTrades > 0 ? sumLose / loseTrades : 0;
  const profitFactor = sumLose > 0 ? sumWin / sumLose : (sumWin > 0 ? 999 : 0);
  const returnImprov = sumWin - sumLose;
  const perTradeAvg = warnings > 0 ? returnImprov / warnings : 0;
  const alertPerYear = warnings / (years * 60);

  return {
    id,
    period,
    warnings,
    correct,
    accuracy: accuracy * 100,
    falseAlarmRate: falseAlarmRate * 100,
    winTrades,
    loseTrades,
    avgWin,
    avgLose,
    profitFactor,
    perTradeAvg,
    returnImprov,
    alertPerYear,
    pairCount: propagationPairs.length,
    years,
  };
}

// 独立 mergePairs（含静态高置信度传播对）
function mergePairsStandalone(dynamic: PropagPair[], useStatic: boolean): PropagPair[] {
  const seen = new Set<string>();
  const merged: PropagPair[] = [];
  const staticPairs: PropagPair[] = [
    { leader: 'AU0', follower: 'AG0', lag: 1, weight: 0.95, source: 'static' },
    { leader: 'SC0', follower: 'FU0', lag: 1, weight: 0.8, source: 'static' },
    { leader: 'SC0', follower: 'BU0', lag: 1, weight: 0.7, source: 'static' },
    { leader: 'I0', follower: 'RB0', lag: 1, weight: 0.85, source: 'static' },
    { leader: 'RB0', follower: 'HC0', lag: 1, weight: 0.9, source: 'static' },
    { leader: 'CU0', follower: 'AL0', lag: 1, weight: 0.8, source: 'static' },
    { leader: 'AL0', follower: 'ZN0', lag: 1, weight: 0.75, source: 'static' },
  ];
  for (const p of [...dynamic, ...(useStatic ? staticPairs : [])]) {
    const key = `${p.leader}->${p.follower}`;
    if (!seen.has(key)) { seen.add(key); merged.push(p); }
  }
  return merged;
}

// 按日期切分 shocks：只保留区间内的冲击
function filterShocksByDate(allShocks: Map<string, Shock[]>, start: string, end: string): Map<string, Shock[]> {
  const out = new Map<string, Shock[]>();
  for (const [code, shocks] of allShocks) {
    out.set(code, shocks.filter(s => s.barDate >= start && s.barDate <= end));
  }
  return out;
}

// ============ 主流程 ============
async function main() {
  console.log('加载数据...');
  const codes = BLACK_SWAN_EVENTS.reduce<string[]>((acc, ev) => {
    for (const c of ev.varieties) if (!acc.includes(c)) acc.push(c);
    return acc;
  }, []);

  const allBars = new Map<string, Bar[]>();
  const allShocks = new Map<string, Shock[]>();
  for (const code of codes) {
    const bars = loadVarietyBars(code);
    if (bars.length > 0) {
      allBars.set(code, bars);
      allShocks.set(code, detectShocks(bars, code, 1.5));
    }
  }
  console.log(`有数据品种: ${allBars.size}, 冲击总数: ${[...allShocks.values()].reduce((a, s) => a + s.length, 0)}`);

  const codeCategoryMap = buildCodeCategoryMap();

  // 基础参数（保持固定）
  const window = 10;
  const threshold = 3;
  const levels: 'all' | 'warn-severe' | 'severe-only' = 'warn-severe';
  const lagLimit = 2;

  // 最近 20 年分段：P1 = 2006-01-01 ~ 2015-12-31，P2 = 2016-01-01 ~ 2026-08-07
  const P1_START = '2006-01-01';
  const P1_END = '2015-12-31';
  const P2_START = '2016-01-01';
  const P2_END = '2026-12-31';
  const years1 = 10;
  const years2 = 10.6;

  const shocksP1 = filterShocksByDate(allShocks, P1_START, P1_END);
  const shocksP2 = filterShocksByDate(allShocks, P2_START, P2_END);
  const shocksAll = filterShocksByDate(allShocks, P1_START, P2_END);

  // ============ 参数网格扫描：同向率 × 严重度 ============
  const srValues = [0.55, 0.60, 0.65, 0.68, 0.70, 0.75];
  const sevValues = [2, 3, 4]; // L2 / L3 / L4

  interface GridRow {
    sr: number;
    sev: number;
    p1: EvalResult;
    p2: EvalResult;
    fwd: EvalResult;
    bwd: EvalResult;
    all: EvalResult;
    overlap: number;
    p1Count: number;
    p2Count: number;
  }
  const grid: GridRow[] = [];

  for (const sr of srValues) {
    for (const sev of sevValues) {
      const pairsP1 = learnPropagationPairs(shocksP1, allBars, window, lagLimit, threshold, sr, codeCategoryMap);
      const pairsP2 = learnPropagationPairs(shocksP2, allBars, window, lagLimit, threshold, sr, codeCategoryMap);
      const pairsAll = learnPropagationPairs(shocksAll, allBars, window, lagLimit, threshold, sr, codeCategoryMap);

      const key = `sr${sr}|L${sev}`;
      const rP1 = evaluateM4(mergePairsStandalone(pairsP1, true), allBars, shocksP1, window, threshold, levels, sev, `${key}-P1`, 'P1独立', years1);
      const rP2 = evaluateM4(mergePairsStandalone(pairsP2, true), allBars, shocksP2, window, threshold, levels, sev, `${key}-P2`, 'P2独立', years2);
      const rFwd = evaluateM4(mergePairsStandalone(pairsP1, true), allBars, shocksP2, window, threshold, levels, sev, `${key}-Fwd`, '前向', years2);
      const rBwd = evaluateM4(mergePairsStandalone(pairsP2, true), allBars, shocksP1, window, threshold, levels, sev, `${key}-Bwd`, '反向', years1);
      const rAll = evaluateM4(mergePairsStandalone(pairsAll, true), allBars, shocksAll, window, threshold, levels, sev, `${key}-All`, '全周期', 20.6);

      const keyP1 = new Set(pairsP1.map(p => `${p.leader}->${p.follower}`));
      const keyP2 = new Set(pairsP2.map(p => `${p.leader}->${p.follower}`));
      const overlap = [...keyP1].filter(k => keyP2.has(k)).length;

      grid.push({ sr, sev, p1: rP1, p2: rP2, fwd: rFwd, bwd: rBwd, all: rAll, overlap, p1Count: keyP1.size, p2Count: keyP2.size });
    }
  }

  // ---------- 网格总览 ----------
  console.log('\n=== 参数网格扫描：跨周期稳健性 ===');
  console.log('同向率 | 严重度 | P1盈亏比 | P2盈亏比 | 前向盈亏比 | 反向盈亏比 | 全周期盈亏比 | P1预警 | P2预警 | 传播对重叠');
  for (const g of grid) {
    console.log(
      `${String(g.sr).padStart(4)}  |  L${g.sev}    | ${g.p1.profitFactor.toFixed(2).padStart(6)}   | ${g.p2.profitFactor.toFixed(2).padStart(6)}   | ${g.fwd.profitFactor.toFixed(2).padStart(6)}     | ${g.bwd.profitFactor.toFixed(2).padStart(6)}     | ${g.all.profitFactor.toFixed(2).padStart(7)}    | ${String(g.p1.warnings).padStart(5)}  | ${String(g.p2.warnings).padStart(5)}  | ${g.overlap}`
    );
  }

  // ---------- 稳健性筛选：P1独立 + P2独立 + 前向 三者均正期望 ----------
  console.log('\n=== 稳健参数域筛选（P1独立 + P2独立 + 前向 均盈亏比>1）===');
  const stableGrid = grid.filter(g => g.p1.profitFactor > 1 && g.p2.profitFactor > 1 && g.fwd.profitFactor > 1);
  if (stableGrid.length === 0) {
    console.log('❌ 无任何参数组合通过稳健性检验 — 传播链方案整体存在过拟合风险');
  } else {
    for (const g of stableGrid) {
      console.log(
        `✅ sr${g.sr} + L${g.sev} | P1 PF ${g.p1.profitFactor.toFixed(2)} | P2 PF ${g.p2.profitFactor.toFixed(2)} | 前向 PF ${g.fwd.profitFactor.toFixed(2)} | 全周期 PF ${g.all.profitFactor.toFixed(2)} | P1每笔 ${g.p1.perTradeAvg.toFixed(3)}% | P2每笔 ${g.p2.perTradeAvg.toFixed(3)}%`
      );
    }
  }

  // ---------- 传播对跨周期重叠（稳健组合）----------
  console.log('\n=== 传播对跨周期重叠（sr0.68 L4 对照）===');
  const pairsP1b = learnPropagationPairs(shocksP1, allBars, window, lagLimit, threshold, 0.68, codeCategoryMap);
  const pairsP2b = learnPropagationPairs(shocksP2, allBars, window, lagLimit, threshold, 0.68, codeCategoryMap);
  const keyP1b = new Set(pairsP1b.map(p => `${p.leader}->${p.follower}`));
  const keyP2b = new Set(pairsP2b.map(p => `${p.leader}->${p.follower}`));
  const overlapB = [...keyP1b].filter(k => keyP2b.has(k));
  console.log(`P1 传播对 ${keyP1b.size} | P2 传播对 ${keyP2b.size} | 重叠 ${overlapB.length} (${(overlapB.length / Math.max(keyP1b.size, 1) * 100).toFixed(0)}%)`);
  for (const k of overlapB.slice(0, 12)) {
    const p1 = pairsP1b.find(p => `${p.leader}->${p.follower}` === k);
    const p2 = pairsP2b.find(p => `${p.leader}->${p.follower}` === k);
    console.log(`  ${k} | P1 同向率 ${((p1?.sameRate ?? 0) * 100).toFixed(0)}% | P2 同向率 ${((p2?.sameRate ?? 0) * 100).toFixed(0)}%`);
  }

  // 保存结果
  const outPath = join(__dirname, '../data/crossPeriodResult.json');
  writeFileSync(outPath, JSON.stringify(grid, null, 2), 'utf8');
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
