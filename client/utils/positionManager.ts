/**
 * 持仓管理 + 加仓/时间止损提醒引擎
 *
 * 数据流：用户登记持仓 → AsyncStorage 持久化 → 每次K线更新时运行 checkPositionAlerts
 * 提醒逻辑：三个加仓时机（回踩EMA20 / Channel回踩 / 突破二次确认）+ 三个时间止损条件
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { CandleBar } from '@/components/chart/CandlestickChart';
import { getMarketState } from './patternRecognition';

const POSITIONS_KEY = '@open_positions';

export interface OpenPosition {
  id: string;
  varietyCode: string;
  varietyName: string;
  direction: 'long' | 'short';
  entryPrice: number;
  entryTime: string;
  /** 入场时的K线索引（用于时间止损按bar计数） */
  entryBarIndex: number;
  stopLoss: number;
  targetPrice: number;
  lots: number;
  /** 交易模式：short=短线3bar / swing=波段5bar */
  mode: 'short' | 'swing';
  /** 最大浮盈（用于回吐判断），随行情更新 */
  maxFloatingPnl: number;
  /** 加仓次数 */
  addCount: number;
  /** 方程是否为正（登记时计算） */
  equationPositive: boolean;
  createdAt: string;
}

export interface PositionAlert {
  type: 'scale_in' | 'time_stop' | 'stop_hit' | 'target_hit' | 'forbidden';
  severity: 'info' | 'warning' | 'danger';
  title: string;
  message: string;
}

// ---------- 持久化 ----------

