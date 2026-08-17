/**
 * 大连商品交易所 (DCE) 官方API服务
 * 用于获取合约信息、结算参数等
 */

import axios from 'axios';

const DCE_API_BASE = 'http://www.dce.com.cn/dceapi';

// 运行时获取环境变量
function getDceConfig() {
  return {
    key: process.env.DCE_API_KEY,
    secret: process.env.DCE_API_SECRET
  };
}

// Token缓存
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * 获取访问Token
 */
async function getAccessToken(): Promise<string> {
  // 如果token还有效（提前5分钟刷新），直接返回
  if (cachedToken && Date.now() < tokenExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }

  const config = getDceConfig();
  if (!config.key || !config.secret) {
    throw new Error('DCE_API_KEY 或 DCE_API_SECRET 未配置');
  }

  const response = await axios.post(
    `${DCE_API_BASE}/cms/auth/accessToken`,
    { secret: config.secret },
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: config.key,
      },
    }
  );

  if (!response.data.success) {
    throw new Error(`DCE API认证失败: ${response.data.msg}`);
  }

  cachedToken = response.data.data.token;
  // Token有效期通常为8小时（28800秒）
  tokenExpiry = Date.now() + response.data.data.expiresIn * 1000;

  return cachedToken as string;
}

/**
 * 带认证的API请求
 */
