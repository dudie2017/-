/**
 * 品种数据管理服务
 * 从飞书表格动态读取品种成本数据
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// 品种成本数据接口
export interface VarietyCostData {
  code: string;
  name: string;
  cost: number; // 成本线
  costBaseline1: number; // 成本基准线1
  costBaseline2: number; // 成本基准线2
  costBaseline3: number; // 成本基准线3
  exchange: string;
  seasonalRule: string;
  corePricingAnchor: string;
  varietyFactors: string;
  industryChain: string;
  category: string;
  contractMultiplier: number;
  substitute: string | null;
  pricingPower: string;
  lastUpdated: string; // 最后更新时间
}

// 数据文件路径 - 使用 /tmp 确保在只读文件系统环境中可写
const DATA_FILE = path.join('/tmp', 'data', 'variety_cost_data.json');

// 内置兜底数据文件（代码仓库内，部署时存在）
const _moduleDir = path.dirname(fileURLToPath(import.meta.url));
const SEED_FILE = path.join(_moduleDir, '..', '..', 'data', 'variety_cost_data.json');

// 内存缓存
let varietyDataCache: Map<string, VarietyCostData> = new Map();
let lastLoadTime: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存

/**
 * 从飞书数据初始化品种数据
 */
export function initVarietyDataFromFeishu(data: any[]): void {
  varietyDataCache.clear();
  
  for (const item of data) {
    const variety: VarietyCostData = {
      code: item.code,
      name: item.name,
      cost: item.cost,
      costBaseline1: item.cost_baseline_1 || item.cost,
      costBaseline2: item.cost_baseline_2 || item.cost,
      costBaseline3: item.cost_baseline_3 || item.cost,
      exchange: item.exchange,
      seasonalRule: item.seasonal_rule || '',
      corePricingAnchor: item.core_pricing_anchor || '',
      varietyFactors: item.variety_factors || '',
      industryChain: Array.isArray(item.industry_chain) ? item.industry_chain.join(',') : (item.industry_chain || ''),
      category: Array.isArray(item.category) ? item.category.join(',') : (item.category || ''),
      contractMultiplier: item.contract_multiplier || 10,
      substitute: item.substitute || null,
      pricingPower: item.pricing_power || '',
      lastUpdated: new Date().toISOString()
    };
    
    varietyDataCache.set(variety.code, variety);
  }
  
  lastLoadTime = Date.now();
  
  // 保存到文件
  saveToFile();
  
  console.log(`[品种数据] 已加载 ${varietyDataCache.size} 个品种数据`);
}

/**
 * 从文件加载品种数据
 */
export function loadVarietyDataFromFile(): boolean {
  try {
    // 优先使用可写目录的数据文件；若不存在（如 /tmp 被清空），从内置种子文件兜底
    let source = DATA_FILE;
    if (!fs.existsSync(source) && fs.existsSync(SEED_FILE)) {
      try {
        const dir = path.dirname(DATA_FILE);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.copyFileSync(SEED_FILE, DATA_FILE);
        console.log('[品种数据] 从内置种子文件恢复品种数据');
      } catch (copyErr) {
        console.error('[品种数据] 种子文件复制失败，尝试直接读取:', copyErr);
        source = SEED_FILE;
      }
    }
    if (fs.existsSync(source)) {
      const data = JSON.parse(fs.readFileSync(source, 'utf-8'));
      varietyDataCache.clear();
      
      for (const item of data) {
        varietyDataCache.set(item.code, item);
      }
      
      lastLoadTime = Date.now();
      console.log(`[品种数据] 从文件加载 ${varietyDataCache.size} 个品种数据`);
      return true;
    }
  } catch (error) {
    console.error('[品种数据] 从文件加载失败:', error);
  }
  return false;
}

/**
 * 保存品种数据到文件
 */
function saveToFile(): void {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    const data = Array.from(varietyDataCache.values());
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('[品种数据] 保存到文件失败:', error);
  }
}

/**
 * 获取单个品种的成本数据
 */
export function getVarietyCostData(code: string): VarietyCostData | null {
  // 检查缓存是否过期
  if (Date.now() - lastLoadTime > CACHE_TTL) {
    loadVarietyDataFromFile();
  }
  
  return varietyDataCache.get(code) || null;
}

/**
 * 获取所有品种的成本数据
 */
export function getAllVarietyCostData(): VarietyCostData[] {
  // 检查缓存是否过期
  if (Date.now() - lastLoadTime > CACHE_TTL) {
    loadVarietyDataFromFile();
  }
  
  return Array.from(varietyDataCache.values());
}

/**
 * 获取品种成本线
 */
export function getVarietyCostLine(code: string): number | null {
  const data = getVarietyCostData(code);
  return data ? data.cost : null;
}

/**
 * 获取品种成本基准线
 */
export function getVarietyCostBaselines(code: string): { s1: number; s2: number; s3: number } | null {
  const data = getVarietyCostData(code);
  if (!data) return null;
  
  return {
    s1: data.costBaseline1,
    s2: data.costBaseline2,
    s3: data.costBaseline3
  };
}

/**
 * 更新品种成本数据
 */
export function updateVarietyCostData(code: string, updates: Partial<VarietyCostData>): boolean {
  const existing = varietyDataCache.get(code);
  if (!existing) return false;
  
  const updated = { ...existing, ...updates, lastUpdated: new Date().toISOString() };
  varietyDataCache.set(code, updated);
  saveToFile();
  
  return true;
}

/**
 * 获取数据最后更新时间
 */
export function getLastUpdateTime(): string | null {
  if (varietyDataCache.size === 0) return null;
  
  const firstItem = varietyDataCache.values().next().value;
  return firstItem?.lastUpdated || null;
}

// 初始化时从文件加载
loadVarietyDataFromFile();
