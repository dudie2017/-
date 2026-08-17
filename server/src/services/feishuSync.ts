import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import {
  saveSpotPriceRecords,
  saveSupplyDemandScores,
  saveIndustryProfits,
  saveSignalAlerts,
  saveTradingRecords,
  saveDailyQuotesFeishu,
  saveTechnicalSignals,
  saveKeyLevels60min,
  saveLonghuBang,
} from './database';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 加载环境变量（兜底，index.ts 已加载）
dotenv.config({ path: path.join(__dirname, '../../.env') });

// 密钥必须从环境变量读取，严禁硬编码
const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const APP_TOKEN = 'UhYUb1QJzaa5QFslDFOcmU13ngb';

// 飞书多维表格表名映射
const TABLE_NAMES = {
  spotPrice: '现货基差',
  supplyDemand: '供需评分',
  industryProfit: '产业链利润',
  signalAlert: '信号告警',
  tradingRecord: '交易记录',
  dailyQuotes: '每日行情',
  technicalSignal: '技术面信号',
  keyLevels: '60min关键位',
  longhuBang: '龙虎榜'
};

async function getTenantAccessToken(): Promise<string> {
  if (!FEISHU_APP_ID || !FEISHU_APP_SECRET) {
    throw new Error('飞书凭证未配置：请在 server/.env 中设置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  }
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET })
  });
  const data: any = await response.json();
  if (!data.tenant_access_token) {
    throw new Error(`飞书Token获取失败: ${data.msg || '未知错误'}`);
  }
  return data.tenant_access_token;
}

async function getTableIds(token: string): Promise<Map<string, string>> {
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables`;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  const data: any = await response.json();

  const tableMap = new Map<string, string>();
  if (data.code === 0) {
    const items = data.data?.items || [];
    for (const item of items) {
      tableMap.set(item.name, item.table_id);
    }
  }

  return tableMap;
}

async function fetchAllRecords(token: string, tableId: string): Promise<any[]> {
  const allRecords: any[] = [];
  let pageToken = '';
  let hasMore = true;

  while (hasMore) {
    const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500${pageToken ? `&page_token=${pageToken}` : ''}`;
    const response = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    });
    const data: any = await response.json();

    if (data.code !== 0) {
      throw new Error(`飞书API错误: ${data.msg}`);
    }

    const items = data.data?.items || [];
    allRecords.push(...items);

    hasMore = data.data?.has_more || false;
    pageToken = data.data?.page_token || '';
  }

  return allRecords;
}

// 将时间戳转换为日期字符串
function timestampToDateString(timestamp: number): string {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return date.toISOString().split('T')[0];
}

// 解析并保存现货基差
function syncSpotPrice(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const timestamp = fields['日期'] || fields['交易日期'] || 0;
    const tradeDate = timestampToDateString(timestamp);
    const code = fields['品种'] || fields['品种代码'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种名称'] || '',
      spot_price: parseFloat(fields['现货价'] || fields['现货价格'] || '0'),
      futures_price: parseFloat(fields['期货价'] || fields['期货价格'] || '0'),
      basis: parseFloat(fields['基差'] || '0'),
      basis_rate: parseFloat(fields['基差率'] || '0'),
      data_source: fields['数据来源'] || '飞书',
    });
  }
  saveSpotPriceRecords(parsed);
  return parsed.length;
}

// 解析并保存供需评分
function syncSupplyDemand(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = timestampToDateString(fields['日期'] || 0);
    const code = fields['品种代码'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种名称'] || '',
      supply_gap_rate: parseFloat(fields['供需缺口率'] || '0'),
      cost_support_price: parseFloat(fields['成本支撑价'] || '0'),
      profit_signal: parseFloat(fields['利润信号'] || '0'),
      inventory_percentile: parseFloat(fields['库存分位'] || '0'),
      five_rules_score: parseFloat(fields['五句金律得分'] || '0'),
      total_score: parseFloat(fields['量化总评分'] || '0'),
      certainty_rating: fields['确定性评级'] || '',
      core_contradiction: fields['核心矛盾'] || '',
      trading_advice: fields['交易建议'] || '',
    });
  }
  saveSupplyDemandScores(parsed);
  return parsed.length;
}

