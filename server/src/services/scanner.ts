import { calcEMA, calcATR, calcADX, calcSMA } from './indicators.js';
import type { BarData, ScanResult } from './varieties.js';
import { VARIETIES, OVERSOLD_VARIETIES, VARIETY_GROUPS, isEnabledVariety, type ScanResult as ScanResultType } from './varieties.js';
import { getVarietyData } from './dataFetcher.js';
import {
  saveSignalRecords,
  getActiveTrendTracking,
  startTrendTracking,
  updateTrendTracking,
  endTrendTracking,
  type SignalRecord,
} from './database.js';

/**
 * Brooks Price Action 72维度扫描引擎
 */

// ===== 维度1: 光谱定位 =====
// 使用多维度综合判断：重叠度 + ADX + 趋势强度 + EMA斜率
function spectrumPosition(bars: BarData[], lookback = 10): { label: string; overlaps: number; strategy: string } {
  if (bars.length < lookback) return { label: '数据不足', overlaps: 0, strategy: '观望' };
  
  const recent = bars.slice(-lookback);
  
  // 1. 计算K线重叠度（改进版）
  let overlapRatio = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const cur = recent[i];
    const next = recent[i + 1];
    const curRange = cur.h - cur.l;
    const nextRange = next.h - next.l;
    if (curRange === 0 || nextRange === 0) continue;
    
    // 计算两根K线的重叠区域
    const overlapHigh = Math.min(cur.h, next.h);
    const overlapLow = Math.max(cur.l, next.l);
    const overlap = Math.max(0, overlapHigh - overlapLow);
    const avgRange = (curRange + nextRange) / 2;
    
    // 重叠比例（重叠区域占平均K线范围的比例）
    overlapRatio += overlap / avgRange;
  }
  overlapRatio = overlapRatio / (recent.length - 1);
  
  // 2. 计算方向一致性（趋势强度）
  let higherHighs = 0, higherLows = 0, lowerHighs = 0, lowerLows = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].h > recent[i - 1].h) higherHighs++;
    else lowerHighs++;
    if (recent[i].l > recent[i - 1].l) higherLows++;
    else lowerLows++;
  }
  
  // 3. 计算EMA斜率
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const emaSlope = ema20[bars.length - 1] - ema20[bars.length - 3];
  const emaSlopePct = Math.abs(emaSlope / ema20[bars.length - 1]) * 100;
  
  // 4. 计算ADX
  const adxResult = calcADX(bars);
  const adx = adxResult.adx;
  
  // 5. 计算趋势K线占比
  let trendBars = 0;
  for (const b of recent) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range > 0 && body / range > 0.5) trendBars++;
  }
  const trendBarRatio = trendBars / recent.length;
  
  // 综合判断
  // 趋势：低重叠 + 较高ADX + 明显EMA斜率 + 较多趋势K线
  // 区间：高重叠 + 低ADX + 弱EMA斜率
  // 通道：介于两者之间
  
  // 调整阈值以适应当前市场条件
  const isTrending = 
    overlapRatio < 0.5 && 
    adx > 20 && 
    (emaSlopePct > 0.2 || Math.abs(emaSlopePct) > 0.15) && 
    trendBarRatio > 0.3;
  
  const isRanging = 
    overlapRatio > 0.65 && 
    adx < 18 && 
    emaSlopePct < 0.15 &&
    trendBarRatio < 0.35;
  
  if (isTrending) {
    return { label: '趋势', overlaps: Math.round(overlapRatio * 100), strategy: '顺势重仓' };
  }
  if (isRanging) {
    return { label: '区间', overlaps: Math.round(overlapRatio * 100), strategy: '高抛低吸' };
  }
  return { label: '通道', overlaps: Math.round(overlapRatio * 100), strategy: '顺势轻仓' };
}

// ===== 维度2: K线身份识别 =====
function barIdentity(bars: BarData[]): { identity: string; bodyRatio: number } {
  const last = bars[bars.length - 1];
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  if (range === 0) return { identity: '无波动', bodyRatio: 0 };
  const bodyRatio = body / range;

  // 计算中位数
  const bodies = bars.slice(-10).map((b) => Math.abs(b.c - b.o));
  const sorted = [...bodies].sort((a, b) => a - b);
  const medianBody = sorted[Math.floor(sorted.length / 2)];
  const ranges = bars.slice(-10).map((b) => b.h - b.l);
  const sortedRanges = [...ranges].sort((a, b) => a - b);
  const medianRange = sortedRanges[Math.floor(sortedRanges.length / 2)];

  if (bodyRatio < 0.2 && range > medianRange * 1.5) return { identity: '大十字星', bodyRatio };
  if (bodyRatio < 0.2) return { identity: '十字星', bodyRatio };
  if (bodyRatio > 0.6 && body > medianBody * 3) return { identity: '衰竭K线', bodyRatio };
  if (bodyRatio > 0.6 && body > medianBody * 2) return { identity: '高潮K线', bodyRatio };
  if (bodyRatio > 0.6) return { identity: '趋势K线', bodyRatio };
  return { identity: '普通K线', bodyRatio };
}

// ===== 维度3: Always In 方向 =====
function alwaysInDirection(bars: BarData[]): {
  direction: string; flip: boolean; ema20: number; emaDevPct: number; aiStreak: number;
} {
  if (bars.length < 25) return { direction: '数据不足', flip: false, ema20: 0, emaDevPct: 0, aiStreak: 0 };

  const closes = bars.map((b) => b.c);
  const ema20Arr = calcEMA(closes, 20);
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const ema20 = ema20Arr[bars.length - 1];
  const prevEma20 = ema20Arr[bars.length - 2];

  const aiNow = last.c > ema20 ? 'LONG' : 'SHORT';
  const aiPrev = prev.c > prevEma20 ? 'LONG' : 'SHORT';
  const flip = aiNow !== aiPrev;
  const emaDev = ((last.c / ema20) - 1) * 100;

  let aiCount = 1;
  for (let i = bars.length - 2; i >= Math.max(bars.length - 20, 0); i--) {
    const curAi = bars[i].c > ema20Arr[i] ? 'LONG' : 'SHORT';
    if (curAi === aiNow) aiCount++;
    else break;
  }

  return { direction: aiNow, flip, ema20: Math.round(ema20 * 100) / 100, emaDevPct: Math.round(emaDev * 100) / 100, aiStreak: aiCount };
}

