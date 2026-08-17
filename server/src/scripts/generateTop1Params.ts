/**
 * 从 26 个 {CODE}_1000Experiments.json 提炼 TOP1/TOP3 完整配方
 * 产出 src/data/top1UnifiedParams.ts（APP 对齐 TOP 配方的唯一参数源）
 *
 * 用法：npx tsx src/scripts/generateTop1Params.ts
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const OUT_FILE = path.join(DATA_DIR, 'top1UnifiedParams.ts');

interface Recipe { [k: string]: number | string | boolean }
interface Stats { totalTrades: number; winRate: number; totalPnl: number; maxDrawdown: number; profitFactor: number; capture: number; longCapture: number; shortCapture: number; longTrades: number; shortTrades: number; wins: number; }

const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('_1000Experiments.json')).sort();

const RECIPE_FIELDS = [
  'minSignalGrade', 'trendFilter', 'cooldownBars', 'edgeLookback', 'allowRangeTrading',
  'equationMode', 'pThreshold', 'softEquationMul', 'stopAtrMult', 'targetAtrMult',
  'maxHoldDays', 'minRR', 'maxPositionPct', 'directionMode', 'dataWindow',
  'nonGreenMul', 'counterCampMul', 'campWindow', 'bsMode', 'circuitBreaker',
  'volReduce', 'dailyLossLimit', 'feeMult', 'startCapital',
];

function q(v: string): string { return `'${v}'`; }
function fmt(v: number | string | boolean): string {
  if (typeof v === 'string') return q(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

interface Entry { recipe: Recipe; score: number; stats: Stats }

const top1: Record<string, Entry> = {};
const top3: Record<string, Entry[]> = {};

for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
  const code = d.meta?.code ?? f.split('_')[0];
  const list = (d.topComposite || []) as Entry[];
  top1[code] = list[0];
  top3[code] = list.slice(0, 3);
}

const lines: string[] = [];
lines.push('/**');
lines.push(' * 统一 TOP 配方参数（自动生成，勿手改 —— 重新生成请运行 generateTop1Params.ts）');
lines.push(' *');
lines.push(' * 来源：26 品种 1000 次 LHS 实验 topComposite（综合评分排序）');
lines.push(' * - TOP1_UNIFIED_PARAMS: 各品种 TOP1 完整配方（24 维），APP 实时引擎 + 回测引擎对齐基准');
lines.push(' * - TOP3_BACKUP:         各品种 TOP2/TOP3 备选配方，TOP1 失效时回退');
lines.push(' *');
lines.push(' * 字段语义与 1000 次实验 recipe 完全一致，含交易核心、信号判定、阵营过滤、风控、方向、数据窗口、成本。');
lines.push(' */');
lines.push('');
lines.push('export interface UnifiedRecipe {');
lines.push("  minSignalGrade: 'L1' | 'L2' | 'L3';");
lines.push('  trendFilter: boolean;');
lines.push('  cooldownBars: number;');
lines.push('  edgeLookback: number;');
lines.push('  allowRangeTrading: boolean;');
lines.push("  equationMode: 'strict' | 'soft' | 'off';");
lines.push('  pThreshold: number;');
lines.push('  softEquationMul: number;');
lines.push('  stopAtrMult: number;');
lines.push('  targetAtrMult: number;');
lines.push('  maxHoldDays: number;');
lines.push('  minRR: number;');
lines.push('  maxPositionPct: number;');
lines.push("  directionMode: 'both' | 'split' | 'longOnly' | 'shortOnly';");
lines.push("  dataWindow: 'full' | 'front70' | 'back70' | 'last2y' | 'last3y';");
lines.push('  nonGreenMul: number;');
lines.push('  counterCampMul: number;');
lines.push('  campWindow: number;');
lines.push("  bsMode: 'none' | 'riskOff' | 'full';");
lines.push("  circuitBreaker: 'off' | '3x10' | '5x20';");
lines.push("  volReduce: 'off' | 'atr15xHalf' | 'atr2xClear';");
lines.push("  dailyLossLimit: 'off' | '5pct' | '8pct';");
lines.push('  feeMult: number;');
lines.push('  startCapital: number;');
lines.push('}');
lines.push('');
lines.push('export interface TopRecipeEntry {');
lines.push('  recipe: UnifiedRecipe;');
lines.push('  score: number;');
lines.push('  stats: {');
lines.push('    totalTrades: number; winRate: number; totalPnl: number; maxDrawdown: number;');
lines.push('    profitFactor: number; capture: number; longCapture: number; shortCapture: number;');
lines.push('    longTrades: number; shortTrades: number; wins: number;');
lines.push('  };');
lines.push('}');
lines.push('');
lines.push('export const TOP1_UNIFIED_PARAMS: Record<string, UnifiedRecipe> = {');
for (const [code, e] of Object.entries(top1)) {
  lines.push(`  ${q(code)}: {`);
  for (const f of RECIPE_FIELDS) {
    const v = e.recipe[f];
    lines.push(`    ${f}: ${fmt(v)},`);
  }
  lines.push('  },');
}
lines.push('};');
lines.push('');
lines.push('export const TOP3_BACKUP: Record<string, UnifiedRecipe[]> = {');
for (const [code, list] of Object.entries(top3)) {
  lines.push(`  ${q(code)}: [`);
  for (const e of list) {
    lines.push('    {');
    for (const f of RECIPE_FIELDS) lines.push(`      ${f}: ${fmt(e.recipe[f])},`);
    lines.push('    },');
  }
  lines.push('  ],');
}
lines.push('};');
lines.push('');
lines.push('export function getTop1Recipe(code: string): UnifiedRecipe | undefined {');
lines.push('  return TOP1_UNIFIED_PARAMS[code];');
lines.push('}');
lines.push('');

fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');
console.log(`已生成 ${OUT_FILE}（${Object.keys(top1).length} 个品种 TOP1 + TOP3 备选）`);
