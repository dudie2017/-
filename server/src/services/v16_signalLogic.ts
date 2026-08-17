/**
 * Brooks V16.2 信号逻辑纯函数
 * 
 * 从 v16_engine.ts 抽取的"信号驱动"纯计算模块，不涉及 IO 与全局状态。
 * 包含: P(顺)方向概率、Gate4、楔形过滤、CH检测、MM测量、方向阵营、
 *       Edge统计验证、Final Flag、一句话总结。
 */

import { type BarData } from './varieties.js';
import { calcEMA, calcATR, detectII, detectIOI, evaluateSignalBar, countTrendBars, detectTightTR } from './indicators.js';
import type {
  V16Row, DirectionCamp, DirectionCampResult,
  DirectionalProbability, Gate4Result, WedgeFilterResult,
  CHSignal, MMMeasurement,
} from './v16_types.js';

// ===== 常数 =====
const G4_MIN_REASONS = 3;        // Gate4最少理由数
const DIRECTION_CAMP_WINDOW = 21; // 方向阵营窗口

// ===== 1. P(顺) 方向概率 (Softmax三情景) =====
export function calcDirectionalProbability(
  bars: BarData[],
  aiDirection: string,
  adx: number,
  trendStrength: number,
  lastBar: BarData,
): DirectionalProbability {
  const len = bars.length;
  if (len < 20) return { p_follow: 0.33, p_counter: 0.33, p_range: 0.34, context: '数据不足' };

  const recent = bars.slice(-10);
  const closes = bars.map((b) => b.c);

  // 1. 趋势方向一致度
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const ema20Last = ema20[len - 1];
  const ema50Last = ema50[len - 1];
  const emaAligned = (ema20Last > ema50Last && aiDirection === '多') ||
    (ema20Last < ema50Last && aiDirection === '空');
  let trendAlignScore = emaAligned ? 0.35 : 0.0;

  // 2. 动量方向
  const shortMA = closes[len - 1];
  const longMA = ema20Last;
  const momentumUp = shortMA > longMA;
  let momentumScore = (momentumUp && aiDirection === '多') ||
    (!momentumUp && aiDirection === '空') ? 0.25 : 0.0;

  // 3. 趋势强度贡献
  const adxNorm = Math.min(adx / 50, 1.0);
  let trendScore = trendStrength > 60 ? 0.25 * adxNorm : 0.10 * adxNorm;

  // 4. 近期波动率
  const atr = calcATR(bars, 14);
  const atrLast = atr[len - 1];
  const atrPct = (atrLast / lastBar.c) * 100;
  const volScore = atrPct > 3 ? 0.15 : atrPct > 1.5 ? 0.10 : 0.05;

  // Softmax三情景
  const followRaw = trendAlignScore + momentumScore + trendScore + volScore;
  const counterRaw = (0.35 - trendAlignScore) + (0.25 - momentumScore) + (0.25 - trendScore);
  const rangeRaw = Math.min(1.0 - followRaw - counterRaw, 1.0);
  const sum = Math.max(followRaw + counterRaw + rangeRaw, 0.001);
  const pFollow = followRaw / sum;
  const pCounter = counterRaw / sum;
  const pRange = rangeRaw / sum;

  let context: string;
  if (adx > 40 && trendStrength > 70) context = '强趋势';
  else if (adx > 25 && trendStrength > 50) context = '弱趋势';
  else if (adx < 20) context = '区间震荡';
  else context = '高波动';

  return { p_follow: pFollow, p_counter: pCounter, p_range: pRange, context };
}

// ===== Gate4 实验配置 =====
export interface Gate4Config {
  minReasons?: number;           // 最低理由数（默认3）
  disabledReasons?: number[];    // 关闭的理由编号 [1-5]
  requiredReasons?: number[];    // 必须通过的理由编号
  mergeReasons?: [number, number]; // 合并的理由对（OR 逻辑）
}

// Gate4 理由前缀映射（用于 requiredReasons 匹配）
function getReasonPrefix(reasonIdx: number): string {
  switch (reasonIdx) {
    case 1: return 'AI方向';
    case 2: return '信号K线';
    case 3: return '量仓';
    case 4: return '趋势健康';
    case 5: return 'R:R';
    default: return '';
  }
}

