/**
 * 事件驱动日报服务
 *
 * 以黑天鹅事件库（BLACK_SWAN_EVENTS）为入口，生成"事件复盘 + 品种技术面"的综合分析日报。
 * 数据来源全部为真实计算：
 *   - 品种日线缓存 data-cache/{code}.json
 *   - V16 扫描（scanV16Variety）
 *   - 板块归属（GROUP_NAMES / VARIETIES）
 *   - LLM 综合分析结论（coze-coding-dev-sdk）
 *
 * 约束：日报只做数据分析与事件解读，严禁输出买卖建议 / 做多做空意见。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { BLACK_SWAN_EVENTS, type BlackSwanEvent } from '../data/blackswanEvents.js';
import { VARIETIES, GROUP_NAMES, type BarData } from './varieties.js';
import { scanV16Variety } from './v16_engine.js';
import type { V16Row } from './v16_types.js';
import { searchMarketNews, detectEventsFromNews, type DetectedEvent } from './newsService.js';
import { getEventDailyReportByEventId, saveEventDailyReport } from './database.js';
import { LLMClient, Config } from 'coze-coding-dev-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '..', '..', 'data-cache');
// 20 年历史日线缓存（Tushare 主连，覆盖 2000 年至今），用于还原历史事件发生时的技术面
const HISTORY_CACHE_DIR = path.join(__dirname, '..', '..', 'data-cache-daily-20y');

const AI_MODEL = process.env.AI_MODEL || 'doubao-seed-2-0-lite-260215';
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;

// ===== 类型定义 =====

export interface EventDailyVariety {
  code: string;
  name: string;
  group: string;
  hasData: boolean;
  // 技术面（V16 扫描）
  close?: number;
  retPct?: number;
  spectrum?: string;
  aiDirection?: string;
  trendStrength?: number;
  adx?: number;
  marketContext?: string;
  lcStage?: string;
  signalGrade?: string;
  // 近期动量（%）
  recent5dReturn?: number;
  recent20dReturn?: number;
}

export interface EventDailyReport {
  event: {
    id: string;
    date: string;
    title: string;
    category: number;
    categoryName: string;
    direction: string;
    consensus: string;
    note?: string;
  };
  varieties: EventDailyVariety[];
  groups: Record<string, string[]>;
  aiConclusion: string;
}

// ===== 数据加载 =====

/** 解析日线缓存文件（支持数组格式 或 { bars, contract } 对象格式） */
function parseBarsFile(filePath: string, code: string): { bars: BarData[]; contract: string } {
  if (!fs.existsSync(filePath)) return { bars: [], contract: code };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (Array.isArray(raw)) {
      return { bars: raw as BarData[], contract: code };
    }
    const bars = (raw.bars || []) as BarData[];
    const contract = raw.contract || code;
    return { bars, contract };
  } catch {
    return { bars: [], contract: code };
  }
}

/** 加载品种日线缓存（优先 20 年历史缓存，fallback 半年实时缓存） */
function loadBars(code: string): { bars: BarData[]; contract: string } {
  // 优先读 20 年历史日线缓存，还原历史事件发生时的完整技术面
  const historyFile = path.join(HISTORY_CACHE_DIR, `${code}.json`);
  const history = parseBarsFile(historyFile, code);
  if (history.bars.length >= 30) return history;

  // fallback 半年实时缓存
  const filePath = path.join(CACHE_DIR, `${code}.json`);
  return parseBarsFile(filePath, code);
}

