/**
 * 交易监控服务
 *
 * 1. 机会监控：全市场 30min 扫描，检测新出现的 tradable 信号 → 生成交易机会提醒
 * 2. 持仓监控：对登记持仓逐品种检查 → 止损/目标/信号反转/逆势/时间止损提醒
 * 3. 提醒统一处理：落库（trading_alerts）+ 飞书推送（feishuPusher）
 * 4. 去重：同品种同类型在去重窗口内不重复推送，防止轰炸
 */

import { runV16FullScan30m } from './v16_engine.js';
import type { V16Row, V16ScanResult } from './v16_types.js';
import {
  saveTradeAlert,
  getLatestTradeAlert,
  getTradeAlerts,
  getUnreadAlertCount,
  markTradeAlertRead,
  markAllTradeAlertsRead,
  clearTradeAlerts,
  getMonitoredPositions,
  saveMonitoredPosition,
  deleteMonitoredPosition,
  closeMonitoredPosition,
  getMonitoredPosition,
} from './database.js';
import type { MonitoredPosition, TradeAlertRecord } from './database.js';
import { pushFeishuRich, pushFeishuText, FEISHU_COLOR } from './feishuPusher.js';
import { scanNewsForEvents, generateNewsInterpretation } from './newsService.js';
import type { NewsItem } from './newsService.js';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams.js';

// ---------- 类型定义 ----------

export type MonitorAlertType =
  | 'opportunity'        // 新交易机会
  | 'signal_change'      // 已交易信号关键指标变化
  | 'position_stop'      // 持仓止损触发
  | 'position_target'    // 持仓目标到达
  | 'position_reverse'   // 持仓信号反转
  | 'position_trend'     // 持仓逆势抑制
  | 'position_timeout'   // 持仓时间止损
  | 'news_black_swan';   // 新闻黑天鹅事件

export interface MonitorAlert {
  type: MonitorAlertType;
  severity: 'high' | 'medium' | 'low';
  code: string;
  name: string;
  title: string;
  message: string;
  detail?: Record<string, unknown>;
}

// 上次扫描状态缓存（内存 Map，仅用于检测"新出现"的信号）
let lastScanSnapshot = new Map<string, string>(); // code -> 状态签名

// 全监控扫描并发互斥锁（防止手动触发与自动定时触发并发执行）
let isScanRunning = false;

// 上次全监控扫描完成时间（毫秒时间戳），用于前端展示"自动扫描"状态
let lastScanAt: number | null = null;

// 去重窗口（毫秒）：同一品种同一类型在此窗口内不重复推送
const DEDUP_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 小时

// 时间止损天数（超过该天数未到目标则提醒）
const TIMEOUT_DAYS = 10;

// ---------- 内部工具 ----------

/** 计算品种信号的去重签名（用于检测信号变化） */
function signalSignature(row: V16Row): string {
  return [
    row.trade_worthiness,
    row.ai_direction || '',
    row.p_follow?.toFixed(3) || '',
    row.g4_reason_count ?? '',
    row.edge_grade || '',
    row.signal_grade || '',
  ].join('|');
}

/** 计算结构位与现价的偏离度（正=结构位高于现价，负=低于现价） */
function priceDeviation(structPrice: number | null | undefined, close: number | null | undefined): number | null {
  if (structPrice == null || close == null || close === 0) return null;
  return (structPrice - close) / close;
}

/** 判断某提醒在去重窗口内是否已推送过 */
function isDeduped(code: string, type: MonitorAlertType): boolean {
  const latest = getLatestTradeAlert(code, type);
  if (!latest?.created_at) return false;
  const lastTime = new Date(latest.created_at.replace(' ', 'T')).getTime();
  return Date.now() - lastTime < DEDUP_WINDOW_MS;
}

