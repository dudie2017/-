/**
 * 品种×事件类别 敏感度矩阵分析（v3 事件驱动方案）
 * 1. 对每个品种，直接用事件库中的事件日期计算冲击后收益
 * 2. 对每个品种，用 ATR 全冲击扫描做总体敏感度画像
 * 3. 输出：品种×类别 完整敏感度矩阵
 */
import * as fs from 'fs';
import * as path from 'path';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';

// ============ 类型 ============
interface DailyBar {
  date: string; o: number; h: number; l: number; c: number;
  vol: number | null; hold: number | null; ret: number | null;
}

interface EventImpact {
  eventId: string;
  eventTitle: string;
  eventDate: string;
  direction: '利多' | '利空' | '中性';
  consensus: string;
  // 事件日及附近数据
  shockRet: number | null;     // 事件日涨跌幅%
  shockATR: number | null;     // 事件日ATR
  shockAtrMult: number | null; // 事件日|ret|/ATR
  // 后续收益（有向：正=延续共识方向）
  after1d: number | null;
  after3d: number | null;
  after5d: number | null;
  after10d: number | null;
  after20d: number | null;
  // 最大 adverse
  maxAdverse10d: number | null;
}

interface CategoryStats {
  catId: number;
  catName: string;
  eventCount: number;          // 事件数
  validCount: number;          // 有数据的冲击数
  avgAtrMult: number;          // 平均ATR倍数（冲击强度）
  avgAbsRet: number;           // 事件日平均|涨跌幅|%
  after1d: number;             // 有向收益
  after3d: number;
  after5d: number;
  after10d: number;
  after20d: number;
  continuationRate: number;    // 10日延续率%
  contrarianRate: number;      // 反直觉率%
  maxAdverse10d: number;       // 10日最大 adverse%
}

interface VarietyResult {
  code: string;
  sector: string;
  totalBars: number;
  // ATR 全冲击画像
  totalAtrShocks: number;
  overallSensitivity: number;  // 平均ATR倍数
  overallAfter10d: number;     // 全冲击后10日有向收益
  overallContinuation: number; // 全冲击10日延续率
  // 事件驱动分析
  totalEvents: number;         // 影响该品种的事件总数
  categories: CategoryStats[];
  eventImpacts: EventImpact[]; // 所有事件的详细影响
}

// ============ 板块映射 ============
const SECTOR_DEFS: [string, string[]][] = [
  ['贵金属', ['AU0', 'AG0']],
  ['有色', ['CU0', 'AL0', 'ZN0', 'PB0', 'NI0', 'SN0', 'SS0']],
  ['黑色系', ['RB0', 'HC0', 'I0', 'J0', 'JM0', 'ZC0', 'SF0', 'SM0']],
  ['能源', ['SC0', 'FU0', 'BU0', 'LU0']],
  ['化工', ['MA0', 'TA0', 'PP0', 'PE0', 'PG0', 'EB0', 'SA0', 'EG0', 'PF0', 'L0', 'V0', 'UR0']],
  ['油脂油料', ['M0', 'Y0', 'OI0', 'RM0', 'P0', 'C0', 'CS0', 'A0']],
  ['软商品', ['CF0', 'SR0', 'AP0', 'CJ0', 'PK0']],
  ['养殖', ['JD0', 'LH0']],
  ['金融', ['IF0', 'IC0', 'IH0', 'IM0', 'T0', 'TF0', 'TS0']],
  ['新兴', ['AO0', 'BC0', 'EC0', 'LC0', 'SI0', 'NR0', 'RU0']],
  ['建材', ['FG0', 'WR0']],
];

const codeToSector = new Map<string, string>();
for (const [sector, codes] of SECTOR_DEFS) {
  for (const c of codes) codeToSector.set(c, sector);
}
function getSector(code: string): string { return codeToSector.get(code) || '其他'; }

const CAT_NAMES: Record<number, string> = {
  1: '地缘政治', 2: '宏观经济', 3: '政策监管', 4: '天气气候',
  5: '自然灾害', 6: '疾病疫情', 7: '供给端减产', 8: '供需失衡',
  9: '行业事件', 10: '交易制度',
};

// ============ 工具函数 ============
function computeATR(bars: DailyBar[], period: number): (number | null)[] {
  const atr: (number | null)[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 1) { atr.push(null); continue; }
    const start = Math.max(1, i - period + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) {
      sum += Math.max(bars[j].h - bars[j].l, Math.abs(bars[j].h - bars[j - 1].c), Math.abs(bars[j].l - bars[j - 1].c));
    }
    atr.push(sum / (i - start + 1));
  }
  return atr;
}

