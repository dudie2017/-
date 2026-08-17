/**
 * 风控熔断API路由
 */

import { Router } from 'express';
import { checkAllCircuitBreakers, getCircuitBreakerSummary } from '../services/circuitBreaker.js';

const router = Router();

/**
 * GET /api/v1/circuit-breaker/:code
 * 获取单个品种的熔断状态
 */
router.get('/:code', (req, res) => {
  try {
    const { code } = req.params;
    const result = checkAllCircuitBreakers(code);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取熔断状态失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/circuit-breaker/:code/summary
 * 获取熔断摘要（用于AI助手）
 */
router.get('/:code/summary', (req, res) => {
  try {
    const { code } = req.params;
    const summary = getCircuitBreakerSummary(code);
    
    res.json({
      success: true,
      data: {
        code,
        summary
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取熔断摘要失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/circuit-breaker
 * 获取所有品种的熔断状态
 */
router.get('/', (req, res) => {
  try {
    const codes = ['RB', 'I', 'JM', 'J', 'HC', 'CU', 'AL', 'ZN', 'PB', 'NI', 'SN', 'AU', 'AG', 
                   'L', 'V', 'PP', 'M', 'Y', 'P', 'OI', 'RM', 'CF', 'SR', 'TA', 'MA', 'BU', 'RU', 
                   'AP', 'SA', 'FG', 'JD', 'LH', 'SI', 'LC', 'PS'];
    
    const results = codes.map(code => ({
      code,
      ...checkAllCircuitBreakers(code)
    }));
    
    res.json({
      success: true,
      data: results
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取熔断状态失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
