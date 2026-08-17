/**
 * 品种相关性矩阵服务
 * 
 * 计算品种间的价格相关性，用于：
 * 1. 持仓集中度预警（高相关品种同时持仓 = 隐性加仓）
 * 2. 对冲建议（负相关品种可以分散风险）
 * 3. 组合优化参考
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 日线数据目录
const DAILY_20Y_DIR = path.join(__dirname, '..', '..', 'data-cache-daily-20y');
const DAILY_DIR = path.join(__dirname, '..', '..', 'data-cache');

interface BarData {
  date: string;
  c: number;
  [key: string]: unknown;
}

/** 加载品种收盘价序列 */
function loadCloseSeries(code: string, lookback: number = 120): { dates: string[]; closes: number[] } {
  // 优先读取 20 年数据
  const dirs = [DAILY_20Y_DIR, DAILY_DIR];
  for (const dir of dirs) {
    const fp = path.join(dir, `${code}.json`);
    try {
      const raw = fs.readFileSync(fp, 'utf-8');
      const data = JSON.parse(raw);
      let bars: BarData[];
      if (Array.isArray(data)) bars = data;
      else if (data?.bars && Array.isArray(data.bars)) bars = data.bars;
      else continue;

      // 取最近 lookback 条
      const recent = bars.slice(-lookback);
      return {
        dates: recent.map(b => b.date),
        closes: recent.map(b => b.c),
      };
    } catch {
      continue;
    }
  }
  return { dates: [], closes: [] };
}

/** 计算收益率序列 */
function calcReturns(closes: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] !== 0) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
  }
  return returns;
}

/** 计算两个收益率序列的相关系数（Pearson） */
function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0; // 样本不足

  const xs = x.slice(0, n);
  const ys = y.slice(0, n);

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom === 0) return 0;
  return sumXY / denom;
}

// 缓存
let correlationCache: {
  matrix: Record<string, Record<string, number>>;
  timestamp: number;
  codes: string[];
} | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1小时

/**
 * 计算品种相关性矩阵
 * 
 * @param codes 品种代码列表（默认：所有有数据的品种）
 * @param lookback 回看天数（默认 120 交易日 ≈ 半年）
 */
export function computeCorrelationMatrix(
  codes?: string[],
  lookback: number = 120,
): Record<string, Record<string, number>> {
  // 检查缓存
  if (correlationCache && Date.now() - correlationCache.timestamp < CACHE_TTL) {
    if (!codes || codes.every(c => correlationCache!.codes.includes(c))) {
      return correlationCache.matrix;
    }
  }

  // 自动发现品种
  if (!codes || codes.length === 0) {
    codes = discoverAvailableVarieties();
  }

  // 加载所有品种的收益率
  const returnsMap = new Map<string, { dates: string[]; returns: number[] }>();
  for (const code of codes) {
    const series = loadCloseSeries(code, lookback + 1);
    if (series.closes.length >= 20) {
      returnsMap.set(code, {
        dates: series.dates.slice(1),
        returns: calcReturns(series.closes),
      });
    }
  }

  const validCodes = Array.from(returnsMap.keys());
  const matrix: Record<string, Record<string, number>> = {};

  for (const codeA of validCodes) {
    matrix[codeA] = {};
    const dataA = returnsMap.get(codeA)!;
    for (const codeB of validCodes) {
      if (codeA === codeB) {
        matrix[codeA][codeB] = 1.0;
        continue;
      }
      const dataB = returnsMap.get(codeB)!;
      // 对齐日期
      const { alignedA, alignedB } = alignSeries(dataA, dataB);
      const corr = pearsonCorrelation(alignedA, alignedB);
      matrix[codeA][codeB] = Math.round(corr * 1000) / 1000;
    }
  }

  // 更新缓存
  correlationCache = {
    matrix,
    timestamp: Date.now(),
    codes: validCodes,
  };

  return matrix;
}