// ===== 维度4: 买卖压力 =====
function buySellPressure(bars: BarData[], lookback = 10): { label: string; ratio: number } {
  const recent = bars.slice(-lookback);
  let bullBody = 0, bearBody = 0;
  for (const b of recent) {
    const body = b.c - b.o;
    if (body > 0) bullBody += body;
    else bearBody += Math.abs(body);
  }
  const ratio = bearBody === 0 ? (bullBody > 0 ? 99 : 1) : bullBody / bearBody;
  if (ratio > 2.0) return { label: '买方主导', ratio: Math.round(ratio * 100) / 100 };
  if (ratio < 0.5) return { label: '卖方主导', ratio: Math.round(ratio * 100) / 100 };
  return { label: '均衡', ratio: Math.round(ratio * 100) / 100 };
}

// ===== 维度5: 突破有效性评分 =====
function breakoutScore(bars: BarData[], lookback = 20): { score: number; label: string } {
  if (bars.length < lookback + 1) return { score: 0, label: '数据不足' };
  const last = bars[bars.length - 1];
  const prev = bars.slice(-(lookback + 1), -1);
  const prevHigh = Math.max(...prev.map((b) => b.h));
  const prevLow = Math.min(...prev.map((b) => b.l));

  const isBullBO = last.c > prevHigh;
  const isBearBO = last.c < prevLow;
  if (!isBullBO && !isBearBO) return { score: 0, label: '区间内' };

  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  const bodyRatio = range > 0 ? body / range : 0;
  const vols = bars.slice(-20).map((b) => b.vol);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const emaSlope = bars.length >= 2 ? ema20[bars.length - 1] - ema20[bars.length - 3] : 0;

  let score = 0;
  if (bodyRatio > 0.7) score++;
  if (isBullBO ? last.c > (last.h + last.l) / 2 : last.c < (last.h + last.l) / 2) score++;
  if (last.vol > avgVol * 1.5) score++;
  const extent = isBullBO ? (last.c - prevHigh) / prevHigh : (prevLow - last.c) / prevLow;
  if (extent > 0.001) score++;
  if (isBullBO ? emaSlope > 0 : emaSlope < 0) score++;

  if (score >= 3) return { score, label: '有效突破' };
  return { score, label: '假突破' };
}

// ===== 维度6: 反转K线质量 =====
function reversalQuality(bars: BarData[]): { score: number; direction: string } {
  if (bars.length < 5) return { score: 0, direction: '无' };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  if (range === 0) return { score: 0, direction: '无' };
  const bodyRatio = body / range;
  if (bodyRatio < 0.3) return { score: 0, direction: '无' };

  const isBull = last.c > last.o;
  let score = 0;

  // 收盘反转前K线
  if (isBull && last.c > prev.c) score++;
  if (!isBull && last.c < prev.c) score++;

  // 影线比例
  const upperShadow = last.h - Math.max(last.o, last.c);
  const lowerShadow = Math.min(last.o, last.c) - last.l;
  if (isBull) {
    if (lowerShadow / range >= 0.2 && lowerShadow / range <= 0.55 && upperShadow / range < 0.2) score++;
  } else {
    if (upperShadow / range >= 0.2 && upperShadow / range <= 0.55 && lowerShadow / range < 0.2) score++;
  }

  // 反转覆盖面
  let coverCount = 0;
  for (let i = bars.length - 2; i >= Math.max(0, bars.length - 6); i--) {
    if (isBull && last.c > bars[i].c) coverCount++;
    if (!isBull && last.c < bars[i].c) coverCount++;
  }
  if (coverCount >= 3) score += 2;
  else if (coverCount >= 1) score += 1;

  return { score, direction: isBull ? '看涨反转' : '看跌反转' };
}

// ===== 维度7: 重叠度检测 =====
function overlapDetection(bars: BarData[]): { overlapPct: number; verdict: string } {
  if (bars.length < 2) return { overlapPct: 0, verdict: '数据不足' };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const range = last.h - last.l;
  if (range === 0) return { overlapPct: 0, verdict: '无波动' };

  const intersectionHigh = Math.min(last.h, prev.h);
  const intersectionLow = Math.max(last.l, prev.l);
  const intersection = Math.max(0, intersectionHigh - intersectionLow);
  const overlapPct = intersection / range;

  if (overlapPct > 0.75) return { overlapPct, verdict: '双K线区间，突破不可信' };
  if (overlapPct > 0.5) return { overlapPct, verdict: '中度重叠，信号减弱' };
  return { overlapPct, verdict: '重叠合理' };
}

// ===== 维度13: Follow-through =====
function followThrough(bars: BarData[]): number {
  if (bars.length < 3) return 0;
  const signal = bars[bars.length - 2];
  const current = bars[bars.length - 1];
  const signalBody = Math.abs(signal.c - signal.o);
  const signalRange = signal.h - signal.l;
  if (signalRange === 0) return 0;
  const signalRatio = signalBody / signalRange;
  const isBullSignal = signal.c > signal.o;
  const isBullCurrent = current.c > current.o;

  if (isBullSignal && isBullCurrent && signalRatio > 0.5) return 2;
  if (!isBullSignal && !isBullCurrent && signalRatio > 0.5) return -2;
  if (isBullSignal && isBullCurrent) return 1;
  if (!isBullSignal && !isBullCurrent) return -1;
  return 0;
}

// ===== 维度15: 外包线检测 =====
function outsideBarDetection(bars: BarData[]): { isOutside: boolean; direction: string } {
  if (bars.length < 2) return { isOutside: false, direction: '无' };
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const isOutside = last.h > prev.h && last.l < prev.l;
  if (!isOutside) return { isOutside: false, direction: '无' };
  return { isOutside: true, direction: last.c > last.o ? '多头外包' : '空头外包' };
}

