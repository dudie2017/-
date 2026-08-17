/**
 * P(顺) 阈值 17组对照实验
 * 
 * 第一类：阈值扫描组（M0-M8）
 *   M0: 不过滤（pThreshold=0）
 *   M1-M5: 0.25~0.40 宽松
 *   M6: 0.45 当前基线
 *   M7-M8: 0.50~0.55 严格
 * 
 * 第二类：软过滤组（M9-M12）— 暂不实现（需改evaluateV16Row逻辑）
 *   改为额外验证组：P(顺) × minSignalGrade 交叉
 * 
 * 第三类：P(顺) × 持仓周期交叉组（M13-M16）
 */
import { runBacktest } from '../services/backtestEngine.js';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-long');
const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];

interface Experiment {
  name: string;
  desc: string;
  pThreshold?: number;        // undefined=使用默认0.45, 0=不过滤
  minSignalGrade?: string;
  maxHoldDays?: number;
}

const experiments: Experiment[] = [
  // === 第一类：阈值扫描组 ===
  { name: 'M00_无过滤', desc: 'P(顺)不过滤(pThreshold=0)', pThreshold: 0 },
  { name: 'M01_P025', desc: 'P(顺)≥0.25(极低门槛)', pThreshold: 0.25 },
  { name: 'M02_P030', desc: 'P(顺)≥0.30(宽松)', pThreshold: 0.30 },
  { name: 'M03_P033', desc: 'P(顺)≥0.33(=数据不足默认值)', pThreshold: 0.33 },
  { name: 'M04_P035', desc: 'P(顺)≥0.35(偏宽松)', pThreshold: 0.35 },
  { name: 'M05_P040', desc: 'P(顺)≥0.40(中等)', pThreshold: 0.40 },
  { name: 'M06_P045_基线', desc: 'P(顺)≥0.45(当前基线)', pThreshold: 0.45 },
  { name: 'M07_P050', desc: 'P(顺)≥0.50(偏严格)', pThreshold: 0.50 },
  { name: 'M08_P055', desc: 'P(顺)≥0.55(严格)', pThreshold: 0.55 },

  // === 第二类：P(顺) × minSignalGrade 交叉组 ===
  { name: 'M09_P035_L2', desc: 'P≥0.35 + L2', pThreshold: 0.35, minSignalGrade: 'L2' },
  { name: 'M10_P035_L3', desc: 'P≥0.35 + L3', pThreshold: 0.35, minSignalGrade: 'L3' },
  { name: 'M11_P045_L2', desc: 'P≥0.45 + L2', pThreshold: 0.45, minSignalGrade: 'L2' },
  { name: 'M12_P045_L3', desc: 'P≥0.45 + L3(双基线)', pThreshold: 0.45, minSignalGrade: 'L3' },

  // === 第三类：P(顺) × 持仓周期交叉组 ===
  { name: 'M13_P035_8bar', desc: 'P≥0.35 + 8bar', pThreshold: 0.35, maxHoldDays: 8 },
  { name: 'M14_P035_15bar', desc: 'P≥0.35 + 15bar', pThreshold: 0.35, maxHoldDays: 15 },
  { name: 'M15_P045_8bar', desc: 'P≥0.45 + 8bar', pThreshold: 0.45, maxHoldDays: 8 },
  { name: 'M16_P045_15bar', desc: 'P≥0.45 + 15bar(当前默认)', pThreshold: 0.45, maxHoldDays: 15 },
];

async function main() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`P(顺)阈值 17组对照实验`);
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
        pThreshold: exp.pThreshold,
        allowRangeTrading: true,
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
  console.log(`\n${'='.repeat(100)}`);
  console.log('汇总结果:');
  console.log(`${'='.repeat(100)}`);
  console.log(
    '组名'.padEnd(20) +
    '交易数'.padStart(8) +
    '胜率'.padStart(8) +
    'R:R'.padStart(8) +
    '收益率'.padStart(10) +
    'PF'.padStart(8) +
    '回撤'.padStart(8)
  );
  console.log('-'.repeat(100));

  for (const r of results) {
    if (r.error) {
      console.log(`${r.exp.padEnd(20)} ERROR: ${r.error}`);
      continue;
    }
    console.log(
      r.exp.padEnd(20) +
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
