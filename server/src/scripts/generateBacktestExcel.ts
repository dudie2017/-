import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS, TOP3_BACKUP } from '../data/top1UnifiedParams';

interface BacktestStats {
  totalTrades: number;
  longTrades: number;
  shortTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  avgRR: number;
  longCapture: number;
  shortCapture: number;
  capture: number;
  maxDrawdown: number;
  longPnl: number;
  shortPnl: number;
}

interface BacktestResult {
  code: string;
  recipe: Record<string, unknown>;
  stats: BacktestStats;
}

interface ResultFile {
  meta: { generatedAt: string; codes: number };
  results: Record<string, BacktestResult>;
}

const RESULTS_DIR = path.join(process.cwd(), 'backtest-results');

function findLatestResult(): ResultFile {
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.startsWith('top1-unified-backtest-') && f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error('未找到 top1-unified-backtest 结果文件');
  const latest = files[files.length - 1];
  const raw = fs.readFileSync(path.join(RESULTS_DIR, latest), 'utf8');
  return JSON.parse(raw) as ResultFile;
}

const FIELD_LABELS: Record<string, string> = {
  minSignalGrade: '信号等级门槛',
  trendFilter: '趋势过滤',
  cooldownBars: '冷却K线数',
  edgeLookback: '边际回看窗口',
  allowRangeTrading: '允许区间交易',
  equationMode: '方程模式',
  pThreshold: '概率阈值',
  softEquationMul: '软方程乘数',
  stopAtrMult: '止损ATR倍数',
  targetAtrMult: '止盈ATR倍数',
  maxHoldDays: '最大持仓天数',
  minRR: '最小盈亏比',
  maxPositionPct: '最大仓位比例',
  directionMode: '方向模式',
  dataWindow: '数据窗口',
  nonGreenMul: '非绿阵营乘数',
  counterCampMul: '反向阵营乘数',
  campWindow: '阵营窗口',
  bsMode: '黑天鹅模式',
  circuitBreaker: '熔断设置',
  volReduce: '波动缩减',
  dailyLossLimit: '日亏损限制',
  feeMult: '手续费倍数',
  startCapital: '起始资金',
};

const DIRECTION_LABELS: Record<string, string> = {
  both: '双向',
  split: '分向',
  longOnly: '只做多',
  shortOnly: '只做空',
};

function riskFlag(r: BacktestResult): string {
  const flags: string[] = [];
  if (r.stats.totalTrades < 20) flags.push('小样本');
  if (r.stats.maxDrawdown > 0.5) flags.push('高回撤');
  if (r.stats.totalPnl < 0) flags.push('亏损');
  if (r.stats.profitFactor < 1) flags.push('PF<1');
  return flags.join('、') || '正常';
}

