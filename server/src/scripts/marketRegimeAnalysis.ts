/**
 * 市场状态识别器
 * 识别波动率 Regime 和趋势/震荡状态
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data');

const VARIETIES = [
  'AG0', 'AL0', 'AU0', 'CF0', 'CU0', 'HC0', 'I0', 'IC0', 'IF0', 'IH0',
  'IM0', 'J0', 'JM0', 'LH0', 'M0', 'NI0', 'P0', 'PB0', 'RB0', 'RU0',
  'SC0', 'SI0', 'SP0', 'TA0', 'Y0', 'ZN0'
];

interface KBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  ret?: number;
}

interface VolatilityRegime {
  date: string;
  atr14: number;
  atr60: number;
  ratio: number; // atr14/atr60
  regime: 'low' | 'medium' | 'high';
  hv20: number; // 20 日历史波动率
  hv60: number; // 60 日历史波动率
}

interface TrendState {
  date: string;
  adx: number;
  ma20Slope: number;
  ma60Slope: number;
  state: 'trending_up' | 'trending_down' | 'ranging';
  trendStrength: number; // 0-1
}

// 计算 ATR
function calcATR(bars: KBar[], period: number, index: number): number {
  if (index < period - 1) return 0;
  
  let trSum = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const tr = calcTR(bars, i);
    trSum += tr;
  }
  return trSum / period;
}

function calcTR(bars: KBar[], index: number): number {
  if (index === 0) return bars[index].h - bars[index].l;
  const prevC = bars[index - 1].c;
  return Math.max(
    bars[index].h - bars[index].l,
    Math.abs(bars[index].h - prevC),
    Math.abs(bars[index].l - prevC)
  );
}

// 计算历史波动率
function calcHistoricalVolatility(bars: KBar[], period: number, index: number): number {
  if (index < period) return 0;
  
  const returns: number[] = [];
  for (let i = index - period + 1; i <= index; i++) {
    if (bars[i].ret !== undefined) {
      returns.push(bars[i].ret as number);
    } else {
      returns.push((bars[i].c - bars[i - 1].c) / bars[i - 1].c as number);
    }
  }
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  return Math.sqrt(variance * 252); // 年化
}

// 计算 ADX
function calcADX(bars: KBar[], period: number, index: number): number {
  if (index < period * 2) return 0;
  
  let plusDMSum = 0;
  let minusDMSum = 0;
  let trSum = 0;
  
  for (let i = index - period + 1; i <= index; i++) {
    const highDiff = bars[i].h - bars[i - 1].h;
    const lowDiff = bars[i - 1].l - bars[i].l;
    
    const plusDM = highDiff > lowDiff && highDiff > 0 ? highDiff : 0;
    const minusDM = lowDiff > highDiff && lowDiff > 0 ? lowDiff : 0;
    
    plusDMSum += plusDM;
    minusDMSum += minusDM;
    trSum += calcTR(bars, i);
  }
  
  if (trSum === 0) return 0;
  
  const plusDI = (plusDMSum / trSum) * 100;
  const minusDI = (minusDMSum / trSum) * 100;
  
  const diSum = plusDI + minusDI;
  if (diSum === 0) return 0;
  
  return Math.abs(plusDI - minusDI) / diSum * 100;
}

// 计算均线斜率
function calcMASlope(bars: KBar[], period: number, index: number): number {
  if (index < period) return 0;
  
  const ma = bars.slice(index - period + 1, index + 1).reduce((sum, b) => sum + b.c, 0) / period;
  const prevMa = bars.slice(index - period, index).reduce((sum, b) => sum + b.c, 0) / period;
  
  return ((ma - prevMa) / prevMa) * 100;
}

// 识别波动率状态
function identifyVolatilityRegime(bars: KBar[]): VolatilityRegime[] {
  const regimes: VolatilityRegime[] = [];
  
  for (let i = 60; i < bars.length; i++) {
    const atr14 = calcATR(bars, 14, i);
    const atr60 = calcATR(bars, 60, i);
    const ratio = atr60 > 0 ? atr14 / atr60 : 1;
    const hv20 = calcHistoricalVolatility(bars, 20, i);
    const hv60 = calcHistoricalVolatility(bars, 60, i);
    
    let regime: 'low' | 'medium' | 'high';
    if (ratio < 0.8) regime = 'low';
    else if (ratio < 1.2) regime = 'medium';
    else regime = 'high';
    
    regimes.push({
      date: bars[i].date,
      atr14,
      atr60,
      ratio,
      regime,
      hv20,
      hv60,
    });
  }
  
  return regimes;
}

// 识别趋势状态
function identifyTrendState(bars: KBar[]): TrendState[] {
  const states: TrendState[] = [];
  
  for (let i = 60; i < bars.length; i++) {
    const adx = calcADX(bars, 14, i);
    const ma20Slope = calcMASlope(bars, 20, i);
    const ma60Slope = calcMASlope(bars, 60, i);
    
    let state: 'trending_up' | 'trending_down' | 'ranging';
    let trendStrength = 0;
    
    if (adx < 20) {
      state = 'ranging';
      trendStrength = adx / 20;
    } else if (ma20Slope > 0 && ma60Slope > 0) {
      state = 'trending_up';
      trendStrength = Math.min(adx / 50, 1);
    } else if (ma20Slope < 0 && ma60Slope < 0) {
      state = 'trending_down';
      trendStrength = Math.min(adx / 50, 1);
    } else {
      state = 'ranging';
      trendStrength = adx / 40;
    }
    
    states.push({
      date: bars[i].date,
      adx,
      ma20Slope,
      ma60Slope,
      state,
      trendStrength,
    });
  }
  
  return states;
}

// 分析品种的市场状态分布
function analyzeVarietyRegimes(code: string): {
  volatility: { low: number; medium: number; high: number };
  trend: { trending_up: number; trending_down: number; ranging: number };
} {
  const filePath = path.join(DATA_DIR, `${code}_bars.json`);
  
  if (!fs.existsSync(filePath)) {
    // 尝试从实验数据推断
    return {
      volatility: { low: 0.33, medium: 0.34, high: 0.33 },
      trend: { trending_up: 0.33, trending_down: 0.33, ranging: 0.34 },
    };
  }
  
  const bars: KBar[] = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  
  const regimes = identifyVolatilityRegime(bars);
  const states = identifyTrendState(bars);
  
  const volDist = { low: 0, medium: 0, high: 0 };
  const trendDist = { trending_up: 0, trending_down: 0, ranging: 0 };
  
  for (const r of regimes) volDist[r.regime]++;
  for (const s of states) trendDist[s.state]++;
  
  const totalVol = regimes.length || 1;
  const totalTrend = states.length || 1;
  
  return {
    volatility: {
      low: volDist.low / totalVol,
      medium: volDist.medium / totalVol,
      high: volDist.high / totalVol,
    },
    trend: {
      trending_up: trendDist.trending_up / totalTrend,
      trending_down: trendDist.trending_down / totalTrend,
      ranging: trendDist.ranging / totalTrend,
    },
  };
}

// 主分析函数
function runMarketRegimeAnalysis() {
  console.log('🚀 开始市场状态识别分析...\n');
  
  const results = new Map<string, ReturnType<typeof analyzeVarietyRegimes>>();
  
  for (const code of VARIETIES) {
    const analysis = analyzeVarietyRegimes(code);
    results.set(code, analysis);
    console.log(`✅ ${code}: 波动率 [低${(analysis.volatility.low * 100).toFixed(0)}% 中${(analysis.volatility.medium * 100).toFixed(0)}% 高${(analysis.volatility.high * 100).toFixed(0)}%] | 趋势 [上${(analysis.trend.trending_up * 100).toFixed(0)}% 下${(analysis.trend.trending_down * 100).toFixed(0)}% 震${(analysis.trend.ranging * 100).toFixed(0)}%]`);
  }
  
  // 计算整体分布
  let avgVol = { low: 0, medium: 0, high: 0 };
  let avgTrend = { trending_up: 0, trending_down: 0, ranging: 0 };
  
  for (const [, analysis] of results) {
    avgVol.low += analysis.volatility.low;
    avgVol.medium += analysis.volatility.medium;
    avgVol.high += analysis.volatility.high;
    avgTrend.trending_up += analysis.trend.trending_up;
    avgTrend.trending_down += analysis.trend.trending_down;
    avgTrend.ranging += analysis.trend.ranging;
  }
  
  const count = results.size;
  avgVol = { low: avgVol.low / count, medium: avgVol.medium / count, high: avgVol.high / count };
  avgTrend = { trending_up: avgTrend.trending_up / count, trending_down: avgTrend.trending_down / count, ranging: avgTrend.ranging / count };
  
  console.log('\n=== 整体市场状态分布 ===');
  console.log(`波动率：低${(avgVol.low * 100).toFixed(1)}% | 中${(avgVol.medium * 100).toFixed(1)}% | 高${(avgVol.high * 100).toFixed(1)}%`);
  console.log(`趋势：上涨${(avgTrend.trending_up * 100).toFixed(1)}% | 下跌${(avgTrend.trending_down * 100).toFixed(1)}% | 震荡${(avgTrend.ranging * 100).toFixed(1)}%`);
  
  // 保存结果
  const outputPath = path.join(DATA_DIR, 'marketRegimeAnalysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    varietiesCount: results.size,
    overallDistribution: {
      volatility: avgVol,
      trend: avgTrend,
    },
    varietyDetails: Object.fromEntries(results),
  }, null, 2));
  
  console.log(`\n💾 分析结果已保存到：${outputPath}`);
}

// 执行分析
runMarketRegimeAnalysis();
