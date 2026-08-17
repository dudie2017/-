// @ts-nocheck
/**
 * 26 品种组合分析 - 阶段 1：数据整合与基础分析
 * 
 * 功能：
 * 1. 读取所有 26 品种的 1000 次回测数据
 * 2. 提取关键指标（收益、回撤、PF、胜率等）
 * 3. 板块分类统计
 * 4. 品种排名与分级
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 品种元数据
const VARIETY_META: Record<string, { name: string; sector: string; multiplier: number }> = {
  // 黑色系
  JM0: { name: '焦煤', sector: '黑色系', multiplier: 60 },
  J0: { name: '焦炭', sector: '黑色系', multiplier: 100 },
  I0: { name: '铁矿石', sector: '黑色系', multiplier: 100 },
  RB0: { name: '螺纹钢', sector: '黑色系', multiplier: 10 },
  HC0: { name: '热卷', sector: '黑色系', multiplier: 10 },
  
  // 有色
  CU0: { name: '沪铜', sector: '有色', multiplier: 5 },
  AL0: { name: '沪铝', sector: '有色', multiplier: 5 },
  NI0: { name: '沪镍', sector: '有色', multiplier: 1 },
  PB0: { name: '沪铅', sector: '有色', multiplier: 5 },
  ZN0: { name: '沪锌', sector: '有色', multiplier: 5 },
  SI0: { name: '沪锡', sector: '有色', multiplier: 1 },
  
  // 贵金属
  AU0: { name: '沪金', sector: '贵金属', multiplier: 1000 },
  AG0: { name: '沪银', sector: '贵金属', multiplier: 15 },
  
  // 能源化工
  SC0: { name: '原油', sector: '能源化工', multiplier: 1000 },
  FU0: { name: '燃料油', sector: '能源化工', multiplier: 10 },
  BU0: { name: '沥青', sector: '能源化工', multiplier: 10 },
  TA0: { name: 'PTA', sector: '能源化工', multiplier: 5 },
  
  // 农产品
  M0: { name: '豆粕', sector: '农产品', multiplier: 10 },
  P0: { name: '棕榈油', sector: '农产品', multiplier: 10 },
  Y0: { name: '豆油', sector: '农产品', multiplier: 10 },
  CF0: { name: '棉花', sector: '农产品', multiplier: 5 },
  SR0: { name: '白糖', sector: '农产品', multiplier: 10 },
  SP0: { name: '苹果', sector: '农产品', multiplier: 10 },
  
  // 金融
  IF0: { name: '沪深 300', sector: '金融', multiplier: 300 },
  IC0: { name: '中证 500', sector: '金融', multiplier: 200 },
  IH0: { name: '上证 50', sector: '金融', multiplier: 300 },
  IM0: { name: '中证 1000', sector: '金融', multiplier: 200 },
  
  // 其他
  LH0: { name: '生猪', sector: '其他', multiplier: 16 },
  RU0: { name: '橡胶', sector: '其他', multiplier: 10 },
};

interface ExperimentResult {
  code: string;
  name: string;
  sector: string;
  multiplier: number;
  totalReturn: number;
  annualReturn: number;
  maxDrawdown: number;
  profitFactor: number;
  winRate: number;
  totalTrades: number;
  sharpeRatio: number;
  calmarRatio: number;
  bars: number;
}

// 读取单个品种的实验数据
function loadVarietyData(code: string): any[] | null {
  const filePath = path.join(__dirname, `../data/${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  ${code} 数据文件不存在`);
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(content);
  // 数据在 fullResults 数组中
  return parsed.fullResults || parsed.experiments || null;
}

// 提取关键指标
function extractMetrics(code: string, experiments: any[]): ExperimentResult | null {
  if (!experiments || experiments.length === 0) return null;
  
  const meta = VARIETY_META[code];
  if (!meta) {
    console.warn(`⚠️  ${code} 元数据缺失`);
    return null;
  }
  
  // 从 stats 中提取指标
  const stats = experiments.map(e => e.stats || {});
  const returns = stats.map(s => s.totalPnl || 0);
  const drawdowns = stats.map(s => s.maxDrawdown || 0);
  const pfs = stats.map(s => s.profitFactor || 0);
  const winRates = stats.map(s => (s.winRate || 0) * 100); // 转换为百分比
  const trades = stats.map(s => s.totalTrades || 0);
  
  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const median = (arr: number[]) => {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  
  // 计算 Sharpe（简化）
  const meanReturn = avg(returns);
  const stdReturn = Math.sqrt(avg(returns.map(r => (r - meanReturn) ** 2)));
  const sharpe = stdReturn > 0 ? meanReturn / stdReturn : 0;
  
  // 计算 Calmar
  const avgDD = avg(drawdowns);
  const calmar = avgDD > 0 ? meanReturn / avgDD : 0;
  
  // 获取 bars 数量（从第一个实验的 meta 或默认值）
  const bars = experiments[0]?.meta?.bars || 6000;
  
  return {
    code,
    name: meta.name,
    sector: meta.sector,
    multiplier: meta.multiplier,
    totalReturn: median(returns),
    annualReturn: median(returns) / 10, // 假设 10 年数据
    maxDrawdown: median(drawdowns),
    profitFactor: median(pfs),
    winRate: median(winRates),
    totalTrades: median(trades),
    sharpeRatio: sharpe,
    calmarRatio: calmar,
    bars,
  };
}

// 综合评分（基于 min-max 归一化，确保品种间有合理区分度）
function calculateScores(results: ExperimentResult[]): void {
  if (results.length === 0) return;

  const mm = (arr: number[]) => {
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    return { min, max, range: max - min };
  };
  const norm = (val: number, m: { min: number; max: number; range: number }) =>
    m.range > 0 ? (val - m.min) / m.range : 0.5;

  const retMM = mm(results.map(r => r.totalReturn));
  const pfMM = mm(results.map(r => r.profitFactor));
  const ddMM = mm(results.map(r => r.maxDrawdown));
  const wrMM = mm(results.map(r => r.winRate));

  results.forEach(r => {
    // 收益 40%（越高越好）、PF 30%（越高越好）、回撤 20%（越低越好）、胜率 10%（越高越好）
    const returnScore = norm(r.totalReturn, retMM) * 40;
    const pfScore = norm(r.profitFactor, pfMM) * 30;
    const ddScore = (1 - norm(r.maxDrawdown, ddMM)) * 20;
    const wrScore = norm(r.winRate, wrMM) * 10;
    const score = returnScore + pfScore + ddScore + wrScore;
    (r as any).score = Math.round(score * 100) / 100;
    (r as any).grade = getGrade(score);
  });
}

// 分级
function getGrade(score: number): string {
  if (score >= 75) return 'S';
  if (score >= 60) return 'A';
  if (score >= 45) return 'B';
  return 'C';
}

// 主函数
async function main() {
  console.log('📊 26 品种组合分析 - 阶段 1：数据整合\n');
  
  const codes = Object.keys(VARIETY_META);
  const results: ExperimentResult[] = [];
  
  // 读取所有品种数据
  for (const code of codes) {
    const data = loadVarietyData(code);
    if (data) {
      const metrics = extractMetrics(code, data);
      if (metrics) {
        results.push(metrics);
        console.log(`✅ ${code} (${metrics.name}) - 收益:${(metrics.totalReturn/10000).toFixed(1)}万 PF:${metrics.profitFactor.toFixed(2)}`);
      }
    }
  }
  
  console.log(`\n📈 共加载 ${results.length} 个品种数据\n`);
  
  // 计算综合评分（基于全局 min-max 归一化）
  calculateScores(results);
  
  // 按评分排序
  results.sort((a, b) => (b as any).score - (a as any).score);
  
  // 输出排名
  console.log('🏆 品种能力排名:\n');
  console.log('排名 | 代码 | 名称 | 板块 | 评分 | 等级 | 收益 (万) | PF | 回撤 | 胜率');
  console.log('---|---|---|---|---|---|---|---|---|---');
  results.forEach((r, i) => {
    console.log(`${i+1} | ${r.code} | ${r.name} | ${r.sector} | ${r['score'].toFixed(1)} | ${r['grade']} | ${(r.totalReturn/10000).toFixed(1)} | ${r.profitFactor.toFixed(2)} | ${(r.maxDrawdown*100).toFixed(1)}% | ${(r.winRate).toFixed(1)}%`);
  });
  
  // 板块统计
  console.log('\n 板块统计:\n');
  const sectors: Record<string, ExperimentResult[]> = {};
  results.forEach(r => {
    if (!sectors[r.sector]) sectors[r.sector] = [];
    sectors[r.sector].push(r);
  });
  
  Object.entries(sectors).forEach(([sector, varieties]) => {
    const avgReturn = varieties.reduce((s, v) => s + v.totalReturn, 0) / varieties.length;
    const avgPF = varieties.reduce((s, v) => s + v.profitFactor, 0) / varieties.length;
    const avgDD = varieties.reduce((s, v) => s + v.maxDrawdown, 0) / varieties.length;
    const avgWR = varieties.reduce((s, v) => s + v.winRate, 0) / varieties.length;
    
    console.log(`${sector} (${varieties.length}品种): 平均收益${(avgReturn/10000).toFixed(1)}万 PF:${avgPF.toFixed(2)} 回撤:${(avgDD*100).toFixed(1)}% 胜率:${avgWR.toFixed(1)}%`);
  });
  
  // 保存结果
  const outputPath = path.join(__dirname, '../data/26varieties_summary.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n💾 结果已保存到 ${outputPath}`);
  
  return results;
}

main().catch(console.error);
