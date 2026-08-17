/**
 * P3-b 波动率 Regime 分层分析
 *
 * 对全部 59 品种的 TOP1 参数回测，按波动率环境分层统计：
 * - 低波动（ATR 百分位 < 33%）
 * - 中波动（33% ≤ ATR 百分位 < 67%）
 * - 高波动（ATR 百分位 ≥ 67%）
 *
 * 核心问题：某品种是否只在高波动时赚钱？
 * - 全 Regime 稳健：低/中/高波动均有正收益
 * - 条件依赖：仅高波动盈利，低波动亏损
 * - 反常：仅低波动盈利（可能是均值回归型）
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, computeTheoreticalMax, runTop1Backtest } from './runTop1FullBacktest';
import type { TradeLike, Bar } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS, top1UnifiedParams } from '../data/top1UnifiedParams';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

/** 计算 True Range */
function trueRange(bars: Bar[]): number[] {
  const tr: number[] = [bars[0].h - bars[0].l];
  for (let i = 1; i < bars.length; i++) {
    const hl = bars[i].h - bars[i].l;
    const hc = Math.abs(bars[i].h - bars[i - 1].c);
    const lc = Math.abs(bars[i].l - bars[i - 1].c);
    tr.push(Math.max(hl, hc, lc));
  }
  return tr;
}

/** 计算 ATR（14 日滚动） */
function computeATR(bars: Bar[], period = 14): number[] {
  const trArr = trueRange(bars);
  const atr: number[] = [];
  let sum = 0;
  for (let i = 0; i < trArr.length; i++) {
    sum += trArr[i];
    if (i < period) {
      atr.push(sum / (i + 1));
    } else {
      sum -= trArr[i - period];
      atr.push(sum / period);
    }
  }
  return atr;
}

/** 计算 ATR 百分位（用历史 ATR 的排名） */
function computeATRPercentile(atr: number[]): number[] {
  const sorted = [...atr].sort((a, b) => a - b);
  return atr.map((v) => {
    const idx = sorted.findIndex((s) => s >= v);
    return idx / sorted.length;
  });
}

/** 查找 bars 中日期对应的索引 */
function findBarIndex(bars: Bar[], dateStr: string): number {
  // bars 按日期排序，二分查找
  let lo = 0, hi = bars.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].date <= dateStr) lo = mid + 1;
    else hi = mid - 1;
  }
  return Math.max(0, lo - 1);
}

/** 按波动率 Regime 分组计算统计 */
function calcRegimeStats(trades: TradeLike[], bars: Bar[], atrPercentile: number[]) {
  const regimes = { low: [] as TradeLike[], mid: [] as TradeLike[], high: [] as TradeLike[] };

  for (const t of trades) {
    const idx = findBarIndex(bars, t.entryDate);
    const pct = atrPercentile[idx] ?? 0.5;
    if (pct < 0.33) regimes.low.push(t);
    else if (pct < 0.67) regimes.mid.push(t);
    else regimes.high.push(t);
  }

  const calcStats = (ts: TradeLike[]) => {
    if (ts.length === 0) return { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 };
    const totalPnl = ts.reduce((s, t) => s + t.pnl, 0);
    const wins = ts.filter((t) => t.pnl > 0).length;
    const winRate = wins / ts.length;

    // 简化版 Calmar：用总收益 / 最大回撤
    let equity = 0, peak = 0, mdd = 0;
    const sorted = [...ts].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
    for (const t of sorted) {
      equity += t.pnl;
      if (equity > peak) peak = equity;
      const dd = peak === 0 ? 0 : (peak - equity) / peak;
      if (dd > mdd) mdd = dd;
    }
    const calmar = mdd === 0 ? (totalPnl > 0 ? 999 : 0) : totalPnl / (mdd * 500000);

    return { trades: ts.length, totalPnl, winRate: +winRate.toFixed(3), calmar: +calmar.toFixed(2) };
  };

  return {
    low: calcStats(regimes.low),
    mid: calcStats(regimes.mid),
    high: calcStats(regimes.high),
  };
}

interface VarietyRegimeResult {
  code: string;
  grade: string;
  totalTrades: number;
  regimes: {
    low: { trades: number; totalPnl: number; winRate: number; calmar: number };
    mid: { trades: number; totalPnl: number; winRate: number; calmar: number };
    high: { trades: number; totalPnl: number; winRate: number; calmar: number };
  };
  pattern: 'all_robust' | 'high_only' | 'low_only' | 'mid_only' | 'mixed' | 'no_trades';
  description: string;
}