/** 对齐两个时间序列（按日期交集） */
function alignSeries(
  a: { dates: string[]; returns: number[] },
  b: { dates: string[]; returns: number[] },
): { alignedA: number[]; alignedB: number[] } {
  const dateMapA = new Map<string, number>();
  for (let i = 0; i < a.dates.length; i++) {
    dateMapA.set(a.dates[i], a.returns[i]);
  }

  const alignedA: number[] = [];
  const alignedB: number[] = [];

  for (let i = 0; i < b.dates.length; i++) {
    const date = b.dates[i];
    if (dateMapA.has(date)) {
      alignedA.push(dateMapA.get(date)!);
      alignedB.push(b.returns[i]);
    }
  }

  return { alignedA, alignedB };
}

/** 发现可用的品种 */
function discoverAvailableVarieties(): string[] {
  const codes = new Set<string>();
  const dirs = [DAILY_20Y_DIR, DAILY_DIR];
  for (const dir of dirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.endsWith('.json')) {
          codes.add(f.replace('.json', ''));
        }
      }
    } catch {
      continue;
    }
  }
  return Array.from(codes);
}

/**
 * 获取品种的高相关品种列表
 */
export function getHighCorrelationPairs(
  codes: string[],
  threshold: number = 0.7,
): Array<{ codeA: string; codeB: string; correlation: number }> {
  const matrix = computeCorrelationMatrix(codes);
  const pairs: Array<{ codeA: string; codeB: string; correlation: number }> = [];
  const seen = new Set<string>();

  for (const codeA of codes) {
    if (!matrix[codeA]) continue;
    for (const codeB of codes) {
      if (codeA >= codeB) continue;
      const key = `${codeA}-${codeB}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const corr = matrix[codeA][codeB];
      if (corr !== undefined && Math.abs(corr) >= threshold) {
        pairs.push({ codeA, codeB, correlation: corr });
      }
    }
  }

  return pairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

/**
 * 检查持仓集中度风险
 */
export function checkConcentrationRisk(
  heldCodes: string[],
  threshold: number = 0.7,
): {
  risky: boolean;
  groups: Array<{ codes: string[]; avgCorrelation: number; risk: string }>;
  suggestions: string[];
} {
  if (heldCodes.length < 2) {
    return { risky: false, groups: [], suggestions: [] };
  }

  const matrix = computeCorrelationMatrix(heldCodes);
  const groups: Array<{ codes: string[]; avgCorrelation: number; risk: string }> = [];
  const suggestions: string[] = [];

  // 找出高相关品种子集
  for (let i = 0; i < heldCodes.length; i++) {
    const cluster: string[] = [heldCodes[i]];
    for (let j = i + 1; j < heldCodes.length; j++) {
      const corr = matrix[heldCodes[i]]?.[heldCodes[j]];
      if (corr !== undefined && Math.abs(corr) >= threshold) {
        cluster.push(heldCodes[j]);
      }
    }
    if (cluster.length >= 2) {
      // 计算组内平均相关性
      let totalCorr = 0;
      let count = 0;
      for (let a = 0; a < cluster.length; a++) {
        for (let b = a + 1; b < cluster.length; b++) {
          totalCorr += Math.abs(matrix[cluster[a]]?.[cluster[b]] || 0);
          count++;
        }
      }
      const avgCorr = count > 0 ? totalCorr / count : 0;
      groups.push({
        codes: cluster,
        avgCorrelation: Math.round(avgCorr * 1000) / 1000,
        risk: avgCorr > 0.85 ? '极高' : avgCorr > 0.7 ? '高' : '中',
      });
    }
  }

  // 去重（移除子集）
  const uniqueGroups = groups.filter((g, i) =>
    !groups.some((g2, j) => i !== j && g.codes.every(c => g2.codes.includes(c)) && g2.codes.length > g.codes.length)
  );

  for (const g of uniqueGroups) {
    suggestions.push(`${g.codes.join('、')} 相关性 ${g.avgCorrelation.toFixed(2)}（${g.risk}），建议只保留其中1-2个品种`);
  }

  return {
    risky: uniqueGroups.length > 0,
    groups: uniqueGroups,
    suggestions,
  };
}
