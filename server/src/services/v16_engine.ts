/**
 * Brooks V16.2 信号驱动扫描引擎
 * 
 * 决策链: full_scan → extract_v16_2_data → build_v16_2_tradable
 *   P(顺)≥0.45 → Gate4≥3/5 → 楔形reversal过滤 → CH豁免 → 方向阵营GREEN → tradable
 * 
 * 核心原则: 信号驱动(二元判断) 替代 评分驱动(0-100分→阈值)
 */

import { type BarData, VARIETIES, isEnabledVariety } from './varieties.js';
import { calcEMA, calcATR, calcADX, detectII, detectIOI, countTrendBars } from './indicators.js';
import {
  calcDirectionalProbability,
  evaluateGate4,
  evaluateWedgeFilter,
  detectCHSignal,
  calcMMMeasurement,
  calcDirectionCamp,
  backtestSignalPerformance,
  calcEdgeGrade,
  detectFinalFlag,
  generateOneLiner,
  fmtPrice,
  type Gate4Config,
} from './v16_signalLogic.js';
import { getVarietyData, getVarietyDataAsOf, fetchMTFData, detectMainContract } from './dataFetcher.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getActiveTrendTracking, startTrendTracking, endTrendTracking } from './database.js';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams.js';
import { LONG_OPT_PARAMS } from '../data/longOptParams.js';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams.js';
import { TOP1_UNIFIED_PARAMS, type UnifiedRecipe } from '../data/top1UnifiedParams.js';
import { LONG_DISABLED } from '../data/longDisabledVarieties.js';
import { SHORT_DISABLED } from '../data/shortDisabledVarieties.js';
import type { V16Row, V16ScanResult, DirectionCampResult } from './v16_types.js';

// 保持原有对外导出接口不变
export type { Gate4Config };
export { calcDirectionCamp, backtestSignalPerformance, generateOneLiner };

// ===== 常数 =====
const P_THRESHOLD = 0.45;        // P(顺)阈值
const TREND_ADX_THRESHOLD = 25;  // 弱趋势ADX阈值


/** 单方向交易参数（做多/做空共用结构） */
type SideParams = { stopAtrMult?: number; targetAtrMult?: number; maxHoldDays?: number; cooldownBars?: number; trendFilter?: boolean; minSignalGrade?: string };

// 从 TOP1 完整配方映射出单方向交易参数（stop/target/hold/cooldown/trendFilter/minSignalGrade）
function top1ToSideParams(recipe: UnifiedRecipe): SideParams {
  return {
    stopAtrMult: recipe.stopAtrMult,
    targetAtrMult: recipe.targetAtrMult,
    maxHoldDays: recipe.maxHoldDays,
    cooldownBars: recipe.cooldownBars,
    trendFilter: recipe.trendFilter,
    minSignalGrade: recipe.minSignalGrade,
  };
}

// 做多参数：优先 TOP1 完整配方（longOnly/both 允许做多），split 回退生产参数，shortOnly 禁用做多
function getLongParams(code: string): SideParams | null {
  const top1 = TOP1_UNIFIED_PARAMS[code];
  if (top1) {
    if (top1.directionMode === 'longOnly' || top1.directionMode === 'both') return top1ToSideParams(top1);
    if (top1.directionMode === 'shortOnly') return null;
    // split：分方向沿用生产寻优参数
  }
  return LONG_REFINED_PARAMS[code] ?? LONG_OPT_PARAMS[code] ?? null;
}

// 做空参数：优先 TOP1 完整配方（shortOnly/both 允许做空），split 回退生产参数，longOnly 禁用做空
function getShortParams(code: string): SideParams | null {
  const top1 = TOP1_UNIFIED_PARAMS[code];
  if (top1) {
    if (top1.directionMode === 'shortOnly' || top1.directionMode === 'both') return top1ToSideParams(top1);
    if (top1.directionMode === 'longOnly') return null;
    // split：分方向沿用生产寻优参数
  }
  return SHORT_OPT_PARAMS[code] ?? null;
}

export function generateAdvice(row: V16Row): string {
  const kl = row.key_levels;
  const g4 = row.g4_reason_count;
  const tips: string[] = [];

  // —— 不可交易 / 观望品种：说明原因 + 触发条件 ——
  if (row.trade_worthiness !== 'tradable' || !row.g4_pass) {
    const reasons: string[] = [];
    if (row.wedge_filter_on) reasons.push('楔形形态未突破');
    if (g4 < 3) reasons.push(`Gate4仅${g4}/5`);
    if (row.edge_grade === 'D') reasons.push('Edge评级D');
    if (row.lc_stage && /末期|衰竭/.test(row.lc_stage)) reasons.push(`生命周期${row.lc_stage}`);
    const head = reasons.length
      ? `暂不建议入场（${reasons.join('、')}）`
      : '暂不建议入场（信号条件不充分）';
    const klHint =
      kl?.resistance && kl?.support
        ? `等待价格突破 ${fmtPrice(kl.resistance)} 再考虑做多，或跌破 ${fmtPrice(kl.support)} 再考虑做空`
        : null;
    return [head, klHint].filter(Boolean).join('。') + '。';
  }

  // —— 可交易品种：方向 + 入场/止损/目标 ——
  // 方向一致性校验：MM测距方向与AI方向一致时才引用MM目标，否则用关键位/ATR推算
  const atr = row.atr14 || 0;
  const dir = row.ai_direction;
  // 做多方向禁用（砍腿）：与决策链一致，禁用品种只提示做空
  if (dir === '多' && LONG_DISABLED.has(row.code)) {
    return '该品种做多方向已禁用（仅做空）。' + (kl?.support ? `若跌破 ${fmtPrice(kl.support)} 可考虑做空。` : '');
  }
  // 做空方向禁用（砍腿）：回测做空捕获极低（如黄金 30% vs 做多 283%），禁用品种只提示做多
  if (dir === '空' && SHORT_DISABLED.has(row.code)) {
    return '该品种做空方向已禁用（仅做多）。' + (kl?.resistance ? `若突破 ${fmtPrice(kl.resistance)} 可考虑做多。` : '');
  }
  const mmSameDir = row.mm_found && row.mm_direction === dir;

  // 止损/目标 ATR 倍数：按品种×方向使用全品种寻优参数（二次寻优优先；如无配置回退默认 1.5/2.0）
  const longOpt = getLongParams(row.code);
  const shortOpt = getShortParams(row.code);
  const stopMult = dir === '多' ? (longOpt?.stopAtrMult ?? 1.5) : (shortOpt?.stopAtrMult ?? 1.5);
  const targetMult = dir === '多' ? (longOpt?.targetAtrMult ?? 2.0) : (shortOpt?.targetAtrMult ?? 2.0);

  // 价格关系修正工具：做多止损必须低于入场、目标必须高于入场；做空反之
  const validLongStop = (v?: number | null, entry?: number | null) =>
    v != null && entry != null && v < entry ? v : null;
  const validShortStop = (v?: number | null, entry?: number | null) =>
    v != null && entry != null && v > entry ? v : null;
  const validLongTarget = (v?: number | null, entry?: number | null) =>
    v != null && entry != null && v > entry ? v : null;
  const validShortTarget = (v?: number | null, entry?: number | null) =>
    v != null && entry != null && v < entry ? v : null;

  const sentences: string[] = [];
  if (dir === '多') {
    const entry = kl?.ema20 ?? kl?.support ?? row.close;
    let stop = validLongStop(kl?.support, entry) ?? validLongStop(kl?.prev_low, entry);
    if (stop == null && entry != null && atr > 0) stop = entry - atr * stopMult;
    let t1 = mmSameDir ? validLongTarget(row.mm_tier1, entry) : null;
    if (t1 == null) t1 = validLongTarget(row.ch_target, entry);
    if (t1 == null) t1 = validLongTarget(kl?.range_high_20, entry);
    if (t1 == null && entry != null && atr > 0) t1 = entry + atr * targetMult;
    const t2 = mmSameDir ? validLongTarget(row.mm_tier2, entry) : null;

    sentences.push('偏多思路');
    if (entry != null) sentences.push(`回踩 ${fmtPrice(entry)} 附近企稳可分批做多`);
    if (stop != null) sentences.push(`止损设在 ${fmtPrice(stop)} 下方`);
    if (t1 != null) sentences.push(`第一目标 ${fmtPrice(t1)}`);
    if (t2 != null) sentences.push(`第二目标 ${fmtPrice(t2)}`);
  } else if (dir === '空') {
    const entry = kl?.ema20 ?? kl?.resistance ?? row.close;
    let stop = validShortStop(kl?.resistance, entry) ?? validShortStop(kl?.prev_high, entry);
    if (stop == null && entry != null && atr > 0) stop = entry + atr * stopMult;
    let t1 = mmSameDir ? validShortTarget(row.mm_tier1, entry) : null;
    if (t1 == null) t1 = validShortTarget(row.ch_target, entry);
    if (t1 == null) t1 = validShortTarget(kl?.range_low_20, entry);
    if (t1 == null && entry != null && atr > 0) t1 = entry - atr * targetMult;
    const t2 = mmSameDir ? validShortTarget(row.mm_tier2, entry) : null;

    sentences.push('偏空思路');
    if (entry != null) sentences.push(`反弹至 ${fmtPrice(entry)} 附近滞涨可分批做空`);
    if (stop != null) sentences.push(`止损设在 ${fmtPrice(stop)} 上方`);
    if (t1 != null) sentences.push(`第一目标 ${fmtPrice(t1)}`);
    if (t2 != null) sentences.push(`第二目标 ${fmtPrice(t2)}`);
  } else {
    sentences.push('方向中性');
    if (kl?.support && kl?.resistance) {
      sentences.push(`可在 ${fmtPrice(kl.support)}~${fmtPrice(kl.resistance)} 区间内高抛低吸，突破区间再跟随`);
    }
  }

  // —— 质量与风险提示 ——
  if (row.p_follow >= 0.6) tips.push(`P(顺)${Math.round(row.p_follow * 100)}%，顺势胜率较高`);
  else if (row.p_follow > 0 && row.p_follow < 0.4) tips.push(`P(顺)仅${Math.round(row.p_follow * 100)}%，注意逆势风险`);
  if (row.ch_has_signal) tips.push(`CH通道${row.ch_direction === '多' ? '做多' : '做空'}信号（${row.ch_strength || '中'}）`);
  if (row.edge_grade === 'A') tips.push('Edge A级，可按正常仓位执行');
  else if (row.edge_grade === 'C') tips.push('Edge C级，建议减半仓位');
  if (row.wedge_filter_on) tips.push('楔形过滤生效中，谨防假突破');
  if (row.lc_stage && row.lc_stage !== '未知') tips.push(`生命周期处于${row.lc_stage}`);

  const main = sentences.join('，');
  return tips.length ? `${main}。【${tips.join('；')}】` : `${main}。`;
}

