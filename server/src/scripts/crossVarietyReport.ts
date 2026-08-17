/**
 * 跨品种对比分析报告
 * 分析 37 个品种的回测结果，生成综合对比报告
 */
import { promises as fs } from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src/data');

interface VarietyResult {
  code: string;
  totalPnl: number;
  returnPct: number;
  profitFactor: number;
  winRate: number;
  maxDrawdown: number;
  totalTrades: number;
  bars: number;
}

async function loadVarietyResult(code: string): Promise<VarietyResult | null> {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    const baseline = data.baseline;
    const stats = baseline.stats || baseline;
    return {
      code,
      totalPnl: stats.totalPnl || 0,
      returnPct: stats.returnPct || 0,
      profitFactor: stats.profitFactor || 0,
      winRate: stats.winRate || 0,
      maxDrawdown: stats.maxDrawdown || 0,
      totalTrades: stats.totalTrades || 0,
      bars: data.meta.bars,
    };
  } catch {
    return null;
  }
}

async function main() {
  const varieties = [
    // 黑色系
    'JM0', 'J0', 'I0', 'RB0', 'HC0',
    // 有色
    'CU0', 'AL0', 'NI0', 'PB0', 'ZN0', 'SI0',
    // 贵金属
    'AU0', 'AG0',
    // 能源化工
    'SC0', 'FU0', 'BU0', 'TA0', 'MA0', 'EG0', 'EB0',
    // 农产品
    'M0', 'P0', 'Y0', 'CF0', 'SR0', 'SP0', 'C0', 'CS0', 'JD0', 'RM0',
    // 金融
    'IF0', 'IC0', 'IH0', 'IM0',
    // 其他
    'LH0', 'RU0',
  ];

  console.log('=== 跨品种对比分析报告 ===\n');
  console.log(`分析品种数：${varieties.length}\n`);

  const results: VarietyResult[] = [];
  for (const code of varieties) {
    const result = await loadVarietyResult(code);
    if (result) {
      results.push(result);
    } else {
      console.log(`[跳过] ${code} - 数据文件不存在`);
    }
  }

  console.log(`\n成功加载：${results.length} 个品种\n`);

  // 按收益排序
  const byPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
  console.log('=== 按总收益排序 (Top 10) ===');
  byPnl.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.code}: ${r.totalPnl.toLocaleString()} 元 (${(r.returnPct * 100).toFixed(1)}%)`);
  });

  // 按 PF 排序
  const byPF = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  console.log('\n=== 按 Profit Factor 排序 (Top 10) ===');
  byPF.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.code}: PF=${r.profitFactor.toFixed(2)}`);
  });

  // 按胜率排序
  const byWR = [...results].sort((a, b) => b.winRate - a.winRate);
  console.log('\n=== 按胜率排序 (Top 10) ===');
  byWR.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.code}: ${r.winRate.toFixed(3)}`);
  });

  // 按最大回撤排序（越小越好）
  const byDD = [...results].sort((a, b) => a.maxDrawdown - b.maxDrawdown);
  console.log('\n=== 按最大回撤排序 (Top 10, 越小越好) ===');
  byDD.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.code}: ${(r.maxDrawdown * 100).toFixed(1)}%`);
  });

  // 综合评分
  console.log('\n=== 综合评分 (Top 10) ===');
  const scored = results.map(r => ({
    ...r,
    score: r.profitFactor * 0.4 + r.winRate * 100 * 0.3 + (1 - r.maxDrawdown) * 100 * 0.3,
  })).sort((a, b) => b.score - a.score);

  scored.slice(0, 10).forEach((r, i) => {
    console.log(`  ${i + 1}. ${r.code}: score=${r.score.toFixed(2)} (PF=${r.profitFactor.toFixed(2)}, WR=${r.winRate.toFixed(3)}, DD=${(r.maxDrawdown * 100).toFixed(1)}%)`);
  });

  // 板块对比
  console.log('\n=== 板块平均表现 ===');
  const sectors: Record<string, VarietyResult[]> = {
    '黑色系': results.filter(r => ['JM0', 'J0', 'I0', 'RB0', 'HC0'].includes(r.code)),
    '有色': results.filter(r => ['CU0', 'AL0', 'NI0', 'PB0', 'ZN0', 'SI0'].includes(r.code)),
    '贵金属': results.filter(r => ['AU0', 'AG0'].includes(r.code)),
    '能源化工': results.filter(r => ['SC0', 'FU0', 'BU0', 'TA0', 'MA0', 'EG0', 'EB0'].includes(r.code)),
    '农产品': results.filter(r => ['M0', 'P0', 'Y0', 'CF0', 'SR0', 'SP0', 'C0', 'CS0', 'JD0', 'RM0'].includes(r.code)),
    '金融': results.filter(r => ['IF0', 'IC0', 'IH0', 'IM0'].includes(r.code)),
    '其他': results.filter(r => ['LH0', 'RU0'].includes(r.code)),
  };

  for (const [sector, vars] of Object.entries(sectors)) {
    if (vars.length === 0) continue;
    const avgPF = vars.reduce((s, v) => s + v.profitFactor, 0) / vars.length;
    const avgWR = vars.reduce((s, v) => s + v.winRate, 0) / vars.length;
    const avgDD = vars.reduce((s, v) => s + v.maxDrawdown, 0) / vars.length;
    console.log(`  ${sector} (${vars.length} 品种): 平均 PF=${avgPF.toFixed(2)}, 平均胜率=${avgWR.toFixed(3)}, 平均回撤=${(avgDD * 100).toFixed(1)}%`);
  }

  console.log('\n=== 报告完成 ===');
}

main().catch(console.error);
