import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const CODE = process.argv[2] || 'CU0';
const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

async function getPrescannedRows(code: string, edgeLookback: number): Promise<V16Row[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as any[];
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading: false });
    rows.push(row);
  }
  return rows;
}

async function main() {
  const rows = await getPrescannedRows(CODE, 70);
  const signalCache = new Map<string, V16Row[]>([[CODE, rows]]);

  const result: any = await runBacktest({
    startCapital: 500000,
    maxPositionPct: 0.15,
    minSignalGrade: 'L1',
    maxHoldDays: 15,
    stopAtrMult: 1.5,
    targetAtrMult: 3.0,
    minRR: 1.0,
    cooldownBars: 0,
    trendFilter: false,
    warmupBars: 60,
    returnAllTrades: true,
    quiet: true,
    dataDir: DATA_DIR,
    codes: [CODE],
    signalCache,
  });

  const s = result.summary;
  console.log(`=== ${CODE} 收益率验证（资金管理修复后）===`);
  console.log(`起始资金: ${result.params.startCapital} 元`);
  console.log(`最终权益: ${s.finalEquity.toFixed(0)} 元`);
  console.log(`总盈亏: ${(s.finalEquity - result.params.startCapital).toFixed(0)} 元`);
  console.log(`总收益率: ${(s.totalReturn * 100).toFixed(2)}%`);
  console.log(`最大回撤: ${(s.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`胜率: ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`盈亏比(PF): ${s.profitFactor.toFixed(2)}`);
  console.log(`交易笔数: ${result.trades?.length}`);
  console.log(`持仓手数示例: ${result.trades?.slice(0, 5).map((t: any) => t.lots?.toFixed(2)).join(', ')}`);
  
  const years = 25;
  const annualized = (Math.pow(1 + s.totalReturn, 1 / years) - 1) * 100;
  console.log(`年化收益率(复利, 约${years}年): ${annualized.toFixed(2)}%`);
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
