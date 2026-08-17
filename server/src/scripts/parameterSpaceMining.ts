/**
 * 参数空间挖掘脚本（P1）
 * 零重跑成本：直接读取现有 59 品种 × 1000 次 = 59000 次实验数据，挖掘参数空间的深层信息。
 *
 * 产出四个维度：
 * 1. 单因素敏感性 —— 每个参数维度对卡玛比率的影响曲线，识别"真正敏感"的参数
 * 2. 参数交互 —— 关键参数两两组合的表现热力（dataWindow × directionMode 等）
 * 3. 邻域稳定性 —— 每个品种 TOP1 是"孤峰"还是"高原"
 * 4. 板块参数共识 —— 各板块内的参数取值共识（验证"front70/longOnly 铁律"是否成立）
 *
 * 评分口径（与 rescoreAndGrade 一致）：
 * - 卡玛比率 = 收益率 / max(回撤, 1%)，其中收益率 = totalPnl / startCapital
 * - 崩溃 = totalPnl < 0 || maxDrawdown > 0.5
 * - 稳健 = totalPnl > 0 && maxDrawdown < 0.30 && winRate >= 0.40 && profitFactor >= 1.2
 */
import * as fs from 'fs';
import * as path from 'path';
import { GROUP_NAMES } from '../services/varieties';

const DATA_DIR = path.join(process.cwd(), 'src/data');

interface ExpStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  capture: number;
  longPnl?: number;
  shortPnl?: number;
}

interface Exp {
  id: number;
  recipe: Record<string, unknown>;
  stats: ExpStats;
}

interface VarietyData {
  code: string;
  fullResults: Exp[];
}

// 关键策略参数（排除纯技术性参数，如 startCapital/bsMode 等）
const STRATEGY_PARAMS = [
  'minSignalGrade', 'trendFilter', 'cooldownBars', 'edgeLookback',
  'allowRangeTrading', 'equationMode', 'pThreshold', 'stopAtrMult',
  'targetAtrMult', 'maxHoldDays', 'minRR', 'maxPositionPct',
  'directionMode', 'dataWindow', 'feeMult', 'circuitBreaker',
  'volReduce', 'dailyLossLimit',
];

function loadAll(): VarietyData[] {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_1000Experiments.json'));
  const result: VarietyData[] = [];
  for (const f of files) {
    const code = f.replace('_1000Experiments.json', '');
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      result.push({ code, fullResults: d.fullResults as Exp[] });
    } catch (e) {
      console.warn(`跳过 ${f}: ${(e as Error).message}`);
    }
  }
  return result.sort((a, b) => a.code.localeCompare(b.code));
}

function capitalOf(exp: Exp): number {
  const c = exp.recipe.startCapital;
  return typeof c === 'number' && c > 0 ? c : 500000;
}

function pnlPct(exp: Exp): number {
  return exp.stats.totalPnl / capitalOf(exp);
}

function calmar(exp: Exp): number {
  const dd = Math.max(exp.stats.maxDrawdown, 0.01);
  return pnlPct(exp) / dd;
}

function isCrash(exp: Exp): boolean {
  return exp.stats.totalPnl < 0 || exp.stats.maxDrawdown > 0.5;
}

function isRobust(exp: Exp): boolean {
  return (
    exp.stats.totalPnl > 0 &&
    exp.stats.maxDrawdown < 0.30 &&
    exp.stats.winRate >= 0.40 &&
    exp.stats.profitFactor >= 1.2 &&
    exp.stats.totalTrades >= 20
  );
}

interface ValueStat {
  count: number;
  sumCalmar: number;
  sumPnlPct: number;
  robustCount: number;
  crashCount: number;
}

// ============ 1. 单因素敏感性 ============
function sensitivity(all: VarietyData[]) {
  const result: Record<string, { values: Record<string, ValueStat & { avgCalmar: number; avgPnlPct: number; robustPct: number; crashPct: number }>; sensitivity: number; bestValue: string; worstValue: string }> = {};

  for (const param of STRATEGY_PARAMS) {
    const values: Record<string, ValueStat> = {};
    for (const v of all) {
      for (const exp of v.fullResults) {
        const raw = exp.recipe[param];
        if (raw === undefined) continue;
        const key = String(raw);
        if (!values[key]) values[key] = { count: 0, sumCalmar: 0, sumPnlPct: 0, robustCount: 0, crashCount: 0 };
        const s = values[key];
        s.count++;
        s.sumCalmar += calmar(exp);
        s.sumPnlPct += pnlPct(exp);
        if (isRobust(exp)) s.robustCount++;
        if (isCrash(exp)) s.crashCount++;
      }
    }
    if (Object.keys(values).length < 2) continue;

    const enriched: Record<string, any> = {};
    let best = '', worst = '';
    let bestCalmar = -Infinity, worstCalmar = Infinity;
    for (const [key, s] of Object.entries(values)) {
      const avgCalmar = s.sumCalmar / s.count;
      const avgPnlPct = s.sumPnlPct / s.count;
      enriched[key] = {
        count: s.count,
        avgCalmar: +avgCalmar.toFixed(3),
        avgPnlPct: +(avgPnlPct * 100).toFixed(2),
        robustPct: +(s.robustCount / s.count).toFixed(3),
        crashPct: +(s.crashCount / s.count).toFixed(3),
      };
      if (avgCalmar > bestCalmar) { bestCalmar = avgCalmar; best = key; }
      if (avgCalmar < worstCalmar) { worstCalmar = avgCalmar; worst = key; }
    }
    result[param] = {
      values: enriched,
      sensitivity: +(bestCalmar - worstCalmar).toFixed(3),
      bestValue: best,
      worstValue: worst,
    };
  }
  return result;
}

