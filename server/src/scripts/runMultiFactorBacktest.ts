/**
 * 多因子全排列回测（v13）
 * 运行：npx tsx src/scripts/runMultiFactorBacktest.ts
 * 输出：src/data/multiFactorResult.json + 控制台
 *
 * 目标：在 v10 基线（next1+白名单+SL1）之上，穷举所有可调因子组合，
 *       用 20 年全周期 + 3 组滚动前向筛选最优参数。
 *
 * 因子矩阵：
 *   atrMult:    [3, 4, 5, 6]           — 冲击门槛（×ATR）
 *   maxHold:    [3, 5, 7, 10, 15, 20]  — 最大持有天数
 *   volConfirm: [false, true]           — 成交量确认（冲击日vol > 20日均量）
 *   volRegime:  [any, high, low]        — 波动率状态（ATR14 vs ATR60）
 *   stopLoss:   [0, 0.01, 0.02, 0.03]  — 止损比例
 *
 * 总计：4 × 6 × 2 × 3 × 4 = 576 组合 × 4 时段 = 2304 评估
 * 固定：next1确认 + 白名单39对 + lag=2
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

/** 成交量 MA20 */
function computeVolMA(bars: Bar[], i: number, period = 20): number {
  if (i < period) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    sum += bars[k].vol;
  }
  return sum / period;
}

interface Shock {
  code: string;
  barDate: string;
  barIdx: number;
  atrMult: number;
  dir: 'up' | 'down';
  dayRetPct: number;
  sector: string;
  volRatio: number;   // vol / volMA20
  atrRatio: number;   // ATR14 / ATR60 (>1 = 波动放大, <1 = 波动收缩)
}

function detectShocks(bars: Bar[], code: string, threshold: number, sector: string): Shock[] {
  const shocks: Shock[] = [];
  for (let i = 60; i < bars.length; i++) {
    const atr14 = computeATR(bars, i, 14);
    const atr60 = computeATR(bars, i, 60);
    if (atr14 <= 0) continue;
    const ret = bars[i].ret ?? 0;
    const atrMult = Math.abs(ret) / (atr14 / bars[i - 1].c);
    if (atrMult >= threshold) {
      const volMA = computeVolMA(bars, i, 20);
      const volRatio = volMA > 0 ? bars[i].vol / volMA : 1;
      const atrRatio = atr60 > 0 ? atr14 / atr60 : 1;
      shocks.push({
        code, barDate: bars[i].date, barIdx: i,
        atrMult, dir: ret > 0 ? 'up' : 'down',
        dayRetPct: ret * 100, sector,
        volRatio: Math.round(volRatio * 100) / 100,
        atrRatio: Math.round(atrRatio * 100) / 100,
      });
    }
  }
  return shocks;
}

// ============ 因子配置 ============
interface FactorConfig {
  atrMult: number;
  maxHold: number;
  volConfirm: boolean;
  volRegime: 'any' | 'high' | 'low';
  stopLoss: number;
}

interface FactorResult {
  id: string;
  atrMult: number;
  maxHold: number;
  volConfirm: boolean;
  volRegime: string;
  stopLoss: number;
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

function evaluateTrade(
  pair: WhitelistPair,
  lb: Bar[],
  fb: Bar[],
  sh: Shock,
  opts: FactorConfig,
): { warnings: number; correct: number; pnl: number; maxLoss: number } {
  const lIdx = sh.barIdx;
  if (lIdx < 0 || lIdx >= lb.length - 1) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  // 成交量确认
  if (opts.volConfirm && sh.volRatio < 1.0) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };
  }

  // 波动率状态过滤
  if (opts.volRegime === 'high' && sh.atrRatio < 1.0) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };
  }
  if (opts.volRegime === 'low' && sh.atrRatio >= 1.0) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };
  }

  // next1 确认
  const nextRet = lb[lIdx + 1]?.ret ?? 0;
  const next1Ok = sh.dir === 'up' ? nextRet > 0 : nextRet < 0;
  if (!next1Ok) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  const effDir = sh.dir;

  // follower 入场
  const leadDate = sh.barDate;
  const fStart = fb.findIndex(b => b.date > leadDate);
  if (fStart < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0 };

  let afterRet = 0;
  let hitStopLoss = false;
  const maxLook = Math.min(fStart + 2 + opts.maxHold, fb.length); // lag=2

  for (let k = fStart; k < maxLook; k++) {
    const ret = fb[k]?.ret ?? 0;
    afterRet += ret;
    const pnl = effDir === 'up' ? afterRet : -afterRet;
    if (opts.stopLoss > 0 && pnl <= -opts.stopLoss) { hitStopLoss = true; break; }
  }

  const pnl = effDir === 'up' ? afterRet : -afterRet;
  const finalPnl = hitStopLoss ? -opts.stopLoss : pnl;
  const correct = finalPnl > 0 ? 1 : 0;
  return { warnings: 1, correct, pnl: finalPnl * 100, maxLoss: Math.min(0, finalPnl * 100) };
}