// ===== 维度16: 陷阱检测 =====
function trapDetection(bars: BarData[]): string {
  if (bars.length < 5) return '无';
  const last = bars[bars.length - 1];
  const range = last.h - last.l;
  if (range === 0) return '无';
  const closePosition = (last.c - last.l) / range;

  // 检查前期趋势
  const recent = bars.slice(-5, -1);
  const bullBars = recent.filter((b) => b.c > b.o).length;
  const bearBars = recent.filter((b) => b.c < b.o).length;

  if (bullBars >= 3 && closePosition < 0.3) return '牛市陷阱';
  if (bearBars >= 3 && closePosition > 0.7) return '熊市陷阱';
  return '无';
}

// ===== 维度17: 趋势强度评分 =====
function trendStrengthScore(bars: BarData[], adx: number, plusDI: number, minusDI: number): number {
  if (bars.length < 20) return 0;
  const lookback = 20;
  const recent = bars.slice(-lookback);
  let score = 0;

  // Trending highs/lows
  let higherHighs = 0, higherLows = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i].h > recent[i - 1].h) higherHighs++;
    if (recent[i].l > recent[i - 1].l) higherLows++;
  }
  if (higherHighs / (lookback - 1) >= 0.7) score += 8;
  else if (higherHighs / (lookback - 1) >= 0.5) score += 4;
  if (higherLows / (lookback - 1) >= 0.7) score += 8;
  else if (higherLows / (lookback - 1) >= 0.5) score += 4;

  // 趋势K线占比
  let trendBars = 0;
  for (const b of recent) {
    const range = b.h - b.l;
    const body = Math.abs(b.c - b.o);
    if (range > 0 && body / range > 0.5) trendBars++;
  }
  if (trendBars / lookback >= 0.7) score += 8;
  else if (trendBars / lookback >= 0.5) score += 4;

  // EMA20斜率
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const slope = ema20[bars.length - 1] - ema20[bars.length - 3];
  if (Math.abs(slope) > 0) score += 8;

  // ADX强度
  if (adx > 30) score += 8;
  else if (adx > 25) score += 4;

  // 价格远离EMA20
  const dev = Math.abs((bars[bars.length - 1].c / ema20[bars.length - 1]) - 1) * 100;
  if (dev > 2) score += 8;
  else if (dev > 1) score += 4;

  return Math.min(100, Math.round((score / 64) * 100));
}

// ===== 维度20: Spike/Channel =====
function spikeChannelPhase(bars: BarData[]): string {
  if (bars.length < 15) return '数据不足';
  const recent = bars.slice(-15);
  let consecutiveTrend = 0;
  let maxConsecutive = 0;
  for (let i = 1; i < recent.length; i++) {
    const body = Math.abs(recent[i].c - recent[i].o);
    const range = recent[i].h - recent[i].l;
    if (range > 0 && body / range > 0.5) {
      consecutiveTrend++;
      maxConsecutive = Math.max(maxConsecutive, consecutiveTrend);
    } else {
      consecutiveTrend = 0;
    }
  }
  if (maxConsecutive >= 3) return 'Spike阶段';
  if (maxConsecutive >= 1) return 'Channel运行';
  return '区间';
}

// ===== 维度23: Barbwire检测 =====
function barbwireDetection(bars: BarData[]): boolean {
  if (bars.length < 10) return false;
  const recent = bars.slice(-10);
  let highOverlap = 0;
  for (let i = 0; i < recent.length - 1; i++) {
    const range = recent[i].h - recent[i].l;
    if (range === 0) continue;
    const intersectionHigh = Math.min(recent[i].h, recent[i + 1].h);
    const intersectionLow = Math.max(recent[i].l, recent[i + 1].l);
    const intersection = Math.max(0, intersectionHigh - intersectionLow);
    if (intersection / range > 0.5) highOverlap++;
  }
  return highOverlap >= 5;
}

// ===== 维度26: 楔形三推检测 + 测量运动 =====
function wedgeThreePush(bars: BarData[]): { detected: boolean; type: string; measurementTarget: number } {
  if (bars.length < 30) return { detected: false, type: '无', measurementTarget: 0 };
  const recent = bars.slice(-30);

  // 找 swing highs
  const swingHighs: { price: number; index: number }[] = [];
  const swingLows: { price: number; index: number }[] = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].h > recent[i - 1].h && recent[i].h > recent[i - 2].h &&
      recent[i].h > recent[i + 1].h && recent[i].h > recent[i + 2].h) {
      swingHighs.push({ price: recent[i].h, index: i });
    }
    if (recent[i].l < recent[i - 1].l && recent[i].l < recent[i - 2].l &&
      recent[i].l < recent[i + 1].l && recent[i].l < recent[i + 2].l) {
      swingLows.push({ price: recent[i].l, index: i });
    }
  }

  // 检测三推（递减）+ 测量运动
  if (swingHighs.length >= 3) {
    const last3 = swingHighs.slice(-3);
    if (last3[1].price > last3[0].price && last3[2].price > last3[0].price && last3[2].price <= last3[1].price) {
      // 牛市楔形：测量目标 = 楔形起点到第三推的距离，从突破点反向投射
      const wedgeStart = recent[last3[0].index].l; // 楔形起点（第一推前的低点）
      const wedgeEnd = last3[2].price; // 第三推高点
      const distance = wedgeEnd - wedgeStart;
      const lastPrice = bars[bars.length - 1].c;
      const measurementTarget = lastPrice - distance; // 向下投射
      return { detected: true, type: '牛市楔形', measurementTarget };
    }
  }
  if (swingLows.length >= 3) {
    const last3 = swingLows.slice(-3);
    if (last3[1].price < last3[0].price && last3[2].price < last3[0].price && last3[2].price >= last3[1].price) {
      // 熊市楔形：测量目标 = 楔形起点到第三推的距离，从突破点反向投射
      const wedgeStart = recent[last3[0].index].h; // 楔形起点（第一推前的高点）
      const wedgeEnd = last3[2].price; // 第三推低点
      const distance = wedgeStart - wedgeEnd;
      const lastPrice = bars[bars.length - 1].c;
      const measurementTarget = lastPrice + distance; // 向上投射
      return { detected: true, type: '熊市楔形', measurementTarget };
    }
  }
  return { detected: false, type: '无', measurementTarget: 0 };
}

