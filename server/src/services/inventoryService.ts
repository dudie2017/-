import { spawn } from 'child_process';
import { saveInventoryHistories, getInventoryHistory, getLatestInventoryByVarieties } from './database.js';
import type { InventoryHistoryRecord } from './database.js';

/**
 * 品种代码 → AkShare 中文品种名映射
 * AkShare futures_inventory_em 接口使用中文品种名
 */
const VARIETY_NAME_MAP: Record<string, string> = {
  // 黑色系
  'RB': '螺纹钢',
  'HC': '热卷',
  'I': '铁矿石',
  'JM': '焦煤',
  'J': '焦炭',
  'SF': '硅铁',
  'SM': '锰硅',
  'SS': '不锈钢',
  // 农产品
  'M': '豆粕',
  'Y': '豆油',
  'P': '棕榈',
  'RM': '菜粕',
  'OI': '菜油',
  'JD': '鸡蛋',
  'CF': '郑棉',
  'CY': '棉纱',
  'SR': '白糖',
  'C': '玉米',
  'CS': '玉米淀粉',
  'A': '豆一',
  'B': '豆二',
  'LH': '生猪',
  'AP': '苹果',
  'PK': '花生',
  'CJ': '红枣',
  'RR': '粳米',
  // 能化
  'RU': '橡胶',
  'NR': '20号胶',
  'BR': '丁二烯橡胶',
  'SA': '纯碱',
  'TA': 'PTA',
  'MA': '甲醇',
  'FG': '玻璃',
  'UR': '尿素',
  'FU': '燃油',
  'LU': '低硫燃料油',
  'BU': '沥青',
  'PP': '聚丙烯',
  'L': '塑料',
  'V': 'PVC',
  'EB': '苯乙烯',
  'EG': '乙二醇',
  'PG': '液化石油气',
  'PX': '对二甲苯',
  'SH': '烧碱',
  'PF': '短纤',
  'PR': '瓶片',
  'PL': '丙烯',
  // 有色
  'CU': '沪铜',
  'AL': '沪铝',
  'ZN': '沪锌',
  'NI': '镍',
  'SN': '锡',
  'PB': '沪铅',
  'AO': '氧化铝',
  'AD': '铸造铝合金',
  // 贵金属
  'AU': '沪金',
  'AG': '沪银',
  // 新材料
  'SI': '工业硅',
  'LC': '碳酸锂',
  'PS': '多晶硅',
  // 林纸
  'SP': '纸浆',
  'OP': '胶版印刷纸',
};

interface AkShareInventoryRow {
  date: string;
  inventory: number;
  change: number;
}

/**
 * 通过 AkShare 获取某品种的库存历史数据
 * 数据源：东方财富-数据中心-期货库存
 */
async function fetchInventoryFromAkShare(chineseName: string): Promise<AkShareInventoryRow[]> {
  const pythonScript = `
import akshare as ak
import json
import sys
import math

def safe_float(v, default=0):
    try:
        f = float(v)
        return default if math.isnan(f) else f
    except (ValueError, TypeError):
        return default

try:
    df = ak.futures_inventory_em(symbol="${chineseName}")
    result = []
    for _, row in df.iterrows():
        result.append({
            "date": str(row.get("日期", "")),
            "inventory": safe_float(row.get("库存", 0)),
            "change": safe_float(row.get("增减", 0))
        })
    print(json.dumps(result, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"error": str(e)}))
    sys.exit(1)
`;

  return new Promise((resolve, reject) => {
    const python = spawn('python3', ['-c', pythonScript]);
    
    let stdout = '';
    let stderr = '';
    
    python.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    python.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    python.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`AKShare script failed: ${stderr}`));
        return;
      }
      
      try {
        const data = JSON.parse(stdout.trim());
        if (data.error) {
          reject(new Error(data.error));
          return;
        }
        resolve(data as AkShareInventoryRow[]);
      } catch (e) {
        reject(new Error(`Failed to parse AKShare response: ${e}`));
      }
    });
  });
}

/**
 * 计算库存分位：当前库存在历史数据中的百分位（0-100）
 * 分位 = 历史中库存 <= 当前库存的数据点占比 × 100
 */
