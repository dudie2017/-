/**
 * 历史数据追踪路由
 */

import { Router } from 'express';
import {
  getCapitalFlowHistory,
  getWarehouseReceiptHistory,
  getCapitalFlowTrend,
  getWarehouseReceiptTrend,
  getDailyQuotesHistory
} from '../services/database.js';
import {
  collectCapitalFlowData,
  collectWarehouseReceiptData,
  getVarietyAnalysisReport,
  getLatestTradeDate
} from '../services/dataCollector.js';
import { getAllAlerts, getVarietyAlerts } from '../services/alertService.js';
import { getAllSupplyDemandAnalysis, analyzeSupplyDemand, getImbalancedVarieties } from '../services/supplyDemand.js';

const router = Router();

// 获取资金流向历史
router.get('/capital-flow/history', (req, res) => {
  try {
    const { code, startDate, endDate, limit = '30' } = req.query;
    
    const history = getCapitalFlowHistory({
      code: code as string,
      startDate: startDate as string,
      endDate: endDate as string,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error getting capital flow history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取资金流向趋势
router.get('/capital-flow/trend/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { days = '7' } = req.query;
    
    const trend = getCapitalFlowTrend(code.toUpperCase(), parseInt(days as string));

    res.json({
      success: true,
      data: trend
    });
  } catch (error) {
    console.error('Error getting capital flow trend:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取仓单历史
router.get('/warehouse-receipts/history', (req, res) => {
  try {
    const { code, startDate, endDate, limit = '30' } = req.query;
    
    const history = getWarehouseReceiptHistory({
      code: code as string,
      startDate: startDate as string,
      endDate: endDate as string,
      limit: parseInt(limit as string)
    });

    res.json({
      success: true,
      data: history
    });
  } catch (error) {
    console.error('Error getting warehouse receipt history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取仓单趋势
router.get('/warehouse-receipts/trend/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { days = '7' } = req.query;
    
    const trend = getWarehouseReceiptTrend(code.toUpperCase(), parseInt(days as string));

    res.json({
      success: true,
      data: trend
    });
  } catch (error) {
    console.error('Error getting warehouse receipt trend:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取品种综合分析报告
router.get('/analysis/:code', (req, res) => {
  try {
    const { code } = req.params;
    const { days = '7' } = req.query;
    
    const report = getVarietyAnalysisReport(code.toUpperCase(), parseInt(days as string));

    res.json({
      success: true,
      data: report
    });
  } catch (error) {
    console.error('Error getting variety analysis report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 手动触发数据收集
router.post('/collect', async (req, res) => {
  try {
    const { tradeDate, type = 'all' } = req.body;
    const date = tradeDate || getLatestTradeDate();
    
    const results: {
      capitalFlow?: { collected: number; errors: string[] };
      warehouseReceipt?: { collected: number; errors: string[] };
    } = {};

    if (type === 'all' || type === 'capitalFlow') {
      results.capitalFlow = await collectCapitalFlowData(date);
    }

    if (type === 'all' || type === 'warehouseReceipt') {
      results.warehouseReceipt = await collectWarehouseReceiptData(date);
    }

    res.json({
      success: true,
      data: {
        tradeDate: date,
        results
      }
    });
  } catch (error) {
    console.error('Error collecting data:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取所有品种的最新分析报告
router.get('/analysis-report', (req, res) => {
  try {
    const { days = '7' } = req.query;
    const dceVarieties = ['A', 'B', 'M', 'Y', 'P', 'C', 'CS', 'JD', 'L', 'V', 'PP', 'J', 'JM', 'I', 'EG', 'EB', 'PG', 'LH'];
    
    const reports = dceVarieties.map(code => {
      try {
        return getVarietyAnalysisReport(code, parseInt(days as string));
      } catch {
        return null;
      }
    }).filter(r => r !== null);

    // 按信号强度排序
    reports.sort((a, b) => {
      if (a.overallSignal === 'bullish' && b.overallSignal !== 'bullish') return -1;
      if (a.overallSignal !== 'bullish' && b.overallSignal === 'bullish') return 1;
      if (a.overallSignal === 'bearish' && b.overallSignal !== 'bearish') return 1;
      if (a.overallSignal !== 'bearish' && b.overallSignal === 'bearish') return -1;
      return b.confidence - a.confidence;
    });

    res.json({
      success: true,
      data: reports
    });
  } catch (error) {
    console.error('Error getting analysis report:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取所有预警
router.get('/alerts', (req, res) => {
  try {
    const alerts = getAllAlerts();
    
    res.json({
      success: true,
      data: alerts,
      count: alerts.length,
      highCount: alerts.filter(a => a.severity === 'high').length,
      mediumCount: alerts.filter(a => a.severity === 'medium').length,
      lowCount: alerts.filter(a => a.severity === 'low').length
    });
  } catch (error) {
    console.error('Error getting alerts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取特定品种的预警
router.get('/alerts/:code', (req, res) => {
  try {
    const { code } = req.params;
    const alerts = getVarietyAlerts(code.toUpperCase());
    
    res.json({
      success: true,
      data: alerts,
      count: alerts.length
    });
  } catch (error) {
    console.error('Error getting variety alerts:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取所有品种的供需分析
router.get('/supply-demand', (req, res) => {
  try {
    const analysis = getAllSupplyDemandAnalysis();
    
    res.json({
      success: true,
      data: analysis,
      count: analysis.length,
      summary: {
        supplyExcess: analysis.filter(a => a.balance.signal === 'supply_excess').length,
        demandExcess: analysis.filter(a => a.balance.signal === 'demand_excess').length,
        balanced: analysis.filter(a => a.balance.signal === 'balanced').length
      }
    });
  } catch (error) {
    console.error('Error getting supply-demand analysis:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取供需失衡的品种
router.get('/supply-demand/imbalanced', (req, res) => {
  try {
    const imbalanced = getImbalancedVarieties();
    
    res.json({
      success: true,
      data: imbalanced,
      count: imbalanced.length
    });
  } catch (error) {
    console.error('Error getting imbalanced varieties:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取特定品种的供需分析
router.get('/supply-demand/:code', (req, res) => {
  try {
    const { code } = req.params;
    const analysis = analyzeSupplyDemand(code.toUpperCase());
    
    if (!analysis) {
      res.status(404).json({
        success: false,
        error: 'No data available for this variety'
      });
      return;
    }
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error) {
    console.error('Error getting variety supply-demand analysis:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// 获取日行情历史数据
router.get('/daily-quotes', (req, res) => {
  try {
    const { variety, contractId, startDate, endDate, limit = '100' } = req.query;
    
    const quotes = getDailyQuotesHistory({
      variety: variety as string,
      contractId: contractId as string,
      startDate: startDate as string,
      endDate: endDate as string,
      limit: parseInt(limit as string)
    });
    
    res.json({
      success: true,
      data: quotes,
      count: quotes.length
    });
  } catch (error) {
    console.error('Error getting daily quotes history:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
