import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { join, dirname } from 'path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'fs';
import { fileURLToPath } from 'url';

// 数据库路径（使用 /tmp 确保在任何环境都可写）
// veFaaS 云函数环境文件系统只读，只有 /tmp 可写
const DB_DIR = '/tmp/data';
const DB_PATH = join(DB_DIR, 'brooks_signals.db');

// 持久化备份路径（部署目录，重启不丢失；/tmp 为运行时缓存）
// 写入 /tmp 的同时备份一份到 server/data，启动时优先从备份恢复，避免重启丢数据
const __dirname = dirname(fileURLToPath(import.meta.url));
// 兼容开发（src/services → ../../data）与生产（dist → ../data）两种目录结构
const PERSIST_DIR = [
  join(__dirname, '../../data'),
  join(__dirname, '../data'),
].find((p) => existsSync(p)) ?? join(__dirname, '../data');
const PERSIST_PATH = join(PERSIST_DIR, 'brooks_signals.db');

// 备份失败静默降级（只读环境无妨），成功则数据持久化
function backupToPersistDir(): void {
  try {
    if (!existsSync(PERSIST_DIR)) {
      mkdirSync(PERSIST_DIR, { recursive: true });
    }
    copyFileSync(DB_PATH, PERSIST_PATH);
  } catch {
    // 只读环境忽略
  }
}

// 启动时优先从持久化备份恢复（若 /tmp 无库或为空，但 server/data 有备份）
function restoreFromPersistIfNeeded(): void {
  try {
    if (!existsSync(DB_PATH) && existsSync(PERSIST_PATH)) {
      if (!existsSync(DB_DIR)) {
        mkdirSync(DB_DIR, { recursive: true });
      }
      copyFileSync(PERSIST_PATH, DB_PATH);
    }
  } catch {
    // 忽略恢复失败
  }
}

// 检查文件系统是否可写

