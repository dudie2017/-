/**
 * 交易监控 API
 * 机会监控 + 持仓监控 + 提醒中心
 */
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as monitor from '../services/monitorService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// ---------- 提醒中心 ----------

// GET /api/v1/monitor/alerts - 提醒列表
router.get('/alerts', (req, res) => {
  try {
    const unreadOnly = req.query.unreadOnly === 'true';
    const limit = Number(req.query.limit) || 100;
    const alerts = monitor.getTradeAlerts({ unreadOnly, limit });
    const unreadCount = monitor.getUnreadAlertCount();
    res.json({ alerts, unreadCount });
  } catch (error) {
    console.error('Failed to get monitor alerts:', error);
    res.status(500).json({ error: 'Failed to get monitor alerts' });
  }
});

// GET /api/v1/monitor/alerts/unread-count - 未读数
router.get('/alerts/unread-count', (req, res) => {
  try {
    res.json({ unreadCount: monitor.getUnreadAlertCount() });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get unread count' });
  }
});

// POST /api/v1/monitor/alerts/:id/read - 标记已读
router.post('/alerts/:id/read', (req, res) => {
  try {
    const id = Number(req.params.id);
    monitor.markTradeAlertRead(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark read' });
  }
});

// POST /api/v1/monitor/alerts/read-all - 全部已读
router.post('/alerts/read-all', (req, res) => {
  try {
    monitor.markAllTradeAlertsRead();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to mark all read' });
  }
});

// DELETE /api/v1/monitor/alerts - 清空提醒
router.delete('/alerts', (req, res) => {
  try {
    monitor.clearTradeAlerts();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to clear alerts' });
  }
});

// ---------- 自动扫描 ----------

// GET /api/v1/monitor/scan-status - 自动扫描状态（上次扫描时间 / 是否扫描中）
router.get('/scan-status', (req, res) => {
  try {
    res.json(monitor.getScanStatus());
  } catch (error) {
    console.error('Failed to get scan status:', error);
    res.status(500).json({ error: 'Failed to get scan status' });
  }
});

// POST /api/v1/monitor/scan - 触发一次全监控扫描（机会+持仓+新闻）
router.post('/scan', async (req, res) => {
  try {
    const result = await monitor.runMonitorOnce();
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Monitor scan failed:', error);
    res.status(500).json({ error: 'Monitor scan failed', message: (error as Error).message });
  }
});

// ---------- 监控持仓 ----------

// GET /api/v1/monitor/positions - 持仓列表
router.get('/positions', (req, res) => {
  try {
    const status = (req.query.status as string) || 'active';
    res.json({ positions: monitor.getMonitoredPositions(status) });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get positions' });
  }
});

// GET /api/v1/monitor/positions/:code - 单品种持仓详情
router.get('/positions/:code', (req, res) => {
  try {
    const pos = monitor.getMonitoredPosition(req.params.code);
    if (!pos) return res.status(404).json({ error: '持仓不存在' });
    res.json({ position: pos });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get position' });
  }
});

// POST /api/v1/monitor/positions - 登记/更新持仓
router.post('/positions', (req, res) => {
  try {
    const { code, name, direction, entry_price, entry_time, stop_loss, target_price, lots, note } = req.body || {};
    if (!code || !name || !direction || entry_price == null) {
      return res.status(400).json({ error: '缺少必填字段: code/name/direction/entry_price' });
    }
    if (direction !== 'long' && direction !== 'short') {
      return res.status(400).json({ error: 'direction 必须为 long 或 short' });
    }
    monitor.saveMonitoredPosition({
      code, name, direction, entry_price,
      entry_time: entry_time || new Date().toISOString(),
      stop_loss: stop_loss ?? null,
      target_price: target_price ?? null,
      lots: lots || 1,
      note: note || '',
      status: 'active',
    });
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to save position:', error);
    res.status(500).json({ error: 'Failed to save position' });
  }
});

// DELETE /api/v1/monitor/positions/:code - 删除持仓
router.delete('/positions/:code', (req, res) => {
  try {
    monitor.deleteMonitoredPosition(req.params.code);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete position' });
  }
});

// POST /api/v1/monitor/positions/:code/close - 平仓（软关闭）
router.post('/positions/:code/close', (req, res) => {
  try {
    monitor.closeMonitoredPosition(req.params.code);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Failed to close position' });
  }
});

// ---------- 品种质量评分 ----------

// 品种综合质量评分（综合稳健盈利比例/盈亏比/最大回撤/胜率，样本可信度加权）
router.get('/quality-scores', (_req, res) => {
  try {
    const topParams = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/_topParams.json'), 'utf-8')) as Record<string, any>;

    const SAMPLE_RELIABILITY: Record<string, 'high' | 'medium' | 'low'> = {
      RB0:'high',CF0:'high',CU0:'high',RU0:'high',ZN0:'high',AL0:'high',TA0:'high',Y0:'high',J0:'high',IF0:'high',M0:'high',P0:'high',HC0:'high',
      IM0:'medium',SP0:'medium',JM0:'medium',IC0:'medium',SC0:'medium',NI0:'medium',I0:'medium',AU0:'medium',SI0:'medium',PB0:'medium',
      AG0:'low',LH0:'low',
    };
    const RELIABILITY_MULTIPLIER: Record<string, number> = { high: 1.0, medium: 0.85, low: 0.6 };

    function parseFloat2(v: unknown): number {
      if (v == null) return 0;
      return parseFloat(String(v).replace('%', ''));
    }
    function calcPF(pf: number): number { return Math.min(100, Math.max(0, ((pf - 0.5) / 1.5) * 100)); }
    function calcDD(dd: number): number { return Math.min(100, Math.max(0, ((30 - dd) / 25) * 100)); }
    function calcWR(wr: number): number { return Math.min(100, Math.max(0, ((wr - 30) / 30) * 100)); }

    const results = Object.entries(topParams)
      .filter(([code]) => code !== 'IH0')
      .map(([code, data]: [string, any]) => {
        const stats = data.stats || {};
        const rp = parseFloat2(data.robustPct ?? 0);
        const pf = parseFloat2(stats.profitFactor);
        const dd = parseFloat2(stats.maxDrawdown);
        const wr = parseFloat2(stats.winRate);
        const trades = stats.totalTrades ?? 0;
        const rel = SAMPLE_RELIABILITY[code] ?? 'medium';
        const raw = rp * 0.40 + calcPF(pf) * 0.30 + calcDD(dd) * 0.20 + calcWR(wr) * 0.10;
        const compositeScore = Math.round(raw * RELIABILITY_MULTIPLIER[rel] * 10) / 10;
        return { code, compositeScore, robustPct: rp, profitFactor: pf, maxDrawdown: dd, winRate: wr, totalTrades: trades, sampleReliability: rel };
      })
      .sort((a: any, b: any) => b.compositeScore - a.compositeScore);

    res.json({ scores: results });
  } catch (error) {
    console.error('Failed to get quality scores:', error);
    res.status(500).json({ error: 'Failed to get quality scores' });
  }
});

export default router;
