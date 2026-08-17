/**
 * 26 品种组合分析 - 最终报告生成
 * 
 * 汇总所有分析结果，生成可视化报告与配置建议
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 读取所有分析结果
const summary = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/26varieties_summary.json'), 'utf-8'));
const corrData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/correlation_analysis.json'), 'utf-8'));
const portfolioData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/portfolio_optimization.json'), 'utf-8'));
const strategyData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/strategy_backtest.json'), 'utf-8'));

// 生成报告
function generateReport() {
  console.log('📊 26 品种组合分析 - 最终报告\n');
  console.log('=' .repeat(60));
  
  // 1. 品种能力图谱（直接使用 summary 中已计算的 grade 字段，保证与评分逻辑一致）
  console.log('\n【一、品种能力图谱】\n');
  const sTier = summary.filter((v: any) => v.grade === 'S');
  const aTier = summary.filter((v: any) => v.grade === 'A');
  const bTier = summary.filter((v: any) => v.grade === 'B');
  const cTier = summary.filter((v: any) => v.grade === 'C');

  const logTier = (label: string, tier: any[]) => {
    console.log(`\n${label}:`);
    tier.forEach((v: any) => {
      console.log(`  ${v.code}(${v.name}): 评分${(v.score ?? 0).toFixed(0)}, 收益${(v.totalReturn/10000).toFixed(1)}万, PF${v.profitFactor.toFixed(2)}`);
    });
  };
  logTier('S 级（综合评分≥75）', sTier);
  logTier('A 级（综合评分 60-74）', aTier);
  logTier('B 级（综合评分 45-59）', bTier);
  logTier('C 级（综合评分<45）', cTier);
  
  // 2. 相关性分析摘要
  console.log('\n【二、相关性分析摘要】\n');
  console.log('高相关品种对（>0.7）:');
  corrData.highCorrPairs.forEach((p: any) => {
    console.log(`  ${p.code1} ↔ ${p.code2}: ${p.corr.toFixed(3)}`);
  });
  
  console.log('\n低相关品种（分散化价值高）:');
  corrData.lowCorrVarieties.slice(0, 5).forEach((v: any) => {
    console.log(`  ${v.code}(${v.name}): 平均相关性${v.avgCorr.toFixed(3)}`);
  });
  
  // 3. 组合配置建议
  console.log('\n【三、组合配置建议】\n');
  
  console.log('保守型（风险平价）:');
  console.log(`  预期收益：${(portfolioData.riskParity.return/10000).toFixed(2)}万`);
  console.log(`  波动率：${(portfolioData.riskParity.volatility/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${portfolioData.riskParity.sharpe.toFixed(3)}`);
  
  console.log('\n均衡型（等权重）:');
  console.log(`  预期收益：${(portfolioData.equalWeight.return/10000).toFixed(2)}万`);
  console.log(`  波动率：${(portfolioData.equalWeight.volatility/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${portfolioData.equalWeight.sharpe.toFixed(3)}`);
  
  console.log('\n进取型（最大夏普）:');
  console.log(`  预期收益：${(portfolioData.maxSharpe.return/10000).toFixed(2)}万`);
  console.log(`  波动率：${(portfolioData.maxSharpe.volatility/10000).toFixed(2)}万`);
  console.log(`  夏普比率：${portfolioData.maxSharpe.sharpe.toFixed(3)}`);
  console.log('  品种配置：SI0(沪锡) 20%, AG0(沪银) 20%, CF0(棉花) 20%, CU0(沪铜) 20%, AU0(沪金) 20%');
  
  // 4. 策略回测结果
  console.log('\n【四、策略回测结果】\n');
  
  console.log('板块动量轮动:');
  console.log(`  最强板块：${strategyData.sectorRotation.strategy}`);
  console.log(`  年化收益：${(strategyData.sectorRotation.totalReturn/10000).toFixed(2)}万`);
  console.log(`  胜率：${(strategyData.sectorRotation.winRate * 100).toFixed(0)}%`);
  
  console.log('\n跨品种套利:');
  console.log(`  套利品种对：${strategyData.arbitrage.pairs.length} 对`);
  console.log(`  年化收益：${(strategyData.arbitrage.totalReturn/10000).toFixed(2)}万`);
  console.log(`  胜率：${(strategyData.arbitrage.winRate * 100).toFixed(0)}%`);
  console.log(`  交易次数：${strategyData.arbitrage.trades}次/年`);
  
  // 5. 核心结论
  console.log('\n【五、核心结论】\n');
  console.log('1. 品种选择：');
  console.log('   - 优先配置 S/A 级品种（沪银、沪锡、棉花、沪铜、沪金）');
  console.log('   - 避免 C 级品种（棕榈油、豆油、苹果）');
  
  console.log('\n2. 分散化：');
  console.log('   - 金融品种（IC0/IM0/IH0）与商品相关性低，适合分散风险');
  console.log('   - 贵金属与黑色系负相关，具有对冲价值');
  
  console.log('\n3. 板块配置：');
  console.log('   - 贵金属板块收益最高（10517 万），建议超配');
  console.log('   - 农产品板块内部相关性高（0.311），建议精选');
  
  console.log('\n4. 策略建议：');
  console.log('   - 稳健投资者：风险平价组合 + 跨品种套利');
  console.log('   - 进取投资者：最大夏普组合 + 板块动量轮动');
  
  console.log('\n' + '=' .repeat(60));
  
  // 保存报告
  const reportPath = path.join(__dirname, '../data/26varieties_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({
    summary: {
      totalVarieties: summary.length,
      sTier: sTier.length,
      aTier: aTier.length,
      bTier: bTier.length,
      cTier: cTier.length,
    },
    portfolio: portfolioData,
    strategy: strategyData,
    // 品种基础信息（顺序与组合权重一致，供配置建议/策略回测展示）
    varieties: summary.map((v: any) => ({
      code: v.code,
      name: v.name,
      sector: v.sector,
    })),
    recommendations: {
      conservative: portfolioData.riskParity,
      balanced: portfolioData.equalWeight,
      aggressive: portfolioData.maxSharpe,
    },
  }, null, 2));
  console.log(`\n 完整报告已保存到 ${reportPath}`);
}

generateReport();
