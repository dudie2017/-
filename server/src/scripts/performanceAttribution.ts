/**
 * P0 绩效归因与品种稳健性分析
 *
 * 基于 59 × 1000 回测实验数据，输出：
 *
 * 一、参数维度重要性归因
 *   1. 系统级参数重要性排名（聚合 59 品种的方差分解）
 *   2. 分板块参数重要性排名（发现板块特异性）
 *   3. 跨品种共识参数（大多数品种共同依赖的关键维度）
 *   4. 板块特异性参数（仅在特定板块重要的维度）
 *
 * 二、品种稳健性评分
 *   1. Calmar 比率分布（Top10%/Top20%/全样本）
 *   2. 参数敏感度（稳健性系数 = Top10% Calmar CV）
 *   3. 资金分配建议（高/中/低稳健品种分组）
 *   4. 失败模式诊断（亏损实验的共性特征）
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

// ============ 板块元数据 ============
const SECTOR_MAP: Record<string, string> = {
  HC0: '黑色系', RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', SF0: '黑色系', SM0: '黑色系',
  CU0: '有色金属', AL0: '有色金属', ZN0: '有色金属', NI0: '有色金属', BC0: '有色金属', SS0: '有色金属', PB0: '有色金属',
  AG0: '贵金属', AU0: '贵金属',
  SC0: '能化链', BU0: '能化链', TA0: '能化链', MA0: '能化链', EG0: '能化链',
  PP0: '能化链', L0: '能化链', V0: '能化链', FU0: '能化链', EB0: '能化链', LU0: '能化链',
  PX0: '能化链', UR0: '能化链', PG0: '能化链',
  RM0: '农产品', AP0: '农产品', JD0: '农产品', LH0: '农产品', CF0: '农产品',
  A0: '农产品', M0: '农产品', P0: '农产品', CJ0: '农产品', Y0: '农产品', C0: '农产品', OI0: '农产品', SR0: '农产品',
  FG0: '建材', SA0: '建材',
  IM0: '股指', IF0: '股指', IH0: '股指', IC0: '股指',
  LC0: '新材料', SI0: '新材料',
  RU0: '胶类', NR0: '胶类',
  T0: '国债', TF0: '国债',
  EC0: '特殊', SP0: '特殊', AO0: '特殊', WR0: '特殊',
};

const SECTOR_ORDER = ['黑色系', '有色金属', '贵金属', '能化链', '农产品', '建材', '股指', '新材料', '胶类', '国债', '特殊'];

// ============ 类型定义 ============
interface ExperimentStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  capture: number;
  longPnl?: number;
  shortPnl?: number;
}

interface Experiment {
  id: number;
  recipe: Record<string, unknown>;
  stats: ExperimentStats;
}

interface VarianceDecompItem {
  dimension: string;
  groupCount: number;
  betweenVar: number;
  totalVar: number;
  explained: number;
  bestValue: string;
  worstValue: string;
  spread: number;
}

interface VarietyExperimentData {
  meta: { code: string; bars: number; dateRange: string };
  baseline: { recipe: Record<string, unknown>; stats: ExperimentStats };
  varianceDecomposition: {
    totalPnl: VarianceDecompItem[];
    maxDrawdown: VarianceDecompItem[];
    capture: VarianceDecompItem[];
  };
  fullResults: Experiment[];
}

// ============ 分析结果类型 ============
interface DimensionImportance {
  dimension: string;
  avgExplained: number;        // 跨品种平均解释力
  medianExplained: number;     // 中位数解释力
  stdExplained: number;        // 标准差（越小=跨品种越一致）
  consensus: number;           // 共识度：在多少品种中排 top3
  bestValues: string[];        // 各品种最优值
  worstValues: string[];       // 各品种最差值
  sectorBreakdown: Record<string, number>; // 分板块平均解释力
}

interface VarietyRobustness {
  code: string;
  sector: string;
  bars: number;
  // Calmar 分布
  calmarP10: number;           // Top 10% 平均 Calmar
  calmarP20: number;           // Top 20% 平均 Calmar
  calmarMedian: number;        // 全样本中位数 Calmar
  calmarMean: number;          // 全样本均值 Calmar
  // 稳健性指标
  robustnessScore: number;     // 稳健性评分 0-100
  cvTop10: number;             // Top10% 变异系数（越低越稳健）
  positiveRate: number;        // 正收益实验比例
  profitableTradesRate: number;// 平均胜率（Top20%）
  // 资金分配
  allocationTier: 'A' | 'B' | 'C'; // 高/中/低稳健
  suggestedWeight: number;     // 建议权重
  // 失败模式
  failurePattern: {
    crashRate: number;         // 崩溃率（DD>80%）
    avgLossWhenLose: number;   // 亏损实验平均亏损
    topLossDimensions: Array<{ dimension: string; value: string; lift: number }>;
  };
}

interface AttributionReport {
  generatedAt: string;
  varietyCount: number;
  totalExperiments: number;
  // 一、参数重要性
  parameterImportance: {
    systemWide: DimensionImportance[];
    bySector: Record<string, DimensionImportance[]>;
    consensusParams: string[];     // 跨品种共识参数
    sectorSpecific: Record<string, string[]>; // 板块特异性参数
  };
  // 二、品种稳健性
  robustness: {
    rankings: VarietyRobustness[];
    tierSummary: { tier: string; count: number; avgWeight: number; varieties: string[] }[];
    capitalAllocation: { tier: string; varieties: string[]; totalWeight: number }[];
  };
}

// ============ 工具函数 ============
function loadVarietyData(code: string): VarietyExperimentData | null {
  const filePath = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function mean(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function std(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, x) => sum + (x - m) ** 2, 0) / (arr.length - 1));
}

function coefficientOfVariation(arr: number[]): number {
  const m = mean(arr);
  if (Math.abs(m) < 1e-10) return 999;
  return std(arr) / Math.abs(m);
}

function percentile(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ============ 一、参数维度重要性归因 ============
function analyzeParameterImportance(
  allData: Map<string, VarietyExperimentData>
): AttributionReport['parameterImportance'] {
  const metrics = ['totalPnl', 'maxDrawdown', 'capture'] as const;
  const dimensionRecords: Record<string, { explained: number[]; bestValues: string[]; worstValues: string[]; sectors: Record<string, number[]> }> = {};

  // 聚合所有品种的方差分解
  for (const [code, data] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    for (const metric of metrics) {
      const decomp = data.varianceDecomposition[metric];
      if (!decomp) continue;
      for (const item of decomp) {
        const dim = item.dimension;
        if (!dimensionRecords[dim]) {
          dimensionRecords[dim] = { explained: [], bestValues: [], worstValues: [], sectors: {} };
        }
        dimensionRecords[dim].explained.push(item.explained);
        dimensionRecords[dim].bestValues.push(item.bestValue);
        dimensionRecords[dim].worstValues.push(item.worstValue);
        if (!dimensionRecords[dim].sectors[sector]) {
          dimensionRecords[dim].sectors[sector] = [];
        }
        dimensionRecords[dim].sectors[sector].push(item.explained);
      }
    }
  }

  // 计算系统级重要性
  const systemWide: DimensionImportance[] = Object.entries(dimensionRecords).map(([dim, rec]) => {
    const explainedArr = rec.explained;
    const sectorBreakdown: Record<string, number> = {};
    for (const [sector, vals] of Object.entries(rec.sectors)) {
      sectorBreakdown[sector] = mean(vals);
    }

    // 共识度：在该品种的任意 metric 中排 top3 的次数
    let consensusCount = 0;
    for (const [code, data] of allData) {
      let isTop3 = false;
      for (const metric of metrics) {
        const decomp = data.varianceDecomposition[metric];
        if (!decomp) continue;
        const top3 = [...decomp].sort((a, b) => b.explained - a.explained).slice(0, 3);
        if (top3.some(t => t.dimension === dim)) {
          isTop3 = true;
          break;
        }
      }
      if (isTop3) consensusCount++;
    }

    return {
      dimension: dim,
      avgExplained: mean(explainedArr),
      medianExplained: median(explainedArr),
      stdExplained: std(explainedArr),
      consensus: consensusCount / allData.size,
      bestValues: rec.bestValues,
      worstValues: rec.worstValues,
      sectorBreakdown,
    };
  });

  // 按 avgExplained 降序排列
  systemWide.sort((a, b) => b.avgExplained - a.avgExplained);

  // 分板块重要性
  const bySector: Record<string, DimensionImportance[]> = {};
  for (const sector of SECTOR_ORDER) {
    const sectorDims: Record<string, number[]> = {};
    for (const [code, data] of allData) {
      if (SECTOR_MAP[code] !== sector) continue;
      for (const metric of metrics) {
        const decomp = data.varianceDecomposition[metric];
        if (!decomp) continue;
        for (const item of decomp) {
          if (!sectorDims[item.dimension]) sectorDims[item.dimension] = [];
          sectorDims[item.dimension].push(item.explained);
        }
      }
    }
    bySector[sector] = Object.entries(sectorDims)
      .map(([dim, vals]) => ({
        dimension: dim,
        avgExplained: mean(vals),
        medianExplained: median(vals),
        stdExplained: std(vals),
        consensus: 0,
        bestValues: [],
        worstValues: [],
        sectorBreakdown: {},
      }))
      .sort((a, b) => b.avgExplained - a.avgExplained);
  }

  // 共识参数：在 >60% 品种中排 top3
  const consensusParams = systemWide.filter(d => d.consensus > 0.6).map(d => d.dimension);

  // 板块特异性参数：在某板块 avgExplained 排名 top2，但在系统级排名 < 0.02
  const sectorSpecific: Record<string, string[]> = {};
  for (const [sector, dims] of Object.entries(bySector)) {
    const top2 = dims.slice(0, 2).map(d => d.dimension);
    const specific = top2.filter(dim => {
      const sysRank = systemWide.find(s => s.dimension === dim);
      return sysRank && sysRank.avgExplained < 0.03;
    });
    if (specific.length > 0) {
      sectorSpecific[sector] = specific;
    }
  }

  return { systemWide, bySector, consensusParams, sectorSpecific };
}

// ============ 二、品种稳健性评分 ============
function analyzeRobustness(
  allData: Map<string, VarietyExperimentData>
): AttributionReport['robustness'] {
  const rankings: VarietyRobustness[] = [];

  for (const [code, data] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    const results = data.fullResults;
    if (!results || results.length === 0) continue;

    // 计算每个实验的 Calmar
    const calmars = results.map(r => {
      const pnl = r.stats.totalPnl;
      const dd = r.stats.maxDrawdown;
      // Calmar = 年化收益 / 最大回撤（这里用总收益/回撤近似）
      return dd > 0.001 ? pnl / dd : 0;
    });

    // 过滤有效 Calmar（排除极端值）
    const validCalmars = calmars.filter(c => isFinite(c) && Math.abs(c) < 1e8);

    // Top 10% / Top 20%
    const sorted = [...validCalmars].sort((a, b) => b - a);
    const n10 = Math.max(1, Math.floor(sorted.length * 0.1));
    const n20 = Math.max(1, Math.floor(sorted.length * 0.2));
    const top10Calmars = sorted.slice(0, n10);
    const top20Calmars = sorted.slice(0, n20);

    const calmarP10 = mean(top10Calmars);
    const calmarP20 = mean(top20Calmars);
    const calmarMedian = median(validCalmars);
    const calmarMean = mean(validCalmars);

    // 稳健性评分
    const cvTop10 = coefficientOfVariation(top10Calmars);
    const positiveRate = validCalmars.filter(c => c > 0).length / validCalmars.length;

    // Top20% 平均胜率
    const top20Experiments = [...results]
      .filter(r => {
        const dd = r.stats.maxDrawdown;
        const c = dd > 0.001 ? r.stats.totalPnl / dd : 0;
        return isFinite(c) && Math.abs(c) < 1e8;
      })
      .sort((a, b) => {
        const ca = a.stats.maxDrawdown > 0.001 ? a.stats.totalPnl / a.stats.maxDrawdown : 0;
        const cb = b.stats.maxDrawdown > 0.001 ? b.stats.totalPnl / b.stats.maxDrawdown : 0;
        return cb - ca;
      })
      .slice(0, n20);
    const profitableTradesRate = mean(top20Experiments.map(e => e.stats.winRate));

    // 崩溃率
    const crashRate = results.filter(r => r.stats.maxDrawdown > 0.8).length / results.length;

    // 亏损实验平均亏损
    const losingExps = results.filter(r => r.stats.totalPnl < 0);
    const avgLossWhenLose = losingExps.length > 0 ? Math.abs(mean(losingExps.map(e => e.stats.totalPnl))) : 0;

    // 失败模式 top 维度（简化版：从 fragility 数据中提取）
    // 这里用参数值与亏损的相关性来近似
    const topLossDimensions: Array<{ dimension: string; value: string; lift: number }> = [];
    const keyDimensions = ['directionMode', 'stopAtrMult', 'maxPositionPct', 'dataWindow', 'maxHoldDays', 'minRR'];
    for (const dim of keyDimensions) {
      const valueLossMap: Record<string, { losses: number; total: number }> = {};
      for (const r of results) {
        const val = String(r.recipe[dim] ?? 'unknown');
        if (!valueLossMap[val]) valueLossMap[val] = { losses: 0, total: 0 };
        valueLossMap[val].total++;
        if (r.stats.totalPnl < 0) valueLossMap[val].losses++;
      }
      // 找亏损率最高的值
      let worstVal = '';
      let worstRate = 0;
      for (const [val, stats] of Object.entries(valueLossMap)) {
        const rate = stats.losses / stats.total;
        if (rate > worstRate && stats.total > 20) {
          worstRate = rate;
          worstVal = val;
        }
      }
      if (worstVal) {
        const overallLossRate = losingExps.length / results.length;
        const lift = worstRate / overallLossRate;
        if (lift > 1.02) {
          topLossDimensions.push({ dimension: dim, value: worstVal, lift });
        }
      }
    }
    topLossDimensions.sort((a, b) => b.lift - a.lift);

    // 稳健性评分计算（0-100）
    // 综合考虑：Top10% CV（低=好）、正收益比例（高=好）、崩溃率（低=好）
    const cvScore = Math.max(0, 100 - cvTop10 * 100); // CV=0 → 100, CV=1 → 0
    const positiveScore = positiveRate * 100;
    const crashScore = Math.max(0, 100 - crashRate * 150); // crashRate=0 → 100, crashRate=0.67 → 0
    const robustnessScore = Math.round(cvScore * 0.4 + positiveScore * 0.3 + crashScore * 0.3);

    // 资金分配层级
    let allocationTier: 'A' | 'B' | 'C' = 'C';
    if (robustnessScore >= 60 && cvTop10 < 0.5) allocationTier = 'A';
    else if (robustnessScore >= 40 && cvTop10 < 0.8) allocationTier = 'B';

    // 建议权重
    let suggestedWeight = 0.01; // 默认 1%
    if (allocationTier === 'A') suggestedWeight = 0.03;
    else if (allocationTier === 'B') suggestedWeight = 0.015;

    rankings.push({
      code,
      sector,
      bars: data.meta.bars,
      calmarP10,
      calmarP20,
      calmarMedian,
      calmarMean,
      robustnessScore,
      cvTop10,
      positiveRate,
      profitableTradesRate,
      allocationTier,
      suggestedWeight,
      failurePattern: {
        crashRate,
        avgLossWhenLose,
        topLossDimensions: topLossDimensions.slice(0, 5),
      },
    });
  }

  // 按稳健性评分降序排列
  rankings.sort((a, b) => b.robustnessScore - a.robustnessScore);

  // 层级汇总
  const tierMap: Record<string, VarietyRobustness[]> = { A: [], B: [], C: [] };
  for (const r of rankings) {
    tierMap[r.allocationTier].push(r);
  }

  const tierSummary = Object.entries(tierMap).map(([tier, items]) => ({
    tier,
    count: items.length,
    avgWeight: mean(items.map(i => i.suggestedWeight)),
    varieties: items.map(i => i.code),
  }));

  // 资金分配建议
  const capitalAllocation = [
    {
      tier: 'A (高稳健)',
      varieties: tierMap.A.map(r => r.code),
      totalWeight: tierMap.A.reduce((s, r) => s + r.suggestedWeight, 0),
    },
    {
      tier: 'B (中稳健)',
      varieties: tierMap.B.map(r => r.code),
      totalWeight: tierMap.B.reduce((s, r) => s + r.suggestedWeight, 0),
    },
    {
      tier: 'C (低稳健)',
      varieties: tierMap.C.map(r => r.code),
      totalWeight: tierMap.C.reduce((s, r) => s + r.suggestedWeight, 0),
    },
  ];

  return { rankings, tierSummary, capitalAllocation };
}

// ============ 主函数 ============
function main(): AttributionReport {
  // 加载所有品种数据
  const allData = new Map<string, VarietyExperimentData>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('_1000Experiments.json'));

  let totalExperiments = 0;
  for (const file of files) {
    const code = file.replace('_1000Experiments.json', '');
    const data = loadVarietyData(code);
    if (data) {
      allData.set(code, data);
      totalExperiments += data.fullResults?.length || 0;
    }
  }

  console.log(`[归因分析] 加载 ${allData.size} 个品种，共 ${totalExperiments} 次实验`);

  // 一、参数重要性归因
  const parameterImportance = analyzeParameterImportance(allData);

  // 二、品种稳健性评分
  const robustness = analyzeRobustness(allData);

  const report: AttributionReport = {
    generatedAt: new Date().toISOString(),
    varietyCount: allData.size,
    totalExperiments,
    parameterImportance,
    robustness,
  };

  // 输出报告
  const outputPath = path.join(DATA_DIR, 'performanceAttribution.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`[归因分析] 报告已输出: ${outputPath}`);

  // 控制台摘要
  console.log('\n========== 参数维度重要性排名 (系统级) ==========');
  for (const d of parameterImportance.systemWide.slice(0, 10)) {
    console.log(`  ${d.dimension.padEnd(20)} avg=${(d.avgExplained * 100).toFixed(2)}%  consensus=${(d.consensus * 100).toFixed(0)}%  std=${(d.stdExplained * 100).toFixed(2)}%`);
  }

  console.log('\n========== 跨品种共识参数 ==========');
  console.log(`  ${parameterImportance.consensusParams.join(', ')}`);

  console.log('\n========== 板块特异性参数 ==========');
  for (const [sector, params] of Object.entries(parameterImportance.sectorSpecific)) {
    console.log(`  ${sector}: ${params.join(', ')}`);
  }

  console.log('\n========== 品种稳健性排名 (Top 15) ==========');
  for (const r of robustness.rankings.slice(0, 15)) {
    console.log(`  ${r.code.padEnd(6)} ${r.sector.padEnd(8)} score=${r.robustnessScore}  tier=${r.allocationTier}  cv10=${r.cvTop10.toFixed(3)}  pos=${(r.positiveRate * 100).toFixed(0)}%  crash=${(r.failurePattern.crashRate * 100).toFixed(0)}%`);
  }

  console.log('\n========== 资金分配建议 ==========');
  for (const ca of robustness.capitalAllocation) {
    console.log(`  ${ca.tier}: ${ca.varieties.length} 个品种, 总权重=${(ca.totalWeight * 100).toFixed(1)}%`);
    console.log(`    品种: ${ca.varieties.join(', ')}`);
  }

  return report;
}

// 执行
main();

export { analyzeParameterImportance, analyzeRobustness };
export type { AttributionReport, DimensionImportance, VarietyRobustness };