// 缓存：key -> { data, timestamp }
const cache = new Map<string, { data: any; timestamp: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 小时
let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 500; // 最小请求间隔 500ms

async function authenticatedRequest(endpoint: string, data: any): Promise<any> {
  const cacheKey = `${endpoint}:${JSON.stringify(data)}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }

  // 限流保护
  const now = Date.now();
  if (now - lastRequestTime < MIN_REQUEST_INTERVAL) {
    await new Promise(resolve => setTimeout(resolve, MIN_REQUEST_INTERVAL - (now - lastRequestTime)));
  }
  lastRequestTime = Date.now();

  // 重试机制：最多 3 次，指数退避
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = await getAccessToken();
      const config = getDceConfig();

      const response = await axios.post(
        `${DCE_API_BASE}${endpoint}`,
        data,
        {
          headers: {
            'Content-Type': 'application/json',
            apikey: config.key,
            Authorization: `Bearer ${token}`,
          },
          timeout: 10000,
        }
      );

      if (!response.data.success) {
        throw new Error(`DCE API请求失败: ${response.data.msg}`);
      }

      const result = response.data.data;
      cache.set(cacheKey, { data: result, timestamp: Date.now() });
      return result;
    } catch (err: any) {
      lastError = err;
      // 429 限流或网络错误时重试
      if (err?.response?.status === 429 || err?.code === 'ECONNABORTED' || err?.code === 'ERR_NETWORK') {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      // 其他错误直接抛出
      throw err;
    }
  }
  throw lastError || new Error('DCE API请求失败（重试 3 次后）');
}

/**
 * 获取主力合约信息
 * @param varietyId 品种ID（如 'a' 豆一, 'm' 豆粕）
 * @param tradeDate 交易日期 YYYYMMDD
 */
export async function getMainSeriesContracts(
  varietyId: string,
  tradeDate: string
): Promise<Array<{
  tradeDate: string;
  varietyId: string;
  seriesId: string;
  contractId: string;
}>> {
  return authenticatedRequest('/forward/publicweb/tradepara/mainSeriesInfo', {
    varietyId,
    tradeDate,
  });
}

/**
 * 获取新合约增挂信息
 * @param tradeDate 交易日期 YYYYMMDD
 */
export async function getNewContractInfo(
  tradeDate: string
): Promise<Array<{
  tradeType: string;
  variety: string;
  varietyOrder: string;
  contractId: string;
  startTradeDate: string;
  refPriceUnit: string;
}>> {
  return authenticatedRequest('/forward/publicweb/tradepara/newContractInfo', {
    tradeDate,
    tradeType: '2', // 期货/期权合约增挂
    lang: 'zh',
  });
}

/**
 * 获取结算参数（手续费、保证金等）
 * @param varietyId 品种ID
 * @param tradeDate 交易日期 YYYYMMDD
 */
export async function getSettlementParams(
  varietyId: string,
  tradeDate: string
): Promise<Array<{
  variety: string;
  varietyOrder: string;
  contractId: string;
  clearPrice: string;
  openFee: string;
  offsetFee: string;
  specBuyRate: string;
  specSellRate: string;
}>> {
  return authenticatedRequest('/forward/publicweb/tradepara/futAndOptSettle', {
    varietyId,
    tradeDate,
    tradeType: '1',
    lang: 'zh',
  });
}

/**
 * 获取交割参数
 * @param varietyId 品种ID
 */
export async function getDeliveryParams(
  varietyId: string
): Promise<Array<{
  variety: string;
  earnestRate: string;
  unit: string;
  deliveryFee: string;
  feeRate: string;
}>> {
  return authenticatedRequest('/forward/publicweb/deliverypara/deliveryCosts', {
    varietyId,
    varietyType: '1',
    lang: 'zh',
  });
}

/**
 * 获取业务公告
 */
export async function getBusinessNotices(
  pageNo: number = 1,
  pageSize: number = 10
): Promise<any> {
  return authenticatedRequest('/forward/publicweb/cms/notice/dceNotice', {
    pageNo,
    pageSize,
    siteId: 5,
  });
}

/**
 * 获取日行情数据
 * @param tradeDate 交易日期 YYYYMMDD
 * @param varietyId 品种ID（可选，传'all'或undefined返回所有品种）
 * @param tradeType 交易类型 1-期货 2-期权
 */
export async function getDailyQuotes(
  tradeDate: string,
  varietyId?: string,
  tradeType: string = '1'
): Promise<Array<{
  variety: string;
  contractId: string;
  open: string;
  high: string;
  low: string;
  close: string;
  lastClear: string;
  clearPrice: string;
  diff: string;
  diff1: string;
  volumn: number;
  openInterest: number;
  diffI: number;
  turnover: string;
}>> {
  const params: any = {
    tradeDate,
    tradeType: parseInt(tradeType),
    lang: 'zh',
    // 如果没有指定品种ID，使用'all'获取所有品种
    varietyId: varietyId || 'all',
  };
  return authenticatedRequest('/forward/publicweb/dailystat/dayQuotes', params);
}

/**
 * 获取周行情数据
 */
export async function getWeeklyQuotes(
  tradeDate: string,
  varietyId?: string
): Promise<any> {
  const params: any = {
    tradeDate,
    lang: 'zh',
  };
  if (varietyId) {
    params.varietyId = varietyId;
  }
  return authenticatedRequest('/forward/publicweb/dailystat/weekQuotes', params);
}

/**
 * 获取月行情数据
 */
export async function getMonthlyQuotes(
  tradeDate: string,
  varietyId?: string
): Promise<any> {
  const params: any = {
    tradeDate,
    lang: 'zh',
  };
  if (varietyId) {
    params.varietyId = varietyId;
  }
  return authenticatedRequest('/forward/publicweb/dailystat/monthQuotes', params);
}

/**
 * 获取仓单日报数据
 * @param tradeDate 交易日期 YYYYMMDD
 * @param varietyId 品种ID（可选，传'all'或undefined返回所有品种）
 */
export async function getWarehouseReceipts(
  tradeDate: string,
  varietyId?: string
): Promise<Array<{
  variety: string;
  varietyOrder: string;
  whAbbr: string;
  whCodeOrder: string;
  wbillQty: number;
  lastWbillQty: number;
  diff: number;
  genDate: string;
}>> {
  const params: any = {
    tradeDate,
    varietyId: varietyId || 'all',
  };
  const data = await authenticatedRequest('/forward/publicweb/dailystat/wbillWeeklyQuotes', params);
  // 仓单数据在 entityList 中
  return data.entityList || [];
}

/**
 * 获取仓单日报汇总（各品种仓单总量）
 */
export async function getWarehouseReceiptsSummary(
  tradeDate: string
): Promise<Array<{
  variety: string;
  receipt: number;
  receiptChg: number;
  date: string;
}>> {
  const entityList = await getWarehouseReceipts(tradeDate);
  const summary: Array<{
    variety: string;
    receipt: number;
    receiptChg: number;
    date: string;
  }> = [];

  for (const item of entityList) {
    // 品种汇总行的variety字段以"小计"结尾
    if (item.variety && item.variety.endsWith('小计')) {
      summary.push({
        variety: item.variety.replace('小计', ''),
        receipt: typeof item.wbillQty === 'number' ? item.wbillQty : (parseInt(item.wbillQty) || 0),
        receiptChg: typeof item.diff === 'number' ? item.diff : (parseInt(item.diff) || 0),
        date: tradeDate,
      });
    }
  }

  return summary;
}

/**
 * 获取会员成交持仓排名数据
 * @param tradeDate 交易日期 YYYYMMDD
 * @param contractId 合约代码（如 'a2601'）
 * @param varietyId 品种ID（可选）
 * @param tradeType 交易类型 1-期货 2-期权
 */
export async function getMemberDealPositionRank(
  tradeDate: string,
  contractId: string,
  varietyId?: string,
  tradeType: string = '1'
): Promise<{
  qtyFutureList: Array<{
    qtyAbbr: string;
    todayQty: number;
    qtySub: number;
    rank: number;
  }>;
  buyFutureList: Array<{
    buyAbbr: string;
    todayBuyQty: number;
    buySub: number;
    rank: number;
  }>;
  sellFutureList: Array<{
    sellAbbr: string;
    todaySellQty: number;
    sellSub: number;
    rank: number;
  }>;
}> {
  // 从合约代码提取品种ID（如果没有提供）
  const extractedVarietyId = varietyId || contractId.replace(/[0-9]/g, '').toLowerCase();
  
  const params = {
    tradeDate,
    contractId,
    varietyId: extractedVarietyId,
    tradeType: parseInt(tradeType),
  };
  
  return authenticatedRequest('/forward/publicweb/dailystat/memberDealPosi', params);
}

/**
 * 获取指定日期的所有上市合约列表（从日行情数据中提取）
 * @param tradeDate 交易日期 YYYYMMDD
 * @param minVolume 最小成交量过滤（默认0，不过滤）
 */
export async function getContractList(
  tradeDate: string,
  minVolume: number = 0
): Promise<string[]> {
  const quotes = await getDailyQuotes(tradeDate, undefined, '1');
  const contracts: string[] = [];
  
  for (const quote of quotes) {
    const contractId = quote.contractId;
    // 过滤掉月均价合约（以F结尾）
    if (contractId && !contractId.endsWith('F')) {
      // 如果有最小成交量过滤
      if (minVolume <= 0 || (quote.volumn && quote.volumn >= minVolume)) {
        contracts.push(contractId);
      }
    }
  }
  
  return contracts;
}

/**
 * 批量获取所有合约的成交持仓排名（带限流控制）
 * @param tradeDate 交易日期 YYYYMMDD
 * @param minVolume 最小成交量过滤
 * @param delayMs 请求间隔毫秒数（默认10000，避免限流）
 */
export async function getAllMemberDealPositionRank(
  tradeDate: string,
  minVolume: number = 1000,
  delayMs: number = 10000
): Promise<Record<string, {
  contractId: string;
  variety: string;
  volumeRank: Array<{ name: string; volume: number; change: number; rank: number }>;
  longRank: Array<{ name: string; volume: number; change: number; rank: number }>;
  shortRank: Array<{ name: string; volume: number; change: number; rank: number }>;
}>> {
  const contracts = await getContractList(tradeDate, minVolume);
  const result: Record<string, any> = {};
  
  for (let i = 0; i < contracts.length; i++) {
    const contractId = contracts[i];
    
    // 限流控制（第一个请求不需要等待）
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    try {
      const data = await getMemberDealPositionRank(tradeDate, contractId);
      
      // 提取品种代码
      const variety = contractId.replace(/[0-9]/g, '').toUpperCase();
      
      // 整理成交量排名
      const volumeRank = (data.qtyFutureList || []).map((item, idx) => ({
        name: item.qtyAbbr,
        volume: item.todayQty || 0,
        change: item.qtySub || 0,
        rank: idx + 1,
      }));
      
      // 整理多头持仓排名
      const longRank = (data.buyFutureList || []).map((item, idx) => ({
        name: item.buyAbbr,
        volume: item.todayBuyQty || 0,
        change: item.buySub || 0,
        rank: idx + 1,
      }));
      
      // 整理空头持仓排名
      const shortRank = (data.sellFutureList || []).map((item, idx) => ({
        name: item.sellAbbr,
        volume: item.todaySellQty || 0,
        change: item.sellSub || 0,
        rank: idx + 1,
      }));
      
      result[contractId] = {
        contractId,
        variety,
        volumeRank,
        longRank,
        shortRank,
      };
    } catch (error) {
      console.error(`获取合约 ${contractId} 成交持仓排名失败:`, error);
      // 继续处理下一个合约
    }
  }
  
  return result;
}

/**
 * 获取品种ID映射表（用于转换）
 */
export function getVarietyId(code: string): string | null {
  // 将系统品种代码转换为DCE品种ID
  const mapping: Record<string, string> = {
    'A': 'a',    // 豆一
    'B': 'b',    // 豆二
    'M': 'm',    // 豆粕
    'Y': 'y',    // 豆油
    'P': 'p',    // 棕榈油
    'C': 'c',    // 玉米
    'CS': 'cs',  // 淀粉
    'JD': 'jd',  // 鸡蛋
    'RR': 'rr',  // 粳米
    'LH': 'lh',  // 生猪
    'L': 'l',    // 塑料
    'V': 'v',    // PVC
    'PP': 'pp',  // 聚丙烯
    'EB': 'eb',  // 苯乙烯
    'EG': 'eg',  // 乙二醇
    'PG': 'pg',  // LPG
    'J': 'j',    // 焦炭
    'JM': 'jm',  // 焦煤
    'I': 'i',    // 铁矿石
  };
  return mapping[code.toUpperCase()] || null;
}

/**
 * 品种ID映射表（DCE品种代码 -> 中文名称）
 */
export const DCE_VARIETIES: Record<string, string> = {
  a: '豆一',
  b: '豆二',
  m: '豆粕',
  y: '豆油',
  p: '棕榈油',
  c: '玉米',
  cs: '淀粉',
  jd: '鸡蛋',
  rr: '粳米',
  lh: '生猪',
  l: '塑料',
  v: 'PVC',
  pp: '聚丙烯',
  eb: '苯乙烯',
  eg: '乙二醇',
  pg: 'LPG',
  j: '焦炭',
  jm: '焦煤',
  i: '铁矿石',
  fb: '纤维板',
  bb: '胶合板',
  lg: '原木',
};

/**
 * 获取今日日期（YYYYMMDD格式）
 */
export function getTodayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}
