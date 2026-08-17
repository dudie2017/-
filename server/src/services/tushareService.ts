/**
 * Tushare数据服务
 * 提供真实的期货分钟线数据（1min/5min/15min/30min/60min）
 * 
 * 接口文档：https://tushare.pro/document/2?doc_id=313
 */

import axios from 'axios';

// Tushare API配置
const TUSHARE_API_URL = 'https://api.tushare.pro';

/** 惰性读取 token，避免模块加载早于 dotenv 注入导致读不到 */
function getTushareToken(): string {
  const token = process.env.TUSHARE_TOKEN;
  if (!token) {
    console.warn('[Tushare] TUSHARE_TOKEN 未配置，请在 .env 文件中设置');
  }
  return token || '';
}

// 品种代码映射（系统代码 -> Tushare代码）
const VARIETY_CODE_MAP: Record<string, string> = {
  // 贵金属
  'AG': 'AG',
  'AU': 'AU',
  // 有色金属
  'CU': 'CU',
  'AL': 'AL',
  'ZN': 'ZN',
  'NI': 'NI',
  // 黑色系
  'RB': 'RB',
  'HC': 'HC',
  'I': 'I',
  'J': 'J',
  'JM': 'JM',
  // 能源化工
  'MA': 'MA',
  'TA': 'TA',
  'PP': 'PP',
  'L': 'L',
  'V': 'V',
  'RU': 'RU',
  'FU': 'FU',
  'BU': 'BU',
  // 农产品
  'CF': 'CF',
  'SR': 'SR',
  'OI': 'OI',
  'RM': 'RM',
  'M': 'M',
  'Y': 'Y',
  'P': 'P',
  'C': 'C',
  'CS': 'CS',
  'JD': 'JD',
};

// 交易所映射
const EXCHANGE_MAP: Record<string, string> = {
  'AG': 'SHF',  // 上海期货交易所
  'AU': 'SHF',
  'CU': 'SHF',
  'AL': 'SHF',
  'ZN': 'SHF',
  'NI': 'SHF',
  'RB': 'SHF',
  'HC': 'SHF',
  'FU': 'SHF',
  'BU': 'SHF',
  'RU': 'SHF',
  'I': 'DCE',   // 大连商品交易所
  'J': 'DCE',
  'JM': 'DCE',
  'M': 'DCE',
  'Y': 'DCE',
  'P': 'DCE',
  'C': 'DCE',
  'CS': 'DCE',
  'JD': 'DCE',
  'L': 'DCE',
  'V': 'DCE',
  'PP': 'DCE',
  'MA': 'CZCE', // 郑州商品交易所
  'TA': 'CZCE',
  'CF': 'CZCE',
  'SR': 'CZCE',
  'OI': 'CZCE',
  'RM': 'CZCE',
};

export interface TushareBarData {
  ts_code: string;
  trade_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number;
  amount: number;
}

export interface TushareDailyData {
  ts_code: string;
  trade_date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  settle: number;
  vol: number;
  amount: number;
  oi: number;
}

/**
 * 调用Tushare API
 */
async function callTushareAPI(apiName: string, params: Record<string, unknown>): Promise<unknown[]> {
  try {
    console.log(`[Tushare] 调用API: ${apiName}, 参数:`, JSON.stringify(params));
    const response = await axios.post(`${TUSHARE_API_URL}`, {
      api_name: apiName,
      token: getTushareToken(),
      params: params,
      fields: '',
    }, {
      timeout: 30000,
    });

    console.log(`[Tushare] 响应code: ${response.data?.code}, msg: ${response.data?.msg}`);
    
    if (response.data && response.data.code === 0) {
      const items = response.data.data?.items || [];
      console.log(`[Tushare] 返回数据条数: ${items.length}`);
      return items;
    } else {
      console.error(`[Tushare] API错误: ${response.data?.msg || '未知错误'}`);
      return [];
    }
  } catch (error) {
    console.error('[Tushare] API请求失败:', error);
    return [];
  }
}

/**
 * 获取期货分钟线数据
 * @param variety 品种代码（如AG或AG2506.SHF）
 * @param freq 频率（1min/5min/15min/30min/60min）
 * @param startDate 开始日期（格式：YYYY-MM-DD 或 YYYY-MM-DD HH:mm:ss）
 * @param endDate 结束日期
 */
