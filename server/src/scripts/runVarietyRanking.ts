/**
 * 按品种回测（App最新逻辑）
 * 40个品种 × 全量历史，找出效果最好的品种
 * 
 * App最新配置：
 * - minSignalGrade = L2
 * - maxHoldDays = 15bar
 * - equationMode = none（移除方程）
 * - minRR = 1.0
 * - nonGreenMul / counterCampMul = 1.0（移除降级）
 * - cooldownBars = 0（移除冷却）
 * - allowRangeTrading = true（开放区间市）
 */
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine.js';
import { VARIETIES } from '../services/varieties.js';

const DATA_DIR = path.resolve(process.cwd(), 'data-cache-40v');

// App 最新逻辑配置
const APP_CFG = {
  minSignalGrade: 'L2',
  maxHoldDays: 15,
  equationMode: 'none' as const,
  minRR: 1.0,
  nonGreenMul: 1.0,
  counterCampMul: 1.0,
  cooldownBars: 0,
  allowRangeTrading: true,
  edgeLookback: 70,
  warmupBars: 60,
};

async function runOne(code: string) {
  const r = await runBacktest({
    dataDir: DATA_DIR,
    codes: [code],
    ...APP_CFG,
  });
  const s = r.summary;
  const ret = (s.finalEquity - 500000) / 500000 * 100;
  const maxDd = s.maxDrawdown ?? 0;
  return {
    code,
    trades: s.totalTrades,
    winRate: s.winRate ?? 0,
    ret,
    pf: s.profitFactor ?? 0,
    maxDd,
    retPerDd: maxDd > 0 ? ret / maxDd : 0,
  };
}

async function main() {
  const codes = Object.keys(VARIETIES);
  console.log(`共 ${codes.length} 个品种，按App最新逻辑回测（L2 + 15bar + 无方程 + RR≥1.0 + 无降级 + 无冷却 + 开放区间市）`);
  console.log('');

  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  for (const code of codes) {
    try {
      const res = await runOne(code);
      results.push(res);
      console.log(`✅ ${code}: ${res.trades}笔 胜率${res.winRate.toFixed(1)}% 收益${res.ret.toFixed(1)}% PF=${res.pf.toFixed(2)} 回撤${res.maxDd.toFixed(1)}%`);
    } catch (e) {
      console.log(`❌ ${code}: ${(e as Error).message}`);
    }
  }

  // 按收益率排序
  const sorted = [...results].sort((a, b) => b.ret - a.ret);

  console.log('');
  console.log('========== 品种收益排名（按收益率降序） ==========');
  console.log('排名  品种   交易数  胜率   收益率    PF    最大回撤  收益/回撤');
  sorted.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}    ${r.code.padEnd(4)}  ${String(r.trades).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${r.ret.toFixed(1).padStart(7)}%  ${r.pf.toFixed(2).padStart(5)}  ${r.maxDd.toFixed(1).padStart(6)}%  ${r.retPerDd.toFixed(2).padStart(6)}`
    );
  });

  // 统计
  const positive = sorted.filter((r) => r.ret > 0).length;
  const negative = sorted.length - positive;
  console.log('');
  console.log(`盈利品种: ${positive} / ${sorted.length}, 亏损品种: ${negative}`);

  const top10 = sorted.slice(0, 10);
  console.log('');
  console.log('===== TOP 10 品种 =====');
  top10.forEach((r, i) => console.log(`${i + 1}. ${r.code}: 收益${r.ret.toFixed(1)}% PF=${r.pf.toFixed(2)} 回撤${r.maxDd.toFixed(1)}% 收益/回撤${r.retPerDd.toFixed(2)}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
