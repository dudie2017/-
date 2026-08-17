/**
 * 交易监控 API 客户端
 * 机会监控 / 持仓监控 / 提醒中心
 */
import { fetchWithTimeout } from '@/utils/api';
import { API_BASE } from './api';

export interface MonitorAlertItem {
  id: number;
  alert_type: string;    // opportunity / signal_change / position_stop / position_target / position_reverse / position_trend / position_timeout / news_black_swan
  severity: string;      // high / medium / low
  code: string;
  name: string;
  title: string;
  message: string;
  detail?: string;       // JSON 字符串
  is_read: number;
  push_status: string;
  created_at: string;
}

export interface MonitorPosition {
  id: number;
  code: string;
  name: string;
  direction: 'long' | 'short';
  entry_price: number;
  entry_time: string;
  stop_loss?: number | null;
  target_price?: number | null;
  lots?: number;
  note?: string;
  status: string;
  created_at: string;
}

/**
 * 获取提醒列表
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：GET /api/v1/monitor/alerts
 * Query 参数：unreadOnly?: boolean, limit?: number
 */
export async function fetchMonitorAlerts(options: { unreadOnly?: boolean; limit?: number } = {}): Promise<{ alerts: MonitorAlertItem[]; unreadCount: number }> {
  const params = new URLSearchParams();
  if (options.unreadOnly) params.set('unreadOnly', 'true');
  if (options.limit) params.set('limit', String(options.limit));
  const query = params.toString() ? `?${params.toString()}` : '';
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/alerts${query}`);
  if (!resp.ok) throw new Error(`获取提醒失败: ${resp.status}`);
  return resp.json();
}

/**
 * 获取未读数
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：GET /api/v1/monitor/alerts/unread-count
 */
export async function fetchUnreadAlertCount(): Promise<number> {
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/monitor/alerts/unread-count`);
    if (!resp.ok) return 0;
    const data = await resp.json();
    return data.unreadCount || 0;
  } catch {
    return 0;
  }
}

/**
 * 标记已读
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：POST /api/v1/monitor/alerts/:id/read
 * Path 参数：id: number
 */
export async function markAlertRead(id: number): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/alerts/${id}/read`, { method: 'POST' });
  if (!resp.ok) throw new Error('标记已读失败');
}

/**
 * 全部已读
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：POST /api/v1/monitor/alerts/read-all
 */
export async function markAllAlertsRead(): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/alerts/read-all`, { method: 'POST' });
  if (!resp.ok) throw new Error('全部已读失败');
}

/**
 * 获取自动扫描状态
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：GET /api/v1/monitor/scan-status
 * 返回：{ lastScanAt: number | null, isScanning: boolean }
 */
export async function fetchScanStatus(): Promise<{ lastScanAt: number | null; isScanning: boolean }> {
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/monitor/scan-status`);
    if (!resp.ok) return { lastScanAt: null, isScanning: false };
    return resp.json();
  } catch {
    return { lastScanAt: null, isScanning: false };
  }
}

/**
 * 触发一次全监控扫描
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：POST /api/v1/monitor/scan
 */
export async function triggerMonitorScan(): Promise<{ success: boolean; opportunities: string[]; positionAlerts: string[]; newsAlerts: string[]; skipped?: boolean }> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/scan`, { method: 'POST' });
  if (!resp.ok) throw new Error('触发监控失败');
  return resp.json();
}

/** 品种综合质量评分 */
export interface VarietyQuality {
  code: string;
  compositeScore: number;
  robustPct: number;
  profitFactor: number;
  maxDrawdown: number;
  winRate: number;
  totalTrades: number;
  sampleReliability: 'high' | 'medium' | 'low';
}

/**
 * 获取所有品种综合质量评分
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：GET /api/v1/monitor/quality-scores
 * 返回：{ scores: VarietyQuality[] }（已按 compositeScore 降序排列）
 */
export async function fetchVarietyQualityScores(): Promise<VarietyQuality[]> {
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/monitor/quality-scores`);
    if (!resp.ok) return [];
    const data = await resp.json();
    return data.scores ?? [];
  } catch {
    return [];
  }
}

/**
 * 获取监控持仓列表
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：GET /api/v1/monitor/positions
 */
export async function fetchMonitorPositions(status = 'active'): Promise<MonitorPosition[]> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/positions?status=${status}`);
  if (!resp.ok) throw new Error('获取持仓失败');
  const data = await resp.json();
  return data.positions || [];
}

/**
 * 登记/更新监控持仓
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：POST /api/v1/monitor/positions
 * Body 参数：code: string, name: string, direction: 'long'|'short', entry_price: number, stop_loss?: number, target_price?: number
 */
export async function saveMonitorPosition(body: {
  code: string;
  name: string;
  direction: 'long' | 'short';
  entry_price: number;
  entry_time?: string;
  stop_loss?: number | null;
  target_price?: number | null;
  lots?: number;
  note?: string;
}): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/positions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({}));
    throw new Error(data.error || '登记持仓失败');
  }
}

/**
 * 删除监控持仓
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：DELETE /api/v1/monitor/positions/:code
 * Path 参数：code: string
 */
export async function deleteMonitorPosition(code: string): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/positions/${code}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error('删除持仓失败');
}

/**
 * 平仓（软关闭）
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：POST /api/v1/monitor/positions/:code/close
 * Path 参数：code: string
 */
export async function closeMonitorPosition(code: string): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/positions/${code}/close`, { method: 'POST' });
  if (!resp.ok) throw new Error('平仓失败');
}

/**
 * 清空所有提醒
 * 服务端文件：server/src/routes/monitor.ts
 * 接口：DELETE /api/v1/monitor/alerts
 */
export async function clearMonitorAlerts(): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/monitor/alerts`, { method: 'DELETE' });
  if (!resp.ok) throw new Error('清空提醒失败');
}

