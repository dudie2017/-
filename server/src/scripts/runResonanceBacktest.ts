/**
 * 多信号共振回测（方案A / v12）
 * 运行：npx tsx src/scripts/runResonanceBacktest.ts
 * 输出：src/data/resonanceResult.json + 控制台
 *
 * 目标：在 v10 基线（next1+白名单+SL1，PF=8.33）之上，测试共振过滤是否进一步提升信号质量
 *
 * 共振类型：
 *   A1 跨品种共振：同板块 ≥N 个 leader 同日冲击 → 板块级系统性驱动
 *   A2 跨周期共振：日线冲击方向 与 周线趋势（MA100≈20周均线）同向 → 顺大趋势
 *   A3 双共振叠加：A1 + A2 同时满足
 *
 * 变量矩阵：
 *   A1 门槛：R2(≥2 leader) / R3(≥3 leader)
 *   A2 趋势：MA50(≈10周) / MA100(≈20周) / MA200(≈40周)
 *   组合：v10基线 / A1-R2 / A1-R3 / A2-MA50 / A2-MA100 / A2-MA200 / A3-R2-MA100 / A3-R3-MA100
 *
 * 评估：全周期 + 3组滚动前向（F1:2011-2015 / F2:2016-2020 / F3:2021-2025）
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { PROPAGATION_WHITELIST, type WhitelistPair } from '../data/propagationWhitelist.js';

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

/** 计算简单移动平均（从日线数据） */
function computeSMA(bars: Bar[], i: number, period: number): number {
  if (i < period - 1) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    sum += bars[k].c;
  }
  return sum / period;
}

interface Shock {
  code: string;
  barDate: string;
  barIdx: number;     // 在 bars 数组中的索引
  atrMult: number;
  dir: 'up' | 'down';
  dayRetPct: number;
  sector: string;     // 所属板块（从白名单映射）
}

/** 从白名单提取所有 leader → sector 映射 */
function buildLeaderSectorMap(): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of PROPAGATION_WHITELIST) {
    if (!map.has(p.leader)) map.set(p.leader, []);
    const sectors = map.get(p.leader)!;
    if (!sectors.includes(p.sector)) sectors.push(p.sector);
  }
  return map;
}

function detectShocks(bars: Bar[], code: string, threshold: number, sector: string): Shock[] {
  const shocks: Shock[] = [];
  for (let i = 15; i < bars.length; i++) {
    const atr = computeATR(bars, i);
    if (atr <= 0) continue;
    const ret = bars[i].ret ?? 0;
    const atrMult = Math.abs(ret) / (atr / bars[i - 1].c);
    if (atrMult >= threshold) {
      shocks.push({
        code, barDate: bars[i].date, barIdx: i,
        atrMult, dir: ret > 0 ? 'up' : 'down',
        dayRetPct: ret * 100, sector,
      });
    }
  }
  return shocks;
}

// ============ 共振检测 ============

/** A1：跨品种共振 — 同板块同日多 leader 冲击 */
function detectCrossVarietyResonance(
  allShocks: Map<string, Shock[]>,
  minLeaders: number,
): Set<string> {
  // 按日期+板块分组
  const dateSector = new Map<string, Map<string, string[]>>(); // date → sector → [leaderCodes]
  for (const [code, shocks] of allShocks) {
    for (const sh of shocks) {
      if (!dateSector.has(sh.barDate)) dateSector.set(sh.barDate, new Map());
      const sectorMap = dateSector.get(sh.barDate)!;
      if (!sectorMap.has(sh.sector)) sectorMap.set(sh.sector, []);
      const leaders = sectorMap.get(sh.sector)!;
      if (!leaders.includes(code)) leaders.push(code);
    }
  }
  // 筛选：同日期同板块 ≥minLeaders 个 leader
  const resonanceKeys = new Set<string>(); // "date_sector"
  for (const [date, sectorMap] of dateSector) {
    for (const [sector, leaders] of sectorMap) {
      if (leaders.length >= minLeaders) {
        resonanceKeys.add(`${date}_${sector}`);
      }
    }
  }
  return resonanceKeys;
}

