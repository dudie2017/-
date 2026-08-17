import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
/**
 * 模拟盘 API 工具
 * 
 * 基于 v15 策略（PF=14.69，胜率 62.5%）
 */

const BASE_URL = `${BACKEND_BASE}/api/v1/paper-trading`;

export interface RiskStatus {
  totalPositions: number;
  maxTotalPositions: number;
  sectorExposure: Record<string, number>;
  maxSectorPositions: number;
  sectorLossThreshold: number;
  sectorLossPctThreshold: number;
}

export interface PaperTradingStats {
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  totalPnl: number;
  winRate: number;
  maxDrawdown: number;
  openTrades: number;
  recentTrades: SimTrade[];
  riskStatus: RiskStatus;
  currentRegime?: 'high' | 'normal' | 'low';
  regimeParams?: {
    atrMult: number;
    maxHold: number;
    stopLoss: number;
    sectorCorrThreshold: number;
    gradualAtrMult: number;
  };
}

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
  exit_reason: string | null;
  signal_score: number | null;
  signal_grade: string | null;
}

export interface V15Signal {
  leaderCode: string;
  followerCode: string;
  direction: 'long' | 'short';
  shockDate: string;
  shockRet: number;
  atrMult: number;
  lag: number;
  sector: string;
  logic: string;
  entryPrice: number;
  stopPrice: number;
  signalType: 'shock' | 'gradual';
  score: number;
  grade: 'A' | 'B' | 'C' | 'D';
}

/**
 * 获取模拟盘统计
 */
export async function fetchPaperTradingStats(): Promise<PaperTradingStats> {
  const response = await fetchWithTimeout(`${BASE_URL}/stats`);
  if (!response.ok) throw new Error('获取模拟盘统计失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取统计失败');
  return result.data;
}

/**
 * 获取模拟交易列表
 */
export async function fetchSimTrades(status?: string, limit = 50): Promise<SimTrade[]> {
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('limit', limit.toString());
  
  const response = await fetchWithTimeout(`${BASE_URL}/trades?${params}`);
  if (!response.ok) throw new Error('获取交易列表失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取交易列表失败');
  return result.data;
}

/**
 * 手动触发模拟盘扫描
 */
