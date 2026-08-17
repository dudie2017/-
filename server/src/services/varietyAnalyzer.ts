/**
 * 期货单品种全面分析服务 V3.1.2
 * 基于三线合一决策系统：供需面（付海棠）+ 利润信号（参谋部）+ Brooks价格行为（总管）
 *
 * V3.1.2 更新：
 * - Always In 方向追踪（日线+60min双周期）
 * - 信号K线详细状态（吞没/孕线/射击之星/锤子线等）
 * - 回调入场区间（Brooks标准方法）
 * - 贵金属保守化（评分上限±1.5）
 * - 非农产品限幅（评分上限±3.0）
 * - 白银跟随黄金规则
 * - 时序错位判定（替代"矛盾"说法）
 * - 安全阀机制（多维度负分降仓）
 * - 三档梯度仓位
 */

import db from './database';

// ============================================================
// 类型定义
// ============================================================

export const Direction = {
  LONG: '做多' as const,
  SHORT: '做空' as const,
  WAIT: '不交易' as const,
  NEUTRAL: '中性' as const,
};
export type Direction = (typeof Direction)[keyof typeof Direction];

export const SignalLevel = {
  NONE: '无信号' as const,
  WEAK: '★观察级' as const,
  MEDIUM: '★★可执行' as const,
  STRONG: '★★★重仓级' as const,
};
export type SignalLevel = (typeof SignalLevel)[keyof typeof SignalLevel];

export const DataQuality = {
  A: 'A' as const,
  B: 'B' as const,
  C: 'C' as const,
};
export type DataQuality = (typeof DataQuality)[keyof typeof DataQuality];

export const AlwaysInDirection = {
  LONG: 'AI多头' as const,
  SHORT: 'AI空头' as const,
  NEUTRAL: '震荡' as const,
};
export type AlwaysInDirection = (typeof AlwaysInDirection)[keyof typeof AlwaysInDirection];

export const MarketState = {
  TRENDING: '趋势' as const,
  TRADING_RANGE: '震荡' as const,
  BREAKOUT: '突破' as const,
  PULLBACK: '回调' as const,
};
export type MarketState = (typeof MarketState)[keyof typeof MarketState];

export interface OHLCVBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openInterest?: number;
  oiChange?: number;
}

export interface SignalBar {
  bar: OHLCVBar;
  isBullish: boolean;
  bodySize: number;
  upperShadow: number;
  lowerShadow: number;
  isEngulfing: boolean;
  isInside: boolean;
  hasFollowThrough: boolean;
}

export interface SupplyDemandScore {
  score: number; // -5 ~ +5
  direction: Direction;
  coreContradiction: string;
  supplyGapRate: number;
  inventoryPercentile: number;
  confidence: DataQuality;
  // V3.1.1 新增
  isPreciousMetal: boolean;
  preciousMetalCap: number;
  macroDominant: boolean;
  supplyScoreCap: number | null;
}

export interface ProfitSignal {
  signalLevel: SignalLevel;
  signalDirection: Direction;
  vp: number;
  zScore: number;
  winRate: number;
  sharpe: number;
  sampleSize: number;
  resonanceScore: number;
  // V3.1 新增
  basisValue: number | null;
  basisRate: number;
}

export interface BrooksScore {
  total: number; // -3 ~ +3
  resonanceScore: number; // 映射到-5~+5
  p0MultiTf: number; // 多周期共振 (30%)
  p1Trend: number; // 趋势强度 (20%)
  p2SignalBar: number; // 信号K线 (15%)
  p3KeyLevels: number; // 关键位 (15%)
  p4VolumeOi: number; // 量仓关系 (10%)
  p5Patterns: number; // 形态识别 (5%)
  p6Extremes: number; // 超买超卖 (5%)
  // V3.1 新增
  rawTotal: number | null;
  recalculatedTotal: number;
  alwaysInDaily: string;
  alwaysIn60min: string;
  alwaysInResonance: boolean;
  hasSignalBar: boolean;
  signalBarStatus: string;
  signalBarTimeframe: string;
  signalBarDetail: string;
  signalBarCount: number;
  signalBarBodyRatio: number;
  signalBarUpperShadowRatio: number;
  signalBarLowerShadowRatio: number;
  pullbackZoneLow: number;
  pullbackZoneHigh: number;
  pullbackBasis: string;
  brooksEntryPrice: number;
  brooksStopLoss: number;
  brooksRrRatio: number;
  brooksTargetPrice: number;
  calibrationWarning: string;
}

export interface KeyLevels {
  ema20Daily: number;
  ema2060min: number;
  recentHigh20d: number;
  recentLow20d: number;
  support: number;
  resistance: number;
  // V3.1.1 新增
  ema20DailyFeishu: number;
  ema20Divergence: string;
  ema20DailySource: string;
}

export interface TradeDecision {
  variety: string;
  action: Direction;
  signalLevel: SignalLevel;
  positionPct: number;
  entryPrice: number;
  stopLoss: number;
  targetPrice: number;
  maxHoldDays: number;
  reasons: string[];
  warnings: string[];
  // 详细分析数据
  supplyDemand: SupplyDemandScore;
  profitSignal: ProfitSignal;
  brooksScore: BrooksScore;
  keyLevels: KeyLevels;
  resonance: ResonanceResult;
}

export interface ResonanceResult {
  sdScore: number;
  profitScore: number;
  brooksScore: number;
  seasonalScore: number;
  macroScore: number;
  total: number;
  negativeCount: number;
}

// ============================================================
// 品种配置 (V3.1.2)
// ============================================================

export const Board = {
  BLACK: '黑色系' as const,
  NON_FERROUS: '有色金属' as const,
  PRECIOUS: '贵金属' as const,
  OIL_FAT: '油脂油料' as const,
  CORN: '玉米系' as const,
  CHEMICAL: '化工' as const,
  AGRICULTURAL: '农产品' as const,
  LIVESTOCK: '畜牧' as const,
  ALLOY: '合金' as const,
};

export interface VarietyConfig {
  name: string;
  board: string;
  multiplier: number;
  tick: number;
  isPreciousMetal: boolean;
  costLine?: number;
  profitFormula?: string;
}

