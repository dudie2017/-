/**
 * 5组对照回测实验：基线 / 方案A(edge500) / 方案B(区间开放) / 方案A+B / 方案C(edge2000)
 * 使用 data-cache-daily-long 的10品种全量日线
 */
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine.js';

const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];
const DATA_DIR = path.resolve(process.cwd(), 'data-cache-daily-long');

const EXPERIMENTS = [
  { name: 'G0_基线', edgeLookback: 70, allowRangeTrading: false },
  { name: 'G1_方案A_edge500', edgeLookback: 500, allowRangeTrading: false },
  { name: 'G2_方案B_区间开放', edgeLookback: 70, allowRangeTrading: true },
  { name: 'G3_方案A+B', edgeLookback: 500, allowRangeTrading: true },
  { name: 'G4_方案C_edge2000', edgeLookback: 2000, allowRangeTrading: false },
];

async function main() {
  const codesArg = process.argv[2];
  const expNameArg = process.argv[3];
  const codes = codesArg ? codesArg.split(',') : CODES;
  const exps = expNameArg ? EXPERIMENTS.filter(e => e.name === expNameArg) : EXPERIMENTS;

  for (const exp of exps) {
    console.log(`\n===== ${exp.name} =====`);
    const t0 = Date.now();
    const result = await runBacktest({
      dataDir: DATA_DIR,
      codes,
      edgeLookback: exp.edgeLookback,
      allowRangeTrading: exp.allowRangeTrading,
      minSignalGrade: 'L3',
      maxHoldDays: 5,
      warmupBars: 60,
      returnAllTrades: true,
    });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const s = result.summary;
    console.log(JSON.stringify({
      exp: exp.name,
      elapsedSec: elapsed,
      totalTrades: s.totalTrades,
      wins: s.wins,
      losses: s.losses,
      winRate: s.winRate,
      profitFactor: s.profitFactor,
      totalPnl: s.finalEquity - 500000,
      totalReturnPct: s.totalReturn * 100,
      maxDrawdown: s.maxDrawdown,
      sharpe: s.sharpeRatio,
      avgRR: s.avgRR,
    }, null, 2));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
