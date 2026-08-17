/**
 * 模拟交易执行器
 * 用于验证 ML 推荐效果，对比人工决策
 */

import { getDb } from './database';
import { v4 as uuidv4 } from 'uuid';

export interface PaperTrade {
  id: string;
  varietyCode: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  entryTime: string;
  exitTime?: string;
  status: 'open' | 'closed';
  source: 'ml' | 'manual' | 'portfolio';
  mlConfidence?: number;
  mlPredictedReturn?: string;
  stopLoss?: number;
  takeProfit?: number;
  realizedPnl?: number;
  realizedReturn?: number;
  createdAt: string;
  updatedAt: string;
}

export interface OpenTradeParams {
  varietyCode: string;
  direction: 'long' | 'short';
  entryPrice: number;
  quantity: number;
  source: 'ml' | 'manual' | 'portfolio';
  mlConfidence?: number;
  mlPredictedReturn?: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface CloseTradeParams {
  tradeId: string;
  exitPrice: number;
}

/**
 * 开仓
 */
export async function openPaperTrade(params: OpenTradeParams): Promise<PaperTrade> {
  const db = await getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  const trade: PaperTrade = {
    id,
    varietyCode: params.varietyCode,
    direction: params.direction,
    entryPrice: params.entryPrice,
    quantity: params.quantity,
    entryTime: now,
    status: 'open',
    source: params.source,
    mlConfidence: params.mlConfidence,
    mlPredictedReturn: params.mlPredictedReturn,
    stopLoss: params.stopLoss,
    takeProfit: params.takeProfit,
    createdAt: now,
    updatedAt: now,
  };

  await db.run(
    `INSERT INTO paper_trades (id, variety_code, direction, entry_price, quantity, entry_time, status, source, ml_confidence, ml_predicted_return, stop_loss, take_profit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      trade.id,
      trade.varietyCode,
      trade.direction,
      trade.entryPrice,
      trade.quantity,
      trade.entryTime,
      trade.status,
      trade.source,
      trade.mlConfidence ?? null,
      trade.mlPredictedReturn ?? null,
      trade.stopLoss ?? null,
      trade.takeProfit ?? null,
      trade.createdAt,
      trade.updatedAt,
    ]
  );

  return trade;
}

/**
 * 平仓
 */
export async function closePaperTrade(params: CloseTradeParams): Promise<PaperTrade> {
  const db = await getDb();
  const now = new Date().toISOString();

  const row = await db.queryOne('SELECT * FROM paper_trades WHERE id = ?', [params.tradeId]);
  if (!row) {
    throw new Error(`Trade ${params.tradeId} not found`);
  }
  const trade = rowToTrade(row);

  if (trade.status === 'closed') {
    throw new Error(`Trade ${params.tradeId} already closed`);
  }

  // 计算盈亏
  const priceDiff = trade.direction === 'long'
    ? params.exitPrice - trade.entryPrice
    : trade.entryPrice - params.exitPrice;
  const realizedPnl = priceDiff * trade.quantity;
  const realizedReturn = priceDiff / trade.entryPrice;

  console.log('[PaperTrading] Closing trade:', {
    tradeId: params.tradeId,
    direction: trade.direction,
    entryPrice: trade.entryPrice,
    exitPrice: params.exitPrice,
    priceDiff,
    quantity: trade.quantity,
    realizedPnl,
    realizedReturn,
  });

  const updateSql = `UPDATE paper_trades SET exit_price = ?, exit_time = ?, status = 'closed', realized_pnl = ?, realized_return = ?, updated_at = ? WHERE id = ?`;
  const updateParams = [params.exitPrice, now, realizedPnl, realizedReturn, now, params.tradeId];
  
  console.log('[PaperTrading] UPDATE SQL:', updateSql);
  console.log('[PaperTrading] UPDATE params:', updateParams);
  
  db.run(updateSql, updateParams);
  
  // 验证更新结果
  const updatedTrade = db.queryOne('SELECT realized_pnl, realized_return, exit_price FROM paper_trades WHERE id = ?', [params.tradeId]);
  console.log('[PaperTrading] After UPDATE, trade data:', updatedTrade);

  return {
    ...trade,
    exitPrice: params.exitPrice,
    exitTime: now,
    status: 'closed',
    realizedPnl,
    realizedReturn,
    updatedAt: now,
  };
}

/**
 * 获取所有交易
 */
export async function getPaperTrades(filters?: {
  status?: 'open' | 'closed';
  source?: 'ml' | 'manual' | 'portfolio';
  varietyCode?: string;
  limit?: number;
}): Promise<PaperTrade[]> {
  const db = await getDb();
  let query = 'SELECT * FROM paper_trades WHERE 1=1';
  const params: any[] = [];

  if (filters?.status) {
    query += ' AND status = ?';
    params.push(filters.status);
  }
  if (filters?.source) {
    query += ' AND source = ?';
    params.push(filters.source);
  }
  if (filters?.varietyCode) {
    query += ' AND variety_code = ?';
    params.push(filters.varietyCode);
  }

  query += ' ORDER BY entry_time DESC';
  if (filters?.limit) {
    query += ' LIMIT ?';
    params.push(filters.limit);
  }

  const rows = db.query(query, params) as any[];
  return rows.map(rowToTrade);
}

/**
 * 获取单笔交易
 */
export async function getPaperTrade(id: string): Promise<PaperTrade | null> {
  const db = await getDb();
  const row = await db.queryOne('SELECT * FROM paper_trades WHERE id = ?', [id]) as any;
  return row ? rowToTrade(row) : null;
}

/**
 * 获取绩效统计
 * 返回字段与前端 paper-trading 页面 Performance 接口保持一致（snake_case）
 */
export async function getPaperTradePerformance(): Promise<{
  total_trades: number;
  open_trades: number;
  closed_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_pnl: number;
  total_return: number;
  max_drawdown: number;
  sharpe_ratio: number;
  profit_factor: number;
  win_rate: number;
  avg_win: number;
  avg_loss: number;
  ml_trades: number;
  manual_trades: number;
  ml_pnl: number;
  manual_pnl: number;
}> {
  const db = await getDb();

  const stats = await db.queryOne(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed,
      SUM(CASE WHEN source = 'ml' THEN 1 ELSE 0 END) as ml,
      SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) as manual,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END), 0) as total_pnl,
      COALESCE(SUM(CASE WHEN status = 'closed' AND source = 'ml' THEN realized_pnl ELSE 0 END), 0) as ml_pnl,
      COALESCE(SUM(CASE WHEN status = 'closed' AND source = 'manual' THEN realized_pnl ELSE 0 END), 0) as manual_pnl,
      COALESCE(AVG(CASE WHEN status = 'closed' AND realized_pnl > 0 THEN realized_pnl END), 0) as avg_win,
      COALESCE(AVG(CASE WHEN status = 'closed' AND realized_pnl < 0 THEN realized_pnl END), 0) as avg_loss
    FROM paper_trades
  `) as any;

  const closedTrades = db.query(`
    SELECT realized_pnl, exit_time FROM paper_trades WHERE status = 'closed' ORDER BY exit_time ASC
  `) as any[];

  const winningTrades = closedTrades.filter(t => t.realized_pnl > 0).length;
  const losingTrades = closedTrades.filter(t => t.realized_pnl < 0).length;
  const totalPnl = stats.total_pnl || 0;
  const grossProfit = closedTrades.filter(t => t.realized_pnl > 0).reduce((sum, t) => sum + t.realized_pnl, 0);
  const grossLoss = Math.abs(closedTrades.filter(t => t.realized_pnl < 0).reduce((sum, t) => sum + t.realized_pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const winRate = closedTrades.length > 0 ? winningTrades / closedTrades.length : 0;

  // 基于固定初始资金计算收益率与最大回撤
  const INITIAL_CAPITAL = 100000;
  let maxDrawdown = 0;
  let peak = INITIAL_CAPITAL;
  let cumulative = INITIAL_CAPITAL;
  for (const t of closedTrades) {
    cumulative += t.realized_pnl || 0;
    if (cumulative > peak) {
      peak = cumulative;
    }
    const drawdown = peak > 0 ? (peak - cumulative) / peak : 0;
    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
    }
  }

  const totalReturn = INITIAL_CAPITAL > 0 ? totalPnl / INITIAL_CAPITAL : 0;

  return {
    total_trades: stats.total || 0,
    open_trades: stats.open || 0,
    closed_trades: stats.closed || 0,
    winning_trades: winningTrades,
    losing_trades: losingTrades,
    total_pnl: totalPnl,
    total_return: totalReturn,
    max_drawdown: maxDrawdown,
    sharpe_ratio: 0,
    profit_factor: profitFactor === Infinity ? 0 : profitFactor,
    win_rate: winRate,
    avg_win: stats.avg_win || 0,
    avg_loss: stats.avg_loss || 0,
    ml_trades: stats.ml || 0,
    manual_trades: stats.manual || 0,
    ml_pnl: stats.ml_pnl || 0,
    manual_pnl: stats.manual_pnl || 0,
  };
}

/**
 * 获取 ML vs 人工对比分析
 */
export async function getMLvsManualComparison(): Promise<{
  ml: { trades: number; pnl: number; winRate: number; avgReturn: number };
  manual: { trades: number; pnl: number; winRate: number; avgReturn: number };
  comparison: { pnlDiff: number; winRateDiff: number; mlOutperform: boolean };
}> {
  const db = await getDb();

  const mlStats = await db.queryOne(`
    SELECT
      COUNT(*) as trades,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END), 0) as pnl,
      COALESCE(AVG(CASE WHEN status = 'closed' THEN realized_return ELSE 0 END), 0) as avg_return,
      COALESCE(SUM(CASE WHEN status = 'closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0), 0) as win_rate
    FROM paper_trades WHERE source = 'ml'
  `) as any;

  const manualStats = await db.queryOne(`
    SELECT
      COUNT(*) as trades,
      COALESCE(SUM(CASE WHEN status = 'closed' THEN realized_pnl ELSE 0 END), 0) as pnl,
      COALESCE(AVG(CASE WHEN status = 'closed' THEN realized_return ELSE 0 END), 0) as avg_return,
      COALESCE(SUM(CASE WHEN status = 'closed' AND realized_pnl > 0 THEN 1 ELSE 0 END) * 1.0 / NULLIF(SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END), 0), 0) as win_rate
    FROM paper_trades WHERE source = 'manual'
  `) as any;

  return {
    ml: {
      trades: mlStats.trades || 0,
      pnl: mlStats.pnl || 0,
      winRate: mlStats.win_rate || 0,
      avgReturn: mlStats.avg_return || 0,
    },
    manual: {
      trades: manualStats.trades || 0,
      pnl: manualStats.pnl || 0,
      winRate: manualStats.win_rate || 0,
      avgReturn: manualStats.avg_return || 0,
    },
    comparison: {
      pnlDiff: (mlStats.pnl || 0) - (manualStats.pnl || 0),
      winRateDiff: (mlStats.win_rate || 0) - (manualStats.win_rate || 0),
      mlOutperform: (mlStats.pnl || 0) > (manualStats.pnl || 0),
    },
  };
}

function rowToTrade(row: any): PaperTrade {
  return {
    id: row.id,
    varietyCode: row.variety_code,
    direction: row.direction,
    entryPrice: row.entry_price,
    exitPrice: row.exit_price,
    quantity: row.quantity,
    entryTime: row.entry_time,
    exitTime: row.exit_time,
    status: row.status,
    source: row.source,
    mlConfidence: row.ml_confidence,
    mlPredictedReturn: row.ml_predicted_return,
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    realizedPnl: row.realized_pnl,
    realizedReturn: row.realized_return,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
