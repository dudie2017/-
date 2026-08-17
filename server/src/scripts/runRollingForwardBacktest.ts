/**
 * 方案一：前向滚动验证（v7）
 * 运行：npx tsx src/scripts/runRollingForwardBacktest.ts
 * 输出：src/data/rollingForwardResult.json + 控制台对比
 *
 * 验证目标：
 *   1. 3 组前向滚动：S1→E1 / S2→E2 / S3→E3（学习段传播对 → 评估段验证，无前视偏差）
 *   2. 3 档同向率对比：0.68 / 0.75 / 0.80 × severity L2
 *   3. 板块命中率：评估段实际触发的传播对中，leader→follower 同板块占比
 *   4. 按强/弱/不稳健三级标准判定 sr0.75+L2 的滚动稳健性
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null }
interface Shock { code: string; barDate: string; atrMult: number; dir: 'up' | 'down'; dayRetPct: number }
interface PropagPair { leader: string; follower: string; lag: number; sameRate?: number; total?: number; weight?: number; source?: string }
interface EvalResult {
  id: string; period: string; warnings: number; correct: number; accuracy: number; falseAlarmRate: number;
  winTrades: number; loseTrades: number; avgWin: number; avgLose: number; profitFactor: number;
  perTradeAvg: number; returnImprov: number; alertPerYear: number; pairCount: number; years: number;
  maxLoss: number;
}

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
      shocks.push({ code, barDate: bars[i].date, atrMult, dir: ret > 0 ? 'up' : 'down', dayRetPct: ret * 100 });
    }
  }
  return shocks;
}

function severityOf(atrMult: number): number {
  if (atrMult > 6) return 4;
  if (atrMult > 3) return 3;
  if (atrMult > 2) return 2;
  return 1;
}

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

// ============ 板块映射（品种→板块）============
const SECTOR_MAP: Record<string, string> = {
  RB0: '黑色', HC0: '黑色', I0: '黑色', J0: '黑色', JM0: '黑色', SF0: '黑色', SM0: '黑色', WR0: '黑色', SS0: '黑色',
  CU0: '有色', AL0: '有色', ZN0: '有色', PB0: '有色', NI0: '有色', AO0: '有色', BC0: '有色', SI0: '有色', LC0: '有色',
  AU0: '贵金属', AG0: '贵金属',
  SC0: '能源', FU0: '能源', LU0: '能源', BU0: '能源', PG0: '能源', EC0: '能源',
  MA0: '化工', TA0: '化工', EG0: '化工', EB0: '化工', PP0: '化工', V0: '化工', UR0: '化工', SA0: '化工',
  FG0: '化工', RU0: '化工', NR0: '化工', SP0: '化工', PX0: '化工', L0: '化工',
  A0: '农产品', M0: '农产品', Y0: '农产品', RM0: '农产品', OI0: '农产品', P0: '农产品', C0: '农产品',
  AP0: '农产品', CJ0: '农产品', CF0: '农产品', SR0: '农产品', JD0: '农产品', LH0: '农产品', WH0: '农产品', ZC0: '农产品',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融', TF0: '金融', T0: '金融',
};

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

      const lStart = lIdx + 1;
      const lEnd = Math.min(lIdx + window + 1, lb.length);
      let leadCum = 0;
      for (let k = lStart; k < lEnd; k++) leadCum += (lb[k]?.ret ?? 0);
      if (Math.abs(leadCum) < 0.005) continue;

      for (const follower of codes) {
        if (follower === leader) continue;
        const fb = allBars.get(follower);
        if (!fb) continue;
        const fStart = fb.findIndex(b => b.date > sh.barDate);
        if (fStart < 0) continue;
        const fEnd = Math.min(fStart + Math.max(lagLimit, 1) + window, fb.length);

        let follCum = 0;
        for (let k = fStart; k < fEnd; k++) follCum += (fb[k]?.ret ?? 0);
        if (Math.abs(follCum) < 0.008) continue;

        const key = `${leader}->${follower}`;
        if (!pairStats.has(key)) pairStats.set(key, { leader, follower, total: 0, same: 0, lagSum: 0 });
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

// ============ M4 评估（含 maxLoss）============
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
  let maxLoss = 0;

  for (const pair of propagationPairs) {
    const lb = allBars.get(pair.leader);
    const fb = allBars.get(pair.follower);
    if (!lb || !fb) continue;
    const followerShockDates = new Set((allShocks.get(pair.follower) || []).map(s => s.barDate));

    for (const sh of allShocks.get(pair.leader) || []) {
      const lIdx = lb.findIndex(b => b.date === sh.barDate);
      if (lIdx < 0) continue;

      const isWarnLevel = levels === 'all'
        ? sh.atrMult >= threshold
        : levels === 'warn-severe'
          ? sh.atrMult >= threshold + 1
          : sh.atrMult >= threshold + 2;
      if (!isWarnLevel) continue;
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
        if (!hasLaterMove && Math.abs(ret) > 0.003) hasLaterMove = true;
      }

      warnings++;
      const correctDir = (leadDir === 'up' && afterRet > 0) || (leadDir === 'down' && afterRet < 0);
      const hasMove = Math.abs(afterRet) > 0.01;
      const pnl = leadDir === 'up' ? afterRet : -afterRet;
      if (hasLaterMove && correctDir && hasMove) {
        correct++;
        sumWin += pnl * 100;
      } else {
        falseAlarm++;
        sumLose += Math.abs(pnl) * 100;
        if (Math.abs(pnl) * 100 > maxLoss) maxLoss = Math.abs(pnl) * 100;
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
    id, period, warnings, correct, accuracy: accuracy * 100, falseAlarmRate: falseAlarmRate * 100,
    winTrades, loseTrades, avgWin, avgLose, profitFactor, perTradeAvg, returnImprov,
    alertPerYear, pairCount: propagationPairs.length, years, maxLoss,
  };
}

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

function filterShocksByDate(allShocks: Map<string, Shock[]>, start: string, end: string): Map<string, Shock[]> {
  const out = new Map<string, Shock[]>();
  for (const [code, shocks] of allShocks) {
    out.set(code, shocks.filter(s => s.barDate >= start && s.barDate <= end));
  }
  return out;
}

function summarize(r: EvalResult): string {
  return `预警${r.warnings} 准确率${r.accuracy.toFixed(1)}% PF ${r.profitFactor.toFixed(2)} 每笔${r.perTradeAvg.toFixed(3)}% 均盈${r.avgWin.toFixed(2)}% 均亏${r.avgLose.toFixed(2)}% 最大亏${r.maxLoss.toFixed(1)}% 年预警${r.alertPerYear.toFixed(2)}`;
}

// ============ 板块命中率统计 ============
function sectorHitRate(activePairs: PropagPair[]): { rate: number; total: number; hit: number; pairs: string[] } {
  let hit = 0;
  const pairStrs: string[] = [];
  for (const p of activePairs) {
    const ls = SECTOR_MAP[p.leader];
    const fs = SECTOR_MAP[p.follower];
    if (!ls || !fs) continue;
    const same = ls === fs;
    if (same) hit++;
    pairStrs.push(`${p.leader}->${p.follower}(${ls}${same ? '✓' : '✗'})`);
  }
  return { rate: pairStrs.length > 0 ? hit / pairStrs.length : 0, total: pairStrs.length, hit, pairs: pairStrs };
}

// ============ 主流程 ============
async function main() {
  // 加载全量数据
  const codes = Array.from(new Set(BLACK_SWAN_EVENTS.flatMap(ev => ev.varieties)));
  const allBars = new Map<string, Bar[]>();
  const allShocksRaw = new Map<string, Shock[]>();
  for (const code of codes) {
    const bars = loadVarietyBars(code);
    if (bars.length === 0) continue;
    allBars.set(code, bars);
    allShocksRaw.set(code, detectShocks(bars, code, 1.5));
  }

  const codeCategoryMap = buildCodeCategoryMap();
  const window = 10;
  const threshold = 3;
  const levels: 'all' | 'warn-severe' | 'severe-only' = 'warn-severe';
  const minSeverity = 2;
  // 预警级别对应的最小 ATR 倍数（levels 固定为 warn-severe → threshold+1）
  const minAtrMult = threshold + 1;

  // 3 组前向：S→E
  const stages = [
    { id: 'S1→E1', sStart: '2006-01-01', sEnd: '2010-12-31', eStart: '2011-01-01', eEnd: '2015-12-31', years: 5 },
    { id: 'S2→E2', sStart: '2011-01-01', sEnd: '2015-12-31', eStart: '2016-01-01', eEnd: '2020-12-31', years: 5 },
    { id: 'S3→E3', sStart: '2016-01-01', sEnd: '2020-12-31', eStart: '2021-01-01', eEnd: '2025-12-31', years: 5 },
  ];

  const srValues = [0.68, 0.75, 0.80];

  // 两种模式：无约束（学传播对+静态对） / 板块内约束（仅同板块，不用静态对）
  const grid: any[] = [];
  const sectorConstrained: any[] = [];
  for (const sr of srValues) {
    const row: any = { sr, severity: minSeverity, mode: 'unconstrained', stages: [] };
    const rowSc: any = { sr, severity: minSeverity, mode: 'sector-constrained', stages: [] };
    for (const st of stages) {
      const shocksS = filterShocksByDate(allShocksRaw, st.sStart, st.sEnd);
      const shocksE = filterShocksByDate(allShocksRaw, st.eStart, st.eEnd);

      const learned = learnPropagationPairs(shocksS, allBars, window, 2, threshold, sr, codeCategoryMap);
      // 无约束：学习对 + 静态对
      const merged = mergePairsStandalone(learned, true);
      const res = evaluateM4(merged, allBars, shocksE, window, threshold, levels, minSeverity,
        `sr${sr.toFixed(2)}-${st.id}`, `${st.eStart}~${st.eEnd}`, st.years);
      const activePairs = merged.filter(p => {
        const lb = allBars.get(p.leader);
        if (!lb) return false;
        return (shocksE.get(p.leader) || []).some(sh => sh.atrMult >= minAtrMult);
      });
      const sect = sectorHitRate(activePairs);
      row.stages.push({
        stage: st.id, ...res,
        learnedPairs: learned.length, constrainedPairs: learned.length,
        activePairs: activePairs.length,
        sectorHitRate: sect.rate, sectorTotal: sect.total, sectorHit: sect.hit, sectorPairs: sect.pairs,
      });

      // 板块内约束：只保留同板块
      const constrained = learned.filter(p => SECTOR_MAP[p.leader] && SECTOR_MAP[p.follower] && SECTOR_MAP[p.leader] === SECTOR_MAP[p.follower]);
      const mergedSc = mergePairsStandalone(constrained, false);
      const resSc = evaluateM4(mergedSc, allBars, shocksE, window, threshold, levels, minSeverity,
        `sr${sr.toFixed(2)}-${st.id}-sector`, `${st.eStart}~${st.eEnd}`, st.years);
      const activeSc = mergedSc.filter(p => {
        const lb = allBars.get(p.leader);
        if (!lb) return false;
        return (shocksE.get(p.leader) || []).some(sh => sh.atrMult >= minAtrMult);
      });
      const sectSc = sectorHitRate(activeSc);
      rowSc.stages.push({
        stage: st.id, ...resSc,
        learnedPairs: learned.length, constrainedPairs: constrained.length,
        activePairs: activeSc.length,
        sectorHitRate: sectSc.rate, sectorTotal: sectSc.total, sectorHit: sectSc.hit, sectorPairs: sectSc.pairs,
      });
    }
    grid.push(row);
    sectorConstrained.push(rowSc);
  }

  // 三级判定辅助
  function classify(st: any): string {
    if (st.profitFactor > 1.5 && st.perTradeAvg > 0.5) return '强稳健';
    if (st.profitFactor > 1.0 || st.perTradeAvg > 0.1) return '弱稳健';
    return '不稳健';
  }
  function verdictOf(rows: any[]) {
    return rows.map(row => {
      const cls = row.stages.map(classify);
      const strong = cls.filter((c: string) => c === '强稳健').length;
      const fail = cls.filter((c: string) => c === '不稳健').length;
      const v = strong === cls.length ? '强稳健' : (strong >= 2 && fail === 0) ? '弱稳健' : '不稳健';
      return { sr: row.sr, mode: row.mode, strong: cls.filter((c: string) => c === '强稳健').length, weak: cls.filter((c: string) => c === '弱稳健').length, fail, verdict: v, cls };
    });
  }

  // 输出控制台
  console.log('='.repeat(100));
  console.log('方案一：前向滚动验证（3组前向 × 3档同向率 × L2，含板块命中率）');
  console.log('='.repeat(100));
  for (const row of grid) {
    console.log(`\n### sr=${row.sr.toFixed(2)} + L2（无约束）`);
    for (const st of row.stages) {
      console.log(`  [${st.stage}] ${summarize(st)} | 学习对${st.learnedPairs} 活跃对${st.activePairs} 板块命中率${(st.sectorHitRate * 100).toFixed(0)}%`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('【变体】板块内约束（仅同板块传播对，不用静态对）');
  console.log('='.repeat(100));
  for (const row of sectorConstrained) {
    console.log(`\n### sr=${row.sr.toFixed(2)} + L2 + 板块内约束`);
    for (const st of row.stages) {
      console.log(`  [${st.stage}] ${summarize(st)} | 学习对${st.learnedPairs} 约束后${st.constrainedPairs} 活跃对${st.activePairs} 板块命中率${(st.sectorHitRate * 100).toFixed(0)}%`);
    }
  }

  // 三级判定
  console.log('\n' + '='.repeat(100));
  console.log('三级稳健性判定汇总');
  console.log('='.repeat(100));
  const gv = verdictOf(grid);
  for (const v of gv) {
    console.log(`  [${v.mode}] sr${v.sr.toFixed(2)}: 强${v.strong} / 弱${v.weak} / 不稳健${v.fail} → ${v.verdict}`);
  }
  const sv = verdictOf(sectorConstrained);
  for (const v of sv) {
    console.log(`  [${v.mode}] sr${v.sr.toFixed(2)}: 强${v.strong} / 弱${v.weak} / 不稳健${v.fail} → ${v.verdict}`);
  }

  // 板块命中率汇总（sr0.75 无约束）
  const row75 = grid.find(r => r.sr === 0.75)!;
  console.log('\n板块命中率明细（sr0.75+L2 无约束，评估段活跃传播对）:');
  for (const st of row75.stages) {
    console.log(`  [${st.stage}] 板块内命中 ${st.sectorHit}/${st.sectorTotal} = ${(st.sectorHitRate * 100).toFixed(0)}%`);
    if (st.sectorPairs.length) console.log(`    ${st.sectorPairs.join('  ')}`);
  }

  // 保存结果
  const outPath = join(__dirname, '../data/rollingForwardResult.json');
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), verdict: gv, sectorVerdict: sv, grid, sectorConstrained }, null, 2));
  console.log(`\n已保存: ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(1); });