// 解析并保存产业链利润
function syncIndustryProfit(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = timestampToDateString(fields['日期'] || 0);
    const code = fields['品种'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种'] || '',
      upstream_profit: parseFloat(fields['上游利润'] || '0'),
      midstream_profit: parseFloat(fields['中游利润'] || '0'),
      downstream_profit: parseFloat(fields['下游利润'] || '0'),
      profit_transmission: fields['利润传导方向'] || '',
      negative_feedback_risk: fields['负反馈风险'] || '',
      sector: fields['板块'] || '',
    });
  }
  saveIndustryProfits(parsed);
  return parsed.length;
}

// 解析并保存信号告警
function syncSignalAlert(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const triggerDate = timestampToDateString(fields['触发日期'] || 0);
    const code = fields['品种'] || '';
    if (!triggerDate || !code) continue;

    parsed.push({
      trigger_date: triggerDate,
      code,
      name: fields['品种'] || '',
      signal_type: fields['信号类型'] || '',
      signal_description: fields['信号描述'] || '',
      urgency: fields['紧急程度'] || '',
      suggested_action: fields['建议动作'] || '',
      status: fields['状态'] || '',
    });
  }
  saveSignalAlerts(parsed);
  return parsed.length;
}

// 解析并保存交易记录
function syncTradingRecord(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const openDate = timestampToDateString(fields['开仓日期'] || 0);
    const code = fields['品种'] || '';
    if (!openDate || !code) continue;

    const closeTimestamp = fields['平仓日期'] || 0;
    parsed.push({
      open_date: openDate,
      code,
      name: fields['品种'] || '',
      contract: fields['合约'] || '',
      direction: fields['方向'] || '',
      open_price: parseFloat(fields['开仓价'] || '0'),
      quantity: parseInt(fields['手数'] || '0'),
      stop_loss_price: parseFloat(fields['止损价'] || '0'),
      target_price: parseFloat(fields['目标价'] || '0'),
      close_date: closeTimestamp ? timestampToDateString(closeTimestamp) : '',
      close_price: parseFloat(fields['平仓价'] || '0'),
      profit: parseFloat(fields['盈亏'] || '0'),
      cumulative_equity: parseFloat(fields['累计权益'] || '0'),
      trading_reason: fields['交易理由'] || '',
      review_score: parseFloat(fields['复盘评分'] || '0'),
    });
  }
  saveTradingRecords(parsed);
  return parsed.length;
}

// 解析并保存每日行情（飞书版）
function syncDailyQuotes(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = timestampToDateString(fields['日期'] || 0);
    const code = fields['品种代码'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种名称'] || '',
      contract: fields['主力合约'] || '',
      open_price: parseFloat(fields['开盘价'] || '0'),
      high_price: parseFloat(fields['最高价'] || '0'),
      low_price: parseFloat(fields['最低价'] || '0'),
      close_price: parseFloat(fields['收盘价'] || '0'),
      settlement_price: parseFloat(fields['结算价'] || '0'),
      volume: parseInt(fields['成交量'] || '0'),
      position: parseInt(fields['持仓量'] || '0'),
      position_change: parseInt(fields['持仓变化'] || '0'),
      price_change_rate: parseFloat(fields['涨跌幅'] || '0'),
      margin_rate: parseFloat(fields['保证金率'] || '0'),
    });
  }
  saveDailyQuotesFeishu(parsed);
  return parsed.length;
}

// 解析并保存技术面信号
function syncTechnicalSignal(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = timestampToDateString(fields['日期'] || 0);
    const code = fields['品种'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种'] || '',
      contract: fields['合约'] || '',
      trend_stage: fields['趋势阶段'] || '',
      technical_advice: fields['技术面建议'] || '',
      key_support: parseFloat(fields['关键支撑位'] || '0'),
      key_resistance: parseFloat(fields['关键阻力位'] || '0'),
      always_in_direction: fields['AlwaysIn方向'] || '',
      multi_period_resonance: fields['多周期共振'] || '',
      brooks_radar_score: parseFloat(fields['Brooks雷达总分'] || '0'),
      signal_kline_description: fields['信号K线描述'] || '',
      notes: fields['备注'] || '',
      ema20: parseFloat(fields['20EMA'] || '0'),
    });
  }
  saveTechnicalSignals(parsed);
  return parsed.length;
}