// ===== 2. Gate4 v3 (≥3/5理由) =====
export function evaluateGate4(
  bars: BarData[],
  aiDirection: string,
  trendStrength: number,
  adx: number,
  lastBar: BarData,
  oiChangePct: number,
  gate4Config?: Gate4Config,
): Gate4Result {
  const reasons: string[] = [];
  const len = bars.length;
  if (len < 20) return { passed: false, reasonCount: 0, reasons, verdict: '数据不足' };

  const minReasons = gate4Config?.minReasons ?? G4_MIN_REASONS;
  const disabled = gate4Config?.disabledReasons ?? [];

  // 理由1: AI方向一致性 (EMA20 vs EMA50 + 近期价格方向)
  if (!disabled.includes(1)) {
    const closes = bars.map((b) => b.c);
    const ema20 = calcEMA(closes, 20);
    const ema50 = calcEMA(closes, 50);
    const ema20Last = ema20[len - 1];
    const ema50Last = ema50[len - 1];
    const recentDir = closes[len - 1] > closes[len - 6] ? '多' : '空';
    if ((ema20Last > ema50Last && aiDirection === '多') ||
      (ema20Last < ema50Last && aiDirection === '空')) {
      reasons.push('AI方向一致(EMA排列)');
    } else if (aiDirection === recentDir) {
      reasons.push('AI方向一致(短期动量)');
    }
  }

  // 理由2: 信号K线质量 (II/IOI + 趋势K线)
  if (!disabled.includes(2)) {
    const lastIdx = len - 1;
    const isII = detectII(bars, lastIdx);
    const isIOI = detectIOI(bars, lastIdx);
    const signalBar = evaluateSignalBar(bars[lastIdx], bars[lastIdx - 1], aiDirection as 'bull' | 'bear');
    if (isII || isIOI) reasons.push('信号K线(II/IOI)');
    else if (signalBar.score >= 3) reasons.push('信号K线(趋势K线)');
  }

  // 理由3: 量仓确认 (成交量和持仓量都配合)
  if (!disabled.includes(3)) {
    const avgVol = bars.slice(-20).reduce((s, b) => s + b.vol, 0) / 20;
    const lastVol = bars[len - 1].vol;
    const volRatio = lastVol / (avgVol || 1);
    if (volRatio > 1.2 && oiChangePct > 0) reasons.push('量仓确认(放量增仓)');
    else if (volRatio > 1.0 && oiChangePct !== undefined) reasons.push('量仓确认(放量)');
  }

  // 理由4: 趋势健康度 (ADX + 突破分数)
  if (!disabled.includes(4)) {
    if (adx > 30 && trendStrength > 60) reasons.push('趋势健康(ADX>30+强趋势)');
    else if (trendStrength > 50) reasons.push('趋势健康(中等趋势)');
  }

  // 理由5: R:R比（基于真实波段结构）
  if (!disabled.includes(5)) {
    const atr = calcATR(bars, 14);
    const atrLast = atr[len - 1];
    const lastClose = bars[len - 1].c;
    const stopBars = bars.slice(-15);
    const swingLow = Math.min(...stopBars.map((b) => b.l));
    const swingHigh = Math.max(...stopBars.map((b) => b.h));
    const targetBars = bars.slice(-20);
    const targetHigh = Math.max(...targetBars.map((b) => b.h));
    const targetLow = Math.min(...targetBars.map((b) => b.l));
    const bandWidth = swingHigh - swingLow;
    const narrowBand = bandWidth < atrLast * 1.5;
    const longRisk = narrowBand ? atrLast : (lastClose - swingLow);
    const longReward = narrowBand ? atrLast * 2 : Math.max(targetHigh - lastClose, atrLast * 2);
    const longRR = longRisk > 0 ? longReward / longRisk : 0;
    const shortRisk = narrowBand ? atrLast : (swingHigh - lastClose);
    const shortReward = narrowBand ? atrLast * 2 : Math.max(lastClose - targetLow, atrLast * 2);
    const shortRR = shortRisk > 0 ? shortReward / shortRisk : 0;
    const rr = Math.max(longRR, shortRR);
    if (rr >= 2.0) reasons.push(`R:R优(1:${rr.toFixed(1)})`);
    else if (rr >= 1.5) reasons.push(`R:R可(1:${rr.toFixed(1)})`);
  }

  const maxReasons = 5 - disabled.length;

  // 处理 mergeReasons: 合并的理由对（OR 逻辑）
  const merged = gate4Config?.mergeReasons;
  let effectiveReasonCount = reasons.length;
  if (merged && merged.length === 2) {
    // 如果两个理由都通过了，只算1个（合并）
    const [a, b] = merged;
    const aPassed = reasons.some(r => r.startsWith(getReasonPrefix(a)));
    const bPassed = reasons.some(r => r.startsWith(getReasonPrefix(b)));
    if (aPassed && bPassed) effectiveReasonCount = reasons.length - 1;
  }

  // 处理 requiredReasons: 必须通过的理由
  const required = gate4Config?.requiredReasons ?? [];
  let requiredPassed = true;
  if (required.length > 0) {
    for (const reqIdx of required) {
      const prefix = getReasonPrefix(reqIdx);
      if (!reasons.some(r => r.startsWith(prefix))) {
        requiredPassed = false;
        break;
      }
    }
  }

  const passed = requiredPassed && effectiveReasonCount >= minReasons;
  const verdict = passed
    ? `通过(${reasons.length}/${maxReasons})`
    : `不通过(${reasons.length}/${maxReasons}，需≥${minReasons}${required.length > 0 ? '+必选' + required.join(',') : ''})`;

  return { passed, reasonCount: reasons.length, reasons, verdict };
}

