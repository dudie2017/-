import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
/**
 * 多方 1000 次回测对比报告 API 工具
 */

const BASE_URL = `${BACKEND_BASE}/api/v1/backtest`;

export interface MultiStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  capture: number;
  longCapture: number;
  shortCapture: number;
}

export interface MultiRank {
  pnl: number;
  dd: number;
  capture: number;
  total: number;
}

export interface VarianceDim {
  dimension: string;
  explained: number;
  bestValue: string | number | boolean;
  worstValue: string | number | boolean;
  spread: number;
}

export interface FragilityFactor {
  dimension: string;
  value: string | number | boolean;
  inFragile: number;
  inAll: number;
  lift: number;
}

export interface TopRecipe {
  directionMode: string;
  circuitBreaker: string;
  maxHoldDays: number;
  stopAtrMult: number;
  targetAtrMult: number;
  minSignalGrade: string;
}

export interface MultiItem {
  code: string;
  name: string;
  dateRange: string;
  bars: number;
  baseline: {
    stats: MultiStats | null;
    rank: MultiRank | null;
  };
  variance: VarianceDim[];
  fragility: FragilityFactor[];
  topComposite: Array<{ stats: MultiStats; recipe: TopRecipe }>;
  circuitBreaker: { lossStreak: number; pauseBars: number } | null;
}

export interface MultiReportData {
  generatedAt: string;
  items: MultiItem[];
  conclusions: string[];
}

/**
 * 获取多方回测对比报告
 *
 * 服务端文件：server/src/routes/backtest.ts
 * 接口：GET /api/v1/backtest/multi-report
 * 无参数
 */
export async function fetchMultiReport(): Promise<MultiReportData> {
  const response = await fetchWithTimeout(`${BASE_URL}/multi-report`);
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error || '加载多方回测报告失败');
  }
  return json.data;
}
