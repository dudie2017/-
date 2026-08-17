/**
 * P2 品种分组联动分析 + 参数自适应优化
 *
 * 基于 59 × 1001 回测实验数据，输出：
 *
 * 一、品种分组联动分析
 *   1. 板块内品种 PnL 相关性矩阵（同参数组合下的收益相关性）
 *   2. 高风险配对识别（高正相关 → 风险集中）
 *   3. 对冲机会识别（负相关 → 组合分散化价值）
 *   4. 板块内分散化评分
 *   5. 跨板块联动分析
 *
 * 二、参数自适应优化
 *   1. 基于品种类型的参数推荐（趋势型/全天候型/时期依赖型）
 *   2. 基于市场状态的参数切换规则
 *   3. 板块级参数共识（同板块最优参数聚合）
 *   4. 参数稳健性热力图（哪些参数值在哪些板块稳健）
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
interface Experiment {
  id: number;
  recipe: Record<string, unknown>;
  stats: {
    totalPnl: number;
    winRate: number;
    maxDrawdown: number;
    profitFactor: number;
    capture: number;
    totalTrades: number;
    longPnl?: number;
    shortPnl?: number;
  };
}

interface VarietyExperimentData {
  meta: { code: string; bars: number };
  fullResults: Experiment[];
}

// 一、联动分析结果
interface CorrelationPair {
  code1: string;
  code2: string;
  sector1: string;
  sector2: string;
  pnlCorrelation: number;     // PnL 皮尔逊相关系数
  drawdownCorrelation: number; // 回撤相关系数
  winRateCorrelation: number;  // 胜率相关系数
  relationship: 'strong_positive' | 'moderate_positive' | 'weak' | 'moderate_negative' | 'strong_negative';
}

interface SectorDiversification {
  sector: string;
  varieties: string[];
  avgCorrelation: number;       // 板块内平均相关性
  maxCorrelation: number;       // 最高相关性配对
  minCorrelation: number;       // 最低相关性配对
  highRiskPairs: Array<{ code1: string; code2: string; correlation: number }>;
  hedgeOpportunities: Array<{ code1: string; code2: string; correlation: number }>;
  diversificationScore: number; // 分散化评分 0-100
}

interface CrossSectorLinkage {
  sector1: string;
  sector2: string;
  avgCorrelation: number;
  strongestPair: { code1: string; code2: string; correlation: number };
  weakestPair: { code1: string; code2: string; correlation: number };
}

// 二、参数自适应结果
interface VarietyParamRecommendation {
  code: string;
  sector: string;
  regimeType: string;
  optimalParams: Record<string, string | number | boolean>;
  confidence: number;
  rationale: string;
}

interface SectorParamConsensus {
  sector: string;
  consensusParams: Record<string, {
    optimalValue: string;
    agreement: number;        // 板块内品种一致率
    stability: number;        // 参数稳健性
  }>;
}

interface ParamRobustnessHeatmap {
  dimension: string;
  values: Array<{
    value: string;
    sectorPerformance: Record<string, number>; // 板块 → 平均PnL
    overallRank: number;
    isRobust: boolean;        // 在多数板块都表现良好
  }>;
}

interface P2Report {
  generatedAt: string;
  varietyCount: number;
  totalExperiments: number;
  // 一、品种分组联动
  linkage: {
    correlationMatrix: CorrelationPair[];
    sectorDiversification: SectorDiversification[];
    crossSectorLinkage: CrossSectorLinkage[];
    portfolioSuggestions: Array<{
      type: 'diversification' | 'hedging' | 'concentration_warning';
      description: string;
      varieties: string[];
      expectedBenefit: string;
    }>;
  };
  // 二、参数自适应
  adaptive: {
    varietyRecommendations: VarietyParamRecommendation[];
    sectorConsensus: SectorParamConsensus[];
    paramRobustness: ParamRobustnessHeatmap[];
    switchingRules: Array<{
      condition: string;
      action: string;
      params: Record<string, string | number | boolean>;
      confidence: number;
    }>;
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

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 10) return 0;

  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));

  let sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  if (denom < 1e-10) return 0;
  return sumXY / denom;
}

function classifyCorrelation(r: number): CorrelationPair['relationship'] {
  if (r > 0.7) return 'strong_positive';
  if (r > 0.4) return 'moderate_positive';
  if (r > -0.4) return 'weak';
  if (r > -0.7) return 'moderate_negative';
  return 'strong_negative';
}

// ============ 一、品种分组联动分析 ============

/**
 * 1a. 计算品种间 PnL 相关性矩阵
 * 同一实验 ID = 同一参数组合，因此可以跨品种比较 PnL
 */
