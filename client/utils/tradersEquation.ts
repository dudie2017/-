/**
 * Brooks 交易者方程（Trader's Equation）核心计算
 *
 * 公式：P × R > (1-P) × S
 *   P = 盈利概率（0-1）
 *   R = 盈利点数（目标位 - 入场位）
 *   S = 亏损点数（入场位 - 止损位）
 */

export type TradeDirection = 'long' | 'short';

export interface EquationInput {
  direction: TradeDirection;
  entry: number;
  stop: number;
  target: number;
  /** 盈利概率 0-1 */
  probability: number;
}

export interface EquationResult {
  /** 止损点数 */
  riskPoints: number;
  /** 目标点数 */
  rewardPoints: number;
  /** 盈亏比（reward / risk），risk 为 0 时返回 0 */
  rrRatio: number;
  /** P × R 期望盈利 */
  expectedWin: number;
  /** (1-P) × S 期望亏损 */
  expectedLoss: number;
  /** 方程是否为正 */
  isPositive: boolean;
  /** 当前概率下的最低盈亏比要求 */
  minRR: number;
  /** 当前盈亏比是否满足概率要求 */
  rrSatisfied: boolean;
  /** 参数是否合法（止损/目标方向正确） */
  valid: boolean;
  /** 不合法原因 */
  invalidReason?: string;
}

/** 概率与最低盈亏比匹配表（Brooks 规则） */
export function minRRForProbability(p: number): number {
  if (p >= 0.6) return 1.0;
  if (p >= 0.5) return 1.5;
  if (p >= 0.4) return 2.0;
  return 3.0;
}

/** 计算交易者方程 */
export function calcTradersEquation(input: EquationInput): EquationResult {
  const { direction, entry, stop, target, probability } = input;
  const p = Math.min(Math.max(probability, 0), 1);

  const riskPoints = direction === 'long' ? entry - stop : stop - entry;
  const rewardPoints = direction === 'long' ? target - entry : entry - target;

  // 参数合法性校验
  if (riskPoints <= 0) {
    return {
      riskPoints: 0, rewardPoints: 0, rrRatio: 0,
      expectedWin: 0, expectedLoss: 0,
      isPositive: false, minRR: minRRForProbability(p), rrSatisfied: false,
      valid: false,
      invalidReason: direction === 'long' ? '做多止损必须低于入场价' : '做空止损必须高于入场价',
    };
  }
  if (rewardPoints <= 0) {
    return {
      riskPoints, rewardPoints: 0, rrRatio: 0,
      expectedWin: 0, expectedLoss: 0,
      isPositive: false, minRR: minRRForProbability(p), rrSatisfied: false,
      valid: false,
      invalidReason: direction === 'long' ? '做多目标必须高于入场价' : '做空目标必须低于入场价',
    };
  }

  const rrRatio = rewardPoints / riskPoints;
  const expectedWin = p * rewardPoints;
  const expectedLoss = (1 - p) * riskPoints;
  const minRR = minRRForProbability(p);

  return {
    riskPoints,
    rewardPoints,
    rrRatio,
    expectedWin,
    expectedLoss,
    isPositive: expectedWin > expectedLoss,
    minRR,
    rrSatisfied: rrRatio >= minRR,
    valid: true,
  };
}

/**
 * 概率自动估算
 * 来源：历史信号胜率（优先，与后端交易者方程一致）/ 信号棒评分等级 + Always In 对齐 + 市场状态
 *
 * 基础概率：
 * - 有真实历史胜率（近20次同类信号）：直接用（钳制 30%-65%），与后端判定链同源
 * - 否则按信号等级基准：A→60% B→55% C→50% D→40% 无→50%
 * Always In 对齐：+5%；反向：-10%
 * 市场状态：趋势初期/强趋势 +0%（已含在AI），区间 -5%
 */
