/**
 * P3 参数敏感性分析（Parameter Sensitivity Analysis）
 *
 * 对 6 个稳健品种的 TOP1 配方，逐维度做扰动测试：
 * - 数值参数：±20% 扰动
 * - 布尔/枚举参数：翻转所有可选值
 *
 * 判定标准：
 * - 稳健（Robust）：所有扰动变体仍盈利，且收益退化 < 50%
 * - 敏感（Sensitive）：部分扰动导致收益大幅退化（>50%）或亏损
 * - 过拟合（Overfit）：翻转某个参数就导致亏损
 */
import fs from 'fs';
import path from 'path';
import { loadBars, computeTheoreticalMax, runTop1Backtest, calcStats } from './runTop1FullBacktest';
import type { Stats } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import type { UnifiedRecipe } from '../data/top1UnifiedParams';

const CODES = ['CF0', 'AL0', 'RB0', 'SC0', 'NI0', 'IM0'];

/** 数值参数的扰动配置 */
interface NumericPerturbation {
  key: keyof UnifiedRecipe;
  label: string;
  perturb: (val: number) => number[];  // 返回多个扰动值
}

const NUMERIC_PERTURBATIONS: NumericPerturbation[] = [
  { key: 'stopAtrMult', label: '止损ATR倍数', perturb: (v) => [+(v * 0.8).toFixed(2), +(v * 1.2).toFixed(2)] },
  { key: 'targetAtrMult', label: '止盈ATR倍数', perturb: (v) => [+(v * 0.8).toFixed(2), +(v * 1.2).toFixed(2)] },
  { key: 'maxHoldDays', label: '最大持仓天数', perturb: (v) => [Math.max(5, Math.round(v * 0.8)), Math.round(v * 1.2)] },
  { key: 'minRR', label: '最小风险收益比', perturb: (v) => [+(v * 0.8).toFixed(2), +(v * 1.2).toFixed(2)] },
  { key: 'edgeLookback', label: '信号回看窗口', perturb: (v) => [Math.max(20, Math.round(v * 0.8)), Math.round(v * 1.2)] },
  { key: 'pThreshold', label: '概率阈值', perturb: (v) => [Math.max(0.3, +(v - 0.1).toFixed(2)), Math.min(0.8, +(v + 0.1).toFixed(2))] },
  { key: 'cooldownBars', label: '冷却K线数', perturb: (v) => [Math.max(0, v - 1), v + 1] },
  { key: 'maxPositionPct', label: '最大仓位比例', perturb: (v) => [Math.max(0.05, +(v * 0.8).toFixed(3)), Math.min(0.5, +(v * 1.2).toFixed(3))] },
];

/** 枚举参数翻转配置 */
interface EnumPerturbation {
  key: keyof UnifiedRecipe;
  label: string;
  alternatives: any[];
}

const ENUM_PERTURBATIONS: EnumPerturbation[] = [
  { key: 'trendFilter', label: '趋势过滤', alternatives: [true, false] },
  { key: 'equationMode', label: '方程模式', alternatives: ['strict', 'soft', 'off'] },
  { key: 'minSignalGrade', label: '最低信号等级', alternatives: ['L1', 'L2', 'L3'] },
  { key: 'bsMode', label: 'BS模式', alternatives: ['none', 'riskOff', 'full'] },
];

function cloneRecipe(r: UnifiedRecipe): UnifiedRecipe {
  return { ...r };
}

interface SensitivityResult {
  code: string;
  baseline: {
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    winRate: number;
    totalTrades: number;
  };
  perturbations: {
    param: string;
    label: string;
    value: any;
    originalValue: any;
    type: 'numeric' | 'enum';
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    winRate: number;
    totalTrades: number;
    pnlChangePct: number;  // 相对 baseline 的变化百分比
    verdict: 'robust' | 'sensitive' | 'overfit';
  }[];
  summary: {
    robustCount: number;
    sensitiveCount: number;
    overfitCount: number;
    mostSensitiveParam: string;
    overallVerdict: 'robust' | 'sensitive' | 'overfit';
  };
}

async function runOne(code: string, recipe: UnifiedRecipe, bars: any[], theo: any): Promise<Stats> {
  const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');
  return calcStats(trades, theo.longReturn, theo.shortReturn, recipe.startCapital);
}

