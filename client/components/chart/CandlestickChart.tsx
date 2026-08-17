import React, { useMemo, useState, useRef, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Svg, {
  Line, Rect, Polyline, Polygon, Text as SvgText, G,
} from "react-native-svg";
import { FontAwesome6 } from "@expo/vector-icons";

export interface CandleBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
}

export interface TradeMarker {
  date: string;
  price: number;
  type: "long-open" | "long-close" | "short-open" | "short-close";
}

interface Props {
  bars: CandleBar[];
  visibleCount: number;
  width: number;
  height: number;
  interactive?: boolean;
  showEMA?: boolean;
  showVolume?: boolean;
  showOI?: boolean;
  selectedBar?: number | null;
  onBarPress?: (index: number, bar: CandleBar) => void;
  highlightBars?: number[];
  highlightColor?: string;
  priceLine?: number | null;
  priceLineColor?: string;
  trades?: TradeMarker[];
}

const COLOR_UP = "#FF4444";
const COLOR_DOWN = "#00CC66";
const COLOR_FLAT = "#888888";
const COLOR_EMA = "#FFD700";
const COLOR_GRID = "rgba(255,255,255,0.06)";
const COLOR_AXIS_TEXT = "#555570";
const COLOR_BG = "#0A0A0F";
const COLOR_VOL_UP = "rgba(255,68,68,0.5)";
const COLOR_VOL_DOWN = "rgba(0,204,102,0.5)";
const COLOR_OI = "#BF00FF";

function calcEMA(closes: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  const k = 2 / (period + 1);
  let ema = 0;
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(null);
    } else if (i === period - 1) {
      let sum = 0;
      for (let j = 0; j < period; j++) sum += closes[j];
      ema = sum / period;
      result.push(ema);
    } else {
      ema = closes[i] * k + ema * (1 - k);
      result.push(ema);
    }
  }
  return result;
}

