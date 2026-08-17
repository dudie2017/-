import { Router } from 'express';
import { 
  getFuturesMinutes, 
  getFuturesDaily, 
  getMultiTimeframeData
} from '../services/tushareService.js';

const router = Router();

// Tushare品种代码格式：CU2506.SHF（1-2字母+4位数字+.交易所代码）
const VARIETY_REGEX = /^[A-Za-z]{1,2}\d{4}\.[A-Z]{3}$/;
const FREQ_WHITELIST = new Set(['1min', '5min', '15min', '30min', '60min']);

function validateVariety(v: unknown): string | null {
  if (!v || typeof v !== 'string') return 'variety参数必填，如 CU2506.SHF';
  if (!VARIETY_REGEX.test(v)) return `无效的品种代码: ${v}`;
  return null;
}

function validateFreq(f: unknown): string | null {
  if (!f || typeof f !== 'string') return null; // freq 有默认值
  if (!FREQ_WHITELIST.has(f)) return `无效的频率: ${f}，可选 1min/5min/15min/30min/60min`;
  return null;
}

function validateDays(d: unknown): number | null {
  const n = Number(d);
  if (isNaN(n)) return null; // 有默认值
  if (n < 1 || n > 365) return 1; // 返回修正后的安全上限
  return n;
}

/**
 * Tushare数据服务状态
 * GET /api/v1/tushare/status
 */
router.get('/status', (req, res) => {
  const token = process.env.TUSHARE_TOKEN;
  res.json({
    status: token ? 'configured' : 'not_configured',
    token: token ? token.substring(0, 10) + '...' : null
  });
});

/**
 * 获取期货分钟线数据
 * GET /api/v1/tushare/futures-mins?variety=CU2506.SHF&freq=5min&days=30
 */
router.get('/futures-mins', async (req, res) => {
  try {
    const { variety, freq = '5min', days = 30 } = req.query;
    
    const varietyErr = validateVariety(variety);
    if (varietyErr) return res.status(400).json({ error: varietyErr });
    const freqErr = validateFreq(freq);
    if (freqErr) return res.status(400).json({ error: freqErr });
    const safeDays = validateDays(days) || 30;

    // 计算日期范围
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - safeDays);
    
    const result = await getFuturesMinutes(
      variety as string,
      freq as '1min' | '5min' | '15min' | '30min' | '60min',
      startDate.toISOString().split('T')[0],
      endDate.toISOString().split('T')[0]
    );
    
    if ('error' in result && result.error) {
      return res.status(500).json({ error: result.error });
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取期货日线数据
 * GET /api/v1/tushare/futures-daily?variety=CU2506.SHF&days=60
 */
router.get('/futures-daily', async (req, res) => {
  try {
    const { variety, days = 60 } = req.query;
    
    const varietyErr = validateVariety(variety);
    if (varietyErr) return res.status(400).json({ error: varietyErr });
    const safeDays = validateDays(days) || 60;

    // 不指定日期，获取所有数据（Tushare会自动返回最新数据）
    const result = await getFuturesDaily(variety as string);
    
    // 如果指定了days，截取最近N条
    const daysNum = safeDays;
    const data = result.slice(-daysNum);
    
    if ('error' in result && result.error) {
      return res.status(500).json({ error: result.error });
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * 获取多周期数据（日线+60min+15min+5min）
 * GET /api/v1/tushare/multi-timeframe?variety=CU2506.SHF
 */
router.get('/multi-timeframe', async (req, res) => {
  try {
    const { variety } = req.query;
    
    const varietyErr = validateVariety(variety);
    if (varietyErr) return res.status(400).json({ error: varietyErr });

    const result = await getMultiTimeframeData(variety as string);
    
    res.json({
      success: true,
      data: result
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
