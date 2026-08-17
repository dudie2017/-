import type { BarData } from './varieties.js';
import { detectMainContract } from './dataFetcher.js';

/**
 * 多周期回测引擎
 * 支持 1min/5min/15min/30min/60min/daily 六个周期
 * 
 * 索普-西蒙斯方案：不同周期下验证Brooks维度的有效性
 */

export type TimeframePeriod = '1m' | '5m' | '15m' | '30m' | '60m' | 'daily';

export interface TimeframeBacktestResult {
  period: TimeframePeriod;
  label: string;
  barsAvailable: number;
  tradingDaysCovered: number;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgProfit: number;
  avgLoss: number;
  profitFactor: number;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  avgHoldingBars: number;
  signals: Array<{
    index: number;
    date: string;
    direction: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    isWin: boolean;
    holdingBars: number;
  }>;
}

export interface MultiTimeframeResult {
  code: string;
  name: string;
  timeframes: TimeframeBacktestResult[];
  bestPeriod: TimeframePeriod | null;
  worstPeriod: TimeframePeriod | null;
  conclusion: string;
}

// 获取分钟K线数据
async function fetchMinuteBars(contractCode: string, type: number): Promise<BarData[] | null> {
  try {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${contractCode}=/InnerFuturesNewService.getFewMinLine?symbol=${contractCode}&type=${type}`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await resp.text();
    const jsonMatch = text.match(/\=\((\[.*\])\)/);
    if (!jsonMatch) return null;
    const rawData = JSON.parse(jsonMatch[1]) as Array<Record<string, string>>;
    if (!rawData || rawData.length < 30) return null;
    const bars: BarData[] = rawData.map((item) => ({
      date: item.d || '',
      o: parseFloat(item.o) || 0,
      h: parseFloat(item.h) || 0,
      l: parseFloat(item.l) || 0,
      c: parseFloat(item.c) || 0,
      vol: parseFloat(item.v) || 0,
      hold: parseFloat(item.p) || 0,
      settle: 0,
    }));
    return bars.filter((b) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0);
  } catch {
    return null;
  }
}

// 获取日线数据
async function fetchDailyBars(symbol: string, n = 250): Promise<BarData[] | null> {
  try {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${symbol}=/InnerFuturesNewService.getDailyKLine?symbol=${symbol}`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();
    const jsonMatch = text.match(/\=\((\[.*\])\)/);
    if (!jsonMatch) return null;
    const rawData = JSON.parse(jsonMatch[1]) as Array<Record<string, string>>;
    if (!rawData || rawData.length < 30) return null;
    const bars: BarData[] = rawData.slice(-n).map((item) => ({
      date: item.d || '',
      o: parseFloat(item.o) || 0,
      h: parseFloat(item.h) || 0,
      l: parseFloat(item.l) || 0,
      c: parseFloat(item.c) || 0,
      vol: parseFloat(item.v) || 0,
      hold: parseFloat(item.p) || 0,
      settle: parseFloat(item.s) || 0,
    }));
    return bars.filter((b) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0);
  } catch {
    return null;
  }
}

// 获取指定周期数据
async function fetchBarsForTimeframe(contractCode: string, period: TimeframePeriod): Promise<BarData[] | null> {
  switch (period) {
    case '1m': return fetchMinuteBars(contractCode, 1);
    case '5m': return fetchMinuteBars(contractCode, 5);
    case '15m': return fetchMinuteBars(contractCode, 15);
    case '30m': return fetchMinuteBars(contractCode, 30);
    case '60m': return fetchMinuteBars(contractCode, 60);
    case 'daily': return fetchDailyBars(contractCode, 250);
  }
}

// 估算覆盖交易天数
function estimateTradingDays(period: TimeframePeriod, barCount: number): number {
  const barsPerDay: Record<TimeframePeriod, number> = {
    '1m': 1260, '5m': 252, '15m': 84, '30m': 42, '60m': 21, 'daily': 1,
  };
  return Math.round((barCount / barsPerDay[period]) * 10) / 10;
}

