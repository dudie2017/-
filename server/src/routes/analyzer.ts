import { Router, type Request, type Response } from 'express';
import { analyzeVariety, VARIETY_CONFIG, type Direction, type SignalLevel } from '../services/varietyAnalyzer.js';

const router = Router();

/**
 * GET /api/v1/analyzer/varieties
 * 获取支持分析的品种列表
 */
router.get('/varieties', (req: Request, res: Response) => {
  const varieties = Object.entries(VARIETY_CONFIG).map(([code, config]) => ({
    code,
    name: config.name,
    board: config.board,
    multiplier: config.multiplier,
  }));

  // 按板块分组
  const grouped: Record<string, typeof varieties> = {};
  for (const v of varieties) {
    if (!grouped[v.board]) grouped[v.board] = [];
    grouped[v.board].push(v);
  }

  res.json({
    success: true,
    data: {
      list: varieties,
      grouped,
    },
  });
});

/**
 * GET /api/v1/analyzer/analyze/:code
 * 对指定品种进行全面分析
 * 
 * Query参数:
 * - capital: 总资金（默认200000）
 */
router.get('/analyze/:code', async (req: Request, res: Response) => {
  try {
    const { code } = req.params;
    const capital = parseFloat(req.query.capital as string) || 200000;

    const result = await analyzeVariety(String(code).toUpperCase(), capital);
    const config = VARIETY_CONFIG[String(code).toUpperCase()];

    // 构建增强的响应 (V3.1.2)
    const lastClose = result.entryPrice || result.keyLevels?.ema20Daily || 0;
    const response = {
      ...result,
      varietyCode: String(code).toUpperCase(),
      varietyName: config?.name || code,
      board: config?.board || '',
      lastClose,
      brooksAnalysis: {
        trendDirection: result.brooksScore?.alwaysInDaily || (result.action === '做多' ? '上升' : result.action === '做空' ? '下降' : '横盘'),
        trendStrength: Math.abs(result.brooksScore?.resonanceScore || 0).toFixed(1),
        signalType: result.signalLevel,
        signalQuality: (result.brooksScore?.total || 0) > 1.5 ? '高' : (result.brooksScore?.total || 0) > 0.5 ? '中' : '低',
        channelPosition: result.keyLevels?.resistance && result.keyLevels?.support
          ? ((lastClose - result.keyLevels.support) / (result.keyLevels.resistance - result.keyLevels.support) * 100).toFixed(0) + '%'
          : 'N/A',
        channelWidth: result.keyLevels?.resistance && result.keyLevels?.support && lastClose > 0
          ? ((result.keyLevels.resistance - result.keyLevels.support) / lastClose * 100).toFixed(1) + '%'
          : 'N/A',
        suggestedDirection: result.action,
        // V3.1 新增
        alwaysInDaily: result.brooksScore?.alwaysInDaily || '',
        alwaysIn60min: result.brooksScore?.alwaysIn60min || '',
        alwaysInResonance: result.brooksScore?.alwaysInResonance || false,
        hasSignalBar: result.brooksScore?.hasSignalBar || false,
        signalBarStatus: result.brooksScore?.signalBarStatus || '',
        signalBarDetail: result.brooksScore?.signalBarDetail || '',
        pullbackZoneLow: result.brooksScore?.pullbackZoneLow || 0,
        pullbackZoneHigh: result.brooksScore?.pullbackZoneHigh || 0,
        pullbackBasis: result.brooksScore?.pullbackBasis || '',
        calibrationWarning: result.brooksScore?.calibrationWarning || '',
        score: {
          total: result.brooksScore?.total || 0,
          resonance: result.brooksScore?.resonanceScore || 0,
          multiTf: result.brooksScore?.p0MultiTf || 0,
          trend: result.brooksScore?.p1Trend || 0,
          signalBar: result.brooksScore?.p2SignalBar || 0,
          keyLevels: result.brooksScore?.p3KeyLevels || 0,
          volumeOi: result.brooksScore?.p4VolumeOi || 0,
          patterns: result.brooksScore?.p5Patterns || 0,
          extremes: result.brooksScore?.p6Extremes || 0,
        },
      },
      // V3.1 新增：共振详情
      resonance: result.resonance || null,
      // V3.1.1 新增：贵金属/非农产品标注
      isPreciousMetal: result.supplyDemand?.isPreciousMetal || false,
      supplyScoreCap: result.supplyDemand?.supplyScoreCap || null,
    };

    res.json({
      success: true,
      data: response,
    });
  } catch (error: any) {
    res.status(400).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/v1/analyzer/summary
 * 获取所有品种的分析摘要
 */
// 分析摘要缓存（60 秒 TTL，按 capital 区分，避免每次请求都重新分析全部品种）
const SUMMARY_CACHE_TTL_MS = 60_000;
const summaryCache = new Map<number, { time: number; data: any[] }>();

router.get('/summary', async (req: Request, res: Response) => {
  try {
    const capital = parseFloat(req.query.capital as string) || 200000;
    const now = Date.now();
    const cached = summaryCache.get(capital);
    if (cached && now - cached.time < SUMMARY_CACHE_TTL_MS) {
      res.json({ success: true, data: cached.data, cached: true });
      return;
    }

    const results: any[] = [];
    
    for (const [code, config] of Object.entries(VARIETY_CONFIG)) {
      try {
        const result = await analyzeVariety(code, capital);
        results.push({
          code,
          name: config.name,
          board: config.board,
          action: result.action,
          signalLevel: result.signalLevel,
          positionPct: result.positionPct,
          entryPrice: result.entryPrice,
          stopLoss: result.stopLoss,
          supplyDemandScore: result.supplyDemand?.score || 0,
          brooksScore: result.brooksScore?.total || 0,
        });
      } catch (e) {
        // 跳过无数据的品种
      }
    }

    // 按信号强度排序
    const levelOrder: Record<string, number> = { '★★★重仓级': 3, '★★可执行': 2, '★观察级': 1, '无信号': 0 };
    results.sort((a, b) => {
      return (levelOrder[b.signalLevel] || 0) - (levelOrder[a.signalLevel] || 0);
    });

    summaryCache.set(capital, { time: now, data: results });
    res.json({
      success: true,
      data: results,
    });
  } catch (error: any) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
