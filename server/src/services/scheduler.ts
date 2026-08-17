/**
 * 定时任务调度器
 * 每日收盘后自动收集数据，并同步飞书数据
 */

import cron from 'node-cron';
import { collectAllData } from './dataCollector.js';
import { syncAllFeishuData } from './feishuSync.js';
import { syncAllInventoryData } from './inventoryService.js';
import { runV16FullScan, runV16FullScan30m } from './v16_engine.js';
import { runOpportunityScan, monitorPositions, scanNewsBlackSwans } from './monitorService.js';
import { scanPropagationAlerts, backfillPropagationPerformance } from './eventMonitorService.js';
import {
  generateAllHistoricalEventDailies,
  generateLatestEventDailyReport,
} from './eventDailyService.js';
import {
  saveDailyJournal,
  saveSimTrade,
  getOpenSimTrade,
  closeSimTrade,
  type DailyJournalRecord
} from './database.js';

// 记录上次执行时间
let lastExecutionDate = '';
// 并发互斥锁：防止手动触发与定时任务并发执行
let isCollecting = false;
// 监控任务互斥锁
let isMonitoring = false;
// 新闻扫描互斥锁
let isNewsScanning = false;
// 事件日报生成互斥锁
let isEventDailyGenerating = false;

/**
 * 执行每日数据收集
 */
async function runDailyDataCollection() {
  const today = new Date().toISOString().split('T')[0].replace(/-/g, '');

  // 并发互斥：已有收集任务在执行时直接跳过
  if (isCollecting) {
    console.log('[Scheduler] 已有数据收集任务执行中，跳过本次触发');
    return;
  }

  // 防止同一天重复执行
  if (lastExecutionDate === today) {
    console.log('[Scheduler] 今日数据已收集，跳过');
    return;
  }

  isCollecting = true;
  console.log(`[Scheduler] 开始执行每日数据收集 - ${today}`);

  try {
    // 收集所有数据
    console.log('[Scheduler] 收集仓单和资金流向数据...');
    const result = await collectAllData(today);
    console.log(`[Scheduler] 仓单数据: ${result.warehouseReceipt?.collected || 0} 条`);
    console.log(`[Scheduler] 资金流向数据: ${result.capitalFlow?.collected || 0} 条`);

    // 同步飞书数据
    console.log('[Scheduler] 同步飞书数据...');
    try {
      const result = await syncAllFeishuData();
      console.log(`[Scheduler] 飞书数据同步完成: ${result.message}`);
    } catch (feishuError) {
      console.error('[Scheduler] 飞书数据同步失败:', feishuError);
    }

    // 同步库存数据（AkShare，每周更新一次即可，库存为周度数据）
    console.log('[Scheduler] 同步库存数据（AkShare）...');
    try {
      const invResult = await syncAllInventoryData();
      console.log(`[Scheduler] 库存数据同步完成: ${invResult.message}`);
    } catch (invError) {
      console.error('[Scheduler] 库存数据同步失败:', invError);
    }

    // 执行全市场V16.2扫描
    console.log('[Scheduler] 执行V16.2全市场扫描...');
    try {
      const report = await runV16FullScan();
      console.log(`[Scheduler] V16.2扫描完成: ${report.rows.length}品种, ${report.tradable.length}tradable, ${report.filtered.length}filtered`);
    } catch (scanError) {
      console.error('[Scheduler] 市场扫描失败:', scanError);
    }

    // 执行传播链预警扫描（基于日线数据的冲击传导检测）
    console.log('[Scheduler] 执行传播链预警扫描...');
    try {
      const propagationResult = scanPropagationAlerts();
      console.log(`[Scheduler] 传播链预警扫描完成: ${propagationResult.summary.shockCount}个冲击, ${propagationResult.summary.alertCount}条预警`);
    } catch (propagationError) {
      console.error('[Scheduler] 传播链预警扫描失败:', propagationError);
    }

    // 回填历史传播链预警的绩效（follower 是否按预期跟随）
    console.log('[Scheduler] 回填传播链预警绩效...');
    try {
      const backfill = backfillPropagationPerformance();
      if (backfill.verified > 0) {
        console.log(`[Scheduler] 传播链预警绩效回填完成: 验证 ${backfill.verified} 条, 命中 ${backfill.hit} 条, 未命中 ${backfill.missed} 条`);
      }
    } catch (backfillError) {
      console.error('[Scheduler] 传播链预警绩效回填失败:', backfillError);
    }

    // 生成每日信号日报 + 同步模拟交易
    console.log('[Scheduler] 生成每日信号日报...');
    try {
      await generateDailyJournal();
    } catch (journalError) {
      console.error('[Scheduler] 日报生成失败:', journalError);
    }

    // 运行多策略回测，更新品种分级
    console.log('[Scheduler] 运行多策略回测...');
    try {
      await runBacktestUpdate();
    } catch (backtestError) {
      console.error('[Scheduler] 回测更新失败:', backtestError);
    }

    // 自动生成事件日报（历史回填 + 当日实时事件）
    console.log('[Scheduler] 自动生成事件日报...');
    try {
      await runEventDailyAutoGeneration();
    } catch (eventDailyError) {
      console.error('[Scheduler] 事件日报生成失败:', eventDailyError);
    }

    lastExecutionDate = today;
    console.log(`[Scheduler] 每日数据收集完成`);
  } catch (error) {
    console.error('[Scheduler] 数据收集失败:', error);
  } finally {
    isCollecting = false;
  }
}