// ===== 9. 主力扫描: scanV16 =====
export interface ScanV16Opts {
  edgeLookback?: number;      // Edge统计窗口（默认70）
  allowRangeTrading?: boolean; // 是否允许区间市交易（默认false）
  gate4Config?: Gate4Config;   // Gate4实验配置
}

export function scanV16Variety(
  code: string,
  bars: BarData[],
  contract: string,
  opts?: ScanV16Opts,
): V16Row {
  const name = VARIETIES[code] || code;
  const len = bars.length;
  const lastBar = bars[len - 1];
  const prevBar = bars[len - 2];

  // 基础计算
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const adxResult = calcADX(bars, 14);
  const atr = calcATR(bars, 14);
  const atr14 = atr[len - 1];

  // 价格变动（日涨跌幅：最新收盘 vs 前一交易日结算价，与国内期货官方口径一致；结算价缺失时回退昨收盘）
  const prevBase = prevBar && prevBar.settle && prevBar.settle > 0 ? prevBar.settle : (prevBar?.c ?? 0);
  const retPct = prevBase > 0
    ? ((lastBar.c - prevBase) / prevBase) * 100
    : 0;

  // AI方向 (基于EMA排列+动量)
  const ema50 = calcEMA(closes, 50);
  const ema20Last = ema20[len - 1];
  const ema50Last = ema50[len - 1];
  let aiDirection = '中性';
  if (ema20Last > ema50Last && lastBar.c > ema20Last) aiDirection = '多';
  else if (ema20Last < ema50Last && lastBar.c < ema20Last) aiDirection = '空';
  else if (ema20Last > ema50Last) aiDirection = '多';
  else aiDirection = '空';

  // V18 频谱分类：7条件综合判定（替代ADX单维三元）
  const oiChangePct = bars[len - 1].hold && bars[len - 2].hold
    ? ((bars[len - 1].hold! - bars[len - 2].hold!) / bars[len - 2].hold!) * 100
    : 0;
  const priceChangePct = bars[len - 1].c && bars[len - 2].c
    ? ((bars[len - 1].c - bars[len - 2].c) / bars[len - 2].c) * 100
    : 0;
  const spectrumResult = classifySpectrumV18(bars, adxResult.adx, aiDirection, oiChangePct);
  const spectrum = spectrumResult.spectrum;
  const trendStrength = spectrumResult.trendStrength;
  const spectrumDetail = spectrumResult.spectrumDetail;

  // V18 量仓矩阵：6格分类
  const oiMatrix = classifyOIMatrix(oiChangePct, priceChangePct, aiDirection);
  const oiSignal = oiMatrix.oiSignal;

  // P1-⑤ V15/V18 混合频谱因子（趋势强度 × 频谱信心归一化 0-100）
  const spectrumScoreMap: Record<string, number> = { '趋势': 85, '通道': 60, '区间': 25, '趋势-紧通道': 90 };
  const spectrumConfidence = spectrumScoreMap[spectrum] || 40;
  const hybridFactor = Math.round((trendStrength * 0.6 + spectrumConfidence * 0.4) * 100) / 100;

  // P(顺)
  const dp = calcDirectionalProbability(bars, aiDirection, adxResult.adx, trendStrength, lastBar);

  // Gate4
  const g4 = evaluateGate4(bars, aiDirection, trendStrength, adxResult.adx, lastBar, oiChangePct, opts?.gate4Config);

  // 楔形过滤
  const wedge = evaluateWedgeFilter(bars, aiDirection);

  // CH通道信号
  const ch = detectCHSignal(bars);

  // MM测量
  const mm = calcMMMeasurement(bars);

  // P1-⑧: 目标位完成度剔除——若当前价已超过目标位，则该目标位已失效
  let mmTier1 = mm.tier1;
  let mmTier2 = mm.tier2;
  let mmTier3 = mm.tier3;
  if (mm.found) {
    if (mm.direction === '多') {
      if (mmTier1 !== null && lastBar.c >= mmTier1 * 1.005) mmTier1 = null;
      if (mmTier2 !== null && lastBar.c >= mmTier2 * 1.005) mmTier2 = null;
      if (mmTier3 !== null && lastBar.c >= mmTier3 * 1.005) mmTier3 = null;
    } else {
      if (mmTier1 !== null && lastBar.c <= mmTier1 * 0.995) mmTier1 = null;
      if (mmTier2 !== null && lastBar.c <= mmTier2 * 0.995) mmTier2 = null;
      if (mmTier3 !== null && lastBar.c <= mmTier3 * 0.995) mmTier3 = null;
    }
  }

  // Final Flag
  const ff = detectFinalFlag(bars);

  // Edge（基于历史信号棒回测统计，此前恒为 D 的摆设已修复）
  const signalPerf = backtestSignalPerformance(bars, opts?.edgeLookback ?? 70);
  const edge = calcEdgeGrade(signalPerf.winRate20, signalPerf.avgRR, signalPerf.sampleCount);

  // LC阶段
  const lcStage = len < 50 ? '初期' : len < 100 ? '成长期' : '成熟期';

  // Follow-Through
  const ftBars = countTrendBars(bars, 10);
  const ftCount = ftBars.bullBars + ftBars.bearBars;
  const fwRank = ftCount >= 8 ? 5 : ftCount >= 6 ? 4 : ftCount >= 4 ? 3 : ftCount >= 2 ? 2 : 1;
  const fwTypeCn = ftCount >= 8 ? '强FT' : ftCount >= 6 ? '中FT' : ftCount >= 4 ? '弱FT' : '无FT';

  // 纪律阶梯 (初始为0)
  const discLadder = 0;

  // 关键位标注 (真实K线计算)
  const keyLevels = calcKeyLevels(bars, ema20Last);
  const trendExhaustion = detectTrendExhaustion(bars, aiDirection, adxResult.adx);


  // 构建row（先不含V17分级，分级需要row本身，在runV16FullScan中后处理）
  const row: V16Row = {
    code, name, contract, close: lastBar.c, ret_pct: Math.round(retPct * 100) / 100,
    spectrum: spectrum, spectrum_detail: spectrumDetail, ai_direction: aiDirection, trend_strength: trendStrength, atr14, adx: adxResult.adx,
    ema20: ema20[len - 1], ema50: ema50[len - 1],
    p_follow: Math.round(dp.p_follow * 1000) / 1000,
    p_counter: Math.round(dp.p_counter * 1000) / 1000,
    market_context: dp.context,
    g4_pass: g4.passed, g4_reason_count: g4.reasonCount,
    g4_reasons_met: g4.reasons, g4_verdict: g4.verdict,
    ch_has_signal: ch.hasSignal, ch_direction: ch.direction,
    ch_entry: ch.entry, ch_stop: ch.stop, ch_target: ch.target, ch_strength: ch.strength,
    wedge_found: wedge.found, wedge_filter_on: wedge.isReversal,
    wedge_filtered_dir: wedge.filteredDir,
    mm_found: mm.found, mm_direction: mm.direction,
    mm_tier1: mmTier1, mm_tier2: mmTier2, mm_tier3: mmTier3,
    mm_variant_count: mm.variantCount,
    ff_found: ff.found, ff_label: ff.label,
    lc_stage: lcStage, fw_rank: fwRank, fw_type_cn: fwTypeCn,
    edge_status: edge.status, edge_grade: edge.grade,
    edge_decay: edge.decay,
    edge_p_value: edge.pValue, edge_wilson_ci_low: edge.ci?.[0] ?? null, edge_wilson_ci_high: edge.ci?.[1] ?? null,
    disc_ladder: discLadder,
    trade_worthiness: 'pending',
    oi_signal: oiSignal, oi_grade: oiMatrix.oiGrade, trend_exhaustion: trendExhaustion, oi_change_pct: Math.round(oiChangePct * 100) / 100,
    win_rate_20: signalPerf.sampleCount >= 5 && signalPerf.winRate20 != null ? Math.round(signalPerf.winRate20 * 100) / 100 : null,
    avg_rr: signalPerf.sampleCount >= 5 && signalPerf.avgRR != null ? Math.round(signalPerf.avgRR * 100) / 100 : null,
    key_levels: keyLevels,
    hybrid_factor: hybridFactor,
      tight_channel: false,
      tight_channel_detail: undefined,
    };

    // V17 紧通道检测 (规则1: 区间+明确方向 → 四条判定)
    if (spectrum.includes('区间') && (aiDirection === '多' || aiDirection === '空')) {
      const tcResult = detectTightChannel(bars, aiDirection);
      row.tight_channel = tcResult?.detected || false;
      row.tight_channel_detail = tcResult?.detail;
    }

  // V18 L1 入场检测（所有有方向的品种，不限于紧通道）
  const l1 = detectL1EntryV18(bars, aiDirection, ema20Last, row);
  row.l1_triggered = l1.triggered;
  row.l1_entry_price = l1.entryPrice;
  row.l1_position_multiplier = l1.positionMultiplier;

  // V17 信号分级 (直接在scan中完成，因为所有字段已就绪)
  const v17 = gradeV17Signal(row);
  row.signal_grade = v17.grade;
  row.signal_variant = v17.variant;

  // C3 强趋势逆势抑制：计算200-bar动量（30min≈14天）
  const momLookback = Math.min(200, len - 1);
  const momStart = len - 1 - momLookback;
  const lastClose = bars[len - 1].c;
  const momBase = bars[momStart]?.c;
  if (momBase && momBase > 0) {
    row.trend_momentum = Math.round(((lastClose - momBase) / momBase) * 10000) / 10000;
  } else {
    row.trend_momentum = 0;
  }

  return row;
}