function computeCorrelationMatrix(
  allData: Map<string, VarietyExperimentData>
): CorrelationPair[] {
  const codes = [...allData.keys()].sort();
  const pairs: CorrelationPair[] = [];

  // 预提取每个品种的 PnL / DD / WR 数组
  const pnlMap: Record<string, number[]> = {};
  const ddMap: Record<string, number[]> = {};
  const wrMap: Record<string, number[]> = {};

  for (const code of codes) {
    const data = allData.get(code)!;
    // 按 ID 排序确保对齐
    const sorted = [...data.fullResults].sort((a, b) => a.id - b.id);
    pnlMap[code] = sorted.map(e => e.stats.totalPnl);
    ddMap[code] = sorted.map(e => e.stats.maxDrawdown);
    wrMap[code] = sorted.map(e => e.stats.winRate);
  }

  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const c1 = codes[i], c2 = codes[j];
      const pnlCorr = pearsonCorrelation(pnlMap[c1], pnlMap[c2]);
      const ddCorr = pearsonCorrelation(ddMap[c1], ddMap[c2]);
      const wrCorr = pearsonCorrelation(wrMap[c1], wrMap[c2]);

      pairs.push({
        code1: c1,
        code2: c2,
        sector1: SECTOR_MAP[c1] || '其他',
        sector2: SECTOR_MAP[c2] || '其他',
        pnlCorrelation: pnlCorr,
        drawdownCorrelation: ddCorr,
        winRateCorrelation: wrCorr,
        relationship: classifyCorrelation(pnlCorr),
      });
    }
  }

  return pairs;
}

/**
 * 1b. 板块内分散化分析
 */
function analyzeSectorDiversification(
  allData: Map<string, VarietyExperimentData>,
  allPairs: CorrelationPair[]
): SectorDiversification[] {
  const sectorVarieties: Record<string, string[]> = {};
  for (const [code] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    if (!sectorVarieties[sector]) sectorVarieties[sector] = [];
    sectorVarieties[sector].push(code);
  }

  const results: SectorDiversification[] = [];

  for (const sector of SECTOR_ORDER) {
    const varieties = sectorVarieties[sector];
    if (!varieties || varieties.length < 2) continue;

    // 找板块内的配对
    const sectorPairs = allPairs.filter(p =>
      p.sector1 === sector && p.sector2 === sector
    );

    if (sectorPairs.length === 0) continue;

    const correlations = sectorPairs.map(p => p.pnlCorrelation);
    const avgCorr = mean(correlations);
    const maxCorr = Math.max(...correlations);
    const minCorr = Math.min(...correlations);

    // 高风险配对：相关性 > 0.7
    const highRiskPairs = sectorPairs
      .filter(p => p.pnlCorrelation > 0.7)
      .map(p => ({ code1: p.code1, code2: p.code2, correlation: p.pnlCorrelation }))
      .sort((a, b) => b.correlation - a.correlation);

    // 对冲机会：相关性 < -0.3
    const hedgeOpportunities = sectorPairs
      .filter(p => p.pnlCorrelation < -0.3)
      .map(p => ({ code1: p.code1, code2: p.code2, correlation: p.pnlCorrelation }))
      .sort((a, b) => a.correlation - b.correlation);

    // 分散化评分：平均相关性越低 → 分散化越好
    // 100 = 完全不相关，0 = 完全相关
    const diversificationScore = Math.round(Math.max(0, Math.min(100, (1 - avgCorr) * 100)));

    results.push({
      sector,
      varieties,
      avgCorrelation: avgCorr,
      maxCorrelation: maxCorr,
      minCorrelation: minCorr,
      highRiskPairs: highRiskPairs.slice(0, 5),
      hedgeOpportunities: hedgeOpportunities.slice(0, 5),
      diversificationScore,
    });
  }

  return results;
}