function configId(opts: FactorConfig): string {
  return `ATR${opts.atrMult}|H${opts.maxHold}|${opts.volConfirm ? 'VolY' : 'VolN'}|${opts.volRegime}|SL${opts.stopLoss}`;
}

async function main() {
  // 1. 加载数据
  const leaderSet = new Set(PROPAGATION_WHITELIST.map(p => p.leader));
  const followerSet = new Set(PROPAGATION_WHITELIST.map(p => p.follower));
  const allCodes = new Set([...leaderSet, ...followerSet]);

  const allBars = new Map<string, Bar[]>();
  for (const code of allCodes) {
    const bars = loadVarietyBars(code);
    if (bars.length > 0) allBars.set(code, bars);
  }
  console.log(`加载品种: ${allBars.size} 个`);

  // 2. 预计算所有冲击（最低门槛 3×ATR，后续按因子过滤）
  const leaderSectorMap = new Map<string, string[]>();
  for (const p of PROPAGATION_WHITELIST) {
    if (!leaderSectorMap.has(p.leader)) leaderSectorMap.set(p.leader, []);
    const sectors = leaderSectorMap.get(p.leader)!;
    if (!sectors.includes(p.sector)) sectors.push(p.sector);
  }

  const allShocks = new Map<string, Shock[]>();
  for (const code of leaderSet) {
    const bars = allBars.get(code);
    if (!bars) continue;
    const sectors = leaderSectorMap.get(code) || ['未知'];
    for (const sector of sectors) {
      const shocks = detectShocks(bars, code, 3, sector);
      if (!allShocks.has(code)) allShocks.set(code, []);
      const existing = allShocks.get(code)!;
      for (const sh of shocks) {
        if (!existing.find(e => e.barDate === sh.barDate && e.sector === sh.sector)) existing.push(sh);
      }
    }
  }

  let totalShocks = 0;
  for (const [, shocks] of allShocks) totalShocks += shocks.length;
  console.log(`检测到冲击事件: ${totalShocks} 个 (≥3×ATR)`);

  // 3. 因子矩阵
  const atrMults = [3, 4, 5, 6];
  const maxHolds = [3, 5, 7, 10, 15, 20];
  const volConfirms = [false, true];
  const volRegimes: Array<'any' | 'high' | 'low'> = ['any', 'high', 'low'];
  const stopLosses = [0, 0.01, 0.02, 0.03];

  const totalCombos = atrMults.length * maxHolds.length * volConfirms.length * volRegimes.length * stopLosses.length;
  console.log(`因子组合: ${totalCombos} 种 × 4 时段 = ${totalCombos * 4} 评估`);

  // 4. 时段
  const stages: Array<{ id: string; eval: [string, string] }> = [
    { id: 'ALL', eval: ['2006-01-01', '2025-12-31'] },
    { id: 'F1', eval: ['2011-01-01', '2015-12-31'] },
    { id: 'F2', eval: ['2016-01-01', '2020-12-31'] },
    { id: 'F3', eval: ['2021-01-01', '2025-12-31'] },
  ];

  const results: FactorResult[] = [];
  let evaluated = 0;

  for (const atrMult of atrMults) {
    for (const maxHold of maxHolds) {
      for (const volConfirm of volConfirms) {
        for (const volRegime of volRegimes) {
          for (const stopLoss of stopLosses) {
            const opts: FactorConfig = { atrMult, maxHold, volConfirm, volRegime, stopLoss };
            const id = configId(opts);

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
                const periodShocks = leaderShocks.filter(s =>
                  s.barDate >= st.eval[0] && s.barDate <= st.eval[1] &&
                  s.sector === pair.sector &&
                  s.atrMult >= opts.atrMult
                );

                for (const sh of periodShocks) {
                  const r = evaluateTrade(pair, lb, fb, sh, opts);
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
                id, atrMult, maxHold, volConfirm, volRegime, stopLoss,
                stage: st.id,
                period: `${st.eval[0].slice(0, 4)}-${st.eval[1].slice(0, 4)}`,
                warnings, correct,
                accuracy: accuracy * 100,
                profitFactor, perTradeAvg, avgWin, avgLose, maxLoss,
                winTrades, loseTrades,
              });
              evaluated++;
            }
          }
        }
      }
    }
  }
  console.log(`评估完成: ${evaluated} 次`);

  // ============ 输出 Top 30 ============
  // 筛选：ALL 阶段信号数 ≥ 5（统计显著性）
  const allResults = results.filter(r => r.stage === 'ALL' && r.warnings >= 5);
  allResults.sort((a, b) => b.profitFactor - a.profitFactor);

  console.log('\n========== 多因子全排列回测（v13） ==========');
  console.log(`白名单: ${PROPAGATION_WHITELIST.length} 对 | next1确认 | lag=2 | 时段: 20年+3组前向`);
  console.log(`因子: atrMult[${atrMults}] × maxHold[${maxHolds}] × volConfirm[${volConfirms}] × volRegime[${volRegimes}] × stopLoss[${stopLosses}]`);
  console.log(`有效组合（ALL信号≥5）: ${allResults.length} / ${totalCombos}`);
  console.log('====================================================================================');
  console.log('排名 | 组合ID                                    | ALL PF   F1 PF   F2 PF   F3 PF | 信号  胜率   每笔    | 最大亏损');
  console.log('-----|-------------------------------------------|-------------------------------|----------------------|---------');

  const top30 = allResults.slice(0, 30);
  for (let i = 0; i < top30.length; i++) {
    const r = top30[i];
    const f1 = results.find(x => x.id === r.id && x.stage === 'F1');
    const f2 = results.find(x => x.id === r.id && x.stage === 'F2');
    const f3 = results.find(x => x.id === r.id && x.stage === 'F3');
    const f1pf = f1 ? f1.profitFactor.toFixed(2) : '-';
    const f2pf = f2 ? f2.profitFactor.toFixed(2) : '-';
    const f3pf = f3 ? f3.profitFactor.toFixed(2) : '-';
    console.log(
      `${String(i + 1).padStart(3)}  | ${r.id.padEnd(41)} | ${r.profitFactor.toFixed(2).padStart(5)}  ${f1pf.padStart(5)}  ${f2pf.padStart(5)}  ${f3pf.padStart(5)} | ` +
      `${String(r.warnings).padStart(4)} ${r.accuracy.toFixed(1).padStart(5)}% ${r.perTradeAvg.toFixed(3).padStart(7)}% | ${r.maxLoss.toFixed(2)}`
    );
  }

  // ============ 稳健性判定 Top 10 ============
  console.log('\n----------------------------------------------------------------------');
  console.log('Top 10 稳健性判定:');
  const top10 = allResults.slice(0, 10);
  for (let i = 0; i < top10.length; i++) {
    const r = top10[i];
    const f1 = results.find(x => x.id === r.id && x.stage === 'F1');
    const f2 = results.find(x => x.id === r.id && x.stage === 'F2');
    const f3 = results.find(x => x.id === r.id && x.stage === 'F3');
    const f1pf = f1?.profitFactor ?? 0;
    const f2pf = f2?.profitFactor ?? 0;
    const f3pf = f3?.profitFactor ?? 0;

    let verdict = '';
    if (f1pf > 1.5 && f2pf > 1.5 && f3pf > 1.5) verdict = '✅ 强稳健';
    else if (f1pf > 1.0 && f2pf > 1.0 && f3pf > 1.0) verdict = '🟡 弱稳健';
    else if (f1pf > 0 && f2pf > 0 && f3pf > 0) verdict = '🟠 边缘稳健';
    else verdict = '❌ 不稳健';

    console.log(`  #${i + 1} ${r.id.padEnd(41)} PF=${r.profitFactor.toFixed(2)} F1=${f1pf.toFixed(2)} F2=${f2pf.toFixed(2)} F3=${f3pf.toFixed(2)} | ${verdict}`);
  }

  // ============ 单因子分析（各因子独立影响） ============
  console.log('\n----------------------------------------------------------------------');
  console.log('单因子影响分析（固定其他因子为v10默认值: ATR4+H10+VolN+any+SL0.01）:');

  // 固定其他因子，只变一个
  const baseCfg = { volConfirm: false, volRegime: 'any' as const, stopLoss: 0.01 };

  // atrMult 影响
  console.log('\n  冲击门槛（atrMult）:');
  for (const am of atrMults) {
    const id = `ATR${am}|H10|VolN|any|SL0.01`;
    const r = results.find(x => x.id === id && x.stage === 'ALL');
    if (r) {
      const f1 = results.find(x => x.id === id && x.stage === 'F1');
      const f2 = results.find(x => x.id === id && x.stage === 'F2');
      const f3 = results.find(x => x.id === id && x.stage === 'F3');
      console.log(`    ATR${am}: PF=${r.profitFactor.toFixed(2)} 信号${r.warnings} 胜率${r.accuracy.toFixed(1)}% | F1=${f1?.profitFactor.toFixed(2)} F2=${f2?.profitFactor.toFixed(2)} F3=${f3?.profitFactor.toFixed(2)}`);
    }
  }

  // maxHold 影响
  console.log('\n  持有期（maxHold）:');
  for (const mh of maxHolds) {
    const id = `ATR4|H${mh}|VolN|any|SL0.01`;
    const r = results.find(x => x.id === id && x.stage === 'ALL');
    if (r) {
      const f1 = results.find(x => x.id === id && x.stage === 'F1');
      const f2 = results.find(x => x.id === id && x.stage === 'F2');
      const f3 = results.find(x => x.id === id && x.stage === 'F3');
      console.log(`    H${mh}天: PF=${r.profitFactor.toFixed(2)} 信号${r.warnings} 胜率${r.accuracy.toFixed(1)}% | F1=${f1?.profitFactor.toFixed(2)} F2=${f2?.profitFactor.toFixed(2)} F3=${f3?.profitFactor.toFixed(2)}`);
    }
  }

  // stopLoss 影响
  console.log('\n  止损（stopLoss）:');
  for (const sl of stopLosses) {
    const id = `ATR4|H10|VolN|any|SL${sl}`;
    const r = results.find(x => x.id === id && x.stage === 'ALL');
    if (r) {
      const f1 = results.find(x => x.id === id && x.stage === 'F1');
      const f2 = results.find(x => x.id === id && x.stage === 'F2');
      const f3 = results.find(x => x.id === id && x.stage === 'F3');
      console.log(`    SL${sl}: PF=${r.profitFactor.toFixed(2)} 信号${r.warnings} 胜率${r.accuracy.toFixed(1)}% | F1=${f1?.profitFactor.toFixed(2)} F2=${f2?.profitFactor.toFixed(2)} F3=${f3?.profitFactor.toFixed(2)}`);
    }
  }

  // volConfirm 影响
  console.log('\n  成交量确认（volConfirm）:');
  for (const vc of volConfirms) {
    const id = `ATR4|H10|${vc ? 'VolY' : 'VolN'}|any|SL0.01`;
    const r = results.find(x => x.id === id && x.stage === 'ALL');
    if (r) {
      const f1 = results.find(x => x.id === id && x.stage === 'F1');
      const f2 = results.find(x => x.id === id && x.stage === 'F2');
      const f3 = results.find(x => x.id === id && x.stage === 'F3');
      console.log(`    ${vc ? '需要放量' : '无要求'}: PF=${r.profitFactor.toFixed(2)} 信号${r.warnings} 胜率${r.accuracy.toFixed(1)}% | F1=${f1?.profitFactor.toFixed(2)} F2=${f2?.profitFactor.toFixed(2)} F3=${f3?.profitFactor.toFixed(2)}`);
    }
  }

  // volRegime 影响
  console.log('\n  波动率状态（volRegime）:');
  for (const vr of volRegimes) {
    const id = `ATR4|H10|VolN|${vr}|SL0.01`;
    const r = results.find(x => x.id === id && x.stage === 'ALL');
    if (r) {
      const f1 = results.find(x => x.id === id && x.stage === 'F1');
      const f2 = results.find(x => x.id === id && x.stage === 'F2');
      const f3 = results.find(x => x.id === id && x.stage === 'F3');
      const label = vr === 'any' ? '不限' : vr === 'high' ? '高波动(ATR14>ATR60)' : '低波动(ATR14<ATR60)';
      console.log(`    ${label}: PF=${r.profitFactor.toFixed(2)} 信号${r.warnings} 胜率${r.accuracy.toFixed(1)}% | F1=${f1?.profitFactor.toFixed(2)} F2=${f2?.profitFactor.toFixed(2)} F3=${f3?.profitFactor.toFixed(2)}`);
    }
  }

  // ============ 保存 JSON ============
  const outPath = join(__dirname, '../data/multiFactorResult.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