// ===== 关键位标注计算 (基于真实K线) =====
function calcKeyLevels(bars: BarData[], ema20Last: number) {
  const len = bars.length;
  const prevBar = bars[len - 2];

  // 近20日运行区间
  const recent20 = bars.slice(-20);
  const rangeHigh20 = Math.max(...recent20.map((b) => b.h));
  const rangeLow20 = Math.min(...recent20.map((b) => b.l));

  // Swing点检测: 最近30根内最后一个局部高/低点 (左右各1根确认)
  let swingHigh: number | null = null;
  let swingLow: number | null = null;
  const swingStart = Math.max(1, len - 30);
  for (let i = swingStart; i < len - 1; i++) {
    if (bars[i].h > bars[i - 1].h && bars[i].h > bars[i + 1].h) swingHigh = bars[i].h;
    if (bars[i].l < bars[i - 1].l && bars[i].l < bars[i + 1].l) swingLow = bars[i].l;
  }

  // 兜底: 无swing点时用近10日高/低点
  const recent10 = bars.slice(-10);
  const high10 = Math.max(...recent10.map((b) => b.h));
  const low10 = Math.min(...recent10.map((b) => b.l));

  return {
    ema20: Math.round(ema20Last * 100) / 100,
    prev_high: prevBar.h,
    prev_low: prevBar.l,
    range_high_20: rangeHigh20,
    range_low_20: rangeLow20,
    support: swingLow ?? low10,
    resistance: swingHigh ?? high10,
  };
}

/**
 * 交易者方程检查：P×R > (1-P)×S（Brooks 核心纪律，方程为负的交易不做）
 * 入场取 EMA20 参考位，止损/目标取关键位（支撑/阻力），缺失或方向不明时用 ATR 兜底
 */
export function checkTradersEquation(row: V16Row): { positive: boolean; rr: number } {
  const atr = row.atr14 || 0;
  const kl = row.key_levels;
  const entry = kl?.ema20 || row.close;
  const dir = row.ai_direction;
  if (dir !== '多' && dir !== '空') return { positive: true, rr: 0 }; // 方向中性：由其他环节拦截
  if (atr <= 0) return { positive: true, rr: 0 }; // 无法估算不阻塞

  let stop: number | null = null;
  let target: number | null = null;
  if (dir === '多') {
    stop = kl?.support && kl.support < entry ? kl.support : null;
    target = kl?.resistance && kl.resistance > entry ? kl.resistance : null;
  } else {
    stop = kl?.resistance && kl.resistance > entry ? kl.resistance : null;
    target = kl?.support && kl.support < entry ? kl.support : null;
  }
  // 止损/目标倍数：按品种×方向使用全品种寻优参数（二次寻优优先；如无配置则回退默认 1.5/2.0）
  const longOpt = getLongParams(row.code);
  const shortOpt = getShortParams(row.code);
  const stopMult = dir === '多' ? (longOpt?.stopAtrMult ?? 1.5) : (shortOpt?.stopAtrMult ?? 1.5);
  const targetMult = dir === '多' ? (longOpt?.targetAtrMult ?? 2.0) : (shortOpt?.targetAtrMult ?? 2.0);
  if (stop == null) stop = dir === '多' ? entry - atr * stopMult : entry + atr * stopMult;
  if (target == null) target = dir === '多' ? entry + atr * targetMult : entry - atr * targetMult;

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk <= 0) return { positive: true, rr: 0 };
  const rr = reward / risk;
  // 概率P取值（Brooks口径：P是"这笔交易达到目标的概率"，不是趋势延续概率）：
  // Edge统计有效时，用近20次同类信号真实胜率+AI对齐加成作为P，并以p_follow为上限；
  // 这样低胜率信号必须配高盈亏比才能通过（Brooks概率匹配表），暴跌接飞刀类（胜率40%+RR<1）被拦截
  let p = row.p_follow;
  if (row.edge_status === 'active' && row.win_rate_20 != null) {
    const edgeP = row.win_rate_20 + 0.05;
    p = Math.min(p, Math.max(edgeP, 0.3));
  }
  return { positive: p * reward > (1 - p) * risk, rr };
}

// ===== 10. V16.2 决策链过滤 =====

/** 单品种过滤评估结果 */
export interface V16RowEvaluation {
  tradable: boolean;
  reason: string;
  posMul: number;     // 0 = 不可交易
  chExempt: boolean;  // 是否触发了CH强信号豁免
}

