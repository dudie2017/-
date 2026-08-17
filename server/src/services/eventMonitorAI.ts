/**
 * 传播链预警 LLM 深度解读服务
 *
 * 把传播链预警的结构化数据（冲击事件 + 传播对 + 板块联动 + 季节性 + V16 信号）
 * 喂给大语言模型，输出有洞察力的交易解读，而非冷冰冰的信号列表。
 *
 * 设计原则：
 * 1. 数据诚实：LLM 只基于提供的数据解读，禁止编造行情或点位
 * 2. 流式输出：默认 SSE 流式，前端逐块渲染
 * 3. 交叉验证：结合 V16 信号方向，给出一致/矛盾的判断
 */

import { LLMClient, Config } from 'coze-coding-dev-sdk';
import { getLatestScanResult } from './eventMonitorService.js';
import type { PropagationAlert } from './eventMonitorService.js';
import { getScanCache } from '../routes/scan.js';
import type { V16Row } from './v16_types.js';

// AI 模型配置：通过环境变量 AI_MODEL 切换
const AI_MODEL = process.env.AI_MODEL || 'doubao-seed-2-0-lite-260215';
// AI 请求超时（毫秒）
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;

/** 为 Promise 添加超时兜底，防止 LLM 挂起无限占住连接 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s），请稍后重试`)), ms)
    ),
  ]);
}

const SYSTEM_PROMPT = `你是一位资深期货研究员，精通产业链传导逻辑与 Brooks 价格行为分析。

你的任务：基于系统提供的【传播链预警数据】，输出可读性强的交易解读。

## 输出要求（严格按此结构）

1. **市场概览**：一段话概括当前传播链的整体状态（哪些板块活跃、方向如何）
2. **逐条解读**：对每条预警，输出：
   - 传导逻辑：用大白话解释"为什么 leader 的冲击会传导到 follower"（成本传导/替代/产业链）
   - 置信度判断：结合 ATR 倍数、板块联动率、季节性，给出"高/中/低"置信度及理由
   - V16 交叉验证：若 follower 有 V16 信号，说明方向一致还是矛盾；一致增强，矛盾提示观望
   - 风险提示：什么情况下该传导会失效
3. **综合建议**：2-3 条可操作的关注要点（关注方向、需要等待的确认信号）

## 硬性约束

- 只基于提供的数据解读，禁止编造行情、点位、新闻
- 禁止给出具体的开仓价格、仓位比例、止损点位（这是研究解读，不是下单指令）
- 语言接地气、直接了当，避免模棱两可的"一方面...另一方面..."
- 用中文输出，可用少量 markdown 标题与列表提升可读性
- 若数据为空或仅有少量信号，如实说明，不要硬凑内容`;

/**
 * 构建 V16 信号交叉引用表（follower code → V16 方向/信号等级）
 */
function buildV16CrossReference(): Map<string, V16Row> {
  const map = new Map<string, V16Row>();
  const scan = getScanCache();
  if (!scan) return map;
  for (const row of scan.rows) {
    map.set(row.code, row);
  }
  return map;
}

/**
 * 构建喂给 LLM 的结构化上下文
 */