// ===== 维度30: 高潮检测 =====
function climaxDetection(bars: BarData[], emaDevPct: number): boolean {
  if (bars.length < 10) return false;
  const recent = bars.slice(-5);
  let consecutiveTrend = 0;
  for (const b of recent) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range > 0 && body / range > 0.6) consecutiveTrend++;
  }
  return consecutiveTrend >= 3 && Math.abs(emaDevPct) > 2;
}

// ===== 维度29: MTR检测（v12增强：60% minor法则）=====
function mtrDetection(bars: BarData[], adx: number): { detected: boolean; type: 'major' | 'minor' | 'none' } {
  if (bars.length < 40 || adx < 20) return { detected: false, type: 'none' };
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const recent20 = bars.slice(-20);

  // 检查EMA穿越
  let emaCrossed = false;
  for (let i = bars.length - 10; i < bars.length; i++) {
    if (i > 0 && ema20[i] && ema20[i - 1]) {
      const prevAbove = bars[i - 1].c > ema20[i - 1];
      const curAbove = bars[i].c > ema20[i];
      if (prevAbove !== curAbove) emaCrossed = true;
    }
  }

  // 检查前期趋势
  let oneSideCount = 0;
  for (let i = 0; i < recent20.length; i++) {
    const b = recent20[i];
    const emaIdx = bars.length - 20 + i;
    if (emaIdx >= 0 && emaIdx < ema20.length) {
      if (b.c > ema20[emaIdx] || b.c < ema20[emaIdx]) {
        oneSideCount++;
      }
    }
  }

  const basicDetected = emaCrossed && oneSideCount > 13;
  if (!basicDetected) return { detected: false, type: 'none' };

  // v12: 60% minor法则
  // 默认60%是minor
  let confidence = 0.6;
  
  // 检查DB确认（双底/双顶）
  const hasDB = checkDoubleBottomTop(bars);
  if (hasDB) confidence = 0.8; // 有DB→major
  
  // Tight Channel→80% minor
  const tightChannel = checkTightChannel(bars);
  if (tightChannel) confidence *= 0.8;
  
  // 反向腿>3bars需要DB确认
  const reverseLegBars = countReverseLegBars(bars);
  if (reverseLegBars > 3 && !hasDB) confidence *= 0.7;
  
  const type = confidence >= 0.7 ? 'major' : 'minor';
  
  return { detected: true, type };
}

// 检查双底/双顶
function checkDoubleBottomTop(bars: BarData[]): boolean {
  if (bars.length < 20) return false;
  
  const recent = bars.slice(-20);
  const lows = recent.map(b => b.l);
  const highs = recent.map(b => b.h);
  const minLow = Math.min(...lows);
  const maxHigh = Math.max(...highs);
  
  // 找两个接近最低点的位置（双底）
  let firstLow = -1, secondLow = -1;
  for (let i = 0; i < lows.length; i++) {
    if (lows[i] <= minLow * 1.01) {
      if (firstLow === -1) firstLow = i;
      else if (i - firstLow >= 5) secondLow = i;
    }
  }
  
  // 找两个接近最高点的位置（双顶）
  let firstHigh = -1, secondHigh = -1;
  for (let i = 0; i < highs.length; i++) {
    if (highs[i] >= maxHigh * 0.99) {
      if (firstHigh === -1) firstHigh = i;
      else if (i - firstHigh >= 5) secondHigh = i;
    }
  }
  
  return (firstLow !== -1 && secondLow !== -1) || (firstHigh !== -1 && secondHigh !== -1);
}

// 检查Tight Channel
function checkTightChannel(bars: BarData[]): boolean {
  if (bars.length < 10) return false;
  
  const recent = bars.slice(-10);
  let overlapCount = 0;
  
  for (let i = 0; i < recent.length - 1; i++) {
    const cur = recent[i];
    const next = recent[i + 1];
    const overlapHigh = Math.min(cur.h, next.h);
    const overlapLow = Math.max(cur.l, next.l);
    if (overlapHigh > overlapLow) overlapCount++;
  }
  
  return overlapCount >= 6; // 60%以上重叠
}

// 计算反向腿K线数
function countReverseLegBars(bars: BarData[]): number {
  if (bars.length < 10) return 0;
  
  const recent = bars.slice(-10);
  const last = recent[recent.length - 1];
  const isBullish = last.c > last.o;
  
  let count = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const b = recent[i];
    const barBullish = b.c > b.o;
    if (barBullish !== isBullish) {
      count++;
    } else {
      break;
    }
  }
  
  return count;
}

// ===== 维度31: Final Flag（v12增强：磁铁规则）=====
function finalFlagDetection(bars: BarData[]): { detected: boolean; magnetEffect: boolean; failureRate: number } {
  if (bars.length < 30) return { detected: false, magnetEffect: false, failureRate: 0.6 };
  
  // 精确Tight TR检测：连续≥20bars + 重叠度>60%
  const recent40 = bars.slice(-40);
  let tightTRBars = 0;
  let maxConsecutiveTight = 0;
  let currentConsecutive = 0;
  
  for (let i = 0; i < recent40.length; i++) {
    const b = recent40[i];
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    const isTight = range > 0 && body / range < 0.3;
    
    // 检查与前K线的重叠度
    let overlapHigh = false;
    if (i > 0) {
      const prev = recent40[i - 1];
      const overlap = Math.min(b.h, prev.h) - Math.max(b.l, prev.l);
      const overlapRatio = overlap / Math.max(b.h - b.l, prev.h - prev.l, 0.01);
      overlapHigh = overlapRatio > 0.6;
    }
    
    if (isTight && (i === 0 || overlapHigh)) {
      currentConsecutive++;
      maxConsecutiveTight = Math.max(maxConsecutiveTight, currentConsecutive);
    } else {
      currentConsecutive = 0;
    }
  }
  
  // 磁铁效应：连续Tight TR ≥ 20bars
  const magnetEffect = maxConsecutiveTight >= 20;
  
  // 失败率：磁铁80-90%，普通60%
  const failureRate = magnetEffect ? 0.85 : 0.6;
  
  // 检查是否有旗形整理（小K线连续）
  const recent = bars.slice(-15);
  let smallBars = 0;
  for (const b of recent) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range > 0 && body / range < 0.3) smallBars++;
  }
  
  // 前期需要有趋势
  const prevTrend = bars.slice(-30, -15);
  let trendBars = 0;
  for (const b of prevTrend) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range > 0 && body / range > 0.5) trendBars++;
  }
  
  // B Climax + Tight TR组合
  const hasBClimax = checkBClimax(bars);
  const detected = (smallBars >= 4 && trendBars >= 6) || (hasBClimax && magnetEffect);
  
  return { detected, magnetEffect, failureRate };
}