/** V16.2 统一过滤函数 —— APP扫描和回测引擎共享的唯一真相源 */
export function evaluateV16Row(row: V16Row, opts?: {
  allowRangeTrading?: boolean;
  pThreshold?: number;
  equationMode?: 'hard' | 'soft' | 'none';  // 交易者方程模式
  softEquationMul?: number;                  // 软过滤时的仓位倍率
  chExemptEquation?: boolean;                // CH强信号豁免方程
}): V16RowEvaluation {
  // Step 1: AI方向
  if (!row.ai_direction || row.ai_direction === '中性')
    return { tradable: false, reason: 'AI方向中性', posMul: 0, chExempt: false };

  // Step 1.5: 做多方向禁用（砍腿）：二次寻优后做多仍负捕获率的品种，只做空
  if (row.ai_direction === '多' && LONG_DISABLED.has(row.code))
    return { tradable: false, reason: '做多方向禁用(砍腿, 仅做空)', posMul: 0, chExempt: false };

  // Step 1.5b: 做空方向禁用（砍腿）：1000次回测做空捕获极低的品种，只做多（如黄金9.5:1、沪银7.6:1、铜4.1:1、原油2.5:1）
  if (row.ai_direction === '空' && SHORT_DISABLED.has(row.code))
    return { tradable: false, reason: '做空方向禁用(砍腿, 仅做多)', posMul: 0, chExempt: false };

  // Step 2: Edge统计验证（无豁免）
  if (row.edge_grade === 'D' && row.edge_status === 'active')
    return { tradable: false, reason: 'Edge D级失效', posMul: 0, chExempt: false };

  // Step 3: 交易者方程（可配置模式）
  const eqMode = opts?.equationMode ?? 'hard';
  const chExemptEq = opts?.chExemptEquation ?? false;
  const chStrong = row.ch_has_signal && row.ch_strength === '强';
  const eqResult = checkTradersEquation(row);

  if (eqMode === 'hard' && !eqResult.positive) {
    // CH豁免模式：CH强信号跳过方程检查
    if (!(chExemptEq && chStrong)) {
      return { tradable: false, reason: '交易者方程为负', posMul: 0, chExempt: false };
    }
  }

  // Step 4: 区间市屏蔽（紧通道豁免；实验可开启区间交易）
  if (row.spectrum.includes('区间') && !row.spectrum.includes('紧通道') && !opts?.allowRangeTrading)
    return { tradable: false, reason: '区间市屏蔽', posMul: 0, chExempt: false };

  // Step 4.5: 强趋势逆势抑制（C3优化，无豁免）
  const mom = row.trend_momentum ?? 0;
  const dir = row.ai_direction ?? '中性';
  if (mom > 0.05 && (dir === '空' || dir === 'SHORT'))
    return { tradable: false, reason: `强多头趋势逆势做空(mom=${(mom * 100).toFixed(1)}%)`, posMul: 0, chExempt: false };
  if (mom < -0.05 && (dir === '多' || dir === 'LONG'))
    return { tradable: false, reason: `强空头趋势逆势做多(mom=${(mom * 100).toFixed(1)}%)`, posMul: 0, chExempt: false };

  // Step 5: CH强信号 → 豁免P/Gate4/楔形检查
  const chExempt = chStrong;

  if (!chExempt) {
    const pThresh = opts?.pThreshold ?? P_THRESHOLD;
    if (row.p_follow < pThresh)
      return { tradable: false, reason: `P(顺)=${row.p_follow.toFixed(3)}`, posMul: 0, chExempt: false };
    if (!row.g4_pass)
      return { tradable: false, reason: `Gate4未过(${row.g4_reason_count}/5)`, posMul: 0, chExempt: false };
    if (row.wedge_filter_on)
      return { tradable: false, reason: `楔形过滤(${row.wedge_filtered_dir})`, posMul: 0, chExempt: false };
  }

  // Step 6: V15混合引擎仓位倍率
  let posMul = 1.0;
  if (row.spectrum.includes('通道')) posMul = 0.85;
  else if (row.spectrum.includes('区间')) posMul = 0.70;

  // Step 7: 软过滤模式 — 方程为负时降低仓位
  if (eqMode === 'soft' && !eqResult.positive) {
    const softMul = opts?.softEquationMul ?? 0.5;
    posMul *= softMul;
  }

  return { tradable: true, reason: '', posMul, chExempt };
}

/** 批量过滤：叠加方向阵营降级（仅APP端使用，回测不适用） */
export function buildV16Tradable(
  rows: V16Row[],
  directionCamp: DirectionCampResult,
  opts?: { nonGreenMul?: number; counterCampMul?: number; trendFilter?: boolean; historyBars?: Array<{ c: number }> },
): { tradable: V16Row[]; filtered: { code: string; name: string; reason: string }[] } {
  // 回测论证: 方向阵营降级有害，移除后收益+12.5%（2337%→2630%）
  const nonGreenMul = opts?.nonGreenMul ?? 1.0;
  const counterCampMul = opts?.counterCampMul ?? 1.0;
  const enableTrendFilter = opts?.trendFilter ?? false;
  const tradable: V16Row[] = [];
  const filtered: { code: string; name: string; reason: string }[] = [];

  for (const row of rows) {
    // 回测论证: 区间市开放 + 移除交易者方程硬过滤 → 显著提升收益
    const ev = evaluateV16Row(row, { allowRangeTrading: true, equationMode: 'none' });
    if (!ev.tradable) {
      row.trade_worthiness = 'filtered';
      filtered.push({ code: row.code, name: row.name, reason: ev.reason });
      continue;
    }

    // 方向阵营降级（V18: 不硬过滤，降级为警告/仓位调整）
    if (!directionCamp.isGreen) {
      row.direction_camp_warning = `方向阵营${directionCamp.camp}非GREEN，仓位×${nonGreenMul}`;
      row.position_multiplier = nonGreenMul;
    }
    if (
      (directionCamp.camp === 'LONG21' && row.ai_direction !== '多') ||
      (directionCamp.camp === 'SHORT21' && row.ai_direction !== '空')
    ) {
      row.direction_camp_warning = row.direction_camp_warning
        ? `${row.direction_camp_warning}; 且逆阵营方向`
        : `逆阵营方向：全市场${directionCamp.camp}但你选${row.ai_direction}方向`;
      row.position_multiplier = row.position_multiplier ? Math.min(row.position_multiplier, counterCampMul) : counterCampMul;
    }
    if (row.position_multiplier == null) row.position_multiplier = 1.0;
    row.position_multiplier *= ev.posMul;

    // ===== 多周期融合过滤（回测验证：PF从2.84提升至2.67但交易减少20%）=====
    // conflict共振：日线vs60min方向相反，直接过滤
    if (row.mtf_resonance?.resonance === 'conflict') {
      row.trade_worthiness = 'filtered';
      filtered.push({ code: row.code, name: row.name, reason: 'MTF冲突(日线vs60min方向相反)' });
      continue;
    }
    // none共振：无多周期数据或无共振，仓位降30%
    if (row.mtf_resonance?.resonance === 'none') {
      row.position_multiplier *= 0.7;
      row.mtf_warning = 'MTF无共振，仓位×0.7';
    }
    // full共振：三周期一致，仓位 boost 20%
    if (row.mtf_resonance?.resonance === 'full') {
      row.position_multiplier *= 1.2;
    }

    // ===== EMA趋势过滤（回测验证：减少20%交易，PF保持≥2.5）=====
    // 全局开关 or 品种×方向寻优 trendFilter（二次寻优优先）
    const longOptTrend = getLongParams(row.code)?.trendFilter === true && row.ai_direction === '多';
    const shortOptTrend = getShortParams(row.code)?.trendFilter === true && row.ai_direction === '空';
    const rowEma20 = row.ema20;
    const useRowTrendFilter = (enableTrendFilter || longOptTrend || shortOptTrend) && rowEma20 != null && row.close != null;
    if (useRowTrendFilter) {
      const signalDir = row.ai_direction;
      const rowTrendDir = row.close > (rowEma20 as number) ? '多' : '空';
      if ((rowTrendDir === '多' && signalDir === '空') || (rowTrendDir === '空' && signalDir === '多')) {
        // 信号方向与EMA20趋势相反，过滤掉
        row.trade_worthiness = 'filtered';
        filtered.push({ code: row.code, name: row.name, reason: `EMA趋势过滤(EMA20=${rowTrendDir}, 信号=${signalDir})` });
        continue;
      }
    }

    // ===== 做多方向禁用（砍腿）：二次寻优后做多仍负捕获率的品种，只做空 =====
    if (row.ai_direction === '多' && LONG_DISABLED.has(row.code)) {
      row.trade_worthiness = 'filtered';
      filtered.push({ code: row.code, name: row.name, reason: `做多方向禁用(砍腿, 仅做空)` });
      continue;
    }

    // ===== 做空方向禁用（砍腿）：1000次回测做空捕获率远低于做多的品种，只做多 =====
    if (row.ai_direction === '空' && SHORT_DISABLED.has(row.code)) {
      row.trade_worthiness = 'filtered';
      filtered.push({ code: row.code, name: row.name, reason: `做空方向禁用(回测做空捕获不足, 仅做多)` });
      continue;
    }

    // ===== 信号等级过滤（品种×方向寻优 minSignalGrade，二次寻优优先）=====
    const rowLevel = gradeV17Signal(row).level;
    const optMinGrade = row.ai_direction === '多'
      ? (getLongParams(row.code)?.minSignalGrade ?? 'L0')
      : (getShortParams(row.code)?.minSignalGrade ?? 'L0');
    const optLevel = { L0: 0, L1: 1, L2: 2, L3: 3, L4: 4 }[optMinGrade] ?? 0;
    if (optLevel > 0 && rowLevel < optLevel) {
      row.trade_worthiness = 'filtered';
      filtered.push({ code: row.code, name: row.name, reason: `信号等级过滤(需${optMinGrade}, 实际L${rowLevel})` });
      continue;
    }

    row.trade_worthiness = 'tradable';
    tradable.push(row);
  }

  // 排序: CH信号优先 > P(顺)降序
  tradable.sort((a, b) => {
    if (a.ch_has_signal && !b.ch_has_signal) return -1;
    if (!a.ch_has_signal && b.ch_has_signal) return 1;
    return b.p_follow - a.p_follow;
  });

  return { tradable, filtered };
}

