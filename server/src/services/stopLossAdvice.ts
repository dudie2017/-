/**
 * 止盈止损建议服务
 * 
 * 基于 ATR、关键位、MM 测量运动，为每个 tradable 品种生成：
 * - 建议入场价（激进/保守两档）
 * - 止损价（基于 ATR 倍数 + swing 点）
 * - 目标价（三档：T1/T2/T3）
 * - 盈亏比评估
 * - 时间止损建议
 */

import type { V16Row, KeyLevels } from './v16_types.js';
import type { BarData } from './varieties.js';
import { calcATR } from './indicators.js';
import { getSpec } from './backtestEngine.js';

export interface StopLossTakeProfitAdvice {
  code: string;
  direction: '多' | '空';
  close: number;
  atr: number;

  // 入场价建议
  entry: {
    aggressive: number;   // 激进：当前价附近
    conservative: number; // 保守：回踩关键位附近
    current: number;      // 当前收盘价
  };

  // 止损价
  stop: {
    price: number;        // 止损价
    distance: number;     // 止损距离（绝对值）
    distancePct: number;  // 止损距离占入场价百分比
    atrMultiple: number;  // ATR 倍数
    basis: string;        // 止损依据：'swing' | 'atr' | 'ch_stop'
  };

  // 目标价（三档）
  targets: {
    t1: { price: number; rr: number; basis: string };  // 第一目标（保守）
    t2: { price: number; rr: number; basis: string };  // 第二目标（标准）
    t3: { price: number; rr: number; basis: string };  // 第三目标（激进）
  };

  // 综合评估
  assessment: {
    bestRR: number;          // 最佳盈亏比（T3 对应）
    conservativeRR: number;  // 保守盈亏比（T1 对应）
    timeStop: string;        // 时间止损建议
    riskLevel: '低' | '中' | '高'; // 风险等级
  };
}

/**
 * 为单个品种生成止盈止损建议
 */