// 检查B Climax
function checkBClimax(bars: BarData[]): boolean {
  if (bars.length < 20) return false;
  
  const recent = bars.slice(-10);
  let strongTrendBars = 0;
  
  for (const b of recent) {
    const body = Math.abs(b.c - b.o);
    const range = b.h - b.l;
    if (range > 0 && body / range > 0.7) strongTrendBars++;
  }
  
  // 连续3根以上强趋势K线后出现小K线
  return strongTrendBars >= 3;
}

// ===== 维度19: Leg计数 =====
function legCounter(bars: BarData[]): number {
  if (bars.length < 20) return 0;
  const recent = bars.slice(-30);
  let swingCount = 0;
  for (let i = 2; i < recent.length - 2; i++) {
    if ((recent[i].h > recent[i - 1].h && recent[i].h > recent[i - 2].h &&
      recent[i].h > recent[i + 1].h && recent[i].h > recent[i + 2].h) ||
      (recent[i].l < recent[i - 1].l && recent[i].l < recent[i - 2].l &&
        recent[i].l < recent[i + 1].l && recent[i].l < recent[i + 2].l)) {
      swingCount++;
    }
  }
  return swingCount;
}

// ===== 维度25: 磁铁位 =====
function magnetLevels(bars: BarData[]): number[] {
  if (bars.length < 20) return [];
  const recent = bars.slice(-30);
  const levels: number[] = [];

  for (let i = 2; i < recent.length - 2; i++) {
    if (recent[i].h > recent[i - 1].h && recent[i].h > recent[i - 2].h &&
      recent[i].h > recent[i + 1].h && recent[i].h > recent[i + 2].h) {
      levels.push(recent[i].h);
    }
    if (recent[i].l < recent[i - 1].l && recent[i].l < recent[i - 2].l &&
      recent[i].l < recent[i + 1].l && recent[i].l < recent[i + 2].l) {
      levels.push(recent[i].l);
    }
  }
  return levels.slice(-5);
}

// ===== 超跌反弹评分 =====
function calcOversoldScore(bars: BarData[]): {
  score: number; signal: string; consecDown: number; volRatio: number; devMa20: number;
} {
  if (bars.length < 25) return { score: 0, signal: '无', consecDown: 0, volRatio: 1, devMa20: 0 };

  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const retPct = ((last.c - prev.c) / prev.c) * 100;

  // 连跌天数
  let consecDown = 0;
  for (let i = bars.length - 1; i >= 1; i--) {
    if (bars[i].c < bars[i - 1].c) consecDown++;
    else break;
  }

  // 量比
  const vols = bars.slice(-20).map((b) => b.vol);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const volRatio = avgVol > 0 ? last.vol / avgVol : 1;

  // 偏离MA20
  const closes = bars.map((b) => b.c);
  const ma20 = calcSMA(closes, 20);
  const ma20Val = ma20[bars.length - 1];
  const devMa20 = ma20Val > 0 ? ((last.c / ma20Val) - 1) * 100 : 0;

  // 偏离EMA20
  const ema20 = calcEMA(closes, 20);
  const ema20Val = ema20[bars.length - 1];
  const devEma20 = ema20Val > 0 ? ((last.c / ema20Val) - 1) * 100 : 0;

  let score = 0;
  if (retPct < -3) score -= 2;
  else if (retPct < -2) score -= 1;
  if (consecDown >= 5) score -= 2;
  else if (consecDown >= 3) score -= 1;
  if (volRatio > 2.0) score -= 1;
  if (devMa20 < -5) score -= 2;
  else if (devMa20 < -3) score -= 1;
  if (devEma20 < -3) score -= 1;

  const signal = score <= -3 ? '强烈超卖' : score <= -1 ? '观察超卖' : '无';
  return { score, signal, consecDown, volRatio: Math.round(volRatio * 100) / 100, devMa20: Math.round(devMa20 * 100) / 100 };
}

// ===== v12新增维度: Gap跳空分类 =====
function classifyGap(bars: BarData[]): 'none' | 'breakaway' | 'measuring' | 'exhaustion' {
  if (bars.length < 2) return 'none';
  
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  
  // 检测跳空
  const gapUp = last.l > prev.h;
  const gapDown = last.h < prev.l;
  
  if (!gapUp && !gapDown) return 'none';
  
  // 根据位置判断类型
  const trendStrength = bars.slice(-10).reduce((acc, b) => {
    return acc + (b.c > b.o ? 1 : -1);
  }, 0);
  
  // 突破跳空：趋势开始时
  if (Math.abs(trendStrength) <= 3) return 'breakaway';
  
  // 测量跳空：趋势中间
  if (Math.abs(trendStrength) >= 4 && Math.abs(trendStrength) <= 7) return 'measuring';
  
  // 耗竭跳空：趋势末端
  if (Math.abs(trendStrength) > 7) return 'exhaustion';
  
  return 'breakaway';
}

// ===== v12新增维度: Major Surprise检测 =====
function detectMajorSurprise(bars: BarData[]): boolean {
  if (bars.length < 20) return false;
  
  const last = bars[bars.length - 1];
  const lastRange = last.h - last.l;
  
  // 计算平均K线范围
  const avgRange = bars.slice(-20, -1).reduce((acc, b) => acc + (b.h - b.l), 0) / 19;
  
  // 幅度>2.5倍平均=Major Surprise
  // Brooks: 80-90%当天不反向
  return lastRange > avgRange * 2.5;
}