// ===== V18 三维信号分级 (Brooks: 位置×K线×量仓) =====

/**
 * V18 三维信号综合等级 (Level 0-4)
 * 核心原则: 信号K线必须测试关键位 + K线实体够大 + 量仓配合
 * L3+ 才推荐交易，L1/L0 不做
 */
function gradeV17Signal(row: V16Row): { level: number; grade: string; variant: string; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;

  // ===== 维度1: 位置 Position (0-1.5分) =====
  // 信号K线是否在关键位附近 (CH边界 / swing高低点 / 紧通道)
  let posScore = 0;
  if (row.ch_has_signal && row.ch_strength === '强') {
    posScore = 1.5; reasons.push('位置优-通道强边界');
  } else if (row.ch_has_signal) {
    posScore = 1.0; reasons.push('位置可-通道边界');
  } else if (row.tight_channel) {
    posScore = 0.8; reasons.push('位置可-紧通道突破');
  } else if (row.mm_found && row.mm_variant_count >= 2) {
    posScore = 0.6; reasons.push('位置弱-MM测量位');
  } else {
    posScore = 0.2;
  }
  score += posScore;

  // ===== 维度2: K线质量 Candle (0-1.5分) =====
  // Gate4信号理由数 + 方向强度反映K线质量
  let candleScore = 0;
  if (row.g4_reason_count >= 5) {
    candleScore = 1.5; reasons.push('K线优-信号强劲');
  } else if (row.g4_reason_count >= 4) {
    candleScore = 1.2; reasons.push('K线良-信号明确');
  } else if (row.g4_reason_count >= 3) {
    candleScore = 0.8; reasons.push('K线可-信号达标');
  } else if (row.g4_reason_count >= 2) {
    candleScore = 0.4;
  } else {
    candleScore = 0;
  }
  // 趋势强度加成: ADX>40额外+0.3
  if (row.trend_strength >= 70 && row.ai_direction !== '中性') {
    candleScore = Math.min(candleScore + 0.3, 1.5);
    if (!reasons.includes('K线优-信号强劲')) reasons.push('K线加成-趋势强');
  }
  score += candleScore;

  // ===== 维度3: 量仓配合 Volume/OI (0-1.5分) =====
  let volScore = 0;
  if (row.oi_grade === 'B') {
    volScore = 1.5; reasons.push('量仓优-机构共振');
  } else if (row.oi_grade === 'B-') {
    volScore = 1.0; reasons.push('量仓良-方向一致');
  } else if (row.oi_grade === 'D' || row.oi_grade === 'D-') {
    volScore = 0.3;
  } else {
    volScore = 0.5;
  }
  // 趋势衰竭扣分
  if (row.trend_exhaustion) {
    volScore = Math.max(volScore - 0.5, 0);
    reasons.push('量仓警告-趋势衰竭');
  }
  score += volScore;

  // ===== Level映射 (满分4.5) =====
  let level: number;
  let grade: string;
  if (score >= 4.0) { level = 4; grade = 'L4'; }
  else if (score >= 3.0) { level = 3; grade = 'L3'; }
  else if (score >= 2.0) { level = 2; grade = 'L2'; }
  else if (score >= 1.0) { level = 1; grade = 'L1'; }
  else { level = 0; grade = 'L0'; }

  // Variant分级 (S/A+/A/A-/B+)
  let variant = 'B+';
  if (row.ch_has_signal && row.edge_grade === 'A' && row.g4_reason_count >= 4) variant = 'S';
  else if (row.ch_has_signal && (row.edge_grade === 'A' || row.edge_grade === 'B')) variant = 'A+';
  else if ((row.ch_has_signal || row.ff_found) && (row.edge_grade === 'A' || row.edge_grade === 'B')) variant = 'A';
  else if (row.g4_reason_count >= 4 && (row.edge_grade === 'A' || row.edge_grade === 'B' || row.edge_grade === 'C')) variant = 'A-';
  else if (row.g4_reason_count >= 3) variant = 'B+';

  return { level, grade, variant, reasons };
}

// ========== V18 频谱分类 + 量仓矩阵 ==========

/**
 * V18 频谱分类：7条件综合判定
 * 替代旧版 ADX 单维判定（65/67被判为区间的问题根源）
 */
function classifySpectrumV18(
  bars: BarData[],
  adx: number,
  aiDirection: string,
  oiChangePct: number,
): { spectrum: string; trendStrength: number; spectrumDetail: string } {
  const len = bars.length;
  const last20 = bars.slice(-20);
  const lastIdx = len - 1;

  // C1: K线重叠率 < 40% → 趋势
  let overlaps = 0;
  for (let i = 1; i < last20.length; i++) {
    const overlapRaw = Math.min(last20[i].h, last20[i - 1].h) - Math.max(last20[i].l, last20[i - 1].l);
    const prevRange = last20[i - 1].h - last20[i - 1].l;
    if (prevRange > 0 && overlapRaw / prevRange < 0.4) overlaps++;
  }
  const c1Trend = overlaps >= 11;

  // C2: ADX > 25 = 趋势区
  const c2Trend = adx > 25;
  const c2Channel = adx >= 18 && adx <= 25;

  // C3: EMA20斜率 > 0.15%/日
  const closes20 = last20.map((b) => b.c);
  const ema20Local = calcEMA(closes20, 20);
  const emaStart = ema20Local[0];
  const emaEnd = ema20Local[ema20Local.length - 1];
  const emaSlopePct = emaStart > 0 ? ((emaEnd - emaStart) / emaStart) * 100 : 0;
  const c3Trend = Math.abs(emaSlopePct) > 0.15;

  // C4: 趋势K线占比 > 35%（实体>40%+方向符合同向）
  let trendBars = 0;
  for (let i = 1; i < last20.length; i++) {
    const bar = last20[i];
    const body = Math.abs(bar.c - bar.o);
    const range = bar.h - bar.l;
    const isDirBar = aiDirection === '多'
      ? bar.c > last20[i - 1].c
      : bar.c < last20[i - 1].c;
    if (range > 0 && body / range > 0.4 && isDirBar) trendBars++;
  }
  const c4Trend = trendBars > 7;

  // C5: 价格偏离20日范围中心 > 60%
  const max20 = Math.max(...last20.map((b) => b.h));
  const min20 = Math.min(...last20.map((b) => b.l));
  const mid20 = (max20 + min20) / 2;
  const halfRange = (max20 - min20) / 2;
  const pricePos = halfRange > 0 ? Math.abs(last20[last20.length - 1].c - mid20) / halfRange : 0;
  const c5Trend = pricePos > 0.6;

  // C6: 量仓方向对齐
  const c6Trend = aiDirection === '多' ? oiChangePct > 0.5 : oiChangePct < -0.5;

  // C7: 近期突破（价格触及20日极值 ±0.5%）
  const lastC = last20[last20.length - 1].c;
  const c7Trend = aiDirection === '多'
    ? lastC >= max20 * 0.995
    : lastC <= min20 * 1.005;

  const trendScore = [c1Trend, c2Trend, c3Trend, c4Trend, c5Trend, c6Trend, c7Trend]
    .filter(Boolean).length;

  if (trendScore >= 4) {
    return {
      spectrum: '趋势',
      trendStrength: Math.min(100, 55 + (trendScore - 4) * 10 + (adx - 25)),
      spectrumDetail: `趋势-${trendScore}条件(ADX${Math.round(adx)}/重叠${overlaps}/趋势K${trendBars})`,
    };
  } else if (trendScore >= 2) {
    return {
      spectrum: '通道',
      trendStrength: 30 + trendScore * 8 + (adx > 20 ? 10 : 0),
      spectrumDetail: `通道-${trendScore}条件(ADX${Math.round(adx)}/重叠${overlaps})`,
    };
  }
  return {
    spectrum: '区间',
    trendStrength: Math.max(10, Math.round(adx * 0.5)),
    spectrumDetail: `区间(${c2Channel ? '弱ADX' : '极低ADX'}/高重叠${overlaps})`,
  };
}

/**
 * V18 量仓联合模型：6格矩阵
 * 替代旧版"增仓/减仓/稳定"二值判断
 */
