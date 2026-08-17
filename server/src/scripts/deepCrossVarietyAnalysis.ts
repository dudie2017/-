// @ts-nocheck
/**
 * 深度跨品种分析 - 覆盖全部 60 品种
 *
 * 输出：
 * 1. 品种分级（A/B/C/D 四级，基于最优综合配方）
 * 2. 板块对比（收益/回撤/PF/捕获率/正收益比例）
 * 3. 参数稳健性（跨品种 varianceDecomposition 共识）
 * 4. 系统可行性论证（全品种盈利比例、崩溃率）
 * 5. 优化方向建议
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

// ============ 板块与品种元数据（60 品种全覆盖） ============
const VARIETY_META: Record<string, { name: string; sector: string }> = {
  // 黑色系
  HC0: { name: '热卷', sector: '黑色系' }, RB0: { name: '螺纹钢', sector: '黑色系' },
  I0: { name: '铁矿石', sector: '黑色系' }, J0: { name: '焦炭', sector: '黑色系' },
  JM0: { name: '焦煤', sector: '黑色系' }, SF0: { name: '硅铁', sector: '黑色系' },
  SM0: { name: '锰硅', sector: '黑色系' }, ZC0: { name: '动力煤', sector: '黑色系' },
  // 有色金属
  CU0: { name: '沪铜', sector: '有色金属' }, AL0: { name: '沪铝', sector: '有色金属' },
  ZN0: { name: '沪锌', sector: '有色金属' }, NI0: { name: '沪镍', sector: '有色金属' },
  BC0: { name: '豆二', sector: '有色金属' }, SS0: { name: '不锈钢', sector: '有色金属' },
  PB0: { name: '沪铅', sector: '有色金属' },
  // 贵金属
  AU0: { name: '沪金', sector: '贵金属' }, AG0: { name: '沪银', sector: '贵金属' },
  // 能化链
  SC0: { name: '原油', sector: '能化链' }, BU0: { name: '沥青', sector: '能化链' },
  TA0: { name: 'PTA', sector: '能化链' }, MA0: { name: '甲醇', sector: '能化链' },
  EG0: { name: '乙二醇', sector: '能化链' }, PP0: { name: '聚丙烯', sector: '能化链' },
  L0: { name: '塑料', sector: '能化链' }, FU0: { name: '燃料油', sector: '能化链' },
  EB0: { name: '苯乙烯', sector: '能化链' }, LU0: { name: '低硫燃料油', sector: '能化链' },
  PX0: { name: '对二甲苯', sector: '能化链' }, UR0: { name: '尿素', sector: '能化链' },
  V0: { name: 'PVC', sector: '能化链' },
  // 农产品
  A0: { name: '豆一', sector: '农产品' }, M0: { name: '豆粕', sector: '农产品' },
  RM0: { name: '菜粕', sector: '农产品' }, CF0: { name: '棉花', sector: '农产品' },
  AP0: { name: '苹果', sector: '农产品' }, CJ0: { name: '红枣', sector: '农产品' },
  JD0: { name: '鸡蛋', sector: '农产品' }, LH0: { name: '生猪', sector: '农产品' },
  P0: { name: '棕榈油', sector: '农产品' }, C0: { name: '玉米', sector: '农产品' },
  OI0: { name: '菜油', sector: '农产品' }, SR0: { name: '白糖', sector: '农产品' },
  Y0: { name: '豆油', sector: '农产品' },
  // 建材
  FG0: { name: '玻璃', sector: '建材' }, SA0: { name: '纯碱', sector: '建材' },
  // 股指
  IF0: { name: '沪深300', sector: '股指' }, IH0: { name: '上证50', sector: '股指' },
  IC0: { name: '中证500', sector: '股指' }, IM0: { name: '中证1000', sector: '股指' },
  // 新材料
  LC0: { name: '碳酸锂', sector: '新材料' }, SI0: { name: '工业硅', sector: '新材料' },
  // 胶类
  RU0: { name: '橡胶', sector: '胶类' }, NR0: { name: '20号胶', sector: '胶类' },
  // 国债
  T0: { name: '10年国债', sector: '国债' }, TF0: { name: '5年国债', sector: '国债' },
  // 特殊
  EC0: { name: '集运指数', sector: '特殊' }, SP0: { name: '纸浆', sector: '特殊' },
  AO0: { name: '氧化铝', sector: '特殊' }, PG0: { name: '液化气', sector: '特殊' },
  WR0: { name: '线材', sector: '特殊' },
};

const SECTOR_ORDER = ['黑色系', '有色金属', '贵金属', '能化链', '农产品', '建材', '股指', '新材料', '胶类', '国债', '特殊'];

// ============ 数据加载与指标提取 ============
interface VarietySummary {
  code: string;
  name: string;
  sector: string;
  bars: number;
  // 基线（生产参数）
  basePnl: number;
  baseDD: number;
  basePF: number;
  baseCapture: number;
  // 最优综合配方
  bestPnl: number;
  bestDD: number;
  bestPF: number;
  bestCapture: number;
  bestScore: number;
  bestWinRate: number;
  bestTrades: number;
  // 最优收益配方
  topPnl: number;
  // 全样本分布
  positiveRate: number;   // 正收益配方比例
  crashRate: number;      // 崩溃比例（回撤>90%）
  avgPnl: number;
  medianPnl: number;
  // 数据质量
  abnormal: boolean;      // 数据异常（价格数据问题导致收益爆炸）
  lowSample: boolean;     // 样本不足（交易次数<10，PF失真）
}

function loadVarietyData(code: string): any | null {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function extractSummary(code: string): VarietySummary | null {
  const meta = VARIETY_META[code];
  if (!meta) return null;
  const d = loadVarietyData(code);
  if (!d) return null;

  const fullResults: any[] = d.fullResults || d.experiments || [];
  if (fullResults.length === 0) return null;

  const base = d.baseline?.stats || {};
  const best = d.topComposite?.[0]?.stats || {};
  const topPnlStats = d.topPnl?.[0]?.stats || {};

  const pnls = fullResults.map((e) => e.stats?.totalPnl ?? 0);
  const dds = fullResults.map((e) => e.stats?.maxDrawdown ?? 0);
  const positive = pnls.filter((p) => p > 0).length;
  const crash = dds.filter((dd) => dd > 0.9).length;
  const sum = pnls.reduce((a, b) => a + b, 0);
  const sorted = [...pnls].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return {
    code,
    name: meta.name,
    sector: meta.sector,
    bars: d.meta?.bars || 0,
    basePnl: base.totalPnl ?? 0,
    baseDD: base.maxDrawdown ?? 0,
    basePF: base.profitFactor ?? 0,
    baseCapture: base.capture ?? 0,
    bestPnl: best.totalPnl ?? 0,
    bestDD: best.maxDrawdown ?? 0,
    bestPF: best.profitFactor ?? 0,
    bestCapture: best.capture ?? 0,
    bestScore: d.topComposite?.[0]?.score ?? 0,
    bestWinRate: best.winRate ?? 0,
    bestTrades: best.totalTrades ?? 0,
    topPnl: topPnlStats.totalPnl ?? 0,
    positiveRate: positive / fullResults.length,
    crashRate: crash / fullResults.length,
    avgPnl: sum / fullResults.length,
    medianPnl: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    abnormal: Math.abs(best.totalPnl ?? 0) > 200000000 || Math.abs(base.totalPnl ?? 0) > 200000000,
    lowSample: (best.totalTrades ?? 0) < 10,
  };
}

// ============ 品种分级 ============
function gradeVariety(s: VarietySummary): string {
  // 核心判据：最优综合配方是否盈利 + 捕获率 + 回撤
  if (s.bestPnl > 0 && s.bestCapture >= 0.3 && s.bestDD <= 0.5) return 'A';
  if (s.bestPnl > 0 && s.bestCapture >= 0.1) return 'B';
  if (s.bestPnl > 0) return 'C';
  return 'D';
}

// ============ 主分析流程 ============
function main() {
  const allCodes = Object.keys(VARIETY_META);
  const summaries: VarietySummary[] = [];
  const missing: string[] = [];

  for (const code of allCodes) {
    const s = extractSummary(code);
    if (s) summaries.push(s);
    else missing.push(code);
  }

  if (missing.length > 0) console.log(`⚠️  缺少数据文件: ${missing.join(', ')}\n`);

  // ---- 1. 品种分级表 ----
  const gradeOrder = { A: 0, B: 1, C: 2, D: 3 };
  const graded = summaries
    .map((s) => ({ ...s, grade: gradeVariety(s) }))
    .sort((a, b) => gradeOrder[a.grade] - gradeOrder[b.grade] || b.bestPnl - a.bestPnl);

  console.log('════════════════════════════════════════════════════════════');
  console.log('一、品种分级总览（按最优综合配方排序）');
  console.log('════════════════════════════════════════════════════════════');
  console.log(
    '分级 | 品种 | 板块 | 最优收益 | 回撤 | PF | 捕获率 | 胜率 | 正收益比例 | 崩溃率'
  );
  console.log('-----+------+------+----------+------+----+--------+------+-----------+-------');
  for (const s of graded) {
    const pnl = (s.bestPnl / 10000).toFixed(0);
    const flag = s.abnormal ? '⚠️数据异常' : (s.lowSample ? '⚠️样本少' : '');
    console.log(
      ` ${s.grade}  | ${s.code}(${s.name}) | ${s.sector} | ${pnl}万 | ${(s.bestDD * 100).toFixed(0)}% | ${s.bestPF.toFixed(2)} | ${(s.bestCapture * 100).toFixed(1)}% | ${(s.bestWinRate * 100).toFixed(0)}% | ${(s.positiveRate * 100).toFixed(0)}% | ${(s.crashRate * 100).toFixed(0)}% ${flag}`
    );
  }

  const gradeCount = { A: 0, B: 0, C: 0, D: 0 };
  for (const s of graded) gradeCount[s.grade]++;

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('二、板块对比');
  console.log('════════════════════════════════════════════════════════════');
  console.log('板块 | 品种数 | A级 | B级 | C级 | D级 | 平均捕获率 | 平均回撤 | 平均PF | 正收益比例');
  console.log('-----+--------+-----+-----+-----+-----+-----------+---------+--------+----------');

  for (const sector of SECTOR_ORDER) {
    const members = summaries.filter((s) => s.sector === sector);
    if (members.length === 0) continue;
    const a = members.filter((s) => gradeVariety(s) === 'A').length;
    const b = members.filter((s) => gradeVariety(s) === 'B').length;
    const c = members.filter((s) => gradeVariety(s) === 'C').length;
    const dd = members.filter((s) => gradeVariety(s) === 'D').length;
    const avgCapture = members.reduce((x, s) => x + s.bestCapture, 0) / members.length;
    const avgDD = members.reduce((x, s) => x + s.bestDD, 0) / members.length;
    const avgPF = members.reduce((x, s) => x + s.bestPF, 0) / members.length;
    const avgPos = members.reduce((x, s) => x + s.positiveRate, 0) / members.length;
    console.log(
      `${sector} | ${members.length} | ${a} | ${b} | ${c} | ${dd} | ${(avgCapture * 100).toFixed(1)}% | ${(avgDD * 100).toFixed(0)}% | ${avgPF.toFixed(2)} | ${(avgPos * 100).toFixed(0)}%`
    );
  }

  // ---- 3. 参数稳健性（跨品种方差分解共识） ----
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('三、参数稳健性（跨品种方差分解共识）');
  console.log('════════════════════════════════════════════════════════════');
  const dimConsensus: Record<string, { explained: number[]; bestValues: string[]; count: number }> = {};
  for (const code of allCodes) {
    const d = loadVarietyData(code);
    if (!d?.varianceDecomposition?.totalPnl) continue;
    for (const item of d.varianceDecomposition.totalPnl) {
      if (!item?.dimension) continue;
      if (!dimConsensus[item.dimension]) dimConsensus[item.dimension] = { explained: [], bestValues: [], count: 0 };
      dimConsensus[item.dimension].explained.push(item.explained ?? 0);
      dimConsensus[item.dimension].bestValues.push(String(item.bestValue ?? ''));
      dimConsensus[item.dimension].count++;
    }
  }
  const dimRank = Object.entries(dimConsensus)
    .map(([dim, v]) => ({
      dim,
      avgExplained: v.explained.reduce((a, b) => a + b, 0) / v.explained.length,
      topValue: mode(v.bestValues),
      coverage: v.count,
    }))
    .sort((a, b) => b.avgExplained - a.avgExplained);

  console.log('排名 | 参数维度 | 平均解释方差 | 最常见最优值 | 覆盖品种数');
  console.log('-----+----------+-------------+-------------+-----------');
  dimRank.slice(0, 12).forEach((r, i) => {
    console.log(
      ` ${i + 1}  | ${r.dim} | ${(r.avgExplained * 100).toFixed(1)}% | ${r.topValue} | ${r.coverage}`
    );
  });

  // ---- 4. 系统可行性论证 ----
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('四、系统可行性论证');
  console.log('════════════════════════════════════════════════════════════');
  const profitable = summaries.filter((s) => s.bestPnl > 0);
  const strongProfit = summaries.filter((s) => s.bestPnl > 0 && s.bestCapture >= 0.1);
  const totalVarieties = summaries.length;

  // 排除数据异常品种后的有效样本
  const valid = summaries.filter((s) => !s.abnormal);
  const validProfitable = valid.filter((s) => s.bestPnl > 0);
  const validStrong = valid.filter((s) => s.bestPnl > 0 && s.bestCapture >= 0.1);
  const validTotal = valid.length;

  console.log(`1. 可盈利品种比例（最优配方收益>0）: ${profitable.length}/${totalVarieties} = ${(profitable.length / totalVarieties * 100).toFixed(1)}%`);
  console.log(`2. 强盈利品种（收益>0 且捕获率≥10%）: ${strongProfit.length}/${totalVarieties} = ${(strongProfit.length / totalVarieties * 100).toFixed(1)}%`);
  console.log(`   —— 排除数据异常后：可盈利 ${validProfitable.length}/${validTotal} = ${(validProfitable.length / validTotal * 100).toFixed(1)}%，强盈利 ${validStrong.length}/${validTotal} = ${(validStrong.length / validTotal * 100).toFixed(1)}%`);
  console.log(`3. 平均最优捕获率（全部/有效）: ${(summaries.reduce((x, s) => x + s.bestCapture, 0) / totalVarieties * 100).toFixed(2)}% / ${(valid.reduce((x, s) => x + s.bestCapture, 0) / validTotal * 100).toFixed(2)}%`);
  console.log(`4. 平均最优回撤（有效样本）: ${(valid.reduce((x, s) => x + s.bestDD, 0) / validTotal * 100).toFixed(1)}%`);
  console.log(`5. 数据异常品种（价格数据待修复）: ${summaries.filter((s) => s.abnormal).map((s) => s.code + '(' + s.name + ')').join(', ') || '无'}`);

  // 基线 vs 最优对比
  const baseProfitable = valid.filter((s) => s.basePnl > 0).length;
  console.log(`6. 基线参数（生产）可盈利品种: ${baseProfitable}/${validTotal} = ${(baseProfitable / validTotal * 100).toFixed(1)}%（最优配方为 ${(validProfitable.length / validTotal * 100).toFixed(1)}%）—— 参数优化空间巨大`);

  // ---- 5. 优化方向建议 ----
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('五、优化方向建议');
  console.log('════════════════════════════════════════════════════════════');

  // 方向1：D级品种（策略失效）需要单独处理
  const dGrade = graded.filter((s) => s.grade === 'D');
  if (dGrade.length > 0) {
    console.log(`\n【方向1 - 失效品种隔离】以下 ${dGrade.length} 个品种当前策略失效，建议排除或单独研发：`);
    console.log('  ' + dGrade.map((s) => `${s.code}(${s.name})`).join(', '));
  }

  // 方向2：板块级结论
  const sectorAvgCapture = SECTOR_ORDER.map((sector) => {
    const members = summaries.filter((s) => s.sector === sector);
    if (members.length === 0) return null;
    return {
      sector,
      avgCapture: members.reduce((x, s) => x + s.bestCapture, 0) / members.length,
      profitableRate: members.filter((s) => s.bestPnl > 0).length / members.length,
    };
  }).filter(Boolean) as { sector: string; avgCapture: number; profitableRate: number }[];
  const bestSector = [...sectorAvgCapture].sort((a, b) => b.avgCapture - a.avgCapture)[0];
  const worstSector = [...sectorAvgCapture].sort((a, b) => a.avgCapture - b.avgCapture)[0];
  console.log(`\n【方向2 - 板块聚焦】表现最佳板块「${bestSector.sector}」（平均捕获率 ${(bestSector.avgCapture * 100).toFixed(1)}%，盈利比例 ${(bestSector.profitableRate * 100).toFixed(0)}%）；表现最弱板块「${worstSector.sector}」（平均捕获率 ${(worstSector.avgCapture * 100).toFixed(1)}%）`);

  // 方向3：参数共识
  const top3Dim = dimRank.slice(0, 3);
  console.log(`\n【方向3 - 参数调优优先级】方差解释力前三的参数维度：`);
  top3Dim.forEach((r, i) => {
    console.log(`   ${i + 1}. ${r.dim}（平均解释 ${(r.avgExplained * 100).toFixed(1)}%，最优值多取「${r.topValue}」）`);
  });

  console.log('\n════════════════════════════════════════════════════════════');
  console.log('分析完成。完整数据已保存在各品种 _1000Experiments.json 中。');
  console.log('════════════════════════════════════════════════════════════');
}

// 众数
function mode(arr: string[]): string {
  const m = new Map<string, number>();
  for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [k, v] of m) if (v > bestCount) { bestCount = v; best = k; }
  return best;
}

main();
