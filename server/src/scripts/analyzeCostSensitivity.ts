/**
 * P3-a 交易成本敏感性分析（Cost Sensitivity Analysis）
 *
 * 对全部 59 品种的 TOP1 参数回测，施加不同成本压力：
 * - 基准：feeMult=1（原始回测费率）
 * - 压力档：1.5x / 2x / 3x / 5x（相对基准费率的倍数）
 *
 * 核心指标：
 * - 净卡玛比率（Calmar = 净收益 / 最大回撤）
 * - 成本敏感度 = (基准Calmar - 压力Calmar) / 基准Calmar
 * - 盈亏平衡费率倍数（Calmar 降到 0 时的费率倍数）
 *
 * 判定：
 * - 稳健：3x 费率下仍为正 Calmar
 * - 脆弱：2x 费率下 Calmar 为负
 * - 淘汰：1.5x 费率下即为负
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadBars, computeTheoreticalMax, runTop1Backtest } from './runTop1FullBacktest';
import type { TradeLike } from './runTop1FullBacktest';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../data');

// 合约乘数（与 backtestEngine / runTop1FullBacktest 一致）
const CONTRACT_MULTIPLIER: Record<string, number> = {
  IC0: 200, IF0: 300, IH0: 300, IM0: 200,
  RB0: 10, I0: 100, JM0: 60, J0: 100, HC0: 10, SP0: 10,
  CU0: 5, AL0: 5, ZN0: 5, PB0: 5, NI0: 1, SC0: 1000, AU0: 1000, AG0: 15,
  RU0: 10, FU0: 10, BU0: 10, EG0: 10, EB0: 5, FG0: 20, MA0: 10, PP0: 5, V0: 5, PG0: 20, LU0: 10,
  M0: 10, Y0: 10, CF0: 5, SR0: 10, A0: 10, C0: 10, JD0: 5, AP0: 10, CJ0: 5, RM0: 10, OI0: 20,
  LH0: 16, SI0: 5, TA0: 5, P0: 10,
};

function getMultiplier(code: string): number {
  return CONTRACT_MULTIPLIER[code] || 10;
}

/** 对 trades 施加额外费率压力（在已有费率基础上乘以 mult） */
function applyFeeStress(trades: TradeLike[], code: string, feeMultiplier: number): TradeLike[] {
  if (feeMultiplier === 1) return trades;
  const multiplier = getMultiplier(code);
  return trades.map((t) => {
    const contractValue = Math.abs(t.entryPrice) * multiplier;
    // 基准手续费：万分之1.5 单边，双边 = 万分之3
    const baseFee = contractValue * 0.00015 * 2;
    // 额外费用 = baseFee * (mult - 1)
    const extraFee = baseFee * (feeMultiplier - 1);
    return { ...t, pnl: t.pnl - extraFee };
  });
}

/** 计算权益曲线统计 */
function calcEquityStats(trades: TradeLike[], capital: number) {
  const sorted = [...trades].sort((a, b) => a.exitDate.localeCompare(b.exitDate));
  let equity = capital;
  let peak = capital;
  let mdd = 0;
  const monthlyPnl = new Map<string, number>();

  for (const t of sorted) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = peak === 0 ? 0 : (peak - equity) / peak;
    if (dd > mdd) mdd = dd;

    const month = t.exitDate.slice(0, 7);
    monthlyPnl.set(month, (monthlyPnl.get(month) || 0) + t.pnl);
  }

  const totalPnl = equity - capital;
  const totalReturn = totalPnl / capital;
  const calmar = mdd === 0 ? (totalPnl > 0 ? 999 : 0) : totalPnl / (mdd * capital);

  return { totalPnl, totalReturn, mdd, calmar, totalTrades: trades.length };
}

/** 估算每笔交易的基准手续费 */
function estimateBaseFee(trades: TradeLike[], code: string): number {
  const multiplier = getMultiplier(code);
  let totalFee = 0;
  for (const t of trades) {
    const contractValue = Math.abs(t.entryPrice) * multiplier;
    totalFee += contractValue * 0.00015 * 2;
  }
  return totalFee;
}

interface VarietyCostResult {
  code: string;
  grade: string;
  baselineFeeMult: number;
  baseline: { totalPnl: number; mdd: number; calmar: number; totalTrades: number; estBaseFee: number; feePctOfPnl: number };
  stressLevels: {
    multiplier: number;
    totalPnl: number;
    mdd: number;
    calmar: number;
    calmarChangePct: number;
    verdict: 'survive' | 'fragile' | 'dead';
  }[];
  breakPoint: string;
  costSensitivity: number; // 0-1, 越高越敏感
  overallVerdict: 'robust' | 'fragile' | 'dead';
}