// ===== v12新增维度: Bar 40-41时间窗口（精确实现）=====
function checkBar40_41Window(bars: BarData[]): boolean {
  // Bar 40-41是高概率反转窗口
  // Brooks: 日线级别，从趋势开始的第40-41天
  
  if (bars.length < 45) return false;
  
  // 追踪趋势起点
  let trendStart = -1;
  let trendDirection = 0; // 1=上涨, -1=下跌
  let consecutiveBars = 0;
  
  // 从最近往前找趋势起点
  for (let i = bars.length - 1; i >= Math.max(0, bars.length - 60); i--) {
    const b = bars[i];
    const isBull = b.c > b.o;
    
    // 检查EMA斜率确定趋势方向
    const closes = bars.slice(0, i + 1).map(bar => bar.c);
    const prevCloses = i > 20 ? bars.slice(0, i).map(bar => bar.c) : closes;
    const ema20 = calcEMA(closes, 20)[closes.length - 1] || 0;
    const prevEma20 = i > 20 ? calcEMA(prevCloses, 20)[prevCloses.length - 1] || 0 : ema20;
    const emaSlope = ema20 - prevEma20;
    
    if (emaSlope > 0 && isBull) {
      if (trendDirection !== 1) {
        trendDirection = 1;
        trendStart = i;
        consecutiveBars = 1;
      } else {
        consecutiveBars++;
      }
    } else if (emaSlope < 0 && !isBull) {
      if (trendDirection !== -1) {
        trendDirection = -1;
        trendStart = i;
        consecutiveBars = 1;
      } else {
        consecutiveBars++;
      }
    } else {
      // 趋势中断
      if (consecutiveBars >= 10) break; // 找到足够长的趋势
      trendDirection = 0;
      consecutiveBars = 0;
    }
  }
  
  // 检查是否在Bar 40-41窗口
  const barsSinceTrendStart = bars.length - trendStart;
  const inWindow = barsSinceTrendStart >= 38 && barsSinceTrendStart <= 43;
  
  // 检查是否有反转信号
  const recent = bars.slice(-5);
  let reversalSignals = 0;
  
  for (let i = 1; i < recent.length; i++) {
    const prev = recent[i - 1];
    const curr = recent[i];
    
    // 看涨吞没
    if (trendDirection === -1 && prev.c < prev.o && curr.c > curr.o && 
        curr.c > prev.o && curr.o < prev.c) {
      reversalSignals++;
    }
    
    // 看跌吞没
    if (trendDirection === 1 && prev.c > prev.o && curr.c < curr.o && 
        curr.c < prev.o && curr.o > prev.c) {
      reversalSignals++;
    }
  }
  
  // Bar 40-41窗口 + 反转信号 = 高概率反转
  return inWindow && reversalSignals >= 1;
}

