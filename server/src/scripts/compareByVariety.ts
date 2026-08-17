/**
 * G0(基线) vs G2(方案B) 按品种分解对比
 */
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine.js';

const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];
const DATA_DIR = path.resolve(process.cwd(), 'data-cache-daily-long');

async function runOne(code: string, cfg: { name: string; edgeLookback: number; allowRangeTrading: boolean }) {
  const r = await runBacktest({
    dataDir: DATA_DIR,
    codes: [code],
    edgeLookback: cfg.edgeLookback,
    allowRangeTrading: cfg.allowRangeTrading,
    minSignalGrade: 'L3',
    maxHoldDays: 5,
    warmupBars: 60,
    returnAllTrades: true,
  });
  const s = r.summary;
  return {
    code,
    trades: s.totalTrades,
    winRate: s.winRate ?? 0,
    pf: s.profitFactor ?? 0,
    pnl: s.finalEquity - 500000,
    maxDd: s.maxDrawdown ?? 0,
  };
}

async function main() {
  const G0 = { name: 'G0', edgeLookback: 70, allowRangeTrading: false };
  const G2 = { name: 'G2', edgeLookback: 70, allowRangeTrading: true };

  console.log('品种   G0交易 G0胜率  G0收益 | G2交易 G2胜率  G2收益  Δ收益');
  let sumG0 = 0, sumG2 = 0;
  for (const code of CODES) {
    const r0 = await runOne(code, G0);
    const r2 = await runOne(code, G2);
    sumG0 += r0.pnl; sumG2 += r2.pnl;
    console.log(
      `${code}   ${String(r0.trades).padStart(4)}  ${r0.winRate.toFixed(1).padStart(5)}%  ${r0.pnl.toFixed(0).padStart(9)} | ` +
      `${String(r2.trades).padStart(4)}  ${r2.winRate.toFixed(1).padStart(5)}%  ${r2.pnl.toFixed(0).padStart(9)}  ${(r2.pnl - r0.pnl).toFixed(0).padStart(9)}`
    );
  }
  console.log(
    '合计     ' +
    sumG0.toFixed(0).padStart(21) + ' | ' +
    sumG2.toFixed(0).padStart(16) + ' ' +
    (sumG2 - sumG0).toFixed(0).padStart(9)
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
