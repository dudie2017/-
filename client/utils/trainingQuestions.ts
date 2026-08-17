/**
 * 专项训练题目生成器
 * 每个模块 3-5 种题型，基于真实K线数据分析
 */

import { CandleBar } from "@/components/chart/CandlestickChart";
import { VarietyStat } from "./trainingApi";

export interface GeneratedQuestion {
  id: string;
  type: "tap" | "multi";
  question: string;
  code: string;
  bars: CandleBar[];
  correctBarIndex: number;
  correctOptionIndex?: number;
  options?: string[];
  explanation: string;
  showOI?: boolean;
}

// ── Helper functions ──

interface BarAnalysis {
  range: number;
  body: number;
  bodyPct: number;
  closePos: number; // 0=low, 1=high
  isBull: boolean;
  upperWick: number;
  lowerWick: number;
  upperWickPct: number;
  lowerWickPct: number;
}

function analyzeBar(bar: CandleBar): BarAnalysis {
  const range = bar.h - bar.l;
  const body = Math.abs(bar.c - bar.o);
  const bodyPct = range > 0 ? body / range : 0;
  const closePos = range > 0 ? (bar.c - bar.l) / range : 0.5;
  const isBull = bar.c > bar.o;
  const upperWick = bar.h - Math.max(bar.c, bar.o);
  const lowerWick = Math.min(bar.c, bar.o) - bar.l;
  return {
    range, body, bodyPct, closePos, isBull,
    upperWick, lowerWick,
    upperWickPct: range > 0 ? upperWick / range : 0,
    lowerWickPct: range > 0 ? lowerWick / range : 0,
  };
}

function calcEMA(bars: CandleBar[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += bars[j].c;
      ema = sum / period;
      result.push(ema);
    } else {
      ema = bars[i].c * k + ema * (1 - k);
      result.push(ema);
    }
  }
  return result;
}

function calcATR(bars: CandleBar[], endIdx: number, period = 14): number {
  const start = Math.max(1, endIdx - period + 1);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= endIdx; i++) {
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c),
    );
    sum += tr;
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function detectTrend(bars: CandleBar[], endIdx: number): "strong_up" | "up" | "range" | "down" | "strong_down" {
  if (endIdx < 20) return "range";
  const ema = calcEMA(bars.slice(0, endIdx + 1), 20);
  const emaVal = ema[endIdx] || bars[endIdx].c;
  const price = bars[endIdx].c;
  const atr = calcATR(bars, endIdx);
  const dist = atr > 0 ? (price - emaVal) / atr : 0;

  // Count bull/bear bars in last 10
  const recent = bars.slice(Math.max(0, endIdx - 9), endIdx + 1);
  const bullCount = recent.filter((b) => b.c > b.o).length;
  const bearCount = recent.filter((b) => b.c < b.o).length;

  if (dist > 2 && bullCount >= 7) return "strong_up";
  if (dist > 1) return "up";
  if (dist < -2 && bearCount >= 7) return "strong_down";
  if (dist < -1) return "down";
  return "range";
}

function findSwingHigh(bars: CandleBar[], endIdx: number, lookback = 10): number {
  let highest = -Infinity;
  const start = Math.max(0, endIdx - lookback);
  for (let i = start; i < endIdx; i++) {
    if (bars[i].h > highest) highest = bars[i].h;
  }
  return highest;
}

function findSwingLow(bars: CandleBar[], endIdx: number, lookback = 10): number {
  let lowest = Infinity;
  const start = Math.max(0, endIdx - lookback);
  for (let i = start; i < endIdx; i++) {
    if (bars[i].l < lowest) lowest = bars[i].l;
  }
  return lowest;
}

function randomBarIdx(bars: CandleBar[], minContext = 25, maxFromEnd = 10): number {
  const min = Math.min(minContext, Math.floor(bars.length / 3));
  const max = Math.max(min + 1, bars.length - maxFromEnd);
  return min + Math.floor(Math.random() * (max - min));
}

function contextBars(bars: CandleBar[], barIdx: number, before = 30, after = 3): CandleBar[] {
  const start = Math.max(0, barIdx - before);
  const end = Math.min(bars.length, barIdx + after + 1);
  return bars.slice(start, end);
}

function shuffleOptions(options: string[], correctIdx: number): { options: string[]; correctIndex: number } {
  const indices = options.map((_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return {
    options: indices.map((i) => options[i]),
    correctIndex: indices.indexOf(correctIdx),
  };
}

let qIdCounter = 0;
function nextQId(): string {
  return `q_${Date.now()}_${++qIdCounter}`;
}

// ── 1. 信号K线识别 ──

function generateSignalQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 4);
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const a = analyzeBar(bar);
  const prev = barIdx > 0 ? bars[barIdx - 1] : null;
  const trend = detectTrend(bars, barIdx);
  const ctx = contextBars(bars, barIdx);

  switch (qType) {
    case 0: {
      // 判断是否为有效多头信号棒
      const isValid = a.isBull && a.bodyPct > 0.5 && a.closePos > 0.7;
      const options = [
        `有效多头信号棒——实体占比${(a.bodyPct * 100).toFixed(0)}%，收在K线${a.closePos > 0.66 ? "上" : a.closePos > 0.33 ? "中" : "下"}部`,
        `不是有效信号棒——实体占比仅${(a.bodyPct * 100).toFixed(0)}%，缺乏力度`,
        `不是有效信号棒——虽然收阳但收盘位置偏低（${(a.closePos * 100).toFixed(0)}%处）`,
        `无法判断——需要看后续确认`,
      ];
      let correctIdx = 3;
      if (isValid) correctIdx = 0;
      else if (a.bodyPct <= 0.5) correctIdx = 1;
      else if (a.closePos <= 0.7) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1),
        question: `${bar.date} K线：开${bar.o.toFixed(1)} 高${bar.h.toFixed(1)} 低${bar.l.toFixed(1)} 收${bar.c.toFixed(1)}。当前趋势为"${trend === "strong_up" ? "强多" : trend === "up" ? "多头" : trend === "down" ? "空头" : trend === "strong_down" ? "强空" : "震荡"}"。这根K线是否为有效的多头信号棒？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks信号棒标准：①实体占比>50%（当前${(a.bodyPct * 100).toFixed(0)}%）②收在K线上1/3（当前${(a.closePos * 100).toFixed(0)}%位置）③最好在下跌趋势末端或均线回踩处出现。${isValid ? "这根K线满足所有条件，是有效信号棒。" : "这根K线不满足全部条件。"}`,
      };
    }
    case 1: {
      // 信号棒的后续确认
      const next = barIdx + 1 < bars.length ? bars[barIdx + 1] : null;
      if (!next || !prev) return generateSignalQuestion(bars, code);
      const nextA = analyzeBar(next);
      const isSignal = a.isBull && a.bodyPct > 0.5 && a.closePos > 0.6;
      const hasFollowThrough = next.c > prev.c && nextA.isBull;
      const options = [
        `信号棒得到确认——后续K线继续上涨，跟进力度${nextA.bodyPct > 0.5 ? "强" : "一般"}`,
        `信号棒未获确认——后续K线${nextA.isBull ? "收阳但力度不足" : "收阴"}，可能反转`,
        `需要再等一根K线确认——当前信号不明确`,
        `信号棒本身不够强，观望为主`,
      ];
      let correctIdx = 3;
      if (isSignal && hasFollowThrough) correctIdx = 0;
      else if (isSignal && !hasFollowThrough) correctIdx = 1;
      else if (!isSignal) correctIdx = 3;
      else correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1),
        question: `图中标注区域附近出现一根${a.isBull ? "阳" : "阴"}线（实体${(a.bodyPct * 100).toFixed(0)}%），其后续一根K线${nextA.isBull ? "收阳" : "收阴"}。这根信号棒的后续确认情况如何？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks强调"跟进确认"（Follow-through）：信号棒出现后，下一根K线必须延续同向走势才算确认。${isSignal ? `信号棒本身较强（实体${(a.bodyPct * 100).toFixed(0)}%）` : "信号棒本身较弱"}，${hasFollowThrough ? "后续K线延续了方向，确认有效。" : "后续K线未能延续，信号可能失败。"}`,
      };
    }
    case 2: {
      // 连续同向K线后的衰竭
      const recent5 = bars.slice(Math.max(0, barIdx - 4), barIdx + 1);
      const allBull = recent5.every((b) => b.c > b.o);
      const allBear = recent5.every((b) => b.c < b.o);
      const consecutive = allBull ? "连续5根阳线" : allBear ? "连续5根阴线" : "多空交替";
      const lastBarA = analyzeBar(recent5[recent5.length - 1]);
      const isExhaustion = (allBull || allBear) && lastBarA.bodyPct < 0.4;
      const options = [
        `出现衰竭迹象——${consecutive}后实体缩小（${(lastBarA.bodyPct * 100).toFixed(0)}%），可能回调`,
        `趋势仍然强劲——连续同向K线且实体未缩小`,
        `无法判断衰竭——需要更多数据`,
        `这是正常回调，趋势未变`,
      ];
      let correctIdx = 3;
      if (isExhaustion) correctIdx = 0;
      else if ((allBull || allBear) && lastBarA.bodyPct >= 0.5) correctIdx = 1;
      else if (!allBull && !allBear) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1),
        question: `最近5根K线走势：${consecutive}。最后一根K线实体占比${(lastBarA.bodyPct * 100).toFixed(0)}%。根据Brooks理论，当前是否出现趋势衰竭信号？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的"高潮"（Climax）概念：连续5根以上同向K线后，如果实体开始缩小（<40%），说明推动力在衰减，可能出现回调或反转。${isExhaustion ? "当前确实出现了衰竭迹象。" : allBull || allBear ? "实体未明显缩小，趋势仍可能持续。" : "多空交替，不属于连续推动。"}`,
      };
    }
    default: {
      // 图中哪根是最佳做空信号棒
      let bestIdx = -1;
      let bestScore = -1;
      for (let i = Math.max(0, barIdx - 15); i <= Math.min(barIdx + 2, bars.length - 1); i++) {
        const ba = analyzeBar(bars[i]);
        if (!ba.isBull && ba.bodyPct > 0.4 && ba.closePos < 0.35) {
          const score = ba.bodyPct * (1 - ba.closePos);
          if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
          }
        }
      }
      if (bestIdx < 0) bestIdx = barIdx;
      const relIdx = bestIdx - Math.max(0, barIdx - 30);
      return {
        id: nextQId(), type: "tap", code, bars: ctx,
        correctBarIndex: Math.max(0, Math.min(relIdx, ctx.length - 1)),
        question: "在图中找出最佳的做空信号棒（阴线实体大、收在K线下部）：",
        explanation: `最佳做空信号棒出现在第${bestIdx + 1}根K线（${bars[bestIdx].date}）。特征：阴线实体占比${(analyzeBar(bars[bestIdx]).bodyPct * 100).toFixed(0)}%，收在K线${(analyzeBar(bars[bestIdx]).closePos * 100).toFixed(0)}%位置（越低越好）。Brooks认为这种K线表明卖方完全控制了局面。`,
      };
    }
  }
}