/** 计算近 N 个交易日累计收益率（%） */
function calcReturn(bars: BarData[], n: number): number | undefined {
  if (bars.length < n + 1) return undefined;
  const current = bars[bars.length - 1]?.c;
  const base = bars[bars.length - 1 - n]?.c;
  if (!current || !base || base === 0) return undefined;
  return Number((((current - base) / base) * 100).toFixed(2));
}

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s）`)), ms)
    ),
  ]);
}

// ===== 核心生成逻辑 =====

/**
 * 根据事件对象生成事件日报（品种技术面扫描 + LLM 分析）
 * @param event 事件对象（历史事件或最新检测事件）
 * @param customHeaders 从请求透传的 forward headers（供 LLM 鉴权）
 */
async function buildEventDailyReport(
  event: BlackSwanEvent,
  customHeaders?: Record<string, string>
): Promise<EventDailyReport> {
  const varieties: EventDailyVariety[] = [];
  const groups: Record<string, string[]> = {};

  for (const code of event.varieties) {
    const name = VARIETIES[code] || code;
    const group = GROUP_NAMES[code] || '未分类';

    if (!groups[group]) groups[group] = [];
    groups[group].push(name);

    const { bars: allBars, contract } = loadBars(code);

    // 还原"事件发生当时"的技术面：只保留事件日（含当天）之前的日线
    const eventDate = (event.date || '').slice(0, 10);
    const asOfBars = allBars.filter((b) => (b.date || '').slice(0, 10) <= eventDate);

    // 事件日前数据不足 30 根 → 如实标注无数据（品种上市晚于事件 / 数据源未覆盖该年代）
    if (asOfBars.length < 30) {
      varieties.push({ code, name, group, hasData: false });
      continue;
    }

    // 取事件日前最近 120 根用于 V16 扫描
    const bars = asOfBars.slice(-120);

    // V16 扫描（真实计算，使用默认参数）
    let v16: V16Row | null = null;
    try {
      v16 = scanV16Variety(code, bars, contract);
    } catch {
      v16 = null;
    }

    varieties.push({
      code,
      name,
      group,
      hasData: true,
      close: v16?.close ?? bars[bars.length - 1]?.c,
      retPct: v16?.ret_pct,
      spectrum: v16?.spectrum,
      aiDirection: v16?.ai_direction,
      trendStrength: v16?.trend_strength,
      adx: v16?.adx,
      marketContext: v16?.market_context,
      lcStage: v16?.lc_stage,
      signalGrade: v16?.signal_grade,
      recent5dReturn: calcReturn(bars, 5),
      recent20dReturn: calcReturn(bars, 20),
    });
  }

  // LLM 综合分析结论（失败则降级，不阻断日报生成）
  let aiConclusion = '';
  try {
    aiConclusion = await generateAIConclusion(event, varieties, groups, customHeaders);
  } catch {
    aiConclusion = '（AI 综合分析暂时不可用，以下为结构化数据呈现）';
  }

  return {
    event: {
      id: event.id,
      date: event.date,
      title: event.title,
      category: event.category,
      categoryName: event.categoryName,
      direction: event.direction,
      consensus: event.consensus,
      note: event.note,
    },
    varieties,
    groups,
    aiConclusion,
  };
}

/**
 * 生成事件驱动日报（历史事件，兼容旧接口）
 * @param eventId 黑天鹅事件 id
 * @param customHeaders 从请求透传的 forward headers（供 LLM 鉴权）
 */
export async function generateEventDailyReport(
  eventId: string,
  customHeaders?: Record<string, string>
): Promise<EventDailyReport> {
  const event = BLACK_SWAN_EVENTS.find((e) => e.id === eventId);
  if (!event) {
    throw new Error(`事件不存在: ${eventId}`);
  }
  return buildEventDailyReport(event, customHeaders);
}

/**
 * 列出最新事件（从新闻实时检测，复用 APP 已有逻辑）
 */
export async function listLatestEvents(): Promise<DetectedEvent[]> {
  const { news } = await searchMarketNews();
  if (!news || news.length === 0) return [];
  return detectEventsFromNews(news);
}

/**
 * 生成最新事件日报（从新闻实时检测，按 APP 已有逻辑分析并记录判断结果）
 * @param customHeaders 从请求透传的 forward headers（供 LLM 鉴权）
 */
export async function generateLatestEventDailyReport(
  customHeaders?: Record<string, string>,
  eventId?: string
): Promise<EventDailyReport[]> {
  const detected = await listLatestEvents();
  const targets = eventId
    ? detected.filter((d) => d.event.id === eventId)
    : detected;
  const reports: EventDailyReport[] = [];
  for (const d of targets) {
    try {
      reports.push(await buildEventDailyReport(d.event, customHeaders));
    } catch {
      // 单个事件分析失败不阻断整体
    }
  }
  return reports;
}

/**
 * 列出历史黑天鹅事件库（稳定 id，用于前端"事件日报"列表）
 */
export function listHistoricalEvents(): BlackSwanEvent[] {
  return BLACK_SWAN_EVENTS.map((e) => ({ ...e }));
}

/**
 * 全量回填历史事件日报（幂等：已存在的事件跳过）
 * @param customHeaders 从请求透传的 forward headers（供 LLM 鉴权）
 * @param concurrency 并发数（默认 3，避免 137 个事件串行调用 LLM 过慢）
 */
export async function generateAllHistoricalEventDailies(
  customHeaders?: Record<string, string>,
  concurrency = 3
): Promise<{ total: number; generated: number; skipped: number; failed: number }> {
  const queue = [...BLACK_SWAN_EVENTS];
  let generated = 0;
  let skipped = 0;
  let failed = 0;

  const worker = async () => {
    while (queue.length > 0) {
      const event = queue.shift()!;
      try {
        // 幂等：已存在则跳过，避免重复生成
        if (getEventDailyReportByEventId(event.id)) {
          skipped += 1;
          continue;
        }
        const report = await generateEventDailyReport(event.id, customHeaders);
        saveEventDailyReport({
          id: `event-${event.id}`,
          event_id: event.id,
          event_date: event.date,
          title: event.title,
          category: event.categoryName,
          generated_at: new Date().toISOString(),
          report_json: JSON.stringify(report),
          is_realtime: 0, // 历史事件
        });
        generated += 1;
      } catch {
        failed += 1;
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, () => worker());
  await Promise.all(workers);

  return { total: BLACK_SWAN_EVENTS.length, generated, skipped, failed };
}

// ===== LLM 综合分析 =====

async function generateAIConclusion(
  event: BlackSwanEvent,
  varieties: EventDailyVariety[],
  groups: Record<string, string[]>,
  customHeaders?: Record<string, string>
): Promise<string> {
  const client = new LLMClient(new Config(), customHeaders);

  const systemPrompt = `你是资深期货研究员。请基于提供的黑天鹅事件和品种当前技术面数据，生成客观的事件分析。
