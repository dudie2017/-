/**
 * 每日信号日报 + 模拟交易 API
 */
import { fetchWithTimeout } from '@/utils/api';
import { getBackendBaseUrl } from './api';

const BASE = () => `${getBackendBaseUrl()}/api/v1`;

// ====== 日报 API ======

export interface JournalRecord {
  id: number;
  trade_date: string;
  code: string;
  name: string;
  close: number;
  change_pct: number;
  spectrum: string;
  ai_direction: string;
  signal_level: string;
  p_follow: number;
  adx: number;
  g4_count: number;
  one_liner: string;
  advice: string;
  ch_direction: string;
  ch_entry: number;
  ch_stop: number;
  ch_target: number;
  mm_tier1: number;
  mm_tier2: number;
  trend_momentum: number;
  detail_json: string;
  created_at: string;
}

export interface JournalStats {
  directionChanges: number;
  spectrumUpgrades: number;
  spectrumDowngrades: number;
  consecutiveSameDirection: number;
  avgPFollow: number;
}

/**
 * 一键回填历史信号日报
 * 服务端：POST /api/v1/journal/backfill
 * Body 参数：startDate?: string (YYYY-MM-DD，默认 2026-01-01), endDate?: string (YYYY-MM-DD，默认今天)
 */
export async function triggerJournalBackfill(
  startDate?: string,
  endDate?: string
): Promise<{ success: boolean; total: number; generated: number; skipped: number; failed: number; skippedDates?: string[]; failedDates?: string[] }> {
  const res = await fetchWithTimeout(`${BASE()}/journal/backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: startDate || '2026-01-01', endDate: endDate || getLocalDateStr() }),
  });
  const data = await res.json();
  if (!res.ok || data.success === false) {
    throw new Error(data.error || `回填失败 (${res.status})`);
  }
  return data;
}

function getLocalDateStr(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 获取已有日报的日期列表
 * 服务端：GET /api/v1/journal/dates
 */
export async function fetchJournalDates(): Promise<string[]> {
  const res = await fetchWithTimeout(`${BASE()}/journal/dates`);
  const data = await res.json();
  return data.dates || [];
}

/**
 * 按日期查询日报
 * 服务端：GET /api/v1/journal/date/:date
 * Path 参数：date: string (YYYY-MM-DD)
 */
export async function fetchJournalByDate(date: string): Promise<JournalRecord[]> {
  const res = await fetchWithTimeout(`${BASE()}/journal/date/${date}`);
  const data = await res.json();
  return data.records || [];
}

/**
 * 查询某品种的历史日报
 * 服务端：GET /api/v1/journal/variety/:code?limit=30
 * Path 参数：code: string
 * Query 参数：limit: number
 */
export async function fetchJournalByCode(code: string, limit = 30): Promise<{ records: JournalRecord[]; stats: JournalStats }> {
  const res = await fetchWithTimeout(`${BASE()}/journal/code/${code}?limit=${limit}`);
  const data = await res.json();
  return { records: data.records || [], stats: data.stats || { directionChanges: 0, spectrumUpgrades: 0, spectrumDowngrades: 0, consecutiveSameDirection: 0, avgPFollow: 0 } };
}

/**
 * 手动触发生成日报
 * 服务端：POST /api/v1/journal/generate
 * Body 参数：tradeDate?: string (YYYY-MM-DD，不传则默认当天本地日期)
 */
export async function triggerJournalGenerate(date?: string): Promise<{ success: boolean; count: number; message?: string }> {
  const res = await fetchWithTimeout(`${BASE()}/journal/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tradeDate: date }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`生成失败 (${res.status}): ${text}`);
  }
  const data = await res.json();
  return {
    success: true,
    count: data.savedCount || 0,
    message: data.message,
  };
}

// ====== 模拟交易 API ======

export interface SimTrade {
  id: number;
  code: string;
  name: string;
  direction: string;
  entry_date: string;
  entry_price: number;
  exit_date: string | null;
  exit_price: number | null;
  pnl: number | null;
  pnl_pct: number | null;
  status: string;
  entry_reason: string;
  exit_reason: string;
  signal_grade: string | null;
  signal_score: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  max_hold_days: number | null;
  fee: number | null;
  position_size: number | null;  // Kelly 仓位（手数）
  created_at: string;
}

