/**
 * 组合层相关性分析（P2-b）
 *
 * 目的：对"稳健底仓候选"品种，用新参数 top1UnifiedParams 跑回测得到逐笔 trades，
 * 聚合为月度收益序列，计算品种间 Pearson 相关性，识别"同涨同跌"的高相关组合。
 *
 * 数据来源：
 * - 参数：src/data/top1UnifiedParams.ts 的 TOP1_UNIFIED_PARAMS
 * - 价格：data-cache-daily-20y/{code}.json
 * - 回测：复用 runTop1FullBacktest.ts 的 loadBars / computeTheoreticalMax / runTop1Backtest
 */
import fs from 'fs';
import path from 'path';
import {
  loadBars,
  computeTheoreticalMax,
  runTop1Backtest,
  type TradeLike,
} from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';

// 稳健底仓候选（A 级 6 个 + 明星 HC0）
const TARGETS = ['AG0', 'AU0', 'CF0', 'CU0', 'RU0', 'SI0', 'HC0'];

interface MonthlyPnL {
  [code: string]: Map<string, number>;
}

function aggregateMonthly(trades: TradeLike[]): Map<string, number> {
  const monthly = new Map<string, number>();
  for (const t of trades) {
    if (!t.entryDate) continue;
    const month = String(t.entryDate).slice(0, 7); // YYYY-MM
    monthly.set(month, (monthly.get(month) ?? 0) + t.pnl);
  }
  return monthly;
}

function pearson(a: number[], b: number[]): number {
  const n = a.length;
  if (n < 3) return 0;
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    denA += da * da;
    denB += db * db;
  }
  if (denA === 0 || denB === 0) return 0;
  return num / Math.sqrt(denA * denB);
}

async function main() {
  const monthlyByCode: MonthlyPnL = {};
  const successCodes: string[] = [];

  for (const code of TARGETS) {
    const recipe = (TOP1_UNIFIED_PARAMS as any)[code];
    if (!recipe) {
      console.log(`  ${code}: 无参数，跳过`);
      continue;
    }
    try {
      const bars = loadBars(code);
      if (!bars.length) {
        console.log(`  ${code}: 无价格数据，跳过`);
        continue;
      }
      const theo = computeTheoreticalMax(bars, 0.02);
      const res = await runTop1Backtest(code, recipe, bars, theo);
      monthlyByCode[code] = aggregateMonthly(res.trades);
      successCodes.push(code);
      console.log(`  ${code}: ${res.trades.length} 笔交易，覆盖 ${monthlyByCode[code].size} 个月`);
    } catch (e: any) {
      console.log(`  ${code}: 回测失败 - ${e?.message ?? e}`);
    }
  }

  // 对齐共同月份
  const commonMonths = new Set<string>();
  for (const code of successCodes) {
    const months = Array.from(monthlyByCode[code].keys());
    if (commonMonths.size === 0) {
      months.forEach((m) => commonMonths.add(m));
    } else {
      for (const m of Array.from(commonMonths)) {
        if (!monthlyByCode[code].has(m)) commonMonths.delete(m);
      }
    }
  }
  const sortedMonths = Array.from(commonMonths).sort();

  console.log(`\n共同月份数: ${sortedMonths.length}`);
  if (sortedMonths.length < 6) {
    console.log('⚠️ 共同月份太少，相关性结果不可靠，仅作参考');
  }

  // 构建月度收益序列（对齐后）
  const series: { [code: string]: number[] } = {};
  for (const code of successCodes) {
    series[code] = sortedMonths.map((m) => monthlyByCode[code].get(m) ?? 0);
  }

  // 相关性矩阵（成对：只用两品种都有交易的月份算，避免 0 填充稀释）
  const corrMatrix: { [a: string]: { [b: string]: number } } = {};
  const corrN: { [a: string]: { [b: string]: number } } = {};
  for (const a of successCodes) {
    corrMatrix[a] = {};
    corrN[a] = {};
    for (const b of successCodes) {
      if (a === b) {
        corrMatrix[a][b] = 1;
        corrN[a][b] = 0;
        continue;
      }
      const overlapMonths = sortedMonths.filter((m) => {
        const va = monthlyByCode[a].get(m) ?? 0;
        const vb = monthlyByCode[b].get(m) ?? 0;
        return va !== 0 && vb !== 0;
      });
      if (overlapMonths.length < 5) {
        corrMatrix[a][b] = 0; // 样本不足，标记为 0
        corrN[a][b] = overlapMonths.length;
        continue;
      }
      const va = overlapMonths.map((m) => monthlyByCode[a].get(m)!);
      const vb = overlapMonths.map((m) => monthlyByCode[b].get(m)!);
      corrMatrix[a][b] = pearson(va, vb);
      corrN[a][b] = overlapMonths.length;
    }
  }

  // 高相关组合（>0.5，且排除自身，且样本量≥5）
  const highCorr: Array<{ a: string; b: string; corr: number; n: number }> = [];
  for (let i = 0; i < successCodes.length; i++) {
    for (let j = i + 1; j < successCodes.length; j++) {
      const a = successCodes[i];
      const b = successCodes[j];
      const c = corrMatrix[a][b];
      if (Math.abs(c) >= 0.5 && corrN[a][b] >= 5) highCorr.push({ a, b, corr: c, n: corrN[a][b] });
    }
  }
  highCorr.sort((x, y) => Math.abs(y.corr) - Math.abs(x.corr));

  console.log('\n=== 月度收益相关性矩阵 ===');
  const header = '        ' + successCodes.map((c) => c.padStart(7)).join('');
  console.log(header);
  for (const a of successCodes) {
    const row = a.padEnd(6) + successCodes.map((b) => corrMatrix[a][b].toFixed(2).padStart(7)).join('');
    console.log(row);
  }

  console.log('\n=== 高相关组合（|corr|≥0.5，需分散）===');
  if (highCorr.length === 0) {
    console.log('  无高相关组合，底仓分散良好');
  } else {
    for (const h of highCorr) {
      const flag = h.corr > 0 ? '同向' : '反向';
      console.log(`  ${h.a} ↔ ${h.b}: ${h.corr.toFixed(2)} (${flag}, n=${h.n}月)`);
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    targets: successCodes,
    commonMonths: sortedMonths.length,
    monthlyPnl: Object.fromEntries(successCodes.map((c) => [c, Object.fromEntries(sortedMonths.map((m) => [m, monthlyByCode[c].get(m) ?? 0]))])),
    corrMatrix,
    corrN,
    highCorr,
  };
  const outPath = path.join(process.cwd(), 'src/data/portfolioCorrelation.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\n已落盘: ${outPath}`);
}

main().catch((e) => {
  console.error('组合相关性分析失败:', e);
  process.exit(1);
});