function detectAllShocks(bars: DailyBar[], atrArr: (number | null)[]): { index: number; direction: 'up' | 'down'; atrMult: number; ret: number }[] {
  const shocks: { index: number; direction: 'up' | 'down'; atrMult: number; ret: number }[] = [];
  let lastIdx = -10;
  for (let i = 20; i < bars.length; i++) {
    const atr = atrArr[i];
    if (!atr || atr <= 0) continue;
    const atrPct = (atr / bars[i - 1].c) * 100;
    if (atrPct <= 0) continue;
    const ret = bars[i].ret;
    if (ret === null || ret === undefined) continue;
    const retPct = ret * 100;
    const atrMult = Math.abs(retPct) / atrPct;
    if (atrMult > 3 && i - lastIdx >= 5) {
      shocks.push({ index: i, direction: retPct > 0 ? 'up' : 'down', atrMult, ret: retPct });
      lastIdx = i;
    }
  }
  return shocks;
}

// Find closest bar index to a date
function findDateIndex(bars: DailyBar[], date: string): number {
  const target = new Date(date).getTime();
  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].date).getTime();
    const dist = Math.abs(d - target);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  // Must be within 7 days
  return bestDist <= 7 * 86400000 ? bestIdx : -1;
}

// ============ 核心分析 ============
function analyzeVariety(code: string, bars: DailyBar[]): VarietyResult {
  const atrArr = computeATR(bars, 14);
  const allShocks = detectAllShocks(bars, atrArr);

  // Build date->index map
  const dateToIdx = new Map<string, number>();
  for (let i = 0; i < bars.length; i++) {
    dateToIdx.set(bars[i].date, i);
  }

  // Find all events affecting this variety
  const myEvents = BLACK_SWAN_EVENTS.filter(e => e.varieties.includes(code));

  // Analyze each event's impact
  const eventImpacts: EventImpact[] = [];
  const eventsByCategory = new Map<number, EventImpact[]>();
  for (let catId = 1; catId <= 10; catId++) eventsByCategory.set(catId, []);

  for (const evt of myEvents) {
    const idx = findDateIndex(bars, evt.date);
    if (idx < 1 || idx >= bars.length - 1) continue;

    const bar = bars[idx];
    const prevBar = bars[idx - 1];
    const atr = atrArr[idx];

    // Event day stats
    const shockRet = bar.ret !== null ? bar.ret * 100 : null;
    const shockATR = atr ? (atr / prevBar.c) * 100 : null;
    const shockAtrMult = (shockRet !== null && shockATR && shockATR > 0) ? Math.abs(shockRet) / shockATR : null;

    // Directional after-N-day returns (positive = in consensus direction)
    const consensusDir = evt.direction === '利多' ? 1 : evt.direction === '利空' ? -1 : 0;

    function dirAfter(nd: number): number | null {
      if (idx + nd >= bars.length || consensusDir === 0) return null;
      const retPct = ((bars[idx + nd].c - bar.c) / bar.c) * 100;
      return retPct * consensusDir; // positive = continuation
    }

    // Max adverse excursion (10d)
    let maxAdverse: number | null = null;
    if (idx + 10 < bars.length && shockRet !== null) {
      const shockDir = shockRet > 0 ? 'up' : 'down';
      let worst = 0;
      for (let d = 1; d <= 10 && idx + d < bars.length; d++) {
        const retPct = ((bars[idx + d].c - bar.c) / bar.c) * 100;
        const adverse = shockDir === 'up' ? -retPct : retPct;
        if (adverse > worst) worst = adverse;
      }
      maxAdverse = worst;
    }

    const impact: EventImpact = {
      eventId: evt.id,
      eventTitle: evt.title,
      eventDate: evt.date,
      direction: evt.direction,
      consensus: evt.consensus,
      shockRet,
      shockATR,
      shockAtrMult,
      after1d: dirAfter(1),
      after3d: dirAfter(3),
      after5d: dirAfter(5),
      after10d: dirAfter(10),
      after20d: dirAfter(20),
      maxAdverse10d: maxAdverse,
    };

    eventImpacts.push(impact);
    eventsByCategory.get(evt.category)?.push(impact);
  }

  // Compute category stats
  const categories: CategoryStats[] = [];
  for (let catId = 1; catId <= 10; catId++) {
    const impacts = eventsByCategory.get(catId) || [];
    const validImpacts = impacts.filter(imp => imp.shockAtrMult !== null);
    const n = validImpacts.length;

    if (n === 0) {
      categories.push({
        catId, catName: CAT_NAMES[catId],
        eventCount: impacts.length, validCount: 0,
        avgAtrMult: 0, avgAbsRet: 0,
        after1d: 0, after3d: 0, after5d: 0, after10d: 0, after20d: 0,
        continuationRate: 0, contrarianRate: 0, maxAdverse10d: 0,
      });
      continue;
    }

    // After-N-day (directional)
    function avgAfter(nd: number): number {
      const vals = impacts.map(imp => imp[`after${nd}d` as keyof EventImpact] as number | null).filter((v): v is number => v !== null);
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    }

    // Continuation: after10d > 0
    const after10Vals = impacts.map(imp => imp.after10d).filter((v): v is number => v !== null);
    const contCount = after10Vals.filter(v => v > 0).length;

    // Contrarian: after10d < 0 (consensus was wrong)
    const contraCount = after10Vals.filter(v => v < 0).length;

    // Max adverse
    const adverseVals = impacts.map(imp => imp.maxAdverse10d).filter((v): v is number => v !== null);

    categories.push({
      catId, catName: CAT_NAMES[catId],
      eventCount: impacts.length,
      validCount: n,
      avgAtrMult: validImpacts.reduce((a, b) => a + b.shockAtrMult!, 0) / n,
      avgAbsRet: validImpacts.reduce((a, b) => a + Math.abs(b.shockRet!), 0) / n,
      after1d: avgAfter(1),
      after3d: avgAfter(3),
      after5d: avgAfter(5),
      after10d: avgAfter(10),
      after20d: avgAfter(20),
      continuationRate: after10Vals.length > 0 ? (contCount / after10Vals.length) * 100 : 0,
      contrarianRate: after10Vals.length > 0 ? (contraCount / after10Vals.length) * 100 : 0,
      maxAdverse10d: adverseVals.length > 0 ? adverseVals.reduce((a, b) => a + b, 0) / adverseVals.length : 0,
    });
  }

  // Overall ATR shock stats
  const shockN = allShocks.length;
  let overallAfter10 = 0, overallCont = 0, overallContTotal = 0;
  for (const shock of allShocks) {
    const idx = shock.index;
    if (idx + 10 >= bars.length) continue;
    const retPct = ((bars[idx + 10].c - bars[idx].c) / bars[idx].c) * 100;
    const signed = shock.direction === 'up' ? retPct : -retPct;
    overallAfter10 += signed;
    overallContTotal++;
    if (signed > 0) overallCont++;
  }

  return {
    code,
    sector: getSector(code),
    totalBars: bars.length,
    totalAtrShocks: shockN,
    overallSensitivity: shockN > 0 ? allShocks.reduce((a, b) => a + b.atrMult, 0) / shockN : 0,
    overallAfter10d: overallContTotal > 0 ? overallAfter10 / overallContTotal : 0,
    overallContinuation: overallContTotal > 0 ? (overallCont / overallContTotal) * 100 : 0,
    totalEvents: myEvents.length,
    categories,
    eventImpacts,
  };
}

