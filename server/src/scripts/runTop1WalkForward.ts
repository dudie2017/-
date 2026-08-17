/**
 * P1 样本外验证：Walk-forward 时间分段验证
 *
 * 思路：把每个品种的全样本按时间等分成 5 段，用 TOP1 配方跑一次全样本回测，
 * 将交易按 entryDate 分到各段，独立统计每段的收益/胜率/PF/回撤，
 * 从而判断 TOP1 配方是否跨时间段稳健（而非某段市场环境的过拟合）。
 *
 * 正确性依据：signalCache 是逐 bar 无前视偏差扫描的（每个信号只看其历史），
 * 因此全样本跑一次再按时间分段统计，与"分段独立回测"在信号层面等价。
 */
import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams';
import {
  loadBars,
  computeTheoreticalMax,
  runTop1Backtest,
  calcStats,
  type TradeLike,
  type Bar,
} from './runTop1FullBacktest';

const SEGMENTS = 5;

interface SegmentStat {
  label: string;
  startDate: string;
  endDate: string;
  trades: number;
  wins: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdown: number;
}

interface VarietyResult {
  code: string;
  directionMode: string;
  dataWindow: string;
  fullPnl: number;
  fullMdd: number;
  segments: SegmentStat[];
  profitableSegments: number;
  lastSegmentPnl: number;
  verdict: '稳健' | '中等' | '脆弱';
}

function splitSegments(bars: Bar[]): Array<{ start: string; end: string }> {
  const n = bars.length;
  const segSize = Math.ceil(n / SEGMENTS);
  const segs: Array<{ start: string; end: string }> = [];
  for (let s = 0; s < SEGMENTS; s++) {
    const startIdx = s * segSize;
    const endIdx = Math.min((s + 1) * segSize, n) - 1;
    if (startIdx >= n) break;
    segs.push({ start: bars[startIdx].date, end: bars[endIdx].date });
  }
  return segs;
}

function segLabel(s: number): string {
  return `第${s + 1}段`;
}

async function run(): Promise<void> {
  const codes = Object.keys(TOP1_UNIFIED_PARAMS).sort();
  console.log(`========== TOP1 配方 Walk-forward 分段验证（${codes.length} 品种 × ${SEGMENTS} 段） ==========`);

  const results: VarietyResult[] = [];

  for (const code of codes) {
    const recipe = TOP1_UNIFIED_PARAMS[code];
    const bars = loadBars(code);
    if (bars.length === 0) {
      console.log(`  [${code}] 无数据，跳过`);
      continue;
    }
    const theo = computeTheoreticalMax(bars, 3);
    const capital = Number(recipe.startCapital);

    const { trades } = await runTop1Backtest(code, recipe, bars, theo, 'full');

    const segs = splitSegments(bars);
    const segStats: SegmentStat[] = segs.map((seg, idx) => {
      const segTrades = trades.filter(
        (t: TradeLike) => t.entryDate >= seg.start && t.entryDate <= seg.end,
      );
      const st = calcStats(segTrades, 0, 0, capital);
      return {
        label: segLabel(idx),
        startDate: seg.start,
        endDate: seg.end,
        trades: segTrades.length,
        wins: segTrades.filter((t: TradeLike) => t.pnl > 0).length,
        winRate: st.winRate,
        totalPnl: st.totalPnl,
        profitFactor: st.profitFactor,
        maxDrawdown: st.maxDrawdown,
      };
    });

    const profitableSegments = segStats.filter((s) => s.totalPnl > 0).length;
    const lastSegmentPnl = segStats[segStats.length - 1]?.totalPnl ?? 0;
    const verdict: VarietyResult['verdict'] =
      profitableSegments >= 4 && lastSegmentPnl > 0
        ? '稳健'
        : profitableSegments >= 3
          ? '中等'
          : '脆弱';

    const fullStats = calcStats(trades, 0, 0, capital);
    results.push({
      code,
      directionMode: recipe.directionMode,
      dataWindow: String(recipe.dataWindow),
      fullPnl: fullStats.totalPnl,
      fullMdd: fullStats.maxDrawdown,
      segments: segStats,
      profitableSegments,
      lastSegmentPnl,
      verdict,
    });

    console.log(
      `  [${code}] ${verdict} | 盈利段 ${profitableSegments}/${segStats.length} | 最后段 ${lastSegmentPnl > 0 ? '+' : ''}${Math.round(lastSegmentPnl)} | 段收益: ${segStats.map((s) => Math.round(s.totalPnl)).join(', ')}`,
    );
  }

  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outPath = path.join(process.cwd(), 'backtest-results', `top1-walkforward-${ts}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ meta: { segments: SEGMENTS, generatedAt: ts }, results }, null, 2));
  console.log(`\n结果已写入: ${outPath}`);

  const robust = results.filter((r) => r.verdict === '稳健');
  const mid = results.filter((r) => r.verdict === '中等');
  const weak = results.filter((r) => r.verdict === '脆弱');
  console.log(`\n汇总: 稳健 ${robust.length} | 中等 ${mid.length} | 脆弱 ${weak.length}`);
  console.log(`稳健品种: ${robust.map((r) => r.code).join(', ') || '无'}`);
  console.log(`脆弱品种: ${weak.map((r) => r.code).join(', ') || '无'}`);
}

run().catch((e) => {
  console.error('Walk-forward 验证失败:', e);
  process.exit(1);
});
