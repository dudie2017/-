/**
 * 技术分析API路由
 * 提供Brooks Price Action技术分析接口
 */

import { Router } from 'express';
import { analyzeFromDatabase, performTechnicalAnalysis, type KlineBar } from '../services/technicalAnalysis.js';

const router = Router();

/**
 * GET /api/v1/technical/:code
 * 获取单个品种的技术分析
 * 
 * Query参数：
 * - days: 分析天数，默认60
 */
router.get('/:code', (req, res) => {
  try {
    const { code } = req.params;
    const days = parseInt(req.query.days as string) || 60;
    
    const result = analyzeFromDatabase(code.toUpperCase(), days);
    
    if (!result) {
      return res.json({
        success: false,
        message: `品种 ${code} 数据不足，无法进行技术分析`,
        data: null
      });
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Technical analysis error:', error);
    res.status(500).json({
      success: false,
      message: '技术分析失败',
      error: (error as Error).message
    });
  }
});

/**
 * POST /api/v1/technical/analyze
 * 使用自定义K线数据进行技术分析
 * 
 * Body参数：
 * - code: 品种代码
 * - bars: K线数据数组
 */
router.post('/analyze', (req, res) => {
  try {
    const { code, bars } = req.body as { code: string; bars: KlineBar[] };
    
    if (!code || !bars || !Array.isArray(bars) || bars.length < 10) {
      return res.status(400).json({
        success: false,
        message: '参数错误：需要code和至少10根K线数据'
      });
    }
    
    const result = performTechnicalAnalysis(code.toUpperCase(), bars);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    console.error('Technical analysis error:', error);
    res.status(500).json({
      success: false,
      message: '技术分析失败',
      error: (error as Error).message
    });
  }
});

/**
 * GET /api/v1/technical/compare/:codes
 * 比较多个品种的技术分析
 * 
 * Query参数：
 * - codes: 品种代码，用逗号分隔，如 "RB,AG,AU"
 * - days: 分析天数，默认60
 */
router.get('/compare/:codes', (req, res) => {
  try {
    const { codes } = req.params;
    const days = parseInt(req.query.days as string) || 60;
    
    const codeList = codes.split(',').map(c => c.trim().toUpperCase());
    const results = codeList.map(code => {
      const result = analyzeFromDatabase(code, days);
      return result || { code, error: '数据不足' };
    });
    
    // 按信号强度排序
    const sorted = results
      .filter(r => 'summary' in r)
      .sort((a, b) => {
        const aConf = (a as any).summary?.confidence || 0;
        const bConf = (b as any).summary?.confidence || 0;
        return bConf - aConf;
      });
    
    res.json({
      success: true,
      data: {
        results: sorted,
        summary: {
          total: codeList.length,
          analyzed: sorted.length,
          bullish: sorted.filter(r => (r as any).summary?.direction === 'bullish').length,
          bearish: sorted.filter(r => (r as any).summary?.direction === 'bearish').length,
          neutral: sorted.filter(r => (r as any).summary?.direction === 'neutral').length
        }
      }
    });
  } catch (error) {
    console.error('Technical comparison error:', error);
    res.status(500).json({
      success: false,
      message: '技术对比分析失败',
      error: (error as Error).message
    });
  }
});

export default router;
