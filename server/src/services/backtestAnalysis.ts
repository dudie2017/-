/**
 * 回测结果分析服务
 * 使用JSON文件存储回测数据
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { contractToSystemCode, getVarietyInfo } from './localDataLoader.js';

const DATA_DIR = path.join('/tmp', 'data');
const DATA_FILE = path.join(DATA_DIR, 'backtest_results.json');

// 基于当前模块文件位置解析 server 根目录（不依赖 process.cwd()，
// 因为服务可能从项目根目录启动，cwd 不可靠）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVER_ROOT = [
  path.resolve(__dirname, '..', '..'),
  path.resolve(__dirname, '..'),
].find((p) => fs.existsSync(path.join(p, 'package.json'))) ?? path.resolve(__dirname, '..');

// 品种周期表现数据
export interface TimeframePerformance {
  timeframe: string;
  profitFactor: number;
  winRate: number;
  totalReturn: number;
  maxDrawdown: number;
  isRecommended: boolean;
}

// 品种分级数据
export interface VarietyGrade {
  code: string;
  name: string;
  exchange: string;
  grade: 'S' | 'A' | 'B' | 'C';
  bestTimeframe: string;
  bestProfitFactor: number;
  avgProfitFactor: number;
  timeframes: TimeframePerformance[];
  // 多维度评分
  compositeScore?: number;
  winRate?: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  totalTrades?: number;
  bestStrategy?: string;
}

// 信号质量评分
export interface SignalScore {
  totalScore: number;
  timeframeScore: number;
  varietyScore: number;
  technicalScore: number;
  spectrumScore: number;
  details: {
    timeframeMatch: string;
    varietyGrade: string;
    technicalStrength: string;
    spectrumPosition: string;
  };
}

// 组合推荐
export interface PortfolioRecommendation {
  corePositions: PortfolioItem[];
  auxiliaryPositions: PortfolioItem[];
  watchPositions: PortfolioItem[];
  expectedProfitFactor: number;
  expectedAnnualReturn: string;
}

interface PortfolioItem {
  code: string;
  name: string;
  timeframe: string;
  profitFactor: number;
  weight: number;
}

interface BacktestResult {
  code: string;
  name: string;
  exchange: string;
  timeframe: string;
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  totalReturn: number;
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  sharpeRatio?: number;
  emaTrades?: number;
  rsiTrades?: number;
  bollingerTrades?: number;
  bestStrategy?: string;
}

// 确保数据目录存在
function ensureDataDir() {
  const dir = path.dirname(DATA_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 读取回测结果
// 优先读可写数据文件（运行时生成）；若不存在，回退到仓库内预置的种子数据，
// 保证品种分级/组合推荐/交易建议在未跑过回测前也有可用数据。
// 种子文件路径：源码运行时为 src/services → server/data；esbuild 打包后为 dist → server/data
const SEED_FILE = [
  path.resolve(__dirname, '../data/backtest_results.json'),
  path.resolve(__dirname, '../../data/backtest_results.json'),
].find((p) => fs.existsSync(p)) ?? path.resolve(SERVER_ROOT, 'data/backtest_results.json');

function loadResults(): BacktestResult[] {
  const file = fs.existsSync(DATA_FILE)
    ? DATA_FILE
    : (fs.existsSync(SEED_FILE) ? SEED_FILE : null);
  if (!file) {
    return [];
  }
  const data = fs.readFileSync(file, 'utf-8');
  return JSON.parse(data);
}

// 保存回测结果
function saveResults(results: BacktestResult[]) {
  ensureDataDir();
  fs.writeFileSync(DATA_FILE, JSON.stringify(results, null, 2));
}

/**
 * 存储回测结果
 */
export function storeBacktestResults(results: BacktestResult[]): void {
  saveResults(results);
}

/**
 * 计算品种分级（优化版：动态阈值 + 多维度评分）
 */
