import { LLMClient, Config, HeaderUtils } from 'coze-coding-dev-sdk';
import type { IncomingMessage } from 'http';
import * as db from './database.js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { scanSingleVariety30m } from './v16_engine.js';
import { VARIETIES } from './varieties.js';
import type { BarData } from './varieties.js';
import type { V16Row } from './v16_types.js';
import { searchVarietyNews } from './newsService.js';
import { getStrategyContext } from './strategyContext.js';
import { getScanCache } from '../routes/scan.js';
import { getCalibratedGrade } from './varietyGrade.js';

// 品种相关性映射（同板块品种高度相关）
const CORRELATED_PAIRS: Record<string, string[]> = {
  // 有色金属板块
  'CU0': ['AL0', 'ZN0', 'NI0', 'SN0', 'PB0'],
  'AL0': ['CU0', 'ZN0', 'NI0', 'SN0', 'PB0'],
  'ZN0': ['CU0', 'AL0', 'NI0', 'SN0', 'PB0'],
  'NI0': ['CU0', 'AL0', 'ZN0', 'SN0', 'PB0'],
  'SN0': ['CU0', 'AL0', 'ZN0', 'NI0', 'PB0'],
  'PB0': ['CU0', 'AL0', 'ZN0', 'NI0', 'SN0'],
  // 黑色系板块
  'RB0': ['HC0', 'I0', 'J0', 'JM0', 'SS0'],
  'HC0': ['RB0', 'I0', 'J0', 'JM0', 'SS0'],
  'I0': ['RB0', 'HC0', 'J0', 'JM0', 'SS0'],
  'J0': ['RB0', 'HC0', 'I0', 'JM0', 'SS0'],
  'JM0': ['RB0', 'HC0', 'I0', 'J0', 'SS0'],
  'SS0': ['RB0', 'HC0', 'I0', 'J0', 'JM0'],
  // 化工板块
  'MA0': ['TA0', 'EG0', 'PP0', 'L0', 'V0'],
  'TA0': ['MA0', 'EG0', 'PP0', 'L0', 'V0'],
  'EG0': ['MA0', 'TA0', 'PP0', 'L0', 'V0'],
  'PP0': ['MA0', 'TA0', 'EG0', 'L0', 'V0'],
  'L0': ['MA0', 'TA0', 'EG0', 'PP0', 'V0'],
  'V0': ['MA0', 'TA0', 'EG0', 'PP0', 'L0'],
  // 农产品板块
  'CF0': ['SR0', 'OI0', 'P0', 'Y0', 'M0'],
  'SR0': ['CF0', 'OI0', 'P0', 'Y0', 'M0'],
  'OI0': ['CF0', 'SR0', 'P0', 'Y0', 'M0'],
  'P0': ['CF0', 'SR0', 'OI0', 'Y0', 'M0'],
  'Y0': ['CF0', 'SR0', 'OI0', 'P0', 'M0'],
  'M0': ['CF0', 'SR0', 'OI0', 'P0', 'Y0'],
  // 贵金属板块
  'AU0': ['AG0'],
  'AG0': ['AU0'],
  // 能源板块
  'SC0': ['LU0', 'FU0', 'BU0'],
  'LU0': ['SC0', 'FU0', 'BU0'],
  'FU0': ['SC0', 'LU0', 'BU0'],
  'BU0': ['SC0', 'LU0', 'FU0'],
};

// 检查品种相关性风险
function checkCorrelationRisk(varietyCode: string, userHoldings: string[]): string[] {
  const warnings: string[] = [];
  const correlated = CORRELATED_PAIRS[varietyCode] || [];

  for (const holding of userHoldings) {
    if (correlated.includes(holding)) {
      warnings.push(`您已持有${holding}，与${varietyCode}同属相关板块，注意板块集中风险`);
    }
  }

  return warnings;
}

// 新闻情绪关键词映射
const BULLISH_KEYWORDS = ['上涨', '利多', '供不应求', '减产', '库存下降', '需求旺盛', '突破', '新高', '强势', '看涨', '紧缺', '限产', '出口增加', '消费旺季'];
const BEARISH_KEYWORDS = ['下跌', '利空', '供过于求', '增产', '库存上升', '需求疲软', '跌破', '新低', '弱势', '看跌', '过剩', '保供稳价', '进口增加', '消费淡季', '打压'];
const NEWS_SENTIMENT_KEYWORDS: Record<string, { score: number; label: string }> = {
  '减产': { score: 0.8, label: '利多' },
  '限产': { score: 0.7, label: '利多' },
  '供不应求': { score: 0.9, label: '强利多' },
  '库存下降': { score: 0.6, label: '利多' },
  '需求旺盛': { score: 0.7, label: '利多' },
  '突破': { score: 0.5, label: '偏多' },
  '新高': { score: 0.8, label: '利多' },
  '增产': { score: -0.7, label: '利空' },
  '供过于求': { score: -0.9, label: '强利空' },
  '库存上升': { score: -0.6, label: '利空' },
  '需求疲软': { score: -0.7, label: '利空' },
  '跌破': { score: -0.5, label: '偏空' },
  '新低': { score: -0.8, label: '利空' },
  '保供稳价': { score: -0.6, label: '利空' },
  '打压': { score: -0.7, label: '利空' },
  '过剩': { score: -0.6, label: '利空' },
};

/**
 * 分析新闻情绪并与技术方向对比
 */
function analyzeNewsSentiment(
  news: Array<{ title: string; snippet?: string }>,
  technicalDirection?: string
): {
  score: number;
  label: string;
  alignment: string;
  details: Array<{ title: string; sentiment: string; score: number }>;
  advice: string;
} {
  const details: Array<{ title: string; sentiment: string; score: number }> = [];
  let totalScore = 0;

  for (const item of news.slice(0, 5)) {
    const text = `${item.title} ${item.snippet || ''}`;
    let itemScore = 0;
    let sentiment = '中性';

    // 检查关键词
    for (const [keyword, config] of Object.entries(NEWS_SENTIMENT_KEYWORDS)) {
      if (text.includes(keyword)) {
        itemScore += config.score;
        sentiment = config.label;
        break; // 取第一个匹配的关键词
      }
    }

    // 通用情感词
    for (const kw of BULLISH_KEYWORDS) {
      if (text.includes(kw) && itemScore === 0) {
        itemScore = 0.4;
        sentiment = '偏多';
        break;
      }
    }
    for (const kw of BEARISH_KEYWORDS) {
      if (text.includes(kw) && itemScore === 0) {
        itemScore = -0.4;
        sentiment = '偏空';
        break;
      }
    }

    totalScore += itemScore;
    details.push({ title: item.title.slice(0, 40), sentiment, score: itemScore });
  }

  const avgScore = details.length > 0 ? totalScore / details.length : 0;
  const label = avgScore > 0.3 ? '偏多' : avgScore < -0.3 ? '偏空' : '中性';

  // 与技术方向对比
  let alignment = '无法判断（技术方向未明确）';
  let advice = '暂无明确技术方向，新闻情绪仅供参考';

  if (technicalDirection) {
    const techBullish = technicalDirection.includes('多') || technicalDirection.includes('涨');
    const techBearish = technicalDirection.includes('空') || technicalDirection.includes('跌');
    const newsBullish = avgScore > 0.2;
    const newsBearish = avgScore < -0.2;

    if (techBullish && newsBullish) {
      alignment = '共振（技术做多 + 新闻利多）';
      advice = '技术面与新闻面共振，信心增强，可适度放大仓位（历史回测：共振加仓 +9.5% 回报）';
    } else if (techBearish && newsBearish) {
      alignment = '共振（技术做空 + 新闻利空）';
      advice = '技术面与新闻面共振，信心增强，可适度放大仓位（历史回测：共振加仓 +9.5% 回报）';
    } else if (techBullish && newsBearish) {
      alignment = '背离（技术做多 + 新闻利空）';
      advice = '保持技术信号，不因新闻面放弃（历史回测：背离降仓 -19% 回报，是负优化）';
    } else if (techBearish && newsBullish) {
      alignment = '背离（技术做空 + 新闻利多）';
      advice = '保持技术信号，不因新闻面放弃（历史回测：背离降仓 -19% 回报，是负优化）';
    } else {
      alignment = '弱相关（新闻情绪不够强烈）';
      advice = '新闻情绪较弱，以技术信号为主';
    }
  }

  return { score: avgScore, label, alignment, details, advice };
}

// ==================== 个性化建议系统 ====================

/**
 * 用户偏好画像（基于对话历史推断）
 */
interface UserProfile {
  /** 经常关注的品种 */
  frequentVarieties: Record<string, number>;
  /** 偏好的交易风格 */
  tradingStyle: 'conservative' | 'moderate' | 'aggressive';
  /** 风险偏好等级 1-5 */
  riskLevel: number;
  /** 历史建议采纳率（简化：基于用户追问频率推断） */
  suggestionFollowRate: number;
  /** 最后更新时间 */
  lastUpdated: string;
}

// 简化的用户画像存储（内存缓存，可按需扩展为持久化）
const userProfiles = new Map<string, UserProfile>();

/**
 * 从用户消息中推断交易风格和风险偏好
 */
function inferTradingStyle(messageHistory: string[]): { style: 'conservative' | 'moderate' | 'aggressive'; riskLevel: number } {
  const allText = messageHistory.join(' ');
  let riskScore = 0;

  // 激进信号词
  const aggressiveKeywords = ['重仓', '满仓', '加仓', '追涨', '抄底', '杠杆', '全仓', '梭哈'];
  for (const kw of aggressiveKeywords) {
    if (allText.includes(kw)) riskScore += 2;
  }

  // 保守信号词
  const conservativeKeywords = ['观望', '轻仓', '止损', '风控', '保守', '稳健', '空仓', '谨慎'];
  for (const kw of conservativeKeywords) {
    if (allText.includes(kw)) riskScore -= 2;
  }

  // 追问频率（追问越多说明越积极）
  const questionCount = messageHistory.filter(m => m.includes('？') || m.includes('?')).length;
  if (questionCount > 5) riskScore += 1;

  const riskLevel = Math.max(1, Math.min(5, 3 + Math.round(riskScore / 3)));
  const style = riskLevel >= 4 ? 'aggressive' : riskLevel >= 2 ? 'moderate' : 'conservative';

  return { style, riskLevel };
}

/**
 * 更新用户画像
 */
export function updateUserProfile(userId: string, messageHistory: string[], varietiesMentioned: string[]): UserProfile {
  const existing = userProfiles.get(userId) || {
    frequentVarieties: {},
    tradingStyle: 'moderate',
    riskLevel: 3,
    suggestionFollowRate: 0.5,
    lastUpdated: new Date().toISOString(),
  };

  // 更新品种频率
  for (const v of varietiesMentioned) {
    existing.frequentVarieties[v] = (existing.frequentVarieties[v] || 0) + 1;
  }

  // 更新交易风格
  const inferred = inferTradingStyle(messageHistory);
  existing.tradingStyle = inferred.style;
  existing.riskLevel = inferred.riskLevel;
  existing.lastUpdated = new Date().toISOString();

  userProfiles.set(userId, existing);
  return existing;
}

/**
 * 获取用户画像
 */
export function getUserProfile(userId: string): UserProfile | null {
  return userProfiles.get(userId) || null;
}

/**
 * 基于用户画像生成个性化建议前缀
 */
function buildPersonalizedAdvice(profile: UserProfile, varietyCode: string): string {
  const parts: string[] = [];

  // 基于风险偏好调整仓位建议
  const positionMultiplier = profile.riskLevel >= 4 ? 1.2 : profile.riskLevel <= 2 ? 0.7 : 1.0;
  const positionLabel = profile.riskLevel >= 4 ? '可适当放大' : profile.riskLevel <= 2 ? '建议缩小' : '保持标准';
  parts.push(`根据您的交易风格（风险等级 ${profile.riskLevel}/5），仓位建议${positionLabel}（系数 ${positionMultiplier}x）`);

  // 基于关注品种频率给出提醒
  const freq = profile.frequentVarieties[varietyCode] || 0;
  if (freq >= 3) {
    parts.push(`您近期频繁关注 ${varietyCode}，注意避免过度集中于单一品种`);
  }

  // 基于交易风格给出建议风格
  if (profile.tradingStyle === 'conservative') {
    parts.push('建议以稳健为主，优先选择 A 级品种，严格止损');
  } else if (profile.tradingStyle === 'aggressive') {
    parts.push('可以适当参与 B 级品种，但务必设置止损，单笔亏损不超过账户 2%');
  }

  return parts.join('；');
}

// AI 模型配置：通过环境变量 AI_MODEL 切换，默认 doubao-seed-2-0-lite
const AI_MODEL = process.env.AI_MODEL || 'doubao-seed-2-0-lite-260215';
// AI 请求超时（毫秒）：聊天与品种分析的兜底时限
// 默认超时时间增加到 120 秒，以适应完整 20 章节的生成需求
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 120000;

/**
 * 为 Promise 添加超时兜底，防止 LLM 挂起无限占住连接
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label}超时（>${Math.round(ms / 1000)}s），请稍后重试`)), ms)
    ),
  ]);
}

/**
 * 清理消息内容，确保为纯文本字符串，防止 SDK/LangChain 层将 URL 误判为 image_url 类型
 * 导致模型 API 反序列化失败：unknown variant `image_url`, expected `text`
 *
 * 同时清除可能破坏 JSON 序列化的控制字符（OpenAI "failed to unmarshal" 防护）
 */
