/**
 * 事件驱动传播链监控 API
 *
 * GET  /api/v1/event-monitor/daily   - 获取最新扫描结果（带缓存）
 * POST /api/v1/event-monitor/scan    - 手动触发重新扫描
 * GET  /api/v1/event-monitor/ai-summary - 获取 AI 解读用信号摘要
 * POST /api/v1/event-monitor/ai-interpretation - 流式 LLM 深度解读（SSE）
 */

import { Router } from 'express';
import { HeaderUtils } from 'coze-coding-dev-sdk';
import {
  scanPropagationAlerts,
  getLatestScanResult,
  generateAISignalSummary,
  queryPropagationHistory,
  queryPropagationStats,
  backfillPropagationPerformance,
} from '../services/eventMonitorService.js';
import { streamInterpretation } from '../services/eventMonitorAI.js';

const router = Router();

/**
 * GET /daily - 获取最新传播链预警
 * 返回：扫描日期、冲击事件列表、预警列表、统计摘要
 */
router.get('/daily', (_req, res) => {
  try {
    const result = getLatestScanResult();
    res.json({
      success: true,
      data: result,
    });
  } catch (err: any) {
    console.error('[EventMonitor] GET /daily error:', err.message);
    res.status(500).json({
      success: false,
      error: '扫描失败: ' + err.message,
    });
  }
});

/**
 * POST /scan - 手动触发重新扫描
 * 用于：收盘后强制刷新、数据更新后重算
 */
router.post('/scan', (_req, res) => {
  try {
    const result = scanPropagationAlerts();
    res.json({
      success: true,
      data: result,
      message: `扫描完成：${result.summary.shockCount} 个冲击事件，${result.summary.alertCount} 条预警`,
    });
  } catch (err: any) {
    console.error('[EventMonitor] POST /scan error:', err.message);
    res.status(500).json({
      success: false,
      error: '扫描失败: ' + err.message,
    });
  }
});

/**
 * GET /ai-summary - 获取 AI 解读用的信号摘要文本
 * 返回：纯文本格式，可直接注入 AI 解读模板
 */
router.get('/ai-summary', (_req, res) => {
  try {
    const summary = generateAISignalSummary();
    res.json({
      success: true,
      data: {
        summary,
        scanDate: getLatestScanResult().scanDate,
        alertCount: getLatestScanResult().summary.alertCount,
      },
    });
  } catch (err: any) {
    console.error('[EventMonitor] GET /ai-summary error:', err.message);
    res.status(500).json({
      success: false,
      error: '生成摘要失败: ' + err.message,
    });
  }
});

/**
 * POST /ai-interpretation - 流式 LLM 深度解读（SSE）
 * 无 body 参数，直接基于最新扫描结果解读
 * 返回：SSE 流，data: {content} 逐块，结束 data: [DONE]
 */
router.post('/ai-interpretation', async (req, res) => {
  try {
    // 设置 SSE 响应头
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, no-transform, must-revalidate');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // 提取转发头
    const customHeaders = HeaderUtils.extractForwardHeaders(req.headers as Record<string, string>);

    // 流式输出
    const stream = streamInterpretation(customHeaders);
    for await (const chunk of stream) {
      res.write(`data: ${JSON.stringify({ content: chunk })}\n\n`);
    }

    // 发送结束标记
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (error: any) {
    console.error('[EventMonitor] POST /ai-interpretation error:', error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: 'AI 解读失败: ' + (error?.message || '未知错误') });
    } else {
      res.write(`data: ${JSON.stringify({ error: error?.message || 'AI 解读中断' })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
});

/**
 * GET /history - 历史预警列表（含绩效追踪结果）
 * Query：limit?: number（默认 200）
 */
router.get('/history', (req, res) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
    const data = queryPropagationHistory(limit);
    res.json({ success: true, data });
  } catch (err: any) {
    console.error('[EventMonitor] GET /history error:', err.message);
    res.status(500).json({ success: false, error: '查询历史失败: ' + err.message });
  }
});

/**
 * GET /stats - 传播链预警绩效汇总
 * 返回：总预警数、已验证数、命中数、命中率
 */
router.get('/stats', (_req, res) => {
  try {
    const stats = queryPropagationStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    console.error('[EventMonitor] GET /stats error:', err.message);
    res.status(500).json({ success: false, error: '查询绩效失败: ' + err.message });
  }
});

/**
 * POST /backfill - 手动触发绩效回填
 * 回填 follower 在 lag 天内的实际涨跌，标记命中/未命中
 */
router.post('/backfill', (_req, res) => {
  try {
    const result = backfillPropagationPerformance();
    res.json({
      success: true,
      data: result,
      message: `回填完成：验证 ${result.verified} 条，命中 ${result.hit} 条，未命中 ${result.missed} 条`,
    });
  } catch (err: any) {
    console.error('[EventMonitor] POST /backfill error:', err.message);
    res.status(500).json({ success: false, error: '回填失败: ' + err.message });
  }
});

export default router;
