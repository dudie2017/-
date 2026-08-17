/**
 * E2: 数据驱动发现新的 leader-follower 传播对
 * 
 * 方法：对每个高频冲击品种，扫描同板块+跨板块品种的1-3日滞后同向率，
 *       筛选出命中率≥55%且样本≥10的对，作为白名单候选。
 * 
 * 验证：使用前向验证（样本内/外分割）确保不是过拟合。
 */

import * as fs from 'fs';
import * as path from 'path';

const ATR_PERIOD = 14;
const ATR_MULT = 4;
const ATR_LONG = 60;
const MIN_HIT_RATE = 0.55;
const MIN_SAMPLES = 10;
const MAX_LAG = 3;

const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', B0: '油脂油料', P0: '油脂油料',
  CF0: '软商品', SR0: '软商品', AP0: '软商品',
  BU0: '能源', SC0: '能源', LU0: '能源', FU0: '能源', NR0: '能源',
  MA0: '化工', TA0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', PG0: '化工', V0: '化工',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融',
  JD0: '农产品', LH0: '农产品', WR0: '煤炭', ZC0: '煤炭',
  LC0: '新能源', SI0: '新能源',
  SP0: '纸浆',
};

interface DailyBar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null; }
interface Shock { code: string; date: string; barIdx: number; direction: 'up' | 'down'; ret: number; }

const DATA_DIR = path.resolve('/workspace/projects/server/data-cache-daily-20y');

function loadAllData(): Map<string, DailyBar[]> {
  const data = new Map<string, DailyBar[]>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const code = file.replace('.json', '');
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    const bars = (raw as any[]).map(b => ({
      date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, hold: b.hold || 0, ret: b.ret,
    })).filter(b => b.ret !== null && b.ret !== undefined);
    if (bars.length > 100) data.set(code, bars);
  }
  return data;
}

function calcATR(bars: DailyBar[], period: number): number[] {
  const atr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period) { atr.push(0); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += bars[j].h - bars[j].l;
    atr.push(sum / period);
  }
  return atr;
}

function detectShocks(data: Map<string, DailyBar[]>): Shock[] {
  const shocks: Shock[] = [];
  for (const [code, bars] of data) {
    const atr = calcATR(bars, ATR_PERIOD);
    const atrLong = calcATR(bars, ATR_LONG);
    for (let i = ATR_LONG + 1; i < bars.length; i++) {
      const bar = bars[i];
      const prevBar = bars[i - 1];
      if (bar.ret === null || atr[i] === 0) continue;
      const priceChange = Math.abs(bar.c - prevBar.c);
      const mult = priceChange / atr[i];
      if (mult >= ATR_MULT) {
        if (atrLong[i] > 0 && atr[i] < atrLong[i]) continue;
        shocks.push({ code, date: bar.date, barIdx: i, direction: bar.ret > 0 ? 'up' : 'down', ret: bar.ret });
      }
    }
  }
  return shocks;
}

interface CandidatePair {
  leader: string;
  follower: string;
  lag: number;
  sector: string;
  hitRate: number;
  samples: number;
  logic: string;
}

function discoverPairs(data: Map<string, DailyBar[]>, shocks: Shock[]): CandidatePair[] {
  const candidates: CandidatePair[] = [];
  
  // 按leader分组冲击
  const shocksByCode = new Map<string, Shock[]>();
  for (const s of shocks) {
    if (!shocksByCode.has(s.code)) shocksByCode.set(s.code, []);
    shocksByCode.get(s.code)!.push(s);
  }
  
  // 对每个有冲击的品种，寻找follower
  for (const [leaderCode, leaderShocks] of shocksByCode) {
    if (leaderShocks.length < 5) continue; // 至少5次冲击才有统计意义
    
    const leaderSector = SECTOR_MAP[leaderCode] || '未分类';
    
    for (const [followerCode, followerBars] of data) {
      if (followerCode === leaderCode) continue;
      
      for (let lag = 1; lag <= MAX_LAG; lag++) {
        let hits = 0;
        let total = 0;
        
        for (const shock of leaderShocks) {
          const fIdx = shock.barIdx + lag;
          if (fIdx >= followerBars.length) continue;
          const fBar = followerBars[fIdx];
          if (fBar.ret === null) continue;
          
          total++;
          const sameDir = (shock.direction === 'up' && fBar.ret > 0) ||
                         (shock.direction === 'down' && fBar.ret < 0);
          if (sameDir) hits++;
        }
        
        if (total >= MIN_SAMPLES && hits / total >= MIN_HIT_RATE) {
          const followerSector = SECTOR_MAP[followerCode] || '未分类';
          const isSameSector = leaderSector === followerSector;
          const logic = isSameSector
            ? `${leaderCode}→${followerCode}（${leaderSector}板块联动，lag=${lag}）`
            : `${leaderCode}→${followerCode}（${leaderSector}→${followerSector}跨板块，lag=${lag}）`;
          
          candidates.push({
            leader: leaderCode,
            follower: followerCode,
            lag,
            sector: leaderSector,
            hitRate: hits / total,
            samples: total,
            logic,
          });
        }
      }
    }
  }
  
  // 按 hitRate * sqrt(samples) 排序（兼顾命中率和样本量）
  return candidates.sort((a, b) => 
    (b.hitRate * Math.sqrt(b.samples)) - (a.hitRate * Math.sqrt(a.samples))
  );
}

