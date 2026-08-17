import fs from 'fs';
import path from 'path';

const ALL_CODES = [
  'SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0',
  'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0', 'SI0',
  'IC0', 'IF0', 'IH0', 'IM0', 'HC0', 'NI0', 'PB0', 'ZN0', 'SP0'
];

const dataDir = path.join(process.cwd(), 'src/data');

interface ExperimentResult {
  id: number;
  recipe: any;
  stats: {
    totalTrades: number;
    winRate: number;      // 小数格式，如 0.48 = 48%
    totalPnl: number;
    maxDrawdown: number;  // 小数格式，如 0.27 = 27%
    profitFactor: number;
  };
}

interface DataFile {
  meta: any;
  fullResults: ExperimentResult[];
}

console.log('='.repeat(100));
console.log('修复后全品种 1000 次实验评估报告 (V16.2 修复版)');
console.log('='.repeat(100));
console.log('');

const summary: any[] = [];

for (const code of ALL_CODES) {
  const file = path.join(dataDir, `${code}_1000Experiments.json`);
  if (!fs.existsSync(file)) {
    console.log(`❌ ${code} 结果文件不存在`);
    continue;
  }
  
  const data: DataFile = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const experiments: ExperimentResult[] = data.fullResults || [];
  
  if (experiments.length === 0) {
    console.log(`❌ ${code} 无实验数据`);
    continue;
  }
  
  // 基础统计
  const profitable = experiments.filter(e => e.stats.totalPnl > 0);
  const profitablePct = (profitable.length / experiments.length * 100);
  
  const avgPnl = experiments.reduce((s, e) => s + e.stats.totalPnl, 0) / experiments.length;
  const avgWinRate = experiments.reduce((s, e) => s + e.stats.winRate * 100, 0) / experiments.length; // 转为百分比
  const avgDD = experiments.reduce((s, e) => s + e.stats.maxDrawdown * 100, 0) / experiments.length; // 转为百分比
  const avgPF = experiments.reduce((s, e) => s + e.stats.profitFactor, 0) / experiments.length;
  const avgTrades = experiments.reduce((s, e) => s + e.stats.totalTrades, 0) / experiments.length;
  
  // 优质配方统计 (收益>0 且 回撤<30% 且 胜率>=40% 且 PF>=1.0)
  const robust = experiments.filter(e => 
    e.stats.totalPnl > 0 && 
    e.stats.maxDrawdown * 100 < 30 &&  // 转为百分比比较
    e.stats.winRate * 100 >= 40 &&     // 转为百分比比较
    e.stats.profitFactor >= 1.0
  );
  const robustPct = (robust.length / experiments.length * 100);
  
  // TOP3 配方
  const top3 = [...experiments]
    .sort((a, b) => b.stats.totalPnl - a.stats.totalPnl)
    .slice(0, 3);
  
  const bestPnl = top3[0]?.stats.totalPnl.toFixed(0) || '0';
  const bestWinRate = top3[0] ? (top3[0].stats.winRate * 100).toFixed(1) : '0';
  const bestDD = top3[0] ? (top3[0].stats.maxDrawdown * 100).toFixed(1) : '0';
  const bestPF = top3[0]?.stats.profitFactor.toFixed(2) || '0';
  
  summary.push({
    code,
    profitablePct,
    avgPnl: avgPnl.toFixed(0),
    avgWinRate: avgWinRate.toFixed(1),
    avgDD: avgDD.toFixed(1),
    avgPF: avgPF.toFixed(2),
    avgTrades: avgTrades.toFixed(0),
    robustPct,
    bestPnl,
    bestWinRate,
    bestDD,
    bestPF
  });
}

// 打印汇总表
console.log('┌─────┬────────┬──────────┬────────┬────────┬────────┬────────┬────────┬──────────┬──────────┬────────┬────────┐');
console.log('│品种 │ 盈利% │ 平均盈亏 │ 平均胜率│ 平均回撤│ 平均PF │ 平均笔数│ 稳健% │ 最佳盈亏 │ 最佳胜率 │ 最佳回撤│ 最佳PF │');
console.log('├─────┼────────┼──────────┼────────┼────────┼────────┼────────┼────────┼──────────┼──────────┼────────┼────────┤');

