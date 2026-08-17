import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { trainVarietyModel, saveVarietyModel } from './modelTraining';
import { VARIETIES, GROUP_NAMES, listBacktestCodes } from './varieties';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 支持的品种列表：以 src/data/*_1000Experiments.json 动态扫描结果（listBacktestCodes）为唯一来源，
// 品种中文名回退到 VARIETIES，分组统一走 GROUP_NAMES。
// 这样新增回测文件后品种扩展列表会自动出现，避免手写硬编码列表与真实回测结果脱节。
const SUPPORTED_VARIETIES = listBacktestCodes().map((code) => ({
  code,
  name: VARIETIES[code] || code,
  sector: GROUP_NAMES[code] || '其他',
}));

/**
 * 获取支持的品种列表
 */
export function getSupportedVarieties() {
  return SUPPORTED_VARIETIES.map(v => ({
    ...v,
    hasBacktestData: hasBacktestData(v.code),
    hasModel: hasModel(v.code),
  }));
}

/**
 * 检查是否有回测数据
 */
function hasBacktestData(code: string): boolean {
  const dataPath = path.join(__dirname, '../data', `${code}_1000Experiments.json`);
  return fs.existsSync(dataPath);
}

/**
 * 检查是否有模型
 */
function hasModel(code: string): boolean {
  const modelPath = path.join(__dirname, '../models', `${code}_model.json`);
  return fs.existsSync(modelPath);
}

/**
 * 获取品种回测状态
 */
export function getVarietyBacktestStatus(code: string) {
  const dataPath = path.join(__dirname, '../data', `${code}_1000Experiments.json`);
  
  if (!fs.existsSync(dataPath)) {
    return {
      code,
      hasData: false,
      experimentsCount: 0,
    };
  }

  const data = JSON.parse(fs.readFileSync(dataPath, 'utf-8'));
  return {
    code,
    hasData: true,
    experimentsCount: data.fullResults?.length || 0,
    baseline: data.baseline,
    meta: data.meta,
  };
}

/**
 * 获取品种模型状态
 */
export function getVarietyModelStatus(code: string) {
  const modelPath = path.join(__dirname, '../models', `${code}_model.json`);
  
  if (!fs.existsSync(modelPath)) {
    return {
      code,
      hasModel: false,
      accuracy: undefined,
      version: undefined,
      barsCount: undefined,
    };
  }

  const model = JSON.parse(fs.readFileSync(modelPath, 'utf-8'));
  return {
    code,
    hasModel: true,
    accuracy: model.accuracy,
    precision: model.precision,
    recall: model.recall,
    f1Score: model.f1Score,
    version: model.version || 'v1.0',
    barsCount: model.barsCount || 0,
  };
}

/**
 * 触发品种模型训练（真实训练，非 Mock）
 * 基于该品种的回测实验数据训练分类器，样本不足时回退到全局模型训练，
 * 并将训练结果（性能指标 + 特征重要性）落盘为 `src/models/{code}_model.json`。
 */
export async function triggerModelTraining(code: string) {
  const performance = trainVarietyModel(code);

  const modelPath = saveVarietyModel(code, {
    accuracy: performance.accuracy,
    precision: performance.precision,
    recall: performance.recall,
    f1Score: performance.f1Score,
    featureImportance: performance.featureImportance,
    samples: performance.samples,
    varietySamples: performance.varietySamples,
    version: `v${Date.now()}`,
  });

  return {
    code,
    status: 'completed',
    performance,
    modelPath,
    message: `品种 ${code} 的模型训练已完成`,
  };
}
