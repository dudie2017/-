/**
 * 止损倍数对照实验（25组）
 * 
 * 实验维度：
 * - 止损 ATR 倍数（0.5 / 0.75 / 1.0 / 1.25 / 1.5 / 1.75 / 2.0 / 2.5 / 3.0）
 * - 目标 ATR 倍数（1.5 / 2.0 / 3.0 / 4.0 / 5.0）
 * - 最低 R:R（1.0 / 1.5 / 2.0 / 2.5 / 3.0）
 * - 止损 × 持仓周期交叉
 * - 止损 × minSignalGrade 交叉
 */

import { runBacktest } from '../services/backtestEngine';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '../../data-cache-daily-long');

interface Group {
  id: string;
  name: string;
  config: {
    stopAtrMult?: number;
    targetAtrMult?: number;
    minRR?: number;
    maxHoldDays?: number;
    minSignalGrade?: string;
  };
}

const groups: Group[] = [
  // 第一类：止损 ATR 倍数扫描（P0-P8）
  { id: 'P00', name: '止损ATR×0.5', config: { stopAtrMult: 0.5 } },
  { id: 'P01', name: '止损ATR×0.75', config: { stopAtrMult: 0.75 } },
  { id: 'P02', name: '止损ATR×1.0', config: { stopAtrMult: 1.0 } },
  { id: 'P03', name: '止损ATR×1.25', config: { stopAtrMult: 1.25 } },
  { id: 'P04', name: '止损ATR×1.5(基线)', config: { stopAtrMult: 1.5 } },
  { id: 'P05', name: '止损ATR×1.75', config: { stopAtrMult: 1.75 } },
  { id: 'P06', name: '止损ATR×2.0', config: { stopAtrMult: 2.0 } },
  { id: 'P07', name: '止损ATR×2.5', config: { stopAtrMult: 2.5 } },
  { id: 'P08', name: '止损ATR×3.0', config: { stopAtrMult: 3.0 } },

  // 第二类：目标 ATR 倍数扫描（P9-P13）
  { id: 'P09', name: '目标ATR×1.5', config: { targetAtrMult: 1.5 } },
  { id: 'P10', name: '目标ATR×2.0', config: { targetAtrMult: 2.0 } },
  { id: 'P11', name: '目标ATR×3.0(基线)', config: { targetAtrMult: 3.0 } },
  { id: 'P12', name: '目标ATR×4.0', config: { targetAtrMult: 4.0 } },
  { id: 'P13', name: '目标ATR×5.0', config: { targetAtrMult: 5.0 } },

  // 第三类：最低 R:R 扫描（P14-P18）
  { id: 'P14', name: '最低RR≥1.0', config: { minRR: 1.0 } },
  { id: 'P15', name: '最低RR≥1.5(基线)', config: { minRR: 1.5 } },
  { id: 'P16', name: '最低RR≥2.0', config: { minRR: 2.0 } },
  { id: 'P17', name: '最低RR≥2.5', config: { minRR: 2.5 } },
  { id: 'P18', name: '最低RR≥3.0', config: { minRR: 3.0 } },

  // 第四类：止损 × 持仓周期交叉（P19-P22）
  { id: 'P19', name: '止损1.0+8bar', config: { stopAtrMult: 1.0, maxHoldDays: 8 } },
  { id: 'P20', name: '止损1.0+15bar', config: { stopAtrMult: 1.0, maxHoldDays: 15 } },
  { id: 'P21', name: '止损2.0+8bar', config: { stopAtrMult: 2.0, maxHoldDays: 8 } },
  { id: 'P22', name: '止损2.0+15bar', config: { stopAtrMult: 2.0, maxHoldDays: 15 } },

  // 第五类：止损 × minSignalGrade 交叉（P23-P24）
  { id: 'P23', name: '止损1.0+L3', config: { stopAtrMult: 1.0, minSignalGrade: 'L3' } },
  { id: 'P24', name: '止损2.0+L3', config: { stopAtrMult: 2.0, minSignalGrade: 'L3' } },
];

