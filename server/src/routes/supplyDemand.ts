import { Router } from 'express';
import * as supplyDemandService from '../services/supplyDemand.js';

const router = Router();

// 品种代码格式：1-3位大写字母
const VARIETY_CODE_REGEX = /^[A-Z]{1,3}$/;

// GET /api/v1/supply-demand - 获取所有品种的供需分析
router.get('/', (req, res) => {
  try {
    const analysis = supplyDemandService.getAllSupplyDemandAnalysis();
    // 计算汇总
    const summary = {
      supplyExcess: analysis.filter((a: any) => a.balance?.signal === 'supply_excess').length,
      demandExcess: analysis.filter((a: any) => a.balance?.signal === 'demand_excess').length,
      balanced: analysis.filter((a: any) => a.balance?.signal === 'balanced').length,
    };
    // 检查数据是否充足（至少需要3天历史数据）
    const dataSufficient = analysis.some((a: any) => (a.supply?.historyDays || 0) >= 3);
    res.json({ success: true, data: analysis, summary, dataSufficient });
  } catch (error) {
    console.error('Failed to analyze supply/demand:', error);
    res.status(500).json({ success: false, error: 'Failed to analyze supply/demand' });
  }
});

// GET /api/v1/supply-demand/:variety - 获取单个品种的供需分析
router.get('/:variety', (req, res) => {
  try {
    const { variety } = req.params;
    if (!VARIETY_CODE_REGEX.test(variety.toUpperCase())) {
      return res.status(400).json({ success: false, error: `无效的品种代码: ${variety}` });
    }
    const analysis = supplyDemandService.analyzeSupplyDemand(variety.toUpperCase());
    res.json(analysis);
  } catch (error) {
    console.error('Failed to analyze supply/demand:', error);
    res.status(500).json({ error: 'Failed to analyze supply/demand' });
  }
});

export default router;
