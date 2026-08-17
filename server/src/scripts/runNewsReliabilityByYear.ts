/**
 * 新闻监控可靠性分年段回测
 *
 * 目标：验证新闻监控三层信号（方向推断、品种映射、传播链预警）的可靠性，
 * 并按时间年段（近1/2/3/5/10/20年）与事件类别分解，判断策略是否随时间/市场结构失效。
 *
 * 数据源：
 * - BLACK_SWAN_EVENTS（137 个真实历史事件，2000-2026，精确到日）
 * - data-cache-daily-20y（20 年日线缓存）
 *
 * 核心指标（主窗口 10 日）：
 * - 规则方向准确率：inferDirection（关键词规则）输出方向 vs 事件后实际涨跌
 * - 共识方向准确率：人工标注方向 vs 事件后实际涨跌（对照基准）
 * - 共识方向平均收益：按方向做多/做空的 10 日平均收益
 * - 反直觉率：共识方向与实际相反的占比
 * - 品种映射精确率/召回率：inferVarieties 输出 vs 人工标注品种
 *
 * 运行：cd server && npx tsx src/scripts/runNewsReliabilityByYear.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';
import { inferDirection, inferVarieties } from '../services/newsService.js';
import { loadVarietyBars } from '../services/newsBacktestEngine.js';
import type { DailyBar } from '../services/newsBacktestEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '../..');
const DATA_DIR = path.join(SERVER_ROOT, 'data-cache-daily-20y');
const REPORT_OUT = path.join(SERVER_ROOT, 'src/data/newsReliabilityReport.json');

/** 回测窗口（事件后 N 个交易日） */
const WINDOWS = [1, 3, 5, 10, 20, 60] as const;
/** 方向准确率主窗口 */
const MAIN_WINDOW = 10;

/** 年段划分 */
const YEAR_BUCKETS = [
  { label: '近1年', years: 1 },
  { label: '近2年', years: 2 },
  { label: '近3年', years: 3 },
  { label: '近5年', years: 5 },
  { label: '近10年', years: 10 },
  { label: '近20年', years: 20 },
  { label: '全部', years: 9999 },
] as const;

// ---------- 类型 ----------
interface DirectionSample {
  eventId: string;
  date: string;
  category: number;
  categoryName: string;
  code: string;
  ruleDirection: string;
  consensusDirection: string;
  rets: Record<number, number | null>;
}

interface VarietyMappingSample {
  eventId: string;
  category: number;
  categoryName: string;
  precision: number | null;
  recall: number;
}

interface BucketStats {
  label: string;
  years: number;
  eventCount: number;
  sampleCount: number;
  ruleAccuracy: number | null;
  consensusAccuracy: number | null;
  consensusMeanSignedRet: number | null;
  consensusWinRate: number | null;
  contrarianRate10: number | null;
}

interface CategoryStats {
  category: number;
  categoryName: string;
  sampleCount: number;
  ruleAccuracy: number | null;
  consensusAccuracy: number | null;
  consensusMeanSignedRet: number | null;
}

// ---------- 工具函数 ----------
const barsCache = new Map<string, DailyBar[]>();
function getBars(code: string): DailyBar[] {
  if (!barsCache.has(code)) {
    try {
      barsCache.set(code, loadVarietyBars(code, DATA_DIR));
    } catch {
      barsCache.set(code, []);
    }
  }
  return barsCache.get(code)!;
}

function dirSign(d: string): 1 | -1 | 0 {
  if (d === '利多') return 1;
  if (d === '利空') return -1;
  return 0;
}

/** 方向正确性：利多 → 上涨为正确；利空 → 下跌为正确；中性 → 不判定 */
function isCorrect(direction: string, ret: number | null): boolean | null {
  const s = dirSign(direction);
  if (s === 0 || ret === null) return null;
  return s * ret > 0;
}

