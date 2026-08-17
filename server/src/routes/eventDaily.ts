/**
 * 事件驱动日报路由
 *
 * 以新闻实时检测的最新事件为入口，生成综合分析日报并沉淀为复盘数据。
 * 接口前缀：/api/v1/event-daily
 */
import { Router } from 'express';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import {
  listLatestEvents,
  listHistoricalEvents,
  generateLatestEventDailyReport,
  generateEventDailyReport,
  generateAllHistoricalEventDailies,
} from '../services/eventDailyService.js';
import {
  saveEventDailyReport,
  getEventDailyReports,
  getEventDailyReportById,
  getEventDailyReportByEventId,
} from '../services/database.js';

const router = Router();

/**
 * GET /api/v1/event-daily/events
 * 获取最新事件列表（从新闻实时检测，复用 APP 已有逻辑）
 * Query 参数：category?: number（1-10）, keyword?: string
 */
router.get('/events', async (req, res) => {
  try {
    const categoryRaw = req.query.category;
    const category = categoryRaw ? Number(categoryRaw) : undefined;
    const keyword = ((req.query.keyword as string) || '').trim();

    const detected = await listLatestEvents();
    let events = detected;
    if (category && !Number.isNaN(category)) {
      events = events.filter((d) => d.event.category === category);
    }
    if (keyword) {
      events = events.filter(
        (d) =>
          d.event.title.includes(keyword) ||
          (d.event.consensus || '').includes(keyword)
      );
    }

    // 扁平化为前端兼容结构（含置信度），保持与历史 BlackSwanEventItem 字段一致
    const data = events.map((d) => ({
      id: d.event.id,
      date: d.event.date,
      category: d.event.category,
      categoryName: d.event.categoryName,
      title: d.event.title,
      varieties: d.event.varieties || [],
      direction: d.event.direction,
      consensus: d.event.consensus || '',
      note: d.event.note,
      confidence: d.confidence,
      matchedNewsCount: d.matchedNews?.length || 0,
    }));

    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/event-daily/history-events
 * 获取历史黑天鹅事件库（稳定 id，用于前端"事件日报"列表）
 * Query 参数：category?: number（1-10）, keyword?: string
 */
router.get('/history-events', (req, res) => {
  try {
    const categoryRaw = req.query.category;
    const category = categoryRaw ? Number(categoryRaw) : undefined;
    const keyword = ((req.query.keyword as string) || '').trim();

    let events = listHistoricalEvents();
    if (category && !Number.isNaN(category)) {
      events = events.filter((e) => e.category === category);
    }
    if (keyword) {
      events = events.filter(
        (e) => e.title.includes(keyword) || (e.consensus || '').includes(keyword)
      );
    }

    res.json({ success: true, data: events });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/event-daily/generate
 * 生成事件日报并保存为复盘数据
 * Body 参数：eventId?: string（可选，指定某个历史事件；不传则生成全部最新实时事件）
 */
router.post('/generate', async (req, res) => {
  try {
    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as Record<string, string>
    );
    const eventId = (req.body?.eventId as string) || undefined;

    // 指定事件：优先走稳定历史事件库；若历史库不存在（实时检测事件），回退到实时检测
    if (eventId) {
      // 幂等：已存在则直接返回，避免重复生成
      const existing = getEventDailyReportByEventId(eventId);
      if (existing) {
        res.json({
          success: true,
          data: { id: existing.id, report: JSON.parse(existing.report_json) },
        });
        return;
      }

      try {
        // 1) 历史事件库（稳定 id，生成结果可靠）
        const report = await generateEventDailyReport(eventId, customHeaders);
        const id = `event-${eventId}`;
        saveEventDailyReport({
          id,
          event_id: report.event.id,
          event_date: report.event.date,
          title: report.event.title,
          category: report.event.categoryName,
          generated_at: new Date().toISOString(),
          report_json: JSON.stringify(report),
          is_realtime: 0, // 历史事件
        });
        res.json({ success: true, data: { id, report } });
        return;
      } catch (err) {
        // 2) 历史库中不存在 → 可能是实时检测事件（id 动态生成），回退到实时检测
        const liveReports = await generateLatestEventDailyReport(customHeaders, eventId);
        if (liveReports.length === 0) {
          throw err; // 实时检测也找不到，抛回原错误
        }
        const report = liveReports[0];
        const id = report.event.id.startsWith('live-') ? report.event.id : `live-${report.event.id}`;
        saveEventDailyReport({
          id,
          event_id: report.event.id,
          event_date: report.event.date,
          title: report.event.title,
          category: report.event.categoryName,
          generated_at: new Date().toISOString(),
          report_json: JSON.stringify(report),
          is_realtime: 1, // 实时事件
        });
        res.json({ success: true, data: { id, report } });
        return;
      }
    }

    // 未指定事件：生成全部最新实时事件（用于每日自动生成）
    const reports = await generateLatestEventDailyReport(customHeaders);
    const saved: Array<{ id: string; report: unknown }> = [];
    for (const report of reports) {
      const id = report.event.id.startsWith('live-') ? report.event.id : `live-${report.event.id}`;
      saveEventDailyReport({
        id,
        event_id: report.event.id,
        event_date: report.event.date,
        title: report.event.title,
        category: report.event.categoryName,
        generated_at: new Date().toISOString(),
        report_json: JSON.stringify(report),
        is_realtime: 1, // 实时事件
      });
      saved.push({ id, report });
    }

    res.json({ success: true, data: { reports: saved } });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/event-daily/refresh
 * 手动触发：强制重新检测新闻，返回最新实时事件列表
 * 无 Body 参数
 */
router.post('/refresh', async (req, res) => {
  try {
    const detected = await listLatestEvents();
    const data = detected.map((d) => ({
      id: d.event.id,
      date: d.event.date,
      category: d.event.category,
      categoryName: d.event.categoryName,
      title: d.event.title,
      varieties: d.event.varieties || [],
      direction: d.event.direction,
      consensus: d.event.consensus || '',
      note: d.event.note,
      confidence: d.confidence,
      matchedNewsCount: d.matchedNews?.length || 0,
    }));
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/v1/event-daily/generate-all
 * 全量回填历史事件库所有事件日报（幂等：已存在跳过）
 * 无 Body 参数
 */
router.post('/generate-all', async (req, res) => {
  try {
    const customHeaders = HeaderUtils.extractForwardHeaders(
      req.headers as Record<string, string>
    );
    const result = await generateAllHistoricalEventDailies(customHeaders, 3);
    res.json({ success: true, data: result });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/event-daily/list
 * 获取已生成的历史日报列表（复盘数据）
 * Query 参数：limit?: number（默认 50）
 */
router.get('/list', (req, res) => {
  try {
    const limitRaw = req.query.limit;
    const limit = limitRaw ? Number(limitRaw) : 50;
    const reports = getEventDailyReports(Number.isNaN(limit) ? 50 : limit);
    res.json({ success: true, data: reports });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/v1/event-daily/:id
 * 获取某份日报详情（含结构化报告内容）
 */
router.get('/:id', (req, res) => {
  try {
    const record = getEventDailyReportById(req.params.id);
    if (!record) {
      res.status(404).json({ success: false, error: '日报不存在' });
      return;
    }
    res.json({
      success: true,
      data: {
        ...record,
        report: JSON.parse(record.report_json),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