// 计算EMA
function calcEMA(data: number[], period: number): number[] {
  const result: number[] = [data[0]];
  const k = 2 / (period + 1);
  for (let i = 1; i < data.length; i++) {
    result[i] = data[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

// 计算ATR
function calcATR(bars: BarData[], period: number): number[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[i].h - bars[i].l);
    } else {
      tr.push(Math.max(
        bars[i].h - bars[i].l,
        Math.abs(bars[i].h - bars[i - 1].c),
        Math.abs(bars[i].l - bars[i - 1].c)
      ));
    }
  }
  const atr: number[] = [tr[0]];
  for (let i = 1; i < tr.length; i++) {
    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  }
  return atr;
}

// 单周期回测
function backtestTimeframe(bars: BarData[], period: TimeframePeriod, maxTrades: number = 100): TimeframeBacktestResult {
  const closes = bars.map((b) => b.c);
  const ema20 = calcEMA(closes, 20);
  const atr = calcATR(bars, 14);

  const periodConfig: Record<TimeframePeriod, { atrMult: number; minBars: number; label: string }> = {
    '1m': { atrMult: 2.5, minBars: 60, label: '1分钟' },
    '5m': { atrMult: 2.0, minBars: 30, label: '5分钟' },
    '15m': { atrMult: 2.0, minBars: 20, label: '15分钟' },
    '30m': { atrMult: 1.8, minBars: 15, label: '30分钟' },
    '60m': { atrMult: 1.5, minBars: 10, label: '60分钟' },
    'daily': { atrMult: 1.5, minBars: 5, label: '日线' },
  };

  const config = periodConfig[period];
  const signals: TimeframeBacktestResult['signals'] = [];
  let position: 'LONG' | 'SHORT' | null = null;
  let entryPrice = 0;
  let stopPrice = 0;
  let entryIndex = 0;

  for (let i = config.minBars; i < bars.length - 1 && signals.length < maxTrades; i++) {
    const bar = bars[i];
    const prevBar = bars[i - 1];
    const atrVal = atr[i] || 0;
    if (atrVal <= 0) continue;

    if (position === 'LONG') {
      if (bar.l <= stopPrice) {
        const pnl = (stopPrice - entryPrice) / entryPrice * 100;
        signals.push({ index: i, date: bar.date, direction: 'LONG', entryPrice, exitPrice: stopPrice, pnl, isWin: pnl > 0, holdingBars: i - entryIndex });
        position = null;
        continue;
      }
      const target = entryPrice + config.atrMult * 1.5 * atrVal;
      if (bar.h >= target) {
        const pnl = (target - entryPrice) / entryPrice * 100;
        signals.push({ index: i, date: bar.date, direction: 'LONG', entryPrice, exitPrice: target, pnl, isWin: true, holdingBars: i - entryIndex });
        position = null;
        continue;
      }
    } else if (position === 'SHORT') {
      if (bar.h >= stopPrice) {
        const pnl = (entryPrice - stopPrice) / entryPrice * 100;
        signals.push({ index: i, date: bar.date, direction: 'SHORT', entryPrice, exitPrice: stopPrice, pnl, isWin: pnl > 0, holdingBars: i - entryIndex });
        position = null;
        continue;
      }
      const target = entryPrice - config.atrMult * 1.5 * atrVal;
      if (bar.l <= target) {
        const pnl = (entryPrice - target) / entryPrice * 100;
        signals.push({ index: i, date: bar.date, direction: 'SHORT', entryPrice, exitPrice: target, pnl, isWin: true, holdingBars: i - entryIndex });
        position = null;
        continue;
      }
    }

    if (position === null) {
      const bodyRatio = Math.abs(bar.c - bar.o) / (bar.h - bar.l || 0.001);
      const isBullish = bar.c > bar.o;
      const isBearish = bar.c < bar.o;
      const aboveEMA = bar.c > ema20[i];
      const belowEMA = bar.c < ema20[i];
      const prevBody = Math.abs(prevBar.c - prevBar.o);
      const currBody = Math.abs(bar.c - bar.o);
      const isStrongBull = isBullish && bodyRatio > 0.6 && currBody > prevBody;
      const isStrongBear = isBearish && bodyRatio > 0.6 && currBody > prevBody;
      const lowerWick = Math.min(bar.o, bar.c) - bar.l;
      const upperWick = bar.h - Math.max(bar.o, bar.c);
      const body = Math.abs(bar.c - bar.o);
      const isHammer = lowerWick > body * 2 && upperWick < body * 0.5 && belowEMA;
      const isShootingStar = upperWick > body * 2 && lowerWick < body * 0.5 && aboveEMA;
      const emaCrossUp = i >= 2 && ema20[i] > ema20[i - 1] && ema20[i - 1] <= ema20[i - 2];
      const emaCrossDown = i >= 2 && ema20[i] < ema20[i - 1] && ema20[i - 1] >= ema20[i - 2];

      let entrySignal: 'LONG' | 'SHORT' | null = null;
      if ((isStrongBull && aboveEMA) || (isHammer && bar.c > prevBar.h) || emaCrossUp) {
        entrySignal = 'LONG';
      } else if ((isStrongBear && belowEMA) || (isShootingStar && bar.c < prevBar.l) || emaCrossDown) {
        entrySignal = 'SHORT';
      }

      if (entrySignal) {
        position = entrySignal;
        entryPrice = bar.c;
        entryIndex = i;
        stopPrice = entrySignal === 'LONG'
          ? entryPrice - config.atrMult * atrVal
          : entryPrice + config.atrMult * atrVal;
      }
    }
  }

  // 未平仓按收盘价平
  if (position && bars.length > 0) {
    const lastBar = bars[bars.length - 1];
    const pnl = position === 'LONG'
      ? (lastBar.c - entryPrice) / entryPrice * 100
      : (entryPrice - lastBar.c) / entryPrice * 100;
    signals.push({ index: bars.length - 1, date: lastBar.date, direction: position, entryPrice, exitPrice: lastBar.c, pnl, isWin: pnl > 0, holdingBars: bars.length - 1 - entryIndex });
  }

  const wins = signals.filter((s) => s.isWin);
  const losses = signals.filter((s) => !s.isWin);
  const avgProfit = wins.length > 0 ? wins.reduce((s, x) => s + x.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, x) => s + x.pnl, 0) / losses.length) : 0;
  const totalProfit = wins.reduce((s, x) => s + x.pnl, 0);
  const totalLoss = Math.abs(losses.reduce((s, x) => s + x.pnl, 0));

  let maxConsW = 0, maxConsL = 0, cW = 0, cL = 0;
  for (const s of signals) {
    if (s.isWin) { cW++; cL = 0; maxConsW = Math.max(maxConsW, cW); }
    else { cL++; cW = 0; maxConsL = Math.max(maxConsL, cL); }
  }

  return {
    period, label: config.label, barsAvailable: bars.length,
    tradingDaysCovered: estimateTradingDays(period, bars.length),
    totalTrades: signals.length, wins: wins.length, losses: losses.length,
    winRate: signals.length > 0 ? wins.length / signals.length : 0,
    avgProfit: Math.round(avgProfit * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    profitFactor: totalLoss > 0 ? Math.round((totalProfit / totalLoss) * 100) / 100 : totalProfit > 0 ? 999 : 0,
    maxConsecutiveWins: maxConsW, maxConsecutiveLosses: maxConsL,
    avgHoldingBars: signals.length > 0 ? Math.round(signals.reduce((s, x) => s + x.holdingBars, 0) / signals.length * 10) / 10 : 0,
    signals: signals.slice(-20),
  };
}

