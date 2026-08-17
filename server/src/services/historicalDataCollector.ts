/**
 * 历史数据收集服务
 * 从大商所API获取历史仓单、持仓排名和日行情数据
 */

import { getWarehouseReceipts, getMemberDealPositionRank, getDailyQuotes, getContractList, getAllMemberDealPositionRank } from './dceApi';
import db, { saveWarehouseReceiptRecords, saveCapitalFlowRecord, saveDailyQuoteRecords } from './database';

// 品种名称到代码的映射
const VARIETY_NAME_TO_CODE: Record<string, string> = {
  '豆一': 'A',
  '豆二': 'B',
  '豆粕': 'M',
  '豆油': 'Y',
  '棕榈油': 'P',
  '玉米': 'C',
  '玉米淀粉': 'CS',
  '鸡蛋': 'JD',
  '聚乙烯': 'L',
  '聚氯乙烯': 'V',
  '聚丙烯': 'PP',
  '焦炭': 'J',
  '焦煤': 'JM',
  '铁矿石': 'I',
  '乙二醇': 'EG',
  '苯乙烯': 'EB',
  '液化石油气': 'PG',
  '生猪': 'LH',
};

/**
 * 从品种名称获取品种代码
 */
function getVarietyCodeFromName(name: string): string {
  // 移除"小计"、"合计"等后缀
  const cleanName = name.replace(/(小计|合计|总计)$/, '').trim();
  return VARIETY_NAME_TO_CODE[cleanName] || '';
}

// 品种代码到名称的映射（反向映射）
const VARIETY_CODE_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.entries(VARIETY_NAME_TO_CODE).map(([name, code]) => [code, name])
);

/**
 * 根据品种代码获取品种名称
 */
function getVarietyNameFromCode(code: string): string {
  return VARIETY_CODE_TO_NAME[code.toUpperCase()] || code;
}

/**
 * 生成过去N天的交易日期列表
 */
function generateTradeDates(days: number): string[] {
  const dates: string[] = [];
  const today = new Date();
  
  for (let i = 1; i <= days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    
    // 跳过周末
    const dayOfWeek = date.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) continue;
    
    dates.push(date.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  
  return dates;
}

/**
 * 收集历史仓单数据
 */
export async function collectHistoricalWarehouseReceipts(days: number = 30): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  const dates = generateTradeDates(days);
  let collected = 0;
  const errors: string[] = [];
  
  console.log(`[历史数据收集] 开始收集过去 ${days} 天的仓单数据`);
  
  for (let i = 0; i < dates.length; i++) {
    const tradeDate = dates[i];
    
    // 添加延迟以避免触发API限流（第一个请求不需要等待）
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    try {
      const receipts = await getWarehouseReceipts(tradeDate);
      
      if (receipts && receipts.length > 0) {
        // 按品种聚合数据
        const varietyMap = new Map<string, {
          code: string;
          name: string;
          totalQty: number;
          totalChange: number;
          warehouses: Array<{ name: string; qty: number }>;
        }>();
        
        for (const r of receipts) {
          // DCE API returns: variety (e.g. "豆一"), whAbbr (warehouse name), wbillQty (quantity), diff (change)
          // Extract variety code from the variety name (e.g. "豆一" -> "A")
          const varietyName = r.variety || '';
          const varietyCode = getVarietyCodeFromName(varietyName);
          const warehouseName = r.whAbbr || '';
          const qty = typeof r.wbillQty === 'number' ? r.wbillQty : (parseInt(String(r.wbillQty)) || 0);
          const change = typeof r.diff === 'number' ? r.diff : (parseInt(String(r.diff)) || 0);
          
          // Skip summary rows (品种小计)
          if (varietyName.endsWith('小计') || varietyName.endsWith('合计')) continue;
          
          if (!varietyCode) continue;
          
          if (!varietyMap.has(varietyCode)) {
            varietyMap.set(varietyCode, {
              code: varietyCode,
              name: varietyName,
              totalQty: 0,
              totalChange: 0,
              warehouses: []
            });
          }
          
          const variety = varietyMap.get(varietyCode)!;
          variety.totalQty += qty;
          variety.totalChange += change;
          if (qty > 0) {
            variety.warehouses.push({ name: warehouseName, qty });
          }
        }
        
        // 转换为数据库记录格式
        const records = Array.from(varietyMap.values()).map(v => {
          // 计算仓单分布
          const warehouseDistribution = v.warehouses
            .sort((a, b) => b.qty - a.qty)
            .slice(0, 5)
            .map(w => `${w.name}:${w.qty}`)
            .join(', ');
          
          // 计算供需信号
          const changePct = v.totalQty > 0 ? (v.totalChange / v.totalQty) * 100 : 0;
          let signal = 'neutral';
          let score = 0;
          
          if (changePct > 5) {
            signal = 'supply_increase';
            score = Math.min(100, Math.round(changePct * 10));
          } else if (changePct < -5) {
            signal = 'supply_decrease';
            score = Math.max(-100, Math.round(changePct * 10));
          }
          
          return {
            trade_date: tradeDate,
            code: v.code,
            name: v.name,
            receipt_qty: v.totalQty,
            receipt_change: v.totalChange,
            receipt_change_pct: Math.round(changePct * 100) / 100,
            warehouse_distribution: warehouseDistribution,
            supply_demand_signal: signal,
            supply_demand_score: score
          };
        });
        
        // 使用 saveWarehouseReceiptRecords 批量保存
        const savedCount = saveWarehouseReceiptRecords(records);
        collected += savedCount;
        
        console.log(`[历史数据收集] ${tradeDate}: 收集 ${records.length} 条仓单记录，保存 ${savedCount} 条`);
      }
    } catch (error: any) {
      errors.push(`${tradeDate}: ${error.message}`);
      console.error(`[历史数据收集] ${tradeDate} 失败:`, error.message);
    }
  }
  
  console.log(`[历史数据收集] 仓单数据收集完成，共 ${collected} 条记录`);
  
  return {
    success: true,
    collected,
    errors
  };
}

