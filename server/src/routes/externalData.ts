/**
 * 外部数据源路由
 * 提供EIA原油库存、OPEC数据等外部行业数据
 */

import { Router } from 'express';
import { 
  getAllCrudeOilData, 
  getEIACrudeOilInventory, 
  getUSCrudeOilProduction,
  getOPECBasketPrice,
  getShaleOilRigCount
} from '../services/externalDataService.js';

const router = Router();

/**
 * 获取所有原油相关外部数据
 */
router.get('/crude-oil', async (req, res) => {
  try {
    const data = await getAllCrudeOilData();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * 获取EIA原油库存数据
 */
router.get('/crude-oil/inventory', async (req, res) => {
  try {
    const data = await getEIACrudeOilInventory();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * 获取美国原油产量数据
 */
router.get('/crude-oil/production', async (req, res) => {
  try {
    const data = await getUSCrudeOilProduction();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * 获取OPEC一篮子价格
 */
router.get('/crude-oil/opec-price', async (req, res) => {
  try {
    const data = await getOPECBasketPrice();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * 获取页岩油钻机数量
 */
router.get('/crude-oil/rig-count', async (req, res) => {
  try {
    const data = await getShaleOilRigCount();
    res.json({
      success: true,
      data
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

/**
 * 状态检查
 */
router.get('/status', async (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'ok',
      sources: ['EIA', 'OPEC', 'Baker Hughes'],
      lastUpdate: new Date().toISOString()
    }
  });
});

/**
 * 获取品种相关的外部数据
 */
router.get('/variety/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const data = await getAllCrudeOilData();
    
    // 根据品种代码返回相关数据
    const varietyData: any = { varietyCode: code };
    
    if (['SC', '原油', '原油期货'].includes(code)) {
      varietyData.crudeOil = data.inventory;
      varietyData.opecBasket = data.opecPrice;
      varietyData.rigCount = data.rigCount;
      varietyData.production = data.production;
    }
    
    res.json({
      success: true,
      data: varietyData
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: (error as Error).message
    });
  }
});

export default router;
