/**
 * P4 费率/滑点压力测试 Excel 报告生成
 */
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';

interface StressResult {
  code: string;
  baselineFeeMult: number;
  baseline: { totalPnl: number; totalReturn: number; mdd: number; sharpe: number; profitFactor: number; totalTrades: number };
  feeStress: {
    multiplier: number;
    totalPnl: number;
    totalReturn: number;
    mdd: number;
    sharpe: number;
    profitFactor: number;
    pnlChangePct: number;
    verdict: 'survive' | 'fragile' | 'dead';
  }[];
  slippageStress: {
    extraTicks: number;
    totalPnl: number;
    totalReturn: number;
    mdd: number;
    sharpe: number;
    profitFactor: number;
    pnlChangePct: number;
    verdict: 'survive' | 'fragile' | 'dead';
  }[];
  summary: {
    feeBreakPoint: string;
    slippageBreakPoint: string;
    overallVerdict: 'survive' | 'fragile' | 'dead';
  };
}

function findLatestFile(): string {
  const dir = path.join(process.cwd(), 'backtest-results');
  const files = fs.readdirSync(dir)
    .filter((f) => f.startsWith('fee-stress-test-') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!files.length) throw new Error('No fee-stress-test JSON found');
  return path.join(dir, files[0]);
}

async function generate() {
  const jsonPath = findLatestFile();
  const data: StressResult[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`读取: ${jsonPath}`);

  const wb = new ExcelJS.Workbook();

  // Sheet 1: 总评仪表盘
  const ws1 = wb.addWorksheet('总评仪表盘');
  ws1.columns = [
    { header: '品种', key: 'code', width: 10 },
    { header: 'Baseline 收益', key: 'baselinePnl', width: 16 },
    { header: 'Baseline 回撤', key: 'baselineMdd', width: 14 },
    { header: 'Baseline 夏普', key: 'baselineSharpe', width: 14 },
    { header: '费率盈亏平衡', key: 'feeBreak', width: 16 },
    { header: '3x费率收益变化', key: 'fee3xChange', width: 18 },
    { header: '滑点盈亏平衡', key: 'slipBreak', width: 16 },
    { header: '+2tick收益变化', key: 'slip2tChange', width: 18 },
    { header: '总评', key: 'verdict', width: 12 },
  ];

  // Header styling
  ws1.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws1.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };

  for (const r of data) {
    const fee3x = r.feeStress.find((f) => f.multiplier === 3);
    const slip2t = r.slippageStress.find((s) => s.extraTicks === 2);
    const verdictText = r.summary.overallVerdict === 'survive' ? '✅ 通过' : r.summary.overallVerdict === 'fragile' ? '⚠️ 脆弱' : '❌ 淘汰';

    const row = ws1.addRow({
      code: r.code,
      baselinePnl: r.baseline.totalPnl,
      baselineMdd: r.baseline.mdd,
      baselineSharpe: r.baseline.sharpe,
      feeBreak: r.summary.feeBreakPoint,
      fee3xChange: fee3x ? `${fee3x.pnlChangePct.toFixed(1)}%` : '-',
      slipBreak: r.summary.slippageBreakPoint,
      slip2tChange: slip2t ? `${slip2t.pnlChangePct.toFixed(1)}%` : '-',
      verdict: verdictText,
    });

    // Color the verdict
    const verdictCell = row.getCell('verdict');
    if (r.summary.overallVerdict === 'survive') {
      verdictCell.font = { color: { argb: 'FF27AE60' }, bold: true };
    } else if (r.summary.overallVerdict === 'fragile') {
      verdictCell.font = { color: { argb: 'FFF39C12' }, bold: true };
    } else {
      verdictCell.font = { color: { argb: 'FFE74C3C' }, bold: true };
    }

    row.getCell('baselinePnl').numFmt = '#,##0';
    row.getCell('baselineMdd').numFmt = '0.0%';
    row.getCell('baselineSharpe').numFmt = '0.00';
  }

  // Sheet 2: 费率压力明细
  const ws2 = wb.addWorksheet('费率压力明细');
  ws2.columns = [
    { header: '品种', key: 'code', width: 10 },
    { header: '费率倍数', key: 'mult', width: 12 },
    { header: '收益', key: 'pnl', width: 16 },
    { header: '收益率', key: 'ret', width: 12 },
    { header: '最大回撤', key: 'mdd', width: 12 },
    { header: '夏普', key: 'sharpe', width: 10 },
    { header: '盈亏比', key: 'pf', width: 10 },
    { header: '收益变化%', key: 'change', width: 14 },
    { header: '判定', key: 'verdict', width: 10 },
  ];
  ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };

  for (const r of data) {
    for (const f of r.feeStress) {
      const row = ws2.addRow({
        code: r.code,
        mult: `${f.multiplier}x`,
        pnl: f.totalPnl,
        ret: f.totalReturn,
        mdd: f.mdd,
        sharpe: f.sharpe,
        pf: f.profitFactor,
        change: f.pnlChangePct,
        verdict: f.verdict === 'survive' ? '✅' : f.verdict === 'fragile' ? '⚠️' : '❌',
      });
      row.getCell('pnl').numFmt = '#,##0';
      row.getCell('ret').numFmt = '0.0%';
      row.getCell('mdd').numFmt = '0.0%';
      row.getCell('sharpe').numFmt = '0.00';
      row.getCell('pf').numFmt = '0.00';
      row.getCell('change').numFmt = '0.0';

      // Color change
      if (f.pnlChangePct < -50) {
        row.getCell('change').font = { color: { argb: 'FFE74C3C' }, bold: true };
      }
    }
  }

  // Sheet 3: 滑点压力明细
  const ws3 = wb.addWorksheet('滑点压力明细');
  ws3.columns = [
    { header: '品种', key: 'code', width: 10 },
    { header: '额外滑点', key: 'ticks', width: 12 },
    { header: '收益', key: 'pnl', width: 16 },
    { header: '收益率', key: 'ret', width: 12 },
    { header: '最大回撤', key: 'mdd', width: 12 },
    { header: '夏普', key: 'sharpe', width: 10 },
    { header: '盈亏比', key: 'pf', width: 10 },
    { header: '收益变化%', key: 'change', width: 14 },
    { header: '判定', key: 'verdict', width: 10 },
  ];
  ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };

  for (const r of data) {
    for (const s of r.slippageStress) {
      const row = ws3.addRow({
        code: r.code,
        ticks: `+${s.extraTicks}tick`,
        pnl: s.totalPnl,
        ret: s.totalReturn,
        mdd: s.mdd,
        sharpe: s.sharpe,
        pf: s.profitFactor,
        change: s.pnlChangePct,
        verdict: s.verdict === 'survive' ? '✅' : s.verdict === 'fragile' ? '⚠️' : '❌',
      });
      row.getCell('pnl').numFmt = '#,##0';
      row.getCell('ret').numFmt = '0.0%';
      row.getCell('mdd').numFmt = '0.0%';
      row.getCell('sharpe').numFmt = '0.00';
      row.getCell('pf').numFmt = '0.00';
      row.getCell('change').numFmt = '0.0';
    }
  }

  // Sheet 4: 实盘部署建议
  const ws4 = wb.addWorksheet('实盘部署建议');
  ws4.columns = [
    { header: '品种', key: 'code', width: 10 },
    { header: 'P1 Walk-forward', key: 'wf', width: 18 },
    { header: 'P3 参数敏感性', key: 'sensitivity', width: 18 },
    { header: 'P4 费率压力', key: 'feeStress', width: 18 },
    { header: 'P4 滑点压力', key: 'slipStress', width: 18 },
    { header: '综合评级', key: 'rating', width: 14 },
    { header: '部署建议', key: 'action', width: 30 },
  ];
  ws4.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws4.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2C3E50' } };

  // P1/P3 结果（从之前的分析中硬编码）
  const p1Results: Record<string, string> = {
    RB0: '✅ 稳健', SC0: '✅ 稳健', CF0: '✅ 稳健', NI0: '✅ 稳健',
  };
  const p3Results: Record<string, string> = {
    RB0: '✅ 铁底 (23/23)', SC0: '✅ 稳健 (22/23)', CF0: '⚠️ 敏感 (16/23)', NI0: '⚠️ 敏感 (17/23)',
  };

  for (const r of data) {
    const feeOk = r.summary.overallVerdict === 'survive' ? '✅ 全部通过' : r.summary.overallVerdict === 'fragile' ? '⚠️ 部分脆弱' : '❌ 有淘汰';
    const slipOk = r.summary.overallVerdict === 'survive' ? '✅ 全部通过' : r.summary.overallVerdict === 'fragile' ? '⚠️ 部分脆弱' : '❌ 有淘汰';

    // 综合评级
    const p3Ok = p3Results[r.code].startsWith('✅');
    const allOk = p1Results[r.code].startsWith('✅') && p3Ok && r.summary.overallVerdict === 'survive';
    const rating = allOk ? '⭐⭐⭐ 优先上线' : p3Ok ? '⭐⭐ 可上线' : '⭐ 谨慎上线';
    const action = allOk
      ? '立即部署，参数可微调'
      : p3Ok
        ? '可部署，保持TOP1参数'
        : '降仓部署，密切监控';

    ws4.addRow({
      code: r.code,
      wf: p1Results[r.code],
      sensitivity: p3Results[r.code],
      feeStress: feeOk,
      slipStress: slipOk,
      rating,
      action,
    });
  }

  // 输出
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `P4-fee-stress-test-${ts}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`已输出: ${outPath}`);
}

generate().catch((e) => {
  console.error(e);
  process.exit(1);
});