export const VARIETY_CONFIG: Record<string, VarietyConfig> = {
  // 黑色系
  RB: { name: '螺纹钢', board: Board.BLACK, multiplier: 10, tick: 1, isPreciousMetal: false },
  HC: { name: '热卷', board: Board.BLACK, multiplier: 10, tick: 1, isPreciousMetal: false },
  I: { name: '铁矿石', board: Board.BLACK, multiplier: 100, tick: 0.5, isPreciousMetal: false },
  J: { name: '焦炭', board: Board.BLACK, multiplier: 100, tick: 0.5, isPreciousMetal: false },
  JM: { name: '焦煤', board: Board.BLACK, multiplier: 60, tick: 0.5, isPreciousMetal: false },
  // 有色金属
  CU: { name: '铜', board: Board.NON_FERROUS, multiplier: 5, tick: 10, isPreciousMetal: false },
  AL: { name: '铝', board: Board.NON_FERROUS, multiplier: 5, tick: 5, isPreciousMetal: false },
  ZN: { name: '锌', board: Board.NON_FERROUS, multiplier: 5, tick: 5, isPreciousMetal: false },
  NI: { name: '镍', board: Board.NON_FERROUS, multiplier: 1, tick: 10, isPreciousMetal: false },
  // 贵金属
  AG: { name: '白银', board: Board.PRECIOUS, multiplier: 15, tick: 1, isPreciousMetal: true },
  AU: { name: '黄金', board: Board.PRECIOUS, multiplier: 1000, tick: 0.02, isPreciousMetal: true },
  // 油脂油料
  M: { name: '豆粕', board: Board.OIL_FAT, multiplier: 10, tick: 1, isPreciousMetal: false },
  Y: { name: '豆油', board: Board.OIL_FAT, multiplier: 10, tick: 2, isPreciousMetal: false },
  OI: { name: '菜油', board: Board.OIL_FAT, multiplier: 10, tick: 1, isPreciousMetal: false },
  RM: { name: '菜粕', board: Board.OIL_FAT, multiplier: 10, tick: 1, isPreciousMetal: false },
  P: { name: '棕榈油', board: Board.OIL_FAT, multiplier: 10, tick: 2, isPreciousMetal: false },
  A: { name: '豆一', board: Board.CORN, multiplier: 10, tick: 1, isPreciousMetal: false },
  // 化工
  MA: { name: '甲醇', board: Board.CHEMICAL, multiplier: 10, tick: 1, isPreciousMetal: false },
  TA: { name: 'PTA', board: Board.CHEMICAL, multiplier: 5, tick: 2, isPreciousMetal: false },
  PP: { name: '聚丙烯', board: Board.CHEMICAL, multiplier: 5, tick: 1, isPreciousMetal: false },
  L: { name: '塑料', board: Board.CHEMICAL, multiplier: 5, tick: 1, isPreciousMetal: false },
  SA: { name: '纯碱', board: Board.CHEMICAL, multiplier: 20, tick: 1, isPreciousMetal: false },
  FU: { name: '燃油', board: Board.CHEMICAL, multiplier: 10, tick: 1, isPreciousMetal: false },
  BU: { name: '沥青', board: Board.CHEMICAL, multiplier: 10, tick: 2, isPreciousMetal: false },
  // 农产品
  JD: { name: '鸡蛋', board: Board.AGRICULTURAL, multiplier: 10, tick: 1, isPreciousMetal: false },
  AP: { name: '苹果', board: Board.AGRICULTURAL, multiplier: 10, tick: 1, isPreciousMetal: false },
  // 畜牧
  LH: { name: '生猪', board: Board.LIVESTOCK, multiplier: 16, tick: 5, isPreciousMetal: false },
  // 合金
  SF: { name: '硅铁', board: Board.ALLOY, multiplier: 5, tick: 2, isPreciousMetal: false },
  SM: { name: '锰硅', board: Board.ALLOY, multiplier: 5, tick: 2, isPreciousMetal: false },
};

// 季节性评分（简化版）
const SEASONAL_SCORES: Record<string, Record<number, number>> = {
  JD: { 1: 2, 2: 1, 3: -1, 4: 0, 5: -1, 6: -2, 7: 0, 8: 1, 9: 2, 10: 1, 11: 0, 12: 1 },
  AP: { 1: -1, 2: -1, 3: 0, 4: 1, 5: 1, 6: 0, 7: -1, 8: -1, 9: 2, 10: 3, 11: 1, 12: -1 },
  M: { 1: 1, 2: 0, 3: -1, 4: -1, 5: 0, 6: 1, 7: 2, 8: 2, 9: 1, 10: 0, 11: -1, 12: 0 },
  P: { 1: 1, 2: 1, 3: 0, 4: -1, 5: -1, 6: 0, 7: 1, 8: 2, 9: 2, 10: 1, 11: 0, 12: 1 },
  Y: { 1: 1, 2: 1, 3: 0, 4: -1, 5: -1, 6: 0, 7: 1, 8: 2, 9: 2, 10: 1, 11: 0, 12: 1 },
  RM: { 1: 0, 2: 0, 3: -1, 4: -1, 5: 0, 6: 1, 7: 2, 8: 1, 9: 0, 10: -1, 11: 0, 12: 0 },
  OI: { 1: 1, 2: 0, 3: -1, 4: -1, 5: 0, 6: 0, 7: 1, 8: 2, 9: 1, 10: 0, 11: 0, 12: 1 },
};

// 宏观事件过滤规则
const MACRO_EVENT_FILTER: Record<string, Record<string, string>> = {
  [Board.PRECIOUS]: {
    FOMC: '利率决议日，禁止开仓（波动剧烈且方向不确定）',
  },
  [Board.OIL_FAT]: {
    USDA: 'USDA报告日发布前后1小时禁止开仓',
  },
  [Board.CHEMICAL]: {
    MPOB: 'MPOB报告日发布前后1小时禁止开仓',
  },
};

// 已验证信号品种
const VERIFIED_SIGNALS = new Set(['J', 'JM', 'RB', 'I', 'M', 'SA', 'JD', 'LH']);

// ============================================================
// 技术分析器 (V3.1.2)
// ============================================================

class TechnicalAnalyzer {
  private bars: OHLCVBar[];
  private bars60min: OHLCVBar[] | null;

  constructor(bars: OHLCVBar[], bars60min: OHLCVBar[] | null = null) {
    this.bars = bars;
    this.bars60min = bars60min;
  }

  // 计算EMA
  calcEMA(period: number, data?: OHLCVBar[]): number[] {
    const src = data || this.bars;
    const result: number[] = [];
    const k = 2 / (period + 1);
    let ema = src[0]?.close || 0;

    for (let i = 0; i < src.length; i++) {
      if (i === 0) {
        ema = src[i].close;
      } else {
        ema = src[i].close * k + ema * (1 - k);
      }
      result.push(ema);
    }
    return result;
  }

  // V3.1: 获取Always-In方向（日线）
  getAlwaysInDirection(): AlwaysInDirection {
    if (this.bars.length < 20) return AlwaysInDirection.NEUTRAL;

    const ema20 = this.calcEMA(20);
    const lastClose = this.bars[this.bars.length - 1].close;
    const lastEma = ema20[ema20.length - 1];
    const prevEma = ema20[ema20.length - 2];

    const emaTrendUp = lastEma > prevEma;
    const priceAboveEma = lastClose > lastEma;

    if (priceAboveEma && emaTrendUp) return AlwaysInDirection.LONG;
    if (!priceAboveEma && !emaTrendUp) return AlwaysInDirection.SHORT;
    return AlwaysInDirection.NEUTRAL;
  }

  // V3.1: 获取60min Always-In方向
  getAlwaysIn60min(): AlwaysInDirection | null {
    if (!this.bars60min || this.bars60min.length < 20) return null;

    const ema20 = this.calcEMA(20, this.bars60min);
    const lastClose = this.bars60min[this.bars60min.length - 1].close;
    const lastEma = ema20[ema20.length - 1];
    const prevEma = ema20[ema20.length - 2];

    const emaTrendUp = lastEma > prevEma;
    const priceAboveEma = lastClose > lastEma;

    if (priceAboveEma && emaTrendUp) return AlwaysInDirection.LONG;
    if (!priceAboveEma && !emaTrendUp) return AlwaysInDirection.SHORT;
    return AlwaysInDirection.NEUTRAL;
  }

