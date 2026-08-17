// @ts-nocheck
/**
 * 26 品种组合分析 - 阶段 2：相关性分析
 * 
 * 功能：
 * 1. 计算品种间收益相关性矩阵
 * 2. 板块相关性分析
 * 3. 识别高相关/低相关品种对
 * 4. 找出分散化价值高的品种
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取汇总数据
const summaryPath = path.join(__dirname, '../data/26varieties_summary.json');
const varieties = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

// 读取每个品种的完整实验数据，提取收益序列
function loadReturnSeries(code: string): number[] | null {
  const filePath = path.join(__dirname, `../data/${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return null;
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const experiments = data.fullResults || [];
  
  // 提取每个实验的总收益
  return experiments.map(e => e.stats?.totalPnl || 0);
}

// 计算相关系数
function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n === 0) return 0;
  
  const meanX = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const meanY = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  
  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : 0;
}

// 主函数
async function main() {
  console.log('📊 26 品种组合分析 - 阶段 2：相关性分析\n');
  
  const codes = varieties.map((v: any) => v.code);
  const returnSeries: Record<string, number[]> = {};
  
  // 加载所有品种的收益序列
  console.log('加载收益序列...');
  for (const code of codes) {
    const series = loadReturnSeries(code);
    if (series) {
      returnSeries[code] = series;
      console.log(`  ✅ ${code}: ${series.length} 个实验`);
    }
  }
  
  // 计算相关性矩阵
  console.log('\n计算相关性矩阵...');
  const corrMatrix: Record<string, Record<string, number>> = {};
  
  for (const code1 of codes) {
    corrMatrix[code1] = {};
    for (const code2 of codes) {
      if (code1 === code2) {
        corrMatrix[code1][code2] = 1;
      } else if (corrMatrix[code2]?.[code1] !== undefined) {
        corrMatrix[code1][code2] = corrMatrix[code2][code1];
      } else {
        const s1 = returnSeries[code1];
        const s2 = returnSeries[code2];
        if (s1 && s2) {
          corrMatrix[code1][code2] = correlation(s1, s2);
        } else {
          corrMatrix[code1][code2] = 0;
        }
      }
    }
  }
  
  // 找出高相关品种对（>0.7）
  console.log('\n 高相关品种对 (相关系数 > 0.7):\n');
  const highCorrPairs: Array<{ code1: string; code2: string; corr: number }> = [];
  
  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const corr = corrMatrix[codes[i]][codes[j]];
      if (corr > 0.7) {
        highCorrPairs.push({ code1: codes[i], code2: codes[j], corr });
      }
    }
  }
  
  highCorrPairs.sort((a, b) => b.corr - a.corr);
  highCorrPairs.forEach(p => {
    const v1 = varieties.find((v: any) => v.code === p.code1);
    const v2 = varieties.find((v: any) => v.code === p.code2);
    console.log(`  ${p.code1}(${v1?.name}) ↔ ${p.code2}(${v2?.name}): ${p.corr.toFixed(3)}`);
  });
  
  // 找出低相关品种（分散化价值高）
  console.log('\n 低相关品种（平均相关性 < 0.3，分散化价值高）:\n');
  const avgCorr: Record<string, number> = {};
  
  for (const code of codes) {
    const corrs = codes.filter(c => c !== code).map(c => corrMatrix[code][c]);
    avgCorr[code] = corrs.reduce((a, b) => a + b, 0) / corrs.length;
  }
  
  const lowCorrVarieties = codes
    .map(code => ({ code, avgCorr: avgCorr[code] }))
    .filter(v => v.avgCorr < 0.3)
    .sort((a, b) => a.avgCorr - b.avgCorr);
  
  lowCorrVarieties.forEach(v => {
    const variety = varieties.find((var_: any) => var_.code === v.code);
    console.log(`  ${v.code}(${variety?.name}): 平均相关性 ${v.avgCorr.toFixed(3)}`);
  });
  
  // 板块相关性
  console.log('\n📈 板块平均相关性:\n');
  const sectors: Record<string, string[]> = {};
  varieties.forEach((v: any) => {
    if (!sectors[v.sector]) sectors[v.sector] = [];
    sectors[v.sector].push(v.code);
  });
  
  const sectorNames = Object.keys(sectors);
  for (let i = 0; i < sectorNames.length; i++) {
    for (let j = i; j < sectorNames.length; j++) {
      const s1 = sectorNames[i];
      const s2 = sectorNames[j];
      
      let totalCorr = 0, count = 0;
      for (const c1 of sectors[s1]) {
        for (const c2 of sectors[s2]) {
          if (c1 !== c2) {
            totalCorr += corrMatrix[c1][c2];
            count++;
          }
        }
      }
      
      const avgSectorCorr = count > 0 ? totalCorr / count : 0;
      const marker = i === j ? '(内部)' : '';
      console.log(`  ${s1} ↔ ${s2} ${marker}: ${avgSectorCorr.toFixed(3)}`);
    }
  }
  
  // 保存结果
  const outputPath = path.join(__dirname, '../data/correlation_analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    corrMatrix,
    highCorrPairs,
    lowCorrVarieties,
    avgCorr,
  }, null, 2));
  console.log(`\n 结果已保存到 ${outputPath}`);
}

main().catch(console.error);