/**
 * 刷新30分钟K线缓存（调用Python脚本）
 */
async function refreshKlineCache() {
  try {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const scriptPath = path.resolve(process.cwd(), 'scripts/pull_30m.py');

    console.log('[Scheduler] 开始刷新K线缓存...');
    const output = execSync(`python3 ${scriptPath}`, {
      timeout: 600000,
      encoding: 'utf-8',
    });

    const successCount = (output.match(/OK/g) || []).length;
    const failCount = (output.match(/FAILED/g) || []).length;
    console.log(`[Scheduler] K线缓存刷新完成: 成功 ${successCount}, 失败 ${failCount}`);
    return { success: successCount, failed: failCount };
  } catch (error: any) {
    console.error('[Scheduler] K线缓存刷新失败:', error.message);
    return { success: 0, failed: 0 };
  }
}

/**
 * 生成每日信号日报并同步模拟交易
 */
async function generateDailyJournal() {
  // 先刷新K线缓存
  await refreshKlineCache();

  const tradeDate = new Date().toISOString().slice(0, 10);
  const report = await runV16FullScan30m();

  let savedCount = 0;
  for (const row of report.rows) {
    const record: DailyJournalRecord = {
      trade_date: tradeDate,
      code: row.code,
      name: row.name,
      close: row.close,
      change_pct: row.ret_pct,
      spectrum: row.spectrum,
      ai_direction: row.ai_direction,
      signal_level: row.edge_grade,
      p_follow: row.p_follow,
      adx: row.adx,
      g4_count: row.g4_reason_count,
      one_liner: generateOneLiner(row),
      advice: generateAdvice(row),
      ch_direction: row.ch_direction,
      ch_entry: row.ch_entry ?? undefined,
      ch_stop: row.ch_stop ?? undefined,
      ch_target: row.ch_target ?? undefined,
      mm_tier1: row.mm_tier1 ?? undefined,
      mm_tier2: row.mm_tier2 ?? undefined,
      detail_json: JSON.stringify({
        p_follow: row.p_follow,
        p_counter: row.p_counter,
        g4_pass: row.g4_pass,
        g4_reason_count: row.g4_reason_count,
        edge_grade: row.edge_grade,
        spectrum: row.spectrum,
        trend_strength: row.trend_strength,
        adx: row.adx,
        ch_direction: row.ch_direction,
        trade_worthiness: row.trade_worthiness,
      }),
    };
    saveDailyJournal(record);
    savedCount++;
  }

  // 同步模拟交易
  let opened = 0;
  let closed = 0;
  for (const row of report.rows) {
    const code = row.code;
    const name = row.name;
    const close = row.close;
    const direction = row.ai_direction;
    const signalLevel = row.edge_grade;
    const isTradable = signalLevel && signalLevel !== 'D';

    const existingTrade = getOpenSimTrade(code);

    if (isTradable && direction && (direction === '多' || direction === '空')) {
      if (!existingTrade) {
        saveSimTrade({
          code,
          name,
          direction,
          entry_date: tradeDate,
          entry_price: close,
          status: 'open',
          entry_reason: `信号${signalLevel} ${direction} P顺${(row.p_follow * 100).toFixed(0)}%`,
        });
        opened++;
      } else if (existingTrade.direction !== direction) {
        closeSimTrade(code, { exit_date: tradeDate, exit_price: close, exit_reason: `信号反转 ${existingTrade.direction}→${direction}` });
        closed++;
        saveSimTrade({
          code,
          name,
          direction,
          entry_date: tradeDate,
          entry_price: close,
          status: 'open',
          entry_reason: `信号反转 ${existingTrade.direction}→${direction} 信号${signalLevel}`,
        });
        opened++;
      }
    } else {
      if (existingTrade) {
        closeSimTrade(code, { exit_date: tradeDate, exit_price: close, exit_reason: '信号消失' });
        closed++;
      }
    }
  }

  console.log(`[Scheduler] 日报生成完成: ${savedCount}品种, 模拟交易开${opened}/平${closed}`);
}