// ── 2. 量仓分析 ──

function generateVolumeQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 4);
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const a = analyzeBar(bar);
  const prev = barIdx > 0 ? bars[barIdx - 1] : null;
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);

  if (!prev) return generateVolumeQuestion(bars, code);

  switch (qType) {
    case 0: {
      // 量价配合分析
      const volUp = bar.vol > prev.vol * 1.3;
      const priceUp = bar.c > prev.c;
      const oiUp = bar.hold > prev.hold;
      const options = [
        `量增价涨持仓增——多方主动增仓，趋势健康`,
        `量增价涨持仓减——空头回补推动，持续性存疑`,
        `量增价跌持仓增——空方主动增仓，趋势看空`,
        `量缩价涨——上涨动能不足，谨慎追高`,
      ];
      let correctIdx = 0;
      if (volUp && priceUp && oiUp) correctIdx = 0;
      else if (volUp && priceUp && !oiUp) correctIdx = 1;
      else if (volUp && !priceUp && oiUp) correctIdx = 2;
      else correctIdx = 3;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx, showOI: true,
        question: `${bar.date}：价格${priceUp ? "上涨" : "下跌"}（${bar.c.toFixed(1)}），成交量${volUp ? "放大" : "萎缩"}（${(bar.vol / 1000).toFixed(0)}K），持仓量${oiUp ? "增加" : "减少"}。根据量仓分析，当前状况如何解读？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `量仓分析核心逻辑：量增+价涨+持仓增=多方主动增仓（最强势）；量增+价涨+持仓减=空头回补（次强但不可持续）；量增+价跌+持仓增=空方增仓（看空）。当前：量${volUp ? "增" : "缩"}+价${priceUp ? "涨" : "跌"}+持仓${oiUp ? "增" : "减"}。`,
      };
    }
    case 1: {
      // 量价背离
      const lookback = 10;
      const recentHigh = findSwingHigh(bars, barIdx, lookback);
      const prevHighIdx = Math.max(0, barIdx - lookback);
      const prevHigh = findSwingHigh(bars, prevHighIdx, lookback);
      const isNewHigh = bar.h > recentHigh * 0.998;
      const recentAvgVol = bars.slice(Math.max(0, barIdx - 5), barIdx).reduce((s, b) => s + b.vol, 0) / 5;
      const prevAvgVol = bars.slice(Math.max(0, barIdx - lookback - 5), Math.max(1, barIdx - lookback)).reduce((s, b) => s + b.vol, 0) / 5;
      const volDivergence = isNewHigh && bar.vol < prevAvgVol * 0.8;
      const options = [
        `量价背离——价格创新高但量能明显萎缩，上涨动力不足`,
        `量价齐升——价格新高且量能配合，趋势健康`,
        `量能正常——无明显背离或配合`,
        `缩量整理——正在为下一波蓄力`,
      ];
      let correctIdx = 2;
      if (volDivergence) correctIdx = 0;
      else if (isNewHigh && bar.vol > prevAvgVol * 1.2) correctIdx = 1;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx, showOI: true,
        question: `当前价格${bar.c.toFixed(1)}，近期高点${recentHigh.toFixed(1)}。成交量${(bar.vol / 1000).toFixed(0)}K，前期均量${(prevAvgVol / 1000).toFixed(0)}K。是否存在量价背离？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `量价背离是重要的顶部预警信号：价格创新高但成交量明显低于前期高点时的量能，说明追涨意愿不足。${volDivergence ? `当前量能为前期均量的${((bar.vol / prevAvgVol) * 100).toFixed(0)}%，显著萎缩，存在背离。` : isNewHigh ? "价格新高且量能配合，暂无背离。" : "当前不在新高位置，无从判断背离。"}`,
      };
    }
    case 2: {
      // 持仓量与趋势关系
      const oiChange = bar.hold - prev.hold;
      const oiChangePct = prev.hold > 0 ? (oiChange / prev.hold) * 100 : 0;
      const trend = detectTrend(bars, barIdx);
      const options = [
        `持仓量持续增加——资金持续流入，趋势有望延续`,
        `持仓量大幅减少——资金离场，趋势可能反转`,
        `持仓量持平——多空力量均衡，震荡为主`,
        `持仓量与趋势背离——需警惕变盘`,
      ];
      let correctIdx = 2;
      if (oiChangePct > 3 && (trend === "up" || trend === "strong_up")) correctIdx = 0;
      else if (oiChangePct < -5) correctIdx = 1;
      else if (Math.abs(oiChangePct) < 1) correctIdx = 2;
      else if ((oiChangePct > 2 && (trend === "down" || trend === "strong_down")) || (oiChangePct < -2 && (trend === "up" || trend === "strong_up"))) correctIdx = 3;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx, showOI: true,
        question: `${bar.date}：持仓量变化${oiChangePct > 0 ? "+" : ""}${oiChangePct.toFixed(1)}%（${(bar.hold / 10000).toFixed(1)}万手），当前趋势为"${trend === "strong_up" ? "强多" : trend === "up" ? "多头" : trend === "down" ? "空头" : trend === "strong_down" ? "强空" : "震荡"}"。持仓量变化传递什么信号？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `持仓量反映资金态度：上涨趋势中持仓增加=多头增仓（趋势延续）；持仓减少=多头获利了结（可能见顶）。下跌趋势中持仓增加=空头增仓（趋势延续）；持仓减少=空头回补（可能见底）。当前持仓${oiChangePct > 0 ? "增加" : "减少"}${Math.abs(oiChangePct).toFixed(1)}%。`,
      };
    }
    default: {
      // 放量突破vs缩量突破
      const avgVol = bars.slice(Math.max(0, barIdx - 10), barIdx).reduce((s, b) => s + b.vol, 0) / 10;
      const isBreakout = bar.c > findSwingHigh(bars, barIdx, 15);
      const volRatio = avgVol > 0 ? bar.vol / avgVol : 1;
      const isVolumeBreakout = isBreakout && volRatio > 1.5;
      const options = [
        `放量突破——量能是均量的${volRatio.toFixed(1)}倍，突破有效概率高`,
        `缩量突破——量能不足（仅为均量${volRatio.toFixed(1)}倍），可能是假突破`,
        `非突破位置——当前不在关键位附近`,
        `需要回测确认——突破后应等待回踩确认`,
      ];
      let correctIdx = 2;
      if (isBreakout && volRatio > 1.5) correctIdx = 0;
      else if (isBreakout && volRatio < 1.0) correctIdx = 1;
      else if (isBreakout) correctIdx = 3;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx, showOI: true,
        question: `${bar.date}：价格${bar.c.toFixed(1)}，前期高点${findSwingHigh(bars, barIdx, 15).toFixed(1)}。成交量${(bar.vol / 1000).toFixed(0)}K，10日均量${(avgVol / 1000).toFixed(0)}K。如何评价这次${isBreakout ? "突破" : "走势"}？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks认为突破必须有成交量配合才可靠：放量突破（量能>均量1.5倍）说明有大量资金认同方向，突破有效概率高；缩量突破则可能是少数资金推动的假突破。${isBreakout ? `当前量能比为${volRatio.toFixed(1)}倍，${volRatio > 1.5 ? "属于放量突破" : volRatio > 1.0 ? "量能一般" : "属于缩量突破"}。` : "当前不在突破位置。"}`,
      };
    }
  }
}

// ── 3. 突破验证 ──

function generateBreakoutQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 4);
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const a = analyzeBar(bar);
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);
  const swingHigh = findSwingHigh(bars, barIdx, 15);
  const swingLow = findSwingLow(bars, barIdx, 15);

  switch (qType) {
    case 0: {
      // 真假突破判断
      const isBreakoutUp = bar.c > swingHigh;
      const next = barIdx + 1 < bars.length ? bars[barIdx + 1] : null;
      const nextA = next ? analyzeBar(next) : null;
      const isFalseBreakout = isBreakoutUp && next && next.c < swingHigh;
      const options = [
        `真突破——收盘价${bar.c.toFixed(1)}确认站上${swingHigh.toFixed(1)}上方`,
        `假突破——突破后快速回落到${swingHigh.toFixed(1)}以下，多方力量不足`,
        `尚未突破——价格仍在关键位下方`,
        `需要更多确认——等待回测或第二根确认K线`,
      ];
      let correctIdx = 2;
      if (isBreakoutUp && !isFalseBreakout) correctIdx = 0;
      else if (isFalseBreakout) correctIdx = 1;
      else if (!isBreakoutUp) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `关键阻力位：${swingHigh.toFixed(1)}。当前收盘价${bar.c.toFixed(1)}${isBreakoutUp ? "已突破阻力位" : "仍在阻力位下方"}。${next ? `下一根K线收${next.c.toFixed(1)}。` : ""}这是真突破还是假突破？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的突破确认原则：①收盘价必须明确站上关键位（不是盘中触及）②后续K线不能立即回落到关键位以下③最好有成交量配合。${isBreakoutUp ? (isFalseBreakout ? `突破后下一根K线回落到${next!.c.toFixed(1)}，低于阻力位${swingHigh.toFixed(1)}，属于假突破。` : "突破后未见回落，暂判为真突破。") : "价格未突破阻力位。"}`,
      };
    }
    case 1: {
      // 突破后回踩
      const brokeAbove = barIdx > 5 && bars.slice(barIdx - 5, barIdx).some((b) => b.c > swingHigh);
      const isRetest = brokeAbove && bar.l <= swingHigh * 1.005 && bar.c > swingHigh;
      const options = [
        `回踩成功——价格回测${swingHigh.toFixed(1)}后守住，突破有效，可以做多`,
        `回踩失败——价格跌破${swingHigh.toFixed(1)}，突破可能失败`,
        `尚未回踩——价格远离阻力位，等待回踩`,
        `这不是回踩——只是正常波动`,
      ];
      let correctIdx = 3;
      if (isRetest) correctIdx = 0;
      else if (brokeAbove && bar.c < swingHigh) correctIdx = 1;
      else if (!brokeAbove) correctIdx = 3;
      else correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `前期阻力位${swingHigh.toFixed(1)}。${brokeAbove ? "近期价格曾突破该位" : "价格尚未突破该位"}。当前K线：低${bar.l.toFixed(1)} 收${bar.c.toFixed(1)}。这次回踩是否成功？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的"突破回踩"（Breakout Pullback）策略：突破后价格回踩原阻力位（现在变成支撑位），如果回踩不破且收在其上方，是最佳的二次入场点。${isRetest ? `当前K线最低点${bar.l.toFixed(1)}触及阻力位附近后收回上方，回踩成功。` : brokeAbove ? "回踩跌破了阻力位，突破可能失败。" : "尚未形成突破，无从谈起回踩。"}`,
      };
    }
    case 2: {
      // 突破后的跟进棒质量
      const prevBar = barIdx > 0 ? bars[barIdx - 1] : null;
      if (!prevBar) return generateBreakoutQuestion(bars, code);
      const prevA = analyzeBar(prevBar);
      const wasBreakout = prevBar.c > findSwingHigh(bars, barIdx - 1, 15);
      const followGood = wasBreakout && a.isBull && a.bodyPct > 0.4;
      const options = [
        `跟进棒质量很好——继续放量上涨，突破趋势确立`,
        `跟进棒质量差——未能延续突破方向，可能反转`,
        `不是突破跟进——前一根K线并非突破`,
        `跟进棒一般——需要再观察一根K线`,
      ];
      let correctIdx = 2;
      if (wasBreakout && followGood) correctIdx = 0;
      else if (wasBreakout && !followGood) correctIdx = 1;
      else if (!wasBreakout) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `前一根K线（${prevBar.date}）收${prevBar.c.toFixed(1)}${wasBreakout ? "，突破了关键阻力位" : ""}。当前K线（${bar.date}）收${bar.c.toFixed(1)}，实体${(a.bodyPct * 100).toFixed(0)}%。这根跟进棒的质量如何？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks强调突破后的"跟进棒"（Follow-through Bar）至关重要：如果突破后第一根K线就反转，说明突破可能是假突破。好的跟进棒应该是同向、实体较大（>40%）、最好有量能配合。${wasBreakout ? (followGood ? "跟进棒延续了突破方向，质量好。" : "跟进棒未能延续，警惕假突破。") : "前一根并非突破K线。"}`,
      };
    }
    default: {
      // 突破方向选择（tap模式）
      let targetIdx = barIdx;
      for (let i = barIdx; i >= Math.max(0, barIdx - 15); i--) {
        if (bars[i].c > findSwingHigh(bars, i, 15) && analyzeBar(bars[i]).bodyPct > 0.5) {
          targetIdx = i;
          break;
        }
      }
      const tRelIdx = targetIdx - Math.max(0, barIdx - 30);
      return {
        id: nextQId(), type: "tap", code, bars: ctx,
        correctBarIndex: Math.max(0, Math.min(tRelIdx, ctx.length - 1)),
        question: "在图中找出最有效的一次向上突破（收盘确认、实体较大）：",
        explanation: `最有效的突破出现在${bars[targetIdx].date}：收盘价${bars[targetIdx].c.toFixed(1)}站上前期高点，实体占比${(analyzeBar(bars[targetIdx]).bodyPct * 100).toFixed(0)}%。Brooks认为这种"大实体+收盘确认"的突破是最可靠的。`,
      };
    }
  }
}

// ── 4. 市场三态 ──

function generateMarketStateQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);
  const trend = detectTrend(bars, barIdx);
  const ema = calcEMA(bars.slice(0, barIdx + 1), 20);
  const emaVal = ema[barIdx] || bar.c;
  const atr = calcATR(bars, barIdx);
  const distATR = atr > 0 ? (bar.c - emaVal) / atr : 0;

  // Count consecutive same-direction bars
  let consecutive = 0;
  const isBull = bar.c > bar.o;
  for (let i = barIdx; i >= Math.max(0, barIdx - 10); i--) {
    if ((bars[i].c > bars[i].o) === isBull) consecutive++;
    else break;
  }

  // Channel detection: price oscillating around EMA
  const last10 = bars.slice(Math.max(0, barIdx - 9), barIdx + 1);
  const aboveEMA = last10.filter((b) => b.c > (ema[barIdx - last10.indexOf(b)] || b.c)).length;
  const isChannel = aboveEMA >= 4 && aboveEMA <= 6;

  const stateMap = {
    strong_up: "强趋势（Always In 多头）",
    up: "趋势（多头方向）",
    range: "震荡区间（Trading Range）",
    down: "趋势（空头方向）",
    strong_down: "强趋势（Always In 空头）",
  };

  const options = [
    `趋势态——连续${consecutive}根${isBull ? "阳" : "阴"}线，价格距EMA20约${Math.abs(distATR).toFixed(1)}个ATR`,
    `通道态——价格围绕EMA20震荡上行/下行`,
    `震荡态——多空交替，无明显方向`,
    `反转态——趋势正在发生方向转变`,
  ];

  let correctIdx = 2;
  if (trend === "strong_up" || trend === "strong_down") correctIdx = 0;
  else if (trend === "up" || trend === "down") {
    correctIdx = isChannel ? 1 : 0;
  } else correctIdx = 2;

  const shuffled = shuffleOptions(options, correctIdx);

  return {
    id: nextQId(), type: "multi", code, bars: ctx,
    correctBarIndex: relIdx,
    question: `当前价格${bar.c.toFixed(1)}，EMA20=${emaVal.toFixed(1)}（距离${Math.abs(distATR).toFixed(1)}个ATR）。最近10根K线中${last10.filter((b) => b.c > b.o).length}阳${last10.filter((b) => b.c < b.o).length}阴。根据Brooks市场三态理论，当前市场处于什么状态？`,
    options: shuffled.options,
    correctOptionIndex: shuffled.correctIndex,
    explanation: `Brooks将市场分为三种状态：①趋势态（Trend）——价格远离EMA20，连续同向K线多，应顺势交易；②通道态（Channel）——价格沿EMA20缓慢推进，可双向交易但偏向顺势；③震荡态（Trading Range）——价格围绕EMA20上下波动，高低点重叠，应高抛低吸。当前判断为"${stateMap[trend]}"。`,
  };
}

// ── 5. Always In 方向 ──

function generateAlwaysInQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);
  const trend = detectTrend(bars, barIdx);
  const ema = calcEMA(bars.slice(0, barIdx + 1), 20);
  const emaVal = ema[barIdx] || bar.c;

  // AI Direction logic
  let aiDirection: "long" | "short" | "none" = "none";
  if (trend === "strong_up" || trend === "up") aiDirection = "long";
  else if (trend === "strong_down" || trend === "down") aiDirection = "short";

  // Check for AI flip
  const prevTrend = detectTrend(bars, Math.max(0, barIdx - 5));
  const wasLong = prevTrend === "strong_up" || prevTrend === "up";
  const wasShort = prevTrend === "strong_down" || prevTrend === "down";
  const isFlip = (wasLong && aiDirection === "short") || (wasShort && aiDirection === "long");

  const dirText = aiDirection === "long" ? "Always In 多头" : aiDirection === "short" ? "Always In 空头" : "无明确方向";
  const options = [
    `Always In 多头——只应做多或观望，不应做空`,
    `Always In 空头——只应做空或观望，不应做多`,
    `无明确AI方向——市场处于震荡，可双向交易`,
    `AI正在翻转——从${wasLong ? "多" : "空"}翻${aiDirection === "long" ? "多" : "空"}，注意方向变化`,
  ];

  let correctIdx = 2;
  if (isFlip) correctIdx = 3;
  else if (aiDirection === "long") correctIdx = 0;
  else if (aiDirection === "short") correctIdx = 1;

  const shuffled = shuffleOptions(options, correctIdx);

  return {
    id: nextQId(), type: "multi", code, bars: ctx,
    correctBarIndex: relIdx,
    question: `当前价格${bar.c.toFixed(1)}，EMA20=${emaVal.toFixed(1)}。趋势判断为"${trend === "strong_up" ? "强多" : trend === "up" ? "多头" : trend === "down" ? "空头" : trend === "strong_down" ? "强空" : "震荡"}"。${isFlip ? "近期趋势方向有变化。" : ""}根据Brooks的Always In理论，当前AI方向是什么？`,
    options: shuffled.options,
    correctOptionIndex: shuffled.correctIndex,
    explanation: `Always In是Brooks最核心的概念之一：如果市场处于明确的趋势中，你应该"始终在场"（Always In），只顺趋势方向交易。${aiDirection !== "none" ? `当前AI方向为${dirText}，逆势交易的胜率极低。` : "当前市场无明确趋势，AI方向不明确。"}${isFlip ? "注意：AI方向正在发生翻转，这是重要的趋势转折信号。" : ""}`,
  };
}

// ── 6. 止损位设置 ──

function generateStopLossQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);
  const atr = calcATR(bars, barIdx);
  const swingLow = findSwingLow(bars, barIdx, 10);
  const swingHigh = findSwingHigh(bars, barIdx, 10);
  const ema = calcEMA(bars.slice(0, barIdx + 1), 20);
  const emaVal = ema[barIdx] || bar.c;

  // Assume long entry at current close
  const entryPrice = bar.c;
  const atrStop = entryPrice - atr * 1.5;
  const swingStop = swingLow - atr * 0.3;
  const emaStop = emaVal - atr * 0.5;
  const risk1 = Math.abs(entryPrice - atrStop);
  const risk2 = Math.abs(entryPrice - swingStop);
  const risk3 = Math.abs(entryPrice - emaStop);

  const options = [
    `ATR止损：${atrStop.toFixed(1)}（1.5倍ATR=${(atr * 1.5).toFixed(1)}点，风险${risk1.toFixed(1)}点）`,
    `摆动低点止损：${swingStop.toFixed(1)}（近期低点下方，风险${risk2.toFixed(1)}点）`,
    `EMA20止损：${emaStop.toFixed(1)}（均线下方，风险${risk3.toFixed(1)}点）`,
    `固定百分比止损：${(entryPrice * 0.98).toFixed(1)}（2%固定止损）`,
  ];

  // Best stop is usually swing low for structure-based trading
  const bestIdx = risk2 < risk1 && risk2 < risk3 ? 1 : risk1 < risk3 ? 0 : 2;
  const shuffled = shuffleOptions(options, bestIdx);

  return {
    id: nextQId(), type: "multi", code, bars: ctx,
    correctBarIndex: relIdx,
    question: `假设你在${entryPrice.toFixed(1)}做多入场。当前ATR=${atr.toFixed(1)}，近期摆动低点=${swingLow.toFixed(1)}，EMA20=${emaVal.toFixed(1)}。根据Brooks理论，最佳止损位应该设在哪里？`,
    options: shuffled.options,
    correctOptionIndex: shuffled.correctIndex,
    explanation: `Brooks推荐将止损设在"结构位"（摆动低点/高点）而非固定金额。原因：①结构位是市场共识的防守位②止损距离由市场结构决定，而非主观意愿③被止损说明交易逻辑被证伪。当前摆动低点${swingLow.toFixed(1)}在下方${(entryPrice - swingLow).toFixed(1)}点处，${risk2 < risk1 ? "比ATR止损更紧凑" : "比ATR止损更宽松"}，风险${risk2.toFixed(1)}点。`,
  };
}

// ── 7. K线形态基础 ──

function generateKlineBasicQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 4);
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const a = analyzeBar(bar);
  const prev = barIdx > 0 ? bars[barIdx - 1] : null;
  const prevA = prev ? analyzeBar(prev) : null;
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);

  switch (qType) {
    case 0: {
      // 单根K线形态识别
      let pattern = "普通K线";
      let correctIdx = 3;
      if (a.bodyPct < 0.1) { pattern = "十字星（Doji）"; correctIdx = 0; }
      else if (a.lowerWickPct > 0.6 && a.bodyPct < 0.35) { pattern = "锤头线（Hammer）"; correctIdx = 1; }
      else if (a.upperWickPct > 0.6 && a.bodyPct < 0.35) { pattern = "倒锤头/射击之星"; correctIdx = 2; }
      const options = [
        `十字星——开收盘几乎相同（实体仅${(a.bodyPct * 100).toFixed(0)}%），市场犹豫不决`,
        `锤头线——下影线长（${(a.lowerWickPct * 100).toFixed(0)}%），下方有支撑`,
        `射击之星——上影线长（${(a.upperWickPct * 100).toFixed(0)}%），上方有压力`,
        `${a.isBull ? "阳线" : "阴线"}——实体${(a.bodyPct * 100).toFixed(0)}%，${a.isBull ? "多方" : "空方"}占优`,
      ];
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `${bar.date} K线：开${bar.o.toFixed(1)} 高${bar.h.toFixed(1)} 低${bar.l.toFixed(1)} 收${bar.c.toFixed(1)}。实体${(a.bodyPct * 100).toFixed(0)}%，上影${(a.upperWickPct * 100).toFixed(0)}%，下影${(a.lowerWickPct * 100).toFixed(0)}%。这根K线属于什么形态？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `K线形态分析：实体反映多空力量对比，影线反映极端价格被拒绝的程度。${pattern === "十字星（Doji）" ? "十字星表示市场犹豫，在趋势末端常预示反转。" : pattern === "锤头线（Hammer）" ? "锤头线的长下影说明空方曾打压但被多方收复，是底部反转信号。" : pattern === "倒锤头/射击之星" ? "长上影说明多方曾冲高但被空方打压，是顶部反转信号。" : `实体占比${(a.bodyPct * 100).toFixed(0)}%的${a.isBull ? "阳" : "阴"}线，${a.bodyPct > 0.6 ? "力度较强" : "力度一般"}。`}`,
      };
    }
    case 1: {
      // 两根K线组合
      if (!prev || !prevA) return generateKlineBasicQuestion(bars, code);
      const isEngulfing = !prevA.isBull && a.isBull && bar.o < prev.c && bar.c > prev.o && a.body > prevA.body;
      const isBearEngulfing = prevA.isBull && !a.isBull && bar.o > prev.c && bar.c < prev.o && a.body > prevA.body;
      const isPiercing = !prevA.isBull && a.isBull && bar.o < prev.l && bar.c > (prev.o + prev.c) / 2;
      const options = [
        `多头吞没——阳线实体完全吞没前一根阴线，强烈看涨信号`,
        `空头吞没——阴线实体完全吞没前一根阳线，强烈看跌信号`,
        `刺透形态——阳线收盘深入前一根阴线实体中部以上，看涨信号`,
        `无明显组合形态——两根K线之间无特殊关系`,
      ];
      let correctIdx = 3;
      if (isEngulfing) correctIdx = 0;
      else if (isBearEngulfing) correctIdx = 1;
      else if (isPiercing) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `前一根K线（${prev.date}）：${prevA.isBull ? "阳" : "阴"}线，开${prev.o.toFixed(1)} 收${prev.c.toFixed(1)}。当前K线（${bar.date}）：${a.isBull ? "阳" : "阴"}线，开${bar.o.toFixed(1)} 收${bar.c.toFixed(1)}。这两根K线形成什么组合形态？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `两根K线组合是Brooks体系中最基础也最重要的形态。${isEngulfing ? "多头吞没是最强的底部反转信号之一：后一根阳线实体完全吞没前一根阴线，表明多方彻底扭转了局面。" : isBearEngulfing ? "空头吞没是最强的顶部反转信号：后一根阴线实体完全吞没前一根阳线，空方完全掌控。" : isPiercing ? "刺透形态是次强的底部反转信号：阳线收盘深入阴线实体50%以上。" : "这两根K线没有形成经典的组合形态。"}`,
      };
    }
    case 2: {
      // 三根K线组合
      if (barIdx < 2) return generateKlineBasicQuestion(bars, code);
      const b1 = bars[barIdx - 2];
      const b2 = bars[barIdx - 1];
      const b3 = bars[barIdx];
      const a1 = analyzeBar(b1);
      const a2 = analyzeBar(b2);
      const a3 = analyzeBar(b3);
      const isMorningStar = !a1.isBull && a2.bodyPct < 0.2 && a3.isBull && b3.c > (b1.o + b1.c) / 2;
      const isEveningStar = a1.isBull && a2.bodyPct < 0.2 && !a3.isBull && b3.c < (b1.o + b1.c) / 2;
      const isThreeSoldiers = a1.isBull && a2.isBull && a3.isBull && b2.c > b1.c && b3.c > b2.c;
      const isThreeCrows = !a1.isBull && !a2.isBull && !a3.isBull && b2.c < b1.c && b3.c < b2.c;
      const options = [
        `早晨之星——阴线+小实体+阳线，经典底部反转`,
        `黄昏之星——阳线+小实体+阴线，经典顶部反转`,
        `红三兵——三根递升阳线，强势看涨`,
        `三只乌鸦——三根递降阴线，强势看跌`,
      ];
      let correctIdx = 0;
      if (isMorningStar) correctIdx = 0;
      else if (isEveningStar) correctIdx = 1;
      else if (isThreeSoldiers) correctIdx = 2;
      else if (isThreeCrows) correctIdx = 3;
      else {
        // No clear pattern, ask about the strongest one
        if (a3.isBull && a2.isBull) correctIdx = 2;
        else if (!a3.isBull && !a2.isBull) correctIdx = 3;
        else correctIdx = a3.isBull ? 0 : 1;
      }
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `最近三根K线：${b1.date}(${a1.isBull ? "阳" : "阴"})、${b2.date}(${a2.isBull ? "阳" : "阴"})、${b3.date}(${a3.isBull ? "阳" : "阴"})。这三根K线形成什么组合？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `三根K线组合在Brooks体系中具有更高的可靠性。${isMorningStar ? "早晨之星：第一根阴线表明空方控制，中间小实体表明犹豫，第三根阳线确认多方反攻。" : isEveningStar ? "黄昏之星：与早晨之星相反，是顶部反转信号。" : isThreeSoldiers ? "红三兵：三根递升阳线且每根收盘都高于前一根，是极强看涨信号。" : isThreeCrows ? "三只乌鸦：三根递降阴线，是极强看跌信号。" : "这三根K线没有形成标准的三棒组合，但整体偏向" + (a3.isBull ? "看涨" : "看跌") + "。"}`,
      };
    }
    default: {
      // 找出锤头线（tap模式）
      let targetIdx = barIdx;
      for (let i = barIdx; i >= Math.max(0, barIdx - 15); i--) {
        const ba = analyzeBar(bars[i]);
        if (ba.lowerWickPct > 0.5 && ba.bodyPct < 0.35) {
          targetIdx = i;
          break;
        }
      }
      const tRelIdx = targetIdx - Math.max(0, barIdx - 30);
      const ta = analyzeBar(bars[targetIdx]);
      return {
        id: nextQId(), type: "tap", code, bars: ctx,
        correctBarIndex: Math.max(0, Math.min(tRelIdx, ctx.length - 1)),
        question: "在图中找出锤头线（Hammer）——下影线长、实体小的K线：",
        explanation: `锤头线出现在${bars[targetIdx].date}：下影线占比${(ta.lowerWickPct * 100).toFixed(0)}%，实体仅${(ta.bodyPct * 100).toFixed(0)}%。锤头线的含义：空方曾将价格大幅打压，但多方在收盘前收复了大部分失地，表明下方有强劲支撑。Brooks认为在下跌趋势末端出现的锤头线是高胜率的反转信号。`,
      };
    }
  }
}

