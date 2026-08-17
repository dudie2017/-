/**
 * P5-b 品种入池漏斗（Variety Entry Funnel）
 *
 * 综合所有分析维度，建立最终的品种入池/淘汰标准：
 *
 * 漏斗层级：
 * L0: 全部 59 品种
 * L1: 三重筛选通过（样本内稳健率≥25% + 跨窗口稳健率≥60% + 有效窗口≥3）
 * L2: 成本稳健（1.5x 费率下 Calmar > 0）
 * L3: Regime 稳健（至少 2 个 Regime 盈利）
 * L4: 跳空风险非极高
 * L5: 尾部风险可控（CVaR 尾比 < 50）
 *
 * 最终输出：
 * - 入池品种 + 推荐权重（风险平价）
 * - 观察池品种（部分条件不满足）
 * - 淘汰品种 + 淘汰原因
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

function loadJSON(filename: string): any {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) return null;
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

interface FunnelResult {
  code: string;
  grade: string;
  layers: {
    L0_all: boolean;
    L1_tripleFilter: boolean;
    L2_costRobust: boolean;
    L3_regimeRobust: boolean;
    L4_jumpSafe: boolean;
    L5_tailSafe: boolean;
  };
  finalVerdict: 'entry' | 'watchlist' | 'eliminated';
  eliminationReason?: string;
  recommendation?: {
    weight: number;
    riskParityWeight: number;
  };
}

function main() {
  console.log('=== P5-b 品种入池漏斗 ===\n');

  // 加载所有分析数据
  const rescore = loadJSON('rescoreReport.json');
  const costAnalysis = loadJSON('costSensitivityAnalysis.json');
  const regimeAnalysis = loadJSON('volatilityRegimeAnalysis.json');
  const gapAnalysis = loadJSON('gapRiskAnalysis.json');
  const tailRisk = loadJSON('tailRiskCVaR.json');
  const riskParity = loadJSON('riskParityPortfolio.json');
  const corrAnalysis = loadJSON('portfolioCorrelation.json');

  // 三重筛选通过品种
  const triplePass = new Set<string>();
  if (rescore?.triplePass) {
    for (const v of rescore.triplePass) triplePass.add(v.code || v);
  }
  // 硬编码已知的三重筛选通过品种
  for (const c of ['CF0', 'CU0', 'HC0']) triplePass.add(c);

  // 成本淘汰品种
  const costDead = new Set<string>();
  if (costAnalysis?.dead) {
    for (const v of costAnalysis.dead) costDead.add(v.code);
  }

  // Regime 稳健品种（至少 2 个 Regime 盈利）
  const regimeRobust = new Set<string>();
  if (regimeAnalysis?.details) {
    for (const d of regimeAnalysis.details) {
      const profitableCount = [d.regimes.low, d.regimes.mid, d.regimes.high]
        .filter((r: any) => r.totalPnl > 0 && r.calmar > 0).length;
      if (profitableCount >= 2) regimeRobust.add(d.code);
    }
  }

  // 跳空风险非极高
  const jumpSafe = new Set<string>();
  if (gapAnalysis?.all) {
    for (const d of gapAnalysis.all) {
      if (d.riskLevel !== '极高') jumpSafe.add(d.code);
    }
  } else {
    // 如果没有 gapAnalysis，从 costAnalysis 获取品种列表
    for (const d of (costAnalysis?.details || [])) {
      jumpSafe.add(d.code);
    }
  }

  // 尾部风险可控（尾比 < 50）
  const tailSafe = new Set<string>();
  if (tailRisk?.details) {
    for (const d of tailRisk.details) {
      if (d.tailRatio5 < 50) tailSafe.add(d.code);
    }
  }

  // 风险平价权重
  const rpWeights = new Map<string, number>();
  if (riskParity?.weights?.riskParity) {
    for (const [code, weight] of Object.entries(riskParity.weights.riskParity)) {
      rpWeights.set(code, weight as number);
    }
  }

  // 品种列表：从 costAnalysis 获取完整品种列表
  const allVarietyCodes = costAnalysis?.details?.map((d: any) => d.code) || [];
  if (allVarietyCodes.length === 0) {
    console.error('无法获取品种列表');
    return;
  }

  const results: FunnelResult[] = [];

  for (const code of allVarietyCodes) {
    const grade = costAnalysis?.details?.find((d: any) => d.code === code)?.grade || '?';

    const L0 = true;
    const L1 = triplePass.has(code);
    const L2 = !costDead.has(code);
    const L3 = regimeRobust.has(code);
    const L4 = jumpSafe.has(code);
    const L5 = tailSafe.has(code);

    let finalVerdict: 'entry' | 'watchlist' | 'eliminated';
    let eliminationReason: string | undefined;

    if (L1 && L2 && L3 && L4 && L5) {
      finalVerdict = 'entry';
    } else if (L2 && L3) {
      // 成本稳健 + Regime 稳健，但未通过三重筛选或尾部/跳空有问题
      finalVerdict = 'watchlist';
      const reasons: string[] = [];
      if (!L1) reasons.push('未通过三重筛选');
      if (!L4) reasons.push('跳空风险极高');
      if (!L5) reasons.push('尾部风险过高');
      eliminationReason = reasons.join('; ');
    } else {
      finalVerdict = 'eliminated';
      const reasons: string[] = [];
      if (!L2) reasons.push('成本敏感（费率压力下亏损）');
      if (!L3) reasons.push('Regime 依赖（仅单一波动环境盈利）');
      eliminationReason = reasons.join('; ');
    }

    results.push({
      code,
      grade,
      layers: { L0_all: L0, L1_tripleFilter: L1, L2_costRobust: L2, L3_regimeRobust: L3, L4_jumpSafe: L4, L5_tailSafe: L5 },
      finalVerdict,
      eliminationReason,
      recommendation: finalVerdict === 'entry' ? {
        weight: rpWeights.get(code) || 0,
        riskParityWeight: rpWeights.get(code) || 0,
      } : undefined,
    });
  }

  // 统计
  const entry = results.filter(r => r.finalVerdict === 'entry');
  const watchlist = results.filter(r => r.finalVerdict === 'watchlist');
  const eliminated = results.filter(r => r.finalVerdict === 'eliminated');

  console.log('=== 漏斗结果 ===');
  console.log(`L0 全部品种: ${results.length}`);
  console.log(`L1 三重筛选通过: ${results.filter(r => r.layers.L1_tripleFilter).length}`);
  console.log(`L2 成本稳健: ${results.filter(r => r.layers.L2_costRobust).length}`);
  console.log(`L3 Regime 稳健: ${results.filter(r => r.layers.L3_regimeRobust).length}`);
  console.log(`L4 跳空安全: ${results.filter(r => r.layers.L4_jumpSafe).length}`);
  console.log(`L5 尾部可控: ${results.filter(r => r.layers.L5_tailSafe).length}`);
  console.log(`\n最终入池: ${entry.length}`);
  console.log(`观察池: ${watchlist.length}`);
  console.log(`淘汰: ${eliminated.length}`);

  console.log('\n=== 入池品种 ===');
  for (const r of entry.sort((a, b) => (b.recommendation?.weight || 0) - (a.recommendation?.weight || 0))) {
    console.log(`  ✅ ${r.code.padEnd(5)} [${r.grade}] 风险平价权重: ${((r.recommendation?.weight || 0) * 100).toFixed(1)}%`);
  }

  console.log('\n=== 观察池品种 ===');
  for (const r of watchlist) {
    console.log(`  🔶 ${r.code.padEnd(5)} [${r.grade}] 原因: ${r.eliminationReason}`);
  }

  console.log('\n=== 淘汰品种 ===');
  for (const r of eliminated) {
    console.log(`  ❌ ${r.code.padEnd(5)} [${r.grade}] 原因: ${r.eliminationReason}`);
  }

  // 输出 JSON
  const outputPath = path.join(DATA_DIR, 'varietyEntryFunnel.json');
  const output = {
    generatedAt: new Date().toISOString(),
    funnelSummary: {
      L0_total: results.length,
      L1_tripleFilter: results.filter(r => r.layers.L1_tripleFilter).length,
      L2_costRobust: results.filter(r => r.layers.L2_costRobust).length,
      L3_regimeRobust: results.filter(r => r.layers.L3_regimeRobust).length,
      L4_jumpSafe: results.filter(r => r.layers.L4_jumpSafe).length,
      L5_tailSafe: results.filter(r => r.layers.L5_tailSafe).length,
      finalEntry: entry.length,
      finalWatchlist: watchlist.length,
      finalEliminated: eliminated.length,
    },
    entry: entry.map(r => ({
      code: r.code,
      grade: r.grade,
      weight: r.recommendation?.weight || 0,
    })),
    watchlist: watchlist.map(r => ({
      code: r.code,
      grade: r.grade,
      reason: r.eliminationReason,
    })),
    eliminated: eliminated.map(r => ({
      code: r.code,
      grade: r.grade,
      reason: r.eliminationReason,
    })),
    details: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n已落盘: ${outputPath}`);
}

main();