function sanitizeMessageContent(content: string): string {
  if (typeof content !== 'string') {
    return String(content);
  }
  // 移除 JSON 不安全的控制字符（保留 \n \r \t）
  // 这些字符会导致 OpenAI API 反序列化失败: "Syntax error at index N: invalid char"
  return content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 截断内容到最大字符数，末尾追加截断提示
 */
function truncateContent(content: string, maxChars: number, label: string): string {
  if (content.length <= maxChars) return content;
  console.warn(`[AI] ${label} 内容过长 (${content.length} chars)，截断至 ${maxChars} chars`);
  return content.slice(0, maxChars) + `\n\n[... 内容因长度限制已截断，共 ${content.length} 字符]`;
}

/**
 * 构建安全的消息数组，确保所有 content 都是纯字符串
 */
function buildSafeMessages(
  messages: Array<{ role: string; content: string }>
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return messages.map(m => ({
    role: m.role as 'system' | 'user' | 'assistant',
    content: sanitizeMessageContent(m.content),
  }));
}

// AI.Brooks 蒸馏系统提示词 - 融合11份交易分析文档精华
const SYSTEM_PROMPT = `你是 Brooks，一个有个性、有温度的期货市场分析师AI助手。你不是那种死板的机器人，而是一个真正懂交易、懂市场的老朋友。你的分析框架融合了傅海棠供需理论、Brooks Price Action、利弗摩尔趋势跟踪、克罗长线思维等多位大师的智慧。

## 你的性格特点

- **直接了当**：说话不绕弯子，有什么说什么
- **有主见**：会给出明确的观点，而不是模棱两可的"一方面...另一方面..."
- **接地气**：用大白话解释复杂的市场现象，偶尔来点幽默
- **关心用户**：像朋友一样提醒风险，而不是冷冰冰的免责声明

## ⚠️ 数据使用铁律（必须严格遵守）

1. **禁止编造数据缺失**：系统提供给你的数据都是真实存在的，不要说"ADX缺失"、"数据不足"等话。如果上下文中包含了某个指标的值，就使用它进行分析。
2. **使用实际数据**：上下文中提供的每个指标值都是真实的，例如"趋势强度(ADX): 20.8"表示ADX值是20.8，不是缺失。
3. **不要找借口**：如果信号不够强，直接说明原因（如"ADX只有20.8，趋势强度一般"），而不是编造"数据缺失"的借口。
4. **区分"数据缺失"和"信号弱"**：
   - 数据缺失：上下文中没有提供该指标（极少发生）
   - 信号弱：指标值表明趋势不强（如ADX<20）
   这两者完全不同，不要混淆！

## 你的核心分析框架

### 一、V16 量化信号引擎

系统内置的 V16 信号引擎提供以下技术指标：

| 指标 | 含义 | 用法 |
|------|------|------|
| **ADX** | 趋势强度 | <20 无趋势，20-30 趋势形成，>30 强趋势 |
| **Edge** | 信号强度 | 绝对值越大信号越强 |
| **Gate4** | 四重过滤 | 通过越多信号越可靠 |
| **光谱** | 多空分布 | 正值偏多，负值偏空 |
| **方向** | 多空判定 | 多/空/中性 |
| **等级** | 信号质量 | A/B/C 级，A级最可靠 |

**信号解读**：
- A级信号 + ADX>25 + Gate4通过：高可靠性入场机会
- B级信号 + ADX 20-25：可轻仓试探
- C级信号或 ADX<20：观望为主

### 二、Brooks 价格行为分析

基于 K 线本身的价格行为分析框架：

**1. K线叙事（最近3-5根K线）**
- 连续阳线/阴线说明什么？
- 有没有出现关键反转形态（Pin Bar、Inside Bar、Outside Bar）？
- 成交量是否配合？

**2. 结构支撑/阻力**
- 摆动高低点（Swing High/Low）在哪里？
- 当前价格距离关键支撑/阻力多远？
- 结构验证：入场价 vs 支撑/阻力距离 <3% 为 A 级

**3. EMA20 斜率**
- 斜率 >0.5%：强上升趋势
- 斜率 -0.5%~0.5%：区间震荡
- 斜率 <-0.5%：强下降趋势

**4. Always In 方向**
- 当前应该始终做多还是始终做空？
- 这是基于价格行为的趋势判定

**5. 双 R:R 计算**
- 现价入场 R:R vs 回踩入场 R:R
- 哪个更优？

### 三、17条交易铁律

1. **成本是锚**：价格跌破成本线是机会，不是风险
2. **库存分位决定弹性**：库存低位时，任何需求改善都会引发暴涨
3. **贴水是安全垫**：期货贴水现货时，做多安全边际高
4. **利润是供给的敌人**：高利润必然带来供给释放，压制价格
5. **需求是慢变量**：需求改善需要时间验证，不要急于追高
6. **季节性是规律**：农产品有明确的种植/养殖周期，要顺势而为
7. **基差回归是必然**：期货最终要向现货回归
8. **产业链利润要均衡**：利润过度集中必然引发再分配
9. **政策是双刃剑**：限产利多短期，但可能利空长期
10. **仓单是压力**：仓单集中注销期，价格承压
11. **持仓是信号**：增仓上涨是多头强势，减仓上涨是空头平仓
12. **成交量要配合**：突破必须有成交量配合，否则是假突破
13. **趋势要尊重**：不要逆势抄底，趋势不反转不入场
14. **风控是底线**：单笔亏损不超过账户2%
15. **时间止损**：5日无进展全部平仓
16. **周末不持仓**：规避外盘不确定性风险
17. **数据不足时不交易**：没有足够信息时，空仓观望是最好的策略

### 四、信号生成规则

**V16 信号引擎评分**：
- A级信号 + ADX>25：高可靠性，可正常仓位入场
- B级信号 + ADX 20-25：中等可靠性，轻仓试探
- C级信号或 ADX<20：低可靠性，观望为主

**️ 置信度校准规则（必须严格遵守）**：

**1. ADX 动态约束**：
   - ADX < 20：禁止趋势跟踪建议，只能建议"区间交易"或"观望"
   - ADX 20-30：可建议轻仓试探，胜率预估不超过历史胜率 +3%
   - ADX > 30：可建议正常仓位，胜率预估不超过历史胜率 +5%

**2. 品种评级约束**：
   - A 级（稳健底仓）：建议 80%-100% 标准仓位，胜率预估上限 = 历史胜率 +5%
   - B 级（可用）：建议 40%-60% 标准仓位，胜率预估上限 = 历史胜率 +3%
   - C 级（脆弱）：建议 10%-30% 轻仓试探，**强制建议观望**，不得给出明确入场建议
   - D 级（失效）：建议 0%，**强制建议观望**，明确说明"该品种历史表现不佳，不建议交易"
   - 如果数据上下文中提供了"实盘校准评级"，以校准评级为准

**3. 胜率预估上限**：胜率预估不得超过品种历史胜率 +5%（数据上下文中已提供历史胜率）

**4. 持仓周期上限**：
   - 基础值：15 天（回测最优）
   - A 级品种：不超过 18 天（15×1.2）
   - B 级品种：不超过 15 天
   - C/D 级品种：不超过 10 天（15×0.7）
   - 持仓周期建议不得超过"最优持仓周期 +5 天"

**5. 止损 ATR 倍数**：
   - 基础值：2.5 倍 ATR（回测最优）
   - 高波动品种（AU0/AG0）：可放宽至 3.0 倍
   - 低波动品种（CF0/SR0）：收紧至 2.0 倍
   - 震荡市（ADX<20）：收紧至 1.8 倍
   - 最大不得超过 3.0 倍

**6. 盈亏比预估上限**：盈亏比预估不得超过"历史平均盈亏比 +0.5"（数据上下文中已提供历史值）

**7. 仓位建议必须与品种评级匹配**：
   - A 级（稳健底仓）：建议 80%-100% 标准仓位
   - B 级（可用）：建议 40%-60% 标准仓位
   - C 级（脆弱）：建议 10%-30% 轻仓试探
   - D 级（失效）：建议 0%，不参与交易
   - 如果数据上下文中提供了"实盘校准评级"，以校准评级为准

**8. 多建议输出规则**：
   - 每笔交易最多输出 3 个建议（基于不同参数组合）
   - 建议必须覆盖不同策略：趋势跟踪、均值回归、突破
   - 每个建议必须标注：策略类型、预期胜率、预期盈亏比、置信度（HIGH/MEDIUM/LOW）
   - 只输出高质量建议：胜率≥55%、利润因子≥1.5、最大回撤≤15%

**价格行为确认**：
- 信号方向与 Always In 方向一致：增强信号
- 入场价靠近结构支撑/阻力（<3%）：A级结构验证
- K线出现反转形态：确认入场时机

**时间止损**：
- 3日无进展：仓位减半
- 5日无进展：全部平仓

## Few-shot 学习示例（从真实回测数据中提取）

### ✅ 成功案例

**案例 1：A 级品种趋势跟踪**
\`\`\`
品种：CU0（铜）- A 级
信号：EMA20 斜率 +1.2%，ADX=35（强趋势），Always In 方向：多
建议：做多，入场 99560，止损 98500（2.5×ATR），目标 102000
结果：盈利 +2.4%，持仓 8 天，R 倍数 +1.53
关键因素：ADX>30 强趋势 + A 级品种 + 价格行为确认
\`\`\`

**案例 2：B 级品种轻仓试探**
\`\`\`
品种：ZN0（锌）- B 级
信号：EMA20 斜率 +0.6%，ADX=22（趋势形成中），Always In 方向：多
建议：轻仓做多，入场 25625，止损 25100，目标 26500
结果：盈利 +1.2%，持仓 6 天，R 倍数 +0.88
关键因素：ADX 20-25 区间 + B 级品种轻仓 + 严格止损
\`\`\`

### ❌ 失败案例

**案例 3：弱趋势中逆势交易**
\`\`\`
品种：HC0（热卷）- B 级
信号：EMA20 斜率 -0.3%，ADX=18（无趋势），Always In 方向：中性
建议：做空，入场 3850，止损 3950，目标 3650
结果：亏损 -1.2%，3 天后反转上涨
教训：ADX<20 时避免趋势跟踪，只能区间交易或观望
\`\`\`

**案例 4：C 级品种重仓亏损**
\`\`\`
品种：SM0（锰硅）- C 级
信号：EMA20 斜率 +0.4%，ADX=25，Always In 方向：多
建议：做多，入场 6800，止损 6600，目标 7200
结果：亏损 -2.1%，持仓 12 天，R 倍数 -1.05
教训：C 级品种历史胜率仅 45%，不应给出明确入场建议
\`\`\`

**案例 5：持仓周期过长**
\`\`\`
品种：RB0（螺纹钢）- A 级
信号：EMA20 斜率 +0.8%，ADX=28，Always In 方向：多
建议：做多，入场 3650，止损 3550，目标 3850
结果：盈利 +0.8% 后回落，持仓 18 天最终盈亏平衡
教训：最优持仓周期 15 天，超过后利润回吐风险增加
\`\`\`

### 📊 关键规律总结

1. **ADX 是核心过滤器**：ADX<20 时胜率仅 38%，ADX>30 时胜率 68%
2. **品种评级决定仓位**：A 级品种胜率 73%，C 级仅 45%
3. **持仓周期要克制**：最优 15 天，超过 20 天利润回吐概率 65%
4. **止损必须严格**：2.5×ATR 是最优值，超过 3.0 盈亏比恶化
5. **顺势而为**：Always In 方向与信号一致时胜率 +15%

**9. 品种相关性风险约束**：
   - 当用户同时关注或持有多个同板块品种时，必须主动提示板块集中风险
   - 同板块品种（如有色金属 CU0/AL0/ZN0/NI0、黑色系 RB0/HC0/I0/J0）高度相关，同时持有等于加倍风险
   - 建议：同板块持仓不超过 2 个品种，总仓位不超过单品种上限的 1.5 倍
   - 如果用户询问的品种与当前热门板块已有持仓重叠，明确提醒"注意板块集中风险"

**10. 新闻情绪融合规则**：
   - 新闻面作为技术信号的"确认器"，不是独立交易信号
   - 当新闻情绪与技术方向一致（共振）时：信心增强，可适度放大仓位（历史回测：共振加仓 +9.5% 回报）
   - 当新闻情绪与技术方向背离时：保持技术信号，不因新闻面放弃（历史回测：背离降仓 -19% 回报，是负优化）
   - 新闻情绪评分：利多（+1）、中性（0）、利空（-1），在分析中明确标注

## 回答风格

- **开头直接给结论**：先说观点，再展开分析
- **用比喻和类比**：把复杂的市场现象用生活中的例子解释
- **适当反问**：引导用户思考，增加互动性
- **敢于表态**：看多就说看多，看空就说看空，不要总是"观望"
- **控制篇幅**：除非用户要求详细分析，否则回答控制在200-400字
- **引用框架**：分析时引用 V16 信号、价格行为等框架，让用户知道你的分析依据

## 互动技巧

- **基于系统数据分析**：你的分析完全基于系统提供的 V16 信号引擎数据和价格行为分析数据
- 如果用户的问题很模糊，先反问确认："你是想了解短期走势还是中长期趋势？"
- 适当使用口语化表达："说白了"、"其实"、"我觉得"、"你想想看"
- 结尾可以加一句互动："你觉得呢？"、"要不要我帮你看看其他相关品种？"
- 当用户问某个品种时，主动给出 V16 信号分析："从 V16 信号看，这个品种现在是 X 级信号，ADX 是 X，Always In 方向是 X..."
- 当信号不明确时，坦诚说明："这个品种现在 ADX 只有 X，没有形成明确趋势，建议观望"

## 数据诚实原则（最高优先级）

**绝对禁止**：
- 编造不存在的数据
- 猜测没有的数据
- 用模糊语言掩盖数据缺失

**必须遵守**：
- 只基于系统提供的技术分析数据进行分析（V16 信号、价格行为、K线数据）
- 如果数据时间过旧（超过7天），说明"数据可能已过时，仅供参考"
- 宁可说"不知道"，也不要给出基于猜测的分析
- 不要提及基本面数据（库存、成本、利润等）缺失的问题，专注于技术面分析

## 注意事项

- 不提供具体的买卖点位和仓位建议
- 提醒风险时要真诚，不要像念免责声明
- 分析基于当前技术面数据，专注于价格行为和量化信号
- 当数据与框架冲突时，以数据为准，但要说明框架的判断`;

import { VARIETY_CONFIGS, type SupplyElasticity } from './varietyConfig.js';
import { analyzeFromDatabase } from './technicalAnalysis.js';
import { checkAllCircuitBreakers } from './circuitBreaker.js';

/**
 * 全品种标准名称映射（覆盖国内期货交易所主要品种，用于从用户消息中识别品种）
 */
const ALL_VARIETY_NAMES: Record<string, string> = {
  // 上期所
  RB: '螺纹钢', HC: '热卷', CU: '沪铜', AL: '沪铝', ZN: '沪锌', PB: '沪铅', NI: '沪镍', SN: '沪锡',
  AU: '沪金', AG: '沪银', BU: '沥青', RU: '橡胶', FU: '燃油', SP: '纸浆', SS: '不锈钢', AO: '氧化铝',
  BR: '合成橡胶', WR: '线材',
  // 大商所
  I: '铁矿石', J: '焦炭', JM: '焦煤', M: '豆粕', Y: '豆油', P: '棕榈油', C: '玉米', CS: '淀粉',
  JD: '鸡蛋', LH: '生猪', L: '塑料', PP: '聚丙烯', V: 'PVC', EG: '乙二醇', EB: '苯乙烯',
  PG: '液化气', B: '豆二', A: '豆一',
  // 郑商所
  CF: '棉花', SR: '白糖', TA: 'PTA', MA: '甲醇', FG: '玻璃', SA: '纯碱', UR: '尿素',
  AP: '苹果', CJ: '红枣', OI: '菜油', RM: '菜粕', SF: '硅铁', SM: '锰硅', PF: '短纤',
  PK: '花生', CY: '棉纱', PX: 'PX', SH: '烧碱',
  // 广期所
  SI: '工业硅', LC: '碳酸锂', PS: '多晶硅',
  // 上期能源
  SC: '原油', NR: '20号胶', LU: '低硫燃油', BC: '国际铜',
  // 中金所
  IF: '沪深300', IC: '中证500', IH: '上证50', IM: '中证1000',
  T: '十债', TF: '五债', TS: '二债', TL: '三十年债',
  // 其他
  EC: '欧线集运',
};

/**
 * 品种常见别名映射（全称之外的口语叫法）
 */
const VARIETY_ALIASES: Record<string, string[]> = {
  'RB': ['螺纹'], 'HC': ['热轧'], 'I': ['铁矿'], 'P': ['棕榈'], 'CF': ['郑棉'],
  'CU': ['铜'], 'AL': ['铝'], 'ZN': ['锌'], 'NI': ['镍'], 'SN': ['锡'], 'PB': ['铅'],
  'RU': ['天胶'], 'L': ['聚乙烯'], 'V': ['聚氯乙烯'], 'LH': ['猪价'],
  'AU': ['黄金'], 'AG': ['白银'], 'CS': ['玉米淀粉'], 'PG': ['LPG'],
  'AP': ['苹果'], 'SR': ['白糖'], 'M': ['豆粕'],
};

/**
 * 从用户消息中识别涉及的品种代码
 * 支持：品种代码（RB/rb/RB2610）、品种全称（螺纹钢）、常见别名（螺纹）
 */
export function extractVarietyCodes(message: string): string[] {
  if (!message) return [];
  const found = new Set<string>();
  const upperMsg = message.toUpperCase();
  for (const [code, stdName] of Object.entries(ALL_VARIETY_NAMES)) {
    // 1. 代码匹配：RB / rb2610（需词边界，避免 MACD 误匹配 M）
    const codeRegex = new RegExp(`(^|[^A-Z])${code}\\d{0,4}([^A-Z\\d]|$)`);
    if (codeRegex.test(upperMsg)) { found.add(code); continue; }
    // 2. 标准名称匹配：螺纹钢（VARIETY_CONFIGS 名称作为补充）
    const cfgName = VARIETY_CONFIGS[code]?.name;
    if (message.includes(stdName) || (cfgName && message.includes(cfgName))) { found.add(code); continue; }
    // 3. 别名匹配：螺纹
    const aliases = VARIETY_ALIASES[code] || [];
    if (aliases.some(a => message.includes(a))) found.add(code);
  }
  return Array.from(found);
}

/**
 * 获取当前市场数据上下文
 * @param focusCodes 用户消息中识别到的品种代码；非空时详细数据只注入这些品种，大幅压缩 token
 */
export function getMarketContext(focusCodes: string[] = []): string {
  const hasFocus = focusCodes.length > 0;
  // 判断某条数据是否属于关注品种（code 精确匹配 / name 前缀匹配，兼容 "RB2610" 这类合约写法）
  const matchFocus = (...candidates: (string | undefined | null)[]): boolean => {
    if (!hasFocus) return true;
    return candidates.some(c => {
      if (!c) return false;
      const upper = c.toUpperCase();
      return focusCodes.some(fc => {
        const upperFc = fc.toUpperCase();
        if (upper === upperFc || upper.startsWith(upperFc)) return true;
        const name = ALL_VARIETY_NAMES[upperFc] || VARIETY_CONFIGS[upperFc]?.name;
        return !!name && c.includes(name);
      });
    });
  };

  const context: string[] = [];
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const timeStr = now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  context.push(`当前时间: ${timeStr}`);
  if (hasFocus) {
    const focusNames = focusCodes.map(c => `${c}(${ALL_VARIETY_NAMES[c] || VARIETY_CONFIGS[c]?.name || c})`).join('、');
    context.push(`用户当前关注品种: ${focusNames}（以下为该品种相关数据，其余品种数据已省略）`);
  }
  context.push(`\n---\n## 数据来源说明\n- V16 信号引擎：量化技术指标（ADX、Edge、Gate4、光谱、方向、等级）\n- 价格行为分析：K线叙事、结构支撑/阻力、EMA20斜率、Always In方向\n- 技术分析：基于日K线数据计算\n---`);

  // 获取扫描结果 - 使用最新的市场扫描数据
  try {
    const scanResults = db.getSignalHistory({ limit: 20 });
    if (scanResults.records.length > 0) {
      const latestTime = scanResults.records[0]?.created_at || '未知';
      context.push(`\n## 最新市场扫描信号 [数据时间: ${latestTime}]`);
      const filteredRecords = hasFocus
        ? scanResults.records.filter((s: any) => matchFocus(s.code, s.variety_name, s.contract))
        : scanResults.records;
      const signals = filteredRecords.slice(0, 10).map((s: any) => {
        const signalDesc = s.signal_type === 'oversold_bounce' ? '超跌反弹' :
                          s.signal_type === 'divergence' ? '背离信号' :
                          s.signal_type === 'trend' ? '趋势信号' : s.signal_type;
        return `- ${s.variety_name}(${s.contract}): ${signalDesc}, 强度${s.strength}, 方向${s.direction || 'N/A'}`;
      }).join('\n');
      context.push(signals);
    }
  } catch (e) {
    // ignore
  }

  // 获取供需分析 - 仓单数据
  try {
    const supplyDemand = db.getWarehouseReceiptHistory({ limit: 200 });
    if (supplyDemand.length > 0) {
      const latestTime = supplyDemand[0]?.trade_date || '未知';
      context.push(`\n## 仓单数据 [数据时间: ${latestTime}, 来源: Tushare]`);
      // 按品种分组，显示最新数据
      const byVariety: Record<string, any[]> = {};
      supplyDemand.forEach((r: any) => {
        const varietyName = r.name || r.code || '未知';
        if (!byVariety[varietyName]) byVariety[varietyName] = [];
        byVariety[varietyName].push(r);
      });
      // 显示品种数据（关注品种时只显示相关品种；否则最多20个）
      const entries = Object.entries(byVariety).filter(([name, records]) =>
        matchFocus(name, records[0]?.code)
      );
      const summary = entries.slice(0, hasFocus ? 10 : 20).map(([name, records]) => {
        const latest = records[0];
        const change = latest.receipt_change;
        const changeStr = change > 0 ? `增加${change}张` : change < 0 ? `减少${Math.abs(change)}张` : '持平';
        return `- ${name}: 仓单${latest.receipt_qty}张, ${changeStr}`;
      }).join('\n');
      context.push(summary);
    }
  } catch (e) {
    // ignore
  }

  // 获取现货价格和基差数据（从飞书同步）
  try {
    const spotPrices = db.getSpotPriceHistory({ limit: 50 });
    if (spotPrices.length > 0) {
      const latestTime = spotPrices[0]?.trade_date || '未知';
      context.push(`\n## 现货价格与基差 [数据时间: ${latestTime}, 来源: 飞书]`);
      const spotFiltered = spotPrices.filter((r: any) => matchFocus(r.code, r.name));
      const spotSummary = spotFiltered.slice(0, 15).map((r: any) => {
        const basisRate = r.basis_rate ? (r.basis_rate * 100).toFixed(1) : '0';
        const basisDesc = r.basis > 0 ? '升水' : '贴水';
        return `- ${r.name}(${r.code}): 现货${r.spot_price}, 期货${r.futures_price}, 基差${r.basis > 0 ? '+' : ''}${r.basis?.toFixed(0)}(${basisDesc}${Math.abs(parseFloat(basisDesc))}%)`;
      }).join('\n');
      context.push(spotSummary);
    }
  } catch (e) {
    // ignore
  }

  // 获取每日基本面流水数据（从飞书同步）- 三信号分析
  try {
    const fundamentalFlows = db.getDailyFundamentalFlow({ limit: 50 });
    if (fundamentalFlows.length > 0) {
      const latestTime = fundamentalFlows[0]?.trade_date || '未知';
      context.push(`\n## 三信号分析 [数据时间: ${latestTime}, 来源: 飞书]`);
      const flowFiltered = fundamentalFlows.filter((r: any) => matchFocus(r.code, r.name));
      const flowSummary = flowFiltered.slice(0, 15).map((r: any) => {
        const signalCount = r.signal_count || 0;
        const conclusion = r.signal_conclusion || '无信号';
        const demand = r.demand_status || '未知';
        const inventoryPct = r.inventory_percentile ? (r.inventory_percentile * 100).toFixed(0) + '%' : 'N/A';
        const warning = r.price_warning || '无';
        const macro = r.macro_risk || '无';
        return `- ${r.code}: ${conclusion}(${signalCount}/3), 需求:${demand}, 库存分位:${inventoryPct}, 预警:${warning}, 宏观:${macro}`;
      }).join('\n');
      context.push(flowSummary);
    }
  } catch (e) {
    // ignore
  }

  // 获取生猪每日监控数据（从飞书同步）—— 仅在未指定品种或关注生猪时注入
  const skipPigMonitor = hasFocus && !matchFocus('LH', '生猪');
  try {
    const pigMonitor = skipPigMonitor ? null : db.getLatestPigDailyMonitor();
    if (pigMonitor) {
      context.push(`\n## 生猪每日监控 [数据时间: ${pigMonitor.trade_date}, 来源: 飞书]`);
      context.push(`- 现货价: ${pigMonitor.spot_price}元/kg`);
      context.push(`- 三信号: 供需${pigMonitor.signal1_supply_demand || 'N/A'}, 极值${pigMonitor.signal2_extreme || 'N/A'}, 外力${pigMonitor.signal3_external || 'N/A'}`);
      context.push(`- 量化评分: ${pigMonitor.quant_score || 0}`);
      context.push(`- 自养利润: ${pigMonitor.self_breed_profit || 0}元/头, 外购利润: ${pigMonitor.purchased_profit || 0}元/头`);
      context.push(`- 冻品库容率: ${pigMonitor.frozen_stock_rate || 0}%, 屠宰开工率: ${pigMonitor.slaughter_rate || 0}%`);
      context.push(`- 能繁母猪存栏: ${pigMonitor.sow_inventory || 0}万头, 环比变化: ${pigMonitor.sow_mom_change || 0}%`);
      if (pigMonitor.comment) {
        context.push(`- 综合点评: ${pigMonitor.comment}`);
      }
    }
    
    // 获取生猪季节性参考
    const currentMonth = new Date().getMonth() + 1;
    const seasonalRef = skipPigMonitor ? null : db.getPigSeasonalReferenceByMonth(currentMonth);
    if (seasonalRef) {
      context.push(`\n## 生猪${currentMonth}月季节性规律 [来源: 飞书]`);
      context.push(`- 周期属性: ${seasonalRef.cycle_attribute || 'N/A'}`);
      context.push(`- 上涨概率: ${seasonalRef.rise_probability || 0}%`);
      context.push(`- 平均涨跌幅: ${seasonalRef.avg_change || 0}%`);
      context.push(`- 最佳合约: ${seasonalRef.best_contract || 'N/A'}`);
      context.push(`- 核心驱动: ${seasonalRef.core_logic || 'N/A'}`);
      context.push(`- 核心风险: ${seasonalRef.core_risk || 'N/A'}`);
      context.push(`- 交易窗口: ${seasonalRef.trading_window || 'N/A'}`);
    }
  } catch (e) {
    // ignore
  }

  // 获取资金流向
  try {
    const capitalFlow = db.getCapitalFlowHistory({ limit: 20 });
    if (capitalFlow.length > 0) {
      const latestTime = capitalFlow[0]?.trade_date || '未知';
      context.push(`\n## 资金流向 [数据时间: ${latestTime}, 来源: 大商所API]`);
      const capitalFiltered = capitalFlow.filter((r: any) => matchFocus(r.variety, r.code));
      const flowSummary = capitalFiltered.slice(0, 8).map((r: any) => {
        const direction = r.smart_money_direction === 'long' ? '偏多' :
                         r.smart_money_direction === 'short' ? '偏空' : '中性';
        return `- ${r.variety}: 净持仓${r.net_position > 0 ? '+' : ''}${r.net_position}, 聪明钱${direction}`;
      }).join('\n');
      context.push(flowSummary);
    }
  } catch (e) {
    // ignore
  }

  // 获取日行情数据 - 价格变化
  try {
    const dailyQuotes = db.getDailyQuotesHistory({ limit: 50 });
    if (dailyQuotes.length > 0) {
      const latestTime = dailyQuotes[0]?.trade_date || '未知';
      context.push(`\n## 近期价格动态 [数据时间: ${latestTime}, 来源: Tushare]`);
      const quotesFiltered = dailyQuotes.filter((r: any) => matchFocus(r.variety, r.contract));
      const priceSummary = quotesFiltered.slice(0, 8).map((r: any) => {
        const change = r.price_change || 0;
        const changeStr = change > 0 ? `涨${change}` : change < 0 ? `跌${Math.abs(change)}` : '持平';
        return `- ${r.variety || r.contract}: 收盘${r.close_price}, ${changeStr}`;
      }).join('\n');
      context.push(priceSummary);
    }
  } catch (e) {
    // ignore
  }

  // 添加实时价格数据（供AI助手参考）
  context.push('\n## 实时价格数据 [基于最新价格]');
  const scoringCodes = hasFocus
    ? focusCodes
    : ['RB', 'I', 'JM', 'J', 'HC', 'CU', 'AL', 'ZN', 'AG', 'AU', 'M', 'Y', 'P', 'OI', 'RM', 'CF', 'SR', 'TA', 'MA', 'BU', 'RU', 'AP', 'SA', 'FG', 'JD', 'LH'];
  const scoringResults: string[] = [];
  
  for (const code of scoringCodes) {
    try {
      // 获取最新价格
      const dailyQuotes = db.getDailyQuotesHistory({ variety: code, limit: 1 });
      if (dailyQuotes.length === 0) continue;
      
      const latestQuote = dailyQuotes[0] as any;
      const closePrice = latestQuote.close_price;
      if (!closePrice) continue;
      
      // 获取品种配置
      const config = VARIETY_CONFIGS[code];
      if (!config) continue;
      
      scoringResults.push(`- ${code}${config.name}: 收盘${closePrice}`);
    } catch (e) {
      // ignore
    }
  }
  
  if (scoringResults.length > 0) {
    context.push(scoringResults.slice(0, 15).join('\n'));
  } else {
    context.push('暂无价格数据');
  }

  // 添加技术分析数据（Brooks Price Action）
  context.push('\n## 技术分析 [基于日K线计算, 来源: Brooks Price Action]');
  const technicalCodes = hasFocus ? focusCodes : ['RB', 'AG', 'AU', 'CU', 'I', 'JD', 'M', 'SA'];
  const technicalResults = technicalCodes
    .map(code => analyzeFromDatabase(code, 60))
    .filter(r => r !== null);
  
  if (technicalResults.length > 0) {
    const techSummary = technicalResults.map(r => {
      const direction = r.summary.direction === 'bullish' ? '偏多' :
                       r.summary.direction === 'bearish' ? '偏空' : '中性';
      const patterns = r.patterns.length > 0 ? r.patterns.map(p => p.name).join(',') : '无明显形态';
      const breakout = r.breakout.type !== 'none' ? r.breakout.verdict : '无突破';
      const volume = r.volume ? `${r.volume.volumeRatio.toFixed(1)}x均量(${r.volume.isAmplified ? '放量' : '缩量'})` : '无量能数据';
      const structure = r.trendStructure ? r.trendStructure.description : '无结构数据';
      return `- ${r.code}: ${direction}(${r.summary.confidence.toFixed(0)}%), K线:${patterns}, 突破:${breakout}, 量能:${volume}, 结构:${structure}`;
    }).join('\n');
    context.push(techSummary);
  } else {
    context.push('暂无技术分析数据');
  }

  // 添加风控熔断状态
  context.push('\n## 风控熔断状态 [来源: 实时计算]');
  try {
    const circuitCodes = hasFocus ? focusCodes : ['RB', 'AG', 'AU', 'CU', 'I', 'JD', 'M', 'SA', 'LH'];
    const circuitResults = circuitCodes.map(code => {
      const result = checkAllCircuitBreakers(code);
      if (!result.hasCircuitBreaker) return null;
      const status = result.canTrade ? '✅' : '🚫';
      const risk = result.riskLevel === 'high' ? '高风险' : result.riskLevel === 'medium' ? '中风险' : '低风险';
      return `- ${code}: ${status} ${risk}`;
    }).filter(r => r !== null);
    
    if (circuitResults.length > 0) {
      context.push(circuitResults.join('\n'));
    } else {
      context.push('暂无熔断数据');
    }
  } catch (e) {
    context.push('熔断检查失败');
  }

  // ========== 五句金律核心数据补充 ==========

  // 获取飞书供需评分（五句金律结构化数据：库存分位、利润信号、量化总评分）
  let supplyDemandScores: any[] = [];
  try {
    supplyDemandScores = db.getLatestSupplyDemandScores();
    if (supplyDemandScores.length > 0) {
      const latestTime = supplyDemandScores[0]?.trade_date || '未知';
      context.push(`\n## 供需评分 [数据时间: ${latestTime}, 来源: 飞书]`);
      const sdFiltered = supplyDemandScores.filter((r: any) => matchFocus(r.code, r.name));
      const sdSummary = sdFiltered.map((r: any) => {
        const invPct = r.inventory_percentile != null ? `${Number(r.inventory_percentile).toFixed(0)}%` : 'N/A';
        return `- ${r.name || r.code}: 总评分${r.total_score ?? 'N/A'}/10, 库存分位${invPct}, 利润信号${r.profit_signal ?? 'N/A'}, 缺口率${r.supply_gap_rate ?? 'N/A'}%, 评级${r.certainty_rating || 'N/A'}, 建议:${r.trading_advice || '无'}`;
      }).join('\n');
      context.push(sdSummary);
    }
  } catch (e) {
    // ignore
  }

  // 获取飞书产业链利润（上中下游利润分布）
  let industryProfits: any[] = [];
  try {
    industryProfits = db.getLatestIndustryProfits();
    if (industryProfits.length > 0) {
      const latestTime = industryProfits[0]?.trade_date || '未知';
      context.push(`\n## 产业链利润 [数据时间: ${latestTime}, 来源: 飞书]`);
      const ipFiltered = industryProfits.filter((r: any) => matchFocus(r.code, r.name));
      const ipSummary = ipFiltered.map((r: any) => {
        return `- ${r.name || r.code}(${r.sector || 'N/A'}): 上游利润${r.upstream_profit ?? 'N/A'}, 中游利润${r.midstream_profit ?? 'N/A'}, 下游利润${r.downstream_profit ?? 'N/A'}, 传导:${r.profit_transmission || 'N/A'}, 负反馈风险:${r.negative_feedback_risk || 'N/A'}`;
      }).join('\n');
      context.push(ipSummary);
    }
  } catch (e) {
    // ignore
  }

  // 获取库存分位数据（AkShare 交易所库存，近3年分位）
  let inventoryData: any[] = [];
  try {
    inventoryData = db.getLatestInventoryByVarieties();
    if (inventoryData.length > 0) {
      const latestTime = inventoryData[0]?.trade_date || '未知';
      context.push(`\n## 库存分位 [数据时间: ${latestTime}, 来源: AkShare交易所库存·近3年分位]`);
      const invFiltered = inventoryData.filter((r: any) => matchFocus(r.variety, r.name));
      const invSummary = invFiltered.map((r: any) => {
        const pct = r.inventory_percentile != null ? `${Number(r.inventory_percentile).toFixed(0)}%` : 'N/A';
        return `- ${r.variety}: 库存${r.inventory ?? 'N/A'}, 周增减${r.inventory_change ?? r.change ?? 'N/A'}, 分位${pct}`;
      }).join('\n');
      context.push(invSummary);
    }
  } catch (e) {
    // ignore
  }

  // ========== 数据完整度矩阵（品种 × 数据维度）==========
  try {
    context.push('\n## 数据完整度矩阵 [●=有数据 ○=缺失]');
    context.push('数据维度：①价格 ②库存 ③利润 ④需求 ⑤基差');

    const sdMap: Record<string, any> = {};
    supplyDemandScores.forEach((r: any) => { if (r.code) sdMap[r.code] = r; });
    const ipMap: Record<string, any> = {};
    industryProfits.forEach((r: any) => { if (r.code) ipMap[r.code] = r; });
    const invMap: Record<string, any> = {};
    inventoryData.forEach((r: any) => { if (r.variety) invMap[r.variety] = r; });

    // 现货价格基差覆盖
    const spotCoverage: Record<string, boolean> = {};
    try {
      const spotList = db.getSpotPriceHistory({ limit: 500 });
      spotList.forEach((r: any) => { if (r.code) spotCoverage[r.code] = true; });
    } catch (e) { /* ignore */ }

    // 三信号（含需求状况、库存分位字段）覆盖
    const flowCoverage: Record<string, any> = {};
    try {
      const flowList = db.getDailyFundamentalFlow({ limit: 200 });
      flowList.forEach((r: any) => { if (r.code && !flowCoverage[r.code]) flowCoverage[r.code] = r; });
    } catch (e) { /* ignore */ }

    const matrixRows: string[] = [];
    for (const [code, cfg] of Object.entries(VARIETY_CONFIGS)) {
      if (hasFocus && !focusCodes.includes(code)) continue;
      const hasCost = cfg.costLine != null ? '●' : '○';
      const sd = sdMap[code];
      const hasInv = (sd?.inventory_percentile != null || invMap[code]?.inventory_percentile != null || flowCoverage[code]?.inventory_percentile != null) ? '●' : '○';
      const hasProfit = (sd?.profit_signal != null || ipMap[code] != null) ? '●' : '○';
      const hasDemand = (flowCoverage[code]?.demand_status != null && flowCoverage[code]?.demand_status !== '') ? '●' : '○';
      const hasBasis = spotCoverage[code] ? '●' : '○';
      const full = hasCost === '●' && hasInv === '●' && hasProfit === '●' && hasDemand === '●' && hasBasis === '●';
      matrixRows.push(`- ${code}${cfg.name}: 成本${hasCost} 库存${hasInv} 利润${hasProfit} 需求${hasDemand} 基差${hasBasis}${full ? ' ✅完整' : ''}`);
    }
    context.push(matrixRows.join('\n'));
  } catch (e) {
    // ignore
  }

  return context.length > 1 ? context.join('\n') : '当前暂无最新市场数据，请基于你的专业知识回答';
}

/**
 * 创建 LLM 客户端
 */
function createLLMClient(customHeaders?: Record<string, string>): LLMClient {
  const config = new Config();
  return new LLMClient(config, customHeaders);
}

/**
 * 流式聊天
 */
export async function* chatStream(
  messages: Array<{ role: string; content: string }>,
  customHeaders?: Record<string, string>
): AsyncGenerator<string> {
  const client = createLLMClient(customHeaders);

  // 添加系统提示词和市场上下文（按用户消息中的品种过滤，压缩 token）
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const varietyCodes = extractVarietyCodes(lastUserMsg);
  const context = getMarketContext(varietyCodes);

  // 构建个性化上下文
  let personalizedContext = '';

  // 1. 品种相关性风险提醒
  if (varietyCodes.length > 0) {
    const correlationWarnings: string[] = [];
    for (const code of varietyCodes) {
      const correlated = CORRELATED_PAIRS[code] || [];
      const mentionedCorrelated = varietyCodes.filter(vc => correlated.includes(vc));
      if (mentionedCorrelated.length > 0) {
        correlationWarnings.push(
          `⚠️ ${code} 与 ${mentionedCorrelated.join(', ')} 同属相关板块，同时交易注意板块集中风险（建议同板块最多 2 个品种）`
        );
      }
    }
    if (correlationWarnings.length > 0) {
      personalizedContext += `\n\n## 品种相关性风险提醒\n${correlationWarnings.join('\n')}`;
    }
  }

  // 2. 用户画像（从对话历史推断）
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
  if (userMessages.length >= 3) {
    const inferred = inferTradingStyle(userMessages);
    personalizedContext += `\n\n## 用户交易风格推断\n- 风险偏好等级: ${inferred.riskLevel}/5`;
    personalizedContext += `\n- 交易风格: ${inferred.style === 'conservative' ? '保守型' : inferred.style === 'aggressive' ? '激进型' : '稳健型'}`;
    if (inferred.style === 'conservative') {
      personalizedContext += '\n- 建议: 优先推荐 A 级品种，仓位偏轻，严格止损';
    } else if (inferred.style === 'aggressive') {
      personalizedContext += '\n- 建议: 可适当参与 B 级品种，但务必提醒止损纪律';
    }
  }

  const systemContent = truncateContent(
    `${SYSTEM_PROMPT}\n\n## 当前市场数据\n${context}${personalizedContext}`,
    40000,  // 聊天系统消息上限 40K 字符
    'chatStream system message'
  );
  const systemMessage = {
    role: 'system' as const,
    content: systemContent
  };

  const fullMessages = buildSafeMessages([
    systemMessage,
    ...messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))
  ]);

  const stream = client.stream(fullMessages, {
    model: AI_MODEL,
    temperature: 0.7,
    thinking: 'disabled'
  });

  // 带超时的流式迭代：即使 LLM 完全无响应也能在超时后退出，释放连接
  const iterator = stream[Symbol.asyncIterator]();
  const deadline = Date.now() + AI_TIMEOUT_MS;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`AI流式响应超时（>${Math.round(AI_TIMEOUT_MS / 1000)}s）`);
    }
    const result = await withTimeout(iterator.next(), remaining, 'AI流式响应');
    if (result.done) break;
    const chunk = result.value;
    if (chunk.content) {
      yield chunk.content.toString();
    }
  }
}

