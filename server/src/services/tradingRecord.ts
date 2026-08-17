/**
 * 交易记录服务
 * 处理手动交易和模拟交易的CRUD操作
 */

import db from './database.js';

// ============ 类型定义 ============

export interface ManualTrade {
  id?: number;
  variety_code: string;
  variety_name: string;
  contract_month: string;
  direction: 'LONG' | 'SHORT';
  entry_price: number;
  entry_time: string;
  position_size: number;
  exit_price?: number;
  exit_time?: string;
  exit_reason?: string;
  pnl?: number;
  pnl_percent?: number;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  trade_journal?: string;
  entry_reason?: string;
  emotion_state?: string;
  brooks_review?: string;
  review_score?: number;
  review_tags?: string;
  created_at?: string;
  updated_at?: string;
  // Brooks 复盘模板扩展字段
  signal_grade?: string;    // A/B/C/D
  signal_type?: string;     // 信号棒/外包棒/回踩EMA/突破/反转/双底双顶
  ai_direction?: string;    // LONG/SHORT/NEUTRAL
  market_state?: string;    // 趋势/通道/区间/混合
  support_level?: number;
  resistance_level?: number;
  ema20?: number;
  prev_high?: number;
  prev_low?: number;
  price_range_low?: number;
  price_range_high?: number;
  stop_loss?: number;
  target_price?: number;
  gate4_count?: number;
  edge_grade?: string;
  signal_review?: string;   // 信号有效走了/信号失败反转/没走震荡
  pnl_ratio?: number;       // 盈亏比
}

export interface SimulatedTrade {
  id?: number;
  variety_code: string;
  variety_name: string;
  contract_month: string;
  direction: 'LONG' | 'SHORT';
  signal_source?: string;
  resonance_score?: number;
  entry_price: number;
  entry_time: string;
  position_size: number;
  contract_multiplier: number;
  commission?: number;
  slippage?: number;
  exit_price?: number;
  exit_time?: string;
  exit_reason?: string;
  gross_pnl?: number;
  net_pnl?: number;
  stop_loss?: number;
  target_price?: number;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  trade_reason?: string;
  created_at?: string;
  updated_at?: string;
}

export interface SimulatedAccount {
  initial_capital: number;
  current_capital: number;
  risk_percent: number;
  available_capital: number;
  frozen_capital: number;
  total_pnl: number;
  total_commission: number;
  total_slippage: number;
}

// ============ 合约乘数表 ============

export const CONTRACT_MULTIPLIERS: Record<string, number> = {
  // 上期所
  'CU': 5, 'AL': 5, 'ZN': 5, 'PB': 5, 'NI': 1,
  'SN': 1, 'AU': 1000, 'AG': 15, 'RB': 10, 'HC': 10,
  'SS': 15, 'FU': 10, 'BU': 10, 'RU': 10,
  // 大商所
  'C': 10, 'A': 10, 'B': 10, 'M': 10, 'Y': 10,
  'JD': 5, 'JM': 60, 'JG': 60, 'L': 5, 'V': 5,
  'PP': 5, 'EB': 5, 'PG': 5, 'LH': 5,
  // 郑商所
  'SR': 10, 'CF': 10, 'CJ': 5, 'AP': 10, 'JR': 20,
  'OI': 10, 'RM': 10, 'MA': 10, 'FG': 20, 'SF': 10,
  'SM': 10, 'TA': 10, 'CS': 10, 'P': 10, 'RS': 10,
  // 中金所
  'IF': 300, 'IC': 200, 'IH': 300, 'IM': 200, 'T': 10000,
  'TF': 20000, 'TH': 10000,
  // 上期能源
  'SC': 1000, 'LU': 10,
  // 广期所
  'SI': 30, 'LC': 5,
};

// ============ 手续费配置（华西期货标准）============

