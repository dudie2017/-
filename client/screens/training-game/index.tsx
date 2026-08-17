import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Dimensions,
  ActivityIndicator, Alert, Modal,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { FontAwesome6 } from '@expo/vector-icons';
import { CandlestickChart, type CandleBar } from '@/components/chart/CandlestickChart';
import { fetchTrainingKline } from '@/utils/trainingApi';
import {
  loadTrainingData, saveTrainingData, updateLevelProgress,
  checkAchievements, saveTradeHistory, type TradeHistoryEntry,
} from '@/utils/trainingData';
import { hapticOpenPosition, hapticCloseProfit, hapticCloseLoss, hapticStopLoss, hapticBarAdvance } from '@/utils/haptics';
import { PulseEffect } from '@/components/effects/PulseEffect';
import { detectPatterns, getMarketState, type PatternMatch } from '@/utils/patternRecognition';
import { evaluateSignalBar } from '@/utils/signalBarScorer';

const { width: SW, height: SH } = Dimensions.get('window');
const CHART_W = SW;
const CHART_H = SH * 0.42;

import {
  calcTradersEquation, estimateProbability, checkTimeStop, findRecentSwing,
  type EquationResult,
} from '@/utils/tradersEquation';

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const GREEN = '#00FF88';
const RED = '#FF003C';
const AMBER = '#FFB800';
const GOLD = '#FFD700';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';
const BORDER = 'rgba(0,240,255,0.12)';

// 难度配置：不同难度有不同的数据量、分析深度和评分标准
function getDifficultyConfig(difficulty: number) {
  switch (difficulty) {
    case 1: // 入门
      return {
        barCount: 40,
        initialVisible: 15,
        showEMA: false,
        showVolume: false,
        showOI: false,
        analysisDepth: 'basic' as const,
        scoreMultiplier: 1.0,
        label: '入门',
      };
    case 2: // 进阶
      return {
        barCount: 50,
        initialVisible: 20,
        showEMA: true,
        showVolume: false,
        showOI: false,
        analysisDepth: 'intermediate' as const,
        scoreMultiplier: 1.2,
        label: '进阶',
      };
    case 3: // 高级
      return {
        barCount: 60,
        initialVisible: 20,
        showEMA: true,
        showVolume: true,
        showOI: false,
        analysisDepth: 'advanced' as const,
        scoreMultiplier: 1.5,
        label: '高级',
      };
    case 4: // 大师
      return {
        barCount: 60,
        initialVisible: 25,
        showEMA: true,
        showVolume: true,
        showOI: true,
        analysisDepth: 'master' as const,
        scoreMultiplier: 2.0,
        label: '大师',
      };
    default:
      return {
        barCount: 60,
        initialVisible: 20,
        showEMA: true,
        showVolume: true,
        showOI: true,
        analysisDepth: 'advanced' as const,
        scoreMultiplier: 1.5,
        label: '高级',
      };
  }
}

interface Position {
  direction: 'long' | 'short';
  entryPrice: number;
  entryBar: number;
  stopLoss: number;
  lots: number;
  targetPrice: number;
  equation: EquationResult;
}

interface ScoreBreakdown {
  direction: number;
  timing: number;
  stopLoss: number;
  management: number;
}

type GameState = 'loading' | 'ready' | 'playing' | 'finished';