/**
 * 1c. 跨板块联动分析
 */
function analyzeCrossSectorLinkage(
  allPairs: CorrelationPair[]
): CrossSectorLinkage[] {
  const sectorPairs: Record<string, CorrelationPair[]> = {};

  for (const p of allPairs) {
    if (p.sector1 === p.sector2) continue; // 只看跨板块
    const key = [p.sector1, p.sector2].sort().join('|');
    if (!sectorPairs[key]) sectorPairs[key] = [];
    sectorPairs[key].push(p);
  }

  const results: CrossSectorLinkage[] = [];

  for (const [key, pairs] of Object.entries(sectorPairs)) {
    const [sector1, sector2] = key.split('|');
    const correlations = pairs.map(p => p.pnlCorrelation);
    const avgCorr = mean(correlations);

    const sorted = [...pairs].sort((a, b) => b.pnlCorrelation - a.pnlCorrelation);

    results.push({
      sector1,
      sector2,
      avgCorrelation: avgCorr,
      strongestPair: {
        code1: sorted[0].code1,
        code2: sorted[0].code2,
        correlation: sorted[0].pnlCorrelation,
      },
      weakestPair: {
        code1: sorted[sorted.length - 1].code1,
        code2: sorted[sorted.length - 1].code2,
        correlation: sorted[sorted.length - 1].pnlCorrelation,
      },
    });
  }

  results.sort((a, b) => b.avgCorrelation - a.avgCorrelation);
  return results;
}

/**
 * 1d. 组合建议生成
 */
function generatePortfolioSuggestions(
  sectorDiv: SectorDiversification[],
  crossLinkage: CrossSectorLinkage[],
  allPairs: CorrelationPair[]
): P2Report['linkage']['portfolioSuggestions'] {
  const suggestions: P2Report['linkage']['portfolioSuggestions'] = [];

  // 1. 高风险集中警告
  for (const sd of sectorDiv) {
    if (sd.highRiskPairs.length > 0) {
      const topPair = sd.highRiskPairs[0];
      suggestions.push({
        type: 'concentration_warning',
        description: `${sd.sector}板块内 ${topPair.code1}-${topPair.code2} 相关性高达 ${topPair.correlation.toFixed(2)}，同时持有会导致风险集中`,
        varieties: [topPair.code1, topPair.code2],
        expectedBenefit: '降低单一板块风险暴露',
      });
    }
  }

  // 2. 对冲机会
  const hedgePairs = allPairs
    .filter(p => p.pnlCorrelation < -0.3)
    .sort((a, b) => a.pnlCorrelation - b.pnlCorrelation)
    .slice(0, 5);

  for (const hp of hedgePairs) {
    suggestions.push({
      type: 'hedging',
      description: `${hp.code1}(${hp.sector1}) 与 ${hp.code2}(${hp.sector2}) 负相关(${hp.pnlCorrelation.toFixed(2)})，可构建对冲组合`,
      varieties: [hp.code1, hp.code2],
      expectedBenefit: '通过负相关对冲降低组合整体波动',
    });
  }

  // 3. 分散化建议
  const lowDivSectors = sectorDiv.filter(s => s.diversificationScore < 40);
  if (lowDivSectors.length > 0) {
    suggestions.push({
      type: 'diversification',
      description: `${lowDivSectors.map(s => s.sector).join('、')} 板块内分散化不足（评分<40），建议跨板块配置`,
      varieties: lowDivSectors.flatMap(s => s.varieties.slice(0, 2)),
      expectedBenefit: '通过跨板块配置提升组合分散化',
    });
  }

  return suggestions;
}

// ============ 二、参数自适应优化 ============

/**
 * 2a. 基于品种类型的参数推荐
 */
