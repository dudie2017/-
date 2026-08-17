/**
 * P2-a: 全品种跳空/不可成交风险扫描
 *
 * 背景：回测引擎默认「信号日按收盘价成交」，但高跳空品种（如 EC0 集运欧线）
 * 实盘中无法按回测假设价成交。跳空（开盘价 vs 前收盘价）越大，回测结果越失真。
 *
 * 本脚本零重跑成本，直接扫描 data-cache-daily-20y 的日线数据，
 * 统计每个品种的跳空分布，输出风险排名，识别「回测虚高」品种。
 */
import * as fs from 'fs';
import * as path from 'path';

const PRICE_DIR = path.resolve(process.cwd(), 'data-cache-daily-20y');

interface Bar {
  date?: string;
  o?: number;
  h?: number;
  l?: number;
  c?: number;
}

interface GapRisk {
  code: string;
  bars: number;
  avgGap: number;        // 平均 |跳空| 幅度
  gap3Pct: number;       // |跳空| > 3% 的频率
  gap5Pct: number;       // |跳空| > 5% 的频率
  maxGapUp: number;      // 最大向上跳空
  maxGapDown: number;    // 最大向下跳空
  riskLevel: '极高' | '高' | '中' | '低';
}

function analyzeCode(code: string): GapRisk | null {
  const fp = path.join(PRICE_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return null;
  const bars = JSON.parse(fs.readFileSync(fp, 'utf8')) as Bar[];

  const gaps: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prevC = bars[i - 1]?.c ?? 0;
    const curO = bars[i]?.o ?? 0;
    if (prevC > 0 && curO > 0) {
      gaps.push((curO - prevC) / prevC);
    }
  }
  if (!gaps.length) return null;

  const abs = gaps.map((g) => Math.abs(g));
  const avgGap = abs.reduce((a, b) => a + b, 0) / abs.length;
  const gap3Pct = abs.filter((g) => g >= 0.03).length / abs.length;
  const gap5Pct = abs.filter((g) => g >= 0.05).length / abs.length;
  const maxGapUp = Math.max(...gaps);
  const maxGapDown = Math.min(...gaps);

  let riskLevel: GapRisk['riskLevel'] = '低';
  if (avgGap > 0.015 || gap5Pct > 0.03 || Math.abs(maxGapUp) > 0.20 || Math.abs(maxGapDown) > 0.20) {
    riskLevel = '极高';
  } else if (avgGap > 0.01 || gap5Pct > 0.015) {
    riskLevel = '高';
  } else if (avgGap > 0.007) {
    riskLevel = '中';
  }

  return {
    code,
    bars: bars.length,
    avgGap,
    gap3Pct,
    gap5Pct,
    maxGapUp,
    maxGapDown,
    riskLevel,
  };
}

function main() {
  const files = fs
    .readdirSync(PRICE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''))
    .sort();

  const results: GapRisk[] = [];
  for (const code of files) {
    const r = analyzeCode(code);
    if (r) results.push(r);
  }

  results.sort((a, b) => b.avgGap - a.avgGap);

  const levelCount: Record<string, number> = { 极高: 0, 高: 0, 中: 0, 低: 0 };
  results.forEach((r) => levelCount[r.riskLevel]++);

  console.log('=== 全品种跳空风险扫描 ===\n');
  console.log(`品种总数: ${results.length}`);
  console.log(
    `风险分布: 极高=${levelCount['极高']}, 高=${levelCount['高']}, 中=${levelCount['中']}, 低=${levelCount['低']}\n`,
  );

  console.log('=== 跳空风险 Top 20（按平均跳空降序）===');
  console.log(
    '品种    平均跳空    >3%频率   >5%频率   最大上跳   最大下跳   风险',
  );
  for (const r of results.slice(0, 20)) {
    console.log(
      `${r.code.padEnd(6)} ${(r.avgGap * 100).toFixed(2).padStart(6)}% ${(r.gap3Pct * 100).toFixed(1).padStart(6)}% ${(r.gap5Pct * 100).toFixed(1).padStart(6)}% ${(r.maxGapUp * 100).toFixed(1).padStart(7)}% ${(r.maxGapDown * 100).toFixed(1).padStart(8)}% ${r.riskLevel}`,
    );
  }

  console.log('\n=== 极高/高风险品种（建议加滑点或移出生产池）===');
  const highRisk = results.filter((r) => r.riskLevel === '极高' || r.riskLevel === '高');
  for (const r of highRisk) {
    console.log(
      `  [${r.riskLevel}] ${r.code}: 平均跳空=${(r.avgGap * 100).toFixed(2)}%, >5%频率=${(r.gap5Pct * 100).toFixed(1)}%, 最大跳空=${(Math.max(Math.abs(r.maxGapUp), Math.abs(r.maxGapDown)) * 100).toFixed(1)}%`,
    );
  }

  const out = {
    generatedAt: new Date().toISOString(),
    totalVarieties: results.length,
    levelCount,
    highRisk: results.filter((r) => r.riskLevel === '极高' || r.riskLevel === '高'),
    all: results,
  };
  const outPath = path.join(process.cwd(), 'src/data/gapRiskAnalysis.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n已落盘: ${outPath}`);
}

main();