要求：
1. 只做数据分析与事件解读，严禁给出任何买卖建议、做多/做空/建仓/离场/持仓等交易意见
2. 分析该事件的市场影响与市场共识预期是否吻合（可结合你的历史知识）
3. 结合涉及品种当前技术面状态，说明该事件类别对相关品种的影响传导逻辑
4. 若事件备注中有"反直觉/反转"提示，重点解读其成因
5. 语言精炼，控制在 300 字以内，分 2-3 段`;

  const varietyLines = varieties
    .map((v) => {
      if (!v.hasData) return `- ${v.name}(${v.code})[${v.group}]：暂无行情数据`;
      return `- ${v.name}(${v.code})[${v.group}]：频谱${v.spectrum ?? 'N/A'}，AI方向${v.aiDirection ?? 'N/A'}，趋势强度${v.trendStrength ?? 'N/A'}，ADX ${v.adx ?? 'N/A'}，市场环境${v.marketContext ?? 'N/A'}，近5日${v.recent5dReturn ?? 'N/A'}%，近20日${v.recent20dReturn ?? 'N/A'}%`;
    })
    .join('\n');

  const groupLines = Object.entries(groups)
    .map(([g, names]) => `- ${g}：${names.join('、')}`)
    .join('\n');

  const userPrompt = `黑天鹅事件：
- 标题：${event.title}
- 日期：${event.date}
- 类别：${event.categoryName}
- 方向：${event.direction}
- 市场共识：${event.consensus}
- 备注：${event.note || '无'}

涉及品种当前技术面（数据来源：V16 扫描 + 日线缓存）：
${varietyLines}

涉及板块分布：
${groupLines}

请生成综合分析结论。`;

  const response = await withTimeout(
    client.invoke(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      { model: AI_MODEL, temperature: 0.5 }
    ),
    AI_TIMEOUT_MS,
    'AI 综合分析'
  );

  return response.content || '';
}