function classifyOIMatrix(
  oiChangePct: number,
  priceChangePct: number,
  aiDirection: string,
): { oiSignal: string; oiGrade: string; oiDetail: string } {
  const oiUp = oiChangePct > 1;
  const oiDown = oiChangePct < -1;
  const oiFlat = !oiUp && !oiDown;
  const priceUp = priceChangePct > 0.3;
  const priceDown = priceChangePct < -0.3;

  let oiSignal: string;
  let oiGrade: string;
  let oiDetail: string;

  if (oiUp && priceUp) {
    oiSignal = '量价共振多';
    oiGrade = 'A';
    oiDetail = '增仓+上涨，多头主导';
  } else if (oiUp && priceDown) {
    oiSignal = '量价背离空';
    oiGrade = 'B';
    oiDetail = '增仓+下跌，空头施压';
  } else if (oiDown && priceUp) {
    oiSignal = '多头兑现';
    oiGrade = 'B-';
    oiDetail = '减仓+上涨，多头获利离场';
  } else if (oiDown && priceDown) {
    oiSignal = '空头兑现';
    oiGrade = 'C';
    oiDetail = '减仓+下跌，空头止盈';
  } else if (oiFlat && (priceUp || priceDown)) {
    oiSignal = priceUp ? '纯多' : '纯空';
    oiGrade = 'B';
    oiDetail = `持仓稳定，${priceUp ? '多' : '空'}方推进`;
  } else {
    oiSignal = '观望';
    oiGrade = 'D';
    oiDetail = '量价双平，等待突破';
  }

  // 方向共振加持
  if ((aiDirection === '多' && oiGrade === 'A') || (aiDirection === '空' && oiGrade === 'A')) {
    oiGrade = 'A+';
    oiDetail += '（方向共振）';
  }

  return { oiSignal, oiGrade, oiDetail };
}

// ========== 原 detectTightChannel、L1入口检测 ==========

/**
 * V17 规则1：紧通道检测
 * 触发条件：spectrum包含"区间" + ai_direction明确(多/空)
 * 四条判定全满足 → 重归类为"趋势-紧通道"
 */
function detectTightChannel(bars: BarData[], aiDirection: string): {
  detected: boolean;
  detail: { c1_side: boolean; c2_slope: boolean; c3_drawback: boolean; c4_pullback: boolean; c5_vol_contraction: boolean; c6_range_compression: boolean; c7_duration: boolean; side_n: number; max_dd_pct: number; max_adverse_run: number; vol_ratio: number; range_ratio: number; tight_days: number };
} {
  const empty = { detected: false, detail: { c1_side: false, c2_slope: false, c3_drawback: false, c4_pullback: false, c5_vol_contraction: false, c6_range_compression: false, c7_duration: false, side_n: 0, max_dd_pct: 99, max_adverse_run: 99, vol_ratio: 1, range_ratio: 1, tight_days: 0 } };
  if (bars.length < 20 || (aiDirection !== '多' && aiDirection !== '空')) return empty;

  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const last10 = bars.slice(-10);
  const ema20Last10 = ema20.slice(-10);

  // 条件①: EMA20同侧根数 ≥ 8
  let sideN = 0;
  for (let i = 0; i < 10; i++) {
    if (aiDirection === '多' && last10[i].c > ema20Last10[i]) sideN++;
    else if (aiDirection === '空' && last10[i].c < ema20Last10[i]) sideN++;
  }
  const c1 = sideN >= 8;

  // 条件②: EMA20斜率连续5日同向
  const emaDiffs: number[] = [];
  for (let i = ema20.length - 5; i < ema20.length; i++) {
    emaDiffs.push(ema20[i] - ema20[i - 1]);
  }
  const c2 = aiDirection === '多'
    ? emaDiffs.every((d) => d > 0)
    : emaDiffs.every((d) => d < 0);

  // 条件③: 最大反向回撤 < 3%
  const last10Closes = last10.map((b) => b.c);
  let maxDd = 0;
  if (aiDirection === '多') {
    let runMax = last10Closes[0];
    for (const c of last10Closes) {
      if (c > runMax) runMax = c;
      const dd = (runMax - c) / runMax;
      if (dd > maxDd) maxDd = dd;
    }
  } else {
    let runMin = last10Closes[0];
    for (const c of last10Closes) {
      if (c < runMin) runMin = c;
      const dd = (c - runMin) / runMin;
      if (dd > maxDd) maxDd = dd;
    }
  }
  const c3 = maxDd < 0.03;

  // 条件④: 连续反向K线 ≤ 2根
  let maxAdverseRun = 0;
  let curRun = 0;
  for (let j = 1; j < last10.length; j++) {
    // Brooks: 方向看收盘价相对前收盘，不看K线颜色
    const isAdverse = aiDirection === '多'
      ? (last10[j].c < last10[j - 1].c)
      : (last10[j].c > last10[j - 1].c);
    curRun = isAdverse ? curRun + 1 : 0;
    if (curRun > maxAdverseRun) maxAdverseRun = curRun;
  }
  const c4 = maxAdverseRun <= 2;

  // V18 新增: 条件⑤ 成交量收缩 — 近5日均量 < 近20日均量×0.85
  const last5Vols = last10.slice(-5).map(b => b.vol || 0);
  const avgVol5 = last5Vols.reduce((s, v) => s + v, 0) / Math.max(last5Vols.filter(v => v > 0).length, 1);
  const all20Vols = bars.slice(-20).map(b => b.vol || 0);
  const avgVol20 = all20Vols.filter(v => v > 0).reduce((s, v) => s + v, 0) / Math.max(all20Vols.filter(v => v > 0).length, 1);
  const volRatio = avgVol20 > 0 ? avgVol5 / avgVol20 : 1;
  const c5 = avgVol20 > 0 && volRatio < 0.85;

  // V18 新增: 条件⑥ 波幅压缩 — 近5日平均振幅 < 近20日平均振幅×0.75
  const avgRange5 = last10.slice(-5).reduce((s, b) => s + (b.h - b.l), 0) / 5;
  const avgRange20 = bars.slice(-20).reduce((s, b) => s + (b.h - b.l), 0) / 20;
  const rangeRatio = avgRange20 > 0 ? avgRange5 / avgRange20 : 1;
  const c6 = rangeRatio < 0.75;

  // V18 新增: 条件⑦ 持续时间 — 紧形态已持续 ≥ 8 个交易日
  let tightDays = 0;
  for (let j = bars.length - 2; j >= Math.max(0, bars.length - 30); j--) {
    const barRange = (bars[j].h - bars[j].l) / Math.max(bars[j].c, 0.01);
    if (barRange < avgRange20 * 1.2 / Math.max(bars[j].c, 0.01)) {
      tightDays++;
    } else {
      break;
    }
  }
  const c7 = tightDays >= 8;

  return {
    detected: c1 && c2 && c3 && c4 && (c5 || c6 || c7),
    detail: {
      c1_side: c1, c2_slope: c2, c3_drawback: c3, c4_pullback: c4,
      c5_vol_contraction: c5, c6_range_compression: c6, c7_duration: c7,
      side_n: sideN,
      max_dd_pct: Math.round(maxDd * 10000) / 100,
      max_adverse_run: maxAdverseRun,
      vol_ratio: Math.round(volRatio * 100) / 100,
      range_ratio: Math.round(rangeRatio * 100) / 100,
      tight_days: tightDays,
    },
  };
}

/**
 * V17 L1 紧通道入场检测
 * 条件：tight_channel=true 的前提下
 * - 找到最近一根反向K线（收盘与前收盘方向相反）
 * - 检查该反向K线之后的一根K线是否顺方向突破（收盘>前收盘高点/收盘<前收盘低点）
 * - 满足则 L1 入场信号触发
 *
 * 回测: 326笔 p=0.0073, PF=1.33
 */
/**
 * V18 L1 入场检测（Brooks 三段确认）
 * 条件1: 价格回踩EMA20±2.5%（多空各方向）
 * 条件2: 近5日内至少发现1根信号K线（II/IOI）
 * 条件3: 当前/最近K线顺向（对于做多：最近K收阳或收盘>开盘；做空：收阴）
 */
function detectL1EntryV18(
  bars: BarData[],
  aiDirection: string,
  ema20: number,
  row: V16Row,
): { triggered: boolean; entryPrice: number | null; positionMultiplier: number } {
  const len = bars.length;
  if (len < 5 || aiDirection === '中性' || !ema20) {
    return { triggered: false, entryPrice: null, positionMultiplier: 1 };
  }

  const last = bars[len - 1];
  const close = last.c;

  // 条件1: 回踩EMA20 zone
  // 日线级别: ±4%为宽区, ±2%为紧区
  const emaDist = Math.abs(close - ema20) / ema20;
  if (emaDist > 0.04) return { triggered: false, entryPrice: null, positionMultiplier: 1 };
  const inTightZone = emaDist <= 0.02;

  // 条件2: 近8日有II/IOI信号K线（宽区必须，紧区可选）
  let hasSignalBar = false;
  for (let i = Math.max(len - 8, 2); i < len; i++) {
    const isII = detectII(bars, i);
    const isIOI = detectIOI(bars, i);
    if (isII || isIOI) { hasSignalBar = true; break; }
  }
  if (!hasSignalBar && !inTightZone) {
    return { triggered: false, entryPrice: null, positionMultiplier: 1 };
  }

  // 条件3: 当前K线顺向确认
  const prevClose = bars[len - 2]?.c || close;
  const isBullishBar = last.c > last.o && last.c > prevClose;
  const isBearishBar = last.c < last.o && last.c < prevClose;

  let triggered = false;
  if (aiDirection === '多' && isBullishBar) triggered = true;
  if (aiDirection === '空' && isBearishBar) triggered = true;

  // 仓位倍率: 紧区+信号K线 = 0.75, 紧区无信号 = 0.5, wide区 = 0.35, 紧通道额外+0.1
  let multiplier = inTightZone && hasSignalBar ? 0.75 : inTightZone ? 0.5 : 0.35;
  if (row.tight_channel) multiplier = Math.min(multiplier + 0.1, 0.85);

  return {
    triggered,
    entryPrice: triggered ? close : null,
    positionMultiplier: triggered ? multiplier : 1,
  };
}