/** A2：跨周期共振 — 日线冲击方向与周线趋势同向（或反向） */
function detectCrossTimeframeResonance(
  bars: Bar[],
  shockIdx: number,
  maPeriod: number,
  mode: 'same' | 'reverse' = 'same',
): boolean {
  if (shockIdx < maPeriod) return false;
  const ma = computeSMA(bars, shockIdx, maPeriod);
  if (ma <= 0) return false;
  const price = bars[shockIdx].c;
  const shockDir = bars[shockIdx].ret! > 0 ? 'up' : 'down';
  const trendDir = price > ma ? 'up' : 'down';
  if (mode === 'same') return shockDir === trendDir;
  return shockDir !== trendDir;  // reverse: 逆势
}

/** A1 宽松版：同板块 ≥N leader 在 window 天内连续冲击 */
function detectCrossVarietyResonanceRelaxed(
  allShocks: Map<string, Shock[]>,
  minLeaders: number,
  windowDays: number,
): Set<string> {
  // 收集所有 (date, sector, leaderCode) 三元组
  const entries: Array<{ date: string; sector: string; code: string }> = [];
  for (const [code, shocks] of allShocks) {
    for (const sh of shocks) {
      entries.push({ date: sh.barDate, sector: sh.sector, code });
    }
  }
  // 按板块分组
  const bySector = new Map<string, Array<{ date: string; code: string }>>();
  for (const e of entries) {
    if (!bySector.has(e.sector)) bySector.set(e.sector, []);
    bySector.get(e.sector)!.push({ date: e.date, code: e.code });
  }
  // 对每个板块，按日期排序，滑动窗口检查
  const resonanceKeys = new Set<string>();
  for (const [sector, items] of bySector) {
    items.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < items.length; i++) {
      const startDate = items[i].date;
      const startTs = new Date(startDate).getTime();
      const leadersInWindow = new Set<string>();
      for (let j = i; j < items.length; j++) {
        const ts = new Date(items[j].date).getTime();
        if (ts - startTs > windowDays * 86400000) break;
        leadersInWindow.add(items[j].code);
      }
      if (leadersInWindow.size >= minLeaders) {
        // 标记窗口内所有日期
        for (let j = i; j < items.length; j++) {
          const ts = new Date(items[j].date).getTime();
          if (ts - startTs > windowDays * 86400000) break;
          resonanceKeys.add(`${items[j].date}_${sector}`);
        }
      }
    }
  }
  return resonanceKeys;
}

// ============ 交易评估（与 v10 一致） ============

interface TradeResult {
  warnings: number;
  correct: number;
  pnl: number;
  maxLoss: number;
}