/** 提醒统一处理：落库 + 飞书推送 */
function emitAlert(alert: MonitorAlert, feishuLines?: Array<{ text: string; color?: string }>, feishuIcon?: string): void {
  // 去重
  if (isDeduped(alert.code, alert.type)) {
    console.log(`[Monitor] 去重跳过: ${alert.code} ${alert.type}`);
    return;
  }

  const record: TradeAlertRecord = {
    alert_type: alert.type,
    severity: alert.severity,
    code: alert.code,
    name: alert.name,
    title: alert.title,
    message: alert.message,
    detail: JSON.stringify(alert.detail || {}),
    push_status: '',
  };

  // 落库
  saveTradeAlert(record);
  console.log(`[Monitor] 提醒已生成: [${alert.severity}] ${alert.title}`);

  // 飞书推送（异步，失败不影响主流程）
  if (feishuLines && feishuLines.length > 0) {
    pushFeishuRich(alert.title, feishuLines, { icon: feishuIcon }).then((ok) => {
      console.log(`[Monitor] 飞书推送${ok ? '成功' : '失败'}: ${alert.title}`);
    }).catch((e) => console.error('[Monitor] 飞书推送异常:', e?.message || e));
  } else {
    pushFeishuText(`【${alert.title}】${alert.message}`).then((ok) => {
      console.log(`[Monitor] 飞书推送${ok ? '成功' : '失败'}: ${alert.title}`);
    }).catch((e) => console.error('[Monitor] 飞书推送异常:', e?.message || e));
  }
}

/** 生成品种的「回测稳健性 + 验证状态 + 样本可信度」提示文本 */
function formatRobustness(code: string): string {
  const opt = REALTIME_OPT_PARAMS[code];
  if (!opt) return '';
  const pct = opt.robustPct.toFixed(1);
  const statusMap: Record<string, string> = {
    iron_clad: '铁底·全链路通过',
    robust: '稳健·全链路通过',
    sensitive: '敏感·降仓',
    overfit: '过拟合·最低仓位观察',
    untested: '未通过P1验证',
  };
  const status = statusMap[opt.validationStatus] ?? opt.validationStatus;

  // 样本量警示：样本不足时追加警告
  const sampleWarn = opt.sampleReliability === 'low'
    ? ' · ⚠样本不足，稳健性存疑'
    : opt.sampleReliability === 'medium'
      ? ' · ⚠样本偏少，稳健性仅供参考'
      : '';

  return `回测稳健性 ${pct}%（1000次LHS）· ${status}${sampleWarn}`;
}