// ===== 3. 楔形Reversal过滤 =====
export function evaluateWedgeFilter(
  bars: BarData[],
  aiDirection: string,
): WedgeFilterResult {
  const len = bars.length;
  if (len < 20) return { found: false, isReversal: false, direction: '无', filteredDir: '无' };

  // 检测楔形形态（最后20根K线）
  const wedgeBars = bars.slice(-20);
  const closes = wedgeBars.map((b) => b.c);
  const highs = wedgeBars.map((b) => b.h);
  const lows = wedgeBars.map((b) => b.l);

  // 计算高点和低点的趋势线
  const mid = wedgeBars.length;
  const firstHalf = wedgeBars.slice(0, 10);
  const secondHalf = wedgeBars.slice(-10);

  const hh1 = Math.max(...firstHalf.map((b) => b.h));
  const hh2 = Math.max(...secondHalf.map((b) => b.h));
  const ll1 = Math.min(...firstHalf.map((b) => b.l));
  const ll2 = Math.min(...secondHalf.map((b) => b.l));

  // 收敛检测: 高点下降+低点上升 = 楔形
  const highsConverging = hh2 < hh1;
  const lowsRising = ll2 > ll1;
  const found = highsConverging && lowsRising;

  if (!found) return { found: false, isReversal: false, direction: '无', filteredDir: '无' };

  // 楔形方向判定
  const wedgeDirection = hh2 < hh1 && ll2 > ll1
    ? (hh2 - hh1 > ll2 - ll1 ? '上楔形' : '下楔形')
    : '不确定';

  // reversal过滤: 如果是上楔形(看跌)但AI方向是空，过滤空信号
  // 下楔形(看涨)但AI方向是多，过滤多信号
  const isReversal =
    (wedgeDirection === '上楔形' && aiDirection === '多') ||
    (wedgeDirection === '下楔形' && aiDirection === '空');

  return {
    found: true,
    isReversal,
    direction: wedgeDirection,
    filteredDir: isReversal ? aiDirection : '无',
  };
}