function evaluateTrade(
  pair: WhitelistPair,
  lb: Bar[],
  fb: Bar[],
  sh: Shock,
  stopLoss: number,
  maxHold: number,
  lag: number,
): TradeResult {
  const lIdx = sh.barIdx;
  if (lIdx < 0 || lIdx >= lb.length - 1) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  // next1 确认：leader 次日延续
  const nextRet = lb[lIdx + 1]?.ret ?? 0;
  const next1Ok = sh.dir === 'up' ? nextRet > 0 : nextRet < 0;
  if (!next1Ok) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  const effDir = sh.dir;

  // follower 入场：lag 天后
  const leadDate = sh.barDate;
  const fStart = fb.findIndex(b => b.date > leadDate);
  if (fStart < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  let afterRet = 0;
  let hitStopLoss = false;
  const maxLook = Math.min(fStart + Math.max(lag, 1) + maxHold, fb.length);

  for (let k = fStart; k < maxLook; k++) {
    const ret = fb[k]?.ret ?? 0;
    afterRet += ret;
    const pnl = effDir === 'up' ? afterRet : -afterRet;
    if (stopLoss > 0 && pnl <= -stopLoss) { hitStopLoss = true; break; }
  }

  const pnl = effDir === 'up' ? afterRet : -afterRet;
  const finalPnl = hitStopLoss ? -stopLoss : pnl;
  const correct = finalPnl > 0 ? 1 : 0;
  return { warnings: 1, correct, pnl: finalPnl * 100, maxLoss: Math.min(0, finalPnl * 100) };
}

// ============ 主函数 ============

interface VariantConfig {
  id: string;
  desc: string;
  resonanceFilter: 'none' | 'A1-R2' | 'A1-R3' | 'A2-MA50' | 'A2-MA100' | 'A2-MA200' | 'A3-R2-MA100' | 'A3-R3-MA100'
    | 'A2rev-MA50' | 'A2rev-MA100' | 'A2rev-MA200' | 'A1-relax-R2-W3' | 'A1-relax-R2-W5';
  a1MinLeaders: number;
  a2MAPeriod: number;
  a2Mode: 'same' | 'reverse';
  a1WindowDays: number;
}

interface VariantResult {
  id: string;
  desc: string;
  stage: string;
  period: string;
  warnings: number;
  correct: number;
  accuracy: number;
  profitFactor: number;
  perTradeAvg: number;
  avgWin: number;
  avgLose: number;
  maxLoss: number;
  winTrades: number;
  loseTrades: number;
}

async function main() {
  // 1. 加载数据
  const leaderSet = new Set(PROPAGATION_WHITELIST.map(p => p.leader));
  const allBars = new Map<string, Bar[]>();
  for (const code of leaderSet) {
    const bars = loadVarietyBars(code);
    if (bars.length > 0) allBars.set(code, bars);
  }
  // 也加载 follower 数据
  const followerSet = new Set(PROPAGATION_WHITELIST.map(p => p.follower));
  for (const code of followerSet) {
    if (!allBars.has(code)) {
      const bars = loadVarietyBars(code);
      if (bars.length > 0) allBars.set(code, bars);
    }
  }
  console.log(`加载品种: ${allBars.size} 个 (leader ${leaderSet.size} + follower 补充)`);

  // 2. 检测所有 leader 冲击（≥4×ATR）
  const leaderSectorMap = buildLeaderSectorMap();
  const allShocks = new Map<string, Shock[]>();
  for (const code of leaderSet) {
    const bars = allBars.get(code);
    if (!bars) continue;
    const sectors = leaderSectorMap.get(code) || ['未知'];
    for (const sector of sectors) {
      const shocks = detectShocks(bars, code, 4, sector);
      // 合并（同一品种可能属于多个板块的白名单对）
      if (!allShocks.has(code)) allShocks.set(code, []);
      const existing = allShocks.get(code)!;
      for (const sh of shocks) {
        if (!existing.find(e => e.barDate === sh.barDate)) existing.push(sh);
      }
    }
  }

  let totalShocks = 0;
  for (const [, shocks] of allShocks) totalShocks += shocks.length;
  console.log(`检测到冲击事件: ${totalShocks} 个 (≥4×ATR)`);

  // 3. 预计算共振集合
  // A1: 跨品种共振（同日）
  const a1R2 = detectCrossVarietyResonance(allShocks, 2);
  const a1R3 = detectCrossVarietyResonance(allShocks, 3);
  // A1 宽松版：3天/5天窗口
  const a1RelaxR2W3 = detectCrossVarietyResonanceRelaxed(allShocks, 2, 3);
  const a1RelaxR2W5 = detectCrossVarietyResonanceRelaxed(allShocks, 2, 5);
  console.log(`A1 共振: R2=${a1R2.size} 日期-板块组合, R3=${a1R3.size}`);
  console.log(`A1 宽松: R2-W3=${a1RelaxR2W3.size}, R2-W5=${a1RelaxR2W5.size}`);

  // 4. 定义变体矩阵
  const variants: VariantConfig[] = [
    { id: 'v10-基线', desc: 'v10 next1+白名单+SL1（无共振过滤）', resonanceFilter: 'none', a1MinLeaders: 0, a2MAPeriod: 0, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A1-R2', desc: '跨品种共振≥2 leader(同日)', resonanceFilter: 'A1-R2', a1MinLeaders: 2, a2MAPeriod: 0, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A1-R3', desc: '跨品种共振≥3 leader(同日)', resonanceFilter: 'A1-R3', a1MinLeaders: 3, a2MAPeriod: 0, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A1-relax-R2-W3', desc: '宽松共振≥2 leader(3天内)', resonanceFilter: 'A1-relax-R2-W3', a1MinLeaders: 2, a2MAPeriod: 0, a2Mode: 'same', a1WindowDays: 3 },
    { id: 'A1-relax-R2-W5', desc: '宽松共振≥2 leader(5天内)', resonanceFilter: 'A1-relax-R2-W5', a1MinLeaders: 2, a2MAPeriod: 0, a2Mode: 'same', a1WindowDays: 5 },
    { id: 'A2-MA50', desc: '顺势共振 MA50(≈10周)', resonanceFilter: 'A2-MA50', a1MinLeaders: 0, a2MAPeriod: 50, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A2-MA100', desc: '顺势共振 MA100(≈20周)', resonanceFilter: 'A2-MA100', a1MinLeaders: 0, a2MAPeriod: 100, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A2-MA200', desc: '顺势共振 MA200(≈40周)', resonanceFilter: 'A2-MA200', a1MinLeaders: 0, a2MAPeriod: 200, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A2rev-MA50', desc: '逆势共振 MA50(≈10周)', resonanceFilter: 'A2rev-MA50', a1MinLeaders: 0, a2MAPeriod: 50, a2Mode: 'reverse', a1WindowDays: 0 },
    { id: 'A2rev-MA100', desc: '逆势共振 MA100(≈20周)', resonanceFilter: 'A2rev-MA100', a1MinLeaders: 0, a2MAPeriod: 100, a2Mode: 'reverse', a1WindowDays: 0 },
    { id: 'A2rev-MA200', desc: '逆势共振 MA200(≈40周)', resonanceFilter: 'A2rev-MA200', a1MinLeaders: 0, a2MAPeriod: 200, a2Mode: 'reverse', a1WindowDays: 0 },
    { id: 'A3-R2-MA100', desc: '双共振: R2+MA100', resonanceFilter: 'A3-R2-MA100', a1MinLeaders: 2, a2MAPeriod: 100, a2Mode: 'same', a1WindowDays: 0 },
    { id: 'A3-R3-MA100', desc: '双共振: R3+MA100', resonanceFilter: 'A3-R3-MA100', a1MinLeaders: 3, a2MAPeriod: 100, a2Mode: 'same', a1WindowDays: 0 },
  ];

  // 5. 时段
  const stages: Array<{ id: string; eval: [string, string] }> = [
    { id: 'ALL', eval: ['2006-01-01', '2025-12-31'] },
    { id: 'F1', eval: ['2011-01-01', '2015-12-31'] },
    { id: 'F2', eval: ['2016-01-01', '2020-12-31'] },
    { id: 'F3', eval: ['2021-01-01', '2025-12-31'] },
  ];

  const results: VariantResult[] = [];
  const stopLoss = 0.01; // v10 最优 SL1
  const maxHold = 10;
  const lag = 2;

  for (const variant of variants) {
    for (const st of stages) {
      let warnings = 0;
      let correct = 0;
      let sumWin = 0;
      let sumLose = 0;
      let maxLoss = 0;
      let winTrades = 0;
      let loseTrades = 0;

      for (const pair of PROPAGATION_WHITELIST) {
        const lb = allBars.get(pair.leader);
        const fb = allBars.get(pair.follower);
        if (!lb || !fb || lb.length === 0 || fb.length === 0) continue;

        const leaderShocks = allShocks.get(pair.leader) || [];
        // 过滤时段
        const periodShocks = leaderShocks.filter(s =>
          s.barDate >= st.eval[0] && s.barDate <= st.eval[1] && s.sector === pair.sector
        );

        for (const sh of periodShocks) {
          // 共振过滤
          let passResonance = true;

          // A1 跨品种共振（同日）
          if (variant.resonanceFilter === 'A1-R2' || variant.resonanceFilter === 'A1-R3' ||
              variant.resonanceFilter === 'A3-R2-MA100' || variant.resonanceFilter === 'A3-R3-MA100') {
            const key = `${sh.barDate}_${sh.sector}`;
            const a1Set = variant.a1MinLeaders === 2 ? a1R2 : a1R3;
            if (!a1Set.has(key)) passResonance = false;
          }

          // A1 宽松版（窗口内）
          if (variant.resonanceFilter === 'A1-relax-R2-W3' || variant.resonanceFilter === 'A1-relax-R2-W5') {
            const key = `${sh.barDate}_${sh.sector}`;
            const a1Set = variant.a1WindowDays === 3 ? a1RelaxR2W3 : a1RelaxR2W5;
            if (!a1Set.has(key)) passResonance = false;
          }

          // A2 跨周期共振（顺势或逆势）
          if (passResonance && variant.a2MAPeriod > 0) {
            passResonance = detectCrossTimeframeResonance(lb, sh.barIdx, variant.a2MAPeriod, variant.a2Mode);
          }

          if (!passResonance) continue;

          const r = evaluateTrade(pair, lb, fb, sh, stopLoss, maxHold, lag);
          warnings += r.warnings;
          correct += r.correct;
          if (r.correct === 1) { sumWin += r.pnl; winTrades++; }
          else if (r.warnings === 1) { sumLose += Math.abs(r.pnl); loseTrades++; maxLoss = Math.min(maxLoss, r.pnl); }
        }
      }

      const accuracy = warnings > 0 ? correct / warnings : 0;
      const profitFactor = sumLose > 0 ? sumWin / sumLose : (sumWin > 0 ? 999 : 0);
      const perTradeAvg = warnings > 0 ? (sumWin - sumLose) / warnings : 0;
      const avgWin = winTrades > 0 ? sumWin / winTrades : 0;
      const avgLose = loseTrades > 0 ? sumLose / loseTrades : 0;

      results.push({
        id: variant.id,
        desc: variant.desc,
        stage: st.id,
        period: `${st.eval[0].slice(0, 4)}-${st.eval[1].slice(0, 4)}`,
        warnings,
        correct,
        accuracy: accuracy * 100,
        profitFactor,
        perTradeAvg,
        avgWin,
        avgLose,
        maxLoss,
        winTrades,
        loseTrades,
      });
    }
  }

  // ============ 输出 ============
  console.log('\n========== 多信号共振回测（方案A / v12） ==========');
  console.log(`白名单: ${PROPAGATION_WHITELIST.length} 对 | 冲击: ≥4×ATR | next1确认 | SL1止损 | 最大持有10天`);
  console.log('======================================================================');
  console.log('变体                       | ALL PF   F1 PF   F2 PF   F3 PF | ALL信号 ALL胜率 ALL每笔 | 最大亏损');
  console.log('---------------------------|-------------------------------|---------------------------|---------');

  for (const v of variants) {
    const rows = results.filter(r => r.id === v.id);
    const pf = (s: string) => rows.find(r => r.stage === s)?.profitFactor.toFixed(2) ?? '-';
    const w = rows.find(r => r.stage === 'ALL')?.warnings ?? 0;
    const acc = rows.find(r => r.stage === 'ALL')?.accuracy ?? 0;
    const pt = rows.find(r => r.stage === 'ALL')?.perTradeAvg ?? 0;
    const ml = Math.min(...rows.map(r => r.maxLoss)).toFixed(2);

    console.log(
      `${v.id.padEnd(26)} | ${pf('ALL').padStart(5)}  ${pf('F1').padStart(5)}  ${pf('F2').padStart(5)}  ${pf('F3').padStart(5)} | ` +
      `${String(w).padStart(5)}信号 ${acc.toFixed(1).padStart(5)}% ${pt.toFixed(3).padStart(7)}% | ${ml}`
    );
  }

  // 明细
  console.log('\n----------------------------------------------------------------------');
  console.log('完整明细:');
  for (const r of results) {
    console.log(
      `${r.id} ${r.stage} (${r.period}): ${r.warnings}信号 准确率${r.accuracy.toFixed(1)}% | ` +
      `PF ${r.profitFactor.toFixed(2)} | 每笔${r.perTradeAvg.toFixed(3)}% | ` +
      `均盈${r.avgWin.toFixed(2)}% 均亏${r.avgLose.toFixed(2)}% | 最大亏${r.maxLoss.toFixed(2)}%`
    );
  }

  // ============ 稳健性判定 ============
  console.log('\n----------------------------------------------------------------------');
  console.log('稳健性判定（与 v10 对比）:');
  for (const v of variants) {
    const rows = results.filter(r => r.id === v.id);
    const f1pf = rows.find(r => r.stage === 'F1')?.profitFactor ?? 0;
    const f2pf = rows.find(r => r.stage === 'F2')?.profitFactor ?? 0;
    const f3pf = rows.find(r => r.stage === 'F3')?.profitFactor ?? 0;
    const allpf = rows.find(r => r.stage === 'ALL')?.profitFactor ?? 0;
    const allW = rows.find(r => r.stage === 'ALL')?.warnings ?? 0;

    let verdict = '';
    if (allW < 10) verdict = '⚠️ 信号过少（<10），统计不显著';
    else if (f1pf > 1.5 && f2pf > 1.5 && f3pf > 1.5) verdict = '✅ 强稳健（3组前向PF>1.5）';
    else if (f1pf > 1.0 && f2pf > 1.0 && f3pf > 1.0) verdict = '🟡 弱稳健（3组前向PF>1.0）';
    else verdict = '❌ 不稳健';

    const improvement = allpf > 0 ? ((allpf - 8.33) / 8.33 * 100).toFixed(1) : '-';
    console.log(`  ${v.id.padEnd(26)} PF=${allpf.toFixed(2)} vs v10(8.33) ${improvement}% | ${verdict}`);
  }

  // ============ 保存 JSON ============
  const outPath = join(__dirname, '../data/resonanceResult.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