/** 生成交易机会的飞书富文本行（增强版交易策略） */
export function buildOpportunityLines(row: V16Row): Array<{ text: string; color?: string }> {
  const lines: Array<{ text: string; color?: string }> = [];
  const dir = row.ai_direction;
  const dirText = dir === '多' ? '做多' : dir === '空' ? '做空' : '观望';

  lines.push({ text: `┌ 方向：${dirText} | 信号等级：${row.signal_grade || 'N/A'}`, color: dir === '多' ? FEISHU_COLOR.red : dir === '空' ? FEISHU_COLOR.green : FEISHU_COLOR.grey });

  // 关键指标
  const gate = row.g4_pass ? `✅通过(${row.g4_reason_count}/5)` : `❌未过(${row.g4_reason_count}/5)`;
  lines.push({ text: `P(顺)=${row.p_follow?.toFixed(2) ?? 'N/A'} | Gate4: ${gate}` });

  if (row.g4_reasons_met?.length) {
    lines.push({ text: `理由：${row.g4_reasons_met.join('、')}` });
  }

  // 入场/止损/目标（带价格合理性校验：结构位与现价严重偏离时标注失效，避免误导）
  if (row.close != null) lines.push({ text: `现价：${row.close}` });

  const devEntry = priceDeviation(row.ch_entry, row.close);
  if (row.ch_entry != null && devEntry != null && Math.abs(devEntry) > 0.08) {
    const dirWord = devEntry > 0 ? '现价已跌破结构入场位' : '现价已高于结构入场位';
    lines.push({ text: `⚠ 结构入场位 ${row.ch_entry}（${dirWord} ${(devEntry * 100).toFixed(1)}%，信号可能失效，勿按此价入场）`, color: FEISHU_COLOR.orange });
  } else if (row.ch_entry != null) {
    lines.push({ text: `入场参考：${row.ch_entry}` });
  }
  // 止损位：仅当 CH 方向与 AI 方向一致时有效（ch_stop 方向随 ch_direction，多空分歧时方向相反会误导）
  if (row.ch_stop != null) {
    if (row.ch_direction && row.ai_direction && row.ch_direction === row.ai_direction) {
      lines.push({ text: `止损位：${row.ch_stop}（CH支撑，可配合ATR）`, color: FEISHU_COLOR.orange });
    } else if (row.ch_direction && row.ai_direction && row.ch_direction !== row.ai_direction) {
      lines.push({ text: `⚠ 通道方向${row.ch_direction}≠AI方向${row.ai_direction}，CH止损参考失效，方向确认前轻仓或观望`, color: FEISHU_COLOR.grey });
    }
  }

  // 目标位：方向一致性校验（多单目标应在现价上方，空单目标应在下方）
  if (row.mm_tier1 != null) {
    const wrongDir =
      (row.ai_direction === '多' && row.close != null && row.mm_tier1 < row.close) ||
      (row.ai_direction === '空' && row.close != null && row.mm_tier1 > row.close);
    if (wrongDir) {
      lines.push({ text: `⚠ 第一目标 ${row.mm_tier1} 与${row.ai_direction}方向矛盾（现价 ${row.close}），信号结构已过时，仅供参考`, color: FEISHU_COLOR.grey });
    } else {
      lines.push({ text: `第一目标：${row.mm_tier1}`, color: FEISHU_COLOR.blue });
    }
  }
  if (row.mm_tier2 != null) {
    const wrongDir =
      (row.ai_direction === '多' && row.close != null && row.mm_tier2 < row.close) ||
      (row.ai_direction === '空' && row.close != null && row.mm_tier2 > row.close);
    if (!wrongDir) {
      lines.push({ text: `第二目标：${row.mm_tier2}`, color: FEISHU_COLOR.blue });
    }
  }

  // 仓位
  const mult = row.position_multiplier || 1;
  const posLabel = mult >= 1 ? '标准仓位' : `${Math.round(mult * 100)}%仓位`;
  lines.push({ text: `仓位建议：${posLabel}（倍率×${mult.toFixed(2)}）` });

  // Edge 统计
  if (row.edge_grade) {
    lines.push({ text: `Edge评级：${row.edge_grade} | 近20笔胜率${row.win_rate_20 != null ? (row.win_rate_20 * 100).toFixed(0) + '%' : 'N/A'} | 均RR ${row.avg_rr?.toFixed(2) ?? 'N/A'}` });
  }

  // 回测稳健性 + 验证状态（1000 次 LHS 实验）
  const robustness = formatRobustness(row.code);
  if (robustness) {
    lines.push({ text: robustness, color: FEISHU_COLOR.cyan });
  }

  // MTF 共振
  if (row.mtf_resonance) {
    const res = row.mtf_resonance.resonance;
    const resText = res === 'full' ? '三周期共振' : res === 'partial' ? '部分共振' : res === 'conflict' ? '多周期冲突' : '无共振';
    lines.push({ text: `MTF：${resText}` });
  }

  // 紧通道 / 楔形 / 逆势抑制提示
  if (row.tight_channel) lines.push({ text: '⚠ 紧通道蓄势，突破后力度较强', color: FEISHU_COLOR.purple });
  if (row.wedge_filter_on) lines.push({ text: `⚠ 楔形反转过滤（${row.wedge_filtered_dir || ''}方向）`, color: FEISHU_COLOR.purple });
  if (row.trend_momentum != null && Math.abs(row.trend_momentum) > 0.05) {
    const mm = row.trend_momentum * 100;
    const trendHint = mm > 0 ? '多头趋势强，顺势不逆势' : '空头趋势强，顺势不逆势';
    lines.push({ text: `动量：${mm > 0 ? '+' : ''}${mm.toFixed(1)}%（200bar）| ${trendHint}`, color: FEISHU_COLOR.purple });
  }

  // 方向与风险提示（多空分歧 / 区间市 / 追高风险）
  const chDir = row.ch_direction && row.ch_direction !== '无' ? row.ch_direction : null;
  if (chDir && row.ai_direction && chDir !== row.ai_direction) {
    lines.push({ text: `⚠ 多空分歧：AI方向「${row.ai_direction}」 vs 通道方向「${chDir}」，方向未确认，建议轻仓或观望`, color: FEISHU_COLOR.orange });
  }
  if (row.spectrum && row.spectrum.includes('区间')) {
    lines.push({ text: '⚠ 区间市：勿追单，等回调/反弹边界入场，或观望等待突破', color: FEISHU_COLOR.orange });
  }
  if (row.close != null && row.ch_entry != null) {
    const dev = priceDeviation(row.ch_entry, row.close);
    if (dev != null && Math.abs(dev) > 0.08) {
      const chaseWord = row.ai_direction === '多' ? (dev < 0 ? '追高风险' : '破位风险') : dev > 0 ? '追高风险' : '破位风险';
      lines.push({ text: `⚠ ${chaseWord}：现价距结构入场位 ${(Math.abs(dev) * 100).toFixed(1)}%，务必等价格回到结构位附近再考虑入场`, color: FEISHU_COLOR.orange });
    }
  }

  lines.push({ text: `└ 光谱：${row.spectrum || 'N/A'}` });
  return lines;
}

