/**
 * 事件传播链分析脚本
 * 分析事件如何在品种间传导，识别"领先品种"和"跟随品种"
 * 
 * 方法：
 * 1. 对每个事件，找出所有受影响的品种
 * 2. 测量每个品种的反应速度（多少天后出现显著波动 >1ATR）
 * 3. 测量每个品种的反应幅度（5日内最大收益）
 * 4. 按反应速度排序，找出领先者和跟随者
 * 5. 构建传播矩阵：品种A变动后，品种B多大概率在N天内跟随
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number;
  rollover?: boolean;
}

interface VarietyData {
  code: string;
  bars: DailyBar[];
  atrMap: Map<string, number>;
}

interface ReactionRecord {
  eventId: string;
  eventDate: string;
  category: number;
  categoryName: string;
  variety: string;
  sector: string;
  reactionDay: number; // Days until significant reaction (>1 ATR)
  reactionDir: 'up' | 'down'; // Direction of reaction
  reactionMagnitude: number; // Max absolute return in first 5 days
  after1d: number;
  after3d: number;
  after5d: number;
  after10d: number;
}

interface PropagationPair {
  leader: string;
  follower: string;
  leaderSector: string;
  followerSector: string;
  category: number;
  categoryName: string;
  avgLag: number; // Average days between leader and follower reaction
  coOccurrence: number; // How many times they move together
  correlation: number; // Direction correlation (same direction %)
}

// Compute ATR for each bar
function computeATR(bars: DailyBar[], period: number = 14): Map<string, number> {
  const atrMap = new Map<string, number>();
  if (bars.length < period + 1) return atrMap;

  const trueRanges: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const tr = Math.max(
      curr.h - curr.l,
      Math.abs(curr.h - prev.c),
      Math.abs(curr.l - prev.c)
    );
    trueRanges.push(tr);
  }

  for (let i = period - 1; i < trueRanges.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += trueRanges[j];
    }
    const atr = sum / period;
    atrMap.set(bars[i + 1].date, atr);
  }
  return atrMap;
}

// Find the reaction day and direction for a variety after an event
function findReaction(
  bars: DailyBar[],
  eventDate: string,
  atrMap: Map<string, number>,
  maxLookAhead: number = 10
): { reactionDay: number; reactionDir: 'up' | 'down'; reactionMagnitude: number; after1d: number; after3d: number; after5d: number; after10d: number } | null {
  const eventIdx = bars.findIndex(b => b.date === eventDate);
  if (eventIdx < 0) return null;

  const atr = atrMap.get(eventDate);
  if (!atr || atr <= 0) return null;

  // Calculate returns after event
  const eventClose = bars[eventIdx].c;
  const after1d = eventIdx + 1 < bars.length ? (bars[eventIdx + 1].c - eventClose) / eventClose * 100 : 0;
  const after3d = eventIdx + 3 < bars.length ? (bars[eventIdx + 3].c - eventClose) / eventClose * 100 : 0;
  const after5d = eventIdx + 5 < bars.length ? (bars[eventIdx + 5].c - eventClose) / eventClose * 100 : 0;
  const after10d = eventIdx + 10 < bars.length ? (bars[eventIdx + 10].c - eventClose) / eventClose * 100 : 0;

  // Find first day with significant move (>1 ATR)
  let reactionDay = -1;
  let reactionDir: 'up' | 'down' = 'up';
  let reactionMagnitude = 0;

  for (let i = 1; i <= maxLookAhead && eventIdx + i < bars.length; i++) {
    const bar = bars[eventIdx + i];
    if (bar.rollover) continue;

    const dailyMove = Math.abs(bar.c - bars[eventIdx + i - 1].c);
    if (dailyMove > atr) {
      reactionDay = i;
      reactionDir = bar.c > bars[eventIdx + i - 1].c ? 'up' : 'down';
      break;
    }
  }

  // Calculate max magnitude in first 5 days
  for (let i = 1; i <= 5 && eventIdx + i < bars.length; i++) {
    const ret = Math.abs((bars[eventIdx + i].c - eventClose) / eventClose * 100);
    if (ret > reactionMagnitude) {
      reactionMagnitude = ret;
    }
  }

  if (reactionDay < 0) return null; // No significant reaction found

  return { reactionDay, reactionDir, reactionMagnitude, after1d, after3d, after5d, after10d };
}

// Load all variety data
function loadVarietyData(): Map<string, VarietyData> {
  const dataDir = path.join(__dirname, '..', '..', 'data-cache-daily-20y');
  const varietyData = new Map<string, VarietyData>();

  const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const code = file.replace('.json', '');
    const bars: DailyBar[] = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
    const atrMap = computeATR(bars);
    varietyData.set(code, { code, bars, atrMap });
  }

  return varietyData;
}

// Main analysis
function analyzePropagation(varietyData: Map<string, VarietyData>) {
  const reactions: ReactionRecord[] = [];
  const propagationPairs: Map<string, PropagationPair> = new Map();

  const catNames: Record<number, string> = {
    1: '地缘政治', 2: '宏观经济', 3: '政策监管', 4: '天气气候',
    5: '自然灾害', 6: '疾病疫情', 7: '供给端减产', 8: '供需失衡',
    9: '行业事件', 10: '交易制度'
  };

  // Sector mapping
  const sectorMap: Record<string, string> = {
    'AU0': '贵金属', 'AG0': '贵金属',
    'CU0': '有色', 'AL0': '有色', 'ZN0': '有色', 'PB0': '有色', 'NI0': '有色', 'SN0': '有色', 'BC0': '有色', 'AO0': '有色',
    'RB0': '黑色系', 'I0': '黑色系', 'J0': '黑色系', 'JM0': '黑色系', 'HC0': '黑色系', 'SS0': '黑色系',
    'SC0': '能源', 'FU0': '能源', 'LU0': '能源', 'PG0': '能源', 'BU0': '能源',
    'L0': '化工', 'V0': '化工', 'PP0': '化工', 'EG0': '化工', 'EB0': '化工', 'MA0': '化工', 'TA0': '化工', 'SA0': '化工', 'RU0': '化工', 'NR0': '化工', 'PF0': '化工', 'PR0': '化工', 'PX0': '化工',
    'M0': '油脂油料', 'Y0': '油脂油料', 'OI0': '油脂油料', 'P0': '油脂油料', 'RM0': '油脂油料', 'A0': '油脂油料', 'B0': '油脂油料', 'C0': '油脂油料', 'WH0': '油脂油料', 'JR0': '油脂油料',
    'CF0': '软商品', 'SR0': '软商品', 'AP0': '软商品', 'CJ0': '软商品', 'UR0': '软商品', 'SP0': '软商品', 'WR0': '软商品',
    'LH0': '养殖', 'JD0': '养殖',
    'IF0': '金融', 'IC0': '金融', 'IH0': '金融', 'IM0': '金融', 'T0': '金融', 'TF0': '金融', 'TL0': '金融',
    'SI0': '新兴',
    'FG0': '建材',
  };

  console.log('分析事件传播链...');
  console.log(`事件库: ${BLACK_SWAN_EVENTS.length} 个事件`);
  console.log(`品种数: ${varietyData.size}`);

  // For each event, find reactions across all affected varieties
  for (const event of BLACK_SWAN_EVENTS) {
    const eventReactions: ReactionRecord[] = [];

    for (const varietyCode of event.varieties) {
      const vd = varietyData.get(varietyCode);
      if (!vd) continue;

      const reaction = findReaction(vd.bars, event.date, vd.atrMap);
      if (!reaction) continue;

      const sector = sectorMap[varietyCode] || '其他';
      const record: ReactionRecord = {
        eventId: event.id,
        eventDate: event.date,
        category: event.category,
        categoryName: catNames[event.category] || '未知',
        variety: varietyCode,
        sector,
        ...reaction,
      };

      reactions.push(record);
      eventReactions.push(record);
    }

    // Build propagation pairs: for varieties in the same event,
    // the one that reacts first is the "leader", others are "followers"
    if (eventReactions.length >= 2) {
      // Sort by reaction day
      eventReactions.sort((a, b) => a.reactionDay - b.reactionDay);

      // The first reactor is the leader
      const leader = eventReactions[0];

      for (let i = 1; i < eventReactions.length; i++) {
        const follower = eventReactions[i];
        const lag = follower.reactionDay - leader.reactionDay;
        const sameDir = leader.reactionDir === follower.reactionDir;

        const key = `${leader.variety}->${follower.variety}:${event.category}`;
        let pair = propagationPairs.get(key);

        if (!pair) {
          pair = {
            leader: leader.variety,
            follower: follower.variety,
            leaderSector: leader.sector,
            followerSector: follower.sector,
            category: event.category,
            categoryName: catNames[event.category] || '未知',
            avgLag: 0,
            coOccurrence: 0,
            correlation: 0,
          };
          propagationPairs.set(key, pair);
        }

        // Update running averages
        const n = pair.coOccurrence;
        pair.avgLag = (pair.avgLag * n + lag) / (n + 1);
        pair.correlation = (pair.correlation * n + (sameDir ? 1 : 0)) / (n + 1);
        pair.coOccurrence = n + 1;
      }
    }
  }

  return { reactions, propagationPairs: Array.from(propagationPairs.values()) };
}

// Generate summary statistics
function generateSummary(reactions: ReactionRecord[], pairs: PropagationPair[]) {
  const catNames: Record<number, string> = {
    1: '地缘政治', 2: '宏观经济', 3: '政策监管', 4: '天气气候',
    5: '自然灾害', 6: '疾病疫情', 7: '供给端减产', 8: '供需失衡',
    9: '行业事件', 10: '交易制度'
  };

  // 1. Leader varieties: those that react fastest on average
  const varietyReactionSpeed = new Map<string, { totalDay: number; count: number; avgDay: number; sectors: Set<string> }>();
  
  for (const r of reactions) {
    let entry = varietyReactionSpeed.get(r.variety);
    if (!entry) {
      entry = { totalDay: 0, count: 0, avgDay: 0, sectors: new Set() };
      varietyReactionSpeed.set(r.variety, entry);
    }
    entry.totalDay += r.reactionDay;
    entry.count++;
    entry.sectors.add(r.sector);
  }

  for (const [, entry] of varietyReactionSpeed) {
    entry.avgDay = entry.totalDay / entry.count;
  }

  const leaders = Array.from(varietyReactionSpeed.entries())
    .map(([code, data]) => ({ code, avgDay: data.avgDay, count: data.count, sectors: Array.from(data.sectors) }))
    .filter(v => v.count >= 3)
    .sort((a, b) => a.avgDay - b.avgDay);

  // 2. By category: which varieties react first
  const categoryLeaders = new Map<number, { variety: string; avgDay: number; count: number }[]>();
  
  for (const catId of Object.keys(catNames).map(Number)) {
    const catReactions = reactions.filter(r => r.category === catId);
    const varietyStats = new Map<string, { totalDay: number; count: number }>();
    
    for (const r of catReactions) {
      let entry = varietyStats.get(r.variety);
      if (!entry) {
        entry = { totalDay: 0, count: 0 };
        varietyStats.set(r.variety, entry);
      }
      entry.totalDay += r.reactionDay;
      entry.count++;
    }

    const catLeaders = Array.from(varietyStats.entries())
      .map(([variety, data]) => ({ variety, avgDay: data.totalDay / data.count, count: data.count }))
      .filter(v => v.count >= 2)
      .sort((a, b) => a.avgDay - b.avgDay);

    categoryLeaders.set(catId, catLeaders);
  }

  // 3. Top propagation pairs (most frequent leader-follower relationships)
  const topPairs = pairs
    .filter(p => p.coOccurrence >= 2)
    .sort((a, b) => b.coOccurrence - a.coOccurrence)
    .slice(0, 30);

  // 4. Cross-sector propagation
  const sectorPairs = new Map<string, { count: number; avgLag: number; correlation: number }>();
  
  for (const p of pairs) {
    if (p.leaderSector === p.followerSector) continue; // Skip same-sector
    const key = `${p.leaderSector}->${p.followerSector}`;
    let entry = sectorPairs.get(key);
    if (!entry) {
      entry = { count: 0, avgLag: 0, correlation: 0 };
      sectorPairs.set(key, entry);
    }
    const n = entry.count;
    entry.avgLag = (entry.avgLag * n + p.avgLag) / (n + 1);
    entry.correlation = (entry.correlation * n + p.correlation) / (n + 1);
    entry.count = n + 1;
  }

  const topSectorPairs = Array.from(sectorPairs.entries())
    .map(([pair, data]) => ({
      from: pair.split('->')[0],
      to: pair.split('->')[1],
      ...data,
    }))
    .filter(p => p.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalReactions: reactions.length,
    totalPairs: pairs.length,
    leaders,
    categoryLeaders,
    topPairs,
    topSectorPairs,
    catNames,
  };
}

// Main
async function main() {
  console.log('加载品种数据...');
  const varietyData = loadVarietyData();
  console.log(`已加载 ${varietyData.size} 个品种`);

  const { reactions, propagationPairs } = analyzePropagation(varietyData);
  console.log(`\n分析完成:`);
  console.log(`  总反应记录: ${reactions.length}`);
  console.log(`  传播关系对: ${propagationPairs.length}`);

  const summary = generateSummary(reactions, propagationPairs);

  // Save results
  const outputDir = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const result = {
    totalReactions: summary.totalReactions,
    totalPairs: summary.totalPairs,
    leaders: summary.leaders,
    categoryLeaders: Object.fromEntries(summary.categoryLeaders),
    topPairs: summary.topPairs,
    topSectorPairs: summary.topSectorPairs,
    reactions: reactions,
  };

  fs.writeFileSync(
    path.join(outputDir, 'propagationChainResult.json'),
    JSON.stringify(result, null, 2)
  );

  console.log(`\n结果已保存到 data/propagationChainResult.json`);

  // Print summary
  console.log('\n=== 领先品种 TOP10（反应最快） ===');
  for (const l of summary.leaders.slice(0, 10)) {
    console.log(`  ${l.code}: 平均 ${l.avgDay.toFixed(1)} 天反应, ${l.count} 次事件, 板块: ${l.sectors.join('/')}`);
  }

  console.log('\n=== 跨板块传播 TOP10 ===');
  for (const p of summary.topSectorPairs.slice(0, 10)) {
    console.log(`  ${p.from} -> ${p.to}: ${p.count} 次, 平均滞后 ${p.avgLag.toFixed(1)} 天, 同向率 ${(p.correlation * 100).toFixed(0)}%`);
  }
}

main().catch(console.error);