async function main() {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS);
  console.log(`=== P3-a 交易成本敏感性分析 (${codes.length} 品种) ===\n`);

  const results: VarietyCostResult[] = [];

  for (const code of codes) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    if (!recipe) continue;

    const bars = loadBars(code);
    const theo = computeTheoreticalMax(bars, 3);
    const capital = recipe.startCapital;

    // 跑 baseline 回测
    const { trades: baselineTrades } = await runTop1Backtest(code, recipe, bars, theo, 'full');

    if (baselineTrades.length === 0) {
      results.push({
        code,
        grade: recipe.minSignalGrade || '?',
        baselineFeeMult: recipe.feeMult,
        baseline: { totalPnl: 0, mdd: 0, calmar: 0, totalTrades: 0, estBaseFee: 0, feePctOfPnl: 0 },
        stressLevels: [],
        breakPoint: 'N/A',
        costSensitivity: 0,
        overallVerdict: 'dead',
      });
      continue;
    }

    const baselineStats = calcEquityStats(baselineTrades, capital);
    const estBaseFee = estimateBaseFee(baselineTrades, code);
    const feePctOfPnl = baselineStats.totalPnl !== 0 ? estBaseFee / Math.abs(baselineStats.totalPnl) : 0;

    // 费率压力测试
    const feeMultipliers = [1, 1.5, 2, 3, 5];
    const stressLevels: VarietyCostResult['stressLevels'] = [];

    for (const mult of feeMultipliers) {
      const stressedTrades = applyFeeStress(baselineTrades, code, mult);
      const stats = calcEquityStats(stressedTrades, capital);
      const calmarChangePct = baselineStats.calmar !== 0
        ? (stats.calmar - baselineStats.calmar) / Math.abs(baselineStats.calmar) * 100
        : 0;

      let verdict: 'survive' | 'fragile' | 'dead';
      if (stats.calmar < 0) {
        verdict = 'dead';
      } else if (mult >= 2 && calmarChangePct < -50) {
        verdict = 'fragile';
      } else {
        verdict = 'survive';
      }

      stressLevels.push({
        multiplier: mult,
        totalPnl: stats.totalPnl,
        mdd: stats.mdd,
        calmar: stats.calmar,
        calmarChangePct: +calmarChangePct.toFixed(1),
        verdict,
      });
    }

    // 找盈亏平衡点
    let breakPoint = '>5x';
    for (const s of stressLevels) {
      if (s.calmar < 0) { breakPoint = `${s.multiplier}x`; break; }
    }

    // 成本敏感度：3x 费率下 Calmar 下降比例
    const calmar3x = stressLevels.find(s => s.multiplier === 3)?.calmar ?? 0;
    const costSensitivity = baselineStats.calmar > 0
      ? Math.max(0, Math.min(1, (baselineStats.calmar - calmar3x) / baselineStats.calmar))
      : 1;

    const hasDead3x = stressLevels.find(s => s.multiplier === 3)?.verdict === 'dead';
    const hasDead2x = stressLevels.find(s => s.multiplier === 2)?.verdict === 'dead';
    const hasDead15x = stressLevels.find(s => s.multiplier === 1.5)?.verdict === 'dead';

    let overallVerdict: 'robust' | 'fragile' | 'dead';
    if (hasDead15x) overallVerdict = 'dead';
    else if (hasDead2x || hasDead3x) overallVerdict = 'fragile';
    else overallVerdict = 'robust';

    results.push({
      code,
      grade: recipe.minSignalGrade || '?',
      baselineFeeMult: recipe.feeMult,
      baseline: {
        totalPnl: baselineStats.totalPnl,
        mdd: baselineStats.mdd,
        calmar: baselineStats.calmar,
        totalTrades: baselineStats.totalTrades,
        estBaseFee,
        feePctOfPnl: +feePctOfPnl.toFixed(3),
      },
      stressLevels,
      breakPoint,
      costSensitivity: +costSensitivity.toFixed(3),
      overallVerdict,
    });

    const icon = overallVerdict === 'robust' ? '✅' : overallVerdict === 'fragile' ? '⚠️' : '❌';
    console.log(`${icon} ${code.padEnd(5)} | Calmar ${baselineStats.calmar.toFixed(2).padStart(7)} | 3x Calmar ${calmar3x.toFixed(2).padStart(7)} | 敏感 ${costSensitivity.toFixed(2)} | 平衡 ${breakPoint}`);
  }

  // 按成本敏感度排序
  results.sort((a, b) => b.costSensitivity - a.costSensitivity);

  // 统计
  const robust = results.filter(r => r.overallVerdict === 'robust');
  const fragile = results.filter(r => r.overallVerdict === 'fragile');
  const dead = results.filter(r => r.overallVerdict === 'dead');

  console.log(`\n=== 汇总 ===`);
  console.log(`稳健（3x 仍正 Calmar）: ${robust.length} 个`);
  console.log(`脆弱（2-3x 负 Calmar）: ${fragile.length} 个`);
  console.log(`淘汰（1.5x 即负 Calmar）: ${dead.length} 个`);

  // 输出 JSON
  const outputPath = path.join(DATA_DIR, 'costSensitivityAnalysis.json');
  const output = {
    generatedAt: new Date().toISOString(),
    summary: { total: results.length, robust: robust.length, fragile: fragile.length, dead: dead.length },
    robust: robust.map(r => ({ code: r.code, grade: r.grade, calmar: r.baseline.calmar, breakPoint: r.breakPoint })),
    fragile: fragile.map(r => ({ code: r.code, grade: r.grade, calmar: r.baseline.calmar, breakPoint: r.breakPoint })),
    dead: dead.map(r => ({ code: r.code, grade: r.grade, calmar: r.baseline.calmar, breakPoint: r.breakPoint })),
    details: results,
  };
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n已落盘: ${outputPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
