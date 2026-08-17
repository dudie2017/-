/**
 * 大商所(DCE)官方API服务
 * 
 * 直接对接大商所官方数据，稳定可靠
 * 提供日行情、周行情、月行情等数据
 * 
 * 认证流程：
 * 1. 使用 apikey + secret 获取 token
 * 2. token 有效期 8 小时
 * 3. 后续请求携带 Authorization: Bearer {token}
 */

import axios from 'axios';

// 大商所API配置
const DCE_API_BASE = 'http://www.dce.com.cn/dceapi';

// 获取环境变量（运行时获取，而不是模块加载时）
function getDceApiConfig() {
  return {
    key: process.env.DCE_API_KEY,
    secret: process.env.DCE_API_SECRET
  };
}

// Token缓存
let cachedToken: string | null = null;
let tokenExpireTime: number = 0;

/**
 * 大商所品种代码映射
 * 系统品种代码 -> 大商所品种代码
 */
const DCE_VARIETY_MAP: Record<string, string> = {
  // 大商所品种
  'M': 'm',   // 豆粕
  'Y': 'y',   // 豆油
  'O': 'oi',  // 棕榈油（大商所代码oi）
  'P': 'p',   // 棕榈油
  'C': 'c',   // 玉米
  'CS': 'cs', // 玉米淀粉
  'A': 'a',   // 豆一
  'B': 'b',   // 豆二
  'JD': 'jd', // 鸡蛋
  'FB': 'fb', // 纤维板
  'BB': 'bb', // 胶合板
  'L': 'l',   // 塑料
  'V': 'v',   // PVC
  'PP': 'pp', // 聚丙烯
  'J': 'j',   // 焦炭
  'JM': 'jm', // 焦煤
  'I': 'i',   // 铁矿石
  'EG': 'eg', // 乙二醇
  'EB': 'eb', // 苯乙烯
  'PG': 'pg', // LPG
};

/**
 * 检查是否是大商所品种
 */
export function isDCEVariety(varietyCode: string): boolean {
  return varietyCode.toUpperCase() in DCE_VARIETY_MAP;
}

/**
 * 获取大商所品种代码
 */
export function getDCEVarietyCode(varietyCode: string): string {
  return DCE_VARIETY_MAP[varietyCode.toUpperCase()] || varietyCode.toLowerCase();
}

/**
 * 获取访问Token
 */
async function getAccessToken(): Promise<string> {
  // 检查缓存
  if (cachedToken && Date.now() < tokenExpireTime) {
    return cachedToken;
  }
  
  const config = getDceApiConfig();
  if (!config.key || !config.secret) {
    throw new Error('DCE_API_KEY 或 DCE_API_SECRET 未配置');
  }
  
  try {
    const response = await axios.post(
      `${DCE_API_BASE}/cms/auth/accessToken`,
      { secret: config.secret },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': config.key
        }
      }
    );
    
    if (response.data.success && response.data.data?.token) {
      cachedToken = response.data.data.token;
      // Token有效期8小时，提前1小时刷新
      tokenExpireTime = Date.now() + (response.data.data.expiresIn - 3600) * 1000;
      console.log('[DCE] Token获取成功，有效期至', new Date(tokenExpireTime).toISOString());
      return cachedToken!;
    } else {
      throw new Error(response.data.msg || 'Token获取失败');
    }
  } catch (error: any) {
    console.error('[DCE] Token获取失败:', error.message);
    throw error;
  }
}

/**
 * 日行情数据
 */
export interface DCEDailyQuote {
  variety: string;           // 品种名称
  contractId: string;        // 合约代码
  open: number;              // 开盘价
  high: number;              // 最高价
  low: number;               // 最低价
  close: number;             // 收盘价
  lastClear: number;         // 昨结算
  clearPrice: number;        // 今结算
  volumn: number;            // 成交量
  openInterest: number;      // 持仓量
  diffI: number;             // 持仓变化
  turnover: number;          // 成交额
}

/**
 * 获取日行情数据
 */
