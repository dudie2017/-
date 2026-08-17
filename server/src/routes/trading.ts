/**
 * 交易记录路由
 */

import { Router, type Request, type Response } from 'express';
import {
  createManualTrade,
  getManualTrades,
  getManualTradeById,
  closeManualTrade,
  addBrooksReview,
  deleteManualTrade,
  getSimulatedAccount,
  updateSimulatedCapital,
  createSimulatedTrade,
  getSimulatedTrades,
  closeSimulatedTrade,
  deleteSimulatedTrade,
  generateBrooksReview,
  calculateMaxPosition,
  CONTRACT_MULTIPLIERS,
  upsertDailyReview,
  getDailyReviewByDate,
  getDailyReviews,
  upsertVarietyReview,
  getVarietyReviewsByDate,
  deleteVarietyReview,
} from '../services/tradingRecord.js';

const router = Router();

// ============ 手动交易路由 ============

/**
 * GET /api/v1/trading/manual
 * 获取所有手动交易记录
 */
router.get('/manual', async (req, res) => {
  try {
    const { status } = req.query;
    const trades = await getManualTrades(status as string);
    res.json({ success: true, data: trades });
  } catch (error) {
    console.error('Error getting manual trades:', error);
    res.status(500).json({ success: false, error: 'Failed to get manual trades' });
  }
});

/**
 * GET /api/v1/trading/manual/:id
 * 获取单个手动交易记录
 */
router.get('/manual/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const trade = await getManualTradeById(parseInt(id));
    if (!trade) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error getting manual trade:', error);
    res.status(500).json({ success: false, error: 'Failed to get manual trade' });
  }
});

/**
 * POST /api/v1/trading/manual
 * 创建手动交易记录
 */
router.post('/manual', async (req, res) => {
  try {
    const trade = await createManualTrade(req.body);
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error creating manual trade:', error);
    res.status(500).json({ success: false, error: 'Failed to create manual trade' });
  }
});

/**
 * PUT /api/v1/trading/manual/:id/close
 * 平仓手动交易
 */
router.put('/manual/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const { exitPrice, exitTime, exitReason, signal_review, exit_notes, lessons } = req.body;

    if (!exitPrice || !exitTime) {
      res.status(400).json({ success: false, error: 'exitPrice and exitTime are required' });
      return;
    }

    const trade = await closeManualTrade(parseInt(id), exitPrice, exitTime, exitReason, signal_review, exit_notes, lessons);
    if (!trade) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error closing manual trade:', error);
    res.status(500).json({ success: false, error: 'Failed to close manual trade' });
  }
});

/**
 * GET /api/v1/trading/manual/:id/brooks-review
 * 生成Brooks点评（预览）
 */
router.get('/manual/:id/brooks-review', async (req, res) => {
  try {
    const { id } = req.params;
    const trade = await getManualTradeById(parseInt(id));
    if (!trade) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    
    const review = generateBrooksReview(trade);
    res.json({ success: true, data: { review } });
  } catch (error) {
    console.error('Error generating Brooks review:', error);
    res.status(500).json({ success: false, error: 'Failed to generate review' });
  }
});

/**
 * PUT /api/v1/trading/manual/:id/brooks-review
 * 提交Brooks点评
 */
router.put('/manual/:id/brooks-review', async (req, res) => {
  try {
    const { id } = req.params;
    const { review, score, tags } = req.body;
    
    if (!review || !score) {
      res.status(400).json({ success: false, error: 'review and score are required' });
      return;
    }
    
    const trade = await addBrooksReview(parseInt(id), review, score, tags || []);
    if (!trade) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error adding Brooks review:', error);
    res.status(500).json({ success: false, error: 'Failed to add review' });
  }
});

/**
 * DELETE /api/v1/trading/manual/:id
 * 删除手动交易记录
 */
router.delete('/manual/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await deleteManualTrade(parseInt(id));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, message: 'Trade deleted' });
  } catch (error) {
    console.error('Error deleting manual trade:', error);
    res.status(500).json({ success: false, error: 'Failed to delete trade' });
  }
});

// ============ 模拟交易路由 ============

/**
 * GET /api/v1/trading/simulated/account
 * 获取模拟账户信息
 */
router.get('/simulated/account', async (req, res) => {
  try {
    const account = await getSimulatedAccount();
    res.json({ success: true, data: account });
  } catch (error) {
    console.error('Error getting simulated account:', error);
    res.status(500).json({ success: false, error: 'Failed to get account' });
  }
});

/**
 * PUT /api/v1/trading/simulated/account/capital
 * 更新模拟账户本金
 */
router.put('/simulated/account/capital', async (req, res) => {
  try {
    const { currentCapital } = req.body;
    if (!currentCapital || currentCapital <= 0) {
      res.status(400).json({ success: false, error: 'Invalid currentCapital' });
      return;
    }
    
    const account = await updateSimulatedCapital(currentCapital);
    res.json({ success: true, data: account });
  } catch (error) {
    console.error('Error updating capital:', error);
    res.status(500).json({ success: false, error: 'Failed to update capital' });
  }
});

/**
 * GET /api/v1/trading/simulated
 * 获取所有模拟交易记录
 */
router.get('/simulated', async (req, res) => {
  try {
    const { status } = req.query;
    const trades = await getSimulatedTrades(status as string);
    res.json({ success: true, data: trades });
  } catch (error) {
    console.error('Error getting simulated trades:', error);
    res.status(500).json({ success: false, error: 'Failed to get simulated trades' });
  }
});

