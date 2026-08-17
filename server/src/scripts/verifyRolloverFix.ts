/**
 * 验证换月跳空修复：对指定品种跑一次回测，统计 exitReason='rollover' 的交易数
 */
import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const CODE = process.argv[2] || 'CU0';
const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8'));
  const bars = (Array.isArray(raw) ? raw : raw.bars || []) as Array<{
    date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number;
  }>;
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  return rows;
}

async function main() {
  console.log(`[${CODE}] 预扫描信号中...`);
  const rows = await getPrescannedRows(CODE, 70, false);
  const signalCache = new Map<string, V16Row[]>([[CODE, rows]]);
  console.log(`[${CODE}] 预扫描信号数: ${rows.length}`);

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

  const trades = result.trades || [];
  const byReason: Record<string, number> = {};
  for (const t of trades) {
    byReason[t.exitReason] = (byReason[t.exitReason] || 0) + 1;
  }

  console.log(`\n[${CODE}] 总交易数: ${trades.length}`);
  console.log('出场原因分布:');
  for (const [reason, count] of Object.entries(byReason)) {
    console.log(`  ${reason}: ${count}`);
  }

  const rolloverTrades = trades.filter((t: any) => t.exitReason === 'rollover');
  console.log(`\n换月平仓交易: ${rolloverTrades.length} 笔`);
  for (const t of rolloverTrades.slice(0, 8)) {
    console.log(`  ${t.code} ${t.direction} ${t.signalDate}入场 -> ${t.exitDate}换月平仓 盈亏${t.pnl}元 持仓${t.holdDays}天`);
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