export function calculateVarietyGrades(): VarietyGrade[] {
  const results = loadResults();
  
  // 按品种分组（将旧合约代码映射为系统品种代码，如 JDL8 -> JD0）
  const varietyMap = new Map<string, BacktestResult[]>();
  for (const result of results) {
    const systemCode = contractToSystemCode(result.code);
    const info = getVarietyInfo(result.code);
    const normalized: BacktestResult = {
      ...result,
      code: systemCode,
      // 优先使用映射表中的标准名称，映射表中不存在时保留原始名称
      name: info.systemCode !== result.code ? info.name : result.name,
      exchange: info.systemCode !== result.code ? info.exchange : result.exchange,
    };
    if (!varietyMap.has(systemCode)) {
      varietyMap.set(systemCode, []);
    }
    varietyMap.get(systemCode)!.push(normalized);
  }
  
  // 第一步：计算每个品种的综合评分
  interface VarietyScore {
    code: string;
    name: string;
    exchange: string;
    best: BacktestResult;
    performances: BacktestResult[];
    compositeScore: number;
    avgProfitFactor: number;
  }
  
  const scores: VarietyScore[] = [];
  
  for (const [code, performances] of varietyMap) {
    // 找到最佳周期
    const best = performances.reduce((a, b) => a.profitFactor > b.profitFactor ? a : b);
    
    // 计算平均盈亏比
    const avgProfitFactor = performances.reduce((sum, p) => sum + p.profitFactor, 0) / performances.length;
    
    // 多维度综合评分（0-100）
    // 1. 盈利因子得分（0-40分）
    const pfScore = Math.min(40, best.profitFactor * 10);
    
    // 2. 胜率得分（0-25分）
    const winRateScore = Math.min(25, best.winRate * 0.5);
    
    // 3. 夏普比率得分（0-20分）
    const sharpe = best.sharpeRatio || 0;
    const sharpeScore = Math.min(20, Math.max(0, sharpe * 10));
    
    // 4. 最大回撤惩罚（0-15分，回撤越大分越低）
    const maxDD = best.maxDrawdown || 0;
    const drawdownScore = Math.max(0, 15 - maxDD * 0.5);
    
    // 综合评分
    const compositeScore = pfScore + winRateScore + sharpeScore + drawdownScore;
    
    scores.push({
      code,
      name: best.name,
      exchange: best.exchange,
      best,
      performances,
      compositeScore,
      avgProfitFactor,
    });
  }
  
  // 第二步：动态阈值（基于百分位数）
  // 按综合评分排序
  scores.sort((a, b) => b.compositeScore - a.compositeScore);
  
  const totalVarieties = scores.length;
  const sThreshold = Math.floor(totalVarieties * 0.05); // 前5%为S级
  const aThreshold = Math.floor(totalVarieties * 0.20); // 前20%为A级
  const bThreshold = Math.floor(totalVarieties * 0.40); // 前40%为B级
  
  // 第三步：确定等级
  const grades: VarietyGrade[] = scores.map((s, index) => {
    let grade: 'S' | 'A' | 'B' | 'C';
    if (index < sThreshold) {
      grade = 'S';
    } else if (index < aThreshold) {
      grade = 'A';
    } else if (index < bThreshold) {
      grade = 'B';
    } else {
      grade = 'C';
    }
    
    // 构建周期表现列表
    const timeframes: TimeframePerformance[] = s.performances
      .sort((a, b) => b.profitFactor - a.profitFactor)
      .map(p => ({
        timeframe: p.timeframe,
        profitFactor: p.profitFactor,
        winRate: p.winRate,
        totalReturn: p.totalReturn,
        maxDrawdown: p.maxDrawdown,
        isRecommended: p.profitFactor >= 1.5
      }));
    
    return {
      code: s.code,
      name: s.name,
      exchange: s.exchange,
      grade,
      bestTimeframe: s.best.timeframe,
      bestProfitFactor: s.best.profitFactor,
      avgProfitFactor: s.avgProfitFactor,
      timeframes,
      // 多维度评分
      compositeScore: Math.round(s.compositeScore * 10) / 10,
      winRate: Math.round(s.best.winRate * 10) / 10,
      sharpeRatio: s.best.sharpeRatio,
      maxDrawdown: Math.round(s.best.maxDrawdown * 10) / 10,
      totalTrades: s.best.totalTrades,
      bestStrategy: s.best.bestStrategy,
    };
  });
  
  // 按等级和综合评分排序
  grades.sort((a, b) => {
    const gradeOrder = { S: 0, A: 1, B: 2, C: 3 };
    if (gradeOrder[a.grade] !== gradeOrder[b.grade]) {
      return gradeOrder[a.grade] - gradeOrder[b.grade];
    }
    return (b.compositeScore || 0) - (a.compositeScore || 0);
  });
  
  return grades;
}

/**
 * 获取品种分级列表
 */
export function getVarietyGrades(): VarietyGrade[] {
  return calculateVarietyGrades();
}

/**
 * 获取品种的最佳周期
 */
export function getBestTimeframe(varietyCode: string): string | null {
  const grades = calculateVarietyGrades();
  const variety = grades.find(g => g.code === varietyCode);
  return variety?.bestTimeframe || null;
}

/**
 * 计算信号质量评分
 */