// ===== 主扫描函数 =====
/** @deprecated 使用 runV16FullScan() 代替，V16.2 引擎统一扫描入口 */
export function scanVariety(code: string, bars: BarData[], contract: string): ScanResult {
  const name = VARIETIES[code] || code;
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const changePct = prev ? ((last.c - prev.c) / prev.c) * 100 : 0;

  // 技术指标
  const closes = bars.map((b) => b.c);
  const ema20Arr = calcEMA(closes, 20);
  const atrArr = calcATR(bars);
  const adxResult = calcADX(bars);

  // 各维度
  const spectrum = spectrumPosition(bars);
  const barId = barIdentity(bars);
  const ai = alwaysInDirection(bars);
  const pressure = buySellPressure(bars);
  const bo = breakoutScore(bars);
  const reversal = reversalQuality(bars);
  const overlap = overlapDetection(bars);
  const ft = followThrough(bars);
  const outsideBar = outsideBarDetection(bars);
  const trap = trapDetection(bars);
  const trendStr = trendStrengthScore(bars, adxResult.adx, adxResult.plusDI, adxResult.minusDI);
  const spike = spikeChannelPhase(bars);
  const barbwire = barbwireDetection(bars);
  const wedge = wedgeThreePush(bars);
  const climax = climaxDetection(bars, ai.emaDevPct);
  const mtrResult = mtrDetection(bars, adxResult.adx);
  const finalFlagResult = finalFlagDetection(bars);
  const legs = legCounter(bars);
  const magnets = magnetLevels(bars);
  
  // v12新增维度
  const gapType = classifyGap(bars);
  const majorSurprise = detectMajorSurprise(bars);
  const bar40_41Window = checkBar40_41Window(bars);

  // 量比
  const vols = bars.slice(-20).map((b) => b.vol);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const volRatio = avgVol > 0 ? last.vol / avgVol : 1;

  // 信号汇总 - 确保信号方向与AI方向逻辑一致
  const signals: string[] = [];
  if (bo.score >= 3) signals.push(`${bo.label}(${ai.direction === 'LONG' ? '多' : '空'})`);
  if (mtrResult.detected) {
    // MTR反转信号：根据AI方向标注信号方向
    // 如果AI=LONG但检测到MTR，说明是看空反转信号
    // 如果AI=SHORT但检测到MTR，说明是看多反转信号
    const mtrSignalDir = ai.direction === 'LONG' ? '空' : '多';
    signals.push(`MTR${mtrResult.type === 'major' ? '(重要)' : '(次要)'}趋势反转(${mtrSignalDir})`);
  }
  if (climax) signals.push('高潮运动');
  if (finalFlagResult.detected) signals.push(finalFlagResult.magnetEffect ? 'Final Flag(磁铁)' : 'Final Flag');
  if (wedge.detected) {
    // 楔形信号：根据楔形类型和AI方向判断
    // 熊市楔形在AI=LONG时是矛盾信号，需要标注
    // 牛市楔形在AI=SHORT时是矛盾信号，需要标注
    if (wedge.type === '熊市楔形' && ai.direction === 'LONG') {
      signals.push('熊市楔形(注意:与AI多头矛盾)');
    } else if (wedge.type === '牛市楔形' && ai.direction === 'SHORT') {
      signals.push('牛市楔形(注意:与AI空头矛盾)');
    } else {
      signals.push(wedge.type);
    }
  }
  if (trap !== '无') signals.push(trap);
  if (ai.flip) signals.push(`AI翻转→${ai.direction}`);
  if (barbwire) signals.push('Barbwire紧窄区间');
  if (reversal.score >= 4) {
    // 强反转信号：根据AI方向判断是否矛盾
    if (reversal.direction === '看跌' && ai.direction === 'LONG') {
      signals.push('强看跌反转(注意:与AI多头矛盾)');
    } else if (reversal.direction === '看涨' && ai.direction === 'SHORT') {
      signals.push('强看涨反转(注意:与AI空头矛盾)');
    } else {
      signals.push(`强${reversal.direction}`);
    }
  }
  if (outsideBar.isOutside) signals.push(outsideBar.direction);
  if (gapType !== 'none') signals.push(`${gapType === 'breakaway' ? '突破' : gapType === 'measuring' ? '测量' : '耗竭'}跳空`);
  if (majorSurprise) signals.push('Major Surprise');

  let signalLevel: 'strong' | 'moderate' | 'weak' | 'none' = 'none';
  if (signals.length >= 3) signalLevel = 'strong';
  else if (signals.length >= 2) signalLevel = 'moderate';
  else if (signals.length >= 1) signalLevel = 'weak';

  const result: ScanResult = {
    code, name, contract,
    close: last.c,
    change_pct: Math.round(changePct * 100) / 100,
    spectrum: spectrum.label,
    ai_direction: ai.direction,
    bar_identity: barId.identity,
    buy_sell_pressure: pressure.label,
    breakout_score: bo.score,
    breakout_label: bo.label,
    trend_strength: trendStr,
    trend_label: trendStr >= 70 ? '强趋势' : trendStr >= 50 ? '中等趋势' : trendStr >= 30 ? '弱趋势' : '区间',
    reversal_quality: reversal.score,
    overlap_pct: Math.round(overlap.overlapPct * 100) / 100,
    adx: Math.round(adxResult.adx * 10) / 10,
    plus_di: Math.round(adxResult.plusDI * 10) / 10,
    minus_di: Math.round(adxResult.minusDI * 10) / 10,
    atr: Math.round((atrArr[bars.length - 1] || 0) * 100) / 100,
    ema20: ai.ema20,
    ema_dev_pct: ai.emaDevPct,
    ai_streak: ai.aiStreak,
    ai_flip: ai.flip,
    volume_ratio: Math.round(volRatio * 100) / 100,
    trap_type: trap,
    climax_detected: climax,
    wedge_detected: wedge.detected,
    wedge_type: wedge.type,
    wedge_measurement_target: Math.round(wedge.measurementTarget * 100) / 100,
    mtr_detected: mtrResult.detected,
    mtr_type: mtrResult.type,
    final_flag: finalFlagResult.detected,
    final_flag_magnet: finalFlagResult.magnetEffect,
    barbwire,
    outside_bar: outsideBar.direction,
    follow_through: ft,
    leg_count: legs,
    magnet_levels: magnets.map((m) => Math.round(m * 100) / 100),
    gap_type: gapType,
    major_surprise: majorSurprise,
    bar_40_41_window: bar40_41Window,
    signals,
    signal_level: signalLevel,
  };

  // 超跌评分
  if (OVERSOLD_VARIETIES.has(code)) {
    const oversold = calcOversoldScore(bars);
    result.oversold_score = oversold.score;
    result.oversold_signal = oversold.signal;
    result.consec_down_days = oversold.consecDown;
    result.dev_ma20 = oversold.devMa20;
  }

  // 计算综合信号强度评分 (0-100)
  result.signal_strength_score = calcSignalStrengthScore(result);

  return result;
}

/**
 * 综合信号强度评分 (0-100)
 * 结合多个维度评估信号的有效性和强度
 */
function calcSignalStrengthScore(result: ScanResult): number {
  let score = 0;

  // 1. 趋势强度 (0-25分)
  if (result.trend_strength >= 70) score += 25;
  else if (result.trend_strength >= 50) score += 15;
  else if (result.trend_strength >= 30) score += 8;

  // 2. 突破有效性 (0-20分)
  if (result.breakout_score >= 4) score += 20;
  else if (result.breakout_score >= 3) score += 15;
  else if (result.breakout_score >= 2) score += 8;

  // 3. ADX趋势确认 (0-15分)
  if (result.adx >= 30) score += 15;
  else if (result.adx >= 25) score += 10;
  else if (result.adx >= 20) score += 5;

  // 4. AI方向一致性 (0-15分)
  if (result.ai_streak >= 10) score += 15;
  else if (result.ai_streak >= 5) score += 10;
  else if (result.ai_streak >= 3) score += 5;

  // 5. 特殊信号加成 (0-25分)
  if (result.mtr_detected) score += 10;
  if (result.final_flag) score += 8;
  if (result.climax_detected) score += 5;
  if (result.wedge_detected) score += 5;
  if (result.trap_type !== '无') score += 5;

  // 6. 信号数量加成
  if (result.signals.length >= 4) score += 10;
  else if (result.signals.length >= 3) score += 7;
  else if (result.signals.length >= 2) score += 4;

  // 7. 光谱定位调整
  if (result.spectrum === '趋势' && result.trend_strength >= 50) {
    score += 5; // 趋势状态下的信号更可靠
  }

  // 8. 量价配合
  if (result.volume_ratio >= 1.5) score += 5;
  if (result.volume_ratio >= 2.0) score += 3;

  return Math.min(100, Math.max(0, score));
}

