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

const topParams: Record<string, any> = {};

for (const code of ALL_CODES) {
  const file = path.join(dataDir, `${code}_1000Experiments.json`);
  if (!fs.existsSync(file)) continue;
  
  const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
  const experiments: ExpResult[] = data.fullResults || [];
  if (experiments.length === 0) continue;
  
  // 筛选稳健配方: 盈利 + 回撤<25% + 胜率>=40% + PF>=1.2
  const robust = experiments.filter(e => 
    e.stats.totalPnl > 0 &&
    e.stats.maxDrawdown < 0.25 &&
    e.stats.winRate >= 0.40 &&
    e.stats.profitFactor >= 1.2
  );
  
  // 按综合得分排序: 0.4*收益归一化 + 0.3*PF归一化 + 0.2*(1-回撤)归一化 + 0.1*胜率归一化
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
  
  // 取TOP1
  if (scored.length > 0) {
    const top = scored[0];
    topParams[code] = {
      recipe: top.recipe,
      stats: {
        totalPnl: top.stats.totalPnl,
        winRate: (top.stats.winRate * 100).toFixed(1) + '%',
        maxDrawdown: (top.stats.maxDrawdown * 100).toFixed(1) + '%',
        profitFactor: top.stats.profitFactor.toFixed(2),
        totalTrades: top.stats.totalTrades,
      },
      robustCount: robust.length,
      robustPct: (robust.length / experiments.length * 100).toFixed(1) + '%'
    };
  }
}

// 输出JSON供后续使用
fs.writeFileSync(
  path.join(dataDir, '_topParams.json'),
  JSON.stringify(topParams, null, 2)
);

// 打印摘要
console.log('='.repeat(120));
console.log('各品种 TOP1 稳健配方 (盈利+回撤<25%+胜率≥40%+PF≥1.2)');
console.log('='.repeat(120));
console.log('');

for (const code of ALL_CODES) {
  const p = topParams[code];
  if (!p) {
    console.log(`❌ ${code}: 无稳健配方`);
    continue;
  }
  const r = p.recipe;
  const s = p.stats;
  console.log(`✓ ${code} | 收益${s.totalPnl}元 胜率${s.winRate} 回撤${s.maxDrawdown} PF${s.profitFactor} 交易${s.totalTrades}笔 | 稳健${p.robustPct}`);
  console.log(`    参数: grade=${r.minSignalGrade} trend=${r.trendFilter} cooldown=${r.cooldownBars} stop=${r.stopAtrMult} target=${r.targetAtrMult} hold=${r.maxHoldDays} dir=${r.directionMode} window=${r.dataWindow} cb=${r.circuitBreaker} vol=${r.volReduce} bs=${r.bsMode}`);
  console.log('');
}
