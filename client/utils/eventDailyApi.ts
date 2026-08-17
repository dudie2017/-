/**
 * 事件驱动日报 API
 * 以最新实时事件（新闻检测）为入口，生成综合分析日报并沉淀为复盘数据。
 */
import { fetchWithTimeout } from '@/utils/api';
import { getBackendBaseUrl } from './api';

const BASE = () => `${getBackendBaseUrl()}/api/v1`;

// ====== 类型定义 ======

export interface BlackSwanEventItem {
  id: string;
  date: string;
  category: number;
  categoryName: string;
  title: string;
  varieties: string[];
  direction: '利多' | '利空' | '中性';
  consensus: string;
  note?: string;
  confidence?: number;
  matchedNewsCount?: number;
}

export interface EventDailyVariety {
  code: string;
  name: string;
  group: string;
  hasData: boolean;
  close?: number;
  retPct?: number;
  spectrum?: string;
  aiDirection?: string;
  trendStrength?: number;
  adx?: number;
  marketContext?: string;
  lcStage?: string;
  signalGrade?: string;
  recent5dReturn?: number;
  recent20dReturn?: number;
}

export interface EventDailyReport {
  event: {
    id: string;
    date: string;
    title: string;
    category: number;
    categoryName: string;
    direction: string;
    consensus: string;
    note?: string;
  };
  varieties: EventDailyVariety[];
  groups: Record<string, string[]>;
  aiConclusion: string;
}

export interface EventDailyReportRecord {
  id: string;
  event_id: string;
  event_date: string;
  title: string;
  category: string;
  generated_at: string;
  report_json: string;
  is_realtime?: number; // 1 = 实时事件, 0 = 历史事件
}

// ====== API 函数 ======

/**
 * 获取最新事件列表（从新闻实时检测，非历史事件库）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：GET /api/v1/event-daily/events
 * Query 参数：category?: number, keyword?: string
 */
export async function fetchEvents(options: { category?: number; keyword?: string } = {}): Promise<BlackSwanEventItem[]> {
  const params = new URLSearchParams();
  if (options.category !== undefined) params.set('category', String(options.category));
  if (options.keyword) params.set('keyword', options.keyword);
  const qs = params.toString();
  const res = await fetchWithTimeout(`${BASE()}/event-daily/events${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '获取事件列表失败');
  return json.data as BlackSwanEventItem[];
}

/**
 * 获取历史黑天鹅事件库（稳定 id，用于"事件日报"列表）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：GET /api/v1/event-daily/history-events
 * Query 参数：category?: number, keyword?: string
 */
export async function fetchHistoricalEvents(options: { category?: number; keyword?: string } = {}): Promise<BlackSwanEventItem[]> {
  const params = new URLSearchParams();
  if (options.category !== undefined) params.set('category', String(options.category));
  if (options.keyword) params.set('keyword', options.keyword);
  const qs = params.toString();
  const res = await fetchWithTimeout(`${BASE()}/event-daily/history-events${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '获取历史事件列表失败');
  return json.data as BlackSwanEventItem[];
}

/**
 * 获取实时事件列表（从新闻检测到的最新事件）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：GET /api/v1/event-daily/events
 * Query 参数：category?: number, keyword?: string
 */
export async function fetchRealtimeEvents(options: { category?: number; keyword?: string } = {}): Promise<BlackSwanEventItem[]> {
  const params = new URLSearchParams();
  if (options.category !== undefined) params.set('category', String(options.category));
  if (options.keyword) params.set('keyword', options.keyword);
  const qs = params.toString();
  const res = await fetchWithTimeout(`${BASE()}/event-daily/events${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '获取实时事件列表失败');
  return json.data as BlackSwanEventItem[];
}

/**
 * 手动刷新实时事件（强制重新检测新闻）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：POST /api/v1/event-daily/refresh
 * 无 Body 参数
 */
export async function refreshRealtimeEvents(): Promise<BlackSwanEventItem[]> {
  const res = await fetchWithTimeout(`${BASE()}/event-daily/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '手动更新实时事件失败');
  return json.data as BlackSwanEventItem[];
}

/**
 * 全量回填历史事件库所有事件日报（幂等：已存在跳过）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：POST /api/v1/event-daily/generate-all
 * 无 Body 参数
 */
export async function generateAllEventDailies(): Promise<{ total: number; generated: number; skipped: number; failed: number }> {
  const res = await fetchWithTimeout(`${BASE()}/event-daily/generate-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '全量生成事件日报失败');
  return json.data as { total: number; generated: number; skipped: number; failed: number };
}

/**
 * 生成事件日报（含 AI 综合分析结论）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：POST /api/v1/event-daily/generate
 * Body 参数：eventId?: string（可选，指定某个最新事件；不传则生成全部最新事件）
 */
export async function generateEventDaily(eventId: string): Promise<{ id: string; report: EventDailyReport }> {
  const res = await fetchWithTimeout(`${BASE()}/event-daily/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '生成日报失败');
  return json.data as { id: string; report: EventDailyReport };
}

/**
 * 获取历史事件日报列表（复盘数据）
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：GET /api/v1/event-daily/list
 * Query 参数：limit?: number
 */
export async function fetchEventDailyList(limit = 50): Promise<EventDailyReportRecord[]> {
  const res = await fetchWithTimeout(`${BASE()}/event-daily/list?limit=${limit}`, {}, 30000);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '获取历史日报失败');
  return json.data as EventDailyReportRecord[];
}

/**
 * 获取某份事件日报详情
 * 服务端文件：server/src/routes/eventDaily.ts
 * 接口：GET /api/v1/event-daily/:id
 * Path 参数：id: string
 */
export async function fetchEventDailyDetail(
  id: string
): Promise<EventDailyReportRecord & { report: EventDailyReport }> {
  const res = await fetchWithTimeout(`${BASE()}/event-daily/${id}`, {}, 30000);
  const json = await res.json();
  if (!json.success) throw new Error(json.error || '获取日报详情失败');
  return json.data as EventDailyReportRecord & { report: EventDailyReport };
}
