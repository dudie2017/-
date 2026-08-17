/**
 * 事件驱动传播链监控 API 工具
 * 数据来源：GET /api/v1/event-monitor/*
 */
import { fetchWithTimeout } from '@/utils/api';
import EventSource from 'react-native-sse';
import { API_BASE } from './api';

export interface LeaderShock {
  variety: string;
  varietyName: string;
  date: string;
  direction: 'up' | 'down';
  retPct: number;       // 涨跌幅（小数）
  atrMult: number;      // ATR 倍数
  atrValue: number;     // ATR14 值
  close: number;
}

export interface IntradaySignal {
  variety: string;
  varietyName: string;
  direction: 'up' | 'down';
  atrMult: number;
  datetime: string;
  close: number;
}

export interface EventMonitorAlert {
  id: string;
  leader: string;
  leaderName: string;
  follower: string;
  followerName: string;
  direction: 'LONG' | 'SHORT';
  shockDate: string;
  shockReturn: number;
  shockAtrMult: number;
  sector: string;
  logic: string;
  lagDays: number;
  stopLoss: number;
  holdDays: number;
  signalStrength: 'strong' | 'medium';
  confidenceScore: number;
  sectorCorrelation: number | null;
  seasonalAlignment: boolean | null;
}

export interface EventMonitorSummary {
  totalVarieties: number;
  shockCount: number;
  alertCount: number;
  sectors: Record<string, number>;
}

export interface EventMonitorDailyResponse {
  scanDate: string;
  scanTime: string;
  leaderShocks: LeaderShock[];
  intradaySignals: IntradaySignal[];
  alerts: EventMonitorAlert[];
  summary: EventMonitorSummary;
}

export interface EventMonitorAISummary {
  summary: string;
  scanDate: string;
  alertCount: number;
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：GET /api/v1/event-monitor/daily
 * 获取当日传播链监控结果
 */
export async function fetchEventMonitorDaily(): Promise<EventMonitorDailyResponse> {
  const resp = await fetchWithTimeout(`${API_BASE}/event-monitor/daily`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.data;
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：GET /api/v1/event-monitor/ai-summary
 * 获取 AI 解读用的传播链信号摘要
 */
export async function fetchEventMonitorAISummary(): Promise<EventMonitorAISummary> {
  const resp = await fetchWithTimeout(`${API_BASE}/event-monitor/ai-summary`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.data;
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：POST /api/v1/event-monitor/scan
 * 手动触发扫描
 */
export async function triggerEventMonitorScan(): Promise<{ success: boolean; message: string }> {
  const resp = await fetchWithTimeout(`${API_BASE}/event-monitor/scan`, { method: 'POST' });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json;
}

/** 流式解读回调 */
export interface InterpretationHandlers {
  onChunk: (content: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
}

// 流式读取：react-native-sse（Web + Native 通用，基于 XMLHttpRequest）
function streamInterpretation(url: string, handlers: InterpretationHandlers): Promise<void> {
  const { onChunk, onDone, onError } = handlers;
  return new Promise((resolve) => {
    const sse = new EventSource(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
      },
      timeout: 120000,
    });

    sse.addEventListener('message', (event) => {
      const data = (event as { data?: string } | null)?.data;
      if (data === '[DONE]') {
        sse.close();
        onDone();
        resolve();
        return;
      }
      try {
        const parsed = JSON.parse(data || '');
        if (parsed && typeof parsed.content === 'string' && parsed.content) {
          onChunk(parsed.content);
        }
      } catch {
        // 忽略单块解析错误
      }
    });

    sse.addEventListener('error', (event) => {
      sse.close();
      const evt = event as { type?: string; xhrStatus?: number } | null;
      const errorType = evt?.type;
      const xhrStatus = evt?.xhrStatus;
      let msg = '抱歉，响应失败，请重试。';
      if (errorType === 'timeout') {
        msg = '响应超时，请稍后重试。';
      } else if (xhrStatus === 502 || xhrStatus === 504) {
        msg = '服务响应超时，请稍后重试。';
      } else if (xhrStatus && xhrStatus >= 500) {
        msg = '服务端错误，请稍后重试。';
      } else if (errorType === 'exception') {
        msg = '连接异常，请稍后重试。';
      }
      onError(msg);
      resolve();
    });
  });
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：POST /api/v1/event-monitor/ai-interpretation
 * 流式 LLM 深度解读（SSE），无 body 参数，基于最新扫描结果
 */
export function streamEventMonitorInterpretation(handlers: InterpretationHandlers): Promise<void> {
  const url = `${API_BASE}/event-monitor/ai-interpretation`;
  return streamInterpretation(url, handlers);
}

// ===== 历史预警 + 绩效追踪 =====

export interface PropagationHistoryItem {
  id: number;
  scan_time: string;
  shock_date: string;
  leader: string;
  leader_name: string;
  follower: string;
  follower_name: string;
  direction: 'LONG' | 'SHORT';
  signal_strength: string;
  atr_mult: number;
  confidence_score: number;
  sector: string;
  logic: string;
  lag_days: number;
  hold_days: number;
  entry_price: number;
  stop_loss: number;
  status: 'pending' | 'verified';
  verified_hit: number;
  follower_return_pct: number;
  verified_at: string | null;
  created_at: string;
}

export interface PropagationStats {
  total: number;
  verified: number;
  hit: number;
  hitRate: number | null;
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：GET /api/v1/event-monitor/history
 * Query 参数：limit?: number（默认 200）
 */
export async function fetchPropagationHistory(limit = 100): Promise<PropagationHistoryItem[]> {
  const resp = await fetchWithTimeout(`${API_BASE}/event-monitor/history?limit=${limit}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.data;
}

/**
 * 服务端文件：server/src/routes/eventMonitor.ts
 * 接口：GET /api/v1/event-monitor/stats
 * 无参数
 */
export async function fetchPropagationStats(): Promise<PropagationStats> {
  const resp = await fetchWithTimeout(`${API_BASE}/event-monitor/stats`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const json = await resp.json();
  return json.data;
}