export async function getDailyQuotes(
  varietyCode: string,
  tradeDate?: string
): Promise<DCEDailyQuote[]> {
  const token = await getAccessToken();
  const dceVariety = getDCEVarietyCode(varietyCode);
  
  // 如果没有指定日期，使用最近交易日
  if (!tradeDate) {
    tradeDate = await getLatestTradeDate();
  }
  
  try {
    const response = await axios.post(
      `${DCE_API_BASE}/forward/publicweb/dailystat/dayQuotes`,
      {
        varietyId: dceVariety,
        tradeDate,
        tradeType: '1',  // 期货
        lang: 'zh',
        statisticsType: 2
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': getDceApiConfig().key!,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    if (response.data.success && response.data.data) {
      return response.data.data.map((item: any) => ({
        variety: item.variety,
        contractId: item.contractId,
        open: parseFloat(item.open) || 0,
        high: parseFloat(item.high) || 0,
        low: parseFloat(item.low) || 0,
        close: parseFloat(item.close) || 0,
        lastClear: parseFloat(item.lastClear) || 0,
        clearPrice: parseFloat(item.clearPrice) || 0,
        volumn: item.volumn || 0,
        openInterest: item.openInterest || 0,
        diffI: item.diffI || 0,
        turnover: parseFloat(item.turnover) || 0
      }));
    } else {
      throw new Error(response.data.msg || '日行情获取失败');
    }
  } catch (error: any) {
    console.error(`[DCE] 日行情获取失败(${varietyCode}):`, error.message);
    throw error;
  }
}

/**
 * 获取最近交易日
 */
export async function getLatestTradeDate(): Promise<string> {
  const token = await getAccessToken();
  
  try {
    const response = await axios.post(
      `${DCE_API_BASE}/forward/publicweb/maxTradeDate`,
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': getDceApiConfig().key!,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    if (response.data.success && response.data.data) {
      return response.data.data;
    }
    
    // 如果 maxTradeDate 返回 null，尝试通过日行情接口获取最近交易日
    // 从今天开始往前尝试，找到第一个有数据的日期
    const today = new Date();
    for (let i = 1; i <= 30; i++) {
      const tryDate = new Date(today);
      tryDate.setDate(today.getDate() - i);
      const dateStr = tryDate.toISOString().split('T')[0].replace(/-/g, '');
      
      // 跳过周末
      const dayOfWeek = tryDate.getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) continue;
      
      try {
        const testResponse = await axios.post(
          `${DCE_API_BASE}/forward/publicweb/dailystat/dayQuotes`,
          {
            varietyId: 'm',  // 用豆粕测试
            tradeDate: dateStr,
            tradeType: 1,
            lang: 'zh',
            statisticsType: 1
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'apikey': getDceApiConfig().key!,
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        // 检查是否有有效数据（不是只有"总计"行）
        if (testResponse.data.success && testResponse.data.data) {
          const validQuotes = testResponse.data.data.filter((q: any) => q.contractId);
          if (validQuotes.length > 0) {
            console.log(`[DCE] 找到最近交易日: ${dateStr}`);
            return dateStr;
          }
        }
      } catch {
        // 继续尝试更早的日期
      }
    }
    
    // 如果都失败了，使用一个已知的有效日期
    console.warn('[DCE] 无法获取最近交易日，使用默认日期 20250718');
    return '20250718';
  } catch (error) {
    console.warn('[DCE] 获取最近交易日失败，使用默认日期 20250718');
    return '20250718';
  }
}

/**
 * 获取品种列表
 */
export async function getVarietyList(): Promise<Array<{
  varietyId: string;
  varietyName: string;
  varietyEnglishName: string;
  varietyType: string;
}>> {
  const token = await getAccessToken();
  
  try {
    const response = await axios.post(
      `${DCE_API_BASE}/forward/publicweb/variety`,
      {
        lang: 'zh',
        tradeType: 1  // 期货
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'apikey': getDceApiConfig().key!,
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    if (response.data.success && response.data.data) {
      return response.data.data.map((item: any) => ({
        varietyId: item.varietyId,
        varietyName: item.varietyName,
        varietyEnglishName: item.varietyEnglishName,
        varietyType: item.varietyType
      }));
    }
    
    return [];
  } catch (error: any) {
    console.error('[DCE] 品种列表获取失败:', error.message);
    return [];
  }
}

/**
 * 检查大商所API状态
 */
export async function checkDCEStatus(): Promise<{
  available: boolean;
  token: boolean;
  message: string;
}> {
  try {
    const token = await getAccessToken();
    return {
      available: true,
      token: !!token,
      message: '大商所API可用'
    };
  } catch (error: any) {
    return {
      available: false,
      token: false,
      message: `大商所API不可用: ${error.message}`
    };
  }
}