function calculatePercentile(historicalValues: number[], currentValue: number): number {
  if (historicalValues.length === 0) return 50;
  const belowOrEqual = historicalValues.filter(v => v <= currentValue).length;
  return Math.round((belowOrEqual / historicalValues.length) * 100 * 10) / 10;
}

/**
 * 同步单个品种的库存数据
 * 1. 从 AkShare 获取库存历史
 * 2. 对最新一条数据计算历史分位
 * 3. 保存到 inventory_history 表
 */
async function syncVarietyInventory(code: string, chineseName: string): Promise<{ success: boolean; count: number; percentile?: number; error?: string }> {
  try {
    const rows = await fetchInventoryFromAkShare(chineseName);
    if (rows.length === 0) {
      return { success: false, count: 0, error: '无数据' };
    }
    
    // 按日期排序（升序）
    rows.sort((a, b) => a.date.localeCompare(b.date));
    
    // 所有历史库存值（用于分位计算）
    const allInventories = rows.map(r => r.inventory);
    
    // 组装记录：每条都计算截至当日的历史分位
    const records: InventoryHistoryRecord[] = rows.map((row, idx) => {
      // 使用截至当前日期的历史数据计算分位（至少10个数据点才计算）
      const historyUpToNow = allInventories.slice(0, idx + 1);
      const percentile = historyUpToNow.length >= 10
        ? calculatePercentile(historyUpToNow, row.inventory)
        : null;
      
      return {
        trade_date: row.date,
        variety: code,
        inventory: row.inventory,
        inventory_change: row.change,
        inventory_percentile: percentile,
        data_source: 'akshare'
      };
    });
    
    // 批量保存
    saveInventoryHistories(records);
    
    // 返回最新一条的分位
    const latestPercentile = records[records.length - 1]?.inventory_percentile ?? undefined;
    
    return { success: true, count: records.length, percentile: latestPercentile ?? undefined };
  } catch (err: any) {
    return { success: false, count: 0, error: err.message };
  }
}

/**
 * 同步所有品种的库存数据
 * @param codes 品种代码列表，默认同步映射表中的所有品种
 */
export async function syncAllInventoryData(codes?: string[]): Promise<{
  success: boolean;
  message: string;
  details: Record<string, { success: boolean; count: number; percentile?: number; error?: string }>;
}> {
  console.log('=== 开始同步库存数据（AkShare）===');
  
  const targetCodes = codes || Object.keys(VARIETY_NAME_MAP);
  const results: Record<string, any> = {};
  let successCount = 0;
  
  // 串行同步，避免并发请求过快被限流
  for (const code of targetCodes) {
    const chineseName = VARIETY_NAME_MAP[code];
    if (!chineseName) {
      results[code] = { success: false, count: 0, error: '无品种名映射' };
      continue;
    }
    
    console.log(`[库存同步] ${code} (${chineseName})...`);
    const result = await syncVarietyInventory(code, chineseName);
    results[code] = result;
    
    if (result.success) {
      successCount++;
      console.log(`[库存同步] ${code} 成功: ${result.count} 条, 最新分位: ${result.percentile ?? 'N/A'}`);
    } else {
      console.log(`[库存同步] ${code} 失败: ${result.error}`);
    }
    
    // 每个品种间隔 300ms，避免请求过快
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  
  console.log(`=== 库存数据同步完成: ${successCount}/${targetCodes.length} 个品种成功 ===`);
  
  return {
    success: successCount > 0,
    message: `库存数据同步完成: ${successCount}/${targetCodes.length} 个品种成功`,
    details: results
  };
}

/**
 * 获取所有品种的最新库存及分位（供 AI 上下文使用）
 */
export function getLatestInventorySummary(): Array<{
  variety: string;
  trade_date: string;
  inventory: number;
  inventory_change: number;
  inventory_percentile: number | null;
}> {
  const latest = getLatestInventoryByVarieties();
  return latest.map(r => ({
    variety: r.variety,
    trade_date: r.trade_date,
    inventory: r.inventory,
    inventory_change: r.inventory_change || 0,
    inventory_percentile: r.inventory_percentile ?? null
  }));
}

/**
 * 获取品种名映射（供其他模块使用）
 */
export function getVarietyNameMap(): Record<string, string> {
  return { ...VARIETY_NAME_MAP };
}
