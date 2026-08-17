/**
 * 从飞书同步数据
 * - 品种档案表：品种成本数据
 * - 现货价格表：现货价格、基差
 * - 仓单数据表：仓单数量
 * - 每日基本面流水表：三信号分析、库存分位、需求状况
 * - 焦煤深度监控表：铁水产量、港口库存、电炉开工率
 * - 生猪每日监控表：五句金律评分、三信号、利润数据
 * - 生猪季节性历史参考表：月度季节性规律
 */

import { spawnSync } from 'child_process';
import { initVarietyDataFromFeishu, getAllVarietyCostData } from '../services/varietyData.js';
import { 
  saveSpotPriceRecords, 
  saveWarehouseReceiptRecord,
  saveDailyFundamentalFlow,
  saveCokingCoalMonitor,
  savePigDailyMonitor,
  savePigSeasonalReference
} from '../services/database.js';
import { execSync } from 'child_process';

// 飞鸽配置
const BASE_TOKEN = 'IuUabzH90awyKNsbhcLcijOgnXf';
const TABLES = {
  variety: 'tbl8UkCF94x7vLlT',           // 品种档案表（在原bitable中）
  spotPrice: 'tbl70Ov3rDrH0YcS',         // 现货价格表
  warehouseReceipt: 'tblDo0LRGrTWRnwC',  // 仓单数据表
  dailyFundamentalFlow: 'tblVQLz35PyEEI8V',  // 每日基本面流水表
  cokingCoalMonitor: 'tblPZYF1UncqCf97'      // 焦煤深度监控表
};

// 生猪专项数据bitable
const PIG_BASE_TOKEN = 'QkeDbG7jOa2GwqsbOuic4capnAc';
const PIG_TABLES = {
  dailyMonitor: 'tbl5OMaBBGQ0XJnN',           // 生猪每日监控表
  seasonalReference: 'tblzJRQ4v6NB1I4c'       // 季节性历史参考表
};

// 原bitable（品种档案表）
const ORIGINAL_BASE_TOKEN = 'FNe8bl459aqaXYs7WkMcBb4ZnCe';

/**
 * 从飞书CLI读取数据
 */
function fetchFromFeishu(baseToken: string, tableId: string, limit: number = 200): any[] {
  try {
    // lark-cli limit 最大200
    const actualLimit = Math.min(limit, 200);
    const result = spawnSync('lark-cli', ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId, '--limit', String(actualLimit), '--format', 'json'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.error || result.status !== 0) {
      console.log(`[飞书同步] 读取表 ${tableId} 失败: ${result.stderr || result.error?.message}`);
      return [];
    }
    
    const data = JSON.parse(result.stdout);
    return data?.data?.data || [];
  } catch (error) {
    // 静默失败，返回空数组
    console.log(`[飞书同步] 读取表 ${tableId} 异常: ${error}`);
    return [];
  }
}

/**
 * 同步品种档案表
 */
function syncVarietyData(): { success: boolean; count: number; message: string } {
  console.log('[飞书同步] 开始同步品种档案表...');
  
  const records = fetchFromFeishu(ORIGINAL_BASE_TOKEN, TABLES.variety);
  
  if (records.length === 0) {
    return { success: false, count: 0, message: '未获取到品种数据' };
  }
  
  const varieties = [];
  for (const record of records) {
    if (record.length < 27) continue;
    
    const variety = {
      code: record[26], // 品种代码
      name: record[0], // 品种名称
      cost: record[2], // 成本线
      cost_baseline_1: record[1], // 成本基准线1
      cost_baseline_2: record[10], // 成本基准线2
      cost_baseline_3: record[18], // 成本基准线3
      exchange: record[16], // 交易所
      seasonal_rule: record[7], // 季节性铁律
      core_pricing_anchor: record[13], // 最核心定价锚点
      variety_factors: record[25], // 品种特有因子说明
      industry_chain: record[21], // 产业链属性
      category: record[24], // 品类
      contract_multiplier: record[4], // 期货合约乘数
      substitute: record[5], // 核心替代品
      pricing_power: record[6], // 定价权所属方
    };
    
    if (variety.code && variety.name && variety.cost) {
      varieties.push(variety);
    }
  }
  
  if (varieties.length === 0) {
    return { success: false, count: 0, message: '解析品种数据失败' };
  }
  
  initVarietyDataFromFeishu(varieties);
  const allData = getAllVarietyCostData();
  
  return {
    success: true,
    count: allData.length,
    message: `成功同步 ${allData.length} 个品种数据`
  };
}

