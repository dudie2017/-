/**
 * 品种数据API路由
 */

import { Router } from 'express';
import { 
  getAllVarietyCostData, 
  getVarietyCostData, 
  getVarietyCostLine,
  getVarietyCostBaselines,
  updateVarietyCostData,
  getLastUpdateTime
} from '../services/varietyData.js';
import { syncFromFeishu } from '../scripts/syncFromFeishu.js';

// 品种代码格式：1-3位大写字母
const CODE_REGEX = /^[A-Z]{1,3}$/;
// PUT 更新可接受的字段白名单（安全：防止客户端写入内部字段）
const ALLOWED_UPDATE_FIELDS = new Set([
  'name', 'exchange', 'category', 'trade_unit', 'margin_rate',
  'price_step', 'trading_hours', 'delivery_months', 'status',
]);

const router = Router();

/**
 * GET /api/v1/variety
 * 获取所有品种成本数据
 */
router.get('/', (req, res) => {
  try {
    const data = getAllVarietyCostData();
    const lastUpdated = getLastUpdateTime();
    
    res.json({
      success: true,
      count: data.length,
      lastUpdated,
      data
    });
  } catch (error) {
    res.status(500).json({ success: false, error: '获取品种数据失败' });
  }
});

/**
 * GET /api/v1/variety/:code
 * 获取单个品种成本数据
 */
router.get('/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const data = getVarietyCostData(code);
    
    if (!data) {
      return res.status(404).json({ success: false, error: '品种不存在' });
    }
    
    res.json({ success: true, data });
  } catch (error) {
    res.status(500).json({ success: false, error: '获取品种数据失败' });
  }
});

/**
 * GET /api/v1/variety/:code/cost
 * 获取品种成本线
 */
router.get('/:code/cost', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    const cost = getVarietyCostLine(code);
    const baselines = getVarietyCostBaselines(code);
    
    if (cost === null) {
      return res.status(404).json({ success: false, error: '品种不存在' });
    }
    
    res.json({ 
      success: true, 
      code,
      cost,
      baselines
    });
  } catch (error) {
    res.status(500).json({ success: false, error: '获取成本数据失败' });
  }
});

/**
 * PUT /api/v1/variety/:code
 * 更新品种成本数据
 */
router.put('/:code', (req, res) => {
  try {
    const code = req.params.code.toUpperCase();
    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({ success: false, error: `无效的品种代码: ${code}` });
    }
    
    // 字段白名单过滤：仅接受允许的字段
    const updates: Record<string, unknown> = {};
    const raw = req.body;
    if (typeof raw !== 'object' || raw === null) {
      return res.status(400).json({ success: false, error: '请求体必须是JSON对象' });
    }
    for (const key of Object.keys(raw)) {
      if (ALLOWED_UPDATE_FIELDS.has(key)) {
        updates[key] = raw[key];
      }
    }
    
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ success: false, error: '没有有效的更新字段' });
    }
    
    const success = updateVarietyCostData(code, updates);
    
    if (!success) {
      return res.status(404).json({ success: false, error: '品种不存在' });
    }
    
    res.json({ success: true, message: '更新成功' });
  } catch (error) {
    res.status(500).json({ success: false, error: '更新品种数据失败' });
  }
});

/**
 * POST /api/v1/variety/sync/feishu
 * 从飞书同步品种数据
 */
router.post('/sync/feishu', (req, res) => {
  try {
    const result = syncFromFeishu();
    
    if (!result.success) {
      return res.status(500).json(result);
    }
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: '同步失败' });
  }
});

export default router;
