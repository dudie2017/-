/**
 * 仓位比例对照实验（13组）
 * 
 * 实验维度：
 * - 仓位比例 (maxPositionPct)
 * - 交叉验证（持仓周期、信号等级）
 */

import { runBacktest } from '../services/backtestEngine';

const CACHE_DIR = process.env.DAILY_CACHE_DIR || '/workspace/projects/server/data-cache-daily-long';

interface ExperimentConfig {
  name: string;
  desc: string;
  maxPositionPct?: number;
  maxHoldDays?: number;
  minSignalGrade?: string;
}

const experiments: ExperimentConfig[] = [
  // 第一类：仓位比例扫描（S0-S6）
  { name: 'S00', desc: '5%仓位', maxPositionPct: 0.05 },
  { name: 'S01', desc: '10%仓位', maxPositionPct: 0.10 },
  { name: 'S02', desc: '15%仓位(基线)', maxPositionPct: 0.15 },
  { name: 'S03', desc: '20%仓位', maxPositionPct: 0.20 },
  { name: 'S04', desc: '25%仓位', maxPositionPct: 0.25 },
  { name: 'S05', desc: '30%仓位', maxPositionPct: 0.30 },
  { name: 'S06', desc: '35%仓位', maxPositionPct: 0.35 },

  // 第二类：仓位比例 × 持仓周期交叉（S7-S10）
  { name: 'S07', desc: '10%+8bar', maxPositionPct: 0.10, maxHoldDays: 8 },
  { name: 'S08', desc: '10%+15bar', maxPositionPct: 0.10, maxHoldDays: 15 },
  { name: 'S09', desc: '20%+8bar', maxPositionPct: 0.20, maxHoldDays: 8 },
  { name: 'S10', desc: '20%+15bar', maxPositionPct: 0.20, maxHoldDays: 15 },

  // 第三类：仓位比例 × minSignalGrade 交叉（S11-S12）
  { name: 'S11', desc: '10%+L3', maxPositionPct: 0.10, minSignalGrade: 'L3' },
  { name: 'S12', desc: '20%+L3', maxPositionPct: 0.20, minSignalGrade: 'L3' },
];

function formatPct(v: number | undefined): string {
  if (v == null) return 'N/A';
  return `${v.toFixed(1)}%`;
}

async function main() {
  console.log('=== 仓位比例对照实验（13组） ===\n');

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
      maxPositionPct: exp.maxPositionPct,
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

  // 输出汇总表
  console.log('\n=== 实验结果汇总 ===\n');
  console.log('第一类：仓位比例扫描（S0-S6）');
  console.log('─'.repeat(70));
  console.log('组\t配置\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(70));
  for (const r of results.slice(0, 7)) {
    console.log(`${r.name}\t${r.desc.padEnd(16)}\t${r.trades}\t${r.winRate.toFixed(0)}%\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}\t${r.maxDd.toFixed(0)}%`);
  }

  console.log('\n第二类：仓位比例 × 持仓周期交叉（S7-S10）');
  console.log('─'.repeat(50));
  console.log('组\t配置\t\t收益率\tPF');
  console.log('─'.repeat(50));
  for (const r of results.slice(7, 11)) {
    console.log(`${r.name}\t${r.desc.padEnd(16)}\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}`);
  }

  console.log('\n第三类：仓位比例 × minSignalGrade 交叉（S11-S12）');
  console.log('─'.repeat(50));
  console.log('组\t配置\t\t收益率\tPF');
  console.log('─'.repeat(50));
  for (const r of results.slice(11, 13)) {
    console.log(`${r.name}\t${r.desc.padEnd(16)}\t${r.returnPct.toFixed(0)}%\t${r.pf.toFixed(2)}`);
  }

  // 找出最优配置
  const best = results.reduce((a, b) => a.returnPct > b.returnPct ? a : b);
  console.log(`\n★ 最优配置: ${best.name} (${best.desc}) - 收益${best.returnPct.toFixed(0)}%, PF=${best.pf.toFixed(2)}, 回撤${best.maxDd.toFixed(0)}%`);
}

main().catch(err => {
  console.error('实验失败:', err);
  process.exit(1);
});
