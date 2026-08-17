/**
 * AI 解读质量回测：量化新闻分析体系的实际价值
 * 
 * 对比方案：
 * - S0: 纯 V16 策略（无新闻感知）- 基准
 * - A: 仅品种敏感度过滤
 * - B: 仅严重程度过滤
 * - C: 仅持仓周期调整
 * - D: 仅传播链预警
 * - E: 全组合（A+B+C+D）
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runBacktest } from '../services/backtestEngine.js';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 品种敏感度数据
interface VarietySensitivity {
  code: string;
  sector: string;
  sensitivityLevel: 'high' | 'medium' | 'low';
  avgShockMagnitude: number;
  totalEvents: number;
}

// 严重程度数据
interface SeverityData {
  L1: { count: number; avgReturn10d: number; continuationRate: number };
  L2: { count: number; avgReturn10d: number; continuationRate: number };
  L3: { count: number; avgReturn10d: number; continuationRate: number };
  L4: { count: number; avgReturn10d: number; continuationRate: number };
}

// 持仓周期数据
interface HoldingPeriodData {
  [category: string]: {
    optimalDays: number;
    avgReturn: number;
  };
}

// 传播链数据
interface PropagationData {
  leaders: string[];
  chains: Array<{
    from: string;
    to: string;
    avgLag: number;
    correlation: number;
  }>;
}

// 加载知识数据
function loadKnowledge() {
  // 品种敏感度
  const sensitivityRaw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../data/varietySensitivityResult.json'), 'utf-8'
  ));
  const sensitivityMap = new Map<string, VarietySensitivity>();
  for (const v of sensitivityRaw) {
    let level: 'high' | 'medium' | 'low' = 'medium';
    if (v.overallSensitivity > 4.5) level = 'high';
    else if (v.overallSensitivity < 3.5) level = 'low';
    
    sensitivityMap.set(v.code, {
      code: v.code,
      sector: v.sector,
      sensitivityLevel: level,
      avgShockMagnitude: v.overallSensitivity,
      totalEvents: v.totalEvents,
    });
  }

  // 严重程度
  const severityRaw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/severityClassificationResult.json'), 'utf-8'
  ));
  const severity: SeverityData = {
    L1: severityRaw.globalStats.L1,
    L2: severityRaw.globalStats.L2,
    L3: severityRaw.globalStats.L3,
    L4: severityRaw.globalStats.L4,
  };

  // 持仓周期
  const holdingRaw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../data/holdingPeriodResult.json'), 'utf-8'
  ));
  const holdingPeriod: HoldingPeriodData = {};
  for (const cat of holdingRaw.categoryResults) {
    // 找到最优持仓天数（最高收益对应的时间窗口）
    let bestDays = 10; // 默认
    let bestReturn = -Infinity;
    for (const tw of cat.timeWindows) {
      if (tw.avgReturn > bestReturn) {
        bestReturn = tw.avgReturn;
        bestDays = tw.window;
      }
    }
    holdingPeriod[cat.categoryName] = {
      optimalDays: bestDays,
      avgReturn: bestReturn,
    };
  }

  // 传播链
  const propRaw = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../data/propagationChainResult.json'), 'utf-8'
  ));
  const propagation: PropagationData = {
    leaders: propRaw.leaders.slice(0, 10).map((l: any) => l.code),
    chains: propRaw.topSectorPairs.map((p: any) => ({
      from: p.from,
      to: p.to,
      avgLag: p.avgLag,
      correlation: p.correlation,
    })),
  };

  return { sensitivityMap, severity, holdingPeriod, propagation };
}

// 构建事件日期集合（用于识别事件期）
function buildEventDates() {
  const eventDates = new Set<string>();
  for (const event of BLACK_SWAN_EVENTS) {
    // 事件前后 5 天都算事件期
    const baseDate = new Date(event.date);
    for (let i = -5; i <= 5; i++) {
      const d = new Date(baseDate);
      d.setDate(d.getDate() + i);
      eventDates.add(d.toISOString().split('T')[0]);
    }
  }
  return eventDates;
}

// 估算冲击严重程度（基于价格变动）
function estimateSeverity(dailyReturn: number, atr: number): 'L1' | 'L2' | 'L3' | 'L4' {
  const ratio = Math.abs(dailyReturn) / atr;
  if (ratio < 2) return 'L1';
  if (ratio < 3) return 'L2';
  if (ratio < 6) return 'L3';
  return 'L4';
}

// 获取事件类别（简化版：基于品种推断）
function inferEventCategory(variety: string, sector: string): string {
  // 简化映射
  if (['SC0', 'BU0', 'FU0', 'LU0'].includes(variety)) return '能源';
  if (['AU0', 'AG0'].includes(variety)) return '贵金属';
  if (['CU0', 'AL0', 'ZN0', 'PB0', 'NI0', 'SN0'].includes(variety)) return '有色';
  if (['RB0', 'HC0', 'I0', 'J0', 'JM0'].includes(variety)) return '黑色系';
  if (['M0', 'Y0', 'OI0', 'P0', 'RM0', 'C0', 'CF0', 'SR0', 'AP0', 'CJ0'].includes(variety)) return '农产品';
  if (['RU0', 'NR0', 'L0', 'V0', 'PP0', 'MA0', 'EB0', 'EG0', 'PG0', 'PR0'].includes(variety)) return '化工';
  if (['IF0', 'IC0', 'IH0', 'IM0', 'T0', 'TF0', 'TS0'].includes(variety)) return '金融';
  return '其他';
}

// 方案 A：品种敏感度过滤
function applySensitivityFilter(
  trades: any[],
  variety: string,
  sensitivityMap: Map<string, VarietySensitivity>
) {
  const sens = sensitivityMap.get(variety);
  if (!sens) return trades;

  return trades.map(trade => {
    // 高敏感品种：降低仓位 20%
    if (sens.sensitivityLevel === 'high') {
      return { ...trade, positionSize: trade.positionSize * 0.8 };
    }
    // 低敏感品种：保持原样（技术可靠）
    return trade;
  });
}

// 方案 B：严重程度过滤
function applySeverityFilter(
  trades: any[],
  dailyBars: any[],
  severity: SeverityData
) {
  return trades.map(trade => {
    const entryIdx = dailyBars.findIndex(b => b.date === trade.entryDate);
    if (entryIdx < 0) return trade;

    const bar = dailyBars[entryIdx];
    const atr = bar.atr || (bar.h - bar.l);
    const dailyReturn = Math.abs(bar.c - bar.o) / bar.o;
    const sev = estimateSeverity(dailyReturn, atr);

    // L1：忽略（正常波动）
    if (sev === 'L1') return trade;

    // L4：不追共识方向（反直觉率 69%）
    if (sev === 'L4') {
      // 如果是顺势交易，降低仓位
      if (trade.direction === 'long' && bar.c > bar.o) {
        return { ...trade, positionSize: trade.positionSize * 0.5 };
      }
      if (trade.direction === 'short' && bar.c < bar.o) {
        return { ...trade, positionSize: trade.positionSize * 0.5 };
      }
    }

    // L2/L3：保持原样
    return trade;
  });
}

// 方案 C：持仓周期调整
function applyHoldingPeriodFilter(
  trades: any[],
  variety: string,
  sector: string,
  holdingPeriod: HoldingPeriodData
) {
  const category = inferEventCategory(variety, sector);
  const optimal = holdingPeriod[category];
  
  if (!optimal) return trades;

  return trades.map(trade => {
    // 根据事件类别调整持仓天数
    const originalDays = trade.holdingDays || 10;
    const adjustedDays = Math.min(optimal.optimalDays, originalDays);
    
    // 如果最优持仓更短，提前退出
    if (adjustedDays < originalDays) {
      return { ...trade, holdingDays: adjustedDays };
    }
    return trade;
  });
}

// 方案 D：传播链预警
function applyPropagationFilter(
  trades: any[],
  variety: string,
  propagation: PropagationData
) {
  // 如果是领先品种，保持原样
  if (propagation.leaders.includes(variety)) {
    return trades;
  }

  // 如果是跟随品种，在领先品种异动时降低仓位
  // 简化实现：所有跟随品种降低 10% 仓位
  return trades.map(trade => {
    return { ...trade, positionSize: trade.positionSize * 0.9 };
  });
}

// 运行单个方案
async function runScheme(
  schemeId: string,
  schemeName: string,
  variety: string,
  dailyBars: any[],
  options: {
    useSensitivity?: boolean;
    useSeverity?: boolean;
    useHoldingPeriod?: boolean;
    usePropagation?: boolean;
  },
  knowledge: ReturnType<typeof loadKnowledge>
) {
  // 基础回测
  const result = await runBacktest({
    codes: [variety],
    minSignalGrade: 'L2',
    maxPositionPct: 0.1,
    maxHoldDays: 15,
    dataDir: 'data-cache-daily-20y',
  });

  if (!result || !result.trades || result.trades.length === 0) {
    return { schemeId, schemeName, variety, trades: [], metrics: null };
  }

  let trades = [...result.trades];

  // 应用各层过滤
  if (options.useSensitivity) {
    trades = applySensitivityFilter(trades, variety, knowledge.sensitivityMap);
  }
  if (options.useSeverity) {
    trades = applySeverityFilter(trades, dailyBars, knowledge.severity);
  }
  if (options.useHoldingPeriod) {
    const sector = knowledge.sensitivityMap.get(variety)?.sector || '其他';
    trades = applyHoldingPeriodFilter(trades, variety, sector, knowledge.holdingPeriod);
  }
  if (options.usePropagation) {
    trades = applyPropagationFilter(trades, variety, knowledge.propagation);
  }

  // 重新计算指标
  const metrics = calculateMetrics(trades, dailyBars);

  return { schemeId, schemeName, variety, trades, metrics };
}

// 计算交易指标
function calculateMetrics(trades: any[], dailyBars: any[]) {
  if (trades.length === 0) {
    return {
      totalReturn: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      winRate: 0,
      profitFactor: 0,
      totalTrades: 0,
      avgHoldingDays: 0,
    };
  }

  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let holdingDaysSum = 0;

  for (const trade of trades) {
    const pnl = trade.pnl || 0;
    totalPnl += pnl;
    holdingDaysSum += trade.holdingDays || 10;

    if (pnl > 0) {
      wins++;
      grossProfit += pnl;
    } else {
      losses++;
      grossLoss += Math.abs(pnl);
    }
  }

  const winRate = trades.length > 0 ? wins / trades.length : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;
  const avgHoldingDays = trades.length > 0 ? holdingDaysSum / trades.length : 0;

  // 计算最大回撤
  let peak = 0;
  let maxDrawdown = 0;
  let equity = 0;
  for (const trade of trades) {
    equity += trade.pnl || 0;
    if (equity > peak) peak = equity;
    const drawdown = peak - equity;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // 计算夏普比率（简化版）
  const returns = trades.map(t => t.pnl || 0);
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length);
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

  return {
    totalReturn: totalPnl,
    maxDrawdown,
    sharpeRatio,
    winRate,
    profitFactor,
    totalTrades: trades.length,
    avgHoldingDays,
  };
}

async function main() {
  console.log('=== AI 解读质量回测 ===\n');

  // 加载知识数据
  console.log('加载知识数据...');
  const knowledge = loadKnowledge();
  console.log(`- 品种敏感度：${knowledge.sensitivityMap.size} 个品种`);
  console.log(`- 领先品种：${knowledge.propagation.leaders.length} 个`);
  console.log(`- 传播链：${knowledge.propagation.chains.length} 条`);

  // 加载日线数据
  console.log('\n加载日线数据...');
  const dataDir = path.join(__dirname, '../../data-cache-daily-20y');
  const varieties = fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  console.log(`- ${varieties.length} 个品种`);

  // 定义方案
  const schemes = [
    { id: 'S0', name: '基准（无新闻感知）', options: {} },
    { id: 'A', name: '仅品种敏感度', options: { useSensitivity: true } },
    { id: 'B', name: '仅严重程度', options: { useSeverity: true } },
    { id: 'C', name: '仅持仓周期', options: { useHoldingPeriod: true } },
    { id: 'D', name: '仅传播链', options: { usePropagation: true } },
    { id: 'E', name: '全组合', options: { useSensitivity: true, useSeverity: true, useHoldingPeriod: true, usePropagation: true } },
  ];

  // 运行回测（取前 10 个品种做快速验证）
  const testVarieties = varieties.slice(0, 10);
  console.log(`\n运行回测（${testVarieties.length} 个品种 × ${schemes.length} 个方案）...`);

  const results: any[] = [];
  const startTime = Date.now();

  for (const scheme of schemes) {
    console.log(`\n方案 ${scheme.id}: ${scheme.name}`);
    
    for (const variety of testVarieties) {
      const filePath = path.join(dataDir, `${variety}.json`);
      const dailyBars = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

      const result = await runScheme(
        scheme.id,
        scheme.name,
        variety,
        dailyBars,
        scheme.options,
        knowledge
      );

      results.push(result);
      
      if (result.metrics) {
        console.log(`  ${variety}: 收益=${(result.metrics.totalReturn * 100).toFixed(2)}%, 回撤=${(result.metrics.maxDrawdown * 100).toFixed(2)}%, 夏普=${result.metrics.sharpeRatio.toFixed(2)}`);
      }
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n回测完成，耗时 ${elapsed}s`);

  // 汇总结果
  const summary: any = {};
  for (const scheme of schemes) {
    const schemeResults = results.filter(r => r.schemeId === scheme.id);
    const metricsList = schemeResults.filter(r => r.metrics).map(r => r.metrics);

    if (metricsList.length === 0) {
      summary[scheme.id] = { name: scheme.name, metrics: null };
      continue;
    }

    const avgReturn = metricsList.reduce((sum, m) => sum + m.totalReturn, 0) / metricsList.length;
    const avgDrawdown = metricsList.reduce((sum, m) => sum + m.maxDrawdown, 0) / metricsList.length;
    const avgSharpe = metricsList.reduce((sum, m) => sum + m.sharpeRatio, 0) / metricsList.length;
    const avgWinRate = metricsList.reduce((sum, m) => sum + m.winRate, 0) / metricsList.length;
    const totalTrades = metricsList.reduce((sum, m) => sum + m.totalTrades, 0);

    summary[scheme.id] = {
      name: scheme.name,
      metrics: {
        avgReturn,
        avgDrawdown,
        avgSharpe,
        avgWinRate,
        totalTrades,
      },
    };
  }

  // 保存结果
  const outputDir = path.join(__dirname, '../data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(outputDir, 'aiInterpretationValueResult.json'),
    JSON.stringify({ summary, results }, null, 2)
  );

  console.log('\n结果已保存到 data/aiInterpretationValueResult.json');

  // 打印汇总
  console.log('\n=== 方案对比 ===');
  console.log('方案\t名称\t\t平均收益\t平均回撤\t夏普\t胜率\t交易数');
  for (const scheme of schemes) {
    const s = summary[scheme.id];
    if (s.metrics) {
      console.log(`${scheme.id}\t${scheme.name.padEnd(12)}\t${(s.metrics.avgReturn * 100).toFixed(2)}%\t\t${(s.metrics.avgDrawdown * 100).toFixed(2)}%\t\t${s.metrics.avgSharpe.toFixed(2)}\t${(s.metrics.avgWinRate * 100).toFixed(1)}%\t${s.metrics.totalTrades}`);
    }
  }
}

main().catch(console.error);
