/**
 * 优化分析路由
 */

import { Router, type Request, type Response } from 'express';
import {
  getVarietyGrades,
  getBestTimeframe,
  calculateSignalScore,
  getPortfolioRecommendation,
  getTimeframeStats
} from '../services/backtestAnalysis.js';
import { analyzeResonance, analyzeResonanceRealtime, filterHighResonance } from '../services/multiTimeframeResonance.js';
import { aggregateToTimeframe } from '../services/localDataLoader.js';
import { generateTradingAdvice, generateAdviceFromV16Row, checkAlertLevel, getTopTradingAdvices, getTopTradingAdvicesRealtime, getMarketTradingReport } from '../services/tradingAdvice.js';
import { getRealtimeVarietyData } from '../services/dataFetcher.js';
import { VARIETIES } from '../services/varieties.js';
import { getPriceActionSummary } from '../services/aiAssistant.js';
import { getStrategyContext, getDirectionConsistency } from '../services/strategyContext.js';
import { searchVarietyNews, detectEventsFromNews, generatePropagationAlerts } from '../services/newsService.js';
import { getScanCache } from './scan.js';

const router = Router();

/**
 * GET /api/v1/optimization/grades
 * 获取品种分级列表
 */
router.get('/grades', (req, res) => {
  try {
    const grades = getVarietyGrades();
    res.json({
      success: true,
      data: grades
    });
  } catch (error) {
    console.error('Error getting variety grades:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get variety grades'
    });
  }
});

/**
 * GET /api/v1/optimization/best-timeframe/:code
 * 获取品种的最佳周期
 */
router.get('/best-timeframe/:code', (req, res) => {
  try {
    const { code } = req.params;
    const bestTimeframe = getBestTimeframe(code);
    
    if (!bestTimeframe) {
      res.status(404).json({
        success: false,
        error: 'Variety not found'
      });
      return;
    }
    
    res.json({
      success: true,
      data: {
        code,
        bestTimeframe
      }
    });
  } catch (error) {
    console.error('Error getting best timeframe:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get best timeframe'
    });
  }
});

/**
 * POST /api/v1/optimization/signal-score
 * 计算信号质量评分
 */
router.post('/signal-score', (req, res) => {
  try {
    const { varietyCode, timeframe, technicalStrength, spectrumPosition } = req.body;
    
    if (!varietyCode || !timeframe || technicalStrength === undefined || !spectrumPosition) {
      res.status(400).json({
        success: false,
        error: 'Missing required parameters'
      });
      return;
    }
    
    const score = calculateSignalScore(
      varietyCode,
      timeframe,
      technicalStrength,
      spectrumPosition
    );
    
    res.json({
      success: true,
      data: score
    });
  } catch (error) {
    console.error('Error calculating signal score:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to calculate signal score'
    });
  }
});

/**
 * GET /api/v1/optimization/portfolio
 * 获取组合推荐
 */
router.get('/portfolio', (req, res) => {
  try {
    const portfolio = getPortfolioRecommendation();
    res.json({
      success: true,
      data: portfolio
    });
  } catch (error) {
    console.error('Error getting portfolio recommendation:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get portfolio recommendation'
    });
  }
});

/**
 * GET /api/v1/optimization/timeframe-stats
 * 获取周期统计
 */
router.get('/timeframe-stats', (req, res) => {
  try {
    const stats = getTimeframeStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('Error getting timeframe stats:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get timeframe stats'
    });
  }
});

/**
 * GET /api/v1/optimization/resonance/:code
 * 获取单个品种的多周期共振分析（使用实时数据）
 */
router.get('/resonance/:code', async (req, res) => {
  try {
    const { code } = req.params;

    // 从新浪财经获取实时数据
    const realtimeData = await getRealtimeVarietyData(code);

    if (!realtimeData) {
      res.status(404).json({
        success: false,
        error: `Variety ${code} data not available`
      });
      return;
    }

    // 使用新的实时数据分析函数
    const analysis = analyzeResonanceRealtime(
      realtimeData.code,
      VARIETIES[code] || realtimeData.name,
      realtimeData.dailyBars,
      realtimeData.minuteBars
    );

    // 添加实时价格信息
    res.json({
      success: true,
      data: {
        ...analysis,
        currentPrice: realtimeData.currentPrice,
        contract: realtimeData.contract,
        dataSource: 'realtime'
      }
    });
  } catch (error) {
    console.error('Error analyzing resonance:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to analyze resonance'
    });
  }
});

/**
 * GET /api/v1/optimization/resonance
 * 获取所有品种的多周期共振分析（简化版，只返回基本信息）
 * 注意：由于内存限制，此端点返回缓存的优化数据而非实时共振分析
 */