export const COMMISSION_RATES: Record<string, { rate: number; fixed: number }> = {
  'default': { rate: 0.0001, fixed: 0 },
  'IF': { rate: 0.000023, fixed: 0 },
  'IC': { rate: 0.000023, fixed: 0 },
  'IH': { rate: 0.000023, fixed: 0 },
  'IM': { rate: 0.000023, fixed: 0 },
  'CU': { rate: 0, fixed: 10 },
  'AL': { rate: 0, fixed: 3 },
  'ZN': { rate: 0, fixed: 3 },
  'PB': { rate: 0, fixed: 3 },
  'NI': { rate: 0, fixed: 3 },
  'SN': { rate: 0, fixed: 3 },
  'AU': { rate: 0, fixed: 10 },
  'AG': { rate: 0.00005, fixed: 0 },
  'RB': { rate: 0.0001, fixed: 0 },
  'HC': { rate: 0.0001, fixed: 0 },
  'SS': { rate: 0, fixed: 3 },
  'FU': { rate: 0, fixed: 3 },
  'BU': { rate: 0, fixed: 3 },
  'RU': { rate: 0, fixed: 3 },
  'C': { rate: 0, fixed: 1.2 },
  'A': { rate: 0, fixed: 2 },
  'B': { rate: 0, fixed: 1 },
  'M': { rate: 0, fixed: 1.5 },
  'Y': { rate: 0, fixed: 2.5 },
  'P': { rate: 0, fixed: 2.5 },
  'O': { rate: 0, fixed: 2 },
  'JD': { rate: 0.00015, fixed: 0 },
  'L': { rate: 0, fixed: 1 },
  'V': { rate: 0, fixed: 1 },
  'PP': { rate: 0, fixed: 1 },
  'J': { rate: 0.0001, fixed: 0 },
  'JM': { rate: 0.0001, fixed: 0 },
  'I': { rate: 0.0001, fixed: 0 },
  'EG': { rate: 0, fixed: 3 },
  'PG': { rate: 0, fixed: 6 },
  'EB': { rate: 0.0001, fixed: 0 },
  'LH': { rate: 0.0001, fixed: 0 },
  'SR': { rate: 0, fixed: 3 },
  'CF': { rate: 0, fixed: 4.3 },
  'CJ': { rate: 0, fixed: 3 },
  'AP': { rate: 0, fixed: 20 },
  'JR': { rate: 0, fixed: 3 },
  'RM': { rate: 0, fixed: 2 },
  'MA': { rate: 0, fixed: 2 },
  'FG': { rate: 0, fixed: 3 },
  'SF': { rate: 0, fixed: 3 },
  'SM': { rate: 0, fixed: 3 },
  'TA': { rate: 0, fixed: 3 },
  'OI': { rate: 0, fixed: 2 },
  'CS': { rate: 0, fixed: 1.5 },
  'SC': { rate: 0, fixed: 20 },
  'LU': { rate: 0, fixed: 3 },
  'NR': { rate: 0, fixed: 3 },
  'BC': { rate: 0, fixed: 10 },
  'SI': { rate: 0, fixed: 3 },
  'LC': { rate: 0, fixed: 3 },
};

// ============ 滑点配置 ============

export const SLIPPAGE_TICKS: Record<string, number> = {
  'default': 1,
  'IF': 1, 'IC': 1, 'IH': 1, 'IM': 1,
  'CU': 10, 'AL': 5, 'ZN': 5, 'PB': 5, 'NI': 10, 'SN': 10,
  'AU': 0.02, 'AG': 1, 'RB': 1, 'HC': 1, 'FU': 1, 'BU': 2, 'RU': 5, 'SC': 0.1,
};

// ============ 初始化交易表 ============