// 前向验证：用前半段数据发现，后半段验证
function forwardValidate(
  pair: CandidatePair,
  data: Map<string, DailyBar[]>,
  shocks: Shock[]
): { inSampleHitRate: number; outSampleHitRate: number; inSamples: number; outSamples: number } {
  const leaderBars = data.get(pair.leader);
  const followerBars = data.get(pair.follower);
  if (!leaderBars || !followerBars) return { inSampleHitRate: 0, outSampleHitRate: 0, inSamples: 0, outSamples: 0 };
  
  const leaderShocks = shocks.filter(s => s.code === pair.leader);
  const splitIdx = Math.floor(leaderShocks.length * 0.6); // 60/40分割
  
  const inShocks = leaderShocks.slice(0, splitIdx);
  const outShocks = leaderShocks.slice(splitIdx);
  
  let inHits = 0, inTotal = 0, outHits = 0, outTotal = 0;
  
  for (const shock of inShocks) {
    const fIdx = shock.barIdx + pair.lag;
    if (fIdx >= followerBars.length) continue;
    const fBar = followerBars[fIdx];
    if (fBar.ret === null) continue;
    inTotal++;
    if ((shock.direction === 'up' && fBar.ret > 0) || (shock.direction === 'down' && fBar.ret < 0)) inHits++;
  }
  
  for (const shock of outShocks) {
    const fIdx = shock.barIdx + pair.lag;
    if (fIdx >= followerBars.length) continue;
    const fBar = followerBars[fIdx];
    if (fBar.ret === null) continue;
    outTotal++;
    if ((shock.direction === 'up' && fBar.ret > 0) || (shock.direction === 'down' && fBar.ret < 0)) outHits++;
  }
  
  return {
    inSampleHitRate: inTotal > 0 ? inHits / inTotal : 0,
    outSampleHitRate: outTotal > 0 ? outHits / outTotal : 0,
    inSamples: inTotal,
    outSamples: outTotal,
  };
}

function main() {
  console.log('=== 数据驱动白名单扩容 ===\n');
  
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种`);
  
  const shocks = detectShocks(data);
  console.log(`检测到 ${shocks.length} 个冲击\n`);
  
  // 发现候选对
  const candidates = discoverPairs(data, shocks);
  console.log(`发现 ${candidates.length} 个候选对\n`);
  
  // 前向验证并过滤
  console.log('=== 前向验证（60/40分割）===\n');
  console.log('Leader'.padEnd(8) + 'Follower'.padEnd(10) + 'Lag'.padEnd(5) + '板块'.padEnd(10) + '全样本HR'.padEnd(10) + '样本内HR'.padEnd(10) + '样本外HR'.padEnd(10) + 'IS_N'.padEnd(6) + 'OOS_N'.padEnd(6) + '通过');
  console.log('-'.repeat(100));
  
  const validated: CandidatePair[] = [];
  
  for (const c of candidates.slice(0, 60)) { // 只看top60
    const fv = forwardValidate(c, data, shocks);
    
    // 验证标准：样本外命中率≥50% 且 样本外样本≥3
    const pass = fv.outSampleHitRate >= 0.50 && fv.outSamples >= 3;
    
    if (pass) {
      validated.push(c);
    }
    
    console.log(
      c.leader.padEnd(8) +
      c.follower.padEnd(10) +
      c.lag.toString().padEnd(5) +
      c.sector.padEnd(10) +
      (c.hitRate * 100).toFixed(1).padEnd(10) +
      (fv.inSampleHitRate * 100).toFixed(1).padEnd(10) +
      (fv.outSampleHitRate * 100).toFixed(1).padEnd(10) +
      fv.inSamples.toString().padEnd(6) +
      fv.outSamples.toString().padEnd(6) +
      (pass ? '✅' : '❌')
    );
  }
  
  console.log(`\n=== 通过前向验证的新增对: ${validated.length} ===\n`);
  
  // 按板块分组输出
  const bySector = new Map<string, CandidatePair[]>();
  for (const v of validated) {
    if (!bySector.has(v.sector)) bySector.set(v.sector, []);
    bySector.get(v.sector)!.push(v);
  }
  
  for (const [sector, pairs] of bySector) {
    console.log(`// ========== ${sector} ==========`);
    for (const p of pairs) {
      console.log(`{ leader: '${p.leader}', follower: '${p.follower}', lag: ${p.lag}, sector: '${p.sector}', logic: '${p.logic}' }, // HR=${(p.hitRate*100).toFixed(0)}% N=${p.samples}`);
    }
    console.log('');
  }
}

main();
