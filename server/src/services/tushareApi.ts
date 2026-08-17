/**
 * Tushare API 服务
 * 提供中国期货市场全面数据接口，覆盖大商所、郑商所、上期所、中金所、广期所、上期能源
 */

import axios from 'axios';

// Tushare API 配置
const TUSHARE_API_URL = 'https://api.tushare.pro';
const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN;

if (!TUSHARE_TOKEN) {
  console.warn('[Tushare] TUSHARE_TOKEN 未配置');
}

// 交易所代码映射
export const EXCHANGE_MAP: Record<string, string> = {
  DCE: '大商所',
  CZCE: '郑商所',
  SHFE: '上期所',
  CFFEX: '中金所',
  GFEX: '广期所',
  INE: '上期能源',
};

// 品种代码映射（Tushare格式 -> 中文名称）
export const VARIETY_MAP: Record<string, string> = {
  // 大商所
  A: '豆一',
  B: '豆二',
  M: '豆粕',
  Y: '豆油',
  P: '棕榈油',
  C: '玉米',
  CS: '淀粉',
  JD: '鸡蛋',
  RR: '粳米',
  L: '塑料',
  V: 'PVC',
  PP: '聚丙烯',
  EB: '苯乙烯',
  EG: '乙二醇',
  PG: 'LPG',
  J: '焦炭',
  JM: '焦煤',
  I: '铁矿石',
  LH: '生猪',
  // 郑商所
  CF: '棉花',
  CY: '棉纱',
  SR: '白糖',
  TA: 'PTA',
  OI: '菜油',
  RM: '菜粕',
  MA: '甲醇',
  FG: '玻璃',
  SA: '纯碱',
  UR: '尿素',
  AP: '苹果',
  CJ: '红枣',
  PK: '花生',
  SF: '硅铁',
  SM: '锰硅',
  WH: '强麦',
  PM: '普麦',
  RI: '粳稻',
  LR: '晚籼稻',
  JR: '粳米',
  // 上期所
  CU: '沪铜',
  AL: '沪铝',
  ZN: '沪锌',
  PB: '沪铅',
  NI: '沪镍',
  SN: '沪锡',
  AU: '沪金',
  AG: '沪银',
  RB: '螺纹钢',
  WR: '线材',
  HC: '热卷',
  SS: '不锈钢',
  BU: '沥青',
  RU: '橡胶',
  FU: '燃油',
  SP: '纸浆',
  NR: '20号胶',
  LU: '低硫燃油',
  BC: '国际铜',
  AO: '氧化铝',
  BR: '丁二烯橡胶',
  // 中金所
  IF: '沪深300',
  IH: '上证50',
  IC: '中证500',
  IM: '中证1000',
  T: '十年国债',
  TF: '五年国债',
  TS: '二年国债',
  TL: '三十年国债',
  // 广期所
  SI: '工业硅',
  LC: '碳酸锂',
};

/**
 * 调用 Tushare API
 */
async function callTushareApi(apiName: string, params: Record<string, unknown> = {}): Promise<unknown[]> {
  try {
    const response = await axios.post(TUSHARE_API_URL, {
      api_name: apiName,
      token: TUSHARE_TOKEN,
      params,
      fields: '',
    });

    if (response.data && response.data.code === 0) {
      return response.data.data?.items || [];
    } else {
      console.error(`[Tushare API] ${apiName} 错误:`, response.data?.msg);
      return [];
    }
  } catch (error) {
    console.error(`[Tushare API] ${apiName} 请求失败:`, error);
    return [];
  }
}

/**
 * 获取期货合约基础信息
 */
export async function getFuturesBasicInfo(exchange?: string): Promise<unknown[]> {
  const params: Record<string, unknown> = {};
  if (exchange) {
    params.exchange = exchange;
  }
  return callTushareApi('fut_basic', params);
}

/**
 * 获取期货日线行情
 */
export async function getFuturesDailyQuotes(options: {
  tradeDate?: string;
  tsCode?: string;
  exchange?: string;
  startDate?: string;
  endDate?: string;
}): Promise<unknown[]> {
  const params: Record<string, unknown> = {};
  if (options.tradeDate) params.trade_date = options.tradeDate;
  if (options.tsCode) params.ts_code = options.tsCode;
  if (options.exchange) params.exchange = options.exchange;
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;
  
  return callTushareApi('fut_daily', params);
}

/**
 * 获取期货仓单数据
 */
export async function getFuturesWarehouseReceipts(options: {
  tradeDate?: string;
  symbol?: string;
  exchange?: string;
  startDate?: string;
  endDate?: string;
}): Promise<unknown[]> {
  const params: Record<string, unknown> = {};
  if (options.tradeDate) params.trade_date = options.tradeDate;
  if (options.symbol) params.symbol = options.symbol;
  if (options.exchange) params.exchange = options.exchange;
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;
  
  return callTushareApi('fut_wsr', params);
}

/**
 * 获取期货持仓排名
 */
export async function getFuturesPositionRanking(options: {
  tradeDate: string;
  symbol: string;
  broker?: string;
  indicator?: string;
}): Promise<unknown[]> {
  const params: Record<string, unknown> = {
    trade_date: options.tradeDate,
    symbol: options.symbol,
  };
  if (options.broker) params.broker = options.broker;
  if (options.indicator) params.indicator = options.indicator;
  
  return callTushareApi('fut_rank', params);
}

/**
 * 获取期货结算数据
 */
export async function getFuturesSettlement(options: {
  tradeDate?: string;
  exchange?: string;
}): Promise<unknown[]> {
  const params: Record<string, unknown> = {};
  if (options.tradeDate) params.trade_date = options.tradeDate;
  if (options.exchange) params.exchange = options.exchange;
  
  return callTushareApi('fut_settle', params);
}

/**
 * 获取交易日历
 */
export async function getTradeCalendar(options: {
  exchange?: string;
  startDate?: string;
  endDate?: string;
}): Promise<unknown[]> {
  const params: Record<string, unknown> = {};
  if (options.exchange) params.exchange = options.exchange;
  if (options.startDate) params.start_date = options.startDate;
  if (options.endDate) params.end_date = options.endDate;
  
  return callTushareApi('trade_cal', params);
}

/**
 * 获取品种代码对应的中文名称
 */
export function getVarietyName(code: string): string {
  // 移除交易所后缀
  const baseCode = code.split('.')[0];
  return VARIETY_MAP[baseCode] || baseCode;
}

/**
 * 获取交易所代码对应的中文名称
 */
export function getExchangeName(code: string): string {
  return EXCHANGE_MAP[code] || code;
}

/**
 * 测试 API 连接
 */
export async function testConnection(): Promise<boolean> {
  try {
    const result = await callTushareApi('trade_cal', { 
      exchange: 'DCE',
      start_date: '20260101',
      end_date: '20260105'
    });
    return result.length > 0;
  } catch (error) {
    console.error('[Tushare API] 连接测试失败:', error);
    return false;
  }
}