// ===== 4. CH通道边界信号检测 =====
export function detectCHSignal(bars: BarData[]): CHSignal {
  const len = bars.length;
  if (len < 30) return { hasSignal: false, direction: '无', entry: null, stop: null, target: null, strength: '弱' };

  // 20周期Donchian通道
  const lookback = 20;
  const recent = bars.slice(-lookback);
  const hh20 = Math.max(...recent.map((b) => b.h));
  const ll20 = Math.min(...recent.map((b) => b.l));
  const lastBar = bars[len - 1];
  const channelWidth = hh20 - ll20;
  if (channelWidth === 0 || (lastBar.c - ll20) / channelWidth < -1 || (lastBar.c - ll20) / channelWidth > 2) {
    return { hasSignal: false, direction: '无', entry: null, stop: null, target: null, strength: '弱' };
  }

  // 50周期扩展通道(用于止损)
  const wide = bars.slice(-Math.min(50, len));
  const hh50 = Math.max(...wide.map((b) => b.h));
  const ll50 = Math.min(...wide.map((b) => b.l));

  // 近5日振幅收缩检测(通道特征：波动收敛)
  const recent5 = bars.slice(-5);
  const recent20 = bars.slice(-20);
  const avgRange5 = recent5.reduce((s, b) => s + (b.h - b.l), 0) / 5;
  const avgRange20 = recent20.reduce((s, b) => s + (b.h - b.l), 0) / 20;
  const rangeContracting = avgRange20 > 0 && avgRange5 < avgRange20 * 0.85;

  // 通道内价格位置 (0=下边界, 1=上边界)
  const pricePosition = (lastBar.c - ll20) / channelWidth;

  let hasSignal = false, direction = '无', entry: number | null = null;
  let stop: number | null = null, target: number | null = null, strength = '弱';

  // === 上边界做空信号 ===
  // 条件：价格接近上边界(>0.75) + (振幅收缩 或 K线收阴)
  const nearUpper = pricePosition > 0.72 && pricePosition <= 1.05;
  const upperBearish = lastBar.c < lastBar.o || lastBar.c < recent[recent.length - 2].c;
  if (nearUpper && (rangeContracting || upperBearish)) {
    hasSignal = true; direction = '空';
    entry = lastBar.c;
    stop = Math.max(hh50, hh20 * 1.005);
    target = ll20;
    // 强度判定
    if (rangeContracting && upperBearish && pricePosition > 0.9) strength = '强';
    else if (rangeContracting || (upperBearish && pricePosition > 0.85)) strength = '中';
    else strength = '弱';
  }

  // === 下边界做多信号 ===
  // 条件：价格接近下边界(<0.28) + (振幅收缩 或 K线收阳)
  const nearLower = pricePosition >= -0.03 && pricePosition < 0.28;
  const lowerBullish = lastBar.c > lastBar.o || lastBar.c > recent[recent.length - 2].c;
  if (!hasSignal && nearLower && (rangeContracting || lowerBullish)) {
    hasSignal = true; direction = '多';
    entry = lastBar.c;
    stop = Math.min(ll50, ll20 * 0.995);
    target = hh20;
    if (rangeContracting && lowerBullish && pricePosition < 0.1) strength = '强';
    else if (rangeContracting || (lowerBullish && pricePosition < 0.15)) strength = '中';
    else strength = '弱';
  }

  return { hasSignal, direction, entry, stop, target, strength };
}

// ===== 5. MM测量运动 (5变体3层目标位) =====
export function calcMMMeasurement(bars: BarData[]): MMMeasurement {
  const len = bars.length;
  if (len < 20) return { found: false, direction: '无', tier1: null, tier2: null, tier3: null, variantCount: 0 };

  const recent = bars.slice(-20);
  const hh = Math.max(...recent.map((b) => b.h));
  const ll = Math.min(...recent.map((b) => b.l));
  const range = hh - ll;
  const lastBar = bars[len - 1];

  // 简单MM计算：基于近期波动范围
  if (range <= 0) return { found: false, direction: '无', tier1: null, tier2: null, tier3: null, variantCount: 0 };

  const direction = lastBar.c > (hh + ll) / 2 ? '多' : '空';

  // 3层目标位 (基于Fibonacci扩展)
  const tier1Mult = 1.0;
  const tier2Mult = 1.618;
  const tier3Mult = 2.618;

  let tier1: number;
  let tier2: number;
  let tier3: number;

  if (direction === '多') {
    tier1 = lastBar.c + range * tier1Mult;
    tier2 = lastBar.c + range * tier2Mult;
    tier3 = lastBar.c + range * tier3Mult;
  } else {
    tier1 = lastBar.c - range * tier1Mult;
    tier2 = lastBar.c - range * tier2Mult;
    tier3 = lastBar.c - range * tier3Mult;
  }

  // 5变体计数 (简化: 根据EMA排列/ADX/趋势强度)
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const emaAligned = (ema20[len - 1] > ema50[len - 1] && direction === '多') ||
    (ema20[len - 1] < ema50[len - 1] && direction === '空');

  let variantCount = 1;
  if (emaAligned) variantCount++;
  const trendBars = countTrendBars(bars, 10);
  if (trendBars.bullBars >= 6 || trendBars.bearBars >= 6) variantCount++;
  const tightTR = detectTightTR(bars);
  if (tightTR) variantCount++;
  if (len > 40 && bars[len - 21].c < lastBar.c) variantCount++;
  variantCount = Math.min(variantCount, 5);

  return { found: true, direction, tier1, tier2, tier3, variantCount };
}