async function runGroup(group: Group) {
  const result = await runBacktest({
    dataDir: DATA_DIR,
    minSignalGrade: group.config.minSignalGrade || 'L2',
    maxHoldDays: group.config.maxHoldDays || 15,
    equationMode: 'none',
    stopAtrMult: group.config.stopAtrMult,
    targetAtrMult: group.config.targetAtrMult,
    minRR: group.config.minRR,
  });

  const s = result.summary;
  return {
    totalTrades: s.totalTrades || 0,
    winRate: (s.winRate || 0) * 100,
    totalReturnPct: (s.totalReturn || 0) * 100,
    profitFactor: s.profitFactor || 0,
    maxDrawdownPct: (s.maxDrawdown || 0) * 100,
    avgTradeReturnPct: s.avgRR || 0,
  };
}

function formatPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

async function main() {
  console.log('========================================');
  console.log('止损倍数对照实验（25组）');
  console.log('========================================\n');

  const results: Array<{ group: Group; result: Awaited<ReturnType<typeof runGroup>> }> = [];

  for (const group of groups) {
    process.stdout.write(`[${group.id}] ${group.name}... `);
    const result = await runGroup(group);
    console.log(`交易${result.totalTrades}笔 胜率${formatPct(result.winRate)} 收益${formatPct(result.totalReturnPct)} PF=${result.profitFactor.toFixed(2)} 回撤${formatPct(result.maxDrawdownPct)}`);
    results.push({ group, result });
  }

  // 汇总表格
  console.log('\n========================================');
  console.log('汇总表格');
  console.log('========================================\n');

  console.log('第一类：止损 ATR 倍数扫描');
  console.log('─'.repeat(90));
  console.log('组\t名称\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(90));
  for (const { group, result } of results.filter(r => r.group.id.startsWith('P0') && parseInt(r.group.id.slice(1)) <= 8)) {
    const name = group.name.padEnd(16, '\t');
    console.log(`${group.id}\t${name}\t${result.totalTrades}\t${formatPct(result.winRate)}\t${formatPct(result.totalReturnPct)}\t${result.profitFactor.toFixed(2)}\t${formatPct(result.maxDrawdownPct)}`);
  }

  console.log('\n第二类：目标 ATR 倍数扫描');
  console.log('─'.repeat(90));
  console.log('组\t名称\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(90));
  for (const { group, result } of results.filter(r => r.group.id >= 'P09' && r.group.id <= 'P13')) {
    const name = group.name.padEnd(16, '\t');
    console.log(`${group.id}\t${name}\t${result.totalTrades}\t${formatPct(result.winRate)}\t${formatPct(result.totalReturnPct)}\t${result.profitFactor.toFixed(2)}\t${formatPct(result.maxDrawdownPct)}`);
  }

  console.log('\n第三类：最低 R:R 扫描');
  console.log('─'.repeat(90));
  console.log('组\t名称\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(90));
  for (const { group, result } of results.filter(r => r.group.id >= 'P14' && r.group.id <= 'P18')) {
    const name = group.name.padEnd(16, '\t');
    console.log(`${group.id}\t${name}\t${result.totalTrades}\t${formatPct(result.winRate)}\t${formatPct(result.totalReturnPct)}\t${result.profitFactor.toFixed(2)}\t${formatPct(result.maxDrawdownPct)}`);
  }

  console.log('\n第四类：止损 × 持仓周期交叉');
  console.log('─'.repeat(90));
  console.log('组\t名称\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(90));
  for (const { group, result } of results.filter(r => r.group.id >= 'P19' && r.group.id <= 'P22')) {
    const name = group.name.padEnd(16, '\t');
    console.log(`${group.id}\t${name}\t${result.totalTrades}\t${formatPct(result.winRate)}\t${formatPct(result.totalReturnPct)}\t${result.profitFactor.toFixed(2)}\t${formatPct(result.maxDrawdownPct)}`);
  }

  console.log('\n第五类：止损 × minSignalGrade 交叉');
  console.log('─'.repeat(90));
  console.log('组\t名称\t\t\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(90));
  for (const { group, result } of results.filter(r => r.group.id >= 'P23')) {
    const name = group.name.padEnd(16, '\t');
    console.log(`${group.id}\t${name}\t${result.totalTrades}\t${formatPct(result.winRate)}\t${formatPct(result.totalReturnPct)}\t${result.profitFactor.toFixed(2)}\t${formatPct(result.maxDrawdownPct)}`);
  }

  // 找出最优
  const best = results.reduce((a, b) => a.result.totalReturnPct > b.result.totalReturnPct ? a : b);
  console.log(`\n最优配置: ${best.group.id} ${best.group.name} → 收益${formatPct(best.result.totalReturnPct)}, PF=${best.result.profitFactor.toFixed(2)}`);
}

main().catch(console.error);
