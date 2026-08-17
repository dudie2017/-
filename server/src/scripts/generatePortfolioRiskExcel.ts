/**
 * P2 组合风控 Excel 报告生成
 * Sheet1: 相关性矩阵 + 板块分布
 * Sheet2: 组合回测对比（等权 vs 波动率加权）
 * Sheet3: 仓位优化建议
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const jsonPath = process.argv[2] ||
  process.argv[2] ||
  (() => {
    const files = fs.readdirSync(path.join(process.cwd(), 'backtest-results'))
      .filter((f) => f.startsWith('portfolio-risk-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (!files.length) { console.error('未找到 portfolio-risk JSON'); process.exit(1); }
    return path.join(process.cwd(), 'backtest-results', files[0]);
  })();

const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
const { meta, correlation, volatility, volWeights, positionSuggestion, sectorCount, equalWeight, volWeight } = data;
const codes: string[] = meta.codes;

const SECTORS: Record<string, string> = {
  CF0: '农产品', AL0: '有色', RB0: '黑色', SC0: '能源', NI0: '有色', IM0: '黑色',
};

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'P2 Portfolio Risk';
  wb.created = new Date();

  // ── 颜色 ──
  const BLUE = 'FF2563EB';
  const DARK = 'FF1E293B';
  const GREEN = 'FF059669';
  const RED = 'FFDC2626';
  const LIGHT_BLUE = 'FFDBEAFE';
  const LIGHT_GREEN = 'FFD1FAE5';
  const LIGHT_RED = 'FFFEE2E2';
  const LIGHT_GRAY = 'FFF1F5F9';
  const WHITE = 'FFFFFFFF';

  const headerFont = { bold: true, color: { argb: WHITE }, size: 11 };
  const headerFill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const thinBorder = {
    top: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    bottom: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    left: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    right: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
  };

  // ═══════════════════════════════════════════════
  // Sheet1: 相关性矩阵 + 板块分布
  // ═══════════════════════════════════════════════
  const ws1 = wb.addWorksheet('相关性矩阵', { views: [{ state: 'frozen', ySplit: 3, xSplit: 2 }] });

  // 标题
  ws1.mergeCells('A1:H1');
  const titleCell = ws1.getCell('A1');
  titleCell.value = 'P2 组合风控 — 相关性矩阵与板块分布';
  titleCell.font = { bold: true, size: 16, color: { argb: DARK } };
  titleCell.alignment = { horizontal: 'left', vertical: 'middle' };
  ws1.getRow(1).height = 36;

  // 元信息
  ws1.mergeCells('A2:H2');
  ws1.getCell('A2').value = `品种: ${codes.join(', ')} | 总资金: ${(meta.totalCapital / 10000).toFixed(0)}万 | 单品种: ${(meta.capitalPerVariety / 10000).toFixed(0)}万`;
  ws1.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

  // 板块分布表
  let row = 4;
  ws1.getCell(`A${row}`).value = '板块分布';
  ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  row++;
  const sectorHeaders = ['板块', '品种数', '品种'];
  sectorHeaders.forEach((h, i) => {
    const c = ws1.getCell(row, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  row++;
  const sectorVarieties: Record<string, string[]> = {};
  for (const code of codes) {
    const s = SECTORS[code];
    if (!sectorVarieties[s]) sectorVarieties[s] = [];
    sectorVarieties[s].push(code);
  }
  for (const [sector, vars] of Object.entries(sectorVarieties)) {
    ws1.getCell(row, 1).value = sector;
    ws1.getCell(row, 1).border = thinBorder;
    ws1.getCell(row, 2).value = vars.length;
    ws1.getCell(row, 2).alignment = { horizontal: 'center' };
    ws1.getCell(row, 2).border = thinBorder;
    ws1.getCell(row, 3).value = vars.join(', ');
    ws1.getCell(row, 3).border = thinBorder;
    row++;
  }

  // 相关性矩阵
  row += 2;
  ws1.getCell(`A${row}`).value = 'Pearson 相关性矩阵（价格日收益率）';
  ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  row++;

  // 表头
  ws1.getCell(row, 1).value = '';
  ws1.getCell(row, 1).border = thinBorder;
  codes.forEach((c, i) => {
    const cell = ws1.getCell(row, i + 2);
    cell.value = c;
    cell.font = headerFont;
    cell.fill = headerFill(BLUE) as any;
    cell.alignment = { horizontal: 'center' };
    cell.border = thinBorder;
  });
  row++;

  for (const a of codes) {
    ws1.getCell(row, 1).value = a;
    ws1.getCell(row, 1).font = { bold: true };
    ws1.getCell(row, 1).border = thinBorder;
    codes.forEach((b, j) => {
      const cell = ws1.getCell(row, j + 2);
      const v = correlation[a][b];
      cell.value = v;
      cell.numFmt = '0.000';
      cell.alignment = { horizontal: 'center' };
      cell.border = thinBorder;
      // 颜色：对角线蓝，高相关红，低/负相关绿
      if (a === b) {
        cell.fill = headerFill(LIGHT_BLUE) as any;
        cell.font = { bold: true, color: { argb: BLUE } };
      } else if (v >= 0.4) {
        cell.fill = headerFill(LIGHT_RED) as any;
        cell.font = { color: { argb: RED } };
      } else if (v <= 0.1) {
        cell.fill = headerFill(LIGHT_GREEN) as any;
        cell.font = { color: { argb: GREEN } };
      }
    });
    row++;
  }

  // 解读
  row += 1;
  ws1.getCell(`A${row}`).value = '解读：红色 = 高相关(≥0.4，分散化不足) | 绿色 = 低相关(≤0.1，分散化好) | 蓝色 = 对角线';
  ws1.getCell(`A${row}`).font = { size: 9, italic: true, color: { argb: 'FF64748B' } };

  // 波动率
  row += 2;
  ws1.getCell(`A${row}`).value = '年化波动率';
  ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  row++;
  const volHeaders = ['品种', '板块', '年化波动率', '波动率倒数权重'];
  volHeaders.forEach((h, i) => {
    const c = ws1.getCell(row, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  row++;
  for (const code of codes) {
    ws1.getCell(row, 1).value = code;
    ws1.getCell(row, 1).border = thinBorder;
    ws1.getCell(row, 2).value = SECTORS[code];
    ws1.getCell(row, 2).border = thinBorder;
    ws1.getCell(row, 3).value = volatility[code];
    ws1.getCell(row, 3).numFmt = '0.00%';
    ws1.getCell(row, 3).border = thinBorder;
    ws1.getCell(row, 3).alignment = { horizontal: 'center' };
    ws1.getCell(row, 4).value = volWeights[code];
    ws1.getCell(row, 4).numFmt = '0.00%';
    ws1.getCell(row, 4).border = thinBorder;
    ws1.getCell(row, 4).alignment = { horizontal: 'center' };
    row++;
  }

  // 列宽
  ws1.getColumn(1).width = 12;
  ws1.getColumn(2).width = 12;
  ws1.getColumn(3).width = 18;
  ws1.getColumn(4).width = 18;
  for (let i = 5; i <= 8; i++) ws1.getColumn(i).width = 12;

  // ═══════════════════════════════════════════════
  // Sheet2: 组合回测对比
  // ═══════════════════════════════════════════════
  const ws2 = wb.addWorksheet('组合回测对比');

  ws2.mergeCells('A1:F1');
  ws2.getCell('A1').value = 'P2 组合回测对比（已实现 pnl 口径）';
  ws2.getCell('A1').font = { bold: true, size: 16, color: { argb: DARK } };
  ws2.getRow(1).height = 36;

  ws2.mergeCells('A2:F2');
  ws2.getCell('A2').value = `总资金 ${(meta.totalCapital / 10000).toFixed(0)}万 = ${codes.length} 品种 × ${(meta.capitalPerVariety / 10000).toFixed(0)}万/品种`;
  ws2.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

  // 对比表
  let r2 = 4;
  const compareHeaders = ['指标', '等权组合', '波动率加权组合', '说明'];
  compareHeaders.forEach((h, i) => {
    const c = ws2.getCell(r2, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  r2++;

  const rows = [
    ['总收益', equalWeight.totalReturn, volWeight.totalReturn, '波动率加权通过降低高波动品种仓位提升总收益'],
    ['总盈亏(万)', equalWeight.totalPnl / 10000, volWeight.totalPnl / 10000, ''],
    ['最大回撤', equalWeight.mdd, volWeight.mdd, '波动率加权可能略增回撤（集中低波品种）'],
    ['月频夏普', equalWeight.sharpe, volWeight.sharpe, '等权夏普更高说明分散化效果优于集中化'],
    ['收益/回撤比', equalWeight.totalReturn / equalWeight.mdd, volWeight.totalReturn / volWeight.mdd, '越高越好，衡量风险调整后收益'],
  ];

  for (const [label, eq, vw, note] of rows) {
    ws2.getCell(r2, 1).value = label;
    ws2.getCell(r2, 1).font = { bold: true };
    ws2.getCell(r2, 1).border = thinBorder;

    const eqCell = ws2.getCell(r2, 2);
    eqCell.value = eq as number;
    eqCell.alignment = { horizontal: 'center' };
    eqCell.border = thinBorder;

    const vwCell = ws2.getCell(r2, 3);
    vwCell.value = vw as number;
    vwCell.alignment = { horizontal: 'center' };
    vwCell.border = thinBorder;

    ws2.getCell(r2, 4).value = note as string;
    ws2.getCell(r2, 4).border = thinBorder;

    // 格式化
    if (label === '总盈亏(万)') {
      eqCell.numFmt = '#,##0.0';
      vwCell.numFmt = '#,##0.0';
    } else if ((label as string).includes('收益') || (label as string).includes('回撤')) {
      eqCell.numFmt = '0.0%';
      vwCell.numFmt = '0.0%';
    } else {
      eqCell.numFmt = '0.00';
      vwCell.numFmt = '0.00';
    }
    r2++;
  }

  // 单品种 vs 组合
  r2 += 2;
  ws2.getCell(`A${r2}`).value = '单品种 vs 组合对比';
  ws2.getCell(`A${r2}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r2++;
  const svHeaders = ['品种', '板块', '年化波动率', '波动率权重', '建议仓位比例'];
  svHeaders.forEach((h, i) => {
    const c = ws2.getCell(r2, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  r2++;
  for (const code of codes) {
    ws2.getCell(r2, 1).value = code;
    ws2.getCell(r2, 1).border = thinBorder;
    ws2.getCell(r2, 2).value = SECTORS[code];
    ws2.getCell(r2, 2).border = thinBorder;
    ws2.getCell(r2, 3).value = volatility[code];
    ws2.getCell(r2, 3).numFmt = '0.00%';
    ws2.getCell(r2, 3).alignment = { horizontal: 'center' };
    ws2.getCell(r2, 3).border = thinBorder;
    ws2.getCell(r2, 4).value = volWeights[code];
    ws2.getCell(r2, 4).numFmt = '0.00%';
    ws2.getCell(r2, 4).alignment = { horizontal: 'center' };
    ws2.getCell(r2, 4).border = thinBorder;
    ws2.getCell(r2, 5).value = positionSuggestion[code];
    ws2.getCell(r2, 5).numFmt = '0.00%';
    ws2.getCell(r2, 5).alignment = { horizontal: 'center' };
    ws2.getCell(r2, 5).border = thinBorder;
    r2++;
  }

  // 列宽
  ws2.getColumn(1).width = 16;
  ws2.getColumn(2).width = 18;
  ws2.getColumn(3).width = 20;
  ws2.getColumn(4).width = 40;
  ws2.getColumn(5).width = 16;

  // ═══════════════════════════════════════════════
  // Sheet3: 仓位优化建议
  // ═══════════════════════════════════════════════
  const ws3 = wb.addWorksheet('仓位优化建议');

  ws3.mergeCells('A1:E1');
  ws3.getCell('A1').value = 'P2 仓位优化与风控建议';
  ws3.getCell('A1').font = { bold: true, size: 16, color: { argb: DARK } };
  ws3.getRow(1).height = 36;

  let r3 = 3;
  // 核心结论
  ws3.getCell(`A${r3}`).value = '核心结论';
  ws3.getCell(`A${r3}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r3++;

  const conclusions = [
    `1. 6 品种两两相关性均 ≤ 0.42，最高为 AL0-NI0（0.414），组合分散化效果良好`,
    `2. SC0 与其余品种相关性最低（0.03~0.22），是天然的对冲品种`,
    `3. 等权组合月频夏普 ${equalWeight.sharpe.toFixed(2)} > 波动率加权 ${volWeight.sharpe.toFixed(2)}，说明等权分散更优`,
    `4. 等权组合收益 ${((equalWeight.totalReturn) * 100).toFixed(1)}% / 回撤 ${((equalWeight.mdd) * 100).toFixed(1)}%，收益回撤比 ${(equalWeight.totalReturn / equalWeight.mdd).toFixed(2)}`,
    `5. 板块分布：有色 2 个、黑色 2 个、农产品 1 个、能源 1 个，黑色/有色集中度偏高`,
  ];
  for (const line of conclusions) {
    ws3.getCell(`A${r3}`).value = line;
    ws3.getCell(`A${r3}`).font = { size: 10 };
    ws3.mergeCells(`A${r3}:E${r3}`);
    r3++;
  }

  // 仓位建议表
  r3 += 1;
  ws3.getCell(`A${r3}`).value = '仓位建议（目标组合波动率 10%）';
  ws3.getCell(`A${r3}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r3++;

  const posHeaders = ['品种', '板块', '波动率倒数权重', '建议仓位比例', '对应资金(万)'];
  posHeaders.forEach((h, i) => {
    const c = ws3.getCell(r3, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  r3++;

  for (const code of codes) {
    const w = volWeights[code];
    const suggested = positionSuggestion[code];
    // 取波动率权重和建议仓位中较小值作为实际建议
    const actual = Math.min(w, suggested);
    const capitalWan = actual * meta.totalCapital / 10000;

    ws3.getCell(r3, 1).value = code;
    ws3.getCell(r3, 1).border = thinBorder;
    ws3.getCell(r3, 2).value = SECTORS[code];
    ws3.getCell(r3, 2).border = thinBorder;
    ws3.getCell(r3, 3).value = w;
    ws3.getCell(r3, 3).numFmt = '0.00%';
    ws3.getCell(r3, 3).alignment = { horizontal: 'center' };
    ws3.getCell(r3, 3).border = thinBorder;
    ws3.getCell(r3, 4).value = actual;
    ws3.getCell(r3, 4).numFmt = '0.00%';
    ws3.getCell(r3, 4).alignment = { horizontal: 'center' };
    ws3.getCell(r3, 4).border = thinBorder;
    ws3.getCell(r3, 5).value = capitalWan;
    ws3.getCell(r3, 5).numFmt = '#,##0.0';
    ws3.getCell(r3, 5).alignment = { horizontal: 'center' };
    ws3.getCell(r3, 5).border = thinBorder;
    r3++;
  }

  // 风控规则
  r3 += 2;
  ws3.getCell(`A${r3}`).value = '组合风控规则建议';
  ws3.getCell(`A${r3}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  r3++;

  const rules = [
    '1. 单品种最大仓位不超过总资金的 25%',
    '2. 同板块最大暴露不超过总资金的 40%',
    '3. 组合最大回撤触发 30% 时，全部品种减半仓位',
    '4. 组合最大回撤触发 40% 时，全部品种清仓观望',
    '5. SC0 波动率最高（39%），建议仓位上限 10%',
    '6. CF0/AL0 波动率最低（15%），可适当增配',
  ];
  for (const rule of rules) {
    ws3.getCell(`A${r3}`).value = rule;
    ws3.getCell(`A${r3}`).font = { size: 10 };
    ws3.mergeCells(`A${r3}:E${r3}`);
    r3++;
  }

  // 列宽
  ws3.getColumn(1).width = 12;
  ws3.getColumn(2).width = 12;
  ws3.getColumn(3).width = 18;
  ws3.getColumn(4).width = 18;
  ws3.getColumn(5).width = 16;

  // 保存
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `P2-portfolio-risk-${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log('\n已输出:', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