/**
 * 收集历史持仓排名数据（用于资金流向分析）
 */
export async function collectHistoricalCapitalFlow(days: number = 30): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  const dates = generateTradeDates(days);
  let collected = 0;
  const errors: string[] = [];
  
  console.log(`[历史数据收集] 开始收集过去 ${days} 天的持仓排名数据`);
  
  for (let i = 0; i < dates.length; i++) {
    const tradeDate = dates[i];
    
    // 添加延迟以避免触发API限流（第一个请求不需要等待）
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    try {
      // 使用 getAllMemberDealPositionRank 获取当天所有合约的持仓排名
      const rankData = await getAllMemberDealPositionRank(tradeDate, 500, 2000);
      
      if (!rankData || Object.keys(rankData).length === 0) {
        console.log(`[历史数据收集] ${tradeDate}: 无持仓排名数据`);
        continue;
      }
      
      // 按品种聚合数据
      const varietyData: Record<string, {
        name: string;
        totalVolume: number;
        totalLong: number;
        totalShort: number;
      }> = {};
      
      for (const [contractId, data] of Object.entries(rankData)) {
        const variety = data.variety;
        const varietyName = getVarietyNameFromCode(variety);
        
        if (!varietyData[variety]) {
          varietyData[variety] = {
            name: varietyName,
            totalVolume: 0,
            totalLong: 0,
            totalShort: 0
          };
        }
        
        // 累加前5名的数据
        const top5Volume = data.volumeRank.slice(0, 5).reduce((sum, r) => sum + r.volume, 0);
        const top5Long = data.longRank.slice(0, 5).reduce((sum, r) => sum + r.volume, 0);
        const top5Short = data.shortRank.slice(0, 5).reduce((sum, r) => sum + r.volume, 0);
        
        varietyData[variety].totalVolume += top5Volume;
        varietyData[variety].totalLong += top5Long;
        varietyData[variety].totalShort += top5Short;
      }
      
      // 保存每个品种的数据
      for (const [variety, data] of Object.entries(varietyData)) {
        const netPosition = data.totalLong - data.totalShort;
        
        saveCapitalFlowRecord({
          trade_date: tradeDate,
          code: variety,
          name: data.name,
          top5_volume: data.totalVolume,
          top5_volume_ratio: 0,
          top5_volume_change: 0,
          top5_long: data.totalLong,
          top5_short: data.totalShort,
          net_position: netPosition,
          net_position_change: 0,
          concentration_index: 0,
          smart_money_direction: netPosition > 0 ? 'LONG' : netPosition < 0 ? 'SHORT' : 'NEUTRAL',
          smart_money_confidence: 50,
          signal_type: 'neutral',
          signal_confidence: 50,
          close_price: 0,
          price_change_pct: 0
        });
        collected++;
      }
      
      console.log(`[历史数据收集] ${tradeDate}: 收集 ${Object.keys(varietyData).length} 个品种的持仓排名数据`);
    } catch (error: any) {
      errors.push(`${tradeDate}: ${error.message}`);
      console.error(`[历史数据收集] ${tradeDate} 失败:`, error.message);
    }
  }
  
  console.log(`[历史数据收集] 持仓排名数据收集完成，共 ${collected} 条记录`);
  
  return {
    success: true,
    collected,
    errors
  };
}