export async function triggerPaperTradingScan(): Promise<{ signalCount: number; newTrades: number; filteredCount: number; riskFilteredCount: number; signals: V15Signal[] }> {
  const response = await fetchWithTimeout(`${BASE_URL}/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) throw new Error('扫描失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '扫描失败');
  return result.data;
}

/**
 * 获取当前 v15 信号（不创建交易）
 */
export async function fetchV15Signals(): Promise<{ count: number; signals: V15Signal[] }> {
  const response = await fetchWithTimeout(`${BASE_URL}/signals`);
  if (!response.ok) throw new Error('获取信号失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取信号失败');
  return result.data;
}

// ============ 绩效看板类型 ============

export interface EquityPoint {
  date: string;
  cumulativePnl: number;
}

export interface SignalTypeDist {
  type: string;
  count: number;
  winRate: number;
  pnl: number;
  trades: number;
}

export interface VarietyStat {
  code: string;
  name: string;
  trades: number;
  winRate: number;
  pnl: number;
}

export interface PaperPerformance {
  summary: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    totalPnl: number;
    winRate: number;
    maxDrawdown: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgHoldDays: number;
    openTrades: number;
  };
  directionDist: {
    longCount: number;
    shortCount: number;
    longWinRate: number;
    shortWinRate: number;
    longPnl: number;
    shortPnl: number;
  };
  signalTypeDist: SignalTypeDist[];
  byVariety: VarietyStat[];
  equityCurve: EquityPoint[];
  monthlyPnl: { month: string; pnl: number }[];
  // 高级风险指标
  riskMetrics?: {
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    annualizedReturn: number;
    annualizedVolatility: number;
    tradingDays: number;
  };
}

/**
 * 服务端文件：server/src/routes/paperTrading.ts
 * 接口：GET /api/v1/paper-trading/performance
 * 返回：模拟盘完整绩效看板数据（收益曲线/胜率/回撤/信号来源分布/品种排行）
 */
export async function fetchPaperPerformance(): Promise<PaperPerformance> {
  const response = await fetchWithTimeout(`${BASE_URL}/performance`);
  if (!response.ok) throw new Error('获取绩效看板失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取绩效看板失败');
  return result.data;
}

// ============ 信号可视化类型 ============

export interface SignalHistoryItem {
  id: number;
  code: string;
  name: string;
  direction: 'long' | 'short';
  entryDate: string;
  entryPrice: number;
  exitDate: string | null;
  exitPrice: number | null;
  pnl: number | null;
  pnlPct: number | null;
  status: 'open' | 'closed';
  entryReason: string | null;
  exitReason: string | null;
  signalScore: number | null;
  signalGrade: string | null;
  createdAt: string;
}

export interface SectorHeatmapVariety {
  code: string;
  ret: number;
  date: string;
}

export interface SectorHeatmapSector {
  sector: string;
  varieties: SectorHeatmapVariety[];
  upCount: number;
  downCount: number;
  flatCount: number;
  total: number;
  correlationStrength: number;
  dominantDirection: 'up' | 'down' | 'neutral';
}

export interface SectorHeatmapData {
  sectors: SectorHeatmapSector[];
  updatedAt: string;
}

/**
 * 服务端文件：server/src/routes/paperTrading.ts
 * 接口：GET /api/v1/paper-trading/signal-history
 * Query: code?: string, limit?: number
 * 返回：信号历史列表（用于可视化）
 */
export async function fetchSignalHistory(code?: string, limit = 100): Promise<{ count: number; signals: SignalHistoryItem[] }> {
  const params = new URLSearchParams();
  if (code) params.set('code', code);
  params.set('limit', String(limit));
  
  const response = await fetchWithTimeout(`${BASE_URL}/signal-history?${params}`);
  if (!response.ok) throw new Error('获取信号历史失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取信号历史失败');
  return result.data;
}

/**
 * 服务端文件：server/src/routes/paperTrading.ts
 * 接口：GET /api/v1/paper-trading/sector-heatmap
 * 返回：板块联动热力图数据
 */
export async function fetchSectorHeatmap(): Promise<SectorHeatmapData> {
  const response = await fetchWithTimeout(`${BASE_URL}/sector-heatmap`);
  if (!response.ok) throw new Error('获取板块热力图失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取板块热力图失败');
  return result.data;
}

// ============ 1000次回测品种列表类型 ============

export interface BacktestVariety {
  code: string;
  name: string;
  sector: string;
  experiments: number;
  bars: number;
  dateRange: string | null;
  theoLong: number | null;
  theoShort: number | null;
  baseline: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    capture: number;
  };
  best: {
    winRate: number;
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    totalTrades: number;
    score: number;
  } | null;
  error?: string;
}

/**
 * 服务端文件：server/src/routes/backtest.ts
 * 接口：GET /api/v1/backtest/varieties
 * 返回：全部品种的 1000 次回测汇总列表（来自 *_1000Experiments.json）
 */
export async function fetchBacktestVarieties(): Promise<BacktestVariety[]> {
  const backtestUrl = `${BACKEND_BASE}/api/v1/backtest/varieties`;
  const response = await fetchWithTimeout(backtestUrl);
  if (!response.ok) throw new Error('获取品种回测列表失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取品种回测列表失败');
  return result.data;
}

// ============ ML vs 手动对比分析类型 ============

export interface ComparisonStats {
  ml: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    avgPnl: number;
    maxDrawdown: number;
  };
  manual: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnl: number;
    profitFactor: number;
    avgPnl: number;
    maxDrawdown: number;
  };
  comparison: {
    mlWinRateDiff: number;
    mlPnlDiff: number;
    mlPfDiff: number;
    mlAvgPnlDiff: number;
    winner: 'ml' | 'manual' | 'tie';
  };
}

/**
 * 服务端文件：server/src/routes/paperTrading.ts
 * 接口：GET /api/v1/paper-trading/comparison
 * 返回：ML vs 手动交易对比分析
 */
export async function fetchComparison(): Promise<ComparisonStats> {
  const response = await fetchWithTimeout(`${BASE_URL}/comparison`);
  if (!response.ok) throw new Error('获取对比分析失败');
  const result = await response.json();
  if (!result.success) throw new Error(result.error || '获取对比分析失败');
  return result.data;
}