function generateVarietyParamRecommendations(
  allData: Map<string, VarietyExperimentData>,
  p1Data: any
): VarietyParamRecommendation[] {
  const recommendations: VarietyParamRecommendation[] = [];
  const varietyFit = p1Data?.marketStateAdaptive?.varietyRegimeFit || [];

  for (const [code, data] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    const fit = varietyFit.find((v: any) => v.code === code);
    const regimeType = fit?.regimeType || 'all_weather';
    const results = data.fullResults;

    // 根据品种类型，找最优参数
    let filteredResults = results;
    let rationale = '';

    switch (regimeType) {
      case 'trend_follower':
        // 趋势型：找单向表现最好的方向
        const dirPnls: Record<string, number[]> = {};
        for (const exp of results) {
          const dir = String(exp.recipe.directionMode);
          if (!dirPnls[dir]) dirPnls[dir] = [];
          dirPnls[dir].push(exp.stats.totalPnl);
        }
        const bestDir = Object.entries(dirPnls)
          .map(([dir, pnls]) => ({ dir, avg: mean(pnls) }))
          .sort((a, b) => b.avg - a.avg)[0];
        
        filteredResults = results.filter(e => e.recipe.directionMode === bestDir?.dir);
        rationale = `趋势跟随型，最优方向 ${bestDir?.dir}（avgPnl=${bestDir?.avg.toFixed(0)}）`;
        break;

      case 'conditional':
        // 时期依赖型：用最近的数据窗口
        filteredResults = results.filter(e => 
          ['last2y', 'last3y', 'back70'].includes(String(e.recipe.dataWindow))
        );
        rationale = `时期依赖型，聚焦近期市场（last2y/last3y/back70）`;
        break;

      case 'mean_reverter':
        // 均值回归型：用 split 方向 + 短持仓
        filteredResults = results.filter(e => 
          e.recipe.directionMode === 'split' && 
          Number(e.recipe.maxHoldDays) <= 25
        );
        rationale = `均值回归型，split方向 + 短持仓（≤25天）`;
        break;

      default:
        // all_weather：全样本
        rationale = `全天候型，全参数空间稳健`;
    }

    // 在过滤后的结果中找最优参数组合（Top 5% 平均）
    const sorted = [...filteredResults].sort((a, b) => {
      const ca = a.stats.maxDrawdown > 0.001 ? a.stats.totalPnl / a.stats.maxDrawdown : 0;
      const cb = b.stats.maxDrawdown > 0.001 ? b.stats.totalPnl / b.stats.maxDrawdown : 0;
      return cb - ca;
    });

    const topN = sorted.slice(0, Math.max(5, Math.floor(sorted.length * 0.05)));
    const optimalParams: Record<string, string | number | boolean> = {};
    const keyDims = ['directionMode', 'stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];

    for (const dim of keyDims) {
      const counts: Record<string, number> = {};
      for (const exp of topN) {
        const val = String(exp.recipe[dim] ?? 'unknown');
        counts[val] = (counts[val] || 0) + 1;
      }
      const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (best) {
        // 尝试转为原始类型
        const rawVal = best[0];
        if (rawVal === 'true') optimalParams[dim] = true;
        else if (rawVal === 'false') optimalParams[dim] = false;
        else if (!isNaN(Number(rawVal))) optimalParams[dim] = Number(rawVal);
        else optimalParams[dim] = rawVal;
      }
    }

    // 置信度：Top5% 中该参数出现的频率
    const topFreq = Object.values(
      topN.reduce((acc: Record<string, number>, exp) => {
        const key = keyDims.map(d => `${d}=${exp.recipe[d]}`).join('|');
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {})
    );
    const confidence = Math.min(0.95, Math.max(...topFreq) / topN.length);

    recommendations.push({
      code,
      sector,
      regimeType,
      optimalParams,
      confidence,
      rationale,
    });
  }

  return recommendations;
}

/**
 * 2b. 板块级参数共识
 */
function computeSectorParamConsensus(
  varietyRecs: VarietyParamRecommendation[]
): SectorParamConsensus[] {
  const sectorGroups: Record<string, VarietyParamRecommendation[]> = {};
  for (const rec of varietyRecs) {
    if (!sectorGroups[rec.sector]) sectorGroups[rec.sector] = [];
    sectorGroups[rec.sector].push(rec);
  }

  const results: SectorParamConsensus[] = [];

  for (const sector of SECTOR_ORDER) {
    const recs = sectorGroups[sector];
    if (!recs || recs.length < 2) continue;

    const consensusParams: SectorParamConsensus['consensusParams'] = {};
    const keyDims = ['directionMode', 'stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];

    for (const dim of keyDims) {
      const valueCounts: Record<string, number> = {};
      for (const rec of recs) {
        const val = String(rec.optimalParams[dim] ?? 'unknown');
        valueCounts[val] = (valueCounts[val] || 0) + 1;
      }

      const sorted = Object.entries(valueCounts).sort((a, b) => b[1] - a[1]);
      const optimalValue = sorted[0]?.[0] || 'unknown';
      const agreement = sorted[0] ? sorted[0][1] / recs.length : 0;

      // 稳定性：最优值的平均置信度
      const matchingRecs = recs.filter(r => String(r.optimalParams[dim]) === optimalValue);
      const stability = mean(matchingRecs.map(r => r.confidence));

      consensusParams[dim] = { optimalValue, agreement, stability };
    }

    results.push({ sector, consensusParams });
  }

  return results;
}

/**
 * 2c. 参数稳健性热力图
 */
function computeParamRobustnessHeatmap(
  allData: Map<string, VarietyExperimentData>
): ParamRobustnessHeatmap[] {
  const keyDims = ['directionMode', 'stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];
  const results: ParamRobustnessHeatmap[] = [];

  for (const dim of keyDims) {
    // 收集该维度所有可能的值
    const allValues = new Set<string>();
    for (const [, data] of allData) {
      for (const exp of data.fullResults) {
        allValues.add(String(exp.recipe[dim] ?? 'unknown'));
      }
    }

    const valueResults: ParamRobustnessHeatmap['values'] = [];

    for (const val of allValues) {
      const sectorPerformance: Record<string, number[]> = {};

      for (const [code, data] of allData) {
        const sector = SECTOR_MAP[code] || '其他';
        const matching = data.fullResults.filter(e => String(e.recipe[dim]) === val);
        if (matching.length > 0) {
          if (!sectorPerformance[sector]) sectorPerformance[sector] = [];
          sectorPerformance[sector].push(mean(matching.map(e => e.stats.totalPnl)));
        }
      }

      const sectorAvg: Record<string, number> = {};
      for (const [sector, pnls] of Object.entries(sectorPerformance)) {
        sectorAvg[sector] = mean(pnls);
      }

      // 总体排名：所有板块平均
      const overallAvg = mean(Object.values(sectorAvg));

      // 稳健性：在多少板块中排名前半
      const allSectorAvgs = Object.values(sectorAvg);
      const medianVal = allSectorAvgs.length > 0
        ? [...allSectorAvgs].sort((a, b) => a - b)[Math.floor(allSectorAvgs.length / 2)]
        : 0;
      const aboveMedianCount = allSectorAvgs.filter(v => v > medianVal).length;
      const isRobust = aboveMedianCount >= allSectorAvgs.length * 0.6;

      valueResults.push({
        value: val,
        sectorPerformance: sectorAvg,
        overallRank: overallAvg,
        isRobust,
      });
    }

    // 按总体排名降序
    valueResults.sort((a, b) => b.overallRank - a.overallRank);

    results.push({ dimension: dim, values: valueResults });
  }

  return results;
}

/**
 * 2d. 参数切换规则
 */
function generateSwitchingRules(
  sectorConsensus: SectorParamConsensus[],
  varietyRecs: VarietyParamRecommendation[],
  p1Data: any
): P2Report['adaptive']['switchingRules'] {
  const rules: P2Report['adaptive']['switchingRules'] = [];

  // 规则1：基于品种类型的方向切换
  const trendFollowers = varietyRecs.filter(r => r.regimeType === 'trend_follower');
  const conditionalTypes = varietyRecs.filter(r => r.regimeType === 'conditional');

  if (trendFollowers.length > 0) {
    // 统计趋势型品种的最优方向分布
    const dirCounts: Record<string, number> = {};
    for (const r of trendFollowers) {
      const dir = String(r.optimalParams.directionMode || 'both');
      dirCounts[dir] = (dirCounts[dir] || 0) + 1;
    }
    const dominantDir = Object.entries(dirCounts).sort((a, b) => b[1] - a[1])[0];
    if (dominantDir) {
      rules.push({
        condition: `品种为趋势跟随型（${trendFollowers.length}个品种）`,
        action: `切换方向模式为 ${dominantDir[0]}`,
        params: { directionMode: dominantDir[0] },
        confidence: dominantDir[1] / trendFollowers.length,
      });
    }
  }

  // 规则2：基于市场状态的持仓周期切换
  const paramRecs = p1Data?.marketStateAdaptive?.paramRecommendations || [];
  for (const rec of paramRecs) {
    if (rec.regime === '高波动环境') {
      rules.push({
        condition: '高波动环境（启用熔断/波动率降仓）',
        action: '缩短持仓 + 放宽止损',
        params: {
          stopAtrMult: Number(rec.optimalParams?.stopAtrMult) || 2.5,
          maxHoldDays: Number(rec.optimalParams?.maxHoldDays) || 25,
        },
        confidence: rec.confidence,
      });
    }
    if (rec.regime === '低风险偏好') {
      rules.push({
        condition: '低风险偏好（目标回撤<5%）',
        action: '收紧止损 + 缩短持仓',
        params: {
          stopAtrMult: Number(rec.optimalParams?.stopAtrMult) || 2,
          maxHoldDays: Number(rec.optimalParams?.maxHoldDays) || 15,
          maxPositionPct: 0.15,
        },
        confidence: rec.confidence,
      });
    }
  }

  // 规则3：板块级参数共识
  for (const sc of sectorConsensus) {
    const highAgreement = Object.entries(sc.consensusParams)
      .filter(([, v]) => v.agreement > 0.6)
      .map(([k, v]) => `${k}=${v.optimalValue}(${(v.agreement * 100).toFixed(0)}%)`);

    if (highAgreement.length > 0) {
      rules.push({
        condition: `${sc.sector}板块参数共识`,
        action: `采用板块共识参数: ${highAgreement.join(', ')}`,
        params: Object.fromEntries(
          Object.entries(sc.consensusParams)
            .filter(([, v]) => v.agreement > 0.6)
            .map(([k, v]) => {
              const raw = v.optimalValue;
              if (raw === 'true') return [k, true];
              if (raw === 'false') return [k, false];
              if (!isNaN(Number(raw))) return [k, Number(raw)];
              return [k, raw];
            })
        ),
        confidence: mean(
          Object.values(sc.consensusParams)
            .filter(v => v.agreement > 0.6)
            .map(v => v.agreement)
        ),
      });
    }
  }

  return rules;
}

// ============ 主函数 ============
function main(): P2Report {
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

  console.log(`[P2分析] 加载 ${allData.size} 个品种，共 ${totalExperiments} 次实验`);

  // 加载 P1 数据
  let p1Data: any = null;
  const p1Path = path.join(DATA_DIR, 'p1AdaptiveAndFailure.json');
  if (fs.existsSync(p1Path)) {
    p1Data = JSON.parse(fs.readFileSync(p1Path, 'utf-8'));
    console.log(`[P2分析] 已加载 P1 数据`);
  }

  // ============ 一、品种分组联动分析 ============
  console.log('\n--- 1. 品种间 PnL 相关性矩阵 ---');
  const correlationMatrix = computeCorrelationMatrix(allData);
  console.log(`  计算了 ${correlationMatrix.length} 个品种配对`);

  const strongPositive = correlationMatrix.filter(p => p.relationship === 'strong_positive');
  const strongNegative = correlationMatrix.filter(p => p.relationship === 'strong_negative');
  console.log(`  强正相关: ${strongPositive.length} 对`);
  console.log(`  强负相关: ${strongNegative.length} 对`);

  // Top 5 最强正相关
  const topPositive = [...strongPositive].sort((a, b) => b.pnlCorrelation - a.pnlCorrelation).slice(0, 5);
  console.log('  Top 5 强正相关:');
  for (const p of topPositive) {
    console.log(`    ${p.code1}-${p.code2}: ${p.pnlCorrelation.toFixed(3)} (${p.sector1}/${p.sector2})`);
  }

  // Top 5 最强负相关
  const topNegative = [...strongNegative].sort((a, b) => a.pnlCorrelation - b.pnlCorrelation).slice(0, 5);
  console.log('  Top 5 强负相关:');
  for (const p of topNegative) {
    console.log(`    ${p.code1}-${p.code2}: ${p.pnlCorrelation.toFixed(3)} (${p.sector1}/${p.sector2})`);
  }

  console.log('\n--- 2. 板块内分散化分析 ---');
  const sectorDiversification = analyzeSectorDiversification(allData, correlationMatrix);
  for (const sd of sectorDiversification) {
    console.log(`  ${sd.sector.padEnd(8)} avgCorr=${sd.avgCorrelation.toFixed(3)}  score=${sd.diversificationScore}  highRisk=${sd.highRiskPairs.length}  hedge=${sd.hedgeOpportunities.length}`);
  }

  console.log('\n--- 3. 跨板块联动 ---');
  const crossSectorLinkage = analyzeCrossSectorLinkage(correlationMatrix);
  for (const cl of crossSectorLinkage.slice(0, 5)) {
    console.log(`  ${cl.sector1} ↔ ${cl.sector2}: avgCorr=${cl.avgCorrelation.toFixed(3)}  strongest=${cl.strongestPair.code1}-${cl.strongestPair.code2}(${cl.strongestPair.correlation.toFixed(3)})`);
  }

  console.log('\n--- 4. 组合建议 ---');
  const portfolioSuggestions = generatePortfolioSuggestions(sectorDiversification, crossSectorLinkage, correlationMatrix);
  for (const ps of portfolioSuggestions) {
    console.log(`  [${ps.type}] ${ps.description.slice(0, 80)}`);
  }

  // ============ 二、参数自适应优化 ============
  console.log('\n--- 5. 品种参数推荐 ---');
  const varietyRecommendations = generateVarietyParamRecommendations(allData, p1Data);
  const regimeTypeCounts: Record<string, number> = {};
  for (const r of varietyRecommendations) {
    regimeTypeCounts[r.regimeType] = (regimeTypeCounts[r.regimeType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(regimeTypeCounts)) {
    console.log(`  ${type}: ${count} 个品种`);
  }

  console.log('\n--- 6. 板块参数共识 ---');
  const sectorConsensus = computeSectorParamConsensus(varietyRecommendations);
  for (const sc of sectorConsensus) {
    const highAgreement = Object.entries(sc.consensusParams)
      .filter(([, v]) => v.agreement > 0.5)
      .map(([k, v]) => `${k}=${v.optimalValue}(${(v.agreement * 100).toFixed(0)}%)`);
    console.log(`  ${sc.sector.padEnd(8)} ${highAgreement.join(', ')}`);
  }

  console.log('\n--- 7. 参数稳健性热力图 ---');
  const paramRobustness = computeParamRobustnessHeatmap(allData);
  for (const pr of paramRobustness) {
    const robust = pr.values.filter(v => v.isRobust);
    console.log(`  ${pr.dimension.padEnd(20)} robust values: ${robust.map(v => v.value).join(', ')}`);
  }

  console.log('\n--- 8. 参数切换规则 ---');
  const switchingRules = generateSwitchingRules(sectorConsensus, varietyRecommendations, p1Data);
  for (const rule of switchingRules) {
    console.log(`  [${rule.condition.slice(0, 40)}] → ${rule.action.slice(0, 50)} (confidence=${(rule.confidence * 100).toFixed(0)}%)`);
  }

  // 组装报告
  const report: P2Report = {
    generatedAt: new Date().toISOString(),
    varietyCount: allData.size,
    totalExperiments,
    linkage: {
      correlationMatrix,
      sectorDiversification,
      crossSectorLinkage,
      portfolioSuggestions,
    },
    adaptive: {
      varietyRecommendations,
      sectorConsensus,
      paramRobustness,
      switchingRules,
    },
  };

  // 输出报告
  const outputPath = path.join(DATA_DIR, 'p2LinkageAndAdaptive.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n[P2分析] 报告已输出: ${outputPath}`);

  return report;
}

// 执行
main();

export {
  computeCorrelationMatrix,
  analyzeSectorDiversification,
  analyzeCrossSectorLinkage,
  generatePortfolioSuggestions,
  generateVarietyParamRecommendations,
  computeSectorParamConsensus,
  computeParamRobustnessHeatmap,
  generateSwitchingRules,
};
export type { P2Report, CorrelationPair, SectorDiversification, CrossSectorLinkage, VarietyParamRecommendation, SectorParamConsensus, ParamRobustnessHeatmap };