export async function loadPositions(): Promise<OpenPosition[]> {
  try {
    const raw = await AsyncStorage.getItem(POSITIONS_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function savePosition(pos: Omit<OpenPosition, 'id' | 'createdAt' | 'maxFloatingPnl' | 'addCount'>): Promise<OpenPosition> {
  const positions = await loadPositions();
  const newPos: OpenPosition = {
    ...pos,
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    maxFloatingPnl: 0,
    addCount: 0,
    createdAt: new Date().toISOString(),
  };
  positions.push(newPos);
  await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  return newPos;
}

export async function updatePosition(id: string, patch: Partial<OpenPosition>): Promise<void> {
  const positions = await loadPositions();
  const idx = positions.findIndex(p => p.id === id);
  if (idx >= 0) {
    positions[idx] = { ...positions[idx], ...patch };
    await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  }
}

export async function deletePosition(id: string): Promise<void> {
  const positions = await loadPositions();
  await AsyncStorage.setItem(POSITIONS_KEY, JSON.stringify(positions.filter(p => p.id !== id)));
}

// ---------- 提醒检查引擎 ----------

/** 计算EMA */
function ema(bars: CandleBar[], period: number, endIndex: number): number | null {
  const start = Math.max(0, endIndex - period * 3);
  const slice = bars.slice(start, endIndex + 1);
  if (slice.length < period) return null;
  const k = 2 / (period + 1);
  let e = slice.slice(0, period).reduce((s, b) => s + b.c, 0) / period;
  for (let i = period; i < slice.length; i++) {
    e = slice[i].c * k + e * (1 - k);
  }
  return e;
}

/**
 * 检查单个持仓的所有提醒
 * @param pos 持仓
 * @param bars 该品种最新K线（完整序列，当前最新在末尾）
 * @returns 提醒列表 + 需要更新的持仓字段
 */
export function checkPositionAlerts(
  pos: OpenPosition,
  bars: CandleBar[],
): { alerts: PositionAlert[]; posPatch: Partial<OpenPosition> } {
  const alerts: PositionAlert[] = [];
  const posPatch: Partial<OpenPosition> = {};
  if (bars.length < 25) return { alerts, posPatch };

  const curIdx = bars.length - 1;
  const cur = bars[curIdx];
  const isLong = pos.direction === 'long';

  // 当前浮动盈亏（点）
  const floatPnl = isLong ? cur.c - pos.entryPrice : pos.entryPrice - cur.c;

  // 更新最大浮盈
  const newMaxFloat = Math.max(pos.maxFloatingPnl, floatPnl);
  if (newMaxFloat !== pos.maxFloatingPnl) posPatch.maxFloatingPnl = newMaxFloat;

  // ===== 1. 价格止损/目标触发 =====
  const stopHit = isLong ? cur.l <= pos.stopLoss : cur.h >= pos.stopLoss;
  if (stopHit) {
    alerts.push({
      type: 'stop_hit', severity: 'danger',
      title: '价格止损触发',
      message: `最新价${isLong ? '最低' : '最高'}触及止损位 ${pos.stopLoss}，应无条件平仓。`,
    });
  }
  const targetHit = isLong ? cur.h >= pos.targetPrice : cur.l <= pos.targetPrice;
  if (targetHit) {
    alerts.push({
      type: 'target_hit', severity: 'info',
      title: '到达目标位',
      message: `价格到达目标 ${pos.targetPrice}，可考虑分批止盈。`,
    });
  }

  // ===== 2. 时间止损三条件 =====
  const barsHeld = curIdx - pos.entryBarIndex;
  const timeLimit = pos.mode === 'short' ? 3 : 5;

  if (barsHeld >= timeLimit && !stopHit) {
    const riskPoints = Math.abs(pos.entryPrice - pos.stopLoss);

    // 条件1：波动不足（持仓期间振幅 < 止损幅度的50%）
    const heldBars = bars.slice(pos.entryBarIndex, curIdx + 1);
    const periodHigh = Math.max(...heldBars.map(b => b.h));
    const periodLow = Math.min(...heldBars.map(b => b.l));
    const periodRange = periodHigh - periodLow;
    if (riskPoints > 0 && periodRange < riskPoints * 0.5) {
      alerts.push({
        type: 'time_stop', severity: 'warning',
        title: '时间止损：动能不足',
        message: `已持仓${barsHeld}根K线，期间振幅${periodRange.toFixed(1)}点 < 止损幅度50%(${(riskPoints * 0.5).toFixed(1)}点)。市场没有走出预期方向，应平仓。`,
      });
    }

    // 条件2：浮盈回吐超过50%（曾有过浮盈，现在回吐殆尽）
    if (newMaxFloat > 0 && floatPnl < newMaxFloat * 0.5) {
      alerts.push({
        type: 'time_stop', severity: 'warning',
        title: '时间止损：浮盈回吐',
        message: `最大浮盈${newMaxFloat.toFixed(1)}点已回吐至${floatPnl.toFixed(1)}点（回吐超50%）。动能消失，应平仓。`,
      });
    }

    // 条件3：市场状态切换（Always In 反向 或 EMA20走平进入区间）
    const ms = getMarketState(bars, curIdx);
    const aiFlipped = (isLong && ms.alwaysIn === 'short') || (!isLong && ms.alwaysIn === 'long');
    const msDesc = ms.description;
    const enteredRange = msDesc.includes('区间');
    if (aiFlipped) {
      alerts.push({
        type: 'time_stop', severity: 'danger',
        title: '时间止损：Always In 翻转',
        message: `Always In 已转为${ms.alwaysIn === 'long' ? '多头' : '空头'}，与你的${isLong ? '多' : '空'}单相反。趋势不再支持你，应平仓。`,
      });
    } else if (enteredRange) {
      alerts.push({
        type: 'time_stop', severity: 'warning',
        title: '时间止损：进入交易区间',
        message: `市场从趋势切换到区间震荡（EMA20走平）。趋势单在区间中没有优势，应平仓或减仓。`,
      });
    }
  }

  // ===== 3. 加仓时机检测（仅浮盈时 + 最多加1次） =====
  if (floatPnl > 0 && pos.addCount < 1 && !stopHit) {
    const ema20 = ema(bars, 20, curIdx);
    const prev = bars[curIdx - 1];

    if (ema20 && prev) {
      const nearEma = Math.abs(cur.c - ema20) / ema20 < 0.008; // 距EMA20在0.8%内
      const pulledToEma = isLong
        ? (prev.l <= ema20 * 1.003 || cur.l <= ema20 * 1.003)
        : (prev.h >= ema20 * 0.997 || cur.h >= ema20 * 0.997);

      // 信号棒：实体>影线的同向棒
      const body = Math.abs(cur.c - cur.o);
      const upperWick = cur.h - Math.max(cur.o, cur.c);
      const lowerWick = Math.min(cur.o, cur.c) - cur.l;
      const isSignalBar = isLong
        ? (cur.c > cur.o && body > upperWick)
        : (cur.c < cur.o && body > lowerWick);

      // 回调棒不能是大反向趋势棒
      const isBigCounterBar = isLong
        ? (prev.c < prev.o && (prev.o - prev.c) > body * 1.5)
        : (prev.c > prev.o && (prev.c - prev.o) > body * 1.5);

      if (pulledToEma && nearEma && isSignalBar && !isBigCounterBar) {
        alerts.push({
          type: 'scale_in', severity: 'info',
          title: '加仓时机：回踩EMA20确认',
          message: `价格浮盈${floatPnl.toFixed(1)}点，回踩EMA20(${ema20.toFixed(1)})后出现${isLong ? '多' : '空'}信号棒。可在下一根K线开盘加仓，独立止损放信号棒${isLong ? '低点' : '高点'}外侧。`,
        });
      }

      // 突破二次确认：回踩前高/前低（近似用最近20根极值）
      const lookback = bars.slice(Math.max(0, curIdx - 20), curIdx - 2);
      if (lookback.length > 5) {
        const breakoutLevel = isLong ? Math.max(...lookback.map(b => b.h)) : Math.min(...lookback.map(b => b.l));
        const nearBreakout = Math.abs(cur.c - breakoutLevel) / breakoutLevel < 0.005;
        const wasBreakout = isLong ? prev.c > breakoutLevel : prev.c < breakoutLevel;
        if (wasBreakout && nearBreakout && isSignalBar) {
          alerts.push({
            type: 'scale_in', severity: 'info',
            title: '加仓时机：突破二次确认',
            message: `价格突破关键位${breakoutLevel.toFixed(1)}后回踩确认，出现信号棒。阻力变支撑，可加仓，止损放信号棒外侧。`,
          });
        }
      }
    }
  }

  // ===== 4. 禁忌检测：浮亏加仓警告（如果用户在浮亏时想加仓） =====
  if (floatPnl < 0 && pos.addCount > 0) {
    alerts.push({
      type: 'forbidden', severity: 'danger',
      title: '禁忌：浮亏加仓',
      message: `当前浮亏${floatPnl.toFixed(1)}点且已加仓过。浮亏加仓是情绪交易，会加速亏损。`,
    });
  }

  return { alerts, posPatch };
}

/** 计算登记持仓时的方程与建议仓位 */
export function calcPositionSizing(params: {
  accountEquity: number;
  riskPct: number;
  entry: number;
  stop: number;
  pointValue: number;
}): { lots: number; perLotRisk: number; totalRisk: number } {
  const { accountEquity, riskPct, entry, stop, pointValue } = params;
  const maxRiskAmount = accountEquity * (riskPct / 100);
  const riskPoints = Math.abs(entry - stop);
  const perLotRisk = riskPoints * pointValue;
  if (perLotRisk <= 0) return { lots: 0, perLotRisk: 0, totalRisk: 0 };
  const lots = Math.floor(maxRiskAmount / perLotRisk);
  return { lots, perLotRisk: Math.round(perLotRisk), totalRisk: Math.round(maxRiskAmount) };
}
