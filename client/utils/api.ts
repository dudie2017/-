import Constants from 'expo-constants';

// 后端URL候选列表（按优先级排序）
function getBackendUrlCandidates(): string[] {
  const candidates: string[] = [];

  // 0. app.config.ts extra 中配置的 URL（手机端最可靠来源，构建时注入公网域名）
  const extraUrl = Constants.expoConfig?.extra?.backendBaseURL as string | undefined;
  if (extraUrl) {
    candidates.push(extraUrl);
  }

  // 1. 环境变量（最高优先级）
  if (process.env.EXPO_PUBLIC_BACKEND_BASE_URL) {
    candidates.push(process.env.EXPO_PUBLIC_BACKEND_BASE_URL);
  }

  // 2. Web环境：使用当前域名
  if (typeof window !== 'undefined' && window.location) {
    const hostname = window.location.hostname;
    if (hostname.includes('dev.coze.site')) {
      const protocol = window.location.protocol;
      // coze 代理会将 /api/v1/* 转发到后端，直接使用同域最可靠
      candidates.push(`${protocol}//${hostname}`);
    } else if (hostname !== 'localhost' && hostname !== '127.0.0.1') {
      // 非本地环境，尝试使用当前域名
      candidates.push(`${window.location.protocol}//${hostname}`);
    }
  }

  // 3. 原生端（手机）：通过 Expo hostUri 推断后端地址
  //    hostUri 形如 "192.168.x.x:8081" 或 "dfb897ac-xxx.dev.coze.site"
  if (typeof window === 'undefined') {
    const hostUri = (Constants.expoConfig?.hostUri ||
      Constants.expoGoConfig?.debuggerHost) as string | undefined;
    if (hostUri) {
      const host = hostUri.split(':')[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        if (host.includes('dev.coze.site')) {
          candidates.push(`https://${host}`);
        } else {
          // 局域网开发：后端与 Expo 服务同机
          candidates.push(`http://${host}:9091`);
          candidates.push(`http://${host}:5000`);
        }
      }
    }

    // 4. 从项目ID构建URL（最后兜底）
    const projectId =
      process.env.EXPO_PUBLIC_COZE_PROJECT_ID || process.env.COZE_PROJECT_ID;
    if (projectId) {
      candidates.push(`https://app${projectId}.dev.coze.site`);
    }
  }

  // 5. 本地开发（最低优先级）- 仅在开发环境使用
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    candidates.push('http://localhost:9091');
    candidates.push('http://localhost:5000');
  }

  return candidates;
}

// 获取后端URL（同步版本，用于初始化）
export function getBackendBaseUrl(): string {
  const candidates = getBackendUrlCandidates();
  return candidates[0] || 'http://localhost:9091';
}

// 后端根地址（带完整兜底逻辑，手机端也可用）——所有页面/工具统一从这里取，禁止直接读 process.env
export const BACKEND_BASE = getBackendBaseUrl();