/** @deprecated 使用 detectL1EntryV18 替代 */
function detectL1Entry(_bars: BarData[], _aiDirection: string) {
  return { triggered: false, entryPrice: null, positionMultiplier: 1 };
}

/**
 * V17 规则3：观察档判定
 * tradable中方向明确 + g4_pass + 无明确入场信号 → 观察档
 */
function isWatchListCandidate(row: V16Row, tightChannelHits: Set<string>): boolean {
  if (row.ai_direction !== '多' && row.ai_direction !== '空') return false;
  if (!row.g4_pass) return false;
  if (tightChannelHits.has(row.code)) return false;
  // 无CH信号、无II/IOI信号K线 → 缺少明确入场触发
  const hasEntrySignal = row.ch_has_signal || row.g4_reasons_met.some((r) => r.includes('信号K线'));
  return !hasEntrySignal;
}

/**
 * P0-3: Brooks 多时间框架分析
 * 日线定方向 → 60min找结构 → 15min精确入场 → 5min确认
 */
function analyzeBrooksMTF(
  dailyRow: V16Row,
  mtfData: { bars5min: BarData[]; bars15min: BarData[]; bars60min: BarData[] }
): V16Row['mtf_resonance'] {
  const { bars5min, bars15min, bars60min } = mtfData;

  // === HTF (日线): 方向 + 趋势阶段 ===
  const htfDirection = dailyRow.ai_direction === '多' ? '多' : dailyRow.ai_direction === '空' ? '空' : '中性';
  let htfTrendPhase: '强趋势' | '通道' | '区间' | '紧通道';
  if (dailyRow.tight_channel) {
    htfTrendPhase = '紧通道';
  } else if (dailyRow.spectrum.includes('趋势')) {
    htfTrendPhase = '强趋势';
  } else if (dailyRow.spectrum.includes('通道')) {
    htfTrendPhase = '通道';
  } else {
    htfTrendPhase = '区间';
  }

  // === TTF (60min): 方向 + 是否回踩 ===
  let ttfDirection: '多' | '空' | '中性' = '中性';
  let ttfPullback = false;

  if (bars60min.length >= 20) {
    const closes60 = bars60min.map((b) => b.c);
    const ema20_60 = calcEMA(closes60, 20);
    const last60 = bars60min[bars60min.length - 1];
    const lastEma60 = ema20_60[ema20_60.length - 1];
    const prevEma60 = ema20_60[ema20_60.length - 2];

    // Brooks bar-by-bar三态识别（简化版）
    // 先看方向：EMA20位置+斜率
    let rawDirection: '多' | '空' | '中性' = '中性';
    if (last60.c > lastEma60 && lastEma60 > prevEma60) rawDirection = '多';
    else if (last60.c < lastEma60 && lastEma60 < prevEma60) rawDirection = '空';

    // 再看三态：近10根K线中趋势K线占比 + 回调深度
    const recent60 = bars60min.slice(-10);
    const bullBars = recent60.filter((b, i) => {
      if (i === 0) return false;
      return b.c > recent60[i - 1].c && Math.abs(b.c - b.o) > (b.h - b.l) * 0.5;
    }).length;
    const bearBars = recent60.filter((b, i) => {
      if (i === 0) return false;
      return b.c < recent60[i - 1].c && Math.abs(b.c - b.o) > (b.h - b.l) * 0.5;
    }).length;

    // 趋势态：同向K线≥6/10 且回调<1根反向K线
    // 通道态：同向K线≥5/10 但回调加深
    // 区间态：不满足以上
    if (rawDirection === '多') {
      if (bullBars >= 6) ttfDirection = '多';  // 趋势态，方向确认
      else if (bullBars >= 4) ttfDirection = '多';  // 通道态，方向仍有效
      else ttfDirection = '中性';  // 区间态，方向不确定
    } else if (rawDirection === '空') {
      if (bearBars >= 6) ttfDirection = '空';
      else if (bearBars >= 4) ttfDirection = '空';
      else ttfDirection = '中性';
    }

    // 判断是否在回踩 EMA20：价格接近 EMA20（距离 < 0.5%）
    const distanceToEma = Math.abs(last60.c - lastEma60) / lastEma60;
    ttfPullback = distanceToEma < 0.005;
  }

  // === LTF (15min): 信号 K 线检测 ===
  let ltfSignal: '多' | '空' | '无' = '无';
  let ltfEntryReady = false;

  if (bars15min.length >= 3) {
    const lastIdx = bars15min.length - 1;
    // Brooks标准：用 detectII/detectIOI 检测信号K线
    const isII = detectII(bars15min, lastIdx);
    const isIOI = detectIOI(bars15min, lastIdx);

    if (isII || isIOI) {
      const lastBar = bars15min[lastIdx];
      if (lastBar.c > lastBar.o) {
        ltfSignal = '多';
        ltfEntryReady = true;
      } else if (lastBar.c < lastBar.o) {
        ltfSignal = '空';
        ltfEntryReady = true;
      }
    }
  }

  // === 5min: Follow-through 确认 ===
  let ltfFt = false;
  if (bars5min.length >= 5 && ltfSignal !== '无') {
    const last5 = bars5min.slice(-5);
    // Brooks: FT看收盘价整体方向，不数K线颜色
    if (ltfSignal === '多') {
      // 收盘从低到高 = 至少3/5次收盘高于前收盘
      let upCount = 0;
      for (let k = 1; k < last5.length; k++) {
        if (last5[k].c > last5[k - 1].c) upCount++;
      }
      ltfFt = upCount >= 3;
    } else if (ltfSignal === '空') {
      let downCount = 0;
      for (let k = 1; k < last5.length; k++) {
        if (last5[k].c < last5[k - 1].c) downCount++;
      }
      ltfFt = downCount >= 3;
    }
  }

  // === 共振判定 ===
  let resonance: 'full' | 'partial' | 'conflict' | 'none';

  if (htfDirection === '中性' && ttfDirection === '中性') {
    resonance = 'none';
  } else if (htfDirection !== '中性' && ttfDirection !== '中性' && htfDirection !== ttfDirection) {
    resonance = 'conflict'; // 日线 vs 60min 方向相反
  } else if (htfDirection === ttfDirection && ltfSignal !== '无' && ltfFt) {
    resonance = 'full'; // 三周期一致 + 5min FT 确认
  } else if (htfDirection === ttfDirection && ltfSignal !== '无') {
    resonance = 'partial'; // 日线+60min一致，15min有信号但5min未确认
  } else if (htfDirection === ttfDirection) {
    resonance = 'partial'; // 日线+60min一致，等待15min信号
  } else {
    resonance = 'none';
  }

  return {
    htf_direction: htfDirection,
    ttf_direction: ttfDirection,
    ltf_signal: ltfSignal,
    ltf_ft: ltfFt,
    resonance,
    htf_trend_phase: htfTrendPhase,
    ttf_pullback: ttfPullback,
    ltf_entry_ready: ltfEntryReady,
  };
}

