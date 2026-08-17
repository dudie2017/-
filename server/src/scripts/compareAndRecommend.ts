import fs from 'fs';
import path from 'path';

const ALL_CODES = [
  'SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0',
  'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0', 'SI0',
  'IC0', 'IF0', 'IH0', 'IM0', 'HC0', 'NI0', 'PB0', 'ZN0', 'SP0'
];

const dataDir = path.join(process.cwd(), 'src/data');

interface ExpResult {
  id: number;
  recipe: Record<string, any>;
  stats: {
    totalTrades: number;
    winRate: number;
    totalPnl: number;
    maxDrawdown: number;
    profitFactor: number;
    avgRR: number;
    capture: number;
  };
}

// 当前 App 参数
const CURRENT_PARAMS: Record<string, any> = {
  SI0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  IC0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  SC0: { maxPositionPct: 0.30, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  JM0: { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  RU0: { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  AU0: { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  I0:  { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  CU0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  M0:  { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '5x20' },
  AG0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  RB0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  CF0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  Y0:  { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  J0:  { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  AL0: { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  P0:  { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  TA0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  LH0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  IF0: { maxPositionPct: 0.20, volReduce: 'atr2xClear', dailyLossLimit: '5pct', circuitBreaker: '3x10' },
  IH0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  IM0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  HC0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  NI0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  ZN0: { maxPositionPct: 0.15, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  PB0: { maxPositionPct: 0.10, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
  SP0: { maxPositionPct: 0.10, volReduce: 'off', dailyLossLimit: 'off', circuitBreaker: '3x10' },
};

console.log('='.repeat(120));
console.log('修复后回测 vs 当前 App 参数对比分析');
console.log('='.repeat(120));
console.log('');

const recommendations: any[] = [];

for (const code of ALL_CODES) {
  const file = path.join(dataDir, `${code}_1000Experiments.json`);
  if (!fs.existsSync(file)) continue;
  
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const experiments: ExpResult[] = data.fullResults || [];
  if (experiments.length === 0) continue;
  
  // 筛选稳健配方
  const robust = experiments.filter(e => 
    e.stats.totalPnl > 0 &&
    e.stats.maxDrawdown < 0.25 &&
    e.stats.winRate >= 0.40 &&
    e.stats.profitFactor >= 1.2
  );
  
  if (robust.length === 0) {
    console.log(`❌ ${code}: 无稳健配方，建议暂时不纳入App`);
    continue;
  }
  
  // 综合评分
  const maxPnl = Math.max(...robust.map(e => e.stats.totalPnl), 1);
  const maxPF = Math.max(...robust.map(e => e.stats.profitFactor), 1);
  
  const scored = robust.map(e => ({
    ...e,
    score: 0.4 * (e.stats.totalPnl / maxPnl) +
           0.3 * (e.stats.profitFactor / maxPF) +
           0.2 * (1 - e.stats.maxDrawdown) +
           0.1 * e.stats.winRate
  }));
  
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  const r = top.recipe;
  const s = top.stats;
  
  // 当前参数
  const cur = CURRENT_PARAMS[code];
  
  // 分析差异
  const changes: string[] = [];
  
  // volReduce 对比
  if (cur.volReduce !== r.volReduce) {
    changes.push(`volReduce: ${cur.volReduce} → ${r.volReduce}`);
  }
  
  // circuitBreaker 对比
  const topCB = r.circuitBreaker === 'off' ? 'off' : r.circuitBreaker;
  if (cur.circuitBreaker !== topCB) {
    changes.push(`circuitBreaker: ${cur.circuitBreaker} → ${topCB}`);
  }
  
  // dailyLossLimit 对比
  if (cur.dailyLossLimit !== r.dailyLossLimit) {
    changes.push(`dailyLossLimit: ${cur.dailyLossLimit} → ${r.dailyLossLimit}`);
  }
  
  // 仓位建议
  let recPosition = cur.maxPositionPct;
  if (s.maxDrawdown < 0.05 && s.profitFactor > 2.0) {
    recPosition = Math.min(0.25, cur.maxPositionPct + 0.05);
  } else if (s.maxDrawdown > 0.15 || s.profitFactor < 1.5) {
    recPosition = Math.max(0.10, cur.maxPositionPct - 0.05);
  }
  if (recPosition !== cur.maxPositionPct) {
    changes.push(`maxPositionPct: ${(cur.maxPositionPct*100).toFixed(0)}% → ${(recPosition*100).toFixed(0)}%`);
  }
  
  const robustPct = (robust.length / experiments.length * 100).toFixed(1);
  
  recommendations.push({
    code,
    current: cur,
    topRecipe: r,
    topStats: s,
    robustPct: parseFloat(robustPct),
    changes,
    recPosition
  });
  
  if (changes.length > 0) {
    console.log(`📊 ${code} | 收益${s.totalPnl.toFixed(0)}元 胜率${(s.winRate*100).toFixed(1)}% 回撤${(s.maxDrawdown*100).toFixed(1)}% PF${s.profitFactor.toFixed(2)} | 稳健${robustPct}%`);
    console.log(`   变更: ${changes.join(' | ')}`);
    console.log('');
  } else {
    console.log(`✅ ${code} | 收益${s.totalPnl.toFixed(0)}元 胜率${(s.winRate*100).toFixed(1)}% 回撤${(s.maxDrawdown*100).toFixed(1)}% PF${s.profitFactor.toFixed(2)} | 当前参数已最优`);
  }
}

console.log('');
console.log('='.repeat(120));
console.log('优化建议汇总');
console.log('='.repeat(120));

const needChange = recommendations.filter(r => r.changes.length > 0);
const noChange = recommendations.filter(r => r.changes.length === 0);

console.log(`\n需调整: ${needChange.length} 个品种`);
for (const r of needChange) {
  console.log(`  ${r.code}: ${r.changes.join(', ')}`);
}

console.log(`\n无需调整: ${noChange.length} 个品种`);
for (const r of noChange) {
  console.log(`  ${r.code}: 当前参数已最优`);
}