// ── 8. 回踩入场 ──

function generatePullbackQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 4);
  const barIdx = randomBarIdx(bars);
  const bar = bars[barIdx];
  const a = analyzeBar(bar);
  const ctx = contextBars(bars, barIdx);
  const relIdx = Math.min(barIdx - Math.max(0, barIdx - 30), ctx.length - 1);
  const ema = calcEMA(bars.slice(0, barIdx + 1), 20);
  const emaVal = ema[barIdx] || bar.c;
  const trend = detectTrend(bars, barIdx);
  const atr = calcATR(bars, barIdx);

  switch (qType) {
    case 0: {
      // EMA20回踩判断
      const isUptrend = trend === "up" || trend === "strong_up";
      const touchedEMA = bar.l <= emaVal && bar.c > emaVal;
      const isPullbackBuy = isUptrend && touchedEMA;
      const options = [
        `是EMA20回踩买点——上升趋势中价格回踩EMA20（${emaVal.toFixed(1)}）后收回上方`,
        `不是回踩——虽然触及EMA20但收在其下方，可能趋势转变`,
        `不是回踩——当前趋势不明确，EMA20回踩不可靠`,
        `需要更多确认——等下一根K线确认方向`,
      ];
      let correctIdx = 3;
      if (isPullbackBuy) correctIdx = 0;
      else if (touchedEMA && bar.c < emaVal) correctIdx = 1;
      else if (!isUptrend) correctIdx = 2;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `当前趋势：${isUptrend ? "上升" : trend === "range" ? "震荡" : "下降"}。EMA20=${emaVal.toFixed(1)}。本K线：低${bar.l.toFixed(1)} 收${bar.c.toFixed(1)}。这是否是一个有效的EMA20回踩做多机会？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的EMA20回踩策略：在明确上升趋势中，价格回踩EMA20均线后收回上方，是高胜率的做多入场点。条件：①趋势明确向上②价格触及或略破EMA20③收盘收回EMA20上方④最好出现多头信号棒。当前${isPullbackBuy ? "满足所有条件。" : touchedEMA ? "虽然触及EMA20但收在下方，不满足条件。" : !isUptrend ? "趋势不够明确，EMA20回踩不可靠。" : "价格未触及EMA20。"}`,
      };
    }
    case 1: {
      // 回踩深度评估
      const recentHigh = findSwingHigh(bars, barIdx, 15);
      const recentLow = findSwingLow(bars, barIdx, 15);
      const range = recentHigh - recentLow;
      const retracePct = range > 0 ? ((recentHigh - bar.c) / range) * 100 : 0;
      let depthAssessment = "";
      let correctIdx = 3;
      if (retracePct < 23.6) { depthAssessment = "浅回踩（<23.6%），趋势极强"; correctIdx = 0; }
      else if (retracePct < 38.2) { depthAssessment = "标准回踩（23.6-38.2%），趋势强劲"; correctIdx = 1; }
      else if (retracePct < 61.8) { depthAssessment = "深度回踩（38.2-61.8%），可能反转"; correctIdx = 2; }
      else { depthAssessment = "超深度回踩（>61.8%），趋势可能已结束"; correctIdx = 3; }
      const options = [
        `浅回踩（<23.6%）——趋势极强，可直接入场`,
        `标准回踩（23.6-38.2%）——最佳入场区域，风险回报比最优`,
        `深度回踩（38.2-61.8%）——需要更强的信号确认`,
        `超深度回踩（>61.8%）——趋势可能已结束，不宜入场`,
      ];
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `近期高点${recentHigh.toFixed(1)}，低点${recentLow.toFixed(1)}，当前价格${bar.c.toFixed(1)}。从高点回踩了约${retracePct.toFixed(0)}%。根据Brooks理论，这个回踩深度意味着什么？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks将回踩深度分为几个区间：浅回踩（<23.6%）说明趋势极强但入场位置不佳；标准回踩（23.6-38.2%）是最佳入场区域；深度回踩（38.2-61.8%）需要更强的信号确认；超深度回踩（>61.8%）通常意味着趋势已经结束。当前回踩${retracePct.toFixed(0)}%，${depthAssessment}。`,
      };
    }
    case 2: {
      // 双底/双顶回踩
      const prevLow = findSwingLow(bars, Math.max(0, barIdx - 8), 10);
      const currentLow = bar.l;
      const isDoubleBottom = Math.abs(currentLow - prevLow) / atr < 0.5 && bar.c > bar.o;
      const prevHigh = findSwingHigh(bars, Math.max(0, barIdx - 8), 10);
      const currentHigh = bar.h;
      const isDoubleTop = Math.abs(currentHigh - prevHigh) / atr < 0.5 && bar.c < bar.o;
      const options = [
        `双底形态——两次测试${prevLow.toFixed(1)}附近支撑未破，可能反转上涨`,
        `双顶形态——两次测试${prevHigh.toFixed(1)}附近阻力未过，可能反转下跌`,
        `不是双底/双顶——价格距前低/前高较远`,
        `需要第三根K线确认——双底/双顶形态尚不完整`,
      ];
      let correctIdx = 2;
      if (isDoubleBottom) correctIdx = 0;
      else if (isDoubleTop) correctIdx = 1;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `前期摆动低点${prevLow.toFixed(1)}，当前K线低点${bar.l.toFixed(1)}。前期摆动高点${prevHigh.toFixed(1)}，当前K线高点${bar.h.toFixed(1)}。当前是否形成双底或双顶形态？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的双底/双顶（Double Bottom/Top）是重要的反转形态：两次测试同一价位而未破，说明该价位有强支撑/阻力。${isDoubleBottom ? `当前形成双底（两次测试${prevLow.toFixed(1)}附近），且当前K线收阳，反转概率较高。` : isDoubleTop ? `当前形成双顶（两次测试${prevHigh.toFixed(1)}附近），且当前K线收阴，反转概率较高。` : "当前价格距前低/前高较远，未形成双底/双顶。"}`,
      };
    }
    default: {
      // 趋势通道回踩
      const isUptrend = trend === "up" || trend === "strong_up";
      const distToEMA = Math.abs(bar.c - emaVal);
      const isNearEMA = distToEMA < atr * 0.8;
      const options = [
        `趋势通道回踩——上升趋势中价格回踩通道下轨/EMA20附近，可以做多`,
        `通道已破——价格跌破通道，不宜再做多`,
        `非趋势通道——市场处于震荡，通道策略不适用`,
        `通道回踩但信号不足——需要等待更好的信号棒`,
      ];
      let correctIdx = 2;
      if (isUptrend && isNearEMA && a.isBull) correctIdx = 0;
      else if (isUptrend && bar.c < emaVal - atr) correctIdx = 1;
      else if (!isUptrend) correctIdx = 2;
      else if (isUptrend && isNearEMA) correctIdx = 3;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(), type: "multi", code, bars: ctx,
        correctBarIndex: relIdx,
        question: `趋势：${isUptrend ? "上升" : "非上升"}。价格${bar.c.toFixed(1)}，EMA20=${emaVal.toFixed(1)}（距离${(distToEMA / atr).toFixed(1)}个ATR）。本K线${a.isBull ? "收阳" : "收阴"}。当前是否为趋势通道回踩入场点？`,
        options: shuffled.options,
        correctOptionIndex: shuffled.correctIndex,
        explanation: `Brooks的趋势通道交易策略：在上升趋势中，价格沿EMA20形成的通道运行。当价格回踩到通道下轨（通常在EMA20附近0.5-1个ATR内）时，如果出现多头信号棒，是很好的入场点。${isUptrend && isNearEMA ? (a.isBull ? "当前满足条件：上升趋势+回踩EMA20附近+收阳。" : "虽然回踩到EMA20附近但未收阳，信号不足。") : !isUptrend ? "当前不是上升趋势，通道策略不适用。" : "价格不在通道下轨附近。"}`,
      };
    }
  }
}

