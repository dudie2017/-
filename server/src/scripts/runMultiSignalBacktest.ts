/**
 * 多信号融合回测 v14（对齐 v13 逻辑）
 * 
 * 与 v13 完全对齐的回测引擎，新增信号过滤器：
 * - S2: V16 Gate 级别过滤（冲击日 ATR 倍数 ≥ 阈值）
 * - S3: 事件驱动过滤（冲击日 ±N 天内有黑天鹅事件涉及该品种）
 * - S4: 成交量确认（冲击日 vol > 20日均量）
 * 
 * 基线 = v13 最优：ATR4 + H20 + 高波动 + SL0.01 + next1 + 白名单 + lag=2
 * 
 * 组合：11 组（基线 + 10 种叠加）
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { PROPAGATION_WHITELIST, type WhitelistPair } from '../data/propagationWhitelist.js';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null }

// ============ 数据加载（与 v13 完全一致） ============

function loadVariety(code: string): Bar[] {
  const filePath = join(__dirname, '../../data-cache-daily-20y', `${code}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const bars: Bar[] = (Array.isArray(raw) ? raw : raw.bars || []).map((b: any) => ({
    date: b.date, o: b.o ?? b.open, h: b.h ?? b.high, l: b.l ?? b.low,
    c: b.c ?? b.close, vol: b.vol ?? b.volume ?? 0, hold: b.hold ?? b.oi ?? 0,
    ret: b.ret ?? null,
  }));
  bars.sort((a, b) => a.date.localeCompare(b.date));
  // 填充 ret
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].ret === null || bars[i].ret === undefined) {
      bars[i].ret = bars[i - 1].c !== 0 ? (bars[i].c - bars[i - 1].c) / bars[i - 1].c : 0;
    }
  }
  return bars;
}

// ============ 冲击检测（与 v13 一致） ============

interface Shock { barDate: string; dir: 'up' | 'down'; atrMult: number; atrRatio: number; barIdx: number }

function detectShocks(bars: Bar[], minAtrMult: number): Shock[] {
  const shocks: Shock[] = [];
  for (let i = 20; i < bars.length; i++) {
    // ATR14
    let atrSum = 0;
    for (let j = i - 13; j <= i; j++) {
      const tr = Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
      atrSum += tr;
    }
    const atr = atrSum / 14;
    if (atr <= 0) continue;
    const ret = bars[i].c - bars[i - 1].c;
    const mult = Math.abs(ret) / atr;
    if (mult >= minAtrMult) {
      // ATR14 / ATR60 比率
      let atr60Sum = 0;
      for (let j = i - 59; j <= i; j++) {
        const tr = Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
        atr60Sum += tr;
      }
      const atr60 = atr60Sum / 60;
      const atrRatio = atr60 > 0 ? atr / atr60 : 1;
      shocks.push({ barDate: bars[i].date, dir: ret > 0 ? 'up' : 'down', atrMult: mult, atrRatio, barIdx: i });
    }
  }
  return shocks;
}

// ============ 信号过滤器 ============

/** S2: V16 Gate 级别过滤（简化版：用 ATR 倍数近似） */
function passV16Filter(shock: Shock, minGrade: number): boolean {
  // ATR4+ ≈ L2+, ATR5+ ≈ L3+, ATR6+ ≈ L4
  if (minGrade <= 2) return shock.atrMult >= 4;
  if (minGrade <= 3) return shock.atrMult >= 5;
  return shock.atrMult >= 6;
}

/** S3: 事件驱动过滤（冲击日 ±N 天内有黑天鹅事件涉及该品种） */
function passEventFilter(varietyCode: string, shockDate: string, windowDays: number): boolean {
  const shockTime = new Date(shockDate).getTime();
  for (const event of BLACK_SWAN_EVENTS) {
    if (!event.varieties.includes(varietyCode)) continue;
    const eventTime = new Date(event.date).getTime();
    const diffDays = Math.abs(eventTime - shockTime) / (1000 * 60 * 60 * 24);
    if (diffDays <= windowDays) return true;
  }
  return false;
}

/** S4: 成交量确认（冲击日 vol > 20日均量） */
function passVolumeFilter(bars: Bar[], barIdx: number): boolean {
  if (barIdx < 20) return false;
  let volSum = 0;
  for (let j = barIdx - 19; j <= barIdx; j++) {
    volSum += bars[j].vol;
  }
  const volMA = volSum / 20;
  return bars[barIdx].vol > volMA;
}

// ============ 交易评估（与 v13 evaluateTrade 完全一致） ============

interface TradeResult { warnings: number; correct: number; pnl: number; maxLoss: number; date: string }

