import { Router } from 'express';
import { VARIETIES, VARIETY_GROUPS, DISABLED_VARIETIES } from '../services/varieties.js';
import { calcATR } from '../services/indicators.js';
import { getVarietyData, getAvailableContracts } from '../services/dataFetcher.js';
import { runV16FullScan, runV16FullScan30m, scanV16Variety } from '../services/v16_engine.js';
import type { V16Row, V16ScanResult } from '../services/v16_types.js';
import { searchVarietyNews, searchMarketNews } from '../services/newsService.js';
import {
  saveSignalRecords,
  getSignalHistory,
  getVarietySignalHistory,
  getActiveTrendTracking,
  getVarietyTrendHistory,
  startTrendTracking,
  updateTrendTracking,
  endTrendTracking,
  getSignalStats,
  getAllVarietyPerformance,
  getSuitableVarieties,
  updateVarietyPerformance,
  getDb,
  type SignalRecord,
} from '../services/database.js';
import { runBacktest, runAllBacktests, generateBacktestReport } from '../services/backtest.js';
import { backtestMultiTimeframe } from '../services/multiTimeframeBacktest.js';
import { stopLossManager, correlationMonitor, PositionSizer } from '../services/riskManager.js';
import {
  runAllSingleFactorTestsAsync,
  walkForwardBacktest,
  signalDecayTest,
  runFullResearch,
} from '../services/research.js';
import { getPriceActionData, getPriceActionSummary } from '../services/aiAssistant.js';
import { getSimulatedAccount, getAccountDiscipline } from '../services/tradingRecord.js';
import { getVarietyGrade, getAllVarietyGrades, getAllCalibratedGrades, getCalibratedGrade, VARIETY_GRADE_LABELS } from '../services/varietyGrade.js';
import { generateStopLossAdvice } from '../services/stopLossAdvice.js';
import { calcTradeCost, getSlippageConfig, estimateLiquidityLevel } from '../services/tradingCostModel.js';
import { checkAccountRisk, suggestPositionSize, CORRELATED_GROUPS, type PositionInfo } from '../services/accountRiskMonitor.js';
import { computeCorrelationMatrix, getHighCorrelationPairs, checkConcentrationRisk } from '../services/correlationMatrix.js';
import { calcSignalDecay, applySignalDecay } from '../services/signalDecay.js';
import { generatePerformanceReport } from '../services/performanceReport.js';

const router = Router();

// 缓存扫描结果
let scanCache: { report: V16ScanResult; timestamp: number } | null = null;
const CACHE_TTL = 15 * 60 * 1000; // 15分钟缓存（5分钟过短导致手机端频繁触发26s全量扫描）

// 导出缓存访问函数
export function getScanCache(): V16ScanResult | null {
  return scanCache?.report || null;
}

/**
 * 为扫描结果中的每个品种生成一句话总结与投资建议。
 * 统一在此处生成，确保无论哪个路由更新缓存，report.rows 都带有 one_liner / advice 字段。
 */
function decorateReportWithAdvice(report: V16ScanResult): V16ScanResult {
  for (const row of report.rows) {
    (row as any).one_liner = generateOneLiner(row);
    (row as any).advice = generateAdvice(row);
    // 附加品种稳健性分级（1000 次回测三维度 + 实盘校准），供前端展示信任指标与仓位联动
    const grade = getVarietyGrade(row.code);
    const calibrated = getCalibratedGrade(row.code);
    (row as any).grade = grade?.grade ?? null;
    (row as any).grade_label = grade?.gradeLabel ?? null;
    (row as any).robust_pct = grade?.robustPct ?? null;
    (row as any).crash_pct = grade?.crashPct ?? null;
    (row as any).profitable_pct = grade?.profitablePct ?? null;
    (row as any).calibrated_grade = calibrated.calibratedGrade;
    (row as any).calibrated_grade_label = calibrated.calibratedGradeLabel;
    (row as any).calibration_note = calibrated.calibrationNote;
  }
  return report;
}

/**
 * 服务启动时预加载扫描缓存
 * 异步执行，失败不抛出异常（避免阻塞服务启动）
 */
export async function preloadScanCache(): Promise<void> {
  try {
    if (scanCache && Date.now() - scanCache.timestamp < CACHE_TTL) {
      console.log('[ScanPreload] 缓存已就绪，跳过预加载');
      return;
    }
    const report = await runV16FullScan();
    scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    console.log(
      `[ScanPreload] V16 扫描完成: ${report.rows.length} 品种, ${report.tradable.length} 可交易, ${report.filtered.length} 被过滤`
    );
  } catch (err) {
    console.error('[ScanPreload] 预加载扫描失败:', (err as Error).message);
  }
}

/**
 * 预热 30 分钟 K 线缓存（为 AI 分析提供数据）
 * 对所有品种执行 30 分钟扫描，将结果写入 data-cache-30m-long/ 目录
 */
export async function preload30mCache(): Promise<void> {
  try {
    console.log('[30mPreload] 开始预热 30 分钟 K 线缓存...');
    const result = await runV16FullScan30m();
    console.log(`[30mPreload] 30 分钟扫描完成: ${result.rows?.length || 0} 品种已处理`);
  } catch (err) {
    console.error('[30mPreload] 30 分钟缓存预热失败:', (err as Error).message);
  }
}

/**
 * 定时续热 scan 缓存：每 10 分钟后台重扫一次，
 * 保证缓存永不过期（避免缓存 TTL 到期后首次请求白屏 20s+）
 */
export function startScanCacheRefresh(): NodeJS.Timeout {
  const timer = setInterval(async () => {
    try {
      const report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
      console.log(`[ScanRefresh] 定时续热完成: ${report.rows.length} 品种, ${report.tradable.length} 可交易`);
    } catch (err) {
      console.error('[ScanRefresh] 定时续热失败:', (err as Error).message);
    }
  }, 10 * 60 * 1000);
  // 不阻止进程退出
  timer.unref?.();
  return timer;
}

