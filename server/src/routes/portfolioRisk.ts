/**
 * 组合风控监控 API 路由
 */

import { Router } from 'express';
import { generatePortfolioRiskReport } from '../services/portfolioRiskMonitor.js';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams.js';

const router = Router();

/**
 * GET /api/v1/portfolio-risk
 * 获取组合风控报告
 */
router.get('/', (req, res) => {
  try {
    const report = generatePortfolioRiskReport();
    
    res.json({
      success: true,
      data: report,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取组合风控报告失败',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/portfolio/varieties
 * 获取品种验证状态（从 realtimeOptParams）
 */
router.get('/varieties', (req, res) => {
  try {
    const varieties = Object.entries(REALTIME_OPT_PARAMS).map(([code, params]) => ({
      code,
      validationStatus: params.validationStatus,
      maxPositionPct: params.maxPositionPct,
      volReduce: params.volReduce,
      dailyLossLimit: params.dailyLossLimit,
      circuitBreaker: params.circuitBreaker,
    }));

    // 按验证状态排序：iron_clad > robust > sensitive > overfit > untested
    const statusOrder: Record<string, number> = { iron_clad: 0, robust: 1, sensitive: 2, overfit: 3, untested: 4 };
    varieties.sort((a, b) => statusOrder[a.validationStatus] - statusOrder[b.validationStatus]);

    res.json({
      success: true,
      data: varieties,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取品种验证状态失败',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
