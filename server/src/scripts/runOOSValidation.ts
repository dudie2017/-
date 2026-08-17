/**
 * 样本外验证（Out-of-Sample Validation）
 * 目的：验证 20 年全量寻优出的参数（LONG/SHORT_OPT_PARAMS）在最近 2 年独立数据上是否仍有效，
 *       确认不是过拟合。
 * 方法：对每个品种截取最近 2 年（>= OOS_START）的数据，用寻优参数回测，统计成功率。
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';

const FULL_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const OOS_DIR = path.join(process.cwd(), 'data-cache-oos-2y');
const OOS_START = '2024-08-01'; // 最近 2 年

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; ret?: number | null }

interface TradeStat {
  totalTrades: number; wins: number; winRate: number; totalPnl: number; profitFactor: number;
  longTrades: number; longWins: number; longPnl: number; longPF: number;
  shortTrades: number; shortWins: number; shortPnl: number; shortPF: number;
}

function calcStats(trades: any[]): TradeStat {
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const longTrades = trades.filter((t) => t.direction === 'LONG');
  const shortTrades = trades.filter((t) => t.direction === 'SHORT');
  const longWins = longTrades.filter((t) => t.pnl > 0);
  const longLosses = longTrades.filter((t) => t.pnl <= 0);
  const shortWins = shortTrades.filter((t) => t.pnl > 0);
  const shortLosses = shortTrades.filter((t) => t.pnl <= 0);
  const longGrossWin = longWins.reduce((s, t) => s + t.pnl, 0);
  const longGrossLoss = Math.abs(longLosses.reduce((s, t) => s + t.pnl, 0));
  const shortGrossWin = shortWins.reduce((s, t) => s + t.pnl, 0);
  const shortGrossLoss = Math.abs(shortLosses.reduce((s, t) => s + t.pnl, 0));
  return {
    totalTrades: trades.length,
    wins: wins.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    totalPnl: trades.reduce((s, t) => s + t.pnl, 0),
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0,
    longTrades: longTrades.length,
    longWins: longWins.length,
    longPnl: longTrades.reduce((s, t) => s + t.pnl, 0),
    longPF: longGrossLoss > 0 ? longGrossWin / longGrossLoss : longGrossWin > 0 ? 99 : 0,
    shortTrades: shortTrades.length,
    shortWins: shortWins.length,
    shortPnl: shortTrades.reduce((s, t) => s + t.pnl, 0),
    shortPF: shortGrossLoss > 0 ? shortGrossWin / shortGrossLoss : shortGrossWin > 0 ? 99 : 0,
  };
}

function listVarieties(): string[] {
  const files = fs.readdirSync(FULL_DIR).filter((f) => f.endsWith('.json'));
  return files.map((f) => f.replace('.json', '')).sort();
}

function isPassing(stats: TradeStat, side: 'long' | 'short'): boolean {
  const trades = side === 'long' ? stats.longTrades : stats.shortTrades;
  const pnl = side === 'long' ? stats.longPnl : stats.shortPnl;
  const wins = side === 'long' ? stats.longWins : stats.shortWins;
  const pf = side === 'long' ? stats.longPF : stats.shortPF;
  if (trades < 5) return false;
  if (pnl <= 0) return false;
  if (wins / trades < 0.45) return false;
  if (pf < 1.5) return false;
  return true;
}

async function main() {
  // 1. 构建样本外数据目录（最近2年）
  if (fs.existsSync(OOS_DIR)) fs.rmSync(OOS_DIR, { recursive: true, force: true });
  fs.mkdirSync(OOS_DIR, { recursive: true });

  const codes = listVarieties();
  let enough = 0;
  for (const code of codes) {
    const raw = JSON.parse(fs.readFileSync(path.join(FULL_DIR, `${code}.json`), 'utf8'));
    const bars: Bar[] = Array.isArray(raw) ? raw : raw.bars || [];
    const oosBars = bars.filter((b) => b.date >= OOS_START);
    if (oosBars.length >= 80) { // warmup 60 + maxHold 20 左右
      fs.writeFileSync(path.join(OOS_DIR, `${code}.json`), JSON.stringify(oosBars));
      enough++;
    }
  }
  console.log(`样本外窗口: ${OOS_START} ~ 最近 (最后2年), 数据充足品种: ${enough}/${codes.length}`);

  // 2. 逐品种回测（用寻优参数）
  const results: any[] = [];
  for (let ci = 0; ci < enough; ci++) {
    const code = codes.filter((c) => fs.existsSync(path.join(OOS_DIR, `${c}.json`)))[ci];
    if (!code) continue;
    const t0 = Date.now();
    const optLong = LONG_OPT_PARAMS[code];
    const optShort = SHORT_OPT_PARAMS[code];
    const res = await runBacktest({
      minSignalGrade: 'L2',
      maxHoldDays: 15,
      stopAtrMult: 1.5,
      targetAtrMult: 3.0,
      minRR: 1.0,
      cooldownBars: 0,
      warmupBars: 60,
      returnAllTrades: true,
      quiet: true,
      codes: [code],
      dataDir: OOS_DIR,
      sideParams: {
        long: optLong || {},
        short: optShort || {},
      },
    } as any);
    const stats = calcStats(res.trades || []);
    results.push({ code, stats, pass: { long: isPassing(stats, 'long'), short: isPassing(stats, 'short') } });
    console.log(`[${ci + 1}/${enough}] ${code} 多${stats.longTrades}笔赚${Math.round(stats.longPnl)}(PF${stats.longPF.toFixed(2)}) 空${stats.shortTrades}笔赚${Math.round(stats.shortPnl)}(PF${stats.shortPF.toFixed(2)}) 耗时${Date.now() - t0}ms`);
  }

  // 3. 汇总
  const passLong = results.filter((r) => r.pass.long).length;
  const passShort = results.filter((r) => r.pass.short).length;
  const passBoth = results.filter((r) => r.pass.long && r.pass.short).length;
  const totalPnl = results.reduce((s, r) => s + r.stats.totalPnl, 0);
  const totalLong = results.reduce((s, r) => s + r.stats.longPnl, 0);
  const totalShort = results.reduce((s, r) => s + r.stats.shortPnl, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  样本外验证汇总（最近2年, 寻优参数独立回测）');
  console.log('='.repeat(70));
  console.log(`  做多成功率: ${passLong}/${enough} = ${(passLong / enough * 100).toFixed(1)}%`);
  console.log(`  做空成功率: ${passShort}/${enough} = ${(passShort / enough * 100).toFixed(1)}%`);
  console.log(`  双方向成功率: ${passBoth}/${enough} = ${(passBoth / enough * 100).toFixed(1)}%`);
  console.log(`  样本外总收益: ${Math.round(totalPnl)} (做多 ${Math.round(totalLong)} / 做空 ${Math.round(totalShort)})`);
  const oos = results.filter((r) => r.pass.long && r.pass.short).map((r) => r.code);
  const failed = results.filter((r) => !(r.pass.long && r.pass.short)).map((r) => r.code);
  console.log(`  双达标品种: ${oos.join(', ')}`);
  console.log(`  未双达标: ${failed.join(', ') || '无'}`);

  fs.writeFileSync(path.join(process.cwd(), 'src/data/oosValidation.json'), JSON.stringify({ results, passLong, passShort, passBoth, totalPnl, totalLong, totalShort }, null, 2));
  console.log('\n结果已保存: src/data/oosValidation.json');
}

main().catch((e) => { console.error(e); process.exit(1); });