/** 事件后按方向做多/做空的符号化收益（利多取 +ret，利空取 -ret） */
function signedReturn(direction: string, ret: number | null): number | null {
  const s = dirSign(direction);
  if (s === 0 || ret === null) return null;
  return s * ret;
}

/** 找 >= date 的第一根 bar 索引 */
function findEventIndex(bars: DailyBar[], date: string): number {
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date >= date) return i;
  }
  return -1;
}

/** 事件后 window 个交易日的累计涨跌幅(%) */
function windowReturn(bars: DailyBar[], idx: number, window: number): number | null {
  const t = idx + window;
  if (t >= bars.length) return null;
  const base = bars[idx].c;
  if (!base) return null;
  return ((bars[t].c - base) / base) * 100;
}

function yearsAgo(date: string): number {
  const d = new Date(date).getTime();
  const now = Date.now();
  return (now - d) / (365.25 * 24 * 3600 * 1000);
}

// ---------- 主循环：遍历历史事件，复现规则信号并计算结果 ----------
function buildSamples(): { samples: DirectionSample[]; varietySamples: VarietyMappingSample[] } {
  const samples: DirectionSample[] = [];
  const varietySamples: VarietyMappingSample[] = [];

  for (const ev of BLACK_SWAN_EVENTS) {
    const text = `${ev.title} ${ev.consensus}`;
    const ruleDirection = inferDirection(ev.category, text);
    const ruleVarieties = inferVarieties(text);
    const labeledVarieties = ev.varieties;

    // 品种映射评估
    const overlap = ruleVarieties.filter((v) => labeledVarieties.includes(v));
    const precision = ruleVarieties.length > 0 ? overlap.length / ruleVarieties.length : null;
    const recall = labeledVarieties.length > 0 ? overlap.length / labeledVarieties.length : 0;
    varietySamples.push({
      eventId: ev.id,
      category: ev.category,
      categoryName: ev.categoryName,
      precision,
      recall,
    });

    // 方向样本：对每个标注品种计算事件后收益
    for (const code of labeledVarieties) {
      const bars = getBars(code);
      if (bars.length === 0) continue;
      const idx = findEventIndex(bars, ev.date);
      if (idx < 0) continue;

      const rets: Record<number, number | null> = {};
      for (const w of WINDOWS) {
        rets[w] = windowReturn(bars, idx, w);
      }

      samples.push({
        eventId: ev.id,
        date: ev.date,
        category: ev.category,
        categoryName: ev.categoryName,
        code,
        ruleDirection,
        consensusDirection: ev.direction,
        rets,
      });
    }
  }

  return { samples, varietySamples };
}

// ---------- 聚合统计 ----------
function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function pct(n: number | null): string {
  return n === null ? '  --  ' : `${(n * 100).toFixed(1).padStart(5)}%`;
}

/** 统计方向准确率（主窗口） */
function directionAccuracy(samples: DirectionSample[], dirKey: 'ruleDirection' | 'consensusDirection'): number | null {
  let correct = 0;
  let total = 0;
  for (const s of samples) {
    const ret = s.rets[MAIN_WINDOW];
    const ok = isCorrect(s[dirKey], ret);
    if (ok !== null) {
      total++;
      if (ok) correct++;
    }
  }
  return total === 0 ? null : correct / total;
}

/** 统计共识方向的符号化收益（主窗口） */
function consensusSignedReturns(samples: DirectionSample[]): number[] {
  const out: number[] = [];
  for (const s of samples) {
    const r = signedReturn(s.consensusDirection, s.rets[MAIN_WINDOW]);
    if (r !== null) out.push(r);
  }
  return out;
}

