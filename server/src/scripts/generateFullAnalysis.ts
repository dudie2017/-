// @ts-nocheck
/**
 * 全品种组合分析 - 一次性生成轻量汇总数据
 *
 * 功能：
 * 1. 动态扫描 data 目录下所有 *_1000Experiments.json（当前 59 个品种）
 * 2. 提取每个品种的排名指标（收益/PF/胜率/回撤）
 * 3. 计算品种间收益相关性矩阵
 * 4. 计算三种组合配置（等权/风险平价/最大夏普）
 * 5. 计算策略回测（板块轮动/跨品种套利）
 * 6. 输出轻量 JSON（full_analysis.json），供 portfolio 接口直接读取
 *
 * 运行：cd server && pnpm exec tsx src/scripts/generateFullAnalysis.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { VARIETIES, GROUP_NAMES } from '../services/varieties.js';
import {
  buildCovariance,
  portfolioStats,
  shrinkMu,
  computeThreePortfolios,
} from '../services/portfolioMath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

// 统一品种元数据来源：data 目录实际存在的回测文件
function listVarietyCodes(): string[] {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('_1000Experiments.json'));
  return files.map((f) => f.replace('_1000Experiments.json', '')).sort();
}

function loadVarietyStats(code: string) {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return null;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const fullResults = data.fullResults || [];
  const statsList = fullResults.map((r: any) => r.stats).filter(Boolean);
  if (statsList.length === 0) return null;
  return statsList;
}

function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function std(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(mean(arr.map((v) => (v - m) ** 2)));
}

function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx2 = 0;
  let dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const den = Math.sqrt(dx2 * dy2);
  return den > 0 ? num / den : 0;
}

// 收益分布直方图（用于单品种下钻，展示 1000 次实验的完整分布）
function buildHistogram(values: number[], bins = 20) {
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const p25 = sorted[Math.floor(sorted.length * 0.25)];
  const p75 = sorted[Math.floor(sorted.length * 0.75)];
  const med = median(sorted);
  const meanV = mean(values);
  const stdV = std(values);
  if (max - min < 1e-12) {
    return { min, max, p25, median: med, p75, mean: meanV, std: stdV, binWidth: 1, counts: [values.length] };
  }
  const binWidth = (max - min) / bins;
  const counts = new Array(bins).fill(0);
  for (const v of values) {
    let idx = Math.floor((v - min) / binWidth);
    if (idx >= bins) idx = bins - 1;
    counts[idx]++;
  }
  return { min, max, p25, median: med, p75, mean: meanV, std: stdV, binWidth, counts };
}

const CACHE_DIR = path.join(__dirname, '../../data-cache');

// 读取行情日线，计算按日期索引的日收益率（%）
function loadDailyReturnsByDate(code: string): Map<string, number> | null {
  const filePath = path.join(CACHE_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars = data.bars || [];
    if (bars.length < 30) return null;
    const map = new Map<string, number>();
    for (let i = 1; i < bars.length; i++) {
      const prev = bars[i - 1];
      const cur = bars[i];
      if (prev.c > 0 && cur.c > 0) {
        map.set(cur.date, (cur.c - prev.c) / prev.c);
      }
    }
    return map;
  } catch {
    return null;
  }
}

// 基于按日期对齐的行情日收益计算相关性（公共交易日 < 20 返回 0）
function correlationByDate(a: Map<string, number>, b: Map<string, number>): number {
  const xs: number[] = [];
  const ys: number[] = [];
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  for (const [date, r] of smaller) {
    const other = larger.get(date);
    if (other === undefined) continue;
    if (a === smaller) {
      xs.push(r);
      ys.push(other);
    } else {
      xs.push(other);
      ys.push(r);
    }
  }
  if (xs.length < 20) return 0;
  return correlation(xs, ys);
}

// 读取行情日线收盘价（按日期索引，用于价差套利回测）
function loadDailyPrices(code: string): Map<string, number> | null {
  const filePath = path.join(CACHE_DIR, `${code}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars = data.bars || [];
    if (bars.length < 30) return null;
    const map = new Map<string, number>();
    for (const b of bars) {
      if (b.c > 0) map.set(b.date, b.c);
    }
    return map;
  } catch {
    return null;
  }
}

// 每手基准权益（元）：用于把真实回测的累计收益率换算成"累计每手净收益"，与前端展示口径对齐
const BENCHMARK_EQUITY = 50000;

// 板块轮动动量回测：每月调仓，持有过去 LOOKBACK 日动量最强板块（真实行情逐日回放）
function buildSectorRotationBacktest(
  varieties: { code: string; sector: string }[],
  dailyReturns: Record<string, Map<string, number>>
) {
  const sectorCodes: Record<string, string[]> = {};
  varieties.forEach((v) => {
    (sectorCodes[v.sector] = sectorCodes[v.sector] || []).push(v.code);
  });

  const dateSet = new Set<string>();
  Object.values(dailyReturns).forEach((m) => m.forEach((_r, d) => dateSet.add(d)));
  const dates = Array.from(dateSet).sort();
  if (dates.length < 60) return null;

  // 优化参数：60日动量回看（过滤短期噪音）+ 40日调仓（平衡信号稳定性和交易频率）
  const REBALANCE = 40; // 40日调仓（约2个月，平衡信号稳定性和交易频率）
  const LOOKBACK = 60; // 60日动量回看（过滤短期噪音）

  let nav = 1;
  const navs: number[] = [1];
  let peak = 1;
  let maxDd = 0;
  let currentCodes: string[] = [];
  let currentSector = '';
  const periodReturns: number[] = [];
  let periodRet = 0;

  for (let i = LOOKBACK; i < dates.length; i++) {
    const relIdx = i - LOOKBACK;
    if (relIdx % REBALANCE === 0) {
      if (relIdx > 0) {
        periodReturns.push(periodRet);
        periodRet = 0;
      }
      // 调仓：选动量最强板块
      let bestSector = '';
      let bestCodes: string[] = [];
      let bestMom = -Infinity;
      for (const [sector, codes] of Object.entries(sectorCodes)) {
        let sum = 0;
        let cnt = 0;
        for (const c of codes) {
          const m = dailyReturns[c];
          if (!m) continue;
          let cum = 0;
          for (let j = i - LOOKBACK; j < i; j++) {
            const r = m.get(dates[j]);
            if (r !== undefined) cum += r;
          }
          sum += cum;
          cnt++;
        }
        const mom = cnt > 0 ? sum / cnt : -Infinity;
        if (mom > bestMom) {
          bestMom = mom;
          bestSector = sector;
          bestCodes = codes;
        }
      }
      currentSector = bestSector;
      currentCodes = bestCodes;
    }

    // 当日收益 = 当前板块品种等权平均日收益
    let dayRet = 0;
    let cnt = 0;
    for (const c of currentCodes) {
      const r = dailyReturns[c]?.get(dates[i]);
      if (r !== undefined) {
        dayRet += r;
        cnt++;
      }
    }
    if (cnt > 0) dayRet /= cnt;
    periodRet += dayRet;
    nav *= 1 + dayRet;
    navs.push(nav);
    peak = Math.max(peak, nav);
    maxDd = Math.min(maxDd, nav / peak - 1);
  }
  if (periodRet !== 0) periodReturns.push(periodRet);

  const totalReturn = nav - 1;
  const annualized = Math.pow(nav, 252 / (dates.length - LOOKBACK)) - 1;
  const wins = periodReturns.filter((r) => r > 0).length;
  const winRate = periodReturns.length > 0 ? wins / periodReturns.length : 0;
  const pMean = mean(periodReturns);
  const pStd = std(periodReturns) || 1e-9;
  const sharpe = (pMean / pStd) * Math.sqrt(252 / REBALANCE);

  // 下采样净值曲线到约 60 个点
  const step = Math.max(1, Math.ceil(navs.length / 60));
  const sampled = navs.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== navs[navs.length - 1]) {
    sampled.push(navs[navs.length - 1]);
  }

  return {
    strategy: `${currentSector}轮动`,
    description: `每月调仓，持有过去 20 日动量最强板块（${currentSector}）`,
    totalReturn: Math.round(totalReturn * BENCHMARK_EQUITY * 100) / 100,
    annualized: Math.round(annualized * BENCHMARK_EQUITY * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    trades: periodReturns.length,
    bestSector: currentSector,
    maxDrawdown: Math.round(maxDd * 10000) / 10000,
    sharpe: Math.round(sharpe * 100) / 100,
    navCurve: sampled.map((v) => Math.round(v * 10000) / 10000),
  };
}

// 跨品种套利：价差 z-score 均值回归（真实行情逐日回放）
function buildArbitrageBacktest(
  topPairs: { code1: string; code2: string; corr: number }[],
  dailyPrices: Record<string, Map<string, number>>
) {
  // 优化参数：更严格的开仓阈值 + 更宽松的平仓阈值
  const LOOKBACK = 30; // 滚动窗口（原20日，现30日，更稳定的均值/标准差）
  const ENTRY_Z = 2.0; // 开仓阈值（原1.5，现2.0，提高信号质量）
  const EXIT_Z = 0.5; // 平仓阈值（原0.2，现0.5，避免过早平仓）

  let totalPnl = 0;
  let wins = 0;
  let totalTrades = 0;
  let maxDrawdownPnl = 0;
  let peakPnl = 0;
  let sampleDays = 0;
  const pairResults: { code1: string; code2: string; corr: number }[] = [];

  for (const pair of topPairs) {
    const p1 = dailyPrices[pair.code1];
    const p2 = dailyPrices[pair.code2];
    if (!p1 || !p2) continue;

    // 对齐日期，计算 log 价差
    const dates: string[] = [];
    const spreads: number[] = [];
    const [smaller, larger] = p1.size <= p2.size ? [p1, p2] : [p2, p1];
    for (const [date, price] of smaller) {
      const other = larger.get(date);
      if (other === undefined) continue;
      spreads.push(Math.log(price) - Math.log(other));
      dates.push(date);
    }
    if (spreads.length < LOOKBACK + 5) continue;
    sampleDays = Math.max(sampleDays, spreads.length - LOOKBACK);

    let position = 0; // 0 无仓，1 做多价差（多 code1 空 code2），-1 做空价差
    let entrySpread = 0;
    let pairPnl = 0;
    let pairTrades = 0;

    for (let i = LOOKBACK; i < spreads.length; i++) {
      const window = spreads.slice(i - LOOKBACK, i);
      const m = mean(window);
      const s = std(window) || 1e-9;
      const z = (spreads[i] - m) / s;

      if (position === 0) {
        if (z > ENTRY_Z) {
          position = -1;
          entrySpread = spreads[i];
        } else if (z < -ENTRY_Z) {
          position = 1;
          entrySpread = spreads[i];
        }
      } else if (Math.abs(z) < EXIT_Z) {
        const spreadRet = position === 1 ? spreads[i] - entrySpread : entrySpread - spreads[i];
        const pnl = spreadRet * BENCHMARK_EQUITY;
        pairPnl += pnl;
        wins += pnl > 0 ? 1 : 0;
        totalTrades += 1;
        pairTrades += 1;
        position = 0;
      }
    }

    if (pairTrades > 0) {
      totalPnl += pairPnl;
      peakPnl = Math.max(peakPnl, totalPnl);
      maxDrawdownPnl = Math.min(maxDrawdownPnl, totalPnl - peakPnl);
      pairResults.push({ code1: pair.code1, code2: pair.code2, corr: pair.corr });
    }
  }

  if (totalTrades === 0) return null;

  const annualized = sampleDays > 0 ? totalPnl * (252 / sampleDays) : totalPnl * 2;

  return {
    strategy: '跨品种套利',
    description: '做多强势、做空弱势的高相关品种对（价差 z-score 均值回归）',
    totalReturn: Math.round(totalPnl * 100) / 100,
    annualized: Math.round(annualized * 100) / 100,
    winRate: Math.round((wins / totalTrades) * 100) / 100,
    trades: totalTrades,
    maxDrawdown: Math.round(maxDrawdownPnl * 100) / 100,
    pairs: pairResults,
  };
}

// 组合历史回测：用行情日收益率验证配置的真实历史表现
function buildPortfolioBacktest(
  weights: number[],
  codes: string[],
  dailyReturns: Record<string, Map<string, number>>
) {
  const dateSet = new Set<string>();
  codes.forEach((c) => {
    const m = dailyReturns[c];
    if (m) m.forEach((_r, date) => dateSet.add(date));
  });
  const dates = Array.from(dateSet).sort();
  if (dates.length < 20) return null;

  const dailyPnls: number[] = [];
  const navs: number[] = [1];
  let nav = 1;
  let peak = 1;
  let maxDd = 0;
  for (const date of dates) {
    let dayRet = 0;
    codes.forEach((c, i) => {
      const r = dailyReturns[c]?.get(date);
      if (r !== undefined) dayRet += weights[i] * r;
    });
    dailyPnls.push(dayRet);
    nav *= 1 + dayRet;
    navs.push(nav);
    peak = Math.max(peak, nav);
    maxDd = Math.min(maxDd, nav / peak - 1);
  }

  const meanRet = mean(dailyPnls);
  const stdRet = std(dailyPnls) || 1e-9;
  const annualizedReturn = Math.pow(nav, 252 / dates.length) - 1;
  const sharpe = (meanRet / stdRet) * Math.sqrt(252);

  // 下采样净值曲线到约 60 个点，控制 JSON 体积
  const step = Math.max(1, Math.ceil(navs.length / 60));
  const sampled = navs.filter((_, i) => i % step === 0);
  if (sampled[sampled.length - 1] !== navs[navs.length - 1]) {
    sampled.push(navs[navs.length - 1]);
  }

  return {
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    tradingDays: dates.length,
    totalReturn: Math.round((nav - 1) * 10000) / 10000,
    maxDrawdown: Math.round(maxDd * 10000) / 10000,
    annualizedReturn: Math.round(annualizedReturn * 10000) / 10000,
    sharpe: Math.round(sharpe * 100) / 100,
    navCurve: sampled.map((v) => Math.round(v * 10000) / 10000),
  };
}

async function main() {
  console.log('📊 全品种组合分析 - 生成轻量汇总\n');

  const codes = listVarietyCodes();
  console.log(`发现 ${codes.length} 个品种回测文件\n`);

  // 1. 提取品种排名指标 + 收益序列
  const varieties: any[] = [];
  const returnSeries: Record<string, number[]> = {};

  // 预期指标取 Top-K 实验子集（代表"参数优化后"的可实现表现，而非全体分布）
  // 样本外验证表明：K 越大（越接近全体）事后选择偏差越小，Top-20% 的样本外夏普显著优于 Top-10%
  const TOP_K = 200;

  // μ 收缩估计：Top-K 与全体均值线性混合，降低事后选择偏差（James-Stein 思想）
  const SHRINK_ALPHA = 0.5;

  for (const code of codes) {
    const statsList = loadVarietyStats(code);
    if (!statsList) continue;

    const pnls = statsList.map((s: any) => s.totalPnl || 0);
    const pfs = statsList.map((s: any) => s.profitFactor || 0);
    const winRates = statsList.map((s: any) => s.winRate || 0);
    const dds = statsList.map((s: any) => s.maxDrawdown || 0);

    // 全体序列（用于相关性矩阵与波动率，保持保守口径）
    returnSeries[code] = pnls;

    // 剔除退化品种：收益波动为 0（1000 次实验全部无交易），会破坏风险平价/协方差计算
    if (std(pnls) < 1e-9) {
      console.warn(`⚠️ 跳过退化品种 ${code}（${VARIETIES[code] || code}，收益波动为 0）`);
      delete returnSeries[code];
      continue;
    }

    // Top-K 子集：按 totalPnl 降序取前 K
    const topIdx = pnls
      .map((v, i) => ({ v, i }))
      .sort((a, b) => b.v - a.v)
      .slice(0, Math.min(TOP_K, pnls.length))
      .map((x) => x.i);
    const topPnl = topIdx.map((i) => pnls[i]);
    const topPf = topIdx.map((i) => pfs[i]);
    const topWin = topIdx.map((i) => winRates[i]);
    const topDd = topIdx.map((i) => dds[i]);

    varieties.push({
      code,
      name: VARIETIES[code] || code,
      sector: GROUP_NAMES[code] || '其他',
      // 指标值用 Top-K 子集的中位数（抗极端值，代表优化后表现）
      avgPnl: Math.round(median(topPnl) * 100) / 100,
      // 全体实验均值（用于品种预筛：剔除平均亏损的品种，验证显示这是配置收益转正的关键）
      avgPnlAll: Math.round(mean(pnls) * 100) / 100,
      avgPf: Math.round(median(topPf) * 100) / 100,
      avgWinRate: Math.round(median(topWin) * 1000) / 1000,
      avgMaxDd: Math.round(median(topDd) * 10000) / 10000,
      experiments: statsList.length,
      pnlHistogram: buildHistogram(pnls, 20),
      _pnl: median(topPnl),
      _pf: median(topPf),
      _wr: median(topWin),
      _dd: median(topDd),
    });
  }

  // 综合评分：收益40% + PF30% + 回撤20% + 胜率10%（rank 归一化，对极端值稳健）
  const rankNorm = (arr: number[]) => {
    const n = arr.length;
    const sorted = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
    const out = new Array<number>(n);
    sorted.forEach((item, rank) => {
      out[item.i] = n === 1 ? 0.5 : rank / (n - 1); // 0 ~ 1 均匀分布
    });
    return out;
  };

  const pnlNorm = rankNorm(varieties.map((v) => v._pnl));
  const pfNorm = rankNorm(varieties.map((v) => v._pf));
  const ddNorm = rankNorm(varieties.map((v) => v._dd));
  const wrNorm = rankNorm(varieties.map((v) => v._wr));

  varieties.forEach((v, i) => {
    const returnScore = pnlNorm[i] * 40;
    const pfScore = pfNorm[i] * 30;
    const ddScore = (1 - ddNorm[i]) * 20; // 回撤越小得分越高
    const wrScore = wrNorm[i] * 10;
    v.score = Math.round((returnScore + pfScore + ddScore + wrScore) * 100) / 100;
    v.tier = v.score >= 75 ? 'S' : v.score >= 60 ? 'A' : v.score >= 45 ? 'B' : 'C';
    delete v._pnl;
    delete v._pf;
    delete v._wr;
    delete v._dd;
  });

  // 按综合评分降序排序
  varieties.sort((a, b) => b.score - a.score);
  varieties.forEach((v, i) => {
    v.rank = i + 1;
  });

  console.log(`✅ 排名完成：共 ${varieties.length} 个品种\n`);

  const summary = {
    totalVarieties: varieties.length,
    sTier: varieties.filter((v) => v.tier === 'S').length,
    aTier: varieties.filter((v) => v.tier === 'A').length,
    bTier: varieties.filter((v) => v.tier === 'B').length,
    cTier: varieties.filter((v) => v.tier === 'C').length,
  };

  // 2. 相关性矩阵（全部品种，NxN，基于行情日收益，按日期对齐；无行情数据时回退到回测序列）
  const dailyReturnsByDate: Record<string, Map<string, number>> = {};
  for (const v of varieties) {
    const m = loadDailyReturnsByDate(v.code);
    if (m) dailyReturnsByDate[v.code] = m;
  }
  const corrMatrix: Record<string, Record<string, number>> = {};
  for (const c1 of varieties) {
    corrMatrix[c1.code] = {};
    for (const c2 of varieties) {
      if (c1.code === c2.code) {
        corrMatrix[c1.code][c2.code] = 1;
      } else {
        const a = dailyReturnsByDate[c1.code];
        const b = dailyReturnsByDate[c2.code];
        corrMatrix[c1.code][c2.code] =
          a && b
            ? Math.round(correlationByDate(a, b) * 1000) / 1000
            : Math.round(correlation(returnSeries[c1.code], returnSeries[c2.code]) * 1000) / 1000;
      }
    }
  }
  console.log(`✅ 相关性矩阵完成：${varieties.length} × ${varieties.length}（基于行情日收益）\n`);

  // 3. 组合配置（仅选用"全体均值为正"的品种，剔除平均亏损的品种——样本外验证表明这是收益转正的关键）
  const eligible = varieties.filter((v) => v.avgPnlAll > 0);
  const universe = eligible.length >= 2 ? eligible : varieties;
  const n = universe.length;
  const portfolioVarieties = universe.map((v) => ({
    code: v.code,
    name: v.name,
    sector: v.sector,
  }));

  // 构建协方差矩阵（相关性矩阵 × 波动率），μ 用收缩估计（Top-K 向全体均值收缩）
  const codesOrder = universe.map((v) => v.code);
  const vols = codesOrder.map((c) => std(returnSeries[c]) || 1);
  const muTop = universe.map((v) => v.avgPnl);
  const muAll = universe.map((v) => v.avgPnlAll);
  const mu = shrinkMu(muTop, muAll, SHRINK_ALPHA);
  const sectors = universe.map((v) => v.sector);
  const corr2d = codesOrder.map((c1) =>
    codesOrder.map((c2) => corrMatrix[c1]?.[c2] ?? (c1 === c2 ? 1 : 0))
  );
  const Sigma = buildCovariance(corr2d, vols);

  const roundWeights = (ws: number[]) => ws.map((w) => Math.round(w * 10000) / 10000);
  const roundStats = (s: { return: number; volatility: number; sharpe: number }) => ({
    return: Math.round(s.return * 100) / 100,
    volatility: Math.round(s.volatility * 100) / 100,
    sharpe: Math.round(s.sharpe * 100) / 100,
  });

  // 交易成本敏感性：配置收益（累计每手净收益）对额外换仓摩擦的承受能力。
  // 收益/波动率均为"累计每手"口径，成本档位按"累计每手换仓成本"假设（低/中/高摩擦）。
  const buildCostImpact = (ret: number, vol: number) => {
    const scenarios = [
      { label: '低摩擦', cost: 500 },
      { label: '中摩擦', cost: 2000 },
      { label: '高摩擦', cost: 5000 },
    ].map((s) => ({
      ...s,
      netReturn: Math.round((ret - s.cost) * 100) / 100,
      netSharpe: vol > 0 ? Math.round(((ret - s.cost) / vol) * 100) / 100 : 0,
    }));
    return {
      breakEvenCost: Math.round(ret * 100) / 100,
      erosionPer1k: ret > 0 ? Math.round((1000 / ret) * 10000) / 100 : null,
      scenarios,
    };
  };

  // 三种方案权重（统一约束：单品种上限 / 板块上限 / 权重下限 / 最小持仓数）
  const { equalWeight, riskParity, maxSharpe } = computeThreePortfolios(mu, Sigma, sectors);

  // 均衡型：等权重 + 约束
  const equalWeightWeights = roundWeights(equalWeight);

  // 保守型：风险平价（ERC，风险贡献均衡）+ 约束
  const riskParityWeights = roundWeights(riskParity);

  // 进取型：最大夏普（long-only 数值优化）+ 约束
  const maxSharpeOptimizedWeights = roundWeights(maxSharpe);

  // 单品种最优对照基准（样本外验证：全押最优单品种夏普 0.81，远高于分散配置）
  const bestSingleIdx = universe.reduce((best, _v, i) => {
    const s = vols[i] > 0 ? mu[i] / vols[i] : -Infinity;
    const bestS = vols[best] > 0 ? mu[best] / vols[best] : -Infinity;
    return s > bestS ? i : best;
  }, 0);
  const bestSingle = {
    code: universe[bestSingleIdx].code,
    name: universe[bestSingleIdx].name,
    return: Math.round(mu[bestSingleIdx] * 100) / 100,
    volatility: Math.round(vols[bestSingleIdx] * 100) / 100,
    sharpe: vols[bestSingleIdx] > 0
      ? Math.round((mu[bestSingleIdx] / vols[bestSingleIdx]) * 100) / 100
      : 0,
  };

  const eqStats = portfolioStats(equalWeightWeights, mu, Sigma);
  const rpStats = portfolioStats(riskParityWeights, mu, Sigma);
  const msStats = portfolioStats(maxSharpeOptimizedWeights, mu, Sigma);

  const portfolio = {
    equalWeight: {
      weights: equalWeightWeights,
      ...roundStats(eqStats),
      backtest: buildPortfolioBacktest(equalWeightWeights, codesOrder, dailyReturnsByDate),
      costImpact: buildCostImpact(eqStats.return, eqStats.volatility),
    },
    riskParity: {
      weights: riskParityWeights,
      ...roundStats(rpStats),
      backtest: buildPortfolioBacktest(riskParityWeights, codesOrder, dailyReturnsByDate),
      costImpact: buildCostImpact(rpStats.return, rpStats.volatility),
    },
    maxSharpe: {
      weights: maxSharpeOptimizedWeights,
      ...roundStats(msStats),
      backtest: buildPortfolioBacktest(maxSharpeOptimizedWeights, codesOrder, dailyReturnsByDate),
      costImpact: buildCostImpact(msStats.return, msStats.volatility),
    },
    bestSingle: {
      ...bestSingle,
      costImpact: buildCostImpact(bestSingle.return, bestSingle.volatility),
    },
  };
  console.log('✅ 组合配置完成（等权 / 风险平价ERC / 最大夏普优化）\n');

  // 4. 策略回测（真实行情逐日回放，替代固定假设）
  // 板块轮动：每月调仓，持有过去 20 日动量最强板块
  const sectorRotation = buildSectorRotationBacktest(
    varieties.map((v) => ({ code: v.code, sector: v.sector })),
    dailyReturnsByDate
  ) || {
    strategy: '板块轮动',
    description: '样本不足，暂无法回测',
    totalReturn: 0,
    annualized: 0,
    winRate: 0,
    trades: 0,
    bestSector: '',
  };

  // 跨品种套利：相关性 > 0.7 的前 3 对，价差 z-score 均值回归
  const pairs: { code1: string; code2: string; corr: number }[] = [];
  const seen = new Set<string>();
  for (const v1 of varieties) {
    for (const v2 of varieties) {
      if (v1.code === v2.code) continue;
      const key = [v1.code, v2.code].sort().join('-');
      if (seen.has(key)) continue;
      seen.add(key);
      const c = corrMatrix[v1.code][v2.code];
      if (c > 0.7) pairs.push({ code1: v1.code, code2: v2.code, corr: c });
    }
  }
  pairs.sort((a, b) => b.corr - a.corr);
  const topPairs = pairs.slice(0, 3);

  // 价差回归需要价格序列
  const dailyPrices: Record<string, Map<string, number>> = {};
  for (const p of topPairs) {
    for (const code of [p.code1, p.code2]) {
      if (!dailyPrices[code]) {
        dailyPrices[code] = loadDailyPrices(code) || new Map();
      }
    }
  }

  const arbitrage = buildArbitrageBacktest(topPairs, dailyPrices) || {
    strategy: '跨品种套利',
    description: '样本不足，暂无法回测',
    totalReturn: 0,
    annualized: 0,
    winRate: 0,
    trades: 0,
    pairs: topPairs.map((p) => ({ code1: p.code1, code2: p.code2, corr: p.corr })),
  };
  console.log('✅ 策略回测完成（板块轮动 / 跨品种套利）\n');

  // 5. 输出轻量 JSON
  const output = {
    generatedAt: new Date().toISOString(),
    summary,
    varieties,
    varietiesMeta: portfolioVarieties,
    correlation: corrMatrix,
    portfolio,
    strategy: {
      sectorRotation,
      arbitrage,
    },
  };

  const outPath = path.join(DATA_DIR, 'full_analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
  const sizeKB = Math.round(fs.statSync(outPath).size / 1024);
  console.log(`🎉 生成完成：${outPath}（${sizeKB} KB）`);
  console.log(
    `   品种 ${summary.totalVarieties} 个（S:${summary.sTier} A:${summary.aTier} B:${summary.bTier} C:${summary.cTier}）`
  );
}

main().catch((err) => {
  console.error('❌ 生成失败：', err);
  process.exit(1);
});