// ============ Brooks 深度分析引擎 ============
function analyzeBarDeep(bars: CandleBar[], idx: number): string[] {
  const lines: string[] = [];
  if (idx < 1 || idx >= bars.length) return ['数据不足，等待更多K线。'];

  const bar = bars[idx];
  const prev = bars[idx - 1];
  const prev2 = idx >= 2 ? bars[idx - 2] : null;
  const range = bar.h - bar.l;
  const body = Math.abs(bar.c - bar.o);
  const bodyPct = range > 0 ? body / range : 0;
  const closePos = range > 0 ? (bar.c - bar.l) / range : 0.5;
  const isBull = bar.c > bar.o;
  const upperWick = bar.h - Math.max(bar.c, bar.o);
  const lowerWick = Math.min(bar.c, bar.o) - bar.l;

  // --- 1. 趋势背景 ---
  const emaPeriod = Math.min(20, idx);
  let ema = bars[0].c;
  const k = 2 / (emaPeriod + 1);
  for (let i = 1; i <= idx; i++) ema = bars[i].c * k + ema * (1 - k);
  const distToEma = bar.c - ema;
  const atrSum = range;
  let atr = atrSum;
  const atrCount = Math.min(14, idx);
  let atrTotal = 0;
  for (let i = idx - atrCount + 1; i <= idx; i++) {
    if (i >= 1) {
      const tr = Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
      atrTotal += tr;
    }
  }
  atr = atrCount > 0 ? atrTotal / atrCount : range;

  const trendDir = distToEma > atr * 0.5 ? '多头' : distToEma < -atr * 0.5 ? '空头' : '震荡';
  const trendStrength = Math.abs(distToEma) > atr * 2 ? '强势' : Math.abs(distToEma) > atr ? '中等' : '弱势';
  lines.push(`【趋势】${trendDir}趋势(${trendStrength})，价格${distToEma > 0 ? '高于' : '低于'}EMA20 ${Math.abs(distToEma).toFixed(1)}点`);

  // --- 2. K线质量 ---
  const quality = bodyPct > 0.7 ? '极强' : bodyPct > 0.5 ? '较强' : bodyPct > 0.3 ? '一般' : '弱';
  const closeDesc = closePos > 0.8 ? '收在顶部附近' : closePos > 0.6 ? '收在上半部' : closePos > 0.4 ? '收在中部' : closePos > 0.2 ? '收在下半部' : '收在底部附近';
  lines.push(`【K线】${isBull ? '阳线' : '阴线'}，实体占比${(bodyPct * 100).toFixed(0)}%(${quality})，${closeDesc}`);

  // --- 3. 形态识别 ---
  const prevBody = Math.abs(prev.c - prev.o);
  const prevIsBull = prev.c > prev.o;

  if (bodyPct < 0.08 && range > 0) {
    lines.push('【形态】十字星——多空力量均衡，在趋势末端出现时可能预示反转');
  } else if (isBull && !prevIsBull && body > prevBody * 1.5) {
    lines.push('【形态】看涨吞没——多头力量强势回归，可能开启反弹或反转');
  } else if (!isBull && prevIsBull && body > prevBody * 1.5) {
    lines.push('【形态】看跌吞没——空头力量强势介入，可能开启回落或反转');
  } else if (lowerWick > body * 2 && closePos > 0.5) {
    lines.push('【形态】锤头线——下影线远超实体，下方买盘强劲');
  } else if (upperWick > body * 2 && closePos < 0.5) {
    lines.push('【形态】射击之星——上影线远超实体，上方卖压沉重');
  } else if (isBull && prevIsBull && prev2 && prev2.c > prev2.o && bar.c > prev.c && prev.c > prev2.c) {
    lines.push('【形态】三连阳——连续阳线推动，但注意短线过热风险');
  } else if (!isBull && !prevIsBull && prev2 && prev2.c < prev2.o && bar.c < prev.c && prev.c < prev2.c) {
    lines.push('【形态】三连阴——连续阴线打压，但注意超卖反弹机会');
  }

  // --- 4. 量仓分析 ---
  if (bar.vol && prev.vol) {
    const volChange = prev.vol > 0 ? ((bar.vol - prev.vol) / prev.vol * 100) : 0;
    if (Math.abs(volChange) > 30) {
      lines.push(`【量能】成交量${volChange > 0 ? '放大' : '萎缩'}${Math.abs(volChange).toFixed(0)}%，${volChange > 0 ? '市场参与度高，走势可信度强' : '市场观望情绪浓，走势持续性存疑'}`);
    }
  }
  if (bar.hold != null && prev.hold != null && prev.hold > 0) {
    const oiChange = ((bar.hold - prev.hold) / prev.hold * 100);
    if (Math.abs(oiChange) > 2) {
      const oiDesc = oiChange > 0 ? '增仓' : '减仓';
      const oiMeaning = oiChange > 0
        ? (isBull ? '多头主动增仓，趋势可能延续' : '空头主动增仓，下跌可能延续')
        : (isBull ? '空头回补推动上涨，后续动能有限' : '多头止盈离场，下跌动能可能减弱');
      lines.push(`【持仓】${oiDesc}${Math.abs(oiChange).toFixed(1)}%，${oiMeaning}`);
    }
  }

  // --- 5. 关键位分析 ---
  const recentHighs: number[] = [];
  const recentLows: number[] = [];
  for (let i = Math.max(0, idx - 20); i < idx; i++) {
    recentHighs.push(bars[i].h);
    recentLows.push(bars[i].l);
  }
  const swingHigh = Math.max(...recentHighs);
  const swingLow = Math.min(...recentLows);
  const nearHigh = bar.h >= swingHigh * 0.998;
  const nearLow = bar.l <= swingLow * 1.002;
  if (nearHigh) lines.push(`【关键位】触及近期高点${swingHigh.toFixed(1)}附近，注意阻力反应`);
  if (nearLow) lines.push(`【关键位】触及近期低点${swingLow.toFixed(1)}附近，注意支撑反应`);

  // --- 6. 交易建议 ---
  if (trendDir === '多头' && bodyPct > 0.5 && closePos > 0.7 && distToEma < atr) {
    lines.push('【建议】多头信号棒+EMA20附近，可考虑做多，止损设在本棒低点下方');
  } else if (trendDir === '空头' && bodyPct > 0.5 && closePos < 0.3 && distToEma > -atr) {
    lines.push('【建议】空头信号棒+EMA20附近，可考虑做空，止损设在本棒高点上方');
  } else if (bodyPct < 0.2 && Math.abs(distToEma) < atr * 0.5) {
    lines.push('【建议】窄幅震荡+EMA20附近，市场方向不明，建议观望等待突破');
  } else if (Math.abs(distToEma) > atr * 3) {
    lines.push(`【建议】价格偏离EMA20过远(${(Math.abs(distToEma) / atr).toFixed(1)}倍ATR)，存在回归需求，不宜追单`);
  } else {
    lines.push('【建议】当前形态不够明确，等待更好的入场机会');
  }

  return lines;
}