  // 获取市场状态
  getMarketState(): MarketState {
    if (this.bars.length < 20) return MarketState.TRADING_RANGE;

    const ema20 = this.calcEMA(20);
    const lastClose = this.bars[this.bars.length - 1].close;
    const lastEma = ema20[ema20.length - 1];

    // 计算波动率
    const returns: number[] = [];
    for (let i = 1; i < Math.min(20, this.bars.length); i++) {
      returns.push((this.bars[i].close - this.bars[i - 1].close) / this.bars[i - 1].close);
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => Math.pow(b - avgReturn, 2), 0) / returns.length;
    const volatility = Math.sqrt(variance);

    const distanceFromEma = Math.abs(lastClose - lastEma) / lastEma;

    if (distanceFromEma < 0.01 && volatility < 0.02) {
      return MarketState.TRADING_RANGE;
    } else if (distanceFromEma > 0.03) {
      return MarketState.TRENDING;
    } else if (volatility > 0.03) {
      return MarketState.BREAKOUT;
    }
    return MarketState.PULLBACK;
  }

  // 获取关键位
  getKeyLevels(): KeyLevels {
    if (this.bars.length === 0) {
      return {
        ema20Daily: 0,
        ema2060min: 0,
        recentHigh20d: 0,
        recentLow20d: 0,
        support: 0,
        resistance: 0,
        ema20DailyFeishu: 0,
        ema20Divergence: '',
        ema20DailySource: '',
      };
    }

    const ema20 = this.calcEMA(20);
    const lastEma = ema20[ema20.length - 1];

    // 近20日高低点
    const recent20 = this.bars.slice(-20);
    const recentHigh = Math.max(...recent20.map((b) => b.high));
    const recentLow = Math.min(...recent20.map((b) => b.low));

    // 支撑阻力
    const lastClose = this.bars[this.bars.length - 1].close;
    const support =
      recent20.filter((b) => b.low < lastClose).reduce((min, b) => Math.min(min, b.low), Infinity) ||
      recentLow;
    const resistance =
      recent20.filter((b) => b.high > lastClose).reduce((max, b) => Math.max(max, b.high), 0) ||
      recentHigh;

    // 60min EMA
    let ema2060min = 0;
    if (this.bars60min && this.bars60min.length >= 20) {
      const ema60 = this.calcEMA(20, this.bars60min);
      ema2060min = ema60[ema60.length - 1];
    }

    return {
      ema20Daily: lastEma,
      ema2060min,
      recentHigh20d: recentHigh,
      recentLow20d: recentLow,
      support: support === Infinity ? recentLow : support,
      resistance: resistance || recentHigh,
      ema20DailyFeishu: 0,
      ema20Divergence: '',
      ema20DailySource: '',
    };
  }

  // V3.1: 计算ATR
  calcATR(period: number): number {
    if (this.bars.length < period + 1) return 0;

    let atrSum = 0;
    for (let i = this.bars.length - period; i < this.bars.length; i++) {
      const high = this.bars[i].high;
      const low = this.bars[i].low;
      const prevClose = this.bars[i - 1]?.close || this.bars[i].open;
      const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
      atrSum += tr;
    }
    return atrSum / period;
  }

  // V3.1: 计算Brooks评分（增强版）
  calcBrooksScore(direction: Direction): BrooksScore {
    const kl = this.getKeyLevels();
    const lastBar = this.bars[this.bars.length - 1];
    const lastClose = lastBar?.close || 0;

    // P0: 多周期共振 (30%)
    const aiDir = this.getAlwaysInDirection();
    const ai60 = this.getAlwaysIn60min();
    let p0 = 0;
    if (direction === Direction.LONG && aiDir === AlwaysInDirection.LONG) p0 = 30;
    else if (direction === Direction.SHORT && aiDir === AlwaysInDirection.SHORT) p0 = 30;
    else if (aiDir === AlwaysInDirection.NEUTRAL) p0 = 15;

    // 60min共振加分
    if (ai60) {
      const ai60Matches =
        (direction === Direction.LONG && ai60 === AlwaysInDirection.LONG) ||
        (direction === Direction.SHORT && ai60 === AlwaysInDirection.SHORT);
      if (ai60Matches) p0 = Math.min(p0 + 5, 30);
    }

    // P1: 趋势强度 (20%)
    let p1 = 0;
    if (kl.ema20Daily > 0) {
      const distance = (lastClose - kl.ema20Daily) / kl.ema20Daily;
      if (direction === Direction.LONG && distance > 0.02) p1 = 20;
      else if (direction === Direction.SHORT && distance < -0.02) p1 = 20;
      else if (direction === Direction.LONG && distance > 0) p1 = 12;
      else if (direction === Direction.SHORT && distance < 0) p1 = 12;
      else p1 = 5;
    }

    // P2: 信号K线 (15%)
    let p2 = 0;
    if (lastBar) {
      const bodySize = Math.abs(lastBar.close - lastBar.open);
      const totalRange = lastBar.high - lastBar.low;
      if (totalRange > 0) {
        const bodyRatio = bodySize / totalRange;
        const isBullish = lastBar.close > lastBar.open;
        if ((direction === Direction.LONG && isBullish) || (direction === Direction.SHORT && !isBullish)) {
          p2 = bodyRatio > 0.6 ? 15 : bodyRatio > 0.4 ? 10 : 5;
        } else {
          p2 = bodyRatio < 0.3 ? 5 : 0; // 反向K线小实体也给分（可能是十字星）
        }
      }
    }

    // P3: 关键位 (15%)
    let p3 = 0;
    if (kl.support > 0 && kl.resistance > 0) {
      const range = kl.resistance - kl.support;
      if (range > 0) {
        if (direction === Direction.LONG && lastClose < kl.support + range * 0.3) p3 = 15;
        else if (direction === Direction.SHORT && lastClose > kl.resistance - range * 0.3) p3 = 15;
        else p3 = 5;
      }
    }

    // P4: 量仓关系 (10%)
    let p4 = 5;
    if (this.bars.length >= 2) {
      const lastVol = lastBar?.volume || 0;
      const prevVol = this.bars[this.bars.length - 2]?.volume || 1;
      const volIncrease = lastVol > prevVol * 1.1;
      const isBullish = (lastBar?.close || 0) > (lastBar?.open || 0);
      if ((direction === Direction.LONG && isBullish && volIncrease) ||
          (direction === Direction.SHORT && !isBullish && volIncrease)) {
        p4 = 10;
      } else if (volIncrease && ((direction === Direction.LONG && !isBullish) || (direction === Direction.SHORT && isBullish))) {
        p4 = 0; // 放量反向
      }
    }

    // P5: 形态识别 (5%)
    let p5 = 2.5;
    if (this.bars.length >= 3) {
      const last3 = this.bars.slice(-3);
      const allBullish = last3.every((b) => b.close > b.open);
      const allBearish = last3.every((b) => b.close < b.open);
      if ((direction === Direction.LONG && allBullish) || (direction === Direction.SHORT && allBearish)) {
        p5 = 5;
      }
    }

    // P6: 超买超卖 (5%)
    let p6 = 2.5;
    if (kl.ema20Daily > 0) {
      const deviation = (lastClose - kl.ema20Daily) / kl.ema20Daily;
      if (direction === Direction.LONG && deviation < -0.05) p6 = 5; // 超卖做多
      else if (direction === Direction.SHORT && deviation > 0.05) p6 = 5; // 超买做空
      else if (direction === Direction.LONG && deviation > 0.05) p6 = 0; // 超买做多风险
      else if (direction === Direction.SHORT && deviation < -0.05) p6 = 0;
    }

    const rawTotal = p0 + p1 + p2 + p3 + p4 + p5 + p6;
    // 归一化到 -3 ~ +3
    const normalizedTotal = (rawTotal / 100) * 3;
    const total = direction === Direction.SHORT ? -normalizedTotal : normalizedTotal;
    const resonanceScore = (total / 3) * 5;

    // 校准警告
    const recalculatedTotal =
      p0 * 0.3 + p1 * 0.2 + p2 * 0.15 + p3 * 0.15 + p4 * 0.1 + p5 * 0.05 + p6 * 0.05;
    let calibrationWarning = '';
    if (Math.abs(recalculatedTotal - rawTotal / 100 * 3) > 0.5) {
      calibrationWarning = `Brooks评分校准提醒：P0-P6分项加权和(${recalculatedTotal.toFixed(1)})与总分(${total.toFixed(1)})差异较大`;
    }

    return {
      total,
      resonanceScore,
      p0MultiTf: p0,
      p1Trend: p1,
      p2SignalBar: p2,
      p3KeyLevels: p3,
      p4VolumeOi: p4,
      p5Patterns: p5,
      p6Extremes: p6,
      rawTotal: null,
      recalculatedTotal,
      alwaysInDaily: '',
      alwaysIn60min: '',
      alwaysInResonance: false,
      hasSignalBar: false,
      signalBarStatus: '',
      signalBarTimeframe: '',
      signalBarDetail: '',
      signalBarCount: 0,
      signalBarBodyRatio: 0,
      signalBarUpperShadowRatio: 0,
      signalBarLowerShadowRatio: 0,
      pullbackZoneLow: 0,
      pullbackZoneHigh: 0,
      pullbackBasis: '',
      brooksEntryPrice: 0,
      brooksStopLoss: 0,
      brooksRrRatio: 0,
      brooksTargetPrice: 0,
      calibrationWarning,
    };
  }

