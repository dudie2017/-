/**
 * Brooks V16.2 信号驱动引擎类型定义
 * V16.2 定版指标: 1276笔/胜率46.0%/¥835,474/Sharpe 5.410/回撤-¥41,414
 */

// === V16.2 核心输出行 ===
export interface V16Row {
  // 基础信息
  code: string;
  name: string;
  contract: string;
  close: number;
  ret_pct: number;

  // 技术面
  spectrum: string;          // 光谱定位
  spectrum_detail?: string;   // V18频谱详情
  ai_direction: string;      // AI方向: 多/空/中性
  trend_strength: number;    // 趋势强度 0-100
  atr14: number;             // 14周期ATR
  adx: number;               // ADX值
  ema20?: number;            // EMA20（品种级趋势过滤用）
  ema50?: number;            // EMA50（品种级趋势过滤用）

  // P(顺) 方向概率 (Softmax三情景)
  p_follow: number;          // 顺势概率 (0-1)
  p_counter: number;         // 逆势概率 (0-1)
  market_context: string;    // 市场环境: 强趋势/弱趋势/区间震荡/高波动

  // Gate4 v3 决策门 (≥3/5才通过)
  g4_pass: boolean;          // 是否通过Gate4
  g4_reason_count: number;   // 通过的理由数
  g4_reasons_met: string[];  // 通过的理由列表
  g4_verdict: string;        // Gate4判定: 通过/不通过+原因

  // CH通道边界信号 (豁免P/Gate4)
  ch_has_signal: boolean;
  ch_direction: string;      // 通道方向: 多/空/无
  ch_entry: number | null;
  ch_stop: number | null;
  ch_target: number | null;
  ch_strength: string;       // 通道信号强度: 强/中/弱

  // 楔形reversal过滤
  wedge_found: boolean;
  wedge_filter_on: boolean;  // 楔形是否过滤掉信号
  wedge_filtered_dir: string; // 被过滤的方向

  // MM测量运动 (5变体3层目标位)
  mm_found: boolean;
  mm_direction: string;
  mm_tier1: number | null;
  mm_tier2: number | null;
  mm_tier3: number | null;
  mm_variant_count: number;

  // Final Flag / LC阶段
  ff_found: boolean;
  ff_label: string;
  lc_stage: string;          // 生命周期阶段
  fw_rank: number;           // Follow-Through排名
  fw_type_cn: string;        // Follow-Through类型中文

  // Edge统计验证 (Simons统计)
  edge_status: string;       // 边缘状态: active/inactive/expired
  edge_grade: string;        // 边缘等级: A/B/C/D
  disc_ladder: number;       // 纪律阶梯: 0-4

  // 穿透/筛选状态
  trade_worthiness: string;  // 可交易性: tradable/filtered/观望

  // 持仓量信号
  oi_signal: string;         // 持仓量信号
  oi_grade?: string;         // V18量仓评级
  oi_change_pct: number;     // 持仓量变化
  trend_exhaustion?: string | null;  // V18趋势衰竭

  // 回测统计
  win_rate_20: number | null;  // 近20笔胜率
  avg_rr: number | null;       // 平均盈亏比

  // 关键位标注 (基于真实K线计算)
  key_levels?: KeyLevels;

  // V17 增强层字段
  signal_grade?: string;       // 信号综合等级: L0/L1/L2/L3/L4
  signal_variant?: string;     // 信号子类型: S/A+/A/A-/B+
  tight_channel?: boolean;     // 是否紧通道（V17规则1命中）
  tight_channel_detail?: {     // 紧通道详情
    c1_side: boolean;
    c2_slope: boolean;
    c3_drawback: boolean;
    c4_pullback: boolean;
    c5_vol_contraction?: boolean;
    c6_range_compression?: boolean;
    c7_duration?: boolean;
    side_n: number;
    max_dd_pct: number;
    max_adverse_run: number;
    vol_ratio?: number;
    range_ratio?: number;
    tight_days?: number;
  };
  watch_list?: boolean;        // 是否在观察档（V17规则3）