async function main() {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS);
  console.log(`=== P3-b 波动率 Regime 分层分析 (${codes.length} 品种) ===\n`);

  const results: VarietyRegimeResult[] = [];

  for (const code of codes) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    if (!recipe) continue;

    const bars = loadBars(code);
    if (bars.length < 60) {
      results.push({
        code, grade: top1UnifiedParams[code]?.grade || '?', totalTrades: 0,
        regimes: { low: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 }, mid: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 }, high: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 } },
        pattern: 'no_trades', description: '数据不足',
      });
      continue;
    }

    const atr = computeATR(bars);
    const atrPct = computeATRPercentile(atr);
    const theo = computeTheoreticalMax(bars, 3);

    const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');

    if (trades.length === 0) {
      results.push({
        code, grade: top1UnifiedParams[code]?.grade || '?', totalTrades: 0,
        regimes: { low: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 }, mid: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 }, high: { trades: 0, totalPnl: 0, winRate: 0, calmar: 0 } },
        pattern: 'no_trades', description: '无交易',
      });
      continue;
    }

    const regimes = calcRegimeStats(trades, bars, atrPct);

    // 判定模式
    const profitable = {
      low: regimes.low.totalPnl > 0 && regimes.low.calmar > 0,
      mid: regimes.mid.totalPnl > 0 && regimes.mid.calmar > 0,
      high: regimes.high.totalPnl > 0 && regimes.high.calmar > 0,
    };

    let pattern: VarietyRegimeResult['pattern'];
    let description: string;

    if (profitable.low && profitable.mid && profitable.high) {
      pattern = 'all_robust';
      description = '全 Regime 稳健';
    } else if (profitable.high && !profitable.low && !profitable.mid) {
      pattern = 'high_only';
      description = '仅高波动盈利（条件依赖型）';
    } else if (profitable.low && !profitable.mid && !profitable.high) {
      pattern = 'low_only';
      description = '仅低波动盈利（均值回归型）';
    } else if (profitable.mid && !profitable.low && !profitable.high) {
      pattern = 'mid_only';
      description = '仅中波动盈利';
    } else {
      pattern = 'mixed';
      const parts: string[] = [];
      if (profitable.low) parts.push('低');
      if (profitable.mid) parts.push('中');
      if (profitable.high) parts.push('高');
      description = `部分 Regime 盈利（${parts.join('+')}）`;
    }

    results.push({ code, grade: top1UnifiedParams[code]?.grade || '?', totalTrades: trades.length, regimes, pattern, description });

    const icon = pattern === 'all_robust' ? '✅' : pattern === 'high_only' ? '⚠️' : pattern === 'low_only' ? '🔶' : '🔶';
    console.log(`${icon} ${code.padEnd(5)} | 低[${regimes.low.trades}笔/${regimes.low.totalPnl > 0 ? '+' : ''}${(regimes.low.totalPnl / 1000).toFixed(0)}k] 中[${regimes.mid.trades}笔/${regimes.mid.totalPnl > 0 ? '+' : ''}${(regimes.mid.totalPnl / 1000).toFixed(0)}k] 高[${regimes.high.trades}笔/${regimes.high.totalPnl > 0 ? '+' : ''}${(regimes.high.totalPnl / 1000).toFixed(0)}k] | ${description}`);
  }

  // 统计
  const allRobust = results.filter(r => r.pattern === 'all_robust');
  const highOnly = results.filter(r => r.pattern === 'high_only');
  const lowOnly = results.filter(r => r.pattern === 'low_only');
  const midOnly = results.filter(r => r.pattern === 'mid_only');
  const mixed = results.filter(r => r.pattern === 'mixed');
  const noTrades = results.filter(r => r.pattern === 'no_trades');

  console.log(`\n=== 汇总 ===`);
  console.log(`全 Regime 稳健: ${allRobust.length} 个`);
  console.log(`仅高波动盈利: ${highOnly.length} 个`);
  console.log(`仅低波动盈利: ${lowOnly.length} 个`);
  console.log(`仅中波动盈利: ${midOnly.length} 个`);
  console.log(`混合模式: ${mixed.length} 个`);
  console.log(`无交易: ${noTrades.length} 个`);

  // 输出 JSON
  const outputPath = path.join(DATA_DIR, 'volatilityRegimeAnalysis.json');
  const output = {
    generatedAt: new Date().toISOString(),
    summary: {
      total: results.length,
      allRobust: allRobust.length,
      highOnly: highOnly.length,
      lowOnly: lowOnly.length,
      midOnly: midOnly.length,
      mixed: mixed.length,
      noTrades: noTrades.length,
    },
    allRobust: allRobust.map(r => ({ code: r.code, grade: r.grade })),
    highOnly: highOnly.map(r => ({ code: r.code, grade: r.grade })),
    lowOnly: lowOnly.map(r => ({ code: r.code, grade: r.grade })),
    mixed: mixed.map(r => ({ code: r.code, grade: r.grade, description: r.description })),
    details: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n已落盘: ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
