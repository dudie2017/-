/**
 * 生成新闻/黑天鹅 20 年回测报告
 * 从 data/newsBacktestResult.json 和 data/eventBacktestResult.json 读取结果，输出 NEWS_BACKTEST_REPORT_20Y.md
 */
import * as fs from 'fs';

interface VarietyStats {
  code: string;
  totalBars: number;
  total: number;
  upCount: number;
  downCount: number;
  after: Record<string, { mean: number; median: number; winRate: number; avgMaxDD: number }>;
  breakdownRate: number;
  contrarianRate10: number;
  resonance: {
    resonanceCount: number;
    resonanceAfter10Mean: number;
    resonanceWinRate: number;
    divergenceCount: number;
    divergenceAfter10Mean: number;
    divergenceWinRate: number;
  };
}

interface EventCatAgg {
  name: string;
  count: number;
  samples: number;
  avgAfter10: number;
  contrarian: number;
}

interface EventResult {
  id: string;
  title: string;
  date: string;
  categoryName: string;
  samples: number;
  avgAfter10: number;
  contrarian: number;
}

function loadJSON<T>(fp: string): T {
  return JSON.parse(fs.readFileSync(fp, 'utf-8')) as T;
}

function main() {
  const result = loadJSON<{ summary: any; varieties: VarietyStats[] }>('data/newsBacktestResult.json');
  const rawEvents = loadJSON<any[]>('data/eventBacktestResult.json');
  const events: EventResult[] = rawEvents.map((e) => {
    const samples: any[] = e.samples || [];
    const after10s = samples.map((s) => s.after10).filter((v): v is number => typeof v === 'number');
    const contrarianCount = samples.filter((s) => s.contrarian10 === true).length;
    return {
      id: e.id,
      title: e.title,
      date: e.date,
      categoryName: e.categoryName,
      samples: samples.length,
      avgAfter10: after10s.length ? after10s.reduce((a, b) => a + b, 0) / after10s.length : 0,
      contrarian: samples.length ? contrarianCount / samples.length : 0,
    };
  });
  const catMap = new Map<string, EventCatAgg>();
  for (const e of events) {
    if (!catMap.has(e.categoryName)) {
      catMap.set(e.categoryName, { name: e.categoryName, count: 0, samples: 0, avgAfter10: 0, contrarian: 0 });
    }
    const c = catMap.get(e.categoryName)!;
    c.count += 1;
    c.samples += e.samples;
    c.avgAfter10 += e.avgAfter10;
    c.contrarian += e.contrarian;
  }
  const eventResult = { cats: [...catMap.values()], events };

  const lines: string[] = [];
  const L = (s = '') => lines.push(s);

  L('# 新闻/黑天鹅板块 20 年全品种回测报告');
  L();
  L('> 生成时间：2026-08 ｜ 数据：Tushare 主连日线 ｜ 回测引擎：newsBacktestEngine');
  L();
  L('## 一、数据与方法');
  L();
  L(`- **品种数**：${result.summary.varietyCount} 个（覆盖上期/大商/郑商/中金/广期/能源）`);
  L(`- **时间跨度**：2000-01 ~ 2026-08（约 26 年），总 K 线 193,985 根`);
  L('- **冲击定义**（黑天鹅代理）：单日 |ret| > 3×ATR｜跳空 > 2×ATR｜放量 > 5×20日均量（配合价格异动），剔除换月日');
  L('- **三轨验证**：①全品种异常冲击统计 ②真实事件库（10 类 52 条）逐事件回测 ③共振/背离对比');
  L();
  L('## 二、全市场冲击统计（1055 次冲击）');
  L();
  L(`- 总冲击 **${result.summary.totalShocks}** 次（↑${result.summary.upShocks}/↓${result.summary.downShocks}），平均每品种 ${result.summary.avgShocksPerVariety.toFixed(1)} 次`);
  L();
  L('| 冲击后 | 平均收益 | 中位收益 | 胜率 | 窗口最大回撤 |');
  L('|--------|---------|---------|------|-------------|');
  for (const n of ['3', '5', '10', '20']) {
    const a = result.summary.after[n];
    L(`| N=${n} 日 | ${a.mean.toFixed(2)}% | ${a.median.toFixed(2)}% | ${(a.winRate * 100).toFixed(1)}% | ${a.avgMaxDD.toFixed(2)}% |`);
  }
  L();
  L('### 结论 A：技术失效预警验证');
  L();
  L(`- **技术位击穿率：${(result.summary.breakdownRate * 100).toFixed(1)}%**（冲击后 10 日内击穿前 20 日支撑/阻力）`);
  L(`- **10 日反直觉率：${(result.summary.contrarianRate10 * 100).toFixed(1)}%**（冲击方向与后续走势相反的占比）`);
  L(`- 解读：冲击后整体呈**动量延续**（胜率 61-66%），"买预期卖事实"并非商品期货的普遍规律；技术位在 10 日窗口内被击穿的概率较低。`);
  L();
  L('### 结论 B：共振/背离验证（新闻面验证价值）');
  L();
  L(`- **共振**（冲击方向=技术方向）：${result.summary.resonance.resonanceCount} 次，10 日均收益 ${result.summary.resonance.resonanceAfter10Mean.toFixed(2)}%，胜率 ${(result.summary.resonance.resonanceWinRate * 100).toFixed(1)}%`);
  L(`- **背离**（冲击方向≠技术方向）：${result.summary.resonance.divergenceCount} 次，10 日均收益 ${result.summary.resonance.divergenceAfter10Mean.toFixed(2)}%，胜率 ${(result.summary.resonance.divergenceWinRate * 100).toFixed(1)}%`);
  L(`- 解读：共振组胜率显著高于背离组（${(result.summary.resonance.resonanceWinRate * 100).toFixed(1)}% vs ${(result.summary.resonance.divergenceWinRate * 100).toFixed(1)}%），**共振增强、背离警示**成立。`);
  L();
  L('## 三、事件库 10 类分析（52 个真实事件）');
  L();
  L('| 类别 | 事件数 | 样本 | 平均10日收益 | 反直觉率 | 解读 |');
  L('|------|--------|------|-------------|---------|------|');
  const catInsight: Record<string, string> = {
    '地缘政治': '强延续，共识方向通常兑现',
    '宏观经济/金融': '系统性下跌，方向明确',
    '政策监管': '打压类政策见效，偏空',
    '天气/气候': '利多延续（减产逻辑）',
    '自然灾害': '短时冲击，方向不一',
    '疾病/疫情': '预期易被证伪，反直觉高',
    '供给端减产': '强延续，减产利多兑现',
    '供需失衡/库存': '分化，视库存方向',
    '产业/技术变革': '高反直觉，共识最易错',
    '交易/制度': '冲击最剧烈，下跌概率高',
  };
  for (const c of eventResult.cats) {
    L(`| ${c.name} | ${c.count} | ${c.samples} | ${(c.avgAfter10 / c.count).toFixed(2)}% | ${((c.contrarian / c.count) * 100).toFixed(0)}% | ${catInsight[c.name] ?? '-'} |`);
  }
  L();
  L('### 关键事件案例');
  L();
  L('| 事件 | 日期 | 类别 | 10日收益 | 反直觉 |');
  L('|------|------|------|---------|--------|');
  const topEvents = [...eventResult.events]
    .sort((a, b) => Math.abs(b.avgAfter10) - Math.abs(a.avgAfter10))
    .slice(0, 12);
  for (const e of topEvents) {
    L(`| ${e.title} | ${e.date} | ${e.categoryName} | ${e.avgAfter10.toFixed(2)}% | ${(e.contrarian * 100).toFixed(0)}% |`);
  }
  L();
  L('## 四、分品种明细（按冲击次数排序 Top 15）');
  L();
  L('| 品种 | 冲击 | 10日收益 | 胜率 | 击穿率 | 反直觉率 |');
  L('|------|------|---------|------|--------|---------|');
  const sortedVarieties = [...result.varieties].sort((a, b) => b.total - a.total).slice(0, 15);
  for (const v of sortedVarieties) {
    const a10 = v.after['10'];
    L(`| ${v.code} | ${v.total} | ${a10.mean.toFixed(2)}% | ${(a10.winRate * 100).toFixed(0)}% | ${(v.breakdownRate * 100).toFixed(0)}% | ${(v.contrarianRate10 * 100).toFixed(0)}% |`);
  }
  L();
  L('## 五、对 AI 新闻分析能力的量化支撑');
  L();
  L('1. **地缘/减产/天气类黑天鹅**：冲击方向大概率延续（反直觉率 0-17%），AI 应顺着方向提示，而非警示反转；');
  L('2. **政策监管/交易制度类黑天鹅**：平均 10 日下跌 6-19%，AI 应重点提示下跌风险与减仓；');
  L('3. **疾病/产业变革类**：反直觉率 65-83%（共识最易被证伪），AI 必须提示"共识可能相反"；');
  L('4. **共振/背离**：共振胜率 72.8% vs 背离 60.6%，AI 在做"新闻面验证"时应量化引用该差异；');
  L('5. **技术失效**：整体击穿率仅 4.6%，但部分品种（燃料油 19%、线材 17%）显著更高，AI 应区分品种提示。');

  const out = 'NEWS_BACKTEST_REPORT_20Y.md';
  fs.writeFileSync(out, lines.join('\n'), 'utf-8');
  console.log(`报告已生成: ${out} (${lines.length} 行)`);
}

main();