function buildYearBuckets(samples: DirectionSample[]): BucketStats[] {
  return YEAR_BUCKETS.map((b) => {
    const subset = samples.filter((s) => yearsAgo(s.date) <= b.years);
    const signedRets = consensusSignedReturns(subset);
    const acc10 = directionAccuracy(subset, 'consensusDirection');
    const eventIds = new Set(subset.map((s) => s.eventId));

    return {
      label: b.label,
      years: b.years,
      eventCount: eventIds.size,
      sampleCount: subset.length,
      ruleAccuracy: directionAccuracy(subset, 'ruleDirection'),
      consensusAccuracy: acc10,
      consensusMeanSignedRet: mean(signedRets),
      consensusWinRate: signedRets.length === 0 ? null : signedRets.filter((r) => r > 0).length / signedRets.length,
      contrarianRate10: acc10 === null ? null : 1 - acc10,
    };
  });
}

function buildCategoryStats(samples: DirectionSample[]): CategoryStats[] {
  const map = new Map<number, DirectionSample[]>();
  for (const s of samples) {
    if (!map.has(s.category)) map.set(s.category, []);
    map.get(s.category)!.push(s);
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([cat, subset]) => {
      const signedRets = consensusSignedReturns(subset);
      return {
        category: cat,
        categoryName: subset[0].categoryName,
        sampleCount: subset.length,
        ruleAccuracy: directionAccuracy(subset, 'ruleDirection'),
        consensusAccuracy: directionAccuracy(subset, 'consensusDirection'),
        consensusMeanSignedRet: mean(signedRets),
      };
    });
}

/** 各窗口整体方向准确率 */
function buildWindowStats(samples: DirectionSample[]): Record<number, { ruleAccuracy: number | null; consensusAccuracy: number | null; sampleCount: number }> {
  const out: Record<number, { ruleAccuracy: number | null; consensusAccuracy: number | null; sampleCount: number }> = {};
  for (const w of WINDOWS) {
    let ruleTotal = 0;
    let ruleOk = 0;
    let consTotal = 0;
    let consOk = 0;
    for (const s of samples) {
      const ret = s.rets[w];
      const rc = isCorrect(s.ruleDirection, ret);
      const cc = isCorrect(s.consensusDirection, ret);
      if (rc !== null) {
        ruleTotal++;
        if (rc) ruleOk++;
      }
      if (cc !== null) {
        consTotal++;
        if (cc) consOk++;
      }
    }
    out[w] = {
      ruleAccuracy: ruleTotal === 0 ? null : ruleOk / ruleTotal,
      consensusAccuracy: consTotal === 0 ? null : consOk / consTotal,
      sampleCount: consTotal,
    };
  }
  return out;
}

// ---------- 品种映射聚合 ----------
function buildVarietyMappingStats(varietySamples: VarietyMappingSample[]) {
  const precisions = varietySamples.map((v) => v.precision).filter((p): p is number => p !== null);
  const recalls = varietySamples.map((v) => v.recall);

  const byCategoryMap = new Map<number, VarietyMappingSample[]>();
  for (const v of varietySamples) {
    if (!byCategoryMap.has(v.category)) byCategoryMap.set(v.category, []);
    byCategoryMap.get(v.category)!.push(v);
  }
  const byCategory = Array.from(byCategoryMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([cat, subset]) => {
      const ps = subset.map((v) => v.precision).filter((p): p is number => p !== null);
      const rs = subset.map((v) => v.recall);
      return {
        category: cat,
        categoryName: subset[0].categoryName,
        count: subset.length,
        avgPrecision: mean(ps),
        avgRecall: mean(rs),
      };
    });

  return { avgPrecision: mean(precisions), avgRecall: mean(recalls), byCategory };
}