  // V3.1: 识别信号K线（增强版）
  identifySignalBar(direction: Direction): SignalBar | null {
    if (this.bars.length < 2) return null;

    const lastBar = this.bars[this.bars.length - 1];
    const prevBar = this.bars[this.bars.length - 2];
    const isBullish = lastBar.close > lastBar.open;
    const bodySize = Math.abs(lastBar.close - lastBar.open);
    const totalRange = lastBar.high - lastBar.low;

    if (totalRange === 0) return null;

    const upperShadow = lastBar.high - Math.max(lastBar.open, lastBar.close);
    const lowerShadow = Math.min(lastBar.open, lastBar.close) - lastBar.low;

    // 方向匹配
    const directionMatch =
      (direction === Direction.LONG && isBullish) ||
      (direction === Direction.SHORT && !isBullish);

    if (!directionMatch && bodySize / totalRange < 0.5) return null;

    // 吞没形态
    const prevBodySize = Math.abs(prevBar.close - prevBar.open);
    const prevBullish = prevBar.close > prevBar.open;
    const isEngulfing =
      (isBullish && !prevBullish && bodySize > prevBodySize && lastBar.close > prevBar.open && lastBar.open < prevBar.close) ||
      (!isBullish && prevBullish && bodySize > prevBodySize && lastBar.close < prevBar.open && lastBar.open > prevBar.close);

    // 孕线形态
    const isInside = bodySize < prevBodySize * 0.5 && lastBar.high < prevBar.high && lastBar.low > prevBar.low;

    // Follow-through
    let hasFollowThrough = false;
    if (this.bars.length >= 3) {
      const thirdLast = this.bars[this.bars.length - 3];
      if (isBullish) {
        hasFollowThrough = lastBar.close > thirdLast.high;
      } else {
        hasFollowThrough = lastBar.close < thirdLast.low;
      }
    }

    if (!directionMatch && !isEngulfing && !hasFollowThrough) return null;

    return {
      bar: lastBar,
      isBullish,
      bodySize,
      upperShadow,
      lowerShadow,
      isEngulfing,
      isInside,
      hasFollowThrough,
    };
  }

  // 计算止损
  calcStopLoss(signalBar: SignalBar, direction: Direction, entry: number): number {
    const range = signalBar.bar.high - signalBar.bar.low;
    if (direction === Direction.LONG) {
      return entry - range * 1.5;
    } else {
      return entry + range * 1.5;
    }
  }
}

// ============================================================
// 利润信号分析器 (V3.1)
// ============================================================

class ProfitSignalAnalyzer {
  private prices: Record<string, OHLCVBar[]>;

  constructor(prices: Record<string, OHLCVBar[]>) {
    this.prices = prices;
  }

  // 计算虚拟利润（简化版）
  calcVirtualProfit(variety: string): number[] | null {
    const bars = this.prices[variety];
    if (!bars || bars.length < 20) return null;

    const vp: number[] = [];
    for (let i = 1; i < bars.length; i++) {
      const change = bars[i].close - bars[i - 1].close;
      vp.push(change);
    }
    return vp;
  }

  // 计算Z-Score
  calcZScore(values: number[]): number {
    if (values.length === 0) return 0;
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const std = Math.sqrt(values.reduce((a, b) => Math.pow(b - mean, 2), 0) / values.length);
    if (std === 0) return 0;
    const lastValue = values[values.length - 1];
    return (lastValue - mean) / std;
  }

  // 生成利润信号
  generateSignal(variety: string): ProfitSignal {
    const vp = this.calcVirtualProfit(variety);
    const zScore = vp ? this.calcZScore(vp) : 0;

    // 基于基差和Z-Score判定信号
    let signalLevel: SignalLevel = SignalLevel.NONE;
    let signalDirection: Direction = Direction.NEUTRAL;

    if (zScore > 2) {
      signalLevel = SignalLevel.STRONG;
      signalDirection = Direction.LONG;
    } else if (zScore > 1) {
      signalLevel = SignalLevel.MEDIUM;
      signalDirection = Direction.LONG;
    } else if (zScore > 0.5) {
      signalLevel = SignalLevel.WEAK;
      signalDirection = Direction.LONG;
    } else if (zScore < -2) {
      signalLevel = SignalLevel.STRONG;
      signalDirection = Direction.SHORT;
    } else if (zScore < -1) {
      signalLevel = SignalLevel.MEDIUM;
      signalDirection = Direction.SHORT;
    } else if (zScore < -0.5) {
      signalLevel = SignalLevel.WEAK;
      signalDirection = Direction.SHORT;
    }

    // 映射共振分数
    let resonanceScore = 0;
    if (signalLevel === SignalLevel.STRONG) resonanceScore = 5;
    else if (signalLevel === SignalLevel.MEDIUM) resonanceScore = 3;
    else if (signalLevel === SignalLevel.WEAK) resonanceScore = 1;
    if (signalDirection === Direction.SHORT) resonanceScore = -resonanceScore;

    return {
      signalLevel,
      signalDirection,
      vp: vp ? vp[vp.length - 1] : 0,
      zScore,
      winRate: 0,
      sharpe: 0,
      sampleSize: vp ? vp.length : 0,
      resonanceScore,
      basisValue: null,
      basisRate: 0,
    };
  }
}

// ============================================================
// 决策引擎 (V3.1.2)
// ============================================================

