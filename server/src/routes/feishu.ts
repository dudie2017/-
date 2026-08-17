/**
 * 飞鸽数据API路由
 * 提供从飞鸽同步的数据查询接口
 */

import { Router } from 'express';
import {
  getSpotPriceHistory,
  getLatestSpotPrice,
  getDailyFundamentalFlow,
  getWarehouseReceiptHistory,
  getPigDailyMonitorHistory,
  getCokingCoalMonitor,
  getLatestInventoryByVarieties,
  getInventoryHistory,
  getLonghuBang
} from '../services/database.js';
import { syncAllInventoryData } from '../services/inventoryService.js';
import { syncAllFeishuData, getSyncStatus } from '../services/feishuSync.js';

const router = Router();

// 手动触发库存数据同步（AkShare 交易所库存 + 分位计算）
router.post('/sync-inventory', async (req, res) => {
  try {
    const result = await syncAllInventoryData();
    res.json(result);
  } catch (error) {
    console.error('Failed to sync inventory:', error);
    res.status(500).json({ success: false, error: 'Failed to sync inventory' });
  }
});

// 库存分位查询
router.get('/inventory', (req, res) => {
  try {
    const { variety, limit = '200' } = req.query;
    if (variety) {
      const data = getInventoryHistory({ variety: variety as string, limit: parseInt(limit as string) });
      res.json({ success: true, data });
    } else {
      const data = getLatestInventoryByVarieties();
      res.json({ success: true, data });
    }
  } catch (error) {
    console.error('Failed to get inventory:', error);
    res.status(500).json({ success: false, error: 'Failed to get inventory' });
  }
});

// 现货价格列表
router.get('/spot-price', (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const data = getSpotPriceHistory({ limit: parseInt(limit as string) });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Failed to get spot prices:', error);
    res.status(500).json({ success: false, error: 'Failed to get spot prices' });
  }
});

// 现货价格摘要（按品种分组，取最新）
router.get('/spot-price/summary', (req, res) => {
  try {
    // 获取所有现货价格，然后按品种分组取最新
    const allPrices = getSpotPriceHistory({ limit: 500 });
    const summary: Record<string, any> = {};
    
    for (const price of allPrices) {
      const code = price.code || price.variety_code || price.varietyCode;
      if (!summary[code] || price.trade_date > summary[code].tradeDate) {
        summary[code] = {
          varietyCode: code,
          name: price.name || price.variety_name,
          spotPrice: price.spot_price ?? price.spotPrice,
          futuresPrice: price.futures_price ?? price.futuresPrice,
          basis: price.basis,
          basisRate: price.basis_rate ?? price.basisRate,
          tradeDate: price.trade_date || price.tradeDate,
        };
      }
    }
    
    res.json({ success: true, data: Object.values(summary) });
  } catch (error) {
    console.error('Failed to get spot price summary:', error);
    res.status(500).json({ success: false, error: 'Failed to get spot price summary' });
  }
});

// 基本面流水列表
router.get('/fundamental-flow', (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const data = getDailyFundamentalFlow({ limit: parseInt(limit as string) });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Failed to get fundamental flows:', error);
    res.status(500).json({ success: false, error: 'Failed to get fundamental flows' });
  }
});

// 仓单数据列表
router.get('/warehouse-receipt', (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const data = getWarehouseReceiptHistory({ limit: parseInt(limit as string) });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Failed to get warehouse receipts:', error);
    res.status(500).json({ success: false, error: 'Failed to get warehouse receipts' });
  }
});

// 生猪监控数据
router.get('/pig-monitor', (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const data = getPigDailyMonitorHistory(parseInt(limit as string));
    res.json({ success: true, data });
  } catch (error) {
    console.error('Failed to get pig monitors:', error);
    res.status(500).json({ success: false, error: 'Failed to get pig monitors' });
  }
});

// 焦煤监控数据
router.get('/coking-coal-monitor', (req, res) => {
  try {
    const { limit = '50' } = req.query;
    const data = getCokingCoalMonitor({ limit: parseInt(limit as string) });
    res.json({ success: true, data });
  } catch (error) {
    console.error('Failed to get coking coal monitors:', error);
    res.status(500).json({ success: false, error: 'Failed to get coking coal monitors' });
  }
});

// 龙虎榜数据（统一走主库）
router.get('/longhu-bang', (req, res) => {
  try {
    const { tradeDate, contractCode, limit = '100' } = req.query;
    const data = getLonghuBang({
      date: tradeDate as string | undefined,
      contractCode: contractCode as string | undefined,
      limit: parseInt(limit as string),
    });
    res.json({ success: true, data, total: data.length });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// 手动触发同步
router.post('/sync', async (req, res) => {
  try {
    const result = await syncAllFeishuData();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

// 获取同步状态
router.get('/sync-status', async (req, res) => {
  try {
    const status = getSyncStatus();
    res.json({ success: true, data: status });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message });
  }
});

export default router;
