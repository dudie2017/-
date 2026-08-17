/**
 * 白名单传播对回测：验证领域知识真联动对在 20 年（3组滚动前向）的稳健性
 * 运行：npx tsx src/scripts/runWhitelistBacktest.ts
 * 输出：src/data/whitelistResult.json + 控制台
 *
 * 对比目标（v7 机器学习结果）：
 *   F1(06-10→11-15) / F2(11-15→16-20) / F3(16-20→21-25) 均失败
 * 白名单若在 3 组前向中 ≥2 组 PF>1.5，则证明"领域知识 > 机器学习"。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist';

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
  for (let i = 1; i < bars.length; i++) {
    const atr = computeATR(bars, i);
    if (atr <= 0) continue;
    const ret = bars[i].ret ?? 0;
    const atrMult = Math.abs(ret) / (atr / bars[i - 1].c);
    if (atrMult >= threshold) {
      shocks.push({ code, barDate: bars[i].date, atrMult, dir: ret > 0 ? 'up' : 'down', dayRetPct: ret * 100 });
    }
  }
  return shocks;
}

// ============ M4 评估（白名单版） ============
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
  years: number;
  sectorHitRate: number;   // 板块命中率（同板块占比）
  activePairs: number;
}

function severityOf(atrMult: number): number {
  if (atrMult > 6) return 4;
  if (atrMult > 3) return 3;
  if (atrMult > 2) return 2;
  return 1;
}

function evaluateWhitelist(
  pairs: typeof PROPAGATION_WHITELIST,
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
  let sectorHit = 0;
  let sectorCount = 0;
  const active = new Set<string>();

  const minAtrMult = levels === 'all' ? threshold : levels === 'warn-severe' ? threshold + 1 : threshold + 2;

  for (const pair of pairs) {
    const lb = allBars.get(pair.leader);
    const fb = allBars.get(pair.follower);
    if (!lb || !fb || lb.length === 0 || fb.length === 0) continue;
    const followerShockDates = new Set((allShocks.get(pair.follower) || []).map(s => s.barDate));
    let pairWarned = false;

    for (const sh of allShocks.get(pair.leader) || []) {
      if (sh.atrMult < minAtrMult) continue;
      if (minSeverity > 0 && severityOf(sh.atrMult) < minSeverity) continue;
      const lIdx = lb.findIndex(b => b.date === sh.barDate);
      if (lIdx < 0) continue;
      const leadDir = sh.dir;
      const leadDate = sh.barDate;
      const fStart = fb.findIndex(b => b.date > leadDate);
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
      pairWarned = true;
      sectorCount++;
      if (pair.sector !== '其他') sectorHit++;

      // 传播方向：用 leader 冲击后累计收益方向（与机器学习版一致），而非单日方向
      const lStart = lIdx + 1;
      const lEnd = Math.min(lIdx + window + 1, lb.length);
      let leadCum = 0;
      for (let k = lStart; k < lEnd; k++) leadCum += (lb[k]?.ret ?? 0);
      const effDir: 'up' | 'down' = leadCum >= 0 ? 'up' : 'down';

      const correctDir = (effDir === 'up' && afterRet > 0) || (effDir === 'down' && afterRet < 0);
      const hasMove = Math.abs(afterRet) > 0.01;
      const pnl = effDir === 'up' ? afterRet : -afterRet;
      if (hasLaterMove && correctDir && hasMove) {
        correct++;
        sumWin += pnl * 100;
      } else {
        falseAlarm++;
        sumLose += Math.abs(pnl) * 100;
      }
    }
    if (pairWarned) active.add(`${pair.leader}->${pair.follower}`);
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
    years,
    sectorHitRate: sectorCount > 0 ? sectorHit / sectorCount : 0,
    activePairs: active.size,
  };
}

// ============ 主流程 ============
async function main() {
  const codes = BLACK_SWAN_EVENTS.reduce<string[]>((acc, ev) => {
    for (const c of ev.varieties) if (!acc.includes(c)) acc.push(c);
    return acc;
  }, []);

  const allBars = new Map<string, Bar[]>();
  for (const code of codes) {
    const bars = loadVarietyBars(code);
    if (bars.length > 0) allBars.set(code, bars);
  }
  console.log(`加载品种: ${allBars.size} 个`);

  const allShocks = new Map<string, Shock[]>();
  for (const [code, bars] of allBars) {
    allShocks.set(code, detectShocks(bars, code, 1.5));
  }

  const stages: Array<{ id: string; learn: [string, string]; eval: [string, string]; years: number }> = [
    { id: 'F1', learn: ['2006-01-01', '2010-12-31'], eval: ['2011-01-01', '2015-12-31'], years: 5 },
    { id: 'F2', learn: ['2011-01-01', '2015-12-31'], eval: ['2016-01-01', '2020-12-31'], years: 5 },
    { id: 'F3', learn: ['2016-01-01', '2020-12-31'], eval: ['2021-01-01', '2025-12-31'], years: 5 },
  ];

  const window = 10;
  const threshold = 3;
  const levels: 'warn-severe' = 'warn-severe';
  const severityLevels = [0, 3, 4]; // 不过滤 / L3+ / L4+（warn-severe 已隐含 ≥4×ATR，L2 无差异）

  const results: EvalResult[] = [];
  for (const sev of severityLevels) {
    for (const st of stages) {
      const evalShocks = new Map<string, Shock[]>();
      for (const [code, shocks] of allShocks) {
        evalShocks.set(code, shocks.filter(s => s.barDate >= st.eval[0] && s.barDate <= st.eval[1]));
      }
      const r = evaluateWhitelist(
        PROPAGATION_WHITELIST, allBars, evalShocks,
        window, threshold, levels, sev,
        `WL-${st.id}-S${sev}`, `${st.eval[0].slice(0,4)}-${st.eval[1].slice(0,4)}`, st.years,
      );
      results.push(r);
    }
  }

  console.log('\n========== 白名单传播对 滚动前向回测（3组） ==========');
  console.log('白名单传播对数:', PROPAGATION_WHITELIST.length);
  console.log('参数: window=' + window + ' threshold=' + threshold + ' levels=' + levels + ' severityLevels=[' + severityLevels.join(',') + ']');
  console.log('------------------------------------------------------------');
  for (const r of results) {
    console.log(
      `${r.id} (${r.period}): 预警${r.warnings} 准确率${r.accuracy.toFixed(1)}% | 盈亏比${r.profitFactor.toFixed(2)} | 每笔${r.perTradeAvg.toFixed(3)}% | ` +
      `均盈${r.avgWin.toFixed(2)}% 均亏${r.avgLose.toFixed(2)}% | 板块命中率${(r.sectorHitRate * 100).toFixed(0)}% | 活跃对${r.activePairs}`
    );
  }

  // 汇总判定
  const strong = results.filter(r => r.profitFactor > 1.5).length;
  const weak = results.filter(r => r.profitFactor > 1.0 && r.profitFactor <= 1.5).length;
  const fail = results.filter(r => r.profitFactor <= 1.0).length;
  console.log('------------------------------------------------------------');
  console.log(`判定: 强稳健${strong}组 / 弱稳健${weak}组 / 不稳健${fail}组`);
  if (strong >= 2) console.log('✅ 白名单传播对在滚动前向验证下稳健（领域知识 > 机器学习）');
  else if (strong === 1 && fail <= 1) console.log('⚠️ 部分稳健，需进一步筛选');
  else console.log('❌ 白名单传播对仍不稳健');

  writeFileSync(
    join(__dirname, '../data/whitelistResult.json'),
    JSON.stringify({ pairs: PROPAGATION_WHITELIST.length, results, verdict: { strong, weak, fail } }, null, 2),
  );
  console.log('\n已保存: src/data/whitelistResult.json');
}

main().catch(e => { console.error(e); process.exit(1); });