// 静态路由在前
// GET /api/v1/scan - 全品种扫描（主入口，V16.2信号驱动）
router.get('/scan', async (_req, res) => {
  try {
    if (scanCache && Date.now() - scanCache.timestamp < CACHE_TTL) {
      const report = scanCache.report;
      return res.json({
        total: report.rows.length,
        tradable_count: report.tradable.length,
        filtered_count: report.filtered.length,
        rows: report.rows.map(r => ({
          ...serializeV16Row(r),
          pa_summary: getPriceActionSummary(r.code, r),
        })),
        tradable: report.tradable.map(r => ({
          ...serializeV16Row(r),
          pa_summary: getPriceActionSummary(r.code, r),
        })),
        filtered: report.filtered.map((f) => ({ code: f.code, name: f.name, reason: f.reason })),
        market_summary: `V16.2扫描完成: ${report.tradable.length}个可交易, ${report.filtered.length}个被过滤`,
        cache: true,
      });
    }

    const report = await runV16FullScan();
    scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    res.json({
      scanTime: report.scanTime,
      total: report.rows.length,
      tradable_count: report.tradable.length,
      filtered_count: report.filtered.length,
      rows: report.rows.map(r => ({
        ...serializeV16Row(r),
        pa_summary: getPriceActionSummary(r.code, r),
      })),
      tradable: report.tradable.map(r => ({
        ...serializeV16Row(r),
        pa_summary: getPriceActionSummary(r.code, r),
      })),
      filtered: report.filtered.map((f) => ({ code: f.code, name: f.name, reason: f.reason })),
      timing: report.timing,
    });
  } catch (err) {
    console.error('Full scan error:', err);
    res.status(500).json({ error: '扫描失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/groups - 获取品种分组
router.get('/scan/groups', (_req, res) => {
  res.json({ groups: VARIETY_GROUPS });
});

// GET /api/v1/scan/varieties - 获取品种列表（含停用状态）
router.get('/scan/varieties', (_req, res) => {
  const varietiesWithStatus = Object.entries(VARIETIES).map(([code, name]) => ({
    code,
    name,
    enabled: !DISABLED_VARIETIES.has(code),
  }));
  const enabledCount = varietiesWithStatus.filter((v) => v.enabled).length;
  const disabledCount = varietiesWithStatus.filter((v) => !v.enabled).length;
  res.json({ 
    varieties: VARIETIES,
    varietiesWithStatus,
    disabledCount,
    enabledCount,
  });
});

// GET /api/v1/scan/summary - 获取市场概览
router.get('/scan/summary', async (_req, res) => {
  try {
    if (scanCache && Date.now() - scanCache.timestamp < CACHE_TTL) {
      return res.json(scanCache.report);
    }

    const report = await runV16FullScan();
    scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    res.json(report);
  } catch (err) {
    console.error('Scan summary error:', err);
    res.status(500).json({ error: '扫描失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/market-insight - 封面 Brooks 市场洞察（规则生成，无 LLM 延迟）
router.get('/scan/market-insight', async (_req, res) => {
  try {
    let report = scanCache?.report;
    if (!report || Date.now() - (scanCache?.timestamp || 0) > CACHE_TTL) {
      report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    }
    if (!report) throw new Error('扫描结果为空');

    const rows = report.rows || [];
    const tradable = report.tradable || [];
    const filteredMap = new Map(report.filtered.map((f) => [f.code, f.reason]));

    const gradeRank = (g?: string) => (g === 'A' ? 0 : g === 'B' ? 1 : g === 'C' ? 2 : g === 'D' ? 3 : 4);

    // 重点推荐：可交易 + A/B级 + Gate4>=4，按稳健级与P(顺)排序
    const recommendations = tradable
      .filter((r) => ['A', 'B'].includes((r as any).grade || '') && (r.g4_reason_count ?? 0) >= 4)
      .sort((a, b) => gradeRank((a as any).grade) - gradeRank((b as any).grade) || (b.p_follow ?? 0) - (a.p_follow ?? 0))
      .slice(0, 3)
      .map((r) => ({
        code: r.code,
        name: r.name,
        type: 'recommend' as const,
        title: `${r.name}(${r.code}) ${(r as any).grade || ''}级·Gate4=${r.g4_reason_count}/5`,
        detail: `可交易 · ${(r as any).grade_label || '稳健'} · ${r.ai_direction === '多' ? '做多' : r.ai_direction === '空' ? '做空' : '观望'} · P(顺)${(r.p_follow ?? 0).toFixed(2)}`,
      }));

    // 重点警示：高信号但被过滤（Gate4>=4 却 trade_worthiness=filtered），如 CJ0 场景
    const cautions = rows
      .filter((r) => r.trade_worthiness !== 'tradable' && (r.g4_reason_count ?? 0) >= 4)
      .sort((a, b) => (b.g4_reason_count ?? 0) - (a.g4_reason_count ?? 0))
      .slice(0, 3)
      .map((r) => ({
        code: r.code,
        name: r.name,
        type: 'caution' as const,
        title: `${r.name}(${r.code}) Gate4=${r.g4_reason_count}/5 但被过滤`,
        detail: filteredMap.get(r.code) || r.g4_verdict || '信号不满足入场条件',
      }));

    // A/B/C/D 分级分布（1000次回测三维度）
    const gradeDist = { A: 0, B: 0, C: 0, D: 0 };
    getAllVarietyGrades().forEach((g) => {
      if (gradeDist[g.grade] !== undefined) gradeDist[g.grade]++;
    });

    const longCount = tradable.filter((r) => r.ai_direction === '多').length;
    const shortCount = tradable.filter((r) => r.ai_direction === '空').length;
    const totalCount = rows.length;
    const tradableCount = tradable.length;
    const abSignals = recommendations.length;

    // 规则生成一句话市场总结
    let marketState = '区间震荡';
    const bullShare = tradableCount > 0 ? longCount / tradableCount : 0;
    if (bullShare >= 0.6) marketState = '偏多格局';
    else if (bullShare <= 0.4) marketState = '偏空格局';
    else if (tradableCount >= totalCount * 0.5) marketState = '强趋势格局';

    const aiSummaryParts: string[] = [];
    aiSummaryParts.push(`全市场 ${totalCount} 个品种，${tradableCount} 个可交易（${Math.round((tradableCount / Math.max(totalCount, 1)) * 100)}%），呈${marketState}。`);
    if (abSignals > 0) {
      aiSummaryParts.push(`A/B级稳健信号 ${abSignals} 个，优先关注 ${recommendations.map((r) => r.name).join('、')}。`);
    }
    if (cautions.length > 0) {
      aiSummaryParts.push(`注意 ${cautions.length} 个高分信号被过滤（${cautions.map((r) => r.name).join('、')}），暂不适合交易。`);
    } else {
      aiSummaryParts.push('当前无高分信号被过滤，信号与过滤结果一致。');
    }

    res.json({
      generated_at: new Date().toISOString(),
      market_state: marketState,
      tradable_count: tradableCount,
      total_count: totalCount,
      long_count: longCount,
      short_count: shortCount,
      grade_distribution: gradeDist,
      recommendations,
      cautions,
      ai_summary: aiSummaryParts.join(' '),
    });
  } catch (err) {
    console.error('Market insight error:', err);
    res.status(500).json({ error: '生成市场洞察失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/alerts - 获取预警（V16.2 tradable + 高风险filtered）
router.get('/scan/alerts', async (_req, res) => {
  try {
    let report = scanCache?.report;
    if (!report || Date.now() - (scanCache?.timestamp || 0) > CACHE_TTL) {
      report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    }

    res.json({
      tradable: report.tradable.map(serializeV16Row),
      filtered_high_risk: report.filtered
        .filter((r: { code: string; name: string; reason: string }) => r.reason.includes('P(顺)') || r.reason.includes('Gate4'))
        .slice(0, 10),
      summary: `V16.2扫描完成: ${report.tradable.length}个可交易, ${report.filtered.length}个被过滤`,
    });
  } catch (err) {
    console.error('Alerts error:', err);
    res.status(500).json({ error: '获取预警失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/ranked - 获取按P(顺)排序的tradable列表（V16.2）
router.get('/scan/ranked', async (_req, res) => {
  try {
    let report = scanCache?.report;
    if (!report || Date.now() - (scanCache?.timestamp || 0) > CACHE_TTL) {
      report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    }

    // 按P(顺)降序 + CH信号优先
    const ranked = [...report.tradable]
      .sort((a, b) => {
        if (a.ch_has_signal && !b.ch_has_signal) return -1;
        if (!a.ch_has_signal && b.ch_has_signal) return 1;
        return b.p_follow - a.p_follow;
      })
      .map(serializeV16Row);

    res.json({ total: ranked.length, results: ranked });
  } catch (err) {
    console.error('Ranked error:', err);
    res.status(500).json({ error: '获取排序失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/history - 获取历史信号记录
router.get('/scan/history', (req, res) => {
  try {
    const { code, signalLevel, limit, offset } = req.query;
    const result = getSignalHistory({
      code: code as string,
      signalLevel: signalLevel as string,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });
    res.json(result);
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: '获取历史失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/history/:code - 获取品种历史信号
router.get('/scan/history/:code', (req, res) => {
  try {
    const { code } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 30;
    const records = getVarietySignalHistory(code, limit);
    res.json({ code, records });
  } catch (err) {
    console.error('Variety history error:', err);
    res.status(500).json({ error: '获取历史失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/tracking - 获取活跃的趋势跟踪
router.get('/scan/tracking', (_req, res) => {
  try {
    const active = getActiveTrendTracking();
    res.json({ active, count: active.length });
  } catch (err) {
    console.error('Tracking error:', err);
    res.status(500).json({ error: '获取跟踪失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/tracking/:code - 获取品种趋势跟踪历史
router.get('/scan/tracking/:code', (req, res) => {
  try {
    const { code } = req.params;
    const records = getVarietyTrendHistory(code);
    res.json({ code, records });
  } catch (err) {
    console.error('Variety tracking error:', err);
    res.status(500).json({ error: '获取跟踪失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/stats - 获取信号统计
router.get('/scan/stats', (req, res) => {
  try {
    const days = req.query.days ? parseInt(req.query.days as string) : 7;
    const stats = getSignalStats(days);
    res.json(stats);
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: '获取统计失败', message: (err as Error).message });
  }
});

// POST /api/v1/scan/save - 保存当前扫描结果到历史
router.post('/scan/save', async (_req, res) => {
  try {
    let report = scanCache?.report;
    if (!report || Date.now() - (scanCache?.timestamp || 0) > CACHE_TTL) {
      report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    }

    res.json({
      total: report.rows.length,
      tradable: report.tradable.length,
      filtered: report.filtered.length,
      message: `V16.2扫描完成: ${report.tradable.length}个tradable, ${report.filtered.length}个filtered`,
    });
  } catch (err) {
    console.error('Save error:', err);
    res.status(500).json({ error: '保存失败', message: (err as Error).message });
  }
});

// ===== 回测接口（必须在动态路由之前定义）=====

// GET /api/v1/scan/backtest - 全品种回测
router.get('/scan/backtest', async (_req, res) => {
  try {
    const results = await runAllBacktests();
    const report = generateBacktestReport(results);
    
    // 保存结果到品种适应性表
    for (const r of results) {
      updateVarietyPerformance(
        r.varietyCode,
        r.varietyName,
        r.totalTrades,
        r.winningTrades,
        r.losingTrades,
        r.avgPnl,
        r.profitFactor,
        r.maxConsecutiveWins,
        r.maxConsecutiveLosses
      );
    }
    
    // 汇总统计
    const totalTrades = results.reduce((sum, r) => sum + r.totalTrades, 0);
    const totalWins = results.reduce((sum, r) => sum + r.winningTrades, 0);
    const overallWinRate = totalTrades > 0 ? (totalWins / totalTrades * 100) : 0;

    res.json({
      summary: {
        totalVarieties: results.length,
        totalTrades,
        totalWins,
        overallWinRate: Math.round(overallWinRate * 100) / 100,
        avgProfitFactor: results.reduce((sum, r) => sum + r.profitFactor, 0) / results.length,
      },
      results: results.map(r => ({
        varietyCode: r.varietyCode,
        varietyName: r.varietyName,
        totalTrades: r.totalTrades,
        winRate: r.winRate,
        avgPnl: r.avgPnl,
        profitFactor: r.profitFactor,
        maxConsecutiveWins: r.maxConsecutiveWins,
        maxConsecutiveLosses: r.maxConsecutiveLosses,
        bySignalStrength: r.bySignalStrength,
      })),
      report,
    });
  } catch (err) {
    console.error('Backtest all error:', err);
    res.status(500).json({ error: '回测失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/backtest/:code - 单品种回测
router.get('/scan/backtest/:code', async (req, res) => {
  try {
    let code = req.params.code;
    // 规范化 code：如果不存在但 code + '0' 存在，则补 '0'
    if (!VARIETIES[code] && VARIETIES[code + '0']) {
      code = code + '0';
    }
    const lookbackBars = req.query.lookback ? parseInt(req.query.lookback as string) : 60;
    const forwardBars = req.query.forward ? parseInt(req.query.forward as string) : 10;
    const signalThreshold = req.query.threshold ? parseInt(req.query.threshold as string) : 30;

    const stats = await runBacktest({
      varietyCode: code,
      lookbackBars,
      forwardBars,
      signalThreshold,
    });

    res.json(stats);
  } catch (err) {
    console.error('Backtest error:', err);
    res.status(500).json({ error: '回测失败', message: (err as Error).message });
  }
});

// ===== 品种适应性接口 =====

// GET /api/v1/scan/varieties/performance - 获取所有品种适应性评分
router.get('/scan/varieties/performance', (_req, res) => {
  try {
    const performance = getAllVarietyPerformance();
    res.json({
      total: performance.length,
      suitable: performance.filter(p => p.isSuitable === true).length,
      varieties: performance,
    });
  } catch (err) {
    console.error('Performance error:', err);
    res.status(500).json({ error: '获取失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/varieties/suitable - 获取适合交易的品种
router.get('/scan/varieties/suitable', (_req, res) => {
  try {
    const suitable = getSuitableVarieties();
    res.json({
      total: suitable.length,
      varieties: suitable,
    });
  } catch (err) {
    console.error('Suitable error:', err);
    res.status(500).json({ error: '获取失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/grades - 获取品种稳健性分级（1000次回测三维度 + 实盘校准）
router.get('/scan/grades', (_req, res) => {
  try {
    const grades = getAllVarietyGrades();
    const calibrated = getAllCalibratedGrades();
    const summary: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    grades.forEach((g) => { summary[g.grade] = (summary[g.grade] || 0) + 1; });
    const calibratedSummary: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    calibrated.forEach((g) => { calibratedSummary[g.calibratedGrade] = (calibratedSummary[g.calibratedGrade] || 0) + 1; });
    res.json({ 
      success: true, 
      labels: VARIETY_GRADE_LABELS, 
      summary, 
      calibratedSummary,
      grades,
      calibrated,
    });
  } catch (err) {
    console.error('Grades error:', err);
    res.status(500).json({ error: '获取分级失败', message: (err as Error).message });
  }
});

// ===== 风险管理接口 =====

// GET /api/v1/scan/risk/status - 获取风控状态
router.get('/scan/risk/status', async (_req, res) => {
  try {
    // 从模拟账户获取当前本金
    const account = getSimulatedAccount();
    const capital = account.current_capital || 1000000; // 默认100万
    const summary = stopLossManager.getSummary(capital, 0);
    // 添加账户信息到响应中
    res.json({
      ...summary,
      capital,
      initialCapital: account.initial_capital,
      currentCapital: account.current_capital,
    });
  } catch (err) {
    console.error('Risk status error:', err);
    res.status(500).json({ error: '获取风控状态失败', message: (err as Error).message });
  }
});

// POST /api/v1/scan/risk/record-trade - 记录交易
router.post('/scan/risk/record-trade', (req, res) => {
  try {
    const { code, direction, entryPrice, exitPrice, size, pnl } = req.body;
    stopLossManager.recordTrade({
      id: `trade_${Date.now()}`,
      code,
      direction,
      entryPrice,
      exitPrice,
      size,
      pnl,
      isLoss: pnl < 0,
      timestamp: Date.now(),
    });
    res.json({ success: true, message: '交易已记录' });
  } catch (err) {
    console.error('Record trade error:', err);
    res.status(500).json({ error: '记录失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/risk/position-calc - 仓位计算
router.get('/scan/risk/position-calc', async (req, res) => {
  try {
    const code = req.query.code as string;
    const capital = req.query.capital ? parseFloat(req.query.capital as string) : 1000000;
    const method = (req.query.method as string) || 'fixed';

    if (!VARIETIES[code]) {
      return res.status(404).json({ error: '品种不存在' });
    }

    const data = await getVarietyData(code, 120);
    if (!data) {
      return res.status(500).json({ error: '数据获取失败' });
    }

    const sizer = new PositionSizer(capital, method as any);
    const lastBar = data.bars[data.bars.length - 1];
    const atrArr = calcATR(data.bars, 14);
    const atr = atrArr[atrArr.length - 1] || (lastBar.h - lastBar.l) || 1;
    const v16Row = scanV16Variety(code, data.bars, data.contract);

    const position = sizer.calcSize({
      code,
      direction: (v16Row.ai_direction === '多' ? 'LONG' : 'SHORT') as 'LONG' | 'SHORT',
      signalStrength: Math.round(v16Row.p_follow * 100),
      breakoutScore: 60,
      atr,
      price: lastBar?.c || 0,
      spectrumState: (v16Row.spectrum as '趋势' | '通道' | '区间'),
    });

    res.json({
      variety: code,
      name: VARIETIES[code] || code,
      currentPrice: lastBar?.c || 0,
      direction: v16Row.ai_direction,
      signalStrength: Math.round(v16Row.p_follow * 100),
      spectrum: v16Row.spectrum,
      position,
      riskAssessment: {
        riskAmount: position.riskAmount,
        riskPct: `${(position.riskPct * 100).toFixed(2)}%`,
        stopDistance: position.stopDistance.toFixed(2),
        targetDistance: position.targetDistance.toFixed(2),
      },
    });
  } catch (err) {
    console.error('Position calc error:', err);
    res.status(500).json({ error: '仓位计算失败', message: (err as Error).message });
  }
});

// ===== 研究验证接口 =====

// GET /api/v1/scan/research/single-factor - 单维度验证
router.get('/scan/research/single-factor', async (req, res) => {
  try {
    const code = req.query.code as string;
    const forwardDays = req.query.forwardDays ? parseInt(req.query.forwardDays as string) : 5;

    if (!code || !VARIETIES[code]) {
      return res.status(400).json({ error: '请提供有效的品种代码' });
    }

    const result = await runAllSingleFactorTestsAsync(code, forwardDays);
    res.json(result);
  } catch (err) {
    console.error('Single factor error:', err);
    res.status(500).json({ error: '单维度验证失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/research/walk-forward - Walk-Forward滚动回测
router.get('/scan/research/walk-forward', async (req, res) => {
  try {
    const code = req.query.code as string;
    const trainWindow = req.query.trainWindow ? parseInt(req.query.trainWindow as string) : 126;
    const testWindow = req.query.testWindow ? parseInt(req.query.testWindow as string) : 42;

    if (!code || !VARIETIES[code]) {
      return res.status(400).json({ error: '请提供有效的品种代码' });
    }

    const result = await walkForwardBacktest(code, trainWindow, testWindow);
    res.json(result);
  } catch (err) {
    console.error('Walk-forward error:', err);
    res.status(500).json({ error: 'Walk-Forward回测失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/research/signal-decay - 信号衰减测试
router.get('/scan/research/signal-decay', async (req, res) => {
  try {
    const code = req.query.code as string;
    const maxDays = req.query.maxDays ? parseInt(req.query.maxDays as string) : 15;

    if (!code || !VARIETIES[code]) {
      return res.status(400).json({ error: '请提供有效的品种代码' });
    }

    const result = await signalDecayTest(code, maxDays);
    res.json(result);
  } catch (err) {
    console.error('Signal decay error:', err);
    res.status(500).json({ error: '信号衰减测试失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/research/full - 完整研究报告
router.get('/scan/research/full', async (req, res) => {
  try {
    const codesParam = req.query.codes as string;
    const codes = codesParam ? codesParam.split(',') : ['AU0', 'AG0', 'CU0', 'I0', 'RB0'];

    const result = await runFullResearch(codes);
    res.json(result);
  } catch (err) {
    console.error('Full research error:', err);
    res.status(500).json({ error: '研究失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/backtest/multi-timeframe/:code - 多周期回测对比
router.get('/scan/backtest/multi-timeframe/:code', async (req, res) => {
  try {
    let code = req.params.code;
    // 规范化 code：如果不存在但 code + '0' 存在，则补 '0'
    if (!VARIETIES[code] && VARIETIES[code + '0']) {
      code = code + '0';
    }
    const maxTrades = parseInt(req.query.maxTrades as string) || 100;
    
    if (!VARIETIES[code]) {
      return res.status(404).json({ error: '品种不存在' });
    }

    const name = VARIETIES[code] || code;
    const result = await backtestMultiTimeframe(code, name, maxTrades);
    res.json(result);
  } catch (err) {
    console.error('Multi-timeframe backtest error:', err);
    res.status(500).json({ error: '多周期回测失败', message: (err as Error).message });
  }
});

// GET /api/v1/scan/refresh - 强制刷新数据缓存并重新扫描
router.get('/scan/refresh', async (_req, res) => {
  try {
    scanCache = null; // 清除扫描缓存
    const report = await runV16FullScan(true); // forceRefresh = true
    scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    res.json({
      success: true,
      total: report.totalCount,
      tradable: report.tradableCount,
      filtered: report.filteredCount,
      scan_time_ms: report.timing.total,
    });
  } catch (err) {
    console.error('刷新扫描失败:', err);
    res.status(500).json({ error: '刷新失败', message: (err as Error).message });
  }
});

// ====== 30min 扫描（必须放在动态路由 /:code 之前） ======
router.get('/scan/30m', async (_req, res) => {
  try {
    const report = await runV16FullScan30m();
    const result = [
      ...report.tradable.map(serializeV16Row),
      ...report.filtered.map((f: any) => ({ code: f.code, name: f.name, filtered: true, reason: f.reason })),
    ];
    res.json({
      total: report.totalCount,
      tradable: report.tradableCount,
      filtered: report.filteredCount,
      scanTime: report.scanTime,
      timing: report.timing,
      rows: result,
    });
  } catch (e: any) {
    console.error('[30m Scan] 错误:', e);
    res.status(500).json({ error: '扫描失败: ' + (e.message || e) });
  }
});

// ===== P0: 止盈止损建议 =====
router.get('/scan/advice/:code', async (req, res) => {
  try {
    const { code } = req.params;
    let report = scanCache?.report;
    if (!report || Date.now() - (scanCache?.timestamp || 0) > CACHE_TTL) {
      report = await runV16FullScan();
      scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    }

    const row = report.rows.find(r => r.code === code);
    if (!row) {
      return res.status(404).json({ error: `品种 ${code} 未在扫描结果中找到` });
    }

    // 获取 K 线数据
    let bars: any[] = [];
    try {
      const data = await getVarietyData(code);
      bars = data?.bars || [];
    } catch {
      // 兜底：从缓存文件读取
      const fs = await import('fs');
      const path = await import('path');
      const dirs = [
        path.default.join(process.cwd(), 'data-cache-daily-20y'),
        path.default.join(process.cwd(), 'data-cache'),
      ];
      for (const dir of dirs) {
        try {
          const fp = path.default.join(dir, `${code}.json`);
          const raw = fs.default.readFileSync(fp, 'utf-8');
          const data = JSON.parse(raw);
          bars = Array.isArray(data) ? data : (data?.bars || []);
          break;
        } catch { continue; }
      }
    }

    const advice = generateStopLossAdvice(row, bars);
    if (!advice) {
      return res.json({ code, message: '该品种当前方向为中性，无止盈止损建议' });
    }

    // 附加交易成本估算
    const slippageConfig = getSlippageConfig(code);
    const cost = calcTradeCost(
      code,
      advice.entry.aggressive,
      advice.stop.price,
      advice.atr,
      false,
      slippageConfig,
    );

    // 附加信号衰减
    const decay = applySignalDecay(row);

    res.json({
      ...advice,
      trading_cost: cost,
      signal_decay: decay,
      liquidity: estimateLiquidityLevel(code),
      grade: getCalibratedGrade(code),
    });
  } catch (err) {
    console.error('Advice error:', err);
    res.status(500).json({ error: '获取止盈止损建议失败', message: (err as Error).message });
  }
});

// ===== P0: 交易成本查询 =====
router.get('/scan/cost/:code', (req, res) => {
  try {
    const { code } = req.params;
    const price = req.query.price ? parseFloat(req.query.price as string) : 0;
    const atr = req.query.atr ? parseFloat(req.query.atr as string) : price * 0.02;

    if (price <= 0) {
      return res.status(400).json({ error: '请提供 price 参数' });
    }

    const cost = calcTradeCost(code, price, price * 1.02, atr, false, getSlippageConfig(code));
    res.json({
      code,
      price,
      liquidity: estimateLiquidityLevel(code),
      ...cost,
    });
  } catch (err) {
    console.error('Cost error:', err);
    res.status(500).json({ error: '计算交易成本失败', message: (err as Error).message });
  }
});

// ===== P1: 账户风控检查 =====
router.post('/scan/risk-check', (req, res) => {
  try {
    const { positions, equity, closed_trades } = req.body as {
      positions: PositionInfo[];
      equity: number;
      closed_trades?: any[];
    };

    if (!positions || !equity) {
      return res.status(400).json({ error: '请提供 positions 和 equity 参数' });
    }

    const result = checkAccountRisk(positions, closed_trades || [], equity);
    res.json(result);
  } catch (err) {
    console.error('Risk check error:', err);
    res.status(500).json({ error: '风控检查失败', message: (err as Error).message });
  }
});

// ===== P1: 仓位建议 =====
router.post('/scan/position-size', (req, res) => {
  try {
    const { equity, current_margin, new_trade_margin, code } = req.body as {
      equity: number;
      current_margin: number;
      new_trade_margin: number;
      code: string;
    };

    if (!equity || !code) {
      return res.status(400).json({ error: '请提供 equity 和 code 参数' });
    }

    const result = suggestPositionSize(equity, current_margin || 0, new_trade_margin || 0, code);
    res.json(result);
  } catch (err) {
    console.error('Position size error:', err);
    res.status(500).json({ error: '计算仓位失败', message: (err as Error).message });
  }
});

// ===== P2: 品种相关性矩阵 =====
router.get('/scan/correlation', (req, res) => {
  try {
    const codes = req.query.codes ? (req.query.codes as string).split(',') : undefined;
    const lookback = req.query.lookback ? parseInt(req.query.lookback as string) : 120;

    const matrix = computeCorrelationMatrix(codes, lookback);
    const pairs = getHighCorrelationPairs(codes || Object.keys(matrix).slice(0, 30));

    res.json({
      matrix,
      high_correlation_pairs: pairs.slice(0, 20),
      correlated_groups: CORRELATED_GROUPS,
    });
  } catch (err) {
    console.error('Correlation error:', err);
    res.status(500).json({ error: '计算相关性失败', message: (err as Error).message });
  }
});

// ===== P2: 持仓集中度检查 =====
router.post('/scan/concentration-check', (req, res) => {
  try {
    const { codes, threshold } = req.body as { codes: string[]; threshold?: number };
    if (!codes || codes.length < 2) {
      return res.json({ risky: false, groups: [], suggestions: ['持仓品种不足2个，无集中度风险'] });
    }

    const result = checkConcentrationRisk(codes, threshold || 0.7);
    res.json(result);
  } catch (err) {
    console.error('Concentration check error:', err);
    res.status(500).json({ error: '集中度检查失败', message: (err as Error).message });
  }
});

// ===== P2: 信号衰减查询 =====
router.get('/scan/decay/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const days = req.query.days ? parseFloat(req.query.days as string) : 0;
    const baseScore = req.query.score ? parseFloat(req.query.score as string) : 50;
    const context = req.query.context as string || '弱趋势';

    const result = calcSignalDecay(baseScore, days, context);
    res.json({ code, ...result });
  } catch (err) {
    console.error('Decay error:', err);
    res.status(500).json({ error: '计算信号衰减失败', message: (err as Error).message });
  }
});

// ===== P3: 绩效报告 =====
router.get('/scan/performance-report', (req, res) => {
  try {
    const type = (req.query.type as string) === 'monthly' ? 'monthly' : 'weekly';
    const report = generatePerformanceReport(type);
    res.json(report);
  } catch (err) {
    console.error('Performance report error:', err);
    res.status(500).json({ error: '生成绩效报告失败', message: (err as Error).message });
  }
});

// 动态路由在后
// GET /api/v1/scan/:code - 获取单品种V16.2详情
router.get('/scan/:code', async (req, res) => {
  try {
    let code = req.params.code;
    if (!VARIETIES[code] && VARIETIES[code + '0']) {
      code = code + '0';
    }
    if (!VARIETIES[code]) {
      return res.status(404).json({ error: '品种不存在' });
    }

    // 附加账户纪律阶梯（账户级，基于平仓记录连续亏损计算）
    const accountDiscipline = getAccountDiscipline();

    // 使用缓存中的单品种数据（rows 包含全部品种，无论 tradable 或 filtered）
    if (scanCache) {
      const row = scanCache.report.rows.find((r: V16Row) => r.code === code);
      if (row) {
        const priceAction = getPriceActionData(code, row);
        return res.json({ ...serializeV16Row(row), account_discipline: accountDiscipline, scan_time: scanCache.report.scanTime, price_action: priceAction });
      }
    }

    // 无缓存时运行全扫描
    const report = await runV16FullScan();
    scanCache = { report: decorateReportWithAdvice(report), timestamp: Date.now() };
    const fullRow = report.rows.find((r: V16Row) => r.code === code);
    if (fullRow) {
      const priceAction = getPriceActionData(code, fullRow);
      return res.json({ ...serializeV16Row(fullRow), account_discipline: accountDiscipline, scan_time: report.scanTime, price_action: priceAction });
    }

    return res.status(404).json({ error: '品种不在扫描结果中' });
  } catch (err) {
    console.error('Scan detail error:', err);
    res.status(500).json({ error: '扫描失败', message: (err as Error).message });
  }
});


// V16.2 序列化辅助函数
function serializeV16Row(r: V16Row) {
  const grade = getVarietyGrade(r.code);
  const calibrated = getCalibratedGrade(r.code);
  return {
    code: r.code,
    name: r.name,
    contract: r.contract,
    close: r.close,
    change_pct: r.ret_pct,
    decision: r.trade_worthiness,
    p_shun: r.p_follow,
    gate4_count: r.g4_reason_count,
    gate4_reasons: r.g4_reasons_met,
    ai_direction: r.ai_direction,
    camp: r.ch_direction,
    ch_has_signal: r.ch_has_signal,
    ch_exemption: r.ch_has_signal,
    filter_reason: r.g4_verdict,
    direction_quality: r.trend_strength,
    mm_variant: r.mm_variant_count,
    mm_target1: r.mm_tier1,
    mm_stop: r.ch_stop,
    edge_grade: r.edge_grade,
    discipline_status: r.disc_ladder,
    entry_score: (r.p_follow * 100) | 0,
    one_liner: generateOneLiner(r),
    advice: generateAdvice(r),
    key_levels: r.key_levels || null,
    atr14: r.atr14,
    // 趋势质量与行为数据
    adx: r.adx,
    trend_strength: r.trend_strength,
    lc_stage: r.lc_stage,
    lc_desc: lcStageDesc(r.lc_stage),
    ft_status: r.fw_type_cn,
    fw_rank: r.fw_rank,
    fw_type_cn: r.fw_type_cn,
    disc_ladder: r.disc_ladder,
    ff_found: r.ff_found,
    ff_label: r.ff_label,
    oi_signal: r.oi_signal,
    oi_change_pct: r.oi_change_pct,
    wedge_filter_on: r.wedge_filter_on,
    wedge_found: r.wedge_found,
    wedge_filtered_dir: r.wedge_filtered_dir,
    p_follow: r.p_follow,
    g4_pass: r.g4_pass,
    g4_reason_count: r.g4_reason_count,
    g4_verdict: r.g4_verdict,
    ch_direction: r.ch_direction,
    ch_strength: r.ch_strength,
    ch_stop: r.ch_stop,
    ch_target: r.ch_target,
    mm_found: r.mm_found,
    mm_direction: r.mm_direction,
    mm_tier1: r.mm_tier1,
    mm_tier2: r.mm_tier2,
    mm_tier3: r.mm_tier3,
    win_rate_20: r.win_rate_20,
    avg_rr: r.avg_rr,
    trade_worthiness: r.trade_worthiness,
    spectrum: r.spectrum,
    // V17 增强层字段
    signal_grade: r.signal_grade || null,
    signal_variant: r.signal_variant || null,
    tight_channel: r.tight_channel || false,
    tight_channel_detail: r.tight_channel_detail || null,
    watch_list: r.watch_list || false,
    // P0-3: MTF 共振字段
    mtf_resonance: r.mtf_resonance || null,
    // P1: 方向阵营降级字段
    direction_camp_warning: r.direction_camp_warning || null,
    position_multiplier: r.position_multiplier || 1.0,
    // P0-1: 数据时效字段
    data_freshness: r.data_freshness || 'cached',
    // V18 升级字段
    spectrum_detail: r.spectrum_detail || null,
    oi_grade: r.oi_grade || null,
    trend_exhaustion: r.trend_exhaustion || null,
    edge_decay: r.edge_decay || null,
    edge_p_value: r.edge_p_value ?? null,
    edge_wilson_ci_low: r.edge_wilson_ci_low ?? null,
    edge_wilson_ci_high: r.edge_wilson_ci_high ?? null,
    hybrid_factor: r.hybrid_factor ?? null,
    // 以下三个字段在V16Row中无结构化数据，从已有字段推导供前端兼容展示
    lifecycle: r.lc_stage,
    follow_through_ok: r.fw_rank >= 3,
    oi_confirmed: !!r.oi_signal,
    // P0-优化: 品种稳健性分级（1000次回测三维度 + 实盘校准）
    grade: grade?.grade ?? null,
    grade_label: grade?.gradeLabel ?? null,
    robust_pct: grade?.robustPct ?? null,
    crash_pct: grade?.crashPct ?? null,
    profitable_pct: grade?.profitablePct ?? null,
    calibrated_grade: calibrated.calibratedGrade,
    calibrated_grade_label: calibrated.calibratedGradeLabel,
    calibration_note: calibrated.calibrationNote,
    // P2: 信号衰减
    signal_decay: applySignalDecay(r),
  };
}

/**
 * 生成品种一句话讲解（纯计算，不依赖LLM）
 * 格式："{品种名} [{信号等级}{方向}] {光谱简述} P(顺)={p} Gate4={n}/5"
 */
function generateOneLiner(r: V16Row): string {
  const parts: string[] = [];

  // 品种名
  parts.push(r.name || r.code);

  // 信号等级 + 方向
  const grade = r.signal_grade || '';
  const dir = r.ai_direction || '';
  const sigLabel = grade || dir ? `[${grade}${dir}]` : '';
  if (sigLabel) parts.push(sigLabel);

  // 光谱简述
  const spectrum = r.spectrum || '';
  if (spectrum) {
    const shortSpectrum = spectrum.length > 12 ? spectrum.slice(0, 12) + '…' : spectrum;
    parts.push(shortSpectrum);
  }

  // P(顺)
  if (r.p_follow != null) {
    parts.push(`P(顺)=${r.p_follow.toFixed(2)}`);
  }

  // Gate4
  parts.push(`Gate4=${r.g4_reason_count}/5`);

  // Edge评级
  if (r.edge_grade) {
    parts.push(`Edge=${r.edge_grade}`);
  }

  // 紧通道标记
  if (r.tight_channel) {
    parts.push('🔒紧通道');
  }

  // MM目标位
  if (r.mm_found && r.mm_tier1 != null) {
    parts.push(`目标${r.mm_tier1}`);
  }

  return parts.join(' ');
}

/**
 * 生成品种交易建议（纯计算，不依赖LLM）
 * 基于 V16Row 各字段综合生成操作建议文本
 */
function generateAdvice(r: V16Row): string {
  const worthiness = r.trade_worthiness || '';

  // 可交易品种
  if (worthiness === 'tradable') {
    const lines: string[] = [];

    // 方向判断
    const dir = r.ai_direction;
    const dirText = dir === '多' ? '做多' : dir === '空' ? '做空' : '观望';

    // 入场说明
    lines.push(`方向：${dirText}`);

    // 信号质量
    const grade = r.signal_grade || '';
    if (grade) lines.push(`信号等级：${grade}`);

    // Gate4 通过理由
    if (r.g4_reasons_met && r.g4_reasons_met.length > 0) {
      lines.push(`Gate4通过：${r.g4_reasons_met.join('、')}`);
    }

    // 止损位
    if (r.ch_stop != null) {
      lines.push(`止损参考：${Number(r.ch_stop).toFixed(2)}`);
    }

    // 目标位
    if (r.mm_tier1 != null) {
      lines.push(`第一目标：${Number(r.mm_tier1).toFixed(2)}`);
    }
    if (r.mm_tier2 != null) {
      lines.push(`第二目标：${Number(r.mm_tier2).toFixed(2)}`);
    }

    // Edge统计
    if (r.edge_grade) {
      lines.push(`Edge评级：${r.edge_grade}`);
    }

    // 近20笔统计
    if (r.win_rate_20 != null && r.avg_rr != null) {
      lines.push(`近20笔胜率${(r.win_rate_20 * 100).toFixed(0)}% | 均RR ${r.avg_rr.toFixed(2)}`);
    }

    // 紧通道提示
    if (r.tight_channel) {
      lines.push('提示：处于紧通道（低波动蓄势），突破后力度通常较强');
    }

    // MTF共振
    if (r.mtf_resonance?.resonance === 'full') {
      lines.push('MTF：日线/60min/15min 三周期共振，信号可靠性高');
    } else if (r.mtf_resonance?.resonance === 'partial') {
      lines.push('MTF：部分共振，注意大周期方向约束');
    } else if (r.mtf_resonance?.resonance === 'conflict') {
      lines.push('MTF：多周期冲突，建议降低仓位');
    }

    return lines.join('。');
  }

  // 被过滤品种
  if (worthiness === 'filtered') {
    const reasons: string[] = [];

    if (!r.g4_pass) {
      reasons.push(`Gate4未通过（${r.g4_reason_count}/5）`);
    }
    if (r.ch_direction === '无' && !r.ch_has_signal) {
      reasons.push('CH通道无信号');
    }
    if (r.wedge_filter_on) {
      reasons.push(`楔形反转过滤了${r.wedge_filtered_dir || '未知'}方向`);
    }
    if (r.edge_grade === 'D' || r.disc_ladder <= 1) {
      reasons.push(`Edge评级低（${r.edge_grade || 'D'}）`);
    }

    const reasonText = reasons.length > 0 ? reasons.join('，') : '信号不满足入场条件';
    return `【过滤】${reasonText}。当前不适合交易，等待信号改善。`;
  }

  // 观望品种
  const watchReasons: string[] = [];
  if (r.lc_stage === '区间') watchReasons.push('处于区间市');
  if (r.trend_strength < 30) watchReasons.push('趋势不明朗');
  if (r.p_follow < 0.45) watchReasons.push(`P(顺)过低(${r.p_follow?.toFixed(2) || 'N/A'})`);

  if (watchReasons.length > 0) {
    return `【观望】${watchReasons.join('，')}。建议等待更明确的信号出现。`;
  }

  return '当前信号不足以支持交易决策，建议继续观察。';
}

/** 生命周期阶段中文描述（Brooks体系） */
function lcStageDesc(stage: string): string {
  switch (stage) {
    case '初期':
      return '趋势启动初期，信号新鲜，可积极跟随，止损相对明确';
    case '成长期':
      return '趋势运行中段，以回调入场为主，避免追单';
    case '成熟期':
      return '趋势运行较久，谨防末端反转与 Final Flag，仓位宜轻、收紧止损';
    default:
      return '数据不足，暂无法判断生命周期阶段';
  }
}

// 获取品种的可用合约列表（含成交量）
router.get('/contracts/:code', async (req, res) => {
  try {
    const code = req.params.code as string;
    const contracts = await getAvailableContracts(code);
    res.json({ success: true, code, contracts });
  } catch (e: any) {
    res.status(500).json({ error: e.message || '获取合约失败' });
  }
});

/**
 * GET /api/v1/scan/signal-stats/:code
 * 获取指定品种的历史信号胜率统计
 * 基于 sim_trades 和 signal_history 数据
 */
router.get('/signal-stats/:code', (req, res) => {
  try {
    const code = req.params.code as string;
    const db = getDb();
    
    // 查询该品种的历史模拟交易
    const trades = db.query(
      `SELECT * FROM sim_trades WHERE code = ? AND status = 'closed' ORDER BY exit_date DESC LIMIT 100`,
      [code]
    ) as any[];

    // 查询该品种的历史信号记录（按等级分组）
    const signalRecords = db.query(
      `SELECT signal_level, ai_direction, scan_time FROM signal_history WHERE code = ? ORDER BY scan_time DESC LIMIT 500`,
      [code]
    ) as any[];

    // 计算模拟交易统计
    const totalTrades = trades.length;
    const winningTrades = trades.filter(t => (t.pnl || 0) > 0).length;
    const losingTrades = trades.filter(t => (t.pnl || 0) < 0).length;
    const winRate = totalTrades > 0 ? (winningTrades / totalTrades * 100) : 0;
    const avgWin = winningTrades > 0 
      ? trades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl_pct || 0), 0) / winningTrades 
      : 0;
    const avgLoss = losingTrades > 0
      ? trades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl_pct || 0), 0) / losingTrades
      : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;

    // 按方向统计
    const longTrades = trades.filter(t => t.direction === '多');
    const shortTrades = trades.filter(t => t.direction === '空');
    const longWinRate = longTrades.length > 0 
      ? (longTrades.filter(t => (t.pnl || 0) > 0).length / longTrades.length * 100) 
      : 0;
    const shortWinRate = shortTrades.length > 0
      ? (shortTrades.filter(t => (t.pnl || 0) > 0).length / shortTrades.length * 100)
      : 0;

    // 按信号等级统计（从 signal_history）
    const gradeCounts: Record<string, { count: number; directions: Record<string, number> }> = {};
    for (const rec of signalRecords) {
      const grade = rec.signal_level || 'unknown';
      if (!gradeCounts[grade]) {
        gradeCounts[grade] = { count: 0, directions: {} };
      }
      gradeCounts[grade].count++;
      const dir = rec.ai_direction || '中性';
      gradeCounts[grade].directions[dir] = (gradeCounts[grade].directions[dir] || 0) + 1;
    }

    // 最近信号变化（从 signal_history）
    const recentSignals = signalRecords.slice(0, 10).map(r => ({
      time: r.scan_time,
      direction: r.ai_direction,
      level: r.signal_level,
    }));

    res.json({
      success: true,
      code,
      tradeStats: {
        totalTrades,
        winningTrades,
        losingTrades,
        winRate: Number(winRate.toFixed(1)),
        avgWinPct: Number(avgWin.toFixed(2)),
        avgLossPct: Number(avgLoss.toFixed(2)),
        profitFactor: Number(profitFactor.toFixed(2)),
        longTrades: longTrades.length,
        longWinRate: Number(longWinRate.toFixed(1)),
        shortTrades: shortTrades.length,
        shortWinRate: Number(shortWinRate.toFixed(1)),
      },
      signalGradeStats: Object.entries(gradeCounts).map(([grade, data]) => ({
        grade,
        count: data.count,
        directions: data.directions,
      })),
      recentSignals,
    });
  } catch (err: any) {
    console.error('Signal stats error:', err);
    res.status(500).json({ error: err.message || '获取信号统计失败' });
  }
});

// 搜索市场热点新闻（注意：静态路由必须定义在动态路由 /news/:code 之前，否则会被 /news/:code 抢先匹配）
router.get('/news/market', async (req, res) => {
  try {
    const result = await searchMarketNews();

    res.json({
      type: 'market',
      ...result,
    });
  } catch (err: any) {
    console.error('Macro news search error:', err);
    res.status(500).json({ error: err.message || '搜索市场新闻失败' });
  }
});

// 搜索品种相关新闻
router.get('/news/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const count = parseInt(req.query.count as string) || 5;

    // 获取品种名称
    const name = VARIETIES[code] || code;

    const result = await searchVarietyNews(code);

    res.json({
      code,
      name,
      ...result,
    });
  } catch (err: any) {
    console.error('News search error:', err);
    res.status(500).json({ error: err.message || '搜索新闻失败' });
  }
});

export default router;