async function main() {
  const data = findLatestResult();
  const codes = Object.keys(data.results).sort();

  const wb = new ExcelJS.Workbook();
  wb.creator = '量化回测系统';
  wb.created = new Date();

  // ============ Sheet1: 汇总 ============
  const s1 = wb.addWorksheet('TOP1回测汇总', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });
  const headerFill: ExcelJS.Fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F3864' },
  };
  const headerFont: Partial<ExcelJS.Font> = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };

  s1.mergeCells('A1:U1');
  const title = s1.getCell('A1');
  title.value = `TOP1 完整配方统一回测报告（26 品种）· 生成时间 ${data.meta.generatedAt}`;
  title.font = { bold: true, size: 14, color: { argb: 'FF1F3864' } };
  title.alignment = { vertical: 'middle', horizontal: 'left' };
  s1.getRow(1).height = 24;

  const summaryCols = [
    '品种', '方向', '数据窗口', '总交易', '多单', '空单', '胜率(%)', '总收益(元)',
    '最大回撤(%)', '盈亏比PF', '捕获率(%)', '多头收益', '空头收益', '风险标注',
  ];
  const summaryHeader = s1.addRow(summaryCols);
  summaryHeader.eachCell((c) => {
    c.fill = headerFill;
    c.font = headerFont;
    c.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  let totalPnlSum = 0;
  let totalTradesSum = 0;
  let totalWinsSum = 0;
  let totalLosses = 0;

  for (const code of codes) {
    const r = data.results[code];
    const recipe = r.recipe as Record<string, unknown>;
    const row = s1.addRow([
      code,
      DIRECTION_LABELS[recipe.directionMode as string] || recipe.directionMode,
      recipe.dataWindow,
      r.stats.totalTrades,
      r.stats.longTrades,
      r.stats.shortTrades,
      +(r.stats.winRate * 100).toFixed(1),
      Math.round(r.stats.totalPnl),
      +(r.stats.maxDrawdown * 100).toFixed(1),
      +r.stats.profitFactor.toFixed(2),
      +(r.stats.capture * 100).toFixed(1),
      Math.round(r.stats.longPnl),
      Math.round(r.stats.shortPnl),
      riskFlag(r),
    ]);
    totalPnlSum += r.stats.totalPnl;
    totalTradesSum += r.stats.totalTrades;
    totalWinsSum += r.stats.wins;
    if (r.stats.totalPnl < 0) totalLosses++;

    // 风险行高亮
    const flag = riskFlag(r);
    if (flag !== '正常') {
      const color = r.stats.totalPnl < 0 ? 'FFFCE4EC' : 'FFFFF3CD';
      row.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; });
    }
    row.eachCell((c) => { c.alignment = { vertical: 'middle' }; });
  }

  // 合计行
  const sumRow = s1.addRow([
    '合计/均值', '', '', totalTradesSum, '', '',
    +(totalTradesSum ? (totalWinsSum / totalTradesSum) * 100 : 0).toFixed(1),
    Math.round(totalPnlSum), '', '', '', '', '',
    `亏损品种 ${totalLosses} 个`,
  ]);
  sumRow.eachCell((c) => {
    c.font = { bold: true };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDEEAF6' } };
    c.alignment = { vertical: 'middle' };
  });

  s1.columns.forEach((col, i) => {
    let w = 12;
    if (i === 0) w = 10;
    if (i === 4 || i === 7 || i === 11 || i === 12) w = 14;
    col.width = w;
  });

  // ============ Sheet2: 完整配方明细 ============
  const s2 = wb.addWorksheet('完整配方明细', {
    views: [{ state: 'frozen', ySplit: 1, xSplit: 1 }],
  });
  const fieldKeys = Object.keys(FIELD_LABELS);
  const detailHeader = s2.addRow(['品种', ...fieldKeys.map((k) => FIELD_LABELS[k])]);
  detailHeader.eachCell((c) => {
    c.fill = headerFill;
    c.font = headerFont;
    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  });
  s2.getRow(1).height = 30;

  for (const code of codes) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    const vals = fieldKeys.map((k) => {
      const v = recipe[k as keyof typeof recipe];
      if (k === 'directionMode') return DIRECTION_LABELS[v as string] || v;
      if (typeof v === 'boolean') return v ? '是' : '否';
      return v;
    });
    const row = s2.addRow([code, ...vals]);
    row.eachCell((c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; });
  }
  s2.columns.forEach((col, i) => {
    col.width = i === 0 ? 10 : 14;
  });

  // ============ Sheet3: TOP3 备选配方对比 ============
  const s3 = wb.addWorksheet('TOP3备选配方', {
    views: [{ state: 'frozen', ySplit: 2, xSplit: 1 }],
  });
  s3.mergeCells('A1:K1');
  const t3 = s3.getCell('A1');
  t3.value = '每个品种 TOP1/TOP2/TOP3 备选配方（TOP1 为当前落地配方，TOP2/TOP3 供回退）';
  t3.font = { bold: true, size: 13, color: { argb: 'FF1F3864' } };
  const top3Header = s3.addRow([
    '品种', '排名', '方向', '信号等级', '方程模式', '止损ATR', '止盈ATR', '最大持仓', '数据窗口', '熔断', '仓位上限',
  ]);
  top3Header.eachCell((c) => {
    c.fill = headerFill;
    c.font = headerFont;
    c.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  for (const code of codes) {
    const top3 = TOP3_BACKUP[code] || [];
    top3.forEach((t, i) => {
      const row = s3.addRow([
        code,
        `TOP${i + 1}`,
        DIRECTION_LABELS[t.directionMode] || t.directionMode,
        t.minSignalGrade,
        t.equationMode,
        t.stopAtrMult,
        t.targetAtrMult,
        t.maxHoldDays,
        t.dataWindow,
        t.circuitBreaker,
        t.maxPositionPct,
      ]);
      if (i === 0) {
        row.eachCell((c) => {
          c.font = { bold: true };
          c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } };
        });
      }
      row.eachCell((c) => { c.alignment = { vertical: 'middle', horizontal: 'center' }; });
    });
  }
  s3.columns.forEach((col, i) => {
    col.width = i <= 1 ? 10 : 14;
  });

  // ============ 输出 ============
  const stamp = data.meta.generatedAt.replace(/[-:]/g, '');
  const outPath = path.join(RESULTS_DIR, `TOP1统一回测报告_${stamp}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`Excel 已生成: ${outPath}`);
  console.log(`  品种数: ${codes.length} | 合计收益: ${Math.round(totalPnlSum)} | 合计交易: ${totalTradesSum} | 亏损品种: ${totalLosses}`);
}

main().catch((e) => {
  console.error('生成 Excel 失败:', e);
  process.exit(1);
});