/**
 * 同步现货价格表
 */
function syncSpotPriceData(): { success: boolean; count: number; message: string } {
  console.log('[飞书同步] 开始同步现货价格表...');
  
  const records = fetchFromFeishu(BASE_TOKEN, TABLES.spotPrice);
  
  if (records.length === 0) {
    return { success: false, count: 0, message: '未获取到现货价格数据' };
  }
  
  // 字段顺序：日期, 品种名称, 基差率, 期货主力价, 基差, 品种代码, 数据来源, 现货价格
  const spotPrices = [];
  for (const record of records) {
    if (!record || record.length < 8) continue;
    
    const dateStr = record[0];
    if (!dateStr) continue;
    
    // 解析日期
    const tradeDate = dateStr.split(' ')[0];
    
    const spotPrice = {
      trade_date: tradeDate,
      name: record[1] || '',
      basis_rate: record[2] || 0,
      futures_price: record[3] || 0,
      basis: record[4] || 0,
      code: record[5] || '',
      data_source: record[6] || '',
      spot_price: record[7] || 0
    };
    
    if (spotPrice.code && spotPrice.trade_date) {
      spotPrices.push(spotPrice);
    }
  }
  
  if (spotPrices.length === 0) {
    return { success: false, count: 0, message: '解析现货价格数据失败' };
  }
  
  const savedCount = saveSpotPriceRecords(spotPrices);
  
  return {
    success: true,
    count: savedCount,
    message: `成功同步 ${savedCount} 条现货价格数据`
  };
}

/**
 * 同步仓单数据表
 */
function syncWarehouseReceiptData(): { success: boolean; count: number; message: string } {
  console.log('[飞书同步] 开始同步仓单数据表...');
  
  const records = fetchFromFeishu(BASE_TOKEN, TABLES.warehouseReceipt);
  
  if (records.length === 0) {
    return { success: false, count: 0, message: '未获取到仓单数据' };
  }
  
  // 字段顺序：日期, (unknown), 仓单数量, 仓单变化, 交易所, 品种代码, 品种名称
  const warehouseReceipts = [];
  for (const record of records) {
    if (!record || record.length < 7) continue;
    
    const dateStr = record[0];
    if (!dateStr) continue;
    
    // 解析日期
    const tradeDate = dateStr.split(' ')[0];
    
    const warehouseReceipt = {
      trade_date: tradeDate,
      code: record[5] || '',
      name: record[6] || '',
      receipt_qty: record[2] || 0,
      receipt_change: record[3] || 0,
      receipt_change_pct: 0,
      warehouse_distribution: '',
      supply_demand_signal: '',
      supply_demand_score: 0
    };
    
    // 计算变化百分比
    if (warehouseReceipt.receipt_qty > 0 && warehouseReceipt.receipt_change !== 0) {
      const prevQty = warehouseReceipt.receipt_qty - warehouseReceipt.receipt_change;
      if (prevQty > 0) {
        warehouseReceipt.receipt_change_pct = (warehouseReceipt.receipt_change / prevQty) * 100;
      }
    }
    
    if (warehouseReceipt.code && warehouseReceipt.trade_date) {
      warehouseReceipts.push(warehouseReceipt);
    }
  }
  
  if (warehouseReceipts.length === 0) {
    return { success: false, count: 0, message: '解析仓单数据失败' };
  }
  
  let savedCount = 0;
  for (const receipt of warehouseReceipts) {
    try {
      saveWarehouseReceiptRecord(receipt);
      savedCount++;
    } catch (error) {
      // Error already logged
    }
  }
  
  return {
    success: true,
    count: savedCount,
    message: `成功同步 ${savedCount} 条仓单数据`
  };
}

/**
 * 同步每日基本面流水数据
 */