// ===== 6. 方向阵营过滤 =====
export function calcDirectionCamp(results: V16Row[], window: number = DIRECTION_CAMP_WINDOW): DirectionCampResult {
  let longCount = 0, shortCount = 0, neutralCount = 0;

  for (const r of results) {
    if (r.ai_direction === '多') longCount++;
    else if (r.ai_direction === '空') shortCount++;
    else neutralCount++;
  }

  let camp: DirectionCamp;
  if (longCount >= window) camp = 'LONG21';
  else if (shortCount >= window) camp = 'SHORT21';
  else camp = 'NEUTRAL10';

  const isGreen = camp === 'LONG21' || camp === 'SHORT21';

  return { camp, longCount, shortCount, neutralCount, isGreen };
}

// ===== 7. Edge统计验证 (Simons检验简化版) =====
/**
 * 历史信号棒表现回测（Edge统计的数据来源）
 * 扫描近70根K线中的多/空信号棒，模拟"下一根开盘入场、信号棒极值止损、2R波段目标"，
 * 统计近20次信号的胜率与平均R倍数期望（Brooks: Edge必须经统计验证，否则形态只是噪声）
 */
export function backtestSignalPerformance(bars: BarData[], lookback = 70): {
  winRate20: number | null;
  avgRR: number | null;
  sampleCount: number;
} {
  const results: number[] = []; // 每次信号的R倍数结果
  const maxForward = 10; // 入场后最多持有10根验证
  const start = Math.max(2, bars.length - lookback); // 需要至少2根前序K线检测II/IOI
  const end = bars.length - 2; // 最后一根无"下一根"可入场

  for (let i = start; i < end; i++) {
    const bar = bars[i];

    // P2: 使用 II/IOI 替代 evaluateSignalBar，与 Gate4 信号定义对齐
    const isII = detectII(bars, i);
    const isIOI = detectIOI(bars, i);

    let dir = 0; // 1=多, -1=空

    // II 信号K线：根据收盘方向判断
    if (isII) {
      if (bar.c > bar.o) dir = 1;        // II看涨→做多
      else if (bar.c < bar.o) dir = -1;  // II看跌→做空
    }
    // IOI 信号K线：根据收盘方向判断
    else if (isIOI) {
      if (bar.c > bar.o) dir = 1;        // IOI看涨→做多
      else if (bar.c < bar.o) dir = -1;  // IOI看跌→做空
    }

    if (dir === 0) continue;

    const entry = bars[i + 1].o;
    const stop = dir === 1 ? bar.l : bar.h;
    const risk = dir === 1 ? entry - stop : stop - entry;
    if (risk <= 0) continue;

    const target = dir === 1 ? entry + risk * 2 : entry - risk * 2; // 2R波段目标
    let rMultiple: number | null = null;
    const lastCheck = Math.min(i + 1 + maxForward, bars.length);

    for (let j = i + 1; j < lastCheck; j++) {
      const b = bars[j];
      if (dir === 1) {
        if (b.l <= stop) { rMultiple = -1; break; } // 保守：同根双触算亏
        if (b.h >= target) { rMultiple = 2; break; }
      } else {
        if (b.h >= stop) { rMultiple = -1; break; }
        if (b.l <= target) { rMultiple = 2; break; }
      }
    }

    if (rMultiple === null) {
      // 超时未达目标/止损，按收盘平仓折算R倍数
      const exitPrice = bars[lastCheck - 1].c;
      rMultiple = dir === 1 ? (exitPrice - entry) / risk : (entry - exitPrice) / risk;
    }

    results.push(rMultiple);
  }

  const recent = results.slice(-20);
  const sampleCount = recent.length;
  if (sampleCount === 0) return { winRate20: null, avgRR: null, sampleCount: 0 };
  const winRate20 = recent.filter((r) => r > 0).length / sampleCount;
  const avgRR = recent.reduce((a, b) => a + b, 0) / sampleCount;
  return { winRate20, avgRR, sampleCount };
}

/**
 * Edge评级：基于近20次信号回测的胜率与R倍数期望
 * status='active' 且 grade='D' 表示样本足够但统计期望为负（验证失败，应过滤）
 * status='inactive' 表示样本不足，无法验证（不硬过滤，但也不提供Edge背书）
 */
// ====== P1 Simons二项检验 ======
function binomialTestPValue(successes: number, trials: number, nullProb = 0.5): number {
  if (trials < 5 || successes > trials) return 1.0;
  const observed = successes / trials;
  const se = Math.sqrt(nullProb * (1 - nullProb) / trials);
  if (se === 0) return 1.0;
  const z = (observed - nullProb) / se;
  const p = 0.5 * (1 + erf(z / Math.sqrt(2)));
  return 1 - p;
}
function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1; x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return sign * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
}
function wilsonCI(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials === 0) return [0, 0];
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