class DecisionEngine {
  decide(
    variety: string,
    sd: SupplyDemandScore,
    profit: ProfitSignal,
    brooks: BrooksScore,
    directionHint: Direction,
    month: number | null = null,
    macroEvent: string | null = null,
    totalCapital: number = 200000
  ): TradeDecision {
    const decision: TradeDecision = {
      variety,
      action: Direction.WAIT,
      signalLevel: SignalLevel.NONE,
      positionPct: 0,
      entryPrice: 0,
      stopLoss: 0,
      targetPrice: 0,
      maxHoldDays: 0,
      reasons: [],
      warnings: [],
      supplyDemand: sd,
      profitSignal: profit,
      brooksScore: brooks,
      keyLevels: { ema20Daily: 0, ema2060min: 0, recentHigh20d: 0, recentLow20d: 0, support: 0, resistance: 0, ema20DailyFeishu: 0, ema20Divergence: '', ema20DailySource: '' },
      resonance: { sdScore: 0, profitScore: 0, brooksScore: 0, seasonalScore: 0, macroScore: 0, total: 0, negativeCount: 0 },
    };

    const config = VARIETY_CONFIG[variety] || {};

    // V3.1.1 贵金属/非农产品标注
    if (sd.isPreciousMetal) {
      decision.reasons.push(
        `贵金属保守化：评分上限±${sd.preciousMetalCap}，核心驱动=${sd.macroDominant ? '宏观/货币因素' : '供需+宏观混合'}`
      );
      if (variety === 'AG') {
        decision.warnings.push(
          '白银看黄金：AG无独立行情，走势完全跟随AU。请同步确认AU方向一致性后再操作，AU与AG方向不一致时不做白银。'
        );
      }
    }
    if (sd.supplyScoreCap !== null) {
      decision.reasons.push(`非农产品限幅：评分上限±${sd.supplyScoreCap}`);
    }

    // 第0步：宏观事件过滤
    const board = config.board || Board.BLACK;
    if (macroEvent) {
      const filterRules = MACRO_EVENT_FILTER[board] || {};
      if (filterRules[macroEvent]) {
        decision.action = Direction.WAIT;
        decision.warnings.push(`宏观事件[${macroEvent}]触发禁入规则：${filterRules[macroEvent]}`);
        return decision;
      }
    }

    // 第1步：共振矩阵判定
    const sdDir = sd.direction;
    const profitDir = profit.signalDirection;
    const brooksDir = brooks.total > 0 ? Direction.LONG : brooks.total < 0 ? Direction.SHORT : Direction.NEUTRAL;

    let matrixPass = false;
    let basePositionPct = 0;

    if (sdDir === Direction.SHORT) {
      if (profit.signalLevel === SignalLevel.STRONG && brooks.total <= -1) {
        matrixPass = true;
        basePositionPct = 0.5;
      } else if (profit.signalLevel === SignalLevel.MEDIUM && brooks.total <= -1) {
        matrixPass = true;
        basePositionPct = 0.3;
      } else if (profit.signalLevel === SignalLevel.WEAK && brooks.total <= -1) {
        matrixPass = true;
        basePositionPct = 0.1;
      } else if (profit.signalLevel === SignalLevel.NONE) {
        decision.warnings.push('供需偏空但无利润信号 → 观望');
      } else if (brooksDir === Direction.LONG) {
        decision.warnings.push('供需偏空但Brooks多头确认 → 时序错位（基本面领先，技术面滞后），暂不做空，列入做空观察清单等技术面确认');
      }
    } else if (sdDir === Direction.LONG) {
      if (profit.signalLevel === SignalLevel.STRONG || profit.signalLevel === SignalLevel.MEDIUM || profit.signalLevel === SignalLevel.WEAK) {
        if (brooks.total >= 1) {
          matrixPass = true;
          if (profit.signalLevel === SignalLevel.STRONG) basePositionPct = 0.5;
          else if (profit.signalLevel === SignalLevel.MEDIUM) basePositionPct = 0.3;
          else basePositionPct = 0.1;
        }
      } else if (profit.signalLevel === SignalLevel.NONE) {
        decision.warnings.push('供需偏多但无利润信号 → 观望');
      }
    } else if (sdDir === Direction.NEUTRAL) {
      if (profit.signalLevel === SignalLevel.STRONG && brooks.total !== 0) {
        matrixPass = true;
        basePositionPct = 0.25;
        decision.reasons.push('供需中性+★★★信号 → 允许入场，仓位减半');
      }
    }

    if (!matrixPass) {
      decision.action = Direction.WAIT;
      if (sdDir === Direction.LONG && brooksDir === Direction.SHORT) {
        decision.warnings.push('供需偏多但技术面偏空 → 时序错位，列入做多观察清单，等技术面确认');
      } else if (sdDir === Direction.SHORT && brooksDir === Direction.LONG) {
        decision.warnings.push('供需偏空但技术面偏多 → 时序错位，列入做空观察清单，等技术面确认');
      } else {
        decision.warnings.push('共振矩阵未通过 → 暂不交易，列入观察清单');
      }
      return decision;
    }

    // 第2步：共振评分
    // 供需面共振分数：根据评分映射到-5~+5
    const sdResonanceScore = Math.max(-5, Math.min(5, sd.score));
    const resonance: ResonanceResult = {
      sdScore: sdResonanceScore,
      profitScore: profit.resonanceScore,
      brooksScore: brooks.resonanceScore,
      seasonalScore: 0,
      macroScore: 0,
      total: 0,
      negativeCount: 0,
    };

    // 季节性评分
    if (month && SEASONAL_SCORES[variety]) {
      resonance.seasonalScore = SEASONAL_SCORES[variety][month] || 0;
    }

    resonance.total = resonance.sdScore + resonance.profitScore + resonance.brooksScore + resonance.seasonalScore + resonance.macroScore;
    resonance.negativeCount = [resonance.sdScore, resonance.profitScore, resonance.brooksScore, resonance.seasonalScore, resonance.macroScore].filter((s) => s < 0).length;
    decision.resonance = resonance;

    // V3.0 冲突处理
    if (resonance.total <= -2) {
      decision.action = Direction.WAIT;
      decision.warnings.push(`共振评分${resonance.total}≤-2 → 多维度时序错位，暂不交易，列入观察清单等待方向收敛`);
      return decision;
    }

    if (resonance.total === -1) {
      if (profit.signalLevel === SignalLevel.STRONG) {
        basePositionPct *= 0.5;
        decision.reasons.push('共振评分-1但★★★信号 → 仓位减半执行');
      } else {
        decision.action = Direction.WAIT;
        decision.warnings.push('共振评分-1且信号<★★★ → 暂不交易');
        return decision;
      }
    }

    // V3.1 安全阀
    if (resonance.negativeCount >= 3 && profit.signalLevel === SignalLevel.STRONG) {
      basePositionPct *= 0.25;
      decision.warnings.push(`安全阀触发：${resonance.negativeCount}个维度为负 → 仓位降至25%`);
    }

    // 仓位调整（V3.1.2 三档梯度）
    let positionMultiplier: number;
    if (resonance.total >= 4) positionMultiplier = 1.0;
    else if (resonance.total >= 2) positionMultiplier = 0.6;
    else positionMultiplier = 0.3;

    let finalPositionPct = basePositionPct * positionMultiplier;
    finalPositionPct = Math.min(finalPositionPct, 0.8);

    // 第3步：确定方向和仓位
    if (sdDir === Direction.SHORT) {
      decision.action = Direction.SHORT;
    } else if (sdDir === Direction.LONG) {
      decision.action = Direction.LONG;
    } else {
      decision.action = profit.signalDirection;
    }

    decision.positionPct = finalPositionPct;
    decision.signalLevel = profit.signalLevel;

    // Always In 方向汇总
    const aiStatus = brooks.alwaysInResonance ? '共振' : '错位';
    decision.reasons.push(`供需面：${sd.direction}（评分${sd.score}）`);
    decision.reasons.push(`利润信号：${profit.signalLevel} ${profit.signalDirection}`);
    decision.reasons.push(`Brooks总分：${brooks.total.toFixed(1)}（映射${brooks.resonanceScore.toFixed(1)}）`);

    if (brooks.calibrationWarning) {
      decision.warnings.push(brooks.calibrationWarning);
    }

    decision.reasons.push(`Always In：日线=${brooks.alwaysInDaily}, 60min=${brooks.alwaysIn60min}（${aiStatus}）`);

    // 信号K线汇总
    if (brooks.hasSignalBar) {
      decision.reasons.push(`信号K线：${brooks.signalBarStatus}（${brooks.signalBarTimeframe}）`);
      if (brooks.signalBarDetail) {
        decision.reasons.push(`  └ ${brooks.signalBarDetail}`);
      }
    } else {
      decision.reasons.push('信号K线：无（需等待信号K线确认）');
    }

    // 回调入场区间
    if (brooks.pullbackZoneLow > 0 || brooks.pullbackZoneHigh > 0) {
      decision.reasons.push(
        `回调入场区间：${brooks.pullbackZoneLow.toFixed(1)} ~ ${brooks.pullbackZoneHigh.toFixed(1)}（依据：${brooks.pullbackBasis}）`
      );
    }

    decision.reasons.push(`共振总分：${resonance.total.toFixed(1)}（${resonance.negativeCount}维负分）`);
    decision.reasons.push(`建议仓位：${(finalPositionPct * 100).toFixed(1)}%`);

    return decision;
  }
}