export function calculateSignalScore(
  varietyCode: string,
  timeframe: string,
  technicalStrength: number,
  spectrumPosition: 'trend' | 'channel' | 'range'
): SignalScore {
  const grades = calculateVarietyGrades();
  const variety = grades.find(g => g.code === varietyCode);
  const perf = variety?.timeframes.find(t => t.timeframe === timeframe);
  
  if (!variety || !perf) {
    return {
      totalScore: 50,
      timeframeScore: 25,
      varietyScore: 25,
      technicalScore: Math.round(technicalStrength * 0.3),
      spectrumScore: spectrumPosition === 'trend' ? 10 : spectrumPosition === 'channel' ? 5 : 0,
      details: {
        timeframeMatch: '无历史数据',
        varietyGrade: '未知',
        technicalStrength: `${technicalStrength}%`,
        spectrumPosition: spectrumPosition
      }
    };
  }
  
  // 周期匹配度评分 (0-30分)
  let timeframeScore = 0;
  let timeframeMatch = '';
  if (perf.profitFactor >= 3.0) {
    timeframeScore = 30;
    timeframeMatch = '极佳周期';
  } else if (perf.profitFactor >= 2.0) {
    timeframeScore = 25;
    timeframeMatch = '优秀周期';
  } else if (perf.profitFactor >= 1.5) {
    timeframeScore = 20;
    timeframeMatch = '良好周期';
  } else if (perf.profitFactor >= 1.0) {
    timeframeScore = 10;
    timeframeMatch = '一般周期';
  } else {
    timeframeScore = 0;
    timeframeMatch = '不推荐周期';
  }
  
  // 品种等级评分 (0-30分)
  let varietyScore = 0;
  let varietyGradeText = '';
  switch (variety.grade) {
    case 'S':
      varietyScore = 30;
      varietyGradeText = 'S级(强烈推荐)';
      break;
    case 'A':
      varietyScore = 25;
      varietyGradeText = 'A级(推荐)';
      break;
    case 'B':
      varietyScore = 15;
      varietyGradeText = 'B级(一般)';
      break;
    case 'C':
      varietyScore = 5;
      varietyGradeText = 'C级(谨慎)';
      break;
  }
  
  // 技术信号评分 (0-30分)
  const technicalScore = Math.min(30, technicalStrength * 0.3);
  
  // 光谱定位评分 (0-10分)
  let spectrumScore = 0;
  let spectrumText = '';
  switch (spectrumPosition) {
    case 'trend':
      spectrumScore = 10;
      spectrumText = '趋势(最佳)';
      break;
    case 'channel':
      spectrumScore = 5;
      spectrumText = '通道(良好)';
      break;
    case 'range':
      spectrumScore = 0;
      spectrumText = '区间(不推荐)';
      break;
  }
  
  const totalScore = Math.round(timeframeScore + varietyScore + technicalScore + spectrumScore);
  
  return {
    totalScore,
    timeframeScore,
    varietyScore,
    technicalScore: Math.round(technicalScore),
    spectrumScore,
    details: {
      timeframeMatch: `${timeframeMatch} (盈亏比: ${perf.profitFactor.toFixed(2)})`,
      varietyGrade: `${variety.grade}级 - ${varietyGradeText}`,
      technicalStrength: `${Math.round(technicalStrength)}%`,
      spectrumPosition: spectrumText
    }
  };
}

/**
 * 获取组合推荐
 */
export function getPortfolioRecommendation(): PortfolioRecommendation {
  const grades = getVarietyGrades();
  
  // 筛选推荐品种
  const recommended = grades.filter(g => g.grade === 'S' || g.grade === 'A');
  
  // 核心仓位：S级品种
  const corePositions: PortfolioItem[] = recommended
    .filter(g => g.grade === 'S')
    .slice(0, 3)
    .map(g => ({
      code: g.code,
      name: g.name,
      timeframe: g.bestTimeframe,
      profitFactor: g.bestProfitFactor,
      weight: 25
    }));
  
  // 辅助仓位：A级品种
  const auxiliaryPositions: PortfolioItem[] = recommended
    .filter(g => g.grade === 'A')
    .slice(0, 3)
    .map(g => ({
      code: g.code,
      name: g.name,
      timeframe: g.bestTimeframe,
      profitFactor: g.bestProfitFactor,
      weight: 15
    }));
  
  // 观察仓位：B级品种
  const watchPositions: PortfolioItem[] = grades
    .filter(g => g.grade === 'B')
    .slice(0, 3)
    .map(g => ({
      code: g.code,
      name: g.name,
      timeframe: g.bestTimeframe,
      profitFactor: g.bestProfitFactor,
      weight: 5
    }));
  
  // 计算预期盈亏比
  const allPositions = [...corePositions, ...auxiliaryPositions, ...watchPositions];
  const totalWeight = allPositions.reduce((sum, p) => sum + p.weight, 0);
  const expectedProfitFactor = allPositions.reduce((sum, p) => sum + p.profitFactor * (p.weight / totalWeight), 0);
  
  const expectedAnnualReturn = `${Math.round(expectedProfitFactor * 15 - 15)}-${Math.round(expectedProfitFactor * 20 - 10)}%`;
  
  return {
    corePositions,
    auxiliaryPositions,
    watchPositions,
    expectedProfitFactor: Math.round(expectedProfitFactor * 100) / 100,
    expectedAnnualReturn
  };
}

/**
 * 获取周期统计
 */
export function getTimeframeStats(): { timeframe: string; count: number; percentage: number }[] {
  const grades = getVarietyGrades();
  const stats = new Map<string, number>();
  
  for (const g of grades) {
    stats.set(g.bestTimeframe, (stats.get(g.bestTimeframe) || 0) + 1);
  }
  
  const total = grades.length;
  return Array.from(stats.entries())
    .map(([timeframe, count]) => ({
      timeframe,
      count,
      percentage: Math.round(count / total * 100)
    }))
    .sort((a, b) => b.count - a.count);
}