// 测试URL是否可访问
export async function testBackendUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(`${url}/api/v1/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    
    clearTimeout(timeoutId);
    return response.ok;
  } catch {
    return false;
  }
}

// 自动检测可用的后端URL
export async function detectBackendUrl(): Promise<string> {
  const candidates = getBackendUrlCandidates();
  
  for (const url of candidates) {
    const isAvailable = await testBackendUrl(url);
    if (isAvailable) {
      console.log(`[API] 找到可用的后端URL: ${url}`);
      return url;
    }
  }
  
  console.warn('[API] 所有候选URL均不可用，使用默认URL');
  return candidates[0] || 'http://localhost:9091';
}

const BASE_URL = getBackendBaseUrl();
export const API_BASE = `${BASE_URL}/api/v1`;

// 统一带超时的 fetch 封装（默认 15s，可自定义），避免网络异常时前端无限挂起
export async function fetchWithTimeout(input: string, init?: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

// 导出候选URL列表供调试使用
export const BACKEND_URL_CANDIDATES = getBackendUrlCandidates();

export interface VarietyItem {
  code: string;
  name: string;
  contract: string;
  close: number;
  change_pct: number;
  spectrum: string;
  ai_direction: string;
  bar_identity: string;
  buy_sell_pressure: string;
  breakout_score: number;
  breakout_label: string;
  trend_strength: number;
  trend_label: string;
  ai_flip: boolean;
  signal_level: 'strong' | 'moderate' | 'weak' | 'none';
  signals: string[];
  // V16.2 字段
  g4_count?: number;  // Gate4 通过数 (0-5)
  edge_grade?: 'A' | 'B' | 'C' | 'D';  // Edge 统计等级
  p_follow?: number;  // P(顺) 概率
  win_rate_20?: number | null;  // Edge 历史胜率（近20次同类信号统计）
  atr14?: number;  // ATR(14)，用于止损距离/入场时机评估
  one_liner?: string;  // 一句话分析总结
  advice?: string;  // 文字性投资建议（方向/入场/止损/目标/风险提示）
  // 旧字段（兼容）
  signal_strength_score?: number;
  oversold_score?: number;
  oversold_signal?: string;
  consec_down_days?: number;
  dev_ma20?: number;
  // V17 增强层字段
  signal_grade?: string;       // L0/L1/L2/L3/L4
  signal_variant?: string;     // S/A+/A/A-/B+
  tight_channel?: boolean;     // 紧通道标记
  watch_list?: boolean;        // 观察档标记

  // 关键位标注 (后端基于真实K线计算)
  key_levels?: {
    ema20: number;
    prev_high: number;
    prev_low: number;
    range_high_20: number;
    range_low_20: number;
    support: number;
    resistance: number;
  } | null;

  // 价格行为分析 (Brooks视角增强)
  price_action?: {
    ema20_slope: number;                 // EMA20近5日斜率
    above_ema20: boolean;                // 价格是否在EMA20上方
    always_in: '多头' | '空头' | '中性';  // Always In方向
    structural_support: number | null;   // 结构支撑 (摆动低点)
    structural_resistance: number | null; // 结构阻力 (摆动高点)
    support_levels: number[];            // 结构支撑位列表
    resistance_levels: number[];         // 结构阻力位列表
    double_bottom: boolean;              // 是否有双底结构
    double_bottom_level: number | null;  // 双底价位
    double_top: boolean;                 // 是否有双顶结构
    double_top_level: number | null;     // 双顶价位
    failed_breakout: boolean;            // 是否有突破失败
    failed_breakout_desc: string;        // 突破失败描述
    recent_bars: Array<{                 // 最近5根日线
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      change_pct: number;
      body_pct: number;                  // 实体占比
      direction: '阳线' | '阴线' | '十字星';
    }>;
    trend_context: string;               // 趋势背景描述
  } | null;

  // 品种稳健性分级（1000次回测三维度：盈利占比/稳健率/崩溃率）
  grade?: 'A' | 'B' | 'C' | 'D';        // 稳健性等级
  grade_label?: string;                 // 等级标签（稳健底仓/可用/脆弱/失效）
  robust_pct?: number;                  // 稳健率 0~1
  crash_pct?: number;                   // 崩溃率 0~1
  profitable_pct?: number;              // 盈利占比 0~1

  // 可交易性终判（后端 buildV16Tradable 最终结果）
  trade_worthiness?: string;            // 'tradable' | 'filtered' | '观望'
  // 实盘校准分级（融合1000次回测 + 实盘表现）
  calibrated_grade?: string;            // 'A' | 'B' | 'C' | 'D'
  calibrated_grade_label?: string;      // 校准后等级标签
  calibration_note?: string;            // 校准说明
}

export interface MarketSummary {
  total: number;
  aiLongCount: number;
  aiShortCount: number;
  spectrumCounts: Record<string, number>;
  marketState: string;
  marketAdvice: string;
  strongSignalCount: number;
  oversoldCount: number;
}

export interface ScanDetail {
  // 基础信息
  code: string;
  name: string;
  contract: string;
  close: number;
  change_pct: number;
  scan_time?: string;         // 数据扫描时间 (ISO string)
  
  // V16.2 核心字段
  spectrum: string;           // 光谱定位
  ai_direction: string;       // AI方向 (多/空/中性)
  trend_strength: number;     // 趋势强度 0-100
  atr14: number;              // ATR
  adx: number;                // ADX
  p_follow: number;           // 顺势概率
  p_counter: number;          // 逆势概率
  market_context: string;     // 市场环境
  
  // Gate4
  g4_pass: boolean;
  g4_reason_count: number;
  g4_reasons_met: string[];
  g4_verdict: string;
  
  // CH通道信号
  ch_has_signal: boolean;
  ch_direction: string;
  ch_entry: number | null;
  ch_stop: number | null;
  ch_target: number | null;
  ch_strength: string;
  
  // 楔形
  wedge_found: boolean;
  wedge_filter_on: boolean;
  wedge_filtered_dir: string;
  
  // MM测距
  mm_found: boolean;
  mm_direction: string;
  mm_tier1: number | null;
  mm_tier2: number | null;
  mm_tier3: number | null;
  mm_variant_count: number;
  
  // Final Flag / LC
  ff_found: boolean;
  ff_label: string;
  lc_stage: string;
  lc_desc: string;
  fw_rank: number;
  fw_type_cn: string;
  ft_status: string;
  account_discipline?: {
    level: number;
    consecutive_losses: number;
    recent_results: Array<'win' | 'loss'>;
  } | null;
  
  // Edge统计
  edge_status: string;
  edge_grade: string;
  disc_ladder: number;
  
  // 持仓量
  oi_signal: string;
  oi_change_pct: number;
  
  // 回测统计
  win_rate_20: number | null;
  avg_rr: number | null;
  
  // 可交易性
  trade_worthiness: string;
  advice?: string;               // 文字性交易建议（方向/入场/止损/目标/风险提示）
  
  // 兼容旧字段（用于列表页）
  signals: string[];
  signal_level: 'strong' | 'moderate' | 'weak' | 'none';
  signal_strength_score: number;
  bar_identity: string;
  buy_sell_pressure: string;
  ai_flip: boolean;
  trend_label: string;
  breakout_score: number;
  breakout_label: string;
  oversold_score?: number;
  oversold_signal?: string;
  consec_down_days?: number;
  dev_ma20?: number;

  // 关键位标注 (后端基于真实K线计算)
  key_levels?: {
    ema20: number;
    prev_high: number;
    prev_low: number;
    range_high_20: number;
    range_low_20: number;
    support: number;
    resistance: number;
  } | null;

  // 价格行为分析 (后端基于日线聚合 + 摆动结构计算)
  price_action?: {
    generatedAt: string;
    dailyBars: { date: string; o: number; h: number; l: number; c: number; vol: number }[];
    ema: { ema20: number; slope5: number; aboveEma: boolean; alwaysIn: string };
    last3Candles: { date: string; o: number; h: number; l: number; c: number; change: number }[];
    swingStructures: { type: string; price: number; date: string }[];
    doubleStructure: string;
    breakoutTest: string;
    riskReward: { rrNow: number | null; rrPullback: number | null; pullbackText: string };
  } | null;

  // 价格行为摘要 (轻量版，用于列表页)
  pa_summary?: {
    alwaysIn: string;
    ema20: number;
    slope5: number;
    support: number | null;
    resistance: number | null;
  } | null;
}

// 信号历史统计
export interface SignalStats {
  tradeStats: {
    totalTrades: number;
    winningTrades: number;
    losingTrades: number;
    winRate: number;
    avgWinPct: number;
    avgLossPct: number;
    profitFactor: number;
    longTrades: number;
    longWinRate: number;
    shortTrades: number;
    shortWinRate: number;
  };
  signalGradeStats: Array<{
    grade: string;
    total: number;
    wins: number;
    losses: number;
    winRate: number;
  }>;
  recentSignals: Array<{
    date: string;
    direction: string;
    grade: string;
    spectrum: string;
    edge: number;
    close: number;
  }>;
}

export interface AlertData {
  oversold: ScanDetail[];
  linkage: {
    alerts: {
      group: string;
      leader: string;
      leaderName: string;
      signal: string;
      signalDir: string;
      members: { code: string; name: string; aiDir: string; status: string }[];
    }[];
  };
  strongSignals: VarietyItem[];
}

// 获取市场概览 (V16.2 格式适配)
// 60s 超时：scan 冷启动（缓存过期时）需全量扫描约 26s，15s 默认超时会导致首页空白
export async function fetchMarketSummary(): Promise<{ summary: MarketSummary; results: VarietyItem[]; scanTime: string }> {
  const resp = await fetchWithTimeout(`${API_BASE}/scan/summary`, {}, 60000);
  if (!resp.ok) throw new Error('获取市场数据失败');
  const data = await resp.json();
  
  // V16.2 API 返回 { scanTime, rows, tradable, filtered, timing }
  // 优先使用 rows（全部品种），如果不存在则用 tradable
  const rows = data.rows || data.tradable || [];
  
  const results: VarietyItem[] = rows.map((row: any) => {
    // 映射AI方向（V16.2 返回中文"多"/"空"）
    let aiDir = row.ai_direction || 'NEUTRAL';
    if (aiDir === '多') aiDir = 'LONG';
    else if (aiDir === '空') aiDir = 'SHORT';
    
    // 确定信号等级（后端 trade_worthiness 是最终可交易性判定）
    let signalLevel: 'strong' | 'moderate' | 'weak' | 'none' = 'none';
    const isTradable = row.trade_worthiness === 'tradable';
    if (isTradable && row.g4_pass) signalLevel = 'strong';
    else if (isTradable) signalLevel = 'moderate';
    else if (!isTradable && row.g4_reason_count && row.g4_reason_count <= 2) signalLevel = 'weak';
    
    return {
      code: row.code || '',
      name: row.name || '',
      contract: row.contract || '',
      close: row.close || 0,
      change_pct: row.ret_pct || row.change_pct || 0,
      spectrum: row.spectrum_position || row.spectrum || '区间',
      ai_direction: aiDir,
      bar_identity: row.lc_stage || row.bar_identity || '未知',
      buy_sell_pressure: row.fw_type_cn || row.buy_sell_pressure || '均衡',
      breakout_score: row.trend_strength || row.breakout_score || 0,
      breakout_label: row.market_context || row.breakout_label || '',
      trend_strength: row.trend_strength || 0,
      trend_label: row.g4_verdict || row.trend_label || '',
      ai_flip: row.ch_has_signal || row.ai_flip || false,
      signal_level: signalLevel,
      signals: row.g4_reasons_met || row.signals || [],
      // V16.2 字段映射
      g4_count: row.g4_reason_count ?? row.g4_count ?? 0,
      edge_grade: row.edge_grade || undefined,
      p_follow: row.p_follow ?? 0,
      win_rate_20: row.win_rate_20 ?? null,
      atr14: row.atr14 ?? 0,
      one_liner: row.one_liner || '',
      advice: row.advice || '',
      // 关键位标注（后端基于真实K线计算，用于止损/目标预填）
      key_levels: row.key_levels || null,
      // V17 增强层字段
      signal_grade: row.signal_grade || undefined,
      signal_variant: row.signal_variant || undefined,
      tight_channel: row.tight_channel || false,
      watch_list: row.watch_list || false,
      // 可交易性终判（buildV16Tradable 最终结果）
      trade_worthiness: row.trade_worthiness || '观望',
      // 实盘校准分级（融合1000次回测 + 实盘表现）
      calibrated_grade: row.calibrated_grade || undefined,
      calibrated_grade_label: row.calibrated_grade_label || undefined,
      calibration_note: row.calibration_note || undefined,
      // 旧字段（兼容）
      signal_strength_score: row.g4_reason_count || row.signal_strength_score || 0,
      oversold_score: row.edge_p_value ? (1 - row.edge_p_value) * 100 : (row.oversold_score || 0),
      oversold_signal: row.edge_status || row.oversold_signal || 'inactive',
    };
  });
  
  // 构建市场摘要
  const aiLongCount = results.filter(r => r.ai_direction === 'LONG').length;
  const aiShortCount = results.filter(r => r.ai_direction === 'SHORT').length;
  const spectrumCounts: Record<string, number> = {};
  results.forEach(r => {
    spectrumCounts[r.spectrum] = (spectrumCounts[r.spectrum] || 0) + 1;
  });
  
  const tradableCount = data.tradableCount || data.tradable?.length || 0;
  const totalCount = data.totalCount || data.total || rows.length;
  
  const summary: MarketSummary = {
    total: totalCount,
    aiLongCount,
    aiShortCount,
    spectrumCounts,
    marketState: `V16.2扫描: ${tradableCount}/${totalCount}个品种可交易`,
    marketAdvice: tradableCount > 0 ? '存在交易机会，注意风险控制' : '当前无明确交易信号',
    strongSignalCount: results.filter(r => r.signal_level === 'strong').length,
    oversoldCount: results.filter(r => r.oversold_signal === 'active').length,
  };
  
  return { summary, results, scanTime: data.scanTime || '' };
}

/** 强制刷新数据（重新从API拉取K线，清除24h缓存） */
export async function fetchRefreshScan(): Promise<{ success: boolean; total: number; tradable: number; filtered: number }> {
  // 60s 超时：强制刷新会清除缓存并全量扫描（约 26s+），15s 默认超时会误报失败
  const resp = await fetchWithTimeout(`${API_BASE}/scan/refresh`, {}, 60000);
  if (!resp.ok) throw new Error('刷新扫描失败');
  return resp.json();
}

// 获取品种可用合约列表
export async function fetchAvailableContracts(code: string): Promise<Array<{ contract: string; name: string; volume: number; is_main: boolean }>> {
  const resp = await fetchWithTimeout(`${API_BASE}/contracts/${code}`);
  if (!resp.ok) throw new Error('获取合约列表失败');
  const data = await resp.json();
  return data.contracts || [];
}

// 获取单品种详情 (V16.2 格式适配)
export async function fetchVarietyDetail(code: string): Promise<ScanDetail> {
  const resp = await fetchWithTimeout(`${API_BASE}/scan/${code}`, {}, 30000);
  if (!resp.ok) throw new Error('获取品种详情失败');
  const row = await resp.json();
  
  // 映射AI方向
  let aiDir = row.ai_direction || '中性';
  if (aiDir === '多') aiDir = 'LONG';
  else if (aiDir === '空') aiDir = 'SHORT';
  
  // 确定信号等级
  let signalLevel: 'strong' | 'moderate' | 'weak' | 'none' = 'none';
  if (row.trade_worthiness === 'tradable' && row.g4_pass) signalLevel = 'strong';
  else if (row.trade_worthiness === 'tradable') signalLevel = 'moderate';
  else if (row.trade_worthiness !== 'tradable' && row.g4_reason_count > 0) signalLevel = 'weak';
  
  return {
    code: row.code || '',
    name: row.name || '',
    contract: row.contract || '',
    close: row.close || 0,
    change_pct: row.change_pct || row.ret_pct || 0,
    scan_time: row.scan_time || '',
    spectrum: row.spectrum || '区间',
    ai_direction: aiDir,
    trend_strength: row.trend_strength || 0,
    atr14: row.atr14 || 0,
    adx: row.adx || 0,
    p_follow: row.p_follow || row.p_shun || 0,
    p_counter: row.p_counter || 0,
    market_context: row.market_context || '',
    g4_pass: row.g4_pass || false,
    g4_reason_count: row.g4_reason_count || row.gate4_count || 0,
    g4_reasons_met: row.g4_reasons_met || row.gate4_reasons || [],
    g4_verdict: row.g4_verdict || row.filter_reason || '',
    ch_has_signal: row.ch_has_signal || false,
    ch_direction: row.ch_direction || row.camp || '无',
    ch_entry: row.ch_entry || null,
    ch_stop: row.ch_stop || row.mm_stop || null,
    ch_target: row.ch_target || null,
    ch_strength: row.ch_strength || '弱',
    wedge_found: row.wedge_found || false,
    wedge_filter_on: row.wedge_filter_on || false,
    wedge_filtered_dir: row.wedge_filtered_dir || '无',
    mm_found: row.mm_found || false,
    mm_direction: row.mm_direction || '无',
    mm_tier1: row.mm_tier1 || row.mm_target1 || null,
    mm_tier2: row.mm_tier2 || null,
    mm_tier3: row.mm_tier3 || null,
    mm_variant_count: row.mm_variant_count || row.mm_variant || 0,
    ff_found: row.ff_found || false,
    ff_label: row.ff_label || '',
    lc_stage: row.lc_stage || '未知',
    lc_desc: row.lc_desc || '',
    fw_rank: row.fw_rank || 0,
    fw_type_cn: row.fw_type_cn || '未知',
    ft_status: row.ft_status || row.fw_type_cn || '未知',
    account_discipline: (row.account_discipline as ScanDetail['account_discipline']) || null,
    edge_status: row.edge_status || 'inactive',
    edge_grade: row.edge_grade || 'D',
    disc_ladder: row.disc_ladder || row.discipline_status || 0,
    oi_signal: row.oi_signal || '稳定',
    oi_change_pct: row.oi_change_pct || 0,
    win_rate_20: row.win_rate_20 || null,
    avg_rr: row.avg_rr || null,
    trade_worthiness: row.trade_worthiness || row.decision || 'filtered',
    // 兼容旧字段
    signals: row.g4_reasons_met || row.gate4_reasons || [],
    signal_level: signalLevel,
    signal_strength_score: row.g4_reason_count || row.gate4_count || 0,
    bar_identity: row.lc_stage || '未知',
    buy_sell_pressure: row.fw_type_cn || '均衡',
    ai_flip: row.ch_has_signal || false,
    trend_label: row.g4_verdict || '',
    breakout_score: row.trend_strength || 0,
    breakout_label: row.market_context || '',
    oversold_score: row.edge_p_value ? (1 - row.edge_p_value) * 100 : 0,
    oversold_signal: row.edge_status || 'inactive',
    key_levels: row.key_levels || null,
    advice: row.advice || '',
  };
}

/**
 * 结构化交易建议（与雷达/品种分析页同一数据源 V16Row）
 */
export interface VarietyAdvice {
  varietyCode: string;
  varietyName: string;
  direction: 'LONG' | 'SHORT';
  signalGrade: string;
  signalVariant: string;
  spectrum: string;
  g4ReasonCount: number;
  mtfResonanceText: string;
  contractMonth: string;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  support: number;
  resistance: number;
  target1: number;
  target2: number;
  riskAmount: number;
  riskPerUnit: number;
  contractMultiplier: number;
  maxPosition: number;
  entryTiming: string;
  entryConditions: string[];
  summary: string;
  analysis: string;
  alertLevel: 'NONE' | 'WATCH' | 'ALERT' | 'CRITICAL';
  alertMessage: string;
  equationRR?: number;
  equationPassed?: boolean;
}

/**
 * 服务端文件：server/src/routes/optimization.ts
 * 接口：GET /api/v1/optimization/advice/:code
 * Path 参数：code: string（品种代码，如 AG0）
 * Query 参数：riskAmount?: number（风险金额，默认 2000）
 */
export async function fetchVarietyAdvice(code: string): Promise<VarietyAdvice | null> {
  const resp = await fetchWithTimeout(`${API_BASE}/optimization/advice/${encodeURIComponent(code)}`);
  if (!resp.ok) throw new Error('获取交易建议失败');
  const j = await resp.json();
  if (!j.success) throw new Error(j.error || '获取交易建议失败');
  return j.data as VarietyAdvice | null;
}

/**
 * 服务端文件：server/src/routes/scan.ts
 * 接口：GET /api/v1/signal-stats/:code
 * Path 参数：code: string
 */
export async function fetchSignalStats(code: string): Promise<SignalStats> {
  const resp = await fetchWithTimeout(`${API_BASE}/signal-stats/${code}`);
  if (!resp.ok) throw new Error('获取信号统计失败');
  const data = await resp.json();
  return {
    tradeStats: data.tradeStats || {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      avgWinPct: 0, avgLossPct: 0, profitFactor: 0,
      longTrades: 0, longWinRate: 0, shortTrades: 0, shortWinRate: 0,
    },
    signalGradeStats: data.signalGradeStats || [],
    recentSignals: data.recentSignals || [],
  };
}

// 获取预警数据 (V16.2 格式适配)
export async function fetchAlerts(): Promise<AlertData> {
  const resp = await fetchWithTimeout(`${API_BASE}/scan/alerts`);
  if (!resp.ok) throw new Error('获取预警数据失败');
  const data = await resp.json();
  
  // V16.2 API 返回 { tradable, filtered_high_risk, summary }
  // 映射到 AlertData 格式
  const tradable = data.tradable || [];
  const strongSignals: VarietyItem[] = tradable.map((row: any) => {
    let aiDir = row.ai_direction || '中性';
    if (aiDir === '多') aiDir = 'LONG';
    else if (aiDir === '空') aiDir = 'SHORT';
    
    const g4Count = row.gate4_count ?? 0;
    let signalLevel: 'strong' | 'moderate' | 'weak' | 'none' = 'none';
    if (row.decision === 'tradable' && g4Count >= 4) signalLevel = 'strong';
    else if (row.decision === 'tradable') signalLevel = 'moderate';
    
    return {
      code: row.code || '',
      name: row.name || '',
      contract: row.contract || '',
      close: row.close || 0,
      change_pct: row.change_pct || row.ret_pct || 0,
      spectrum: row.spectrum || '区间',
      ai_direction: aiDir,
      bar_identity: row.lc_stage || '未知',
      buy_sell_pressure: row.fw_type_cn || '均衡',
      breakout_score: row.direction_quality || row.trend_strength || 0,
      breakout_label: row.market_context || '',
      trend_strength: row.direction_quality || row.trend_strength || 0,
      trend_label: row.filter_reason || '',
      ai_flip: row.ch_has_signal || false,
      signal_level: signalLevel,
      signals: row.gate4_reasons || [],
      signal_strength_score: g4Count,
      oversold_score: 0,
      oversold_signal: 'inactive',
      // V16.2 字段
      g4_count: g4Count,
      edge_grade: row.edge_grade || undefined,
    };
  });
  
  return {
    oversold: [],
    linkage: { alerts: [] },
    strongSignals,
  };
}

// ========== 交易日志 API ==========

// 后端 ManualTrade 接口字段（server/src/services/tradingRecord.ts）
interface ManualTradeBackend {
  id: number;
  variety_code: string;
  variety_name: string;
  contract_month?: string;
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
  signal_grade?: string;
  signal_type?: string;
  ai_direction?: string;
  market_state?: string;
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
  signal_review?: string;
  pnl_ratio?: number;
  exit_notes?: string;
  lessons?: string;
}

// 后端 ManualTrade → 前端 TradeRecord 映射
function mapBackendTrade(t: ManualTradeBackend): TradeRecord {
  return {
    id: t.id,
    variety_code: t.variety_code,
    variety_name: t.variety_name,
    direction: t.direction === 'LONG' ? 'long' : 'short',
    open_time: t.entry_time,
    open_price: t.entry_price,
    open_quantity: t.position_size,
    open_reason: t.entry_reason || '',
    close_time: t.exit_time,
    close_price: t.exit_price,
    close_reason: t.exit_reason,
    profit_loss: t.pnl,
    status: t.status === 'OPEN' ? 'open' : 'closed',
    notes: t.trade_journal,
    signal_grade: t.signal_grade,
    ai_direction: t.ai_direction,
    market_state: t.market_state,
    support_level: t.support_level,
    resistance_level: t.resistance_level,
    ema20: t.ema20,
    prev_high: t.prev_high,
    prev_low: t.prev_low,
    price_range_low: t.price_range_low,
    price_range_high: t.price_range_high,
    signal_type: t.signal_type,
    entry_reason: t.entry_reason,
    close_signal_review: t.signal_review,
    close_notes: t.exit_notes,
    lessons_learned: t.lessons,
    stop_loss: t.stop_loss,
    target_price: t.target_price,
    gate4_count: t.gate4_count,
    edge_grade: t.edge_grade,
    pnl_ratio: t.pnl_ratio,
  };
}

// 前端 TradeRecord → 后端 ManualTrade 映射（用于创建）
function mapToBackendTrade(trade: Partial<TradeRecord>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (trade.variety_code !== undefined) out.variety_code = trade.variety_code;
  if (trade.variety_name !== undefined) out.variety_name = trade.variety_name;
  if (trade.direction !== undefined) out.direction = trade.direction === 'long' ? 'LONG' : 'SHORT';
  if (trade.open_price !== undefined) out.entry_price = trade.open_price;
  if (trade.open_time !== undefined) out.entry_time = trade.open_time;
  if (trade.open_quantity !== undefined) out.position_size = trade.open_quantity;
  if (trade.open_reason !== undefined) out.entry_reason = trade.open_reason;
  if (trade.notes !== undefined) out.trade_journal = trade.notes;
  if (trade.signal_grade !== undefined) out.signal_grade = trade.signal_grade;
  if (trade.signal_type !== undefined) out.signal_type = trade.signal_type;
  if (trade.ai_direction !== undefined) out.ai_direction = trade.ai_direction;
  if (trade.market_state !== undefined) out.market_state = trade.market_state;
  if (trade.support_level !== undefined) out.support_level = trade.support_level;
  if (trade.resistance_level !== undefined) out.resistance_level = trade.resistance_level;
  if (trade.ema20 !== undefined) out.ema20 = trade.ema20;
  if (trade.prev_high !== undefined) out.prev_high = trade.prev_high;
  if (trade.prev_low !== undefined) out.prev_low = trade.prev_low;
  if (trade.price_range_low !== undefined) out.price_range_low = trade.price_range_low;
  if (trade.price_range_high !== undefined) out.price_range_high = trade.price_range_high;
  if (trade.stop_loss !== undefined) out.stop_loss = trade.stop_loss;
  if (trade.target_price !== undefined) out.target_price = trade.target_price;
  if (trade.gate4_count !== undefined) out.gate4_count = trade.gate4_count;
  if (trade.edge_grade !== undefined) out.edge_grade = trade.edge_grade;
  return out;
}

export interface TradeRecord {
  id: number;
  variety_code: string;
  variety_name: string;
  direction: 'long' | 'short';
  open_time: string;
  open_price: number;
  open_quantity: number;
  open_reason: string;
  open_screenshot?: string;
  close_time?: string;
  close_price?: number;
  close_reason?: string;
  profit_loss?: number;
  status: 'open' | 'closed';
  notes?: string;
  // Brooks 扩展
  signal_grade?: string;
  ai_direction?: string;
  market_state?: string;
  support_level?: number;
  resistance_level?: number;
  ema20?: number;
  prev_high?: number;
  prev_low?: number;
  price_range_low?: number;
  price_range_high?: number;
  signal_type?: string;
  entry_reason?: string;
  close_signal_review?: string;
  close_notes?: string;
  lessons_learned?: string;
  stop_loss?: number;
  target_price?: number;
  gate4_count?: number;
  edge_grade?: string;
  pnl_ratio?: number;
}

// ============ 复盘相关接口（与后端 daily_reviews / variety_reviews 表对齐） ============

// 品种级明日计划项（存于 daily_reviews.tomorrow_plans JSON 数组）
export interface TomorrowPlan {
  variety_code: string;
  variety_name: string;
  direction?: 'long' | 'short' | 'both';
  breakout_long?: string;   // 突破做多价位
  breakdown_short?: string; // 跌破做空价位
  range_low?: string;
  range_high?: string;
  notes?: string;
}

export interface DailyReview {
  id?: number;
  review_date: string;
  premarket_state?: string;        // 盘前状态：trend/channel/range
  market_state_actual?: string;    // 实际走势
  state_correct?: boolean;
  iron_rules_check?: string;       // JSON: boolean[9]
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
  tomorrow_plans?: string;         // JSON: TomorrowPlan[]
  created_at?: string;
  updated_at?: string;
}

// 品种级复盘
export interface VarietyReview {
  id?: number;
  review_date: string;
  variety_code: string;
  variety_name: string;
  premarket_state?: string;        // 盘前判断：trend/channel/range
  market_state_actual?: string;    // 实际走势
  state_correct?: boolean;
  ai_direction?: string;
  signal_grade?: string;           // A/B/C/D
  signal_notes?: string;
  key_levels?: string;             // JSON 关键位快照
  notes?: string;                  // 单品种反思
  created_at?: string;
  updated_at?: string;
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：GET /api/v1/trading/manual
 * Query 参数：status?: 'OPEN' | 'CLOSED'
 */
export async function fetchTrades(status?: string): Promise<{ trades: TradeRecord[] }> {
  const backendStatus = status === 'open' ? 'OPEN' : status === 'closed' ? 'CLOSED' : undefined;
  const url = backendStatus ? `${API_BASE}/trading/manual?status=${backendStatus}` : `${API_BASE}/trading/manual`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) throw new Error('获取交易记录失败');
  const json = await resp.json();
  const list: ManualTradeBackend[] = json.data || [];
  return { trades: list.map(mapBackendTrade) };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：POST /api/v1/trading/manual
 * Body 参数：variety_code: string, variety_name: string, direction: 'LONG'|'SHORT', entry_price: number, entry_time: string, position_size: number, entry_reason?: string, signal_grade?: string 等
 */
export async function createTrade(trade: Partial<TradeRecord>): Promise<{ success: boolean; id: number }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/manual`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(mapToBackendTrade(trade)),
  });
  if (!resp.ok) throw new Error('创建交易记录失败');
  const json = await resp.json();
  return { success: json.success, id: json.data?.id ?? json.id };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：PUT /api/v1/trading/manual/:id/close
 * Path 参数：id: number
 * Body 参数：exitPrice: number, exitTime: string, exitReason?: string, signal_review?: string, exit_notes?: string, lessons?: string
 */
