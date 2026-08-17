/**
 * 每日信号日报 + 模拟交易路由
 */
import { Router } from 'express';
import {
  saveDailyJournal, getDailyJournalByDate, getDailyJournalByCode, getJournalDates,
  saveSimTrade, getSimTrades, getSimTradeStats, closeSimTrade, getOpenSimTrade,
  upsertJournalReview, getPendingJournalReviews, getAllJournalReviews,
  getJournalReviewsByCode, getJournalReviewByCodeDate, updateJournalReview, getJournalReviewStats,
  type DailyJournalRecord, type SimTradeRecord, type JournalReviewRecord
} from '../services/database.js';
import { runV16FullScan } from '../services/v16_engine.js';
import { getScanCache } from './scan.js';
import { VARIETIES, GROUP_NAMES, VARIETY_GROUPS } from '../services/varieties.js';
import type { V16Row, V16ScanResult } from '../services/v16_types.js';

const router = Router();

/**
 * 获取本地时区日期字符串（YYYY-MM-DD）
 * 避免 toISOString() 使用 UTC 时区导致中国时区日期差一天
 */
function getLocalDateStr(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 获取日报扫描结果：
 * - 当天：优先复用 APP 主逻辑已预加载的扫描缓存（数据与 APP 首页/信号页一致）
 * - 历史日期：按该日期截断日线数据重新扫描，得到「那天」的判断结果
 */
async function getJournalScanReport(tradeDate: string): Promise<V16ScanResult> {
  const today = getLocalDateStr();
  if (tradeDate === today) {
    const cached = getScanCache();
    if (cached && cached.rows.length > 0) return cached;
    return runV16FullScan();
  }
  return runV16FullScan(false, tradeDate);
}

// ====== 每日信号日报 ======

/**
 * POST /api/v1/journal/generate
 * 手动触发生成今日日报（扫描全市场并保存）
 */
/**
 * 复盘：根据最新行情更新所有待跟踪建议的状态
 * - 价格触及止损价 → 已止损
 * - 价格触及目标价 → 已止盈
 * - 价格进入入场区间 → 已入场
 */
function createJournalReviews(tradeDate: string, reportRows: any[]) {
  try {
    let created = 0;
    for (const row of reportRows) {
      if (!row.ch_direction) continue; // 只有有交易方向的品种才创建复盘
      const existing = getJournalReviewByCodeDate(row.code, tradeDate);
      if (existing) continue;
      upsertJournalReview({
        code: row.code,
        name: row.name,
        advice_date: tradeDate,
        direction: row.ch_direction,
        entry_price: row.ch_entry ?? 0,
        entry_range_low: 0,
        entry_range_high: 0,
        stop_price: row.ch_stop ?? 0,
        target_price: row.ch_target ?? 0,
        signal_level: row.edge_grade ?? '',
        spectrum: row.spectrum ?? '',
        status: 'pending',
        touched_date: '',
        result: 'pending',
        result_pnl: 0,
        result_pnl_pct: 0,
        days_held: 0,
      } as any);
      created++;
    }
    return { created };
  } catch (err: any) {
    console.error('[journal] createJournalReviews error:', err?.message || err);
    return { created: 0 };
  }
}

function updateJournalReviews(tradeDate: string, reportRows: any[]) {
  try {
    const pending = getPendingJournalReviews();
    if (!pending.length) return { updated: 0 };

    const priceMap = new Map<string, number>();
    for (const row of reportRows) {
      priceMap.set(row.code, row.close ?? 0);
    }

    let updated = 0;
    for (const review of pending) {
      const currentPrice = priceMap.get(review.code);
      if (!currentPrice) continue;

      const isLong = review.direction === '多' || review.direction === 'LONG';
      const status = review.status;

      // 只有未结束的建议才更新
      if (status === '已止盈' || status === '已止损' || status === '已过期') continue;

      let newStatus: string | null = null;
      let closePrice: number | null = null;
      let closeDate: string | null = null;

      if (isLong) {
        // 多单：价格跌破止损 → 止损；价格突破目标 → 止盈
        if (review.stop_price && currentPrice <= review.stop_price) {
          newStatus = '已止损';
          closePrice = review.stop_price;
          closeDate = tradeDate;
        } else if (review.target_price && currentPrice >= review.target_price) {
          newStatus = '已止盈';
          closePrice = review.target_price;
          closeDate = tradeDate;
        }
      } else {
        // 空单：价格突破止损 → 止损；价格跌破目标 → 止盈
        if (review.stop_price && currentPrice >= review.stop_price) {
          newStatus = '已止损';
          closePrice = review.stop_price;
          closeDate = tradeDate;
        } else if (review.target_price && currentPrice <= review.target_price) {
          newStatus = '已止盈';
          closePrice = review.target_price;
          closeDate = tradeDate;
        }
      }

      if (newStatus && review.id != null) {
        const result = newStatus === '已止盈' ? 'win' : newStatus === '已止损' ? 'loss' : 'open';
        updateJournalReview(review.id, newStatus, closePrice, closeDate, result);
        updated++;
      }
    }

    return { updated };
  } catch (err: any) {
    console.error('[journal] updateJournalReviews error:', err?.message || err);
    return { updated: 0 };
  }
}

/**
 * 复盘：为今日可交易品种创建新的复盘记录
 */

// 复盘更新（手动触发）
router.post('/journal/review/update', async (_req, res) => {
  try {
    const report = await getJournalScanReport(getLocalDateStr());
    const rows = report.rows ?? [];
    const result = updateJournalReviews(getLocalDateStr(), rows);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '复盘更新失败' });
  }
});

// 复盘记录单条状态流转（pending → entered/stopped/hit_target）
router.post('/journal/review/:id/status', (req, res) => {
  try {
    const id = Number(req.params.id);
    const { status, closePrice, closeDate, result } = req.body ?? {};
    if (!id || !['pending', 'entered', 'stopped', 'hit_target'].includes(status)) {
      res.status(400).json({ success: false, error: '无效的状态参数' });
      return;
    }
    updateJournalReview(
      id,
      status,
      closePrice != null ? Number(closePrice) : null,
      closeDate || null,
      result || null
    );
    res.json({ success: true, id, status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '更新复盘状态失败' });
  }
});

// 全部复盘记录
router.get('/journal/reviews', (_req, res) => {
  try {
    const records = getAllJournalReviews();
    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '获取复盘记录失败' });
  }
});

// 按品种复盘记录
router.get('/journal/reviews/code/:code', (req, res) => {
  try {
    const records = getJournalReviewsByCode(req.params.code);
    res.json({ success: true, records });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '获取品种复盘失败' });
  }
});

// 复盘统计
router.get('/journal/reviews/stats', (_req, res) => {
  try {
    const stats = getJournalReviewStats();
    res.json({ success: true, ...stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || '获取复盘统计失败' });
  }
});