/**
 * 收集历史日行情数据（价格、成交量、持仓量等）
 */
export async function collectHistoricalDailyQuotes(days: number = 30): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  const dates = generateTradeDates(days);
  let collected = 0;
  const errors: string[] = [];
  
  console.log(`[历史数据收集] 开始收集过去 ${days} 天的日行情数据`);
  
  for (let i = 0; i < dates.length; i++) {
    const tradeDate = dates[i];
    
    // 添加延迟以避免触发API限流（第一个请求不需要等待）
    if (i > 0) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    try {
      const quotes = await getDailyQuotes(tradeDate);
      
      if (quotes && quotes.length > 0) {
        // 转换为数据库记录格式
        const records = quotes.map(q => {
          // 提取品种代码（从合约ID中提取字母部分）
          const variety = q.variety || q.contractId.replace(/[0-9]/g, '').toUpperCase();
          
          return {
            trade_date: tradeDate,
            variety: variety,
            contract_id: q.contractId || '',
            open_price: parseFloat(q.open) || 0,
            high_price: parseFloat(q.high) || 0,
            low_price: parseFloat(q.low) || 0,
            close_price: parseFloat(q.close) || 0,
            clear_price: parseFloat(q.clearPrice || q.lastClear) || 0,
            price_change: parseFloat(q.diff) || 0,
            volume: q.volumn || 0,
            open_interest: q.openInterest || 0,
            open_interest_change: q.diffI || 0,
            turnover: parseFloat(q.turnover) || 0
          };
        });
        
        // 批量保存
        const savedCount = saveDailyQuoteRecords(records);
        collected += savedCount;
        
        console.log(`[历史数据收集] ${tradeDate}: 收集 ${records.length} 条日行情记录，保存 ${savedCount} 条`);
      }
    } catch (error: any) {
      errors.push(`${tradeDate}: ${error.message}`);
      console.error(`[历史数据收集] ${tradeDate} 日行情收集失败:`, error.message);
    }
  }
  
  console.log(`[历史数据收集] 日行情数据收集完成，共 ${collected} 条记录`);
  
  return {
    success: true,
    collected,
    errors
  };
}

/**
 * 收集所有历史数据
 */
export async function collectAllHistoricalData(days: number = 30): Promise<{
  success: boolean;
  message: string;
  data: {
    warehouseReceipts: number;
    capitalFlow: number;
    dailyQuotes: number;
    errors: string[];
  };
}> {
  console.log(`[历史数据收集] 开始收集过去 ${days} 天的所有历史数据`);
  
  // 收集仓单数据
  const warehouseResult = await collectHistoricalWarehouseReceipts(days);
  
  // 收集持仓排名数据
  const capitalFlowResult = await collectHistoricalCapitalFlow(days);
  
  // 收集日行情数据
  const dailyQuotesResult = await collectHistoricalDailyQuotes(days);
  
  const allErrors = [...warehouseResult.errors, ...capitalFlowResult.errors, ...dailyQuotesResult.errors];
  
  return {
    success: true,
    message: `历史数据收集完成`,
    data: {
      warehouseReceipts: warehouseResult.collected,
      capitalFlow: capitalFlowResult.collected,
      dailyQuotes: dailyQuotesResult.collected,
      errors: allErrors
    }
  };
}

