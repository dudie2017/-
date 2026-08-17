/**
 * buildSectorPriors.ts — P0 板块优化落地（零重跑成本）
 *
 * 功能：
 *   P0-2 明星品种 TOP-N 参数平均：对 CF0/CU0/HC0 用卡玛比率排序取 TOP-N，
 *        数值参数取均值、枚举参数取众数、布尔参数取多数，产出"稳健平均参数"
 *        替代单点 TOP1（当前 57/59 品种 TOP1 是孤峰，单点不可靠）。
 *   P0-1 板块差异化搜索先验：基于 parameterSpaceMining 的 sectorConsensus，
 *        为每个板块生成参数搜索空间先验，供未来寻优缩小搜索空间。
 *
 * 运行：npx tsx src/scripts/buildSectorPriors.ts
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.resolve(process.cwd(), 'src/data');

/** 数值型参数（TOP-N 取均值） */
const NUMERIC_KEYS = [
  'cooldownBars',
  'edgeLookback',
  'pThreshold',
  'softEquationMul',
  'stopAtrMult',
  'targetAtrMult',
  'maxHoldDays',
  'minRR',
  'maxPositionPct',
  'nonGreenMul',
  'counterCampMul',
  'campWindow',
  'feeMult',
] as const;

/** 枚举型参数（TOP-N 取众数） */
const ENUM_KEYS = [
  'minSignalGrade',
  'equationMode',
  'directionMode',
  'dataWindow',
  'bsMode',
  'circuitBreaker',
  'volReduce',
  'dailyLossLimit',
] as const;

/** 布尔型参数（TOP-N 取多数） */
const BOOL_KEYS = ['trendFilter', 'allowRangeTrading'] as const;

interface ExpStats {
  totalPnl: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  capture: number;
  totalTrades: number;
}

interface Exp {
  id: number;
  recipe: Record<string, unknown>;
  stats: ExpStats;
}

interface VarietyData {
  fullResults: Exp[];
}

/** 卡玛比率：收益率 / 回撤（回撤过小则兜底），数值越高越稳健 */
function calmar(pnl: number, dd: number, capital = 500000): number {
  const pnlPct = pnl / capital;
  return pnlPct / Math.max(dd, 0.01);
}

/** 计算众数 */
function mode(values: string[]): string {
  const counter = new Map<string, number>();
  for (const v of values) counter.set(v, (counter.get(v) ?? 0) + 1);
  let best = values[0];
  let bestCount = -1;
  for (const [k, c] of counter) {
    if (c > bestCount) {
      best = k;
      bestCount = c;
    }
  }
  return best;
}

/** 对一组实验做 TOP-N 参数平均 */
function ensembleTopN(experiments: Exp[], n: number): Record<string, unknown> {
  const numericAcc: Record<string, number> = {};
  const enumAcc: Record<string, string[]> = {};
  const boolAcc: Record<string, number> = {};

  for (const key of NUMERIC_KEYS) numericAcc[key] = 0;
  for (const key of ENUM_KEYS) enumAcc[key] = [];
  for (const key of BOOL_KEYS) boolAcc[key] = 0;

  for (const e of experiments) {
    for (const key of NUMERIC_KEYS) {
      numericAcc[key] += Number(e.recipe[key] ?? 0);
    }
    for (const key of ENUM_KEYS) {
      enumAcc[key].push(String(e.recipe[key] ?? ''));
    }
    for (const key of BOOL_KEYS) {
      boolAcc[key] += e.recipe[key] === true ? 1 : 0;
    }
  }

  const out: Record<string, unknown> = {};
  for (const key of NUMERIC_KEYS) {
    out[key] = Math.round((numericAcc[key] / n) * 100) / 100;
  }
  for (const key of ENUM_KEYS) {
    out[key] = mode(enumAcc[key]);
  }
  for (const key of BOOL_KEYS) {
    out[key] = boolAcc[key] / n >= 0.5;
  }
  // 保留固定值
  out['startCapital'] = 500000;
  return out;
}

/** 读取品种实验数据 */
function loadVariety(code: string): VarietyData {
  const file = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as VarietyData;
}

