import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '../../data-cache-daily-20y');

const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  WR0: '煤炭', ZC0: '煤炭',
  RU0: '能源', FU0: '能源', BU0: '能源', LU0: '能源', SC0: '能源', PG0: '能源', NR0: '能源',
  MA0: '化工', TA0: '化工', EG0: '化工', PF0: '化工', L0: '化工', V0: '化工', PP0: '化工', PE0: '化工', PS0: '化工', PR0: '化工',
  CF0: '纺织', SR0: '纺织', CJ0: '纺织', AP0: '纺织',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', C0: '油脂油料', P0: '油脂油料', CS0: '油脂油料',
  JD0: '农产品', LH0: '农产品',
  AU0: '贵金属', AG0: '贵金属',
  IC0: '股指', IF0: '股指', IH0: '股指', IM0: '股指',
  T0: '债券', TF0: '债券', TS0: '债券', TL0: '债券',
  LC0: '新能源', SI0: '新能源',
  SP0: '纸浆', BC0: '纸浆',
  EC0: '集运指数',
};

const uncovered = ['SF0','SM0','JD0','LH0','EC0','BU0','CJ0','PG0','SR0','P0','PP0','SA0','BC0','EG0','NR0'];

interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number; }
function loadBars(v: string): Bar[] {
  const fp = path.join(dataDir, `${v}.json`);
  if (!fs.existsSync(fp)) return [];
  const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return raw.map((r: any) => ({
    date: r.date,
    open: r.o ?? r[1] ?? r.open,
    high: r.h ?? r[2] ?? r.high,
    low: r.l ?? r[3] ?? r.low,
    close: r.c ?? r[4] ?? r.close,
    volume: r.vol ?? r[5] ?? r.volume,
  }));
}

// Find pairs where uncovered variety is leader
for (const leader of uncovered) {
  const leaderBars = loadBars(leader);
  if (leaderBars.length < 100) { console.log(`${leader}: 数据不足(${leaderBars.length} bars)`); continue; }
  
  const leaderSector = SECTOR_MAP[leader] || '未分类';
  const results: { follower: string; lag: number; hitRate: number; sample: number; sector: string; }[] = [];
  
  for (const follower of Object.keys(SECTOR_MAP)) {
    if (follower === leader) continue;
    const fBars = loadBars(follower);
    if (fBars.length < 100) continue;
    
    // Check same direction at lag 1-5
    for (const lag of [1, 2, 3, 4, 5]) {
      let sameDir = 0, total = 0;
      for (let i = lag; i < leaderBars.length && i < fBars.length; i++) {
        const lRet = leaderBars[i].close - leaderBars[i-1].close;
        const fRet = fBars[i].close - fBars[i-lag].close;
        if (lRet !== 0 && fRet !== 0) {
          total++;
          if ((lRet > 0 && fRet > 0) || (lRet < 0 && fRet < 0)) sameDir++;
        }
      }
      const hr = total > 0 ? sameDir / total : 0;
      if (hr >= 0.50 && total >= 5) {
        results.push({ follower, lag, hitRate: hr, sample: total, sector: SECTOR_MAP[follower] || '未分类' });
      }
    }
  }
  
  // Deduplicate: keep best lag per follower
  const bestPerFollower = new Map<string, typeof results[0]>();
  for (const r of results) {
    const existing = bestPerFollower.get(r.follower);
    if (!existing || r.hitRate > existing.hitRate) bestPerFollower.set(r.follower, r);
  }
  
  const best = Array.from(bestPerFollower.values()).sort((a, b) => b.hitRate - a.hitRate).slice(0, 5);
  if (best.length > 0) {
    console.log(`\n${leader} (${leaderSector}): ${best.length} 个高命中率follower`);
    for (const b of best) {
      console.log(`  ${leader}→${b.follower}: lag=${b.lag}, HR=${(b.hitRate*100).toFixed(0)}%, N=${b.sample}, 板块=${b.sector}`);
    }
  }
}