export function generateStopLossAdvice(
  row: V16Row,
  bars: BarData[],
): StopLossTakeProfitAdvice | null {
  const dir = row.ai_direction;
  if (!dir || dir === '中性') return null;

  const close = row.close;
  const atr = row.atr14 || (bars.length >= 15 ? calcATR(bars, 14)[bars.length - 1] : close * 0.02);
  if (atr <= 0 || !isFinite(atr)) return null;

  const kl = row.key_levels || null;
  const isLong = dir === '多';

  // ===== 入场价 =====
  const aggressive = close;
  let conservative: number;
  if (isLong) {
    // 做多保守入场：回踩到 EMA20 或支撑位附近
    const ema20 = kl?.ema20 || close * 0.99;
    const support = kl?.support || close * 0.98;
    // 取 EMA20 和支撑位中更靠近现价的
    conservative = Math.max(ema20, support);
    // 但不能低于支撑位太多
    conservative = Math.max(conservative, support * 0.995);
  } else {
    const ema20 = kl?.ema20 || close * 1.01;
    const resistance = kl?.resistance || close * 1.02;
    conservative = Math.min(ema20, resistance);
    conservative = Math.min(conservative, resistance * 1.005);
  }

  // ===== 止损价 =====
  let stopPrice: number;
  let stopBasis: string;
  const atrStop = isLong ? close - atr * 1.5 : close + atr * 1.5;

  if (isLong) {
    const swingStop = kl?.support || 0;
    const chStop = row.ch_stop || 0;
    // 优先用 CH 止损（如果有），否则取 swing 和 ATR 中更合理的
    if (chStop > 0 && chStop < close && (close - chStop) < atr * 3) {
      stopPrice = chStop;
      stopBasis = 'ch_stop';
    } else if (swingStop > 0 && swingStop < close && swingStop > atrStop) {
      stopPrice = swingStop;
      stopBasis = 'swing';
    } else {
      stopPrice = atrStop;
      stopBasis = 'atr';
    }
  } else {
    const swingStop = kl?.resistance || 0;
    const chStop = row.ch_stop || 0;
    if (chStop > 0 && chStop > close && (chStop - close) < atr * 3) {
      stopPrice = chStop;
      stopBasis = 'ch_stop';
    } else if (swingStop > 0 && swingStop > close && swingStop < atrStop) {
      stopPrice = swingStop;
      stopBasis = 'swing';
    } else {
      stopPrice = atrStop;
      stopBasis = 'atr';
    }
  }

  const stopDistance = Math.abs(close - stopPrice);
  const stopDistancePct = (stopDistance / close) * 100;
  const stopAtrMultiple = stopDistance / atr;

  // ===== 目标价（三档）=====
  // T1: 保守 — 1R（1倍止损距离）或结构位
  // T2: 标准 — 2R 或 MM tier1
  // T3: 激进 — 3R 或 MM tier2/tier3

  let t1Price: number, t2Price: number, t3Price: number;
  let t1Basis: string, t2Basis: string, t3Basis: string;

  if (isLong) {
    // T1: 取 1R 和结构阻力中较小的
    const r1Target = close + stopDistance;
    const structTarget = kl?.resistance || close + atr * 2;
    if (structTarget > close && structTarget < r1Target) {
      t1Price = structTarget;
      t1Basis = '结构阻力';
    } else {
      t1Price = r1Target;
      t1Basis = '1R';
    }

    // T2: 取 2R 和 MM tier1 中较优的
    const r2Target = close + stopDistance * 2;
    const mmT1 = row.mm_tier1 || 0;
    if (mmT1 > close && Math.abs(mmT1 - r2Target) / r2Target < 0.02) {
      t2Price = mmT1;
      t2Basis = 'MM测量T1';
    } else if (mmT1 > close) {
      t2Price = (r2Target + mmT1) / 2; // 取均值
      t2Basis = '2R+MM均值';
    } else {
      t2Price = r2Target;
      t2Basis = '2R';
    }

    // T3: 取 3R 和 MM tier2/tier3
    const r3Target = close + stopDistance * 3;
    const mmT2 = row.mm_tier2 || 0;
    const mmT3 = row.mm_tier3 || 0;
    if (mmT3 > close) {
      t3Price = mmT3;
      t3Basis = 'MM测量T3';
    } else if (mmT2 > close) {
      t3Price = mmT2;
      t3Basis = 'MM测量T2';
    } else {
      t3Price = r3Target;
      t3Basis = '3R';
    }

    // 确保目标价递增
    t2Price = Math.max(t2Price, t1Price * 1.001);
    t3Price = Math.max(t3Price, t2Price * 1.001);
  } else {
    // 做空
    const r1Target = close - stopDistance;
    const structTarget = kl?.support || close - atr * 2;
    if (structTarget > 0 && structTarget > close - stopDistance && structTarget < close) {
      t1Price = structTarget;
      t1Basis = '结构支撑';
    } else {
      t1Price = r1Target;
      t1Basis = '1R';
    }

    const r2Target = close - stopDistance * 2;
    const mmT1 = row.mm_tier1 || 0;
    if (mmT1 > 0 && mmT1 < close && Math.abs(mmT1 - r2Target) / r2Target < 0.02) {
      t2Price = mmT1;
      t2Basis = 'MM测量T1';
    } else if (mmT1 > 0 && mmT1 < close) {
      t2Price = (r2Target + mmT1) / 2;
      t2Basis = '2R+MM均值';
    } else {
      t2Price = r2Target;
      t2Basis = '2R';
    }

    const r3Target = close - stopDistance * 3;
    const mmT2 = row.mm_tier2 || 0;
    const mmT3 = row.mm_tier3 || 0;
    if (mmT3 > 0 && mmT3 < close) {
      t3Price = mmT3;
      t3Basis = 'MM测量T3';
    } else if (mmT2 > 0 && mmT2 < close) {
      t3Price = mmT2;
      t3Basis = 'MM测量T2';
    } else {
      t3Price = r3Target;
      t3Basis = '3R';
    }

    // 确保目标价递减（做空）
    t2Price = Math.min(t2Price, t1Price * 0.999);
    t3Price = Math.min(t3Price, t2Price * 0.999);
  }

  // ===== 盈亏比计算 =====
  const calcRR = (target: number): number => {
    const dist = Math.abs(target - close);
    return stopDistance > 0 ? Math.round((dist / stopDistance) * 100) / 100 : 0;
  };

  const t1RR = calcRR(t1Price);
  const t2RR = calcRR(t2Price);
  const t3RR = calcRR(t3Price);

  // ===== 综合评估 =====
  // 风险等级：基于止损距离占价格百分比
  let riskLevel: '低' | '中' | '高';
  if (stopDistancePct < 1.5) {
    riskLevel = '低';
  } else if (stopDistancePct < 3.0) {
    riskLevel = '中';
  } else {
    riskLevel = '高';
  }

  // 时间止损建议
  const adx = row.adx || 0;
  let timeStop: string;
  if (adx > 30) {
    timeStop = '强趋势，5日无进展减仓，8日无进展清仓';
  } else if (adx > 20) {
    timeStop = '趋势形成中，3日无进展减仓，5日无进展清仓';
  } else {
    timeStop = '弱趋势，2日无进展即清仓';
  }

  // 合约规格（用于取最小变动价位）
  const spec = getSpec(row.code);

  // 价格取整到最小变动价位
  const roundToTick = (price: number): number => {
    const tick = spec.tickSize || 1;
    return Math.round(price / tick) * tick;
  };

  return {
    code: row.code,
    direction: dir as '多' | '空',
    close,
    atr: Math.round(atr * 100) / 100,
    entry: {
      aggressive: roundToTick(aggressive),
      conservative: roundToTick(conservative),
      current: close,
    },
    stop: {
      price: roundToTick(stopPrice),
      distance: roundToTick(stopDistance),
      distancePct: Math.round(stopDistancePct * 100) / 100,
      atrMultiple: Math.round(stopAtrMultiple * 10) / 10,
      basis: stopBasis,
    },
    targets: {
      t1: { price: roundToTick(t1Price), rr: t1RR, basis: t1Basis },
      t2: { price: roundToTick(t2Price), rr: t2RR, basis: t2Basis },
      t3: { price: roundToTick(t3Price), rr: t3RR, basis: t3Basis },
    },
    assessment: {
      bestRR: t3RR,
      conservativeRR: t1RR,
      timeStop,
      riskLevel,
    },
  };
}

/**
 * 批量生成止盈止损建议
 */
export function generateAllStopLossAdvice(
  rows: V16Row[],
  barsMap: Map<string, BarData[]>,
): StopLossTakeProfitAdvice[] {
  const results: StopLossTakeProfitAdvice[] = [];
  for (const row of rows) {
    if (row.trade_worthiness !== 'tradable') continue;
    const bars = barsMap.get(row.code);
    if (!bars || bars.length < 20) continue;
    const advice = generateStopLossAdvice(row, bars);
    if (advice) results.push(advice);
  }
  return results;
}