// ── 13. 仓位与风控（交易者方程 / 加仓 / 时间止损）──

function generateRiskQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  const qType = Math.floor(Math.random() * 8);
  // 风控题为概念计算题，correctBarIndex 仅用于去重，取随机值确保能生成多题
  const barIdx = Math.floor(Math.random() * bars.length);

  const mkQ = (question: string, options: string[], correctIdx: number, explanation: string): GeneratedQuestion => {
    const shuffled = shuffleOptions(options, correctIdx);
    return {
      id: nextQId(), type: "multi", code, bars: [],
      correctBarIndex: barIdx,
      question, options: shuffled.options,
      correctOptionIndex: shuffled.correctIndex,
      explanation,
    };
  };

  // ── 类型0：交易者方程基础计算 ──
  if (qType === 0) {
    const entry = Math.round(3000 + Math.random() * 2000);
    const stopPts = [40, 50, 60, 68, 80, 100][Math.floor(Math.random() * 6)];
    const targetPts = stopPts * [2, 2.5, 3][Math.floor(Math.random() * 3)];
    const stop = entry - stopPts;
    const target = entry + targetPts;
    const P = [50, 55, 60, 65][Math.floor(Math.random() * 4)] / 100;
    const ev = P * targetPts;
    const risk = (1 - P) * stopPts;
    const isPositive = ev > risk;
    return mkQ(
      `做多场景：入场${entry}，止损${stop}（-${stopPts}点），目标${target}（+${targetPts}点），估计胜率${(P * 100).toFixed(0)}%。根据交易者方程 P×R > (1-P)×S，这笔交易是否值得做？`,
      [
        `值得做——期望值${ev.toFixed(0)} > 风险${risk.toFixed(0)}，方程为正`,
        `不值得做——期望值${ev.toFixed(0)} ≤ 风险${risk.toFixed(0)}，方程为负`,
        `无法判断——缺少市场状态信息`,
        `不值得做——盈亏比不够高`,
      ],
      isPositive ? 0 : 1,
      `交易者方程：P×R = ${P}×${targetPts} = ${ev.toFixed(1)}；(1-P)×S = ${(1 - P).toFixed(2)}×${stopPts} = ${risk.toFixed(1)}。${ev.toFixed(1)} ${isPositive ? ">" : "≤"} ${risk.toFixed(1)}，所以方程${isPositive ? "为正，值得做" : "为负，应放弃"}。Brooks规则：方程为负的交易坚决不做。`,
    );
  }

  // ── 类型1：概率与盈亏比匹配 ──
  if (qType === 1) {
    const scenarios = [
      { p: 60, minRR: "1:1", desc: "高概率允许低盈亏比" },
      { p: 50, minRR: "1.5:1", desc: "中等概率需要1.5:1" },
      { p: 40, minRR: "2:1", desc: "低概率要求高盈亏比" },
      { p: 30, minRR: "3:1", desc: "很低概率需要极高盈亏比" },
    ];
    const s = scenarios[Math.floor(Math.random() * scenarios.length)];
    return mkQ(
      `根据Brooks的概率与盈亏比匹配表，当估计胜率约为${s.p}%时，最低可接受的盈亏比是多少？`,
      ["1:1（盈亏相等即可）", "1.5:1", "2:1", "3:1"],
      s.p === 60 ? 0 : s.p === 50 ? 1 : s.p === 40 ? 2 : 3,
      `概率与盈亏比匹配表：胜率60%→最低1:1；50%→1.5:1；40%→2:1；30%→3:1。胜率${s.p}%属于"${s.desc}"的情况，最低需要${s.minRR}。Brooks原话：不确定时假设50%胜率。`,
    );
  }

  // ── 类型2：仓位大小计算 ──
  if (qType === 2) {
    const account = [50, 100, 200][Math.floor(Math.random() * 3)]; // 万
    const riskPct = 2;
    const maxLoss = account * 10000 * (riskPct / 100); // 元
    const stopPts = [50, 68, 80, 100][Math.floor(Math.random() * 4)];
    const pointValue = 10; // 每点10元
    const perLotLoss = stopPts * pointValue;
    const lots = Math.floor(maxLoss / perLotLoss);
    return mkQ(
      `账户权益${account}万，单笔风险控制在${riskPct}%（即最大可亏${(maxLoss / 10000).toFixed(0)}万元）。止损${stopPts}点，该品种每点价值${pointValue}元/手。应开多少手？`,
      [
        `${lots}手——仓位=${(maxLoss / 10000).toFixed(0)}万÷(${stopPts}点×${pointValue}元)=${lots}手`,
        `${lots * 2}手——止损越小仓位可以越大`,
        `${Math.max(1, Math.floor(lots / 2))}手——保守起见减半`,
        `固定10手——与止损距离无关`,
      ],
      0,
      `仓位公式：仓位 = 最大可接受亏损 ÷ 每手止损亏损。最大可亏=${account}万×${riskPct}%=${maxLoss.toFixed(0)}元；每手止损亏损=${stopPts}点×${pointValue}元=${perLotLoss}元；仓位=${maxLoss.toFixed(0)}÷${perLotLoss}=${lots}手。核心：止损越远，仓位越小，这是数学不是主观判断。`,
    );
  }

  // ── 类型3：止损距离与仓位的关系 ──
  if (qType === 3) {
    return mkQ(
      `同样的账户和风险比例，止损从68点扩大到100点，仓位应该如何调整？`,
      [
        `减小仓位——止损越远每手亏损越大，仓位必须减小以保持风险一致`,
        `加大仓位——止损远说明给市场更多空间，应该加仓`,
        `保持不变——仓位只与账户大小有关`,
        `取决于对市场方向的信心`,
      ],
      0,
      `举例：2万风险额度，止损68点×10元=每手亏680元→可开29手；止损100点×10元=每手亏1000元→只能开20手。止损距离扩大，每手风险增加，仓位必须相应减小，才能保持总风险暴露一致（2万）。这是仓位管理的铁律。`,
    );
  }

  // ── 类型4：加仓核心原则 ──
  if (qType === 4) {
    return mkQ(
      `关于加仓（Scaling In），以下哪种做法符合Brooks的规范？`,
      [
        `第一笔浮盈后，等回调到EMA20出现新的信号棒再加仓，且每次加仓独立设止损`,
        `第一笔浮亏后加仓摊低成本，等待反弹解套`,
        `只要看好方向，随时加仓不需要等新信号`,
        `加仓后与第一笔共用一个止损位，方便管理`,
      ],
      0,
      `加仓三原则：①只在浮盈时加仓（浮盈说明市场确认你的判断）；②必须等新的信号棒（回调EMA20附近出现信号棒）；③每次加仓独立止损（不能合并计算）。浮亏加仓=逆势加码=情绪交易；无信号加仓=赌博；合并止损=风险暴露不清。`,
    );
  }

  // ── 类型5：加仓禁忌识别 ──
  if (qType === 5) {
    const entry = Math.round(3000 + Math.random() * 1000);
    const dropPts = [50, 80, 100][Math.floor(Math.random() * 3)];
    const current = entry - dropPts;
    return mkQ(
      `你在${entry}做多，现在价格跌到${current}（浮亏${dropPts}点）。你的止损还没触发。此时正确的做法是？`,
      [
        `持有等待，但绝不在浮亏时加仓摊低成本`,
        `在${current}加仓摊低成本，这样反弹到${entry - Math.floor(dropPts / 2)}就能回本`,
        `立即手动止损，不等价格止损触发`,
        `加仓并把止损下移，给市场更多空间`,
      ],
      0,
      `浮亏说明市场在告诉你"你的判断可能是错的"。此时加仓=逆势加码=情绪交易，如果价格继续下跌，亏损会加速扩大。正确做法：持有原仓位等待止损或反转信号，但绝不加仓。Brooks禁忌第一条：浮亏时加仓是最常见的爆仓原因。`,
    );
  }

  // ── 类型6：时间止损触发判断 ──
  if (qType === 6) {
    const stopPts = [60, 68, 80][Math.floor(Math.random() * 3)];
    const days = 3;
    const moved = Math.floor(stopPts * 0.3); // 波动不足50%
    return mkQ(
      `短线做多，止损幅度${stopPts}点。入场后${days}天了，价格只向目标方向移动了${moved}点（不足止损幅度的50%）。按照时间止损规则，应该？`,
      [
        `触发时间止损，无条件平仓——${days}天波动${moved}点 < ${stopPts}点×50%=${Math.floor(stopPts * 0.5)}点，动能不足`,
        `继续持有——价格止损没触发就不走`,
        `加仓——横盘说明在蓄力，突破后会有大行情`,
        `把止损放宽，给市场更多时间`,
      ],
      0,
      `时间止损规则：短线3天/波段5天内，价格波动不足止损幅度的50%，说明动能不足，应无条件平仓。逻辑：如果图形是对的，价格会走；3天不走说明市场不认可你的判断。到时间就平仓，不要"再等等看"，纪律就是纪律。`,
    );
  }

  // ── 类型7：时间止损与价格止损的关系 ──
  return mkQ(
    `关于时间止损和价格止损的关系，以下哪种理解是正确的？`,
    [
      `两者独立——任何一个触发都执行平仓，可能时间止损先触发（横盘），也可能价格止损先触发（急跌）`,
      `价格止损优先——只有价格止损才有效，时间止损只是参考`,
      `时间止损可以替代价格止损——到时间了不管盈亏都平仓`,
      `浮盈时不需要时间止损——赚钱的单子可以一直拿`,
    ],
    0,
    `时间止损与价格止损是两条独立的防线：价格止损防"急跌"，时间止损防"耗死"。可能价格止损先触发（快速下跌触及止损位），也可能时间止损先触发（3天横盘不动）。任何一个触发都无条件平仓。即使浮盈，如果时间止损触发且动能消失，也应平仓或至少把止损移到成本线以上锁定利润。`,
  );
}

