/**
 * 组合回测 Excel 导出脚本
 * 
 * 将11个A级品种的组合回测结果导出为Excel，包含：
 * - 每笔交易的完整买卖点
 * - 复利权益曲线
 * - 组合统计汇总
 * 
 * 用法：cd server && npx tsx src/scripts/exportPortfolioExcel.ts
 * 输出：server/src/data/组合回测_YYYYMMDD.xlsx
 */

import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

// A级品种（11个）
const A_GRADE = ['JM0', 'RU0', 'AG0', 'CU0', 'AU0', 'RB0', 'CF0', 'J0', 'SI0', 'IM0', 'HC0'];

const CONTRACT_NAMES: Record<string, string> = {
  JM0: '焦煤', RU0: '橡胶', AG0: '白银', CU0: '铜', AU0: '黄金',
  RB0: '螺纹钢', CF0: '棉花', J0: '焦炭', SI0: '工业硅', IM0: '中证1000', HC0: '热卷',
};

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
  console.log('=== 组合回测 Excel 导出 ===');
  console.log(`品种: ${A_GRADE.join(', ')}`);
  console.log('[1/3] 预扫描信号中...');

  const signalCache = new Map<string, V16Row[]>();
  for (const code of A_GRADE) {
    const rows = await getPrescannedRows(code, 70);
    signalCache.set(code, rows);
    console.log(`  ${code}: ${rows.length} 个信号`);
  }

  console.log('[2/3] 运行组合回测...');
  const result: any = await runBacktest({
    startCapital: 500000,
    maxPositionPct: 0.05,
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
    codes: A_GRADE,
    signalCache,
    maxPositions: 6,
    maxPerSector: 2,
    sectorMap: SECTOR_MAP,
  });

  const trades = result.trades || [];
  const s = result.summary;
  const years = 25;
  const annualized = (Math.pow(1 + s.totalReturn, 1 / years) - 1) * 100;

  console.log(`  交易笔数: ${trades.length}`);
  console.log(`  年化收益率: ${annualized.toFixed(2)}%`);
  console.log(`  最大回撤: ${(s.maxDrawdown * 100).toFixed(2)}%`);

  console.log('[3/3] 写入 Excel...');

  // 构建交易数据
  const tradeRows: any[] = [];
  let cumPnl = 0;
  let equity = 500000;
  
  for (const t of trades) {
    cumPnl += t.pnl;
    equity = 500000 + cumPnl;
    
    tradeRows.push({
      code: t.code,
      name: CONTRACT_NAMES[t.code] || t.code,
      sector: SECTOR_MAP[t.code] || '其他',
      direction: t.direction === 'LONG' ? '多' : '空',
      signalDate: t.signalDate,
      entryDate: t.entryDate,
      exitDate: t.exitDate,
      holdDays: t.holdDays,
      entryPrice: t.entryPrice,
      stopLoss: t.stopLoss,
      target: t.target,
      exitPrice: t.exitPrice,
      exitReason: t.exitReason === 'stop' ? '止损' : t.exitReason === 'target' ? '止盈' : t.exitReason === 'timeout' ? '超时' : t.exitReason === 'rollover' ? '换月' : t.exitReason,
      signalGrade: t.signalGrade,
      spectrum: t.spectrum,
      lots: t.lots?.toFixed(1) || '',
      posMul: t.posMul?.toFixed(2) || '',
      pnl: Math.round(t.pnl),
      cumPnl: Math.round(cumPnl),
      equity: Math.round(equity),
      pnlPct: t.pnlPct?.toFixed(2) || '',
      rMultiple: t.rMultiple?.toFixed(2) || '',
      result: t.pnl > 0 ? 'WIN' : t.pnl < 0 ? 'LOSS' : 'EVEN',
    });
  }

  // 创建 Excel
  const wb = new ExcelJS.Workbook();

  // Sheet 1: 交易明细
  const ws1 = wb.addWorksheet('交易明细');
  ws1.columns = [
    { header: '品种代码', key: 'code', width: 10 },
    { header: '品种名称', key: 'name', width: 10 },
    { header: '板块', key: 'sector', width: 8 },
    { header: '方向', key: 'direction', width: 6 },
    { header: '信号日期', key: 'signalDate', width: 12 },
    { header: '入场日期', key: 'entryDate', width: 12 },
    { header: '出场日期', key: 'exitDate', width: 12 },
    { header: '持仓天数', key: 'holdDays', width: 10 },
    { header: '入场价', key: 'entryPrice', width: 12 },
    { header: '止损价', key: 'stopLoss', width: 12 },
    { header: '目标价', key: 'target', width: 12 },
    { header: '出场价', key: 'exitPrice', width: 12 },
    { header: '出场原因', key: 'exitReason', width: 10 },
    { header: '信号等级', key: 'signalGrade', width: 10 },
    { header: '光谱', key: 'spectrum', width: 10 },
    { header: '手数', key: 'lots', width: 8 },
    { header: '仓位倍率', key: 'posMul', width: 10 },
    { header: '盈亏(元)', key: 'pnl', width: 12 },
    { header: '累计盈亏', key: 'cumPnl', width: 14 },
    { header: '当前权益', key: 'equity', width: 14 },
    { header: '盈亏%', key: 'pnlPct', width: 10 },
    { header: 'R倍数', key: 'rMultiple', width: 10 },
    { header: '结果', key: 'result', width: 8 },
  ];

  // 表头样式
  ws1.getRow(1).font = { bold: true };
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const r of tradeRows) {
    ws1.addRow(r);
  }

  // 盈亏着色
  for (let i = 2; i <= tradeRows.length + 1; i++) {
    const row = ws1.getRow(i);
    const pnl = row.getCell('pnl').value as number;
    const result = row.getCell('result').value as string;
    
    if (pnl > 0) {
      row.getCell('pnl').font = { color: { argb: 'FF00B050' }, bold: true };
      row.getCell('cumPnl').font = { color: { argb: 'FF00B050' } };
      row.getCell('equity').font = { color: { argb: 'FF00B050' } };
    } else if (pnl < 0) {
      row.getCell('pnl').font = { color: { argb: 'FFFF0000' }, bold: true };
    }
    
    // 结果列着色
    if (result === 'WIN') {
      row.getCell('result').font = { color: { argb: 'FF00B050' }, bold: true };
    } else if (result === 'LOSS') {
      row.getCell('result').font = { color: { argb: 'FFFF0000' }, bold: true };
    }
  }

  ws1.views = [{ state: 'frozen', ySplit: 1 }];
  ws1.autoFilter = { from: { row: 1, column: 1 }, to: { row: tradeRows.length + 1, column: 23 } };

  // Sheet 2: 品种统计
  const ws2 = wb.addWorksheet('品种统计');
  
  const byCode: Record<string, { trades: number; wins: number; pnl: number; avgPnl: number; maxWin: number; maxLoss: number }> = {};
  for (const t of trades) {
    if (!byCode[t.code]) {
      byCode[t.code] = { trades: 0, wins: 0, pnl: 0, avgPnl: 0, maxWin: 0, maxLoss: 0 };
    }
    const stat = byCode[t.code];
    stat.trades++;
    stat.pnl += t.pnl;
    if (t.pnl > 0) stat.wins++;
    if (t.pnl > stat.maxWin) stat.maxWin = t.pnl;
    if (t.pnl < stat.maxLoss) stat.maxLoss = t.pnl;
  }
  
  const statsRows = Object.entries(byCode)
    .map(([code, stat]) => ({
      code,
      name: CONTRACT_NAMES[code] || code,
      sector: SECTOR_MAP[code] || '其他',
      trades: stat.trades,
      wins: stat.wins,
      winRate: stat.trades > 0 ? (stat.wins / stat.trades * 100).toFixed(1) + '%' : '0%',
      totalPnl: Math.round(stat.pnl),
      avgPnl: Math.round(stat.pnl / stat.trades),
      maxWin: Math.round(stat.maxWin),
      maxLoss: Math.round(stat.maxLoss),
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

  ws2.columns = [
    { header: '品种代码', key: 'code', width: 10 },
    { header: '品种名称', key: 'name', width: 10 },
    { header: '板块', key: 'sector', width: 8 },
    { header: '交易笔数', key: 'trades', width: 10 },
    { header: '盈利笔数', key: 'wins', width: 10 },
    { header: '胜率', key: 'winRate', width: 10 },
    { header: '总盈亏(元)', key: 'totalPnl', width: 14 },
    { header: '平均盈亏', key: 'avgPnl', width: 12 },
    { header: '最大单笔盈利', key: 'maxWin', width: 14 },
    { header: '最大单笔亏损', key: 'maxLoss', width: 14 },
  ];

  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  for (const r of statsRows) {
    ws2.addRow(r);
  }

  // 盈亏着色
  for (let i = 2; i <= statsRows.length + 1; i++) {
    const row = ws2.getRow(i);
    const pnl = row.getCell('totalPnl').value as number;
    if (pnl > 0) {
      row.getCell('totalPnl').font = { color: { argb: 'FF00B050' }, bold: true };
    } else if (pnl < 0) {
      row.getCell('totalPnl').font = { color: { argb: 'FFFF0000' }, bold: true };
    }
  }

  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  // Sheet 3: 组合汇总
  const ws3 = wb.addWorksheet('组合汇总');
  
  const summaryRows = [
    { item: '回测参数', value: '' },
    { item: '  品种数量', value: `${A_GRADE.length} 个` },
    { item: '  品种列表', value: A_GRADE.map(c => `${c}(${CONTRACT_NAMES[c]})`).join(', ') },
    { item: '  起始资金', value: '500,000 元' },
    { item: '  单品种仓位', value: '5%' },
    { item: '  最大持仓数', value: '6 个品种' },
    { item: '  单板块限制', value: '2 个品种' },
    { item: '', value: '' },
    { item: '回测结果', value: '' },
    { item: '  最终权益', value: `${s.finalEquity?.toLocaleString() || (500000 + trades.reduce((sum: number, t: any) => sum + t.pnl, 0)).toLocaleString()} 元` },
    { item: '  总盈亏', value: `${trades.reduce((sum: number, t: any) => sum + t.pnl, 0).toLocaleString()} 元` },
    { item: '  总收益率', value: `${(s.totalReturn * 100).toFixed(2)}%` },
    { item: '  年化收益率', value: `${annualized.toFixed(2)}%` },
    { item: '  最大回撤', value: `${(s.maxDrawdown * 100).toFixed(2)}%` },
    { item: '  交易笔数', value: `${trades.length}` },
    { item: '  胜率', value: `${(s.winRate * 100).toFixed(1)}%` },
    { item: '  盈亏比(PF)', value: `${s.profitFactor?.toFixed(2) || 'N/A'}` },
    { item: '', value: '' },
    { item: '数据说明', value: '' },
    { item: '  数据来源', value: 'Tushare Pro fut_daily (20年历史日线)' },
    { item: '  回测周期', value: '2000-2025 (约25年)' },
    { item: '  换月处理', value: '换月日强制平仓+不开仓 (Tushare fut_mapping)' },
    { item: '  资金管理', value: '复利模式，按当前权益×5%计算手数' },
    { item: '  风控机制', value: '品种内互斥 + 板块限制 + 最大持仓数' },
  ];

  ws3.columns = [
    { header: '项目', key: 'item', width: 20 },
    { header: '数值', key: 'value', width: 80 },
  ];

  ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };

  for (const r of summaryRows) {
    const row = ws3.addRow(r);
    if (r.item && !r.item.startsWith('  ')) {
      row.getCell('item').font = { bold: true };
      row.getCell('item').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
    }
  }

  ws3.views = [{ state: 'frozen', ySplit: 1 }];

  // 保存
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = path.join(process.cwd(), 'src', 'data', `组合回测_${today}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  
  console.log(`\n✅ 已导出到: ${outPath}`);
  console.log(`   交易明细: ${tradeRows.length} 笔`);
  console.log(`   品种统计: ${statsRows.length} 个品种`);
  console.log(`   组合汇总: 年化${annualized.toFixed(2)}%, 回撤${(s.maxDrawdown * 100).toFixed(2)}%`);
}

main().catch((e) => { console.error(e); process.exit(1); });
