/**
 * 外部数据源服务
 * 获取EIA原油库存、OPEC数据等外部行业数据
 */

import axios from 'axios';
import { SearchClient, Config } from 'coze-coding-dev-sdk';

// EIA API配置（免费API key）
const EIA_API_KEY = process.env.EIA_API_KEY || 'YOUR_EIA_API_KEY';
const EIA_BASE_URL = 'https://api.eia.gov/v2';

// 缓存配置
const CACHE_TTL = 60 * 60 * 1000; // 1小时缓存
const cache = new Map<string, { data: any; timestamp: number }>();

/**
 * 获取EIA原油库存数据
 */
export async function getEIACrudeOilInventory(): Promise<any> {
  const cacheKey = 'eia_crude_oil_inventory';
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // 如果没有配置EIA API key，使用模拟数据
  if (!process.env.EIA_API_KEY || process.env.EIA_API_KEY === 'YOUR_EIA_API_KEY') {
    const mockData = {
      source: 'EIA (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentInventory: 425.6,  // 百万桶
      unit: 'million-barrels',
      percentile: 45,  // 历史分位
      change: -2.3,  // 本周变化
      trend: '下降',
      historical: [
        { date: '2026-07-11', value: 425.6 },
        { date: '2026-07-04', value: 427.9 },
        { date: '2026-06-27', value: 430.2 },
        { date: '2026-06-20', value: 428.5 }
      ]
    };
    cache.set(cacheKey, { data: mockData, timestamp: Date.now() });
    return mockData;
  }

  try {
    // EIA Weekly Crude Oil Inventories
    const response = await axios.get(`${EIA_BASE_URL}/petroleum/pet/wtot/US`, {
      params: {
        'api_key': process.env.EIA_API_KEY,
        'frequency': 'weekly',
        'data[0]': 'value',
        'facets[units][]': 'million-barrels',
        'start': '2024-01-01',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'offset': 0,
        'length': 52
      }
    });

    const data = response.data?.response?.data || [];
    
    // 计算库存分位
    const inventories = data.map((d: any) => ({
      date: d.period,
      value: d.value,
      unit: d.units
    }));

    // 计算历史分位
    const values = inventories.map((i: any) => i.value).filter((v: any) => v != null);
    const currentValue = values[0];
    const percentile = calculatePercentile(currentValue, values);

    const result = {
      source: 'EIA',
      lastUpdate: inventories[0]?.date,
      currentInventory: currentValue,
      unit: 'million-barrels',
      percentile: percentile,
      trend: calculateTrend(values.slice(0, 4)),
      historical: inventories.slice(0, 12)
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('EIA API error:', error);
    // 返回模拟数据作为fallback
    return {
      source: 'EIA (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentInventory: 425.6,
      unit: 'million-barrels',
      percentile: 45,
      change: -2.3,
      trend: '下降',
      historical: []
    };
  }
}

/**
 * 获取美国原油产量数据
 */
export async function getUSCrudeOilProduction(): Promise<any> {
  const cacheKey = 'us_crude_production';
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  try {
    const response = await axios.get(`${EIA_BASE_URL}/petroleum/crude/production/US`, {
      params: {
        'api_key': EIA_API_KEY,
        'frequency': 'monthly',
        'data[0]': 'value',
        'facets[units][]': 'thousand-barrels-per-day',
        'start': '2023-01-01',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'offset': 0,
        'length': 24
      }
    });

    const data = response.data?.response?.data || [];
    
    const production = data.map((d: any) => ({
      date: d.period,
      value: d.value,
      unit: d.units
    }));

    const result = {
      source: 'EIA',
      lastUpdate: production[0]?.date,
      currentProduction: production[0]?.value,
      unit: 'thousand-barrels-per-day',
      trend: calculateTrend(production.slice(0, 6).map((p: any) => p.value))
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('EIA Production API error:', error);
    return null;
  }
}

/**
 * 获取OPEC一篮子原油价格
 */
export async function getOPECBasketPrice(): Promise<any> {
  const cacheKey = 'opec_basket_price';
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // 如果没有配置EIA API key，使用模拟数据
  if (!process.env.EIA_API_KEY || process.env.EIA_API_KEY === 'YOUR_EIA_API_KEY') {
    const mockData = {
      source: 'OPEC (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentPrice: 72.5,  // 美元/桶
      unit: 'dollars-per-barrel',
      weekChange: -1.2,
      trend: '下降'
    };
    cache.set(cacheKey, { data: mockData, timestamp: Date.now() });
    return mockData;
  }

  try {
    // 使用EIA的OPEC数据
    const response = await axios.get(`${EIA_BASE_URL}/petroleum/price/opec`, {
      params: {
        'api_key': process.env.EIA_API_KEY,
        'frequency': 'daily',
        'data[0]': 'value',
        'facets[units][]': 'dollars-per-barrel',
        'start': '2024-01-01',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'offset': 0,
        'length': 30
      }
    });

    const data = response.data?.response?.data || [];
    
    const prices = data.map((d: any) => ({
      date: d.period,
      value: d.value,
      unit: d.units
    }));

    const result = {
      source: 'OPEC/EIA',
      lastUpdate: prices[0]?.date,
      currentPrice: prices[0]?.value,
      unit: 'dollars-per-barrel',
      weekChange: prices[0]?.value - prices[4]?.value,
      trend: calculateTrend(prices.slice(0, 7).map((p: any) => p.value))
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('OPEC API error:', error);
    // 返回模拟数据作为fallback
    return {
      source: 'OPEC (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentPrice: 72.5,
      unit: 'dollars-per-barrel',
      weekChange: -1.2,
      trend: '下降'
    };
  }
}

/**
 * 获取页岩油钻机数量（Baker Hughes数据）
 */
export async function getShaleOilRigCount(): Promise<any> {
  const cacheKey = 'shale_rig_count';
  const cached = cache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // 如果没有配置EIA API key，使用模拟数据
  if (!process.env.EIA_API_KEY || process.env.EIA_API_KEY === 'YOUR_EIA_API_KEY') {
    const mockData = {
      source: 'Baker Hughes (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentCount: 585,  // 台
      unit: 'rigs',
      monthChange: -12,
      trend: '下降'
    };
    cache.set(cacheKey, { data: mockData, timestamp: Date.now() });
    return mockData;
  }

  try {
    // Baker Hughes Rig Count via EIA
    const response = await axios.get(`${EIA_BASE_URL}/petroleum/navgas/rigcount/US`, {
      params: {
        'api_key': process.env.EIA_API_KEY,
        'frequency': 'weekly',
        'data[0]': 'value',
        'facets[units][]': 'rigs',
        'start': '2024-01-01',
        'sort[0][column]': 'period',
        'sort[0][direction]': 'desc',
        'offset': 0,
        'length': 52
      }
    });

    const data = response.data?.response?.data || [];
    
    const rigCounts = data.map((d: any) => ({
      date: d.period,
      value: d.value,
      unit: d.units
    }));

    const result = {
      source: 'Baker Hughes/EIA',
      lastUpdate: rigCounts[0]?.date,
      currentCount: rigCounts[0]?.value,
      unit: 'rigs',
      monthChange: rigCounts[0]?.value - rigCounts[4]?.value,
      trend: calculateTrend(rigCounts.slice(0, 12).map((r: any) => r.value))
    };

    cache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
  } catch (error) {
    console.error('Rig Count API error:', error);
    // 返回模拟数据作为fallback
    return {
      source: 'Baker Hughes (模拟)',
      lastUpdate: new Date().toISOString().split('T')[0],
      currentCount: 585,
      unit: 'rigs',
      monthChange: -12,
      trend: '下降'
    };
  }
}

/**
 * 获取所有原油相关外部数据
 */
export async function getAllCrudeOilData(): Promise<any> {
  const [inventory, production, opecPrice, rigCount] = await Promise.all([
    getEIACrudeOilInventory(),
    getUSCrudeOilProduction(),
    getOPECBasketPrice(),
    getShaleOilRigCount()
  ]);

  return {
    inventory,
    production,
    opecPrice,
    rigCount,
    summary: generateCrudeOilSummary(inventory, production, opecPrice, rigCount)
  };
}

/**
 * 生成原油市场摘要
 */
function generateCrudeOilSummary(
  inventory: any, 
  production: any, 
  opecPrice: any, 
  rigCount: any
): string {
  const lines: string[] = [];
  
  lines.push('【原油市场外部数据摘要】');
  
  if (inventory) {
    const percentileLabel = inventory.percentile < 25 ? '低位' : 
                           inventory.percentile < 50 ? '中低位' :
                           inventory.percentile < 75 ? '中高位' : '高位';
    lines.push(`• 美国原油库存: ${inventory.currentInventory}百万桶, 历史分位${inventory.percentile.toFixed(0)}%(${percentileLabel})`);
    lines.push(`  趋势: ${inventory.trend}`);
  }
  
  if (production) {
    lines.push(`• 美国原油产量: ${production.currentProduction}千桶/日`);
    lines.push(`  趋势: ${production.trend}`);
  }
  
  if (opecPrice) {
    lines.push(`• OPEC一篮子价格: $${opecPrice.currentPrice}/桶`);
    lines.push(`  周变化: ${opecPrice.weekChange > 0 ? '+' : ''}${opecPrice.weekChange?.toFixed(2)}`);
  }
  
  if (rigCount) {
    lines.push(`• 活跃钻机数: ${rigCount.currentRigCount}台`);
    lines.push(`  月变化: ${rigCount.monthChange > 0 ? '+' : ''}${rigCount.monthChange}`);
  }
  
  // 综合判断
  lines.push('\n【综合判断】');
  
  let bullishSignals = 0;
  let bearishSignals = 0;
  
  if (inventory?.percentile < 30) bullishSignals++;
  else if (inventory?.percentile > 70) bearishSignals++;
  
  if (inventory?.trend === '去库') bullishSignals++;
  else if (inventory?.trend === '累库') bearishSignals++;
  
  if (production?.trend === '下降') bullishSignals++;
  else if (production?.trend === '上升') bearishSignals++;
  
  if (rigCount?.trend === '下降') bullishSignals++;
  else if (rigCount?.trend === '上升') bearishSignals++;
  
  if (bullishSignals > bearishSignals + 1) {
    lines.push('偏多: 供给收缩+库存低位，支撑油价');
  } else if (bearishSignals > bullishSignals + 1) {
    lines.push('偏空: 供给增加+库存高位，压制油价');
  } else {
    lines.push('中性: 多空因素交织，观望为主');
  }
  
  return lines.join('\n');
}

/**
 * 通用外部数据搜索辅助函数
 * 使用 web search 获取真实的最新公开数据，返回结构化结果 + 真实来源
 */
interface WebSearchItem {
  title: string;
  source: string;
  url: string;
  snippet: string;
  publishTime?: string;
}

async function searchExternalData(query: string, maxResults = 6): Promise<WebSearchItem[]> {
  try {
    const config = new Config();
    const client = new SearchClient(config);
    const response = await client.webSearch(query, maxResults, true);
    const items: WebSearchItem[] = [];
    if (response?.web_items) {
      for (const item of response.web_items) {
        items.push({
          title: item.title || '',
          source: item.site_name || '未知来源',
          url: item.url || '',
          snippet: item.snippet || '',
          publishTime: item.publish_time,
        });
      }
    }
    return items;
  } catch (error) {
    console.error(`[ExternalData] 搜索失败 (${query}):`, error);
    return [];
  }
}

/**
 * 从搜索结果文本中提取第一个数值（用于库存/比值等）
 * 返回 number | null
 */
function extractNumber(text: string): number | null {
  // 匹配带千分位/小数点的数字，如 125,000 / 82.5 / 170000
  const match = text.replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(?:万|亿|吨|美元|点)?/);
  if (match && match[1]) {
    const num = parseFloat(match[1]);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/**
 * 获取铜库存数据（实时搜索）
 */
export async function getCopperInventoryData(): Promise<any> {
  const query = 'LME铜库存 最新数据 吨 COMEX铜库存';
  const news = await searchExternalData(query);

  // 从搜索结果中提取数值（仅作参考，无法保证精确）
  const combined = news.map((n) => `${n.title} ${n.snippet}`).join(' ');
  const lme = extractNumber(combined);
  const comex = null;
  const total = lme;

  return {
    lme,
    comex,
    total,
    date: new Date().toISOString().split('T')[0],
    source: 'Web Search (实时)',
    note: '数据来自网络搜索结果，数值仅供参考，请以交易所官方数据为准',
    news,
  };
}

/**
 * 获取铝库存数据（实时搜索）
 */
export async function getAluminumInventoryData(): Promise<any> {
  const query = 'LME铝库存 最新数据 吨';
  const news = await searchExternalData(query);

  const combined = news.map((n) => `${n.title} ${n.snippet}`).join(' ');
  const lme = extractNumber(combined);
  const comex = null;
  const total = lme;

  return {
    lme,
    comex,
    total,
    date: new Date().toISOString().split('T')[0],
    source: 'Web Search (实时)',
    note: '数据来自网络搜索结果，数值仅供参考，请以交易所官方数据为准',
    news,
  };
}

/**
 * 获取金银比数据（实时搜索）
 */
export async function getGoldSilverRatioData(): Promise<any> {
  const query = '金银比 最新 黄金 白银 价格比';
  const news = await searchExternalData(query);

  const combined = news.map((n) => `${n.title} ${n.snippet}`).join(' ');
  const ratio = extractNumber(combined);

  return {
    ratio,
    date: new Date().toISOString().split('T')[0],
    source: 'Web Search (实时)',
    note: '数据来自网络搜索结果，数值仅供参考，请以交易所官方数据为准',
    news,
  };
}

// 辅助函数
function calculatePercentile(current: number, values: number[]): number {
  if (!current || values.length === 0) return 50;
  const below = values.filter(v => v < current).length;
  return (below / values.length) * 100;
}

function calculateTrend(values: number[]): string {
  if (values.length < 2) return '数据不足';
  const recent = values.slice(0, 4);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const prev = values.slice(4, 8);
  const prevAvg = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : avg;
  
  const change = ((avg - prevAvg) / prevAvg) * 100;
  if (change > 2) return '上升';
  if (change < -2) return '下降';
  return '平稳';
}

/**
 * 获取特定品种的外部数据
 */
export async function getExternalDataForVariety(varietyCode: string): Promise<any> {
  const result: any = { varietyCode };

  switch (varietyCode) {
    case 'SC': // 原油
      const [crudeOil, opecBasket, rigCount] = await Promise.all([
        getEIACrudeOilInventory(),
        getOPECBasketPrice(),
        getShaleOilRigCount()
      ]);
      result.crudeOil = crudeOil;
      result.opecBasket = opecBasket;
      result.rigCount = rigCount;
      break;
    case 'CU': // 铜
      const copperInventory = await getCopperInventoryData();
      result.copper = copperInventory;
      break;
    case 'AL': // 铝
      const aluminumInventory = await getAluminumInventoryData();
      result.aluminum = aluminumInventory;
      break;
    case 'AU': // 黄金
    case 'AG': // 白银
      const goldSilverRatio = await getGoldSilverRatioData();
      result.preciousMetals = goldSilverRatio;
      break;
    default:
      // 尝试获取相关数据
      break;
  }

  return result;
}

/**
 * 将真实搜索结果附加到 AI 上下文
 */
function appendNewsLines(lines: string[], news?: Array<{ title: string; source: string }>): void {
  if (news && news.length > 0) {
    lines.push(`数据来源(实时搜索):`);
    for (const n of news.slice(0, 3)) {
      lines.push(`  - ${n.title}（${n.source}）`);
    }
  }
}

/**
 * 格式化外部数据给AI
 */
export function formatExternalDataForAI(data: any, varietyCode: string): string {
  if (!data) return '';

  const lines: string[] = [];
  lines.push(`【${varietyCode} 外部数据】`);

  switch (varietyCode) {
    case 'SC':
      if (data.crudeOil) {
        lines.push(`原油库存: ${data.crudeOil.currentInventory}百万桶 (前值: ${data.crudeOil.previousInventory})`);
        lines.push(`  变化: ${data.crudeOil.change}百万桶 (${data.crudeOil.changePercent}%)`);
        lines.push(`  趋势: ${data.crudeOil.trend} (4周均值: ${data.crudeOil.fourWeekAvg}百万桶)`);
      }
      if (data.opecBasket) {
        lines.push(`OPEC篮子价: ${data.opecBasket.currentPrice}美元/桶`);
        lines.push(`  周变化: ${data.opecBasket.weekChange}美元`);
        lines.push(`  趋势: ${data.opecBasket.trend}`);
      }
      if (data.rigCount) {
        lines.push(`页岩油钻机: ${data.rigCount.currentCount}台`);
        lines.push(`  周变化: ${data.rigCount.weekChange}台`);
        lines.push(`  趋势: ${data.rigCount.trend}`);
      }
      break;
    case 'CU':
      if (data.copper) {
        if (data.copper.lme != null) lines.push(`LME铜库存: ${data.copper.lme}吨`);
        if (data.copper.comex != null) lines.push(`COMEX铜库存: ${data.copper.comex}吨`);
        if (data.copper.total != null) lines.push(`总库存: ${data.copper.total}吨`);
        appendNewsLines(lines, data.copper.news);
      }
      break;
    case 'AL':
      if (data.aluminum) {
        if (data.aluminum.lme != null) lines.push(`LME铝库存: ${data.aluminum.lme}吨`);
        if (data.aluminum.comex != null) lines.push(`COMEX铝库存: ${data.aluminum.comex}吨`);
        if (data.aluminum.total != null) lines.push(`总库存: ${data.aluminum.total}吨`);
        appendNewsLines(lines, data.aluminum.news);
      }
      break;
    case 'AU':
    case 'AG':
      if (data.preciousMetals) {
        if (data.preciousMetals.ratio != null) lines.push(`金银比: ${data.preciousMetals.ratio}`);
        appendNewsLines(lines, data.preciousMetals.news);
      }
      break;
  }

  return lines.join('\n');
}
