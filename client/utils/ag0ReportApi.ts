import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
/**
 * 白银(AG0)回测寻优报告 API 工具
 */

const BASE_URL = `${BACKEND_BASE}/api/v1/backtest`;

export interface BacktestStats {
  totalTrades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  avgRR: number;
  longTrades?: number;
  shortTrades?: number;
  maxDrawdown: number;
  capture?: number;
}

export interface SideParams {
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  cooldownBars: number;
  trendFilter: boolean;
  minSignalGrade: string;
}

export interface DrawdownScenario {
  name: string;
  trades: number;
  winRate: number;
  pnl: number;
  pf: number;
  maxDrawdown: number;
  riskAdjusted: number;
}

export interface Ag0Report {
  code: string;
  name: string;
  generatedAt: string;
  sampleCount: number;
  theoreticalMax: { longReturn: number; shortReturn: number };
  baseline: { params: { long: SideParams; short: SideParams }; stats: BacktestStats; capture: { long: number; short: number } };
  optimized: { params: { long: SideParams; short: SideParams }; stats: BacktestStats; capture: { long: number; short: number } };
  optimizedWithCB: { params: { long: SideParams; short: SideParams; circuitBreaker: { lossStreak: number; pauseDays: number } }; stats: BacktestStats; capture: { long: number; short: number } };
  conclusion: string;
  currentParams: {
    long: SideParams;
    short: SideParams;
    circuitBreaker: { lossStreak: number; pauseDays: number };
  };
  multiObjective: {
    bestComposite: { params: SideParams; stats: BacktestStats; composite: number };
    topAll: Array<{ params: SideParams; stats: BacktestStats; composite: number }>;
    paretoCount: number;
  };
  drawdownScenarios: DrawdownScenario[];
  robustAudit: {
    perturbation: { n: number; pnlMean: number; pnlStd: number; pnlCV: number; winRateMean: number; pfMean: number };
    concentration: { totalPnl: number; topYear: string; topYearPnl: number; topYearRatio: number; top3Ratio: number; positiveYears: number };
    byYear: Array<{ year: string; pnl: number; trades: number; wins: number }>;
    final: { totalTrades: number; wins: number; winRate: number; totalPnl: number; profitFactor: number };
  } | null;
}

/**
 * 获取白银回测寻优报告
 *
 * 服务端文件：server/src/routes/backtest.ts
 * 接口：GET /api/v1/backtest/ag0-report
 * 无参数
 */
export async function fetchAg0Report(): Promise<Ag0Report> {
  const response = await fetchWithTimeout(`${BASE_URL}/ag0-report`);
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error || '加载白银回测报告失败');
  }
  return json.data as Ag0Report;
}