export function estimateProbability(opts: {
  edgeGrade?: 'A' | 'B' | 'C' | 'D' | null;
  winRate20?: number | null;         // Edge 真实历史胜率（近20次信号），优先于等级基准
  aiDirection?: string | null;       // 'LONG' | 'SHORT' | null
  tradeDirection?: TradeDirection;
  spectrum?: string | null;          // 市场状态谱（含"区间"则 -5%）
}): { probability: number; breakdown: { label: string; delta: number }[] } {
  const breakdown: { label: string; delta: number }[] = [];

  // 基础概率：优先真实历史胜率，否则按 Edge 等级基准
  let base = 0.5;
  if (opts.winRate20 != null) {
    base = Math.min(Math.max(opts.winRate20, 0.3), 0.65);
    breakdown.push({ label: `历史胜率(近20次)`, delta: base });
  } else {
    if (opts.edgeGrade === 'A') base = 0.60;
    else if (opts.edgeGrade === 'B') base = 0.55;
    else if (opts.edgeGrade === 'C') base = 0.50;
    else if (opts.edgeGrade === 'D') base = 0.40;
    breakdown.push({ label: `信号等级 ${opts.edgeGrade ?? '无'}`, delta: base });
  }

  let p = base;

  // Always In 对齐
  if (opts.aiDirection && opts.tradeDirection) {
    const aiLong = opts.aiDirection === 'LONG';
    const tradeLong = opts.tradeDirection === 'long';
    if (aiLong === tradeLong) {
      p += 0.05;
      breakdown.push({ label: 'Always In 对齐', delta: 0.05 });
    } else {
      p -= 0.10;
      breakdown.push({ label: 'Always In 反向', delta: -0.10 });
    }
  }

  // 区间状态
  if (opts.spectrum && opts.spectrum.includes('区间')) {
    p -= 0.05;
    breakdown.push({ label: '区间市场', delta: -0.05 });
  }

  return { probability: Math.min(Math.max(p, 0.05), 0.95), breakdown };
}

/** 仓位计算输入 */
export interface PositionSizeInput {
  /** 账户权益（元） */
  accountEquity: number;
  /** 单笔风险比例（0-1），默认 0.02 */
  riskPct: number;
  /** 止损点数 */
  stopPoints: number;
  /** 每点价值（元/点/手） */
  pointValue: number;
}

export interface PositionSizeResult {
  /** 最大可接受亏损金额 */
  riskAmount: number;
  /** 每手最大亏损 */
  perLotRisk: number;
  /** 建议手数（向下取整） */
  lots: number;
  valid: boolean;
  invalidReason?: string;
}

/** 仓位大小计算：仓位 = 最大可接受亏损 ÷ 止损点数 ÷ 每点价值 */
export function calcPositionSize(input: PositionSizeInput): PositionSizeResult {
  const { accountEquity, riskPct, stopPoints, pointValue } = input;

  if (accountEquity <= 0) {
    return { riskAmount: 0, perLotRisk: 0, lots: 0, valid: false, invalidReason: '账户权益必须大于0' };
  }
  if (stopPoints <= 0) {
    return { riskAmount: 0, perLotRisk: 0, lots: 0, valid: false, invalidReason: '止损点数必须大于0' };
  }
  if (pointValue <= 0) {
    return { riskAmount: 0, perLotRisk: 0, lots: 0, valid: false, invalidReason: '每点价值必须大于0' };
  }

  const riskAmount = accountEquity * riskPct;
  const perLotRisk = stopPoints * pointValue;
  const lots = Math.floor(riskAmount / perLotRisk);

  return { riskAmount, perLotRisk, lots, valid: true };
}

/**
 * 时间止损检查（Brooks 规则）
 * 短线：3根K线；波段：5根K线
 */
export interface TimeStopInput {
  /** 持仓已过的K线数 */
  barsHeld: number;
  /** 模式：scalp=短线3根, swing=波段5根 */
  mode: 'scalp' | 'swing';
  /** 止损幅度（点数） */
  stopPoints: number;
  /** 持仓期间最大波动幅度（点数） */
  maxRange: number;
  /** 最大浮盈（点数） */
  maxProfit: number;
  /** 当前浮盈（点数，负数为浮亏） */
  currentProfit: number;
  /** Always In 是否已翻转 */
  aiFlipped: boolean;
  /** EMA20 是否走平 */
  ema20Flat: boolean;
}

export interface TimeStopResult {
  triggered: boolean;
  reason?: string;
  /** 时间止损截止K线数 */
  deadline: number;
  /** 是否到期 */
  expired: boolean;
}

export function checkTimeStop(input: TimeStopInput): TimeStopResult {
  const deadline = input.mode === 'scalp' ? 3 : 5;
  const expired = input.barsHeld >= deadline;

  // 条件3：市场状态切换（任意时间触发）
  if (input.aiFlipped) {
    return { triggered: true, reason: 'Always In 方向翻转，市场状态已切换', deadline, expired };
  }
  if (expired && input.ema20Flat) {
    return { triggered: true, reason: 'EMA20 走平，趋势已结束', deadline, expired };
  }

  if (!expired) {
    return { triggered: false, deadline, expired };
  }

  // 条件1：波动不足（到期时振幅 < 止损幅度50%）
  if (input.maxRange < input.stopPoints * 0.5) {
    return {
      triggered: true,
      reason: `${deadline}根K线波动 ${input.maxRange.toFixed(0)}点 < 止损幅度50%（${(input.stopPoints * 0.5).toFixed(0)}点）`,
      deadline, expired,
    };
  }

  // 条件2：浮盈回吐超过50%（曾浮盈，现在回吐超过一半）
  if (input.maxProfit > 0 && input.currentProfit < input.maxProfit * 0.5) {
    return {
      triggered: true,
      reason: `浮盈回吐超过50%（峰值${input.maxProfit.toFixed(0)}点 → 当前${input.currentProfit.toFixed(0)}点）`,
      deadline, expired,
    };
  }

  return { triggered: false, deadline, expired };
}