export async function getFuturesMinutes(
  variety: string,
  freq: '1min' | '5min' | '15min' | '30min' | '60min' = '5min',
  startDate?: string,
  endDate?: string
): Promise<TushareBarData[]> {
  // 支持直接传入完整合约代码（如AG2506.SHF）或品种代码（如AG）
  let tsCode: string;
  if (variety.includes('.')) {
    // 已经是完整合约代码
    tsCode = variety;
  } else {
    // 对于品种代码，先获取主力合约
    const dominantContract = await getDominantContract(variety);
    if (dominantContract) {
      tsCode = dominantContract;
    } else {
      // 如果获取失败，使用默认的主力合约格式
      const baseCode = VARIETY_CODE_MAP[variety] || variety;
      const exchange = EXCHANGE_MAP[variety] || 'SHF';
      tsCode = `${baseCode}主力.${exchange}`;
    }
  }
  
  // 默认获取最近30天的数据
  if (!endDate) {
    endDate = new Date().toISOString().split('T')[0];
  }
  if (!startDate) {
    const start = new Date();
    start.setDate(start.getDate() - 30);
    startDate = start.toISOString().split('T')[0];
  }
  
  const params = {
    ts_code: tsCode,
    freq: freq,
    start_date: startDate,
    end_date: endDate,
  };
  
  const data = await callTushareAPI('ft_mins', params);
  
  return data.map((item: unknown) => {
    const row = item as unknown[];
    return {
      ts_code: row[0] as string,
      trade_time: row[1] as string,
      open: row[2] as number,
      high: row[3] as number,
      low: row[4] as number,
      close: row[5] as number,
      vol: row[6] as number,
      amount: row[7] as number,
    };
  });
}

/**
 * 获取期货日线数据
 * @param variety 品种代码（如AG或AG2506.SHF）
 * @param startDate 开始日期（格式：YYYYMMDD）
 * @param endDate 结束日期
 */
export async function getFuturesDaily(
  variety: string,
  startDate?: string,
  endDate?: string
): Promise<TushareDailyData[]> {
  // 支持直接传入完整合约代码（如AG2506.SHF）或品种代码（如AG）
  let tsCode: string;
  if (variety.includes('.')) {
    // 已经是完整合约代码
    tsCode = variety;
  } else {
    // 对于品种代码，先获取主力合约
    const dominantContract = await getDominantContract(variety);
    if (dominantContract) {
      tsCode = dominantContract;
    } else {
      // 如果获取失败，使用默认的主力合约格式
      const baseCode = VARIETY_CODE_MAP[variety] || variety;
      const exchange = EXCHANGE_MAP[variety] || 'SHF';
      tsCode = `${baseCode}主力.${exchange}`;
    }
  }
  
  // 如果不指定日期，获取所有数据（Tushare会自动返回最新数据）
  // 如果指定了日期，使用指定日期
  const params: Record<string, string> = {
    ts_code: tsCode,
  };
  
  if (startDate) {
    params.start_date = startDate;
  }
  if (endDate) {
    params.end_date = endDate;
  }
  
  const data = await callTushareAPI('fut_daily', params);
  
  return data.map((item: unknown) => {
    const row = item as unknown[];
    return {
      ts_code: row[0] as string,
      trade_date: row[1] as string,
      open: row[4] as number,
      high: row[5] as number,
      low: row[6] as number,
      close: row[7] as number,
      settle: row[8] as number,
      vol: row[11] as number,
      amount: row[12] as number,
      oi: row[13] as number,
    };
  });
}

/**
 * 获取主力合约映射
 * @param variety 品种代码
 * @param tradeDate 交易日期
 */
export async function getDominantContract(
  variety: string,
  tradeDate?: string
): Promise<string | null> {
  const baseCode = VARIETY_CODE_MAP[variety] || variety;
  const exchange = EXCHANGE_MAP[variety] || 'SHF';
  
  if (!tradeDate) {
    tradeDate = new Date().toISOString().split('T')[0].replace(/-/g, '');
  }
  
  const params = {
    trade_date: tradeDate,
    symbol: `${baseCode}.${exchange}`,
  };
  
  const data = await callTushareAPI('fut_mapping', params);
  
  if (data.length > 0) {
    const row = data[0] as unknown[];
    return row[1] as string; // 返回合约代码
  }
  
  return null;
}

/**
 * 将Tushare数据转换为系统BarData格式
 */
export function convertToBarData(tushareData: TushareBarData[]): Array<{
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}> {
  return tushareData.map(item => ({
    date: item.trade_time,
    o: item.open,
    h: item.high,
    l: item.low,
    c: item.close,
    v: item.vol,
  }));
}

/**
 * 获取多周期数据（用于多周期共振分析）
 * @param variety 品种代码
 * @returns 包含日线、60min、15min、5min数据的对象
 */
export async function getMultiTimeframeData(variety: string): Promise<{
  daily: Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>;
  h1: Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>;
  m15: Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>;
  m5: Array<{ date: string; o: number; h: number; l: number; c: number; v: number }>;
}> {
  // 并行获取各周期数据
  const [dailyData, h1Data, m15Data, m5Data] = await Promise.all([
    getFuturesDaily(variety).then(data => convertToBarData(data as unknown as TushareBarData[])),
    getFuturesMinutes(variety, '60min').then(convertToBarData),
    getFuturesMinutes(variety, '15min').then(convertToBarData),
    getFuturesMinutes(variety, '5min').then(convertToBarData),
  ]);
  
  return {
    daily: dailyData,
    h1: h1Data,
    m15: m15Data,
    m5: m5Data,
  };
}
