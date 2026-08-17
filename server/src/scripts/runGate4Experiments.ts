/**
 * Gate4 对照回测实验
 * 在方案B（区间开放）基础上，测试10种 Gate4 配置
 * 10品种 × 10年日线
 */
import { runBacktest } from '../services/backtestEngine';
import type { Gate4Config } from '../services/v16_engine';

const DATA_DIR = '/workspace/projects/server/data-cache-daily-long';
const CODES = ['RB0', 'CU0', 'AG0', 'M0', 'MA0', 'BU0', 'SA0', 'I0', 'Y0', 'TA0'];

interface Experiment {
  name: string;
  gate4Config?: Gate4Config;
  desc: string;
}

const experiments: Experiment[] = [
  { name: 'G0_基线', desc: 'Gate4 ≥3/5（当前）', gate4Config: { minReasons: 3 } },
  { name: 'G1_关闭Gate4', desc: '完全关闭Gate4', gate4Config: { minReasons: 0 } },
  { name: 'G2_门槛4', desc: 'Gate4 ≥4/5', gate4Config: { minReasons: 4 } },
  { name: 'G3_门槛5', desc: 'Gate4 ≥5/5（全部通过）', gate4Config: { minReasons: 5 } },
  { name: 'G4_关理由1', desc: '关闭AI方向一致', gate4Config: { minReasons: 2, disabledReasons: [1] } },
  { name: 'G5_关理由3', desc: '关闭量仓确认', gate4Config: { minReasons: 2, disabledReasons: [3] } },
  { name: 'G6_关理由4', desc: '关闭趋势健康', gate4Config: { minReasons: 2, disabledReasons: [4] } },
  { name: 'G7_关理由5', desc: '关闭R:R', gate4Config: { minReasons: 2, disabledReasons: [5] } },
  { name: 'G8_核心确认', desc: '理由1+2必须 + 3/4/5至少1个', gate4Config: { minReasons: 3, requiredReasons: [1, 2] } },
  { name: 'G9_合并1+4', desc: '理由1+4合并为趋势确认，4理由≥3/4', gate4Config: { minReasons: 3, mergeReasons: [1, 4] } },
];

async function runExperiment(exp: Experiment) {
  const start = Date.now();
  const result = await runBacktest({
    dataDir: DATA_DIR,
    codes: CODES,
    minSignalGrade: 'L3',
    maxHoldDays: 5,
    warmupBars: 60,
    allowRangeTrading: true,
    gate4Config: exp.gate4Config,
  });

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const s = result.summary || {};
  const winRate = s.winRate ?? 0;
  const avgRR = s.avgRR ?? 0;
  const totalReturn = s.totalReturn ?? 0;
  const sharpe = s.sharpe ?? 0;
  const maxDrawdown = s.maxDrawdown ?? 0;
  console.log(`===== ${exp.name}: ${exp.desc} =====`);
  console.log(`[回测v2] 总${s.totalTrades ?? 0}笔 胜率${(winRate * 100).toFixed(1)}% R:R=${avgRR.toFixed(2)} 收益${(totalReturn * 100).toFixed(1)}% 夏普${sharpe.toFixed(2)} 回撤${(maxDrawdown * 100).toFixed(1)}%`);

  return {
    exp: exp.name,
    desc: exp.desc,
    elapsedSec: parseFloat(elapsed),
    totalTrades: s.totalTrades ?? 0,
    winRate,
    avgRR,
    totalReturn,
    sharpe,
    maxDrawdown,
    profitFactor: s.profitFactor ?? 0,
  };
}

async function main() {
  console.log('=== Gate4 对照回测实验 ===');
  console.log(`数据: ${DATA_DIR}`);
  console.log(`品种: ${CODES.join(', ')}`);
  console.log(`实验组: ${experiments.length}`);
  console.log();

  const results = [];
  for (const exp of experiments) {
    try {
      const r = await runExperiment(exp);
      results.push(r);
    } catch (err) {
      console.error(`${exp.name} 失败:`, err);
      results.push({ exp: exp.name, error: String(err) });
    }
  }

  console.log('\n=== 完整结果 JSON ===');
  console.log(JSON.stringify(results, null, 2));
}

main().catch(console.error);