/**
 * 加仓时机检测（Brooks 三时机）
 * 注意：此函数只做条件判断，调用方需保证传入数据来自最新K线
 */
export interface ScalingInInput {
  /** 当前是否浮盈（加仓前提：只在浮盈时加仓） */
  inProfit: boolean;
  /** 当前已加仓次数（上限1次，即底仓+1） */
  scaleCount: number;
  /** 价格是否回踩到 EMA20 附近（±0.5%） */
  nearEMA20: boolean;
  /** 价格是否回踩到被突破位附近（±0.5%） */
  nearBreakoutLevel: boolean;
  /** 是否出现新的信号棒 */
  hasSignalBar: boolean;
  /** 回调K线是否为大反向趋势棒（是则禁止加仓） */
  pullbackIsBigCounterBar: boolean;
}

export interface ScalingInResult {
  allowed: boolean;
  timing?: 'ema20_pullback' | 'breakout_retest';
  reason: string;
}

export function checkScalingIn(input: ScalingInInput): ScalingInResult {
  // 禁忌1：浮亏不加仓
  if (!input.inProfit) {
    return { allowed: false, reason: '浮亏中禁止加仓（摊低成本 = 逆势加码）' };
  }
  // 次数限制：最多1次加仓
  if (input.scaleCount >= 1) {
    return { allowed: false, reason: '已达加仓次数上限（底仓+1次）' };
  }
  // 禁忌2：必须有新信号棒
  if (!input.hasSignalBar) {
    return { allowed: false, reason: '未出现新信号棒，不能凭情绪加仓' };
  }
  // 禁忌：回调是大反向趋势棒
  if (input.pullbackIsBigCounterBar) {
    return { allowed: false, reason: '回调出现大反向趋势棒，动能存疑，不加仓' };
  }

  if (input.nearEMA20) {
    return { allowed: true, timing: 'ema20_pullback', reason: 'EMA20 回踩 + 信号棒确认，可加仓' };
  }
  if (input.nearBreakoutLevel) {
    return { allowed: true, timing: 'breakout_retest', reason: '突破位回踩 + 信号棒确认，可加仓' };
  }

  return { allowed: false, reason: '价格不在 EMA20 或突破位附近，等待回踩' };
}

/**
 * 在最近N根K线中寻找摆动点作为目标位
 * 做多：最近摆动高点；做空：最近摆动低点
 * 找不到时回退到 2×风险距离 的目标
 */
export function findRecentSwing(
  bars: { h: number; l: number; c: number }[],
  currentIndex: number,
  direction: TradeDirection,
  lookback: number = 15,
): number {
  const start = Math.max(0, currentIndex - lookback);
  const current = bars[currentIndex];
  if (!current) return 0;

  if (direction === 'long') {
    let swingHigh = -Infinity;
    for (let i = start; i < currentIndex; i++) {
      const b = bars[i];
      if (!b) continue;
      // 摆动高点：左右邻居都更低
      const left = bars[i - 1];
      const right = bars[i + 1];
      const isSwing = (!left || b.h >= left.h) && (!right || b.h >= right.h);
      if (isSwing && b.h > current.c && b.h > swingHigh) swingHigh = b.h;
    }
    if (swingHigh > current.c) return swingHigh;
    // 回退：用区间最高价
    let maxH = -Infinity;
    for (let i = start; i <= currentIndex; i++) if (bars[i] && bars[i].h > maxH) maxH = bars[i].h;
    if (maxH > current.c) return maxH;
    return current.c * 1.02; // 兜底 +2%
  }

  let swingLow = Infinity;
  for (let i = start; i < currentIndex; i++) {
    const b = bars[i];
    if (!b) continue;
    const left = bars[i - 1];
    const right = bars[i + 1];
    const isSwing = (!left || b.l <= left.l) && (!right || b.l <= right.l);
    if (isSwing && b.l < current.c && b.l < swingLow) swingLow = b.l;
  }
  if (swingLow < current.c) return swingLow;
  let minL = Infinity;
  for (let i = start; i <= currentIndex; i++) if (bars[i] && bars[i].l < minL) minL = bars[i].l;
  if (minL < current.c) return minL;
  return current.c * 0.98; // 兜底 -2%
}