async function main() {
  const results: SensitivityResult[] = [];

  for (const code of CODES) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`${code} 参数敏感性分析`);
    console.log('='.repeat(50));

    const recipe = TOP1_UNIFIED_PARAMS[code];
    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);

    // Baseline
    const baseStats = await runOne(code, recipe, bars, theo);
    console.log(`  Baseline: 收益 ${baseStats.totalPnl.toFixed(0)} | 回撤 ${(baseStats.maxDrawdown * 100).toFixed(1)}% | PF ${baseStats.profitFactor.toFixed(2)} | 交易 ${baseStats.totalTrades}`);

    const perturbations: SensitivityResult['perturbations'] = [];

    // Numeric perturbations
    for (const p of NUMERIC_PERTURBATIONS) {
      const originalVal = recipe[p.key] as number;
      const variants = p.perturb(originalVal);

      for (const v of variants) {
        const r = cloneRecipe(recipe);
        (r as any)[p.key] = v;
        const stats = await runOne(code, r, bars, theo);
        const changePct = baseStats.totalPnl !== 0
          ? (stats.totalPnl - baseStats.totalPnl) / Math.abs(baseStats.totalPnl) * 100
          : (stats.totalPnl > 0 ? 100 : stats.totalPnl < 0 ? -100 : 0);

        let verdict: 'robust' | 'sensitive' | 'overfit';
        if (stats.totalPnl < 0) {
          verdict = 'overfit';
        } else if (Math.abs(changePct) > 50) {
          verdict = 'sensitive';
        } else {
          verdict = 'robust';
        }

        const direction = v < originalVal ? '-' : '+';
        perturbations.push({
          param: p.key,
          label: p.label,
          value: v,
          originalValue: originalVal,
          type: 'numeric',
          totalPnl: stats.totalPnl,
          maxDrawdown: stats.maxDrawdown,
          profitFactor: stats.profitFactor,
          winRate: stats.winRate,
          totalTrades: stats.totalTrades,
          pnlChangePct: +changePct.toFixed(1),
          verdict,
        });

        if (verdict !== 'robust') {
          console.log(`  ⚠ ${p.label}(${p.key}) ${direction}20% → ${v}: 收益 ${stats.totalPnl.toFixed(0)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%) [${verdict}]`);
        }
      }
    }

    // Enum perturbations
    for (const p of ENUM_PERTURBATIONS) {
      const originalVal = recipe[p.key];

      for (const v of p.alternatives) {
        if (v === originalVal) continue;  // 跳过原始值
        const r = cloneRecipe(recipe);
        (r as any)[p.key] = v;
        const stats = await runOne(code, r, bars, theo);
        const changePct = baseStats.totalPnl !== 0
          ? (stats.totalPnl - baseStats.totalPnl) / Math.abs(baseStats.totalPnl) * 100
          : (stats.totalPnl > 0 ? 100 : stats.totalPnl < 0 ? -100 : 0);

        let verdict: 'robust' | 'sensitive' | 'overfit';
        if (stats.totalPnl < 0) {
          verdict = 'overfit';
        } else if (Math.abs(changePct) > 50) {
          verdict = 'sensitive';
        } else {
          verdict = 'robust';
        }

        perturbations.push({
          param: p.key,
          label: p.label,
          value: v,
          originalValue: originalVal,
          type: 'enum',
          totalPnl: stats.totalPnl,
          maxDrawdown: stats.maxDrawdown,
          profitFactor: stats.profitFactor,
          winRate: stats.winRate,
          totalTrades: stats.totalTrades,
          pnlChangePct: +changePct.toFixed(1),
          verdict,
        });

        if (verdict !== 'robust') {
          console.log(`  ⚠ ${p.label}(${p.key}) ${String(originalVal)}→${String(v)}: 收益 ${stats.totalPnl.toFixed(0)} (${changePct > 0 ? '+' : ''}${changePct.toFixed(1)}%) [${verdict}]`);
        }
      }
    }

    // Summary
    const robustCount = perturbations.filter((p) => p.verdict === 'robust').length;
    const sensitiveCount = perturbations.filter((p) => p.verdict === 'sensitive').length;
    const overfitCount = perturbations.filter((p) => p.verdict === 'overfit').length;

    // 最敏感参数：按平均 |changePct| 排序
    const paramAvgAbs = new Map<string, number[]>();
    for (const p of perturbations) {
      if (!paramAvgAbs.has(p.param)) paramAvgAbs.set(p.param, []);
      paramAvgAbs.get(p.param)!.push(Math.abs(p.pnlChangePct));
    }
    let mostSensitive = '';
    let maxAvg = 0;
    for (const [param, vals] of paramAvgAbs) {
      const avg = vals.reduce((s, v) => s + v, 0) / vals.length;
      if (avg > maxAvg) { maxAvg = avg; mostSensitive = param; }
    }

    const overallVerdict: 'robust' | 'sensitive' | 'overfit' =
      overfitCount > 0 ? 'overfit' : sensitiveCount > 3 ? 'sensitive' : 'robust';

    const summary = { robustCount, sensitiveCount, overfitCount, mostSensitiveParam: mostSensitive, overallVerdict };

    console.log(`\n  汇总: 稳健 ${robustCount} | 敏感 ${sensitiveCount} | 过拟合 ${overfitCount} | 最敏感: ${mostSensitive} | 总评: ${overallVerdict}`);

    results.push({
      code,
      baseline: {
        totalPnl: baseStats.totalPnl,
        maxDrawdown: baseStats.maxDrawdown,
        profitFactor: baseStats.profitFactor,
        winRate: baseStats.winRate,
        totalTrades: baseStats.totalTrades,
      },
      perturbations,
      summary,
    });
  }

  // 输出 JSON
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outPath = path.join(process.cwd(), 'backtest-results', `parameter-sensitivity-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n\n已输出: ${outPath}`);

  // 总评
  console.log('\n' + '='.repeat(60));
  console.log('P3 参数敏感性分析 — 总评');
  console.log('='.repeat(60));
  for (const r of results) {
    const icon = r.summary.overallVerdict === 'robust' ? '✅' : r.summary.overallVerdict === 'sensitive' ? '⚠️' : '❌';
    console.log(`  ${icon} ${r.code}: ${r.summary.overallVerdict} (稳健${r.summary.robustCount} 敏感${r.summary.sensitiveCount} 过拟合${r.summary.overfitCount}) 最敏感: ${r.summary.mostSensitiveParam}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