export function calcEdgeGrade(
  winRate20: number | null,
  avgRR: number | null,
  sampleCount = 0,
  baselineWinRate?: number | null,
): { grade: string; status: string; decay: string; pValue: number | null; ci: [number, number] | null } {
  if (winRate20 === null || avgRR === null || sampleCount < 5) {
    return { grade: 'D', status: 'inactive', decay: 'NONE', pValue: null, ci: null };
  }
  // Simons二项检验: 计算p-value和Wilson置信区间
  const wins = Math.round(winRate20 * sampleCount);
  const pValue = binomialTestPValue(wins, sampleCount);
  const ci = wilsonCI(wins, sampleCount);
  // 基础评级 (若pValue > 0.1则降级——统计不显著)
  let grade: string;
  if (winRate20 >= 0.5 && avgRR >= 0.8) grade = pValue < 0.1 ? 'A' : 'B';
  else if (winRate20 >= 0.45 && avgRR >= 0.4) grade = pValue < 0.1 ? 'B' : 'C';
  else if (winRate20 >= 0.4 && avgRR > 0) grade = 'C';
  else grade = 'D';
  // 衰减四态
  let decay = 'HEALTHY';
  if (baselineWinRate != null && baselineWinRate > 0) {
    const drop = baselineWinRate - winRate20;
    if (drop > 0.2) decay = 'DEAD';
    else if (drop > 0.1) decay = 'DECAYING';
    else if (drop > 0.05) decay = 'WARNING';
    else decay = 'HEALTHY';
  } else {
    if (grade === 'D') decay = 'DEAD';
    else if (grade === 'C' && avgRR < 0.2) decay = 'WARNING';
  }
  const status = (grade === 'D' || decay === 'DEAD') ? 'inactive' : 'active';
  return { grade, status, decay, pValue, ci };
}

// ===== 8. Final Flag / LC阶段判定 =====
export function detectFinalFlag(bars: BarData[]): { found: boolean; label: string } {
  const len = bars.length;
  if (len < 20) return { found: false, label: '无' };

  const recent = bars.slice(-15);
  const closes = recent.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const atr = calcATR(bars, 14);
  const lastBar = bars[len - 1];

  // Final Flag特征: 小实体+窄幅整理+在高位/低位
  const bodyRatio = Math.abs(lastBar.c - lastBar.o) / ((lastBar.h - lastBar.l) || 0.001);
  const rangeRatio = (lastBar.h - lastBar.l) / (atr[len - 1] || 0.001);

  const isSmallBody = bodyRatio < 0.3;
  const isTightRange = rangeRatio < 0.5;

  if (isSmallBody && isTightRange) {
    const trendBars = countTrendBars(bars, 20);
    if (trendBars.bullBars >= 12 || trendBars.bearBars >= 12) return { found: true, label: 'Final Flag(强趋势后)' };
    return { found: true, label: '窄幅整理' };
  }

  return { found: false, label: '无' };
}

// ===== 8.5 一句话总结生成 =====
export function generateOneLiner(row: V16Row): string {
  const parts: string[] = [];

  // 光谱 + 方向
  const dirCn = row.ai_direction === '多' ? '做多' : row.ai_direction === '空' ? '做空' : '观望';
  parts.push(`${row.spectrum}${dirCn}`);

  // Gate4
  if (row.g4_pass) {
    parts.push(`Gate4通过${row.g4_reason_count}/5`);
  } else {
    parts.push(`Gate4未通过`);
  }

  // CH 通道信号
  if (row.ch_has_signal) {
    parts.push(`CH通道${row.ch_direction === '多' ? '做多' : '做空'}信号${row.ch_strength}`);
  }

  // MM 测距
  if (row.mm_found && row.mm_tier1) {
    parts.push(`MM目标${row.mm_tier1}`);
  }

  // 楔形过滤
  if (row.wedge_filter_on) {
    parts.push('楔形过滤');
  }

  // 生命周期
  if (row.lc_stage && row.lc_stage !== '未知') {
    parts.push(row.lc_stage);
  }

  // P(顺)
  if (row.p_follow >= 0.6) {
    parts.push(`P(顺)${(row.p_follow * 100).toFixed(0)}%`);
  }

  // Edge
  if (row.edge_grade === 'A') {
    parts.push('Edge A级');
  }

  return parts.join('，');
}

// 价格格式化工具（generateAdvice 使用）
export function fmtPrice(v?: number | null): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return String(Math.round(v * 100) / 100);
}
