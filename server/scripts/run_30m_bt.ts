import * as path from 'path';
import * as fs from 'fs';
import { runBacktest } from '../src/services/backtestEngine';

import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_30M = path.join(__dirname, '..', 'data-cache-30m-long');
const ALL_30M = fs.readdirSync(CACHE_30M).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));

(async () => {
  console.log(`[${new Date().toISOString()}] Starting 30m backtest for ${ALL_30M.length} varieties...`);
  const result = await runBacktest({
    startCapital: 500000,
    maxPositionPct: 0.15,
    minSignalGrade: 'L3',
    maxHoldDays: 70,
    warmupBars: 120,
    cooldownBars: 28,
    dataDir: CACHE_30M,
    codes: ALL_30M,
    returnAllTrades: true,
  });
  
  const byCode: Record<string, any> = {};
  for (const t of result.trades) {
    if (!byCode[t.code]) byCode[t.code] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalRR: 0 };
    byCode[t.code].trades++;
    if (t.pnl > 0) byCode[t.code].wins++; else byCode[t.code].losses++;
    byCode[t.code].totalPnl += t.pnl;
    byCode[t.code].totalRR += t.rMultiple;
  }
  
  const report = Object.entries(byCode).map(([code, stats]: [string, any]) => ({
    code,
    trades: stats.trades,
    wins: stats.wins,
    losses: stats.losses,
    winRate: stats.trades > 0 ? Math.round(stats.wins / stats.trades * 10000) / 100 : 0,
    avgRR: stats.trades > 0 ? Math.round(stats.totalRR / stats.trades * 100) / 100 : 0,
    totalPnl: Math.round(stats.totalPnl),
    profitFactor: stats.losses > 0 ? Math.round(stats.wins / Math.max(stats.losses, 1) * 100) / 100 : stats.trades,
  })).sort((a: any, b: any) => b.totalPnl - a.totalPnl);
  
  fs.writeFileSync('/tmp/bt_30m_result.json', JSON.stringify({
    summary: result.summary,
    report,
    totalVarieties: ALL_30M.length,
    profitable: report.filter((r: any) => r.totalPnl > 0).length,
  }));
  console.log(`[${new Date().toISOString()}] Done!`);
})().catch(e => { console.error(e); process.exit(1); });
