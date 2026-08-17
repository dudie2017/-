/**
 * 组合回测：将 A 级品种放在一起，共享资金池 + 组合风控，验证组合年化收益率
 */
import fs from 'fs';
import path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

// A级品种（11个）
const A_GRADE = ['JM0', 'RU0', 'AG0', 'CU0', 'AU0', 'RB0', 'CF0', 'J0', 'SI0', 'IM0', 'HC0'];

// 板块映射
const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', AL0: '有色', ZN0: '有色', NI0: '有色', PB0: '有色',
  AU0: '贵金属', AG0: '贵金属',
  RB0: '黑色', HC0: '黑色', I0: '黑色', J0: '黑色', JM0: '黑色',
  SC0: '能化', RU0: '能化', TA0: '能化',
  CF0: '农产品', Y0: '农产品', P0: '农产品', M0: '农产品',
  IC0: '股指', IF0: '股指', IH0: '股指', IM0: '股指',
  SI0: '其他', SP0: '其他', LH0: '其他',
};

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
  const codes = process.argv[2] ? process.argv[2].split(',') : A_GRADE;
  const maxPositions = parseInt(process.argv[3] || '6', 10);
  const maxPerSector = parseInt(process.argv[4] || '2', 10);

  console.log(`[组合回测] 品种: ${codes.join(', ')}`);
  console.log(`[组合回测] maxPositions=${maxPositions}, maxPerSector=${maxPerSector}`);
  console.log('[组合回测] 预扫描信号中（较耗时）...');

  const signalCache = new Map<string, V16Row[]>();
  for (const code of codes) {
    const rows = await getPrescannedRows(code, 70);
    signalCache.set(code, rows);
    console.log(`  ${code}: ${rows.length} 个信号`);
  }

  const result: any = await runBacktest({
    startCapital: 500000,
    maxPositionPct: 0.05, // v9: 降低到5%，更贴近实际
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
    codes,
    signalCache,
    maxPositions,
    maxPerSector,
    sectorMap: SECTOR_MAP,
  });

  const s = result.summary;
  const years = 25;
  const annualized = (Math.pow(1 + s.totalReturn, 1 / years) - 1) * 100;

  console.log('\n===== 组合回测结果 =====');
  console.log(`品种数: ${codes.length}`);
  console.log(`起始资金: ${result.params.startCapital.toLocaleString()} 元`);
  console.log(`最终权益: ${s.finalEquity.toLocaleString()} 元`);
  console.log(`总盈亏: ${(s.finalEquity - result.params.startCapital).toLocaleString()} 元`);
  console.log(`总收益率: ${(s.totalReturn * 100).toFixed(2)}%`);
  console.log(`最大回撤: ${(s.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`胜率: ${(s.winRate * 100).toFixed(1)}%`);
  console.log(`盈亏比(PF): ${s.profitFactor.toFixed(2)}`);
  console.log(`交易笔数: ${result.trades?.length}`);
  console.log(`年化收益率(复利, ${years}年): ${annualized.toFixed(2)}%`);
  
  // 各品种贡献
  const byCode: Record<string, { pnl: number; trades: number }> = {};
  for (const t of result.trades || []) {
    if (!byCode[t.code]) byCode[t.code] = { pnl: 0, trades: 0 };
    byCode[t.code].pnl += t.pnl;
    byCode[t.code].trades++;
  }
  console.log('\n各品种贡献:');
  for (const [code, v] of Object.entries(byCode).sort((a, b) => b[1].pnl - a[1].pnl)) {
    console.log(`  ${code}: ${v.pnl.toLocaleString()} 元 (${v.trades}笔)`);
  }
}

main().catch((e) => { console.error('[FATAL]', e); process.exit(1); });