// 解析并保存60min关键位
function syncKeyLevels(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = timestampToDateString(fields['日期'] || 0);
    const code = fields['品种'] || '';
    if (!tradeDate || !code) continue;

    parsed.push({
      trade_date: tradeDate,
      code,
      name: fields['品种'] || '',
      support_level: parseFloat(fields['支撑位'] || '0'),
      resistance_level: parseFloat(fields['阻力位'] || '0'),
    });
  }
  saveKeyLevels60min(parsed);
  return parsed.length;
}

// 解析并保存龙虎榜
function syncLonghuBang(records: any[]): number {
  const parsed: any[] = [];
  for (const record of records) {
    const fields = record.fields || {};
    const tradeDate = fields['交易日期'] || '';
    const contractCode = fields['合约代码'] || '';
    const memberName = fields['会员简称'] || '';
    if (!tradeDate || !contractCode || !memberName) continue;

    const buyVolume = parseInt(fields['持买单量'] || '0');
    const sellVolume = parseInt(fields['持卖单量'] || '0');
    parsed.push({
      trade_date: tradeDate,
      contract_code: contractCode,
      member_name: memberName,
      rank: parseInt(fields['名次'] || '0'),
      buy_volume: buyVolume,
      buy_change: parseInt(fields['持买单增减'] || '0'),
      sell_volume: sellVolume,
      sell_change: parseInt(fields['持卖单增减'] || '0'),
      net_volume: buyVolume - sellVolume,
    });
  }
  saveLonghuBang(parsed);
  return parsed.length;
}

// 单表同步通用流程
async function syncOneTable(
  token: string,
  tableIds: Map<string, string>,
  tableName: string,
  syncFn: (records: any[]) => number,
  label: string,
  results: any,
  resultKey: string
): Promise<void> {
  const tableId = tableIds.get(tableName);
  if (!tableId) {
    results[resultKey] = { success: false, error: '表不存在' };
    return;
  }
  try {
    const records = await fetchAllRecords(token, tableId);
    const count = syncFn(records);
    results[resultKey] = { success: true, count };
    console.log(`${label}同步成功: ${count} 条`);
  } catch (err: any) {
    results[resultKey] = { success: false, error: err.message };
    console.error(`${label}同步失败: ${err.message}`);
  }
}

export async function syncAllFeishuData(): Promise<{ success: boolean; message: string; details: any }> {
  console.log('=== 开始同步飞书数据 ===');

  try {
    const token = await getTenantAccessToken();
    console.log('飞书Token获取成功');

    // 获取表ID映射
    const tableIds = await getTableIds(token);
    console.log('表ID映射:', Array.from(tableIds.entries()));

    const results: any = {};

    await syncOneTable(token, tableIds, TABLE_NAMES.spotPrice, syncSpotPrice, '现货价格', results, 'spotPrice');
    await syncOneTable(token, tableIds, TABLE_NAMES.supplyDemand, syncSupplyDemand, '供需评分', results, 'supplyDemand');
    await syncOneTable(token, tableIds, TABLE_NAMES.industryProfit, syncIndustryProfit, '产业链利润', results, 'industryProfit');
    await syncOneTable(token, tableIds, TABLE_NAMES.signalAlert, syncSignalAlert, '信号告警', results, 'signalAlert');
    await syncOneTable(token, tableIds, TABLE_NAMES.tradingRecord, syncTradingRecord, '交易记录', results, 'tradingRecord');
    await syncOneTable(token, tableIds, TABLE_NAMES.dailyQuotes, syncDailyQuotes, '每日行情', results, 'dailyQuotes');
    await syncOneTable(token, tableIds, TABLE_NAMES.technicalSignal, syncTechnicalSignal, '技术面信号', results, 'technicalSignal');
    await syncOneTable(token, tableIds, TABLE_NAMES.keyLevels, syncKeyLevels, '60min关键位', results, 'keyLevels');
    await syncOneTable(token, tableIds, TABLE_NAMES.longhuBang, syncLonghuBang, '龙虎榜', results, 'longhuBang');

    console.log('=== 飞书数据同步完成 ===');
    return { success: true, message: '飞书数据同步完成', details: results };
  } catch (err: any) {
    console.error('飞书数据同步失败:', err.message);
    return { success: false, message: `飞书数据同步失败: ${err.message}`, details: null };
  }
}

export function getSyncStatus(): { lastSync: string; status: string } {
  return {
    lastSync: new Date().toISOString(),
    status: 'ok'
  };
}