/**
 * 从 Tushare 收集所有交易所的日行情数据
 */
export async function collectTushareDailyQuotes(days: number = 30): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  console.log(`[Tushare数据收集] 开始收集过去 ${days} 天的日行情数据（所有交易所）`);
  
  const { getFuturesDailyQuotes, getExchangeName } = await import('./tushareApi');
  
  let collected = 0;
  const errors: string[] = [];
  
  // 获取过去 N 天的日期列表
  const dates: string[] = [];
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  
  // 按交易所收集数据
  const exchanges = ['DCE', 'CZCE', 'SHFE', 'CFFEX', 'GFEX', 'INE'];
  
  for (const exchange of exchanges) {
    console.log(`[Tushare数据收集] 开始收集 ${getExchangeName(exchange)} 的日行情数据`);
    
    for (const tradeDate of dates) {
      try {
        const records = await getFuturesDailyQuotes({
          tradeDate,
          exchange,
        });
        
        if (records.length === 0) {
          continue;
        }
        
        // 转换为数据库格式
        const dailyQuoteRecords = records.map((r: any) => {
          // Tushare API 返回的是数组格式:
          // [ts_code, trade_date, open, high, low, close, settle, ?, ?, change1, change2, vol, amount, oi, oi_chg]
          let tsCode: string;
          let openPrice: number;
          let highPrice: number;
          let lowPrice: number;
          let closePrice: number;
          let clearPrice: number;
          let priceChange: number;
          let volume: number;
          let openInterest: number;
          let openInterestChange: number;
          let turnover: number;
          
          if (Array.isArray(r)) {
            // 数组格式
            tsCode = r[0] || '';
            openPrice = r[2] || 0;
            highPrice = r[3] || 0;
            lowPrice = r[4] || 0;
            closePrice = r[5] || 0;
            clearPrice = r[6] || 0;
            priceChange = r[9] || 0;
            volume = r[11] || 0;
            turnover = r[12] || 0;
            openInterest = r[13] || 0;
            openInterestChange = r[14] || 0;
          } else {
            // 对象格式
            tsCode = r.ts_code || '';
            openPrice = r.open || 0;
            highPrice = r.high || 0;
            lowPrice = r.low || 0;
            closePrice = r.close || 0;
            clearPrice = r.settle || 0;
            priceChange = r.change1 || 0;
            volume = r.vol || 0;
            openInterest = r.oi || 0;
            openInterestChange = r.oi_chg || 0;
            turnover = r.amount || 0;
          }
          
          // 从 ts_code 提取品种代码（如 RB2510.DCE -> RB）
          const contractCode = tsCode.split('.')[0]; // RB2510
          // 提取品种代码：去掉数字部分
          const varietyCode = contractCode.replace(/[0-9]/g, ''); // RB
          
          return {
            trade_date: tradeDate,
            variety: varietyCode,
            contract_id: tsCode,
            open_price: openPrice,
            high_price: highPrice,
            low_price: lowPrice,
            close_price: closePrice,
            clear_price: clearPrice,
            price_change: priceChange,
            volume: volume,
            open_interest: openInterest,
            open_interest_change: openInterestChange,
            turnover: turnover,
          };
        });
        
        const savedCount = saveDailyQuoteRecords(dailyQuoteRecords);
        collected += savedCount;
        
        // 添加延迟避免限流
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        errors.push(`${exchange}-${tradeDate}: ${error.message}`);
        console.error(`[Tushare数据收集] ${exchange}-${tradeDate} 收集失败:`, error.message);
      }
    }
    
    console.log(`[Tushare数据收集] ${getExchangeName(exchange)} 日行情数据收集完成`);
  }
  
  console.log(`[Tushare数据收集] 日行情数据收集完成，共 ${collected} 条记录`);
  
  return {
    success: true,
    collected,
    errors
  };
}

