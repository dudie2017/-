import type { CandleBar } from '@/components/chart/CandlestickChart';

// ============ Brooks 信号棒质量评分 ============

export interface SignalBarScore {
  /** 总分 0-100 */
  total: number;
  /** 信号棒本身质量 0-40 */
  barQuality: number;
  /** 上下文配合度 0-30 */
  contextScore: number;
  /** 成交量配合 0-15 */
  volumeScore: number;
  /** 趋势配合度 0-15 */
  trendScore: number;
  /** 信号棒等级 */
  grade: 'A' | 'B' | 'C' | 'D';
  /** 信号方向 */
  direction: 'bullish' | 'bearish' | 'neutral';
  /** 详细分析 */
  analysis: string[];
}

function getBody(bar: CandleBar): number {
  return Math.abs(bar.c - bar.o);
}

function getRange(bar: CandleBar): number {
  return bar.h - bar.l;
}

function isBull(bar: CandleBar): boolean {
  return bar.c > bar.o;
}

function getClosePosition(bar: CandleBar): number {
  const range = getRange(bar);
  if (range === 0) return 0.5;
  return (bar.c - bar.l) / range;
}

function getUpperWick(bar: CandleBar): number {
  return bar.h - Math.max(bar.c, bar.o);
}

function getLowerWick(bar: CandleBar): number {
  return Math.min(bar.c, bar.o) - bar.l;
}

function avgRange(bars: CandleBar[], currentIndex: number, period: number = 10): number {
  const start = Math.max(0, currentIndex - period);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= currentIndex; i++) {
    sum += getRange(bars[i]);
    count++;
  }
  return count > 0 ? sum / count : 0;
}

function avgVolume(bars: CandleBar[], currentIndex: number, period: number = 10): number {
  const start = Math.max(0, currentIndex - period);
  let sum = 0;
  let count = 0;
  for (let i = start; i <= currentIndex; i++) {
    sum += bars[i].vol;
    count++;
  }
  return count > 0 ? sum / count : 1;
}

/**
 * 评估信号棒质量
 * 用于判断一根K线是否是好的入场信号
 */