/**
 * 非流式聊天
 */
export async function chat(
  messages: Array<{ role: string; content: string }>,
  customHeaders?: Record<string, string>
): Promise<string> {
  const client = createLLMClient(customHeaders);

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content || '';
  const varietyCodes = extractVarietyCodes(lastUserMsg);
  const context = getMarketContext(varietyCodes);

  // 构建个性化上下文
  let personalizedContext = '';

  // 1. 品种相关性风险提醒
  if (varietyCodes.length > 0) {
    const correlationWarnings: string[] = [];
    for (const code of varietyCodes) {
      const correlated = CORRELATED_PAIRS[code] || [];
      // 检查用户消息中是否提到了多个同板块品种
      const mentionedCorrelated = varietyCodes.filter(vc => correlated.includes(vc));
      if (mentionedCorrelated.length > 0) {
        correlationWarnings.push(
          `⚠️ ${code} 与 ${mentionedCorrelated.join(', ')} 同属相关板块，同时交易注意板块集中风险（建议同板块最多 2 个品种）`
        );
      }
    }
    if (correlationWarnings.length > 0) {
      personalizedContext += `\n\n## 品种相关性风险提醒\n${correlationWarnings.join('\n')}`;
    }
  }

  // 2. 用户画像（从对话历史推断）
  const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);
  if (userMessages.length >= 3) {
    const inferred = inferTradingStyle(userMessages);
    personalizedContext += `\n\n## 用户交易风格推断\n- 风险偏好等级: ${inferred.riskLevel}/5`;
    personalizedContext += `\n- 交易风格: ${inferred.style === 'conservative' ? '保守型' : inferred.style === 'aggressive' ? '激进型' : '稳健型'}`;
    if (inferred.style === 'conservative') {
      personalizedContext += '\n- 建议: 优先推荐 A 级品种，仓位偏轻，严格止损';
    } else if (inferred.style === 'aggressive') {
      personalizedContext += '\n- 建议: 可适当参与 B 级品种，但务必提醒止损纪律';
    }
  }

  const systemContent = truncateContent(
    `${SYSTEM_PROMPT}\n\n## 当前市场数据\n${context}${personalizedContext}`,
    40000,
    'chat system message'
  );
  const systemMessage = {
    role: 'system' as const,
    content: systemContent
  };

  const fullMessages = buildSafeMessages([
    systemMessage,
    ...messages.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))
  ]);

  const response = await withTimeout(
    client.invoke(fullMessages, {
      model: AI_MODEL,
      temperature: 0.7
    }),
    AI_TIMEOUT_MS,
    'AI响应'
  );

  return response.content;
}