// 单品种多周期回测
export async function backtestMultiTimeframe(code: string, name: string, maxTradesPerPeriod = 100): Promise<MultiTimeframeResult> {
  const periods: TimeframePeriod[] = ['1m', '5m', '15m', '30m', '60m', 'daily'];
  const results: TimeframeBacktestResult[] = [];
  const contract = await detectMainContract(code);

  for (const period of periods) {
    try {
      const bars = await fetchBarsForTimeframe(contract, period);
      if (!bars || bars.length < 30) {
        const labels: Record<TimeframePeriod, string> = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟', 'daily': '日线' };
        results.push({ period, label: labels[period], barsAvailable: bars?.length || 0, tradingDaysCovered: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgProfit: 0, avgLoss: 0, profitFactor: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0, avgHoldingBars: 0, signals: [] });
        continue;
      }
      results.push(backtestTimeframe(bars, period, maxTradesPerPeriod));
      await new Promise((r) => setTimeout(r, 200));
    } catch {
      const labels: Record<TimeframePeriod, string> = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟', 'daily': '日线' };
      results.push({ period, label: labels[period], barsAvailable: 0, tradingDaysCovered: 0, totalTrades: 0, wins: 0, losses: 0, winRate: 0, avgProfit: 0, avgLoss: 0, profitFactor: 0, maxConsecutiveWins: 0, maxConsecutiveLosses: 0, avgHoldingBars: 0, signals: [] });
    }
  }

  const valid = results.filter((r) => r.totalTrades >= 3);
  let bestPeriod: TimeframePeriod | null = null;
  let worstPeriod: TimeframePeriod | null = null;
  if (valid.length > 0) {
    const sorted = [...valid].sort((a, b) => (b.winRate * Math.log(b.profitFactor + 1)) - (a.winRate * Math.log(a.profitFactor + 1)));
    bestPeriod = sorted[0].period;
    worstPeriod = sorted[sorted.length - 1].period;
  }

  const labels: Record<TimeframePeriod, string> = { '1m': '1分钟', '5m': '5分钟', '15m': '15分钟', '30m': '30分钟', '60m': '60分钟', 'daily': '日线' };
  let conclusion = '';
  if (bestPeriod) {
    const b = valid.find((r) => r.period === bestPeriod)!;
    conclusion += `最佳周期：${labels[bestPeriod]}（胜率${(b.winRate * 100).toFixed(1)}%，盈亏比${b.profitFactor}）。`;
  }
  if (worstPeriod && worstPeriod !== bestPeriod) {
    const w = valid.find((r) => r.period === worstPeriod)!;
    conclusion += `最差周期：${labels[worstPeriod]}（胜率${(w.winRate * 100).toFixed(1)}%）。`;
  }
  const shortTerm = valid.filter((r) => ['1m', '5m', '15m'].includes(r.period));
  const longTerm = valid.filter((r) => ['60m', 'daily'].includes(r.period));
  if (shortTerm.length > 0 && longTerm.length > 0) {
    const sWR = shortTerm.reduce((s, r) => s + r.winRate, 0) / shortTerm.length;
    const lWR = longTerm.reduce((s, r) => s + r.winRate, 0) / longTerm.length;
    if (sWR > lWR + 0.05) conclusion += '短周期优于长周期，适合日内交易。';
    else if (lWR > sWR + 0.05) conclusion += '长周期优于短周期，适合趋势跟踪。';
    else conclusion += '各周期表现接近，信号跨周期稳定。';
  }
  const overallWR = valid.length > 0 ? valid.reduce((s, r) => s + r.winRate, 0) / valid.length : 0;
  if (overallWR > 0.6) conclusion += '【索普】优势明显，可重点配置。';
  else if (overallWR > 0.5) conclusion += '【西蒙斯】边际优势，需严格风控。';
  else conclusion += '【西蒙斯】优势不足，建议排除。';

  return { code, name, timeframes: results, bestPeriod, worstPeriod, conclusion };
}