function evaluateTrade(
  pair: WhitelistPair,
  lb: Bar[],  // leader bars
  fb: Bar[],  // follower bars
  sh: Shock,
  opts: {
    maxHold: number;
    stopLoss: number;
    useV16Filter: boolean;
    minV16Grade: number;
    useEventFilter: boolean;
    eventWindow: number;
    useVolumeFilter: boolean;
    leaderCode: string;
  }
): TradeResult {
  const lIdx = sh.barIdx;

  // S2: V16 过滤
  if (opts.useV16Filter && !passV16Filter(sh, opts.minV16Grade)) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0, date: sh.barDate };
  }

  // S3: 事件过滤
  if (opts.useEventFilter && !passEventFilter(opts.leaderCode, sh.barDate, opts.eventWindow)) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0, date: sh.barDate };
  }

  // S4: 成交量过滤
  if (opts.useVolumeFilter && !passVolumeFilter(lb, lIdx)) {
    return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0, date: sh.barDate };
  }

  // next1 确认（与 v13 一致）
  const nextRet = lb[lIdx + 1]?.ret ?? 0;
  const next1Ok = sh.dir === 'up' ? nextRet > 0 : nextRet < 0;
  if (!next1Ok) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0, date: sh.barDate };

  const effDir = sh.dir;

  // follower 入场（lag=2，与 v13 一致）
  const leadDate = sh.barDate;
  const fStart = fb.findIndex(b => b.date > leadDate);
  if (fStart < 0) return { warnings: 0, correct: 0, pnl: 0, maxLoss: 0, date: sh.barDate };

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
  return { warnings: 1, correct, pnl: finalPnl * 100, maxLoss: Math.min(0, finalPnl * 100), date: sh.barDate };
}

// ============ 主流程 ============

interface SignalConfig {
  name: string;
  atrMult: number;
  maxHold: number;
  stopLoss: number;
  useHighVolFilter: boolean;
  useV16Filter: boolean;
  minV16Grade: number;
  useEventFilter: boolean;
  eventWindow: number;
  useVolumeFilter: boolean;
}