// ── 主生成函数 ──

type ModuleGenerator = (bars: CandleBar[], code: string, context?: VarietyStat | null) => GeneratedQuestion;

const MODULE_GENERATORS: Record<string, ModuleGenerator> = {
  signal_bar: generateSignalQuestion,
  volume_oi: generateVolumeQuestion,
  breakout: generateBreakoutQuestion,
  market_state: generateMarketStateQuestion,
  always_in: generateAlwaysInQuestion,
  stop_loss: generateStopLossQuestion,
  basic_patterns: generateKlineBasicQuestion,
  pullback: generatePullbackQuestion,
  risk_management: generateRiskQuestion,
};

// ===== V16.2 CH 信号检测（移植自 server v16_engine.ts，用于雷达训练模块）=====
type CHSignalResult = {
  hasSignal: boolean;
  direction: '多' | '空' | '无';
  strength: '强' | '中' | '弱';
  pricePosition: number;
};

function detectCHSignal(bars: CandleBar[]): CHSignalResult {
  const len = bars.length;
  const noSignal: CHSignalResult = { hasSignal: false, direction: '无', strength: '弱', pricePosition: 0.5 };
  if (len < 30) return noSignal;

  const lookback = 20;
  const recent = bars.slice(-lookback);
  const hh20 = Math.max(...recent.map((b) => b.h));
  const ll20 = Math.min(...recent.map((b) => b.l));
  const lastBar = bars[len - 1];
  const channelWidth = hh20 - ll20;
  if (channelWidth === 0) return noSignal;

  const pricePosition = (lastBar.c - ll20) / channelWidth;
  if (pricePosition < -1 || pricePosition > 2) return { ...noSignal, pricePosition };

  // 近5日 vs 近20日振幅收缩检测
  const recent5 = bars.slice(-5);
  const recent20 = bars.slice(-20);
  const avgRange5 = recent5.reduce((s, b) => s + (b.h - b.l), 0) / 5;
  const avgRange20 = recent20.reduce((s, b) => s + (b.h - b.l), 0) / 20;
  const rangeContracting = avgRange20 > 0 && avgRange5 < avgRange20 * 0.85;

  // 上边界做空信号
  const nearUpper = pricePosition > 0.72 && pricePosition <= 1.05;
  const upperBearish = lastBar.c < lastBar.o || lastBar.c < recent[recent.length - 2].c;
  if (nearUpper && (rangeContracting || upperBearish)) {
    let strength: '强' | '中' | '弱' = '弱';
    if (rangeContracting && upperBearish && pricePosition > 0.9) strength = '强';
    else if (rangeContracting || (upperBearish && pricePosition > 0.85)) strength = '中';
    return { hasSignal: true, direction: '空', strength, pricePosition };
  }

  // 下边界做多信号
  const nearLower = pricePosition >= -0.03 && pricePosition < 0.28;
  const lowerBullish = lastBar.c > lastBar.o || lastBar.c > recent[recent.length - 2].c;
  if (nearLower && (rangeContracting || lowerBullish)) {
    let strength: '强' | '中' | '弱' = '弱';
    if (rangeContracting && lowerBullish && pricePosition < 0.1) strength = '强';
    else if (rangeContracting || (lowerBullish && pricePosition < 0.15)) strength = '中';
    return { hasSignal: true, direction: '多', strength, pricePosition };
  }

  return { ...noSignal, pricePosition };
}

