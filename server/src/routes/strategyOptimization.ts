/**
 * 策略优化 API 路由
 * 提供参数稳健性分析、市场状态分析、元模型推荐、自适应参数、分析重跑等接口
 */

import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  REGIME_PARAM_MAP,
  DEFAULT_PARAMS,
  runAdaptiveAnalysis,
} from '../scripts/adaptiveBacktestFramework';
import { runAnalysis } from '../scripts/strategyOptimizationAnalysis';
import { runMetaModelAnalysis } from '../scripts/metaModelService';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../data');

const router = Router();

// 加载分析结果
function loadAnalysisResult(filename: string) {
  const filePath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * 获取参数稳健性分析结果
 * GET /api/v1/strategy-optimization/parameter-analysis
 */
router.get('/parameter-analysis', (req, res) => {
  try {
    const result = loadAnalysisResult('strategyOptimizationAnalysis.json');

    if (!result) {
      return res.status(404).json({
        success: false,
        error: '分析结果不存在，请先运行参数稳健性分析脚本',
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error getting parameter analysis:', error);
    res.status(500).json({
      success: false,
      error: '获取参数分析失败',
    });
  }
});

/**
 * 获取市场状态分析结果
 * GET /api/v1/strategy-optimization/market-regime
 */
router.get('/market-regime', (req, res) => {
  try {
    const result = loadAnalysisResult('marketRegimeAnalysis.json');

    if (!result) {
      return res.status(404).json({
        success: false,
        error: '分析结果不存在，请先运行市场状态分析脚本',
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error getting market regime analysis:', error);
    res.status(500).json({
      success: false,
      error: '获取市场状态分析失败',
    });
  }
});

/**
 * 获取元模型分析结果（品种推荐）
 * GET /api/v1/strategy-optimization/meta-model
 */
router.get('/meta-model', (req, res) => {
  try {
    const result = loadAnalysisResult('metaModelAnalysis.json');

    if (!result) {
      return res.status(404).json({
        success: false,
        error: '分析结果不存在，请先运行元模型分析脚本',
      });
    }

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Error getting meta model analysis:', error);
    res.status(500).json({
      success: false,
      error: '获取元模型分析失败',
    });
  }
});

/**
 * 获取自适应参数配置
 * GET /api/v1/strategy-optimization/adaptive-params/:code
 * Query: volatility=low|medium|high, trend=strong_up|neutral|strong_down
 */
router.get('/adaptive-params/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { volatility, trend } = req.query;

    if (!volatility || !trend) {
      return res.status(400).json({
        success: false,
        error: '缺少参数：volatility 和 trend',
      });
    }

    const key = `${volatility}_${trend}`;
    const adjustments = REGIME_PARAM_MAP[key] || {};

    res.json({
      success: true,
      data: {
        code,
        regime: { volatility, trend },
        params: { ...DEFAULT_PARAMS, ...adjustments },
      },
    });
  } catch (error) {
    console.error('Error getting adaptive params:', error);
    res.status(500).json({
      success: false,
      error: '获取自适应参数失败',
    });
  }
});

let isAnalysisRunning = false;

/**
 * 重新运行策略优化分析（重新生成三份 JSON 结果）
 * POST /api/v1/strategy-optimization/run-analysis
 */
router.post('/run-analysis', (req, res) => {
  if (isAnalysisRunning) {
    return res.status(409).json({
      success: false,
      error: '分析正在进行中，请稍后再试',
    });
  }

  isAnalysisRunning = true;
  try {
    runAnalysis();
    runMetaModelAnalysis();
    runAdaptiveAnalysis();

    res.json({
      success: true,
      data: {
        message: '分析完成，已重新生成参数分析、元模型、市场状态结果',
      },
    });
  } catch (error) {
    console.error('Error running strategy optimization analysis:', error);
    res.status(500).json({
      success: false,
      error: '分析失败',
    });
  } finally {
    isAnalysisRunning = false;
  }
});

export default router;
