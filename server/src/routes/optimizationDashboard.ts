/**
 * 优化仪表板 API
 * 
 * 提供所有分析结果数据的统一接口
 */

import { Router } from 'express';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', 'data');

const router = Router();

// 安全读取 JSON 文件
function readJson(filename: string): any {
  const filePath = path.join(DATA_DIR, filename);
  if (!existsSync(filePath)) {
    return { error: `文件不存在: ${filename}` };
  }
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (e) {
    return { error: `读取失败: ${(e as Error).message}` };
  }
}

// 获取所有分析结果概览
router.get('/overview', (_req, res) => {
  const files = [
    'rescoreReport.json',
    'costSensitivityAnalysis.json',
    'volatilityRegimeAnalysis.json',
    'riskParityPortfolio.json',
    'tailRiskCVaR.json',
    'varietyEntryFunnel.json',
    'seasonalityAnalysis.json',
    'parameterAdaptationAnalysis.json',
    'executionQualityAudit.json',
    'stopLossOptimization.json',
    'dynamicStopLossAnalysis.json',
    'batchTakeProfitAnalysis.json',
    'positionSizingAnalysis.json',
    'multiTimeframeValidation.json',
  ];

  const overview: Record<string, any> = {};
  for (const f of files) {
    const key = f.replace('.json', '');
    overview[key] = readJson(f);
  }

  res.json(overview);
});

// 获取止损止盈优化结果
router.get('/stop-loss', (_req, res) => {
  res.json({
    gridSearch: readJson('stopLossOptimization.json'),
    dynamic: readJson('dynamicStopLossAnalysis.json'),
    batchTakeProfit: readJson('batchTakeProfitAnalysis.json'),
  });
});

// 获取仓位管理结果
router.get('/position-sizing', (_req, res) => {
  res.json(readJson('positionSizingAnalysis.json'));
});

// 获取多时间框架验证结果
router.get('/multi-timeframe', (_req, res) => {
  res.json(readJson('multiTimeframeValidation.json'));
});

// 获取品种入池漏斗
router.get('/funnel', (_req, res) => {
  res.json(readJson('varietyEntryFunnel.json'));
});

// 获取风险平价组合
router.get('/risk-parity', (_req, res) => {
  res.json(readJson('riskParityPortfolio.json'));
});

// 获取成本敏感性
router.get('/cost-sensitivity', (_req, res) => {
  res.json(readJson('costSensitivityAnalysis.json'));
});

// 获取波动率Regime
router.get('/volatility-regime', (_req, res) => {
  res.json(readJson('volatilityRegimeAnalysis.json'));
});

// 获取尾部风险
router.get('/tail-risk', (_req, res) => {
  res.json(readJson('tailRiskCVaR.json'));
});

// 获取季节性分析
router.get('/seasonality', (_req, res) => {
  res.json(readJson('seasonalityAnalysis.json'));
});

// 获取参数自适应
router.get('/parameter-adaptation', (_req, res) => {
  res.json(readJson('parameterAdaptationAnalysis.json'));
});

// 获取执行质量审计
router.get('/execution-quality', (_req, res) => {
  res.json(readJson('executionQualityAudit.json'));
});

// 获取品种重分级
router.get('/rescore', (_req, res) => {
  res.json(readJson('rescoreReport.json'));
});

export default router;
