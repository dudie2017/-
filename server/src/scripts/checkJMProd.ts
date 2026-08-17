import { loadBars } from './theoreticalMax';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';

const CODE = 'JM0';
const DATA_DIR = '/workspace/projects/server/data-cache-daily-20y';

async function main() {
  const bars = loadBars(CODE);
  const rows: any[] = [];
  for (let i = 60; i < bars.length - 2; i++) {
    rows.push(await scanV16Variety(CODE, bars.slice(0, i), CODE, { edgeLookback: 70, allowRangeTrading: true }));
  }
  const cache = new Map([[CODE, rows]]);
  const longOpt = LONG_REFINED_PARAMS[CODE];
  const shortOpt = SHORT_OPT_PARAMS[CODE];
  console.log('生产做多参数:', JSON.stringify(longOpt));
  console.log('生产做空参数:', JSON.stringify(shortOpt));

  const base = { startCapital: 500000, maxPositionPct: 0.15, minSignalGrade: 'L2', maxHoldDays: 15, stopAtrMult: 1.5, targetAtrMult: 3.0, minRR: 1.0, cooldownBars: 0, trendFilter: false, warmupBars: 60, returnAllTrades: true, quiet: true };
  const r: any = await runBacktest({ ...base, dataDir: DATA_DIR, codes: [CODE], signalCache: cache, sideParams: { long: longOpt, short: shortOpt } });
  const t = (r.trades || []) as any[];
  const wins = t.filter((x) => x.pnl > 0).length;
  const totalPnl = t.reduce((s, x) => s + (x.pnl || 0), 0);
  const grossWin = t.filter((x) => x.pnl > 0).reduce((s, x) => s + x.pnl, 0);
  const grossLoss = Math.abs(t.filter((x) => x.pnl <= 0).reduce((s, x) => s + x.pnl, 0));
  let eq = 0, peak = 0, maxDd = 0;
  for (const x of [...t].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1))) { eq += x.pnl; if (eq > peak) peak = eq; if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak); }
  console.log(`生产参数(split, 无熔断): 交易${t.length} 胜率${(wins / t.length * 100).toFixed(1)}% 收益${Math.round(totalPnl).toLocaleString()} 回撤${(maxDd * 100).toFixed(1)}% PF${(grossWin / Math.max(grossLoss, 1)).toFixed(2)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
