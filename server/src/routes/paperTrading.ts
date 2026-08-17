/**
 * 模拟交易 API 路由
 */

import express from 'express';
import {
  openPaperTrade,
  closePaperTrade,
  getPaperTrades,
  getPaperTrade,
  getPaperTradePerformance,
  getMLvsManualComparison,
} from '../services/paperTrading';
import { getPaperPerformance } from '../services/paperTradingService';

const router = express.Router();

/**
 * 开仓
 * POST /api/v1/paper-trading/open
 * Body: { varietyCode, direction, entryPrice, quantity, source, mlConfidence?, mlPredictedReturn?, stopLoss?, takeProfit? }
 */
router.post('/open', async (req, res) => {
  try {
    const {
      varietyCode,
      direction,
      entryPrice,
      quantity,
      source,
      mlConfidence,
      mlPredictedReturn,
      stopLoss,
      takeProfit,
    } = req.body;

    if (!varietyCode || !direction || !entryPrice || !quantity || !source) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: varietyCode, direction, entryPrice, quantity, source',
      });
    }

    const trade = await openPaperTrade({
      varietyCode,
      direction,
      entryPrice,
      quantity,
      source,
      mlConfidence,
      mlPredictedReturn,
      stopLoss,
      takeProfit,
    });

    return res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error opening paper trade:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 平仓
 * POST /api/v1/paper-trading/close
 * Body: { tradeId, exitPrice }
 */
router.post('/close', async (req, res) => {
  try {
    const { tradeId, exitPrice } = req.body;

    if (!tradeId || !exitPrice) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: tradeId, exitPrice',
      });
    }

    const trade = await closePaperTrade({ tradeId, exitPrice });
    return res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error closing paper trade:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 获取交易列表
 * GET /api/v1/paper-trading/trades?status=&source=&varietyCode=&limit=
 */
router.get('/trades', async (req, res) => {
  try {
    const { status, source, varietyCode, limit } = req.query;
    const trades = await getPaperTrades({
      status: status as any,
      source: source as any,
      varietyCode: varietyCode as string,
      limit: limit ? parseInt(limit as string) : undefined,
    });
    return res.json({ success: true, data: trades });
  } catch (error) {
    console.error('Error getting paper trades:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 获取单笔交易
 * GET /api/v1/paper-trading/trades/:id
 */
router.get('/trades/:id', async (req, res) => {
  try {
    const trade = await getPaperTrade(req.params.id);
    if (!trade) {
      return res.status(404).json({ success: false, error: 'Trade not found' });
    }
    return res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error getting paper trade:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 获取绩效统计
 * GET /api/v1/paper-trading/performance
 */
router.get('/performance', async (req, res) => {
  try {
    const performance = getPaperPerformance();
    return res.json({ success: true, data: performance });
  } catch (error) {
    console.error('Error getting performance:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 获取手动模拟盘绩效统计（扁平结构，供 paper-trading 页面使用）
 * GET /api/v1/paper-trading/stats
 */
router.get('/stats', async (req, res) => {
  try {
    const performance = await getPaperTradePerformance();
    return res.json({ success: true, data: performance });
  } catch (error) {
    console.error('Error getting paper trading stats:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * 获取 ML vs 人工对比
 * GET /api/v1/paper-trading/comparison
 */
router.get('/comparison', async (req, res) => {
  try {
    const comparison = await getMLvsManualComparison();
    return res.json({ success: true, data: comparison });
  } catch (error) {
    console.error('Error getting comparison:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
