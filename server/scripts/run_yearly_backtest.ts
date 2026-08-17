/**
 * C1: 按年回测 — 检验策略穿越牛熊能力
 *
 * 将 30min 数据按年份切分为 2022/2023/2024/2025/2026 五段，
 * 分别跑回测，对比各年表现。
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from '../src/services/backtestEngine.js';
import { VARIETIES, GROUP_NAMES } from '../src/services/varieties.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(__dirname, '..', 'data-cache-30m-long');
const WHITELIST = Object.keys(VARIETIES);

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

const BASE_CONFIG = {
  startCapital: 500_000,
  maxPositionPct: 0.15,
  minSignalGrade: 'L3' as const,
  maxHoldDays: 70,
  warmupBars: 120,
  cooldownBars: 28,
  returnAllTrades: true,
  suppressCounterTrend: true,
};

const YEARS = [2022, 2023, 2024, 2025, 2026];

async function main() {
  console.log('=== C1: 按年回测分析 ===\n');

  // Pre-load all data
  const allData: Record<string, Bar[]> = {};
  for (const code of WHITELIST) {
    const file = path.join(CACHE, code + '.json');
    if (fs.existsSync(file)) {
      allData[code] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    }
  }
  console.log(`Loaded data for ${Object.keys(allData).length} varieties\n`);

  const yearResults: Record<number, any> = {};

  for (const year of YEARS) {
    console.log(`--- ${year} ---`);

    // Filter bars to this year
    const yearData: Record<string, Bar[]> = {};
    let totalBars = 0;
    for (const [code, bars] of Object.entries(allData)) {
      const filtered = bars.filter(b => b.date.startsWith(String(year)));
      if (filtered.length >= 50) {
        yearData[code] = filtered;
        totalBars += filtered.length;
      }
    }

    const codes = Object.keys(yearData);
    console.log(`${codes.length} varieties, ${totalBars.toLocaleString()} bars`);

    if (codes.length < 10) {
      console.log(`  SKIP: too few varieties`);
      continue;
    }

    // Write temp cache
    const tmpDir = path.join('/tmp', `cache-30m-${year}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    for (const [code, bars] of Object.entries(yearData)) {
      fs.writeFileSync(path.join(tmpDir, code + '.json'), JSON.stringify(bars));
    }

    const result = await runBacktest({
      ...BASE_CONFIG,
      dataDir: tmpDir,
      codes,
      returnAllTrades: true,  // need trades for direction split
    });

    // Direction split stats
    const longTrades = result.trades.filter((t: any) => t.direction === 'LONG');
    const shortTrades = result.trades.filter((t: any) => t.direction === 'SHORT');
    const makeDirStats = (trades: any[]) => {
      const wins = trades.filter((t: any) => t.pnl > 0);
      const losses = trades.filter((t: any) => t.pnl <= 0);
      const totalPnl = trades.reduce((s: number, t: any) => s + t.pnl, 0);
      return {
        trades: trades.length,
        wins: wins.length,
        losses: losses.length,
        winRate: trades.length > 0 ? wins.length / trades.length : 0,
        pf: losses.length > 0 ? Math.abs(wins.reduce((s: number, t: any) => s + t.pnl, 0) / Math.abs(losses.reduce((s: number, t: any) => s + t.pnl, 0))) : trades.length,
        totalPnl: Math.round(totalPnl),
      };
    };

    yearResults[year] = {
      summary: result.summary,
      codes,
      totalBars,
      long: makeDirStats(longTrades),
      short: makeDirStats(shortTrades),
    };

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`  Trades: ${result.summary.totalTrades} | WR: ${(result.summary.winRate * 100).toFixed(1)}% | Return: ${(result.summary.totalReturn * 100).toFixed(0)}% | PF: ${result.summary.profitFactor.toFixed(2)} | Sharpe: ${result.summary.sharpeRatio.toFixed(2)} | DD: ${(result.summary.maxDrawdown * 100).toFixed(1)}%`);
    const ls = yearResults[year].long;
    const ss = yearResults[year].short;
    console.log(`    LONG: ${ls.trades}笔 WR:${(ls.winRate*100).toFixed(1)}% PF:${ls.pf.toFixed(2)} PnL:¥${ls.totalPnl.toLocaleString()} | SHORT: ${ss.trades}笔 WR:${(ss.winRate*100).toFixed(1)}% PF:${ss.pf.toFixed(2)} PnL:¥${ss.totalPnl.toLocaleString()}\n`);
  }

  // Summary table
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║              历年回测对比总览                              ║');
  console.log('╠══════╦════════╦═══════╦════════╦══════╦════════╦══════════╣');
  console.log('║ 年份 ║ 品种   ║ 交易  ║ 胜率   ║ PF   ║ 收益   ║ 夏普     ║');
  console.log('╠══════╬════════╬═══════╬════════╬══════╬════════╬══════════╣');
  for (const year of YEARS) {
    const r = yearResults[year];
    if (!r) continue;
    const s = r.summary;
    console.log(`║ ${year} ║ ${String(r.codes.length).padStart(5)}  ║ ${String(s.totalTrades).padStart(5)} ║ ${(s.winRate * 100).toFixed(1).padStart(5)}% ║ ${s.profitFactor.toFixed(2).padStart(4)} ║ ${(s.totalReturn * 100).toFixed(0).padStart(5)}% ║ ${s.sharpeRatio.toFixed(2).padStart(7)} ║`);
  }

  // All-years combined
  console.log('╚══════╩════════╩═══════╩════════╩══════╩════════╩══════════╝');

  // Market context
  console.log('\n=== 市场背景（同期文华商品指数） ===');
  const marketContext: Record<number, string> = {
    2022: '上半年延续牛市，6月后暴跌（美联储加息），全年 -15%',
    2023: '震荡反弹年，区间波动，全年 +5%',
    2024: '震荡上行，供给端驱动，全年 +12%',
    2025: '牛市延续，地缘溢价，全年 +18%',
    2026: '高位震荡，年初冲高后回落，H1 +3%',
  };
  for (const year of YEARS) {
    if (yearResults[year]) {
      const s = yearResults[year].summary;
      const ret = s.totalReturn * 100;
      const status = ret > 50 ? '🔥' : ret > 15 ? '✅' : ret > 0 ? '🟢' : '🔴';
      console.log(`${status} ${year}: ${marketContext[year]}`);
      console.log(`   策略: ${ret.toFixed(0)}% | PF:${s.profitFactor.toFixed(2)} | WR:${(s.winRate*100).toFixed(1)}%`);
    }
  }

  // Save results
  const outPath = '/tmp/bt_yearly.json';
  fs.writeFileSync(outPath, JSON.stringify(yearResults));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