export function evaluateSignalBar(
  bars: CandleBar[],
  index: number,
  direction: 'long' | 'short',
): SignalBarScore {
  if (index < 1 || index >= bars.length) {
    return {
      total: 0,
      barQuality: 0,
      contextScore: 0,
      volumeScore: 0,
      trendScore: 0,
      grade: 'D',
      direction: 'neutral',
      analysis: ['数据不足'],
    };
  }

  const bar = bars[index];
  const prev = bars[index - 1];
  const avgR = avgRange(bars, index);
  const avgV = avgVolume(bars, index);
  const analysis: string[] = [];

  // ============ 1. 信号棒本身质量 (0-40) ============
  let barQuality = 0;

  const body = getBody(bar);
  const range = getRange(bar);
  const bodyPct = range > 0 ? body / range : 0;
  const closePos = getClosePosition(bar);
  const upperWick = getUpperWick(bar);
  const lowerWick = getLowerWick(bar);

  // 实体占比
  if (bodyPct >= 0.7) {
    barQuality += 15;
    analysis.push('实体占比高，信号强');
  } else if (bodyPct >= 0.5) {
    barQuality += 10;
    analysis.push('实体占比中等');
  } else {
    barQuality += 3;
    analysis.push('实体占比低，信号弱');
  }

  // 收盘位置
  if (direction === 'long') {
    if (closePos >= 0.8) {
      barQuality += 15;
      analysis.push('收盘在K线顶部，多方控制');
    } else if (closePos >= 0.6) {
      barQuality += 8;
      analysis.push('收盘偏上方');
    } else {
      barQuality += 2;
      analysis.push('收盘位置不理想');
    }
  } else {
    if (closePos <= 0.2) {
      barQuality += 15;
      analysis.push('收盘在K线底部，空方控制');
    } else if (closePos <= 0.4) {
      barQuality += 8;
      analysis.push('收盘偏下方');
    } else {
      barQuality += 2;
      analysis.push('收盘位置不理想');
    }
  }

  // 影线评估
  if (direction === 'long') {
    if (upperWick < body * 0.3) {
      barQuality += 10;
      analysis.push('上影线短，抛压小');
    } else if (upperWick > body) {
      barQuality -= 5;
      analysis.push('上影线过长，有抛压');
    }
  } else {
    if (lowerWick < body * 0.3) {
      barQuality += 10;
      analysis.push('下影线短，支撑弱');
    } else if (lowerWick > body) {
      barQuality -= 5;
      analysis.push('下影线过长，有买盘支撑');
    }
  }

  // 信号棒大小
  if (body > avgR * 1.5) {
    barQuality += 5;
    analysis.push('信号棒较大，力度强');
  } else if (body < avgR * 0.5) {
    barQuality -= 3;
    analysis.push('信号棒较小，力度弱');
  }

  barQuality = Math.max(0, Math.min(40, barQuality));

  // ============ 2. 上下文配合度 (0-30) ============
  let contextScore = 0;

  // 前一根K线方向
  if (direction === 'long') {
    if (isBull(prev)) {
      contextScore += 10;
      analysis.push('前K线为阳线，方向一致');
    } else {
      contextScore += 3;
    }
  } else {
    if (!isBull(prev)) {
      contextScore += 10;
      analysis.push('前K线为阴线，方向一致');
    } else {
      contextScore += 3;
    }
  }

  // 连续方向
  let consecutive = 0;
  for (let i = Math.max(0, index - 5); i < index; i++) {
    if (direction === 'long' && isBull(bars[i])) consecutive++;
    if (direction === 'short' && !isBull(bars[i])) consecutive++;
  }
  if (consecutive >= 3) {
    contextScore += 10;
    analysis.push(`连续${consecutive}根同向K线`);
  } else if (consecutive >= 2) {
    contextScore += 5;
  }

  // 支撑/阻力
  if (direction === 'long') {
    if (bar.c > prev.h) {
      contextScore += 10;
      analysis.push('突破前高，确认方向');
    }
  } else {
    if (bar.c < prev.l) {
      contextScore += 10;
      analysis.push('跌破前低，确认方向');
    }
  }

  contextScore = Math.max(0, Math.min(30, contextScore));

  // ============ 3. 成交量配合 (0-15) ============
  let volumeScore = 0;

  if (bar.vol > avgV * 1.5) {
    volumeScore += 15;
    analysis.push('放量确认，信号可靠');
  } else if (bar.vol > avgV * 1.2) {
    volumeScore += 10;
    analysis.push('量能温和放大');
  } else if (bar.vol < avgV * 0.8) {
    volumeScore += 2;
    analysis.push('缩量信号，可靠性降低');
  } else {
    volumeScore += 5;
    analysis.push('量能正常');
  }

  volumeScore = Math.max(0, Math.min(15, volumeScore));

  // ============ 4. 趋势配合度 (0-15) ============
  let trendScore = 0;

  // 计算简单EMA
  const emaPeriod = Math.min(20, index);
  let ema = bars[0].c;
  const k = 2 / (emaPeriod + 1);
  for (let i = 1; i <= index; i++) {
    ema = bars[i].c * k + ema * (1 - k);
  }

  if (direction === 'long') {
    if (bar.c > ema) {
      trendScore += 15;
      analysis.push('价格在EMA上方，趋势配合');
    } else {
      trendScore += 5;
      analysis.push('价格在EMA下方，逆势信号');
    }
  } else {
    if (bar.c < ema) {
      trendScore += 15;
      analysis.push('价格在EMA下方，趋势配合');
    } else {
      trendScore += 5;
      analysis.push('价格在EMA上方，逆势信号');
    }
  }

  trendScore = Math.max(0, Math.min(15, trendScore));

  // ============ 总分 ============
  const total = barQuality + contextScore + volumeScore + trendScore;

  const grade = total >= 80 ? 'A' : total >= 60 ? 'B' : total >= 40 ? 'C' : 'D';
  const sigDirection = direction === 'long' ? 'bullish' as const : 'bearish' as const;

  return {
    total,
    barQuality,
    contextScore,
    volumeScore,
    trendScore,
    grade,
    direction: sigDirection,
    analysis,
  };
}
