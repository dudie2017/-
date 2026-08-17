/**
 * AKShare 数据源路由
 * 
 * 提供免费的期货分钟数据获取能力
 */

import { Router } from 'express';
import { 
  getFuturesMinutesAKShare, 
  getMultiTimeframeDataAKShare,
  checkAKShareAvailability 
} from '../services/akshareService.js';
import { analyzeResonanceWithAKShare } from '../services/multiTimeframeResonance.js';

const router = Router();

/**
 * 检查 AKShare 状态
 * GET /api/v1/akshare/status
 */
router.get('/status', async (req, res) => {
  try {
    const status = await checkAKShareAvailability();
    res.json({
      success: true,
      data: status
    });
  } catch (error: any) {
    console.error('检查AKShare状态失败', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 品种代码格式校验：1-3位字母 + 可选0-4位数字（合约月），如 ag0、AG、RB2501、CJ
const SYMBOL_REGEX = /^[A-Za-z]{1,3}\d{0,4}$/;

function validateSymbol(symbol: unknown): string | null {
  if (!symbol || typeof symbol !== 'string') return 'symbol参数必填，如 ag0';
  if (!SYMBOL_REGEX.test(symbol)) return `无效的品种代码: ${symbol}`;
  return null;
}

/**
 * 获取期货分钟数据
 * GET /api/v1/akshare/futures-mins?symbol=ag0&period=5
 */
router.get('/futures-mins', async (req, res) => {
  try {
    const { symbol, period } = req.query;
    
    const symbolErr = validateSymbol(symbol);
    if (symbolErr) return res.status(400).json({ success: false, error: symbolErr });

    const periodNum = parseInt(period as string || '5', 10);
    if (isNaN(periodNum) || periodNum < 1 || periodNum > 1440) {
      return res.status(400).json({ success: false, error: 'period必须在1-1440之间' });
    }
    
    const data = await getFuturesMinutesAKShare(symbol as string, String(periodNum));
    
    if (!data.success) {
      return res.status(500).json({
        success: false,
        error: data.error
      });
    }
    
    res.json({
      success: true,
      data: {
        symbol,
        period: period || '5min',
        count: data.data?.length || 0,
        bars: data.data
      }
    });
  } catch (error: any) {
    console.error('获取AKShare分钟数据失败', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 获取多周期数据
 * GET /api/v1/akshare/multi-timeframe?symbol=ag0
 */
router.get('/multi-timeframe', async (req, res) => {
  try {
    const { symbol } = req.query;
    
    const symbolErr = validateSymbol(symbol);
    if (symbolErr) return res.status(400).json({ success: false, error: symbolErr });

    const data = await getMultiTimeframeDataAKShare(symbol as string);
    
    if (!data.success) {
      return res.status(500).json({
        success: false,
        error: data.error
      });
    }
    
    res.json({
      success: true,
      data: {
        symbol,
        m5_count: data.data?.m5.length || 0,
        m15_count: data.data?.m15.length || 0,
        m60_count: data.data?.m60.length || 0,
        ...data.data
      }
    });
  } catch (error: any) {
    console.error('获取AKShare多周期数据失败', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * 多周期共振分析（使用AKShare真实数据）
 * GET /api/v1/akshare/resonance?variety_code=AG
 */
router.get('/resonance', async (req, res) => {
  try {
    const { variety_code } = req.query;
    
    const codeErr = validateSymbol(variety_code);
    if (codeErr) return res.status(400).json({ success: false, error: codeErr.replace('symbol', 'variety_code') });

    const analysis = await analyzeResonanceWithAKShare(variety_code as string, variety_code as string);
    
    res.json({
      success: true,
      data: analysis
    });
  } catch (error: any) {
    console.error('AKShare共振分析失败', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;