for (const s of summary) {
  let grade = 'D';
  if (s.profitablePct >= 60 && s.robustPct >= 30) grade = 'A';
  else if (s.profitablePct >= 50 && s.robustPct >= 20) grade = 'B';
  else if (s.profitablePct >= 40) grade = 'C';
  
  console.log(
    `│ ${s.code.padEnd(3)} │ ${s.profitablePct.toFixed(1).padStart(5)}% │ ${s.avgPnl.padStart(8)} │ ${s.avgWinRate.padStart(5)}% │ ${s.avgDD.padStart(5)}% │ ${s.avgPF.padStart(5)}  │ ${s.avgTrades.padStart(5)}  │ ${s.robustPct.toFixed(1).padStart(5)}% │ ${s.bestPnl.padStart(8)} │ ${s.bestWinRate.padStart(7)}% │ ${s.bestDD.padStart(5)}% │ ${s.bestPF.padStart(5)}  │`
  );
}

console.log('└─────┴────────┴──────────┴────────┴────────┴────────┴────────┴────────┴──────────┴──────────┴────────┴────────┘');
console.log('');

// 品种评级分布
const gradeA = summary.filter(s => s.profitablePct >= 60 && s.robustPct >= 30);
const gradeB = summary.filter(s => s.profitablePct >= 50 && s.robustPct >= 20 && !(s.profitablePct >= 60 && s.robustPct >= 30));
const gradeC = summary.filter(s => s.profitablePct >= 40 && !(s.profitablePct >= 50 && s.robustPct >= 20));
const gradeD = summary.filter(s => s.profitablePct < 40);

console.log('='.repeat(100));
console.log('品种评级分布');
console.log('='.repeat(100));
console.log(`A级 (盈利≥60% 且 稳健≥30%): ${gradeA.length} 个 - ${gradeA.map(s => s.code).join(', ')}`);
console.log(`B级 (盈利≥50% 且 稳健≥20%): ${gradeB.length} 个 - ${gradeB.map(s => s.code).join(', ')}`);
console.log(`C级 (盈利≥40%): ${gradeC.length} 个 - ${gradeC.map(s => s.code).join(', ')}`);
console.log(`D级 (盈利<40%): ${gradeD.length} 个 - ${gradeD.map(s => s.code).join(', ')}`);
console.log('');

// TOP5 品种
console.log('='.repeat(100));
console.log('TOP5 优质品种 (按盈利比例排序)');
console.log('='.repeat(100));
const top5 = [...summary].sort((a, b) => b.profitablePct - a.profitablePct).slice(0, 5);
for (let i = 0; i < top5.length; i++) {
  const s = top5[i];
  console.log(`#${i+1} ${s.code}: 盈利${s.profitablePct.toFixed(1)}% 稳健${s.robustPct.toFixed(1)}% 最佳盈亏${s.bestPnl}元 胜率${s.bestWinRate}% 回撤${s.bestDD}% PF${s.bestPF}`);
}

console.log('');
console.log('='.repeat(100));
console.log('BOTTOM5 弱势品种');
console.log('='.repeat(100));
const bottom5 = [...summary].sort((a, b) => a.profitablePct - b.profitablePct).slice(0, 5);
for (let i = 0; i < bottom5.length; i++) {
  const s = bottom5[i];
  console.log(`#${i+1} ${s.code}: 盈利${s.profitablePct.toFixed(1)}% 稳健${s.robustPct.toFixed(1)}% 平均盈亏${s.avgPnl}元 平均回撤${s.avgDD}%`);
}

console.log('');
console.log('='.repeat(100));
console.log('建议纳入 App 的品种 (A/B级)');
console.log('='.repeat(100));
const recommended = summary.filter(s => s.profitablePct >= 50 && s.robustPct >= 20);
if (recommended.length === 0) {
  console.log('无 A/B 级品种，建议放宽条件或等待更多实验数据');
} else {
  for (const s of recommended) {
    console.log(`✓ ${s.code}: 盈利${s.profitablePct.toFixed(1)}% 稳健${s.robustPct.toFixed(1)}%`);
  }
}
