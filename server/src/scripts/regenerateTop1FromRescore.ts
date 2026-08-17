/**
 * 从 rescoreReport.json 重新生成 top1UnifiedParams.ts
 * 
 * 逻辑：
 * 1. 读取 rescoreReport.json（包含所有 59 个品种的新 TOP1 recipe）
 * 2. 从现有的 top1UnifiedParams.ts 里提取 code -> name 映射
 * 3. 对每个品种，从 _1000Experiments.json 里找到 recipe 匹配的完整 stats
 * 4. 生成新的 top1UnifiedParams.ts（保留类型定义，替换数据）
 */

import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src/data');

// 1. 读取 rescoreReport.json
const rescoreReport = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'rescoreReport.json'), 'utf8'));
console.log(`Loaded rescoreReport.json: ${rescoreReport.results.length} varieties`);

// 2. 从现有的 top1UnifiedParams.ts 里提取 code -> name 映射
const top1Path = path.join(DATA_DIR, 'top1UnifiedParams.ts');
const top1Content = fs.readFileSync(top1Path, 'utf8');
const nameMap: Record<string, string> = {};
const regex = /code: '(\w+)', name: '([^']+)'/g;
let match;
while ((match = regex.exec(top1Content)) !== null) {
  nameMap[match[1]] = match[2];
}
console.log(`Extracted ${Object.keys(nameMap).length} name mappings from existing top1UnifiedParams.ts`);

// 3. 对每个品种，从 _1000Experiments.json 里找到 recipe 匹配的完整 stats
const results = rescoreReport.results.map((v: any) => {
  const expFile = path.join(DATA_DIR, `${v.code}_1000Experiments.json`);
  if (!fs.existsSync(expFile)) {
    console.warn(`Warning: ${expFile} not found, skipping ${v.code}`);
    return null;
  }
  
  const expData = JSON.parse(fs.readFileSync(expFile, 'utf8'));
  
  // 找到 recipe 匹配的实验（用 JSON.stringify 比较，排序后）
  const recipeKey = JSON.stringify(v.newTop1.recipe, Object.keys(v.newTop1.recipe).sort());
  const matchedExp = expData.fullResults.find((exp: any) => {
    const expKey = JSON.stringify(exp.recipe, Object.keys(exp.recipe).sort());
    return expKey === recipeKey;
  });
  
  if (!matchedExp) {
    console.warn(`Warning: No matching experiment found for ${v.code}`);
    return null;
  }
  
  return {
    code: v.code,
    name: nameMap[v.code] || v.code,
    recipe: v.newTop1.recipe,
    stats: matchedExp.stats,
    grade: v.grade,
  };
}).filter(Boolean);

console.log(`Matched ${results.length} varieties with full stats`);

// 4. 生成 TypeScript 代码
const typeDefs = `// 自动生成的 TOP1 统一参数（基于 rescoreReport.json）
// 生成时间: ${new Date().toISOString()}
// 品种数: ${results.length}
// 分级: A=${rescoreReport.summary.A}, B=${rescoreReport.summary.B}, C=${rescoreReport.summary.C}, D=${rescoreReport.summary.D}
// 
// A 级 = 稳健底仓（稳健率≥25% 且 盈利占比≥55% 且 崩溃率<35%）
// B 级 = 可用（稳健率≥10% 且 崩溃率<50%）
// C 级 = 脆弱（崩溃率≥50% 或 稳健率<10%）
// D 级 = 失效（无稳健配方）

export interface UnifiedRecipe {
  minSignalGrade: string;
  trendFilter: boolean;
  cooldownBars: number;
  edgeLookback: number;
  allowRangeTrading: boolean;
  equationMode: string;
  pThreshold: number;
  stopAtrMult: number;
  targetAtrMult: number;
  maxHoldDays: number;
  minRR: number;
  maxPositionPct: number;
  directionMode: string;
  dataWindow: string;
  nonGreenMul: number;
  counterCampMul: number;
  campWindow: number;
  bsMode: string;
  circuitBreaker: string;
  volReduce: string;
  dailyLossLimit: string;
  softEquationMul: number;
  feeMult: number;
  startCapital: number;
}

export interface Top1Stats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  capture: number;
  longCapture?: number;
  shortCapture?: number;
  longTrades?: number;
  shortTrades?: number;
  wins?: number;
  avgRR?: number;
  longPnl?: number;
  shortPnl?: number;
}

export interface Top1Params {
  code: string;
  name: string;
  recipe: UnifiedRecipe;
  stats: Top1Stats;
  grade?: string;
}

export const top1UnifiedParams: Record<string, Top1Params> = {
`;

let dataCode = '';
for (const r of results as any[]) {
  dataCode += `  '${r.code}': {
    code: '${r.code}',
    name: '${r.name}',
    recipe: ${JSON.stringify(r.recipe, null, 4).split('\n').map((line, i) => i === 0 ? line : '    ' + line).join('\n')},
    stats: ${JSON.stringify(r.stats, null, 4).split('\n').map((line, i) => i === 0 ? line : '    ' + line).join('\n')},
    grade: '${r.grade}',
  },
`;
}

const fullCode = typeDefs + dataCode + `};

// 向后兼容导出：TOP1_UNIFIED_PARAMS（只包含 recipe）
export const TOP1_UNIFIED_PARAMS: Record<string, UnifiedRecipe> = Object.fromEntries(
  Object.entries(top1UnifiedParams).map(([code, params]) => [code, params.recipe])
);

// 向后兼容导出：TOP3_BACKUP（当前为空，后续可扩展）
export const TOP3_BACKUP: Record<string, UnifiedRecipe[]> = {};

// 获取品种 recipe 的辅助函数
export function getRecipe(code: string): UnifiedRecipe | undefined {
  return TOP1_UNIFIED_PARAMS[code];
}
`;

// 5. 写入 top1UnifiedParams.ts
fs.writeFileSync(top1Path, fullCode);

console.log(`\n✅ Generated top1UnifiedParams.ts with ${results.length} varieties`);
console.log(`Grade distribution: A=${(results as any[]).filter(r => r.grade === 'A').length}, B=${(results as any[]).filter(r => r.grade === 'B').length}, C=${(results as any[]).filter(r => r.grade === 'C').length}, D=${(results as any[]).filter(r => r.grade === 'D').length}`);
console.log(`\nA级稳健底仓: ${(results as any[]).filter(r => r.grade === 'A').map(r => r.code).join(', ')}`);
console.log(`B级可用: ${(results as any[]).filter(r => r.grade === 'B').map(r => r.code).join(', ')}`);
console.log(`D级失效: ${(results as any[]).filter(r => r.grade === 'D').map(r => r.code).join(', ')}`);
