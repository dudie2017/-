/**
 * P1 市场状态自适应 + 失败案例归因分析
 *
 * 基于 59 × 1000 回测实验数据，输出：
 *
 * 一、市场状态自适应分析
 *   1. 不同数据窗口（代表不同市场时期）下的参数表现差异
 *   2. 方向模式（多头/空头/双向）在不同品种上的表现
 *   3. 波动率环境下的最优参数切换建议
 *   4. 品种-市场状态匹配度评分
 *
 * 二、失败案例归因分析
 *   1. 跨品种亏损实验的共性参数模式
 *   2. "死亡组合"识别（高亏损率的参数组合）
 *   3. 亏损因子提升度（lift）排名
 *   4. 可操作的改进建议
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
  longTrades?: number;
  shortTrades?: number;
  longCapture?: number;
  shortCapture?: number;
}

interface Experiment {
  id: number;
  recipe: Record<string, unknown>;
  stats: ExperimentStats;
}

interface VarietyExperimentData {
  meta: { code: string; bars: number; dateRange: string };
  baseline: { recipe: Record<string, unknown>; stats: ExperimentStats };
  varianceDecomposition: Record<string, unknown[]>;
  fullResults: Experiment[];
  fragility?: {
    count: number;
    total: number;
    topFactors: Array<{ dimension: string; value: string; inFragile: number; inAll: number; lift: number }>;
  };
}

// ============ 分析结果类型 ============

// 一、市场状态自适应
interface WindowPerformance {
  window: string;
  avgPnl: number;
  avgWinRate: number;
  avgDrawdown: number;
  positiveRate: number;
  bestParams: Record<string, string>;  // 该窗口下最优参数值
  worstParams: Record<string, string>; // 该窗口下最差参数值
}

interface DirectionAnalysis {
  mode: string;
  avgPnl: number;
  avgWinRate: number;
  avgDrawdown: number;
  positiveRate: number;
  varietyCount: number;
  bestSectors: string[];
  worstSectors: string[];
}

interface RegimeParamRecommendation {
  regime: string;           // 市场状态描述
  description: string;
  optimalParams: Record<string, string | number | boolean>;
  avoidParams: Record<string, string | number | boolean>;
  expectedImprovement: number; // 预期改善幅度
  confidence: number;        // 置信度
}

interface VarietyRegimeFit {
  code: string;
  sector: string;
  bestWindow: string;       // 最适合的数据窗口
  worstWindow: string;      // 最差的数据窗口
  windowSpread: number;     // 窗口间差异
  bestDirection: string;    // 最适合的方向模式
  directionFitScore: number; // 方向匹配度
  regimeType: 'trend_follower' | 'mean_reverter' | 'all_weather' | 'conditional';
}

// 二、失败案例归因
interface LossFactorAnalysis {
  dimension: string;
  value: string;
  lossCount: number;        // 该参数值下亏损实验数
  totalCount: number;       // 该参数值总实验数
  lossRate: number;         // 亏损率
  baselineLossRate: number; // 基准亏损率
  lift: number;             // 提升度（>1 表示更容易亏损）
  avgLoss: number;          // 该参数值下平均亏损
  varieties: string[];      // 受影响的品种
}

interface DeathCombination {
  params: Record<string, string>;
  lossCount: number;
  totalCount: number;
  lossRate: number;
  avgLoss: number;
  varieties: string[];
  severity: 'critical' | 'high' | 'medium';
}

interface ImprovementSuggestion {
  category: 'parameter' | 'risk_management' | 'variety_selection' | 'direction';
  title: string;
  description: string;
  impact: 'high' | 'medium' | 'low';
  evidence: string;
  action: string;
}

interface P1Report {
  generatedAt: string;
  varietyCount: number;
  totalExperiments: number;
  // 一、市场状态自适应
  marketStateAdaptive: {
    windowPerformance: WindowPerformance[];
    directionAnalysis: DirectionAnalysis[];
    paramRecommendations: RegimeParamRecommendation[];
    varietyRegimeFit: VarietyRegimeFit[];
  };
  // 二、失败案例归因
  failureAttribution: {
    overallLossRate: number;
    totalLossExperiments: number;
    topLossFactors: LossFactorAnalysis[];
    deathCombinations: DeathCombination[];
    suggestions: ImprovementSuggestion[];
    sectorLossProfile: Array<{
      sector: string;
      lossRate: number;
      avgLoss: number;
      topRiskFactors: string[];
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

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// ============ 一、市场状态自适应分析 ============

/**
 * 1a. 数据窗口性能分析
 * dataWindow 代表不同市场时期：
 * - full: 全历史
 * - front70: 前 70% 数据
 * - back70: 后 70% 数据
 * - last2y: 最近 2 年
 * - last3y: 最近 3 年
 */