export function syncDailyFundamentalFlowData(): { success: boolean; count: number; message: string } {
  console.log('[飞书同步] 开始同步每日基本面流水数据...');
  
  const records = fetchFromFeishu(BASE_TOKEN, TABLES.dailyFundamentalFlow);
  
  if (records.length === 0) {
    return { success: false, count: 0, message: '未获取到每日基本面流水数据' };
  }
  
  // 解析字段（根据实际字段顺序）
  // 字段: 品种代码, 主力合约价格, 事件驱动评分, 交易日, 三信号结论, 持仓量_OI, 基差, 
  //       需求好坏, 三信号S3外力拐点, 库存量, 三信号S2五年极值, 库存分位, 库存高低, 
  //       仓单变动, 价格行为预警, 现货价, 成本线, 三信号S1供需变化, 三信号通过数, 结算价, 宏观风险等级
  const fundamentalFlows: any[] = [];
  for (const record of records) {
    if (record.length < 21) continue;
    
    const dateStr = record[3];
    if (!dateStr) continue;
    const tradeDate = dateStr.split(' ')[0];
    
    const flow = {
      trade_date: tradeDate,
      code: record[0] || '',
      futures_price: record[1] || 0,
      settle_price: record[19] || 0,
      spot_price: record[15] || 0,
      cost_line: record[16] || 0,
      basis: record[6] || 0,
      inventory: record[9] || 0,
      inventory_percentile: record[11] || 0,
      inventory_level: Array.isArray(record[12]) ? record[12][0] : (record[12] || ''),
      warehouse_change: record[13] || 0,
      open_interest: record[5] || 0,
      demand_status: Array.isArray(record[7]) ? record[7][0] : (record[7] || ''),
      signal_conclusion: record[4] || '',
      signal_count: record[18] || 0,
      signal_s1: record[17] || '',
      signal_s2: record[10] || '',
      signal_s3: record[8] || '',
      price_warning: Array.isArray(record[14]) ? record[14][0] : (record[14] || ''),
      macro_risk: Array.isArray(record[20]) ? record[20][0] : (record[20] || ''),
      event_score: record[2] || 0
    };
    
    if (flow.code && flow.trade_date) {
      fundamentalFlows.push(flow);
    }
  }
  
  if (fundamentalFlows.length === 0) {
    return { success: false, count: 0, message: '解析每日基本面流水数据失败' };
  }
  
  let savedCount = 0;
  for (const flow of fundamentalFlows) {
    try {
      saveDailyFundamentalFlow(flow);
      savedCount++;
    } catch (error) {
      // Error already logged
    }
  }
  
  return {
    success: true,
    count: savedCount,
    message: `成功同步 ${savedCount} 条每日基本面流水数据`
  };
}

/**
 * 同步焦煤深度监控数据
 */
export function syncCokingCoalMonitorData(): { success: boolean; count: number; message: string } {
  console.log('[飞书同步] 开始同步焦煤深度监控数据...');
  
  const records = fetchFromFeishu(BASE_TOKEN, TABLES.cokingCoalMonitor);
  
  if (records.length === 0) {
    return { success: false, count: 0, message: '未获取到焦煤深度监控数据' };
  }
  
  // 解析字段（根据实际字段顺序）
  // 字段: 品种代码, 基差, 六大港库存, 交易日, 铁水产量, 基差率, Wind华东价, 
  //       电炉开工率, 收盘价, Wind均价, 现货价AKShare, Wind华北价, 偏离成本线
  const monitors: any[] = [];
  for (const record of records) {
    if (record.length < 13) continue;
    
    const dateStr = record[3];
    if (!dateStr) continue;
    const tradeDate = dateStr.split(' ')[0];
    
    const monitor = {
      trade_date: tradeDate,
      code: record[0] || '',
      close_price: record[8] || 0,
      spot_price: record[10] || 0,
      basis: record[1] || 0,
      basis_rate: record[5] || 0,
      iron_water_output: record[4] || 0,
      port_inventory: record[2] || 0,
      eaf_utilization: record[7] || 0,
      wind_avg_price: record[9] || 0,
      wind_east_price: record[6] || 0,
      wind_north_price: record[11] || 0,
      cost_deviation: record[12] || 0
    };
    
    if (monitor.code && monitor.trade_date) {
      monitors.push(monitor);
    }
  }
  
  if (monitors.length === 0) {
    return { success: false, count: 0, message: '解析焦煤深度监控数据失败' };
  }
  
  let savedCount = 0;
  for (const monitor of monitors) {
    try {
      saveCokingCoalMonitor(monitor);
      savedCount++;
    } catch (error) {
      // Error already logged
    }
  }
  
  return {
    success: true,
    count: savedCount,
    message: `成功同步 ${savedCount} 条焦煤深度监控数据`
  };
}

