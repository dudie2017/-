/**
 * P3 参数敏感性分析 Excel 报告
 * Sheet1: 总评仪表盘
 * Sheet2: 各品种扰动明细
 * Sheet3: 参数稳健性热力图
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

const jsonPath = (() => {
  const files = fs.readdirSync(path.join(process.cwd(), 'backtest-results'))
    .filter((f) => f.startsWith('parameter-sensitivity-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) { console.error('未找到 parameter-sensitivity JSON'); process.exit(1); }
  return path.join(process.cwd(), 'backtest-results', files[0]);
})();

interface Perturbation {
  param: string; label: string; value: any; originalValue: any;
  type: 'numeric' | 'enum';
  totalPnl: number; maxDrawdown: number;
  profitFactor: number; winRate: number; totalTrades: number;
  pnlChangePct: number; verdict: 'robust' | 'sensitive' | 'overfit';
}
interface VarietyResult {
  code: string;
  baseline: { totalPnl: number; maxDrawdown: number; profitFactor: number; winRate: number; totalTrades: number };
  perturbations: Perturbation[];
  summary: { robustCount: number; sensitiveCount: number; overfitCount: number; mostSensitiveParam: string; overallVerdict: string };
}

const results: VarietyResult[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));

async function main() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'P3 Parameter Sensitivity';
  wb.created = new Date();

  const BLUE = 'FF2563EB';
  const DARK = 'FF1E293B';
  const GREEN = 'FF059669';
  const RED = 'FFDC2626';
  const ORANGE = 'FFD97706';
  const WHITE = 'FFFFFFFF';
  const LIGHT_GREEN = 'FFD1FAE5';
  const LIGHT_RED = 'FFFEE2E2';
  const LIGHT_ORANGE = 'FFFEF3C7';
  const LIGHT_GRAY = 'FFF1F5F9';

  const headerFont = { bold: true, color: { argb: WHITE }, size: 11 };
  const headerFill = (argb: string) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });
  const thinBorder = {
    top: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    bottom: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    left: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
    right: { style: 'thin' as const, color: { argb: 'FFD1D5DB' } },
  };

  // ═══════════════════════════════════════════════
  // Sheet1: 总评仪表盘
  // ═══════════════════════════════════════════════
  const ws1 = wb.addWorksheet('总评仪表盘');

  ws1.mergeCells('A1:H1');
  ws1.getCell('A1').value = 'P3 参数敏感性分析 — 总评仪表盘';
  ws1.getCell('A1').font = { bold: true, size: 16, color: { argb: DARK } };
  ws1.getRow(1).height = 36;

  ws1.mergeCells('A2:H2');
  ws1.getCell('A2').value = '对 6 个稳健品种的 TOP1 配方逐维度做 ±20% 扰动，检验参数是否过拟合';
  ws1.getCell('A2').font = { size: 10, color: { argb: 'FF64748B' } };

  // 总评表
  let row = 4;
  const dashHeaders = ['品种', '总评', '稳健', '敏感', '过拟合', '最敏感参数', 'Baseline收益', 'Baseline回撤'];
  dashHeaders.forEach((h, i) => {
    const c = ws1.getCell(row, i + 1);
    c.value = h;
    c.font = headerFont;
    c.fill = headerFill(BLUE) as any;
    c.alignment = { horizontal: 'center' };
    c.border = thinBorder;
  });
  row++;

  for (const r of results) {
    ws1.getCell(row, 1).value = r.code;
    ws1.getCell(row, 1).font = { bold: true };
    ws1.getCell(row, 1).border = thinBorder;

    const verdictCell = ws1.getCell(row, 2);
    const verdictMap: Record<string, { text: string; color: string; bg: string }> = {
      robust: { text: '✅ 稳健', color: GREEN, bg: LIGHT_GREEN },
      sensitive: { text: '⚠️ 敏感', color: ORANGE, bg: LIGHT_ORANGE },
      overfit: { text: '❌ 过拟合', color: RED, bg: LIGHT_RED },
    };
    const v = verdictMap[r.summary.overallVerdict] || verdictMap.sensitive;
    verdictCell.value = v.text;
    verdictCell.font = { bold: true, color: { argb: v.color } };
    verdictCell.fill = headerFill(v.bg) as any;
    verdictCell.alignment = { horizontal: 'center' };
    verdictCell.border = thinBorder;

    ws1.getCell(row, 3).value = r.summary.robustCount;
    ws1.getCell(row, 3).font = { color: { argb: GREEN } };
    ws1.getCell(row, 3).alignment = { horizontal: 'center' };
    ws1.getCell(row, 3).border = thinBorder;

    ws1.getCell(row, 4).value = r.summary.sensitiveCount;
    ws1.getCell(row, 4).font = { color: { argb: ORANGE } };
    ws1.getCell(row, 4).alignment = { horizontal: 'center' };
    ws1.getCell(row, 4).border = thinBorder;

    ws1.getCell(row, 5).value = r.summary.overfitCount;
    ws1.getCell(row, 5).font = { color: { argb: RED } };
    ws1.getCell(row, 5).alignment = { horizontal: 'center' };
    ws1.getCell(row, 5).border = thinBorder;

    ws1.getCell(row, 6).value = r.summary.mostSensitiveParam;
    ws1.getCell(row, 6).border = thinBorder;

    ws1.getCell(row, 7).value = r.baseline.totalPnl;
    ws1.getCell(row, 7).numFmt = '#,##0';
    ws1.getCell(row, 7).border = thinBorder;

    ws1.getCell(row, 8).value = r.baseline.maxDrawdown;
    ws1.getCell(row, 8).numFmt = '0.0%';
    ws1.getCell(row, 8).alignment = { horizontal: 'center' };
    ws1.getCell(row, 8).border = thinBorder;
    row++;
  }

  // 结论
  row += 2;
  ws1.getCell(`A${row}`).value = '关键发现';
  ws1.getCell(`A${row}`).font = { bold: true, size: 12, color: { argb: BLUE } };
  row++;

  const findings = [
    '1. RB0 最稳健：所有 23 个扰动变体全部盈利，参数无过拟合风险',
    '2. SC0 接近稳健：仅 minSignalGrade 降级时收益下降 69%，其余全盈利',
    '3. CF0/NI0 敏感但不过拟合：trendFilter 和 minSignalGrade 是主要敏感源，但所有变体仍盈利',
    '4. AL0/IM0 存在过拟合风险：minSignalGrade 变化直接导致亏损，信号等级阈值是核心瓶颈',
    '5. 跨品种共性：minSignalGrade 和 trendFilter 是最常见的敏感参数，说明信号质量过滤是策略核心',
    '6. 建议：AL0/IM0 需要更保守的信号等级设置，或在实盘中增加信号确认机制',
  ];
  for (const f of findings) {
    ws1.getCell(`A${row}`).value = f;
    ws1.getCell(`A${row}`).font = { size: 10 };
    ws1.mergeCells(`A${row}:H${row}`);
    row++;
  }

  // 列宽
  ws1.getColumn(1).width = 10;
  ws1.getColumn(2).width = 14;
  ws1.getColumn(3).width = 8;
  ws1.getColumn(4).width = 8;
  ws1.getColumn(5).width = 8;
  ws1.getColumn(6).width = 18;
  ws1.getColumn(7).width = 16;
  ws1.getColumn(8).width = 14;

  // ═══════════════════════════════════════════════
  // Sheet2: 各品种扰动明细
  // ═══════════════════════════════════════════════
  const ws2 = wb.addWorksheet('扰动明细');

  ws2.mergeCells('A1:K1');
  ws2.getCell('A1').value = 'P3 参数扰动明细（每个变体 vs Baseline）';
  ws2.getCell('A1').font = { bold: true, size: 16, color: { argb: DARK } };
  ws2.getRow(1).height = 36;

  let r2 = 3;
  for (const r of results) {
    // 品种标题
    ws2.getCell(`A${r2}`).value = `${r.code} (Baseline: 收益 ${r.baseline.totalPnl.toFixed(0)} | 回撤 ${(r.baseline.maxDrawdown * 100).toFixed(1)}% | PF ${r.baseline.profitFactor.toFixed(2)})`;
    ws2.getCell(`A${r2}`).font = { bold: true, size: 12, color: { argb: BLUE } };
    ws2.mergeCells(`A${r2}:K${r2}`);
    r2++;

    // 表头
    const detailHeaders = ['参数', '标签', '原始值', '扰动值', '类型', '收益', '回撤', 'PF', '胜率', '交易数', '判定'];
    detailHeaders.forEach((h, i) => {
      const c = ws2.getCell(r2, i + 1);
      c.value = h;
      c.font = headerFont;
      c.fill = headerFill(BLUE) as any;
      c.alignment = { horizontal: 'center' };
      c.border = thinBorder;
    });
    r2++;

    for (const p of r.perturbations) {
      ws2.getCell(r2, 1).value = p.param;
      ws2.getCell(r2, 1).border = thinBorder;
      ws2.getCell(r2, 2).value = p.label;
      ws2.getCell(r2, 2).border = thinBorder;
      ws2.getCell(r2, 3).value = String(p.originalValue);
      ws2.getCell(r2, 3).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 3).border = thinBorder;
      ws2.getCell(r2, 4).value = String(p.value);
      ws2.getCell(r2, 4).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 4).border = thinBorder;
      ws2.getCell(r2, 5).value = p.type === 'numeric' ? '数值' : '枚举';
      ws2.getCell(r2, 5).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 5).border = thinBorder;
      ws2.getCell(r2, 6).value = p.totalPnl;
      ws2.getCell(r2, 6).numFmt = '#,##0';
      ws2.getCell(r2, 6).border = thinBorder;
      ws2.getCell(r2, 7).value = p.maxDrawdown;
      ws2.getCell(r2, 7).numFmt = '0.0%';
      ws2.getCell(r2, 7).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 7).border = thinBorder;
      ws2.getCell(r2, 8).value = p.profitFactor;
      ws2.getCell(r2, 8).numFmt = '0.00';
      ws2.getCell(r2, 8).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 8).border = thinBorder;
      ws2.getCell(r2, 9).value = p.winRate;
      ws2.getCell(r2, 9).numFmt = '0.0%';
      ws2.getCell(r2, 9).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 9).border = thinBorder;
      ws2.getCell(r2, 10).value = p.totalTrades;
      ws2.getCell(r2, 10).alignment = { horizontal: 'center' };
      ws2.getCell(r2, 10).border = thinBorder;

      const verdictCell = ws2.getCell(r2, 11);
      const vm: Record<string, { text: string; color: string; bg: string }> = {
        robust: { text: '✅ 稳健', color: GREEN, bg: LIGHT_GREEN },
        sensitive: { text: '⚠️ 敏感', color: ORANGE, bg: LIGHT_ORANGE },
        overfit: { text: '❌ 过拟合', color: RED, bg: LIGHT_RED },
      };
      const vv = vm[p.verdict] || vm.robust;
      verdictCell.value = vv.text;
      verdictCell.font = { bold: true, color: { argb: vv.color } };
      verdictCell.fill = headerFill(vv.bg) as any;
      verdictCell.alignment = { horizontal: 'center' };
      verdictCell.border = thinBorder;

      // 收益变化百分比标注
      const pnlCell = ws2.getCell(r2, 6);
      if (p.verdict === 'overfit') {
        pnlCell.font = { color: { argb: RED } };
      } else if (p.verdict === 'sensitive') {
        pnlCell.font = { color: { argb: ORANGE } };
      }

      r2++;
    }
    r2++; // 空行
  }

  // 列宽
  ws2.getColumn(1).width = 18;
  ws2.getColumn(2).width = 14;
  ws2.getColumn(3).width = 10;
  ws2.getColumn(4).width = 10;
  ws2.getColumn(5).width = 8;
  ws2.getColumn(6).width = 14;
  ws2.getColumn(7).width = 10;
  ws2.getColumn(8).width = 8;
  ws2.getColumn(9).width = 8;
  ws2.getColumn(10).width = 8;
  ws2.getColumn(11).width = 12;

  // ═══════════════════════════════════════════════
  // Sheet3: 参数稳健性热力图
  // ═══════════════════════════════════════════════
  const ws3 = wb.addWorksheet('稳健性热力图');

  ws3.mergeCells('A1:H1');
  ws3.getCell('A1').value = 'P3 参数稳健性热力图（按品种 × 参数聚合）';
  ws3.getCell('A1').font = { bold: true, size: 16, color: { argb: DARK } };
  ws3.getRow(1).height = 36;

  // 收集所有参数
  const allParams = new Set<string>();
  for (const r of results) {
    for (const p of r.perturbations) allParams.add(p.param);
  }
  const paramList = [...allParams];

  // 按品种 × 参数 聚合：取该参数所有变体中最差的 pnlChangePct
  let r3 = 3;
  ws3.getCell(r3, 1).value = '品种 \\ 参数';
  ws3.getCell(r3, 1).font = headerFont;
  ws3.getCell(r3, 1).fill = headerFill(BLUE) as any;
  ws3.getCell(r3, 1).border = thinBorder;

  paramList.forEach((p, i) => {
    const cell = ws3.getCell(r3, i + 2);
    cell.value = p;
    cell.font = headerFont;
    cell.fill = headerFill(BLUE) as any;
    cell.alignment = { horizontal: 'center', wrapText: true };
    cell.border = thinBorder;
  });
  r3++;

  for (const r of results) {
    ws3.getCell(r3, 1).value = r.code;
    ws3.getCell(r3, 1).font = { bold: true };
    ws3.getCell(r3, 1).border = thinBorder;

    paramList.forEach((param, i) => {
      const cell = ws3.getCell(r3, i + 2);
      const paramPerturbations = r.perturbations.filter((p) => p.param === param);
      if (paramPerturbations.length === 0) {
        cell.value = '-';
        cell.fill = headerFill(LIGHT_GRAY) as any;
      } else {
        const worstChange = Math.min(...paramPerturbations.map((p) => p.pnlChangePct));
        const hasOverfit = paramPerturbations.some((p) => p.verdict === 'overfit');
        const hasSensitive = paramPerturbations.some((p) => p.verdict === 'sensitive');

        cell.value = `${worstChange > 0 ? '+' : ''}${worstChange.toFixed(0)}%`;
        cell.alignment = { horizontal: 'center' };

        if (hasOverfit) {
          cell.fill = headerFill(LIGHT_RED) as any;
          cell.font = { bold: true, color: { argb: RED } };
        } else if (hasSensitive) {
          cell.fill = headerFill(LIGHT_ORANGE) as any;
          cell.font = { color: { argb: ORANGE } };
        } else {
          cell.fill = headerFill(LIGHT_GREEN) as any;
          cell.font = { color: { argb: GREEN } };
        }
      }
      cell.border = thinBorder;
    });
    r3++;
  }

  // 图例
  r3 += 2;
  ws3.getCell(`A${r3}`).value = '图例：';
  ws3.getCell(`A${r3}`).font = { bold: true };
  r3++;
  const legends = [
    { text: '绿色 = 稳健（所有变体收益变化 < 50%）', bg: LIGHT_GREEN, color: GREEN },
    { text: '橙色 = 敏感（部分变体收益变化 > 50%，但仍盈利）', bg: LIGHT_ORANGE, color: ORANGE },
    { text: '红色 = 过拟合（某些变体导致亏损）', bg: LIGHT_RED, color: RED },
  ];
  for (const l of legends) {
    ws3.getCell(r3, 1).value = l.text;
    ws3.getCell(r3, 1).font = { color: { argb: l.color } };
    ws3.getCell(r3, 1).fill = headerFill(l.bg) as any;
    ws3.mergeCells(`A${r3}:D${r3}`);
    r3++;
  }

  // 列宽
  ws3.getColumn(1).width = 10;
  for (let i = 2; i <= paramList.length + 1; i++) ws3.getColumn(i).width = 14;

  // 保存
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `P3-parameter-sensitivity-${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log('\n已输出:', outPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
