// @ts-nocheck
/**
 * 26 品种组合分析 - 阶段 3：组合优化
 * 
 * 功能：
 * 1. 马科维茨有效前沿
 * 2. 风险平价组合
 * 3. 不同风险偏好的最优配置
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取数据
const summaryPath = path.join(__dirname, '../data/26varieties_summary.json');
const corrPath = path.join(__dirname, '../data/correlation_analysis.json');
const varieties = JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));
const corrData = JSON.parse(fs.readFileSync(corrPath, 'utf-8'));
const corrMatrix = corrData.corrMatrix;

// 品种代码列表
const codes = varieties.map((v: any) => v.code);

// 预期收益（使用历史中位数收益）
const expectedReturns = varieties.map((v: any) => v.totalReturn);

// 波动率（简化：使用收益的标准差）
function loadVolatility(code: string): number {
  const filePath = path.join(__dirname, `../data/${code}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) return 0;
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const experiments = data.fullResults || [];
  const returns = experiments.map(e => e.stats?.totalPnl || 0);
  
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// 计算组合收益
function portfolioReturn(weights: number[]): number {
  return weights.reduce((sum, w, i) => sum + w * expectedReturns[i], 0);
}

// 计算组合波动率
function portfolioVolatility(weights: number[]): number {
  let variance = 0;
  for (let i = 0; i < codes.length; i++) {
    for (let j = 0; j < codes.length; j++) {
      const corr = corrMatrix[codes[i]]?.[codes[j]] || 0;
      const vol_i = loadVolatility(codes[i]);
      const vol_j = loadVolatility(codes[j]);
      variance += weights[i] * weights[j] * corr * vol_i * vol_j;
    }
  }
  return Math.sqrt(variance);
}

// 计算夏普比率
function sharpeRatio(weights: number[], riskFreeRate: number = 0): number {
  const ret = portfolioReturn(weights);
  const vol = portfolioVolatility(weights);
  return vol > 0 ? (ret - riskFreeRate) / vol : 0;
}

// 等权重组合
function equalWeightPortfolio(): number[] {
  const w = 1 / codes.length;
  return codes.map(() => w);
}

// 风险平价组合（简化版：波动率倒数加权）
function riskParityPortfolio(): number[] {
  const vols = codes.map(c => loadVolatility(c));
  const invVols = vols.map(v => v > 0 ? 1 / v : 0);
  const sum = invVols.reduce((a, b) => a + b, 0);
  return sum > 0 ? invVols.map(v => v / sum) : equalWeightPortfolio();
}

// 最大夏普比率组合（简化：使用预期收益/波动率排序）
function maxSharpePortfolio(): number[] {
  const scores = codes.map((code, i) => {
    const vol = loadVolatility(code);
    return vol > 0 ? expectedReturns[i] / vol : 0;
  });
  
  // 选择前 5 个品种
  const top5 = scores
    .map((s, i) => ({ code: codes[i], score: s }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  
  const weights = codes.map(c => {
    const item = top5.find(t => t.code === c);
    return item ? 1 / 5 : 0;
  });
  
  return weights;
}

// 主函数
async function main() {
  console.log('📊 26 品种组合分析 - 阶段 3：组合优化\n');
  
  // 预加载波动率
  console.log('计算波动率...');
  const vols: Record<string, number> = {};
  for (const code of codes) {
    vols[code] = loadVolatility(code);
  }
  
  // 等权重组合
  console.log('\n 等权重组合:');
  const ewWeights = equalWeightPortfolio();
  const ewReturn = portfolioReturn(ewWeights);
  const ewVol = portfolioVolatility(ewWeights);
  const ewSharpe = sharpeRatio(ewWeights);
  console.log(`  预期收益：${(ewReturn/10000).toFixed(2)}万`);
  console.log(`  波动率：${(ewVol/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${ewSharpe.toFixed(3)}`);
  
  // 风险平价组合
  console.log('\n 风险平价组合（波动率倒数加权）:');
  const rpWeights = riskParityPortfolio();
  const rpReturn = portfolioReturn(rpWeights);
  const rpVol = portfolioVolatility(rpWeights);
  const rpSharpe = sharpeRatio(rpWeights);
  console.log(`  预期收益：${(rpReturn/10000).toFixed(2)}万`);
  console.log(`  波动率：${(rpVol/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${rpSharpe.toFixed(3)}`);
  
  // 最大夏普组合
  console.log('\n 最大夏普组合（Top 5 品种）:');
  const msWeights = maxSharpePortfolio();
  const msReturn = portfolioReturn(msWeights);
  const msVol = portfolioVolatility(msWeights);
  const msSharpe = sharpeRatio(msWeights);
  console.log(`  预期收益：${(msReturn/10000).toFixed(2)}万`);
  console.log(`  波动率：${(msVol/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${msSharpe.toFixed(3)}`);
  
  // 显示最大夏普组合的品种
  const topVarieties = codes
    .map((code, i) => ({ code, weight: msWeights[i] }))
    .filter(v => v.weight > 0)
    .map(v => {
      const variety = varieties.find((var_: any) => var_.code === v.code);
      return `${v.code}(${variety?.name}): ${(v.weight * 100).toFixed(0)}%`;
    });
  console.log(`  品种配置：${topVarieties.join(', ')}`);
  
  // 保存结果
  const outputPath = path.join(__dirname, '../data/portfolio_optimization.json');
  fs.writeFileSync(outputPath, JSON.stringify({
    equalWeight: { weights: ewWeights, return: ewReturn, volatility: ewVol, sharpe: ewSharpe },
    riskParity: { weights: rpWeights, return: rpReturn, volatility: rpVol, sharpe: rpSharpe },
    maxSharpe: { weights: msWeights, return: msReturn, volatility: msVol, sharpe: msSharpe },
  }, null, 2));
  console.log(`\n 结果已保存到 ${outputPath}`);
}

main().catch(console.error);