// 生成 CH 信号识别题：优先寻找带真实信号的 K 线，找不到则回退方向判断
function generateCHSignalQuestion(bars: CandleBar[], code: string): GeneratedQuestion {
  for (let attempt = 0; attempt < 40; attempt++) {
    const barIdx = randomBarIdx(bars);
    if (barIdx < 30) continue;
    const history = bars.slice(0, barIdx + 1);
    const signal = detectCHSignal(history);
    if (signal.hasSignal) {
      const ctx = contextBars(bars, barIdx);
      const relIdx = barIdx - Math.max(0, barIdx - 30);
      const lastBar = history[history.length - 1];
      const options = [
        'CH 做空信号——价格触及通道上边界',
        'CH 做多信号——价格触及通道下边界',
        '无 CH 信号——价格处于通道中部',
      ];
      const correctIdx = signal.direction === '空' ? 0 : 1;
      const shuffled = shuffleOptions(options, correctIdx);
      return {
        id: nextQId(),
        type: 'multi',
        code,
        bars: ctx,
        correctBarIndex: Math.min(relIdx, ctx.length - 1),
        correctOptionIndex: shuffled.correctIndex,
        options: shuffled.options,
        question: `V16.2 信号系统：观察最后 20 根 K 线形成的通道，当前 K 线收盘 ${lastBar.c.toFixed(1)} 位于通道约 ${(signal.pricePosition * 100).toFixed(0)}% 位置（0%=下边界，100%=上边界）。这构成什么 CH 信号？`,
        explanation: `V16.2 的 CH 信号基于 20 周期 Donchian 通道：价格接近上边界（>72%）且振幅收缩或收阴 → 做空信号；接近下边界（<28%）且振幅收缩或收阳 → 做多信号。当前价格位置约 ${(signal.pricePosition * 100).toFixed(0)}%，构成${signal.direction}信号（强度：${signal.strength}）。`,
        showOI: false,
      };
    }
  }
  return generateAlwaysInQuestion(bars, code);
}

