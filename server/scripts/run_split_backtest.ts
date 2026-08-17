/**
 * 样本内/样本外分离回测
 * 切分点: 2026-05-01
 * - 样本内 (in-sample):  ~2022-07 ~ 2026-04-30
 * - 样本外 (out-of-sample): 2026-05-01 ~ 2026-08-03
 */

import * as path from 'path';
import * as fs from 'fs';
import { runBacktest } from '../src/services/backtestEngine.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_30M = path.join(__dirname, '..', 'data-cache-30m-long');
const SPLIT_DATE = '2026-05-01';
const RESULT_FILE = '/tmp/bt_split_result.json';
const TMP_IN = '/tmp/bt_split_in';
const TMP_OUT = '/tmp/bt_split_out';
const WHITELIST_48_FILE = path.join(__dirname, '..', 'src', 'services', 'varieties.ts');

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function readWhitelist(): Set<string> {
  try {
    const content = fs.readFileSync(WHITELIST_48_FILE, 'utf-8');
    const match = content.match(/WHITELIST_48\s*=\s*\[([\s\S]*?)\]/);
    if (!match) return new Set();
    const codes = match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(s => s.length > 0);
    return new Set(codes);
  } catch { return new Set(); }
}

async function main() {
  const whitelist = readWhitelist();
  const allFiles = fs.readdirSync(CACHE_30M).filter(f => f.endsWith('.json'));
  
  console.log(`=== 分离回测 ===`);
  console.log(`切分点: ${SPLIT_DATE}`);
  console.log(`白名单: ${whitelist.size} 品种`);
  console.log();

  // 创建临时目录
  fs.mkdirSync(TMP_IN, { recursive: true });
  fs.mkdirSync(TMP_OUT, { recursive: true });

  // 清理旧文件
  for (const f of fs.readdirSync(TMP_IN)) fs.unlinkSync(path.join(TMP_IN, f));
  for (const f of fs.readdirSync(TMP_OUT)) fs.unlinkSync(path.join(TMP_OUT, f));

  // 切分数据
  let inCount = 0;
  let outCount = 0;

  for (const file of allFiles) {
    const code = file.replace('.json', '');
    if (whitelist.size > 0 && !whitelist.has(code)) continue;

    const bars: Bar[] = JSON.parse(fs.readFileSync(path.join(CACHE_30M, file), 'utf-8'));
    const inSample = bars.filter(b => b.date < SPLIT_DATE);
    const outSample = bars.filter(b => b.date >= SPLIT_DATE);

    if (inSample.length >= 200) {
      fs.writeFileSync(path.join(TMP_IN, file), JSON.stringify(inSample));
      inCount++;
    }
    if (outSample.length >= 60) {
      fs.writeFileSync(path.join(TMP_OUT, file), JSON.stringify(outSample));
      outCount++;
    }
  }

  console.log(`样本内品种: ${inCount}  样本外品种: ${outCount}`);
  console.log();

  const baseConfig = {
    startCapital: 500000,
    maxPositionPct: 0.15,
    minSignalGrade: 'L3' as const,
    maxHoldDays: 70,
    warmupBars: 120,
    cooldownBars: 28,
    returnAllTrades: true,
  };

  // === 样本内回测 ===
  console.log('[1/2] 样本内回测 (~2022-07 ~ 2026-04)...');
  const inStart = Date.now();
  const inResult = await runBacktest({ ...baseConfig, dataDir: TMP_IN });
  const inTime = (Date.now() - inStart) / 1000;
  console.log(`  耗时: ${inTime.toFixed(0)}s`);
  console.log(`  交易: ${inResult.summary.totalTrades}笔  WR:${(inResult.summary.winRate*100).toFixed(1)}%  Ret:${(inResult.summary.totalReturn*100).toFixed(1)}%  PF:${inResult.summary.profitFactor.toFixed(2)}  夏普:${inResult.summary.sharpeRatio.toFixed(2)}  回撤:${(inResult.summary.maxDrawdown*100).toFixed(1)}%`);
  console.log();

  // === 样本外回测 ===
  console.log('[2/2] 样本外回测 (2026-05-01 ~ 2026-08)...');
  const outStart = Date.now();
  const outResult = await runBacktest({ ...baseConfig, dataDir: TMP_OUT, warmupBars: 60 });
  const outTime = (Date.now() - outStart) / 1000;
  console.log(`  耗时: ${outTime.toFixed(0)}s`);
  console.log(`  交易: ${outResult.summary.totalTrades}笔  WR:${(outResult.summary.winRate*100).toFixed(1)}%  Ret:${(outResult.summary.totalReturn*100).toFixed(1)}%  PF:${outResult.summary.profitFactor.toFixed(2)}  夏普:${outResult.summary.sharpeRatio.toFixed(2)}  回撤:${(outResult.summary.maxDrawdown*100).toFixed(1)}%`);
  console.log();

  // === 构建逐品种对比 ===
  const inByCode = buildByCode(inResult);
  const outByCode = buildByCode(outResult);

  const comparison: any[] = [];
  for (const code of [...new Set([...Object.keys(inByCode), ...Object.keys(outByCode)])]) {
    const ins = inByCode[code] || { trades: 0, wins: 0, totalPnl: 0, totalRR: 0, losses: 0 };
    const outs = outByCode[code] || { trades: 0, wins: 0, totalPnl: 0, totalRR: 0, losses: 0 };
    comparison.push({
      code,
      inTrades: ins.trades, inWinRate: pct(ins.wins, ins.trades), inPnl: Math.round(ins.totalPnl),
      inPF: ins.trades - ins.wins > 0 ? round(ins.wins / (ins.trades - ins.wins)) : ins.trades,
      outTrades: outs.trades, outWinRate: pct(outs.wins, outs.trades), outPnl: Math.round(outs.totalPnl),
      outPF: outs.trades - outs.wins > 0 ? round(outs.wins / (outs.trades - outs.wins)) : outs.trades,
      totalPnl: Math.round(ins.totalPnl + outs.totalPnl),
    });
  }
  comparison.sort((a, b) => b.totalPnl - a.totalPnl);

  const result = { splitDate: SPLIT_DATE, inSample: { codes: inCount, summary: inResult.summary }, outSample: { codes: outCount, summary: outResult.summary }, comparison };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(`结果已写入 ${RESULT_FILE}`);
}

function pct(n: number, d: number) { return d > 0 ? Math.round(n / d * 10000) / 100 : 0; }
function round(n: number) { return Math.round(n * 100) / 100; }

function buildByCode(result: any): Record<string, { trades: number; wins: number; losses: number; totalPnl: number; totalRR: number }> {
  const map: Record<string, any> = {};
  for (const t of result.trades) {
    if (!map[t.code]) map[t.code] = { trades: 0, wins: 0, losses: 0, totalPnl: 0, totalRR: 0 };
    map[t.code].trades++;
    if (t.pnl > 0) map[t.code].wins++; else map[t.code].losses++;
    map[t.code].totalPnl += t.pnl;
    map[t.code].totalRR += t.rMultiple || 0;
  }
  return map;
}

main().catch(e => { console.error(e); process.exit(1); });