export function buildInterpretationContext(): string {
  const result = getLatestScanResult();
  const v16Map = buildV16CrossReference();

  const lines: string[] = [];

  lines.push(`# 传播链预警数据（扫描日期 ${result.scanDate}）`);
  lines.push('');
  lines.push(`## 概览`);
  lines.push(`- 扫描品种数：${result.summary.totalVarieties}`);
  lines.push(`- 检测到 leader 冲击事件：${result.summary.shockCount} 个`);
  lines.push(`- 生成传播链预警：${result.summary.alertCount} 条`);
  if (Object.keys(result.summary.sectors).length > 0) {
    lines.push(`- 活跃板块：${Object.entries(result.summary.sectors).map(([s, n]) => `${s}(${n}条)`).join('、')}`);
  }
  lines.push('');

  if (result.alerts.length === 0) {
    lines.push('## 当前无活跃预警');
    lines.push(`已检测到 ${result.leaderShocks.length} 个 leader 冲击事件，但均未通过 next1 确认或板块联动/季节性过滤。`);
    lines.push('请基于上述情况如实说明，并给出"当前应观望/等待何种确认信号"的建议。');
    return lines.join('\n');
  }

  // 逐条预警画像
  lines.push('## 逐条预警详情');
  lines.push('');
  result.alerts.forEach((a: PropagationAlert, idx: number) => {
    const dirLabel = a.direction === 'LONG' ? '上涨(看多)' : '下跌(看空)';
    const strengthLabel = a.signalStrength === 'strong' ? '强' : '中';
    const corrText = a.sectorCorrelation !== null ? `${(a.sectorCorrelation * 100).toFixed(0)}%` : '未知';
    const seasonText = a.seasonalAlignment === null ? '未知' : a.seasonalAlignment ? '同向✓' : '逆向✗';

    lines.push(`### 预警 #${idx + 1}：${a.leaderName} → ${a.followerName}`);
    lines.push(`- 方向：${dirLabel}`);
    lines.push(`- 冲击：${a.leaderName} 于 ${a.shockDate} 涨跌幅 ${(a.shockReturn * 100).toFixed(2)}%（${a.shockAtrMult}×ATR，${strengthLabel}强度）`);
    lines.push(`- 次日确认：${a.next1Confirmed ? `已确认（${(a.next1Return * 100).toFixed(2)}%）` : '未确认'}`);
    lines.push(`- 传导逻辑：${a.logic}`);
    lines.push(`- 预期滞后：${a.lagDays} 天`);
    lines.push(`- 板块联动：${a.sector} 板块 ${corrText} 品种同向`);
    lines.push(`- 季节性：${seasonText}`);

    // V16 交叉验证
    const followerV16 = v16Map.get(a.follower);
    if (followerV16) {
      const v16Dir = followerV16.ai_direction;
      const aligned = (a.direction === 'LONG' && v16Dir === '多') || (a.direction === 'SHORT' && v16Dir === '空');
      const conflict = (a.direction === 'LONG' && v16Dir === '空') || (a.direction === 'SHORT' && v16Dir === '多');
      const v16Verdict = aligned ? '方向一致（增强）' : conflict ? '方向矛盾（需警惕）' : '方向中性';
      lines.push(`- V16 信号：${followerV16.name} 当前 V16 方向「${v16Dir}」，${v16Verdict}；ADX=${followerV16.adx}，趋势强度=${followerV16.trend_strength}，信号等级=${followerV16.signal_grade || 'N/A'}`);
    } else {
      lines.push(`- V16 信号：${a.followerName} 暂无 V16 扫描数据`);
    }
    lines.push('');
  });

  lines.push('## 请开始解读');
  lines.push('请基于以上数据，按系统要求的输出结构给出你的交易解读。');

  return lines.join('\n');
}

/**
 * 流式 LLM 解读（SSE 用）
 */
export async function* streamInterpretation(
  customHeaders?: Record<string, string>
): AsyncGenerator<string> {
  const client = new LLMClient(new Config(), customHeaders);

  const context = buildInterpretationContext();
  const messages = [
    { role: 'system' as const, content: SYSTEM_PROMPT },
    { role: 'user' as const, content: context },
  ];

  const stream = client.stream(messages, {
    model: AI_MODEL,
    temperature: 0.4,
    thinking: 'disabled',
  });

  // 带超时的流式迭代
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + AI_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`AI流式响应超时（>${Math.round(AI_TIMEOUT_MS / 1000)}s）`);
    }
    const result = await withTimeout(iterator.next(), remaining, 'AI流式响应');
    if (result.done) break;
    const chunk = result.value as { content?: unknown };
    if (chunk && chunk.content) {
      yield chunk.content.toString();
    }
  }
}