// Wrapper class（sql.js 纯 JS 引擎，无原生依赖，兼容任意 Node.js 版本）
class DatabaseWrapper {
  private db!: SqlJsDatabase;
  private initPromise: Promise<void>;
  private isReady = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    if (!existsSync(DB_DIR)) {
      mkdirSync(DB_DIR, { recursive: true });
    }
    // 优先从持久化备份恢复（/tmp 被清空时）
    restoreFromPersistIfNeeded();
    this.initPromise = this.init();
  }

  private async init(): Promise<void> {
    const SQL = await initSqlJs();

    // 加载已有数据库或创建新数据库
    if (existsSync(DB_PATH)) {
      try {
        const buffer = readFileSync(DB_PATH);
        this.db = new SQL.Database(buffer);
      } catch {
        this.db = new SQL.Database();
      }
    } else {
      this.db = new SQL.Database();
    }

    // 创建表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_time TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        contract TEXT,
        close REAL,
        change_pct REAL,
        spectrum TEXT,
        ai_direction TEXT,
        ai_streak INTEGER,
        ai_flip INTEGER,
        trend_strength INTEGER,
        breakout_score INTEGER,
        breakout_label TEXT,
        signal_level TEXT,
        signals TEXT,
        signal_strength_score REAL,
        adx REAL,
        atr REAL,
        ema_dev_pct REAL,
        volume_ratio REAL,
        mtr_detected INTEGER,
        climax_detected INTEGER,
        final_flag INTEGER,
        wedge_detected INTEGER,
        trap_type TEXT,
        barbwire INTEGER,
        oversold_score INTEGER,
        oversold_signal TEXT,
        consec_down_days INTEGER,
        dev_ma20 REAL,
        verified INTEGER DEFAULT 0,
        verify_time TEXT,
        verify_result TEXT,
        price_at_verify REAL,
        price_change_after REAL,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trend_tracking (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        signal_type TEXT NOT NULL,
        signal_direction TEXT NOT NULL,
        start_time TEXT NOT NULL,
        start_price REAL NOT NULL,
        start_scan_time TEXT NOT NULL,
        last_update_time TEXT NOT NULL,
        last_price REAL,
        last_ai_direction TEXT,
        last_trend_strength INTEGER,
        duration_days INTEGER DEFAULT 0,
        max_favorable_excursion REAL DEFAULT 0,
        max_adverse_excursion REAL DEFAULT 0,
        status TEXT DEFAULT 'active',
        end_time TEXT,
        end_price REAL,
        result TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(code, signal_type, start_time)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS variety_performance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,
        win_rate REAL DEFAULT 0,
        avg_pnl REAL DEFAULT 0,
        profit_factor REAL DEFAULT 0,
        max_consecutive_wins INTEGER DEFAULT 0,
        max_consecutive_losses INTEGER DEFAULT 0,
        adaptability_score REAL DEFAULT 50,
        last_updated TEXT DEFAULT (datetime('now', 'localtime')),
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS capital_flow_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        top5_volume INTEGER DEFAULT 0,
        top5_volume_ratio REAL DEFAULT 0,
        top5_volume_change INTEGER DEFAULT 0,
        top5_long INTEGER DEFAULT 0,
        top5_short INTEGER DEFAULT 0,
        net_position INTEGER DEFAULT 0,
        net_position_change INTEGER DEFAULT 0,
        concentration_index REAL DEFAULT 0,
        smart_money_direction TEXT,
        smart_money_confidence INTEGER DEFAULT 0,
        signal_type TEXT,
        signal_confidence INTEGER DEFAULT 0,
        close_price REAL,
        price_change_pct REAL,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS warehouse_receipt_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        receipt_qty INTEGER DEFAULT 0,
        receipt_change INTEGER DEFAULT 0,
        receipt_change_pct REAL DEFAULT 0,
        warehouse_distribution TEXT,
        supply_demand_signal TEXT,
        supply_demand_score INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 日行情历史表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_quotes_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        variety TEXT NOT NULL,
        contract_id TEXT NOT NULL,
        open_price REAL DEFAULT 0,
        high_price REAL DEFAULT 0,
        low_price REAL DEFAULT 0,
        close_price REAL DEFAULT 0,
        clear_price REAL DEFAULT 0,
        price_change REAL DEFAULT 0,
        volume INTEGER DEFAULT 0,
        open_interest INTEGER DEFAULT 0,
        open_interest_change INTEGER DEFAULT 0,
        turnover REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, contract_id)
      )
    `);

    // 现货价格表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spot_price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        spot_price REAL DEFAULT 0,
        futures_price REAL DEFAULT 0,
        basis REAL DEFAULT 0,
        basis_rate REAL DEFAULT 0,
        data_source TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 每日基本面流水表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_fundamental_flow (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        futures_price REAL DEFAULT 0,
        settle_price REAL DEFAULT 0,
        spot_price REAL DEFAULT 0,
        cost_line REAL DEFAULT 0,
        basis REAL DEFAULT 0,
        inventory REAL DEFAULT 0,
        inventory_percentile REAL DEFAULT 0,
        inventory_level TEXT DEFAULT '',
        warehouse_change REAL DEFAULT 0,
        open_interest INTEGER DEFAULT 0,
        demand_status TEXT DEFAULT '',
        signal_conclusion TEXT DEFAULT '',
        signal_count INTEGER DEFAULT 0,
        signal_s1 TEXT DEFAULT '',
        signal_s2 TEXT DEFAULT '',
        signal_s3 TEXT DEFAULT '',
        price_warning TEXT DEFAULT '',
        macro_risk TEXT DEFAULT '',
        event_score REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 焦煤深度监控表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS coking_coal_monitor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        close_price REAL DEFAULT 0,
        spot_price REAL DEFAULT 0,
        basis REAL DEFAULT 0,
        basis_rate REAL DEFAULT 0,
        iron_water_output REAL DEFAULT 0,
        port_inventory REAL DEFAULT 0,
        eaf_utilization REAL DEFAULT 0,
        wind_avg_price REAL DEFAULT 0,
        wind_east_price REAL DEFAULT 0,
        wind_north_price REAL DEFAULT 0,
        cost_deviation REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 生猪每日监控表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pig_daily_monitor (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        spot_price REAL,
        lh2609_price REAL,
        lh2611_price REAL,
        lh2701_price REAL,
        corn_price REAL,
        piglet_price REAL,
        sow_inventory REAL,
        sow_mom_change REAL,
        slaughter_rate REAL,
        frozen_stock_rate REAL,
        slaughter_weight REAL,
        self_breed_profit REAL,
        purchased_profit REAL,
        rule1_price_low INTEGER,
        rule2_inventory_low INTEGER,
        rule3_profit_negative INTEGER,
        rule4_demand_good INTEGER,
        rule5_basis_discount INTEGER,
        signal1_supply_demand TEXT,
        signal2_extreme TEXT,
        signal3_external TEXT,
        quant_score INTEGER,
        comment TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date)
      )
    `);

    // 生猪季节性历史参考表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pig_seasonal_reference (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        month INTEGER NOT NULL UNIQUE,
        core_logic TEXT,
        best_contract TEXT,
        max_monthly_gain REAL,
        max_monthly_drop REAL,
        avg_change REAL,
        rise_probability REAL,
        cycle_attribute TEXT,
        trading_window TEXT,
        core_risk TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // 供需评分表（五句金律核心数据，从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS supply_demand_score (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        supply_gap_rate REAL DEFAULT 0,
        cost_support_price REAL DEFAULT 0,
        profit_signal REAL DEFAULT 0,
        inventory_percentile REAL DEFAULT 0,
        five_rules_score REAL DEFAULT 0,
        total_score REAL DEFAULT 0,
        certainty_rating TEXT,
        core_contradiction TEXT,
        trading_advice TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 产业链利润表（从飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS industry_profit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        upstream_profit REAL DEFAULT 0,
        midstream_profit REAL DEFAULT 0,
        downstream_profit REAL DEFAULT 0,
        profit_transmission TEXT,
        negative_feedback_risk TEXT,
        sector TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 库存历史表（从 AkShare 同步，用于计算库存分位）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inventory_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        variety TEXT NOT NULL,
        inventory REAL DEFAULT 0,
        inventory_change REAL DEFAULT 0,
        inventory_percentile REAL DEFAULT NULL,
        data_source TEXT DEFAULT 'akshare',
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, variety)
      )
    `);

    // 信号告警表（飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signal_alert (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        signal_type TEXT,
        signal_description TEXT,
        urgency TEXT,
        suggested_action TEXT,
        status TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trigger_date, code)
      )
    `);

    // 交易记录表（飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_record (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        open_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        contract TEXT,
        direction TEXT,
        open_price REAL DEFAULT 0,
        quantity INTEGER DEFAULT 0,
        stop_loss_price REAL DEFAULT 0,
        target_price REAL DEFAULT 0,
        close_date TEXT,
        close_price REAL DEFAULT 0,
        profit REAL DEFAULT 0,
        cumulative_equity REAL DEFAULT 0,
        trading_reason TEXT,
        review_score REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(open_date, code)
      )
    `);

    // 飞书每日行情表（区别于 Tushare 的 daily_quotes_history）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_quotes_feishu (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        contract TEXT,
        open_price REAL DEFAULT 0,
        high_price REAL DEFAULT 0,
        low_price REAL DEFAULT 0,
        close_price REAL DEFAULT 0,
        settlement_price REAL DEFAULT 0,
        volume INTEGER DEFAULT 0,
        position INTEGER DEFAULT 0,
        position_change INTEGER DEFAULT 0,
        price_change_rate REAL DEFAULT 0,
        margin_rate REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 技术面信号表（飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS technical_signal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        contract TEXT,
        trend_stage TEXT,
        technical_advice TEXT,
        key_support REAL DEFAULT 0,
        key_resistance REAL DEFAULT 0,
        always_in_direction TEXT,
        multi_period_resonance TEXT,
        brooks_radar_score REAL DEFAULT 0,
        signal_kline_description TEXT,
        notes TEXT,
        ema20 REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 60min 关键位表（飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS key_levels_60min (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        support_level REAL DEFAULT 0,
        resistance_level REAL DEFAULT 0,
        data_source TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 龙虎榜表（飞书同步）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS longhu_bang (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        contract_code TEXT NOT NULL,
        member_name TEXT NOT NULL,
        rank INTEGER,
        buy_volume INTEGER DEFAULT 0,
        buy_change INTEGER DEFAULT 0,
        sell_volume INTEGER DEFAULT 0,
        sell_change INTEGER DEFAULT 0,
        net_volume INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, contract_code, member_name)
      )
    `);

    // 交易提醒表（机会监控/持仓监控生成，前端轮询 + 飞书推送双通道）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trading_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        code TEXT NOT NULL,
        name TEXT,
        title TEXT NOT NULL,
        message TEXT,
        detail TEXT,
        is_read INTEGER DEFAULT 0,
        push_status TEXT DEFAULT '',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // 监控持仓表（服务端登记持仓，供监控引擎检测止损/反转/目标）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS monitored_positions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        entry_time TEXT,
        stop_loss REAL,
        target_price REAL,
        lots REAL DEFAULT 1,
        note TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // 每日信号日报表（收盘后自动记录每个品种的研判结果）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS daily_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_date TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT,
        close REAL,
        change_pct REAL,
        spectrum TEXT,
        ai_direction TEXT,
        signal_level TEXT,
        p_follow REAL,
        adx REAL,
        g4_count INTEGER,
        one_liner TEXT,
        advice TEXT,
        ch_direction TEXT,
        ch_entry REAL,
        ch_stop REAL,
        ch_target REAL,
        mm_tier1 REAL,
        mm_tier2 REAL,
        trend_momentum REAL,
        detail_json TEXT,
        created_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(trade_date, code)
      )
    `);

    // 模拟交易记录表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_trades (
        id TEXT PRIMARY KEY,
        variety_code TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        quantity REAL NOT NULL,
        entry_time TEXT NOT NULL,
        exit_time TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        source TEXT NOT NULL,
        ml_confidence REAL,
        ml_predicted_return TEXT,
        stop_loss REAL,
        take_profit REAL,
        realized_pnl REAL,
        realized_return REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 模拟交易绩效表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS paper_trade_performance (
        id TEXT PRIMARY KEY,
        total_trades INTEGER NOT NULL DEFAULT 0,
        winning_trades INTEGER NOT NULL DEFAULT 0,
        losing_trades INTEGER NOT NULL DEFAULT 0,
        total_pnl REAL NOT NULL DEFAULT 0,
        total_return REAL NOT NULL DEFAULT 0,
        max_drawdown REAL NOT NULL DEFAULT 0,
        sharpe_ratio REAL,
        profit_factor REAL,
        win_rate REAL NOT NULL DEFAULT 0,
        avg_win REAL,
        avg_loss REAL,
        ml_trades INTEGER NOT NULL DEFAULT 0,
        manual_trades INTEGER NOT NULL DEFAULT 0,
        ml_pnl REAL NOT NULL DEFAULT 0,
        manual_pnl REAL NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // 日报建议复盘跟踪表（追踪每条交易建议的完整生命周期）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_review (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        name TEXT,
        advice_date TEXT NOT NULL,
        direction TEXT,
        entry_price REAL,
        entry_range_low REAL,
        entry_range_high REAL,
        stop_price REAL,
        target_price REAL,
        signal_level TEXT,
        spectrum TEXT,
        status TEXT DEFAULT 'pending',
        touched_date TEXT,
        result TEXT,
        result_pnl REAL,
        result_pnl_pct REAL,
        days_held INTEGER,
        updated_at TEXT DEFAULT (datetime('now', 'localtime')),
        UNIQUE(code, advice_date)
      )
    `);

    // 模拟交易表（基于信号自动生成，跟踪盈亏）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sim_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        name TEXT,
        direction TEXT NOT NULL,
        entry_date TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_date TEXT,
        exit_price REAL,
        pnl REAL,
        pnl_pct REAL,
        status TEXT DEFAULT 'open',
        entry_reason TEXT,
        exit_reason TEXT,
        signal_score REAL,
        signal_grade TEXT,
        stop_loss REAL,
        take_profit REAL,
        max_hold_days INTEGER DEFAULT 15,
        cooldown_until TEXT,
        fee REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now', 'localtime'))
      )
    `);

    // 迁移：为已存在的表添加新字段（回测对齐参数）
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN stop_loss REAL`);
    } catch { /* 已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN take_profit REAL`);
    } catch { /* 已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN max_hold_days INTEGER DEFAULT 15`);
    } catch { /* 已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN cooldown_until TEXT`);
    } catch { /* 已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN fee REAL DEFAULT 0`);
    } catch { /* 已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN position_size REAL DEFAULT 1`);
    } catch { /* 已存在则忽略 */ }

    // 事件日报表（黑天鹅事件驱动的综合分析日报，作为复盘数据沉淀）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS event_daily_reports (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_date TEXT NOT NULL,
        title TEXT NOT NULL,
        category TEXT,
        generated_at TEXT NOT NULL,
        report_json TEXT NOT NULL,
        is_realtime INTEGER DEFAULT 0
      )
    `);
    try {
      // 兼容旧库：为已存在的 event_daily_reports 表补充 is_realtime 列
      this.db.exec(`ALTER TABLE event_daily_reports ADD COLUMN is_realtime INTEGER DEFAULT 0`);
    } catch { /* 已存在则忽略 */ }

    // ML 模型版本管理表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ml_model_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        training_samples INTEGER NOT NULL,
        varieties_count INTEGER DEFAULT 0,
        accuracy REAL NOT NULL,
        precision_score REAL NOT NULL,
        recall_score REAL NOT NULL,
        f1_score REAL NOT NULL,
        feature_importance TEXT,
        is_active INTEGER DEFAULT 1,
        performance_decay REAL DEFAULT 0,
        rollback_version TEXT,
        notes TEXT,
        model_path TEXT
      )
    `);

    // 迁移: 为已有的 sim_trades 表添加 signal_score 和 signal_grade 列
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN signal_score REAL`);
    } catch { /* 列已存在则忽略 */ }
    try {
      this.db.exec(`ALTER TABLE sim_trades ADD COLUMN signal_grade TEXT`);
    } catch { /* 列已存在则忽略 */ }

    // 创建索引
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signal_history_code ON signal_history(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signal_history_time ON signal_history(scan_time)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signal_history_level ON signal_history(signal_level)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trend_tracking_code ON trend_tracking(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trend_tracking_status ON trend_tracking(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_variety_performance_code ON variety_performance(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_variety_performance_adaptability ON variety_performance(adaptability_score)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_capital_flow_history_date ON capital_flow_history(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_capital_flow_history_code ON capital_flow_history(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_warehouse_receipt_history_date ON warehouse_receipt_history(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_warehouse_receipt_history_code ON warehouse_receipt_history(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_quotes_history_date ON daily_quotes_history(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_quotes_history_variety ON daily_quotes_history(variety)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_quotes_history_contract ON daily_quotes_history(contract_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_supply_demand_score_date ON supply_demand_score(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_supply_demand_score_code ON supply_demand_score(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_industry_profit_date ON industry_profit(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_industry_profit_code ON industry_profit(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_history_date ON inventory_history(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_inventory_history_variety ON inventory_history(variety)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_signal_alert_date ON signal_alert(trigger_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trading_record_date ON trading_record(open_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_quotes_feishu_date ON daily_quotes_feishu(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_technical_signal_date ON technical_signal(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_key_levels_date ON key_levels_60min(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_longhu_date ON longhu_bang(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_longhu_contract ON longhu_bang(contract_code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trading_alerts_read ON trading_alerts(is_read)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trading_alerts_type ON trading_alerts(alert_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_trading_alerts_created ON trading_alerts(created_at)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_journal_date ON daily_journal(trade_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_review_code ON journal_review(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_review_status ON journal_review(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_journal_review_date ON journal_review(advice_date)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_daily_journal_code ON daily_journal(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sim_trades_status ON sim_trades(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sim_trades_code ON sim_trades(code)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_event_daily_reports_event ON event_daily_reports(event_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_event_daily_reports_generated ON event_daily_reports(generated_at)`);

    // 迁移 spot_price_history：UNIQUE(trade_date, code) → UNIQUE(trade_date, code, data_source)
    // 防止不同数据源（飞书/Tushare）同日期数据互相覆盖
    try {
      const tblSql = this.db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='spot_price_history'`
      ).get() as unknown as { sql: string } | undefined;
      // 检查 UNIQUE 子句是否已包含 data_source（从 UNIQUE( 到下一个 )）
      const sql = tblSql?.sql || '';
      const uniStart = sql.indexOf('UNIQUE(');
      const uniEnd = sql.indexOf(')', uniStart);
      const needMigration = uniStart > -1 && uniEnd > uniStart &&
        !sql.substring(uniStart, uniEnd + 1).includes('data_source');
      if (needMigration) {
        console.log('[DB] 迁移 spot_price_history UNIQUE 约束...');
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS spot_price_history_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            trade_date TEXT NOT NULL,
            code TEXT NOT NULL,
            name TEXT NOT NULL,
            spot_price REAL DEFAULT 0,
            futures_price REAL DEFAULT 0,
            basis REAL DEFAULT 0,
            basis_rate REAL DEFAULT 0,
            data_source TEXT DEFAULT '',
            created_at TEXT DEFAULT (datetime('now', 'localtime')),
            UNIQUE(trade_date, code, data_source)
          )
        `);
        const oldCount = this.db.prepare('SELECT COUNT(*) as c FROM spot_price_history').get() as unknown as { c: number };
        this.db.exec(`INSERT OR IGNORE INTO spot_price_history_new SELECT * FROM spot_price_history`);
        this.db.exec(`DROP TABLE spot_price_history`);
        this.db.exec(`ALTER TABLE spot_price_history_new RENAME TO spot_price_history`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_spot_price_date ON spot_price_history(trade_date)`);
        this.db.exec(`CREATE INDEX IF NOT EXISTS idx_spot_price_code ON spot_price_history(code)`);
        const newCount = this.db.prepare('SELECT COUNT(*) as c FROM spot_price_history').get() as unknown as { c: number };
        console.log(`[DB] spot_price_history 迁移完成: ${oldCount.c} → ${newCount.c} 条`);
      }
    } catch (e) {
      console.error('[DB] spot_price_history 迁移失败:', e);
    }

    // 创建 ML 模型版本表
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS ml_model_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version TEXT UNIQUE NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          accuracy REAL,
          precision_score REAL,
          recall_score REAL,
          f1_score REAL,
          training_samples INTEGER,
          varieties_count INTEGER,
          is_active INTEGER DEFAULT 0,
          performance_decay REAL,
          rollback_version TEXT,
          notes TEXT,
          model_path TEXT
        )
      `);
      // 迁移：为已存在的 ml_model_versions 表补齐 model_path 列
      try {
        this.db.exec(`ALTER TABLE ml_model_versions ADD COLUMN model_path TEXT`);
      } catch { /* 列已存在则忽略 */ }
      console.log('[DB] ml_model_versions 表已创建');
    } catch (e) {
      console.error('[DB] ml_model_versions 表创建失败:', e);
    }

    this.isReady = true;
  }

  // 持久化到磁盘（防抖，避免频繁写入）
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        const data = this.db.export();
        const buffer = Buffer.from(data);
        writeFileSync(DB_PATH, buffer);
        backupToPersistDir();
      } catch (e) {
        console.error('[DB] Save failed:', e);
      }
    }, 100);
  }

  // 立即持久化
  private saveNow(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      writeFileSync(DB_PATH, buffer);
      backupToPersistDir();
    } catch (e) {
      console.error('[DB] Save failed:', e);
    }
  }

  // Wait for initialization
  async ensureInitialized(): Promise<void> {
    await this.initPromise;
  }

  // Synchronous wait for initialization (for module-level code)
  private waitUntilReady(): void {
    if (!this.isReady) {
      throw new Error('Database not initialized. Call waitForDbInit() first.');
    }
  }

  // Execute SQL (for CREATE, INSERT, UPDATE, DELETE) - synchronous
  exec(sql: string): void {
    this.waitUntilReady();
    this.db.exec(sql);
    this.scheduleSave();
  }

  // Run SQL with parameters - synchronous
  run(sql: string, params: any[] = []): void {
    this.waitUntilReady();
    try {
      this.db.run(sql, params);
    } catch (e) {
      console.error('[DB] Run failed:', sql, params, e);
      throw e;
    }
    this.scheduleSave();
  }

  // Query and return all rows - synchronous
  query(sql: string, params: any[] = []): any[] {
    this.waitUntilReady();
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    const rows: any[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  // Query and return single row - synchronous
  queryOne(sql: string, params: any[] = []): any | null {
    this.waitUntilReady();
    const stmt = this.db.prepare(sql);
    if (params.length > 0) stmt.bind(params);
    let row: any = null;
    if (stmt.step()) {
      row = stmt.getAsObject();
    }
    stmt.free();
    return row;
  }

  // Transaction support - synchronous
  transaction<T>(fn: () => T): T {
    this.waitUntilReady();
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      this.saveNow();
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // Prepare statement
  prepare(sql: string): { run: (...params: any[]) => { changes: number; lastInsertRowid: any }; get: (...params: any[]) => any; all: (...params: any[]) => any[] } {
    this.waitUntilReady();
    const self = this;
    const flatten = (params: any[]) => {
      if (params.length === 1 && params[0] !== null && typeof params[0] === 'object') {
        if (Array.isArray(params[0])) return params[0]; // unwrap array of values
        return Object.values(params[0]); // unwrap object values
      }
      return params;
    };
    return {
      run: (...params: any[]) => {
        const flatParams = flatten(params);
        self.db.run(sql, flatParams);
        const changes = (self.db as any).getRowsModified();
        // 获取 lastInsertRowid
        const stmt = self.db.prepare('SELECT last_insert_rowid() as id');
        stmt.step();
        const lastInsertRowid = stmt.getAsObject().id;
        stmt.free();
        self.scheduleSave();
        return { changes, lastInsertRowid };
      },
      get: (...params: any[]): any => {
        const flatParams = flatten(params);
        const s = self.db.prepare(sql);
        if (flatParams.length > 0) s.bind(flatParams);
        let row: any = null;
        if (s.step()) {
          row = s.getAsObject();
        }
        s.free();
        return row;
      },
      all: (...params: any[]): any[] => {
        const flatParams = flatten(params);
        const s = self.db.prepare(sql);
        if (flatParams.length > 0) s.bind(flatParams);
        const rows: any[] = [];
        while (s.step()) {
          rows.push(s.getAsObject());
        }
        s.free();
        return rows;
      },
    };
  }
}

// Create database instance
const db = new DatabaseWrapper();

// Export db instance for direct queries
export function getDb(): DatabaseWrapper {
  return db;
}

// Wait for initialization
export async function waitForDbInit(): Promise<void> {
  await db.ensureInitialized();
}

// 类型定义
export interface SignalRecord {
  scan_time: string;
  code: string;
  name: string;
  contract?: string;
  close: number;
  change_pct: number;
  spectrum: string;
  ai_direction: string;
  ai_streak: number;
  ai_flip: boolean;
  trend_strength: number;
  breakout_score: number;
  breakout_label: string;
  signal_level: string;
  signals: string[];
  signal_strength_score: number;
  adx: number;
  atr: number;
  ema_dev_pct: number;
  volume_ratio: number;
  mtr_detected: boolean;
  climax_detected: boolean;
  final_flag: boolean;
  wedge_detected: boolean;
  trap_type: string;
  barbwire: boolean;
  oversold_score?: number;
  oversold_signal?: string;
  consec_down_days?: number;
  dev_ma20?: number;
}

export interface TrendTrackingRecord {
  code: string;
  name: string;
  signal_type: string;
  signal_direction: string;
  start_time: string;
  start_price: number;
  start_scan_time: string;
}

// 保存信号记录
export function saveSignalRecord(record: SignalRecord): void {
  db.run(`
    INSERT INTO signal_history (
      scan_time, code, name, contract, close, change_pct, spectrum,
      ai_direction, ai_streak, ai_flip, trend_strength, breakout_score,
      breakout_label, signal_level, signals, signal_strength_score,
      adx, atr, ema_dev_pct, volume_ratio, mtr_detected, climax_detected,
      final_flag, wedge_detected, trap_type, barbwire,
      oversold_score, oversold_signal, consec_down_days, dev_ma20
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `, [
    record.scan_time, record.code, record.name, record.contract || null,
    record.close, record.change_pct, record.spectrum,
    record.ai_direction, record.ai_streak, record.ai_flip ? 1 : 0,
    record.trend_strength, record.breakout_score,
    record.breakout_label, record.signal_level, JSON.stringify(record.signals),
    record.signal_strength_score,
    record.adx, record.atr, record.ema_dev_pct, record.volume_ratio,
    record.mtr_detected ? 1 : 0, record.climax_detected ? 1 : 0,
    record.final_flag ? 1 : 0, record.wedge_detected ? 1 : 0,
    record.trap_type, record.barbwire ? 1 : 0,
    record.oversold_score || null, record.oversold_signal || null,
    record.consec_down_days || null, record.dev_ma20 || null
  ]);
}

// 批量保存信号记录
export function saveSignalRecords(records: SignalRecord[]): void {
  db.transaction(() => {
    for (const record of records) {
      saveSignalRecord(record);
    }
  });
}

// 获取历史信号
export function getSignalHistory(options: {
  code?: string;
  signalLevel?: string;
  limit?: number;
  offset?: number;
}): { records: any[]; total: number } {
  const { code, signalLevel, limit = 50, offset = 0 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (signalLevel) {
    whereClause += ' AND signal_level = ?';
    params.push(signalLevel);
  }

  const totalRow = db.queryOne(`SELECT COUNT(*) as total FROM signal_history WHERE ${whereClause}`, params);
  const total = totalRow?.total || 0;

  const records = db.query(`
    SELECT * FROM signal_history 
    WHERE ${whereClause}
    ORDER BY scan_time DESC 
    LIMIT ? OFFSET ?
  `, [...params, limit, offset]).map((r: any) => ({
    ...r,
    ai_flip: r.ai_flip === 1,
    signals: JSON.parse(r.signals || '[]'),
    mtr_detected: r.mtr_detected === 1,
    climax_detected: r.climax_detected === 1,
    final_flag: r.final_flag === 1,
    wedge_detected: r.wedge_detected === 1,
    barbwire: r.barbwire === 1,
  }));

  return { records, total };
}

// 获取品种的历史信号
export function getVarietySignalHistory(code: string, limit = 30): any[] {
  return db.query(`
    SELECT * FROM signal_history 
    WHERE code = ?
    ORDER BY scan_time DESC 
    LIMIT ?
  `, [code, limit]).map((r: any) => ({
    ...r,
    ai_flip: r.ai_flip === 1,
    signals: JSON.parse(r.signals || '[]'),
    mtr_detected: r.mtr_detected === 1,
    climax_detected: r.climax_detected === 1,
    final_flag: r.final_flag === 1,
    wedge_detected: r.wedge_detected === 1,
    barbwire: r.barbwire === 1,
  }));
}

// 开始跟踪趋势
export function startTrendTracking(record: TrendTrackingRecord): void {
  db.run(`
    INSERT OR IGNORE INTO trend_tracking (
      code, name, signal_type, signal_direction, 
      start_time, start_price, start_scan_time,
      last_update_time, last_price, last_ai_direction
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `, [
    record.code, record.name, record.signal_type, record.signal_direction,
    record.start_time, record.start_price, record.start_scan_time,
    record.start_time, record.start_price, record.signal_direction
  ]);
}

// 更新趋势跟踪
export function updateTrendTracking(code: string, signalType: string, data: {
  last_price: number;
  last_ai_direction: string;
  last_trend_strength: number;
  last_update_time: string;
}): void {
  db.run(`
    UPDATE trend_tracking 
    SET last_price = ?,
        last_ai_direction = ?,
        last_trend_strength = ?,
        last_update_time = ?,
        duration_days = julianday(?) - julianday(start_time),
        max_favorable_excursion = CASE 
          WHEN signal_direction = 'LONG' THEN MAX(max_favorable_excursion, ? - start_price)
          WHEN signal_direction = 'SHORT' THEN MAX(max_favorable_excursion, start_price - ?)
          ELSE max_favorable_excursion
        END,
        max_adverse_excursion = CASE 
          WHEN signal_direction = 'LONG' THEN MAX(max_adverse_excursion, start_price - ?)
          WHEN signal_direction = 'SHORT' THEN MAX(max_adverse_excursion, ? - start_price)
          ELSE max_adverse_excursion
        END
    WHERE code = ? AND signal_type = ? AND status = 'active'
  `, [
    data.last_price, data.last_ai_direction, data.last_trend_strength,
    data.last_update_time, data.last_update_time,
    data.last_price, data.last_price,
    data.last_price, data.last_price,
    code, signalType
  ]);
}

// 结束趋势跟踪
export function endTrendTracking(code: string, signalType: string, data: {
  end_time: string;
  end_price: number;
  result: string;
}): void {
  db.run(`
    UPDATE trend_tracking 
    SET status = 'ended',
        end_time = ?,
        end_price = ?,
        result = ?
    WHERE code = ? AND signal_type = ? AND status = 'active'
  `, [data.end_time, data.end_price, data.result, code, signalType]);
}

// 获取活跃的趋势跟踪
export function getActiveTrendTracking(): any[] {
  return db.query(`
    SELECT * FROM trend_tracking 
    WHERE status = 'active'
    ORDER BY start_time DESC
  `);
}

// 获取品种的趋势跟踪历史
export function getVarietyTrendHistory(code: string): any[] {
  return db.query(`
    SELECT * FROM trend_tracking 
    WHERE code = ?
    ORDER BY start_time DESC
    LIMIT 20
  `, [code]);
}

// 获取信号统计
export function getSignalStats(days = 7): {
  totalSignals: number;
  strongSignals: number;
  moderateSignals: number;
  weakSignals: number;
  topVarieties: { code: string; name: string; count: number }[];
  signalDistribution: { type: string; count: number }[];
} {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

  const totalRow = db.queryOne(`
    SELECT COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level != 'none'
  `, [cutoff]);
  const totalSignals = totalRow?.count || 0;

  const strongRow = db.queryOne(`
    SELECT COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level = 'strong'
  `, [cutoff]);
  const strongSignals = strongRow?.count || 0;

  const moderateRow = db.queryOne(`
    SELECT COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level = 'moderate'
  `, [cutoff]);
  const moderateSignals = moderateRow?.count || 0;

  const weakRow = db.queryOne(`
    SELECT COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level = 'weak'
  `, [cutoff]);
  const weakSignals = weakRow?.count || 0;

  const topVarieties = db.query(`
    SELECT code, name, COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level != 'none'
    GROUP BY code, name
    ORDER BY count DESC
    LIMIT 10
  `, [cutoff]) as { code: string; name: string; count: number }[];

  const signalDistribution = db.query(`
    SELECT signal_level as type, COUNT(*) as count FROM signal_history 
    WHERE scan_time > ? AND signal_level != 'none'
    GROUP BY signal_level
    ORDER BY count DESC
  `, [cutoff]) as { type: string; count: number }[];

  return { totalSignals, strongSignals, moderateSignals, weakSignals, topVarieties, signalDistribution };
}

// 清理旧数据（保留最近30天）
export function cleanupOldData(): void {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 30);
  const cutoff = cutoffDate.toISOString().slice(0, 19).replace('T', ' ');

  db.run(`DELETE FROM signal_history WHERE scan_time < ?`, [cutoff]);
}

// ============ 品种表现管理 ============

export interface VarietyPerformance {
  code: string;
  name: string;
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  win_rate: number;
  avg_pnl: number;
  profit_factor: number;
  max_consecutive_wins: number;
  max_consecutive_losses: number;
  adaptability_score: number;
  last_updated: string;
}

export interface VarietyPerformanceComputed {
  code: string;
  name: string;
  totalTrades: number;
  winningTrades: number;
  winRate: number;
  avgPnl: number;
  maxWin: number;
  maxLoss: number;
  profitFactor: number;
  adaptabilityScore: number;
  lastUpdated: string;
  isSuitable: boolean;
  recommendation: string;
}

export function calculateAdaptabilityScore(
  winRate: number,
  profitFactor: number,
  totalTrades: number,
  avgPnl: number
): number {
  let score = 50;
  if (totalTrades >= 5) {
    score += (winRate - 50) * 0.6;
  }
  if (profitFactor > 1) {
    score += Math.min((profitFactor - 1) * 10, 20);
  }
  if (avgPnl > 0) {
    score += Math.min(avgPnl * 2, 10);
  }
  if (totalTrades < 5) {
    score *= 0.7;
  } else if (totalTrades < 10) {
    score *= 0.85;
  }
  return Math.max(0, Math.min(100, score));
}

export function updateVarietyPerformance(
  code: string,
  name: string,
  totalTrades: number,
  winningTrades: number,
  losingTrades: number,
  avgPnl: number,
  profitFactor: number,
  maxConsecutiveWins: number,
  maxConsecutiveLosses: number
): void {
  const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;
  const adaptabilityScore = calculateAdaptabilityScore(winRate, profitFactor, totalTrades, avgPnl);

  const existing = db.queryOne(`SELECT code FROM variety_performance WHERE code = ?`, [code]);
  
  if (existing) {
    db.run(`
      UPDATE variety_performance SET
        total_trades = ?, winning_trades = ?, losing_trades = ?,
        win_rate = ?, avg_pnl = ?, profit_factor = ?,
        max_consecutive_wins = ?, max_consecutive_losses = ?,
        adaptability_score = ?, last_updated = datetime('now', 'localtime')
      WHERE code = ?
    `, [
      totalTrades, winningTrades, losingTrades,
      winRate, avgPnl, profitFactor, maxConsecutiveWins, maxConsecutiveLosses,
      adaptabilityScore, code
    ]);
  } else {
    db.run(`
      INSERT INTO variety_performance (code, name, total_trades, winning_trades, losing_trades,
        win_rate, avg_pnl, profit_factor, max_consecutive_wins, max_consecutive_losses,
        adaptability_score, last_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `, [
      code, name, totalTrades, winningTrades, losingTrades,
      winRate, avgPnl, profitFactor, maxConsecutiveWins, maxConsecutiveLosses,
      adaptabilityScore
    ]);
  }
}

export function getAllVarietyPerformance(): VarietyPerformanceComputed[] {
  const rows = db.query(`SELECT * FROM variety_performance ORDER BY adaptability_score DESC`) as Array<{
    code: string;
    name: string;
    total_trades: number;
    winning_trades: number;
    win_rate: number;
    avg_pnl: number;
    profit_factor: number;
    max_consecutive_wins: number;
    max_consecutive_losses: number;
    adaptability_score: number;
    last_updated: string;
  }>;
  return rows.map(row => ({
    code: row.code,
    name: row.name,
    totalTrades: row.total_trades,
    winningTrades: row.winning_trades,
    winRate: row.win_rate,
    avgPnl: row.avg_pnl,
    maxWin: row.max_consecutive_wins,
    maxLoss: row.max_consecutive_losses,
    profitFactor: row.profit_factor,
    adaptabilityScore: row.adaptability_score,
    lastUpdated: row.last_updated,
    isSuitable: row.adaptability_score >= 60,
    recommendation: row.adaptability_score >= 70 ? '强烈推荐' :
      row.adaptability_score >= 60 ? '推荐' :
      row.adaptability_score >= 40 ? '谨慎' : '不推荐',
  }));
}

export function getSuitableVarieties(threshold: number = 60): VarietyPerformance[] {
  return db.query(`
    SELECT * FROM variety_performance
    WHERE adaptability_score >= ?
    ORDER BY adaptability_score DESC
  `, [threshold]) as VarietyPerformance[];
}

export function getVarietyAdaptability(code: string): number | null {
  const row = db.queryOne(`SELECT adaptability_score FROM variety_performance WHERE code = ?`, [code]);
  return row ? row.adaptability_score : null;
}

// ============= 资金流向历史 =============

export interface CapitalFlowRecord {
  trade_date: string;
  code: string;
  name: string;
  top5_volume: number;
  top5_volume_ratio: number;
  top5_volume_change: number;
  top5_long: number;
  top5_short: number;
  net_position: number;
  net_position_change: number;
  concentration_index: number;
  smart_money_direction: string;
  smart_money_confidence: number;
  signal_type: string;
  signal_confidence: number;
  close_price: number;
  price_change_pct: number;
}

export function saveCapitalFlowRecord(record: CapitalFlowRecord): void {
  const existing = db.queryOne(
    `SELECT id FROM capital_flow_history WHERE trade_date = ? AND code = ?`,
    [record.trade_date, record.code]
  );

  if (existing) {
    db.run(`
      UPDATE capital_flow_history SET
        name = ?, top5_volume = ?, top5_volume_ratio = ?, top5_volume_change = ?,
        top5_long = ?, top5_short = ?, net_position = ?, net_position_change = ?,
        concentration_index = ?, smart_money_direction = ?, smart_money_confidence = ?,
        signal_type = ?, signal_confidence = ?, close_price = ?, price_change_pct = ?
      WHERE trade_date = ? AND code = ?
    `, [
      record.name,
      record.top5_volume, record.top5_volume_ratio, record.top5_volume_change,
      record.top5_long, record.top5_short, record.net_position, record.net_position_change,
      record.concentration_index, record.smart_money_direction, record.smart_money_confidence,
      record.signal_type, record.signal_confidence, record.close_price, record.price_change_pct,
      record.trade_date, record.code
    ]);
  } else {
    db.run(`
      INSERT INTO capital_flow_history (
        trade_date, code, name,
        top5_volume, top5_volume_ratio, top5_volume_change,
        top5_long, top5_short, net_position, net_position_change,
        concentration_index, smart_money_direction, smart_money_confidence,
        signal_type, signal_confidence, close_price, price_change_pct
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      record.trade_date, record.code, record.name,
      record.top5_volume, record.top5_volume_ratio, record.top5_volume_change,
      record.top5_long, record.top5_short, record.net_position, record.net_position_change,
      record.concentration_index, record.smart_money_direction, record.smart_money_confidence,
      record.signal_type, record.signal_confidence, record.close_price, record.price_change_pct
    ]);
  }
}

export function saveCapitalFlowRecords(records: CapitalFlowRecord[]): number {
  let savedCount = 0;
  for (const record of records) {
    try {
      saveCapitalFlowRecord(record);
      savedCount++;
    } catch (error) {
      console.error('Failed to save capital flow record:', error);
    }
  }
  return savedCount;
}

export function getCapitalFlowHistory(options: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { code, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM capital_flow_history 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

export function getCapitalFlowTrend(code: string, days: number = 7): {
  trend: string;
  avgNetPosition: number;
  netPositionChange: number;
  smartMoneyConsistency: number;
} {
  const records = db.query(`
    SELECT * FROM capital_flow_history 
    WHERE code = ?
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [code, days]) as any[];
  
  if (records.length === 0) {
    return { trend: 'unknown', avgNetPosition: 0, netPositionChange: 0, smartMoneyConsistency: 0 };
  }
  
  const avgNetPosition = records.reduce((sum, r) => sum + r.net_position, 0) / records.length;
  const netPositionChange = records[0].net_position - records[records.length - 1].net_position;
  
  const directions = records.map(r => r.smart_money_direction);
  const longCount = directions.filter((d: string) => d === 'LONG').length;
  const shortCount = directions.filter((d: string) => d === 'SHORT').length;
  const smartMoneyConsistency = Math.max(longCount, shortCount) / records.length;
  
  let trend = 'neutral';
  if (netPositionChange > 1000) trend = 'bullish';
  else if (netPositionChange < -1000) trend = 'bearish';
  
  return { trend, avgNetPosition, netPositionChange, smartMoneyConsistency };
}

// ============= 仓单历史 =============

export interface WarehouseReceiptRecord {
  trade_date: string;
  code: string;
  name: string;
  receipt_qty: number;
  receipt_change: number;
  receipt_change_pct: number;
  warehouse_distribution: string;
  supply_demand_signal: string;
  supply_demand_score: number;
}

export function saveWarehouseReceiptRecord(record: WarehouseReceiptRecord): void {
  try {
    const existing = db.queryOne(
      `SELECT id FROM warehouse_receipt_history WHERE trade_date = ? AND code = ?`,
      [record.trade_date, record.code]
    );

    if (existing) {
      db.run(`
        UPDATE warehouse_receipt_history SET
          name = ?, receipt_qty = ?, receipt_change = ?, receipt_change_pct = ?,
          warehouse_distribution = ?, supply_demand_signal = ?, supply_demand_score = ?
        WHERE trade_date = ? AND code = ?
      `, [
        record.name,
        record.receipt_qty, record.receipt_change, record.receipt_change_pct,
        record.warehouse_distribution, record.supply_demand_signal, record.supply_demand_score,
        record.trade_date, record.code
      ]);
    } else {
      db.run(`
        INSERT INTO warehouse_receipt_history (
          trade_date, code, name,
          receipt_qty, receipt_change, receipt_change_pct,
          warehouse_distribution, supply_demand_signal, supply_demand_score
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.trade_date, record.code, record.name,
        record.receipt_qty, record.receipt_change, record.receipt_change_pct,
        record.warehouse_distribution, record.supply_demand_signal, record.supply_demand_score
      ]);
    }
  } catch (error) {
    console.error(`Failed to save warehouse receipt for ${record.code} on ${record.trade_date}:`, error);
    throw error;
  }
}

export function saveWarehouseReceiptRecords(records: WarehouseReceiptRecord[]): number {
  let savedCount = 0;
  for (const record of records) {
    try {
      saveWarehouseReceiptRecord(record);
      savedCount++;
    } catch (error) {
      console.error('Failed to save warehouse receipt record:', error);
    }
  }
  return savedCount;
}

export function getWarehouseReceiptHistory(options: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { code, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM warehouse_receipt_history 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

export function getWarehouseReceiptTrend(code: string, days: number = 7): {
  trend: string;
  avgReceipt: number;
  receiptChange: number;
  supplyPressure: string;
} {
  const records = db.query(`
    SELECT * FROM warehouse_receipt_history 
    WHERE code = ?
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [code, days]) as any[];
  
  if (records.length === 0) {
    return { trend: 'unknown', avgReceipt: 0, receiptChange: 0, supplyPressure: 'unknown' };
  }
  
  const avgReceipt = records.reduce((sum, r) => sum + r.receipt_qty, 0) / records.length;
  const receiptChange = records[0].receipt_qty - records[records.length - 1].receipt_qty;
  
  let trend = 'stable';
  let supplyPressure = 'neutral';
  
  if (receiptChange > 500) {
    trend = 'increasing';
    supplyPressure = 'high';
  } else if (receiptChange < -500) {
    trend = 'decreasing';
    supplyPressure = 'low';
  }
  
  return { trend, avgReceipt, receiptChange, supplyPressure };
}

// ============= 日行情历史 =============

export interface DailyQuoteRecord {
  trade_date: string;
  variety: string;
  contract_id: string;
  open_price: number;
  high_price: number;
  low_price: number;
  close_price: number;
  clear_price: number;
  price_change: number;
  volume: number;
  open_interest: number;
  open_interest_change: number;
  turnover: number;
}

export function saveDailyQuoteRecord(record: DailyQuoteRecord): void {
  try {
    const existing = db.queryOne(
      `SELECT id FROM daily_quotes_history WHERE trade_date = ? AND contract_id = ?`,
      [record.trade_date, record.contract_id]
    );

    if (existing) {
      db.run(`
        UPDATE daily_quotes_history SET
          variety = ?, open_price = ?, high_price = ?, low_price = ?,
          close_price = ?, clear_price = ?, price_change = ?,
          volume = ?, open_interest = ?, open_interest_change = ?, turnover = ?
        WHERE trade_date = ? AND contract_id = ?
      `, [
        record.variety, record.open_price, record.high_price, record.low_price,
        record.close_price, record.clear_price, record.price_change,
        record.volume, record.open_interest, record.open_interest_change, record.turnover,
        record.trade_date, record.contract_id
      ]);
    } else {
      db.run(`
        INSERT INTO daily_quotes_history (
          trade_date, variety, contract_id,
          open_price, high_price, low_price, close_price, clear_price,
          price_change, volume, open_interest, open_interest_change, turnover
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.trade_date, record.variety, record.contract_id,
        record.open_price, record.high_price, record.low_price, record.close_price, record.clear_price,
        record.price_change, record.volume, record.open_interest, record.open_interest_change, record.turnover
      ]);
    }
  } catch (error) {
    console.error(`Failed to save daily quote for ${record.contract_id} on ${record.trade_date}:`, error);
    throw error;
  }
}

export function saveDailyQuoteRecords(records: DailyQuoteRecord[]): number {
  let savedCount = 0;
  for (const record of records) {
    try {
      saveDailyQuoteRecord(record);
      savedCount++;
    } catch (error) {
      // Error already logged in saveDailyQuoteRecord
    }
  }
  return savedCount;
}

export function getDailyQuotesHistory(options: {
  variety?: string;
  contractId?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { variety, contractId, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (variety) {
    whereClause += ' AND variety = ?';
    params.push(variety);
  }
  if (contractId) {
    whereClause += ' AND contract_id = ?';
    params.push(contractId);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM daily_quotes_history 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

// ============= 现货价格历史（从飞书同步） =============

export interface SpotPriceRecord {
  trade_date: string;
  code: string;
  name: string;
  spot_price: number;
  futures_price: number;
  basis: number;
  basis_rate: number;
  data_source: string;
}

export function saveSpotPriceRecord(record: SpotPriceRecord): void {
  db.run(`
    INSERT OR REPLACE INTO spot_price_history 
    (trade_date, code, name, spot_price, futures_price, basis, basis_rate, data_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.code,
    record.name,
    record.spot_price,
    record.futures_price,
    record.basis,
    record.basis_rate,
    record.data_source
  ]);
}

export function saveSpotPriceRecords(records: SpotPriceRecord[]): number {
  let savedCount = 0;
  for (const record of records) {
    try {
      saveSpotPriceRecord(record);
      savedCount++;
    } catch (error) {
      // Error already logged
    }
  }
  return savedCount;
}

export function getSpotPriceHistory(options: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { code, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM spot_price_history 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

export function getLatestSpotPrice(code: string): any | null {
  const results = db.query(`
    SELECT * FROM spot_price_history 
    WHERE code = ? 
    ORDER BY trade_date DESC 
    LIMIT 1
  `, [code]) as any[];
  
  return results.length > 0 ? results[0] : null;
}

// ============= 每日基本面流水（从飞书同步） =============

export interface DailyFundamentalFlowRecord {
  trade_date: string;
  code: string;
  futures_price: number;
  settle_price: number;
  spot_price: number;
  cost_line: number;
  basis: number;
  inventory: number;
  inventory_percentile: number;
  inventory_level: string;
  warehouse_change: number;
  open_interest: number;
  demand_status: string;
  signal_conclusion: string;
  signal_count: number;
  signal_s1: string;
  signal_s2: string;
  signal_s3: string;
  price_warning: string;
  macro_risk: string;
  event_score: number;
}

export function saveDailyFundamentalFlow(record: DailyFundamentalFlowRecord): void {
  db.run(`
    INSERT OR REPLACE INTO daily_fundamental_flow 
    (trade_date, code, futures_price, settle_price, spot_price, cost_line, basis, 
     inventory, inventory_percentile, inventory_level, warehouse_change, open_interest,
     demand_status, signal_conclusion, signal_count, signal_s1, signal_s2, signal_s3,
     price_warning, macro_risk, event_score)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.code,
    record.futures_price,
    record.settle_price,
    record.spot_price,
    record.cost_line,
    record.basis,
    record.inventory,
    record.inventory_percentile,
    record.inventory_level,
    record.warehouse_change,
    record.open_interest,
    record.demand_status,
    record.signal_conclusion,
    record.signal_count,
    record.signal_s1,
    record.signal_s2,
    record.signal_s3,
    record.price_warning,
    record.macro_risk,
    record.event_score
  ]);
}

export function getDailyFundamentalFlow(options: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { code, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM daily_fundamental_flow 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

export function getLatestDailyFundamentalFlow(code: string): any | null {
  const results = db.query(`
    SELECT * FROM daily_fundamental_flow 
    WHERE code = ? 
    ORDER BY trade_date DESC 
    LIMIT 1
  `, [code]) as any[];
  
  return results.length > 0 ? results[0] : null;
}

// ============= 焦煤深度监控（从飞书同步） =============

export interface CokingCoalMonitorRecord {
  trade_date: string;
  code: string;
  close_price: number;
  spot_price: number;
  basis: number;
  basis_rate: number;
  iron_water_output: number;
  port_inventory: number;
  eaf_utilization: number;
  wind_avg_price: number;
  wind_east_price: number;
  wind_north_price: number;
  cost_deviation: number;
}

export function saveCokingCoalMonitor(record: CokingCoalMonitorRecord): void {
  db.run(`
    INSERT OR REPLACE INTO coking_coal_monitor 
    (trade_date, code, close_price, spot_price, basis, basis_rate,
     iron_water_output, port_inventory, eaf_utilization,
     wind_avg_price, wind_east_price, wind_north_price, cost_deviation)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.code,
    record.close_price,
    record.spot_price,
    record.basis,
    record.basis_rate,
    record.iron_water_output,
    record.port_inventory,
    record.eaf_utilization,
    record.wind_avg_price,
    record.wind_east_price,
    record.wind_north_price,
    record.cost_deviation
  ]);
}

export function getCokingCoalMonitor(options: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): any[] {
  const { code, startDate, endDate, limit = 30 } = options;
  
  let whereClause = '1=1';
  const params: any[] = [];
  
  if (code) {
    whereClause += ' AND code = ?';
    params.push(code);
  }
  if (startDate) {
    whereClause += ' AND trade_date >= ?';
    params.push(startDate);
  }
  if (endDate) {
    whereClause += ' AND trade_date <= ?';
    params.push(endDate);
  }

  return db.query(`
    SELECT * FROM coking_coal_monitor 
    WHERE ${whereClause}
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [...params, limit]);
}

export function getLatestCokingCoalMonitor(code: string): any | null {
  const results = db.query(`
    SELECT * FROM coking_coal_monitor 
    WHERE code = ? 
    ORDER BY trade_date DESC 
    LIMIT 1
  `, [code]) as any[];
  
  return results.length > 0 ? results[0] : null;
}

// ============ 生猪每日监控相关函数 ============

export function savePigDailyMonitor(data: any): boolean {
  try {
    db.run(`
      INSERT OR REPLACE INTO pig_daily_monitor (
        trade_date, spot_price, lh2609_price, lh2611_price, lh2701_price,
        corn_price, piglet_price, sow_inventory, sow_mom_change,
        slaughter_rate, frozen_stock_rate, slaughter_weight,
        self_breed_profit, purchased_profit,
        rule1_price_low, rule2_inventory_low, rule3_profit_negative,
        rule4_demand_good, rule5_basis_discount,
        signal1_supply_demand, signal2_extreme, signal3_external,
        quant_score, comment
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.trade_date,
      data.spot_price || 0,
      data.lh2609_price || 0,
      data.lh2611_price || 0,
      data.lh2701_price || 0,
      data.corn_price || 0,
      data.piglet_price || 0,
      data.sow_inventory || 0,
      data.sow_mom_change || 0,
      data.slaughter_rate || 0,
      data.frozen_stock_rate || 0,
      data.slaughter_weight || 0,
      data.self_breed_profit || 0,
      data.purchased_profit || 0,
      data.rule1_price_low || 0,
      data.rule2_inventory_low || 0,
      data.rule3_profit_negative || 0,
      data.rule4_demand_good || 0,
      data.rule5_basis_discount || 0,
      data.signal1_supply_demand || '',
      data.signal2_extreme || '',
      data.signal3_external || '',
      data.quant_score || 0,
      data.comment || ''
    ]);
    return true;
  } catch (error) {
    console.error('[Database] Error saving pig daily monitor:', error);
    return false;
  }
}

export function getLatestPigDailyMonitor(): any | null {
  const results = db.query(`
    SELECT * FROM pig_daily_monitor 
    ORDER BY trade_date DESC 
    LIMIT 1
  `) as any[];
  
  return results.length > 0 ? results[0] : null;
}

export function getPigDailyMonitorHistory(limit: number = 30): any[] {
  return db.query(`
    SELECT * FROM pig_daily_monitor 
    ORDER BY trade_date DESC 
    LIMIT ?
  `, [limit]) as any[];
}

// ============ 生猪季节性历史参考相关函数 ============

export function savePigSeasonalReference(data: any): boolean {
  try {
    db.run(`
      INSERT OR REPLACE INTO pig_seasonal_reference (
        month, core_logic, best_contract, max_monthly_gain, max_monthly_drop,
        avg_change, rise_probability, cycle_attribute, trading_window, core_risk
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      data.month,
      data.core_logic || '',
      data.best_contract || '',
      data.max_monthly_gain || 0,
      data.max_monthly_drop || 0,
      data.avg_change || 0,
      data.rise_probability || 0,
      data.cycle_attribute || '',
      data.trading_window || '',
      data.core_risk || ''
    ]);
    return true;
  } catch (error) {
    console.error('[Database] Error saving pig seasonal reference:', error);
    return false;
  }
}

export function getPigSeasonalReference(): any[] {
  return db.query(`
    SELECT * FROM pig_seasonal_reference 
    ORDER BY month ASC
  `) as any[];
}

export function getPigSeasonalReferenceByMonth(month: number): any | null {
  const results = db.query(`
    SELECT * FROM pig_seasonal_reference 
    WHERE month = ?
    LIMIT 1
  `, [month]) as any[];
  
  return results.length > 0 ? results[0] : null;
}

// ========== 供需评分表（五句金律核心数据） ==========
export interface SupplyDemandScoreRecord {
  trade_date: string;
  code: string;
  name?: string;
  supply_gap_rate?: number;
  cost_support_price?: number;
  profit_signal?: number;
  inventory_percentile?: number;
  five_rules_score?: number;
  total_score?: number;
  certainty_rating?: string;
  core_contradiction?: string;
  trading_advice?: string;
}

export function saveSupplyDemandScore(record: SupplyDemandScoreRecord): void {
  db.run(`
    INSERT OR REPLACE INTO supply_demand_score 
    (trade_date, code, name, supply_gap_rate, cost_support_price, profit_signal, 
     inventory_percentile, five_rules_score, total_score, certainty_rating, 
     core_contradiction, trading_advice)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.code,
    record.name || '',
    record.supply_gap_rate || 0,
    record.cost_support_price || 0,
    record.profit_signal || 0,
    record.inventory_percentile || 0,
    record.five_rules_score || 0,
    record.total_score || 0,
    record.certainty_rating || '',
    record.core_contradiction || '',
    record.trading_advice || ''
  ]);
}

// 批量保存供需评分（事务包裹，只写一次文件）
export function saveSupplyDemandScores(records: SupplyDemandScoreRecord[]): void {
  db.transaction(() => {
    for (const record of records) {
      db.run(`
        INSERT OR REPLACE INTO supply_demand_score 
        (trade_date, code, name, supply_gap_rate, cost_support_price, profit_signal, 
         inventory_percentile, five_rules_score, total_score, certainty_rating, 
         core_contradiction, trading_advice)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.trade_date,
        record.code,
        record.name || '',
        record.supply_gap_rate || 0,
        record.cost_support_price || 0,
        record.profit_signal || 0,
        record.inventory_percentile || 0,
        record.five_rules_score || 0,
        record.total_score || 0,
        record.certainty_rating || '',
        record.core_contradiction || '',
        record.trading_advice || ''
      ]);
    }
  });
}

export function getSupplyDemandScores(options?: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): SupplyDemandScoreRecord[] {
  let sql = 'SELECT * FROM supply_demand_score WHERE 1=1';
  const params: any[] = [];
  
  if (options?.code) {
    sql += ' AND code = ?';
    params.push(options.code);
  }
  if (options?.startDate) {
    sql += ' AND trade_date >= ?';
    params.push(options.startDate);
  }
  if (options?.endDate) {
    sql += ' AND trade_date <= ?';
    params.push(options.endDate);
  }
  
  sql += ' ORDER BY trade_date DESC';
  
  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  
  return db.query(sql, params) as SupplyDemandScoreRecord[];
}

// 获取每个品种最新一条供需评分
export function getLatestSupplyDemandScores(limit: number = 100): SupplyDemandScoreRecord[] {
  return db.query(`
    SELECT s.* FROM supply_demand_score s
    INNER JOIN (
      SELECT code, MAX(trade_date) as max_date
      FROM supply_demand_score
      GROUP BY code
    ) latest ON s.code = latest.code AND s.trade_date = latest.max_date
    LIMIT ?
  `, [limit]) as SupplyDemandScoreRecord[];
}

export function getLatestSupplyDemandScoreByCode(code: string): SupplyDemandScoreRecord | null {
  const results = db.query(`
    SELECT * FROM supply_demand_score 
    WHERE code = ?
    ORDER BY trade_date DESC
    LIMIT 1
  `, [code]) as SupplyDemandScoreRecord[];
  
  return results.length > 0 ? results[0] : null;
}

// ========== 产业链利润表 ==========
export interface IndustryProfitRecord {
  trade_date: string;
  code: string;
  name?: string;
  upstream_profit?: number;
  midstream_profit?: number;
  downstream_profit?: number;
  profit_transmission?: string;
  negative_feedback_risk?: string;
  sector?: string;
}

export function saveIndustryProfit(record: IndustryProfitRecord): void {
  db.run(`
    INSERT OR REPLACE INTO industry_profit 
    (trade_date, code, name, upstream_profit, midstream_profit, downstream_profit, 
     profit_transmission, negative_feedback_risk, sector)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.code,
    record.name || '',
    record.upstream_profit || 0,
    record.midstream_profit || 0,
    record.downstream_profit || 0,
    record.profit_transmission || '',
    record.negative_feedback_risk || '',
    record.sector || ''
  ]);
}

// 批量保存产业链利润（事务包裹，只写一次文件）
export function saveIndustryProfits(records: IndustryProfitRecord[]): void {
  db.transaction(() => {
    for (const record of records) {
      db.run(`
        INSERT OR REPLACE INTO industry_profit 
        (trade_date, code, name, upstream_profit, midstream_profit, downstream_profit, 
         profit_transmission, negative_feedback_risk, sector)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [
        record.trade_date,
        record.code,
        record.name || '',
        record.upstream_profit || 0,
        record.midstream_profit || 0,
        record.downstream_profit || 0,
        record.profit_transmission || '',
        record.negative_feedback_risk || '',
        record.sector || ''
      ]);
    }
  });
}

export function getIndustryProfits(options?: {
  code?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): IndustryProfitRecord[] {
  let sql = 'SELECT * FROM industry_profit WHERE 1=1';
  const params: any[] = [];
  
  if (options?.code) {
    sql += ' AND code = ?';
    params.push(options.code);
  }
  if (options?.startDate) {
    sql += ' AND trade_date >= ?';
    params.push(options.startDate);
  }
  if (options?.endDate) {
    sql += ' AND trade_date <= ?';
    params.push(options.endDate);
  }
  
  sql += ' ORDER BY trade_date DESC';
  
  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  
  return db.query(sql, params) as IndustryProfitRecord[];
}

// 获取每个品种最新一条产业链利润
export function getLatestIndustryProfits(limit: number = 100): IndustryProfitRecord[] {
  return db.query(`
    SELECT p.* FROM industry_profit p
    INNER JOIN (
      SELECT code, MAX(trade_date) as max_date
      FROM industry_profit
      GROUP BY code
    ) latest ON p.code = latest.code AND p.trade_date = latest.max_date
    LIMIT ?
  `, [limit]) as IndustryProfitRecord[];
}

export function getLatestIndustryProfitByCode(code: string): IndustryProfitRecord | null {
  const results = db.query(`
    SELECT * FROM industry_profit 
    WHERE code = ?
    ORDER BY trade_date DESC
    LIMIT 1
  `, [code]) as IndustryProfitRecord[];
  
  return results.length > 0 ? results[0] : null;
}

// ========== 库存历史表（AkShare 数据源） ==========
export interface InventoryHistoryRecord {
  trade_date: string;
  variety: string;
  inventory: number;
  inventory_change?: number;
  inventory_percentile?: number | null;
  data_source?: string;
}

export function saveInventoryHistory(record: InventoryHistoryRecord): void {
  db.run(`
    INSERT OR REPLACE INTO inventory_history 
    (trade_date, variety, inventory, inventory_change, inventory_percentile, data_source)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    record.trade_date,
    record.variety,
    record.inventory,
    record.inventory_change || 0,
    record.inventory_percentile ?? null,
    record.data_source || 'akshare'
  ]);
}

// 批量保存库存历史（事务包裹，只写一次文件）
export function saveInventoryHistories(records: InventoryHistoryRecord[]): void {
  db.transaction(() => {
    for (const record of records) {
      db.run(`
        INSERT OR REPLACE INTO inventory_history 
        (trade_date, variety, inventory, inventory_change, inventory_percentile, data_source)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        record.trade_date,
        record.variety,
        record.inventory,
        record.inventory_change || 0,
        record.inventory_percentile ?? null,
        record.data_source || 'akshare'
      ]);
    }
  });
}

export function getInventoryHistory(options?: {
  variety?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
}): InventoryHistoryRecord[] {
  let sql = 'SELECT * FROM inventory_history WHERE 1=1';
  const params: any[] = [];
  
  if (options?.variety) {
    sql += ' AND variety = ?';
    params.push(options.variety);
  }
  if (options?.startDate) {
    sql += ' AND trade_date >= ?';
    params.push(options.startDate);
  }
  if (options?.endDate) {
    sql += ' AND trade_date <= ?';
    params.push(options.endDate);
  }
  
  sql += ' ORDER BY trade_date DESC';
  
  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  
  return db.query(sql, params) as InventoryHistoryRecord[];
}

// 获取每个品种最新一条库存数据
export function getLatestInventoryByVarieties(): InventoryHistoryRecord[] {
  return db.query(`
    SELECT i.* FROM inventory_history i
    INNER JOIN (
      SELECT variety, MAX(trade_date) as max_date
      FROM inventory_history
      GROUP BY variety
    ) latest ON i.variety = latest.variety AND i.trade_date = latest.max_date
  `) as InventoryHistoryRecord[];
}

export function getLatestInventoryByVariety(variety: string): InventoryHistoryRecord | null {
  const results = db.query(`
    SELECT * FROM inventory_history 
    WHERE variety = ?
    ORDER BY trade_date DESC
    LIMIT 1
  `, [variety]) as InventoryHistoryRecord[];
  
  return results.length > 0 ? results[0] : null;
}

// ==================== 飞书扩展表（信号告警/交易记录/每日行情/技术面/关键位/龙虎榜） ====================

export interface SignalAlertRecord {
  trigger_date: string;
  code: string;
  name?: string;
  signal_type?: string;
  signal_description?: string;
  urgency?: string;
  suggested_action?: string;
  status?: string;
}

export function saveSignalAlerts(records: SignalAlertRecord[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO signal_alert (trigger_date, code, name, signal_type, signal_description, urgency, suggested_action, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.trigger_date, r.code, r.name || '', r.signal_type || '', r.signal_description || '', r.urgency || '', r.suggested_action || '', r.status || '']
      );
    }
  });
}

export function getLatestSignalAlerts(limit: number = 50): SignalAlertRecord[] {
  return db.query(
    `SELECT * FROM signal_alert ORDER BY trigger_date DESC, id DESC LIMIT ?`,
    [limit]
  ) as SignalAlertRecord[];
}

export interface TradingRecordItem {
  open_date: string;
  code: string;
  name?: string;
  contract?: string;
  direction?: string;
  open_price?: number;
  quantity?: number;
  stop_loss_price?: number;
  target_price?: number;
  close_date?: string;
  close_price?: number;
  profit?: number;
  cumulative_equity?: number;
  trading_reason?: string;
  review_score?: number;
}

export function saveTradingRecords(records: TradingRecordItem[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO trading_record (open_date, code, name, contract, direction, open_price, quantity, stop_loss_price, target_price, close_date, close_price, profit, cumulative_equity, trading_reason, review_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.open_date, r.code, r.name || '', r.contract || '', r.direction || '', r.open_price || 0, r.quantity || 0, r.stop_loss_price || 0, r.target_price || 0, r.close_date || '', r.close_price || 0, r.profit || 0, r.cumulative_equity || 0, r.trading_reason || '', r.review_score || 0]
      );
    }
  });
}

export function getLatestTradingRecords(limit: number = 50): TradingRecordItem[] {
  return db.query(
    `SELECT * FROM trading_record ORDER BY open_date DESC, id DESC LIMIT ?`,
    [limit]
  ) as TradingRecordItem[];
}

export interface DailyQuotesFeishuRecord {
  trade_date: string;
  code: string;
  name?: string;
  contract?: string;
  open_price?: number;
  high_price?: number;
  low_price?: number;
  close_price?: number;
  settlement_price?: number;
  volume?: number;
  position?: number;
  position_change?: number;
  price_change_rate?: number;
  margin_rate?: number;
}

export function saveDailyQuotesFeishu(records: DailyQuotesFeishuRecord[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO daily_quotes_feishu (trade_date, code, name, contract, open_price, high_price, low_price, close_price, settlement_price, volume, position, position_change, price_change_rate, margin_rate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.trade_date, r.code, r.name || '', r.contract || '', r.open_price || 0, r.high_price || 0, r.low_price || 0, r.close_price || 0, r.settlement_price || 0, r.volume || 0, r.position || 0, r.position_change || 0, r.price_change_rate || 0, r.margin_rate || 0]
      );
    }
  });
}

export function getLatestDailyQuotesFeishu(limit: number = 100): DailyQuotesFeishuRecord[] {
  return db.query(
    `SELECT q.* FROM daily_quotes_feishu q
     INNER JOIN (SELECT code, MAX(trade_date) as max_date FROM daily_quotes_feishu GROUP BY code) latest
     ON q.code = latest.code AND q.trade_date = latest.max_date
     ORDER BY q.code LIMIT ?`,
    [limit]
  ) as DailyQuotesFeishuRecord[];
}

export interface TechnicalSignalRecord {
  trade_date: string;
  code: string;
  name?: string;
  contract?: string;
  trend_stage?: string;
  technical_advice?: string;
  key_support?: number;
  key_resistance?: number;
  always_in_direction?: string;
  multi_period_resonance?: string;
  brooks_radar_score?: number;
  signal_kline_description?: string;
  notes?: string;
  ema20?: number;
}

export function saveTechnicalSignals(records: TechnicalSignalRecord[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO technical_signal (trade_date, code, name, contract, trend_stage, technical_advice, key_support, key_resistance, always_in_direction, multi_period_resonance, brooks_radar_score, signal_kline_description, notes, ema20) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.trade_date, r.code, r.name || '', r.contract || '', r.trend_stage || '', r.technical_advice || '', r.key_support || 0, r.key_resistance || 0, r.always_in_direction || '', r.multi_period_resonance || '', r.brooks_radar_score || 0, r.signal_kline_description || '', r.notes || '', r.ema20 || 0]
      );
    }
  });
}

export function getLatestTechnicalSignals(limit: number = 100): TechnicalSignalRecord[] {
  return db.query(
    `SELECT t.* FROM technical_signal t
     INNER JOIN (SELECT code, MAX(trade_date) as max_date FROM technical_signal GROUP BY code) latest
     ON t.code = latest.code AND t.trade_date = latest.max_date
     ORDER BY t.code LIMIT ?`,
    [limit]
  ) as TechnicalSignalRecord[];
}

export interface KeyLevel60minRecord {
  trade_date: string;
  code: string;
  name?: string;
  support_level?: number;
  resistance_level?: number;
}

export function saveKeyLevels60min(records: KeyLevel60minRecord[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO key_levels_60min (trade_date, code, name, support_level, resistance_level) VALUES (?, ?, ?, ?, ?)`,
        [r.trade_date, r.code, r.name || '', r.support_level || 0, r.resistance_level || 0]
      );
    }
  });
}

export function getLatestKeyLevels60min(limit: number = 100): KeyLevel60minRecord[] {
  return db.query(
    `SELECT k.* FROM key_levels_60min k
     INNER JOIN (SELECT code, MAX(trade_date) as max_date FROM key_levels_60min GROUP BY code) latest
     ON k.code = latest.code AND k.trade_date = latest.max_date
     ORDER BY k.code LIMIT ?`,
    [limit]
  ) as KeyLevel60minRecord[];
}

export interface LonghuBangRecord {
  trade_date: string;
  contract_code: string;
  member_name: string;
  rank?: number;
  buy_volume?: number;
  buy_change?: number;
  sell_volume?: number;
  sell_change?: number;
  net_volume?: number;
}

export function saveLonghuBang(records: LonghuBangRecord[]): void {
  db.transaction(() => {
    for (const r of records) {
      db.run(
        `INSERT OR REPLACE INTO longhu_bang (trade_date, contract_code, member_name, rank, buy_volume, buy_change, sell_volume, sell_change, net_volume) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.trade_date, r.contract_code, r.member_name, r.rank || 0, r.buy_volume || 0, r.buy_change || 0, r.sell_volume || 0, r.sell_change || 0, r.net_volume || 0]
      );
    }
  });
}

export function getLonghuBang(options: { date?: string; contractCode?: string; limit?: number }): LonghuBangRecord[] {
  let sql = 'SELECT * FROM longhu_bang WHERE 1=1';
  const params: any[] = [];
  if (options.date) { sql += ' AND trade_date = ?'; params.push(options.date); }
  if (options.contractCode) { sql += ' AND contract_code = ?'; params.push(options.contractCode); }
  sql += ' ORDER BY trade_date DESC, rank ASC LIMIT ?';
  params.push(options.limit || 100);
  return db.query(sql, params) as LonghuBangRecord[];
}

export function getLatestLonghuBangDate(): string | null {
  const row = db.queryOne('SELECT MAX(trade_date) as d FROM longhu_bang');
  return row?.d || null;
}

// ---------- 交易提醒（trading_alerts） ----------

export interface TradeAlertRecord {
  id?: number;
  alert_type: string;      // opportunity / position_stop / position_reverse / position_target / position_trend / position_timeout / signal_change
  severity: string;        // high / medium / low
  code: string;
  name: string;
  title: string;
  message: string;
  detail?: string;         // JSON 字符串
  is_read?: number;
  push_status?: string;
  created_at?: string;
}

export function saveTradeAlert(alert: TradeAlertRecord): void {
  db.run(
    `INSERT INTO trading_alerts (alert_type, severity, code, name, title, message, detail, is_read, push_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [alert.alert_type, alert.severity, alert.code, alert.name, alert.title, alert.message, alert.detail || '', alert.is_read || 0, alert.push_status || '']
  );
}

export function getTradeAlerts(options: { unreadOnly?: boolean; limit?: number } = {}): TradeAlertRecord[] {
  let sql = 'SELECT * FROM trading_alerts WHERE 1=1';
  const params: any[] = [];
  if (options.unreadOnly) {
    sql += ' AND is_read = 0';
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(options.limit || 100);
  return db.query(sql, params) as TradeAlertRecord[];
}

export function getUnreadAlertCount(): number {
  const row = db.queryOne('SELECT COUNT(*) as c FROM trading_alerts WHERE is_read = 0');
  return row?.c || 0;
}

export function markTradeAlertRead(id: number): void {
  db.run('UPDATE trading_alerts SET is_read = 1 WHERE id = ?', [id]);
}

export function markAllTradeAlertsRead(): void {
  db.run('UPDATE trading_alerts SET is_read = 1');
}

export function clearTradeAlerts(): void {
  db.run('DELETE FROM trading_alerts');
}

/**
 * 查询某品种最近的提醒（用于去重：同一类型 N 分钟内不重复推送）
 */
export function getLatestTradeAlert(code: string, alertType: string): TradeAlertRecord | null {
  const row = db.queryOne(
    `SELECT * FROM trading_alerts WHERE code = ? AND alert_type = ? ORDER BY id DESC LIMIT 1`,
    [code, alertType]
  );
  return row as TradeAlertRecord | null;
}

// ---------- 监控持仓（monitored_positions） ----------

export interface MonitoredPosition {
  id?: number;
  code: string;
  name: string;
  direction: string;      // long / short
  entry_price: number;
  entry_time?: string;
  stop_loss?: number | null;
  target_price?: number | null;
  lots?: number;
  note?: string;
  status?: string;        // active / closed
  created_at?: string;
}

export function saveMonitoredPosition(pos: MonitoredPosition): void {
  db.run(
    `INSERT OR REPLACE INTO monitored_positions (code, name, direction, entry_price, entry_time, stop_loss, target_price, lots, note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [pos.code, pos.name, pos.direction, pos.entry_price, pos.entry_time || new Date().toISOString(), pos.stop_loss ?? null, pos.target_price ?? null, pos.lots || 1, pos.note || '', pos.status || 'active']
  );
}

export function getMonitoredPositions(status = 'active'): MonitoredPosition[] {
  return db.query(
    'SELECT * FROM monitored_positions WHERE status = ? ORDER BY created_at DESC',
    [status]
  ) as MonitoredPosition[];
}

export function getMonitoredPosition(code: string): MonitoredPosition | null {
  const row = db.queryOne('SELECT * FROM monitored_positions WHERE code = ?', [code]);
  return row as MonitoredPosition | null;
}

export function deleteMonitoredPosition(code: string): void {
  db.run('DELETE FROM monitored_positions WHERE code = ?', [code]);
}

export function closeMonitoredPosition(code: string): void {
  db.run("UPDATE monitored_positions SET status = 'closed' WHERE code = ?", [code]);
}

// ---------- 每日信号日报（daily_journal） ----------

export interface DailyJournalRecord {
  id?: number;
  trade_date: string;
  code: string;
  name?: string;
  close?: number;
  change_pct?: number;
  spectrum?: string;
  ai_direction?: string;
  signal_level?: string;
  p_follow?: number;
  adx?: number;
  g4_count?: number;
  one_liner?: string;
  advice?: string;
  ch_direction?: string;
  ch_entry?: number;
  ch_stop?: number;
  ch_target?: number;
  mm_tier1?: number;
  mm_tier2?: number;
  trend_momentum?: number;
  detail_json?: string;
  created_at?: string;
}

export function saveDailyJournal(record: DailyJournalRecord): void {
  db.run(
    `INSERT OR REPLACE INTO daily_journal (trade_date, code, name, close, change_pct, spectrum, ai_direction, signal_level, p_follow, adx, g4_count, one_liner, advice, ch_direction, ch_entry, ch_stop, ch_target, mm_tier1, mm_tier2, trend_momentum, detail_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.trade_date, record.code, record.name || '', record.close || 0, record.change_pct || 0,
      record.spectrum || '', record.ai_direction || '', record.signal_level || '',
      record.p_follow || 0, record.adx || 0, record.g4_count || 0,
      record.one_liner || '', record.advice || '',
      record.ch_direction || '', record.ch_entry || 0, record.ch_stop || 0, record.ch_target || 0,
      record.mm_tier1 || 0, record.mm_tier2 || 0, record.trend_momentum || 0,
      record.detail_json || ''
    ]
  );
}

export function getDailyJournalByDate(tradeDate: string): DailyJournalRecord[] {
  return db.query(
    'SELECT * FROM daily_journal WHERE trade_date = ? ORDER BY signal_level ASC, code ASC',
    [tradeDate]
  ) as DailyJournalRecord[];
}

export function getDailyJournalByCode(code: string, limit = 30): DailyJournalRecord[] {
  return db.query(
    'SELECT * FROM daily_journal WHERE code = ? ORDER BY trade_date DESC LIMIT ?',
    [code, limit]
  ) as DailyJournalRecord[];
}

export function getJournalDates(limit = 400): string[] {
  const rows = db.query(
    'SELECT DISTINCT trade_date FROM daily_journal ORDER BY trade_date DESC LIMIT ?',
    [limit]
  );
  return rows.map(r => r.trade_date);
}

// ---------- 日报建议复盘（journal_review） ----------

export interface JournalReviewRecord {
  id?: number;
  code: string;
  name?: string;
  advice_date: string;
  direction?: string;
  entry_price?: number;
  entry_range_low?: number;
  entry_range_high?: number;
  stop_price?: number;
  target_price?: number;
  signal_level?: string;
  spectrum?: string;
  status?: string;        // pending / entered / stopped / hit_target / expired
  touched_date?: string;
  result?: string;        // win / loss / pending
  result_pnl?: number;
  result_pnl_pct?: number;
  days_held?: number;
  updated_at?: string;
}

export function upsertJournalReview(record: JournalReviewRecord): void {
  db.run(
    `INSERT OR REPLACE INTO journal_review
      (code, name, advice_date, direction, entry_price, entry_range_low, entry_range_high,
       stop_price, target_price, signal_level, spectrum, status, touched_date, result,
       result_pnl, result_pnl_pct, days_held, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.code, record.name || '', record.advice_date, record.direction || '',
      record.entry_price || 0, record.entry_range_low || 0, record.entry_range_high || 0,
      record.stop_price || 0, record.target_price || 0, record.signal_level || '',
      record.spectrum || '', record.status || 'pending', record.touched_date || '',
      record.result || 'pending', record.result_pnl || 0, record.result_pnl_pct || 0,
      record.days_held || 0, new Date().toISOString().slice(0, 19).replace('T', ' ')
    ]
  );
}

export function getPendingJournalReviews(limit = 200): JournalReviewRecord[] {
  return db.query(
    "SELECT * FROM journal_review WHERE status IN ('pending', 'entered') ORDER BY advice_date ASC LIMIT ?",
    [limit]
  ) as JournalReviewRecord[];
}

export function getJournalReviewsByCode(code: string, limit = 50): JournalReviewRecord[] {
  return db.query(
    'SELECT * FROM journal_review WHERE code = ? ORDER BY advice_date DESC LIMIT ?',
    [code, limit]
  ) as JournalReviewRecord[];
}

export function getAllJournalReviews(limit = 500): JournalReviewRecord[] {
  return db.query(
    'SELECT * FROM journal_review ORDER BY advice_date DESC LIMIT ?',
    [limit]
  ) as JournalReviewRecord[];
}

export function getJournalReviewByCodeDate(code: string, date: string): JournalReviewRecord | null {
  const rows = db.query(
    'SELECT * FROM journal_review WHERE code = ? AND advice_date = ?',
    [code, date]
  ) as JournalReviewRecord[];
  return rows.length > 0 ? rows[0] : null;
}

export function updateJournalReview(
  id: number,
  status: string,
  closePrice: number | null,
  closeDate: string | null,
  result: string | null
): void {
  // 迁移：确保 close_price / close_date 列存在（旧库无这两列）
  try {
    const cols = db.query(`PRAGMA table_info(journal_review)`) as any[];
    if (!cols.some((c: any) => c.name === 'close_price')) {
      db.run(`ALTER TABLE journal_review ADD COLUMN close_price REAL`);
    }
    if (!cols.some((c: any) => c.name === 'close_date')) {
      db.run(`ALTER TABLE journal_review ADD COLUMN close_date TEXT`);
    }
  } catch {
    // 迁移失败静默（不影响主流程）
  }
  db.run(
    `UPDATE journal_review SET status = ?, close_price = ?, close_date = ?, result = ? WHERE id = ?`,
    [status, closePrice, closeDate, result, id]
  );
}

export function getJournalReviewStats(): Record<string, any> {
  const total = db.query('SELECT COUNT(*) as cnt FROM journal_review')[0]?.cnt || 0;
  const pending = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE status = 'pending'")[0]?.cnt || 0;
  const entered = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE status = 'entered'")[0]?.cnt || 0;
  const stopped = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE status = 'stopped'")[0]?.cnt || 0;
  const hitTarget = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE status = 'hit_target'")[0]?.cnt || 0;
  const expired = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE status = 'expired'")[0]?.cnt || 0;
  const winCount = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE result = 'win'")[0]?.cnt || 0;
  const lossCount = db.query("SELECT COUNT(*) as cnt FROM journal_review WHERE result = 'loss'")[0]?.cnt || 0;
  const closedCount = winCount + lossCount;
  const winRate = closedCount > 0 ? (winCount / closedCount * 100) : 0;

  // 按信号等级统计胜率
  const byGrade = db.query(
    `SELECT signal_level,
            COUNT(*) as total,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses
     FROM journal_review WHERE result IN ('win', 'loss')
     GROUP BY signal_level ORDER BY signal_level`
  ) as Array<{ signal_level: string; total: number; wins: number; losses: number }>;

  // 按方向统计
  const byDirection = db.query(
    `SELECT direction,
            COUNT(*) as total,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins,
            SUM(CASE WHEN result = 'loss' THEN 1 ELSE 0 END) as losses
     FROM journal_review WHERE result IN ('win', 'loss')
     GROUP BY direction`
  ) as Array<{ direction: string; total: number; wins: number; losses: number }>;

  // 平均盈亏比
  const avgPnlPct = db.query(
    'SELECT AVG(result_pnl_pct) as avg FROM journal_review WHERE result IN (\"win\", \"loss\")'
  )[0]?.avg || 0;

  // 近30天按日分布
  const recent = db.query(
    `SELECT advice_date,
            COUNT(*) as total,
            SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) as wins
     FROM journal_review
     WHERE advice_date >= datetime('now', '-30 days')
     GROUP BY advice_date ORDER BY advice_date DESC LIMIT 30`
  ) as Array<{ advice_date: string; total: number; wins: number }>;

  return {
    total, pending, entered, stopped, hitTarget, expired,
    closed: closedCount, winCount, lossCount, winRate,
    avgPnlPct: Number(avgPnlPct.toFixed(2)),
    byGrade, byDirection, recent
  };
}

// ---------- 模拟交易（sim_trades） ----------

export interface SimTradeRecord {
  id?: number;
  code: string;
  name?: string;
  direction: string;      // 多 / 空
  entry_date: string;
  entry_price: number;
  exit_date?: string | null;
  exit_price?: number | null;
  pnl?: number | null;
  pnl_pct?: number | null;
  status?: string;        // open / closed
  entry_reason?: string;
  exit_reason?: string;
  signal_score?: number | null;
  signal_grade?: string | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  max_hold_days?: number | null;
  cooldown_until?: string | null;
  fee?: number | null;
  position_size?: number | null;  // Kelly 仓位（手数）
  created_at?: string;
}

export function saveSimTrade(trade: SimTradeRecord): number {
  const result = db.prepare(
    `INSERT INTO sim_trades (code, name, direction, entry_date, entry_price, exit_date, exit_price, pnl, pnl_pct, status, entry_reason, exit_reason, signal_score, signal_grade, stop_loss, take_profit, max_hold_days, cooldown_until, fee, position_size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run([
    trade.code, trade.name || '', trade.direction || '多', trade.entry_date, trade.entry_price,
    trade.exit_date ?? null, trade.exit_price ?? null, trade.pnl ?? null, trade.pnl_pct ?? null,
    trade.status || 'open', trade.entry_reason || '', trade.exit_reason || '',
    trade.signal_score ?? null, trade.signal_grade ?? null,
    trade.stop_loss ?? null, trade.take_profit ?? null, trade.max_hold_days ?? 15,
    trade.cooldown_until ?? null, trade.fee ?? 0, trade.position_size ?? 1
  ]) as any;
  return Number(result.lastInsertRowid);
}

export function getSimTrades(options: { status?: string; code?: string; limit?: number } = {}): SimTradeRecord[] {
  let sql = 'SELECT * FROM sim_trades WHERE 1=1';
  const params: any[] = [];
  if (options.status) {
    sql += ' AND status = ?';
    params.push(options.status);
  }
  if (options.code) {
    sql += ' AND code = ?';
    params.push(options.code);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(options.limit || 100);
  return db.query(sql, params) as SimTradeRecord[];
}

export function getSimTradeStats(): { 
  totalTrades: number; 
  winTrades: number; 
  lossTrades: number; 
  totalPnl: number; 
  winRate: number; 
  maxDrawdown: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
} {
  const closed = db.query('SELECT * FROM sim_trades WHERE status = ?', ['closed']) as SimTradeRecord[];
  const totalTrades = closed.length;
  const winTrades = closed.filter(t => (t.pnl || 0) > 0);
  const lossTrades = closed.filter(t => (t.pnl || 0) <= 0);
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? winTrades.length / totalTrades : 0;

  // 计算平均盈利和平均亏损
  const avgWin = winTrades.length > 0 
    ? winTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / winTrades.length 
    : 0;
  const avgLoss = lossTrades.length > 0
    ? Math.abs(lossTrades.reduce((sum, t) => sum + (t.pnl || 0), 0) / lossTrades.length)
    : 0;
  
  // 盈利因子
  const totalWin = winTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const totalLoss = Math.abs(lossTrades.reduce((sum, t) => sum + (t.pnl || 0), 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : 0;

  // 计算最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const t of closed.sort((a, b) => (a.exit_date || '').localeCompare(b.exit_date || ''))) {
    cumulative += t.pnl || 0;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return { 
    totalTrades, 
    winTrades: winTrades.length, 
    lossTrades: lossTrades.length, 
    totalPnl, 
    winRate, 
    maxDrawdown,
    avgWin,
    avgLoss,
    profitFactor,
  };
}

export interface SimPerformance {
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
  longCount: number;
  shortCount: number;
  longWinRate: number;
  shortWinRate: number;
  signalTypeDist: { shock: number; gradual: number };
  signalTypeWinRate: { shockWinRate: number; gradualWinRate: number };
  byVariety: { code: string; name: string; trades: number; wins: number; pnl: number; winRate: number }[];
  equityCurve: { date: string; cumulativePnl: number; tradeCount: number }[];
  monthlyPnl: { month: string; pnl: number; trades: number }[];
  // 高级风险指标
  riskMetrics: {
    sharpeRatio: number;
    sortinoRatio: number;
    calmarRatio: number;
    annualizedReturn: number;
    annualizedVolatility: number;
    tradingDays: number;
  };
}

export function getSimPerformance(): SimPerformance {
  const closed = db.query('SELECT * FROM sim_trades WHERE status = ? ORDER BY exit_date', ['closed']) as SimTradeRecord[];
  const open = db.query('SELECT * FROM sim_trades WHERE status = ?', ['open']) as SimTradeRecord[];
  const totalTrades = closed.length;
  const winTrades = closed.filter(t => (t.pnl || 0) > 0).length;
  const lossTrades = closed.filter(t => (t.pnl || 0) <= 0).length;
  const totalPnl = closed.reduce((sum, t) => sum + (t.pnl || 0), 0);
  const winRate = totalTrades > 0 ? winTrades / totalTrades : 0;

  // 最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  let cumulative = 0;
  for (const t of closed) {
    cumulative += t.pnl || 0;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  // 盈利因子 PF = 总盈利 / 总亏损
  const grossProfit = closed.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
  const grossLoss = Math.abs(closed.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 0);

  // 平均盈亏
  const wins = closed.filter(t => (t.pnl || 0) > 0);
  const losses = closed.filter(t => (t.pnl || 0) < 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length : 0;

  // 平均持有天数
  const holdDays = closed
    .filter(t => t.entry_date && t.exit_date)
    .map(t => {
      const diff = new Date(t.exit_date!).getTime() - new Date(t.entry_date!).getTime();
      return diff / (1000 * 60 * 60 * 24);
    });
  const avgHoldDays = holdDays.length > 0 ? holdDays.reduce((a, b) => a + b, 0) / holdDays.length : 0;

  // 多空分布
  const longTrades = closed.filter(t => t.direction === '多');
  const shortTrades = closed.filter(t => t.direction === '空');
  const longWinRate = longTrades.length > 0 ? longTrades.filter(t => (t.pnl || 0) > 0).length / longTrades.length : 0;
  const shortWinRate = shortTrades.length > 0 ? shortTrades.filter(t => (t.pnl || 0) > 0).length / shortTrades.length : 0;

  // 信号来源分布（渐变趋势在 logic 中含 "+渐变"）
  const gradualCount = closed.filter(t => (t.entry_reason || '').includes('渐变')).length;
  const shockCount = closed.length - gradualCount;
  const gradualWins = closed.filter(t => (t.entry_reason || '').includes('渐变') && (t.pnl || 0) > 0).length;
  const shockWins = closed.filter(t => !(t.entry_reason || '').includes('渐变') && (t.pnl || 0) > 0).length;

  // 品种收益排行
  const varietyMap = new Map<string, { code: string; name: string; trades: number; wins: number; pnl: number }>();
  for (const t of closed) {
    const key = t.code;
    const cur = varietyMap.get(key) || { code: t.code, name: t.name || t.code, trades: 0, wins: 0, pnl: 0 };
    cur.trades++;
    if ((t.pnl || 0) > 0) cur.wins++;
    cur.pnl += t.pnl || 0;
    varietyMap.set(key, cur);
  }
  const byVariety = Array.from(varietyMap.values())
    .map(v => ({ ...v, winRate: v.trades > 0 ? v.wins / v.trades : 0 }))
    .sort((a, b) => b.pnl - a.pnl);

  // 收益曲线（按退出日期累计）
  const equityCurve: { date: string; cumulativePnl: number; tradeCount: number }[] = [];
  let runningPnl = 0;
  let runningCount = 0;
  for (const t of closed) {
    runningPnl += t.pnl || 0;
    runningCount++;
    equityCurve.push({
      date: t.exit_date || t.entry_date,
      cumulativePnl: Math.round(runningPnl * 100) / 100,
      tradeCount: runningCount,
    });
  }

  // 月度收益
  const monthMap = new Map<string, { month: string; pnl: number; trades: number }>();
  for (const t of closed) {
    const month = (t.exit_date || t.entry_date || '').substring(0, 7);
    if (!month) continue;
    const cur = monthMap.get(month) || { month, pnl: 0, trades: 0 };
    cur.pnl += t.pnl || 0;
    cur.trades++;
    monthMap.set(month, cur);
  }
  const monthlyPnl = Array.from(monthMap.values()).sort((a, b) => a.month.localeCompare(b.month));

  // 高级风险指标计算
  const riskFreeRate = 0.02; // 无风险利率 2%
  const tradingDaysPerYear = 252;

  // 计算交易天数跨度
  const firstDate = closed.length > 0 ? new Date(closed[0].exit_date || closed[0].entry_date || '') : new Date();
  const lastDate = closed.length > 0 ? new Date(closed[closed.length - 1].exit_date || closed[closed.length - 1].entry_date || '') : new Date();
  const tradingDays = Math.max(1, Math.round((lastDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24)));

  // 年化收益率 (复利)
  const totalReturn = totalPnl / 100; // 转换为小数
  const annualizedReturn = tradingDays > 0 ? Math.pow(1 + totalReturn, tradingDaysPerYear / tradingDays) - 1 : 0;

  // 计算每日收益率序列 (基于累计收益曲线)
  const dailyReturns: number[] = [];
  let prevCumPnl = 0;
  const pnlByDate = new Map<string, number>();
  for (const t of closed) {
    const date = t.exit_date || t.entry_date || '';
    if (!date) continue;
    pnlByDate.set(date, (pnlByDate.get(date) || 0) + (t.pnl || 0));
  }
  const sortedDates = Array.from(pnlByDate.keys()).sort();
  for (const date of sortedDates) {
    const dailyPnl = pnlByDate.get(date) || 0;
    dailyReturns.push(dailyPnl / 100); // 转换为小数
  }

  // 年化波动率
  const avgDailyReturn = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const dailyVariance = dailyReturns.length > 0
    ? dailyReturns.reduce((sum, r) => sum + Math.pow(r - avgDailyReturn, 2), 0) / dailyReturns.length
    : 0;
  const dailyStdDev = Math.sqrt(dailyVariance);
  const annualizedVolatility = dailyStdDev * Math.sqrt(tradingDaysPerYear);

  // Sharpe Ratio = (年化收益 - 无风险利率) / 年化波动率
  const sharpeRatio = annualizedVolatility > 0 ? (annualizedReturn - riskFreeRate) / annualizedVolatility : 0;

  // Sortino Ratio = (年化收益 - 无风险利率) / 下行偏差
  const downsideReturns = dailyReturns.filter(r => r < 0);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((sum, r) => sum + Math.pow(r, 2), 0) / downsideReturns.length
    : 0;
  const downsideDeviation = Math.sqrt(downsideVariance) * Math.sqrt(tradingDaysPerYear);
  const sortinoRatio = downsideDeviation > 0 ? (annualizedReturn - riskFreeRate) / downsideDeviation : 0;

  // Calmar Ratio = 年化收益 / 最大回撤
  const maxDrawdownDecimal = maxDrawdown / 100;
  const calmarRatio = maxDrawdownDecimal > 0 ? annualizedReturn / maxDrawdownDecimal : 0;

  return {
    totalTrades,
    winTrades,
    lossTrades,
    totalPnl: Math.round(totalPnl * 100) / 100,
    winRate,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    avgHoldDays: Math.round(avgHoldDays * 10) / 10,
    longCount: longTrades.length,
    shortCount: shortTrades.length,
    longWinRate,
    shortWinRate,
    signalTypeDist: { shock: shockCount, gradual: gradualCount },
    signalTypeWinRate: { shockWinRate: shockCount > 0 ? shockWins / shockCount : 0, gradualWinRate: gradualCount > 0 ? gradualWins / gradualCount : 0 },
    byVariety,
    equityCurve,
    monthlyPnl,
    // 高级风险指标
    riskMetrics: {
      sharpeRatio: Math.round(sharpeRatio * 100) / 100,
      sortinoRatio: Math.round(sortinoRatio * 100) / 100,
      calmarRatio: Math.round(calmarRatio * 100) / 100,
      annualizedReturn: Math.round(annualizedReturn * 10000) / 100,
      annualizedVolatility: Math.round(annualizedVolatility * 10000) / 100,
      tradingDays,
    },
  };
}

export function closeSimTrade(code: string, data: { exit_date: string; exit_price: number; exit_reason: string; fee?: number }): void {
  const trade = db.queryOne(
    'SELECT * FROM sim_trades WHERE code = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [code, 'open']
  ) as SimTradeRecord | null;
  if (!trade) return;

  const dir = trade.direction === '多' ? 1 : -1;
  const grossPnl = (data.exit_price - trade.entry_price) * dir;
  const pnlPct = trade.entry_price > 0 ? (grossPnl / trade.entry_price) * 100 : 0;
  // 扣除手续费（开仓+平仓双边）
  const fee = data.fee ?? 0;
  const netPnl = grossPnl - fee;

  db.run(
    `UPDATE sim_trades SET exit_date = ?, exit_price = ?, pnl = ?, pnl_pct = ?, status = 'closed', exit_reason = ?, fee = ? WHERE id = ?`,
    [data.exit_date, data.exit_price, netPnl, pnlPct, data.exit_reason, fee, trade.id]
  );
}

export function getOpenSimTrade(code: string): SimTradeRecord | null {
  const row = db.queryOne(
    'SELECT * FROM sim_trades WHERE code = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [code, 'open']
  );
  return row as SimTradeRecord | null;
}

// ---------- 事件日报（event_daily_reports） ----------
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

export function saveEventDailyReport(record: EventDailyReportRecord): void {
  db.run(
    `INSERT OR REPLACE INTO event_daily_reports (id, event_id, event_date, title, category, generated_at, report_json, is_realtime)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.id,
      record.event_id,
      record.event_date,
      record.title,
      record.category,
      record.generated_at,
      record.report_json,
      record.is_realtime ?? 0,
    ]
  );
}

export function getEventDailyReports(limit = 50): EventDailyReportRecord[] {
  return db.query(
    'SELECT * FROM event_daily_reports ORDER BY generated_at DESC LIMIT ?',
    [limit]
  ) as EventDailyReportRecord[];
}

export function getEventDailyReportById(id: string): EventDailyReportRecord | null {
  return db.queryOne(
    'SELECT * FROM event_daily_reports WHERE id = ?',
    [id]
  ) as EventDailyReportRecord | null;
}

export function getEventDailyReportByEventId(eventId: string): EventDailyReportRecord | null {
  return db.queryOne(
    'SELECT * FROM event_daily_reports WHERE event_id = ? ORDER BY generated_at DESC LIMIT 1',
    [eventId]
  ) as EventDailyReportRecord | null;
}

export default db;
