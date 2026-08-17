/**
 * 机器学习优化 API 路由
 */

import { Router } from 'express';
import {
  trainModels,
  getAllVarietyRecommendations,
  predictVariety,
  getFeatureImportanceFromForest,
} from '../services/modelTraining';
import { getDynamicParameterService } from '../services/dynamicParameter';

const router = Router();

/**
 * GET /api/v1/ml-optimization/train
 * 训练模型
 */
router.get('/train', (req, res) => {
  try {
    const performance = trainModels();
    res.json({
      success: true,
      data: {
        message: '模型训练完成',
        performance,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '模型训练失败',
    });
  }
});

/**
 * GET /api/v1/ml-optimization/recommendations
 * 获取所有品种推荐
 */
router.get('/recommendations', async (req, res) => {
  try {
    const recommendations = await getAllVarietyRecommendations();
    
    // 按置信度排序
    const sorted = recommendations.sort((a, b) => b.confidence - a.confidence);
    
    res.json({
      success: true,
      data: {
        varietiesCount: sorted.length,
        recommendations: sorted,
        topPicks: sorted.slice(0, 5),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取推荐失败',
    });
  }
});

/**
 * GET /api/v1/ml-optimization/predict/:code
 * 预测单个品种
 */
router.get('/predict/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { volatility, trend } = req.query;
    
    const prediction = predictVariety(code, {
      marketState: {
        volatility: (volatility as string) || 'medium',
        trend: (trend as string) || 'neutral',
        atrRatio: 1.0,
      },
    });
    
    res.json({
      success: true,
      data: prediction,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '预测失败',
    });
  }
});

/**
 * GET /api/v1/ml-optimization/feature-importance
 * 获取特征重要性
 */
router.get('/feature-importance', (req, res) => {
  try {
    // 特征重要性直接取自训练好的随机森林（基尼重要性）
    const importance = getFeatureImportanceFromForest();
    
    // 排序
    const sorted = Object.entries(importance)
      .sort((a, b) => b[1] - a[1])
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, {} as Record<string, number>);
    
    res.json({
      success: true,
      data: {
        featureImportance: sorted,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取特征重要性失败',
    });
  }
});

/**
 * POST /api/v1/ml-optimization/optimize-params
 * 动态参数优化
 */
router.post('/optimize-params', (req, res) => {
  try {
    const { code, currentParams, marketState, performance } = req.body;
    
    if (!code || !currentParams || !marketState || !performance) {
      return res.status(400).json({
        success: false,
        error: '缺少必要参数',
      });
    }
    
    const service = getDynamicParameterService();
    const optimizedParams = service.getOptimizedParams(
      code,
      currentParams,
      marketState,
      performance
    );
    
    const learningCurve = service.getLearningCurve(code);
    
    res.json({
      success: true,
      data: {
        code,
        originalParams: currentParams,
        optimizedParams,
        learningCurve: learningCurve.slice(-10), // 最近 10 次
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '参数优化失败',
    });
  }
});

export default router;