export async function closeTrade(id: number, data: {
  close_price: number; close_time?: string; close_reason?: string;
  close_signal_review?: string; close_notes?: string; lessons_learned?: string;
}): Promise<{ success: boolean; profit_loss: number }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/manual/${id}/close`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      exitPrice: data.close_price,
      exitTime: data.close_time || new Date().toISOString(),
      exitReason: data.close_reason,
      signal_review: data.close_signal_review,
      exit_notes: data.close_notes,
      lessons: data.lessons_learned,
    }),
  });
  if (!resp.ok) throw new Error('平仓失败');
  const json = await resp.json();
  const t = json.data || {};
  return { success: json.success, profit_loss: t.profit_loss ?? t.pnl ?? 0 };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：DELETE /api/v1/trading/manual/:id
 * Path 参数：id: number
 */
export async function deleteTrade(id: number): Promise<void> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/manual/${id}`, { method: 'DELETE' });
  if (!resp.ok) throw new Error('删除失败');
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：GET /api/v1/trading/reviews
 */
export async function fetchReviews(): Promise<{ reviews: DailyReview[] }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews`);
  if (!resp.ok) throw new Error('获取复盘列表失败');
  const json = await resp.json();
  return { reviews: json.data || [] };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：GET /api/v1/trading/reviews/:date
 * Path 参数：date: string（YYYY-MM-DD）
 */
export async function fetchReview(date: string): Promise<{ review: DailyReview | null }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews/${date}`);
  if (resp.status === 404) return { review: null };
  if (!resp.ok) throw new Error('获取复盘失败');
  const json = await resp.json();
  return { review: json.data || null };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：POST /api/v1/trading/reviews
 * Body 参数：review_date: string, premarket_state?: string, market_state_actual?: string,
 *   state_correct?: boolean, iron_rules_check?: string(JSON), what_went_well?: string,
 *   what_went_poorly?: string, key_lesson?: string, new_pa_pattern?: string,
 *   emotional_state?: string, tomorrow_plans?: string(JSON: TomorrowPlan[]),
 *   total_signals?: number, a_level_signals?: number, b_level_signals?: number,
 *   c_level_signals?: number, entered_signals?: number, missed_signals?: number
 */