// ============ 2. 参数交互 ============
const INTERACTIONS: Array<[string, string]> = [
  ['dataWindow', 'directionMode'],
  ['stopAtrMult', 'targetAtrMult'],
  ['pThreshold', 'edgeLookback'],
  ['maxHoldDays', 'cooldownBars'],
  ['minSignalGrade', 'equationMode'],
];

function interactions(all: VarietyData[]) {
  const result: Record<string, Record<string, { count: number; avgCalmar: number; avgPnlPct: number; robustPct: number }>> = {};
  for (const [p1, p2] of INTERACTIONS) {
    const key = `${p1} × ${p2}`;
    const combos: Record<string, { count: number; sumCalmar: number; sumPnl: number; robust: number }> = {};
    for (const v of all) {
      for (const exp of v.fullResults) {
        const a = exp.recipe[p1];
        const b = exp.recipe[p2];
        if (a === undefined || b === undefined) continue;
        const ck = `${a} / ${b}`;
        if (!combos[ck]) combos[ck] = { count: 0, sumCalmar: 0, sumPnl: 0, robust: 0 };
        const s = combos[ck];
        s.count++;
        s.sumCalmar += calmar(exp);
        s.sumPnl += pnlPct(exp);
        if (isRobust(exp)) s.robust++;
      }
    }
    const enriched: Record<string, any> = {};
    for (const [ck, s] of Object.entries(combos)) {
      enriched[ck] = {
        count: s.count,
        avgCalmar: +(s.sumCalmar / s.count).toFixed(3),
        avgPnlPct: +((s.sumPnl / s.count) * 100).toFixed(2),
        robustPct: +(s.robust / s.count).toFixed(3),
      };
    }
    result[key] = enriched;
  }
  return result;
}

// ============ 3. 邻域稳定性（参数空间距离口径）============
// 枚举参数：值不同贡献 1 距离；数值参数：|a-b|/range 归一化
const ENUM_PARAMS = [
  'minSignalGrade', 'trendFilter', 'allowRangeTrading', 'equationMode',
  'directionMode', 'dataWindow', 'bsMode', 'circuitBreaker', 'volReduce', 'dailyLossLimit',
];
const NUM_PARAMS: Array<[string, number]> = [
  ['cooldownBars', 4], ['edgeLookback', 100], ['pThreshold', 0.6], ['softEquationMul', 1],
  ['stopAtrMult', 3], ['targetAtrMult', 5], ['maxHoldDays', 60], ['minRR', 1.5],
  ['maxPositionPct', 0.3], ['nonGreenMul', 1], ['counterCampMul', 1], ['campWindow', 100],
  ['feeMult', 1],
];

function paramDistance(a: Record<string, unknown>, b: Record<string, unknown>): number {
  let dist = 0;
  for (const p of ENUM_PARAMS) {
    if (a[p] !== undefined && b[p] !== undefined && a[p] !== b[p]) dist += 1;
  }
  for (const [p, range] of NUM_PARAMS) {
    const av = a[p], bv = b[p];
    if (typeof av === 'number' && typeof bv === 'number' && range > 0) {
      dist += Math.abs(av - bv) / range;
    }
  }
  return dist;
}

