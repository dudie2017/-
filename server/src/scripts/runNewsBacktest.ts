/**
 * 全品种 20 年新闻/黑天鹅回测执行脚本
 * 运行：npx tsx src/scripts/runNewsBacktest.ts
 * 输出：data/newsBacktestResult.json + 控制台摘要
 */
import { writeFileSync } from 'fs';
import { analyzeVariety, listVarietyCodes, loadVarietyBars, aggregateAfter } from '../services/newsBacktestEngine';
import type { AfterStats, VarietyShockStats } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

interface EventSample {
  code: string;
  eventBarDate: string;
  gapPct: number;
  dayRet: number;
  after3: number;
  after5: number;
  after10: number;
  after20: number;
  contrarian10: boolean;
}

interface EventBacktest {
  id: string;
  title: string;
  category: number;
  categoryName: string;
  date: string;
  direction: string;
  samples: EventSample[];
  avgAfter10: number;
  contrarianRate: number;
}

/** 事件库逐事件回测：定位事件日后最近交易日，统计事件后收益与反直觉率 */
function runEventBacktest() {
  const results: EventBacktest[] = [];
  for (const ev of BLACK_SWAN_EVENTS) {
    const samples: EventSample[] = [];
    for (const code of ev.varieties) {
      let bars: ReturnType<typeof loadVarietyBars>;
      try {
        bars = loadVarietyBars(code);
      } catch {
        continue;
      }
      // 定位事件日后第一个交易日
      const idx = bars.findIndex((b) => b.date >= ev.date);
      if (idx < 0 || idx + 20 >= bars.length) continue;
      const base = bars[idx];
      const prev = bars[idx - 1];
      if (!prev || prev.c <= 0) continue;
      const gapPct = ((base.o - prev.c) / prev.c) * 100;
      const dayRet = ((base.c - prev.c) / prev.c) * 100;
      const after3 = ((bars[idx + 3].c - base.c) / base.c) * 100;
      const after5 = ((bars[idx + 5].c - base.c) / base.c) * 100;
      const after10 = ((bars[idx + 10].c - base.c) / base.c) * 100;
      const after20 = ((bars[idx + 20].c - base.c) / base.c) * 100;
      // 反直觉：共识预期方向 vs 10日实际走势
      let contrarian10 = false;
      if (ev.direction === '利多' && after10 < 0) contrarian10 = true;
      if (ev.direction === '利空' && after10 > 0) contrarian10 = true;
      samples.push({ code, eventBarDate: base.date, gapPct, dayRet, after3, after5, after10, after20, contrarian10 });
    }
    if (samples.length === 0) continue;
    const avgAfter10 = samples.reduce((s, x) => s + x.after10, 0) / samples.length;
    const contrarianRate = samples.filter((s) => s.contrarian10).length / samples.length;
    results.push({ ...ev, samples, avgAfter10, contrarianRate });
  }
  return results;
}

interface Summary {
  varietyCount: number;
  totalShocks: number;
  avgShocksPerVariety: number;
  upShocks: number;
  downShocks: number;
  after: Record<number, AfterStats>;
  breakdownRate: number;
  contrarianRate10: number;
  resonance: {
    resonanceCount: number;
    resonanceAfter10Mean: number;
    resonanceWinRate: number;
    divergenceCount: number;
    divergenceAfter10Mean: number;
    divergenceWinRate: number;
  };
}