async function main() {
  console.log('=== 多信号融合回测 v14（对齐 v13 逻辑） ===\n');

  // 加载白名单中涉及的所有品种
  const varietyCodes = new Set<string>();
  for (const pair of PROPAGATION_WHITELIST) {
    varietyCodes.add(pair.leader);
    varietyCodes.add(pair.follower);
  }
  console.log(`加载 ${varietyCodes.size} 个品种数据...`);

  const barsMap = new Map<string, Bar[]>();
  for (const code of varietyCodes) {
    const bars = loadVariety(code);
    if (bars.length > 0) barsMap.set(code, bars);
  }
  console.log(`成功加载 ${barsMap.size} 个品种\n`);

  // 预计算每个 leader 的冲击（ATR4+）
  const leaderShocks = new Map<string, Shock[]>();
  for (const pair of PROPAGATION_WHITELIST) {
    if (!leaderShocks.has(pair.leader)) {
      const lb = barsMap.get(pair.leader);
      if (lb && lb.length > 100) {
        leaderShocks.set(pair.leader, detectShocks(lb, 4)); // ATR4+ 基线
      }
    }
  }

  // 定义 11 组组合
  const configs: SignalConfig[] = [
    { name: 'S1(基线=v13)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: false, eventWindow: 0, useVolumeFilter: false },
    { name: 'S1+S2(L3)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: true, minV16Grade: 3, useEventFilter: false, eventWindow: 0, useVolumeFilter: false },
    { name: 'S1+S2(L4)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: true, minV16Grade: 4, useEventFilter: false, eventWindow: 0, useVolumeFilter: false },
    { name: 'S1+S3(±3d)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: true, eventWindow: 3, useVolumeFilter: false },
    { name: 'S1+S3(±5d)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: true, eventWindow: 5, useVolumeFilter: false },
    { name: 'S1+S3(±7d)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: true, eventWindow: 7, useVolumeFilter: false },
    { name: 'S1+S4', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: false, eventWindow: 0, useVolumeFilter: true },
    { name: 'S1+S2(L3)+S3(±5d)', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: true, minV16Grade: 3, useEventFilter: true, eventWindow: 5, useVolumeFilter: false },
    { name: 'S1+S2(L3)+S4', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: true, minV16Grade: 3, useEventFilter: false, eventWindow: 0, useVolumeFilter: true },
    { name: 'S1+S3(±5d)+S4', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: false, minV16Grade: 0, useEventFilter: true, eventWindow: 5, useVolumeFilter: true },
    { name: 'S1+S2+S3+S4', atrMult: 4, maxHold: 20, stopLoss: 0.01, useHighVolFilter: true, useV16Filter: true, minV16Grade: 3, useEventFilter: true, eventWindow: 5, useVolumeFilter: true },
  ];

  // 时段划分（与 v13 一致）
  const allDates: string[] = [];
  for (const bars of barsMap.values()) {
    for (const b of bars) allDates.push(b.date);
  }
  allDates.sort();
  const minDate = allDates[0];
  const maxDate = allDates[allDates.length - 1];
  const minY = parseInt(minDate.slice(0, 4));
  const maxY = parseInt(maxDate.slice(0, 4));
  const midY1 = minY + Math.floor((maxY - minY) / 3);
  const midY2 = minY + Math.floor((maxY - minY) * 2 / 3);

  const stages = [
    { name: 'ALL', start: minDate, end: maxDate },
    { name: 'F1', start: minDate, end: `${midY1}-12-31` },
    { name: 'F2', start: `${midY1 + 1}-01-01`, end: `${midY2}-12-31` },
    { name: 'F3', start: `${midY2 + 1}-01-01`, end: maxDate },
  ];

  console.log(`时段: ALL=${minDate}~${maxDate}`);
  console.log(`  F1=${minDate}~${midY1}-12-31`);
  console.log(`  F2=${midY1 + 1}-01-01~${midY2}-12-31`);
  console.log(`  F3=${midY2 + 1}-01-01~${maxDate}\n`);

  const results: any[] = [];

  for (const config of configs) {
    const stageResults: Record<string, { warnings: number; correct: number; sumWin: number; sumLose: number; maxLoss: number; trades: number }> = {};
    for (const s of stages) {
      stageResults[s.name] = { warnings: 0, correct: 0, sumWin: 0, sumLose: 0, maxLoss: 0, trades: 0 };
    }

    // 对每个白名单对回测
    for (const pair of PROPAGATION_WHITELIST) {
      const lb = barsMap.get(pair.leader);
      const fb = barsMap.get(pair.follower);
      if (!lb || !fb || lb.length < 100 || fb.length < 100) continue;

      const shocks = leaderShocks.get(pair.leader) || [];

      for (const stage of stages) {
        const periodShocks = shocks.filter(sh =>
          sh.barDate >= stage.start && sh.barDate <= stage.end
        );

        for (const sh of periodShocks) {
          // 高波动过滤（基线条件）
          if (config.useHighVolFilter && sh.atrRatio < 1.0) continue;

          const r = evaluateTrade(pair, lb, fb, sh, {
            maxHold: config.maxHold,
            stopLoss: config.stopLoss,
            useV16Filter: config.useV16Filter,
            minV16Grade: config.minV16Grade,
            useEventFilter: config.useEventFilter,
            eventWindow: config.eventWindow,
            useVolumeFilter: config.useVolumeFilter,
            leaderCode: pair.leader,
          });

          if (r.warnings === 0) continue;

          const sr = stageResults[stage.name];
          sr.warnings += r.warnings;
          sr.correct += r.correct;
          sr.trades++;
          if (r.correct === 1) sr.sumWin += r.pnl;
          else { sr.sumLose += Math.abs(r.pnl); sr.maxLoss = Math.min(sr.maxLoss, r.pnl); }
        }
      }
    }

    // 计算指标
    const allSR = stageResults['ALL'];
    const pf = allSR.sumLose > 0 ? allSR.sumWin / allSR.sumLose : (allSR.sumWin > 0 ? 999 : 0);
    const winRate = allSR.warnings > 0 ? allSR.correct / allSR.warnings : 0;

    const row: any = {
      name: config.name,
      signalCount: allSR.warnings,
      ALL_PF: pf,
      ALL_WinRate: winRate,
      ALL_MaxLoss: allSR.maxLoss,
      F1_PF: 0, F2_PF: 0, F3_PF: 0,
    };

    for (const sName of ['F1', 'F2', 'F3']) {
      const sr = stageResults[sName];
      const sPF = sr.sumLose > 0 ? sr.sumWin / sr.sumLose : (sr.sumWin > 0 ? 999 : 0);
      row[`${sName}_PF`] = sPF;
      row[`${sName}_Signals`] = sr.warnings;
    }

    results.push(row);
  }

  // 输出结果
  console.log('========== 多信号融合回测 v14 ==========');
  console.log('白名单: 39 对 | next1确认 | lag=2 | 高波动过滤 | SL0.01');
  console.log('====================================================================================');
  console.log('排名 | 组合                          | ALL PF   F1 PF   F2 PF   F3 PF | 信号  胜率   | 最大亏损');
  console.log('-----|-------------------------------|-------------------------------|--------------|---------');

  const sorted = [...results].sort((a, b) => b.ALL_PF - a.ALL_PF);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const robust = r.F1_PF >= 1.5 && r.F2_PF >= 1.5 && r.F3_PF >= 1.5 ? '✅强稳健' :
                   (r.F1_PF >= 1.0 && r.F2_PF >= 1.0 ? '⚠️弱稳健' : '❌不稳健');
    console.log(
      `#${String(i + 1).padStart(2)} | ${r.name.padEnd(30)}| ${r.ALL_PF.toFixed(2).padStart(7)} ${r.F1_PF.toFixed(2).padStart(7)} ${r.F2_PF.toFixed(2).padStart(7)} ${r.F3_PF.toFixed(2).padStart(7)} | ${String(r.signalCount).padStart(3)} ${(r.ALL_WinRate * 100).toFixed(1).padStart(5)}% | ${r.ALL_MaxLoss.toFixed(2).padStart(7)} | ${robust}`
    );
  }

  // 保存结果
  const outputPath = join(__dirname, '../data/multiSignalResult.json');
  writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

main().catch(console.error);
