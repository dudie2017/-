/**
 * 模型性能监控路由
 * 提供模型版本管理、性能监控、回滚功能
 */

import express from 'express';
import {
  getActiveModelVersion,
  getAllModelVersions,
  activateModelVersion,
  rollbackToPreviousVersion,
  needsRetraining,
  calculatePerformanceDecay,
} from '../services/modelVersionManager';
import { executeRetrain, loadForests } from '../services/modelTraining';

const router = express.Router();

/**
 * GET /api/v1/model-monitoring/versions
 * 获取所有模型版本
 */
router.get('/versions', async (req, res) => {
  try {
    const versions = await getAllModelVersions();
    res.json({
      success: true,
      data: {
        versions,
        total: versions.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取模型版本失败',
    });
  }
});

/**
 * GET /api/v1/model-monitoring/active
 * 获取当前活跃版本
 */
router.get('/active', async (req, res) => {
  try {
    const activeVersion = await getActiveModelVersion();
    res.json({
      success: true,
      data: {
        activeVersion,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取活跃版本失败',
    });
  }
});

/**
 * POST /api/v1/model-monitoring/activate
 * 激活指定版本
 */
router.post('/activate', async (req, res) => {
  try {
    const { version } = req.body;

    if (!version) {
      return res.status(400).json({
        success: false,
        error: '缺少版本号',
      });
    }

    const success = await activateModelVersion(version);

    if (success) {
      // 激活后同步加载对应版本的森林到内存
      const loaded = loadForests(version);
      res.json({
        success: true,
        message: loaded ? `版本 ${version} 已激活并加载` : `版本 ${version} 已激活（未找到模型文件，将惰性重训练）`,
      });
    } else {
      res.status(500).json({
        success: false,
        error: '激活版本失败',
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '激活版本失败',
    });
  }
});

/**
 * POST /api/v1/model-monitoring/rollback
 * 回滚到上一个版本
 */
router.post('/rollback', async (req, res) => {
  try {
    const result = await rollbackToPreviousVersion();

    if (result.success) {
      res.json({
        success: true,
        data: {
          rolledBackTo: result.previousVersion,
        },
        message: result.message,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.message,
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '回滚失败',
    });
  }
});

/**
 * GET /api/v1/model-monitoring/decay
 * 计算性能衰减
 */
router.get('/decay', async (req, res) => {
  try {
    const { current, previous } = req.query;

    if (!current || !previous) {
      return res.status(400).json({
        success: false,
        error: '缺少 current 或 previous 参数',
      });
    }

    const decay = await calculatePerformanceDecay(
      current as string,
      previous as string
    );

    res.json({
      success: true,
      data: {
        currentVersion: current,
        previousVersion: previous,
        decay,
        decayPercentage: (decay * 100).toFixed(2) + '%',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '计算性能衰减失败',
    });
  }
});

/**
 * GET /api/v1/model-monitoring/needs-retrain
 * 检查是否需要重训练
 */
router.get('/needs-retrain', async (req, res) => {
  try {
    const threshold = parseFloat(req.query.threshold as string) || 0.1;
    const result = await needsRetraining(threshold);

    res.json({
      success: true,
      data: {
        needsRetraining: result.needsRetraining,
        currentVersion: result.currentVersion,
        decay: result.decay,
        decayPercentage: (result.decay * 100).toFixed(2) + '%',
        threshold: threshold,
        thresholdPercentage: (threshold * 100).toFixed(0) + '%',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '检查重训练需求失败',
    });
  }
});

/**
 * POST /api/v1/model-monitoring/retrain
 * 手动触发重训练
 */
router.post('/retrain', async (req, res) => {
  try {
    const result = await executeRetrain();

    res.json({
      success: true,
      data: result,
      message: '重训练完成',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '重训练失败',
    });
  }
});

export default router;