// ============================================================
// 主分析函数 (V3.1.2)
// ============================================================

export async function analyzeVariety(
  varietyCode: string,
  totalCapital: number = 200000
): Promise<TradeDecision> {
  const config = VARIETY_CONFIG[varietyCode];
  if (!config) {
    throw new Error(`未知品种: ${varietyCode}`);
  }

  // 1. 获取日线数据
  const dailyBars = await getDailyBars(varietyCode);
  if (dailyBars.length === 0) {
    throw new Error(`无${varietyCode}日线数据`);
  }

  // 2. 获取供需评分
  const supplyDemand = await getSupplyDemandScore(varietyCode, config);

  // 3. 技术分析
  const techAnalyzer = new TechnicalAnalyzer(dailyBars);
  const aiDir = techAnalyzer.getAlwaysInDirection();
  const ai60 = techAnalyzer.getAlwaysIn60min();
  const marketState = techAnalyzer.getMarketState();
  const keyLevels = techAnalyzer.getKeyLevels();

  // 确定分析方向
  let analysisDir: Direction = Direction.NEUTRAL;
  if (supplyDemand.direction !== Direction.NEUTRAL) {
    analysisDir = supplyDemand.direction;
  } else {
    const profitAnalyzer = new ProfitSignalAnalyzer({ [varietyCode]: dailyBars });
    const tempProfit = profitAnalyzer.generateSignal(varietyCode);
    if (tempProfit.signalDirection !== Direction.NEUTRAL) {
      analysisDir = tempProfit.signalDirection;
    } else {
      analysisDir = aiDir === AlwaysInDirection.LONG ? Direction.LONG : aiDir === AlwaysInDirection.SHORT ? Direction.SHORT : Direction.LONG;
    }
  }

  // 4. Brooks评分
  const brooksScore = techAnalyzer.calcBrooksScore(analysisDir);
  const sigBar = techAnalyzer.identifySignalBar(analysisDir);

  // V3.1.2: Always In方向写入brooks对象
  const isOscillating = marketState === MarketState.TRADING_RANGE;

  if (isOscillating && aiDir === AlwaysInDirection.NEUTRAL) {
    brooksScore.alwaysInDaily = '震荡（非AI空头）';
  } else {
    brooksScore.alwaysInDaily = aiDir;
  }

  if (ai60) {
    if (isOscillating && ai60 === AlwaysInDirection.NEUTRAL) {
      brooksScore.alwaysIn60min = '震荡（非AI空头）';
    } else {
      brooksScore.alwaysIn60min = ai60;
    }
    brooksScore.alwaysInResonance = aiDir === ai60 && aiDir !== AlwaysInDirection.NEUTRAL;
  } else {
    brooksScore.alwaysIn60min = '未知';
    brooksScore.alwaysInResonance = false;
  }

  // V3.1: 信号K线状态
  if (sigBar) {
    brooksScore.hasSignalBar = true;
    if (sigBar.isEngulfing) {
      brooksScore.signalBarStatus = sigBar.isBullish ? '看涨吞没' : '看跌吞没';
    } else if (sigBar.isInside) {
      brooksScore.signalBarStatus = '孕线';
    } else if (sigBar.upperShadow > sigBar.bodySize * 2) {
      brooksScore.signalBarStatus = !sigBar.isBullish ? '射击之星' : '上影线';
    } else if (sigBar.lowerShadow > sigBar.bodySize * 2) {
      brooksScore.signalBarStatus = sigBar.isBullish ? '锤子线' : '下影线';
    } else {
      brooksScore.signalBarStatus = sigBar.isBullish ? '阳线' : '阴线';
    }
    brooksScore.signalBarTimeframe = '日线';
    if (sigBar.hasFollowThrough) {
      brooksScore.signalBarStatus += ' +F/T确认';
    }

    const barRange = sigBar.bar.high - sigBar.bar.low;
    brooksScore.signalBarCount = 1;
    if (barRange > 0) {
      brooksScore.signalBarBodyRatio = sigBar.bodySize / barRange;
      brooksScore.signalBarUpperShadowRatio = sigBar.upperShadow / barRange;
      brooksScore.signalBarLowerShadowRatio = sigBar.lowerShadow / barRange;
    }
    brooksScore.signalBarDetail =
      `${brooksScore.signalBarStatus}：实体=${sigBar.bodySize.toFixed(1)}` +
      `(${(brooksScore.signalBarBodyRatio * 100).toFixed(0)}%)` +
      `，上影=${sigBar.upperShadow.toFixed(1)}` +
      `(${(brooksScore.signalBarUpperShadowRatio * 100).toFixed(0)}%)` +
      `，下影=${sigBar.lowerShadow.toFixed(1)}` +
      `(${(brooksScore.signalBarLowerShadowRatio * 100).toFixed(0)}%)`;
  }

  // V3.1: 回调入场区间
  const tickSize = config.tick || 1;
  const atrVal = techAnalyzer.calcATR(14);
  const lastClose = dailyBars[dailyBars.length - 1].close;

  if (dailyBars.length >= 20) {
    if (analysisDir === Direction.LONG) {
      if (sigBar) {
        brooksScore.pullbackZoneLow = sigBar.bar.low - tickSize;
        brooksScore.pullbackZoneHigh = sigBar.bar.low + tickSize;
        brooksScore.pullbackBasis = `信号K线低点${sigBar.bar.low.toFixed(1)}±1tick（Brooks标准）`;
        if (atrVal > 0) {
          brooksScore.brooksEntryPrice = sigBar.bar.low - tickSize;
          brooksScore.brooksStopLoss = sigBar.bar.low - atrVal;
          brooksScore.brooksRrRatio = 2.0;
          brooksScore.brooksTargetPrice = brooksScore.brooksEntryPrice + (brooksScore.brooksEntryPrice - brooksScore.brooksStopLoss) * brooksScore.brooksRrRatio;
        }
      } else {
        // 无信号K线时，使用当前收盘价作为入场价参考
        brooksScore.pullbackZoneLow = keyLevels.ema20Daily * 0.998;
        brooksScore.pullbackZoneHigh = keyLevels.ema20Daily * 1.002;
        brooksScore.pullbackBasis = 'EMA20(日线)±0.2%（无信号K线，退化方案）';
        brooksScore.brooksEntryPrice = lastClose;
        if (atrVal > 0) {
          brooksScore.brooksStopLoss = lastClose - atrVal;
          brooksScore.brooksRrRatio = 2.0;
          brooksScore.brooksTargetPrice = lastClose + atrVal * 2;
        }
      }
    } else if (analysisDir === Direction.SHORT) {
      if (sigBar) {
        brooksScore.pullbackZoneLow = sigBar.bar.high - tickSize;
        brooksScore.pullbackZoneHigh = sigBar.bar.high + tickSize;
        brooksScore.pullbackBasis = `信号K线高点${sigBar.bar.high.toFixed(1)}+1tick（Brooks标准）`;
        if (atrVal > 0) {
          brooksScore.brooksEntryPrice = sigBar.bar.high + tickSize;
          brooksScore.brooksStopLoss = sigBar.bar.high + atrVal;
          brooksScore.brooksRrRatio = 2.0;
          brooksScore.brooksTargetPrice = brooksScore.brooksEntryPrice - (brooksScore.brooksStopLoss - brooksScore.brooksEntryPrice) * brooksScore.brooksRrRatio;
        }
      } else {
        // 无信号K线时，使用当前收盘价作为入场价参考
        brooksScore.pullbackZoneLow = keyLevels.ema20Daily * 0.998;
        brooksScore.pullbackZoneHigh = keyLevels.ema20Daily * 1.002;
        brooksScore.pullbackBasis = 'EMA20(日线)±0.2%（无信号K线，退化方案）';
        brooksScore.brooksEntryPrice = lastClose;
        if (atrVal > 0) {
          brooksScore.brooksStopLoss = lastClose + atrVal;
          brooksScore.brooksRrRatio = 2.0;
          brooksScore.brooksTargetPrice = lastClose - atrVal * 2;
        }
      }
    }
  }

  // 5. 利润信号
  const profitAnalyzer = new ProfitSignalAnalyzer({ [varietyCode]: dailyBars });
  const profitSignal = profitAnalyzer.generateSignal(varietyCode);

  // 补充基差数据
  const spotData = await getSpotData(varietyCode);
  if (spotData) {
    profitSignal.basisValue = spotData.basisValue;
    profitSignal.basisRate = spotData.basisRate;
    // 如果有基差数据，用基差增强信号
    if (spotData.basisRate > 5) {
      profitSignal.signalLevel = SignalLevel.MEDIUM;
      profitSignal.signalDirection = Direction.LONG;
    } else if (spotData.basisRate > 2) {
      profitSignal.signalLevel = SignalLevel.WEAK;
      profitSignal.signalDirection = Direction.LONG;
    } else if (spotData.basisRate < -5) {
      profitSignal.signalLevel = SignalLevel.MEDIUM;
      profitSignal.signalDirection = Direction.SHORT;
    } else if (spotData.basisRate < -2) {
      profitSignal.signalLevel = SignalLevel.WEAK;
      profitSignal.signalDirection = Direction.SHORT;
    }
  }

  // 6. 决策引擎
  const engine = new DecisionEngine();
  const month = new Date().getMonth() + 1;
  const decision = engine.decide(
    varietyCode,
    supplyDemand,
    profitSignal,
    brooksScore,
    analysisDir,
    month,
    null,
    totalCapital
  );

  // 7. 仓位管理
  if (decision.action !== Direction.WAIT) {
    // 检查Always In方向与决策方向是否一致
    const aiDirectionMatches = 
      (decision.action === Direction.LONG && aiDir === AlwaysInDirection.LONG) ||
      (decision.action === Direction.SHORT && aiDir === AlwaysInDirection.SHORT);
    
    if (!aiDirectionMatches && aiDir !== AlwaysInDirection.NEUTRAL) {
      // Always In方向与决策方向不一致，添加警告
      const aiDirStr = aiDir === AlwaysInDirection.LONG ? 'AI多头' : 'AI空头';
      decision.warnings.push(`⚠️ Always In方向(${aiDirStr})与决策方向(${decision.action})不一致，建议谨慎`);
      // 降低仓位
      decision.positionPct = Math.min(decision.positionPct, 0.15);
    }
    
    const entry = dailyBars[dailyBars.length - 1].close;
    decision.entryPrice = entry;
    
    if (sigBar) {
      // 有信号K线时，使用Brooks方法计算止损
      if (brooksScore.brooksStopLoss > 0) {
        // 使用Brooks方法计算的止损距离，但基于当前入场价重新计算
        const brooksStopDistance = Math.abs(brooksScore.brooksEntryPrice - brooksScore.brooksStopLoss);
        if (decision.action === Direction.LONG) {
          decision.stopLoss = entry - brooksStopDistance;
        } else {
          decision.stopLoss = entry + brooksStopDistance;
        }
      } else {
        const stop = techAnalyzer.calcStopLoss(sigBar, decision.action, entry);
        decision.stopLoss = stop;
      }

      // 止损合理性检查：止损距离不能超过入场价的5%，且方向必须正确
      const stopDistance = Math.abs(decision.entryPrice - decision.stopLoss);
      const maxStopDistance = decision.entryPrice * 0.05; // 最大5%止损
      const isStopDirectionWrong = 
        (decision.action === Direction.LONG && decision.stopLoss > decision.entryPrice) ||
        (decision.action === Direction.SHORT && decision.stopLoss < decision.entryPrice);
      
      if (stopDistance > maxStopDistance || isStopDirectionWrong) {
        // 止损太远或方向错误，使用信号K线范围作为止损
        const barRange = Math.abs(sigBar.bar.high - sigBar.bar.low);
        const safeRange = Math.max(barRange, decision.entryPrice * 0.01); // 至少1%的范围
        if (decision.action === Direction.LONG) {
          decision.stopLoss = decision.entryPrice - safeRange * 1.5;
        } else {
          decision.stopLoss = decision.entryPrice + safeRange * 1.5;
        }
        decision.warnings.push(`止损已调整(原距离${(stopDistance / decision.entryPrice * 100).toFixed(1)}%)`);
      }

      // 计算手数（基于2%风险）
      const riskPerUnit = Math.abs(decision.entryPrice - decision.stopLoss);
      const maxRisk = totalCapital * 0.02;
      const multiplier = config.multiplier || 10;
      if (riskPerUnit > 0) {
        const maxLots = Math.floor(maxRisk / (riskPerUnit * multiplier));
        const positionValue = decision.entryPrice * multiplier * maxLots;
        const actualPct = positionValue / totalCapital;
        decision.positionPct = Math.min(actualPct, decision.positionPct);
      }
    } else {
      // 无信号K线时，使用ATR计算止损
      if (atrVal > 0) {
        if (decision.action === Direction.LONG) {
          decision.stopLoss = entry - atrVal;
        } else {
          decision.stopLoss = entry + atrVal;
        }
      }
      decision.warnings.push('无有效信号K线，止损基于ATR计算');
    }

    // 目标价 - 确保方向正确，基于实际止损距离计算
    // V3.1.2修复：使用实际止损距离计算目标价，确保盈亏比合理
    const actualStopDistance = Math.abs(decision.entryPrice - decision.stopLoss);
    
    if (decision.action === Direction.LONG) {
      // 做多：目标价必须高于入场价
      // 优先使用2倍止损距离作为目标，确保盈亏比至少1:2
      const targetFromStop = decision.entryPrice + actualStopDistance * 2;
      if (targetFromStop > decision.entryPrice) {
        decision.targetPrice = targetFromStop;
      } else if (keyLevels.recentHigh20d > decision.entryPrice) {
        decision.targetPrice = keyLevels.recentHigh20d;
      } else if (atrVal > 0) {
        // 兜底：入场价 + 2倍ATR
        decision.targetPrice = decision.entryPrice + atrVal * 2;
      } else {
        decision.targetPrice = decision.entryPrice * 1.05; // 5%涨幅
      }
    } else if (decision.action === Direction.SHORT) {
      // 做空：目标价必须低于入场价
      // 优先使用2倍止损距离作为目标，确保盈亏比至少1:2
      const targetFromStop = decision.entryPrice - actualStopDistance * 2;
      if (targetFromStop > 0 && targetFromStop < decision.entryPrice) {
        decision.targetPrice = targetFromStop;
      } else if (keyLevels.recentLow20d > 0 && keyLevels.recentLow20d < decision.entryPrice) {
        decision.targetPrice = keyLevels.recentLow20d;
      } else if (atrVal > 0) {
        // 兜底：入场价 - 2倍ATR
        decision.targetPrice = decision.entryPrice - atrVal * 2;
      } else {
        decision.targetPrice = decision.entryPrice * 0.95; // 5%跌幅
      }
    }

    decision.maxHoldDays = decision.action === Direction.SHORT ? 20 : 60;

    // 交易计划
    if (decision.entryPrice > 0) {
      let rrStr = '';
      if (decision.stopLoss > 0 && decision.targetPrice > 0) {
        const risk = Math.abs(decision.entryPrice - decision.stopLoss);
        const reward = Math.abs(decision.targetPrice - decision.entryPrice);
        if (risk > 0) {
          rrStr = `，风险回报比=1:${(reward / risk).toFixed(1)}`;
        }
      }
      decision.reasons.push(
        `交易计划：入场=${decision.entryPrice.toFixed(1)}，止损=${decision.stopLoss.toFixed(1)}，目标=${decision.targetPrice.toFixed(1)}${rrStr}`
      );
    }
  }

  // 补充详细数据
  decision.keyLevels = keyLevels;

  // 验证状态
  if (!VERIFIED_SIGNALS.has(varietyCode)) {
    decision.warnings.push('该品种尚未完成回测验证，信号仅供研究参考');
  }

  return decision;
}

