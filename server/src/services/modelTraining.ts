/**
 * 模型训练服务
 * 使用自实现随机森林（CART 决策树 + bootstrap）进行品种选择与参数预测
 * 包含：分层训练/测试切分、测试集评估、森林持久化
 */

import {
  getAllFeatures,
  extractFeatures,
  generateReturnLabel,
  generateDrawdownLabel,
  computeLabelThresholds,
  getNestedValue,
  NUMERIC_FEATURES,
} from './featureEngineering';
import type { ExperimentFeatures, LabelThresholds } from './featureEngineering';
import { RandomForest } from './randomForest';
import {
  recordModelVersion,
  activateModelVersion,
  getActiveModelVersionSync,
} from './modelVersionManager';
import { listBacktestCodes, type BarData } from './varieties';
import { getVarietyData } from './dataFetcher';
import { calcATR } from './indicators';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MODELS_DIR = path.join(__dirname, '..', 'models');

export interface ModelPrediction {
  code: string;
  predictedReturn: string; // high_return/medium_return/low_return/negative_return
  predictedRisk: string; // low_risk/medium_risk/high_risk/extreme_risk
  confidence: number;
  recommendedParams: {
    atrPeriod: number;
    holdPeriod: number;
    stopAtrMult: number;
    targetAtrMult: number;
  };
}

export interface ModelPerformance {
  accuracy: number;
  precision: number;
  recall: number;
  f1Score: number;
  featureImportance: Record<string, number>;
  trainSamples: number;
  testSamples: number;
}

// 全局森林实例（收益 + 风险）
let returnForest: RandomForest | null = null;
let riskForest: RandomForest | null = null;

/**
 * 将 ExperimentFeatures 转换为数值特征向量（按 NUMERIC_FEATURES 顺序）
 */