// ---------- 机会监控 ----------

/**
 * 执行一次全市场 30min 扫描，检测新交易机会与信号变化
 */
export async function runOpportunityScan(): Promise<{ newSignals: string[]; changedSignals: string[] }> {
  console.log('[Monitor] 开始全市场 30min 机会扫描...');
  const report: V16ScanResult = await runV16FullScan30m();
  console.log(`[Monitor] 扫描完成: ${report.tradableCount} tradable / ${report.filteredCount} filtered / ${report.totalCount} total`);

  const newSignals: string[] = [];
  const changedSignals: string[] = [];

  for (const row of report.tradable) {
    const sig = signalSignature(row);
    const prev = lastScanSnapshot.get(row.code);

    if (prev === undefined) {
      // 首次扫描：缓存但不推送（避免启动即轰炸）
      lastScanSnapshot.set(row.code, sig);
      continue;
    }

    if (prev === sig) continue; // 无变化

    // 新出现的机会（之前是 filtered/观望 或不存在）
    if (!prev.startsWith('tradable|')) {
      const title = `交易机会：${row.name} ${row.code} [${row.signal_grade || ''}${row.ai_direction || ''}]`;
      emitAlert(
        {
          type: 'opportunity',
          severity: 'high',
          code: row.code,
          name: row.name,
          title,
          message: buildOpportunityMessage(row),
          detail: { close: row.close, p_follow: row.p_follow, signal_grade: row.signal_grade, direction: row.ai_direction, robust_pct: REALTIME_OPT_PARAMS[row.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[row.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[row.code]?.sampleReliability },
        },
        buildOpportunityLines(row),
        '🟢',
      );
      newSignals.push(row.code);
    } else {
      // 信号变化（已 tradable 但关键指标变了）
      const title = `信号变化：${row.name} ${row.code}`;
      emitAlert(
        {
          type: 'signal_change',
          severity: 'medium',
          code: row.code,
          name: row.name,
          title,
          message: `P(顺)=${row.p_follow?.toFixed(2)} Gate4=${row.g4_reason_count}/5 Edge=${row.edge_grade} 方向=${row.ai_direction} ${formatRobustness(row.code)}`,
          detail: { p_follow: row.p_follow, gate4: row.g4_reason_count, edge_grade: row.edge_grade, direction: row.ai_direction, robust_pct: REALTIME_OPT_PARAMS[row.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[row.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[row.code]?.sampleReliability },
        },
        [
          { text: `最新状态：${row.ai_direction || '观望'} | P(顺)=${row.p_follow?.toFixed(2) ?? 'N/A'} | Gate4=${row.g4_reason_count}/5 | Edge=${row.edge_grade || 'N/A'}` },
          { text: `现价：${row.close}`, color: FEISHU_COLOR.blue },
          { text: formatRobustness(row.code), color: FEISHU_COLOR.grey },
        ],
        '🟡',
      );
      changedSignals.push(row.code);
    }

    lastScanSnapshot.set(row.code, sig);
  }

  // 清理：不再出现在扫描结果的品种从快照移除
  const currentCodes = new Set(report.tradable.map((r) => r.code));
  for (const code of lastScanSnapshot.keys()) {
    if (!currentCodes.has(code) && !report.rows.some((r) => r.code === code)) {
      lastScanSnapshot.delete(code);
    }
  }

  console.log(`[Monitor] 机会扫描完成: 新信号 ${newSignals.length} 个, 变化 ${changedSignals.length} 个`);
  return { newSignals, changedSignals };
}

/** 生成机会提醒的纯文本 message */
function buildOpportunityMessage(row: V16Row): string {
  const dir = row.ai_direction === '多' ? '做多' : row.ai_direction === '空' ? '做空' : '观望';
  const parts = [
    `${row.name} ${row.code} 出现${dir}机会`,
    `信号等级 ${row.signal_grade || 'N/A'}，P(顺)=${row.p_follow?.toFixed(2) ?? 'N/A'}`,
  ];
  if (row.ch_entry != null) parts.push(`入场参考 ${row.ch_entry}`);
  if (row.ch_stop != null && row.ch_direction && row.ai_direction && row.ch_direction === row.ai_direction) parts.push(`止损 ${row.ch_stop}`);
  if (row.mm_tier1 != null) parts.push(`目标1 ${row.mm_tier1}`);
  if (row.mm_tier2 != null) parts.push(`目标2 ${row.mm_tier2}`);
  if (row.edge_grade) parts.push(`Edge ${row.edge_grade}`);
  const robustness = formatRobustness(row.code);
  if (robustness) parts.push(robustness);
  return parts.join('，');
}

// ---------- 持仓监控 ----------

/**
 * 对登记持仓逐品种检查：止损/目标/信号反转/逆势抑制/时间止损
 * 需要一份最新的 30min 扫描结果（可传入，避免重复扫描）
 */
export async function monitorPositions(report?: V16ScanResult): Promise<string[]> {
  const positions = getMonitoredPositions('active');
  if (positions.length === 0) {
    console.log('[Monitor] 无活跃持仓，跳过持仓监控');
    return [];
  }

  // 无传入扫描结果时执行一次全市场扫描
  let scanReport = report;
  if (!scanReport) {
    scanReport = await runV16FullScan30m();
  }

  const triggered: string[] = [];
  for (const pos of positions) {
    const row = scanReport.rows.find((r) => r.code === pos.code);
    if (!row || row.close == null) continue;

    const close = row.close;
    const dirText = pos.direction === 'long' ? '多单' : '空单';
    const alerts: MonitorAlert[] = [];

    // 1. 止损触发
    if (pos.stop_loss != null) {
      const hit = pos.direction === 'long' ? close <= pos.stop_loss : close >= pos.stop_loss;
      if (hit) {
        alerts.push({
          type: 'position_stop',
          severity: 'high',
          code: pos.code,
          name: pos.name,
          title: `止损提醒：${pos.name} ${pos.code} ${dirText}`,
          message: `你的持仓成本 ${pos.entry_price} → 现价 ${close}，已触及止损位 ${pos.stop_loss}，建议执行离场`,
          detail: { entry: pos.entry_price, close, stop_loss: pos.stop_loss, direction: pos.direction, robust_pct: REALTIME_OPT_PARAMS[pos.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[pos.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[pos.code]?.sampleReliability },
        });
      }
    }

    // 2. 目标到达
    if (pos.target_price != null) {
      const hit = pos.direction === 'long' ? close >= pos.target_price : close <= pos.target_price;
      if (hit) {
        alerts.push({
          type: 'position_target',
          severity: 'medium',
          code: pos.code,
          name: pos.name,
          title: `目标到达：${pos.name} ${pos.code} ${dirText}`,
          message: `你的持仓成本 ${pos.entry_price} → 现价 ${close}，已触及目标位 ${pos.target_price}，考虑止盈或上移止损到成本`,
          detail: { entry: pos.entry_price, close, target: pos.target_price, direction: pos.direction, robust_pct: REALTIME_OPT_PARAMS[pos.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[pos.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[pos.code]?.sampleReliability },
        });
      }
    }

    // 3. 信号反转
    if (row.ai_direction && row.ai_direction !== '中性') {
      const reversed = pos.direction === 'long' ? row.ai_direction === '空' : row.ai_direction === '多';
      if (reversed) {
        alerts.push({
          type: 'position_reverse',
          severity: 'high',
          code: pos.code,
          name: pos.name,
          title: `信号反转：${pos.name} ${pos.code} ${dirText}`,
          message: `持仓方向 ${dirText}，但最新信号已翻转为${row.ai_direction}，建议考虑离场`,
          detail: { direction: pos.direction, signal_direction: row.ai_direction, p_follow: row.p_follow, robust_pct: REALTIME_OPT_PARAMS[pos.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[pos.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[pos.code]?.sampleReliability },
        });
      }
    }

    // 4. 逆势抑制（趋势动量与持仓方向相反）
    if (row.trend_momentum != null) {
      const mm = row.trend_momentum;
      const suppressed = pos.direction === 'long' ? mm < -0.05 : mm > 0.05;
      if (suppressed) {
        alerts.push({
          type: 'position_trend',
          severity: 'medium',
          code: pos.code,
          name: pos.name,
          title: `逆势警告：${pos.name} ${pos.code} ${dirText}`,
          message: `200bar动量 ${(mm * 100).toFixed(1)}% 与持仓方向相反，系统已抑制逆势信号，建议减仓或离场`,
          detail: { direction: pos.direction, trend_momentum: mm, robust_pct: REALTIME_OPT_PARAMS[pos.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[pos.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[pos.code]?.sampleReliability },
        });
      }
    }

    // 5. 时间止损（入场超过 N 天未触发目标）
    if (pos.entry_time) {
      const days = (Date.now() - new Date(pos.entry_time).getTime()) / (24 * 3600 * 1000);
      if (days >= TIMEOUT_DAYS) {
        alerts.push({
          type: 'position_timeout',
          severity: 'low',
          code: pos.code,
          name: pos.name,
          title: `时间止损：${pos.name} ${pos.code} ${dirText}`,
          message: `持仓已 ${Math.round(days)} 天未触发目标，建议评估是否继续持有`,
          detail: { entry_time: pos.entry_time, days: Math.round(days), robust_pct: REALTIME_OPT_PARAMS[pos.code]?.robustPct, validation_status: REALTIME_OPT_PARAMS[pos.code]?.validationStatus, sample_reliability: REALTIME_OPT_PARAMS[pos.code]?.sampleReliability },
        });
      }
    }

    // 发出提醒
    for (const a of alerts) {
      emitAlert(a, buildPositionLines(pos, row, a), a.type === 'position_stop' || a.type === 'position_reverse' ? '🔴' : a.type === 'position_target' ? '🟢' : '⚠️');
      triggered.push(`${a.type}:${a.code}`);
    }
  }

  return triggered;
}

/** 生成持仓提醒的飞书富文本行 */
function buildPositionLines(pos: MonitoredPosition, row: V16Row, alert: MonitorAlert): Array<{ text: string; color?: string }> {
  const dirText = pos.direction === 'long' ? '多单' : '空单';
  const lines: Array<{ text: string; color?: string }> = [];
  lines.push({ text: `┌ ${pos.name} ${pos.code} ${dirText}` });
  lines.push({ text: `你的持仓成本：${pos.entry_price} | 现价：${row.close}` });
  if (pos.stop_loss != null) lines.push({ text: `止损位：${pos.stop_loss}`, color: FEISHU_COLOR.orange });
  if (pos.target_price != null) lines.push({ text: `目标位：${pos.target_price}`, color: FEISHU_COLOR.blue });
  lines.push({ text: `最新信号：${row.ai_direction || '观望'} | P(顺)=${row.p_follow?.toFixed(2) ?? 'N/A'} | Gate4=${row.g4_reason_count}/5` });
  if (row.edge_grade) lines.push({ text: `Edge=${row.edge_grade} | 近20笔胜率${row.win_rate_20 != null ? (row.win_rate_20 * 100).toFixed(0) + '%' : 'N/A'}` });
  // 回测稳健性
  const robustness = formatRobustness(pos.code);
  if (robustness) lines.push({ text: robustness, color: FEISHU_COLOR.cyan });
  lines.push({ text: `└ ${alert.message}` });
  return lines;
}

/**
 * 基于事件ID的去重检查（24小时窗口）
 * 检查数据库中是否已存在相同 eventId 的黑天鹅事件提醒
 */
function isEventDeduped(eventId: string): boolean {
  const alerts = getTradeAlerts({ limit: 200 });
  const now = Date.now();
  const DEDUP_WINDOW = 24 * 60 * 60 * 1000; // 24小时
  
  for (const alert of alerts) {
    if (alert.alert_type !== 'news_black_swan') continue;
    if (!alert.created_at) continue;
    
    // 检查时间窗口
    const alertTime = new Date(alert.created_at.replace(' ', 'T')).getTime();
    if (now - alertTime > DEDUP_WINDOW) continue;
    
    // 检查 eventId
    try {
      const detail = JSON.parse(alert.detail || '{}');
      if (detail.eventId === eventId) {
        return true;
      }
    } catch {
      // ignore parse error
    }
  }
  return false;
}

/**
 * 扫描新闻黑天鹅事件并生成提醒
 * 每个事件只生成一条提醒（不是每个品种一条），基于 eventId 去重（24小时窗口）
 */
async function scanNewsBlackSwans(): Promise<string[]> {
  const newAlerts: string[] = [];
  
  try {
    const scanResult = await scanNewsForEvents();
    const { detectedEvents, news } = scanResult;
    
    console.log(`[Monitor] 新闻扫描完成，搜索到 ${news.length} 条新闻，检测到 ${detectedEvents.length} 个事件`);
    
    // 如果没有检测到事件，直接返回
    if (detectedEvents.length === 0) {
      console.log('[Monitor] 未检测到黑天鹅事件');
      return newAlerts;
    }
    
    // 筛选重大事件（高影响力或黑天鹅类别）
    const blackSwanEvents = detectedEvents.filter(event => {
      // 检查事件影响力（confidence 在 DetectedEvent 层级）
      const isHighImpact = event.confidence >= 0.7;
      // 检查是否为黑天鹅类别（地缘政治、政策突变等）
      const isBlackSwanCategory = [1, 2, 3].includes(event.event.category); // 1=地缘政治，2=政策，3=自然灾害
      
      return isHighImpact || isBlackSwanCategory;
    });
    
    console.log(`[Monitor] 筛选出 ${blackSwanEvents.length} 个黑天鹅事件`);
    
    // 为每个黑天鹅事件生成提醒（每个事件只生成一条）
    for (const event of blackSwanEvents) {
      const { event: eventData, affectedVarieties, confidence, matchedNews } = event;
      
      // 基于事件ID去重（24小时窗口）
      if (isEventDeduped(eventData.id)) {
        console.log(`[Monitor] 事件已存在，跳过: ${eventData.title} (${eventData.id})`);
        continue;
      }
      
      // 生成 LLM 深度解读
      let aiInterpretation = '';
      let aiDirection: '利多' | '利空' | '中性' = '中性';
      try {
        const interpretation = await generateNewsInterpretation(matchedNews);
        aiInterpretation = interpretation.interpretation;
        aiDirection = interpretation.direction;
      } catch (e) {
        console.error('[Monitor] AI 解读失败:', e);
      }
      
      // 每个事件只生成一条提醒（使用第一个受影响品种作为 code）
      const primaryCode = affectedVarieties[0] || 'unknown';
      const title = `黑天鹅事件：${eventData.title}`;
      const message = `${eventData.categoryName} | ${aiDirection} | 影响品种：${affectedVarieties.join(', ')} | ${eventData.consensus}`;
      
      const record: TradeAlertRecord = {
        alert_type: 'news_black_swan',
        severity: confidence >= 0.9 ? 'high' : 'medium',
        code: primaryCode,
        name: primaryCode,
        title,
        message,
        detail: JSON.stringify({
          eventId: eventData.id,
          category: eventData.categoryName,
          direction: eventData.direction,
          aiDirection,
          consensus: eventData.consensus,
          confidence,
          affectedVarieties, // 所有受影响品种
          date: eventData.date,
          aiInterpretation,
          matchedNews: matchedNews.slice(0, 5).map((n: NewsItem) => ({
            title: n.title,
            source: n.source,
            snippet: n.snippet?.slice(0, 200),
            url: n.url,
            publishTime: n.publishTime,
          })),
        }),
        push_status: '',
      };
      
      saveTradeAlert(record);
      newAlerts.push(primaryCode);
      console.log(`[Monitor] 黑天鹅事件提醒已生成: ${title} (影响 ${affectedVarieties.length} 个品种, AI解读: ${aiDirection})`);
    }
  } catch (error) {
    console.error('[Monitor] 新闻黑天鹅扫描失败:', error);
  }
  
  return newAlerts;
}

// ---------- 对外 API 封装 ----------

export async function runMonitorOnce(): Promise<{ opportunities: string[]; positionAlerts: string[]; newsAlerts: string[]; skipped?: boolean }> {
  // 并发互斥：已有扫描任务在执行时直接返回，避免重复扫描造成后端压力
  if (isScanRunning) {
    console.log('[Monitor] 已有全监控扫描任务执行中，跳过本次触发');
    return { opportunities: [], positionAlerts: [], newsAlerts: [], skipped: true };
  }

  isScanRunning = true;
  try {
    const opp = await runOpportunityScan();
    // 持仓监控无缓存报告时内部会自行扫描一次
    const positions = await monitorPositions();

    // 新闻黑天鹅事件检测
    const newsAlerts = await scanNewsBlackSwans();

    lastScanAt = Date.now();
    return { opportunities: opp.newSignals, positionAlerts: positions, newsAlerts };
  } finally {
    isScanRunning = false;
  }
}

/** 获取自动扫描状态（上次扫描时间 / 是否扫描中） */
export function getScanStatus(): { lastScanAt: number | null; isScanning: boolean } {
  return { lastScanAt, isScanning: isScanRunning };
}

export {
  getTradeAlerts,
  getUnreadAlertCount,
  markTradeAlertRead,
  markAllTradeAlertsRead,
  clearTradeAlerts,
  getMonitoredPositions,
  saveMonitoredPosition,
  deleteMonitoredPosition,
  closeMonitoredPosition,
  getMonitoredPosition,
  scanNewsBlackSwans,
};
