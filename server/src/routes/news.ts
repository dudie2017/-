/**
 * 方案C：实时新闻接入 API 路由
 * 提供新闻扫描、事件检测、传播链预警功能
 */

import { Router } from 'express';
import { scanNewsForEvents, searchMarketNews, detectEventsFromNews, generatePropagationAlerts, generateNewsInterpretation, generateNewsTradeAdvices, generateNewsItemInterpretations } from '../services/newsService.js';

const router = Router();

/**
 * GET /api/v1/news/scan
 * 完整新闻扫描：搜索新闻 -> 检测事件 -> 生成传播链预警
 */
router.get('/scan', async (req, res) => {
  try {
    const result = await scanNewsForEvents();
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[NewsAPI] 扫描失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '扫描失败',
    });
  }
});

/**
 * GET /api/v1/news/latest
 * 获取最新新闻（不检测事件）
 */
// 最新新闻缓存（60 秒 TTL，外部源失败时降级返回旧数据）
const NEWS_CACHE_TTL_MS = 60_000;
let latestNewsCache: { time: number; data: any } | null = null;

router.get('/latest', async (req, res) => {
  try {
    const now = Date.now();
    if (latestNewsCache && now - latestNewsCache.time < NEWS_CACHE_TTL_MS) {
      res.json({ success: true, data: { ...latestNewsCache.data, cached: true } });
      return;
    }
    const result = await searchMarketNews();
    const data = {
      news: result.news,
      summary: result.summary,
      fetchTime: new Date().toISOString(),
    };
    latestNewsCache = { time: now, data };
    res.json({ success: true, data });
  } catch (error) {
    console.error('[NewsAPI] 获取新闻失败:', error);
    // 降级：有旧缓存则返回旧数据，避免外部源波动导致 500
    if (latestNewsCache) {
      res.json({
        success: true,
        data: {
          ...latestNewsCache.data,
          stale: true,
          error: error instanceof Error ? error.message : '获取新闻失败',
        },
      });
      return;
    }
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '获取新闻失败',
    });
  }
});

/**
 * GET /api/v1/news/events
 * 从缓存的新闻中检测事件（需要先调用 /scan）
 */
router.get('/events', async (req, res) => {
  try {
    // 先获取最新新闻
    const marketNews = await searchMarketNews();
    const detectedEvents = detectEventsFromNews(marketNews.news);
    const propagationAlerts = generatePropagationAlerts(detectedEvents);

    res.json({
      success: true,
      data: {
        detectedEvents,
        propagationAlerts,
        scanTime: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('[NewsAPI] 检测事件失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '检测事件失败',
    });
  }
});

/**
 * GET /api/v1/news/interpretation
 * 获取新闻的 AI 深度解读（含结构化事件检测 + LLM 文本解读）
 * Query参数: variety?: string (可选，指定品种代码则针对性解读)
 */
router.get('/interpretation', async (req, res) => {
  try {
    const variety = typeof req.query.variety === 'string' ? req.query.variety : undefined;
    const marketNews = await searchMarketNews();
    const result = await generateNewsInterpretation(marketNews.news, variety);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[NewsAPI] AI解读失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'AI解读失败',
    });
  }
});

/**
 * GET /api/v1/news/ai-summary
 * 获取 AI 解读用的新闻摘要
 */
router.get('/ai-summary', async (req, res) => {
  try {
    const result = await scanNewsForEvents();
    
    let summary = '';
    if (result.detectedEvents.length > 0) {
      summary += `【检测到 ${result.detectedEvents.length} 个潜在黑天鹅事件】\n`;
      for (const de of result.detectedEvents.slice(0, 3)) {
        summary += `- ${de.event.title} (${de.event.categoryName})，置信度 ${(de.confidence * 100).toFixed(0)}%\n`;
        summary += `  影响品种：${de.affectedVarieties.join(', ')}\n`;
        summary += `  方向预期：${de.event.direction}\n`;
      }
    } else {
      summary += '【未检测到明显黑天鹅事件】\n';
    }

    if (result.propagationAlerts.length > 0) {
      summary += `\n【传播链预警 ${result.propagationAlerts.length} 条】\n`;
      for (const alert of result.propagationAlerts.slice(0, 5)) {
        summary += `- ${alert.leader} → ${alert.follower} (${alert.sector})，预期滞后 ${alert.lag} 天\n`;
      }
    }

    res.json({
      success: true,
      data: {
        summary,
        detectedEventCount: result.detectedEvents.length,
        propagationAlertCount: result.propagationAlerts.length,
        scanTime: result.scanTime,
      },
    });
  } catch (error) {
    console.error('[NewsAPI] 生成AI摘要失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '生成摘要失败',
    });
  }
});

/**
 * POST /api/v1/news/trade-advices
 * 为每个检测到的事件和传播链预警生成一条 AI 交易建议
 * Body 参数：detectedEvents: DetectedEvent[], propagationAlerts: PropagationAlert[]
 * （由前端传入当前扫描结果，保证 eventId 与前端一致，避免重复搜索新闻）
 * 返回：{ eventAdvices, alertAdvices }
 */
router.post('/trade-advices', async (req, res) => {
  try {
    const detectedEvents = Array.isArray(req.body?.detectedEvents) ? req.body.detectedEvents : [];
    const propagationAlerts = Array.isArray(req.body?.propagationAlerts) ? req.body.propagationAlerts : [];
    const advices = await generateNewsTradeAdvices(detectedEvents, propagationAlerts);
    res.json({
      success: true,
      data: advices,
    });
  } catch (error) {
    console.error('[NewsAPI] 生成逐条交易建议失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '生成逐条交易建议失败',
    });
  }
});

/**
 * POST /api/v1/news/interpretations
 * 为每条新闻生成一条 AI 解读（方向 + 影响品种 + 可操作提示）
 * Body 参数：news: NewsItem[]
 * （由前端传入当前扫描结果，保证索引一致，避免重复搜索新闻）
 * 返回：NewsItemInterpretation[]
 */
router.post('/interpretations', async (req, res) => {
  try {
    const news = Array.isArray(req.body?.news) ? req.body.news : [];
    const interpretations = await generateNewsItemInterpretations(news);
    res.json({
      success: true,
      data: interpretations,
    });
  } catch (error) {
    console.error('[NewsAPI] 生成逐条新闻解读失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '生成逐条新闻解读失败',
    });
  }
});

/**
 * GET /api/v1/news/variety/:code
 * 搜索指定品种的最新新闻（逐品种聚焦）
 */
router.get('/variety/:code', async (req, res) => {
  try {
    const code = req.params.code;
    const { searchVarietyNews } = await import('../services/newsService.js');
    const result = await searchVarietyNews(code);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('[NewsAPI] 搜索品种新闻失败:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : '搜索品种新闻失败',
    });
  }
});

export default router;
