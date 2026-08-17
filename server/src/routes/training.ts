import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getVarietyData } from '../services/dataFetcher.js';
import { VARIETIES, VARIETY_GROUPS, GROUP_NAMES } from '../services/varieties.js';

const router = Router();

// variety-stats 缓存（读取 59 个回测 JSON 较重，60 秒 TTL）
let varietyStatsCache: { data: unknown[]; ts: number } | null = null;
const VARIETY_STATS_TTL = 60_000;

/**
 * 获取训练用 K 线数据（真实历史数据）
 * GET /api/v1/training/kline/:code?bars=120
 * 返回: { code, name, group, bars: [{date, o, h, l, c, vol, hold}] }
 */
router.get('/kline/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const barCount = Math.min(parseInt(req.query.bars as string) || 120, 250);

    console.log(`[Training] 请求K线数据: ${code}, bars=${barCount}`);

    if (!VARIETIES[code]) {
      console.log(`[Training] 品种不存在: ${code}`);
      return res.status(404).json({ error: `品种 ${code} 不存在` });
    }

    const data = await getVarietyData(code, barCount);
    console.log(`[Training] getVarietyData 返回:`, data ? `${data.bars.length} bars` : 'null');

    if (!data || !data.bars || data.bars.length < 20) {
      console.log(`[Training] 数据不足: ${code}`);
      return res.status(502).json({ error: '获取K线数据失败，数据源可能不可用' });
    }

    // 确保每条数据都有 vol 和 hold
    const bars = data.bars.map(b => ({
      date: b.date,
      o: b.o,
      h: b.h,
      l: b.l,
      c: b.c,
      vol: b.vol || 0,
      hold: b.hold || 0,
    }));

    res.json({
      code,
      name: VARIETIES[code],
      group: GROUP_NAMES[code] || '其他',
      contract: data.contract,
      barCount: bars.length,
      bars,
    });
  } catch (e: any) {
    console.error('[Training] kline error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * 获取所有品种列表（用于关卡选择）
 * GET /api/v1/training/varieties
 */
router.get('/varieties', (_req, res) => {
  const groups: Record<string, { code: string; name: string }[]> = {};

  for (const [code, name] of Object.entries(VARIETIES)) {
    const group = GROUP_NAMES[code] || '其他';
    if (!groups[group]) groups[group] = [];
    groups[group].push({ code, name });
  }

  res.json({ groups });
});

/**
 * 获取品种分组信息
 * GET /api/v1/training/groups
 */
router.get('/groups', (_req, res) => {
  const groupList = Object.entries(VARIETY_GROUPS).map(([name, info]) => ({
    name,
    members: info.members,
    leader: info.leader,
    count: info.members.length,
  }));
  res.json({ groups: groupList });
});

/**
 * 获取 59 品种回测统计摘要（品种性格模块的数据源）
 * 基于 59 × 1000 次 LHS 回测结果计算每个品种的真实交易特征
 * GET /api/v1/training/variety-stats
 * 返回: { stats: [{ code, name, medianReturnPct, positiveRate, bestReturnPct,
 *                  avgWinRate, avgProfitFactor, avgMaxDrawdown, volatility }] }
 */
router.get('/variety-stats', (_req, res) => {
  try {
    // 命中缓存直接返回
    if (varietyStatsCache && Date.now() - varietyStatsCache.ts < VARIETY_STATS_TTL) {
      res.json({ success: true, stats: varietyStatsCache.data });
      return;
    }
    const dataDir = path.join(process.cwd(), 'src', 'data');
    const stats: {
      code: string;
      name: string;
      medianReturnPct: number;
      positiveRate: number;
      bestReturnPct: number;
      avgWinRate: number;
      avgProfitFactor: number;
      avgMaxDrawdown: number;
      volatility: number;
    }[] = [];

    const avg = (arr: number[]) =>
      arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

    for (const [code, name] of Object.entries(VARIETIES)) {
      const file = path.join(dataDir, `${code}_1000Experiments.json`);
      if (!fs.existsSync(file)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(file, 'utf-8'));
        const fr = d.fullResults;
        if (!Array.isArray(fr) || fr.length === 0) continue;

        const rets: number[] = [];
        const winRates: number[] = [];
        const pfs: number[] = [];
        const dds: number[] = [];
        for (const r of fr) {
          const st = r.stats;
          if (!st || typeof st.totalPnl !== 'number') continue;
          const capital = r.recipe?.startCapital ?? 500000;
          rets.push((st.totalPnl / capital) * 100);
          if (typeof st.winRate === 'number') winRates.push(st.winRate);
          if (typeof st.profitFactor === 'number') pfs.push(st.profitFactor);
          if (typeof st.maxDrawdown === 'number') dds.push(st.maxDrawdown);
        }
        if (rets.length === 0) continue;

        const sorted = [...rets].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const positiveRate = rets.filter((r) => r > 0).length / rets.length;
        const mean = avg(rets);
        const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / rets.length;
        const volatility = Math.sqrt(variance);

        const best = d.topComposite?.[0];
        const bestCapital = best?.recipe?.startCapital ?? 500000;
        const bestReturnPct = best?.stats?.totalPnl
          ? (best.stats.totalPnl / bestCapital) * 100
          : 0;

        stats.push({
          code,
          name,
          medianReturnPct: Math.round(median * 10) / 10,
          positiveRate: Math.round(positiveRate * 1000) / 10,
          bestReturnPct: Math.round(bestReturnPct * 10) / 10,
          avgWinRate: Math.round(avg(winRates) * 1000) / 10,
          avgProfitFactor: Math.round(avg(pfs) * 100) / 100,
          avgMaxDrawdown: Math.round(avg(dds) * 1000) / 10,
          volatility: Math.round(volatility * 10) / 10,
        });
      } catch (e) {
        console.error(`[Training] 读取回测数据失败 ${code}:`, e);
      }
    }

    varietyStatsCache = { data: stats, ts: Date.now() };
    res.json({ success: true, stats });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 绩效归因报告缓存（5 分钟 TTL，数据较重）
let attributionCache: { data: Record<string, unknown>; ts: number } | null = null;
const ATTRIBUTION_TTL = 5 * 60_000;

/**
 * 获取绩效归因报告（参数重要性 + 品种稳健性）
 * GET /api/v1/training/attribution
 * 返回: { parameterImportance, robustness }
 */
router.get('/attribution', (_req, res) => {
  try {
    // 检查缓存
    if (attributionCache && Date.now() - attributionCache.ts < ATTRIBUTION_TTL) {
      return res.json({ success: true, ...attributionCache.data });
    }

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'performanceAttribution.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: '归因报告尚未生成，请先运行 performanceAttribution 脚本' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    attributionCache = { data: report, ts: Date.now() };

    res.json({
      success: true,
      generatedAt: report.generatedAt,
      varietyCount: report.varietyCount,
      totalExperiments: report.totalExperiments,
      parameterImportance: report.parameterImportance,
      robustness: report.robustness,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 获取单品种稳健性详情
 * GET /api/v1/training/attribution/:code
 * 返回: { code, robustness, failurePattern }
 */
router.get('/attribution/:code', (req, res) => {
  try {
    const { code } = req.params;
    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'performanceAttribution.json');

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: '归因报告尚未生成' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const variety = report.robustness?.rankings?.find((r: any) => r.code === code);

    if (!variety) {
      return res.status(404).json({ success: false, error: `品种 ${code} 未在归因报告中` });
    }

    res.json({ success: true, ...variety });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// P1 市场状态自适应 + 失败案例归因 缓存
let p1Cache: { data: Record<string, unknown>; ts: number } | null = null;
const P1_TTL = 5 * 60_000;

/**
 * 获取 P1 市场状态自适应分析
 * GET /api/v1/training/market-adaptive
 * 返回: { windowPerformance, directionAnalysis, paramRecommendations, varietyRegimeFit }
 */
router.get('/market-adaptive', (_req, res) => {
  try {
    if (p1Cache && Date.now() - p1Cache.ts < P1_TTL) {
      return res.json({
        success: true,
        generatedAt: p1Cache.data.generatedAt,
        marketStateAdaptive: p1Cache.data.marketStateAdaptive,
      });
    }

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p1AdaptiveAndFailure.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P1 分析报告尚未生成，请先运行 p1AdaptiveAndFailure 脚本' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    p1Cache = { data: report, ts: Date.now() };

    res.json({
      success: true,
      generatedAt: report.generatedAt,
      marketStateAdaptive: report.marketStateAdaptive,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 获取 P1 失败案例归因分析
 * GET /api/v1/training/failure-attribution
 * 返回: { overallLossRate, topLossFactors, deathCombinations, suggestions, sectorLossProfile }
 */
router.get('/failure-attribution', (_req, res) => {
  try {
    if (p1Cache && Date.now() - p1Cache.ts < P1_TTL) {
      return res.json({
        success: true,
        generatedAt: p1Cache.data.generatedAt,
        failureAttribution: p1Cache.data.failureAttribution,
      });
    }

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p1AdaptiveAndFailure.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P1 分析报告尚未生成' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    p1Cache = { data: report, ts: Date.now() };

    res.json({
      success: true,
      generatedAt: report.generatedAt,
      failureAttribution: report.failureAttribution,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 获取单品种市场状态匹配详情
 * GET /api/v1/training/market-adaptive/:code
 * 返回: { code, regimeType, bestWindow, worstWindow, bestDirection, ... }
 */
router.get('/market-adaptive/:code', (req, res) => {
  try {
    const { code } = req.params;
    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p1AdaptiveAndFailure.json');

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P1 分析报告尚未生成' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const variety = report.marketStateAdaptive?.varietyRegimeFit?.find((v: any) => v.code === code);

    if (!variety) {
      return res.status(404).json({ success: false, error: `品种 ${code} 未在市场状态分析中` });
    }

    res.json({ success: true, ...variety });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ P2 品种联动 + 参数自适应 ============

let p2Cache: { data: any; ts: number } | null = null;
const P2_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/**
 * 获取 P2 品种分组联动分析
 * GET /api/v1/training/linkage
 * 返回: { correlationMatrix, sectorDiversification, crossSectorLinkage, portfolioSuggestions }
 */
router.get('/linkage', (req, res) => {
  try {
    if (p2Cache && Date.now() - p2Cache.ts < P2_CACHE_TTL) {
      return res.json({
        success: true,
        generatedAt: p2Cache.data.generatedAt,
        linkage: p2Cache.data.linkage,
      });
    }

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p2LinkageAndAdaptive.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P2 分析报告尚未生成，请先运行 p2LinkageAndAdaptive 脚本' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    p2Cache = { data: report, ts: Date.now() };

    res.json({
      success: true,
      generatedAt: report.generatedAt,
      linkage: report.linkage,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 获取 P2 参数自适应优化
 * GET /api/v1/training/param-adaptive
 * 返回: { varietyRecommendations, sectorConsensus, paramRobustness, switchingRules }
 */
router.get('/param-adaptive', (req, res) => {
  try {
    if (p2Cache && Date.now() - p2Cache.ts < P2_CACHE_TTL) {
      return res.json({
        success: true,
        generatedAt: p2Cache.data.generatedAt,
        adaptive: p2Cache.data.adaptive,
      });
    }

    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p2LinkageAndAdaptive.json');
    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P2 分析报告尚未生成' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    p2Cache = { data: report, ts: Date.now() };

    res.json({
      success: true,
      generatedAt: report.generatedAt,
      adaptive: report.adaptive,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

/**
 * 获取单品种联动详情（与其他品种的关联性）
 * GET /api/v1/training/linkage/:code
 * 返回: { code, sector, correlatedVarieties, hedgeOpportunities, ... }
 */
router.get('/linkage/:code', (req, res) => {
  try {
    const { code } = req.params;
    const dataDir = path.join(process.cwd(), 'src', 'data');
    const reportPath = path.join(dataDir, 'p2LinkageAndAdaptive.json');

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ success: false, error: 'P2 分析报告尚未生成' });
    }

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
    const matrix = report.linkage?.correlationMatrix || [];

    // 找该品种的所有关联
    const related = matrix.filter((p: any) => p.code1 === code || p.code2 === code);

    // 按相关性排序
    const sorted = related
      .map((p: any) => ({
        otherCode: p.code1 === code ? p.code2 : p.code1,
        otherSector: p.code1 === code ? p.sector2 : p.sector1,
        pnlCorrelation: p.pnlCorrelation,
        drawdownCorrelation: p.drawdownCorrelation,
        relationship: p.relationship,
      }))
      .sort((a: any, b: any) => Math.abs(b.pnlCorrelation) - Math.abs(a.pnlCorrelation));

    // 找该品种所在的板块分散化信息
    const sectorDiv = report.linkage?.sectorDiversification?.find((sd: any) =>
      sd.varieties.includes(code)
    );

    // 找该品种的参数推荐
    const paramRec = report.adaptive?.varietyRecommendations?.find((r: any) => r.code === code);

    res.json({
      success: true,
      code,
      sector: sectorDiv?.sector || '其他',
      correlations: sorted,
      sectorDiversification: sectorDiv || null,
      paramRecommendation: paramRec || null,
    });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

export default router;
