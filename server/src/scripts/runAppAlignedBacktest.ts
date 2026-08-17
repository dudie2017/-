/**
 * 回测④ — 最终验证
 * 
 * 两种模式对比：
 * 1. 基线(当前App): 原始参数
 * 2. 基线+融合: EMA20趋势过滤 + 冷却期
 * 
 * 运行：cd server && npx tsx src/scripts/runAppAlignedBacktest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from '../services/backtestEngine.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_DIR = path.join(__dirname, '../../src/data');
const LONG_DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

const APP_PARAMS = {
  startCapital: 500000,
  maxPositionPct: 0.15,
  minSignalGrade: 'L2',
  maxHoldDays: 15,
  warmupBars: 50,
  cooldownBars: 0,
  equationMode: 'none' as const,
  allowRangeTrading: true,
  pThreshold: 0.45,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  nonGreenMul: 1.0,
  counterCampMul: 1.0,
  campWindow: 21,
  returnAllTrades: true,
  dataDir: LONG_DATA_DIR,
};

function calcMaxDrawdown(equityCurve: { date: string; equity: number }[], startCapital: number) {
  let peak = startCapital;
  let maxDD = 0;
  let maxDDDate = '';
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (peak - pt.equity) / peak;
    if (dd > maxDD) { maxDD = dd; maxDDDate = pt.date; }
  }
  return { maxDD: Math.round(maxDD * 10000) / 100, maxDDDate };
}

function printReport(label: string, result: any, startCapital: number) {
  const { summary } = result;
  const dd = calcMaxDrawdown(result.equityCurve, startCapital);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
  console.log(`  笔数: ${summary.totalSignals}  胜率: ${(summary.winRate * 100).toFixed(1)}%  PF: ${summary.profitFactor.toFixed(2)}`);
  console.log(`  收益: ${(summary.totalReturn * 100).toFixed(1)}%  回撤: ${(summary.maxDrawdown * 100).toFixed(1)}%  Sharpe: ${summary.sharpeRatio.toFixed(2)}`);
  console.log(`  区间: ${result.params.startDate} ~ ${result.params.endDate}`);

  return { summary, dd };
}

async function main() {
  console.log('='.repeat(60));
  console.log('  回测④ -- 最终验证');
  console.log('  基线 vs 基线+融合(EMA20趋势过滤+冷却期)');
  console.log('='.repeat(60));

  // 基线
  console.log('\n>>> [1/2] 基线...');
  const t0 = Date.now();
  const baseline = await runBacktest(APP_PARAMS);
  console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  const b = printReport('基线', baseline, APP_PARAMS.startCapital);

  // 融合
  console.log('\n>>> [2/2] 融合...');
  const t1 = Date.now();
  const fusion = await runBacktest({ ...APP_PARAMS, cooldownBars: 3, trendFilter: true });
  console.log(`   ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  const f = printReport('融合', fusion, APP_PARAMS.startCapital);

  // 对比
  console.log('\n' + '='.repeat(60));
  console.log('  对比');
  console.log('='.repeat(60));
  console.log('  配置        笔数    胜率    PF     收益     回撤    Sharpe');
  console.log(`  基线     ${String(b.summary.totalSignals).padStart(6)}  ${(b.summary.winRate*100).toFixed(1).padStart(5)}%  ${b.summary.profitFactor.toFixed(2).padStart(5)}  ${(b.summary.totalReturn*100).toFixed(0).padStart(6)}%  ${(b.summary.maxDrawdown*100).toFixed(1).padStart(5)}%  ${b.summary.sharpeRatio.toFixed(2)}`);
  console.log(`  融合     ${String(f.summary.totalSignals).padStart(6)}  ${(f.summary.winRate*100).toFixed(1).padStart(5)}%  ${f.summary.profitFactor.toFixed(2).padStart(5)}  ${(f.summary.totalReturn*100).toFixed(0).padStart(6)}%  ${(f.summary.maxDrawdown*100).toFixed(1).padStart(5)}%  ${f.summary.sharpeRatio.toFixed(2)}`);

  console.log(`\n  标准: PF>=2.5, 回撤<=20%`);
  console.log(`  基线: PF=${b.summary.profitFactor.toFixed(2)} ${b.summary.profitFactor >= 2.5 ? 'PASS' : 'FAIL'}, 回撤=${(b.summary.maxDrawdown*100).toFixed(1)}% ${b.summary.maxDrawdown <= 0.2 ? 'PASS' : 'FAIL'}`);
  console.log(`  融合: PF=${f.summary.profitFactor.toFixed(2)} ${f.summary.profitFactor >= 2.5 ? 'PASS' : 'FAIL'}, 回撤=${(f.summary.maxDrawdown*100).toFixed(1)}% ${f.summary.maxDrawdown <= 0.2 ? 'PASS' : 'FAIL'}`);

  // 保存
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, 'finalBacktest.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    baseline: { summary: b.summary, dd: b.dd },
    fusion: { summary: f.summary, dd: f.dd },
  }, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('  完成');
  console.log('='.repeat(60));
}

main().catch(console.error);