// ---------- 主流程 ----------
function main() {
  console.log('开始新闻监控可靠性回测...\n');
  const { samples, varietySamples } = buildSamples();

  const eventIds = new Set(samples.map((s) => s.eventId));
  console.log(`历史事件总数: ${BLACK_SWAN_EVENTS.length}`);
  console.log(`有效方向样本数(事件×品种): ${samples.length}`);
  console.log(`覆盖事件数(有日线数据): ${eventIds.size}`);
  console.log(`品种映射样本数: ${varietySamples.length}`);
  console.log(`主窗口: 事件后 ${MAIN_WINDOW} 个交易日\n`);

  const varietyStats = buildVarietyMappingStats(varietySamples);
  const yearBuckets = buildYearBuckets(samples);
  const categoryStats = buildCategoryStats(samples);
  const windowStats = buildWindowStats(samples);

  // 品种映射
  console.log('━━━ 品种映射可靠性（inferVarieties vs 人工标注）━━━');
  console.log(`整体精确率: ${pct(varietyStats.avgPrecision)}   整体召回率: ${pct(varietyStats.avgRecall)}`);
  console.log('分类别:');
  console.log('  类别                 样本  精确率    召回率');
  for (const c of varietyStats.byCategory) {
    console.log(`  ${c.categoryName.padEnd(18)} ${String(c.count).padEnd(5)} ${pct(c.avgPrecision)}  ${pct(c.avgRecall)}`);
  }
  console.log('');

  // 分年段
  console.log(`━━━ 分年段方向准确率（主窗口 ${MAIN_WINDOW} 日）━━━`);
  console.log('  年段     事件  样本   规则准确率  共识准确率  共识均收益  胜率   反直觉率');
  for (const b of yearBuckets) {
    console.log(
      `  ${b.label.padEnd(7)} ${String(b.eventCount).padEnd(5)} ${String(b.sampleCount).padEnd(6)} ` +
        `${pct(b.ruleAccuracy)}     ${pct(b.consensusAccuracy)}     ` +
        `${(b.consensusMeanSignedRet === null ? '  --  ' : `${b.consensusMeanSignedRet.toFixed(2).padStart(5)}%`)}  ` +
        `${pct(b.consensusWinRate)}  ${pct(b.contrarianRate10)}`
    );
  }
  console.log('');

  // 分类别
  console.log(`━━━ 分类别方向准确率（主窗口 ${MAIN_WINDOW} 日）━━━`);
  console.log('  类别                 样本   规则准确率  共识准确率  共识均收益');
  for (const c of categoryStats) {
    console.log(
      `  ${c.categoryName.padEnd(18)} ${String(c.sampleCount).padEnd(6)} ` +
        `${pct(c.ruleAccuracy)}     ${pct(c.consensusAccuracy)}     ` +
        `${c.consensusMeanSignedRet === null ? '  --  ' : `${c.consensusMeanSignedRet.toFixed(2)}%`}`
    );
  }
  console.log('');

  // 各窗口
  console.log('━━━ 各回测窗口整体方向准确率 ━━━');
  console.log('  窗口(日)  样本   规则准确率  共识准确率');
  for (const w of WINDOWS) {
    const ws = windowStats[w];
    console.log(
      `  ${String(w).padEnd(8)} ${String(ws.sampleCount).padEnd(6)} ` +
        `${pct(ws.ruleAccuracy)}     ${pct(ws.consensusAccuracy)}`
    );
  }
  console.log('');

  // 写 JSON 报告
  const report = {
    generatedAt: new Date().toISOString(),
    meta: {
      totalEvents: BLACK_SWAN_EVENTS.length,
      coveredEvents: eventIds.size,
      totalSamples: samples.length,
      mainWindow: MAIN_WINDOW,
      windows: [...WINDOWS],
    },
    varietyMapping: varietyStats,
    yearBuckets,
    categoryStats,
    windowStats,
    // 明细样本（便于后续前端可视化）
    samples: samples.map((s) => ({
      eventId: s.eventId,
      date: s.date,
      category: s.category,
      categoryName: s.categoryName,
      code: s.code,
      ruleDirection: s.ruleDirection,
      consensusDirection: s.consensusDirection,
      rets: s.rets,
    })),
  };

  fs.mkdirSync(path.dirname(REPORT_OUT), { recursive: true });
  fs.writeFileSync(REPORT_OUT, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`报告已写入: ${REPORT_OUT}`);
}

main();
