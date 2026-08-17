/**
 * 方向阵营降级对照实验（25组）
 * 
 * 实验维度：
 * - 非GREEN降级倍率 (nonGreenMul)
 * - 逆阵营降级倍率 (counterCampMul)
 * - 方向阵营窗口 (campWindow)
 * - 组合降级
 * - 交叉验证（持仓周期、信号等级）
 */

import { runBacktest } from '../services/backtestEngine';

const CACHE_DIR = process.env.DAILY_CACHE_DIR || '/workspace/projects/server/data-cache-daily-long';

interface ExperimentConfig {
  name: string;
  desc: string;
  nonGreenMul?: number;
  counterCampMul?: number;
  campWindow?: number;
  maxHoldDays?: number;
  minSignalGrade?: string;
}

const experiments: ExperimentConfig[] = [
  // 第一类：非GREEN降级倍率扫描（Q0-Q5）
  { name: 'Q00', desc: '非GREEN不降级(1.0)', nonGreenMul: 1.0, counterCampMul: 1.0 },
  { name: 'Q01', desc: '非GREEN轻度降级(0.85)', nonGreenMul: 0.85, counterCampMul: 1.0 },
  { name: 'Q02', desc: '非GREEN偏轻降级(0.70)', nonGreenMul: 0.70, counterCampMul: 1.0 },
  { name: 'Q03', desc: '非GREEN基线(0.50)', nonGreenMul: 0.50, counterCampMul: 0.25 },
  { name: 'Q04', desc: '非GREEN偏重降级(0.35)', nonGreenMul: 0.35, counterCampMul: 0.25 },
  { name: 'Q05', desc: '非GREEN重度降级(0.20)', nonGreenMul: 0.20, counterCampMul: 0.25 },

  // 第二类：逆阵营降级倍率扫描（Q6-Q10）
  { name: 'Q06', desc: '逆阵营不降级(1.0)', nonGreenMul: 1.0, counterCampMul: 1.0 },
  { name: 'Q07', desc: '逆阵营轻度降级(0.50)', nonGreenMul: 0.50, counterCampMul: 0.50 },
  { name: 'Q08', desc: '逆阵营基线(0.25)', nonGreenMul: 0.50, counterCampMul: 0.25 },
  { name: 'Q09', desc: '逆阵营重度降级(0.15)', nonGreenMul: 0.50, counterCampMul: 0.15 },
  { name: 'Q10', desc: '逆阵营硬过滤(0.0)', nonGreenMul: 0.50, counterCampMul: 0.0 },

  // 第三类：方向阵营窗口扫描（Q11-Q14）
  { name: 'Q11', desc: '窗口10(短期)', nonGreenMul: 0.50, counterCampMul: 0.25, campWindow: 10 },
  { name: 'Q12', desc: '窗口15(偏短期)', nonGreenMul: 0.50, counterCampMul: 0.25, campWindow: 15 },
  { name: 'Q13', desc: '窗口21(基线)', nonGreenMul: 0.50, counterCampMul: 0.25, campWindow: 21 },
  { name: 'Q14', desc: '窗口30(长期)', nonGreenMul: 0.50, counterCampMul: 0.25, campWindow: 30 },

  // 第四类：组合降级（Q15-Q18）
  { name: 'Q15', desc: '完全不降级', nonGreenMul: 1.0, counterCampMul: 1.0 },
  { name: 'Q16', desc: '轻度组合(0.7/0.5)', nonGreenMul: 0.7, counterCampMul: 0.5 },
  { name: 'Q17', desc: '基线组合(0.5/0.25)', nonGreenMul: 0.5, counterCampMul: 0.25 },
  { name: 'Q18', desc: '重度组合(0.3/0.1)', nonGreenMul: 0.3, counterCampMul: 0.1 },

  // 第五类：降级 × 持仓周期交叉（Q19-Q22）
  { name: 'Q19', desc: '不降级+8bar', nonGreenMul: 1.0, counterCampMul: 1.0, maxHoldDays: 8 },
  { name: 'Q20', desc: '不降级+15bar', nonGreenMul: 1.0, counterCampMul: 1.0, maxHoldDays: 15 },
  { name: 'Q21', desc: '当前降级+8bar', nonGreenMul: 0.5, counterCampMul: 0.25, maxHoldDays: 8 },
  { name: 'Q22', desc: '当前降级+15bar', nonGreenMul: 0.5, counterCampMul: 0.25, maxHoldDays: 15 },

  // 第六类：降级 × minSignalGrade 交叉（Q23-Q24）
  { name: 'Q23', desc: '不降级+L3', nonGreenMul: 1.0, counterCampMul: 1.0, minSignalGrade: 'L3' },
  { name: 'Q24', desc: '当前降级+L3', nonGreenMul: 0.5, counterCampMul: 0.25, minSignalGrade: 'L3' },
];

function formatPct(v: number | undefined): string {
  if (v == null) return 'N/A';
  return `${v.toFixed(1)}%`;
}

async function main() {
  console.log('=== 方向阵营降级对照实验（25组） ===\n');

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
    process.stdout.write(`${exp.name}: ${exp.desc}... `);

    const result = await runBacktest({
      dataDir: CACHE_DIR,
      allowRangeTrading: true,
      equationMode: 'none',
      minSignalGrade: exp.minSignalGrade || 'L2',
      maxHoldDays: exp.maxHoldDays ?? 15,
      nonGreenMul: exp.nonGreenMul,
      counterCampMul: exp.counterCampMul,
      campWindow: exp.campWindow,
    });

    const s = result.summary;
    const row = {
      name: exp.name,
      desc: exp.desc,
      trades: s.totalTrades,
      winRate: s.winRate * 100,
      returnPct: s.totalReturn * 100,
      pf: s.profitFactor,
      maxDd: s.maxDrawdown * 100,
    };
    results.push(row);

    console.log(`交易${row.trades}, 胜率${row.winRate.toFixed(1)}%, 收益${row.returnPct.toFixed(1)}%, PF=${row.pf.toFixed(2)}, 回撤${row.maxDd.toFixed(1)}%`);
  }

  // 汇总
  console.log('\n=== 汇总 ===\n');
  console.log('组\t配置\t交易数\t胜率\t收益率\tPF\t回撤');
  console.log('─'.repeat(80));
  for (const r of results) {
    console.log(`${r.name}\t${r.desc}\t${r.trades}\t${r.winRate.toFixed(1)}%\t${r.returnPct.toFixed(1)}%\t${r.pf.toFixed(2)}\t${r.maxDd.toFixed(1)}%`);
  }

  // 最优
  const best = results.reduce((a, b) => a.returnPct > b.returnPct ? a : b);
  console.log(`\n最优: ${best.name} ${best.desc} → 收益${best.returnPct.toFixed(1)}%, PF=${best.pf.toFixed(2)}`);
}

main().catch(console.error);
