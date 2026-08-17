/**
 * 大连商品交易所 (DCE) API路由
 */

import express from 'express';
import {
  getMainSeriesContracts,
  getNewContractInfo,
  getSettlementParams,
  getDeliveryParams,
  getBusinessNotices,
  getDailyQuotes,
  getWeeklyQuotes,
  getMonthlyQuotes,
  getWarehouseReceipts,
  getWarehouseReceiptsSummary,
  getMemberDealPositionRank,
  getContractList,
  getAllMemberDealPositionRank,
  getTodayDate,
  getVarietyId,
  DCE_VARIETIES,
} from '../services/dceApi.js';

const router = express.Router();

/**
 * GET /api/v1/dce/varieties
 * 获取DCE品种列表
 */
router.get('/varieties', (req, res) => {
  try {
    const varieties = Object.entries(DCE_VARIETIES).map(([id, name]) => ({
      id,
      name,
    }));
    res.json(varieties);
  } catch (error) {
    console.error('获取DCE品种列表失败:', error);
    res.status(500).json({ error: '获取品种列表失败' });
  }
});

/**
 * GET /api/v1/dce/main-series/:varietyId
 * 获取主力合约信息
 * Query: tradeDate? (YYYYMMDD, 默认今天)
 */
router.get('/main-series/:varietyId', async (req, res) => {
  try {
    const { varietyId } = req.params;
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();

    const data = await getMainSeriesContracts(varietyId, tradeDate);
    res.json({
      varietyId,
      varietyName: DCE_VARIETIES[varietyId] || varietyId,
      tradeDate,
      contracts: data,
    });
  } catch (error) {
    console.error('获取主力合约信息失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/new-contracts
 * 获取新合约增挂信息
 * Query: tradeDate? (YYYYMMDD, 默认今天)
 */
router.get('/new-contracts', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();

    const data = await getNewContractInfo(tradeDate);
    res.json({
      tradeDate,
      contracts: data,
    });
  } catch (error) {
    console.error('获取新合约信息失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/settlement/:varietyId
 * 获取结算参数（手续费、保证金等）
 * Query: tradeDate? (YYYYMMDD, 默认今天)
 */
router.get('/settlement/:varietyId', async (req, res) => {
  try {
    const { varietyId } = req.params;
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();

    const data = await getSettlementParams(varietyId, tradeDate);
    res.json({
      varietyId,
      varietyName: DCE_VARIETIES[varietyId] || varietyId,
      tradeDate,
      settlement: data,
    });
  } catch (error) {
    console.error('获取结算参数失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/delivery/:varietyId
 * 获取交割参数
 */
router.get('/delivery/:varietyId', async (req, res) => {
  try {
    const { varietyId } = req.params;

    const data = await getDeliveryParams(varietyId);
    res.json({
      varietyId,
      varietyName: DCE_VARIETIES[varietyId] || varietyId,
      delivery: data,
    });
  } catch (error) {
    console.error('获取交割参数失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/notices
 * 获取业务公告
 * Query: pageNo?, pageSize?
 */
router.get('/notices', async (req, res) => {
  try {
    const pageNo = parseInt(req.query.pageNo as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 10;

    const data = await getBusinessNotices(pageNo, pageSize);
    res.json(data);
  } catch (error) {
    console.error('获取业务公告失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/daily-quotes
 * 获取日行情数据
 * Query: 
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 *   - varietyId: 品种ID（可选，如 'a' 豆一）
 *   - variety: 品种代码（可选，如 'A'，会自动转换为varietyId）
 *   - tradeType: 交易类型 1-期货 2-期权（默认1）
 */
router.get('/daily-quotes', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    const tradeType = (req.query.tradeType as string) || '1';
    
    // 支持通过variety参数（系统品种代码）或varietyId参数（DCE品种ID）
    let varietyId = req.query.varietyId as string | undefined;
    if (!varietyId && req.query.variety) {
      varietyId = getVarietyId(req.query.variety as string) || undefined;
    }

    const data = await getDailyQuotes(tradeDate, varietyId, tradeType);
    res.json({
      tradeDate,
      tradeType: tradeType === '1' ? '期货' : '期权',
      varietyId,
      varietyName: varietyId ? (DCE_VARIETIES[varietyId] || varietyId) : '全部',
      quotes: data,
    });
  } catch (error) {
    console.error('获取日行情失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/weekly-quotes
 * 获取周行情数据
 */
router.get('/weekly-quotes', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    let varietyId = req.query.varietyId as string | undefined;
    if (!varietyId && req.query.variety) {
      varietyId = getVarietyId(req.query.variety as string) || undefined;
    }

    const data = await getWeeklyQuotes(tradeDate, varietyId);
    res.json({
      tradeDate,
      varietyId,
      quotes: data,
    });
  } catch (error) {
    console.error('获取周行情失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/monthly-quotes
 * 获取月行情数据
 */
router.get('/monthly-quotes', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    let varietyId = req.query.varietyId as string | undefined;
    if (!varietyId && req.query.variety) {
      varietyId = getVarietyId(req.query.variety as string) || undefined;
    }

    const data = await getMonthlyQuotes(tradeDate, varietyId);
    res.json({
      tradeDate,
      varietyId,
      quotes: data,
    });
  } catch (error) {
    console.error('获取月行情失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/warehouse-receipts
 * 获取仓单日报（详细数据，包含各仓库明细）
 * Query:
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 *   - variety: 品种代码（可选，如 'A'）
 */
router.get('/warehouse-receipts', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    let varietyId = req.query.varietyId as string | undefined;
    if (!varietyId && req.query.variety) {
      varietyId = getVarietyId(req.query.variety as string) || undefined;
    }

    const data = await getWarehouseReceipts(tradeDate, varietyId);
    res.json({
      tradeDate,
      varietyId,
      receipts: data,
    });
  } catch (error) {
    console.error('获取仓单日报失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/warehouse-receipts-summary
 * 获取仓单日报汇总（各品种仓单总量）
 * Query:
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 */
router.get('/warehouse-receipts-summary', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();

    const data = await getWarehouseReceiptsSummary(tradeDate);
    res.json({
      tradeDate,
      summary: data,
    });
  } catch (error) {
    console.error('获取仓单汇总失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/contract-list
 * 获取指定日期的上市合约列表
 * Query:
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 *   - minVolume: 最小成交量过滤（默认0，不过滤）
 */
router.get('/contract-list', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    const minVolume = parseInt(req.query.minVolume as string) || 0;

    const data = await getContractList(tradeDate, minVolume);
    res.json({
      tradeDate,
      minVolume,
      count: data.length,
      contracts: data,
    });
  } catch (error) {
    console.error('获取合约列表失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/position-rank/:contractId
 * 获取单个合约的成交持仓排名
 * Query:
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 */
router.get('/position-rank/:contractId', async (req, res) => {
  try {
    const { contractId } = req.params;
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();

    const data = await getMemberDealPositionRank(tradeDate, contractId);
    
    // 整理返回数据
    const variety = contractId.replace(/[0-9]/g, '').toUpperCase();
    
    res.json({
      tradeDate,
      contractId,
      variety,
      volumeRank: (data.qtyFutureList || []).map((item, idx) => ({
        rank: idx + 1,
        name: item.qtyAbbr,
        volume: item.todayQty || 0,
        change: item.qtySub || 0,
      })),
      longRank: (data.buyFutureList || []).map((item, idx) => ({
        rank: idx + 1,
        name: item.buyAbbr,
        volume: item.todayBuyQty || 0,
        change: item.buySub || 0,
      })),
      shortRank: (data.sellFutureList || []).map((item, idx) => ({
        rank: idx + 1,
        name: item.sellAbbr,
        volume: item.todaySellQty || 0,
        change: item.sellSub || 0,
      })),
    });
  } catch (error) {
    console.error('获取成交持仓排名失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/v1/dce/position-rank-all
 * 获取所有合约的成交持仓排名（批量，带限流）
 * 注意：此接口耗时较长，每个合约间隔10秒
 * Query:
 *   - tradeDate: 交易日期 YYYYMMDD（默认今天）
 *   - minVolume: 最小成交量过滤（默认1000）
 */
router.get('/position-rank-all', async (req, res) => {
  try {
    const tradeDate = (req.query.tradeDate as string) || getTodayDate();
    const minVolume = parseInt(req.query.minVolume as string) || 1000;

    // 设置较长的超时时间
    req.setTimeout(600000); // 10分钟
    
    const data = await getAllMemberDealPositionRank(tradeDate, minVolume, 10000);
    
    res.json({
      tradeDate,
      minVolume,
      contractCount: Object.keys(data).length,
      data,
    });
  } catch (error) {
    console.error('批量获取成交持仓排名失败:', error);
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
