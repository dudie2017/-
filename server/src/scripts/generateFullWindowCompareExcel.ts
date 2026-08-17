/**
 * 生成「全样本(full) vs 原始窗口」对比 Excel
 * 用于 P0：暴露 dataWindow 过拟合（窗口幻觉）品种
 */
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';

const RESULTS_DIR = path.join(process.cwd(), 'backtest-results');

interface Stats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  sharpe?: number;
}
interface Recipe {
  dataWindow: string;
  directionMode: string;
  [k: string]: unknown;
}
interface ResultEntry {
  code: string;
  recipe: Recipe;
  stats: Stats;
}

function latestFile(prefix: string): string {
  const files = fs.readdirSync(RESULTS_DIR).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (files.length === 0) throw new Error(`未找到 ${prefix} 结果文件`);
  return files.sort().pop()!;
}

function loadResults(file: string): Record<string, ResultEntry> {
  const d = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf-8'));
  return d.results as Record<string, ResultEntry>;
}

function classify(origPnl: number, fullPnl: number, fullMdd: number, fullPf: number): string {
  if (origPnl > 0 && fullPnl < 0) return '窗口幻觉(由盈转亏)';
  if (fullPnl < 0) return '全样本亏损';
  if (fullMdd > 70) return '回撤失控(>70%)';
  if (fullMdd > 50) return '高回撤(50~70%)';
  if (origPnl > 0 && fullPnl < origPnl * 0.3) return '收益大幅缩水(>70%)';
  if (fullPf < 1.1) return '盈亏比偏弱(PF<1.1)';
  return '稳健';
}