export function initTradingTables() {
  db.exec(`
    -- 手动交易记录表
    CREATE TABLE IF NOT EXISTS manual_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variety_code TEXT NOT NULL,
      variety_name TEXT NOT NULL,
      contract_month TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      entry_price REAL NOT NULL,
      entry_time TEXT NOT NULL,
      position_size INTEGER NOT NULL,
      exit_price REAL,
      exit_time TEXT,
      exit_reason TEXT,
      pnl REAL,
      pnl_percent REAL,
      status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
      trade_journal TEXT,
      entry_reason TEXT,
      emotion_state TEXT,
      brooks_review TEXT,
      review_score INTEGER CHECK (review_score >= 1 AND review_score <= 10),
      review_tags TEXT,
      signal_grade TEXT,
      signal_type TEXT,
      ai_direction TEXT,
      market_state TEXT,
      support_level REAL,
      resistance_level REAL,
      ema20 REAL,
      prev_high REAL,
      prev_low REAL,
      price_range_low REAL,
      price_range_high REAL,
      stop_loss REAL,
      target_price REAL,
      gate4_count INTEGER,
      edge_grade TEXT,
      signal_review TEXT,
      pnl_ratio REAL,
      exit_notes TEXT,
      lessons TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 旧表结构迁移：为已存在的 manual_trades 表补充缺失列
  const manualTradeNewCols: Array<[string, string]> = [
    ['signal_grade', 'TEXT'], ['signal_type', 'TEXT'], ['ai_direction', 'TEXT'],
    ['market_state', 'TEXT'], ['support_level', 'REAL'], ['resistance_level', 'REAL'],
    ['ema20', 'REAL'], ['prev_high', 'REAL'], ['prev_low', 'REAL'],
    ['price_range_low', 'REAL'], ['price_range_high', 'REAL'], ['stop_loss', 'REAL'],
    ['target_price', 'REAL'], ['gate4_count', 'INTEGER'], ['edge_grade', 'TEXT'],
    ['signal_review', 'TEXT'], ['pnl_ratio', 'REAL'], ['exit_notes', 'TEXT'], ['lessons', 'TEXT'],
  ];
  const existingCols = (db.query("PRAGMA table_info(manual_trades)") as Array<{ name: string }>).map(c => c.name);
  for (const [col, type] of manualTradeNewCols) {
    if (!existingCols.includes(col)) {
      db.exec(`ALTER TABLE manual_trades ADD COLUMN ${col} ${type}`);
    }
  }

  db.exec(`
    -- 模拟交易记录表
    CREATE TABLE IF NOT EXISTS simulated_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      variety_code TEXT NOT NULL,
      variety_name TEXT NOT NULL,
      contract_month TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('LONG', 'SHORT')),
      signal_source TEXT,
      resonance_score INTEGER,
      entry_price REAL NOT NULL,
      entry_time TEXT NOT NULL,
      position_size INTEGER NOT NULL,
      contract_multiplier REAL NOT NULL,
      commission REAL DEFAULT 0,
      slippage REAL DEFAULT 0,
      exit_price REAL,
      exit_time TEXT,
      exit_reason TEXT,
      gross_pnl REAL,
      net_pnl REAL,
      stop_loss REAL,
      target_price REAL,
      status TEXT DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED', 'CANCELLED')),
      trade_reason TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  db.exec(`
    -- 模拟账户表
    CREATE TABLE IF NOT EXISTS simulated_account (
      id INTEGER PRIMARY KEY DEFAULT 1,
      initial_capital REAL DEFAULT 200000.00,
      current_capital REAL DEFAULT 200000.00,
      risk_percent REAL DEFAULT 2.00,
      available_capital REAL DEFAULT 200000.00,
      frozen_capital REAL DEFAULT 0,
      total_pnl REAL DEFAULT 0,
      total_commission REAL DEFAULT 0,
      total_slippage REAL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now', 'localtime'))
    )
  `);

  // 初始化模拟账户
  const account = db.queryOne('SELECT id FROM simulated_account WHERE id = 1');
  if (!account) {
    db.run(`
      INSERT INTO simulated_account (id, initial_capital, current_capital, available_capital)
      VALUES (1, 200000.00, 200000.00, 200000.00)
    `);
  }

  // ── manual_trades 扩展字段迁移（Brooks 复盘模板） ──
  const tradeCols = (db.query("PRAGMA table_info(manual_trades)") as Array<{ name: string }>).map((c) => c.name);
  const addTradeCol = (name: string, ddl: string) => {
    if (!tradeCols.includes(name)) {
      db.exec(`ALTER TABLE manual_trades ADD COLUMN ${name} ${ddl}`);
    }
  };
  addTradeCol('signal_grade', 'TEXT');
  addTradeCol('signal_type', 'TEXT');
  addTradeCol('ai_direction', 'TEXT');
  addTradeCol('market_state', 'TEXT');
  addTradeCol('support_level', 'REAL');
  addTradeCol('resistance_level', 'REAL');
  addTradeCol('ema20', 'REAL');
  addTradeCol('prev_high', 'REAL');
  addTradeCol('prev_low', 'REAL');
  addTradeCol('price_range_low', 'REAL');
  addTradeCol('price_range_high', 'REAL');
  addTradeCol('stop_loss', 'REAL');
  addTradeCol('target_price', 'REAL');
  addTradeCol('gate4_count', 'INTEGER');
  addTradeCol('edge_grade', 'TEXT');
  addTradeCol('signal_review', 'TEXT');
  addTradeCol('pnl_ratio', 'REAL');

  // ── 每日复盘表（Brooks V16.2 完整复盘模板）──
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_date TEXT NOT NULL UNIQUE,
      -- 三态识别
      premarket_state TEXT,
      market_state_actual TEXT,
      state_correct BOOLEAN,
      -- 铁律检查（JSON）
      iron_rules_check TEXT,
      -- 信号统计
      total_signals INTEGER DEFAULT 0,
      a_level_signals INTEGER DEFAULT 0,
      b_level_signals INTEGER DEFAULT 0,
      c_level_signals INTEGER DEFAULT 0,
      entered_signals INTEGER DEFAULT 0,
      missed_signals INTEGER DEFAULT 0,
      -- 反思
      what_went_well TEXT,
      what_went_poorly TEXT,
      key_lesson TEXT,
      new_pa_pattern TEXT,
      emotional_state TEXT,
      -- 明日计划（JSON 数组，品种级：[{variety_code,variety_name,direction,breakout_long,breakdown_short,range_low,range_high,notes}]）
      tomorrow_plans TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_reviews_date ON daily_reviews(review_date)`);

  // 品种级复盘表：三态识别/信号/关键位/反思均按品种记录（期货复盘针对具体品种，非指数大势）
  db.exec(`
    CREATE TABLE IF NOT EXISTS variety_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      review_date TEXT NOT NULL,
      variety_code TEXT NOT NULL,
      variety_name TEXT NOT NULL,
      -- 三态识别（品种级）
      premarket_state TEXT,
      market_state_actual TEXT,
      state_correct INTEGER,
      ai_direction TEXT,
      -- 信号记录
      signal_grade TEXT,
      signal_notes TEXT,
      -- 关键位快照（JSON）
      key_levels TEXT,
      -- 单品种反思
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(review_date, variety_code)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_variety_reviews_date ON variety_reviews(review_date)`);

  // 已有数据库自动补列迁移
  const drCols = (db.query("PRAGMA table_info(daily_reviews)") as Array<{ name: string }>).map(c => c.name);
  if (!drCols.includes('tomorrow_plans')) {
    db.exec('ALTER TABLE daily_reviews ADD COLUMN tomorrow_plans TEXT');
  }
}

// ============ 手动交易服务 ============

export function createManualTrade(trade: ManualTrade): ManualTrade {
  db.run(`
    INSERT INTO manual_trades (
      variety_code, variety_name, contract_month, direction,
      entry_price, entry_time, position_size,
      status, trade_journal, entry_reason, emotion_state,
      signal_grade, signal_type, ai_direction, market_state,
      support_level, resistance_level, ema20, prev_high, prev_low,
      price_range_low, price_range_high, stop_loss, target_price,
      gate4_count, edge_grade
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    trade.variety_code,
    trade.variety_name,
    trade.contract_month || '',
    trade.direction,
    trade.entry_price,
    trade.entry_time,
    trade.position_size,
    trade.status || 'OPEN',
    trade.trade_journal,
    trade.entry_reason,
    trade.emotion_state,
    trade.signal_grade, trade.signal_type, trade.ai_direction, trade.market_state,
    trade.support_level, trade.resistance_level, trade.ema20, trade.prev_high, trade.prev_low,
    trade.price_range_low, trade.price_range_high, trade.stop_loss, trade.target_price,
    trade.gate4_count, trade.edge_grade
  ]);
  
  const lastRow = db.queryOne('SELECT last_insert_rowid() as id');
  return getManualTradeById(lastRow?.id)!;
}

