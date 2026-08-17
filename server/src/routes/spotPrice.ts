/**
 * 现货价格API路由
 */

import { Router } from 'express';
import { getSpotPriceHistory, getLatestSpotPrice } from '../services/database.js';

const router = Router();

/**
 * GET /api/v1/spot-price
 * 获取现货价格历史
 */
router.get('/', (req, res) => {
  try {
    const { code, startDate, endDate, limit } = req.query;
    
    const records = getSpotPriceHistory({
      code: code as string,
      startDate: startDate as string,
      endDate: endDate as string,
      limit: limit ? parseInt(limit as string) : 30
    });
    
    res.json({
      success: true,
      data: records
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取现货价格失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/spot-price/:code/latest
 * 获取单个品种最新现货价格
 */
router.get('/:code/latest', (req, res) => {
  try {
    const { code } = req.params;
    const record = getLatestSpotPrice(code);
    
    if (!record) {
      return res.json({
        success: true,
        data: null,
        message: '未找到该品种的现货价格数据'
      });
    }
    
    res.json({
      success: true,
      data: record
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取现货价格失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/v1/spot-price/summary
 * 获取所有品种最新现货价格摘要
 */
router.get('/summary/all', (req, res) => {
  try {
    // 获取所有品种的最新现货价格
    const allRecords = getSpotPriceHistory({ limit: 200 });
    
    // 按品种分组，取最新的
    const latestByCode: Record<string, any> = {};
    for (const record of allRecords) {
      if (!latestByCode[record.code] || record.trade_date > latestByCode[record.code].trade_date) {
        latestByCode[record.code] = record;
      }
    }
    
    const summary = Object.values(latestByCode).map((r: any) => ({
      code: r.code,
      name: r.name,
      spot_price: r.spot_price,
      futures_price: r.futures_price,
      basis: r.basis,
      basis_rate: r.basis_rate,
      trade_date: r.trade_date,
      data_source: r.data_source
    }));
    
    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: '获取现货价格摘要失败',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
