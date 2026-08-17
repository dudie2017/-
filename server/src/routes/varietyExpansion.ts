import { Router, type Request, type Response } from 'express';
import { 
  getSupportedVarieties, 
  getVarietyBacktestStatus,
  getVarietyModelStatus,
  triggerModelTraining 
} from '../services/varietyExpansionService';

const router = Router();

/**
 * 获取支持的品种列表
 */
router.get('/list', (req: Request, res: Response) => {
  try {
    const varieties = getSupportedVarieties();
    res.json({
      success: true,
      data: varieties,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取品种列表失败',
    });
  }
});

/**
 * 获取品种回测状态
 */
router.get('/backtest-status/:code', (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);
    const status = getVarietyBacktestStatus(code);
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取回测状态失败',
    });
  }
});

/**
 * 获取品种模型状态
 */
router.get('/model-status/:code', (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);
    const status = getVarietyModelStatus(code);
    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: '获取模型状态失败',
    });
  }
});

/**
 * 触发品种模型训练
 */
router.post('/train-model/:code', async (req: Request, res: Response) => {
  try {
    const code = String(req.params.code);
    const result = await triggerModelTraining(code);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error('Trigger model training error:', error);
    res.status(500).json({
      success: false,
      error: '触发模型训练失败',
    });
  }
});

/**
 * 获取所有品种的综合状态（前端主接口）
 */
router.get('/status', (req: Request, res: Response) => {
  try {
    const varieties = getSupportedVarieties();
    const statusList = varieties.map(v => {
      const backtestStatus = getVarietyBacktestStatus(v.code);
      const modelStatus = getVarietyModelStatus(v.code);
      return {
        code: v.code,
        name: v.name,
        sector: v.sector,
        hasBacktest: backtestStatus.hasData,
        hasModel: modelStatus.hasModel,
        modelAccuracy: modelStatus.accuracy,
        modelVersion: modelStatus.version,
        barsCount: modelStatus.barsCount,
      };
    });
    res.json({
      success: true,
      data: { varieties: statusList },
    });
  } catch (error) {
    console.error('Get variety status error:', error);
    res.status(500).json({
      success: false,
      error: '获取品种状态失败',
    });
  }
});

/**
 * 批量训练所有品种模型
 */
router.post('/batch-train', async (req: Request, res: Response) => {
  try {
    const varieties = getSupportedVarieties();
    const results: Array<{ code: string; success: boolean; error?: string }> = [];
    
    for (const v of varieties) {
      try {
        const backtestStatus = getVarietyBacktestStatus(v.code);
        if (!backtestStatus.hasData) {
          results.push({ code: v.code, success: false, error: '无回测数据' });
          continue;
        }
        await triggerModelTraining(v.code);
        results.push({ code: v.code, success: true });
      } catch (err: any) {
        results.push({ code: v.code, success: false, error: err.message });
      }
    }
    
    const successCount = results.filter(r => r.success).length;
    
    res.json({
      success: true,
      data: { results, successCount },
    });
  } catch (error) {
    console.error('Batch train error:', error);
    res.status(500).json({
      success: false,
      error: '批量训练失败',
    });
  }
});

export default router;