/**
 * 生成一句话摘要
 */
function generateOneLiner(row: any): string {
  const dir = row.ai_direction || '观望';
  const spec = row.spectrum || '未知';
  const level = row.edge_grade || 'D';
  const pFollow = row.p_follow ? (row.p_follow * 100).toFixed(0) : '0';
  const isTradable = level && level !== 'D';

  if (!isTradable) {
    return `${spec} ${dir} 暂无交易信号`;
  }

  return `${spec} ${dir} 信号${level}级 P顺${pFollow}%`;
}

/**
 * 生成交易建议
 */
function generateAdvice(row: any): string {
  const level = row.edge_grade || 'D';
  const isTradable = level && level !== 'D';
  
  if (!isTradable) {
    return '当前信号不满足交易条件，建议观望。';
  }

  const dir = row.ai_direction || '观望';
  const spec = row.spectrum || '未知';
  const pFollow = row.p_follow ? (row.p_follow * 100).toFixed(0) : '0';
  const adx = row.adx ? row.adx.toFixed(1) : '0';

  let advice = `${spec} ${dir} 信号${level}级，P顺${pFollow}%，ADX=${adx}。`;

  if (dir === '多') {
    advice += '建议轻仓做多，';
    if (row.ch_stop) advice += `止损参考${row.ch_stop.toFixed(2)}，`;
    if (row.ch_target) advice += `目标看${row.ch_target.toFixed(2)}。`;
  } else if (dir === '空') {
    advice += '建议轻仓做空，';
    if (row.ch_stop) advice += `止损参考${row.ch_stop.toFixed(2)}，`;
    if (row.ch_target) advice += `目标看${row.ch_target.toFixed(2)}。`;
  } else {
    advice += '建议观望。';
  }

  return advice;
}