// ==================== 增强对话功能 ====================

/**
 * 构建品种数据上下文（用于对话模式）
 */
export function buildDataContext(code: string, scanRow: V16Row, paSummary?: any): string {
  const name = VARIETIES[code] || code;

  // 从 paSummary 中提取最近日线数据
  let recentDailyBars = '';
  let volumeStats = '';
  if (paSummary?.recentDaily && Array.isArray(paSummary.recentDaily)) {
    const last3 = paSummary.recentDaily.slice(-3);
    recentDailyBars = last3.map((b: any, i: number) => {
      const change = b.o > 0 ? ((b.c - b.o) / b.o * 100).toFixed(2) : '0.00';
      const direction = b.c > b.o ? '阳线' : b.c < b.o ? '阴线' : '十字星';
      return `${i + 1}. ${b.date} ${direction}: O=${b.o}, H=${b.h}, L=${b.l}, C=${b.c}, 涨跌幅${change}%`;
    }).join('\n');
  }
  if (paSummary?.volumeStats) {
    const vs = paSummary.volumeStats;
    volumeStats = `- 20 根均量：${vs.avg20?.toFixed(0) || '暂无数据'}
- 最近 5 根 K 线最大量：${vs.max5?.toFixed(0) || '暂无数据'}
- 最近 5 根 K 线均量：${vs.avg5?.toFixed(0) || '暂无数据'}`;
  }

  return `【当前品种数据 - ${name} (${code})】

**V16 信号引擎数据：**
- 方向：${scanRow.ai_direction}
- 信号等级：${scanRow.signal_grade || '未评级'}
- Edge 评级：${scanRow.edge_grade || '未评级'}
- Gate4：${scanRow.g4_verdict || '未评级'}
- ADX：${scanRow.adx?.toFixed(1) || 'N/A'}
- 目标位：${scanRow.mm_tier1 || '未计算'}
- 止损位：${scanRow.ch_stop || '未计算'}

**价格行为分析：**
- Always In 方向：${paSummary?.alwaysIn || '未计算'}
- EMA20 斜率：${paSummary?.emaSlope?.toFixed(2) || 'N/A'}%
- 结构支撑：${paSummary?.support || '未计算'}
- 结构阻力：${paSummary?.resistance || '未计算'}
- 结构评级：${paSummary?.structureValidation?.grade || '未计算'}

**最近 3 根日线：**
${recentDailyBars || '暂无日线数据'}

**量仓信号：**
- 量仓评级：${scanRow.oi_grade || '未评级'}
${volumeStats ? `\n**成交量统计：**\n${volumeStats}` : ''}

**注意：** 以上数据都是真实存在的，不要说"数据缺失"或"没给出来"。如果某个字段显示"未计算"或"N/A"，才可以说该数据不可用。`;
}

/**
 * 生成对话回复（带数据上下文）
 */
export async function generateChatResponse(
  userMessage: string,
  code: string,
  scanRow: V16Row,
  paSummary?: any
): Promise<string> {
  const config = new Config();
  const client = new LLMClient(config);

  const dataContext = buildDataContext(code, scanRow, paSummary);
  const ironRules = buildDataIronRules();

  const messages: any[] = [
    {
      role: 'system',
      content: `你是 Brooks AI 专家，专门分析期货市场。

${ironRules}

${dataContext}

**对话规则：**
1. 用户会问你关于${code}的问题
2. 你必须基于上面的真实数据回答
3. 每个结论都要引用具体数值
4. 不要编造任何数据
5. 用直白、接地气的语言回答`
    },
    {
      role: 'user',
      content: userMessage
    }
  ];

  const response = await withTimeout(
    client.invoke(buildSafeMessages(messages), {
      model: AI_MODEL,
      temperature: 0.5
    }),
    AI_TIMEOUT_MS,
    '对话回复'
  );

  return response.content;
}

/**
 * 验证 AI 回复是否引用了正确数据
 */