export default function TrainingGameScreen() {
  const router = useSafeRouter();
  const params = useSafeSearchParams<{
    levelId: string; code: string; name: string;
    category: string; difficulty: number; windowStart: number;
  }>();

  const levelId = params.levelId || '';
  const code = params.code || 'RB0';
  const name = params.name || '';
  const category = params.category || '';
  const difficulty = params.difficulty || 1;
  const windowStart = typeof params.windowStart === 'number' ? params.windowStart : 0;
  console.log('[Training Game] params:', JSON.stringify(params));

  const [gameState, setGameState] = useState<GameState>('loading');
  const [bars, setBars] = useState<CandleBar[]>([]);
  const [position, setPosition] = useState<Position | null>(null);
  const [tradeCount, setTradeCount] = useState(0);
  const [correctCount, setCorrectCount] = useState(0);
  const [brooksLines, setBrooksLines] = useState<string[]>(['加载真实K线数据中...']);
  const [selectedBar, setSelectedBar] = useState<number | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [resultData, setResultData] = useState<{
    score: number; stars: number; totalReturn: number;
    trades: number; correct: number; breakdown: ScoreBreakdown;
    eqPositive: number; eqTotal: number;
  } | null>(null);

  // 脉冲效果状态
  const [pulseEffect, setPulseEffect] = useState<{
    visible: boolean;
    type: 'profit' | 'loss';
  }>({ visible: false, type: 'profit' });

  // 交易者方程反馈卡片（开仓时短暂展示）
  const [equationCard, setEquationCard] = useState<EquationResult | null>(null);
  const equationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 方程统计：正期望开仓次数 / 总开仓次数
  const [equationPositive, setEquationPositive] = useState(0);
  // 时间止损警告（持仓时每根K线检查）
  const [timeStopWarn, setTimeStopWarn] = useState<string | null>(null);
  // 记录持仓最大浮盈（用于浮盈回吐判断）
  const maxFloatPnlRef = useRef(0);

  // 根据难度获取配置
  const diffConfig = useMemo(() => getDifficultyConfig(difficulty), [difficulty]);
  const [visibleCount, setVisibleCount] = useState(diffConfig.initialVisible);

  // 加载真实K线数据
  useEffect(() => {
    (async () => {
      console.log('[Training Game] Loading kline data for:', code, 'windowStart:', windowStart);
      const data = await fetchTrainingKline(code, 120);
      console.log('[Training Game] fetchTrainingKline result:', data ? `${data.bars.length} bars` : 'null');
      if (!data || !data.bars || data.bars.length < 30) {
        console.error('[Training Game] Data loading failed:', data);
        Alert.alert('数据加载失败', '无法获取真实K线数据，请稍后重试');
        return;
      }
      // 根据难度和 windowStart 截取数据窗口
      const startIdx = Math.min(windowStart, Math.max(0, data.bars.length - diffConfig.barCount));
      const slicedBars = data.bars.slice(startIdx, startIdx + diffConfig.barCount);
      console.log('[Training Game] startIdx:', startIdx, 'diffConfig.barCount:', diffConfig.barCount, 'slicedBars.length:', slicedBars.length);
      const candleBars: CandleBar[] = slicedBars.map(b => ({
        date: b.date, o: b.o, h: b.h, l: b.l, c: b.c,
        vol: b.vol, hold: b.hold,
      }));
      console.log('[Training Game] Setting bars:', candleBars.length, 'gameState: ready');
      setBars(candleBars);
      setVisibleCount(diffConfig.initialVisible);
      setGameState('ready');
      setBrooksLines(['数据加载完成，点击「下一根」开始推演。观察K线形态，寻找交易机会。']);
    })();
  }, [code, windowStart, diffConfig.barCount, diffConfig.initialVisible]);

  // 卸载时清理方程卡片定时器
  useEffect(() => {
    return () => {
      if (equationTimerRef.current) clearTimeout(equationTimerRef.current);
    };
  }, []);

  const currentBar = visibleCount > 0 ? bars[visibleCount - 1] : null;
  const prevBar = visibleCount > 1 ? bars[visibleCount - 2] : null;

  const computedPnl = position && currentBar
    ? (position.direction === 'long'
        ? currentBar.c - position.entryPrice
        : position.entryPrice - currentBar.c) * position.lots
    : 0;

  // 评分细分
  const scoreBreakdown = useMemo((): ScoreBreakdown => {
    const dirScore = tradeCount > 0 ? Math.round((correctCount / tradeCount) * 30) : 0;
    const timingScore = Math.min(Math.max(Math.round(computedPnl / 10), 0), 25);
    const stopScore = position ? 20 : 15; // 有止损设置得分更高
    const mgmtScore = tradeCount > 0 ? Math.min(Math.round((correctCount / tradeCount) * 25), 25) : 0;
    return { direction: dirScore, timing: timingScore, stopLoss: stopScore, management: mgmtScore };
  }, [tradeCount, correctCount, computedPnl, position]);

  // 自动止损
  const handleAutoClose = useCallback((reason: string) => {
    if (!position) return;
    hapticStopLoss();
    setBrooksLines([`【止损】${reason}。止损是交易的一部分，关键是控制在可接受范围内。`, '回顾这次入场：是否信号不够强？止损位置是否合理？']);
    setPosition(null);
  }, [position]);

  // 结束游戏
  const finishGame = useCallback(async () => {
    const totalReturn = computedPnl + (correctCount / Math.max(tradeCount, 1)) * 50;
    const bd = scoreBreakdown;
    // 方程扣分：负期望开仓每次扣5分
    const eqPenalty = (tradeCount - equationPositive) * 5;
    const score = Math.max(bd.direction + bd.timing + bd.stopLoss + bd.management - eqPenalty, 0);
    const stars = score >= 80 ? 3 : score >= 60 ? 2 : score >= 40 ? 1 : 0;

    setResultData({
      score, stars,
      totalReturn: Math.round(totalReturn * 10) / 10,
      trades: tradeCount, correct: correctCount,
      breakdown: bd,
      eqPositive: equationPositive, eqTotal: tradeCount,
    });

    const data = await loadTrainingData();
    const updated = updateLevelProgress(data, levelId, code, category, difficulty, score, stars, totalReturn);
    updated.stats.totalReturn += totalReturn;
    updated.stats.winRate = tradeCount > 0
      ? (updated.stats.totalCorrect / Math.max(updated.stats.totalTrades, 1)) * 100
      : 0;
    updated.achievements = checkAchievements(updated);
    await saveTrainingData(updated);

    setShowResult(true);
    setGameState('finished');
  }, [computedPnl, correctCount, tradeCount, scoreBreakdown, equationPositive, levelId, code, category, difficulty]);

  // 下一根K线
  const advanceBar = useCallback(() => {
    if (visibleCount >= bars.length) {
      finishGame();
      return;
    }
    const newCount = visibleCount + 1;
    setVisibleCount(newCount);
    setGameState('playing');

    const newBar = bars[newCount - 1];

    // 自动止损检查
    if (position) {
      if (position.direction === 'long' && newBar.l <= position.stopLoss) {
        handleAutoClose(`多头止损触发 @ ${newBar.l.toFixed(1)}`);
        return;
      }
      if (position.direction === 'short' && newBar.h >= position.stopLoss) {
        handleAutoClose(`空头止损触发 @ ${newBar.h.toFixed(1)}`);
        return;
      }
    }

    const lines = analyzeBarDeep(bars, newCount - 1);

    // 形态识别
    const patterns = detectPatterns(bars, newCount - 1);
    if (patterns.length > 0) {
      const top = patterns[0];
      lines.push(`【形态】检测到${top.name}(${top.confidence}%置信度)：${top.description}`);
      lines.push(`【Brooks笔记】${top.brooksNote}`);
    }

    // 持仓时追加持仓分析
    if (position) {
      const pnlPts = position.direction === 'long'
        ? newBar.c - position.entryPrice
        : position.entryPrice - newBar.c;
      if (pnlPts > 0) {
        lines.push(`【持仓】浮盈${pnlPts.toFixed(1)}点，趋势延续中。可考虑将止损上移至保本位。`);
      } else {
        lines.push(`【持仓】浮亏${Math.abs(pnlPts).toFixed(1)}点，止损设在${position.stopLoss}。若触及需果断出场。`);
      }

      // 追踪最大浮盈
      if (pnlPts > maxFloatPnlRef.current) maxFloatPnlRef.current = pnlPts;

      // 时间止损检查
      const ms = getMarketState(bars, newCount - 1);
      const curAI = ms.alwaysIn === 'flat' ? null : ms.alwaysIn;
      const aiFlipped = !!(curAI && position.direction &&
        ((position.direction === 'long' && curAI === 'short') ||
         (position.direction === 'short' && curAI === 'long')));
      // 持仓期间最大振幅
      let maxRange = 0;
      for (let i = position.entryBar; i < newCount; i++) {
        const b = bars[i];
        if (!b) break;
        maxRange = Math.max(maxRange, b.h - b.l);
      }
      const ts = checkTimeStop({
        barsHeld: newCount - position.entryBar,
        mode: 'scalp',
        stopPoints: Math.abs(position.entryPrice - position.stopLoss),
        maxRange,
        maxProfit: maxFloatPnlRef.current,
        currentProfit: pnlPts,
        aiFlipped,
        ema20Flat: ms.state === 'range' && newCount - position.entryBar >= 3,
      });
      if (ts.triggered && ts.reason) {
        setTimeStopWarn(ts.reason);
        lines.push(`【时间止损】${ts.reason}，应考虑无条件平仓。`);
      } else {
        setTimeStopWarn(null);
      }
    } else {
      setTimeStopWarn(null);
    }
    setBrooksLines(lines);

    if (newCount >= bars.length) {
      setTimeout(() => finishGame(), 800);
    }
  }, [visibleCount, bars, position, finishGame, handleAutoClose]);

  // 做多
  const handleLong = useCallback(() => {
    if (!currentBar || position) return;
    const stopLoss = prevBar ? Math.min(prevBar.l, currentBar.l) * 0.998 : currentBar.l;
    const stop = Math.round(stopLoss * 100) / 100;
    const target = Math.round(findRecentSwing(bars, visibleCount - 1, 'long') * 100) / 100;

    // 交易者方程计算
    const signalScore = evaluateSignalBar(bars, visibleCount - 1, 'long');
    const ms = getMarketState(bars, visibleCount - 1);
    const { probability: prob } = estimateProbability({
      edgeGrade: signalScore.grade,
      aiDirection: ms.alwaysIn === 'flat' ? null : ms.alwaysIn.toUpperCase(),
      tradeDirection: 'long',
      spectrum: ms.description,
    });
    const equation = calcTradersEquation({
      direction: 'long', entry: currentBar.c, stop, target, probability: prob,
    });

    setPosition({
      direction: 'long',
      entryPrice: currentBar.c,
      entryBar: visibleCount - 1,
      stopLoss: stop,
      lots: 1,
      targetPrice: target,
      equation,
    });
    setTradeCount(c => c + 1);
    if (equation.isPositive) setEquationPositive(c => c + 1);
    maxFloatPnlRef.current = 0;
    setTimeStopWarn(null);
    hapticOpenPosition();

    // 方程反馈卡片（3秒自动消失）
    if (equationTimerRef.current) clearTimeout(equationTimerRef.current);
    setEquationCard(equation);
    equationTimerRef.current = setTimeout(() => setEquationCard(null), 3000);

    const lines = [
      `【做多入场】@${currentBar.c.toFixed(1)}，止损${stop.toFixed(1)}，目标${target.toFixed(1)}`,
      `【信号棒评分】${signalScore.total}分 (${signalScore.grade}级)`,
      ...signalScore.analysis.map(a => `· ${a}`),
      signalScore.grade === 'A' || signalScore.grade === 'B'
        ? '信号质量良好，继续持有。'
        : '信号质量一般，建议谨慎持有，严格执行止损。',
    ];
    setBrooksLines(lines);
  }, [currentBar, prevBar, position, visibleCount, bars]);

  // 做空
  const handleShort = useCallback(() => {
    if (!currentBar || position) return;
    const stopLoss = prevBar ? Math.max(prevBar.h, currentBar.h) * 1.002 : currentBar.h;
    const stop = Math.round(stopLoss * 100) / 100;
    const target = Math.round(findRecentSwing(bars, visibleCount - 1, 'short') * 100) / 100;

    // 交易者方程计算
    const signalScore = evaluateSignalBar(bars, visibleCount - 1, 'short');
    const ms = getMarketState(bars, visibleCount - 1);
    const { probability: prob } = estimateProbability({
      edgeGrade: signalScore.grade,
      aiDirection: ms.alwaysIn === 'flat' ? null : ms.alwaysIn.toUpperCase(),
      tradeDirection: 'short',
      spectrum: ms.description,
    });
    const equation = calcTradersEquation({
      direction: 'short', entry: currentBar.c, stop, target, probability: prob,
    });

    setPosition({
      direction: 'short',
      entryPrice: currentBar.c,
      entryBar: visibleCount - 1,
      stopLoss: stop,
      lots: 1,
      targetPrice: target,
      equation,
    });
    setTradeCount(c => c + 1);
    if (equation.isPositive) setEquationPositive(c => c + 1);
    maxFloatPnlRef.current = 0;
    setTimeStopWarn(null);
    hapticOpenPosition();

    // 方程反馈卡片（3秒自动消失）
    if (equationTimerRef.current) clearTimeout(equationTimerRef.current);
    setEquationCard(equation);
    equationTimerRef.current = setTimeout(() => setEquationCard(null), 3000);

    const lines = [
      `【做空入场】@${currentBar.c.toFixed(1)}，止损${stop.toFixed(1)}，目标${target.toFixed(1)}`,
      `【信号棒评分】${signalScore.total}分 (${signalScore.grade}级)`,
      ...signalScore.analysis.map(a => `· ${a}`),
      signalScore.grade === 'A' || signalScore.grade === 'B'
        ? '信号质量良好，继续持有。'
        : '信号质量一般，建议谨慎持有，严格执行止损。',
    ];
    setBrooksLines(lines);
  }, [currentBar, prevBar, position, visibleCount, bars]);

  // 观望
  const handleWait = useCallback(() => {
    if (position) return;
    hapticBarAdvance();
    setBrooksLines(['【观望】选择观望是合理的决策。耐心等待高概率信号出现，不要为了交易而交易。']);
    setCorrectCount(c => c + 1);
    setTradeCount(c => c + 1);
  }, [position]);

  // 平仓
  const handleClose = useCallback(() => {
    if (!position || !currentBar) return;
    const priceDiff = position.direction === 'long'
      ? currentBar.c - position.entryPrice
      : position.entryPrice - currentBar.c;
    const isProfit = priceDiff > 0;
    if (isProfit) {
      setCorrectCount(c => c + 1);
      hapticCloseProfit();
    } else {
      hapticCloseLoss();
    }
    // 触发脉冲效果
    setPulseEffect({ visible: true, type: isProfit ? 'profit' : 'loss' });

    // 记录交易历史（信号验证）
    const ms = getMarketState(bars, visibleCount - 1);
    const aligned = (position.direction === 'long' && ms.alwaysIn === 'long') ||
                    (position.direction === 'short' && ms.alwaysIn === 'short');
    const sigScore = evaluateSignalBar(bars, position.entryBar, position.direction);
    const tradeEntry: TradeHistoryEntry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      varietyCode: code,
      varietyName: name,
      direction: position.direction,
      entryPrice: position.entryPrice,
      exitPrice: currentBar.c,
      pnl: Math.round(priceDiff * 100) / 100,
      signalScore: sigScore.total,
      signalGrade: sigScore.grade,
      alwaysInAligned: aligned,
      timestamp: new Date().toISOString(),
    };
    saveTradeHistory(tradeEntry);

    setBrooksLines([
      isProfit
        ? `【平仓获利】+${priceDiff.toFixed(1)}点。${position.direction === 'long' ? '多头' : '空头'}交易成功！`
        : `【平仓亏损】${priceDiff.toFixed(1)}点。需要复盘：入场时机是否过早？信号是否足够强？`,
      isProfit
        ? '盈利的关键在于让利润奔跑，同时在趋势减弱时及时止盈。'
        : '亏损是交易的一部分。关键是每次亏损都在计划范围内，不伤及本金。',
      aligned ? '本次交易方向与Always In方向一致。' : '注意：本次交易方向与Always In方向相反，属于逆势交易。',
    ]);
    setPosition(null);
    setTimeStopWarn(null);
    setEquationCard(null);
    maxFloatPnlRef.current = 0;
  }, [position, currentBar, bars, visibleCount, code, name]);

  const stopLine = position ? position.stopLoss : null;
  const stopLineColor = position?.direction === 'long' ? RED : GREEN;

  // 进度百分比
  const progressPct = bars.length > 0 ? visibleCount / bars.length : 0;

  if (gameState === 'loading') {
    return (
      <Screen>
        <View style={{ flex: 1, backgroundColor: BG, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={CYAN} />
          <Text style={{ color: TEXT2, fontSize: 14, marginTop: 16 }}>加载真实K线数据...</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View style={{ flex: 1, backgroundColor: BG }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          paddingHorizontal: 16, paddingTop: 12, paddingBottom: 4,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <View>
              <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600' }}>
                {name} ({code})
              </Text>
              <Text style={{ color: TEXT2, fontSize: 11 }}>
                {category} · 难度{difficulty}
              </Text>
            </View>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {(() => {
              if (visibleCount < 10) return null;
              const ms = getMarketState(bars, visibleCount - 1);
              const stateColor = ms.state === 'trend_up' ? GREEN : ms.state === 'trend_down' ? RED : AMBER;
              const stateLabel = ms.state === 'trend_up' ? '上涨趋势' : ms.state === 'trend_down' ? '下跌趋势' : ms.state === 'range' ? '区间' : '转换中';
              return (
                <View style={{
                  paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                  backgroundColor: `${stateColor}15`, borderWidth: 1, borderColor: stateColor,
                }}>
                  <Text style={{ color: stateColor, fontSize: 10, fontWeight: '600' }}>{stateLabel}</Text>
                </View>
              );
            })()}
            {position && (
            <View style={{
              paddingHorizontal: 10, paddingVertical: 4,
              borderRadius: 6,
              backgroundColor: position.direction === 'long' ? 'rgba(255,68,68,0.15)' : 'rgba(0,204,102,0.15)',
              borderWidth: 1,
              borderColor: position.direction === 'long' ? RED : GREEN,
            }}>
              <Text style={{
                color: position.direction === 'long' ? RED : GREEN,
                fontSize: 12, fontWeight: '600',
              }}>
                {position.direction === 'long' ? '多' : '空'} {computedPnl >= 0 ? '+' : ''}{computedPnl.toFixed(0)}
              </Text>
            </View>
          )}
          </View>
        </View>

        {/* Progress Bar */}
        <View style={{ paddingHorizontal: 16, marginBottom: 4 }}>
          <View style={{
            flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2,
          }}>
            <Text style={{ color: TEXT2, fontSize: 10 }}>进度</Text>
            <Text style={{ color: CYAN, fontSize: 10 }}>{visibleCount}/{bars.length}</Text>
          </View>
          <View style={{
            height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2,
          }}>
            <View style={{
              height: 4, borderRadius: 2,
              width: `${Math.min(progressPct * 100, 100)}%`,
              backgroundColor: CYAN,
            }} />
          </View>
        </View>

        {/* Always In Direction Bar */}
        {visibleCount >= 10 && (() => {
          const ms = getMarketState(bars, visibleCount - 1);
          const aiColor = ms.alwaysIn === 'long' ? GREEN : ms.alwaysIn === 'short' ? RED : TEXT2;
          const aiLabel = ms.alwaysIn === 'long' ? 'ALWAYS IN 多' : ms.alwaysIn === 'short' ? 'ALWAYS IN 空' : 'ALWAYS IN 观望';
          return (
            <View style={{
              flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
              paddingHorizontal: 16, paddingVertical: 6,
              backgroundColor: `${aiColor}08`,
              borderBottomWidth: 1, borderBottomColor: `${aiColor}20`,
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <FontAwesome6
                  name={ms.alwaysIn === 'long' ? 'arrow-trend-up' : ms.alwaysIn === 'short' ? 'arrow-trend-down' : 'minus'}
                  size={10}
                  color={aiColor}
                />
                <Text style={{ color: aiColor, fontSize: 11, fontWeight: '700' }}>{aiLabel}</Text>
                <Text style={{ color: TEXT2, fontSize: 10 }}>强度{ms.strength}%</Text>
              </View>
              <Text style={{ color: TEXT2, fontSize: 9 }} numberOfLines={1}>
                {ms.description}
              </Text>
            </View>
          );
        })()}

        {/* K-Line Chart */}
        <View style={{ borderBottomWidth: 1, borderBottomColor: BORDER }}>
          {bars.length > 0 ? (
            <CandlestickChart
              key={`chart-${bars.length}-${visibleCount}`}
              bars={bars}
              visibleCount={visibleCount}
              width={CHART_W}
              height={CHART_H}
              showEMA={diffConfig.showEMA}
              showVolume={diffConfig.showVolume}
              showOI={diffConfig.showOI}
              selectedBar={selectedBar}
              onBarPress={(idx) => setSelectedBar(idx === selectedBar ? null : idx)}
              priceLine={stopLine}
              priceLineColor={stopLineColor}
            />
          ) : (
            <View style={{ width: CHART_W, height: CHART_H, backgroundColor: '#0A0A0F', justifyContent: 'center', alignItems: 'center' }}>
              <ActivityIndicator size="large" color={CYAN} />
              <Text style={{ color: TEXT2, fontSize: 12, marginTop: 8 }}>加载K线数据...</Text>
            </View>
          )}
        </View>

        {/* 交易者方程卡片（开仓后3秒自动消失） */}
        {equationCard && (
          <View style={{
            marginHorizontal: 16, marginTop: 8, borderRadius: 10, padding: 10,
            backgroundColor: equationCard.isPositive ? 'rgba(16,185,129,0.10)' : 'rgba(239,68,68,0.12)',
            borderWidth: 1,
            borderColor: equationCard.isPositive ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.5)',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <FontAwesome6 name={equationCard.isPositive ? 'circle-check' : 'triangle-exclamation'} size={12} color={equationCard.isPositive ? '#10B981' : '#EF4444'} />
                <Text style={{ color: equationCard.isPositive ? '#10B981' : '#EF4444', fontSize: 12, fontWeight: '700' }}>
                  交易者方程 {equationCard.isPositive ? '为正 ✓' : '为负 ✗'}
                </Text>
              </View>
              <Text style={{ color: TEXT2, fontSize: 10 }}>R:R {equationCard.rrRatio.toFixed(1)}:1</Text>
            </View>
            <Text style={{ color: TEXT1, fontSize: 11, marginTop: 4 }}>
              P×R = {equationCard.expectedWin.toFixed(1)}
              {' '}vs{' '}
              (1-P)×S = {equationCard.expectedLoss.toFixed(1)}
            </Text>
            {!equationCard.isPositive && (
              <Text style={{ color: '#EF4444', fontSize: 10, marginTop: 3 }}>
                方程为负，这笔交易数学上不划算，结算时将扣分
              </Text>
            )}
          </View>
        )}

        {/* 时间止损警告 */}
        {timeStopWarn && position && (
          <View style={{
            marginHorizontal: 16, marginTop: 8, borderRadius: 10, padding: 10,
            backgroundColor: 'rgba(245,158,11,0.12)',
            borderWidth: 1, borderColor: 'rgba(245,158,11,0.5)',
            flexDirection: 'row', alignItems: 'center', gap: 8,
          }}>
            <FontAwesome6 name="clock" size={12} color="#F59E0B" />
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#F59E0B', fontSize: 12, fontWeight: '700' }}>时间止损触发</Text>
              <Text style={{ color: TEXT1, fontSize: 11, marginTop: 2 }}>{timeStopWarn}，应无条件平仓</Text>
            </View>
          </View>
        )}

        {/* Selected bar info */}
        {selectedBar !== null && bars[selectedBar] && (
          <View style={{
            flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 6,
            backgroundColor: SURFACE, gap: 12,
          }}>
            <Text style={{ color: TEXT2, fontSize: 10 }}>{bars[selectedBar].date}</Text>
            <Text style={{ color: TEXT1, fontSize: 10 }}>
              O:{bars[selectedBar].o.toFixed(1)} H:{bars[selectedBar].h.toFixed(1)}
              L:{bars[selectedBar].l.toFixed(1)} C:{bars[selectedBar].c.toFixed(1)}
            </Text>
            <Text style={{ color: TEXT2, fontSize: 10 }}>
              Vol:{((bars[selectedBar].vol || 0) / 10000).toFixed(0)}万
            </Text>
          </View>
        )}

        {/* Brooks Deep Analysis */}
        <ScrollView style={{ flex: 1, marginTop: 8 }} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}>
          <View style={{
            padding: 12, backgroundColor: SURFACE, borderRadius: 10,
            borderWidth: 1, borderColor: 'rgba(0,240,255,0.15)',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <FontAwesome6 name="lightbulb" size={12} color={CYAN} style={{ marginRight: 6 }} />
              <Text style={{ color: CYAN, fontSize: 11, fontWeight: '600' }}>Brooks 深度解读</Text>
            </View>
            {brooksLines.map((line, i) => (
              <Text key={i} style={{
                color: line.startsWith('【建议】') ? AMBER : line.startsWith('【止损】') || line.startsWith('【平仓亏损】') ? RED : TEXT1,
                fontSize: 12, lineHeight: 20, marginBottom: 4,
              }}>
                {line}
              </Text>
            ))}
          </View>

          {/* Stats Row */}
          <View style={{
            flexDirection: 'row', marginTop: 10, gap: 8,
          }}>
            <View style={{ flex: 1, padding: 8, backgroundColor: SURFACE, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: CYAN, fontSize: 16, fontWeight: '700' }}>{tradeCount}</Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>交易</Text>
            </View>
            <View style={{ flex: 1, padding: 8, backgroundColor: SURFACE, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: GREEN, fontSize: 16, fontWeight: '700' }}>{correctCount}</Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>正确</Text>
            </View>
            <View style={{ flex: 1, padding: 8, backgroundColor: SURFACE, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: AMBER, fontSize: 16, fontWeight: '700' }}>
                {tradeCount > 0 ? Math.round(correctCount / tradeCount * 100) : 0}%
              </Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>准确率</Text>
            </View>
            <View style={{ flex: 1, padding: 8, backgroundColor: SURFACE, borderRadius: 8, alignItems: 'center' }}>
              <Text style={{ color: CYAN, fontSize: 16, fontWeight: '700' }}>
                {bars.length - visibleCount}
              </Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>剩余</Text>
            </View>
          </View>
        </ScrollView>

        {/* Action Buttons */}
        <View style={{
          flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 12, gap: 8,
          borderTopWidth: 1, borderTopColor: BORDER,
        }}>
          {!position ? (
            <>
              <TouchableOpacity
                onPress={handleLong}
                disabled={gameState !== 'ready' && gameState !== 'playing'}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: 'rgba(255,68,68,0.15)',
                  borderWidth: 1, borderColor: RED,
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name="arrow-trend-up" size={16} color={RED} style={{ marginBottom: 4 }} />
                <Text style={{ color: RED, fontSize: 14, fontWeight: '600' }}>做多</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleShort}
                disabled={gameState !== 'ready' && gameState !== 'playing'}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: 'rgba(0,204,102,0.15)',
                  borderWidth: 1, borderColor: GREEN,
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name="arrow-trend-down" size={16} color={GREEN} style={{ marginBottom: 4 }} />
                <Text style={{ color: GREEN, fontSize: 14, fontWeight: '600' }}>做空</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={handleWait}
                style={{
                  flex: 1, paddingVertical: 14, borderRadius: 10,
                  backgroundColor: 'rgba(255,184,0,0.1)',
                  borderWidth: 1, borderColor: AMBER,
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name="eye" size={16} color={AMBER} style={{ marginBottom: 4 }} />
                <Text style={{ color: AMBER, fontSize: 14, fontWeight: '600' }}>观望</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity
              onPress={handleClose}
              style={{
                flex: 1, paddingVertical: 14, borderRadius: 10,
                backgroundColor: 'rgba(255,255,255,0.08)',
                borderWidth: 1, borderColor: TEXT2,
                alignItems: 'center',
              }}
            >
              <FontAwesome6 name="hand" size={16} color={TEXT1} style={{ marginBottom: 4 }} />
              <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '600' }}>平仓</Text>
            </TouchableOpacity>
          )}

          <TouchableOpacity
            onPress={advanceBar}
            disabled={visibleCount >= bars.length}
            style={{
              width: 60, paddingVertical: 14, borderRadius: 10,
              backgroundColor: visibleCount >= bars.length ? 'rgba(255,255,255,0.03)' : 'rgba(0,240,255,0.12)',
              borderWidth: 1, borderColor: visibleCount >= bars.length ? BORDER : CYAN,
              alignItems: 'center', justifyContent: 'center',
            }}
          >
            <FontAwesome6
              name="forward-step"
              size={18}
              color={visibleCount >= bars.length ? TEXT2 : CYAN}
            />
            <Text style={{
              color: visibleCount >= bars.length ? TEXT2 : CYAN,
              fontSize: 9, marginTop: 2,
            }}>
              下一根
            </Text>
          </TouchableOpacity>
        </View>

        {/* Result Modal */}
        <Modal visible={showResult} transparent animationType="slide">
          <View style={{
            flex: 1, backgroundColor: 'rgba(0,0,0,0.8)',
            justifyContent: 'center', alignItems: 'center',
          }}>
            <View style={{
              width: SW - 48, padding: 24, maxHeight: SH * 0.8,
              backgroundColor: SURFACE, borderRadius: 16,
              borderWidth: 1, borderColor: BORDER,
            }}>
              <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700', textAlign: 'center', marginBottom: 16 }}>
                关卡完成
              </Text>

              {/* Stars */}
              <View style={{ flexDirection: 'row', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
                {[1, 2, 3].map(s => (
                  <FontAwesome6
                    key={s}
                    name="star"
                    size={28}
                    color={s <= (resultData?.stars || 0) ? GOLD : 'rgba(255,255,255,0.1)'}
                  />
                ))}
              </View>

              {/* Score Breakdown */}
              <View style={{ gap: 10, marginBottom: 16 }}>
                <Text style={{ color: TEXT2, fontSize: 12, marginBottom: 4 }}>评分细分</Text>
                {resultData && [
                  { label: '方向判断', value: resultData.breakdown.direction, max: 30, color: CYAN },
                  { label: '入场时机', value: resultData.breakdown.timing, max: 25, color: GREEN },
                  { label: '止损设置', value: resultData.breakdown.stopLoss, max: 20, color: AMBER },
                  { label: '持仓管理', value: resultData.breakdown.management, max: 25, color: '#BF00FF' },
                ].map(item => (
                  <View key={item.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: TEXT2, fontSize: 11, width: 60 }}>{item.label}</Text>
                    <View style={{ flex: 1, height: 6, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>
                      <View style={{
                        height: 6, borderRadius: 3,
                        width: `${Math.min((item.value / item.max) * 100, 100)}%`,
                        backgroundColor: item.color,
                      }} />
                    </View>
                    <Text style={{ color: item.color, fontSize: 11, fontWeight: '600', width: 30, textAlign: 'right' }}>
                      {item.value}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Stats */}
              <View style={{ gap: 8, marginBottom: 20 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: TEXT2, fontSize: 14 }}>总得分</Text>
                  <Text style={{ color: CYAN, fontSize: 16, fontWeight: '700' }}>{resultData?.score || 0}</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: TEXT2, fontSize: 14 }}>收益率</Text>
                  <Text style={{ color: (resultData?.totalReturn || 0) >= 0 ? GREEN : RED, fontSize: 14, fontWeight: '600' }}>
                    {(resultData?.totalReturn || 0).toFixed(1)}%
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: TEXT2, fontSize: 14 }}>交易次数</Text>
                  <Text style={{ color: TEXT1, fontSize: 14 }}>{resultData?.trades || 0}</Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ color: TEXT2, fontSize: 14 }}>正确决策</Text>
                  <Text style={{ color: GREEN, fontSize: 14 }}>{resultData?.correct || 0}</Text>
                </View>
                {resultData?.eqTotal ? (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ color: TEXT2, fontSize: 14 }}>方程遵守率</Text>
                    <Text style={{
                      color: (resultData.eqPositive / resultData.eqTotal) >= 0.7 ? GREEN : AMBER,
                      fontSize: 14, fontWeight: '600',
                    }}>
                      {resultData.eqPositive}/{resultData.eqTotal}
                      <Text style={{ color: TEXT2, fontSize: 11 }}>
                        {' '}({Math.round((resultData.eqPositive / resultData.eqTotal) * 100)}%)
                      </Text>
                    </Text>
                  </View>
                ) : null}
              </View>

              <TouchableOpacity
                onPress={() => { setShowResult(false); router.back(); }}
                style={{
                  paddingVertical: 14, borderRadius: 10,
                  backgroundColor: 'rgba(0,240,255,0.15)',
                  borderWidth: 1, borderColor: CYAN,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: CYAN, fontSize: 16, fontWeight: '600' }}>返回关卡列表</Text>
              </TouchableOpacity>
            </View>
          </View>
        </Modal>

        {/* 脉冲效果 */}
        <PulseEffect
          visible={pulseEffect.visible}
          type={pulseEffect.type}
          onComplete={() => setPulseEffect(prev => ({ ...prev, visible: false }))}
        />
      </View>
    </Screen>
  );
}