function main() {
  const codes = listVarietyCodes();
  console.log(`开始回测，共 ${codes.length} 个品种...`);

  const all: VarietyShockStats[] = [];
  let totalShocks = 0;
  let upShocks = 0;
  let downShocks = 0;
  let breakdown = 0;
  let contrarian = 0;
  const resonanceAfter10: number[] = [];
  const divergenceAfter10: number[] = [];

  for (const code of codes) {
    try {
      const bars = loadVarietyBars(code);
      const stats = analyzeVariety(code, bars);
      all.push(stats);
      totalShocks += stats.total;
      upShocks += stats.upCount;
      downShocks += stats.downCount;
      breakdown += Math.round(stats.breakdownRate * stats.total);
      contrarian += Math.round(stats.contrarianRate10 * stats.total);
      resonanceAfter10.push(...Array(stats.resonance.resonanceCount).fill(stats.resonance.resonanceAfter10Mean));
      divergenceAfter10.push(...Array(stats.resonance.divergenceCount).fill(stats.resonance.divergenceAfter10Mean));
      console.log(
        `  ${code}: 冲击 ${stats.total} 次 (↑${stats.upCount}/↓${stats.downCount}) | 击穿率 ${(stats.breakdownRate * 100).toFixed(1)}% | 反直觉率 ${(stats.contrarianRate10 * 100).toFixed(1)}%`
      );
    } catch (e) {
      console.log(`  ${code}: 跳过（${(e as Error).message}）`);
    }
  }

  // 汇总统计
  const summary: Summary = {
    varietyCount: all.length,
    totalShocks,
    avgShocksPerVariety: all.length ? totalShocks / all.length : 0,
    upShocks,
    downShocks,
    after: {},
    breakdownRate: totalShocks ? breakdown / totalShocks : 0,
    contrarianRate10: totalShocks ? contrarian / totalShocks : 0,
    resonance: {
      resonanceCount: resonanceAfter10.length,
      resonanceAfter10Mean: resonanceAfter10.length ? resonanceAfter10.reduce((s, x) => s + x, 0) / resonanceAfter10.length : 0,
      resonanceWinRate: resonanceAfter10.length ? resonanceAfter10.filter((x) => x > 0).length / resonanceAfter10.length : 0,
      divergenceCount: divergenceAfter10.length,
      divergenceAfter10Mean: divergenceAfter10.length ? divergenceAfter10.reduce((s, x) => s + x, 0) / divergenceAfter10.length : 0,
      divergenceWinRate: divergenceAfter10.length ? divergenceAfter10.filter((x) => x > 0).length / divergenceAfter10.length : 0,
    },
  };

  // 汇总 after 统计
  for (const n of [3, 5, 10, 20]) {
    const list = all.map((s) => s.after[n]).filter((a) => a.count > 0);
    summary.after[n] = aggregateAfter(list, n);
  }

  // 保存结果
  writeFileSync('data/newsBacktestResult.json', JSON.stringify({ summary, varieties: all }, null, 2), 'utf-8');

  // 打印汇总
  console.log('\n========== 全市场汇总 ==========');
  console.log(`品种数: ${summary.varietyCount} | 总冲击: ${summary.totalShocks} (↑${upShocks}/↓${downShocks})`);
  console.log(`平均每品种冲击次数: ${summary.avgShocksPerVariety.toFixed(1)}`);
  console.log('\n冲击后收益:');
  for (const n of [3, 5, 10, 20]) {
    const a = summary.after[n];
    console.log(
      `  N=${n}: 平均 ${a.mean.toFixed(2)}% | 中位 ${a.median.toFixed(2)}% | 胜率 ${(a.winRate * 100).toFixed(1)}% | 最大回撤 ${a.avgMaxDD.toFixed(2)}%`
    );
  }
  console.log(`\n技术位击穿率: ${(summary.breakdownRate * 100).toFixed(1)}%`);
  console.log(`10日反直觉率: ${(summary.contrarianRate10 * 100).toFixed(1)}%`);
  console.log('\n共振/背离（10日）:');
  console.log(`  共振: ${summary.resonance.resonanceCount} 次, 平均 ${summary.resonance.resonanceAfter10Mean.toFixed(2)}%, 胜率 ${(summary.resonance.resonanceWinRate * 100).toFixed(1)}%`);
  console.log(`  背离: ${summary.resonance.divergenceCount} 次, 平均 ${summary.resonance.divergenceAfter10Mean.toFixed(2)}%, 胜率 ${(summary.resonance.divergenceWinRate * 100).toFixed(1)}%`);

  writeFileSync('data/newsBacktestSummary.json', JSON.stringify(summary, null, 2), 'utf-8');
  console.log('\n结果已保存: data/newsBacktestResult.json');

  // ===== 事件库逐事件回测 =====
  console.log('\n\n========== 事件库逐事件回测 ==========');
  const eventResults = runEventBacktest();
  writeFileSync('data/eventBacktestResult.json', JSON.stringify(eventResults, null, 2), 'utf-8');

  // 按类别聚合
  const catAgg: Record<number, { name: string; count: number; samples: number; avgAfter10: number; contrarian: number }> = {};
  for (const r of eventResults) {
    const c = catAgg[r.category] || { name: r.categoryName, count: 0, samples: 0, avgAfter10: 0, contrarian: 0 };
    c.count++;
    c.samples += r.samples.length;
    c.avgAfter10 += r.avgAfter10;
    c.contrarian += r.contrarianRate;
    catAgg[r.category] = c;
  }
  console.log('\n按事件类别汇总:');
  console.log(`  ${'类别'.padEnd(8)}${'事件数'.padStart(6)}${'样本'.padStart(6)}${'平均10日%'.padStart(10)}${'反直觉率%'.padStart(10)}`);
  const sortedCats = Object.entries(catAgg).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [cat, v] of sortedCats) {
    console.log(
      `  ${v.name.padEnd(8)}${v.count.toString().padStart(6)}${v.samples.toString().padStart(6)}${(v.avgAfter10 / v.count).toFixed(2).padStart(10)}${((v.contrarian / v.count) * 100).toFixed(1).padStart(10)}`
    );
  }
  console.log('\n事件明细（前 15 条）:');
  console.log(`  ${'事件'.padEnd(14)}${'日期'.padStart(12)}${'类别'.padStart(8)}${'样本'.padStart(6)}${'10日%'.padStart(8)}${'反直觉%'.padStart(8)}`);
  for (const r of eventResults.slice(0, 15)) {
    console.log(
      `  ${r.title.slice(0, 13).padEnd(14)}${r.date.padStart(12)}${r.categoryName.padStart(8)}${r.samples.length.toString().padStart(6)}${r.avgAfter10.toFixed(2).padStart(8)}${(r.contrarianRate * 100).toFixed(0).padStart(8)}`
    );
  }
  console.log('\n事件回测结果已保存: data/eventBacktestResult.json');
}

main();
