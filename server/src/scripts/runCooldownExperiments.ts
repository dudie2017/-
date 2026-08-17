/**
 * 冷却期对照实验（15组）
 * 
 * 实验维度：
 * - 冷却期 (cooldownBars)
 * - 交叉验证（持仓周期、信号等级）
 */

import { runBacktest } from '../services/backtestEngine';

const CACHE_DIR = process.env.DAILY_CACHE_DIR || '/workspace/projects/server/data-cache-daily-long';

interface ExperimentConfig {
  name: string;
  desc: string;
  cooldownBars?: number;
  maxHoldDays?: number;
  minSignalGrade?: string;
}

const experiments: ExperimentConfig[] = [
  // 第一类：冷却期扫描（R0-R8）
  { name: 'R00', desc: '无冷却(0)', cooldownBars: 0 },
  { name: 'R01', desc: '1bar冷却', cooldownBars: 1 },
  { name: 'R02', desc: '2bar冷却(基线)', cooldownBars: 2 },
  { name: 'R03', desc: '3bar冷却', cooldownBars: 3 },
  { name: 'R04', desc: '4bar冷却', cooldownBars: 4 },
  { name: 'R05', desc: '5bar冷却', cooldownBars: 5 },
  { name: 'R06', desc: '7bar冷却(1周)', cooldownBars: 7 },
  { name: 'R07', desc: '10bar冷却(2周)', cooldownBars: 10 },
  { name: 'R08', desc: '15bar冷却(3周)', cooldownBars: 15 },

  // 第二类：冷却期 × 持仓周期交叉（R9-R12）
  { name: 'R09', desc: '无冷却+8bar', cooldownBars: 0, maxHoldDays: 8 },
  { name: 'R10', desc: '无冷却+15bar', cooldownBars: 0, maxHoldDays: 15 },
  { name: 'R11', desc: '当前冷却+8bar', cooldownBars: 2, maxHoldDays: 8 },
  { name: 'R12', desc: '当前冷却+15bar', cooldownBars: 2, maxHoldDays: 15 },

  // 第三类：冷却期 × minSignalGrade 交叉（R13-R14）
  { name: 'R13', desc: '无冷却+L3', cooldownBars: 0, minSignalGrade: 'L3' },
  { name: 'R14', desc: '当前冷却+L3', cooldownBars: 2, minSignalGrade: 'L3' },
];

function formatPct(v: number | undefined): string {
  if (v == null) return 'N/A';
  return `${v.toFixed(1)}%`;
}

async function main() {
  console.log('=== 冷却期对照实验（15组） ===\n');

  const results: Array<{
    name: string;
    desc: string;
    trades: number;
    winRate: number;
    returnPct: number;
    pf: number;
    maxDd: number;
  }> = [];

  for (const exp of experiments) {
    process.stdout.write(`运行 ${exp.name}: ${exp.desc}... `);

    const result = await runBacktest({
      dataDir: CACHE_DIR,
      minSignalGrade: exp.minSignalGrade,
      maxHoldDays: exp.maxHoldDays,
      cooldownBars: exp.cooldownBars,
    });

    const summary = result.summary;
    const trades = summary.totalTrades ?? 0;
    const winRate = (summary.winRate ?? 0) * 100;
    const returnPct = (summary.totalReturn ?? 1) * 100;
    const pf = summary.profitFactor ?? 0;
    const maxDd = (summary.maxDrawdown ?? 0) * 100;

    console.log(`交易${trades}笔, 胜率${winRate.toFixed(0)}%, 收益${returnPct.toFixed(0)}%, PF=${pf.toFixed(2)}, 回撤${maxDd.toFixed(0)}%`);

    results.push({
      name: exp.name,
      desc: exp.desc,
      trades,
      winRate,
      returnPct,
      pf,
      maxDd,
    });
  }

  // 汇总
  console.log('\n=== 实验结果汇总 ===\n');

  console.log('第一类：冷却期扫描（R0-R8）');
  console.log('─'.repeat(80));
  console.log('组\t配置\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(80));
  for (const r of results.slice(0, 9)) {
    const marker = r.name === 'R02' ? ' ← 基线' : '';
    console.log(`${r.name}\t${r.desc.padEnd(20)}\t${r.trades}\t${r.winRate.toFixed(0)}%\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}\t${r.maxDd.toFixed(0)}%${marker}`);
  }

  console.log('\n第二类：冷却期 × 持仓周期交叉（R9-R12）');
  console.log('─'.repeat(80));
  console.log('组\t配置\t\t\t收益率\tPF');
  console.log('─'.repeat(80));
  for (const r of results.slice(9, 13)) {
    console.log(`${r.name}\t${r.desc.padEnd(20)}\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}`);
  }

  console.log('\n第三类：冷却期 × minSignalGrade 交叉（R13-R14）');
  console.log('─'.repeat(80));
  console.log('组\t配置\t\t\t收益率\tPF');
  console.log('─'.repeat(80));
  for (const r of results.slice(13)) {
    console.log(`${r.name}\t${r.desc.padEnd(20)}\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}`);
  }

  // 找出最优
  const best = results.reduce((a, b) => (a.returnPct > b.returnPct ? a : b));
  console.log(`\n最优配置: ${best.name} (${best.desc}) - 收益${best.returnPct.toFixed(0)}%, PF=${best.pf.toFixed(2)}`);
}

main().catch(console.error);