// ============================================================
// 辅助函数
// ============================================================

async function getDailyBars(varietyCode: string): Promise<OHLCVBar[]> {
  // 优先使用实时数据（与扫描服务保持一致）
  try {
    const { getVarietyData } = await import('./dataFetcher.js');
    const realtimeData = await getVarietyData(varietyCode, 60);
    if (realtimeData && realtimeData.bars && realtimeData.bars.length >= 30) {
      return realtimeData.bars.map((bar: any) => ({
        date: bar.date,
        open: bar.o,
        high: bar.h,
        low: bar.l,
        close: bar.c,
        volume: bar.vol || 0,
        openInterest: bar.hold || 0,
      }));
    }
  } catch (error) {
    console.warn(`[varietyAnalyzer] 获取实时数据失败，使用数据库数据:`, error);
  }
  
  // 降级：使用数据库中的历史数据
  const rows = db.query(
    `SELECT trade_date, open_price, high_price, low_price, close_price, volume, open_interest
     FROM daily_quotes_history
     WHERE variety = ?
     ORDER BY trade_date DESC
     LIMIT 60`,
    [varietyCode]
  ) as any[];

  return rows.reverse().map((row: any) => ({
    date: row.trade_date,
    open: row.open_price,
    high: row.high_price,
    low: row.low_price,
    close: row.close_price,
    volume: row.volume || 0,
    openInterest: row.open_interest || 0,
  }));
}