function toVector(feature: ExperimentFeatures): number[] {
  return NUMERIC_FEATURES.map((name) => {
    const v = getNestedValue(feature, name);
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
}

/**
 * 分层随机切分：按标签分组，保证训练/测试集类别均衡
 */
function stratifiedSplit(
  labels: string[],
  testRatio: number
): { trainIdx: number[]; testIdx: number[] } {
  const groups = new Map<string, number[]>();
  labels.forEach((label, i) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(i);
  });

  const trainIdx: number[] = [];
  const testIdx: number[] = [];

  for (const indices of groups.values()) {
    const shuffled = [...indices].sort(() => Math.random() - 0.5);
    const testCount = Math.max(1, Math.floor(shuffled.length * testRatio));
    testIdx.push(...shuffled.slice(0, testCount));
    trainIdx.push(...shuffled.slice(testCount));
  }

  return { trainIdx, testIdx };
}

/**
 * 在给定样本集上评估森林（宏平均 precision/recall/f1）
 */
function evaluateForest(
  forest: RandomForest,
  X: number[][],
  labels: string[]
): { accuracy: number; precision: number; recall: number; f1Score: number } {
  if (X.length === 0) {
    return { accuracy: 0, precision: 0, recall: 0, f1Score: 0 };
  }

  const allLabels = forest.labels;
  const confusion: Record<string, Record<string, number>> = {};
  for (const l of allLabels) {
    confusion[l] = {};
    for (const p of allLabels) confusion[l][p] = 0;
  }

  let correct = 0;
  for (let i = 0; i < X.length; i++) {
    const pred = forest.predict(X[i]).label;
    const truth = labels[i];
    if (confusion[truth]) {
      confusion[truth][pred] = (confusion[truth][pred] || 0) + 1;
    }
    if (pred === truth) correct++;
  }

  const accuracy = correct / X.length;

  let precisionSum = 0;
  let recallSum = 0;
  let f1Sum = 0;
  for (const l of allLabels) {
    const tp = confusion[l][l] || 0;
    let fp = 0;
    let fn = 0;
    for (const p of allLabels) {
      if (p !== l) fp += confusion[p][l] || 0;
      if (p !== l) fn += confusion[l][p] || 0;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    precisionSum += precision;
    recallSum += recall;
    f1Sum += f1;
  }

  const labelCount = allLabels.length || 1;
  return {
    accuracy,
    precision: precisionSum / labelCount,
    recall: recallSum / labelCount,
    f1Score: f1Sum / labelCount,
  };
}

/**
 * 核心训练逻辑：切分 → 训练收益/风险森林 → 测试集评估
 * 返回森林实例 + 性能指标，由调用方决定是否设为全局
 */
function trainForestOnFeatures(features: ExperimentFeatures[]): {
  returnF: RandomForest;
  riskF: RandomForest;
  performance: ModelPerformance;
} {
  const emptyPerf: ModelPerformance = {
    accuracy: 0,
    precision: 0,
    recall: 0,
    f1Score: 0,
    featureImportance: {},
    trainSamples: 0,
    testSamples: 0,
  };

  if (features.length === 0) {
    return { returnF: new RandomForest(), riskF: new RandomForest(), performance: emptyPerf };
  }

  // 数据驱动的标签阈值
  const thresholds: LabelThresholds = computeLabelThresholds(features);
  const returnLabels = features.map((f) =>
    generateReturnLabel(f.results.totalReturn, thresholds.returnThresholds)
  );
  const riskLabels = features.map((f) =>
    generateDrawdownLabel(f.results.maxDrawdown, thresholds.drawdownThresholds)
  );

  // 特征矩阵
  const X = features.map(toVector);

  // 分层切分（按收益标签切分，两个分类器共用同一划分）
  const { trainIdx, testIdx } = stratifiedSplit(returnLabels, 0.2);

  let trainX: number[][];
  let testX: number[][];
  let trainReturnY: string[];
  let testReturnY: string[];
  let trainRiskY: string[];
  let testRiskY: string[];

  if (trainIdx.length === 0 || testIdx.length === 0) {
    // 样本过少无法切分时降级为同集评估
    trainX = X;
    testX = X;
    trainReturnY = returnLabels;
    testReturnY = returnLabels;
    trainRiskY = riskLabels;
    testRiskY = riskLabels;
  } else {
    trainX = trainIdx.map((i) => X[i]);
    testX = testIdx.map((i) => X[i]);
    trainReturnY = trainIdx.map((i) => returnLabels[i]);
    testReturnY = testIdx.map((i) => returnLabels[i]);
    trainRiskY = trainIdx.map((i) => riskLabels[i]);
    testRiskY = testIdx.map((i) => riskLabels[i]);
  }

  // 训练收益森林
  const returnF = new RandomForest();
  returnF.fit(trainX, trainReturnY, NUMERIC_FEATURES);

  // 训练风险森林
  const riskF = new RandomForest();
  riskF.fit(trainX, trainRiskY, NUMERIC_FEATURES);

  // 测试集评估
  const returnMetrics = evaluateForest(returnF, testX, testReturnY);
  const riskMetrics = evaluateForest(riskF, testX, testRiskY);

  const accuracy = (returnMetrics.accuracy + riskMetrics.accuracy) / 2;
  const precision = (returnMetrics.precision + riskMetrics.precision) / 2;
  const recall = (returnMetrics.recall + riskMetrics.recall) / 2;
  const f1Score = (returnMetrics.f1Score + riskMetrics.f1Score) / 2;

  // 特征重要性：收益/风险两个森林平均
  const returnImportance = returnF.getFeatureImportance();
  const riskImportance = riskF.getFeatureImportance();
  const featureImportance: Record<string, number> = {};
  for (const name of NUMERIC_FEATURES) {
    featureImportance[name] =
      ((returnImportance[name] || 0) + (riskImportance[name] || 0)) / 2;
  }

  return {
    returnF,
    riskF,
    performance: {
      accuracy,
      precision,
      recall,
      f1Score,
      featureImportance,
      trainSamples: trainX.length,
      testSamples: testX.length,
    },
  };
}

/**
 * 训练全局模型（全品种数据）
 */
export function trainModels(): ModelPerformance {
  const features = getAllFeatures();
  const { returnF, riskF, performance } = trainForestOnFeatures(features);
  returnForest = returnF;
  riskForest = riskF;
  return performance;
}

/**
 * 针对单个品种训练模型（基于该品种的回测实验数据）
 * 若该品种实验样本不足，回退到全局模型训练。
 */
export function trainVarietyModel(
  code: string
): ModelPerformance & { samples: number; varietySamples: number } {
  const features = extractFeatures(code);

  if (features.length >= 5) {
    const { performance } = trainForestOnFeatures(features);
    return { ...performance, samples: features.length, varietySamples: features.length };
  }

  // 样本不足，回退到全局模型（真实训练，基于所有有数据的品种）
  const globalFeatures = getAllFeatures();
  const global = trainModels();
  return { ...global, samples: globalFeatures.length, varietySamples: features.length };
}

// 预测用默认特征值（中性值），当调用方未提供真实市场状态时兜底
const DEFAULT_PARAMS = {
  atrPeriod: 20,
  holdPeriod: 10,
  stopAtrMult: 3,
  targetAtrMult: 3,
  maxLossStreak: 3,
  pauseBars: 3,
};
const DEFAULT_MARKET_STATE = {
  volatility: 'medium',
  trend: 'neutral',
  atrRatio: 1.0,
};
const DEFAULT_TECHNICAL = {
  maSlope20: 0,
  maSlope60: 0,
  pricePosition: 0.5,
  momentum: 0,
  meanReversion: 0,
};

/**
 * 确保全局森林已就绪：优先加载持久化模型，失败则惰性重训练
 */
function ensureModelsReady(): void {
  if (returnForest && riskForest) return;

  const active = getActiveModelVersionSync();
  if (active?.model_path && loadForests(active.version)) {
    return;
  }

  trainModels();
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 根据收益/风险预测给出参数建议
 */
function recommendParams(
  predictedReturn: string,
  predictedRisk: string
): ModelPrediction['recommendedParams'] {
  let atrPeriod = DEFAULT_PARAMS.atrPeriod;
  let holdPeriod = DEFAULT_PARAMS.holdPeriod;
  let stopAtrMult = DEFAULT_PARAMS.stopAtrMult;
  let targetAtrMult = DEFAULT_PARAMS.targetAtrMult;

  if (predictedReturn === 'high_return') {
    targetAtrMult = round1(targetAtrMult + 0.5);
    holdPeriod += 2;
  } else if (predictedReturn === 'negative_return') {
    targetAtrMult = Math.max(1, round1(targetAtrMult - 0.5));
  }

  if (predictedRisk === 'high_risk' || predictedRisk === 'extreme_risk') {
    stopAtrMult = Math.max(1, round1(stopAtrMult - 0.5));
  } else if (predictedRisk === 'low_risk') {
    stopAtrMult = round1(stopAtrMult + 0.5);
  }

  return { atrPeriod, holdPeriod, stopAtrMult, targetAtrMult };
}

/**
 * 从真实 30 分钟 K 线数据计算品种当前市场状态特征，供品种推荐注入真实数据。
 * 数据不足（<30 根 K 线）时返回 null，由调用方回退到默认特征。
 */
export async function loadLatestMarketState(
  code: string
): Promise<Record<string, unknown> | null> {
  try {
    const result = await getVarietyData(code, 120);
    if (!result || !result.bars || result.bars.length < 30) return null;

    const bars: BarData[] = result.bars; // 升序 BarData[]

  const closes = bars.map((b) => b.c);
  const n = closes.length;
  const last = closes[n - 1];

  // 波动率比值：当前 ATR14 / 近60日平均 ATR
  const atrSeries = calcATR(bars, 14);
  const validAtr = atrSeries.filter((v) => Number.isFinite(v) && v > 0);
  const atrNow = validAtr[validAtr.length - 1] ?? 0;
  const recentAtr = validAtr.slice(-60);
  const avgAtr = recentAtr.length
    ? recentAtr.reduce((a, b) => a + b, 0) / recentAtr.length
    : 0;
  const atrRatio = avgAtr > 0 ? atrNow / avgAtr : 1.0;

  // 均线斜率（近5日变化率，量级放大到与训练特征一致）
  const ma20 = calcSMA(closes, 20);
  const ma60 = calcSMA(closes, 60);
  const ma20Now = ma20[n - 1] ?? last;
  const ma20Prev = ma20[n - 6] ?? ma20[0] ?? ma20Now;
  const ma60Now = ma60[n - 1] ?? last;
  const ma60Prev = ma60[n - 6] ?? ma60[0] ?? ma60Now;
  const maSlope20 = ma20Prev > 0 ? (ma20Now - ma20Prev) / ma20Prev : 0;
  const maSlope60 = ma60Prev > 0 ? (ma60Now - ma60Prev) / ma60Prev : 0;

  // 价格位置：近60日高低区间相对位置（0~1）
  const recent = bars.slice(-60);
  const high60 = Math.max(...recent.map((b) => b.h));
  const low60 = Math.min(...recent.map((b) => b.l));
  const pricePosition = high60 > low60 ? (last - low60) / (high60 - low60) : 0.5;

  // 动量：近20日涨跌幅
  const close20ago = closes[n - 21] ?? closes[0];
  const momentum = close20ago > 0 ? (last - close20ago) / close20ago : 0;

  // 均值回归：价格偏离 MA20 的程度
  const meanReversion = ma20Now > 0 ? (last - ma20Now) / ma20Now : 0;

  return {
    marketState: { atrRatio: clamp(atrRatio, 0.2, 2) },
    technical: {
      maSlope20: clamp(maSlope20 * 20, -2, 2),
      maSlope60: clamp(maSlope60 * 20, -2, 2),
      pricePosition: clamp(pricePosition, 0, 1),
      momentum: clamp(momentum, -1, 1),
      meanReversion: clamp(meanReversion, -1, 1),
    },
  };
  } catch {
    return null;
  }
}

function calcSMA(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(v, min), max);
}

/**
 * 预测单个品种的收益/风险等级，并给出参数建议
 * currentFeatures 可选：{ params, marketState, technical } 的部分字段
 */
export function predictVariety(
  code: string,
  currentFeatures?: Record<string, unknown>
): ModelPrediction | null {
  ensureModelsReady();
  if (!returnForest || !riskForest) return null;

  const params = { ...DEFAULT_PARAMS, ...(currentFeatures?.params as object) };
  const marketState = { ...DEFAULT_MARKET_STATE, ...(currentFeatures?.marketState as object) };
  const technical = { ...DEFAULT_TECHNICAL, ...(currentFeatures?.technical as object) };

  const feature: ExperimentFeatures = {
    code,
    params: params as ExperimentFeatures['params'],
    marketState: marketState as ExperimentFeatures['marketState'],
    technical: technical as ExperimentFeatures['technical'],
    results: { totalReturn: 0, profitFactor: 0, maxDrawdown: 0, winRate: 0, sharpeRatio: 0 },
  };

  const vector = toVector(feature);
  const returnPred = returnForest.predict(vector);
  const riskPred = riskForest.predict(vector);

  return {
    code,
    predictedReturn: returnPred.label,
    predictedRisk: riskPred.label,
    confidence: round1((returnPred.confidence + riskPred.confidence) / 2),
    recommendedParams: recommendParams(returnPred.label, riskPred.label),
  };
}

/**
 * 获取所有品种的 ML 推荐结果
 */
export async function getAllVarietyRecommendations(): Promise<ModelPrediction[]> {
  const codes = listBacktestCodes();
  const predictions = await Promise.all(
    codes.map(async (code) => {
      const marketState = await loadLatestMarketState(code);
      return predictVariety(code, marketState ?? {});
    })
  );
  return predictions.filter((p): p is ModelPrediction => p !== null);
}

/**
 * 保存单品种模型训练结果到磁盘（src/models/{code}_model.json）
 */
export function saveVarietyModel(code: string, data: Record<string, unknown>): string {
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  const filePath = path.join(MODELS_DIR, `${code}_model.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/**
 * 保存全局森林到磁盘（src/models/model_{version}.json）
 */
export function saveForests(version: string): string {
  if (!returnForest || !riskForest) throw new Error('模型尚未训练，无法保存');
  if (!fs.existsSync(MODELS_DIR)) fs.mkdirSync(MODELS_DIR, { recursive: true });
  const filePath = path.join(MODELS_DIR, `model_${version}.json`);
  const payload = {
    version,
    savedAt: new Date().toISOString(),
    returnForest: returnForest.toJSON(),
    riskForest: riskForest.toJSON(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload));
  return filePath;
}

/**
 * 从磁盘加载指定版本的森林，成功返回 true
 */
export function loadForests(version: string): boolean {
  try {
    const filePath = path.join(MODELS_DIR, `model_${version}.json`);
    if (!fs.existsSync(filePath)) return false;
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    returnForest = RandomForest.fromJSON(payload.returnForest);
    riskForest = RandomForest.fromJSON(payload.riskForest);
    return true;
  } catch (e) {
    console.error('[modelTraining] 加载模型失败:', e);
    return false;
  }
}

/**
 * 从当前森林计算特征重要性（收益 + 风险森林平均）
 */
export function getFeatureImportanceFromForest(): Record<string, number> {
  ensureModelsReady();
  if (!returnForest || !riskForest) return {};

  const ret = returnForest.getFeatureImportance();
  const risk = riskForest.getFeatureImportance();
  const out: Record<string, number> = {};
  for (const name of NUMERIC_FEATURES) {
    out[name] = ((ret[name] || 0) + (risk[name] || 0)) / 2;
  }
  return out;
}

function generateVersion(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `v${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(
    now.getHours()
  )}${pad(now.getMinutes())}`;
}

/**
 * 执行重训练：训练 → 落盘 → 记录版本 → 激活
 */
export async function executeRetrain(): Promise<ModelPerformance> {
  const performance = trainModels();
  const version = generateVersion();
  const modelPath = saveForests(version);

  await recordModelVersion({
    version,
    accuracy: performance.accuracy,
    precision_score: performance.precision,
    recall_score: performance.recall,
    f1_score: performance.f1Score,
    training_samples: performance.trainSamples,
    varieties_count: listBacktestCodes().length,
    model_path: modelPath,
    notes: '自动重训练',
  });

  await activateModelVersion(version);
  return performance;
}
