/**
 * 交易者方程 19组对照实验
 * 
 * 第一类：硬过滤 vs 软过滤 vs 不过滤（N0-N5）
 * 第二类：CH 豁免 + 方程（N6-N8）
 * 第三类：方程参数变体（N9-N12）— 暂不实现（需改checkTradersEquation内部逻辑）
 *   改为：方程 × 持仓周期交叉（N9-N12）
 * 第四类：方程 × minSignalGrade 交叉（N13-N14）
 * 第五类：软过滤梯度精细扫描（N15-N18）
 */
import { runBacktest } from '../services/backtestEngine.js';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-long');
const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];

interface Experiment {
  name: string;
  desc: string;
  equationMode?: 'hard' | 'soft' | 'none';
  softEquationMul?: number;
  chExemptEquation?: boolean;
  minSignalGrade?: string;
  maxHoldDays?: number;
}

const experiments: Experiment[] = [
  // === 第一类：硬过滤 vs 软过滤 vs 不过滤 ===
  { name: 'N00_不过滤', desc: '移除方程检查', equationMode: 'none' },
  { name: 'N01_硬过滤_基线', desc: '方程为负→不交易(当前)', equationMode: 'hard' },
  { name: 'N02_软过滤07', desc: '方程为负→仓位×0.7', equationMode: 'soft', softEquationMul: 0.7 },
  { name: 'N03_软过滤05', desc: '方程为负→仓位×0.5', equationMode: 'soft', softEquationMul: 0.5 },
  { name: 'N04_软过滤03', desc: '方程为负→仓位×0.3', equationMode: 'soft', softEquationMul: 0.3 },
  { name: 'N05_仅警告', desc: '方程为负→标记但posMul=1(=不过滤)', equationMode: 'none' },

  // === 第二类：CH 豁免 + 方程 ===
  { name: 'N06_CH豁免_硬过滤', desc: 'CH强信号跳过方程检查', equationMode: 'hard', chExemptEquation: true },
  { name: 'N07_CH豁免_软05', desc: 'CH跳过+非CH为负→×0.5', equationMode: 'soft', softEquationMul: 0.5, chExemptEquation: true },
  { name: 'N08_CH豁免_不过滤', desc: 'CH跳过+其余也不过滤', equationMode: 'none', chExemptEquation: true },

  // === 第三类：方程 × 持仓周期交叉 ===
  { name: 'N09_硬过滤_8bar', desc: '硬过滤 + 8bar(短持仓)', equationMode: 'hard', maxHoldDays: 8 },
  { name: 'N10_硬过滤_15bar', desc: '硬过滤 + 15bar(最优持仓)', equationMode: 'hard', maxHoldDays: 15 },
  { name: 'N11_不过滤_8bar', desc: '不过滤 + 8bar', equationMode: 'none', maxHoldDays: 8 },
  { name: 'N12_不过滤_15bar', desc: '不过滤 + 15bar', equationMode: 'none', maxHoldDays: 15 },

  // === 第四类：方程 × minSignalGrade 交叉 ===
  { name: 'N13_硬过滤_L3', desc: '硬过滤 + L3(双严格)', equationMode: 'hard', minSignalGrade: 'L3' },
  { name: 'N14_不过滤_L3', desc: '不过滤 + L3', equationMode: 'none', minSignalGrade: 'L3' },

  // === 第五类：软过滤梯度精细扫描 ===
  { name: 'N15_软过滤09', desc: '方程为负→仓位×0.9(微调)', equationMode: 'soft', softEquationMul: 0.9 },
  { name: 'N16_软过滤08', desc: '方程为负→仓位×0.8', equationMode: 'soft', softEquationMul: 0.8 },
  { name: 'N17_软过滤06', desc: '方程为负→仓位×0.6', equationMode: 'soft', softEquationMul: 0.6 },
  { name: 'N18_软过滤04', desc: '方程为负→仓位×0.4', equationMode: 'soft', softEquationMul: 0.4 },
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`交易者方程 19组对照实验`);
  console.log(`${'='.repeat(60)}`);
  console.log(`品种: ${CODES.length}个 (${CODES.join(', ')})`);
  console.log(`数据: 10年日线 (${DATA_DIR})`);
  console.log(`实验组: ${experiments.length}组\n`);

  const results: any[] = [];

  for (const exp of experiments) {
    console.log(`[运行] ${exp.name}: ${exp.desc}`);
    const start = Date.now();

    try {
      const result = await runBacktest({
        startCapital: 500000,
        maxPositionPct: 0.15,
        minSignalGrade: exp.minSignalGrade || 'L2',
        maxHoldDays: exp.maxHoldDays || 15,
        warmupBars: 60,
        allowRangeTrading: true,
        equationMode: exp.equationMode,
        softEquationMul: exp.softEquationMul,
        chExemptEquation: exp.chExemptEquation,
        dataDir: DATA_DIR,
        codes: CODES,
      });

      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const s = result.summary;
      console.log(`[结果] ${exp.name}: 交易${s.totalTrades}笔 胜率${(s.winRate * 100).toFixed(1)}% R:R=${s.avgRR.toFixed(2)} 收益${(s.totalReturn * 100).toFixed(1)}% PF=${s.profitFactor.toFixed(2)} 回撤${(s.maxDrawdown * 100).toFixed(1)}% (${elapsed}s)`);

      results.push({
        exp: exp.name,
        desc: exp.desc,
        totalTrades: s.totalTrades,
        winRate: s.winRate,
        avgRR: s.avgRR,
        totalReturn: s.totalReturn,
        profitFactor: s.profitFactor,
        maxDrawdown: s.maxDrawdown,
        elapsedSec: parseFloat(elapsed),
      });
    } catch (err: any) {
      console.error(`[错误] ${exp.name}: ${err.message}`);
      results.push({ exp: exp.name, desc: exp.desc, error: err.message });
    }
  }

  // 汇总表格
  console.log(`\n${'='.repeat(110)}`);
  console.log('汇总结果:');
  console.log(`${'='.repeat(110)}`);
  console.log(
    '组名'.padEnd(22) +
    '交易数'.padStart(8) +
    '胜率'.padStart(8) +
    'R:R'.padStart(8) +
    '收益率'.padStart(10) +
    'PF'.padStart(8) +
    '回撤'.padStart(8)
  );
  console.log('-'.repeat(110));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.exp.padEnd(22)} ERROR: ${r.error}`);
      continue;
    }
    console.log(
      r.exp.padEnd(22) +
      String(r.totalTrades).padStart(8) +
      (r.winRate * 100).toFixed(1).padStart(7) + '%' +
      r.avgRR.toFixed(2).padStart(8) +
      (r.totalReturn * 100).toFixed(1).padStart(9) + '%' +
      r.profitFactor.toFixed(2).padStart(8) +
      (r.maxDrawdown * 100).toFixed(1).padStart(7) + '%'
    );
  }

  // 找出最优
  const valid = results.filter(r => !r.error && r.totalTrades > 0);
  if (valid.length > 0) {
    const bestReturn = valid.reduce((a, b) => a.totalReturn > b.totalReturn ? a : b);
    const bestPF = valid.reduce((a, b) => a.profitFactor > b.profitFactor ? a : b);
    const bestDD = valid.reduce((a, b) => a.maxDrawdown < b.maxDrawdown ? a : b);
    console.log(`\n最优收益: ${bestReturn.exp} (${(bestReturn.totalReturn * 100).toFixed(1)}%)`);
    console.log(`最优PF: ${bestPF.exp} (${bestPF.profitFactor.toFixed(2)})`);
    console.log(`最小回撤: ${bestDD.exp} (${(bestDD.maxDrawdown * 100).toFixed(1)}%)`);
  }
}

main().catch(console.error);