// 新闻黑天鹅扫描定时任务（每30分钟，全天候）
function initNewsScanScheduler() {
  cron.schedule('*/30 * * * *', async () => {
    if (isNewsScanning) {
      console.log('[Scheduler] 新闻扫描任务执行中，跳过本次触发');
      return;
    }
    isNewsScanning = true;
    try {
      console.log(`[Scheduler] 触发新闻黑天鹅扫描 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
      const newsAlerts = await scanNewsBlackSwans();
      if (newsAlerts.length > 0) {
        console.log(`[Scheduler] 新闻扫描发现 ${newsAlerts.length} 个黑天鹅事件`);
      } else {
        console.log('[Scheduler] 新闻扫描完成，未发现新事件');
      }
    } catch (e) {
      console.error('[Scheduler] 新闻扫描失败:', (e as Error)?.message || e);
    } finally {
      isNewsScanning = false;
    }
  }, {
    timezone: 'Asia/Shanghai'
  });

  // 实时事件日报生成（每小时1次，交易时段 08:00-23:00）
  // 检测到新事件后自动生成日报，标记为"实时"
  cron.schedule('0 8-23 * * *', async () => {
    if (isEventDailyGenerating) {
      console.log('[Scheduler] 实时事件日报生成任务执行中，跳过本次触发');
      return;
    }
    isEventDailyGenerating = true;
    try {
      console.log(`[Scheduler] 触发实时事件日报生成 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
      const latest = await generateLatestEventDailyReport(undefined);
      if (latest.length > 0) {
        console.log(`[Scheduler] 实时事件日报生成完成: ${latest.length} 份`);
      } else {
        console.log('[Scheduler] 实时事件检测完成，未发现新事件');
      }
    } catch (e) {
      console.error('[Scheduler] 实时事件日报生成失败:', (e as Error)?.message || e);
    } finally {
      isEventDailyGenerating = false;
    }
  }, {
    timezone: 'Asia/Shanghai'
  });
}

/**
 * 运行多策略回测，更新品种分级
 */
async function runBacktestUpdate() {
  try {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const scriptPath = path.resolve(process.cwd(), 'src/scripts/generateRealBacktestResults.ts');

    console.log('[Scheduler] 开始运行多策略回测...');
    const output = execSync(`npx tsx ${scriptPath}`, {
      timeout: 300000, // 5分钟超时
      encoding: 'utf-8',
      cwd: process.cwd(),
    });

    // 提取关键信息
    const resultMatch = output.match(/共生成 (\d+) 条回测结果/);
    const gradeMatch = output.match(/S级: (\d+).*A级: (\d+).*B级: (\d+).*C级: (\d+)/s);

    if (resultMatch) {
      console.log(`[Scheduler] 回测完成: ${resultMatch[1]} 条结果`);
    }
    if (gradeMatch) {
      console.log(`[Scheduler] 品种分级: S=${gradeMatch[1]} A=${gradeMatch[2]} B=${gradeMatch[3]} C=${gradeMatch[4]}`);
    }

    return { success: true };
  } catch (error: any) {
    console.error('[Scheduler] 回测运行失败:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * 事件日报自动生成：历史事件库回填（幂等）+ 当日实时事件
 */
async function runEventDailyAutoGeneration() {
  if (isEventDailyGenerating) {
    console.log('[Scheduler] 事件日报生成任务执行中，跳过本次触发');
    return;
  }
  isEventDailyGenerating = true;
  console.log('[Scheduler] 开始自动生成事件日报...');
  try {
    try {
      const backfill = await generateAllHistoricalEventDailies(undefined, 3);
      console.log(
        `[Scheduler] 历史事件日报回填完成: 总数${backfill.total} 新增${backfill.generated} 跳过${backfill.skipped} 失败${backfill.failed}`
      );
    } catch (e) {
      console.error('[Scheduler] 历史事件日报回填失败:', (e as Error)?.message || e);
    }

    try {
      const latest = await generateLatestEventDailyReport(undefined);
      console.log(`[Scheduler] 当日实时事件日报生成完成: ${latest.length} 份`);
    } catch (e) {
      console.error('[Scheduler] 当日实时事件日报生成失败:', (e as Error)?.message || e);
    }
  } finally {
    isEventDailyGenerating = false;
  }
}

/**
 * 初始化定时任务
 */
export function initScheduler() {
  // 每个交易日 15:45 执行（收盘后15分钟）
  // cron 格式: 秒 分 时 日 月 周
  // 周一到周五 15:45 执行
  cron.schedule('0 45 15 * * 1-5', async () => {
    console.log('[Scheduler] 触发定时任务 - 每日数据收集');
    await runDailyDataCollection();
  }, {
    timezone: 'Asia/Shanghai'
  });

  // 每个交易日 16:05 自动生成事件日报（历史回填 + 当日实时事件）
  cron.schedule('0 5 16 * * 1-5', async () => {
    console.log('[Scheduler] 触发定时任务 - 事件日报自动生成');
    await runEventDailyAutoGeneration();
  }, {
    timezone: 'Asia/Shanghai'
  });

  // 每个交易日 16:10 自动扫描传播链预警（独立兜底，确保日线数据更新后预警已刷新）
  cron.schedule('0 10 16 * * 1-5', async () => {
    console.log('[Scheduler] 触发定时任务 - 传播链预警自动扫描');
    try {
      const propagationResult = scanPropagationAlerts();
      console.log(`[Scheduler] 传播链预警扫描完成: ${propagationResult.summary.shockCount}个冲击, ${propagationResult.summary.alertCount}条预警`);
      const backfill = backfillPropagationPerformance();
      if (backfill.verified > 0) {
        console.log(`[Scheduler] 传播链预警绩效回填: 验证 ${backfill.verified} 条, 命中 ${backfill.hit} 条`);
      }
    } catch (e) {
      console.error('[Scheduler] 传播链预警扫描失败:', (e as Error)?.message || e);
    }
  }, {
    timezone: 'Asia/Shanghai'
  });

  // 交易时段每 30 分钟执行一次交易监控（日盘 09:00-14:30），收盘后 15:00 再执行一次
  // 监控：全市场机会扫描 + 持仓止损/反转/目标检测，并推送飞书
  const runTradingMonitor = async () => {
    if (isMonitoring) {
      console.log('[Scheduler] 监控任务执行中，跳过本次触发');
      return;
    }
    isMonitoring = true;
    try {
      console.log(`[Scheduler] 触发交易监控 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
      // 先刷新 30 分钟 K 线缓存（为 AI 分析提供最新数据）
      try {
        await runV16FullScan30m();
        console.log('[Scheduler] 30 分钟 K 线缓存已刷新');
      } catch (e) {
        console.error('[Scheduler] 30 分钟缓存刷新失败:', (e as Error)?.message || e);
      }
      const opp = await runOpportunityScan();
      if (opp.newSignals.length > 0 || opp.changedSignals.length > 0) {
        console.log(`[Scheduler] 机会监控: 新 ${opp.newSignals.length} / 变化 ${opp.changedSignals.length}`);
      }
      const posAlerts = await monitorPositions();
      if (posAlerts.length > 0) {
        console.log(`[Scheduler] 持仓监控触发 ${posAlerts.length} 条`);
      }
      console.log('[Scheduler] 交易监控完成');
    } catch (e) {
      console.error('[Scheduler] 交易监控失败:', (e as Error)?.message || e);
    } finally {
      isMonitoring = false;
    }
  };

  cron.schedule('0,30 9-14 * * 1-5', runTradingMonitor, { timezone: 'Asia/Shanghai' });
  cron.schedule('0 15 * * 1-5', runTradingMonitor, { timezone: 'Asia/Shanghai' });

  console.log('[Scheduler] 定时任务已初始化');
  console.log('[Scheduler] - 每日数据收集: 周一至周五 15:45 (北京时间)');
  console.log('[Scheduler] - 事件日报自动生成: 周一至周五 16:05 (北京时间)');
  console.log('[Scheduler] - 实时事件日报: 每日 08:00-23:00 每小时1次');
  console.log('[Scheduler] - 传播链预警自动扫描: 周一至周五 16:10 (北京时间)');
  console.log('[Scheduler] - 交易监控: 周一至周五 09:00-15:00 每30分钟 (北京时间)');
  console.log('[Scheduler] - 新闻黑天鹅扫描: 每30分钟 (全天候)');
  console.log('[Scheduler] - 多策略回测更新: 每日收盘后自动运行');
  
  // 初始化新闻扫描定时任务
  initNewsScanScheduler();
}

/**
 * 手动触发数据收集（用于测试）
 */
export async function triggerManualCollection(tradeDate?: string) {
  const date = tradeDate || new Date().toISOString().split('T')[0].replace(/-/g, '');
  console.log(`[Scheduler] 手动触发数据收集 - ${date}`);
  return await collectAllData(date);
}