export interface SimTradeStats {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  totalPnl: number;
  winRate: number;
  maxDrawdown: number;
  openTrades: number;
  closedTrades: number;
  floatingPnl: number;
  avgPnl: number;
  bestTrade: number;
  worstTrade: number;
  // Kelly 仓位管理相关
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
}

/**
 * 查询模拟交易列表
 * 服务端：GET /api/v1/sim-trades
 * Query 参数：status?: 'open' | 'closed', code?: string, limit?: number
 */
export async function fetchSimTrades(options: { status?: string; code?: string; limit?: number } = {}): Promise<SimTrade[]> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.code) params.set('code', options.code);
  if (options.limit) params.set('limit', String(options.limit));
  const res = await fetchWithTimeout(`${BASE()}/sim-trades?${params.toString()}`);
  const data = await res.json();
  return data.trades || [];
}

/**
 * 获取模拟交易统计
 * 服务端：GET /api/v1/sim-trades/stats
 */
export async function fetchSimTradeStats(): Promise<SimTradeStats> {
  const res = await fetchWithTimeout(`${BASE()}/sim-trades/stats`);
  return await res.json();
}

/**
 * 手动同步模拟交易
 * 服务端：POST /api/v1/sim-trades/sync
 */
export async function triggerSimTradeSync(): Promise<{ success: boolean; opened: number; closed: number }> {
  const res = await fetchWithTimeout(`${BASE()}/sim-trades/sync`, { method: 'POST' });
  return await res.json();
}

// ====== 复盘 API ======

export interface JournalReviewRecord {
  id: number;
  code: string;
  name: string;
  trade_date: string;
  direction: string;
  entry_price: number;
  stop_price: number | null;
  target_price: number | null;
  signal_level: string;
  status: string;
  close_price: number | null;
  close_date: string | null;
  pnl_pct: number | null;
  review_note: string | null;
  created_at: string;
}

export interface ReviewStats {
  total: number;
  pending: number;
  entered: number;
  stopped: number;
  hitTarget: number;
  expired: number;
  closed: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  avgPnlPct: number;
  byGrade: Array<{ signal_level: string; total: number; wins: number; losses: number }>;
  byDirection: Array<{ direction: string; total: number; wins: number; losses: number }>;
  recent: Array<{ advice_date: string; total: number; wins: number }>;
}

/**
 * 查询复盘记录列表
 * 服务端：GET /api/v1/journal/reviews
 * Query 参数：status?: string, limit?: number
 */
export async function fetchJournalReviews(options: { status?: string; limit?: number } = {}): Promise<JournalReviewRecord[]> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit) params.set('limit', String(options.limit));
  const res = await fetchWithTimeout(`${BASE()}/journal/reviews?${params.toString()}`);
  const data = await res.json();
  return data.reviews || data.records || [];
}

/**
 * 查询复盘统计
 * 服务端：GET /api/v1/journal/reviews/stats
 */
export async function fetchJournalReviewStats(): Promise<ReviewStats> {
  const res = await fetchWithTimeout(`${BASE()}/journal/reviews/stats`);
  const data = await res.json();
  return data.stats || {};
}

/**
 * 手动触发复盘更新
 * 服务端：POST /api/v1/journal/review/update
 */
export async function triggerReviewUpdate(): Promise<{ success: boolean; updated: number }> {
  const res = await fetchWithTimeout(`${BASE()}/journal/review/update`, { method: 'POST' });
  const data = await res.json();
  return { success: data.success !== false, updated: data.updated || 0 };
}

/**
 * 更新单条复盘记录状态（pending → entered/stopped/hit_target/expired）
 * 服务端：POST /api/v1/journal/review/:id/status
 * Body 参数：status: string, closePrice?: number, note?: string
 */
export async function updateJournalReviewStatus(
  id: number,
  status: string,
  extra: { closePrice?: number; note?: string } = {}
): Promise<{ success: boolean; message?: string }> {
  const res = await fetchWithTimeout(`${BASE()}/journal/review/${id}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, closePrice: extra.closePrice, note: extra.note }),
  });
  const data = await res.json();
  return { success: data.success !== false, message: data.message };
}
