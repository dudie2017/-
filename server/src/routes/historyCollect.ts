/**
 * 历史数据收集路由
 */

import express from 'express';
import { collectAllHistoricalData, collectHistoricalWarehouseReceipts, collectHistoricalCapitalFlow, collectHistoricalDailyQuotes } from '../services/historicalDataCollector';

const router = express.Router();

/**
 * 收集所有历史数据
 * POST /api/v1/history-collect
 */
router.post('/', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    console.log(`[历史数据API] 开始收集过去 ${days} 天的历史数据`);
    
    const result = await collectAllHistoricalData(days);
    
    res.json({
      success: true,
      message: '历史数据收集完成',
      data: result,
    });
  } catch (error: any) {
    console.error('[历史数据API] 收集失败:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 只收集仓单历史数据
 * POST /api/v1/history-collect/warehouse-receipts
 */
router.post('/warehouse-receipts', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    const result = await collectHistoricalWarehouseReceipts(days);
    
    res.json({
      success: true,
      message: '仓单历史数据收集完成',
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 只收集持仓历史数据
 * POST /api/v1/history-collect/capital-flow
 */
router.post('/capital-flow', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    const result = await collectHistoricalCapitalFlow(days);
    
    res.json({
      success: true,
      message: '持仓历史数据收集完成',
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 只收集日行情历史数据
 * POST /api/v1/history-collect/daily-quotes
 */
router.post('/daily-quotes', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    const result = await collectHistoricalDailyQuotes(days);
    
    res.json({
      success: true,
      message: '日行情历史数据收集完成',
      data: result,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 从 Tushare 收集所有交易所的日行情数据
 * POST /api/v1/history-collect/tushare/daily-quotes
 */
router.post('/tushare/daily-quotes', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    const { collectTushareDailyQuotes } = await import('../services/historicalDataCollector');
    const result = await collectTushareDailyQuotes(days);
    
    res.json({
      success: true,
      message: 'Tushare 日行情数据收集完成',
      data: result,
    });
  } catch (error: any) {
    console.error('[Tushare日行情API] 收集失败:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 从 Tushare 收集所有交易所的仓单数据
 * POST /api/v1/history-collect/tushare/warehouse-receipts
 */
router.post('/tushare/warehouse-receipts', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    const { collectTushareWarehouseReceipts } = await import('../services/historicalDataCollector');
    const result = await collectTushareWarehouseReceipts(days);
    
    res.json({
      success: true,
      message: 'Tushare 仓单数据收集完成',
      data: result,
    });
  } catch (error: any) {
    console.error('[Tushare仓单API] 收集失败:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 从 Tushare 收集所有交易所的所有数据
 * POST /api/v1/history-collect/tushare
 */
router.post('/tushare', async (req, res) => {
  try {
    const { days = 30 } = req.body;
    
    console.log(`[Tushare API] 开始收集过去 ${days} 天的所有数据（所有交易所）`);
    
    const { collectTushareDailyQuotes, collectTushareWarehouseReceipts } = await import('../services/historicalDataCollector');
    
    // 收集日行情数据
    const dailyQuotesResult = await collectTushareDailyQuotes(days);
    
    // 收集仓单数据
    const warehouseReceiptsResult = await collectTushareWarehouseReceipts(days);
    
    res.json({
      success: true,
      message: 'Tushare 数据收集完成',
      data: {
        dailyQuotes: dailyQuotesResult.collected,
        warehouseReceipts: warehouseReceiptsResult.collected,
        errors: [...dailyQuotesResult.errors, ...warehouseReceiptsResult.errors],
      },
    });
  } catch (error: any) {
    console.error('[Tushare API] 收集失败:', error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

/**
 * 刷新30分钟K线缓存数据
 * POST /api/v1/history-collect/refresh-kline
 * 调用 Python 脚本从新浪财经拉取最新30分钟K线数据
 */
router.post('/refresh-kline', async (req, res) => {
  try {
    const { execSync } = await import('child_process');
    const path = await import('path');

    console.log('[K线刷新] 开始拉取最新30分钟K线数据...');

    const scriptPath = path.resolve(process.cwd(), 'scripts/pull_30m.py');
    const output = execSync(`python3 ${scriptPath}`, {
      timeout: 600000, // 10分钟超时
      encoding: 'utf-8',
    });

    console.log('[K线刷新] 完成');

    res.json({
      success: true,
      message: 'K线数据刷新完成',
      output: output.split('\n').filter((l: string) => l.includes('OK') || l.includes('完成') || l.includes('FAILED')).slice(-10),
    });
  } catch (error: any) {
    console.error('[K线刷新] 失败:', error.message);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

export default router;