function analyzeWindowPerformance(allData: Map<string, VarietyExperimentData>): WindowPerformance[] {
  const windows = ['full', 'front70', 'back70', 'last2y', 'last3y'];
  const results: WindowPerformance[] = [];

  for (const window of windows) {
    const windowExps: Experiment[] = [];
    for (const [, data] of allData) {
      for (const exp of data.fullResults) {
        if (exp.recipe.dataWindow === window) {
          windowExps.push(exp);
        }
      }
    }

    if (windowExps.length === 0) continue;

    const avgPnl = mean(windowExps.map(e => e.stats.totalPnl));
    const avgWinRate = mean(windowExps.map(e => e.stats.winRate));
    const avgDrawdown = mean(windowExps.map(e => e.stats.maxDrawdown));
    const positiveRate = windowExps.filter(e => e.stats.totalPnl > 0).length / windowExps.length;

    // 找该窗口下最优/最差参数值
    const bestParams: Record<string, string> = {};
    const worstParams: Record<string, string> = {};
    const keyDims = ['directionMode', 'stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];

    for (const dim of keyDims) {
      const valuePnlMap: Record<string, number[]> = {};
      for (const exp of windowExps) {
        const val = String(exp.recipe[dim] ?? 'unknown');
        if (!valuePnlMap[val]) valuePnlMap[val] = [];
        valuePnlMap[val].push(exp.stats.totalPnl);
      }
      let bestVal = '', worstVal = '';
      let bestAvg = -Infinity, worstAvg = Infinity;
      for (const [val, pnls] of Object.entries(valuePnlMap)) {
        if (pnls.length < 50) continue; // 样本量不足
        const avg = mean(pnls);
        if (avg > bestAvg) { bestAvg = avg; bestVal = val; }
        if (avg < worstAvg) { worstAvg = avg; worstVal = val; }
      }
      if (bestVal) bestParams[dim] = bestVal;
      if (worstVal) worstParams[dim] = worstVal;
    }

    results.push({ window, avgPnl, avgWinRate, avgDrawdown, positiveRate, bestParams, worstParams });
  }

  return results;
}

/**
 * 1b. 方向模式分析
 */
function analyzeDirectionMode(allData: Map<string, VarietyExperimentData>): DirectionAnalysis[] {
  const modes = ['both', 'split', 'longOnly', 'shortOnly'];
  const results: DirectionAnalysis[] = [];

  for (const mode of modes) {
    const modeExps: Experiment[] = [];
    const modeVarieties = new Set<string>();
    for (const [code, data] of allData) {
      for (const exp of data.fullResults) {
        if (exp.recipe.directionMode === mode) {
          modeExps.push(exp);
          modeVarieties.add(code);
        }
      }
    }

    if (modeExps.length === 0) continue;

    const avgPnl = mean(modeExps.map(e => e.stats.totalPnl));
    const avgWinRate = mean(modeExps.map(e => e.stats.winRate));
    const avgDrawdown = mean(modeExps.map(e => e.stats.maxDrawdown));
    const positiveRate = modeExps.filter(e => e.stats.totalPnl > 0).length / modeExps.length;

    // 分板块表现
    const sectorPnlMap: Record<string, number[]> = {};
    for (const [code, data] of allData) {
      const sector = SECTOR_MAP[code] || '其他';
      const sectorExps = data.fullResults.filter(e => e.recipe.directionMode === mode);
      if (sectorExps.length > 0) {
        if (!sectorPnlMap[sector]) sectorPnlMap[sector] = [];
        sectorPnlMap[sector].push(mean(sectorExps.map(e => e.stats.totalPnl)));
      }
    }

    const sectorAvgs = Object.entries(sectorPnlMap)
      .map(([sector, pnls]) => ({ sector, avg: mean(pnls) }))
      .sort((a, b) => b.avg - a.avg);

    results.push({
      mode,
      avgPnl,
      avgWinRate,
      avgDrawdown,
      positiveRate,
      varietyCount: modeVarieties.size,
      bestSectors: sectorAvgs.slice(0, 3).map(s => s.sector),
      worstSectors: sectorAvgs.slice(-3).map(s => s.sector),
    });
  }

  return results;
}

/**
 * 1c. 市场状态参数推荐
 * 基于不同数据窗口（代表不同市场时期）的最优参数差异，生成切换建议
 */
function generateParamRecommendations(
  allData: Map<string, VarietyExperimentData>,
  windowPerf: WindowPerformance[]
): RegimeParamRecommendation[] {
  const recommendations: RegimeParamRecommendation[] = [];

  // 分析不同窗口下参数表现的差异
  const dimWindowBest: Record<string, Record<string, string[]>> = {};
  const keyDims = ['directionMode', 'stopAtrMult', 'targetAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];

  for (const dim of keyDims) {
    dimWindowBest[dim] = {};
    for (const wp of windowPerf) {
      dimWindowBest[dim][wp.window] = [];
    }
  }

  // 对每个品种，找每个窗口下的最优参数值
  for (const [code, data] of allData) {
    for (const dim of keyDims) {
      for (const wp of windowPerf) {
        const windowExps = data.fullResults.filter(e => e.recipe.dataWindow === wp.window);
        if (windowExps.length < 10) continue;

        const valuePnlMap: Record<string, number[]> = {};
        for (const exp of windowExps) {
          const val = String(exp.recipe[dim] ?? 'unknown');
          if (!valuePnlMap[val]) valuePnlMap[val] = [];
          valuePnlMap[val].push(exp.stats.totalPnl);
        }

        let bestVal = '';
        let bestAvg = -Infinity;
        for (const [val, pnls] of Object.entries(valuePnlMap)) {
          if (pnls.length < 3) continue;
          const avg = mean(pnls);
          if (avg > bestAvg) { bestAvg = avg; bestVal = val; }
        }
        if (bestVal) {
          dimWindowBest[dim][wp.window].push(bestVal);
        }
      }
    }
  }

  // 分析方向模式在不同时期的变化
  const directionStability: Record<string, number> = {};
  for (const dim of keyDims) {
    const values = Object.values(dimWindowBest[dim]).map(arr => {
      const counts: Record<string, number> = {};
      for (const v of arr) counts[v] = (counts[v] || 0) + 1;
      const maxCount = Math.max(...Object.values(counts));
      return maxCount / arr.length;
    });
    directionStability[dim] = mean(values);
  }

  // 生成推荐
  // 1. 趋势市场推荐（基于 back70 和 last2y/last3y 表现）
  const recentWindows = windowPerf.filter(w => ['back70', 'last2y', 'last3y'].includes(w.window));
  const recentAvgPnl = mean(recentWindows.map(w => w.avgPnl));
  const fullAvgPnl = mean(windowPerf.map(w => w.avgPnl));

  recommendations.push({
    regime: '近期趋势市场',
    description: '最近 2-3 年的市场环境，可能包含趋势行情或震荡行情',
    optimalParams: {
      ...(recentWindows[0]?.bestParams || {}),
    },
    avoidParams: {
      ...(recentWindows[0]?.worstParams || {}),
    },
    expectedImprovement: recentAvgPnl > fullAvgPnl ? (recentAvgPnl - fullAvgPnl) / Math.abs(fullAvgPnl) : 0,
    confidence: directionStability['directionMode'] || 0.5,
  });

  // 2. 高波动环境推荐（基于 fragility 数据中的 bsMode 和 circuitBreaker）
  const highVolExps: Experiment[] = [];
  const lowVolExps: Experiment[] = [];
  for (const [, data] of allData) {
    for (const exp of data.fullResults) {
      if (exp.recipe.volReduce === 'atr2xClear' || exp.recipe.circuitBreaker === '3x10') {
        highVolExps.push(exp);
      } else if (exp.recipe.volReduce === 'off' && exp.recipe.circuitBreaker === 'off') {
        lowVolExps.push(exp);
      }
    }
  }

  if (highVolExps.length > 0 && lowVolExps.length > 0) {
    const highVolAvg = mean(highVolExps.map(e => e.stats.totalPnl));
    const lowVolAvg = mean(lowVolExps.map(e => e.stats.totalPnl));

    recommendations.push({
      regime: '高波动环境',
      description: '波动率放大期，启用风控机制（熔断/波动率降仓）',
      optimalParams: {
        circuitBreaker: '3x10',
        volReduce: 'atr2xClear',
        stopAtrMult: 2.5,
        maxHoldDays: 25,
      },
      avoidParams: {
        circuitBreaker: 'off',
        volReduce: 'off',
        stopAtrMult: 1.5,
        maxHoldDays: 60,
      },
      expectedImprovement: highVolAvg > 0 ? 0.15 : 0.05,
      confidence: Math.min(0.8, highVolExps.length / 10000),
    });
  }

  // 3. 低风险偏好推荐
  const conservativeExps: Experiment[] = [];
  for (const [, data] of allData) {
    for (const exp of data.fullResults) {
      if (exp.stats.maxDrawdown < 0.05 && exp.stats.totalPnl > 0) {
        conservativeExps.push(exp);
      }
    }
  }

  if (conservativeExps.length > 0) {
    // 找保守实验中的常见参数
    const paramCounts: Record<string, Record<string, number>> = {};
    for (const dim of keyDims) {
      paramCounts[dim] = {};
      for (const exp of conservativeExps) {
        const val = String(exp.recipe[dim] ?? 'unknown');
        paramCounts[dim][val] = (paramCounts[dim][val] || 0) + 1;
      }
    }

    const optimalParams: Record<string, string | number | boolean> = {};
    for (const dim of keyDims) {
      let bestVal = '', bestCount = 0;
      for (const [val, count] of Object.entries(paramCounts[dim])) {
        if (count > bestCount) { bestCount = count; bestVal = val; }
      }
      optimalParams[dim] = bestVal;
    }

    recommendations.push({
      regime: '低风险偏好',
      description: '追求低回撤（<5%），牺牲部分收益换取稳定性',
      optimalParams,
      avoidParams: {
        stopAtrMult: 1.5,
        maxHoldDays: 60,
        maxPositionPct: 0.3,
      },
      expectedImprovement: 0.1,
      confidence: Math.min(0.9, conservativeExps.length / 5000),
    });
  }

  return recommendations;
}

/**
 * 1d. 品种-市场状态匹配度
 */
function analyzeVarietyRegimeFit(
  allData: Map<string, VarietyExperimentData>
): VarietyRegimeFit[] {
  const results: VarietyRegimeFit[] = [];

  for (const [code, data] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    const windows = ['full', 'front70', 'back70', 'last2y', 'last3y'];

    // 各窗口下的平均 PnL
    const windowPnlMap: Record<string, number[]> = {};
    for (const w of windows) {
      windowPnlMap[w] = data.fullResults
        .filter(e => e.recipe.dataWindow === w)
        .map(e => e.stats.totalPnl);
    }

    const windowAvgPnl: Record<string, number> = {};
    for (const [w, pnls] of Object.entries(windowPnlMap)) {
      windowAvgPnl[w] = pnls.length > 0 ? mean(pnls) : 0;
    }

    const sorted = Object.entries(windowAvgPnl).sort((a, b) => b[1] - a[1]);
    const bestWindow = sorted[0]?.[0] || 'full';
    const worstWindow = sorted[sorted.length - 1]?.[0] || 'full';
    const windowSpread = sorted.length > 1 ? sorted[0][1] - sorted[sorted.length - 1][1] : 0;

    // 方向模式分析
    const dirPnlMap: Record<string, number[]> = {};
    for (const dir of ['both', 'split', 'longOnly', 'shortOnly']) {
      dirPnlMap[dir] = data.fullResults
        .filter(e => e.recipe.directionMode === dir)
        .map(e => e.stats.totalPnl);
    }

    const dirAvgPnl: Record<string, number> = {};
    for (const [dir, pnls] of Object.entries(dirPnlMap)) {
      dirAvgPnl[dir] = pnls.length > 0 ? mean(pnls) : 0;
    }

    const dirSorted = Object.entries(dirAvgPnl).sort((a, b) => b[1] - a[1]);
    const bestDirection = dirSorted[0]?.[0] || 'both';

    // 方向匹配度：最优方向 vs 双向的差距
    const bothPnl = dirAvgPnl['both'] || 0;
    const bestDirPnl = dirSorted[0]?.[1] || 0;
    const directionFitScore = bothPnl > 0 ? bestDirPnl / bothPnl : (bestDirPnl > 0 ? 2 : 1);

    // 判断品种类型
    let regimeType: VarietyRegimeFit['regimeType'] = 'all_weather';
    const recentPnl = mean(windowPnlMap['last2y'] || []);
    const oldPnl = mean(windowPnlMap['front70'] || []);

    if (Math.abs(recentPnl - oldPnl) > Math.abs(mean(Object.values(windowAvgPnl))) * 0.5) {
      regimeType = 'conditional'; // 时期依赖型
    } else if (bestDirection === 'longOnly' || bestDirection === 'shortOnly') {
      regimeType = 'trend_follower'; // 趋势跟随型
    } else if (bestDirection === 'split' && directionFitScore > 1.3) {
      regimeType = 'mean_reverter'; // 均值回归型
    }

    results.push({
      code,
      sector,
      bestWindow,
      worstWindow,
      windowSpread,
      bestDirection,
      directionFitScore,
      regimeType,
    });
  }

  return results;
}

// ============ 二、失败案例归因分析 ============

/**
 * 2a. 亏损因子提升度分析
 */
function analyzeLossFactors(allData: Map<string, VarietyExperimentData>): {
  overallLossRate: number;
  totalLossExperiments: number;
  topLossFactors: LossFactorAnalysis[];
} {
  let totalExps = 0;
  let totalLosses = 0;
  const dimValueStats: Record<string, Record<string, {
    losses: number; total: number; lossPnls: number[]; varieties: Set<string>;
  }>> = {};

  const keyDimensions = [
    'directionMode', 'dataWindow', 'stopAtrMult', 'targetAtrMult',
    'maxHoldDays', 'pThreshold', 'equationMode', 'minSignalGrade',
    'trendFilter', 'allowRangeTrading', 'bsMode', 'circuitBreaker',
    'volReduce', 'dailyLossLimit', 'maxPositionPct', 'minRR',
    'nonGreenMul', 'cooldownBars', 'edgeLookback', 'feeMult',
    'startCapital', 'softEquationMul', 'counterCampMul', 'campWindow',
  ];

  for (const [code, data] of allData) {
    for (const exp of data.fullResults) {
      totalExps++;
      const isLoss = exp.stats.totalPnl < 0;
      if (isLoss) totalLosses++;

      for (const dim of keyDimensions) {
        const val = String(exp.recipe[dim] ?? 'unknown');
        if (!dimValueStats[dim]) dimValueStats[dim] = {};
        if (!dimValueStats[dim][val]) {
          dimValueStats[dim][val] = { losses: 0, total: 0, lossPnls: [], varieties: new Set() };
        }
        dimValueStats[dim][val].total++;
        if (isLoss) {
          dimValueStats[dim][val].losses++;
          dimValueStats[dim][val].lossPnls.push(Math.abs(exp.stats.totalPnl));
          dimValueStats[dim][val].varieties.add(code);
        }
      }
    }
  }

  const overallLossRate = totalLosses / totalExps;
  const factors: LossFactorAnalysis[] = [];

  for (const [dim, valueMap] of Object.entries(dimValueStats)) {
    for (const [val, stats] of Object.entries(valueMap)) {
      if (stats.total < 100) continue; // 样本量不足
      const lossRate = stats.losses / stats.total;
      const lift = lossRate / overallLossRate;
      if (lift < 1.03) continue; // 提升度不够显著

      factors.push({
        dimension: dim,
        value: val,
        lossCount: stats.losses,
        totalCount: stats.total,
        lossRate,
        baselineLossRate: overallLossRate,
        lift,
        avgLoss: stats.lossPnls.length > 0 ? mean(stats.lossPnls) : 0,
        varieties: [...stats.varieties],
      });
    }
  }

  factors.sort((a, b) => b.lift - a.lift);

  return {
    overallLossRate,
    totalLossExperiments: totalLosses,
    topLossFactors: factors.slice(0, 30),
  };
}

/**
 * 2b. 死亡组合识别
 */
function identifyDeathCombinations(allData: Map<string, VarietyExperimentData>): DeathCombination[] {
  // 分析 2 参数组合的亏损率
  const keyDims = ['directionMode', 'dataWindow', 'stopAtrMult', 'maxHoldDays', 'pThreshold', 'equationMode'];
  const comboStats: Record<string, {
    params: Record<string, string>; losses: number; total: number; lossPnls: number[]; varieties: Set<string>;
  }> = {};

  for (const [code, data] of allData) {
    for (const exp of data.fullResults) {
      for (let i = 0; i < keyDims.length; i++) {
        for (let j = i + 1; j < keyDims.length; j++) {
          const dim1 = keyDims[i];
          const dim2 = keyDims[j];
          const val1 = String(exp.recipe[dim1] ?? 'unknown');
          const val2 = String(exp.recipe[dim2] ?? 'unknown');
          const key = `${dim1}=${val1}|${dim2}=${val2}`;

          if (!comboStats[key]) {
            comboStats[key] = {
              params: { [dim1]: val1, [dim2]: val2 },
              losses: 0, total: 0, lossPnls: [], varieties: new Set(),
            };
          }
          comboStats[key].total++;
          if (exp.stats.totalPnl < 0) {
            comboStats[key].losses++;
            comboStats[key].lossPnls.push(Math.abs(exp.stats.totalPnl));
            comboStats[key].varieties.add(code);
          }
        }
      }
    }
  }

  const combinations: DeathCombination[] = [];
  for (const [key, stats] of Object.entries(comboStats)) {
    if (stats.total < 200) continue; // 样本量不足
    const lossRate = stats.losses / stats.total;
    if (lossRate < 0.45) continue; // 亏损率不够高

    let severity: DeathCombination['severity'] = 'medium';
    if (lossRate > 0.55 && stats.varieties.size > 30) severity = 'critical';
    else if (lossRate > 0.50) severity = 'high';

    combinations.push({
      params: stats.params,
      lossCount: stats.losses,
      totalCount: stats.total,
      lossRate,
      avgLoss: stats.lossPnls.length > 0 ? mean(stats.lossPnls) : 0,
      varieties: [...stats.varieties],
      severity,
    });
  }

  combinations.sort((a, b) => b.lossRate - a.lossRate);
  return combinations.slice(0, 20);
}

/**
 * 2c. 改进建议生成
 */
function generateSuggestions(
  lossFactors: LossFactorAnalysis[],
  deathCombinations: DeathCombination[],
  directionAnalysis: DirectionAnalysis[],
  varietyFit: VarietyRegimeFit[]
): ImprovementSuggestion[] {
  const suggestions: ImprovementSuggestion[] = [];

  // 基于亏损因子生成建议
  const topFactors = lossFactors.slice(0, 10);
  for (const factor of topFactors) {
    if (factor.lift < 1.05) continue;

    let title = '';
    let description = '';
    let action = '';
    let category: ImprovementSuggestion['category'] = 'parameter';

    switch (factor.dimension) {
      case 'directionMode':
        category = 'direction';
        title = `避免使用 ${factor.value} 方向模式`;
        description = `${factor.value} 模式的亏损率比基准高 ${(factor.lift - 1) * 100 | 0}%，影响 ${factor.varieties.length} 个品种`;
        action = factor.value === 'longOnly'
          ? '改用 split 或 both 模式，允许双向交易以分散风险'
          : factor.value === 'shortOnly'
            ? '改用 split 或 both 模式，避免单边做空的风险集中'
            : '保持 both 模式，增加方向过滤';
        break;
      case 'stopAtrMult':
        category = 'risk_management';
        title = `止损倍数 ${factor.value} 风险过高`;
        description = `止损倍数设为 ${factor.value} 时，亏损率提升 ${(factor.lift - 1) * 100 | 0}%`;
        action = factor.value === '1.5'
          ? '将止损倍数从 1.5 提高到 2.0-2.5，减少被正常波动扫损的概率'
          : '考虑收紧止损到 2.0，降低单笔最大亏损';
        break;
      case 'maxHoldDays':
        category = 'risk_management';
        title = `持仓周期 ${factor.value} 天过长`;
        description = `持仓超过 ${factor.value} 天的实验亏损率显著偏高`;
        action = '将最大持仓天数缩短到 25 天以内，避免长期持仓带来的不确定性';
        break;
      case 'dataWindow':
        category = 'parameter';
        title = `数据窗口 ${factor.value} 表现不佳`;
        description = `使用 ${factor.value} 窗口的实验亏损率偏高`;
        action = '改用 front70 或 full 窗口，覆盖更完整的市场周期';
        break;
      case 'pThreshold':
        category = 'parameter';
        title = `信号阈值 ${factor.value} 过低`;
        description = `低阈值导致更多低质量信号被采纳`;
        action = '将 pThreshold 提高到 0.5 以上，过滤低质量信号';
        break;
      case 'equationMode':
        category = 'parameter';
        title = `方程模式 ${factor.value} 风险偏高`;
        description = `${factor.value} 模式下的亏损率高于其他模式`;
        action = '切换到 strict 或 off 模式，减少过度拟合';
        break;
      case 'bsMode':
        category = 'risk_management';
        title = `未启用风控模式 (bsMode=${factor.value})`;
        description = `不启用 bull/bear 切换导致在不利市场中亏损`;
        action = '启用 riskOff 模式，在市场不利时自动降低风险敞口';
        break;
      case 'allowRangeTrading':
        category = 'parameter';
        title = `允许震荡交易增加风险`;
        description = `allowRangeTrading=true 时亏损率提升 ${(factor.lift - 1) * 100 | 0}%`;
        action = '关闭震荡交易（设为 false），仅在趋势明确时入场';
        break;
      default:
        title = `参数 ${factor.dimension}=${factor.value} 风险偏高`;
        description = `该参数值的亏损率比基准高 ${(factor.lift - 1) * 100 | 0}%`;
        action = `建议调整 ${factor.dimension} 到其他值`;
    }

    if (title) {
      suggestions.push({
        category,
        title,
        description,
        impact: factor.lift > 1.15 ? 'high' : factor.lift > 1.08 ? 'medium' : 'low',
        evidence: `基于 ${factor.totalCount} 次实验，亏损率 ${(factor.lossRate * 100).toFixed(1)}%（基准 ${(factor.baselineLossRate * 100).toFixed(1)}%），lift=${factor.lift.toFixed(2)}`,
        action,
      });
    }
  }

  // 基于死亡组合生成建议
  const criticalCombos = deathCombinations.filter(c => c.severity === 'critical');
  if (criticalCombos.length > 0) {
    suggestions.push({
      category: 'parameter',
      title: `识别到 ${criticalCombos.length} 个高危参数组合`,
      description: `这些组合在 ${criticalCombos[0].varieties.length}+ 个品种中亏损率超过 55%`,
      impact: 'high',
      evidence: `最严重组合: ${Object.entries(criticalCombos[0].params).map(([k, v]) => `${k}=${v}`).join(', ')}，亏损率 ${(criticalCombos[0].lossRate * 100).toFixed(1)}%`,
      action: '在参数搜索空间中排除这些组合，或在实盘中设置硬编码黑名单',
    });
  }

  // 基于品种匹配度生成建议
  const conditionalVarieties = varietyFit.filter(v => v.regimeType === 'conditional');
  if (conditionalVarieties.length > 5) {
    suggestions.push({
      category: 'variety_selection',
      title: `${conditionalVarieties.length} 个品种具有强时期依赖性`,
      description: `这些品种在不同市场时期表现差异巨大，需要动态参数切换`,
      impact: 'medium',
      evidence: `品种: ${conditionalVarieties.slice(0, 5).map(v => v.code).join(', ')} 等`,
      action: '对这些品种实施市场状态检测，根据当前波动率/趋势状态切换参数',
    });
  }

  // 基于方向分析生成建议
  const worstDirection = directionAnalysis.sort((a, b) => a.avgPnl - b.avgPnl)[0];
  if (worstDirection && worstDirection.avgPnl < 0) {
    suggestions.push({
      category: 'direction',
      title: `${worstDirection.mode} 模式整体表现不佳`,
      description: `该方向模式平均亏损 ${Math.abs(worstDirection.avgPnl).toFixed(0)}，正收益率仅 ${(worstDirection.positiveRate * 100).toFixed(1)}%`,
      impact: 'medium',
      evidence: `基于 ${worstDirection.varietyCount} 个品种的数据`,
      action: worstDirection.mode === 'longOnly'
        ? '减少纯多头策略的使用，增加 split/both 模式的比重'
        : '考虑增加方向过滤，避免在不利的方向上交易',
    });
  }

  return suggestions;
}

/**
 * 2d. 板块亏损画像
 */
function analyzeSectorLossProfile(allData: Map<string, VarietyExperimentData>): P1Report['failureAttribution']['sectorLossProfile'] {
  const sectorStats: Record<string, {
    losses: number; total: number; lossPnls: number[]; dimFactors: Record<string, number>;
  }> = {};

  for (const [code, data] of allData) {
    const sector = SECTOR_MAP[code] || '其他';
    if (!sectorStats[sector]) {
      sectorStats[sector] = { losses: 0, total: 0, lossPnls: [], dimFactors: {} };
    }

    for (const exp of data.fullResults) {
      sectorStats[sector].total++;
      if (exp.stats.totalPnl < 0) {
        sectorStats[sector].losses++;
        sectorStats[sector].lossPnls.push(Math.abs(exp.stats.totalPnl));
      }
    }
  }

  return Object.entries(sectorStats).map(([sector, stats]) => {
    const lossRate = stats.losses / stats.total;
    const avgLoss = stats.lossPnls.length > 0 ? mean(stats.lossPnls) : 0;

    // 找该板块的主要风险因子（简化版）
    const topRiskFactors: string[] = [];
    // 从 fragility 数据中提取
    for (const [code, data] of allData) {
      if (SECTOR_MAP[code] !== sector) continue;
      if (data.fragility?.topFactors) {
        for (const f of data.fragility.topFactors.slice(0, 3)) {
          const key = `${f.dimension}=${f.value}`;
          if (!topRiskFactors.includes(key)) topRiskFactors.push(key);
        }
        break; // 只取第一个品种的代表
      }
    }

    return {
      sector,
      lossRate,
      avgLoss,
      topRiskFactors: topRiskFactors.slice(0, 5),
    };
  }).sort((a, b) => b.lossRate - a.lossRate);
}

// ============ 主函数 ============
function main(): P1Report {
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

  console.log(`[P1分析] 加载 ${allData.size} 个品种，共 ${totalExperiments} 次实验`);

  // 一、市场状态自适应分析
  console.log('\n--- 1. 数据窗口性能分析 ---');
  const windowPerformance = analyzeWindowPerformance(allData);
  for (const wp of windowPerformance) {
    console.log(`  ${wp.window.padEnd(10)} avgPnl=${wp.avgPnl.toFixed(0).padStart(8)}  winRate=${(wp.avgWinRate * 100).toFixed(1)}%  posRate=${(wp.positiveRate * 100).toFixed(1)}%`);
  }

  console.log('\n--- 2. 方向模式分析 ---');
  const directionAnalysis = analyzeDirectionMode(allData);
  for (const da of directionAnalysis) {
    console.log(`  ${da.mode.padEnd(12)} avgPnl=${da.avgPnl.toFixed(0).padStart(8)}  winRate=${(da.avgWinRate * 100).toFixed(1)}%  posRate=${(da.positiveRate * 100).toFixed(1)}%`);
  }

  console.log('\n--- 3. 参数推荐 ---');
  const paramRecommendations = generateParamRecommendations(allData, windowPerformance);
  for (const rec of paramRecommendations) {
    console.log(`  [${rec.regime}] confidence=${(rec.confidence * 100).toFixed(0)}%`);
  }

  console.log('\n--- 4. 品种-市场匹配度 ---');
  const varietyRegimeFit = analyzeVarietyRegimeFit(allData);
  const typeCounts: Record<string, number> = {};
  for (const v of varietyRegimeFit) {
    typeCounts[v.regimeType] = (typeCounts[v.regimeType] || 0) + 1;
  }
  for (const [type, count] of Object.entries(typeCounts)) {
    console.log(`  ${type}: ${count} 个品种`);
  }

  // 二、失败案例归因
  console.log('\n--- 5. 亏损因子分析 ---');
  const lossAnalysis = analyzeLossFactors(allData);
  console.log(`  总体亏损率: ${(lossAnalysis.overallLossRate * 100).toFixed(1)}%`);
  console.log(`  亏损实验数: ${lossAnalysis.totalLossExperiments}`);
  console.log('  Top 10 亏损因子:');
  for (const f of lossAnalysis.topLossFactors.slice(0, 10)) {
    console.log(`    ${f.dimension}=${f.value}  lift=${f.lift.toFixed(2)}  lossRate=${(f.lossRate * 100).toFixed(1)}%  varieties=${f.varieties.length}`);
  }

  console.log('\n--- 6. 死亡组合识别 ---');
  const deathCombinations = identifyDeathCombinations(allData);
  console.log(`  识别到 ${deathCombinations.length} 个高危组合`);
  for (const dc of deathCombinations.slice(0, 5)) {
    const params = Object.entries(dc.params).map(([k, v]) => `${k}=${v}`).join(', ');
    console.log(`    [${dc.severity}] ${params}  lossRate=${(dc.lossRate * 100).toFixed(1)}%  varieties=${dc.varieties.length}`);
  }

  console.log('\n--- 7. 改进建议 ---');
  const suggestions = generateSuggestions(
    lossAnalysis.topLossFactors,
    deathCombinations,
    directionAnalysis,
    varietyRegimeFit
  );
  for (const s of suggestions) {
    console.log(`  [${s.impact}] ${s.title}`);
  }

  console.log('\n--- 8. 板块亏损画像 ---');
  const sectorLossProfile = analyzeSectorLossProfile(allData);
  for (const sp of sectorLossProfile) {
    console.log(`  ${sp.sector.padEnd(8)} lossRate=${(sp.lossRate * 100).toFixed(1)}%  avgLoss=${sp.avgLoss.toFixed(0)}`);
  }

  // 组装报告
  const report: P1Report = {
    generatedAt: new Date().toISOString(),
    varietyCount: allData.size,
    totalExperiments,
    marketStateAdaptive: {
      windowPerformance,
      directionAnalysis,
      paramRecommendations,
      varietyRegimeFit,
    },
    failureAttribution: {
      overallLossRate: lossAnalysis.overallLossRate,
      totalLossExperiments: lossAnalysis.totalLossExperiments,
      topLossFactors: lossAnalysis.topLossFactors,
      deathCombinations,
      suggestions,
      sectorLossProfile,
    },
  };

  // 输出报告
  const outputPath = path.join(DATA_DIR, 'p1AdaptiveAndFailure.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  console.log(`\n[P1分析] 报告已输出: ${outputPath}`);

  return report;
}

// 执行
main();

export { analyzeWindowPerformance, analyzeDirectionMode, generateParamRecommendations, analyzeVarietyRegimeFit, analyzeLossFactors, identifyDeathCombinations, generateSuggestions, analyzeSectorLossProfile };
export type { P1Report, WindowPerformance, DirectionAnalysis, RegimeParamRecommendation, VarietyRegimeFit, LossFactorAnalysis, DeathCombination, ImprovementSuggestion };