async function main() {
  const origFile = latestFile('top1-unified-backtest');
  const fullFile = latestFile('top1-fullwindow-backtest');
  const orig = loadResults(origFile);
  const full = loadResults(fullFile);

  const codes = Object.keys(full).sort();

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quant Backtest';
  wb.created = new Date();

  // ===== Sheet 1: 全样本 vs 原始窗口对比 =====
  const ws1 = wb.addWorksheet('全样本vs原始窗口', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws1.columns = [
    { header: '品种', key: 'code', width: 8 },
    { header: '方向', key: 'dir', width: 10 },
    { header: '原始窗口', key: 'dw', width: 12 },
    { header: '原始收益', key: 'origPnl', width: 12 },
    { header: '原始回撤%', key: 'origMdd', width: 11 },
    { header: '原始PF', key: 'origPf', width: 9 },
    { header: '原始交易数', key: 'origTrades', width: 11 },
    { header: '全样本收益', key: 'fullPnl', width: 12 },
    { header: '全样本回撤%', key: 'fullMdd', width: 11 },
    { header: '全样本PF', key: 'fullPf', width: 9 },
    { header: '全样本交易数', key: 'fullTrades', width: 12 },
    { header: '收益变化%', key: 'pnlChange', width: 11 },
    { header: '判定', key: 'verdict', width: 20 },
  ];
  // 表头样式
  const headerRow = ws1.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002FA7' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  const verdictColor: Record<string, string> = {
    '窗口幻觉(由盈转亏)': 'FFC00000',
    '全样本亏损': 'FFC00000',
    '回撤失控(>70%)': 'FFC00000',
    '高回撤(50~70%)': 'FFED7D31',
    '收益大幅缩水(>70%)': 'FFED7D31',
    '盈亏比偏弱(PF<1.1)': 'FFBF8F00',
    稳健: 'FF2E7D32',
  };

  let origTotal = 0;
  let fullTotal = 0;
  let illusionCount = 0;
  let lossCount = 0;

  codes.forEach((code) => {
    const o = orig[code];
    const f = full[code];
    if (!o || !f) return;
    const pnlChange = o.stats.totalPnl !== 0 ? ((f.stats.totalPnl - o.stats.totalPnl) / Math.abs(o.stats.totalPnl)) * 100 : 0;
    const verdict = classify(o.stats.totalPnl, f.stats.totalPnl, f.stats.maxDrawdown * 100, f.stats.profitFactor);
    if (verdict === '窗口幻觉(由盈转亏)') illusionCount++;
    if (f.stats.totalPnl < 0) lossCount++;
    origTotal += o.stats.totalPnl;
    fullTotal += f.stats.totalPnl;

    const row = ws1.addRow({
      code,
      dir: f.recipe.directionMode,
      dw: o.recipe.dataWindow,
      origPnl: Math.round(o.stats.totalPnl),
      origMdd: +(o.stats.maxDrawdown * 100).toFixed(1),
      origPf: +o.stats.profitFactor.toFixed(2),
      origTrades: o.stats.totalTrades,
      fullPnl: Math.round(f.stats.totalPnl),
      fullMdd: +(f.stats.maxDrawdown * 100).toFixed(1),
      fullPf: +f.stats.profitFactor.toFixed(2),
      fullTrades: f.stats.totalTrades,
      pnlChange: +pnlChange.toFixed(0),
      verdict,
    });
    row.getCell('verdict').font = { bold: true, color: { argb: verdictColor[verdict] || 'FF000000' } };
    row.getCell('fullPnl').font = { color: { argb: f.stats.totalPnl >= 0 ? 'FF2E7D32' : 'FFC00000' } };
    row.getCell('fullMdd').font = { color: { argb: f.stats.maxDrawdown * 100 > 50 ? 'FFC00000' : 'FF000000' } };
  });

  // 合计行
  const totalRow = ws1.addRow({
    code: '合计',
    dir: '',
    dw: '',
    origPnl: Math.round(origTotal),
    origMdd: '',
    origPf: '',
    origTrades: '',
    fullPnl: Math.round(fullTotal),
    fullMdd: '',
    fullPf: '',
    fullTrades: '',
    pnlChange: '',
    verdict: `窗口幻觉${illusionCount}个 | 全样本亏损${lossCount}个`,
  });
  totalRow.font = { bold: true };
  totalRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } };

  // ===== Sheet 2: 全样本真实排名（稳健品种优先） =====
  const ws2 = wb.addWorksheet('全样本真实排名', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws2.columns = [
    { header: '排名', key: 'rank', width: 6 },
    { header: '品种', key: 'code', width: 8 },
    { header: '方向', key: 'dir', width: 10 },
    { header: '全样本收益', key: 'pnl', width: 12 },
    { header: '回撤%', key: 'mdd', width: 10 },
    { header: 'PF', key: 'pf', width: 9 },
    { header: '胜率%', key: 'winRate', width: 9 },
    { header: '交易数', key: 'trades', width: 9 },
    { header: '夏普', key: 'sharpe', width: 9 },
    { header: '稳健度评分', key: 'robustScore', width: 12 },
  ];
  const h2 = ws2.getRow(1);
  h2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  h2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF002FA7' } };
  h2.alignment = { horizontal: 'center', vertical: 'middle' };

  const ranked = codes
    .map((code) => {
      const f = full[code];
      const mdd = f.stats.maxDrawdown * 100;
      const pf = f.stats.profitFactor;
      const trades = f.stats.totalTrades;
      // 稳健度评分：收益为正 + PF + 回撤 + 交易数（样本充分性）
      const robustScore =
        f.stats.totalPnl > 0 ? pf * 10 - mdd * 0.5 + Math.min(trades, 100) * 0.1 : -999;
      return { code, f, mdd, pf, robustScore };
    })
    .sort((a, b) => b.robustScore - a.robustScore);

  ranked.forEach((item, i) => {
    const { f, mdd, pf } = item;
    const row = ws2.addRow({
      rank: i + 1,
      code: item.code,
      dir: f.recipe.directionMode,
      pnl: Math.round(f.stats.totalPnl),
      mdd: +mdd.toFixed(1),
      pf: +pf.toFixed(2),
      winRate: +(f.stats.winRate * 100).toFixed(1),
      trades: f.stats.totalTrades,
      sharpe: f.stats.sharpe ? +f.stats.sharpe.toFixed(2) : '',
      robustScore: +item.robustScore.toFixed(1),
    });
    row.getCell('pnl').font = { color: { argb: f.stats.totalPnl >= 0 ? 'FF2E7D32' : 'FFC00000' } };
    if (item.robustScore < 0) {
      row.font = { color: { argb: 'FF9E9E9E' } };
    }
  });

  const outFile = path.join(
    RESULTS_DIR,
    `全样本vs原始窗口对比_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '')}.xlsx`,
  );
  await wb.xlsx.writeFile(outFile);
  console.log('对比 Excel 已生成:', outFile);
  console.log(`窗口幻觉(由盈转亏)品种: ${illusionCount} 个`);
  console.log(`全样本亏损品种: ${lossCount} 个`);
  console.log(`原始窗口合计收益: ${Math.round(origTotal)}, 全样本合计收益: ${Math.round(fullTotal)}`);
}

main().catch((e) => {
  console.error('生成对比 Excel 失败:', e);
  process.exit(1);
});