/**
 * 同步生猪每日监控数据
 */
export function syncPigDailyMonitorData(): { success: boolean; count: number; message: string } {
  try {
    const result = spawnSync('lark-cli', ['base', '+record-list', '--base-token', PIG_BASE_TOKEN, '--table-id', PIG_TABLES.dailyMonitor, '--limit', '100', '--format', 'json'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.error || result.status !== 0) {
      return { success: false, count: 0, message: `读取失败: ${result.stderr || result.error?.message}` };
    }
    
    const data = JSON.parse(result.stdout);
    const records = data.data?.data || [];
    
    if (records.length === 0) {
      return { success: true, count: 0, message: '生猪每日监控数据为空' };
    }
    
    let savedCount = 0;
    for (const record of records) {
      const dateStr = record[0];
      if (!dateStr) continue;
      
      // 解析日期
      const tradeDate = typeof dateStr === 'string' ? dateStr.split(' ')[0] : dateStr;
      
      const monitor = {
        trade_date: tradeDate,
        spot_price: record[1] || 0,
        lh2609_price: record[11] || 0,
        lh2611_price: record[17] || 0,
        lh2701_price: record[3] || 0,
        corn_price: record[6] || 0,
        piglet_price: record[8] || 0,
        sow_inventory: record[16] || 0,
        sow_mom_change: record[5] || 0,
        slaughter_rate: record[7] || 0,
        frozen_stock_rate: record[4] || 0,
        slaughter_weight: record[15] || 0,
        self_breed_profit: record[18] || 0,
        purchased_profit: record[20] || 0,
        rule1_price_low: record[2] || 0,
        rule2_inventory_low: record[23] || 0,
        rule3_profit_negative: record[9] || 0,
        rule4_demand_good: record[14] || 0,
        rule5_basis_discount: record[19] || 0,
        signal1_supply_demand: Array.isArray(record[22]) ? record[22][0] : (record[22] || ''),
        signal2_extreme: Array.isArray(record[13]) ? record[13][0] : (record[13] || ''),
        signal3_external: Array.isArray(record[21]) ? record[21][0] : (record[21] || ''),
        quant_score: record[12] || 0,
        comment: record[10] || ''
      };
      
      if (monitor.trade_date) {
        try {
          savePigDailyMonitor(monitor);
          savedCount++;
        } catch (error) {
          // Error already logged
        }
      }
    }
    
    return {
      success: true,
      count: savedCount,
      message: `成功同步 ${savedCount} 条生猪每日监控数据`
    };
  } catch (error) {
    console.error('[飞书同步] 同步生猪每日监控数据失败:', error);
    return { success: false, count: 0, message: '同步生猪每日监控数据失败' };
  }
}

/**
 * 同步生猪季节性历史参考数据
 */
export function syncPigSeasonalReferenceData(): { success: boolean; count: number; message: string } {
  try {
    const result = spawnSync('lark-cli', ['base', '+record-list', '--base-token', PIG_BASE_TOKEN, '--table-id', PIG_TABLES.seasonalReference, '--limit', '100', '--format', 'json'], {
      encoding: 'utf-8',
      cwd: process.cwd(),
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    if (result.error || result.status !== 0) {
      return { success: false, count: 0, message: `读取失败: ${result.stderr || result.error?.message}` };
    }
    
    const data = JSON.parse(result.stdout);
    const records = data.data?.data || [];
    
    if (records.length === 0) {
      return { success: true, count: 0, message: '生猪季节性历史参考数据为空' };
    }
    
    let savedCount = 0;
    for (const record of records) {
      const reference = {
        month: record[0] || 0,
        core_logic: record[9] || '',
        best_contract: record[2] || '',
        max_monthly_gain: record[3] || 0,
        max_monthly_drop: record[10] || 0,
        avg_change: record[8] || 0,
        rise_probability: record[5] || 0,
        cycle_attribute: Array.isArray(record[7]) ? record[7][0] : (record[7] || ''),
        trading_window: record[4] || '',
        core_risk: record[6] || ''
      };
      
      if (reference.month > 0) {
        try {
          savePigSeasonalReference(reference);
          savedCount++;
        } catch (error) {
          // Error already logged
        }
      }
    }
    
    return {
      success: true,
      count: savedCount,
      message: `成功同步 ${savedCount} 条生猪季节性历史参考数据`
    };
  } catch (error) {
    console.error('[飞书同步] 同步生猪季节性历史参考数据失败:', error);
    return { success: false, count: 0, message: '同步生猪季节性历史参考数据失败' };
  }
}

/**
 * 同步所有飞书数据
 */
export function syncFromFeishu(): { success: boolean; results: any[] } {
  console.log('[飞书同步] 开始同步所有数据...');
  
  const results = [];
  
  try {
    // 1. 同步品种档案
    const varietyResult = syncVarietyData();
    results.push({ type: '品种档案', ...varietyResult });
    console.log('[飞书同步]', varietyResult.message);
  } catch (error) {
    console.log('[飞书同步] 品种档案同步失败:', error instanceof Error ? error.message : String(error));
    results.push({ type: '品种档案', success: false, message: '同步失败' });
  }
  
  try {
    // 2. 同步现货价格
    const spotPriceResult = syncSpotPriceData();
    results.push({ type: '现货价格', ...spotPriceResult });
    console.log('[飞书同步]', spotPriceResult.message);
  } catch (error) {
    console.log('[飞书同步] 现货价格同步失败:', error instanceof Error ? error.message : String(error));
    results.push({ type: '现货价格', success: false, message: '同步失败' });
  }
  
  try {
    // 3. 同步仓单数据
    const warehouseResult = syncWarehouseReceiptData();
    results.push({ type: '仓单数据', ...warehouseResult });
    console.log('[飞书同步]', warehouseResult.message);
  } catch (error) {
    console.log('[飞书同步] 仓单数据同步失败:', error instanceof Error ? error.message : String(error));
    results.push({ type: '仓单数据', success: false, message: '同步失败' });
  }
  
  try {
    // 4. 同步每日基本面流水
    const fundamentalFlowResult = syncDailyFundamentalFlowData();
    results.push({ type: '每日基本面流水', ...fundamentalFlowResult });
    console.log('[飞书同步]', fundamentalFlowResult.message);
  } catch (error) {
    console.log('[飞书同步] 每日基本面流水同步失败:', error instanceof Error ? error.message : String(error));
    results.push({ type: '每日基本面流水', success: false, message: '同步失败' });
  }
  
  try {
    // 5. 同步焦煤深度监控
    const cokingCoalResult = syncCokingCoalMonitorData();
    results.push({ type: '焦煤深度监控', ...cokingCoalResult });
    console.log('[飞书同步]', cokingCoalResult.message);
  } catch (error) {
    console.log('[飞书同步] 焦煤深度监控同步失败:', error instanceof Error ? error.message : String(error));
    results.push({ type: '焦煤深度监控', success: false, message: '同步失败' });
  }
  
  // 6. 同步生猪每日监控
  const pigDailyResult = syncPigDailyMonitorData();
  results.push({ type: '生猪每日监控', ...pigDailyResult });
  console.log('[飞书同步]', pigDailyResult.message);
  
  // 7. 同步生猪季节性历史参考
  const pigSeasonalResult = syncPigSeasonalReferenceData();
  results.push({ type: '生猪季节性参考', ...pigSeasonalResult });
  console.log('[飞书同步]', pigSeasonalResult.message);
  
  const allSuccess = results.every(r => r.success);
  
  return {
    success: allSuccess,
    results
  };
}

// 如果直接运行此脚本
if (process.argv[1]?.includes('syncFromFeishu')) {
  const result = syncFromFeishu();
  console.log('[飞书同步] 最终结果:', result);
}