router.get('/resonance', (req, res) => {
  try {
    // 返回品种分级数据作为替代（避免内存问题）
    const grades = getVarietyGrades();
    
    // 将品种分级转换为简单的共振格式
    const results = grades
      .filter(g => g.grade === 'S' || g.grade === 'A')
      .map(g => ({
        varietyCode: g.code,
        varietyName: g.name,
        resonanceScore: g.grade === 'S' ? 4 : 3,
        resonanceLevel: g.grade === 'S' ? 'STRONG' : 'MEDIUM',
        suggestedDirection: 'LONG',
        suggestedPosition: g.grade === 'S' ? 100 : 75,
        bestTimeframe: g.bestTimeframe,
        profitFactor: g.bestProfitFactor
      }));
    
    res.json({
      success: true,
      data: {
        total: results.length,
        results
      }
    });
  } catch (error) {
    console.error('Error getting resonance list:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /api/v1/optimization/resonance-all
 * 获取所有高共振品种列表（简化版，使用缓存数据）
 */
router.get('/resonance-all', (req, res) => {
  try {
    const grades = getVarietyGrades();
    
    // 筛选S级和A级品种，按盈亏比排序
    const results = grades
      .filter(g => g.grade === 'S' || g.grade === 'A')
      .map(g => ({
        varietyCode: g.code,
        varietyName: g.name,
        resonanceScore: g.grade === 'S' ? 4 : 3,
        resonanceLevel: g.grade === 'S' ? 'STRONG' : 'MEDIUM',
        bestTimeframe: g.bestTimeframe,
        profitFactor: g.bestProfitFactor,
        grade: g.grade
      }))
      .sort((a, b) => b.profitFactor - a.profitFactor);
    
    res.json({
      success: true,
      data: {
        total: results.length,
        results
      }
    });
  } catch (error) {
    console.error('Error getting resonance list:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

/**
 * GET /api/v1/optimization/market-report
 * 获取全市场交易机会报告（不截断）
 * Query参数: riskAmount?: number (默认2000元)
 */
router.get('/market-report', async (req, res) => {
  try {
    const riskAmount = parseFloat(req.query.riskAmount as string) || 2000;

    // 全市场扫描 + 完整建议 + 观望分组
    const report = await getMarketTradingReport(riskAmount);

    // 为每个建议添加价格行为结构验证
    const enrichAdvice = (advice: any) => {
      const paSummary = getPriceActionSummary(advice.varietyCode, null);
      if (!paSummary) return advice;

      const isLong = advice.direction === 'LONG';
      const entryPrice = advice.entryPrice;
      let structureCheck = null;

      const supportLevels = paSummary.support || [];
      const resistanceLevels = paSummary.resistance || [];

      if (isLong && supportLevels.length > 0) {
        const nearestSupport = supportLevels[0];
        const distancePct = Math.abs(entryPrice - nearestSupport) / entryPrice * 100;
        structureCheck = {
          type: '支撑验证',
          hasStructure: distancePct < 2,
          nearestLevel: nearestSupport,
          distancePct: Number(distancePct.toFixed(2)),
          verdict: distancePct < 1 ? '强支撑' : distancePct < 2 ? '有支撑' : '支撑较远',
          alwaysIn: paSummary.alwaysIn,
        };
      } else if (!isLong && resistanceLevels.length > 0) {
        const nearestResistance = resistanceLevels[0];
        const distancePct = Math.abs(entryPrice - nearestResistance) / entryPrice * 100;
        structureCheck = {
          type: '阻力验证',
          hasStructure: distancePct < 2,
          nearestLevel: nearestResistance,
          distancePct: Number(distancePct.toFixed(2)),
          verdict: distancePct < 1 ? '强阻力' : distancePct < 2 ? '有阻力' : '阻力较远',
          alwaysIn: paSummary.alwaysIn,
        };
      }

      return {
        ...advice,
        structureValidation: structureCheck ? {
          alwaysIn: structureCheck.alwaysIn,
          entryVsSupport: isLong ? structureCheck.distancePct : null,
          entryVsResistance: !isLong ? structureCheck.distancePct : null,
          structureGrade: structureCheck.hasStructure ? 'A' : structureCheck.distancePct < 3 ? 'B' : 'C',
          structureNote: structureCheck.verdict,
        } : null,
        paSummary: {
          alwaysIn: paSummary.alwaysIn,
          aboveEma: paSummary.aboveEma,
          momentum: paSummary.momentum,
          support: supportLevels,
          resistance: resistanceLevels,
        },
      };
    };

    // 注入结构验证 + 策略上下文（千次回测验证结论）
    const enrichedAdvices = report.advices.map((advice: any) => {
      const strategyContext = getStrategyContext(advice.varietyCode);
      return {
        ...enrichAdvice(advice),
        strategyContext,
        directionConsistency: getDirectionConsistency(advice.direction, strategyContext),
      };
    });

    res.json({
      success: true,
      data: {
        scanTime: report.scanTime,
        totalCount: report.totalCount,
        tradableCount: enrichedAdvices.length,
        watchCount: report.watchCount,
        longCount: report.longCount,
        shortCount: report.shortCount,
        riskAmount,
        dataSource: 'realtime',
        advices: enrichedAdvices,
        watch: report.watch.map((w: any) => ({
          ...w,
          strategyContext: getStrategyContext(w.code),
        })),
      }
    });
  } catch (error) {
    console.error('Error getting market report:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get market report'
    });
  }
});

/**
 * GET /api/v1/optimization/trading-advice
 * 获取Top 5交易建议（使用实时数据）
 * Query参数: limit?: number (默认5), riskAmount?: number (默认2000元)
 */
router.get('/trading-advice', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 5;
    const riskAmount = parseFloat(req.query.riskAmount as string) || 2000;

    // 获取品种分级数据，筛选S级和A级品种
    const grades = getVarietyGrades();
    const topVariieties = grades
      .filter(g => g.grade === 'S' || g.grade === 'A')
      .slice(0, 10); // 取前10个进行详细分析（减少API调用）

    const varietyCodes = topVariieties.map(g => g.code);

    // 使用实时数据生成交易建议
    const advices = await getTopTradingAdvicesRealtime(varietyCodes, limit, riskAmount);

    // 为每个建议添加价格行为结构验证
    const enrichedAdvices = advices.map((advice: any) => {
      const paSummary = getPriceActionSummary(advice.varietyCode, null);
      if (!paSummary) return advice;

      // 结构验证：入场位是否有支撑/阻力
      const isLong = advice.direction === 'LONG';
      const entryPrice = advice.entryPrice;
      let structureCheck = null;

      const supportLevels = paSummary.support || [];
      const resistanceLevels = paSummary.resistance || [];

      if (isLong && supportLevels.length > 0) {
        const nearestSupport = supportLevels[0];
        const distancePct = Math.abs(entryPrice - nearestSupport) / entryPrice * 100;
        structureCheck = {
          type: '支撑验证',
          hasStructure: distancePct < 2,
          nearestLevel: nearestSupport,
          distancePct: Number(distancePct.toFixed(2)),
          verdict: distancePct < 1 ? '强支撑' : distancePct < 2 ? '有支撑' : '支撑较远',
          alwaysIn: paSummary.alwaysIn,
        };
      } else if (!isLong && resistanceLevels.length > 0) {
        const nearestResistance = resistanceLevels[0];
        const distancePct = Math.abs(entryPrice - nearestResistance) / entryPrice * 100;
        structureCheck = {
          type: '阻力验证',
          hasStructure: distancePct < 2,
          nearestLevel: nearestResistance,
          distancePct: Number(distancePct.toFixed(2)),
          verdict: distancePct < 1 ? '强阻力' : distancePct < 2 ? '有阻力' : '阻力较远',
          alwaysIn: paSummary.alwaysIn,
        };
      }

      return {
        ...advice,
        structureValidation: structureCheck ? {
          alwaysIn: structureCheck.alwaysIn,
          entryVsSupport: isLong ? structureCheck.distancePct : null,
          entryVsResistance: !isLong ? structureCheck.distancePct : null,
          structureGrade: structureCheck.hasStructure ? 'A' : structureCheck.distancePct < 3 ? 'B' : 'C',
          structureNote: structureCheck.verdict,
        } : null,
        paSummary: {
          alwaysIn: paSummary.alwaysIn,
          aboveEma: paSummary.aboveEma,
          momentum: paSummary.momentum,
          support: supportLevels,
          resistance: resistanceLevels,
        },
      };
    });

    // 为每条建议注入策略上下文（五方 1000 次回测验证结论）
    const enrichedWithStrategy = enrichedAdvices.map((advice) => {
      const strategyContext = getStrategyContext(advice.varietyCode);
      return {
        ...advice,
        strategyContext,
        directionConsistency: getDirectionConsistency(advice.direction, strategyContext),
      };
    });

    res.json({
      success: true,
      data: {
        total: enrichedWithStrategy.length,
        riskAmount,
        dataSource: 'realtime',
        advices: enrichedWithStrategy
      }
    });
  } catch (error) {
    console.error('Error getting trading advice:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get trading advice'
    });
  }
});

/**
 * GET /api/v1/optimization/trading-advice/:code
 * 获取单个品种的交易建议（使用实时数据）
 * Query参数: riskAmount?: number (默认2000元)
 */
router.get('/trading-advice/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const riskAmount = parseFloat(req.query.riskAmount as string) || 2000;

    // 从新浪财经获取实时数据
    const realtimeData = await getRealtimeVarietyData(code);

    if (!realtimeData) {
      res.status(404).json({
        success: false,
        error: `Variety ${code} data not available`
      });
      return;
    }

    // 使用新的实时数据分析函数
    const resonance = analyzeResonanceRealtime(
      realtimeData.code,
      VARIETIES[code] || realtimeData.name,
      realtimeData.dailyBars,
      realtimeData.minuteBars
    );

    // 合并数据用于交易建议生成
    const allBars = [...realtimeData.dailyBars, ...realtimeData.minuteBars];

    // 生成交易建议
    const advice = generateTradingAdvice(
      realtimeData.code,
      VARIETIES[code] || realtimeData.name,
      allBars as any[],
      resonance,
      riskAmount
    );

    // 注入相关新闻与黑天鹅事件上下文（失败降级为空，不阻塞主接口）
    let newsContext: any = null;
    try {
      const varietyNews = await searchVarietyNews(code);
      const detectedEvents = detectEventsFromNews(varietyNews.news);
      const propagationAlerts = generatePropagationAlerts(detectedEvents);
      newsContext = {
        varietyName: varietyNews.varietyName,
        news: varietyNews.news.slice(0, 5),
        detectedEvents: detectedEvents.slice(0, 3),
        propagationAlerts: propagationAlerts.slice(0, 5),
      };
    } catch (err) {
      console.warn(`[Advice] 获取 ${code} 新闻上下文失败:`, err);
    }

    res.json({
      success: true,
      data: {
        ...advice,
        currentPrice: realtimeData.currentPrice,
        contract: realtimeData.contract,
        dataSource: 'realtime',
        strategyContext: getStrategyContext(code),
        newsContext
      }
    });
  } catch (error) {
    console.error('Error getting trading advice for variety:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get trading advice'
    });
  }
});

/**
 * GET /api/v1/optimization/alert-check/:code
 * 检查品种关键价位提醒
 * Query参数: currentPrice: number (当前价格)
 */
router.get('/alert-check/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const currentPrice = parseFloat(req.query.currentPrice as string);
    
    if (!currentPrice || isNaN(currentPrice)) {
      res.status(400).json({
        success: false,
        error: 'currentPrice is required'
      });
      return;
    }

    // 从扫描缓存获取该品种的 V16Row
    const scanCache = getScanCache();
    const row = scanCache?.rows.find(r => r.code === code);

    if (!row) {
      res.json({
        success: true,
        data: {
          varietyCode: code,
          currentPrice,
          alertLevel: 'NONE',
          message: '暂无该品种的扫描数据，请先执行全品种扫描'
        }
      });
      return;
    }

    // 基于 V16Row 生成交易建议，内部计算关键价位
    const advice = await generateAdviceFromV16Row(row);

    if (!advice) {
      res.json({
        success: true,
        data: {
          varietyCode: code,
          currentPrice,
          alertLevel: 'NONE',
          message: '该品种当前无明确方向信号'
        }
      });
      return;
    }

    // 用传入的实时价格重新判断提醒级别
    const alert = checkAlertLevel(
      currentPrice,
      {
        stopLoss: advice.stopLoss,
        support: advice.support,
        resistance: advice.resistance,
        target1: advice.target1,
        target2: advice.target2
      },
      advice.direction
    );

    res.json({
      success: true,
      data: {
        varietyCode: code,
        varietyName: advice.varietyName,
        currentPrice,
        direction: advice.direction,
        support: advice.support,
        resistance: advice.resistance,
        stopLoss: advice.stopLoss,
        target1: advice.target1,
        target2: advice.target2,
        alertLevel: alert.level,
        message: alert.message || '价格监控中'
      }
    });
  } catch (error) {
    console.error('Error checking alert:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to check alert'
    });
  }
});

/**
 * GET /api/v1/optimization/advice/:code
 * 从扫描缓存 V16Row 生成结构化交易建议（与雷达/品种分析页同一数据源）
 * Path 参数：code: string（品种代码，如 AG0）
 * Query 参数：riskAmount?: number（风险金额，默认 2000）
 */
router.get('/advice/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const riskAmount = parseFloat(req.query.riskAmount as string) || 2000;

    // 从扫描缓存获取该品种的 V16Row（单一真相源，与品种分析页一致）
    const scanCache = getScanCache();
    const row = scanCache?.rows.find(r => r.code === code);

    if (!row) {
      res.status(404).json({
        success: false,
        error: '该品种暂无扫描数据，请先执行全品种扫描'
      });
      return;
    }

    const advice = await generateAdviceFromV16Row(row, riskAmount);

    if (!advice) {
      res.json({
        success: true,
        data: null,
        message: '该品种当前无明确方向信号'
      });
      return;
    }

    res.json({ success: true, data: advice });
  } catch (error) {
    console.error('Error generating advice for variety:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to generate advice'
    });
  }
});

export default router;