// ============ 主流程 ============
async function main() {
  const dataDir = path.resolve('data-cache-daily-20y');
  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).sort();

  console.log(`加载 ${files.length} 个品种 20 年日线数据...`);
  const results: VarietyResult[] = [];

  for (const file of files) {
    const code = file.replace('.json', '');
    const bars: DailyBar[] = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
    const validBars = bars.filter(b => b.c > 0 && b.ret !== null);
    if (validBars.length < 100) continue;

    const result = analyzeVariety(code, validBars);
    results.push(result);

    const activeCats = result.categories.filter(c => c.validCount > 0).length;
    console.log(`  ${code}: ${result.totalBars}根, ${result.totalEvents}个事件, ${activeCats}/10类有数据, ATR冲击${result.totalAtrShocks}次, 敏感度=${result.overallSensitivity.toFixed(2)}x`);
  }

  // Save JSON
  const outPath = path.resolve('data/varietySensitivityResult.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outPath}`);
  console.log(`共 ${results.length} 个品种`);

  // Summary
  const withEvents = results.filter(r => r.totalEvents > 0);
  console.log(`\n有事件覆盖的品种: ${withEvents.length}/${results.length}`);
  console.log('事件覆盖 TOP10:');
  withEvents.sort((a, b) => b.totalEvents - a.totalEvents);
  for (const r of withEvents.slice(0, 10)) {
    const activeCats = r.categories.filter(c => c.validCount > 0).map(c => c.catName).join(',');
    console.log(`  ${r.code}(${r.sector}): ${r.totalEvents}个事件, 覆盖[${activeCats}]`);
  }
}

main().catch(console.error);
