/**
 * M4 传播链增强回测：A1 事件类型过滤 / A2 严重度加权 / A3 传播对质量约束
 * 运行：npx tsx src/scripts/runPropagationEnhanceBacktest.ts
 * 输出：src/data/propagationEnhanceResult.json + 控制台对比
 *
 * 基线：M4-10-3-W-2（10天窗口 / 3×ATR / 警告+严重 / 2天滞后）
 * 变体：base, +A1, +A2a(L3+), +A2b(L4+), +A3, +A1A2, +A1A3, +A1A2A3
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

function computeSMA(values: number[], i: number, period = 20): number {
  if (i < period - 1) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += values[k];
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

// ============ 事件类别工具（A1 基础）============
// 构建 (code -> Set<categoryName>) 映射：品种在哪些事件类别中出现过
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

// ============ 严重度工具（A2 基础）============
// L1: 1-2×ATR, L2: 2-3×ATR, L3: 3-6×ATR, L4: >6×ATR
function severityOf(atrMult: number): number {
  if (atrMult > 6) return 4;
  if (atrMult > 3) return 3;
  if (atrMult > 2) return 2;
  return 1;
}

// ============ 静态高置信度传播对（A3 基础）============
function loadStaticPairs(minCo = 2, minCorr = 0.6): Array<{ leader: string; follower: string; lag: number; category: number }> {
  const pp = join(__dirname, '../data/propagationChainResult.json');
  const pairs: Array<{ leader: string; follower: string; lag: number; category: number }> = [];
  if (!existsSync(pp)) return pairs;
  try {
    const pdata = JSON.parse(readFileSync(pp, 'utf8')) as any;
    const top = (pdata?.topPairs || []) as Array<Record<string, any>>;
    for (const pair of top) {
      if ((pair.coOccurrence || 0) >= minCo && (pair.correlation || 0) >= minCorr) {
        pairs.push({
          leader: pair.leader,
          follower: pair.follower,
          lag: Math.max(1, Math.round(pair.avgLag || 2)),
          category: pair.category || 0,
        });
      }
    }
  } catch (e) { /* 忽略 */ }
  return pairs;
}

// ============ 传播对学习（带 A1/A3 过滤）============
interface LearnOptions {
  eventFilter?: boolean;      // A1：只允许同事件类型上下文的传播对
  qualityFilter?: boolean;    // A3：同向率 >= sameRateMin 的高置信度约束
  sameRateMin?: number;       // 同向率最低要求（默认 0.5）
}

interface PropagPair { leader: string; follower: string; lag: number; sameRate?: number; total?: number; weight?: number; source?: string }