  // P0-3: 多时间框架共振字段 (Brooks MTF)
  mtf_resonance?: {
    htf_direction: '多' | '空' | '中性';  // 日线方向（Higher TF）
    ttf_direction: '多' | '空' | '中性';  // 60min方向（Trading TF）
    ltf_signal: '多' | '空' | '无';       // 15min信号K线
    ltf_ft: boolean;                       // 5min follow-through
    resonance: 'full' | 'partial' | 'conflict' | 'none';
    htf_trend_phase: '强趋势' | '通道' | '区间' | '紧通道';
    ttf_pullback: boolean;                 // 60min是否在回踩
    ltf_entry_ready: boolean;              // 15min入场条件就绪
  };
  data_freshness?: 'realtime' | 'cached' | 'stale'; // 数据时效

  // P1: 方向阵营降级
  direction_camp_warning?: string;     // 阵营警告信息
  position_multiplier?: number;        // 仓位倍率（默认1.0）
  mtf_warning?: string;                // MTF共振警告（如"冲突共振"）

  // V17 L1入场：紧通道是否已触发L1规则
  l1_triggered?: boolean;
  l1_entry_price?: number | null;
  l1_position_multiplier?: number;

  // V17 Edge衰减状态: HEALTHY/WARNING/DECAYING/DEAD
  edge_decay?: string;

  // P1-⑦ Simons二项检验
  edge_p_value?: number | null;       // 二项检验p-value
  edge_wilson_ci_low?: number | null;  // Wilson置信区间下界
  edge_wilson_ci_high?: number | null; // Wilson置信区间上界

  // P1-⑤ V15混合引擎
  hybrid_factor?: number;  // V15/V18混合频谱因子

  // C3 强趋势逆势抑制
  trend_momentum?: number;  // 200-bar动量（30min≈14天），正=上涨，负=下跌
}

// === 关键位标注 (Brooks复盘模板) ===
export interface KeyLevels {
  ema20: number;            // 20周期EMA (真实计算)
  prev_high: number;        // 前一根K线高点
  prev_low: number;         // 前一根K线低点
  range_high_20: number;    // 近20日高点 (价格运行区间上限)
  range_low_20: number;     // 近20日低点 (价格运行区间下限)
  support: number;          // 支撑位 (最近swing low, 兜底10日低点)
  resistance: number;       // 阻力位 (最近swing high, 兜底10日高点)
}

// === V16.2 扫描结果 ===
export interface V16ScanResult {
  scanTime: string;
  totalCount: number;
  tradableCount: number;
  filteredCount: number;
  rows: V16Row[];
  tradable: V16Row[];
  filtered: { code: string; name: string; reason: string }[];
  timing: { scan: number; filter: number; total: number };
}

// === direction camps ===
export type DirectionCamp = 'LONG21' | 'SHORT21' | 'NEUTRAL10';

// 方向阵营状态
export interface DirectionCampResult {
  camp: DirectionCamp;
  longCount: number;
  shortCount: number;
  neutralCount: number;
  isGreen: boolean;  // GREEN可进，其他跳过
}

// === P(顺) 情景概率 ===
export interface DirectionalProbability {
  p_follow: number;    // 顺势概率
  p_counter: number;   // 逆势概率
  p_range: number;     // 区间概率
  context: string;     // 市场环境判定
}

// === Gate4 理由 ===
export interface Gate4Result {
  passed: boolean;
  reasonCount: number;
  reasons: string[];
  verdict: string;
}

// === 楔形过滤 ===
export interface WedgeFilterResult {
  found: boolean;
  isReversal: boolean;   // 是否为反转楔形
  direction: string;     // 楔形方向
  filteredDir: string;   // 被过滤的方向(如楔形为多则过滤空信号)
}

// === CH通道信号 ===
export interface CHSignal {
  hasSignal: boolean;
  direction: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  strength: string;
}

// === MM测量运动 ===
export interface MMMeasurement {
  found: boolean;
  direction: string;
  tier1: number | null;
  tier2: number | null;
  tier3: number | null;
  variantCount: number;
}

// === 品种引用 ===
export interface V16VarietyRef {
  code: string;
  name: string;
  exchange: string;
  category: string;
  contractMultiplier: number;
}