/**
 * POST /api/v1/trading/simulated
 * 创建模拟交易记录
 */
router.post('/simulated', async (req, res) => {
  try {
    const trade = await createSimulatedTrade(req.body);
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error creating simulated trade:', error);
    res.status(500).json({ success: false, error: 'Failed to create simulated trade' });
  }
});

/**
 * PUT /api/v1/trading/simulated/:id/close
 * 平仓模拟交易
 */
router.put('/simulated/:id/close', async (req, res) => {
  try {
    const { id } = req.params;
    const { exitPrice, exitTime, exitReason } = req.body;
    
    if (!exitPrice || !exitTime) {
      res.status(400).json({ success: false, error: 'exitPrice and exitTime are required' });
      return;
    }
    
    const trade = await closeSimulatedTrade(parseInt(id), exitPrice, exitTime, exitReason);
    if (!trade) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, data: trade });
  } catch (error) {
    console.error('Error closing simulated trade:', error);
    res.status(500).json({ success: false, error: 'Failed to close simulated trade' });
  }
});

/**
 * DELETE /api/v1/trading/simulated/:id
 * 删除模拟交易记录
 */
router.delete('/simulated/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await deleteSimulatedTrade(parseInt(id));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Trade not found' });
      return;
    }
    res.json({ success: true, message: 'Trade deleted' });
  } catch (error) {
    console.error('Error deleting simulated trade:', error);
    res.status(500).json({ success: false, error: 'Failed to delete trade' });
  }
});

/**
 * POST /api/v1/trading/calculate-position
 * 计算最大开仓手数
 */
router.post('/calculate-position', (req, res) => {
  try {
    const { capital, riskPercent, entryPrice, stopLoss, varietyCode } = req.body;
    
    if (!capital || !riskPercent || !entryPrice || !stopLoss || !varietyCode) {
      res.status(400).json({ success: false, error: 'Missing required parameters' });
      return;
    }
    
    const contractMultiplier = CONTRACT_MULTIPLIERS[varietyCode] || 10;
    const maxPosition = calculateMaxPosition(capital, riskPercent, entryPrice, stopLoss, contractMultiplier);
    
    res.json({
      success: true,
      data: {
        maxPosition,
        contractMultiplier,
        riskAmount: capital * (riskPercent / 100),
        riskPerUnit: Math.abs(entryPrice - stopLoss),
      }
    });
  } catch (error) {
    console.error('Error calculating position:', error);
    res.status(500).json({ success: false, error: 'Failed to calculate position' });
  }
});

// ============ 每日复盘路由 ============

/**
 * GET /api/v1/trading/reviews
 * 获取复盘列表（最近N天）
 */
router.get('/reviews', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 30;
    const reviews = await getDailyReviews(limit);
    res.json({ success: true, data: reviews });
  } catch (error) {
    console.error('Error getting reviews:', error);
    res.status(500).json({ success: false, error: 'Failed to get reviews' });
  }
});

/**
 * GET /api/v1/trading/reviews/:date
 * 获取某日复盘
 */
router.get('/reviews/:date', async (req, res) => {
  try {
    const review = await getDailyReviewByDate(req.params.date);
    if (!review) {
      res.status(404).json({ success: false, error: 'Review not found' });
      return;
    }
    res.json({ success: true, data: review });
  } catch (error) {
    console.error('Error getting review:', error);
    res.status(500).json({ success: false, error: 'Failed to get review' });
  }
});

/**
 * POST /api/v1/trading/reviews
 * 创建/更新复盘
 */
router.post('/reviews', async (req, res) => {
  try {
    const review = await upsertDailyReview(req.body);
    res.json({ success: true, data: review });
  } catch (error) {
    console.error('Error saving review:', error);
    res.status(500).json({ success: false, error: 'Failed to save review' });
  }
});

/**
 * GET /api/v1/trading/reviews/:date/varieties
 * 获取某日全部品种级复盘
 */
router.get('/reviews/:date/varieties', async (req, res) => {
  try {
    const reviews = getVarietyReviewsByDate(req.params.date);
    res.json({ success: true, data: reviews });
  } catch (error) {
    console.error('Error getting variety reviews:', error);
    res.status(500).json({ success: false, error: 'Failed to get variety reviews' });
  }
});

/**
 * POST /api/v1/trading/reviews/:date/varieties
 * 创建/更新单品种复盘
 * Body: variety_code: string, variety_name: string, premarket_state?: string,
 *       market_state_actual?: string, state_correct?: boolean, ai_direction?: string,
 *       signal_grade?: string, signal_notes?: string, key_levels?: string, notes?: string
 */
router.post('/reviews/:date/varieties', async (req, res) => {
  try {
    const review = upsertVarietyReview({ ...req.body, review_date: req.params.date });
    res.json({ success: true, data: review });
  } catch (error) {
    console.error('Error saving variety review:', error);
    res.status(500).json({ success: false, error: 'Failed to save variety review' });
  }
});

/**
 * DELETE /api/v1/trading/reviews/:date/varieties/:code
 * 删除某日某品种的复盘
 */
router.delete('/reviews/:date/varieties/:code', async (req, res) => {
  try {
    const ok = deleteVarietyReview(req.params.date, req.params.code);
    res.json({ success: ok });
  } catch (error) {
    console.error('Error deleting variety review:', error);
    res.status(500).json({ success: false, error: 'Failed to delete variety review' });
  }
});

export default router;