// 雷达V16.2信号驱动决策系统（CH信号识别 + 市场三态 + AI方向）
MODULE_GENERATORS.radar_v16 = (bars, code) => {
  const r = Math.random();
  if (r < 0.4) return generateCHSignalQuestion(bars, code);
  if (r < 0.7) return generateAlwaysInQuestion(bars, code);
  return generateMarketStateQuestion(bars, code);
};

// 品种特性基于真实回测统计出题（无 stats 时回退为量仓+突破混合）
MODULE_GENERATORS.variety_traits = (bars, code, context) => {
  if (context) return generateVarietyTraitsQuestion(bars, code, context);
  return Math.random() > 0.5 ? generateVolumeQuestion(bars, code) : generateBreakoutQuestion(bars, code);
};

// 品种性格题：基于 59×1000 回测的真实统计特征生成知识型选择题
function generateVarietyTraitsQuestion(bars: CandleBar[], code: string, stat: VarietyStat): GeneratedQuestion {
  const name = stat.name || code;
  const midIdx = Math.max(0, Math.min(bars.length - 1, Math.floor(bars.length * (0.35 + Math.random() * 0.3))));

  // 四类题型，随机抽取
  const builders: Array<() => { question: string; options: string[]; correctOptionIndex: number; explanation: string }> = [
    // 题型1：盈利难度（正收益配方占比）
    () => {
      const rate = stat.positiveRate;
      let correct = 1;
      if (rate >= 65) correct = 0;
      else if (rate < 45) correct = 2;
      const band = rate >= 65 ? '易盈利' : rate < 45 ? '较难盈利' : '中等难度';
      return {
        question: `在 ${name} 的 1000 次参数回测中，约 ${rate}% 的配方最终盈利。这反映了该品种的什么特性？`,
        options: ['易盈利：多数配方都能赚钱', '中等难度：约半数配方盈利', '较难盈利：少数配方才能赚钱'],
        correctOptionIndex: correct,
        explanation: `${name} 正收益配方占比约 ${rate}%，属于「${band}」品种。${
          rate >= 65
            ? '该品种盈利参数区间较宽，策略容错性强，适合稳定型策略。'
            : rate < 45
              ? '该品种盈利参数区间窄，对参数和入场时机要求高，交易难度较大。'
              : '该品种盈亏对参数较为敏感，需谨慎筛选策略组合。'
        }`,
      };
    },
    // 题型2：参数敏感度（收益率标准差）
    () => {
      const vol = stat.volatility;
      let correct = 0;
      if (vol < 8) correct = 2;
      else if (vol < 15) correct = 1;
      const level = vol >= 15 ? '高' : vol < 8 ? '低' : '中';
      return {
        question: `${name} 1000 个配方的收益率标准差约 ${vol}%，这说明该品种的什么特点？`,
        options: ['参数敏感度高：不同配方收益差异大', '参数敏感度中等', '参数敏感度低：收益对参数不敏感'],
        correctOptionIndex: correct,
        explanation: `${name} 收益率标准差约 ${vol}%，属于「${level}」参数敏感度。标准差越大，说明不同参数组合的表现差异越大，参数调优越重要；反之则策略更稳健。`,
      };
    },
    // 题型3：胜率与盈亏比风格
    () => {
      const wr = stat.avgWinRate;
      const pf = stat.avgProfitFactor;
      let correct = 2;
      if (pf >= 1.5) correct = 0;
      else if (wr >= 55) correct = 1;
      const style = pf >= 1.5 ? '趋势跟踪型（低胜率高盈亏比）' : wr >= 55 ? '高频小赚型（高胜率低盈亏比）' : '平衡型';
      return {
        question: `${name} 平均胜率约 ${wr}%、盈亏比约 ${pf}，属于哪种交易风格？`,
        options: ['趋势跟踪型：低胜率、高盈亏比', '高频小赚型：高胜率、低盈亏比', '平衡型：胜率与盈亏比适中'],
        correctOptionIndex: correct,
        explanation: `${name} 胜率约 ${wr}%、盈亏比约 ${pf}，属于「${style}」。盈亏比 > 1.5 通常靠少数大盈利覆盖多次小亏损；胜率 > 55% 则靠高频小幅盈利积累。`,
      };
    },
    // 题型4：最优 vs 中位收益差距（上限与兑现难度）
    () => {
      const gap = stat.bestReturnPct - stat.medianReturnPct;
      let correct = 0;
      if (gap < 5) correct = 2;
      else if (gap < 15) correct = 1;
      return {
        question: `${name} 最优配方收益率约 ${stat.bestReturnPct}%，中位数约 ${stat.medianReturnPct}%，差距约 ${Math.round(gap)} 个百分点，这说明了什么？`,
        options: ['上限高但兑现难，需精准参数', '潜力一般，超额收益有限', '中位收益已接近上限'],
        correctOptionIndex: correct,
        explanation: `${name} 最优与中位收益差距约 ${Math.round(gap)} 个百分点。差距越大，说明该品种「上限高但兑现难」，需要精准的参数优化才能吃到超额收益；差距小则策略天花板明显。`,
      };
    },
  ];

  const builder = builders[Math.floor(Math.random() * builders.length)];
  const r = builder();
  return {
    id: nextQId(),
    type: 'multi',
    code,
    bars,
    correctBarIndex: midIdx,
    correctOptionIndex: r.correctOptionIndex,
    options: r.options,
    question: r.question,
    explanation: r.explanation,
    showOI: false,
  };
}