// ===== 11. 全量扫描 =====
export async function runV16FullScan(forceRefresh = false, asOfDate?: string): Promise<V16ScanResult> {
  const t0 = Date.now();
  const allCodes = Object.keys(VARIETIES).filter(isEnabledVariety);
  const rows: V16Row[] = [];

  // 并行获取数据并扫描
  const tScan0 = Date.now();
  const scanPromises = allCodes.map(async (code) => {
    try {
      // asOfDate 存在时按历史截止日期扫描（用于日报复盘），否则扫描最新数据
      const data = asOfDate
        ? await getVarietyDataAsOf(code, 120, asOfDate)
        : await getVarietyData(code, 120, forceRefresh);
      if (!data || data.bars.length < 20) return null;
      // TOP1 完整配方对齐：按品种使用 edgeLookback / allowRangeTrading
      const top1 = TOP1_UNIFIED_PARAMS[code];
      const scanOpts = top1
        ? { edgeLookback: top1.edgeLookback, allowRangeTrading: top1.allowRangeTrading }
        : undefined;
      return scanV16Variety(code, data.bars, data.contract || code, scanOpts);
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(scanPromises);
  for (const r of results) {
    if (r) rows.push(r);
  }
  const scanElapsed = Date.now() - tScan0;

  // 方向阵营计算
  const directionCamp = calcDirectionCamp(rows);

  // 过滤
  const tFilter0 = Date.now();
  const { tradable, filtered } = buildV16Tradable(rows, directionCamp);
  const filterElapsed = Date.now() - tFilter0;

  // V17 规则3: 观察档标记
  const tightChannelHits = new Set(rows.filter((r) => r.tight_channel).map((r) => r.code));
  for (const row of tradable) {
    if (isWatchListCandidate(row, tightChannelHits)) {
      row.watch_list = true;
    }
  }

  // P0-3: 多时间框架共振分析（仅对 tradable 品种）
  // 历史日期扫描（asOfDate）跳过 MTF 实时分析，避免用当前实时数据污染历史判断
  if (!asOfDate) {
    const mtfPromises = tradable.map(async (row) => {
      try {
        const mtfData = await fetchMTFData(row.contract);
        if (mtfData) {
          row.mtf_resonance = analyzeBrooksMTF(row, mtfData);
        }
      } catch (e: any) {
        console.error(`[V16] MTF分析失败 ${row.code}:`, e?.message || e);
      }
    });
    await Promise.all(mtfPromises);
  }

  const totalElapsed = Date.now() - t0;

  return {
    scanTime: new Date().toISOString(),
    totalCount: rows.length,
    tradableCount: tradable.length,
    filteredCount: filtered.length,
    rows,
    tradable,
    filtered,
    timing: { scan: scanElapsed, filter: filterElapsed, total: totalElapsed },
  };
}

/**
 * 加载30分钟缓存数据（从 data-cache-30m-long 目录）
 * 并尝试从新浪 API 补丁今日最新 bar
 */
async function getVarietyData30m(
  code: string,
  forceRefresh = false,
): Promise<{ bars: BarData[]; contract: string } | null> {
  const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-cache-30m-long');
  const cacheFile = path.join(cacheDir, `${code}.json`);

  try {
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    let bars: BarData[] = JSON.parse(raw);
    if (!bars || bars.length < 20) return null;

    // 只取最近 500 根 bar（足够扫描用），大幅提升性能
    if (bars.length > 500) bars = bars.slice(-500);

    // 尝试补丁最新 bar（从 Sina 分钟线 API）
    if (!forceRefresh) {
      try {
        const patched = await patch30mBar(bars, code);
        return { bars: patched, contract: code };
      } catch {
        return { bars, contract: code };
      }
    }

    return { bars, contract: code };
  } catch {
    return null;
  }
}

/**
 * 单品种30min扫描（供AI深度解读等场景使用，避免全品种扫描耗时）
 */
export async function scanSingleVariety30m(code: string): Promise<V16Row | null> {
  const data = await getVarietyData30m(code, false);
  if (!data || data.bars.length < 20) return null;
  try {
    return scanV16Variety(code, data.bars, data.contract || code);
  } catch {
    return null;
  }
}

/**
 * 补丁今日30min bar — 从 Sina API 拉取今日分钟数据，合并到缓存
 */
async function patch30mBar(bars: BarData[], code: string): Promise<BarData[]> {
  const lastBar = bars[bars.length - 1];
  if (!lastBar) return bars;

  const today = new Date().toISOString().split('T')[0];
  const lastBarDate = (lastBar.date || '').split(' ')[0];
  if (lastBarDate >= today) return bars; // 已有今日数据

  try {
    // 确定合约代码用于 Sina API
    const contract = await detectMainContract(code);
    const sym = contract.toLowerCase();
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${sym}30=/InnerFuturesNewService.getFewMinLine?symbol=${sym}&type=30`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();
    const jsonMatch = text.match(/=\((\[.*\])\)/);
    if (!jsonMatch) return bars;

    const rawData = JSON.parse(jsonMatch[1]) as string[][];
    if (!rawData || rawData.length === 0) return bars;

    // 转换为 BarData，只保留今日的
    const todayBars: BarData[] = [];
    for (const row of rawData) {
      const dt = row[0]; // e.g. "09:30"
      const dateStr = `${today} ${dt}:00`;
      if (dateStr <= (lastBar.date || '')) continue;
      todayBars.push({
        date: dateStr,
        o: parseFloat(row[1]),
        h: parseFloat(row[2]),
        l: parseFloat(row[3]),
        c: parseFloat(row[4]),
        vol: parseFloat(row[5]) || 0,
        hold: parseFloat(row[6]) || 0,
      });
    }

    if (todayBars.length > 0) {
      return [...bars, ...todayBars];
    }
  } catch {
    // 静默失败，使用缓存
  }

  return bars;
}

/**
 * 基于30min数据的全品种扫描
 */
export async function runV16FullScan30m(forceRefresh = false): Promise<V16ScanResult> {
  const t0 = Date.now();
  // 从 30min 缓存目录获取可用品种列表
  const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-cache-30m-long');
  let allCodes: string[] = [];
  try {
    const cached = fs.readdirSync(cacheDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  allCodes = cached.filter(c => c in VARIETIES && isEnabledVariety(c));
  } catch {
    allCodes = Object.keys(VARIETIES).filter(isEnabledVariety);
  }
  const rows: V16Row[] = [];

  const tScan0 = Date.now();
  const scanPromises = allCodes.map(async (code) => {
    try {
      const data = await getVarietyData30m(code, forceRefresh);
      if (!data || data.bars.length < 20) return null;
      return scanV16Variety(code, data.bars, data.contract || code);
    } catch (err) {
      return null;
    }
  });

  const results = await Promise.all(scanPromises);
  for (const r of results) {
    if (r) rows.push(r);
  }
  const scanElapsed = Date.now() - tScan0;

  // 方向阵营计算
  const directionCamp = calcDirectionCamp(rows);

  // 过滤
  const tFilter0 = Date.now();
  const { tradable, filtered } = buildV16Tradable(rows, directionCamp);
  const filterElapsed = Date.now() - tFilter0;

  // V17 规则3: 观察档标记
  const tightChannelHits = new Set(rows.filter((r) => r.tight_channel).map((r) => r.code));
  for (const row of tradable) {
    if (isWatchListCandidate(row, tightChannelHits)) {
      row.watch_list = true;
    }
  }

  // 跳过 MTF 分析（30min 已经是主时间框架）

  const totalElapsed = Date.now() - t0;

  return {
    scanTime: new Date().toISOString(),
    totalCount: rows.length,
    tradableCount: tradable.length,
    filteredCount: filtered.length,
    rows,
    tradable,
    filtered,
    timing: { scan: scanElapsed, filter: filterElapsed, total: totalElapsed },
  };
}

/**
 * V18 趋势衰竭前兆检测
 * C1: 价格远离EMA20 + K线范围收缩 (avgRange5 < 0.7×avgRange20)
 * C2: 连续3根疲软收盘 (收于K线低/高点)
 * C3: 成交量突增 (1.5×20日均量) + 小实体
 * 2+/3 = 预警/确认
 */
function detectTrendExhaustion(
  bars: BarData[],
  aiDirection: string,
  adx: number,
): string | null {
  const len = bars.length;
  if (len < 20 || adx < 20) return null;
  const last5 = bars.slice(-5);
  const last20 = bars.slice(-20);
  const closes = last20.map(b => b.c);
  const ema20 = calcEMA(closes, 20);
  const lastPrice = closes[closes.length - 1];
  const lastEma = ema20[ema20.length - 1];
  const distFromEma = Math.abs((lastPrice - lastEma) / lastEma) * 100;
  const avgRange5 = last5.reduce((s, b) => s + (b.h - b.l), 0) / 5;
  const avgRange20 = last20.reduce((s, b) => s + (b.h - b.l), 0) / 20;
  const c1 = distFromEma > 1.0 && avgRange5 < avgRange20 * 0.7;
  const last3 = bars.slice(-3);
  const c2 = last3.every(b => {
    const range = b.h - b.l;
    if (range === 0) return false;
    if (aiDirection === '多') return (b.c - b.l) / range < 0.3;
    return (b.h - b.c) / range < 0.3;
  });
  const avgVol20 = last20.reduce((s, b) => s + (b.vol || 0), 0) / 20;
  const lastVol = last5[last5.length - 1].vol || 0;
  const lastBody = Math.abs(last5[last5.length - 1].c - last5[last5.length - 1].o);
  const lastRange = last5[last5.length - 1].h - last5[last5.length - 1].l;
  const c3 = avgVol20 > 0 && lastVol > avgVol20 * 1.5 && lastRange > 0 && lastBody / lastRange < 0.3;
  const score = (c1 ? 1 : 0) + (c2 ? 1 : 0) + (c3 ? 1 : 0);
  if (score >= 3) return '衰竭确认';
  if (score >= 2) return '衰竭预警';
  if (score >= 1) return '注意枯竭';
  return null;
}