function neighborhood(all: VarietyData[]) {
  const result: Record<string, { topCalmar: number; topPnlPct: number; topDd: number; neighborAvgCalmar: number; neighborCount: number; isPlateau: boolean; topRecipe: Record<string, unknown> }> = {};

  for (const v of all) {
    // 找出卡玛最高的 TOP1
    let top: Exp | null = null;
    for (const exp of v.fullResults) {
      if (!top || calmar(exp) > calmar(top)) top = exp;
    }
    if (!top) continue;

    // 参数空间最近邻：与 TOP1 参数距离最近的 10 个点（排除 TOP1 自身）
    const ranked = v.fullResults
      .map((exp) => ({ exp, dist: paramDistance(top!.recipe, exp.recipe) }))
      .filter((x) => x.dist > 0) // 排除 TOP1 自身
      .sort((a, b) => a.dist - b.dist);
    const n = 10;
    const neighbors = ranked.slice(0, n);
    const neighborAvgCalmar = neighbors.length
      ? neighbors.reduce((s, x) => s + calmar(x.exp), 0) / neighbors.length
      : 0;

    result[v.code] = {
      topCalmar: +calmar(top).toFixed(3),
      topPnlPct: +(pnlPct(top) * 100).toFixed(2),
      topDd: +(top.stats.maxDrawdown * 100).toFixed(1),
      neighborAvgCalmar: +neighborAvgCalmar.toFixed(3),
      neighborCount: neighbors.length,
      // 高原 = 参数近邻的卡玛 >= TOP1 的一半（说明该参数区域整体优质，非运气单点）
      isPlateau: neighborAvgCalmar >= calmar(top) * 0.5,
      topRecipe: top.recipe,
    };
  }
  return result;
}

// ============ 4. 板块参数共识 ============
function sectorConsensus(all: VarietyData[]) {
  const keyParams = ['dataWindow', 'directionMode', 'edgeLookback', 'maxHoldDays', 'minSignalGrade'];
  const sectorBest: Record<string, Record<string, Record<string, number>>> = {};

  for (const v of all) {
    const sector = GROUP_NAMES[v.code] || '未分类';
    if (!sectorBest[sector]) sectorBest[sector] = {};
    for (const param of keyParams) {
      // 找该品种此参数下卡玛最高的取值
      const best: Record<string, { sumCalmar: number; count: number }> = {};
      for (const exp of v.fullResults) {
        const raw = exp.recipe[param];
        if (raw === undefined) continue;
        const key = String(raw);
        if (!best[key]) best[key] = { sumCalmar: 0, count: 0 };
        best[key].sumCalmar += calmar(exp);
        best[key].count++;
      }
      let bestVal = '', bestC = -Infinity;
      for (const [key, s] of Object.entries(best)) {
        const c = s.sumCalmar / s.count;
        if (c > bestC) { bestC = c; bestVal = key; }
      }
      if (!sectorBest[sector][param]) sectorBest[sector][param] = {};
      sectorBest[sector][param][bestVal] = (sectorBest[sector][param][bestVal] || 0) + 1;
    }
  }
  return sectorBest;
}

function main() {
  console.log('加载 59 品种实验数据...');
  const all = loadAll();
  const totalExps = all.reduce((s, v) => s + v.fullResults.length, 0);
  console.log(`品种 ${all.length} 个，实验 ${totalExps} 次\n`);

  console.log('计算单因素敏感性...');
  const sens = sensitivity(all);

  console.log('计算参数交互...');
  const inter = interactions(all);

  console.log('计算邻域稳定性...');
  const neigh = neighborhood(all);

  console.log('计算板块共识...');
  const sector = sectorConsensus(all);

  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalVarieties: all.length,
      totalExperiments: totalExps,
    },
    sensitivity: sens,
    interactions: inter,
    neighborhood: neigh,
    sectorConsensus: sector,
  };

  const out = path.join(DATA_DIR, 'parameterSpaceMining.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(`\n报告已写入 ${out}`);

  // ============ 控制台摘要 ============
  console.log('\n========== 参数敏感度排名（越靠前越敏感）==========');
  const ranked = Object.entries(sens).sort((a, b) => b[1].sensitivity - a[1].sensitivity);
  for (const [param, s] of ranked) {
    console.log(`  ${param.padEnd(18)} 敏感度=${s.sensitivity.toFixed(3)}  最优=${s.bestValue}  最差=${s.worstValue}`);
  }

  console.log('\n========== 板块共识（各板块最优参数）==========');
  for (const [sect, params] of Object.entries(sector)) {
    const parts: string[] = [];
    for (const [p, vals] of Object.entries(params)) {
      const top = Object.entries(vals).sort((a, b) => b[1] - a[1])[0];
      parts.push(`${p}=${top[0]}(${top[1]}个)`);
    }
    console.log(`  ${sect.padEnd(6)} ${parts.join('  ')}`);
  }

  console.log('\n========== 邻域稳定性（孤峰 vs 高原）==========');
  const plateau = Object.values(neigh).filter((n) => n.isPlateau).length;
  const peak = Object.values(neigh).length - plateau;
  console.log(`  高原品种 ${plateau} 个 / 孤峰品种 ${peak} 个`);
  const peakVarieties = Object.entries(neigh).filter(([, n]) => !n.isPlateau).map(([c]) => c);
  console.log(`  孤峰品种（TOP1 可能是噪声冠军）: ${peakVarieties.join(', ')}`);
}

main();