/** 用卡玛排序取 TOP-N（过滤崩溃实验后） */
function topNByCalmar(data: VarietyData, n: number): Exp[] {
  const ranked = data.fullResults
    .filter((e) => e.stats.totalPnl > 0 && e.stats.maxDrawdown < 0.5)
    .sort(
      (a, b) =>
        calmar(b.stats.totalPnl, b.stats.maxDrawdown) -
        calmar(a.stats.totalPnl, a.stats.maxDrawdown),
    );
  return ranked.slice(0, n);
}

// ===== P0-2：明星品种 TOP-N 参数平均 =====
const STAR_CODES = ['CF0', 'CU0', 'HC0'];
const TOP_N = 20;

function runEnsemble() {
  console.log('=== P0-2 明星品种 TOP-N 参数平均（N=20，卡玛排序）===\n');
  const result: Record<string, unknown> = {};

  for (const code of STAR_CODES) {
    const data = loadVariety(code);
    const topN = topNByCalmar(data, TOP_N);
    const ens = ensembleTopN(topN, TOP_N);

    // 单点 TOP1（卡玛最高）用于对比
    const top1 = topN[0];
    const top1Calmar = calmar(top1.stats.totalPnl, top1.stats.maxDrawdown);
    const ensCalmarAvg =
      topN.reduce((s, e) => s + calmar(e.stats.totalPnl, e.stats.maxDrawdown), 0) /
      TOP_N;

    result[code] = { ensemble: ens, top1: top1.recipe, topNCount: topN.length };

    console.log(`【${code}】`);
    console.log(`  有效 TOP-N 实验数: ${topN.length}`);
    console.log(
      `  单点 TOP1 卡玛: ${top1Calmar.toFixed(2)} | TOP-N 平均卡玛: ${ensCalmarAvg.toFixed(2)}`,
    );
    console.log(`  单点 TOP1: direction=${top1.recipe.directionMode}, window=${top1.recipe.dataWindow}, edge=${top1.recipe.edgeLookback}`);
    console.log(`  平均参数: direction=${ens.directionMode}, window=${ens.dataWindow}, edge=${ens.edgeLookback}, maxHold=${ens.maxHoldDays}`);
    console.log('');
  }

  return result;
}

// ===== P0-1：板块差异化搜索先验 =====
const STAR_SECTORS: Record<string, string> = {
  CF0: '农产品',
  CU0: '有色',
  HC0: '黑色',
};

/** 读取板块共识并生成搜索先验（每个参数取占比最高的取值） */
function runSectorPriors(): Record<string, Record<string, string>> {
  console.log('\n=== P0-1 板块差异化搜索先验 ===\n');

  const miningFile = path.join(DATA_DIR, 'parameterSpaceMining.json');
  const mining = JSON.parse(fs.readFileSync(miningFile, 'utf8')) as {
    sectorConsensus: Record<string, Record<string, Record<string, number>>>;
  };

  const priors: Record<string, Record<string, string>> = {};

  for (const [sector, params] of Object.entries(mining.sectorConsensus)) {
    const prior: Record<string, string> = {};
    for (const [pname, dist] of Object.entries(params)) {
      if (!dist || typeof dist !== 'object') continue;
      // 找占比最高的取值
      let bestVal = '';
      let bestRatio = -1;
      for (const [val, ratio] of Object.entries(dist)) {
        const r = typeof ratio === 'number' ? ratio : 0;
        if (r > bestRatio) {
          bestRatio = r;
          bestVal = val;
        }
      }
      if (bestRatio > 0.4) prior[pname] = bestVal;
    }
    priors[sector] = prior;
    const summary = Object.entries(prior)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    console.log(`【${sector}】${summary}`);
  }

  return priors;
}

// ===== 主流程 =====
function main() {
  const ensemble = runEnsemble();
  const priors = runSectorPriors();

  // 输出 JSON（合并 P0-2 与 P0-1）
  const outFile = path.join(DATA_DIR, 'starEnsembleParams.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        topN: TOP_N,
        starSectors: STAR_SECTORS,
        stars: ensemble,
        sectorSearchPriors: priors,
      },
      null,
      2,
    ),
  );
  console.log(`\n✅ 已写入 ${outFile}`);
}

main();
