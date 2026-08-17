/**
 * minSignalGrade 20组对照实验
 * 
 * 实验组：
 * 基础组：G0(L2), G1(L3基线), G2(L4)
 * 组合组：G3-G8 (minSignalGrade × Gate4)
 * 极端组：G12(L0), G13(L1)
 * 持仓组合：G18(L2+3bar), G19(L4+10bar)
 */
import { runBacktest } from '../services/backtestEngine.js';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-long');
const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];

interface Experiment {
  name: string;
  desc: string;
  minSignalGrade: string;
  maxHoldDays?: number;
  gate4Config?: any;
}

const experiments: Experiment[] = [
  // 基础组
  { name: 'G00_L2', desc: 'minSignalGrade=L2', minSignalGrade: 'L2' },
  { name: 'G01_L3_基线', desc: 'minSignalGrade=L3(基线)', minSignalGrade: 'L3' },
  { name: 'G02_L4', desc: 'minSignalGrade=L4', minSignalGrade: 'L4' },

  // 极端组
  { name: 'G03_L0', desc: 'minSignalGrade=L0(完全不过滤)', minSignalGrade: 'L0' },
  { name: 'G04_L1', desc: 'minSignalGrade=L1', minSignalGrade: 'L1' },

  // Gate4组合组
  { name: 'G05_L2_G4_4_5', desc: 'L2 + Gate4≥4/5', minSignalGrade: 'L2', gate4Config: { minReasons: 4 } },
  { name: 'G06_L3_G4_4_5', desc: 'L3 + Gate4≥4/5', minSignalGrade: 'L3', gate4Config: { minReasons: 4 } },
  { name: 'G07_L4_G4_3_5', desc: 'L4 + Gate4≥3/5', minSignalGrade: 'L4', gate4Config: { minReasons: 3 } },
  { name: 'G08_L4_G4_4_5', desc: 'L4 + Gate4≥4/5', minSignalGrade: 'L4', gate4Config: { minReasons: 4 } },
  { name: 'G09_L4_G4_5_5', desc: 'L4 + Gate4≥5/5(最严)', minSignalGrade: 'L4', gate4Config: { minReasons: 5 } },

  // 持仓周期组合
  { name: 'G10_L2_3bar', desc: 'L2 + 持仓3bar(快进快出)', minSignalGrade: 'L2', maxHoldDays: 3 },
  { name: 'G11_L3_3bar', desc: 'L3 + 持仓3bar', minSignalGrade: 'L3', maxHoldDays: 3 },
  { name: 'G12_L3_8bar', desc: 'L3 + 持仓8bar', minSignalGrade: 'L3', maxHoldDays: 8 },
  { name: 'G13_L3_15bar', desc: 'L3 + 持仓15bar(长持)', minSignalGrade: 'L3', maxHoldDays: 15 },
  { name: 'G14_L4_10bar', desc: 'L4 + 持仓10bar(精选长持)', minSignalGrade: 'L4', maxHoldDays: 10 },

  // 关闭单理由组（验证各理由价值）
  { name: 'G15_L3_关理由1', desc: 'L3 + 关闭理由1(AI方向)', minSignalGrade: 'L3', gate4Config: { disabledReasons: [1] } },
  { name: 'G16_L3_关理由3', desc: 'L3 + 关闭理由3(量仓)', minSignalGrade: 'L3', gate4Config: { disabledReasons: [3] } },
  { name: 'G17_L3_关理由4', desc: 'L3 + 关闭理由4(趋势健康)', minSignalGrade: 'L3', gate4Config: { disabledReasons: [4] } },
  { name: 'G18_L3_关理由5', desc: 'L3 + 关闭理由5(R:R)', minSignalGrade: 'L3', gate4Config: { disabledReasons: [5] } },

  // 合并理由组
  { name: 'G19_L3_合并1_4', desc: 'L3 + 合并理由1+4(趋势确认)', minSignalGrade: 'L3', gate4Config: { mergeReasons: [1, 4] as [number, number], minReasons: 3 } },
];

async function main() {
  const results: any[] = [];

  for (const exp of experiments) {
    const start = Date.now();
    console.log(`\n===== ${exp.name}: ${exp.desc} =====`);

    try {
      const result = await runBacktest({
        dataDir: DATA_DIR,
        codes: CODES,
        minSignalGrade: exp.minSignalGrade,
        maxHoldDays: exp.maxHoldDays || 5,
        warmupBars: 60,
        gate4Config: exp.gate4Config,
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

  // 输出汇总
  console.log('\n\n===== 汇总 =====');
  console.log(JSON.stringify(results, null, 2));

  // 保存到文件
  fs.writeFileSync('/tmp/minSignalGrade_results.json', JSON.stringify(results, null, 2));
  console.log('\n结果已保存到 /tmp/minSignalGrade_results.json');
}

main().catch(console.error);
