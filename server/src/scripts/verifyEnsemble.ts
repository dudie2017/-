/**
 * verifyEnsemble.ts
 * 验证 P0-2 产出的 TOP-N 平均参数（ensemble）是否真的比单点 TOP1 更稳健。
 *
 * 复用 runTop1FullBacktest 的 loadBars / computeTheoreticalMax / runTop1Backtest，
 * 对三个明星品种（CF0/CU0/HC0）分别用 ensemble 与单点 TOP1 跑一次全样本回测，
 * 对比卡玛比率、回撤、收益、胜率、PF。
 *
 * 注意：ensemble 是 TOP-N 参数的平均值，会产生非整数（如 edgeLookback=77.5），
 * 引擎要求整数参数，因此整数参数先四舍五入后再回测。
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  loadBars,
  computeTheoreticalMax,
  runTop1Backtest,
  calcStats,
} from './runTop1FullBacktest';

const DATA_DIR = path.resolve(process.cwd(), 'src/data');
const ENSEMBLE_FILE = path.join(DATA_DIR, 'starEnsembleParams.json');

// 需要整数的参数字段（引擎内部按 bar 数 / 天数使用）
const INT_FIELDS = new Set(['cooldownBars', 'edgeLookback', 'maxHoldDays', 'campWindow']);

// 板块映射（用于展示）
const STAR_SECTORS: Record<string, string> = {
  CF0: '农产品',
  CU0: '有色',
  HC0: '黑色',
};

function roundEnsemble(recipe: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...recipe };
  for (const f of INT_FIELDS) {
    if (typeof out[f] === 'number') out[f] = Math.round(out[f]);
  }
  return out;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(ENSEMBLE_FILE, 'utf8'));
  const stars: Record<string, { ensemble: Record<string, any>; top1: Record<string, any> }> =
    data.stars;

  const report: any[] = [];

  for (const [code, star] of Object.entries(stars)) {
    const bars = loadBars(code);
    if (!bars.length) {
      console.log(`[${code}] 无数据，跳过`);
      continue;
    }
    const theo = computeTheoreticalMax(bars, 0.04);
    const ensembleRecipe = roundEnsemble(star.ensemble);
    const top1Recipe = star.top1;

    const rEns = await runTop1Backtest(code, ensembleRecipe as any, bars, theo);
    const rTop = await runTop1Backtest(code, top1Recipe as any, bars, theo);

    const capital = 500000;
    const sEns = rEns.stats;
    const sTop = rTop.stats;
    const calmar = (s: any) =>
      s.maxDrawdown > 0.001 ? (s.totalPnl / capital) / s.maxDrawdown : s.totalPnl / capital;

    const sector = STAR_SECTORS[code] || '?';
    console.log(`\n===== ${code} [${sector}] =====`);
    console.log(
      `  ensemble: 收益=${(sEns.totalPnl / 10000).toFixed(1)}万 回撤=${(sEns.maxDrawdown * 100).toFixed(1)}% 卡玛=${calmar(sEns).toFixed(2)} 胜率=${(sEns.winRate * 100).toFixed(1)}% PF=${sEns.profitFactor.toFixed(2)} 交易=${sEns.totalTrades}`
    );
    console.log(
      `  top1单点: 收益=${(sTop.totalPnl / 10000).toFixed(1)}万 回撤=${(sTop.maxDrawdown * 100).toFixed(1)}% 卡玛=${calmar(sTop).toFixed(2)} 胜率=${(sTop.winRate * 100).toFixed(1)}% PF=${sTop.profitFactor.toFixed(2)} 交易=${sTop.totalTrades}`
    );

    report.push({
      code,
      sector,
      ensemble: {
        totalPnl: +sEns.totalPnl.toFixed(2),
        maxDrawdown: +sEns.maxDrawdown.toFixed(4),
        calmar: +calmar(sEns).toFixed(2),
        winRate: +sEns.winRate.toFixed(4),
        profitFactor: +sEns.profitFactor.toFixed(4),
        totalTrades: sEns.totalTrades,
      },
      top1: {
        totalPnl: +sTop.totalPnl.toFixed(2),
        maxDrawdown: +sTop.maxDrawdown.toFixed(4),
        calmar: +calmar(sTop).toFixed(2),
        winRate: +sTop.winRate.toFixed(4),
        profitFactor: +sTop.profitFactor.toFixed(4),
        totalTrades: sTop.totalTrades,
      },
    });
  }

  const outFile = path.join(DATA_DIR, 'starEnsembleVerify.json');
  fs.writeFileSync(outFile, JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2));
  console.log(`\n已写入 ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
