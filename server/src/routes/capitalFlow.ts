/**
 * 资金流向分析路由
 */

import { Router } from 'express';
import { 
  analyzeCapitalFlow, 
  analyzeVarietyCapitalFlow, 
  getCapitalFlowRanking,
  analyzeMultipleVarieties 
} from '../services/capitalFlow.js';
import { getLatestTradeDate } from '../services/dceApiService.js';

const router = Router();

/**
 * 获取有效的交易日期（如果指定日期无效，则获取最近交易日）
 */
async function getValidTradeDate(date?: string): Promise<string> {
  // 如果没有指定日期，使用最近交易日
  if (!date) {
    const latestDate = await getLatestTradeDate();
    return latestDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  
  // 检查日期是否在未来（未来日期无效）
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (date > today) {
    // 日期在未来，使用最近交易日
    const latestDate = await getLatestTradeDate();
    return latestDate || today;
  }
  
  return date;
}

/**
 * 获取资金流向排行榜
 * GET /api/v1/capital-flow/ranking?date=20251009&top=20
 */
router.get('/ranking', async (req, res) => {
  try {
    const { date, top } = req.query;
    const tradeDate = (date as string) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const topN = parseInt(top as string) || 20;
    
    const ranking = await getCapitalFlowRanking(tradeDate, topN);
    
    res.json({
      success: true,
      tradeDate,
      ...ranking,
    });
  } catch (error: any) {
    console.error('获取资金流向排行失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 分析单个品种的资金流向
 * GET /api/v1/capital-flow/variety/:code?date=20251009
 */
router.get('/variety/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const { date } = req.query;
    const tradeDate = await getValidTradeDate(date as string);
    
    const analysis = await analyzeVarietyCapitalFlow(code, tradeDate);
    
    if (!analysis) {
      res.status(404).json({
        success: false,
        error: `未找到品种 ${code} 的资金流向数据`,
      });
      return;
    }
    
    res.json({
      success: true,
      ...analysis,
    });
  } catch (error: any) {
    console.error('分析品种资金流向失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 分析单个合约的资金流向
 * GET /api/v1/capital-flow/contract/:contractId?date=20251009
 */
router.get('/contract/:contractId', async (req, res) => {
  try {
    const { contractId } = req.params;
    const { date } = req.query;
    const tradeDate = await getValidTradeDate(date as string);
    
    const analysis = await analyzeCapitalFlow(contractId, tradeDate);
    
    res.json({
      success: true,
      ...analysis,
    });
  } catch (error: any) {
    console.error('分析合约资金流向失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * 批量分析多个品种
 * POST /api/v1/capital-flow/batch
 * Body: { varieties: ['A', 'M', 'Y'], date: '20251009' }
 */
router.post('/batch', async (req, res) => {
  try {
    const { varieties, date } = req.body;
    const tradeDate = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    if (!Array.isArray(varieties) || varieties.length === 0) {
      res.status(400).json({
        success: false,
        error: '请提供品种代码列表',
      });
      return;
    }
    
    const analyses = await analyzeMultipleVarieties(varieties, tradeDate);
    
    res.json({
      success: true,
      tradeDate,
      count: analyses.length,
      data: analyses,
    });
  } catch (error: any) {
    console.error('批量分析资金流向失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
