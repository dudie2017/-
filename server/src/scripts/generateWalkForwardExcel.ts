/**
 * 生成 Walk-forward 分段验证 Excel 报告
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const dir = path.join(process.cwd(), 'backtest-results');

function latestJson(prefix: string): string {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  if (files.length === 0) throw new Error(`未找到 ${prefix} 结果文件`);
  return files.sort().pop()!;
}

async function main(): Promise<void> {
  const wfFile = latestJson('top1-walkforward-');
  const fullFile = latestJson('top1-fullwindow-backtest-');

  const wf = JSON.parse(fs.readFileSync(path.join(dir, wfFile), 'utf-8'));
  const full = JSON.parse(fs.readFileSync(path.join(dir, fullFile), 'utf-8'));

  const results = wf.results;
  const fullList = Array.isArray(full.results) ? full.results : Object.values(full.results);
  const fullMap = new Map(fullList.map((r: any) => [r.code, r]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Quant Backtest';
  wb.created = new Date();

  // ===== Sheet 1: 分段验证汇总 =====
  const ws1 = wb.addWorksheet('Walkforward分段验证', { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [
    '品种', '方向', '选参窗口', '全样本收益', '全样本回撤%',
    '盈利段数', '评级', '段1', '段2', '段3', '段4', '段5', '最后段收益',
  ];
  const headerRow = ws1.addRow(headers);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  headerRow.alignment = { horizontal: 'center', vertical: 'middle' };

  const verdictColor: Record<string, string> = {
    稳健: 'FF059669',
    中等: 'FFD97706',
    脆弱: 'FFDC2626',
  };

  const order: Record<string, number> = { 稳健: 0, 中等: 1, 脆弱: 2 };
  const sorted = [...results].sort((a: any, b: any) => order[a.verdict] - order[b.verdict] || b.fullPnl - a.fullPnl);

  for (const r of sorted) {
    const segPnl = r.segments.map((s: any) => Math.round(s.totalPnl));
    const row = ws1.addRow([
      r.code,
      r.directionMode,
      r.dataWindow,
      Math.round(r.fullPnl),
      +(r.fullMdd * 100).toFixed(1),
      `${r.profitableSegments}/${r.segments.length}`,
      r.verdict,
      ...segPnl,
      Math.round(r.lastSegmentPnl),
    ]);
    const vCell = row.getCell(7);
    vCell.font = { bold: true, color: { argb: verdictColor[r.verdict] ?? 'FF000000' } };
    // 负收益段标红
    for (let i = 0; i < r.segments.length; i++) {
      const cell = row.getCell(8 + i);
      if (r.segments[i].totalPnl < 0) cell.font = { color: { argb: 'FFDC2626' } };
    }
  }

  // 合计行
  const totalPnl = sorted.reduce((s: number, r: any) => s + r.fullPnl, 0);
  const totalRow = ws1.addRow(['合计', '', '', Math.round(totalPnl), '', '', '', '', '', '', '', '', '']);
  totalRow.font = { bold: true };

  ws1.columns.forEach((col, i) => {
    let w = 12;
    if (i === 0) w = 8;
    if (i === 2) w = 10;
    if (i >= 7) w = 12;
    col.width = w;
  });

  // ===== Sheet 2: 稳健品种清单 =====
  const ws2 = wb.addWorksheet('稳健品种清单', { views: [{ state: 'frozen', ySplit: 1 }] });
  const robust = sorted.filter((r: any) => r.verdict === '稳健');
  const h2 = ['品种', '方向', '选参窗口', '全样本收益', '全样本回撤%', '盈利段数', '段收益序列'];
  const hRow2 = ws2.addRow(h2);
  hRow2.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow2.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF059669' } };
  for (const r of robust) {
    ws2.addRow([
      r.code,
      r.directionMode,
      r.dataWindow,
      Math.round(r.fullPnl),
      +(r.fullMdd * 100).toFixed(1),
      `${r.profitableSegments}/${r.segments.length}`,
      r.segments.map((s: any) => Math.round(s.totalPnl)).join(', '),
    ]);
  }
  ws2.columns.forEach((col, i) => {
    col.width = i === 6 ? 40 : 14;
  });

  // ===== Sheet 3: 应剔除品种 =====
  const ws3 = wb.addWorksheet('应剔除品种', { views: [{ state: 'frozen', ySplit: 1 }] });
  const weak = sorted.filter((r: any) => r.verdict === '脆弱' || r.fullPnl < 0);
  const h3 = ['品种', '方向', '评级', '全样本收益', '全样本回撤%', '盈利段数', '剔除原因'];
  const hRow3 = ws3.addRow(h3);
  hRow3.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hRow3.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDC2626' } };
  for (const r of weak) {
    const reasons: string[] = [];
    if (r.verdict === '脆弱') reasons.push('时间不稳定(盈利段≤2)');
    if (r.fullPnl < 0) reasons.push('全样本亏损');
    if (r.fullMdd * 100 > 50) reasons.push(`回撤过高(${+(r.fullMdd * 100).toFixed(1)}%)`);
    ws3.addRow([
      r.code, r.directionMode, r.verdict, Math.round(r.fullPnl),
      +(r.fullMdd * 100).toFixed(1), `${r.profitableSegments}/${r.segments.length}`,
      reasons.join('; ') || '全样本亏损',
    ]);
  }
  ws3.columns.forEach((col, i) => {
    col.width = i === 6 ? 36 : 14;
  });

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outPath = path.join(dir, `Walkforward分段验证_${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`Excel 已生成: ${outPath}`);
  console.log(`稳健 ${robust.length} | 应剔除 ${weak.length}`);
}

main().catch((e) => {
  console.error('Excel 生成失败:', e);
  process.exit(1);
});
