/**
 * P1-a: directionMode 方向 beta 拆解验证（零重跑）
 *
 * 目的：验证各板块的"方向共识"（如黑色 shortOnly、其他 longOnly）是
 *       策略 alpha，还是只是回测区间单边趋势（beta）的产物。
 *
 * 方法：
 *   1. 用价格序列 buy & hold 实际涨跌判断品种的"趋势方向"
 *   2. 从 fullResults 统计 directionMode 各取值（longOnly/shortOnly/both/split）的平均卡玛
 *   3. 对比"趋势方向" vs "最优方向"，若一致则判定为 beta 证据
 *
 * 输出：server/src/data/directionBetaAnalysis.json
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const PRICE_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

// 板块映射（与 buildSectorPriors.ts 一致）
const GROUP: Record<string, string> = {
  T0: '国债', TF0: '国债',
  AG0: '贵金属', AU0: '贵金属',
  HC0: '黑色', RB0: '黑色', I0: '黑色', J0: '黑色', JM0: '黑色', SF0: '黑色', SM0: '黑色',
  CU0: '有色', AL0: '有色', ZN0: '有色', NI0: '有色', PB0: '有色', SS0: '有色', BC0: '有色', AO0: '有色',
  SC0: '能化', BU0: '能化', TA0: '能化', MA0: '能化', EG0: '能化', PP0: '能化', L0: '能化', V0: '能化',
  FU0: '能化', LU0: '能化', EB0: '能化', PG0: '能化', PX0: '能化', UR0: '能化', RU0: '能化', NR0: '能化',
  A0: '农产品', M0: '农产品', RM0: '农产品', CF0: '农产品', AP0: '农产品', CJ0: '农产品',
  JD0: '农产品', LH0: '农产品', P0: '农产品', C0: '农产品', Y0: '农产品', OI0: '农产品', SR0: '农产品',
  IF0: '股指', IH0: '股指', IC0: '股指', IM0: '股指',
  EC0: '航运', SI0: '新材料', LC0: '新材料',
};

interface ExpStats {
  totalPnl: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  capture: number;
  totalTrades: number;
}
interface Exp {
  recipe: { directionMode?: string; startCapital?: number; [k: string]: unknown };
  stats: ExpStats;
}
interface Meta {
  theoLong?: number;
  theoShort?: number;
}

function calmar(pnl: number, dd: number, capital: number): number {
  const ddBounded = Math.max(dd, 0.01);
  return (pnl / Math.max(capital, 1)) / ddBounded;
}

function loadExps(code: string): { fullResults: Exp[]; meta: Meta } | null {
  const fp = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  if (!fs.existsSync(fp)) return null;
  const d = JSON.parse(fs.readFileSync(fp, 'utf8'));
  return { fullResults: d.fullResults || [], meta: d.meta || {} };
}

interface DirStat {
  count: number;
  avgCalmar: number;
  profitablePct: number;
  crashPct: number;
}
type DirMap = Record<string, DirStat>;

interface VarietyResult {
  code: string;
  sector: string;
  trend: 'long' | 'short' | 'neutral';
  theoLong: number;
  theoShort: number;
  dirs: DirMap;
  bestDir: string;
  bestDirCalmar: number;
  isBetaAligned: boolean;
}

function trendDirection(code: string): 'long' | 'short' | 'neutral' {
  try {
    const raw = fs.readFileSync(path.join(PRICE_DIR, `${code}.json`), 'utf-8');
    const bars = JSON.parse(raw) as { c?: number }[];
    if (!bars.length) return 'neutral';
    const first = Number(bars[0].c ?? 0);
    const last = Number(bars[bars.length - 1].c ?? 0);
    if (first <= 0) return 'neutral';
    const ret = (last - first) / first;
    if (ret >= 0.10) return 'long';
    if (ret <= -0.10) return 'short';
    return 'neutral';
  } catch {
    return 'neutral';
  }
}

function analyzeVariety(code: string): VarietyResult | null {
  const data = loadExps(code);
  if (!data) return null;
  const { fullResults, meta } = data;
  if (!fullResults.length) return null;

  const dirs: DirMap = {};
  for (const exp of fullResults) {
    const dir = String(exp.recipe.directionMode ?? 'unknown');
    const capital = Number(exp.recipe.startCapital ?? 500000);
    const c = calmar(exp.stats.totalPnl, exp.stats.maxDrawdown, capital);
    const crash = exp.stats.totalPnl < 0 || exp.stats.maxDrawdown > 0.5;
    if (!dirs[dir]) dirs[dir] = { count: 0, avgCalmar: 0, profitablePct: 0, crashPct: 0 };
    const d = dirs[dir];
    d.count += 1;
    d.avgCalmar += c;
    d.profitablePct += exp.stats.totalPnl > 0 ? 1 : 0;
    d.crashPct += crash ? 1 : 0;
  }
  // 归一化
  for (const k of Object.keys(dirs)) {
    const d = dirs[k];
    d.avgCalmar = +(d.avgCalmar / d.count).toFixed(4);
    d.profitablePct = +(d.profitablePct / d.count).toFixed(4);
    d.crashPct = +(d.crashPct / d.count).toFixed(4);
  }

  // 最优方向 = 平均卡玛最高（且样本量>=30）
  let bestDir = 'none';
  let bestCalmar = -Infinity;
  for (const [k, v] of Object.entries(dirs)) {
    if (v.count < 30) continue;
    if (v.avgCalmar > bestCalmar) {
      bestCalmar = v.avgCalmar;
      bestDir = k;
    }
  }

  const trend = trendDirection(code);
  // beta 对齐判定：最优方向与趋势方向一致
  const isBetaAligned =
    (trend === 'long' && bestDir === 'longOnly') ||
    (trend === 'short' && bestDir === 'shortOnly');

  return {
    code,
    sector: GROUP[code] ?? '未知',
    trend,
    theoLong: meta.theoLong ?? 0,
    theoShort: meta.theoShort ?? 0,
    dirs,
    bestDir,
    bestDirCalmar: +bestCalmar.toFixed(2),
    isBetaAligned,
  };
}

function main() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_1000Experiments.json'));
  const codes = files.map((f) => f.replace('_1000Experiments.json', '')).sort();

  const results: VarietyResult[] = [];
  for (const code of codes) {
    const r = analyzeVariety(code);
    if (r) results.push(r);
  }

  // 板块聚合
  const sectorAgg: Record<string, { total: number; betaAligned: number; bestDirCount: Record<string, number> }> = {};
  for (const r of results) {
    if (!sectorAgg[r.sector]) sectorAgg[r.sector] = { total: 0, betaAligned: 0, bestDirCount: {} };
    const agg = sectorAgg[r.sector];
    agg.total += 1;
    if (r.isBetaAligned) agg.betaAligned += 1;
    agg.bestDirCount[r.bestDir] = (agg.bestDirCount[r.bestDir] ?? 0) + 1;
  }

  // 输出
  const summary = {
    generatedAt: new Date().toISOString(),
    totalVarieties: results.length,
    sectors: Object.entries(sectorAgg).map(([sector, agg]) => ({
      sector,
      total: agg.total,
      betaAligned: agg.betaAligned,
      betaRate: +(agg.betaAligned / Math.max(agg.total, 1)).toFixed(2),
      bestDirCount: agg.bestDirCount,
    })),
    varieties: results,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'directionBetaAnalysis.json'), JSON.stringify(summary, null, 2));

  // 控制台摘要
  console.log('=== directionMode 方向 beta 拆解验证 ===\n');
  console.log(`品种总数: ${results.length}\n`);
  console.log('板块 | 品种数 | beta对齐数 | beta对齐率 | 最优方向分布');
  console.log('-----|--------|-----------|-----------|-------------');
  for (const [sector, agg] of Object.entries(sectorAgg).sort(
    (a, b) => b[1].betaAligned / Math.max(b[1].total, 1) - a[1].betaAligned / Math.max(a[1].total, 1),
  )) {
    const dirStr = Object.entries(agg.bestDirCount)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}:${v}`)
      .join(', ');
    console.log(
      `${sector} | ${agg.total} | ${agg.betaAligned} | ${(agg.betaAligned / agg.total * 100).toFixed(0)}% | ${dirStr}`,
    );
  }

  console.log('\n=== beta 对齐明细（最优方向 = 趋势方向） ===');
  for (const r of results.filter((x) => x.isBetaAligned)) {
    console.log(
      `  ${r.code} [${r.sector}] 趋势=${r.trend} 最优方向=${r.bestDir} (卡玛${r.bestDirCalmar})`,
    );
  }

  console.log('\n=== 反 beta 品种（最优方向 ≠ 趋势方向，可能是真 alpha） ===');
  for (const r of results.filter((x) => !x.isBetaAligned && x.bestDir !== 'none')) {
    console.log(
      `  ${r.code} [${r.sector}] 趋势=${r.trend} 最优方向=${r.bestDir} (卡玛${r.bestDirCalmar})`,
    );
  }
}

main();