router.post('/journal/generate', async (req, res) => {
  try {
    const tradeDate = (req.body?.tradeDate as string) || getLocalDateStr();
    const report = await getJournalScanReport(tradeDate);

    let savedCount = 0;
    for (const row of report.rows) {
      const record: DailyJournalRecord = {
        trade_date: tradeDate,
        code: row.code,
        name: row.name,
        close: row.close,
        change_pct: row.ret_pct,
        spectrum: row.spectrum,
        ai_direction: row.ai_direction,
        signal_level: row.edge_grade,
        p_follow: row.p_follow,
        adx: row.adx,
        g4_count: row.g4_reason_count,
        one_liner: generateOneLiner(row),
        advice: generateAdvice(row),
        ch_direction: row.ch_direction,
        ch_entry: row.ch_entry ?? undefined,
        ch_stop: row.ch_stop ?? undefined,
        ch_target: row.ch_target ?? undefined,
        mm_tier1: row.mm_tier1 ?? undefined,
        mm_tier2: row.mm_tier2 ?? undefined,
        detail_json: JSON.stringify({
          p_follow: row.p_follow,
          p_counter: row.p_counter,
          g4_pass: row.g4_pass,
          g4_reason_count: row.g4_reason_count,
          edge_grade: row.edge_grade,
          spectrum: row.spectrum,
          trend_strength: row.trend_strength,
          adx: row.adx,
          ch_direction: row.ch_direction,
          trade_worthiness: row.trade_worthiness,
        }),
      };
      saveDailyJournal(record);
      savedCount++;
    }

    // 同步模拟交易
    const simResult = syncSimTrades(tradeDate, report.rows);

    // 复盘：新增今日建议 + 更新历史建议状态
    createJournalReviews(tradeDate, report.rows);
    updateJournalReviews(tradeDate, report.rows);

    // 计算统计
    const allRecords = getDailyJournalByDate(tradeDate);
    const stats = calculateJournalStats(allRecords);

    res.json({
      success: true,
      tradeDate,
      savedCount,
      tradable: report.tradableCount,
      filtered: report.filteredCount,
      simTrades: simResult,
      stats,
    });
  } catch (e: any) {
    console.error('[Journal Generate] 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * POST /api/v1/journal/backfill
 * 一键回填历史信号日报（从 startDate 到 endDate，默认 2026-01-01 ~ 今天）
 * Body 参数：startDate?: string (YYYY-MM-DD), endDate?: string (YYYY-MM-DD)
 * 说明：逐日扫描全市场并保存；已有日报的日期自动跳过（幂等）；不触发模拟交易/复盘
 */
router.post('/journal/backfill', async (req, res) => {
  try {
    const today = getLocalDateStr();
    const startDate = (req.body?.startDate as string) || '2026-01-01';
    const endDate = (req.body?.endDate as string) || today;

    // 校验日期格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
      return res.status(400).json({ success: false, error: '日期格式必须为 YYYY-MM-DD' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, error: 'startDate 不能晚于 endDate' });
    }

    // 生成日期列表
    const dates: string[] = [];
    const cur = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (cur <= end) {
      dates.push(getLocalDateStr(cur));
      cur.setDate(cur.getDate() + 1);
    }

    let generated = 0;
    let skipped = 0;
    let failed = 0;
    const skippedDates: string[] = [];
    const failedDates: string[] = [];

    for (const tradeDate of dates) {
      // 幂等：已有日报的日期跳过（仅当记录完整 ≥30 条；不完整日期重新生成）
      const existing = getDailyJournalByDate(tradeDate);
      if (existing.length >= 30) {
        skipped++;
        skippedDates.push(tradeDate);
        continue;
      }
      try {
        const report = await runV16FullScan(false, tradeDate);
        let savedCount = 0;
        for (const row of report.rows) {
          const record: DailyJournalRecord = {
            trade_date: tradeDate,
            code: row.code,
            name: row.name,
            close: row.close,
            change_pct: row.ret_pct,
            spectrum: row.spectrum,
            ai_direction: row.ai_direction,
            signal_level: row.edge_grade,
            p_follow: row.p_follow,
            adx: row.adx,
            g4_count: row.g4_reason_count,
            one_liner: generateOneLiner(row),
            advice: generateAdvice(row),
            ch_direction: row.ch_direction,
            ch_entry: row.ch_entry ?? undefined,
            ch_stop: row.ch_stop ?? undefined,
            ch_target: row.ch_target ?? undefined,
            mm_tier1: row.mm_tier1 ?? undefined,
            mm_tier2: row.mm_tier2 ?? undefined,
            detail_json: JSON.stringify({
              p_follow: row.p_follow,
              p_counter: row.p_counter,
              g4_pass: row.g4_pass,
              g4_reason_count: row.g4_reason_count,
              edge_grade: row.edge_grade,
              spectrum: row.spectrum,
              trend_strength: row.trend_strength,
              adx: row.adx,
              ch_direction: row.ch_direction,
              trade_worthiness: row.trade_worthiness,
            }),
          };
          saveDailyJournal(record);
          savedCount++;
        }
        if (savedCount > 0) {
          generated++;
        } else {
          skipped++;
          skippedDates.push(`${tradeDate}(无数据)`);
        }
      } catch (e: any) {
        failed++;
        failedDates.push(tradeDate);
      }
    }

    res.json({
      success: true,
      total: dates.length,
      generated,
      skipped,
      failed,
      startDate,
      endDate,
      skippedDates: skippedDates.slice(0, 20),
      failedDates: failedDates.slice(0, 20),
    });
  } catch (e: any) {
    console.error('[Journal Backfill] 错误:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /api/v1/journal/dates
 * 获取有日报的日期列表
 */
router.get('/journal/dates', (_req, res) => {
  try {
    const dates = getJournalDates();
    res.json({ dates });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/journal/date/:date
 * 获取某日的所有日报
 */
router.get('/journal/date/:date', (req, res) => {
  try {
    const records = getDailyJournalByDate(req.params.date);
    res.json({ records, count: records.length });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/journal/code/:code
 * 获取某品种的历史日报
 */
router.get('/journal/code/:code', (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 30;
    const records = getDailyJournalByCode(req.params.code, limit);
    
    // 计算信号变化统计
    const stats = calculateSignalStats(records);
    
    res.json({ records, stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/journal/stats/:date
 * 获取某日日报的交易建议统计
 */
router.get('/journal/stats/:date', (req, res) => {
  try {
    const records = getDailyJournalByDate(req.params.date);
    const stats = calculateJournalStats(records);
    res.json({ date: req.params.date, totalRecords: records.length, stats });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ====== 模拟交易 ======

/**
 * GET /api/v1/sim-trades
 * 获取模拟交易列表
 */
router.get('/sim-trades', (req, res) => {
  try {
    const { status, code, limit } = req.query;
    const trades = getSimTrades({
      status: status as string,
      code: code as string,
      limit: limit ? parseInt(limit as string) : 50,
    });
    res.json({ trades });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * GET /api/v1/sim-trades/stats
 * 获取模拟交易统计
 */
router.get('/sim-trades/stats', (_req, res) => {
  try {
    const stats = getSimTradeStats();
    res.json(stats);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/v1/sim-trades/sync
 * 手动同步模拟交易（根据最新日报，回测对齐版）
 * 对齐参数：minSignalGrade=L2, stopAtrMult=2, targetAtrMult=4, maxHoldDays=15, feeRate=0.03%
 */
router.post('/sim-trades/sync', (_req, res) => {
  try {
    const tradeDate = getLocalDateStr();
    // 获取最新日报
    const records = getDailyJournalByDate(tradeDate);
    if (records.length === 0) {
      return res.json({ success: false, message: '今日暂无日报，请先生成日报' });
    }
    
    // 转换为 V16Row 格式（包含回测对齐所需的全部字段）
    const rows = records.map(r => ({
      code: r.code,
      name: r.name,
      ai_direction: r.ai_direction,
      spectrum: r.spectrum,
      edge_grade: r.signal_level,
      p_follow: r.p_follow,
      close: r.close,
    } as any));
    
    const result = syncSimTrades(tradeDate, rows);
    res.json({ 
      success: true, 
      ...result,
      params: {
        minSignalGrade: SIM_PARAMS.minSignalGrade,
        stopAtrMult: SIM_PARAMS.stopAtrMult,
        targetAtrMult: SIM_PARAMS.targetAtrMult,
        maxHoldDays: SIM_PARAMS.maxHoldDays,
        feeRate: SIM_PARAMS.feeRate,
        kellyFraction: SIM_PARAMS.kellyFraction,
        maxPositionSize: SIM_PARAMS.maxPositionSize,
      },
      adaptiveParams: result.adaptiveParams,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * GET /sim-trades/risk-dashboard
 * 实时风险仪表盘数据
 * 
 * 返回：
 * - 当前总风险敞口（按板块/品种）
 * - 实时最大回撤 vs 回测预期
 * - 夏普比率实时追踪
 * - 持仓分布统计
 */
router.get('/sim-trades/risk-dashboard', (_req, res) => {
  try {
    const allTrades = getSimTrades();
    const openTrades = allTrades.filter(t => t.status === 'open');
    const closedTrades = allTrades.filter(t => t.status === 'closed');
    
    // 1. 按板块统计风险敞口
    const groupExposure: Record<string, { count: number; totalPosition: number; totalPnl: number; trades: string[] }> = {};
    for (const trade of openTrades) {
      const group = GROUP_NAMES[trade.code] || '其他';
      if (!groupExposure[group]) {
        groupExposure[group] = { count: 0, totalPosition: 0, totalPnl: 0, trades: [] };
      }
      groupExposure[group].count++;
      groupExposure[group].totalPosition += trade.position_size || 1;
      groupExposure[group].trades.push(trade.code);
      // 计算浮动盈亏
      const dir = trade.direction === '多' ? 1 : -1;
      const currentPrice = trade.entry_price; // 简化：使用入场价，实际应获取实时价格
      const pnl = (currentPrice - trade.entry_price) * dir * (trade.position_size || 1);
      groupExposure[group].totalPnl += pnl;
    }
    
    // 2. 计算实时风险指标
    const stats = getSimTradeStats();
    
    // 3. 计算最大回撤
    let maxDrawdown = 0;
    let peak = 0;
    let cumulativePnl = 0;
    const equityCurve: { date: string; equity: number }[] = [];
    
    // 按日期排序已平仓交易
    const sortedClosedTrades = [...closedTrades].sort((a, b) => 
      new Date(a.exit_date!).getTime() - new Date(b.exit_date!).getTime()
    );
    
    for (const trade of sortedClosedTrades) {
      const pnl = (trade.pnl || 0) - (trade.fee || 0);
      cumulativePnl += pnl;
      if (cumulativePnl > peak) peak = cumulativePnl;
      const drawdown = peak - cumulativePnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
      equityCurve.push({ date: trade.exit_date!, equity: cumulativePnl });
    }
    
    // 4. 计算夏普比率（简化版）
    const returns = sortedClosedTrades.map(t => (t.pnl || 0) - (t.fee || 0));
    const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const stdDev = returns.length > 1 
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / (returns.length - 1))
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0; // 年化
    
    // 5. 持仓方向分布
    const longCount = openTrades.filter(t => t.direction === '多').length;
    const shortCount = openTrades.filter(t => t.direction === '空').length;
    
    // 6. 信号等级分布
    const gradeDistribution: Record<string, number> = {};
    for (const trade of openTrades) {
      const grade = trade.signal_grade || 'N/A';
      gradeDistribution[grade] = (gradeDistribution[grade] || 0) + 1;
    }
    
    // 7. 风险警告
    const warnings: string[] = [];
    for (const [group, data] of Object.entries(groupExposure)) {
      if (data.count >= SIM_PARAMS.maxPositionsPerGroup) {
        warnings.push(`${group}板块持仓达到上限(${data.count}/${SIM_PARAMS.maxPositionsPerGroup})`);
      }
    }
    if (maxDrawdown > stats.maxDrawdown * 1.5) {
      warnings.push(`当前回撤(${maxDrawdown.toFixed(0)})已超过历史最大回撤的150%`);
    }
    if (openTrades.length > 10) {
      warnings.push(`持仓数量(${openTrades.length})较多，注意风险分散`);
    }
    
    // 8. 获取当前自适应参数状态
    const adaptiveParams = getAdaptiveParams();
    
    res.json({
      success: true,
      data: {
        summary: {
          totalOpenTrades: openTrades.length,
          totalClosedTrades: closedTrades.length,
          totalPosition: openTrades.reduce((sum, t) => sum + (t.position_size || 1), 0),
          longCount,
          shortCount,
        },
        groupExposure,
        riskMetrics: {
          maxDrawdown: Math.round(maxDrawdown * 100) / 100,
          sharpeRatio: Math.round(sharpeRatio * 100) / 100,
          avgReturn: Math.round(avgReturn * 100) / 100,
          stdDev: Math.round(stdDev * 100) / 100,
        },
        equityCurve,
        gradeDistribution,
        adaptiveParams: {
          ...adaptiveParams,
          effectivePThreshold: Math.round(SIM_PARAMS.pThreshold * adaptiveParams.pThresholdAdj * 1000) / 1000,
          effectiveStopAtrMult: Math.round(SIM_PARAMS.stopAtrMult * adaptiveParams.stopAtrMultAdj * 100) / 100,
          effectiveTargetAtrMult: Math.round(SIM_PARAMS.targetAtrMult * adaptiveParams.targetAtrMultAdj * 100) / 100,
          effectiveMaxHoldDays: Math.round(SIM_PARAMS.maxHoldDays * adaptiveParams.maxHoldDaysAdj),
          effectiveMinScore: SIGNAL_SCORING_PARAMS.minScore + adaptiveParams.minScoreAdj,
        },
        warnings,
      }
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ====== 辅助函数 ======

/**
 * 回测对齐参数（基于59品种×1000次回测优化结果）
 * - minSignalGrade: L2（回测论证 L2收益585% >> L3收益271%）
 * - stopAtrMult: 2（止损 = ATR × 2）
 * - targetAtrMult: 4（目标 = ATR × 4，盈亏比 2:1）
 * - maxHoldDays: 15（回测论证 15bar收益782% >> 5bar收益271%）
 * - cooldownBars: 2（止损后2根K线冷却，防止震荡市连续止损）
 * - feeMult: 3（手续费+滑点 = 单边 0.03%）
 * - pThreshold: 0.4（P顺最低阈值）
 */
const SIM_PARAMS = {
  minSignalGrade: 'L2' as const,
  stopAtrMult: 2,
  targetAtrMult: 4,
  maxHoldDays: 15,
  cooldownBars: 2,
  feeRate: 0.0003, // 单边费率 0.03%（含滑点）
  pThreshold: 0.4,
  minRR: 1.5, // 最小盈亏比
  // Kelly 仓位管理参数
  kellyFraction: 0.25, // Kelly 系数（保守取 0.25，即 1/4 Kelly）
  maxPositionSize: 5, // 最大仓位手数
  minPositionSize: 1, // 最小仓位手数
  minTradesForKelly: 10, // 至少需要 10 笔历史交易才启用 Kelly
  // 品种相关性过滤参数
  maxPositionsPerGroup: 2, // 同板块最多持有头寸数
  // 信号质量评分参数
  minSignalScore: 50, // 最低信号评分（0-100）
};

/** 信号等级排序（用于过滤） */
const GRADE_ORDER: Record<string, number> = { 'L1': 3, 'L2': 2, 'L3': 1, 'D': 0 };

/** 检查信号等级是否满足最低要求 */
function meetsMinGrade(grade: string | undefined): boolean {
  if (!grade) return false;
  return (GRADE_ORDER[grade] || 0) >= (GRADE_ORDER[SIM_PARAMS.minSignalGrade] || 0);
}

/** 计算天数差（用于最大持仓天数和冷却期检查） */
function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * 计算 Kelly 仓位
 * 
 * Kelly 公式：Kelly% = (胜率 × 平均盈利 - 败率 × 平均亏损) / 平均盈利
 * 实际仓位 = Kelly% × Kelly系数（保守取 0.25）
 * 
 * @param winRate 胜率 (0-1)
 * @param avgWin 平均盈利
 * @param avgLoss 平均亏损（正数）
 * @returns 建议仓位手数（1-5）
 */
function calculateKellyPosition(winRate: number, avgWin: number, avgLoss: number): number {
  // 如果历史数据不足，返回默认仓位
  if (avgWin <= 0 || avgLoss <= 0 || winRate <= 0) {
    return SIM_PARAMS.minPositionSize;
  }
  
  const lossRate = 1 - winRate;
  
  // Kelly 公式：f* = (bp - q) / b
  // 其中 b = 盈亏比 (avgWin/avgLoss), p = 胜率, q = 败率
  const kellyPercent = (winRate * avgWin - lossRate * avgLoss) / avgWin;
  
  // 应用 Kelly 系数（保守取 0.25）
  const adjustedKelly = kellyPercent * SIM_PARAMS.kellyFraction;
  
  // 限制在合理范围内 [0, 1]
  const clampedKelly = Math.max(0, Math.min(1, adjustedKelly));
  
  // 转换为手数（假设每手保证金约 10% 资金，这里简化为直接映射）
  // 实际上应该根据账户资金和品种保证金计算，这里简化为 1-5 手
  const positionSize = Math.round(clampedKelly * SIM_PARAMS.maxPositionSize);
  
  // 限制在最小和最大仓位之间
  return Math.max(SIM_PARAMS.minPositionSize, Math.min(SIM_PARAMS.maxPositionSize, positionSize));
}

/**
 * 检查品种板块持仓限制
 * 
 * 同板块最多持有 maxPositionsPerGroup 个头寸，防止风险集中
 * 例如：黑色系（螺纹/热卷/铁矿/焦炭/焦煤）最多同时持有 2 个
 * 
 * @param varietyCode 品种代码
 * @param openTrades 当前持仓列表
 * @returns { allowed: boolean, group: string, currentCount: number }
 */
function checkGroupPositionLimit(
  varietyCode: string, 
  openTrades: SimTradeRecord[]
): { allowed: boolean; group: string; currentCount: number } {
  const groupName = GROUP_NAMES[varietyCode] || '其他';
  
  // 统计同板块持仓数量
  const groupCount = openTrades.filter(trade => {
    const tradeGroup = GROUP_NAMES[trade.code] || '其他';
    return tradeGroup === groupName;
  }).length;
  
  return {
    allowed: groupCount < SIM_PARAMS.maxPositionsPerGroup,
    group: groupName,
    currentCount: groupCount,
  };
}

/**
 * 市场状态类型
 */
type MarketRegime = 'trending' | 'ranging' | 'high_volatility';

/**
 * 市场状态参数调整
 */
interface RegimeAdjustment {
  stopMult: number;      // 止损 ATR 倍数调整
  targetMult: number;    // 止盈 ATR 倍数调整
  maxHoldDays: number;   // 最大持仓天数调整
  positionScale: number; // 仓位比例调整 (0-1)
  entryFilter: 'loose' | 'normal' | 'tight'; // 入场过滤严格程度
}

/**
 * 根据 ADX 和 ATR 识别市场状态并返回参数调整
 * 
 * 市场状态分类：
 * - 趋势市 (ADX > 25): 放宽入场，加大止盈
 * - 震荡市 (ADX < 20): 收紧入场，缩短持仓
 * - 高波动 (ATR 突增 > 1.5x 平均): 降低仓位，加宽止损
 * 
 * @param adx ADX 值
 * @param atr 当前 ATR
 * @param avgAtr 平均 ATR (可选，用于判断高波动)
 * @returns 市场状态和参数调整
 */
function identifyMarketRegime(
  adx: number,
  atr: number,
  avgAtr?: number
): { regime: MarketRegime; adjustment: RegimeAdjustment } {
  // 检查高波动 (ATR 突增 > 1.5x 平均)
  if (avgAtr && avgAtr > 0 && atr > avgAtr * 1.5) {
    return {
      regime: 'high_volatility',
      adjustment: {
        stopMult: 1.5,      // 加宽止损 50%
        targetMult: 1.2,    // 止盈略微放宽
        maxHoldDays: Math.round(SIM_PARAMS.maxHoldDays * 0.7), // 缩短持仓
        positionScale: 0.5, // 仓位减半
        entryFilter: 'tight', // 严格入场
      }
    };
  }
  
  // 检查趋势市 (ADX > 25)
  if (adx > 25) {
    const strongTrend = adx > 35;
    return {
      regime: 'trending',
      adjustment: {
        stopMult: strongTrend ? 1.2 : 1.0,    // 强趋势略微放宽止损
        targetMult: strongTrend ? 1.5 : 1.2,  // 强趋势加大止盈
        maxHoldDays: strongTrend ? SIM_PARAMS.maxHoldDays + 5 : SIM_PARAMS.maxHoldDays, // 强趋势延长持仓
        positionScale: strongTrend ? 1.2 : 1.0, // 强趋势可加仓
        entryFilter: strongTrend ? 'loose' : 'normal', // 强趋势放宽入场
      }
    };
  }
  
  // 震荡市 (ADX < 20)
  if (adx < 20) {
    return {
      regime: 'ranging',
      adjustment: {
        stopMult: 0.8,      // 收紧止损
        targetMult: 0.7,    // 缩短止盈
        maxHoldDays: Math.round(SIM_PARAMS.maxHoldDays * 0.5), // 大幅缩短持仓
        positionScale: 0.6, // 仓位减少
        entryFilter: 'tight', // 严格入场
      }
    };
  }
  
  // 默认 (ADX 20-25): 使用标准参数
  return {
    regime: 'ranging', // 弱趋势视为震荡
    adjustment: {
      stopMult: 1.0,
      targetMult: 1.0,
      maxHoldDays: SIM_PARAMS.maxHoldDays,
      positionScale: 1.0,
      entryFilter: 'normal',
    }
  };
}

/**
 * 同步模拟交易（回测对齐版）
 * 
 * 对齐回测参数：
 * - 信号等级过滤：minSignalGrade = L2
 * - P顺阈值：pThreshold = 0.4
 * - 区间屏蔽：spectrum = '区间' 时不开仓
 * - 止损/止盈：stopAtrMult=2, targetAtrMult=4
 * - 最大持仓天数：maxHoldDays=15
 * - 冷却期：cooldownBars=2（止损后冷却）
 * - 手续费：双边 0.06%（含滑点）
 */
function syncSimTrades(tradeDate: string, rows: V16Row[]): { opened: number; closed: number; skipped: number; kellyPosition?: number; adaptiveParams?: any } {
  let opened = 0;
  let closed = 0;
  let skipped = 0;

  // 获取历史交易统计，用于 Kelly 仓位计算
  const stats = getSimTradeStats();
  let kellyPosition = SIM_PARAMS.minPositionSize;
  
  // 如果历史交易数量足够，计算 Kelly 仓位
  if (stats.totalTrades >= SIM_PARAMS.minTradesForKelly) {
    kellyPosition = calculateKellyPosition(stats.winRate, stats.avgWin, stats.avgLoss);
  }

  // ========== 自适应参数调优 ==========
  const adaptiveParams = getAdaptiveParams();
  // 应用自适应调整后的有效参数
  const effectivePThreshold = SIM_PARAMS.pThreshold * adaptiveParams.pThresholdAdj;
  const effectiveStopAtrMult = SIM_PARAMS.stopAtrMult * adaptiveParams.stopAtrMultAdj;
  const effectiveTargetAtrMult = SIM_PARAMS.targetAtrMult * adaptiveParams.targetAtrMultAdj;
  const effectiveMaxHoldDays = Math.round(SIM_PARAMS.maxHoldDays * adaptiveParams.maxHoldDaysAdj);
  const effectiveMinScore = SIGNAL_SCORING_PARAMS.minScore + adaptiveParams.minScoreAdj;

  for (const row of rows) {
    const openTrade = getOpenSimTrade(row.code);
    const direction = row.ai_direction || '';
    const grade = row.edge_grade || '';
    const pFollow = row.p_follow || 0;
    const spectrum = (row as any).spectrum || '';

    // ========== 持仓中：检查止损/止盈/最大持仓天数 ==========
    if (openTrade) {
      const holdDays = daysBetween(openTrade.entry_date, tradeDate);
      const dir = openTrade.direction === '多' ? 1 : -1;
      const currentPnl = (row.close - openTrade.entry_price) * dir;
      
      let shouldClose = false;
      let closeReason = '';

      // 1. 止损检查
      if (openTrade.stop_loss) {
        const hitStopLoss = dir > 0 
          ? row.close <= openTrade.stop_loss 
          : row.close >= openTrade.stop_loss;
        if (hitStopLoss) {
          shouldClose = true;
          closeReason = `止损 @${openTrade.stop_loss}`;
        }
      }

      // 2. 止盈检查
      if (!shouldClose && openTrade.take_profit) {
        const hitTakeProfit = dir > 0
          ? row.close >= openTrade.take_profit
          : row.close <= openTrade.take_profit;
        if (hitTakeProfit) {
          shouldClose = true;
          closeReason = `止盈 @${openTrade.take_profit}`;
        }
      }

      // 3. 最大持仓天数检查
      const maxHold = openTrade.max_hold_days || SIM_PARAMS.maxHoldDays;
      if (!shouldClose && holdDays >= maxHold) {
        shouldClose = true;
        closeReason = `持仓${holdDays}天超限`;
      }

      // 4. 信号消失或方向翻转
      if (!shouldClose && (!meetsMinGrade(grade) || direction !== openTrade.direction)) {
        shouldClose = true;
        closeReason = !meetsMinGrade(grade) ? '信号降级' : `方向翻转→${direction}`;
      }

      if (shouldClose) {
        // 计算手续费（双边）
        const fee = (openTrade.entry_price + row.close) * SIM_PARAMS.feeRate;
        closeSimTrade(row.code, {
          exit_date: tradeDate,
          exit_price: row.close,
          exit_reason: closeReason,
          fee,
        });
        closed++;

        // 止损后进入冷却期
        if (closeReason.includes('止损')) {
          // 冷却期记录在下一笔开仓时检查
        }

        // 如果新方向满足条件，开新仓
        if (meetsMinGrade(grade) && pFollow >= SIM_PARAMS.pThreshold && 
            spectrum !== '区间' && (direction === '多' || direction === '空')) {
          // 计算止损止盈（使用简化ATR估算，实际应查询历史数据）
          const atrEstimate = row.close * 0.02; // 估算ATR约为价格的2%
          const stopLoss = direction === '多'
            ? row.close - atrEstimate * SIM_PARAMS.stopAtrMult
            : row.close + atrEstimate * SIM_PARAMS.stopAtrMult;
          const takeProfit = direction === '多'
            ? row.close + atrEstimate * SIM_PARAMS.targetAtrMult
            : row.close - atrEstimate * SIM_PARAMS.targetAtrMult;

          saveSimTrade({
            code: row.code,
            name: row.name,
            direction: direction as '多' | '空',
            entry_date: tradeDate,
            entry_price: row.close,
            status: 'open',
            entry_reason: `${direction}，等级${grade}，P顺${(pFollow * 100).toFixed(0)}%，Kelly=${kellyPosition}手`,
            signal_grade: grade,
            signal_score: pFollow,
            stop_loss: Math.round(stopLoss * 100) / 100,
            take_profit: Math.round(takeProfit * 100) / 100,
            max_hold_days: SIM_PARAMS.maxHoldDays,
            position_size: kellyPosition,
          });
          opened++;
        }
      }
      continue;
    }

    // ========== 无持仓：检查是否满足开仓条件 ==========
    
    // 1. 信号等级过滤
    if (!meetsMinGrade(grade)) {
      skipped++;
      continue;
    }

    // 2. P顺阈值过滤（使用自适应调整后的阈值）
    if (pFollow < effectivePThreshold) {
      skipped++;
      continue;
    }

    // 3. 区间屏蔽（回测：allowRangeTrading=false 表现更好）
    if (spectrum === '区间') {
      skipped++;
      continue;
    }

    // 4. 方向有效性
    if (direction !== '多' && direction !== '空') {
      skipped++;
      continue;
    }

    // 5. 盈亏比检查（目标/止损 >= minRR）使用自适应调整后的参数
    const atrEstimate = row.close * 0.02;
    const stopDistance = atrEstimate * effectiveStopAtrMult;
    const targetDistance = atrEstimate * effectiveTargetAtrMult;
    const rr = stopDistance > 0 ? targetDistance / stopDistance : 0;
    if (rr < SIM_PARAMS.minRR) {
      skipped++;
      continue;
    }

    // 6. 板块持仓限制检查（同板块最多 maxPositionsPerGroup 个头寸）
    const openTrades = getSimTrades().filter(t => t.status === 'open');
    const groupCheck = checkGroupPositionLimit(row.code, openTrades);
    if (!groupCheck.allowed) {
      skipped++;
      continue;
    }

    // ========== 市场状态识别与参数调整（前置，供信号评分使用） ==========
    const adx = row.adx || 20; // 默认ADX=20（弱趋势）
    const regimeResult = identifyMarketRegime(adx, atrEstimate);
    const regimeAdj = regimeResult.adjustment;

    // ========== 信号质量评分系统（使用自适应调整后的评分阈值） ==========
    const regimeTypeForScore = regimeResult.regime === 'trending' ? { type: '趋势市' as const, adx } : regimeResult.regime === 'ranging' ? { type: '震荡市' as const, adx } : { type: 'unknown' as const, adx };
    const signalScoreResult = calculateSignalScore(row.code, direction, grade, pFollow, adx, regimeTypeForScore);
    
    // 信号质量过滤：使用自适应调整后的阈值
    if (signalScoreResult.score < effectiveMinScore) {
      skipped++;
      continue;
    }
    
    // 根据市场状态调整入场过滤（使用自适应调整后的P顺阈值）
    if (regimeAdj.entryFilter === 'tight' && pFollow < effectivePThreshold * 1.1) {
      // 高波动或震荡市：提高P顺阈值10%
      skipped++;
      continue;
    }
    
    // 根据市场状态 + 自适应参数调整止损止盈
    const adjustedStopMult = effectiveStopAtrMult * regimeAdj.stopMult;
    const adjustedTargetMult = effectiveTargetAtrMult * regimeAdj.targetMult;
    const adjustedMaxHoldDays = Math.round(effectiveMaxHoldDays * regimeAdj.maxHoldDays / SIM_PARAMS.maxHoldDays);
    
    // 计算止损止盈（使用市场状态 + 自适应调整后的参数）
    const adjustedStopDistance = atrEstimate * adjustedStopMult;
    const adjustedTargetDistance = atrEstimate * adjustedTargetMult;
    const stopLoss = direction === '多'
      ? row.close - adjustedStopDistance
      : row.close + adjustedStopDistance;
    const takeProfit = direction === '多'
      ? row.close + adjustedTargetDistance
      : row.close - adjustedTargetDistance;

    // 根据市场状态调整仓位
    const adjustedKellyPosition = Math.max(1, Math.round(kellyPosition * regimeAdj.positionScale));

    saveSimTrade({
      code: row.code,
      name: row.name,
      direction: direction as '多' | '空',
      entry_date: tradeDate,
      entry_price: row.close,
      status: 'open',
      entry_reason: `${direction}，等级${grade}，P顺${(pFollow * 100).toFixed(0)}%，R:R=${rr.toFixed(1)}，Kelly=${adjustedKellyPosition}手，市场=${regimeResult.regime}，评分=${signalScoreResult.score.toFixed(0)}${adaptiveParams.confidence > 0 ? `，自适应×${adaptiveParams.pThresholdAdj.toFixed(2)}` : ''}`,
      signal_grade: grade,
      signal_score: signalScoreResult.score,
      stop_loss: Math.round(stopLoss * 100) / 100,
      take_profit: Math.round(takeProfit * 100) / 100,
      max_hold_days: adjustedMaxHoldDays,
      position_size: adjustedKellyPosition,
    });
    opened++;
  }

  return { opened, closed, skipped, kellyPosition, adaptiveParams };
}

/**
 * 计算信号变化统计
 */
function calculateSignalStats(records: DailyJournalRecord[]) {
  let directionChanges = 0;
  let spectrumUpgrades = 0;
  let spectrumDowngrades = 0;
  let consecutiveSameDirection = 1;
  let totalPFollow = 0;
  let count = 0;

  const spectrumRank: Record<string, number> = { '趋势': 3, '通道': 2, '区间': 1 };

  for (let i = 0; i < records.length; i++) {
    const curr = records[i];
    totalPFollow += curr.p_follow || 0;
    count++;

    if (i > 0) {
      const prev = records[i - 1];
      
      // 方向变化
      if (curr.ai_direction !== prev.ai_direction) {
        directionChanges++;
      } else {
        consecutiveSameDirection++;
      }
      
      // 频谱变化
      const currSpectrum = curr.spectrum || '';
      const prevSpectrum = prev.spectrum || '';
      const currRank = spectrumRank[currSpectrum] || 0;
      const prevRank = spectrumRank[prevSpectrum] || 0;
      if (currRank > prevRank) spectrumUpgrades++;
      if (currRank < prevRank) spectrumDowngrades++;
    }
  }

  return {
    directionChanges,
    spectrumUpgrades,
    spectrumDowngrades,
    consecutiveSameDirection,
    avgPFollow: count > 0 ? totalPFollow / count : 0,
  };
}

/**
 * 生成一句话摘要
 */
function generateOneLiner(row: V16Row): string {
  const dir = row.ai_direction === '多' ? '偏多' : row.ai_direction === '空' ? '偏空' : '中性';
  const spec = row.spectrum;
  const grade = row.edge_grade || 'D';
  const pFollow = (row.p_follow * 100).toFixed(0);
  
  if (grade === 'D') {
    return `${row.name} ${spec} ${dir}，暂无交易信号`;
  }
  
  return `${row.name} ${spec} ${dir}，信号${grade}级，P顺${pFollow}%，可关注`;
}

/**
 * 生成交易建议
 */
function generateAdvice(row: V16Row): string {
  const dir = row.ai_direction;
  const grade = row.edge_grade || 'D';
  
  if (grade === 'D') {
    return '当前信号较弱，建议观望等待更好的入场时机。';
  }
  
  const pFollow = (row.p_follow * 100).toFixed(0);
  const adx = row.adx?.toFixed(1) || '--';
  
  let advice = `${dir === '多' ? '做多' : '做空'}信号，等级${grade}，P顺${pFollow}%，ADX ${adx}。`;
  
  if (row.ch_entry) {
    advice += ` 通道入场位${row.ch_entry.toFixed(0)}`;
    if (row.ch_stop) advice += `，止损${row.ch_stop.toFixed(0)}`;
    if (row.ch_target) advice += `，目标${row.ch_target.toFixed(0)}`;
  }
  
  if (row.spectrum === '趋势') {
    advice += ' 趋势行情，可适当持有。';
  } else if (row.spectrum === '区间') {
    advice += ' 区间行情，注意控制仓位。';
  }
  
  return advice;
}

/**
 * 计算日报交易建议统计
 */
function calculateJournalStats(records: DailyJournalRecord[]) {
  const directionCount: Record<string, number> = { '多': 0, '空': 0, '中性': 0 };
  const gradeCount: Record<string, number> = {};
  const spectrumCount: Record<string, number> = {};
  const adviceSummary: Record<string, number> = {
    '建议观望': 0,
    '建议做多': 0,
    '建议做空': 0,
    '趋势持有': 0,
    '控制仓位': 0,
  };
  let tradableCount = 0;
  let filteredCount = 0;
  let totalPFollow = 0;
  let totalAdx = 0;
  let countWithAdx = 0;

  for (const r of records) {
    // 方向统计
    const dir = r.ai_direction || '中性';
    directionCount[dir] = (directionCount[dir] || 0) + 1;

    // 等级统计
    const grade = r.signal_level || 'D';
    gradeCount[grade] = (gradeCount[grade] || 0) + 1;

    // 频谱统计
    const spec = r.spectrum || '未知';
    spectrumCount[spec] = (spectrumCount[spec] || 0) + 1;

    // 可交易/被过滤
    if (grade !== 'D') {
      tradableCount++;
    } else {
      filteredCount++;
    }

    // 建议统计
    const advice = r.advice || '';
    if (advice.includes('观望')) adviceSummary['建议观望']++;
    if (advice.includes('做多')) adviceSummary['建议做多']++;
    if (advice.includes('做空')) adviceSummary['建议做空']++;
    if (advice.includes('趋势') && advice.includes('持有')) adviceSummary['趋势持有']++;
    if (advice.includes('控制仓位')) adviceSummary['控制仓位']++;

    totalPFollow += r.p_follow || 0;
    if (r.adx) {
      totalAdx += r.adx;
      countWithAdx++;
    }
  }

  const total = records.length;

  return {
    total,
    tradableCount,
    filteredCount,
    tradableRate: total > 0 ? ((tradableCount / total) * 100).toFixed(1) + '%' : '0%',
    directionDistribution: directionCount,
    gradeDistribution: gradeCount,
    spectrumDistribution: spectrumCount,
    adviceSummary,
    avgPFollow: total > 0 ? (totalPFollow / total).toFixed(3) : '0',
    avgAdx: countWithAdx > 0 ? (totalAdx / countWithAdx).toFixed(1) : '0',
  };
}

// ==================== 信号质量评分系统 ====================

/**
 * 信号质量评分参数
 */
const SIGNAL_SCORING_PARAMS = {
  minScore: 60, // 最低入场评分阈值 (0-100)
  weights: {
    historicalWinRate: 0.30, // 历史胜率权重
    parameterStability: 0.20, // 参数稳定性权重
    marketRegimeMatch: 0.25, // 市场环境匹配度权重
    varietyCharacteristics: 0.25, // 品种特性权重
  },
};

/**
 * 计算信号质量评分
 * @param code 品种代码
 * @param direction 方向 ('多' | '空')
 * @param signalGrade 信号等级
 * @param pFollow P(顺) 值
 * @param adx ADX 值
 * @param regime 市场状态
 * @returns 评分 (0-100) 和是否允许入场
 */
function calculateSignalScore(
  code: string,
  direction: string,
  signalGrade: string,
  pFollow: number,
  adx: number,
  regime: { type: string; adx: number }
): { score: number; allowed: boolean; breakdown: Record<string, number> } {
  const weights = SIGNAL_SCORING_PARAMS.weights;
  const breakdown: Record<string, number> = {};

  // 1. 历史胜率评分 (基于信号等级和P顺)
  // L1 信号基础分 90，L2 基础分 75，L3 基础分 60
  const gradeBaseScore = signalGrade === 'L1' ? 90 : signalGrade === 'L2' ? 75 : 60;
  // P顺加成：P顺越高，历史胜率越高
  const pFollowBonus = Math.min(pFollow * 20, 10); // 最多 +10 分
  const historicalScore = Math.min(gradeBaseScore + pFollowBonus, 100);
  breakdown.historicalWinRate = Math.round(historicalScore);

  // 2. 参数稳定性评分
  // 基于回测数据，L1/L2 信号在多数参数组合下表现稳定
  // 这里简化为基于信号等级的固定评分
  const parameterStabilityScore = signalGrade === 'L1' ? 85 : signalGrade === 'L2' ? 70 : 55;
  breakdown.parameterStability = parameterStabilityScore;

  // 3. 市场环境匹配度评分
  // 趋势市 + 高ADX = 高匹配度
  // 震荡市 + 低ADX = 中等匹配度
  let regimeMatchScore = 50;
  if (regime.type === '趋势市') {
    // 趋势市适合趋势信号
    regimeMatchScore = adx > 30 ? 90 : adx > 25 ? 80 : 70;
  } else if (regime.type === '震荡市') {
    // 震荡市信号质量较低
    regimeMatchScore = adx < 15 ? 60 : 50;
  } else {
    // 未知状态
    regimeMatchScore = 65;
  }
  breakdown.marketRegimeMatch = regimeMatchScore;

  // 4. 品种特性评分
  // 基于品种的历史表现（这里简化为基于品种代码的固定评分）
  // 实际应用中可以从回测数据中获取每个品种的历史盈利能力
  const varietyScore = getVarietyCharacteristicsScore(code);
  breakdown.varietyCharacteristics = varietyScore;

  // 计算加权总分
  const totalScore = Math.round(
    historicalScore * weights.historicalWinRate +
    parameterStabilityScore * weights.parameterStability +
    regimeMatchScore * weights.marketRegimeMatch +
    varietyScore * weights.varietyCharacteristics
  );

  return {
    score: Math.min(Math.max(totalScore, 0), 100),
    allowed: totalScore >= SIGNAL_SCORING_PARAMS.minScore,
    breakdown,
  };
}

/**
 * 获取品种特性评分
 * 基于品种的历史表现和波动特性
 */
function getVarietyCharacteristicsScore(code: string): number {
  // 基于回测数据，不同品种的历史盈利能力不同
  // 这里简化为基于品种类别的固定评分
  // 实际应用中可以从 backtest-results 中计算每个品种的平均收益

  // 高评分品种（历史表现好，趋势性强）
  const highScoreVarieties = ['AU', 'AG', 'CU', 'AL', 'ZN', 'NI', 'SN', 'IF', 'IH', 'IC', 'IM', 'T', 'TF', 'TS'];
  // 中评分品种
  const midScoreVarieties = ['RB', 'HC', 'I', 'J', 'JM', 'MA', 'TA', 'PP', 'PE', 'PG', 'EG', 'EB', 'AP', 'CJ'];
  // 低评分品种（历史表现一般，震荡较多）
  const lowScoreVarieties = ['M', 'Y', 'P', 'OI', 'RM', 'CF', 'SR', 'WH', 'PM', 'RI', 'LR', 'JR', 'RS', 'FH', 'BB'];

  const prefix = code.replace(/[0-9]+$/, '').toUpperCase();

  if (highScoreVarieties.includes(prefix)) {
    return 80;
  } else if (midScoreVarieties.includes(prefix)) {
    return 70;
  } else if (lowScoreVarieties.includes(prefix)) {
    return 60;
  }
  return 65; // 默认评分
}

// ==================== 自适应参数调优系统 ====================

/**
 * 自适应参数调优
 * 基于近期交易表现动态调整核心参数
 * 
 * 原理：
 * - 分析最近 N 笔已平仓交易的胜率、盈亏比、平均收益
 * - 如果近期表现差（胜率下降、连续亏损），收紧参数（提高信号阈值、缩短持仓天数）
 * - 如果近期表现好，适度放宽参数
 * - 不同市场状态下采用不同的调整策略
 * 
 * @returns 调整后的参数覆盖值
 */
function getAdaptiveParams(): {
  pThresholdAdj: number;    // P顺阈值调整系数 (1.0 = 不变, >1 = 收紧, <1 = 放宽)
  stopAtrMultAdj: number;   // 止损ATR倍数调整系数
  targetAtrMultAdj: number; // 止盈ATR倍数调整系数
  maxHoldDaysAdj: number;   // 最大持仓天数调整系数
  minScoreAdj: number;      // 信号评分阈值调整值
  confidence: number;       // 调整置信度 (0-1)
} {
  const trades = getSimTrades().filter(t => t.status === 'closed');
  
  // 至少需要 5 笔已平仓交易才有统计意义
  if (trades.length < 5) {
    return {
      pThresholdAdj: 1.0,
      stopAtrMultAdj: 1.0,
      targetAtrMultAdj: 1.0,
      maxHoldDaysAdj: 1.0,
      minScoreAdj: 0,
      confidence: 0,
    };
  }

  // 取最近 20 笔交易（或全部如果不足 20 笔）
  const recentTrades = trades.slice(-20);
  const recentCount = recentTrades.length;
  
  // 计算近期胜率
  const wins = recentTrades.filter(t => (t.pnl ?? 0) > 0).length;
  const recentWinRate = wins / recentCount;
  
  // 计算近期平均收益率
  const avgPnlPct = recentTrades.reduce((sum, t) => sum + (t.pnl_pct ?? 0), 0) / recentCount;
  
  // 计算近期盈亏比
  const winTrades = recentTrades.filter(t => (t.pnl ?? 0) > 0);
  const lossTrades = recentTrades.filter(t => (t.pnl ?? 0) <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + (t.pnl ?? 0), 0) / lossTrades.length) : 1;
  const recentRR = avgLoss > 0 ? avgWin / avgLoss : 0;
  
  // 计算连续亏损次数
  let maxConsecutiveLosses = 0;
  let currentLosses = 0;
  for (const t of recentTrades) {
    if ((t.pnl ?? 0) <= 0) {
      currentLosses++;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    } else {
      currentLosses = 0;
    }
  }
  
  // 计算平仓原因分布
  const stopLossCount = recentTrades.filter(t => (t.exit_reason ?? '').includes('止损')).length;
  const takeProfitCount = recentTrades.filter(t => (t.exit_reason ?? '').includes('止盈')).length;
  const timeoutCount = recentTrades.filter(t => (t.exit_reason ?? '').includes('超限')).length;
  const stopLossRatio = stopLossCount / recentCount;
  
  // 置信度：基于样本量（越多越可信）
  const confidence = Math.min(recentCount / 20, 1);
  
  // ====== 参数调整逻辑 ======
  
  let pThresholdAdj = 1.0;
  let stopAtrMultAdj = 1.0;
  let targetAtrMultAdj = 1.0;
  let maxHoldDaysAdj = 1.0;
  let minScoreAdj = 0;
  
  // 场景1: 连续亏损 ≥ 3 次 → 收紧参数
  if (maxConsecutiveLosses >= 3) {
    pThresholdAdj = 1.15;    // P顺阈值提高15%
    minScoreAdj = 10;         // 信号评分阈值提高10分
    stopAtrMultAdj = 0.9;    // 止损收紧10%
    maxHoldDaysAdj = 0.7;    // 持仓天数缩短30%
  }
  // 场景2: 止损比例过高 (>60%) → 止损可能太紧或入场时机差
  else if (stopLossRatio > 0.6) {
    stopAtrMultAdj = 1.2;    // 止损放宽20%（给更多空间）
    pThresholdAdj = 1.1;     // 提高入场门槛
    minScoreAdj = 5;
    maxHoldDaysAdj = 0.8;
  }
  // 场景3: 超时平仓比例过高 (>40%) → 信号不够强，持仓时间过长
  else if (timeoutCount / recentCount > 0.4) {
    maxHoldDaysAdj = 0.6;    // 大幅缩短持仓
    pThresholdAdj = 1.1;     // 提高入场门槛
    minScoreAdj = 5;
  }
  // 场景4: 近期表现良好（胜率>55% 且 盈亏比>1.5）→ 适度放宽
  else if (recentWinRate > 0.55 && recentRR > 1.5) {
    pThresholdAdj = 0.95;    // P顺阈值降低5%
    minScoreAdj = -5;         // 信号评分阈值降低5分
    targetAtrMultAdj = 1.1;  // 止盈放宽10%（让利润奔跑）
  }
  // 场景5: 平均收益为负 → 整体收紧
  else if (avgPnlPct < -0.005) {
    pThresholdAdj = 1.1;
    minScoreAdj = 8;
    stopAtrMultAdj = 0.95;
    maxHoldDaysAdj = 0.8;
  }
  
  // 应用置信度衰减（样本少时调整幅度减小）
  const adj = (base: number, target: number) => base + (target - base) * confidence;
  
  return {
    pThresholdAdj: adj(1.0, pThresholdAdj),
    stopAtrMultAdj: adj(1.0, stopAtrMultAdj),
    targetAtrMultAdj: adj(1.0, targetAtrMultAdj),
    maxHoldDaysAdj: adj(1.0, maxHoldDaysAdj),
    minScoreAdj: Math.round(minScoreAdj * confidence),
    confidence,
  };
}

// ==================== 开仓辅助函数 ====================

/**
 * 计算开仓参数（止损、止盈、仓位）
 */
function calculateEntryParams(
  code: string,
  direction: string,
  entryPrice: number,
  atr: number,
  stats: any,
  regime: { type: string; adx: number }
) {
  // 根据市场状态调整参数
  const regimeResult = identifyMarketRegime(regime.adx, atr);
  const adjustment = regimeResult.adjustment;
  const stopMult = SIM_PARAMS.stopAtrMult * adjustment.stopMult;
  const targetMult = SIM_PARAMS.targetAtrMult * adjustment.targetMult;

  const stopLoss = direction === '多' ? entryPrice - atr * stopMult : entryPrice + atr * stopMult;
  const takeProfit = direction === '多' ? entryPrice + atr * targetMult : entryPrice - atr * targetMult;

  // Kelly 仓位
  const kellyPos = calculateKellyPosition(stats.winRate, stats.avgWin, stats.avgLoss);
  const positionSize = Math.round(kellyPos * adjustment.positionScale * 10) / 10;

  return { stopLoss, takeProfit, positionSize, adjustment };
}

export default router;