// 跨品种联动分析
/** @deprecated V16.2 引擎内部处理跨品种联动 */
export function crossVarietyLinkage(results: ScanResult[]): {
  alerts: { group: string; leader: string; leaderName: string; signal: string; signalDir: string; members: { code: string; name: string; aiDir: string; status: string }[] }[];
} {
  const alerts: { group: string; leader: string; leaderName: string; signal: string; signalDir: string; members: { code: string; name: string; aiDir: string; status: string }[] }[] = [];

  const resultMap = new Map(results.map((r) => [r.code, r]));

  for (const [groupName, groupData] of Object.entries(VARIETY_GROUPS) as [string, { members: string[]; leader: string }][]) {
    const leaderResult = resultMap.get(groupData.leader);
    if (!leaderResult) continue;

    // 检查leader是否有强信号
    const leaderSignals: string[] = [];
    if (leaderResult.ai_flip) leaderSignals.push('AI翻转');
    if (leaderResult.breakout_score >= 3) leaderSignals.push('有效突破');
    if (leaderResult.mtr_detected) leaderSignals.push('MTR');
    if (leaderResult.final_flag) leaderSignals.push('Final Flag');
    if (leaderResult.climax_detected) leaderSignals.push('高潮');
    if (leaderResult.wedge_detected) leaderSignals.push('楔形');
    if (leaderResult.trap_type !== '无') leaderSignals.push('陷阱');
    if (leaderResult.trend_strength >= 70) leaderSignals.push('强趋势');

    if (leaderSignals.length === 0) continue;

    const members: { code: string; name: string; aiDir: string; status: string }[] = [];
    for (const memberCode of groupData.members) {
      if (memberCode === groupData.leader) continue;
      const memberResult = resultMap.get(memberCode);
      if (!memberResult) continue;
      members.push({
        code: memberCode,
        name: memberResult.name,
        aiDir: memberResult.ai_direction,
        status: memberResult.ai_direction === leaderResult.ai_direction ? '已跟随' : '待观察',
      });
    }

    if (members.length > 0) {
      alerts.push({
        group: groupName,
        leader: groupData.leader,
        leaderName: leaderResult.name,
        signal: leaderSignals.join('+'),
        signalDir: leaderResult.ai_direction,
        members,
      });
    }
  }

  return { alerts };
}

/**
 * 执行全品种扫描（分批并发，含趋势跟踪状态更新）
 * 从 routes/scan.ts 迁移至此，供路由与定时任务共用
 */
/** @deprecated 使用 runV16FullScan() 代替，V16.2 引擎统一扫描入口 */
export async function runFullScan(): Promise<ScanResultType[]> {
  const codes = Object.keys(VARIETIES).filter(isEnabledVariety);
  const results: ScanResultType[] = [];

  // 分批扫描，每批5个，避免并发过多
  const batchSize = 5;
  for (let i = 0; i < codes.length; i += batchSize) {
    const batch = codes.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (code) => {
        try {
          const data = await getVarietyData(code, 120);
          if (!data) return null;
          return scanVariety(code, data.bars, data.contract);
        } catch {
          return null;
        }
      })
    );
    results.push(...batchResults.filter((r): r is ScanResultType => r !== null));
  }

  // 更新活跃的趋势跟踪
  try {
    const scanTime = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const activeTracking = getActiveTrendTracking();

    for (const tracking of activeTracking) {
      const result = results.find((r) => r.code === tracking.code);
      if (result) {
        updateTrendTracking(tracking.code, tracking.signal_type, {
          last_price: result.close,
          last_ai_direction: result.ai_direction,
          last_trend_strength: result.trend_strength,
          last_update_time: scanTime,
        });

        // 如果AI方向反转，结束跟踪
        if (result.ai_direction !== tracking.signal_direction && result.ai_streak >= 3) {
          const priceChange = result.close - tracking.start_price;
          const pctChange = (priceChange / tracking.start_price) * 100;
          const isProfit = (tracking.signal_direction === 'LONG' && priceChange > 0) ||
                          (tracking.signal_direction === 'SHORT' && priceChange < 0);
          endTrendTracking(tracking.code, tracking.signal_type, {
            end_time: scanTime,
            end_price: result.close,
            result: isProfit ? 'profit' : 'loss',
          });
        }
      }
    }
  } catch (err) {
    console.error('Trend tracking update error:', err);
  }

  return results;
}

/**
 * 将扫描结果持久化到 signal_history，并为强信号启动趋势跟踪
 * 从 routes/scan.ts 的 POST /scan/save 提取，供路由与定时任务共用
 * @returns 保存的信号记录数
 */
export function persistScanResults(results: ScanResultType[], scanTime?: string): number {
  const time = scanTime || new Date().toISOString().slice(0, 19).replace('T', ' ');

  // 转换为信号记录
  const records: SignalRecord[] = results.map((r) => ({
    scan_time: time,
    code: r.code,
    name: r.name,
    contract: r.contract,
    close: r.close,
    change_pct: r.change_pct,
    spectrum: r.spectrum,
    ai_direction: r.ai_direction,
    ai_streak: r.ai_streak,
    ai_flip: r.ai_flip,
    trend_strength: r.trend_strength,
    breakout_score: r.breakout_score,
    breakout_label: r.breakout_label,
    signal_level: r.signal_level,
    signals: r.signals,
    signal_strength_score: r.signal_strength_score || 0,
    adx: r.adx,
    atr: r.atr,
    ema_dev_pct: r.ema_dev_pct,
    volume_ratio: r.volume_ratio,
    mtr_detected: r.mtr_detected,
    climax_detected: r.climax_detected,
    final_flag: r.final_flag,
    wedge_detected: r.wedge_detected,
    trap_type: r.trap_type,
    barbwire: r.barbwire,
    oversold_score: r.oversold_score,
    oversold_signal: r.oversold_signal,
    consec_down_days: r.consec_down_days,
    dev_ma20: r.dev_ma20,
  }));

  // 只保存有信号的记录
  const signalRecords = records.filter((r) => r.signal_level !== 'none');
  saveSignalRecords(signalRecords);

  // 开始跟踪强信号
  for (const r of results) {
    if (r.signal_level === 'strong' && r.signals.length > 0) {
      const signalType = r.signals[0];
      startTrendTracking({
        code: r.code,
        name: r.name,
        signal_type: signalType,
        signal_direction: r.ai_direction,
        start_time: time,
        start_price: r.close,
        start_scan_time: time,
      });
    }
  }

  return signalRecords.length;
}