export async function saveReview(review: Partial<DailyReview>): Promise<{ success: boolean }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(review),
  });
  if (!resp.ok) throw new Error('保存复盘失败');
  return resp.json();
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：GET /api/v1/trading/reviews/:date/varieties
 * Path 参数：date: string（YYYY-MM-DD）
 */
export async function fetchVarietyReviews(date: string): Promise<{ reviews: VarietyReview[] }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews/${date}/varieties`);
  if (!resp.ok) throw new Error('获取品种复盘失败');
  const json = await resp.json();
  return { reviews: json.data || [] };
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：POST /api/v1/trading/reviews/:date/varieties
 * Path 参数：date: string（YYYY-MM-DD）
 * Body 参数：variety_code: string, variety_name: string, premarket_state?: string,
 *   market_state_actual?: string, state_correct?: boolean, ai_direction?: string,
 *   signal_grade?: string, signal_notes?: string, key_levels?: string(JSON), notes?: string
 */
export async function saveVarietyReview(date: string, review: Partial<VarietyReview>): Promise<{ success: boolean }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews/${date}/varieties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(review),
  });
  if (!resp.ok) throw new Error('保存品种复盘失败');
  return resp.json();
}

/**
 * 服务端文件：server/src/routes/trading.ts
 * 接口：DELETE /api/v1/trading/reviews/:date/varieties/:code
 * Path 参数：date: string（YYYY-MM-DD）, code: string（品种代码）
 */
export async function deleteVarietyReviewApi(date: string, code: string): Promise<{ success: boolean }> {
  const resp = await fetchWithTimeout(`${API_BASE}/trading/reviews/${date}/varieties/${code}`, {
    method: 'DELETE',
  });
  if (!resp.ok) throw new Error('删除品种复盘失败');
  return resp.json();
}

// 获取封面 Brooks 市场洞察（规则生成）
export interface MarketInsight {
  generated_at: string;
  market_state: string;
  tradable_count: number;
  total_count: number;
  long_count: number;
  short_count: number;
  grade_distribution: { A: number; B: number; C: number; D: number };
  recommendations: Array<{
    code: string;
    name: string;
    type: 'recommend';
    title: string;
    detail: string;
  }>;
  cautions: Array<{
    code: string;
    name: string;
    type: 'caution';
    title: string;
    detail: string;
  }>;
  ai_summary: string;
}

/**
 * 服务端文件：server/src/routes/scan.ts
 * 接口：GET /api/v1/scan/market-insight
 * 60s 超时：market-insight 冷启动同样需全量扫描，15s 默认超时会导致首页空白
 */
export async function fetchMarketInsight(): Promise<MarketInsight> {
  const resp = await fetchWithTimeout(`${API_BASE}/scan/market-insight`, {}, 60000);
  if (!resp.ok) throw new Error('获取市场洞察失败');
  return resp.json();
}
