/**
 * 交易成本路由
 */

import { Router } from 'express';
import { getTradingCost, getBatchTradingCosts } from '../services/tradingCost.js';

const router = Router();

/**
 * 获取单个合约的交易成本
 * GET /api/v1/trading-cost/:varietyCode/:contractId?date=20251009&price=4000
 */
router.get('/:varietyCode/:contractId', async (req, res) => {
  try {
    const { varietyCode, contractId } = req.params;
    const { date, price } = req.query;
    const tradeDate = (date as string) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const currentPrice = parseFloat(price as string) || 4000;
    
    const cost = await getTradingCost(varietyCode, contractId, tradeDate, currentPrice);
    
    res.json({
      success: true,
      ...cost,
    });
  } catch (error: any) {
    console.error('获取交易成本失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 批量获取交易成本
 * POST /api/v1/trading-cost/batch
 * Body: { contracts: [{ varietyCode: 'A', contractId: 'a2601', currentPrice: 4000 }], date: '20251009' }
 */
router.post('/batch', async (req, res) => {
  try {
    const { contracts, date } = req.body;
    const tradeDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    if (!Array.isArray(contracts) || contracts.length === 0) {
      res.status(400).json({
        success: false,
        error: '请提供合约列表',
      });
      return;
    }
    
    const costs = await getBatchTradingCosts(contracts, tradeDate);
    
    res.json({
      success: true,
      tradeDate,
      count: costs.length,
      data: costs,
    });
  } catch (error: any) {
    console.error('批量获取交易成本失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