async function getSupplyDemandScore(varietyCode: string, config: VarietyConfig): Promise<SupplyDemandScore> {
  const rows = db.query(
    `SELECT * FROM daily_fundamental_flow
     WHERE code = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [varietyCode]
  ) as any[];
  const row = rows[0];

  const defaultSd: SupplyDemandScore = {
    score: 0,
    direction: Direction.NEUTRAL,
    coreContradiction: '数据缺失',
    supplyGapRate: 0,
    inventoryPercentile: 50,
    confidence: DataQuality.C,
    isPreciousMetal: config.isPreciousMetal || false,
    preciousMetalCap: config.isPreciousMetal ? 1.5 : 0,
    macroDominant: config.isPreciousMetal || false,
    supplyScoreCap: null,
  };

  if (!row) return defaultSd;

  // 计算供需评分
  let score = 0;

  if (row.signal_s1 === '供需逆转') score += 2;
  else if (row.signal_s1 === '供需改善') score += 1;
  else if (row.signal_s1 === '供需恶化') score -= 1;
  else if (row.signal_s1 === '供需崩盘') score -= 2;

  if (row.inventory_percentile) {
    const invPct = parseFloat(row.inventory_percentile);
    if (invPct < 20) score += 1.5;
    else if (invPct > 80) score -= 1.5;
  }

  if (row.demand_condition === '需求旺盛') score += 1.5;
  else if (row.demand_condition === '需求疲弱') score -= 1.5;

  // 限制范围
  score = Math.max(-5, Math.min(5, score));

  // V3.1.1: 贵金属保守化
  if (config.isPreciousMetal) {
    defaultSd.isPreciousMetal = true;
    defaultSd.preciousMetalCap = 1.5;
    defaultSd.macroDominant = true;
    score = Math.max(-1.5, Math.min(1.5, score));
  }

  // V3.1.1: 非农产品限幅
  const isAgricultural = [Board.OIL_FAT, Board.CORN, Board.LIVESTOCK].includes(config.board as any);
  if (!config.isPreciousMetal && !isAgricultural) {
    defaultSd.supplyScoreCap = 3.0;
    score = Math.max(-3.0, Math.min(3.0, score));
  }

  let direction: Direction = Direction.NEUTRAL;
  if (score >= 2) direction = Direction.LONG;
  else if (score <= -2) direction = Direction.SHORT;

  return {
    score,
    direction,
    coreContradiction: row.signal_s1 || '未知',
    supplyGapRate: 0,
    inventoryPercentile: row.inventory_percentile ? parseFloat(row.inventory_percentile) : 50,
    confidence: DataQuality.B,
    isPreciousMetal: defaultSd.isPreciousMetal,
    preciousMetalCap: defaultSd.preciousMetalCap,
    macroDominant: defaultSd.macroDominant,
    supplyScoreCap: defaultSd.supplyScoreCap,
  };
}

async function getSpotData(varietyCode: string): Promise<{ basisValue: number; basisRate: number } | null> {
  const rows = db.query(
    `SELECT spot_price, futures_price, basis_rate
     FROM spot_price_history
     WHERE code = ?
     ORDER BY trade_date DESC
     LIMIT 1`,
    [varietyCode]
  ) as any[];
  const row = rows[0];

  if (!row || !row.basis_rate) return null;

  return {
    basisValue: parseFloat(row.basis_rate) || 0,
    basisRate: parseFloat(row.basis_rate) || 0,
  };
}

async function getProfitSignal(_varietyCode: string, _bars: OHLCVBar[]): Promise<ProfitSignal> {
  // 保留兼容，实际使用 ProfitSignalAnalyzer
  return {
    signalLevel: SignalLevel.NONE,
    signalDirection: Direction.NEUTRAL,
    vp: 0,
    zScore: 0,
    winRate: 0,
    sharpe: 0,
    sampleSize: 0,
    resonanceScore: 0,
    basisValue: null,
    basisRate: 0,
  };
}