// 每日一问从所有模块随机选
MODULE_GENERATORS.socratic = (bars, code) => {
  const gens = [
    generateSignalQuestion, generateVolumeQuestion, generateBreakoutQuestion,
    generateMarketStateQuestion, generateAlwaysInQuestion, generateStopLossQuestion,
    generateKlineBasicQuestion, generatePullbackQuestion,
  ];
  return gens[Math.floor(Math.random() * gens.length)](bars, code);
};

// 错题回顾从信号/量仓/突破中随机选（实际应从错题库取，这里作为fallback）
MODULE_GENERATORS.error_review = (bars, code) => {
  const gens = [generateSignalQuestion, generateVolumeQuestion, generateBreakoutQuestion];
  return gens[Math.floor(Math.random() * gens.length)](bars, code);
};

export function generateModuleQuestions(
  moduleId: string,
  bars: CandleBar[],
  code: string,
  count: number,
  context?: VarietyStat | null,
): GeneratedQuestion[] {
  const generator = MODULE_GENERATORS[moduleId];
  if (!generator || bars.length < 40) return [];

  const questions: GeneratedQuestion[] = [];
  const usedIndices = new Set<number>();

  for (let i = 0; i < count; i++) {
    let attempts = 0;
    let q: GeneratedQuestion | null = null;
    while (attempts < 5) {
      try {
        q = generator(bars, code, context);
        // Avoid duplicate questions by checking if the correct bar index is too close
        if (!usedIndices.has(q.correctBarIndex)) {
          usedIndices.add(q.correctBarIndex);
          break;
        }
        q = null;
      } catch {
        q = null;
      }
      attempts++;
    }
    if (q) questions.push(q);
  }

  return questions;
}
