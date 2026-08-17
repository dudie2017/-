/**
 * 持仓周期敏感度分析
 * 
 * 核心问题：新闻冲击的影响持续多久？
 * 
 * 方法：对每个品种，计算事件冲击后 1/3/5/10/20/30 日的收益曲线
 * 观察收益随时间的变化，判断新闻影响的衰减速度
 * 
 * 输出：
 * - 全品种平均衰减曲线
 * - 按事件类别的衰减曲线
 * - 按品种的衰减曲线
 * - 结论：新闻影响在 N 日后衰减到 X%
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { BLACK_SWAN_EVENTS, type BlackSwanEvent } from '../data/blackswanEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.resolve(__dirname, '../../data-cache-daily-20y');
const OUTPUT_DIR = path.resolve(__dirname, '../../data');

interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number;
}

interface TimeWindowStats {
  window: number; // days
  avgReturn: number; // average return after N days
  medianReturn: number;
  positiveRate: number; // % of times return > 0
  avgAbsReturn: number; // average absolute return (volatility)
  maxGain: number;
  maxLoss: number;
  continuationRate: number; // % of times direction matches initial shock direction
  contrarianRate: number; // % of times direction reverses
}

interface VarietyResult {
  code: string;
  sector: string;
  totalBars: number;
  totalEvents: number;
  timeWindows: TimeWindowStats[];
}

interface CategoryResult {
  catId: number;
  categoryName: string;
  totalSamples: number;
  timeWindows: TimeWindowStats[];
}

function computeATR(bars: DailyBar[], period: number = 14): number[] {
  const atrs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 1) {
      atrs.push(0);
      continue;
    }
    const tr = Math.max(
      bars[i].h - bars[i].l,
      Math.abs(bars[i].h - bars[i - 1].c),
      Math.abs(bars[i].l - bars[i - 1].c)
    );
    if (i < period) {
      atrs.push(tr);
    } else {
      atrs.push((atrs[i - 1] * (period - 1) + tr) / period);
    }
  }
  return atrs;
}

function computeTimeWindowStats(
  samples: { barIdx: number; direction: 'up' | 'down'; bars: DailyBar[] }[]
): TimeWindowStats[] {
  const windows = [1, 3, 5, 10, 20, 30];
  const results: TimeWindowStats[] = [];

  for (const window of windows) {
    const returns: number[] = [];
    let continuations = 0;
    let contrarians = 0;
    let valid = 0;

    for (const sample of samples) {
      const { barIdx, direction, bars } = sample;
      const targetIdx = barIdx + window;
      
      if (targetIdx >= bars.length) continue;
      
      const entryPrice = bars[barIdx].c;
      const exitPrice = bars[targetIdx].c;
      const ret = (exitPrice - entryPrice) / entryPrice;
      
      returns.push(ret);
      valid++;

      // Check if direction matches initial shock
      const isPositive = ret > 0;
      if ((direction === 'up' && isPositive) || (direction === 'down' && !isPositive)) {
        continuations++;
      } else {
        contrarians++;
      }
    }

    if (valid === 0) {
      results.push({
        window,
        avgReturn: 0,
        medianReturn: 0,
        positiveRate: 0,
        avgAbsReturn: 0,
        maxGain: 0,
        maxLoss: 0,
        continuationRate: 0,
        contrarianRate: 0,
      });
      continue;
    }

    returns.sort((a, b) => a - b);
    const avgReturn = returns.reduce((a, b) => a + b, 0) / valid;
    const medianReturn = returns[Math.floor(valid / 2)];
    const positiveRate = returns.filter(r => r > 0).length / valid;
    const avgAbsReturn = returns.reduce((a, b) => a + Math.abs(b), 0) / valid;

    results.push({
      window,
      avgReturn: avgReturn * 100,
      medianReturn: medianReturn * 100,
      positiveRate: positiveRate * 100,
      avgAbsReturn: avgAbsReturn * 100,
      maxGain: Math.max(...returns) * 100,
      maxLoss: Math.min(...returns) * 100,
      continuationRate: (continuations / valid) * 100,
      contrarianRate: (contrarians / valid) * 100,
    });
  }

  return results;
}

async function main() {
  console.log('=== 持仓周期敏感度分析 ===');
  console.log(`数据目录: ${DATA_DIR}`);

  // Load all variety data
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  console.log(`品种数: ${files.length}`);

  const varietyData = new Map<string, { bars: DailyBar[]; atrs: number[] }>();
  
  for (const file of files) {
    const code = file.replace('.json', '');
    const bars: DailyBar[] = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
    const atrs = computeATR(bars);
    varietyData.set(code, { bars, atrs });
  }

  // Build event date index: for each variety, find event dates
  const events = BLACK_SWAN_EVENTS;
  console.log(`事件数: ${events.length}`);

  // For each variety, collect samples at each event date
  const varietyResults: VarietyResult[] = [];
  const categorySamples = new Map<number, { barIdx: number; direction: 'up' | 'down'; bars: DailyBar[] }[]>();

  // Initialize category samples
  for (let catId = 1; catId <= 10; catId++) {
    categorySamples.set(catId, []);
  }

  for (const [code, data] of varietyData) {
    const { bars, atrs } = data;
    
    // Find events that affect this variety
    const relevantEvents = events.filter(e => e.varieties.includes(code));
    
    const samples: { barIdx: number; direction: 'up' | 'down'; bars: DailyBar[] }[] = [];
    
    for (const event of relevantEvents) {
      // Find the bar index for the event date (or closest)
      let barIdx = bars.findIndex(b => b.date === event.date);
      
      // If exact date not found, find closest within ±5 days
      if (barIdx === -1) {
        const eventDate = new Date(event.date);
        for (let i = 0; i < bars.length; i++) {
          const barDate = new Date(bars[i].date);
          const diffDays = Math.abs((barDate.getTime() - eventDate.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays <= 5) {
            barIdx = i;
            break;
          }
        }
      }
      
      if (barIdx === -1 || barIdx >= bars.length - 30) continue;
      
      // Determine direction from the shock
      const atr = atrs[barIdx];
      if (atr === 0) continue;
      
      const dayReturn = bars[barIdx].ret || 0;
      const direction: 'up' | 'down' = dayReturn >= 0 ? 'up' : 'down';
      
      samples.push({ barIdx, direction, bars });
      
      // Also add to category samples
      const catSamples = categorySamples.get(event.category)!;
      catSamples.push({ barIdx, direction, bars });
    }

    // Compute time window stats for this variety
    const timeWindows = computeTimeWindowStats(samples);
    
    // Determine sector
    const sectorMap: Record<string, string> = {
      'AU0': '贵金属', 'AG0': '贵金属',
      'CU0': '有色', 'AL0': '有色', 'ZN0': '有色', 'PB0': '有色', 'NI0': '有色', 'SN0': '有色',
      'RB0': '黑色系', 'I0': '黑色系', 'J0': '黑色系', 'JM0': '黑色系', 'HC0': '黑色系', 'SS0': '黑色系',
      'SC0': '能源', 'FU0': '能源', 'LU0': '能源', 'PG0': '能源', 'BU0': '能源',
      'L0': '化工', 'V0': '化工', 'PP0': '化工', 'MA0': '化工', 'TA0': '化工', 'EG0': '化工',
      'EB0': '化工', 'SA0': '化工', 'RU0': '化工', 'NR0': '化工', 'PF0': '化工', 'PR0': '化工',
      'M0': '油脂油料', 'Y0': '油脂油料', 'OI0': '油脂油料', 'P0': '油脂油料', 'RM0': '油脂油料',
      'CF0': '软商品', 'SR0': '软商品', 'AP0': '软商品', 'CJ0': '软商品',
      'LH0': '养殖', 'JD0': '养殖',
      'IF0': '金融', 'IC0': '金融', 'IH0': '金融', 'IM0': '金融', 'T0': '金融', 'TF0': '金融',
      'SI0': '新兴', 'AO0': '新兴', 'PX0': '新兴', 'LC0': '新兴',
      'FG0': '建材',
      'C0': '其他', 'WH0': '其他', 'WR0': '其他', 'SP0': '其他', 'UR0': '其他', 'BC0': '其他',
    };
    
    varietyResults.push({
      code,
      sector: sectorMap[code] || '其他',
      totalBars: bars.length,
      totalEvents: samples.length,
      timeWindows,
    });
  }

  // Compute category-level results
  const categoryResults: CategoryResult[] = [];
  const catNames: Record<number, string> = {
    1: '地缘政治', 2: '宏观经济', 3: '政策监管', 4: '天气气候',
    5: '自然灾害', 6: '疾病疫情', 7: '供给端减产', 8: '供需失衡',
    9: '行业事件', 10: '交易制度',
  };

  for (const [catId, samples] of categorySamples) {
    const timeWindows = computeTimeWindowStats(samples);
    categoryResults.push({
      catId,
      categoryName: catNames[catId] || `类别${catId}`,
      totalSamples: samples.length,
      timeWindows,
    });
  }

  // Compute global average decay curve
  const allSamples: { barIdx: number; direction: 'up' | 'down'; bars: DailyBar[] }[] = [];
  for (const [code, data] of varietyData) {
    const { bars, atrs } = data;
    const relevantEvents = events.filter(e => e.varieties.includes(code));
    
    for (const event of relevantEvents) {
      let barIdx = bars.findIndex(b => b.date === event.date);
      if (barIdx === -1) {
        const eventDate = new Date(event.date);
        for (let i = 0; i < bars.length; i++) {
          const barDate = new Date(bars[i].date);
          const diffDays = Math.abs((barDate.getTime() - eventDate.getTime()) / (1000 * 60 * 60 * 24));
          if (diffDays <= 5) {
            barIdx = i;
            break;
          }
        }
      }
      if (barIdx === -1 || barIdx >= bars.length - 30) continue;
      
      const dayReturn = bars[barIdx].ret || 0;
      const direction: 'up' | 'down' = dayReturn >= 0 ? 'up' : 'down';
      allSamples.push({ barIdx, direction, bars });
    }
  }
  
  const globalTimeWindows = computeTimeWindowStats(allSamples);

  // Save results
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const output = {
    globalTimeWindows,
    categoryResults,
    varietyResults,
    totalSamples: allSamples.length,
  };

  const outputPath = path.join(OUTPUT_DIR, 'holdingPeriodResult.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
  console.log(`总样本数: ${allSamples.length}`);

  // Print summary
  console.log('\n=== 全品种平均衰减曲线 ===');
  console.log('时间窗口 | 平均收益 | 延续率 | 反直觉率');
  for (const tw of globalTimeWindows) {
    console.log(`${tw.window}日 | ${tw.avgReturn.toFixed(3)}% | ${tw.continuationRate.toFixed(1)}% | ${tw.contrarianRate.toFixed(1)}%`);
  }

  console.log('\n=== 按事件类别衰减 ===');
  for (const cat of categoryResults.sort((a, b) => b.totalSamples - a.totalSamples)) {
    if (cat.totalSamples < 5) continue;
    const tw5 = cat.timeWindows.find(t => t.window === 5)!;
    const tw10 = cat.timeWindows.find(t => t.window === 10)!;
    const tw20 = cat.timeWindows.find(t => t.window === 20)!;
    console.log(`${cat.categoryName}(${cat.totalSamples}样本): 5日${tw5.avgReturn.toFixed(2)}% | 10日${tw10.avgReturn.toFixed(2)}% | 20日${tw20.avgReturn.toFixed(2)}%`);
  }

  console.log('\n=== 衰减最快的品种（5日→20日收益变化最大） ===');
  const decayVarieties = varietyResults
    .filter(v => v.totalEvents >= 3)
    .map(v => {
      const tw5 = v.timeWindows.find(t => t.window === 5)!;
      const tw20 = v.timeWindows.find(t => t.window === 20)!;
      return {
        code: v.code,
        sector: v.sector,
        events: v.totalEvents,
        ret5: tw5.avgReturn,
        ret20: tw20.avgReturn,
        decay: tw20.avgReturn - tw5.avgReturn,
      };
    })
    .sort((a, b) => Math.abs(b.decay) - Math.abs(a.decay));

  for (const v of decayVarieties.slice(0, 10)) {
    console.log(`${v.code}(${v.sector}): 5日${v.ret5.toFixed(2)}% → 20日${v.ret20.toFixed(2)}% (变化${v.decay.toFixed(2)}%)`);
  }
}

main().catch(console.error);