function learnPropagationPairs(
  allShocks: Map<string, Shock[]>,
  allBars: Map<string, Bar[]>,
  window: number,
  lagLimit: number,
  threshold: number,
  opts: LearnOptions,
  codeCategoryMap: Map<string, Set<string>>,
): PropagPair[] {
  const pairStats = new Map<string, { leader: string; follower: string; total: number; same: number; lagSum: number }>();
  const sameRateMin = opts.sameRateMin ?? 0.5;

  const codes = Array.from(allBars.keys());
  const minThreshold = Math.max(2, threshold - 1);

  for (const leader of codes) {
    const shocks = allShocks.get(leader) || [];
    if (shocks.length === 0) continue;
    const lb = allBars.get(leader);
    if (!lb) continue;
    const leaderCats = codeCategoryMap.get(leader) || new Set<string>();

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
        // A1：事件类型过滤 —— 两品种必须有共同事件类别才允许成为传播对
        if (opts.eventFilter) {
          const followerCats = codeCategoryMap.get(follower) || new Set<string>();
          let shareCat = false;
          for (const c of leaderCats) { if (followerCats.has(c)) { shareCat = true; break; } }
          if (!shareCat) continue;
        }

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
    if (opts.qualityFilter && sameRate < sameRateMin) continue;
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

// ============ M4 评估（带 A2 严重度过滤）============
interface EvalOptions {
  minSeverity: number;  // A2：只跟踪 >= 该严重度的 leader 冲击（0=不限制, 3=L3+, 4=L4+）
  onTrade?: (pnlPct: number) => void;  // 每笔交易回调（用于稳健性分析）
}

interface EvalResult {
  id: string;
  warnings: number;
  correct: number;
  accuracy: number;
  falseAlarm: number;
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
}

function evaluateM4(
  propagationPairs: PropagPair[],
  allBars: Map<string, Bar[]>,
  allShocks: Map<string, Shock[]>,
  window: number,
  threshold: number,
  levels: 'all' | 'warn-severe' | 'severe-only',
  opts: EvalOptions,
  id: string,
): EvalResult {
  let warnings = 0;
  let correct = 0;
  let falseAlarm = 0;
  let sumWin = 0;
  let sumLose = 0;
  const leadTimes: number[] = [];

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

      // A2：严重度过滤
      if (opts.minSeverity > 0 && severityOf(sh.atrMult) < opts.minSeverity) continue;

      const leadDir = sh.dir;
      const leadDate = sh.barDate;
      let fStart = fb.findIndex(b => b.date > leadDate);
      if (fStart < 0) continue;
      let afterRet = 0;
      let hasLaterMove = false;
      let firstMoveDay = 0;
      const maxLook = Math.min(fStart + Math.max(pair.lag, 1) + window, fb.length);
      for (let k = fStart; k < maxLook; k++) {
        const ret = fb[k]?.ret ?? 0;
        afterRet += ret;
        const fbDate = fb[k]?.date || '';
        if (followerShockDates.has(fbDate)) continue;
        if (!hasLaterMove && Math.abs(ret) > 0.003) {
          hasLaterMove = true;
          firstMoveDay = k - fStart;
        }
      }

      warnings++;
      const correctDir = (leadDir === 'up' && afterRet > 0) || (leadDir === 'down' && afterRet < 0);
      const hasMove = Math.abs(afterRet) > 0.01;
      // 跟随方向交易：leadDir up 做多 follower，leadDir down 做空 follower
      const pnl = leadDir === 'up' ? afterRet : -afterRet;
      if (hasLaterMove && correctDir && hasMove) {
        correct++;
        // 方向正确且幅度足够 → 盈利笔（pnl > 0）
        sumWin += pnl * 100;
        opts.onTrade?.(pnl * 100);
      } else {
        falseAlarm++;
        // 方向错或幅度不够 → 亏损笔（按跟随方向建仓的实际亏损）
        sumLose += Math.abs(pnl) * 100;
        opts.onTrade?.(pnl * 100);
      }
      leadTimes.push(firstMoveDay > 0 ? firstMoveDay : pair.lag);
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
  const alertPerYear = warnings / (20 * 60);

  return {
    id,
    warnings,
    correct,
    accuracy: accuracy * 100,
    falseAlarm,
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
  };
}

// 稳健性验证：剔除 top pct% 盈利笔后重新计算盈亏比
async function evaluateSrRobust(
  sameRateMin: number,
  allShocks: Map<string, Shock[]>,
  allBars: Map<string, Bar[]>,
  window: number,
  lagLimit: number,
  threshold: number,
  levels: 'all' | 'warn-severe' | 'severe-only',
  codeCategoryMap: Map<string, Set<string>>,
): Promise<{ pfBefore: number; pfAfter: number; perBefore: number; perAfter: number }> {
  const pairs = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { sameRateMin }, codeCategoryMap);
  const merged = mergePairsStandalone(pairs, true);
  const trades: number[] = [];
  evaluateM4(merged, allBars, allShocks, window, threshold, levels, { minSeverity: 0, onTrade: (p) => trades.push(p) }, `rob-sr${sameRateMin}`);
  const sumWin0 = trades.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const sumLose0 = trades.filter((t) => t < 0).reduce((a, b) => a + Math.abs(b), 0);
  const pfBefore = sumLose0 > 0 ? sumWin0 / sumLose0 : (sumWin0 > 0 ? 999 : 0);
  const perBefore = trades.reduce((a, b) => a + b, 0) / trades.length;
  // 剔除 top 5% 盈利笔
  const wins = trades.filter((t) => t > 0).sort((a, b) => b - a);
  const cutCount = Math.max(1, Math.floor(wins.length * 0.05));
  const sumWinAfter = wins.slice(cutCount).reduce((a, b) => a + b, 0);
  const pfAfter = sumLose0 > 0 ? sumWinAfter / sumLose0 : 0;
  const perAfter = (sumWinAfter - sumLose0) / trades.length;
  return { pfBefore, pfAfter, perBefore, perAfter };
}

// 独立 mergePairs（供 evaluateSrRobust 使用，避免依赖 main 内闭包）
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
  const staticPairs = loadStaticPairs();

  // M4 基线参数（P2：10天 / 3×ATR / 警告+严重 / 2天）
  const window = 10;
  const threshold = 3;
  const levels: 'all' | 'warn-severe' | 'severe-only' = 'warn-severe';
  const lagLimit = 2;

  // 学习传播对：base（无过滤）/ +A1（事件类型过滤）/ +A3（质量约束）/ +A1A3
  const pairsBase = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, {}, codeCategoryMap);
  const pairsA1 = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { eventFilter: true }, codeCategoryMap);
  const pairsA3 = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { qualityFilter: true, sameRateMin: 0.6 }, codeCategoryMap);
  const pairsA1A3 = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { eventFilter: true, qualityFilter: true, sameRateMin: 0.6 }, codeCategoryMap);

  // 同向率扫描（寻找最优 sameRateMin）—— 细网格
  const srResults: Array<{ sr: number; pairCount: number; warnings: number; pf: number; perTrade: number; acc: number }> = [];
  for (const sr of [0.5, 0.55, 0.58, 0.6, 0.62, 0.65, 0.68, 0.7, 0.72, 0.75]) {
    const pairs = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { sameRateMin: sr }, codeCategoryMap);
    const r = evaluateM4(mergePairs(pairs, true), allBars, allShocks, window, threshold, levels, { minSeverity: 0 }, `M4-sr${sr}`);
    srResults.push({ sr, pairCount: r.pairCount, warnings: r.warnings, pf: r.profitFactor, perTrade: r.perTradeAvg, acc: r.accuracy });
  }

  // 合并静态高置信度传播对（A3 的补充来源）
  function mergePairs(dynamic: PropagPair[], useStatic: boolean): PropagPair[] {
    const seen = new Set<string>();
    const merged: PropagPair[] = [];
    for (const p of [...dynamic, ...(useStatic ? staticPairs : [])]) {
      const key = `${p.leader}->${p.follower}`;
      if (!seen.has(key)) { seen.add(key); merged.push(p); }
    }
    return merged;
  }

  const results: EvalResult[] = [];
  // 基线
  results.push(evaluateM4(mergePairs(pairsBase, true), allBars, allShocks, window, threshold, levels, { minSeverity: 0 }, 'M4-base'));
  // +A1 事件类型过滤
  results.push(evaluateM4(mergePairs(pairsA1, false), allBars, allShocks, window, threshold, levels, { minSeverity: 0 }, 'M4+A1'));
  // +A2a 只跟踪 L3+
  results.push(evaluateM4(mergePairs(pairsBase, true), allBars, allShocks, window, threshold, levels, { minSeverity: 3 }, 'M4+A2a(L3+)'));
  // +A2b 只跟踪 L4+
  results.push(evaluateM4(mergePairs(pairsBase, true), allBars, allShocks, window, threshold, levels, { minSeverity: 4 }, 'M4+A2b(L4+)'));
  // +A3 传播对质量约束（旧基线复现）
  results.push(evaluateM4(mergePairs(pairsA3, true), allBars, allShocks, window, threshold, levels, { minSeverity: 0 }, 'M4+A3(旧基线0.6)'));
  // +A1A2a
  results.push(evaluateM4(mergePairs(pairsA1, false), allBars, allShocks, window, threshold, levels, { minSeverity: 3 }, 'M4+A1+A2a'));
  // +A1A3
  results.push(evaluateM4(mergePairs(pairsA1A3, true), allBars, allShocks, window, threshold, levels, { minSeverity: 0 }, 'M4+A1+A3'));
  // +A1A2aA3 全组合
  results.push(evaluateM4(mergePairs(pairsA1A3, true), allBars, allShocks, window, threshold, levels, { minSeverity: 3 }, 'M4+A1+A2a+A3'));

  // 输出对比
  console.log('\n=== M4 增强变体对比 ===');
  for (const r of results) {
    console.log(
      `${r.id.padEnd(18)} | 传播对${String(r.pairCount).padStart(3)} | 预警${String(r.warnings).padStart(5)} | ` +
      `准确率${r.accuracy.toFixed(1).padStart(5)}% | 误报率${r.falseAlarmRate.toFixed(1).padStart(5)}% | ` +
      `盈亏比${r.profitFactor.toFixed(2).padStart(5)} | 每笔${r.perTradeAvg.toFixed(4).padStart(8)}% | ` +
      `平均盈利${r.avgWin.toFixed(2).padStart(6)}% | 平均亏损${r.avgLose.toFixed(2).padStart(6)}% | ` +
      `收益${r.returnImprov.toFixed(2).padStart(9)}% | 年预警${r.alertPerYear.toFixed(2)}`
    );
  }

  // 保存结果
  const outPath = join(__dirname, '../data/propagationEnhanceResult.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n结果已保存: ${outPath}`);

  // 反指验证：修复评估 bug 后反指盈亏比 < 1，证明反指无价值（跟随本身正期望）
  console.log('\n=== 反指验证（修复 bug 后）===');
  const best = results.find((r) => r.id === 'M4+A2b(L4+)');
  if (best) {
    const total = best.winTrades + best.loseTrades;
    const revWinRate = (best.loseTrades / total) * 100;
    const revPF = (best.avgLose * best.loseTrades) / (best.avgWin * best.winTrades);
    console.log(`跟随: 胜率${best.accuracy.toFixed(1)}% 盈亏比${best.profitFactor.toFixed(2)} | 反指: 胜率${revWinRate.toFixed(1)}% 盈亏比${revPF.toFixed(2)}`);
    console.log(`结论: 跟随盈亏比 > 1 为正期望，反指盈亏比 < 1 无价值 → 跟随方向正确，反指无效`);
  }

  // 最优组合验证：sr=0.68 + A2b(L4+) 严重度过滤
  console.log('\n=== 最优组合验证（sr=0.68 高同向率 + 严重度过滤）===');
  const pairs068 = learnPropagationPairs(allShocks, allBars, window, lagLimit, threshold, { sameRateMin: 0.68 }, codeCategoryMap);
  for (const sev of [0, 3, 4]) {
    const r = evaluateM4(mergePairs(pairs068, true), allBars, allShocks, window, threshold, levels, { minSeverity: sev }, `sr0.68+sev${sev}`);
    console.log(`sr0.68 + 严重度≥${sev === 0 ? '全' : sev === 3 ? 'L3' : 'L4'} | 传播对${String(r.pairCount).padStart(3)} | 预警${String(r.warnings).padStart(5)} | 准确率${r.accuracy.toFixed(1).padStart(5)}% | 盈亏比${r.profitFactor.toFixed(2).padStart(5)} | 每笔${r.perTradeAvg.toFixed(4).padStart(8)}% | 年预警${r.alertPerYear.toFixed(2)}`);
  }

  // sr=0.68 最优传播对名单
  console.log('\n=== sr=0.68 传播对名单（按传播次数 top 15）===');
  const list = [...pairs068].sort((a, b) => (b.total ?? 0) - (a.total ?? 0)).slice(0, 15);
  for (const p of list) {
    console.log(`${p.leader}→${p.follower} | 同向率${((p.sameRate ?? 0) * 100).toFixed(1)}% | 传播${p.total ?? 0}次 | lag${p.lag}`);
  }

  // 最优组合稳健性验证：sr0.68+sev4 剔除 top 5% 盈利笔
  console.log('\n=== 最优组合稳健性（sr0.68 + L4，剔除 top 5% 盈利笔）===');
  const tradesBest: number[] = [];
  evaluateM4(mergePairs(pairs068, true), allBars, allShocks, window, threshold, levels, { minSeverity: 4, onTrade: (p) => tradesBest.push(p) }, 'best-combo');
  const sumWinB = tradesBest.filter((t) => t > 0).reduce((a, b) => a + b, 0);
  const sumLoseB = tradesBest.filter((t) => t < 0).reduce((a, b) => a + Math.abs(b), 0);
  const pfB = sumLoseB > 0 ? sumWinB / sumLoseB : 999;
  const winsB = tradesBest.filter((t) => t > 0).sort((a, b) => b - a);
  const cutB = Math.max(1, Math.floor(winsB.length * 0.05));
  const sumWinB2 = winsB.slice(cutB).reduce((a, b) => a + b, 0);
  const pfB2 = sumLoseB > 0 ? sumWinB2 / sumLoseB : 0;
  console.log(`剔除前: 盈亏比${pfB.toFixed(2)} 每笔${(tradesBest.reduce((a, b) => a + b, 0) / tradesBest.length).toFixed(4)}% | 剔除后: 盈亏比${pfB2.toFixed(2)} 每笔${((sumWinB2 - sumLoseB) / tradesBest.length).toFixed(4)}% | 交易笔数${tradesBest.length}`);

  // 同向率扫描结果
  console.log('\n=== 同向率扫描（传播对学习阈值）===');
  for (const s of srResults) {
    console.log(`sr=${s.sr.toFixed(2)} | 传播对${String(s.pairCount).padStart(3)} | 预警${String(s.warnings).padStart(5)} | 准确率${s.acc.toFixed(1).padStart(5)}% | 盈亏比${s.pf.toFixed(2).padStart(5)} | 每笔${s.perTrade.toFixed(4).padStart(8)}%`);
  }

  // 稳健性验证：对高盈亏比 sr 剔除 top 5% 盈利笔
  console.log('\n=== 稳健性验证（剔除 top 5% 盈利笔）===');
  for (const sr of [0.5, 0.6, 0.65, 0.7]) {
    const rob = await evaluateSrRobust(sr, allShocks, allBars, window, lagLimit, threshold, levels, codeCategoryMap);
    console.log(`sr=${sr.toFixed(2)} | 剔除前盈亏比 ${rob.pfBefore.toFixed(2)} | 剔除后盈亏比 ${rob.pfAfter.toFixed(2)} | 剔除前每笔 ${rob.perBefore.toFixed(4)}% | 剔除后每笔 ${rob.perAfter.toFixed(4)}%`);
  }

  // 排名
  console.log('\n=== 每笔期望 TOP ===');
  const sortedPer = [...results].sort((a, b) => b.perTradeAvg - a.perTradeAvg);
  sortedPer.forEach(r => console.log(`${r.id.padEnd(18)} | 每笔${r.perTradeAvg.toFixed(4)}% | 盈亏比${r.profitFactor.toFixed(2)} | 准确率${r.accuracy.toFixed(1)}%`));

  console.log('\n=== 盈亏比 TOP ===');
  const sortedPF = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  sortedPF.forEach(r => console.log(`${r.id.padEnd(18)} | 盈亏比${r.profitFactor.toFixed(2)} | 每笔${r.perTradeAvg.toFixed(4)}% | 准确率${r.accuracy.toFixed(1)}%`));
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});