export function CandlestickChart({
  bars,
  visibleCount,
  width,
  height,
  interactive = false,
  showEMA = true,
  showVolume = true,
  showOI = false,
  selectedBar = null,
  onBarPress,
  highlightBars = [],
  highlightColor = "#FFD700",
  priceLine = null,
  priceLineColor = "#00F0FF",
  trades = [],
}: Props) {
  const [viewStart, setViewStart] = useState(0);
  const [viewCountOverride, setViewCountOverride] = useState(0);

  const effectiveStart = interactive
    ? Math.min(viewStart, Math.max(0, bars.length - 15))
    : 0;
  const effectiveCount = interactive
    ? Math.min(viewCountOverride || 40, bars.length - effectiveStart)
    : Math.min(visibleCount, bars.length);
  const visibleBars = useMemo(
    () => bars.slice(effectiveStart, effectiveStart + effectiveCount),
    [bars, effectiveStart, effectiveCount],
  );

  const chartRatio = showVolume ? 0.65 : 1;
  const mainH = height * chartRatio;
  const subH = showVolume ? height * 0.3 : 0;
  const padding = { top: 10, right: 50, bottom: 20, left: 8 };
  const plotW = width - padding.left - padding.right;
  const plotH = mainH - padding.top - padding.bottom;

  const touchRef = useRef({
    startX: 0,
    startY: 0,
    startTime: 0,
    startViewStart: 0,
    startViewCount: 0,
    isDragging: false,
    isPinching: false,
    pinchDist: 0,
  });

  const { priceMin, priceMax, volMax, oiMax, emaValues, candleW } = useMemo(() => {
    if (visibleBars.length === 0) {
      return { priceMin: 0, priceMax: 1, volMax: 1, oiMax: 1, emaValues: [] as (number | null)[], candleW: 4 };
    }
    const highs = visibleBars.map((b) => b.h);
    const lows = visibleBars.map((b) => b.l);
    const vols = visibleBars.map((b) => b.vol);
    const holds = visibleBars.map((b) => b.hold);
    let pMin = Math.min(...lows);
    let pMax = Math.max(...highs);
    const pPad = (pMax - pMin) * 0.08 || pMax * 0.02;
    pMin -= pPad;
    pMax += pPad;
    const vMax = Math.max(...vols, 1);
    const oMax = Math.max(...holds, 1);
    const totalW = plotW / visibleBars.length;
    const cw = Math.max(2, totalW * 0.7);
    const closes = visibleBars.map((b) => b.c);
    const emaVals = calcEMA(closes, 20);
    return { priceMin: pMin, priceMax: pMax, volMax: vMax, oiMax: oMax, emaValues: emaVals, candleW: cw };
  }, [visibleBars, plotW]);

  const yScale = useCallback(
    (price: number) => {
      if (priceMax === priceMin) return padding.top + plotH / 2;
      return padding.top + plotH * (1 - (price - priceMin) / (priceMax - priceMin));
    },
    [priceMin, priceMax, plotH, padding.top],
  );

  const xCenter = useCallback(
    (i: number) => {
      const totalW = plotW / Math.max(visibleBars.length, 1);
      return padding.left + totalW * i + totalW / 2;
    },
    [plotW, visibleBars.length, padding.left],
  );

  // ── Touch handlers for pan/zoom ──
  const handleTouchStart = useCallback(
    (evt: any) => {
      if (!interactive) return;
      const touches = evt.nativeEvent.touches;
      if (touches.length === 1) {
        touchRef.current = {
          startX: touches[0].pageX,
          startY: touches[0].pageY,
          startTime: Date.now(),
          startViewStart: effectiveStart,
          startViewCount: effectiveCount,
          isDragging: false,
          isPinching: false,
          pinchDist: 0,
        };
      } else if (touches.length === 2) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        touchRef.current.isPinching = true;
        touchRef.current.isDragging = false;
        touchRef.current.pinchDist = Math.sqrt(dx * dx + dy * dy);
        touchRef.current.startViewCount = effectiveCount;
        touchRef.current.startViewStart = effectiveStart;
      }
    },
    [interactive, effectiveStart, effectiveCount],
  );

  const handleTouchMove = useCallback(
    (evt: any) => {
      if (!interactive) return;
      const touches = evt.nativeEvent.touches;
      const t = touchRef.current;

      if (touches.length === 1 && !t.isPinching) {
        const dx = touches[0].pageX - t.startX;
        if (!t.isDragging && Math.abs(dx) > 10) t.isDragging = true;
        if (t.isDragging) {
          const candleWidth = plotW / Math.max(effectiveCount, 1);
          const barsShifted = Math.round(-dx / Math.max(candleWidth, 1));
          const maxStart = Math.max(0, bars.length - effectiveCount);
          setViewStart(Math.max(0, Math.min(maxStart, t.startViewStart + barsShifted)));
        }
      } else if (touches.length === 2 && t.isPinching) {
        const dx = touches[0].pageX - touches[1].pageX;
        const dy = touches[0].pageY - touches[1].pageY;
        const newDist = Math.sqrt(dx * dx + dy * dy);
        if (t.pinchDist > 0) {
          const scale = t.pinchDist / newDist;
          const newCount = Math.round(t.startViewCount * scale);
          const clampedCount = Math.max(15, Math.min(bars.length, newCount));
          const maxStart = Math.max(0, bars.length - clampedCount);
          setViewCountOverride(clampedCount);
          setViewStart(Math.min(t.startViewStart, maxStart));
        }
      }
    },
    [interactive, bars.length, effectiveCount, plotW],
  );

  const handleTouchEnd = useCallback(() => {
    if (!interactive) return;
    touchRef.current.isDragging = false;
    touchRef.current.isPinching = false;
  }, [interactive]);

  const zoomIn = useCallback(() => {
    const newCount = Math.max(15, effectiveCount - 10);
    setViewCountOverride(newCount);
    const maxStart = Math.max(0, bars.length - newCount);
    if (viewStart > maxStart) setViewStart(maxStart);
  }, [effectiveCount, bars.length, viewStart]);

  const zoomOut = useCallback(() => {
    setViewCountOverride(Math.min(bars.length, effectiveCount + 10));
  }, [effectiveCount, bars.length]);

  const highlightSet = useMemo(() => new Set(highlightBars), [highlightBars]);

  const dateToIndex = useMemo(() => {
    const m = new Map<string, number>();
    visibleBars.forEach((bar, i) => m.set(bar.date, i));
    return m;
  }, [visibleBars]);

  const priceLabels = useMemo(() => {
    const labels: { y: number; text: string }[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const price = priceMin + (priceMax - priceMin) * (i / steps);
      labels.push({
        y: yScale(price),
        text: price >= 1000 ? Math.round(price).toString() : price.toFixed(1),
      });
    }
    return labels;
  }, [priceMin, priceMax, yScale]);

  const emaPointsStr = useMemo(() => {
    const pts: string[] = [];
    for (let i = 0; i < visibleBars.length; i++) {
      const val = emaValues[i];
      if (val != null) pts.push(`${xCenter(i)},${yScale(val)}`);
    }
    return pts.join(" ");
  }, [visibleBars, emaValues, xCenter, yScale]);

  if (visibleBars.length === 0) {
    return (
      <View style={{ width, height, backgroundColor: COLOR_BG, justifyContent: "center", alignItems: "center" }}>
        <Text style={{ color: COLOR_AXIS_TEXT, fontSize: 14 }}>暂无数据</Text>
      </View>
    );
  }

  return (
    <View
      style={{ width, height: mainH + subH }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* Zoom controls */}
      {interactive && (
        <View style={styles.zoomControls}>
          <TouchableOpacity onPress={zoomIn} style={styles.zoomBtn}>
            <FontAwesome6 name="magnifying-glass-plus" size={14} color="#00F0FF" />
          </TouchableOpacity>
          <TouchableOpacity onPress={zoomOut} style={styles.zoomBtn}>
            <FontAwesome6 name="magnifying-glass-minus" size={14} color="#00F0FF" />
          </TouchableOpacity>
          <Text style={styles.zoomText}>{effectiveCount}根</Text>
        </View>
      )}

      {/* Main chart */}
      <Svg width={width} height={mainH}>
        <Rect x={0} y={0} width={width} height={mainH} fill={COLOR_BG} />

        {/* Grid + price labels */}
        {priceLabels.map((label, i) => (
          <G key={`grid-${i}`}>
            <Line
              x1={padding.left} y1={label.y}
              x2={width - padding.right} y2={label.y}
              stroke={COLOR_GRID} strokeWidth={1}
            />
            <SvgText
              x={width - padding.right + 4} y={label.y + 4}
              fill={COLOR_AXIS_TEXT} fontSize={9}
            >
              {label.text}
            </SvgText>
          </G>
        ))}

        {/* Candles */}
        {visibleBars.map((bar, i) => {
          const cx = xCenter(i);
          const isUp = bar.c >= bar.o;
          const color = bar.c === bar.o ? COLOR_FLAT : isUp ? COLOR_UP : COLOR_DOWN;
          const bodyTop = yScale(Math.max(bar.o, bar.c));
          const bodyBot = yScale(Math.min(bar.o, bar.c));
          const bodyH = Math.max(bodyBot - bodyTop, 1);
          const wickTop = yScale(bar.h);
          const wickBot = yScale(bar.l);
          const globalIdx = effectiveStart + i;
          const isHL = highlightSet.has(globalIdx) || highlightSet.has(i);
          const isSel = selectedBar === i || selectedBar === globalIdx;

          return (
            <G
              key={`candle-${i}`}
              onPress={() => onBarPress?.(i, bar)}
              style={{ cursor: onBarPress ? "pointer" : "default" }}
            >
              {isHL && (
                <Rect
                  x={cx - candleW / 2 - 2} y={padding.top}
                  width={candleW + 4} height={plotH}
                  fill={highlightColor} opacity={0.12} rx={2}
                />
              )}
              {isSel && (
                <Rect
                  x={cx - candleW / 2 - 3} y={padding.top}
                  width={candleW + 6} height={plotH}
                  fill="#00F0FF" opacity={0.1} rx={2}
                />
              )}
              <Line x1={cx} y1={wickTop} x2={cx} y2={bodyTop} stroke={color} strokeWidth={1} />
              <Line x1={cx} y1={bodyBot} x2={cx} y2={wickBot} stroke={color} strokeWidth={1} />
              <Rect
                x={cx - candleW / 2} y={bodyTop}
                width={candleW} height={bodyH}
                fill={color} rx={0.5}
              />
            </G>
          );
        })}

        {/* EMA20 */}
        {showEMA && emaPointsStr.length > 1 && (
          <Polyline
            points={emaPointsStr}
            stroke={COLOR_EMA} strokeWidth={1.5} fill="none" opacity={0.8}
          />
        )}

        {/* Price line */}
        {priceLine != null && (
          <G>
            <Line
              x1={padding.left} y1={yScale(priceLine)}
              x2={width - padding.right} y2={yScale(priceLine)}
              stroke={priceLineColor} strokeWidth={1} strokeDasharray="4,3"
            />
            <SvgText
              x={width - padding.right + 4} y={yScale(priceLine) + 4}
              fill={priceLineColor} fontSize={9} fontWeight="bold"
            >
              {priceLine >= 1000 ? Math.round(priceLine).toString() : priceLine.toFixed(1)}
            </SvgText>
          </G>
        )}

        {/* Trade markers (simulated trades) */}
        {trades.length > 0 && (
          <G>
            {trades.map((t, idx) => {
              const barIdx = dateToIndex.get(t.date);
              if (barIdx == null) return null;
              const x = xCenter(barIdx);
              const y = yScale(t.price);
              const isLong = t.type.startsWith('long');
              const isOpen = t.type.endsWith('open');
              const color = isLong ? COLOR_UP : COLOR_DOWN;
              const dir = isLong ? -1 : 1;
              const tipY = y + dir * 11;
              const baseY = y + dir * 3;
              return (
                <G key={`trade-${idx}`}>
                  <Line
                    x1={padding.left} y1={y} x2={width - padding.right} y2={y}
                    stroke={color} strokeWidth={0.5} strokeDasharray="2,3" opacity={0.35}
                  />
                  <Polygon
                    points={`${x},${tipY} ${x - 5},${baseY} ${x + 5},${baseY}`}
                    fill={isOpen ? color : 'none'}
                    stroke={color} strokeWidth={1.2}
                  />
                </G>
              );
            })}
          </G>
        )}

        {/* Date labels */}
        {visibleBars.map((bar, i) => {
          if (visibleBars.length > 30 && i % 10 !== 0) return null;
          if (visibleBars.length <= 30 && i % 5 !== 0 && i !== visibleBars.length - 1) return null;
          return (
            <SvgText
              key={`date-${i}`}
              x={xCenter(i)} y={mainH - 4}
              fill={COLOR_AXIS_TEXT} fontSize={8} textAnchor="middle"
            >
              {bar.date.slice(5)}
            </SvgText>
          );
        })}
      </Svg>

      {/* Volume / OI sub-chart */}
      {showVolume && subH > 0 && (
        <Svg width={width} height={subH}>
          <Rect x={0} y={0} width={width} height={subH} fill={COLOR_BG} />
          <Line x1={0} y1={0} x2={width} y2={0} stroke={COLOR_GRID} strokeWidth={1} />
          {visibleBars.map((bar, i) => {
            const cx = xCenter(i);
            const isUp = bar.c >= bar.o;
            const barH = (bar.vol / volMax) * (subH - 16);
            return (
              <Rect
                key={`vol-${i}`}
                x={cx - candleW / 2}
                y={subH - 10 - barH}
                width={candleW}
                height={Math.max(barH, 1)}
                fill={isUp ? COLOR_VOL_UP : COLOR_VOL_DOWN}
                rx={0.5}
                onPress={() => onBarPress?.(i, bar)}
              />
            );
          })}
          {showOI && visibleBars.length > 1 && (
            <Polyline
              points={visibleBars
                .map((bar, i) => {
                  const oiH = (bar.hold / oiMax) * (subH - 16);
                  return `${xCenter(i)},${subH - 10 - oiH}`;
                })
                .join(" ")}
              stroke={COLOR_OI} strokeWidth={1} fill="none" opacity={0.6}
            />
          )}
          <SvgText x={padding.left + 2} y={12} fill={COLOR_AXIS_TEXT} fontSize={8}>VOL</SvgText>
          {showOI && (
            <SvgText x={padding.left + 28} y={12} fill={COLOR_OI} fontSize={8} opacity={0.6}>OI</SvgText>
          )}
        </Svg>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  zoomControls: {
    position: "absolute",
    top: 4,
    right: 54,
    zIndex: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  zoomBtn: {
    width: 28,
    height: 28,
    borderRadius: 6,
    backgroundColor: "rgba(0,240,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(0,240,255,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  zoomText: {
    color: "#555570",
    fontSize: 10,
    marginLeft: 2,
  },
});
