/**
 * 大商所(DCE)官方API路由
 */

import { Router } from 'express';
import { 
  checkDCEStatus, 
  getDailyQuotes, 
  getLatestTradeDate,
  getVarietyList,
  isDCEVariety 
} from '../services/dceApiService.js';

const router = Router();

/**
 * 检查大商所API状态
 * GET /api/v1/dce/status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await checkDCEStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取最近交易日
 * GET /api/v1/dce/latest-trade-date
 */
router.get('/latest-trade-date', async (req, res) => {
  try {
    const date = await getLatestTradeDate();
    res.json({
      success: true,
      data: { tradeDate: date }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取品种列表
 * GET /api/v1/dce/varieties
 */
router.get('/varieties', async (req, res) => {
  try {
    const varieties = await getVarietyList();
    res.json({
      success: true,
      data: varieties
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取日行情
 * GET /api/v1/dce/daily?variety=M&date=20250708
 */
router.get('/daily', async (req, res) => {
  try {
    const { variety, date } = req.query;
    
    if (!variety || typeof variety !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'variety参数必填'
      });
    }
    
    if (!isDCEVariety(variety)) {
      return res.status(400).json({
        success: false,
        error: `${variety}不是大商所品种`
      });
    }
    
    const quotes = await getDailyQuotes(variety, date as string);
    
    res.json({
      success: true,
      data: {
        variety,
        tradeDate: date || await getLatestTradeDate(),
        count: quotes.length,
        quotes
      }
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