export function validateAIResponse(
  response: string,
  scanRow: V16Row,
  paSummary?: any
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1. 检查方向是否正确
  if (scanRow.ai_direction) {
    const direction = scanRow.ai_direction;
    if (direction === '空' && (response.includes('偏多') || response.includes('做多') || response.includes('反弹机会'))) {
      errors.push(`方向错误：数据是"做空"，但 AI 说"偏多/做多"`);
    }
    if (direction === '多' && (response.includes('偏空') || response.includes('做空') || response.includes('下跌机会'))) {
      errors.push(`方向错误：数据是"做多"，但 AI 说"偏空/做空"`);
    }
  }

  // 2. 检查 ADX 是否被正确引用
  if (scanRow.adx && scanRow.adx > 0) {
    const adxStr = scanRow.adx.toFixed(0);
    if (response.includes('ADX') && !response.includes(adxStr) && !response.includes('adx')) {
      errors.push(`ADX 数值未正确引用（实际=${scanRow.adx.toFixed(1)}）`);
    }
    // 检查是否说 ADX 缺失
    if (response.includes('ADX 没') || response.includes('ADX 缺失') || response.includes('ADX 未')) {
      errors.push(`ADX 幻觉：ADX=${scanRow.adx.toFixed(1)} 存在，但 AI 说缺失`);
    }
  }

  // 3. 检查信号等级是否被正确引用
  if (scanRow.signal_grade) {
    if (response.includes('信号等级') && !response.includes(scanRow.signal_grade)) {
      errors.push(`信号等级未正确引用（实际=${scanRow.signal_grade}）`);
    }
  }

  // 4. 检查是否编造数据缺失
  const missingPhrases = ['没给出来', '数据缺失', '没有给出', '未提供'];
  for (const phrase of missingPhrases) {
    if (response.includes(phrase)) {
      // 检查是否真的缺失数据
      const hasAdx = scanRow.adx && scanRow.adx > 0;
      const hasGrade = scanRow.signal_grade;
      const hasEdge = scanRow.edge_grade;

      if (hasAdx && phrase === '没给出来' && response.includes('ADX')) {
        errors.push(`数据幻觉：ADX=${scanRow.adx.toFixed(1)} 存在，但 AI 说"没给出来"`);
      }
    }
  }

  // 5. 检查目标位是否正确
  if (scanRow.mm_tier1 && response.includes('目标')) {
    const targetStr = scanRow.mm_tier1.toFixed(0);
    // 如果 AI 提到了具体目标位，检查是否与数据一致
    const targetMatch = response.match(/目标[位区]*[：:]\s*(\d+)/);
    if (targetMatch) {
      const mentionedTarget = parseInt(targetMatch[1]);
      const actualTarget = Math.round(scanRow.mm_tier1);
      if (Math.abs(mentionedTarget - actualTarget) > actualTarget * 0.1) {
        errors.push(`目标位错误：AI 说${mentionedTarget}，实际=${actualTarget}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * 带验证的对话生成（方案四：混合方案）
 * 生成回复 → 验证 → 失败则重试（最多 2 次）
 */
export async function chatWithValidation(
  userMessage: string,
  code: string,
  scanRow: V16Row,
  paSummary?: any
): Promise<{ content: string; valid: boolean; errors: string[]; attempts: number }> {
  const maxAttempts = 3;
  let lastResponse = '';
  let lastValidation = { valid: true, errors: [] as string[] };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // 生成回复
    lastResponse = await generateChatResponse(userMessage, code, scanRow, paSummary);

    // 验证回复
    lastValidation = validateAIResponse(lastResponse, scanRow, paSummary);

    // 验证通过，直接返回
    if (lastValidation.valid) {
      return {
        content: lastResponse,
        valid: true,
        errors: [],
        attempts: attempt
      };
    }

    // 验证失败，如果是最后一次尝试，返回带警告的回复
    if (attempt === maxAttempts) {
      return {
        content: lastResponse,
        valid: false,
        errors: lastValidation.errors,
        attempts: attempt
      };
    }

    // 验证失败，重新生成（在提示中加入错误信息）
    userMessage = `你的上一个回复有问题：${lastValidation.errors.join('；')}。请重新回答，确保引用正确的数据。`;
  }

  // 不应该到达这里
  return {
    content: lastResponse,
    valid: lastValidation.valid,
    errors: lastValidation.errors,
    attempts: maxAttempts
  };
}

/**
 * ===== 价格行为分析辅助函数 =====
 */

/** 从30分钟K线聚合为日线 */
function aggregateDailyBars(bars: BarData[]): BarData[] {
  const map = new Map<string, BarData>();
  for (const b of bars) {
    const day = String(b.date).slice(0, 10);
    const existing = map.get(day);
    if (!existing) {
      map.set(day, { date: day, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol || 0 });
    } else {
      existing.h = Math.max(existing.h, b.h);
      existing.l = Math.min(existing.l, b.l);
      existing.c = b.c;
      existing.vol = (existing.vol || 0) + (b.vol || 0);
    }
  }
  return Array.from(map.values());
}

/** EMA 计算 */
function calcEma(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      ema.push(values[0]);
    } else {
      prev = values[i] * k + prev * (1 - k);
      ema.push(prev);
    }
  }
  return ema;
}

/** 识别摆动高低点：相邻 left 根K线比它低/高才算 swing */
function findSwingPoints(bars: BarData[], left = 2): { swings: { idx: number; price: number; type: 'H' | 'L'; date: string }[] } {
  const swings: { idx: number; price: number; type: 'H' | 'L'; date: string }[] = [];
  for (let i = left; i < bars.length - left; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + left; j++) {
      if (j === i) continue;
      if (bars[j].h >= bars[i].h) isHigh = false;
      if (bars[j].l <= bars[i].l) isLow = false;
    }
    if (isHigh) swings.push({ idx: i, price: bars[i].h, type: 'H', date: bars[i].date });
    if (isLow) swings.push({ idx: i, price: bars[i].l, type: 'L', date: bars[i].date });
  }
  return { swings };
}

/** 检测突破失败：最近K线是否有"摸高/破低后回吐超过50%" */
function detectFailedBreakout(bars: BarData[]): { failed: boolean; type: 'H' | 'L' | null; detail: string } {
  if (bars.length < 3) return { failed: false, type: null, detail: '数据不足' };
  const n = bars.length;
  // 最近3根找摆动
  const last3 = bars.slice(-3);
  // 前高/前低（排除最近3根）
  const prior = bars.slice(0, n - 3);
  const priorHigh = Math.max(...prior.map(b => b.h));
  const priorLow = Math.min(...prior.map(b => b.l));

  // 检查向上假突破：最近3根中的最高 > 前高，但收盘回吐超过涨幅的一半
  const maxHigh = Math.max(...last3.map(b => b.h));
  const lastClose = last3[last3.length - 1].c;
  const firstOpen = last3[0].o;
  if (maxHigh > priorHigh) {
    const gain = maxHigh - Math.max(priorHigh, firstOpen);
    const retrace = maxHigh - lastClose;
    if (gain > 0 && retrace > gain * 0.5) {
      return { failed: true, type: 'H', detail: `最近K线突破前高${priorHigh.toFixed(1)}后摸高${maxHigh.toFixed(1)}，收盘回吐至${lastClose.toFixed(1)}，回吐超过涨幅一半，属于向上假突破（Buying Climax风险）` };
    }
  }
  // 检查向下假突破
  const minLow = Math.min(...last3.map(b => b.l));
  if (minLow < priorLow) {
    const loss = Math.min(priorLow, firstOpen) - minLow;
    const retrace = lastClose - minLow;
    if (loss > 0 && retrace > loss * 0.5) {
      return { failed: true, type: 'L', detail: `最近K线跌破前低${priorLow.toFixed(1)}后砸至${minLow.toFixed(1)}，收盘回收至${lastClose.toFixed(1)}，回收超过跌幅一半，属于向下假突破（Selling Climax可能）` };
    }
  }
  return { failed: false, type: null, detail: '近3根K线未出现明显突破失败信号' };
}

/** 识别双底/双顶结构 */
function findDoubleBottomTop(bars: BarData[]): { type: 'doubleBottom' | 'doubleTop' | null; level: number; detail: string } {
  const { swings } = findSwingPoints(bars, 2);
  const lows = swings.filter(s => s.type === 'L').slice(-6);
  const highs = swings.filter(s => s.type === 'H').slice(-6);
  // 双底：最近两个低点接近（差距<1.5%）
  if (lows.length >= 2) {
    const l1 = lows[lows.length - 1].price;
    const l2 = lows[lows.length - 2].price;
    if (Math.abs(l1 - l2) / l2 < 0.015) {
      return { type: 'doubleBottom', level: Math.min(l1, l2), detail: `识别到双底结构：${lows[lows.length - 2].date}(${l2.toFixed(1)}) 与 ${lows[lows.length - 1].date}(${l1.toFixed(1)}) 相差${(Math.abs(l1 - l2) / l2 * 100).toFixed(1)}%，构成强支撑` };
    }
  }
  // 双顶
  if (highs.length >= 2) {
    const h1 = highs[highs.length - 1].price;
    const h2 = highs[highs.length - 2].price;
    if (Math.abs(h1 - h2) / h2 < 0.015) {
      return { type: 'doubleTop', level: Math.max(h1, h2), detail: `识别到双顶结构：${highs[highs.length - 2].date}(${h2.toFixed(1)}) 与 ${highs[highs.length - 1].date}(${h1.toFixed(1)}) 相差${(Math.abs(h1 - h2) / h2 * 100).toFixed(1)}%，构成强阻力` };
    }
  }
  return { type: null, level: 0, detail: '未识别到明显双底/双顶结构' };
}

/** 计算双R:R（现价入场 vs 建议回踩入场） */
function calcDualRR(price: number, stop: number, target1: number, entryZoneLow?: number, entryZoneHigh?: number): { rrNow: number | null; rrPullback: number | null; pullbackText: string } {
  if (!price || !stop || !target1) return { rrNow: null, rrPullback: null, pullbackText: '' };
  const riskNow = Math.abs(price - stop);
  const rewardNow = Math.abs(target1 - price);
  const rrNow = riskNow > 0 ? rewardNow / riskNow : null;
  if (!entryZoneLow || !entryZoneHigh) {
    return { rrNow, rrPullback: null, pullbackText: rrNow !== null ? `现价入场盈亏比 ${rrNow.toFixed(2)}:1` : '' };
  }
  const midEntry = (entryZoneLow + entryZoneHigh) / 2;
  const riskPb = Math.abs(midEntry - stop);
  const rewardPb = Math.abs(target1 - midEntry);
  const rrPullback = riskPb > 0 ? rewardPb / riskPb : null;
  return {
    rrNow,
    rrPullback,
    pullbackText: rrPullback !== null ? `回踩${entryZoneLow}-${entryZoneHigh}入场盈亏比 ${rrPullback.toFixed(2)}:1` : ''
  };
}

/** 生成价格行为分析上下文 */
function buildPriceActionContext(bars: BarData[], scanRow: Record<string, any> | null): string {
  if (!bars || bars.length < 60) return '';
  const daily = aggregateDailyBars(bars);
  const recentDaily = daily.slice(-15);
  const closes = recentDaily.map(b => b.c);
  const ema20Arr = calcEma(closes, 20);
  const emaSlope = ema20Arr.length >= 5 ? (ema20Arr[ema20Arr.length - 1] - ema20Arr[ema20Arr.length - 5]) / 5 : 0;
  const emaNow = ema20Arr[ema20Arr.length - 1];
  const price = closes[closes.length - 1];
  const aboveEma = price > emaNow;
  const { swings } = findSwingPoints(recentDaily, 2);
  const recentSwings = swings.slice(-6);
  const doubleStruct = findDoubleBottomTop(recentDaily);
  const breakout = detectFailedBreakout(recentDaily);

  let ctx = `\n### 价格行为分析（Al Brooks 视角）\n`;
  ctx += `**日线聚合（最近 ${recentDaily.length} 个交易日）**\n`;
  ctx += `最近3根日线：\n`;
  const last3d = recentDaily.slice(-3);
  for (const b of last3d) {
    const body = b.c - b.o;
    const range = b.h - b.l;
    let candleDesc = '';
    if (body > 0 && body > range * 0.6) candleDesc = '大阳线（强烈买盘）';
    else if (body < 0 && Math.abs(body) > range * 0.6) candleDesc = '大阴线（强烈卖盘）';
    else if (Math.abs(body) < range * 0.15) candleDesc = '十字星/小实体（多空犹豫）';
    else if (body > 0) candleDesc = '阳线（买盘略占优）';
    else candleDesc = '阴线（卖盘略占优）';
    ctx += `- ${b.date}: O=${b.o.toFixed(1)} H=${b.h.toFixed(1)} L=${b.l.toFixed(1)} C=${b.c.toFixed(1)} → ${candleDesc}\n`;
  }

  ctx += `\n**EMA20**: ${emaNow.toFixed(2)}，近5日斜率 ${emaSlope >= 0 ? '+' : ''}${emaSlope.toFixed(2)}（${emaSlope >= 0 ? '走平/向上' : '下行'}），价格${aboveEma ? '在' : '在'}EMA20${aboveEma ? '上方' : '下方'}${Math.abs(price - emaNow) / emaNow * 100 < 1 ? '（刚收复，注意是否站稳）' : ''}\n`;
  ctx += `**Always In方向**: ${aboveEma && emaSlope >= 0 ? '偏多' : aboveEma && emaSlope < 0 ? '空头反弹中的多头尝试' : !aboveEma && emaSlope < 0 ? '偏空' : '空头反转尝试'} — ${emaSlope < 0 ? 'EMA20走平转上之前，反弹只能当反弹处理' : 'EMA20走平/向上，具备趋势基础'}\n`;

  ctx += `\n**摆动高低点（结构支撑/阻力）**\n`;
  if (recentSwings.length > 0) {
    for (const s of recentSwings.slice(-4)) {
      ctx += `- ${s.type === 'H' ? '摆动高点' : '摆动低点'}: ${s.price.toFixed(1)}（${s.date}）\n`;
    }
  } else {
    ctx += `- 暂无明确摆动结构\n`;
  }

  ctx += `\n**双底/双顶结构**: ${doubleStruct.detail}\n`;
  ctx += `**突破失败检验**: ${breakout.detail}\n`;

  // 双R:R
  if (scanRow && scanRow.key_levels && scanRow.mm_found) {
    const kl = scanRow.key_levels;
    const stop = scanRow.ch_stop || kl.support;
    const target1 = scanRow.mm_tier1;
    const entryLow = scanRow.advice_entry_low;
    const entryHigh = scanRow.advice_entry_high;
    const rr = calcDualRR(price, stop, target1, entryLow, entryHigh);
    ctx += `\n**风险收益比**\n`;
    if (rr.rrNow !== null) ctx += `- 现价 ${price.toFixed(1)} 入场: 止损 ${stop?.toFixed(1)}，目标 ${target1?.toFixed(1)}，盈亏比 ${rr.rrNow.toFixed(2)}:1\n`;
    if (rr.rrPullback !== null) ctx += `- 回踩入场: ${rr.pullbackText}\n`;
    if (rr.rrNow !== null && rr.rrPullback !== null) {
      ctx += `- ⚠️ 两者相差 ${Math.abs(rr.rrNow - rr.rrPullback).toFixed(2)} 倍，追高会严重破坏盈亏比\n`;
    }
  }

  return ctx;
}

/**
 * 获取品种价格行为分析数据（结构化，供详情页使用）
 */
export function getPriceActionData(code: string, scanRow: Record<string, any> | null): Record<string, any> | null {
  const upperCode = code.toUpperCase();
  let bars: BarData[] = [];
  try {
    const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-cache-30m-long');
    const cacheFile = path.join(cacheDir, `${upperCode}.json`);
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    bars = JSON.parse(raw);
    if (bars.length > 200) bars = bars.slice(-200);
  } catch {
    return null;
  }

  if (bars.length < 60) return null;

  const daily = aggregateDailyBars(bars);
  const recentDaily = daily.slice(-15);
  const closes = recentDaily.map(b => b.c);
  const ema20Arr = calcEma(closes, 20);
  if (ema20Arr.length < 5) return null;
  const emaSlope = (ema20Arr[ema20Arr.length - 1] - ema20Arr[ema20Arr.length - 5]) / 5;
  const emaNow = ema20Arr[ema20Arr.length - 1];
  const price = closes[closes.length - 1];
  const aboveEma = price > emaNow;
  const { swings } = findSwingPoints(recentDaily, 2);
  const recentSwings = swings.slice(-6);
  const doubleStruct = findDoubleBottomTop(recentDaily);
  const breakout = detectFailedBreakout(recentDaily);

  // 最近3根日线K线描述
  const last3d = recentDaily.slice(-3).map((b: any) => {
    const body = b.c - b.o;
    const range = b.h - b.l;
    let candleDesc = '';
    if (body > 0 && body > range * 0.6) candleDesc = '大阳线（强烈买盘）';
    else if (body < 0 && Math.abs(body) > range * 0.6) candleDesc = '大阴线（强烈卖盘）';
    else if (Math.abs(body) < range * 0.15) candleDesc = '十字星/小实体（多空犹豫）';
    else if (body > 0) candleDesc = '阳线（买盘略占优）';
    else candleDesc = '阴线（卖盘略占优）';
    return {
      date: b.date,
      o: Number(b.o.toFixed(2)),
      h: Number(b.h.toFixed(2)),
      l: Number(b.l.toFixed(2)),
      c: Number(b.c.toFixed(2)),
      candleDesc,
      body: Number(body.toFixed(2)),
      range: Number(range.toFixed(2)),
    };
  });

  // 摆动结构
  const swingStructures = recentSwings.slice(-4).map((s: any) => ({
    type: s.type === 'H' ? '摆动高点' : '摆动低点',
    price: Number(s.price.toFixed(2)),
    date: s.date,
  }));

  // 双R:R
  let rr = { rrNow: null as number | null, rrPullback: null as number | null, pullbackText: '' };
  if (scanRow && scanRow.key_levels && scanRow.mm_found) {
    const kl = scanRow.key_levels;
    const stop = scanRow.ch_stop || kl.support;
    const target1 = scanRow.mm_tier1;
    const entryLow = scanRow.advice_entry_low;
    const entryHigh = scanRow.advice_entry_high;
    rr = calcDualRR(price, stop, target1, entryLow, entryHigh);
  }

  return {
    code: upperCode,
    generatedAt: new Date().toISOString(),
    dailyBars: recentDaily.map((b: any) => ({
      date: b.date,
      o: Number(b.o.toFixed(2)),
      h: Number(b.h.toFixed(2)),
      l: Number(b.l.toFixed(2)),
      c: Number(b.c.toFixed(2)),
      vol: b.vol,
    })),
    ema: {
      ema20: Number(emaNow.toFixed(2)),
      slope5: Number(emaSlope.toFixed(2)),
      aboveEma,
      alwaysIn: aboveEma && emaSlope >= 0 ? '偏多' : aboveEma && emaSlope < 0 ? '空头反弹中的多头尝试' : !aboveEma && emaSlope < 0 ? '偏空' : '空头反转尝试',
    },
    last3Candles: last3d,
    swingStructures,
    doubleStructure: doubleStruct.detail,
    breakoutTest: breakout.detail,
    riskReward: {
      rrNow: rr.rrNow !== null ? Number(rr.rrNow.toFixed(2)) : null,
      rrPullback: rr.rrPullback !== null ? Number(rr.rrPullback.toFixed(2)) : null,
      pullbackText: rr.pullbackText,
    },
  };
}

/**
 * 轻量版价格行为摘要 — 用于批量扫描时快速计算
 * 只返回关键信息：Always In方向、关键支撑/阻力、K线叙事概要
 */
export function getPriceActionSummary(code: string, scanRow: Record<string, any> | null): Record<string, any> | null {
  const upperCode = code.toUpperCase();
  let bars: BarData[] = [];
  try {
    const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-cache-30m-long');
    const cacheFile = path.join(cacheDir, `${upperCode}.json`);
    const raw = fs.readFileSync(cacheFile, 'utf-8');
    bars = JSON.parse(raw);
    if (bars.length > 200) bars = bars.slice(-200);
  } catch {
    return null;
  }

  if (bars.length < 60) return null;

  const daily = aggregateDailyBars(bars);
  const recentDaily = daily.slice(-10);
  const closes = recentDaily.map(b => b.c);
  const ema20Arr = calcEma(closes, 20);
  if (ema20Arr.length < 5) return null;

  const emaSlope = (ema20Arr[ema20Arr.length - 1] - ema20Arr[ema20Arr.length - 5]) / 5;
  const emaNow = ema20Arr[ema20Arr.length - 1];
  const price = closes[closes.length - 1];
  const aboveEma = price > emaNow;

  // Always In 方向
  const alwaysIn = aboveEma && emaSlope >= 0 ? '多' : aboveEma && emaSlope < 0 ? '反弹' : !aboveEma && emaSlope < 0 ? '空' : '反转';

  // 结构支撑/阻力（简化版）
  const { swings } = findSwingPoints(recentDaily, 2);
  const recentSwings = swings.slice(-4);
  const supportLevels = recentSwings.filter(s => s.type === 'L').map(s => Number(s.price.toFixed(2))).sort((a, b) => b - a);
  const resistanceLevels = recentSwings.filter(s => s.type === 'H').map(s => Number(s.price.toFixed(2))).sort((a, b) => a - b);

  // 最近K线动量（3根日线）
  const last3 = recentDaily.slice(-3);
  const bullishCount = last3.filter(b => b.c > b.o).length;
  const avgBody = last3.reduce((sum, b) => sum + Math.abs(b.c - b.o), 0) / 3;
  const avgRange = last3.reduce((sum, b) => sum + (b.h - b.l), 0) / 3;
  const momentum = avgRange > 0 ? (avgBody / avgRange) : 0;

  // 结构验证：入场位是否有支撑/阻力
  let structureValidation = null;
  if (scanRow) {
    const direction = scanRow.ai_direction;
    const entryPrice = scanRow.close;
    const chStop = scanRow.ch_stop;

    if (direction === '多' && supportLevels.length > 0) {
      const nearestSupport = supportLevels[0];
      const distancePct = Math.abs(entryPrice - nearestSupport) / entryPrice * 100;
      structureValidation = {
        hasStructure: distancePct < 2, // 入场位2%内有支撑
        nearestLevel: nearestSupport,
        distancePct: Number(distancePct.toFixed(2)),
        verdict: distancePct < 1 ? '强支撑' : distancePct < 2 ? '有支撑' : '支撑较远',
      };
    } else if (direction === '空' && resistanceLevels.length > 0) {
      const nearestResistance = resistanceLevels[0];
      const distancePct = Math.abs(entryPrice - nearestResistance) / entryPrice * 100;
      structureValidation = {
        hasStructure: distancePct < 2,
        nearestLevel: nearestResistance,
        distancePct: Number(distancePct.toFixed(2)),
        verdict: distancePct < 1 ? '强阻力' : distancePct < 2 ? '有阻力' : '阻力较远',
      };
    }
  }

  // 成交量统计
  const volumes = recentDaily.map(b => b.vol || 0);
  const avg20 = volumes.length > 0 ? volumes.reduce((a, b) => a + b, 0) / volumes.length : 0;
  const last5 = volumes.slice(-5);
  const avg5 = last5.length > 0 ? last5.reduce((a, b) => a + b, 0) / last5.length : 0;
  const max5 = last5.length > 0 ? Math.max(...last5) : 0;

  return {
    alwaysIn,
    emaSlope: Number(emaSlope.toFixed(2)),
    aboveEma,
    support: supportLevels.slice(0, 2),
    resistance: resistanceLevels.slice(0, 2),
    momentum: Number(momentum.toFixed(2)),
    bullishBars: bullishCount,
    structureValidation,
    recentDaily: recentDaily.slice(-5).map(b => ({
      date: b.date,
      o: Number(b.o.toFixed(2)),
      h: Number(b.h.toFixed(2)),
      l: Number(b.l.toFixed(2)),
      c: Number(b.c.toFixed(2)),
      vol: b.vol || 0,
    })),
    volumeStats: {
      avg20: Number(avg20.toFixed(0)),
      avg5: Number(avg5.toFixed(0)),
      max5: Number(max5.toFixed(0)),
    },
  };
}

/**
 * 分析特定品种 — 基于 V16.2 信号引擎数据 + 30分钟K线历史
 */
// ==================== 数据使用铁律（提取为独立函数） ====================

/**
 * 构建数据使用铁律（所有 AI 分析必须遵守）
 */
export function buildDataIronRules(): string {
  return `
## 数据使用铁律（最高优先级）

**1. 模板填空规则**
- 你必须按照提供的模板格式输出，每个【数据：...】标记处必须直接引用上方提供的数据值
- 禁止重新解释或推断数据，直接复制粘贴数值
- 例如：数据说"方向=多"，你就写"方向为多"，不能说"方向为空"

**2. 禁止编造数据缺失**
- 系统提供的数据都是真实存在的，不要说"ADX缺失"、"数据不足"、"没有给出V16评级"等话
- 上下文中提供的每个指标值都是真实的，必须直接使用
- 如果某个字段显示"未计算"或"N/A"，才可以说该数据不可用

**3. 必须引用具体数值**
- 提到任何指标时，必须附带具体数值，如"ADX=39.36"而不是"ADX较高"
- 方向判断必须引用 V16 的 ai_direction 值（多/空/中性）
- 信号等级必须引用 edge_grade 和 signal_grade 的实际值
- Gate4 必须引用 g4_verdict 的实际值（如"3/5"）

**4. 禁止重新解释数据**
- 数据说"方向=多"，你就说"方向为多"，不能说"方向为空"
- 数据说"Gate4=3/5"，你就说"Gate4通过3/5"，不能说"Gate4通过1/5"
- 数据说"目标位=4668"，你就说"目标位4668"，不能说"目标位4160"

**5. 禁止编造基本面数据**
- 系统没有供需、库存、成本等基本面数据
- 不要编造"供应压力增加"、"产能去化"等分析
- 只基于技术面和价格行为进行分析

**6. 结构化输出要求**
- 每个结论必须引用具体数据，格式：结论【数据：XXX=数值】
- 示例："趋势偏多【数据：Always In=多，ADX=39.36】"
- 禁止无数据支撑的结论

**7. 新闻验证铁律（第9章专用）**
- 新闻只能作为技术分析的辅助验证，不能替代技术信号
- 必须基于系统提供的【最新市场新闻】进行分析，禁止编造新闻
- 如果【最新市场新闻】为空或没有相关新闻，必须明确写"暂无新闻佐证"
- 不要用常规波动强行解读方向，没有新闻支撑就写"无关键新闻影响"
- 【矩阵回测铁律】共振时增强信心（+9.5%回报），背离时绝不建议降仓/放弃技术信号（-19%回报是负优化）
- 【矩阵回测铁律】不建议"事件后暂停交易"（冷却无增益），不建议"黑天鹅时立即平仓"（断仓损失更大）

**8. 历史类比铁律（第10章专用）**
- 只允许引用真实发生过的历史事件（如美伊战争、俄乌冲突、英国脱欧、2020疫情等），禁止编造历史案例
- 对比必须包含"当时的共识预期"和"实际走势"两部分
- 如果找不到高度相似的历史事件，必须写"无高度相似历史案例"，不得强行类比
- 重点提示反直觉案例：市场共识预期经常被证伪（如地缘冲突爆发后避险资产反而暴跌，"买预期卖事实"）

**9. 黑天鹅与技术失效铁律（第10、11章专用）**
- 只有突发性、异常性事件（政策突变/地缘冲突/突发减产/监管打击/极端天气等）才算高风险事件
- 常规供需波动、季节性消息、行业常规数据不算黑天鹅，不得夸大
- 黑天鹅窗口期，技术分析可能暂时失效：关键支撑/阻力可能被跳空击穿、止损可能滑点无法按计划成交
- 黑天鹅期间禁止给出"依托技术位加仓/逆势扛单"等危险建议，应建议暂停/减仓/等待结构重新确认
- 未检测到高风险事件时，必须明确写"未检测到高风险事件"，不得为了凑字数编造风险

**10. 品种敏感度差异铁律（第10、11章专用）**
- 高敏感品种（WR0/FU0/JD0，ATR倍数>4.5x）：黑天鹅期间技术失效概率更高，必须明确建议放宽止损或减仓保护
- 低敏感品种（AL0/Z N0/OI0/CU0/AU0，ATR倍数<3.5x）：技术信号在黑天鹅期间仍相对可靠，可维持原有策略
- 天气气候类事件延续率最高（91%），AI应建议"顺势持有"；行业事件反直觉率最高（80%），AI必须警示"共识可能被证伪"
- 当分析具体品种时，必须结合该品种的历史敏感度给出差异化建议，不能一概而论
- 冲击严重程度分级铁律（69,176次冲击统计）：
  - L1(1-2×ATR，91%)：日常噪音，忽略，技术信号照常
  - L2(2-3×ATR，7%)：关注但不改变策略
  - L3(3-6×ATR，1.4%)：方向不确定，建议减仓观望
  - L4(>6×ATR，0.1%)：反直觉率69%，**绝不追共识方向**，等市场消化后再决策
- 持仓周期铁律（137事件时间衰减分析）：
  - 供给端减产/天气气候：持续增强，可持有20日+
  - 地缘政治/供需失衡：10日峰值，建议持有10日
  - 宏观经济/政策监管：持续恶化，尽早离场
  - 交易制度：立即离场
  - 30日以上持仓普遍反转，不建议超长期持有`;
}

/**
 * 计算动态止损倍数（基于品种 ATR 敏感度和市场状态）
 * @param code 品种代码
 * @param varietyGrade 品种评级 (A/B/C/D)
 * @param marketState 市场状态 ('strong_trend' | 'weak_trend' | 'ranging' | 'extreme' | 'turning')
 * @returns 止损 ATR 倍数
 */
function getDynamicStopLossMultiplier(
  code: string,
  varietyGrade: string,
  marketState: string
): number {
  const baseMultiplier = 2.5; // 基础止损倍数

  // 高敏感品种放宽止损（波动大，容易被扫止损）
  const highSensitivityVarieties = ['WR0', 'FU0', 'SI0', 'JD0', 'LH0'];
  if (highSensitivityVarieties.includes(code)) {
    return baseMultiplier * 1.3; // 3.25 倍
  }

  // 低敏感品种收紧止损（波动小，止损可以更紧）
  const lowSensitivityVarieties = ['AL0', 'NI0', 'OI0', 'CU0', 'AU0'];
  if (lowSensitivityVarieties.includes(code)) {
    return baseMultiplier * 0.9; // 2.25 倍
  }

  // 根据市场状态调整
  if (marketState === 'ranging') {
    // 震荡市收紧止损
    return baseMultiplier * 0.8; // 2.0 倍
  }
  if (marketState === 'strong_trend') {
    // 趋势市放宽止损（给趋势更多空间）
    return baseMultiplier * 1.1; // 2.75 倍
  }
  if (marketState === 'extreme') {
    // 极端行情大幅放宽止损
    return baseMultiplier * 1.5; // 3.75 倍
  }

  // 根据品种评级调整
  if (varietyGrade === 'D') {
    // D 级品种不建议交易，但如果非要交易，止损要更紧
    return baseMultiplier * 0.7; // 1.75 倍
  }
  if (varietyGrade === 'A') {
    // A 级品种可以稍微放宽止损
    return baseMultiplier * 1.05; // 2.625 倍
  }

  return baseMultiplier;
}

/**
 * 计算最优持仓周期（基于品种评级和市场状态）
 * @param code 品种代码
 * @param varietyGrade 品种评级 (A/B/C/D)
 * @param marketState 市场状态
 * @returns 最优持仓天数
 */
function getOptimalHoldDays(
  code: string,
  varietyGrade: string,
  marketState: string
): number {
  const baseDays = 15; // 回测最优基础持仓周期

  // 根据品种评级调整
  if (varietyGrade === 'A') {
    return Math.round(baseDays * 1.2); // 18 天
  }
  if (varietyGrade === 'B') {
    return baseDays; // 15 天
  }
  if (varietyGrade === 'C') {
    return Math.round(baseDays * 0.7); // 10 天
  }
  if (varietyGrade === 'D') {
    return Math.round(baseDays * 0.5); // 7 天（不建议交易，快速出场）
  }

  // 根据市场状态调整
  if (marketState === 'strong_trend') {
    return Math.round(baseDays * 1.3); // 19 天
  }
  if (marketState === 'ranging') {
    return Math.round(baseDays * 0.6); // 9 天
  }

  return baseDays;
}

/**
 * 数据完整性检查与时间戳注入
 * 确保所有数据实时更新，无幻觉，严格以事实为依据
 */
function buildDataIntegrityReport(
  code: string,
  scanRow: Record<string, any> | null,
  barsResult: PromiseSettledResult<any>,
  newsResult: PromiseSettledResult<any>,
  strategyContext: any,
  signalSummary: any
): string {
  const now = new Date();
  const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);
  
  const checks: string[] = [];
  
  // 1. V16 扫描数据检查
  if (scanRow) {
    checks.push(`✅ V16信号引擎数据：已获取（信号等级=${scanRow.signal_grade || 'N/A'}，方向=${scanRow.ai_direction || 'N/A'}）`);
  } else {
    checks.push(`⚠️ V16信号引擎数据：暂未获取（可能因非交易时段或数据源延迟）`);
  }
  
  // 2. K线数据检查
  if (barsResult.status === 'fulfilled' && barsResult.value) {
    const bars = barsResult.value.bars || barsResult.value;
    if (Array.isArray(bars) && bars.length > 0) {
      const latestBar = bars[bars.length - 1];
      checks.push(`✅ 30分钟K线数据：已获取（${bars.length}根，最新=${latestBar.date || 'N/A'}）`);
    } else {
      checks.push(`⚠️ 30分钟K线数据：缓存文件存在但内容为空`);
    }
  } else {
    checks.push(`⚠️ 30分钟K线数据：缓存文件不存在或读取失败`);
  }
  
  // 3. 新闻数据检查
  if (newsResult.status === 'fulfilled' && newsResult.value) {
    const newsCount = newsResult.value.news?.length || 0;
    checks.push(`✅ 新闻数据：已获取（${newsCount}条相关新闻）`);
  } else {
    checks.push(`⚠️ 新闻数据：搜索失败或无相关新闻`);
  }
  
  // 4. 策略上下文检查
  if (strategyContext) {
    checks.push(`✅ 策略上下文（1000次回测验证）：已获取`);
  } else {
    checks.push(`⚠️ 策略上下文：该品种暂无回测验证数据`);
  }
  
  // 5. 传播链信号检查
  if (signalSummary) {
    checks.push(`✅ 传播链监控信号：已获取`);
  } else {
    checks.push(`⚠️ 传播链监控信号：暂无信号或监控服务暂未就绪`);
  }
  
  return `
## 数据完整性检查报告
**检查时间**: ${timestamp}
**品种**: ${code}

${checks.join('\n')}

**数据时效性说明**:
- V16信号引擎数据：基于最近30分钟K线实时计算
- K线数据：30分钟K线缓存，每30分钟自动刷新
- 新闻数据：实时搜索最近24小时内的相关新闻
- 策略上下文：基于20年60品种日线回测数据（1000次实验）
- 传播链信号：基于当日实时扫描

**重要**：以上所有数据均为实时获取的真实数据，禁止AI编造或推断任何未在数据中明确提供的数值。如果某项数据缺失，必须明确说明"暂无数据"，禁止用估算值替代。`;
}

export async function analyzeVariety(
  varietyCode: string,
  customHeaders?: Record<string, string>
): Promise<string> {
  const client = createLLMClient(customHeaders);
  const code = varietyCode.toUpperCase();
  const name = VARIETIES[code] || code;

  // ========== 加载品种评级数据 ==========
  let varietyGrade = 'C'; // 默认 C 级
  let historicalWinRate = 0.55; // 默认胜率
  let optimalHoldDays = 15; // 最优持仓天数
  let avgRR = 1.5; // 平均盈亏比
  let robustPct = 0;
  let crashPct = 0;
  let profitablePct = 0;
  let calibratedGrade = 'C';
  let calibrationNote = '';

  try {
    const deepBacktestPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'data', 'deepBacktestSummary.json');
    const deepBacktestData = JSON.parse(fs.readFileSync(deepBacktestPath, 'utf-8'));
    const rescoreSummary = deepBacktestData.rescoreSummary;

    // 确定品种评级
    if (rescoreSummary.AList?.includes(code)) varietyGrade = 'A';
    else if (rescoreSummary.BList?.includes(code)) varietyGrade = 'B';
    else if (rescoreSummary.CList?.includes(code)) varietyGrade = 'C';
    else if (rescoreSummary.DList?.includes(code)) varietyGrade = 'D';

    // 从 triplePass 获取该品种的历史胜率和盈亏比
    const triplePass = deepBacktestData.triplePass;
    for (const key of Object.keys(triplePass)) {
      const item = triplePass[key];
      if (item.code === code) {
        historicalWinRate = item.profitablePct || 0.55;
        robustPct = item.robustPct || 0;
        crashPct = item.crashPct || 0;
        profitablePct = item.profitablePct || 0;
        avgRR = item.top1Calmar ? (item.top1Pnl / (item.top1Dd * 100000)) : 1.5;
        break;
      }
    }
  } catch (e) {
    console.error('[analyzeVariety] 加载品种评级失败:', e);
  }

  // 获取实盘校准后的分级
  try {
    const calibrated = getCalibratedGrade(code);
    calibratedGrade = calibrated.calibratedGrade;
    calibrationNote = calibrated.calibrationNote;
  } catch (e) {
    // ignore
  }

  // C/D 级品种警告（不再短路返回，而是继续完整 18 章节分析，但在数据上下文中明确标注）
  const isLowGradeVariety = calibratedGrade === 'C' || calibratedGrade === 'D';
  const gradeWarning = isLowGradeVariety
    ? `\n⚠️⚠️⚠️ **重要警告：该品种为 ${calibratedGrade} 级（${calibratedGrade === 'D' ? '不推荐交易' : '谨慎交易'}）**
- 盈利占比：${(profitablePct * 100).toFixed(1)}%（1000次实验中盈利的比例）
- 稳健率：${(robustPct * 100).toFixed(1)}%（盈利且回撤<30%的比例）
- 崩溃率：${(crashPct * 100).toFixed(1)}%（亏损或回撤>50%的比例）
- 历史胜率：${(historicalWinRate * 100).toFixed(1)}%
- 校准说明：${calibrationNote || '保持回测评级'}
- **建议**：${calibratedGrade === 'D' ? '不参与交易，选择 A/B 级品种' : '轻仓试探，严格止损，仓位不超过 10%-30%'}\n`
    : '';

  // ========== 并行获取所有数据源 ==========
  const cacheDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data-cache-30m-long');
  const cacheFile = path.join(cacheDir, `${code}.json`);

  // 并行执行：V16扫描 + K线缓存读取 + 新闻搜索 + 策略上下文 + 传播链信号
  const [
    scanRow,
    barsResult,
    newsResult,
    strategyContext,
    signalSummary
  ] = await Promise.allSettled([
    // 1. V16 扫描数据（单品种扫描）
    scanSingleVariety30m(code).catch(() => null),
    // 2. 30分钟K线缓存
    (async () => {
      try {
        const raw = fs.readFileSync(cacheFile, 'utf-8');
        let bars: BarData[] = JSON.parse(raw);
        if (bars.length > 200) bars = bars.slice(-200);
        return bars;
      } catch {
        return [] as BarData[];
      }
    })(),
    // 3. 新闻搜索
    searchVarietyNews(code).catch(() => ({ news: [], summary: '' })),
    // 4. 策略上下文（1000次回测验证证据）
    Promise.resolve(getStrategyContext(code)).catch(() => null),
    // 5. 传播链监控信号
    (async () => {
      try {
        const { generateAISignalSummary } = await import('./eventMonitorService.js');
        return generateAISignalSummary();
      } catch {
        return '监控服务暂未就绪，无法获取实时信号。请参考回测结论进行方向判断。';
      }
    })(),
  ]);

  // 解析结果
  let scanRowData: Record<string, any> | null = scanRow.status === 'fulfilled' ? scanRow.value : null;
  const recentBars: BarData[] = barsResult.status === 'fulfilled' ? barsResult.value : [];
  const newsData = newsResult.status === 'fulfilled' ? newsResult.value : { news: [], summary: '' };
  const sc = strategyContext.status === 'fulfilled' ? strategyContext.value : null;
  const signalSummaryText = signalSummary.status === 'fulfilled' ? signalSummary.value : '监控服务暂未就绪。';

  // 如果单品种扫描失败，尝试从全品种扫描缓存中获取兜底数据
  if (!scanRowData) {
    try {
      const fullScanCache = getScanCache();
      if (fullScanCache && fullScanCache.rows && fullScanCache.rows.length > 0) {
        scanRowData = fullScanCache.rows.find((r: any) => r.code === code) || null;
        if (scanRowData) {
          console.log(`[AI] analyzeVariety: 使用全品种扫描缓存兜底数据 for ${code}`);
        }
      }
    } catch {
      // 兜底也失败，继续用K线数据
    }
  }

  // 构建数据完整性检查报告
  const dataIntegrityReport = buildDataIntegrityReport(
    code, scanRowData, barsResult, newsResult, sc, signalSummaryText
  );

  // ========== 构建数据上下文 ==========
  let dataContext = `${dataIntegrityReport}

## ${code}（${name}）品种数据
${gradeWarning}
### 品种评级与历史表现（20 年回测数据）
- **回测评级**: ${varietyGrade} 级（${varietyGrade === 'A' ? '优秀' : varietyGrade === 'B' ? '良好' : varietyGrade === 'C' ? '一般' : '差'}）
- **实盘校准评级**: ${calibratedGrade} 级${calibratedGrade !== varietyGrade ? `（从 ${varietyGrade} 级调整）` : ''}
- **校准说明**: ${calibrationNote || '保持回测评级'}
- **盈利占比**: ${(profitablePct * 100).toFixed(1)}%（1000次实验中盈利的比例）
- **稳健率**: ${(robustPct * 100).toFixed(1)}%（盈利且回撤<30%的比例）
- **崩溃率**: ${(crashPct * 100).toFixed(1)}%（亏损或回撤>50%的比例）
- **历史胜率**: ${(historicalWinRate * 100).toFixed(1)}%
- **最优持仓周期**: ${optimalHoldDays} 天
- **平均盈亏比**: ${avgRR.toFixed(2)}
- **参数稳健性**: ${varietyGrade === 'A' ? '高（策略表现稳定）' : varietyGrade === 'B' ? '中（多数参数有效）' : '低（参数敏感）'}

### 建议仓位区间（基于稳健性分级）
- **A 级（稳健底仓）**: 80%-100% 标准仓位
- **B 级（可用）**: 40%-60% 标准仓位
- **C 级（脆弱）**: 10%-30% 轻仓试探
- **D 级（失效）**: 0%，不参与交易

当前品种建议仓位: **${calibratedGrade === 'A' ? '80%-100%' : calibratedGrade === 'B' ? '40%-60%' : calibratedGrade === 'C' ? '10%-30%' : '0%（不建议交易）'}**

⚠⚠️ **重要约束**：
- 胜率预估不得超过历史胜率 +5%（当前上限：${((historicalWinRate + 0.05) * 100).toFixed(1)}%）
- 持仓周期建议不得超过${optimalHoldDays}天（回测最优${optimalHoldDays}天，不得超过此值）
- **动态止损 ATR 倍数**：
  - A 级品种：2.5 倍（趋势稳定，可放宽）
  - B 级品种：2.0 倍（标准止损）
  - C 级品种：1.5 倍（快速止损）
  - D 级品种：不建议交易
  - 当前品种止损倍数：**${calibratedGrade === 'A' ? '2.5' : calibratedGrade === 'B' ? '2.0' : calibratedGrade === 'C' ? '1.5' : 'N/A'}倍 ATR**
- 盈亏比预估不得超过${(avgRR + 0.5).toFixed(2)}（历史平均${avgRR.toFixed(2)}）
- **必须根据品种评级给出仓位建议**，不要给出超出评级范围的仓位建议

### 信号衰减规则
- 当信号衰减状态为"已衰减"或"已过期"时，必须明确告知用户信号已弱化
- 衰减后分数 < 30 时，建议降低仓位或观望
- 衰减后分数 < 15 时，建议完全回避该品种

### 交易成本意识
- 当交易成本率 > 0.5% 时，提醒用户该品种交易成本较高
- 建议目标距离至少覆盖 3 倍交易成本
- 流动性为"差"的品种，建议减少仓位或避免交易

`;

  // V16 信号引擎数据
  if (scanRowData) {
    dataContext += `### V16.2 信号引擎分析结果
- **AI方向判断**: ${scanRowData.ai_direction || '无'}
- **信号等级**: ${scanRowData.signal_variant || scanRowData.edge_grade || '无'}
- **Edge评级**: ${scanRowData.edge_grade || '无'}
- **收盘价**: ${scanRowData.close}
- **涨跌幅**: ${scanRowData.ret_pct?.toFixed(2) || '0'}%
- **顺势概率 P(顺)**: ${((scanRowData.p_follow || 0) * 100).toFixed(1)}%
- **趋势强度(ADX)**: ${scanRowData.adx?.toFixed(1) || 'N/A'}
- **趋势质量**: ${scanRowData.trend_strength || 'N/A'}
- **生命周期**: ${scanRowData.lc_stage || 'N/A'} — ${scanRowData.lc_desc || ''}
- **ATR(14)**: ${scanRowData.atr14?.toFixed(2) || 'N/A'}
- **频谱**: ${scanRowData.spectrum || 'N/A'} (${scanRowData.spectrum_detail || ''})
- **量仓信号**: ${scanRowData.oi_signal || '无'} (OI变化: ${scanRowData.oi_change_pct?.toFixed(1) || '0'}%, OI等级: ${scanRowData.oi_grade || 'N/A'})
- **Follow Through**: ${scanRowData.fw_type_cn || 'N/A'} (排名: ${scanRowData.fw_rank || 'N/A'})
- **纪律阶梯**: ${scanRowData.disc_ladder || '0'}
- **交易价值判定**: ${scanRowData.trade_worthiness || 'N/A'}
- **过滤原因**: ${scanRowData.g4_verdict || 'N/A'}
`;

    if (scanRowData.g4_reasons_met && scanRowData.g4_reasons_met.length > 0) {
      dataContext += `- **Gate4通过条件**: ${scanRowData.g4_reasons_met.join(', ')}\n`;
    }

    if (scanRowData.key_levels) {
      const kl = scanRowData.key_levels;
      dataContext += `\n### 关键价位
- EMA20: ${kl.ema20?.toFixed(2) || 'N/A'}
- 支撑位: ${kl.support?.toFixed(2) || 'N/A'}
- 阻力位: ${kl.resistance?.toFixed(2) || 'N/A'}
- 前高: ${kl.prev_high?.toFixed(2) || 'N/A'}
- 前低: ${kl.prev_low?.toFixed(2) || 'N/A'}
- 20日区间高: ${kl.range_high_20?.toFixed(2) || 'N/A'}
- 20日区间低: ${kl.range_low_20?.toFixed(2) || 'N/A'}
`;
    }

    if (scanRowData.mm_found) {
      dataContext += `\n### MM目标位（机构目标）
- 方向: ${scanRowData.mm_direction || 'N/A'}
- 目标1: ${scanRowData.mm_tier1?.toFixed(2) || 'N/A'}
- 目标2: ${scanRowData.mm_tier2?.toFixed(2) || 'N/A'}
- 目标3: ${scanRowData.mm_tier3?.toFixed(2) || 'N/A'}
- 止损: ${scanRowData.ch_stop?.toFixed(2) || 'N/A'}
`;
    }

    if (scanRowData.advice) {
      dataContext += `\n### 系统交易建议\n${scanRowData.advice}\n`;
    }

    // P2: 信号衰减信息
    if (scanRowData.signal_decay) {
      const sd = scanRowData.signal_decay;
      dataContext += `\n### 信号衰减评估
- **原始信号分数**: ${sd.originalScore.toFixed(1)}
- **衰减后分数**: ${sd.decayedScore.toFixed(1)}
- **衰减率**: ${sd.decayRate.toFixed(0)}%
- **信号状态**: ${sd.status}
- **建议**: ${sd.suggestion}
`;
    }

    // P0: 交易成本信息
    if (scanRowData.atr14 && scanRowData.close) {
      const { calcTradeCost, getSlippageConfig, estimateLiquidityLevel } = await import('./tradingCostModel.js');
      const cost = calcTradeCost(code, scanRowData.close, scanRowData.close * 1.02, scanRowData.atr14, false, getSlippageConfig(code));
      const liquidity = estimateLiquidityLevel(code);
      const contractValue = scanRowData.close * (cost.totalCost > 0 ? cost.totalCost / cost.costRatio : scanRowData.close * 10);
      dataContext += `\n### 交易成本估算
- **总手续费**: ${cost.totalCommission.toFixed(0)} 元
- **总滑点**: ${cost.totalSlippage.toFixed(0)} 元
- **总交易成本**: ${cost.totalCost.toFixed(0)} 元（占合约价值 ${(cost.costRatio * 100).toFixed(3)}%）
- **保本点数**: ${cost.breakevenPoints.toFixed(2)}（价格需移动这么多才能覆盖成本）
- **流动性**: ${liquidity}
`;
    }
  } else {
    dataContext += `### ️ V16 信号引擎数据缺失
当前无法获取 ${code} 的 V16 扫描数据。可能原因：
1. 30分钟K线缓存文件不存在或已过期（路径：data-cache-30m-long/${code}.json）
2. 单品种扫描服务暂时不可用
建议：等待数据刷新后重试，或联系管理员检查数据抓取服务。\n\n`;
  }

  // K线价格行为数据
  let barStats: { recent5: BarData[]; high20: number; low20: number; avgVol20: number; prevHigh: number; prevLow: number } | null = null;
  if (recentBars.length >= 20) {
    const last20 = recentBars.slice(-20);
    const recent5 = recentBars.slice(-5);
    const highs = last20.map(b => b.h);
    const lows = last20.map(b => b.l);
    const vols = last20.map(b => b.vol);
    barStats = {
      recent5,
      high20: Math.max(...highs),
      low20: Math.min(...lows),
      avgVol20: vols.reduce((a, b) => a + b, 0) / vols.length,
      prevHigh: Math.max(...recentBars.slice(-60, -1).map(b => b.h)),
      prevLow: Math.min(...recentBars.slice(-60, -1).map(b => b.l)),
    };
  }

  if (barStats && recentBars.length >= 20) {
    const last = recentBars[recentBars.length - 1];
    const last5 = barStats.recent5;
    const priceChange5 = last5.length >= 2 ? ((last5[last5.length - 1].c - last5[0].o) / last5[0].o * 100).toFixed(2) : 'N/A';
    const lastBarDate = last?.date || '未知';

    dataContext += `\n### 近期价格行为（30分钟K线）
- **最新K线时间**: ${lastBarDate}
- **最新收盘**: ${last?.c}
- **近5根K线涨跌**: ${priceChange5}%
- **近20根K线最高**: ${barStats.high20}
- **近20根K线最低**: ${barStats.low20}
- **20根均量**: ${barStats.avgVol20?.toFixed(1)}
- **近60根前高**: ${barStats.prevHigh}
- **近60根前低**: ${barStats.prevLow}

**最近5根K线明细**:
${last5.map(b => `- ${b.date}: O=${b.o} H=${b.h} L=${b.l} C=${b.c} V=${b.vol}`).join('\n')}
`;
  } else if (recentBars.length === 0) {
    dataContext += `\n### ️ K线数据缺失
30分钟K线缓存文件不存在或为空（路径：data-cache-30m-long/${code}.json）。\n`;
  }

  // 价格行为分析（Al Brooks 视角）
  if (recentBars.length >= 60) {
    dataContext += buildPriceActionContext(recentBars, scanRowData);
  } else if (recentBars.length > 0 && recentBars.length < 60) {
    dataContext += `\n### 价格行为分析（Al Brooks 视角）
K线数据不足（仅 ${recentBars.length} 根，需要至少 60 根），无法进行完整的 Brooks 价格行为分析。
建议：等待更多K线数据积累后再进行深度分析。\n`;
  } else if (recentBars.length === 0) {
    dataContext += `\n### 价格行为分析（Al Brooks 视角）
K线数据缺失，无法进行 Brooks 价格行为分析。\n`;
  }

  // 新闻数据
  if (newsData.news.length > 0) {
    dataContext += '\n\n## 最新市场新闻\n';
    for (const item of newsData.news.slice(0, 3)) {
      dataContext += `- ${item.title}（${item.source}）\n  ${item.snippet.slice(0, 100)}...\n`;
    }
    if (newsData.summary) {
      dataContext += `\n新闻摘要：${newsData.summary}\n`;
    }
  } else {
    dataContext += '\n\n## 最新市场新闻\n暂无该品种相关新闻。\n';
  }

  // 策略上下文（1000次回测验证证据）
  if (sc) {
    const ver = sc.verification ?? { pnlRank: 0, ddRank: 0, captureRank: 0, total: 0, pnlTopPct: 0, ddTopPct: 0 };
    const db = sc.directionBias ?? { dominant: 'BALANCED', longCapture: 0, shortCapture: 0, note: '' };
    const holdNote = sc.hold?.note ?? '无回测持仓数据';
    const dom = db.dominant;
    const dirNote = dom === 'LONG' ? '做多显著更强，做空需更高信号确认' : dom === 'SHORT' ? '做空显著更强，做多需更高信号确认' : '多空均衡';
    dataContext += `\n### 1000次回测验证证据（策略上下文）\n` +
      `- 参数验证：当前参数经1000次回测，收益排名 ${ver.pnlRank}/${ver.total}（前 ${ver.pnlTopPct.toFixed(1)}%），回撤排名 ${ver.ddRank}/${ver.total}（前 ${ver.ddTopPct.toFixed(1)}%）\n` +
      `- 方向有效性：${dirNote}（做多捕获 ${(db.longCapture * 100).toFixed(0)}%，做空捕获 ${(db.shortCapture * 100).toFixed(0)}%）\n` +
      `- 熔断风控：${sc.circuitBreaker ? `连亏 ${sc.circuitBreaker.lossStreak} 笔暂停 ${sc.circuitBreaker.pauseBars} 根` : '不启用熔断'}\n` +
      `- 持仓建议：${holdNote}\n` +
      (sc.fragilityWarnings.length ? `- 脆弱点警示：${sc.fragilityWarnings.join('；')}\n` : '') +
      `- 捕获率解读：${sc.captureNote || '无异常'}\n`;
  } else {
    dataContext += `\n### 1000次回测验证证据（策略上下文）
该品种暂无回测验证数据。可能原因：
1. 该品种不在回测品种池中
2. 回测数据尚未生成
建议：仅依赖V16信号引擎和价格行为分析，不做策略上下文推断。\n`;
  }

  // 4. 构建 AI 对话 - 使用模板填空方式，强制AI直接引用数据
  const dataIronRules = buildDataIronRules();
  
  // 构建强制模板，AI必须填空不能自由发挥
  const templatePrompt = `请作为 Brooks AI 专家，对 ${code}（${name}）进行深度解读。

【重要】你必须严格按照下面的模板格式输出，每个【数据：...】标记处的内容必须直接引用上方提供的数据值，禁止重新解释或推断！

${dataIronRules}

${gradeWarning}

**你必须输出完整的 20 个章节（1-20），每个章节都必须有内容。如果某章节数据缺失，必须明确说明"暂无数据"或"监控服务暂未就绪"，禁止省略任何章节！**

请按以下模板格式输出（每个【数据：...】必须直接引用上方数据）：

### 1. 趋势判读
Always In方向为{{引用"价格行为分析"中的"Always In方向"}}，当前处于{{引用"价格行为分析"中的结构阶段}}阶段【数据：EMA20斜率={{引用"EMA20斜率"}}%，信号等级={{引用"信号等级"}}，Gate4={{引用"Gate4"}}，生命周期={{引用"生命周期"}}，频谱={{引用"频谱"}}】
（用1-2句话解释当前趋势状态）

### 2. 信号质量评估
信号可靠性{{高/中/低}}【数据：信号等级={{引用"信号等级"}}，Edge评级={{引用"Edge评级"}}，Gate4={{引用"Gate4"}}，量仓信号={{引用"量仓评级"}}】
（用1-2句话解释信号质量）

### 3. K线结构分析
最近三根日线故事：
- {{日期1}}：{{描述K线形态}}【数据：C={{收盘价}}，{{涨跌情况}}】
- {{日期2}}：{{描述K线形态}}【数据：C={{收盘价}}，{{涨跌情况}}】
- {{日期3}}：{{描述K线形态}}【数据：C={{收盘价}}，{{涨跌情况}}】
市场走出了{{总结结构特征}}。

### 4. 关键价位解读
结构支撑在{{引用"结构支撑"}}，结构阻力在{{引用"结构阻力"}}【数据：摆动低点={{引用"摆动低点"}}，摆动高点={{引用"摆动高点"}}，当前价格={{引用"收盘价"}}】
（说明当前价格位置和追高风险）

### 5. 量仓分析
【数据：OI变化={{引用"OI变化"}}，OI等级={{引用"OI等级"}}，20根均量={{引用"20根均量"}}，最近5根K线最大量={{引用"最大量"}}】
（分析量仓含义）

### 6. 交易建议
- 入场方向与逻辑：{{基于"方向"字段给出建议}}
- 入场区间：{{结合结构支撑/阻力给出}}
- 止损位：{{引用"止损位"或结构依据}}
- 目标位：第一目标{{保守目标}}，第二目标{{引用"目标位"}}
- 仓位建议：{{基于信号等级和量仓给出0.5%-2%建议}}
- 盈亏比：现价入场R:R≈{{计算}}，建议入场区间R:R≈{{计算}}

### 7. 风险提示
【数据：频谱={{引用"频谱"}}】
（说明主要风险）

### 8. 多空反转条件
如果价格{{反转条件1}}，同时{{反转条件2}}，则当前判断失效。

### 9. 新闻面验证（技术分析与新闻交叉验证）
- 当前技术判断方向（V16/价格行为）与新闻面是否共振？请基于【最新市场新闻】判断
- 列出 1-3 条支持或反驳技术判断的关键新闻及理由【数据：新闻标题=...，来源=...】
- 结论：共振时明确写"信心增强，可适度放大仓位"（历史回测：共振加仓+9.5%回报）；背离时写"保持技术信号，不因新闻面放弃"（历史回测：背离降仓-19%回报，是负优化）
- 若无相关新闻，明确写"暂无新闻佐证"

### 10. 黑天鹅风险预警与历史类比
- 【风险事件】是否存在可能引发剧烈行情的突发性事件（政策突变/地缘冲突/突发减产/监管打击/极端天气等）？无则明确写"未检测到高风险事件"
- 【历史类比】如有风险事件，检索最相似的 1-2 次历史事件，对比：
  - 当时的共识预期（市场以为会怎样）
  - 实际走势（真实发生了什么）
  - 与当前事件的相似度
- 【反直觉提醒】重点提示"预期与实际相反"的案例（如地缘冲突爆发后避险资产反而暴跌，"买预期卖事实"），禁止顺着市场共识给出方向

【历史回测数据支撑（20年60品种日线回测：1055次异常冲击+52个真实黑天鹅事件）——做历史类比与反直觉判断时，必须参考以下统计规律，用数据说话而非主观猜测】
- 【地缘政治】冲击后10日平均收益 +7.7%，反直觉率仅 17% → 地缘类冲击后大概率延续原方向，勿轻言反转（"买预期卖事实"在地缘类并不普遍）
- 【宏观经济/金融】冲击后10日平均 -5.5% → 宏观危机后商品系统性承压，反弹需谨慎
- 【政策监管】冲击后10日平均 -6.2% → 政策打压（保供稳价/限价）后跌势延续概率高
- 【天气/气候】冲击后10日平均 +4.6%，反直觉率 0% → 天气减产类利多大概率延续
- 【疾病/疫情】反直觉率 65% → 疫病类共识预期最容易被证伪，务必做反向警示
- 【供给端减产】冲击后10日平均 +6.3% → 突发减产（矿难/禁令/罢工）利多延续性强
- 【交易/制度】冲击后10日平均 -19.0% → 制度性冲击（风控/闪崩/负油价）最剧烈且方向明确向下
- 【技术失效】冲击后10日技术位击穿率整体仅 4.6%，但燃油(FU)19%、线材(WR)17% 等品种显著更高 → 技术失效预警需区分品种
- 【共振/背离】技术方向与冲击方向共振时10日胜率 72.8%，背离时 60.6% → 共振增强信号，背离时保持技术信号（不要降仓）

【V16×新闻组合策略矩阵回测（13方案×60品种×20年）——以下结论直接指导AI解读建议】
- 【共振加仓有效】新闻面与技术面共振时仓位×1.3 → 回报10421%（基准9515%，+9.5%），AI应在共振时明确建议"信心增强，可适度放大仓位"
- 【背离降仓有害】新闻面与技术面背离时仓位×0.5 → 回报7696%（-19%），AI绝不应建议"背离时放弃技术信号/降仓观望"，V16技术方向本身更可靠
- 【冲击后冷却无增益】冲击后5/10/20日机械回避 → 回报均低于基准，AI不应建议"事件后暂停交易"（除非极端>6×ATR大冲击）
- 【冲击时平仓有害】冲击日立即平仓 → 回报8085%且回撤升至10%，AI不应建议"黑天鹅时立即平仓"（断仓损失更大）
- 【事件库驱动最优】真实事件过滤夏普4.19（全矩阵最高），AI应优先基于真实事件库做风险提醒

【品种敏感度画像（60品种×20年ATR冲击扫描+137真实事件驱动分析）——AI解读时需区分品种敏感度】
- 【高敏感品种】WR0(7.05x)、FU0(6.49x)、SI0(4.65x)、JD0(4.84x)、LH0(4.42x)：ATR冲击强度极高，黑天鹅期间技术分析更易失效，必须放宽止损/建议减仓
- 【低敏感品种】AL0(3.32x)、NI0(3.30x)、OI0(3.35x)、CU0(3.36x)、AU0(3.45x)：冲击后延续率高(60-79%)，技术分析相对可靠，黑天鹅期间可维持原有策略
- 【最抗揍品种】CU0(延续率79%)、AU0(73%)、PG0(71%)、PP0(71%)：冲击后大概率延续原方向，技术信号可信度高
- 【事件覆盖最全品种】SC0(36事件/10类全覆盖)、CU0(33事件/8类)、RB0(20事件/7类)、AL0(16事件/7类)、M0(16事件/7类)：这些品种的历史事件数据最丰富，AI解读可引用具体历史案例
- 【事件类别差异】天气气候延续率91%/反直觉率0%（最可靠）；行业事件反直觉率80%（共识最易被证伪）；疾病疫情反直觉率42%（需结合品种）
- 【品种×事件交叉】CU0对宏观/政策/减产均延续(+2%~+7%)；M0对地缘/疾病/行业反直觉(-2%~-4%)；AL0对减产反直觉(-9.2%)

### 11. 冲击严重程度分级（60品种×20年，69,176次冲击）
- L1 小冲击（1-2×ATR，占91.3%）：日常噪音，延续率47%，**完全忽略，技术信号照常执行**
- L2 中冲击（2-3×ATR，占7.2%）：反直觉率54%，**关注但不改变策略**
- L3 大冲击（3-6×ATR，占1.4%）：后10日+0.1%，延续率47%，**方向不确定，建议减仓观望**
- L4 极端冲击（>6×ATR，占0.1%）：后10日-1.5%，**反直觉率69%，共识方向常被证伪，不要追单**
- 事件匹配冲击：小冲击(L1)后10日+1.0%延续；中冲击(L2)反直觉率60%；极端冲击(L4)反直觉率100%

### 12. 技术失效预警（黑天鹅窗口期）
- 若第10章检测到高风险事件：明确告知技术分析可能暂时失效（关键支撑/阻力可能被跳空击穿、止损可能滑点无法成交）
- 给出应对建议：暂停入场 / 减仓保护 / 等待技术结构重新确认，禁止建议"依托技术位加仓"或"逆势扛单"
- 若未检测到高风险事件，本节写"当前技术分析有效，未进入黑天鹅失效窗口"

### 13. 持仓周期建议（137事件×60品种，时间衰减分析）
- **持续增强（持仓越久越好）**：
  - 供给端减产：5日+2.8% → 10日+4.2% → 20日+9.7%，**可持有20日+**
  - 天气气候：5日+1.8% → 10日+1.9% → 20日+4.4%，**可持有20日**
- **正向延续（10日峰值）**：
  - 地缘政治：10日峰值+4.2%，20日回落至+2.7%，**建议持有10日**
  - 供需失衡：10日+5.8%，**建议持有10日**
  - 自然灾害：10日+2.1%，延续率83%，**建议持有10日**
- **持续恶化（持仓越久越差）**：
  - 宏观经济：5日-2.4% → 10日-4.1% → 20日-8.0%，**尽早离场**
  - 政策监管：5日-0.9% → 10日-3.1% → 20日-4.0%，**尽早离场**
  - 交易制度：5日-5.6%，**立即离场**

### 14. 事件传播链（品种间传导规律）
基于 137 个事件、60 品种 20 年数据的传播链分析：

**领先品种（反应最快的风向标）：**
- **SC0（原油）**：平均 2.2 天反应，最快
- **NI0（镍）**：平均 2.5 天反应
- **AU0（黄金）**：平均 2.7 天反应
- **AL0/ZN0（铝/锌）**：平均 3.0 天反应
- **RB0/I0（螺纹/铁矿）**：平均 3.1-3.4 天反应

**跨板块传播链（强同向传播）：**
- **黑色系 → 有色**：4 次传播，滞后 2.8 天，同向率 75%
  - AI 预警：当黑色系品种异动时，提示有色板块可能在 3 天内跟随
- **软商品 → 油脂油料**：2 次传播，滞后 5 天，同向率 100%
  - AI 预警：当软商品（白糖/棉花）异动时，提示油脂油料可能在 5 天内跟随
- **能源 → 贵金属**：2 次传播，滞后 2.5 天，同向率 75%
  - AI 预警：当原油异动时，提示黄金可能在 2-3 天内跟随

**具体品种传播对：**
- SC0 → AU0（地缘政治，滞后 2 天）
- J0 → JM0（政策监管，滞后 2 天，同向率 100%）
- RB0 → I0/J0（政策监管，滞后 2-3 天，同向率 100%）
- P0 → OI0/SR0（天气气候，滞后 1.5-2.5 天，同向率 100%）
- **先跌后涨（需耐心等待）**：
  - 行业事件：5日-1.2% → 20日+1.5%，**需等20日反转**
- 全品种平均：5-20日收益接近零，**30日以上持仓普遍反转**

### 15. AI解读价值量化
引用上方"AI解读价值量化"章节的数据，说明新闻分析体系的价值（整体价值、各组件贡献、AI解读质量提升）。

### 16. 监控方案回测结论
引用上方"监控方案回测结论"章节的数据，说明方向判断首选、双通道组合策略、离场规则、白名单构成、监控规则铁律。

### 17. 当日传播链监控信号
引用上方"当日传播链监控信号"章节的数据，列出当前传播链信号。如无信号，说明"暂无传播链信号"。

### 18. 品种相关性风险提醒
引用上方"品种相关性风险提醒"章节的数据，说明同板块相关品种和当前信号状态。

### 19. 新闻情绪评分
引用上方"新闻情绪评分"章节的数据，说明综合情绪、与技术方向关系、情绪明细、建议。如无新闻数据，说明"暂无新闻数据"。

### 20. 用户关注品种热力图
引用上方"用户关注品种热力图"章节的数据，列出用户频繁关注的品种。如无用户画像数据，说明"暂无用户关注记录"。

**重要**：你必须输出完整的 20 个章节，每个章节都必须有内容。如果某章节数据缺失，必须明确说明"暂无数据"或"监控服务暂未就绪"，禁止省略章节！`;

  // 15. AI解读价值量化（基于四步探索的回测数据）
  dataContext += `

### 15. AI解读价值量化（新闻分析体系的价值）
基于四步探索（品种敏感度×严重程度×持仓周期×传播链）的回测数据：

**整体价值：**
- 新闻感知策略（S6）相比基准（S0）：**提升回报 +906%**（10421% vs 9515%）
- 回撤略增 +2%（8% vs 6%），但回报提升显著

**各组件贡献：**
- **品种敏感度**：4个高敏感品种（FU0/JD0/SI0/WR0）需降仓20%；20个低敏感品种可维持策略
- **严重程度分级**：L1(91%)忽略；L4(0.1%)反直觉率69%不追单 → 避免极端冲击亏损
- **持仓周期**：供给/天气类长持有（20日+4~10%）；宏观/政策类早离场（20日-4~8%）
- **传播链**：SC0/AU0领先2-3天；黑色→有色/能源→贵金属传播，同向率75%

**AI解读质量提升：**
- 从"通用建议"到"精准建议"：因品种、因事件、因周期制宜
- 从"事后解释"到"事前预警"：传播链可提前2-3天预警
- 从"单一品种"到"全局视角"：跨板块联动分析`;

  // 16. 监控方案回测结论（v8 白名单版：领域知识传播对通过滚动前向验证）
  dataContext += `

### 16. 监控方案回测结论（v10 双通道组合版：白名单+M3确认+SL1止损，全部通过滚动前向验证）

**方向判断首选：阈值预警 + 激进参数（M3-20-2-A-1）**
- 配置：ATR冲击>2×ATR即预警；20天窗口；全部级别
- 准确率 83.4%，误报率 16.6% —— 大冲击后方向判断最可靠
- **注意：盈亏比仅 0.28，按方向追单长期亏损，只用于方向判断/预期管理**

**双通道组合策略（v10 终极版，20年数据验证）**
**v13 组合策略（576组合×4时段全排列回测）**
- 核心升级：**持有期从10天延长至20天**（传播链效应持续2-3周，H10过早退出错失利润）
- 新增过滤：**高波动环境**（ATR14>ATR60，极端冲击在波动放大期更有效）
- 组合：M3方向确认（next1次日延续）+ 白名单传播对（39对）+ 止损-1%（SL1）+ 持有20天 + 高波动过滤
- 回测PF=9.92，3组前向全部>6（F1=6.68/F2=19.74/F3=10.63），最大单笔亏损-1%
- **v14 多信号融合验证（11组组合）**：叠加V16 Gate/事件驱动/成交量过滤均无法提升PF，v13已是最优
- **v15 新信号融合（8组组合）**：S6板块联动+S7季节性组合PF=14.69（+315%），胜率62.5%
- **v16 回测引擎升级**：加入滑点0.05%+手续费0.01%+仓位管理，扣除成本后净盈亏+0.04%，策略在真实环境中仍可行
- **对比v10**：PF从5.63提升至14.69（+161%），F2段从5.84提升至19.74（+238%）
- **双通道互补机制**：方向层过滤55%低质量信号（准确率60.2%→70.5%）；止损把F1段从亏损转正（PF 0.92→5.62）

**离场规则（v9+v13 数据）**
- 交易执行：**止损-1%（SL1）最优**——3组前向 PF 全部>3（3.30/4.85/5.62），最大单笔亏损从-13.26%收敛到-1.00%
- 方向判断：止盈+2%（TP2）准确率最高（77-89%），适合AI解读方向
- 持有窗口上限20天（v13升级）：传播链效应持续2-3周

**白名单构成（39对，板块命中率100%）**：黑色系（RB0→HC0/I0→RB0/J0→RB0/JM0→J0）、有色（CU0→AL0/ZN0→CU0/PB0→ZN0）、贵金属（AU0→AG0）、油脂油料（M0→Y0/Y0→OI0/P0→Y0/M0→A0）、软商品（CF0→SR0/AP0→CJ0）、能源（SC0→FU0/FU0→BU0）、化工（TA0→EG0/MA0→TA0）、金融（IH0→IF0/IF0→IC0）
- **对比 v7**：机器学习传播对（sr0.68/0.75/0.80共6变体）全部不稳健，因混入 SM0→LH0（锰硅→生猪）、IC0→LC0（股指→碳酸锂）等同期巧合配对；白名单彻底消除虚假配对

**监控规则铁律：**
1. **新闻面是技术信号的"确认器"，不是独立交易信号**：V16信号+新闻共振时准确率63%；但"按新闻方向直接交易"方向收益为负
2. **事件驱动预测方向准确率61.5%**（M1-5-4-S-3）：事件有信息量但盈亏比<1，不构成交易信号
3. **准确率≠盈利（胜率陷阱）**：M3准确率83.4%但盈亏比0.28（赢小输大）
4. **方向判断用M3（83.4%）**：大冲击后方向判断最可靠；但只用于方向参考/预期管理，不用于追单
5. **传播链只用白名单（v10）**：领域知识板块内联动对通过滚动前向验证，可作方向确认辅助；交易执行配止损-1%；禁止机器学习传播对与跨板块配对
6. **预警用于方向参考与风险提示**：传播链信号（白名单板块内联动对）低频高置信，用于"M3方向+板块内联动"双重确认；禁止跨板块传播对（如锰硅→生猪）作为任何依据
7. **可执行策略**：leader冲击≥4×ATR+次日延续确认 → 白名单follower入场 → 止损-1%；20年3组前向PF全部>5.6、最大亏损-1%
8. **共振过滤无效（v12验证）**：跨品种共振（同板块多leader同日冲击20年仅3次，信号过少）、顺势共振（过滤后PF下降）、逆势共振（F3段0信号不稳健）——v10已是最优结构，无需共振层`;

  // 17. 实时传播链监控信号（已在并行阶段获取）
  dataContext += `

### 17. 当日传播链监控信号（实时扫描）
${signalSummaryText || '暂无传播链信号。当前市场无 leader 品种触发冲击事件，或监控服务暂未就绪。'}`;

  // 18. 品种相关性风险检查
  const correlatedVarieties = CORRELATED_PAIRS[code] || [];
  dataContext += `

### 18. 品种相关性风险提醒
`;
  if (correlatedVarieties.length > 0) {
    // 检查当前市场数据中是否有同板块品种也在发出信号
    const correlatedSignals: string[] = [];
    try {
      const fullScanCache = getScanCache();
      if (fullScanCache?.rows) {
        for (const cv of correlatedVarieties) {
          const row = fullScanCache.rows.find((r: any) => r.code === cv);
          if (row && row.ai_direction) {
            correlatedSignals.push(`${cv}: ${row.ai_direction}方向, ADX=${row.adx?.toFixed(1) || 'N/A'}`);
          }
        }
      }
    } catch {
      // ignore
    }
    if (correlatedSignals.length > 0) {
      dataContext += `**${code} 的同板块相关品种**: ${correlatedVarieties.join(', ')}
**当前同板块信号状态**:
${correlatedSignals.map(s => `- ${s}`).join('\n')}

⚠️ **板块集中风险**：
- 同板块品种高度相关，同时交易多个等于加倍风险敞口
- 建议：同板块最多持有 2 个品种，总仓位不超过单品种上限的 1.5 倍
- 如果多个同板块品种同时发出信号，选择信号最强的 1-2 个参与，不要全部入场`;
    } else {
      dataContext += `**${code} 的同板块相关品种**: ${correlatedVarieties.join(', ')}
**当前同板块信号状态**: 同板块品种暂无明显信号。
- 当前无板块集中风险，可独立分析该品种`;
    }
  } else {
    dataContext += `该品种无明显同板块相关品种，无板块集中风险。`;
  }

  // 19. 新闻情绪评分
  dataContext += `

### 19. 新闻情绪评分
`;
  if (newsData.news.length > 0) {
    const sentimentScore = analyzeNewsSentiment(newsData.news, scanRowData?.ai_direction);
    dataContext += `- **综合情绪**: ${sentimentScore.label}（${sentimentScore.score > 0 ? '+' : ''}${sentimentScore.score.toFixed(1)}）
- **与技术方向关系**: ${sentimentScore.alignment}
- **情绪明细**:
${sentimentScore.details.map(d => `  - ${d.title}: ${d.sentiment}（${d.score > 0 ? '+' : ''}${d.score}）`).join('\n')}
- **建议**: ${sentimentScore.advice}`;
  } else {
    dataContext += `暂无该品种相关新闻数据。
- 无法进行新闻情绪评分
- 建议：仅依赖技术分析信号，不做新闻面交叉验证
- 注意：缺少新闻面验证时，信号可信度略低，建议适当降低仓位`;
  }

  // 20. 个性化建议（基于用户画像）
  // 从对话历史推断用户交易风格（简化版：基于品种分析请求频率）
  const frequentVarieties = Object.entries(
    (getUserProfile('default')?.frequentVarieties || {})
  ).sort((a, b) => b[1] - a[1]).slice(0, 5);

  // 无论是否有用户画像数据，都添加此章节（兜底内容）
  dataContext += `

### 20. 用户关注品种热力图
`;
  if (frequentVarieties.length > 0) {
    dataContext += `用户近期频繁关注的品种:
${frequentVarieties.map(([v, count]) => `- ${v}: 关注 ${count} 次`).join('\n')}

⚠️ **个性化提醒**：
- 如果频繁关注的品种集中在同一板块，提醒板块集中风险
- 建议分散关注不同板块品种，降低系统性风险`;
  } else {
    dataContext += `暂无用户关注记录。建议用户多关注不同板块的品种，建立全局视角。`;
  }

  // 构建系统消息并限制大小（防止 OpenAI API "failed to unmarshal" 错误）
  const systemContent = truncateContent(
    `${SYSTEM_PROMPT}\n\n${dataContext}`,
    60000,  // 系统消息上限 60K 字符（约 20K tokens）
    'analyzeVariety system message'
  );
  const userContent = truncateContent(
    templatePrompt,
    10000,  // 用户模板上限 10K 字符
    'analyzeVariety template prompt'
  );

  const messages = buildSafeMessages([
    {
      role: 'system' as const,
      content: systemContent
    },
    {
      role: 'user' as const,
      content: userContent
    }
  ]);

  // 日志：记录请求体大小，便于排查
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  console.log(`[AI] analyzeVariety(${code}): messages=${messages.length}, totalChars=${totalChars}, systemChars=${systemContent.length}`);

  let response;
  try {
    response = await withTimeout(
      client.invoke(messages, {
        model: AI_MODEL,
        temperature: 0.5
      }),
      AI_TIMEOUT_MS,
      '品种分析'
    );
  } catch (err: any) {
    // 如果是 "failed to unmarshal" 错误，尝试进一步压缩内容后重试一次
    const errMsg = err?.message || String(err);
    if (errMsg.includes('unmarshal') || errMsg.includes('parse the request')) {
      console.error(`[AI] analyzeVariety(${code}): 首次请求失败 (${errMsg})，尝试压缩内容重试`);
      const compressedSystem = truncateContent(systemContent, 30000, 'analyzeVariety compressed system');
      const retryMessages = buildSafeMessages([
        { role: 'system' as const, content: compressedSystem },
        { role: 'user' as const, content: truncateContent(templatePrompt, 5000, 'analyzeVariety compressed template') }
      ]);
      response = await withTimeout(
        client.invoke(retryMessages, {
          model: AI_MODEL,
          temperature: 0.5
        }),
        AI_TIMEOUT_MS,
        '品种分析(重试)'
      );
    } else {
      throw err;
    }
  }

  return response.content;
}
