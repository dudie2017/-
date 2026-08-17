/**
 * 双通道组合策略回测（方案A）
 * 运行：npx tsx src/scripts/runCombinedStrategyBacktest.ts
 * 输出：src/data/combinedStrategyResult.json + 控制台
 *
 * 目标：M3 方向层 + 白名单确认 + SL1 止损 组合，用 20 年全周期 + 3 组滚动前向对比：
 *   - 通道1（方向层）：leader 冲击后自身方向延续确认（next1 / next3 / 无确认）
 *   - 通道2（操作层）：白名单传播对选择 follower
 *   - 离场：SL1 止损 或 无条件持有
 *
 * 对比矩阵：
 *   confirmMode: none(基线) / next1(次日延续) / next3(3日延续)
 *   stopLoss:    0 / 0.01
 *   × 时段：全周期 + F1/F2/F3
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

// ============ 组合策略参数 ============
type ConfirmMode = 'none' | 'next1' | 'next3';

interface ComboOpts {
  confirm: ConfirmMode; // 方向层确认模式
  stopLoss: number;     // 止损（0=无）
  maxHold: number;      // 最大持有天数
  window: number;       // 方向窗口
  lag: number;          // follower 滞后天数
}

interface ComboResult {
  id: string;
  confirm: string;
  stopLoss: number;
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

// leader 冲击后方向延续确认：返回确认后的方向（不满足返回 null）
function leaderConfirm(
  lb: Bar[],
  lIdx: number,
  dir: 'up' | 'down',
  mode: ConfirmMode,
  window: number,
): 'up' | 'down' | null {
  if (mode === 'none') return dir;
  const n = mode === 'next1' ? 1 : 3;
  const end = Math.min(lIdx + n + 1, lb.length);
  let cum = 0;
  for (let k = lIdx + 1; k < end; k++) cum += (lb[k]?.ret ?? 0);
  // 延续确认：与冲击方向同向且幅度 > 0.3×ATR 的显著性
  if (cum * (dir === 'up' ? 1 : -1) > 0.003) return dir;
  return null;
}

function evaluateCombo(
  pair: (typeof PROPAGATION_WHITELIST)[number],
  lb: Bar[],
  fb: Bar[],
  followerShockDates: Set<string>,
  sh: Shock,
  opts: ComboOpts,
): { warnings: number; correct: number; pnl: number; maxLoss: number } {
  const lIdx = lb.findIndex(b => b.date === sh.barDate);
  if (lIdx < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  // 方向层：leader 冲击后 window 天内累计收益方向
  const lStart = lIdx + 1;
  const lEnd = Math.min(lIdx + opts.window + 1, lb.length);
  let leadCum = 0;
  for (let k = lStart; k < lEnd; k++) leadCum += (lb[k]?.ret ?? 0);
  if (Math.abs(leadCum) < 0.005) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };
  const leadDir: 'up' | 'down' = leadCum >= 0 ? 'up' : 'down';

  // M3 方向延续确认
  const effDir = leaderConfirm(lb, lIdx, leadDir, opts.confirm, opts.window);
  if (!effDir) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  // 操作层：follower 跟随
  const leadDate = sh.barDate;
  const fStart = fb.findIndex(b => b.date > leadDate);
  if (fStart < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  let afterRet = 0;
  let hasLaterMove = false;
  let hitStopLoss = false;
  const maxLook = Math.min(fStart + Math.max(opts.lag, 1) + opts.maxHold, fb.length);

  for (let k = fStart; k < maxLook; k++) {
    const ret = fb[k]?.ret ?? 0;
    afterRet += ret;
    const fbDate = fb[k]?.date || '';
    if (followerShockDates.has(fbDate)) continue;
    if (!hasLaterMove && Math.abs(ret) > 0.003) hasLaterMove = true;

    const pnl = effDir === 'up' ? afterRet : -afterRet;
    if (opts.stopLoss > 0 && pnl <= -opts.stopLoss) { hitStopLoss = true; break; }
  }

  const pnl = effDir === 'up' ? afterRet : -afterRet;
  const correctDir = (effDir === 'up' && afterRet > 0) || (effDir === 'down' && afterRet < 0);
  const hasMove = Math.abs(afterRet) > 0.01;
  const finalPnl = hitStopLoss ? -opts.stopLoss : pnl;
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

  // 时段：全周期 + 3 组前向
  const stages: Array<{ id: string; eval: [string, string]; years: number }> = [
    { id: 'ALL', eval: ['2006-01-01', '2025-12-31'], years: 20 },
    { id: 'F1', eval: ['2011-01-01', '2015-12-31'], years: 5 },
    { id: 'F2', eval: ['2016-01-01', '2020-12-31'], years: 5 },
    { id: 'F3', eval: ['2021-01-01', '2025-12-31'], years: 5 },
  ];

  const optsList: ComboOpts[] = [
    // 基线：无确认 + 无止损（白名单原样）
    { confirm: 'none', stopLoss: 0, maxHold: 10, window: 10, lag: 2 },
    // 无确认 + SL1
    { confirm: 'none', stopLoss: 0.01, maxHold: 10, window: 10, lag: 2 },
    // M3 方向确认 next1 × 止损档
    { confirm: 'next1', stopLoss: 0, maxHold: 10, window: 10, lag: 2 },
    { confirm: 'next1', stopLoss: 0.01, maxHold: 10, window: 10, lag: 2 },
    // M3 方向确认 next3 × 止损档
    { confirm: 'next3', stopLoss: 0, maxHold: 10, window: 10, lag: 2 },
    { confirm: 'next3', stopLoss: 0.01, maxHold: 10, window: 10, lag: 2 },
  ];

  const results: ComboResult[] = [];

  for (const st of stages) {
    const evalShocks = new Map<string, Shock[]>();
    for (const [code, shocks] of allShocks) {
      evalShocks.set(code, shocks.filter(s => s.barDate >= st.eval[0] && s.barDate <= st.eval[1]));
    }

    for (const opts of optsList) {
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
          if (sh.atrMult < 4) continue; // warn-severe：≥4×ATR
          const r = evaluateCombo(pair, lb, fb, followerShockDates, sh, opts);
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
        id: `${opts.confirm}|SL${opts.stopLoss}`,
        confirm: opts.confirm,
        stopLoss: opts.stopLoss,
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

  // ============ 输出 ============
  console.log('\n========== 双通道组合策略回测（方案A） ==========');
  console.log(`白名单传播对: ${PROPAGATION_WHITELIST.length} | 触发: ≥4×ATR | 最大持有: 10天`);
  console.log('------------------------------------------------------------------');
  console.log('按组合规则汇总（盈亏比 / 每笔期望% / 最大亏损%）:');
  console.log('组合                       | ALL PF   F1 PF   F2 PF   F3 PF | ALL每笔 F3每笔 | 最大亏损');
  console.log('---------------------------|-------------------------------|---------------|---------');
  const idOrder = [...new Set(results.map(r => r.id))];
  for (const id of idOrder) {
    const rows = results.filter(r => r.id === id);
    const pf = (s: string) => rows.find(r => r.stage === s)?.profitFactor.toFixed(2) ?? '-';
    const pt = (s: string) => rows.find(r => r.stage === s)?.perTradeAvg.toFixed(3) ?? '-';
    const ml = Math.min(...rows.map(r => r.maxLoss)).toFixed(2);
    console.log(
      `${id.padEnd(26)} | ${pf('ALL').padStart(5)}  ${pf('F1').padStart(5)}  ${pf('F2').padStart(5)}  ${pf('F3').padStart(5)} | ` +
      `${pt('ALL').padStart(6)} ${pt('F3').padStart(6)} | ${ml}`
    );
  }

  // 明细（准确率/均盈均亏）
  console.log('\n------------------------------------------------------------------');
  console.log('明细（预警/准确率/盈亏比/均盈/均亏/最大亏损）:');
  for (const r of results) {
    console.log(
      `${r.id} ${r.stage} (${r.period}): 预警${r.warnings} 准确率${r.accuracy.toFixed(1)}% | PF ${r.profitFactor.toFixed(2)} | ` +
      `每笔${r.perTradeAvg.toFixed(3)}% | 均盈${r.avgWin.toFixed(2)}% 均亏${r.avgLose.toFixed(2)}% | 最大亏${r.maxLoss.toFixed(2)}%`
    );
  }

  // ============ 保存 JSON ============
  const outPath = join(__dirname, '../data/combinedStrategyResult.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });