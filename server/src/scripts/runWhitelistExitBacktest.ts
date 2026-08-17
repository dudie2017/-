/**
 * 白名单传播对 离场优化回测
 * 运行：npx tsx src/scripts/runWhitelistExitBacktest.ts
 * 输出：src/data/whitelistExitResult.json + 控制台
 *
 * 目标：在 v8 白名单 39 对（已证明稳健）基础上，比较不同离场规则对收益/风险的影响：
 *   - 基线：无条件持有 window 天（v8 现状）
 *   - 止损：follower 累计亏损达 -1% / -2% / -3% 提前离场
 *   - 止盈：follower 累计盈利达 +2% / +3% / +4% 提前兑现
 *   - 时间衰减：持有固定 5 / 7 / 10 天后离场（v8 是 10 天）
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

function severityOf(atrMult: number): number {
  if (atrMult > 6) return 4;
  if (atrMult > 3) return 3;
  if (atrMult > 2) return 2;
  return 1;
}

// ============ 离场规则 ============
interface ExitRule {
  id: string;
  label: string;
  stopLoss: number;   // 0 = 无止损
  takeProfit: number; // 0 = 无止盈
  maxHold: number;    // 最大持有天数
}

const EXIT_RULES: ExitRule[] = [
  { id: 'BASE', label: '基线(持有10天)', stopLoss: 0, takeProfit: 0, maxHold: 10 },
  { id: 'SL1', label: '止损-1%', stopLoss: 0.01, takeProfit: 0, maxHold: 10 },
  { id: 'SL2', label: '止损-2%', stopLoss: 0.02, takeProfit: 0, maxHold: 10 },
  { id: 'SL3', label: '止损-3%', stopLoss: 0.03, takeProfit: 0, maxHold: 10 },
  { id: 'TP2', label: '止盈+2%', stopLoss: 0, takeProfit: 0.02, maxHold: 10 },
  { id: 'TP3', label: '止盈+3%', stopLoss: 0, takeProfit: 0.03, maxHold: 10 },
  { id: 'TP4', label: '止盈+4%', stopLoss: 0, takeProfit: 0.04, maxHold: 10 },
  { id: 'SL2TP3', label: '止损-2%+止盈+3%', stopLoss: 0.02, takeProfit: 0.03, maxHold: 10 },
  { id: 'H5', label: '持有5天', stopLoss: 0, takeProfit: 0, maxHold: 5 },
  { id: 'H7', label: '持有7天', stopLoss: 0, takeProfit: 0, maxHold: 7 },
  { id: 'H15', label: '持有15天', stopLoss: 0, takeProfit: 0, maxHold: 15 },
];

interface ExitResult {
  id: string;
  label: string;
  stage: string;
  period: string;
  warnings: number;
  accuracy: number;
  profitFactor: number;
  perTradeAvg: number;
  avgWin: number;
  avgLose: number;
  maxLoss: number;
  winTrades: number;
  loseTrades: number;
}

// 按离场规则评估单组前向
function evaluateWithExit(
  pair: (typeof PROPAGATION_WHITELIST)[number],
  lb: Bar[],
  fb: Bar[],
  followerShockDates: Set<string>,
  sh: Shock,
  effDir: 'up' | 'down',
  rule: ExitRule,
  window: number,
): { warnings: number; correct: number; pnl: number; maxLoss: number } {
  const lIdx = lb.findIndex(b => b.date === sh.barDate);
  if (lIdx < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };
  const leadDate = sh.barDate;
  const fStart = fb.findIndex(b => b.date > leadDate);
  if (fStart < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  let afterRet = 0;
  let hasLaterMove = false;
  let hitStopLoss = false;
  let hitTakeProfit = false;
  const maxLook = Math.min(fStart + Math.max(pair.lag, 1) + rule.maxHold, fb.length);

  for (let k = fStart; k < maxLook; k++) {
    const ret = fb[k]?.ret ?? 0;
    afterRet += ret;
    const fbDate = fb[k]?.date || '';
    if (followerShockDates.has(fbDate)) continue;
    if (!hasLaterMove && Math.abs(ret) > 0.003) hasLaterMove = true;

    // 离场检查：用经过方向调整的 PnL
    const pnl = effDir === 'up' ? afterRet : -afterRet;
    if (rule.stopLoss > 0 && pnl <= -rule.stopLoss) { hitStopLoss = true; break; }
    if (rule.takeProfit > 0 && pnl >= rule.takeProfit) { hitTakeProfit = true; break; }
  }

  const pnl = effDir === 'up' ? afterRet : -afterRet;
  const correctDir = (effDir === 'up' && afterRet > 0) || (effDir === 'down' && afterRet < 0);
  const hasMove = Math.abs(afterRet) > 0.01;
  const finalPnl = hitStopLoss ? -rule.stopLoss : pnl;
  const correct = hasLaterMove && correctDir && hasMove && !hitStopLoss ? 1 : 0;
  return { warnings: 1, correct, pnl: finalPnl * 100, maxLoss: Math.min(0, finalPnl) };
}

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

  const stages: Array<{ id: string; eval: [string, string]; years: number }> = [
    { id: 'F1', eval: ['2011-01-01', '2015-12-31'], years: 5 },
    { id: 'F2', eval: ['2016-01-01', '2020-12-31'], years: 5 },
    { id: 'F3', eval: ['2021-01-01', '2025-12-31'], years: 5 },
  ];

  const window = 10;
  const threshold = 3;
  const levels: 'warn-severe' = 'warn-severe';
  const minSeverity = 0; // warn-severe 已隐含 ≥4×ATR，不过滤更高级别
  const minAtrMult = threshold + 1; // warn-severe

  const results: ExitResult[] = [];

  for (const st of stages) {
    const evalShocks = new Map<string, Shock[]>();
    for (const [code, shocks] of allShocks) {
      evalShocks.set(code, shocks.filter(s => s.barDate >= st.eval[0] && s.barDate <= st.eval[1]));
    }

    for (const rule of EXIT_RULES) {
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
        const followerShockDates = new Set((evalShocks.get(pair.follower) || []).map(s => s.barDate));

        for (const sh of evalShocks.get(pair.leader) || []) {
          if (sh.atrMult < minAtrMult) continue;
          if (minSeverity > 0 && severityOf(sh.atrMult) < minSeverity) continue;
          const lIdx = lb.findIndex(b => b.date === sh.barDate);
          if (lIdx < 0) continue;

          // leader 冲击后累计收益方向（与 v8 一致）
          const lStart = lIdx + 1;
          const lEnd = Math.min(lIdx + window + 1, lb.length);
          let leadCum = 0;
          for (let k = lStart; k < lEnd; k++) leadCum += (lb[k]?.ret ?? 0);
          const effDir: 'up' | 'down' = leadCum >= 0 ? 'up' : 'down';

          const r = evaluateWithExit(pair, lb, fb, followerShockDates, sh, effDir, rule, window);
          warnings += r.warnings;
          correct += r.correct;
          if (r.correct === 1) { sumWin += r.pnl; winTrades++; }
          else { sumLose += Math.abs(r.pnl); loseTrades++; maxLoss = Math.min(maxLoss, r.pnl); }
        }
      }

      const accuracy = warnings > 0 ? correct / warnings : 0;
      const profitFactor = sumLose > 0 ? sumWin / sumLose : (sumWin > 0 ? 999 : 0);
      const perTradeAvg = warnings > 0 ? (sumWin - sumLose) / warnings : 0;
      const avgWin = winTrades > 0 ? sumWin / winTrades : 0;
      const avgLose = loseTrades > 0 ? sumLose / loseTrades : 0;

      results.push({
        id: rule.id,
        label: rule.label,
        stage: st.id,
        period: `${st.eval[0].slice(0,4)}-${st.eval[1].slice(0,4)}`,
        warnings,
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

  // 输出：按离场规则汇总 3 组前向
  console.log('\n========== 白名单传播对 离场优化回测 ==========');
  console.log(`白名单传播对: ${PROPAGATION_WHITELIST.length} | window=${window} | levels=${levels}`);
  console.log('------------------------------------------------------------');
  console.log('按规则汇总（3组前向的盈亏比 / 每笔期望% / 最大单笔亏损%）:');
  console.log('规则           | F1 PF   F2 PF   F3 PF | F1每笔  F2每笔  F3每笔 | 最大亏损');
  console.log('---------------|------------------------|----------------------|----------');
  for (const rule of EXIT_RULES) {
    const rows = results.filter(r => r.id === rule.id);
    const pf = (s: string) => rows.find(r => r.stage === s)?.profitFactor.toFixed(2) ?? '-';
    const pt = (s: string) => rows.find(r => r.stage === s)?.perTradeAvg.toFixed(3) ?? '-';
    const ml = Math.min(...rows.map(r => r.maxLoss)).toFixed(2);
    console.log(
      `${rule.label.padEnd(14)} | ${pf('F1').padStart(5)}  ${pf('F2').padStart(5)}  ${pf('F3').padStart(5)} | ` +
      `${pt('F1').padStart(6)} ${pt('F2').padStart(6)} ${pt('F3').padStart(6)} | ${ml}`
    );
  }

  // 明细（含准确率/均盈均亏）
  console.log('\n------------------------------------------------------------');
  console.log('明细（预警/准确率/盈亏比/均盈/均亏）:');
  for (const r of results) {
    console.log(
      `${r.id} ${r.stage} (${r.period}): 预警${r.warnings} 准确率${r.accuracy.toFixed(1)}% | PF ${r.profitFactor.toFixed(2)} | ` +
      `每笔${r.perTradeAvg.toFixed(3)}% | 均盈${r.avgWin.toFixed(2)}% 均亏${r.avgLose.toFixed(2)}% | 最大亏${r.maxLoss.toFixed(2)}%`
    );
  }

  writeFileSync(
    join(__dirname, '../data/whitelistExitResult.json'),
    JSON.stringify({ pairs: PROPAGATION_WHITELIST.length, rules: EXIT_RULES, results }, null, 2),
  );
  console.log('\n已保存: src/data/whitelistExitResult.json');
}

main().catch(e => { console.error(e); process.exit(1); });