/**
 * 从 Tushare 收集所有交易所的仓单数据
 */
export async function collectTushareWarehouseReceipts(days: number = 30): Promise<{
  success: boolean;
  collected: number;
  errors: string[];
}> {
  console.log(`[Tushare数据收集] 开始收集过去 ${days} 天的仓单数据（所有交易所）`);
  
  const { getFuturesWarehouseReceipts, getExchangeName, getVarietyName } = await import('./tushareApi');
  
  let collected = 0;
  const errors: string[] = [];
  
  // 获取过去 N 天的日期列表
  const dates: string[] = [];
  const today = new Date();
  for (let i = 1; i <= days; i++) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  
  // 按交易所收集数据
  const exchanges = ['DCE', 'CZCE', 'SHFE', 'CFFEX', 'GFEX', 'INE'];
  
  for (const exchange of exchanges) {
    console.log(`[Tushare数据收集] 开始收集 ${getExchangeName(exchange)} 的仓单数据`);
    
    for (const tradeDate of dates) {
      try {
        const records = await getFuturesWarehouseReceipts({
          tradeDate,
          exchange,
        });
        
        if (records.length === 0) {
          continue;
        }
        
        // 按品种聚合数据
        const varietyMap = new Map<string, {
          code: string;
          name: string;
          totalQty: number;
          totalChange: number;
          warehouses: Record<string, number>;
        }>();
        
        for (const r of records as any[]) {
          // Tushare 返回的是数组格式: [trade_date, symbol, variety_name, warehouse_name, ?, warehouse_receipt_qty, receipt_change, unit]
          const varietyCode = Array.isArray(r) ? r[1] : (r.symbol || '');
          const varietyName = getVarietyName(varietyCode);
          const warehouse = Array.isArray(r) ? (r[3] || 'unknown') : (r.warehouse_name || 'unknown');
          const qty = Array.isArray(r) ? (r[5] || 0) : (r.warehouse_receipt_qty || 0);
          const change = Array.isArray(r) ? (r[6] || 0) : (r.receipt_change || 0);
          
          if (!varietyMap.has(varietyCode)) {
            varietyMap.set(varietyCode, {
              code: varietyCode,
              name: varietyName,
              totalQty: 0,
              totalChange: 0,
              warehouses: {},
            });
          }
          
          const variety = varietyMap.get(varietyCode)!;
          variety.totalQty += qty;
          variety.totalChange += change;
          variety.warehouses[warehouse] = (variety.warehouses[warehouse] || 0) + qty;
        }
        
        // 转换为数据库格式
        const warehouseReceiptRecords = Array.from(varietyMap.values()).map(variety => ({
          trade_date: tradeDate,
          code: variety.code,
          name: variety.name,
          receipt_qty: variety.totalQty,
          receipt_change: variety.totalChange,
          receipt_change_pct: variety.totalQty > 0 ? (variety.totalChange / (variety.totalQty - variety.totalChange)) * 100 : 0,
          warehouse_distribution: JSON.stringify(variety.warehouses),
          supply_demand_signal: variety.totalChange > 0 ? 'supply_increase' : variety.totalChange < 0 ? 'supply_decrease' : 'stable',
          supply_demand_score: variety.totalChange > 0 ? 1 : variety.totalChange < 0 ? -1 : 0,
        }));
        
        const savedCount = saveWarehouseReceiptRecords(warehouseReceiptRecords);
        collected += savedCount;
        
        // 添加延迟避免限流
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error: any) {
        errors.push(`${exchange}-${tradeDate}: ${error.message}`);
        console.error(`[Tushare数据收集] ${exchange}-${tradeDate} 仓单收集失败:`, error.message);
      }
    }
    
    console.log(`[Tushare数据收集] ${getExchangeName(exchange)} 仓单数据收集完成`);
  }
  
  console.log(`[Tushare数据收集] 仓单数据收集完成，共 ${collected} 条记录`);
  
  return {
    success: true,
    collected,
    errors
  };
}
