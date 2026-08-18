import { Router } from 'express';
import { runBacktest } from '../services/backtestEngine';
import { getCircuitBreaker } from '../data/circuitBreakerParams.js';
import { getRealtimeOptParams } from '../data/realtimeOptParams.js';
import { getStrategyContext } from '../services/strategyContext.js';
import { VARIETIES, GROUP_NAMES } from '../services/varieties.js';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();

// 日线回测（66品种）
router.get('/', async (_req, res) => {
  try {
    const minGrade = _req.query['minGrade'] as string || 'L3';
    const startCapital = parseInt(_req.query['capital'] as string) || 500000;
    const maxHoldDays = parseInt(_req.query['holdDays'] as string) || 15;
    const maxPositionPct = parseFloat(_req.query['posPct'] as string) || 0.15;

    const result = await runBacktest({
      startCapital,
      maxPositionPct,
      minSignalGrade: minGrade,
      maxHoldDays,
    });

    res.json({ success: true, data: result });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// 60min回测（全部品种，分钟级出场精度）
const CACHE_60M = path.join(process.cwd(), 'data-cache-60m-long');
try {
  fs.mkdirSync(CACHE_60M, { recursive: true });
} catch (e: any) {
  console.warn(`[Backtest] 无法创建缓存目录 ${CACHE_60M}: ${e.message}，回测功能可能不可用`);
}
const ALL_60M_CODES = fs.existsSync(CACHE_60M) 
  ? fs.readdirSync(CACHE_60M)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''))
  : [];

router.get('/60m', async (_req, res) => {
  try {
    const minGrade = _req.query['minGrade'] as string || 'L3';
    const startCapital = parseInt(_req.query['capital'] as string) || 500000;
    // 5个交易日 × 每天约7根60min bar = 35 bar
    const maxHoldBars = parseInt(_req.query['holdBars'] as string) || 35;
    const maxPositionPct = parseFloat(_req.query['posPct'] as string) || 0.15;
    // 60根bar warmup ≈ 10个交易日
    const warmupBars = parseInt(_req.query['warmup'] as string) || 60;
    // 冷却期 14根bar ≈ 2个交易日
    const cooldownBars = parseInt(_req.query['cooldown'] as string) || 14;

    const result = await runBacktest({
      startCapital,
      maxPositionPct,
      minSignalGrade: minGrade,
      maxHoldDays: maxHoldBars,
      warmupBars,
      cooldownBars,
      dataDir: CACHE_60M,
      codes: ALL_60M_CODES,
      returnAllTrades: true,
    });

    res.json({ success: true, data: result });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// 60min逐品种报告 — 输出品种级盈亏表，用于白名单筛选
router.get('/60m/report', async (_req, res) => {
  try {
    const ALL_CODES = fs.readdirSync(CACHE_60M)
      .filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''));

    const result = await runBacktest({
      startCapital: 500000,
      maxPositionPct: 0.15,
      minSignalGrade: 'L2',
      maxHoldDays: 35,
      warmupBars: 60,
      cooldownBars: 14,
      dataDir: CACHE_60M,
      codes: ALL_CODES,
      returnAllTrades: true,
    });

    // 逐品种统计
    const byCode: Record<string, any> = {};
    for (const t of result.trades) {
      if (!byCode[t.code]) {
        byCode[t.code] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalRR: 0, spectrum: {} };
      }
      byCode[t.code].trades++;
      if (t.pnl > 0) byCode[t.code].wins++;
      else byCode[t.code].losses++;
      byCode[t.code].totalPnl += t.pnl;
      byCode[t.code].totalRR += t.rMultiple;
      const spec = t.spectrum || '未知';
      byCode[t.code].spectrum[spec] = (byCode[t.code].spectrum[spec] || 0) + 1;
    }

    const report = Object.entries(byCode).map(([code, stats]: [string, any]) => ({
      code,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.trades > 0 ? Math.round(stats.wins / stats.trades * 10000) / 100 : 0,
      avgRR: stats.trades > 0 ? Math.round(stats.totalRR / stats.trades * 100) / 100 : 0,
      totalPnl: Math.round(stats.totalPnl),
      profitFactor: stats.losses > 0 ? Math.round(stats.wins / Math.max(stats.losses, 1) * 100) / 100 : stats.trades,
      spectrum: stats.spectrum,
      grade: stats.trades >= 20 && stats.winRate >= 45 && (stats.wins / Math.max(stats.losses, 1)) >= 1.5
        ? 'A' : stats.trades >= 10 && stats.totalPnl > 0 ? 'B'
        : stats.trades < 5 ? 'D' : 'C',
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

    // 自动分类
    const whitelist = report.filter(r => r.grade === 'A' || r.grade === 'B').map(r => r.code);
    const blacklist = report.filter(r => r.totalPnl <= 0 && r.trades >= 10).map(r => r.code);
    const watchlist = report.filter(r => r.grade === 'D' || (r.trades < 10 && r.totalPnl > 0)).map(r => r.code);

    res.json({
      success: true,
      data: {
        summary: result.summary,
        report,
        trades: result.trades,
        suggestion: { whitelist, blacklist, watchlist },
        totalVarieties: report.length,
        profitable: report.filter(r => r.totalPnl > 0).length,
      },
    });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// 30min回测 — 与APP扫描决策链对齐，出场精度更高
const CACHE_30M = path.join(process.cwd(), 'data-cache-30m-long');

router.get('/30m', async (_req, res) => {
  try {
    if (!fs.existsSync(CACHE_30M)) {
      res.json({ success: false, error: '30min cache not built yet' });
      return;
    }
    const ALL_30M = fs.readdirSync(CACHE_30M).filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''));
    const startCapital = parseInt(_req.query['capital'] as string) || 500000;

    const result = await runBacktest({
      startCapital,
      maxPositionPct: 0.15,
      minSignalGrade: 'L2',
      maxHoldDays: 70,    // 5天 × 14根/天
      warmupBars: 120,    // ~10交易日
      cooldownBars: 28,   // 2交易日
      dataDir: CACHE_30M,
      codes: ALL_30M,
      returnAllTrades: true,
    });

    res.json({ success: true, data: result });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

router.get('/30m/report', async (_req, res) => {
  try {
    if (!fs.existsSync(CACHE_30M)) {
      res.json({ success: false, error: '30min cache not built yet' });
      return;
    }
    const ALL_30M = fs.readdirSync(CACHE_30M).filter((f: string) => f.endsWith('.json'))
      .map((f: string) => f.replace('.json', ''));

    const result = await runBacktest({
      startCapital: 500000,
      maxPositionPct: 0.15,
      minSignalGrade: 'L2',
      maxHoldDays: 70,
      warmupBars: 120,
      cooldownBars: 28,
      dataDir: CACHE_30M,
      codes: ALL_30M,
      returnAllTrades: true,
    });

    const byCode: Record<string, any> = {};
    for (const t of result.trades) {
      if (!byCode[t.code]) {
        byCode[t.code] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalRR: 0, spectrum: {} };
      }
      byCode[t.code].trades++;
      if (t.pnl > 0) byCode[t.code].wins++;
      else byCode[t.code].losses++;
      byCode[t.code].totalPnl += t.pnl;
      byCode[t.code].totalRR += t.rMultiple;
      const spec = t.spectrum || '未知';
      byCode[t.code].spectrum[spec] = (byCode[t.code].spectrum[spec] || 0) + 1;
    }

    const report = Object.entries(byCode).map(([code, stats]: [string, any]) => ({
      code,
      trades: stats.trades,
      wins: stats.wins,
      losses: stats.losses,
      winRate: stats.trades > 0 ? Math.round(stats.wins / stats.trades * 10000) / 100 : 0,
      avgRR: stats.trades > 0 ? Math.round(stats.totalRR / stats.trades * 100) / 100 : 0,
      totalPnl: Math.round(stats.totalPnl),
      profitFactor: stats.losses > 0 ? Math.round(stats.wins / Math.max(stats.losses, 1) * 100) / 100 : stats.trades,
      spectrum: stats.spectrum,
    }))
    .sort((a, b) => b.totalPnl - a.totalPnl);

    res.json({
      success: true,
      data: {
        summary: result.summary,
        report,
        totalVarieties: report.length,
        profitable: report.filter(r => r.totalPnl > 0).length,
      },
    });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// 白银(AG0)回测寻优报告 — 读取已完成的白银专项回测结论（参数落库依据：AG0_integrated.optimizedWithCB）
const AG0_DATA_DIR = path.join(process.cwd(), 'src', 'data');
// 内存缓存：避免每次请求都重复 readFileSync + JSON.parse 59 个 1MB 文件
const jsonCache = new Map<string, { mtimeMs: number; data: any }>();

function loadJson(name: string): any | null {
  const p = path.join(AG0_DATA_DIR, name);
  if (!fs.existsSync(p)) return null;
  try {
    const stat = fs.statSync(p);
    const cached = jsonCache.get(name);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.data;
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
    jsonCache.set(name, { mtimeMs: stat.mtimeMs, data });
    return data;
  } catch {
    return null;
  }
}

router.get('/ag0-report', (_req, res) => {
  try {
    const integrated = loadJson('AG0_integrated.json');
    const multiObjective = loadJson('AG0_multiObjective.json');
    const drawdownEngine = loadJson('AG0_drawdownEngine.json');
    const robustAudit = loadJson('silverRobustAudit.json');

    if (!integrated || !multiObjective) {
      res.json({ success: false, error: 'AG0 report data not found, run silver scripts first' });
      return;
    }

    // 当前生产参数（longOptParams/shortOptParams 落地后的 AG0）
    const currentParams = {
      long: { stopAtrMult: 1.93, targetAtrMult: 6.92, maxHoldDays: 53, cooldownBars: 6, trendFilter: false, minSignalGrade: 'L2' },
      short: { stopAtrMult: 2.94, targetAtrMult: 4.41, maxHoldDays: 44, cooldownBars: 5, trendFilter: true, minSignalGrade: 'L2' },
      circuitBreaker: (() => {
        const cb = getCircuitBreaker('AG0');
        return cb ? { lossStreak: cb.lossStreak, pauseDays: cb.pauseBars } : null;
      })(),
    };

    res.json({
      success: true,
      data: {
        code: 'AG0',
        name: '白银',
        generatedAt: multiObjective.generatedAt,
        sampleCount: multiObjective.sampleCount,
        theoreticalMax: integrated.theo,
        baseline: integrated.baseline,
        optimized: integrated.optimized,
        optimizedWithCB: integrated.optimizedWithCB,
        conclusion: integrated.conclusion,
        currentParams,
        multiObjective: {
          bestComposite: multiObjective.bestComposite,
          topAll: multiObjective.topAll,
          paretoCount: multiObjective.pareto?.length ?? 0,
        },
        drawdownScenarios: drawdownEngine?.scenarios ?? [],
        robustAudit: robustAudit ?? null,
      },
    });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// ============ 二十六方 1000 次实验对比报告 ============

const MULTI_CODES: Array<{ code: string; name: string }> = [
  { code: 'SI0', name: '沪锡' },
  { code: 'AG0', name: '沪银' },
  { code: 'CF0', name: '棉花' },
  { code: 'CU0', name: '沪铜' },
  { code: 'AU0', name: '沪金' },
  { code: 'RB0', name: '螺纹钢' },
  { code: 'HC0', name: '热卷' },
  { code: 'TA0', name: 'PTA' },
  { code: 'RU0', name: '橡胶' },
  { code: 'AL0', name: '沪铝' },
  { code: 'JM0', name: '焦煤' },
  { code: 'M0', name: '豆粕' },
  { code: 'SP0', name: '纸浆' },
  { code: 'Y0', name: '豆油' },
  { code: 'ZN0', name: '沪锌' },
  { code: 'P0', name: '棕榈油' },
  { code: 'LH0', name: '生猪' },
  { code: 'PB0', name: '沪铅' },
  { code: 'I0', name: '铁矿石' },
  { code: 'NI0', name: '沪镍' },
  { code: 'J0', name: '焦炭' },
  { code: 'IM0', name: '中证 1000' },
  { code: 'IF0', name: '沪深 300' },
  { code: 'IC0', name: '中证 500' },
  { code: 'SC0', name: '原油' },
  { code: 'IH0', name: '上证 50' },
  // ===== 第二批：补齐 33 个品种（2026 回测扩展） =====
  { code: 'A0', name: '豆一' },
  { code: 'AO0', name: '氧化铝' },
  { code: 'AP0', name: '苹果' },
  { code: 'BC0', name: '国际铜' },
  { code: 'BU0', name: '沥青' },
  { code: 'C0', name: '玉米' },
  { code: 'CJ0', name: '红枣' },
  { code: 'EB0', name: '苯乙烯' },
  { code: 'EC0', name: '集运欧线' },
  { code: 'EG0', name: '乙二醇' },
  { code: 'FG0', name: '玻璃' },
  { code: 'FU0', name: '燃油' },
  { code: 'JD0', name: '鸡蛋' },
  { code: 'L0', name: '塑料' },
  { code: 'LC0', name: '碳酸锂' },
  { code: 'LU0', name: '低硫燃油' },
  { code: 'MA0', name: '甲醇' },
  { code: 'NR0', name: '20号胶' },
  { code: 'OI0', name: '菜籽油' },
  { code: 'PG0', name: '液化气' },
  { code: 'PP0', name: '聚丙烯' },
  { code: 'PX0', name: '对二甲苯' },
  { code: 'RM0', name: '菜粕' },
  { code: 'SA0', name: '纯碱' },
  { code: 'SF0', name: '硅铁' },
  { code: 'SM0', name: '锰硅' },
  { code: 'SR0', name: '白糖' },
  { code: 'SS0', name: '不锈钢' },
  { code: 'T0', name: '10年国债' },
  { code: 'TF0', name: '5年国债' },
  { code: 'UR0', name: '尿素' },
  { code: 'V0', name: 'PVC' },
  { code: 'WR0', name: '线材' },
];

// 生成「多方统一结论与生产意见」（数据驱动，基于完整回测结果，替代硬编码文案）
function buildConclusions(rows: Array<{ code: string; name: string; d: any }>): string[] {
  const c: string[] = [];
  const total = rows.length;
  const fmtWan = (v: number) => {
    const n = v / 10000;
    return `${n >= 0 ? '+' : ''}${n.toFixed(0)}万`;
  };

  const summaries = rows.map(({ code, name, d }) => {
    const full: any[] = d.fullResults || d.experiments || [];
    const base = d.baseline?.stats || {};
    const best = d.topComposite?.[0]?.stats || {};
    const pnls = full.map((e: any) => e.stats?.totalPnl ?? 0);
    const dds = full.map((e: any) => e.stats?.maxDrawdown ?? 0);
    const positiveRate = full.length ? pnls.filter((p: number) => p > 0).length / full.length : 0;
    const crashRate = full.length ? dds.filter((dd: number) => dd > 0.9).length / full.length : 0;
    return {
      code,
      name,
      sector: GROUP_NAMES[code] || '其他',
      basePnl: base.totalPnl ?? 0,
      bestPnl: best.totalPnl ?? 0,
      bestCapture: best.capture ?? 0,
      bestDD: best.maxDrawdown ?? 0,
      rankPnl: d.baseline?.rank?.pnl ?? null,
      positiveRate,
      crashRate,
    };
  });

  // 1. 总览
  const bestProfit = summaries.filter((s) => s.bestPnl > 0).length;
  const strongProfit = summaries.filter((s) => s.bestPnl > 0 && s.bestCapture >= 0.1).length;
  const baseProfit = summaries.filter((s) => s.basePnl > 0).length;
  c.push(
    `${total} 个品种生产参数已全部升级至寻优 TOP1 配方：${bestProfit}/${total} 最优配方可盈利（其中 ${strongProfit} 个强盈利、捕获率≥10%），${baseProfit}/${total} 基线即可盈利。`
  );

  // 2. 基线即为最优的品种
  const baseOptimal = summaries.filter((s) => s.rankPnl === 1);
  if (baseOptimal.length) {
    c.push(
      `基线即为最优的品种共 ${baseOptimal.length} 个：${baseOptimal
        .map((s) => `${s.name}(${s.code})`)
        .join('、')}，无需调参，生产直接沿用基线。`
    );
  }

  // 3. 优化提升最大的品种（前 3）
  const topImprove = [...summaries]
    .sort((a, b) => (b.bestPnl - b.basePnl) - (a.bestPnl - a.basePnl))
    .slice(0, 3);
  c.push(
    `参数寻优提升最显著：${topImprove
      .map((s) => `${s.name} 基线 ${fmtWan(s.basePnl)} → 最优 ${fmtWan(s.bestPnl)}`)
      .join('；')}。`
  );

  // 4. 板块表现（按平均最优捕获率）
  const sectorAgg: Record<string, { sum: number; n: number }> = {};
  summaries.forEach((s) => {
    if (!sectorAgg[s.sector]) sectorAgg[s.sector] = { sum: 0, n: 0 };
    sectorAgg[s.sector].sum += s.bestCapture;
    sectorAgg[s.sector].n += 1;
  });
  const sectorList = Object.entries(sectorAgg)
    .map(([sector, v]) => ({ sector, avg: v.sum / v.n, n: v.n }))
    .sort((a, b) => b.avg - a.avg);
  if (sectorList.length >= 2) {
    const strong = sectorList[0];
    const weak = sectorList[sectorList.length - 1];
    c.push(
      `板块表现：${strong.sector}最强（${strong.n} 个品种平均捕获率 ${(strong.avg * 100).toFixed(1)}%），${weak.sector}最弱（${weak.n} 个品种平均捕获率 ${(weak.avg * 100).toFixed(1)}%）。`
    );
  }

  // 5. 关键参数铁律（dataWindow / directionMode 共识）
  const dwCount: Record<string, number> = {};
  const dmCount: Record<string, number> = {};
  rows.forEach(({ d }) => {
    const vd = d.varianceDecomposition?.totalPnl || [];
    vd.forEach((v: any) => {
      if (v.dimension === 'dataWindow' && v.bestValue != null) {
        const k = String(v.bestValue);
        dwCount[k] = (dwCount[k] || 0) + 1;
      }
      if (v.dimension === 'directionMode' && v.bestValue != null) {
        const k = String(v.bestValue);
        dmCount[k] = (dmCount[k] || 0) + 1;
      }
    });
  });
  const modeOf = (m: Record<string, number>) =>
    Object.entries(m).sort((a, b) => b[1] - a[1])[0];
  const dwMode = modeOf(dwCount);
  const dmMode = modeOf(dmCount);
  const lawParts: string[] = [];
  if (dwMode) lawParts.push(`dataWindow=${dwMode[0]}（${dwMode[1]}/${total} 品种共识）`);
  if (dmMode) lawParts.push(`directionMode=${dmMode[0]}（${dmMode[1]}/${total} 品种共识）`);
  if (lawParts.length) {
    c.push(`关键参数铁律：${lawParts.join('、')}，新上品种可优先锁定这两项，缩小寻优搜索空间。`);
  }

  // 6. 失效品种（最优配方仍亏损）
  const fails = summaries.filter((s) => s.bestPnl <= 0);
  if (fails.length) {
    c.push(
      `失效品种 ${fails.length} 个：${fails.map((s) => `${s.name}(${s.code})`).join('、')}，最优配方仍亏损，建议移出生产池或单独研发。`
    );
  }

  // 7. 高崩溃风险品种（崩溃率 > 30%）
  const highRisk = summaries.filter((s) => s.crashRate > 0.3);
  if (highRisk.length) {
    c.push(
      `高崩溃风险品种 ${highRisk.length} 个：${highRisk
        .map((s) => `${s.name}(${s.code} 崩溃率${(s.crashRate * 100).toFixed(0)}%)`)
        .join('、')}，参数脆弱，需强制限制回撤后使用。`
    );
  }

  // 8. 稳健品种（正收益比例 > 60% 且最优回撤 < 30%）
  const robust = summaries.filter((s) => s.positiveRate > 0.6 && s.bestDD < 0.3);
  if (robust.length) {
    c.push(
      `稳健品种 ${robust.length} 个：${robust
        .slice(0, 12)
        .map((s) => `${s.name}(${s.code})`)
        .join('、')}${robust.length > 12 ? ' 等' : ''}，正收益比例>60% 且最优回撤<30%，适合作为组合底仓。`
    );
  }

  return c;
}

// 二十六方 1000 次回测对比报告（数据来自 *_1000Experiments.json + 熔断建议表）
router.get('/multi-report', async (_req, res) => {
  try {
    const fullRows = MULTI_CODES.map(({ code, name }) => {
      const d = loadJson(`${code}_1000Experiments.json`);
      if (!d) return null;
      return { code, name, d };
    }).filter(Boolean) as Array<{ code: string; name: string; d: any }>;

    const items = fullRows.map(({ code, name, d }) => {
      // 熔断建议以实时引擎实际生效参数为准（REALTIME_OPT_PARAMS），未配置才回退历史建议表
      const rtOpt = getRealtimeOptParams(code);
      const cb = rtOpt?.circuitBreaker
        ? { lossStreak: rtOpt.circuitBreaker.lossStreak, pauseBars: rtOpt.circuitBreaker.pauseDays }
        : getCircuitBreaker(code);
      return {
        code,
        name,
        dateRange: d.meta?.dateRange ?? '',
        bars: d.meta?.bars ?? 0,
        baseline: {
          stats: d.baseline?.stats ?? null,
          rank: d.baseline?.rank ?? null,
        },
        variance: (d.varianceDecomposition?.totalPnl ?? []).slice(0, 3),
        fragility: (d.fragility?.topFactors ?? []).slice(0, 3),
        topComposite: (d.topComposite ?? []).slice(0, 3).map((r: any) => ({
          stats: r.stats,
          recipe: {
            directionMode: r.recipe?.directionMode,
            circuitBreaker: r.recipe?.circuitBreaker,
            maxHoldDays: r.recipe?.maxHoldDays,
            stopAtrMult: r.recipe?.stopAtrMult,
            targetAtrMult: r.recipe?.targetAtrMult,
            minSignalGrade: r.recipe?.minSignalGrade,
          },
        })),
        circuitBreaker: cb,
      };
    });

    const conclusions = buildConclusions(fullRows);

    res.json({ success: true, data: { generatedAt: new Date().toISOString(), items, conclusions } });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// ============ 1000次回测品种列表（供模拟绩效板块展示所有品种回测报告） ============
const EXP_DATA_DIR = path.join(process.cwd(), 'src', 'data');
// varieties.ts 未覆盖的补充中文名
const VARIETY_NAME_SUPPLEMENT: Record<string, string> = {
  C0: '玉米', OI0: '菜油', SR0: '白糖', Y0: '豆油',
};

router.get('/varieties', (_req, res) => {
  try {
    const files = fs.readdirSync(EXP_DATA_DIR)
      .filter((f: string) => f.endsWith('_1000Experiments.json'));

    const items = files.map((f: string) => {
      const code = f.replace('_1000Experiments.json', '');
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(EXP_DATA_DIR, f), 'utf-8'));
        const meta = raw.meta || {};
        const baseline = raw.baseline?.stats || {};
        const top = (raw.topComposite && raw.topComposite[0]) || null;
        return {
          code,
          name: VARIETIES[code] || VARIETY_NAME_SUPPLEMENT[code] || code,
          sector: GROUP_NAMES[code] || '其他',
          experiments: meta.experiments || 0,
          bars: meta.bars || 0,
          dateRange: meta.dateRange || null,
          theoLong: meta.theoLong ?? null,
          theoShort: meta.theoShort ?? null,
          baseline: {
            totalTrades: baseline.totalTrades || 0,
            winRate: baseline.winRate != null ? Math.round(baseline.winRate * 10000) / 100 : 0,
            totalPnl: Math.round(baseline.totalPnl || 0),
            maxDrawdown: baseline.maxDrawdown != null ? Math.round(baseline.maxDrawdown * 10000) / 100 : 0,
            profitFactor: baseline.profitFactor != null ? Math.round(baseline.profitFactor * 100) / 100 : 0,
            capture: baseline.capture != null ? Math.round(baseline.capture * 10000) / 100 : 0,
          },
          best: top ? {
            winRate: top.stats?.winRate != null ? Math.round(top.stats.winRate * 10000) / 100 : 0,
            totalPnl: Math.round(top.stats?.totalPnl || 0),
            maxDrawdown: top.stats?.maxDrawdown != null ? Math.round(top.stats.maxDrawdown * 10000) / 100 : 0,
            profitFactor: top.stats?.profitFactor != null ? Math.round(top.stats.profitFactor * 100) / 100 : 0,
            totalTrades: top.stats?.totalTrades || 0,
            score: Math.round(top.score || 0),
          } : null,
        };
      } catch (e: any) {
        return { code, name: VARIETIES[code] || VARIETY_NAME_SUPPLEMENT[code] || code, sector: GROUP_NAMES[code] || '其他', error: e.message };
      }
    }).sort((a: any, b: any) => (b.best?.totalPnl || 0) - (a.best?.totalPnl || 0));

    res.json({ success: true, data: items, total: items.length });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

// ============ 单品种策略上下文（供交易建议/AI专家/执行清单使用） ============
router.get('/strategy-context/:code', async (req, res) => {
  try {
    const code = String(req.params.code || '').toUpperCase();
    const ctx = getStrategyContext(code);
    if (!ctx) {
      res.json({ success: false, error: `品种 ${code} 暂无 1000 次实验数据` });
      return;
    }
    res.json({ success: true, data: ctx });
  } catch (e: any) {
    res.json({ success: false, error: e.message });
  }
});

export default router;