export function getManualTrades(status?: string): ManualTrade[] {
  let query = 'SELECT * FROM manual_trades';
  const params: any[] = [];
  
  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY entry_time DESC';
  
  const stmt = db.prepare(query);
  return stmt.all(...params) as ManualTrade[];
}

export function getManualTradeById(id: number): ManualTrade | null {
  const stmt = db.prepare('SELECT * FROM manual_trades WHERE id = ?');
  return (stmt.get(id) as ManualTrade) || null;
}

export function closeManualTrade(
  id: number,
  exitPrice: number,
  exitTime: string,
  exitReason?: string,
  signalReview?: string,
  exitNotes?: string,
  lessons?: string
): ManualTrade | null {
  const trade = getManualTradeById(id);
  if (!trade) return null;

  const variety = trade.variety_code.replace(/[0-9]/g, '').toUpperCase();
  const contractMultiplier = CONTRACT_MULTIPLIERS[variety] || 10;

  let pnl = 0;
  if (trade.direction === 'LONG') {
    pnl = (exitPrice - trade.entry_price) * trade.position_size * contractMultiplier;
  } else {
    pnl = (trade.entry_price - exitPrice) * trade.position_size * contractMultiplier;
  }

  const pnlPercent = (pnl / (trade.entry_price * trade.position_size * contractMultiplier)) * 100;

  const risk = Math.abs(trade.entry_price - (trade.stop_loss || trade.entry_price)) * trade.position_size * contractMultiplier;
  const pnlRatio = risk > 0 ? pnl / risk : 0;

  db.prepare(`
    UPDATE manual_trades
    SET exit_price = ?, exit_time = ?, exit_reason = ?,
        pnl = ?, pnl_percent = ?, pnl_ratio = ?, signal_review = ?,
        exit_notes = ?, lessons = ?,
        status = 'CLOSED', updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(exitPrice, exitTime, exitReason, pnl, pnlPercent, pnlRatio, signalReview, exitNotes || null, lessons || null, id);

  return getManualTradeById(id);
}

export function addBrooksReview(
  id: number,
  review: string,
  score: number,
  tags: string[]
): ManualTrade | null {
  db.prepare(`
    UPDATE manual_trades 
    SET brooks_review = ?, review_score = ?, review_tags = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(review, score, tags.join(','), id);
  
  return getManualTradeById(id);
}

export function deleteManualTrade(id: number): boolean {
  // Check if the trade exists first
  const trade = getManualTradeById(id);
  if (!trade) return false;
  
  db.run('DELETE FROM manual_trades WHERE id = ?', [id]);
  return true;
}

// ============ 模拟交易服务 ============

export function getSimulatedAccount(): SimulatedAccount {
  const stmt = db.prepare('SELECT * FROM simulated_account WHERE id = 1');
  return stmt.get() as SimulatedAccount;
}

export function updateSimulatedCapital(currentCapital: number): SimulatedAccount {
  const account = getSimulatedAccount();
  const pnl = currentCapital - account.initial_capital;
  
  db.prepare(`
    UPDATE simulated_account 
    SET current_capital = ?, available_capital = ? - frozen_capital,
        total_pnl = ?, updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `).run(currentCapital, currentCapital, pnl);
  
  return getSimulatedAccount();
}

export function calculateCommission(
  varietyCode: string,
  price: number,
  positionSize: number,
  contractMultiplier: number
): number {
  const variety = varietyCode.replace(/[0-9]/g, '').toUpperCase();
  const config = COMMISSION_RATES[variety] || COMMISSION_RATES['default'];
  
  if (config.fixed > 0) {
    return config.fixed * positionSize;
  }
  
  const tradeValue = price * positionSize * contractMultiplier;
  return tradeValue * config.rate;
}

export function calculateSlippage(
  varietyCode: string,
  positionSize: number,
  contractMultiplier: number
): number {
  const variety = varietyCode.replace(/[0-9]/g, '').toUpperCase();
  const ticks = SLIPPAGE_TICKS[variety] || SLIPPAGE_TICKS['default'];
  
  return ticks * positionSize * contractMultiplier;
}

export function calculateMaxPosition(
  capital: number,
  riskPercent: number,
  entryPrice: number,
  stopLoss: number,
  contractMultiplier: number
): number {
  const riskAmount = capital * (riskPercent / 100);
  const riskPerUnit = Math.abs(entryPrice - stopLoss);
  
  if (riskPerUnit === 0) return 1;
  
  const maxPosition = Math.floor(riskAmount / (riskPerUnit * contractMultiplier));
  return Math.max(1, maxPosition);
}

export function createSimulatedTrade(trade: SimulatedTrade): SimulatedTrade {
  const commission = calculateCommission(
    trade.variety_code,
    trade.entry_price,
    trade.position_size,
    trade.contract_multiplier
  );
  
  const slippage = calculateSlippage(
    trade.variety_code,
    trade.position_size,
    trade.contract_multiplier
  ) * 2;
  
  const account = getSimulatedAccount();
  const frozenAmount = trade.entry_price * trade.position_size * trade.contract_multiplier * 0.1;
  
  db.run(`
    INSERT INTO simulated_trades (
      variety_code, variety_name, contract_month, direction,
      signal_source, resonance_score,
      entry_price, entry_time, position_size, contract_multiplier,
      commission, slippage, stop_loss, target_price,
      status, trade_reason
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    trade.variety_code,
    trade.variety_name,
    trade.contract_month,
    trade.direction,
    trade.signal_source,
    trade.resonance_score,
    trade.entry_price,
    trade.entry_time,
    trade.position_size,
    trade.contract_multiplier,
    commission,
    slippage,
    trade.stop_loss,
    trade.target_price,
    trade.status || 'OPEN',
    trade.trade_reason
  ]);
  
  // 更新账户冻结资金
  db.run(`
    UPDATE simulated_account 
    SET frozen_capital = frozen_capital + ?, 
        available_capital = available_capital - ?,
        total_commission = total_commission + ?,
        total_slippage = total_slippage + ?,
        updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `, [frozenAmount, frozenAmount, commission, slippage]);
  
  // Get the last inserted ID
  const lastId = db.prepare('SELECT last_insert_rowid() as id').get() as { id: number };
  return getSimulatedTradeById(lastId.id)!;
}

export function getSimulatedTrades(status?: string): SimulatedTrade[] {
  let query = 'SELECT * FROM simulated_trades';
  const params: any[] = [];
  
  if (status) {
    query += ' WHERE status = ?';
    params.push(status);
  }
  
  query += ' ORDER BY entry_time DESC';
  
  const stmt = db.prepare(query);
  return stmt.all(...params) as SimulatedTrade[];
}

export function getSimulatedTradeById(id: number): SimulatedTrade | null {
  const stmt = db.prepare('SELECT * FROM simulated_trades WHERE id = ?');
  return (stmt.get(id) as SimulatedTrade) || null;
}

export function closeSimulatedTrade(
  id: number,
  exitPrice: number,
  exitTime: string,
  exitReason?: string
): SimulatedTrade | null {
  const trade = getSimulatedTradeById(id);
  if (!trade) return null;
  
  let grossPnl = 0;
  if (trade.direction === 'LONG') {
    grossPnl = (exitPrice - trade.entry_price) * trade.position_size * trade.contract_multiplier;
  } else {
    grossPnl = (trade.entry_price - exitPrice) * trade.position_size * trade.contract_multiplier;
  }
  
  const exitSlippage = calculateSlippage(
    trade.variety_code,
    trade.position_size,
    trade.contract_multiplier
  );
  
  const exitCommission = calculateCommission(
    trade.variety_code,
    exitPrice,
    trade.position_size,
    trade.contract_multiplier
  );
  
  const netPnl = grossPnl - ((trade.commission || 0) + exitCommission) - ((trade.slippage || 0) + exitSlippage);
  
  const frozenAmount = trade.entry_price * trade.position_size * trade.contract_multiplier * 0.1;
  
  db.prepare(`
    UPDATE simulated_trades 
    SET exit_price = ?, exit_time = ?, exit_reason = ?,
        gross_pnl = ?, net_pnl = ?, 
        commission = commission + ?, slippage = slippage + ?,
        status = 'CLOSED', updated_at = datetime('now', 'localtime')
    WHERE id = ?
  `).run(exitPrice, exitTime, exitReason, grossPnl, netPnl, exitCommission, exitSlippage, id);
  
  // 更新账户
  db.prepare(`
    UPDATE simulated_account 
    SET frozen_capital = frozen_capital - ?,
        current_capital = current_capital + ?,
        available_capital = available_capital + ? - ?,
        total_pnl = total_pnl + ?,
        total_commission = total_commission + ?,
        total_slippage = total_slippage + ?,
        updated_at = datetime('now', 'localtime')
    WHERE id = 1
  `).run(frozenAmount, netPnl, netPnl, frozenAmount, netPnl, exitCommission, exitSlippage);
  
  return getSimulatedTradeById(id);
}

export function deleteSimulatedTrade(id: number): boolean {
  // Check if the trade exists first
  const trade = getSimulatedTradeById(id);
  if (!trade) return false;
  
  db.run('DELETE FROM simulated_trades WHERE id = ?', [id]);
  return true;
}

// ============ Brooks点评生成 ============

export function generateBrooksReview(trade: ManualTrade): string {
  const reviews: string[] = [];
  
  if (trade.entry_reason) {
    reviews.push('【入场分析】');
    reviews.push(`交易理由：${trade.entry_reason}`);
    
    const hasTrend = trade.entry_reason.includes('趋势') || trade.entry_reason.includes('突破');
    const hasPullback = trade.entry_reason.includes('回调') || trade.entry_reason.includes('回踩');
    const hasSignal = trade.entry_reason.includes('信号') || trade.entry_reason.includes('共振');
    
    if (hasTrend && hasPullback) {
      reviews.push('✓ 入场时机良好：趋势中等待回调入场符合Brooks原则');
    } else if (hasSignal) {
      reviews.push('△ 信号入场：需确认信号强度与背景趋势是否一致');
    } else {
      reviews.push('✗ 入场理由不够充分：建议等待更明确的趋势信号');
    }
  }
  
  if (trade.emotion_state) {
    reviews.push('\n【情绪状态】');
    reviews.push(`交易时情绪：${trade.emotion_state}`);
    
    const negativeEmotions = ['恐惧', '焦虑', '贪婪', '急躁', '报复'];
    const hasNegativeEmotion = negativeEmotions.some(e => trade.emotion_state!.includes(e));
    
    if (hasNegativeEmotion) {
      reviews.push('⚠️ 检测到负面情绪：建议暂停交易，等待情绪稳定后再入场');
    } else {
      reviews.push('✓ 情绪状态相对稳定');
    }
  }
  
  if (trade.pnl !== undefined && trade.pnl !== null) {
    reviews.push('\n【结果评估】');
    reviews.push(`盈亏：${trade.pnl > 0 ? '+' : ''}${trade.pnl.toFixed(2)}元 (${trade.pnl_percent?.toFixed(2)}%)`);
    
    if (trade.pnl > 0) {
      reviews.push('✓ 交易盈利');
      if (trade.pnl_percent && trade.pnl_percent > 5) {
        reviews.push('✓ 盈利幅度良好，持仓耐心值得肯定');
      }
    } else {
      reviews.push('✗ 交易亏损');
      if (trade.pnl_percent && trade.pnl_percent < -2) {
        reviews.push('⚠️ 亏损幅度较大，需检查止损设置是否合理');
      }
    }
  }
  
  if (trade.trade_journal) {
    reviews.push('\n【交易日志】');
    reviews.push(trade.trade_journal);
  }
  
  reviews.push('\n【综合建议】');
  reviews.push('请根据以上分析，对本次交易进行1-10分的评分：');
  reviews.push('9-10分：完美执行Brooks原则');
  reviews.push('7-8分：基本符合原则，有小瑕疵');
  reviews.push('5-6分：入场时机或理由有待改进');
  reviews.push('3-4分：明显违反交易原则');
  reviews.push('1-2分：严重错误，需深刻反思');
  
  return reviews.join('\n');
}

// ============ 每日复盘服务 ============


// ============ 每日复盘服务 ============

export interface DailyReview {
  id?: number;
  review_date: string;
  premarket_state?: string;
  market_state_actual?: string;
  state_correct?: boolean;
  iron_rules_check?: string;
  total_signals?: number;
  a_level_signals?: number;
  b_level_signals?: number;
  c_level_signals?: number;
  entered_signals?: number;
  missed_signals?: number;
  what_went_well?: string;
  what_went_poorly?: string;
  key_lesson?: string;
  new_pa_pattern?: string;
  emotional_state?: string;
  tomorrow_plans?: string;
  created_at?: string;
  updated_at?: string;
}

const DAILY_REVIEW_FIELDS: (keyof DailyReview)[] = [
  "review_date", "premarket_state", "market_state_actual", "state_correct",
  "iron_rules_check", "total_signals", "a_level_signals", "b_level_signals",
  "c_level_signals", "entered_signals", "missed_signals", "what_went_well",
  "what_went_poorly", "key_lesson", "new_pa_pattern", "emotional_state",
  "tomorrow_plans",
];

export function upsertDailyReview(review: Partial<DailyReview>): DailyReview {
  const now = new Date().toISOString();
  const existing = getDailyReviewByDate(review.review_date!);

  if (existing) {
    const keys = DAILY_REVIEW_FIELDS.filter(
      (k) => review[k] !== undefined && k !== "review_date"
    );
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const values = keys.map((k) => {
        const v = review[k];
        return typeof v === "boolean" ? (v ? 1 : 0) : v;
      });
      db.prepare(`UPDATE daily_reviews SET ${sets}, updated_at = ? WHERE review_date = ?`)
        .run(...values, now, review.review_date!);
    }
    return getDailyReviewByDate(review.review_date!)!;
  }

  const keys = DAILY_REVIEW_FIELDS.filter((k) => review[k] !== undefined);
  const cols = [...keys, "created_at", "updated_at"];
  const placeholders = cols.map(() => "?").join(", ");
  const values = keys.map((k) => {
    const v = review[k];
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  values.push(now, now);

  const result = db.prepare(
    `INSERT INTO daily_reviews (${cols.join(", ")}) VALUES (${placeholders})`
  ).run(...values);

  return getDailyReviewByDate(review.review_date!)!;
}

export function getDailyReviewByDate(date: string): DailyReview | null {
  const row = db.queryOne("SELECT * FROM daily_reviews WHERE review_date = ?", [date]);
  return row ? (row as unknown as DailyReview) : null;
}

export function getDailyReviews(limit = 30): DailyReview[] {
  const rows = db.query(
    "SELECT * FROM daily_reviews ORDER BY review_date DESC LIMIT ?",
    [limit]
  );
  return rows as unknown as DailyReview[];
}

// ============ 品种级复盘服务 ============

export interface VarietyReview {
  id?: number;
  review_date: string;
  variety_code: string;
  variety_name: string;
  premarket_state?: string;
  market_state_actual?: string;
  state_correct?: boolean;
  ai_direction?: string;
  signal_grade?: string;
  signal_notes?: string;
  key_levels?: string;
  notes?: string;
  created_at?: string;
  updated_at?: string;
}

const VARIETY_REVIEW_FIELDS: (keyof VarietyReview)[] = [
  "review_date", "variety_code", "variety_name", "premarket_state",
  "market_state_actual", "state_correct", "ai_direction", "signal_grade",
  "signal_notes", "key_levels", "notes",
];

export function upsertVarietyReview(review: Partial<VarietyReview>): VarietyReview {
  const now = new Date().toISOString();
  const existing = db.queryOne(
    "SELECT * FROM variety_reviews WHERE review_date = ? AND variety_code = ?",
    [review.review_date!, review.variety_code!]
  );

  if (existing) {
    const keys = VARIETY_REVIEW_FIELDS.filter(
      (k) => review[k] !== undefined && k !== "review_date" && k !== "variety_code"
    );
    if (keys.length > 0) {
      const sets = keys.map((k) => `${k} = ?`).join(", ");
      const values = keys.map((k) => {
        const v = review[k];
        return typeof v === "boolean" ? (v ? 1 : 0) : v;
      });
      db.prepare(
        "UPDATE variety_reviews SET " + sets + ", updated_at = ? WHERE review_date = ? AND variety_code = ?"
      ).run(...values, now, review.review_date!, review.variety_code!);
    }
    return db.queryOne(
      "SELECT * FROM variety_reviews WHERE review_date = ? AND variety_code = ?",
      [review.review_date!, review.variety_code!]
    ) as unknown as VarietyReview;
  }

  const keys = VARIETY_REVIEW_FIELDS.filter((k) => review[k] !== undefined);
  const cols = [...keys, "created_at", "updated_at"];
  const placeholders = cols.map(() => "?").join(", ");
  const values = keys.map((k) => {
    const v = review[k];
    return typeof v === "boolean" ? (v ? 1 : 0) : v;
  });
  values.push(now, now);

  db.prepare(
    `INSERT INTO variety_reviews (${cols.join(", ")}) VALUES (${placeholders})`
  ).run(...values);

  return db.queryOne(
    "SELECT * FROM variety_reviews WHERE review_date = ? AND variety_code = ?",
    [review.review_date!, review.variety_code!]
  ) as unknown as VarietyReview;
}

export function getVarietyReviewsByDate(date: string): VarietyReview[] {
  const rows = db.query(
    "SELECT * FROM variety_reviews WHERE review_date = ? ORDER BY id ASC",
    [date]
  );
  return rows as unknown as VarietyReview[];
}

export function deleteVarietyReview(date: string, varietyCode: string): boolean {
  const before = db.queryOne(
    "SELECT id FROM variety_reviews WHERE review_date = ? AND variety_code = ?",
    [date, varietyCode]
  );
  if (!before) return false;
  db.run(
    "DELETE FROM variety_reviews WHERE review_date = ? AND variety_code = ?",
    [date, varietyCode]
  );
  return true;
}

// ==================== 账户纪律阶梯 ====================

/** 账户纪律阶梯状态（Brooks 亏损降级机制） */
export interface AccountDiscipline {
  level: number; // 0-4 级
  consecutive_losses: number; // 当前连续亏损笔数
  recent_results: Array<"win" | "loss">; // 最近10笔结果（新→旧）
}

/**
 * 基于已平仓交易记录计算账户纪律阶梯等级。
 * 规则（Brooks 手册）：按平仓时间倒序统计连续亏损笔数：
 * 0笔→L0 正常交易；1笔→L1 警告；2笔→L2 仓位减半；
 * 3笔→L3 当日停止开新仓；4笔及以上→L4 停止交易强制复盘。
 */
export function getAccountDiscipline(): AccountDiscipline {
  const rows = db.query(
    `SELECT pnl FROM manual_trades
     WHERE status = 'CLOSED' AND pnl IS NOT NULL
     ORDER BY COALESCE(exit_time, updated_at) DESC
     LIMIT 10`
  ) as Array<{ pnl: number | null }>;

  let consecutive = 0;
  for (const r of rows) {
    if ((r.pnl ?? 0) < 0) consecutive++;
    else break;
  }

  return {
    level: Math.min(consecutive, 4),
    consecutive_losses: consecutive,
    recent_results: rows.map((r) => ((r.pnl ?? 0) < 0 ? "loss" : "win")),
  };
}
