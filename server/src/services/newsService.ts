/**
 * 新闻搜索服务
 * 使用 coze-coding-dev-sdk 的 web search 功能
 */

import { createHash } from 'crypto';
import { SearchClient, Config, LLMClient } from 'coze-coding-dev-sdk';

// 品种名称映射（代码 -> 中文名）
const VARIETY_NAME_MAP: Record<string, string> = {
  AU: '黄金', AG: '白银', CU: '沪铜', AL: '沪铝', ZN: '沪锌', PB: '沪铅',
  NI: '沪镍', SN: '沪锡', RU: '橡胶', FU: '燃油', BU: '沥青', HC: '热卷',
  RB: '螺纹钢', WR: '线材', SS: '不锈钢', SP: '纸浆',
  IF: '沪深300', IC: '中证500', IH: '上证50', IM: '中证1000',
  SC: '原油', NR: '20号胶', LU: '低硫燃油', BC: '国际铜',
  CF: '棉花', CY: '棉纱', SR: '白糖', TA: 'PTA', MA: '甲醇',
  OI: '菜油', RM: '菜粕', AP: '苹果', CJ: '红枣', SA: '纯碱',
  PF: '短纤', PK: '花生', UI: '尿素', FG: '玻璃', ZC: '动力煤',
  SF: '硅铁', SM: '锰硅',
  M: '豆粕', Y: '豆油', A: '豆一', B: '豆二', P: '棕榈油',
  C: '玉米', CS: '淀粉', JD: '鸡蛋', L: '塑料', V: 'PVC',
  PP: '聚丙烯', EB: '苯乙烯', EG: '乙二醇', PG: 'LPG',
  LH: '生猪',
};

// 品种别名映射（代码前缀 -> 别名数组），用于提升 inferVarieties 的召回率
// 注意：别名需足够具体，避免误匹配（如不用单字"铜""油"）
const VARIETY_ALIASES: Record<string, string[]> = {
  AU: ['金价', '伦敦金'],
  AG: ['银价', '伦敦银'],
  CU: ['铜价', '电解铜', '伦铜', 'LME铜'],
  AL: ['铝价', '电解铝', '伦铝'],
  ZN: ['锌价', '伦锌'],
  NI: ['镍价', '伦镍'],
  SN: ['锡价', '伦锡'],
  SC: ['油价', '石油', 'WTI', '布伦特', 'OPEC', '欧佩克'],
  RB: ['钢材', '螺纹'],
  HC: ['热轧'],
  RU: ['天胶', '天然橡胶'],
  M: ['美豆'],
  P: ['马棕'],
  JD: ['蛋价'],
  LH: ['猪肉', '猪价'],
  CF: ['美棉'],
  SR: ['食糖', '原糖'],
  OI: ['菜籽油'],
  FG: ['浮法玻璃'],
  SA: ['重碱'],
};

export interface NewsItem {
  title: string;
  source: string;
  url: string;
  snippet: string;
  publishTime?: string;
}

export interface NewsSearchResult {
  variety: string;
  varietyName: string;
  news: NewsItem[];
  summary?: string;
}

/**
 * 搜索品种相关新闻
 */
export async function searchVarietyNews(code: string): Promise<NewsSearchResult> {
  // 提取品种代码前缀（去掉数字后缀）
  const prefix = code.replace(/\d+$/, '');
  const varietyName = VARIETY_NAME_MAP[prefix] || prefix;

  const config = new Config();
  const client = new SearchClient(config);

  try {
    // 搜索品种最新新闻（含风险事件导向词，兼顾常规消息与突发政策/事件）
    const query = `${varietyName} 期货 最新消息 政策 突发 事件 行情分析`;
    const response = await client.webSearch(query, 8, true);

    const news: NewsItem[] = [];
    if (response.web_items) {
      for (const item of response.web_items) {
        news.push({
          title: item.title || '',
          source: item.site_name || '未知来源',
          url: item.url || '',
          snippet: item.snippet || '',
          publishTime: item.publish_time,
        });
      }
    }

    return {
      variety: code,
      varietyName,
      news,
      summary: response.summary,
    };
  } catch (error) {
    console.error(`[NewsService] 搜索 ${varietyName} 新闻失败:`, error);
    return {
      variety: code,
      varietyName,
      news: [],
      summary: undefined,
    };
  }
}

/**
 * 搜索市场热点新闻（多源聚合）
 * 使用多个搜索查询覆盖不同维度，提升事件检测覆盖率
 */
export async function searchMarketNews(): Promise<{ news: NewsItem[]; summary?: string }> {
  const config = new Config();
  const client = new SearchClient(config);

  // 多维度搜索查询，覆盖更广泛的事件类型
  const queries = [
    '期货市场 今日要闻 大宗商品 宏观经济',
    '原油 黄金 铜 价格 行情',
    '央行 利率 货币政策 通胀',
    '供需 库存 减产 停产',
    '天气 灾害 疫情 地缘政治',
  ];

  try {
    const allNews: NewsItem[] = [];
    const seenUrls = new Set<string>();
    let summaryText = '';

    // 并行执行多个搜索查询
    const searchPromises = queries.map(query =>
      client.webSearch(query, 10, true).catch(err => {
        console.error(`[NewsService] 搜索 "${query}" 失败:`, err);
        return null;
      })
    );

    const results = await Promise.all(searchPromises);

    for (const response of results) {
      if (!response?.web_items) continue;

      // 收集摘要（取第一个有摘要的）
      if (!summaryText && response.summary) {
        summaryText = response.summary;
      }

      for (const item of response.web_items) {
        const url = item.url || '';
        // 去重：同一 URL 只保留一次
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);

        allNews.push({
          title: item.title || '',
          source: item.site_name || '未知来源',
          url: url,
          snippet: item.snippet || '',
          publishTime: item.publish_time,
        });
      }
    }

    // 按发布时间倒序排列
    allNews.sort((a, b) => {
      const ta = a.publishTime || '';
      const tb = b.publishTime || '';
      return tb.localeCompare(ta);
    });

    console.log(`[NewsService] 多源新闻聚合完成: ${allNews.length} 条 (去重后)`);

    return {
      news: allNews,
      summary: summaryText,
    };
  } catch (error) {
    console.error('[NewsService] 搜索市场新闻失败:', error);
    return { news: [] };
  }
}

/**
 * 将新闻数据格式化为 AI 上下文
 */
export function formatNewsForContext(newsResult: NewsSearchResult): string {
  if (!newsResult.news || newsResult.news.length === 0) {
    return '【新闻数据】暂无相关新闻';
  }

  let context = `【${newsResult.varietyName}(${newsResult.variety})相关新闻】\n`;
  for (const item of newsResult.news.slice(0, 5)) {
    context += `- ${item.title} (${item.source})\n`;
    if (item.snippet) {
      context += `  ${item.snippet.slice(0, 100)}...\n`;
    }
  }
  if (newsResult.summary) {
    context += `\n【新闻摘要】${newsResult.summary.slice(0, 200)}`;
  }
  return context;
}

// ========== 方案C：实时新闻接入 - 事件检测 + 传播链联动 ==========

import type { BlackSwanEvent } from '../data/blackswanEvents.js';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist.js';

/**
 * 事件检测结果
 */
export interface DetectedEvent {
  event: BlackSwanEvent;
  matchedNews: NewsItem[];
  confidence: number; // 0-1，匹配置信度
  affectedVarieties: string[];
  propagationAlerts?: PropagationAlert[];
}

export interface PropagationAlert {
  leader: string;
  follower: string;
  direction: '利多' | '利空';
  sector: string;
  logic: string;
  lag: number;
}

/**
 * 事件关键词映射（用于从新闻标题/内容中匹配事件类别）
 */
// 事件类别名称（与 blackswanEvents.ts 的 category 编号一致）
const CATEGORY_NAMES: Record<number, string> = {
  1: '地缘政治',
  2: '宏观经济/金融',
  3: '政策监管',
  4: '天气/气候',
  5: '自然灾害',
  6: '疾病/疫情',
  7: '供给端减产',
  8: '供需失衡/库存',
  9: '产业/技术变革',
  10: '交易/制度',
};

const EVENT_KEYWORDS: Record<number, string[]> = {
  1: ['战争', '冲突', '制裁', '贸易战', '关税', '地缘', '军事', '导弹', '袭击'], // 地缘政治
  2: ['央行', '利率', '加息', '降息', '货币政策', '通胀', 'CPI', 'GDP', '经济数据', '金融危机', '股灾', '流动性', '信贷'], // 宏观经济/金融
  3: ['政策', '监管', '发改委', '限制', '配额', '禁运', '产业政策', '管控', '调控'], // 政策监管
  4: ['天气', '气温', '降雨', '干旱', '洪涝', '寒潮', '台风', '飓风', '气候', '极端天气'], // 天气/气候
  5: ['地震', '海啸', '洪水', '山火', '灾害', '灾情'], // 自然灾害
  6: ['疫情', '病毒', '猪瘟', '禽流感', '非瘟', '流行病', '传染'], // 疾病/疫情
  7: ['减产', '停产', '检修', '事故', '爆炸', '火灾', '供应中断', '缺货', '罢工', '限产'], // 供给端减产
  8: ['库存', '仓单', '交割', '现货', '升水', '贴水', '供需', '需求旺盛', '需求疲软', '过剩', '紧缺'], // 供需失衡/库存
  9: ['技术', '新能源', '替代', '产业升级', '颠覆', '创新', '突破', '新工艺'], // 产业/技术变革
  10: ['交易规则', '保证金', '涨跌停', '制度', '手续费', '交割规则', '监管新规'], // 交易/制度
};

/**
 * 事件类型 → 默认影响品种（领域知识映射）
 * 当新闻文本中无法直接识别出品种名时，按事件类型兜底映射到关联品种，
 * 用于提升品种映射召回率（对应回测中召回率偏低的瓶颈）。
 */
const EVENT_CATEGORY_VARIETIES: Record<number, string[]> = {
  1: ['SC0', 'AU0', 'AG0'],          // 地缘政治：能源 + 贵金属避险
  2: ['CU0', 'SC0', 'AU0'],          // 宏观经济：铜（宏观晴雨表）+ 原油 + 黄金
  3: ['RB0', 'CU0', 'SC0'],          // 政策监管：黑色 + 有色 + 能化
  4: ['M0', 'C0', 'CF0', 'ZC0'],     // 天气气候：农产品 + 动力煤
  5: ['RU0', 'CU0', 'SC0', 'ZC0'],   // 自然灾害：橡胶 + 铜 + 原油 + 动力煤
  6: ['SC0', 'CU0', 'LH0', 'M0'],    // 疾病疫情：原油 + 铜 + 生猪 + 豆粕
  7: ['RB0', 'HC0', 'SC0', 'CU0'],   // 供给减产：黑色 + 能化 + 有色
  8: ['RB0', 'CU0', 'SC0'],          // 供需库存：黑色 + 有色 + 能化
  9: ['LC0', 'SI0', 'NI0'],          // 产业技术：锂 + 硅 + 镍（新能源）
  10: ['RB0', 'SC0'],                // 交易制度：代表性品种
};

/**
 * 推断事件方向（利多/利空/中性）
 */
export function inferDirection(category: number, text: string): '利多' | '利空' | '中性' {
  const lower = text.toLowerCase();

  // 利空词：价格下行、需求萎缩、流动性收紧、供给扩张
  const bearish = [
    '暴跌', '下跌', '利空', '崩盘', '过剩', '需求疲软', '需求萎缩',
    '需求受损', '需求下降', '需求回落', '消费下降', '消费萎缩',
    '危机', '收紧', '加息', '贸易战', '抛储', '放储', '增产', '复产',
    '累库', '库存增加', '仓单增加', '出口下降',
  ];

  // 利多词：价格上行、需求增长、流动性宽松、供给收缩
  const bullish = [
    '暴涨', '上涨', '利多', '涨价', '紧缺', '需求旺盛', '需求增长',
    '需求急增', '需求拉动', '复苏', '宽松', '降息', '减产', '停产',
    '限产', '检修', '供应中断', '供给中断', '供给收缩', '供给减少',
    '关停', '缺货', '罢工',
    '收储', '国储', '禁运', '配额', '去库', '库存下降', '限制进口',
    '重建', '灾后重建',
  ];

  const bearishCount = bearish.filter(kw => lower.includes(kw)).length;
  const bullishCount = bullish.filter(kw => lower.includes(kw)).length;

  // 供给端减产类（category 7）：供给收缩默认利多
  if (category === 7 && bearishCount === 0 && bullishCount === 0) return '利多';
  // 天气/气候类（category 4）：极端天气冲击供给，默认利多（农产品/能源）
  if (category === 4 && bearishCount === 0 && bullishCount === 0) return '利多';
  // 自然灾害类（category 5）：供给端/需求端冲击方向各半，默认中性，仅在有明确方向词时判定
  if (bearishCount > bullishCount) return '利空';
  if (bullishCount > bearishCount) return '利多';
  return '中性';
}

/**
 * 从新闻文本中推断涉及的品种代码
 */
export function inferVarieties(text: string): string[] {
  const varieties: string[] = [];
  const lowerText = text.toLowerCase();
  for (const [code, name] of Object.entries(VARIETY_NAME_MAP)) {
    // 主名匹配（中文名不受大小写影响）
    if (text.includes(name)) {
      varieties.push(`${code}0`);
      continue;
    }
    // 别名匹配（英文别名统一小写后匹配）
    const aliases = VARIETY_ALIASES[code];
    if (aliases && aliases.some(a => lowerText.includes(a.toLowerCase()))) {
      varieties.push(`${code}0`);
    }
  }
  return Array.from(new Set(varieties));
}

/**
 * 从新闻中检测黑天鹅事件
 *
 * 逻辑：按事件类别聚合当前新闻，从新闻标题实时生成"当前事件"，
 * 不再直接引用历史事件库（避免展示"雷曼兄弟倒闭"等过期事件）。
 * 历史事件库仅用于 generatePropagationAlerts 中查找同类历史参考。
 */
export function detectEventsFromNews(news: NewsItem[]): DetectedEvent[] {
  const detected: DetectedEvent[] = [];
  const today = new Date().toISOString().split('T')[0];

  for (const [categoryStr, keywords] of Object.entries(EVENT_KEYWORDS)) {
    const category = parseInt(categoryStr, 10);
    const matchedNews: NewsItem[] = [];

    for (const item of news) {
      const text = `${item.title} ${item.snippet}`.toLowerCase();
      const matchCount = keywords.filter(kw => text.includes(kw.toLowerCase())).length;
      if (matchCount > 0) {
        matchedNews.push(item);
      }
    }

    if (matchedNews.length === 0) continue;

    const categoryName = CATEGORY_NAMES[category] || '未知类别';
    const primaryNews = matchedNews[0];
    const confidence = Math.min(1, matchedNews.length / Math.max(1, keywords.length / 2));
    const combinedText = matchedNews.map(n => `${n.title} ${n.snippet}`).join(' ');
    const direction = inferDirection(category, combinedText);
    const detectedVarieties = inferVarieties(combinedText);
    const affectedVarieties = detectedVarieties.length > 0
      ? detectedVarieties
      : (EVENT_CATEGORY_VARIETIES[category] || []);

    // 从新闻标题生成"当前事件"，使用内容哈希作为ID（确保同一新闻在不同扫描中生成相同ID）
    // 不包含 category，避免同一新闻匹配多个类别时生成多个事件
    const titleHash = createHash('sha256').update(primaryNews.title || '').digest('hex').slice(0, 24);
    const currentEvent: BlackSwanEvent = {
      id: `live-${titleHash}`,
      date: today,
      category,
      categoryName,
      title: primaryNews.title || `${categoryName}相关新闻`,
      varieties: affectedVarieties,
      direction,
      consensus: `根据近期新闻检测到${categoryName}类信号，共匹配 ${matchedNews.length} 条相关新闻`,
      note: primaryNews.snippet || undefined,
    };

    detected.push({
      event: currentEvent,
      matchedNews,
      confidence,
      affectedVarieties,
    });
  }

  // 同一新闻匹配多个类别时会生成 id 相同的事件，按 event.id 去重，保留置信度最高的一个
  const seen = new Map<string, DetectedEvent>();
  for (const item of detected) {
    const existing = seen.get(item.event.id);
    if (!existing || item.confidence > existing.confidence) {
      seen.set(item.event.id, item);
    }
  }

  // 按置信度排序
  return Array.from(seen.values()).sort((a, b) => b.confidence - a.confidence);
}

/**
 * 根据检测到的事件生成传播链预警
 */
/**
 * 传播链白名单最低 hr 阈值：低于此值的传播对视为噪声，不生成预警。
 * 基于 20 年日线回测，hr < 0.6 的跟随对可靠性不足以下交易决策。
 */
const PROPAGATION_HR_THRESHOLD = 0.6;

export function generatePropagationAlerts(detectedEvents: DetectedEvent[]): PropagationAlert[] {
  const alerts: PropagationAlert[] = [];

  for (const de of detectedEvents) {
    const event = de.event;
    const direction = event.direction === '利多' ? '利多' : '利空';
    
    // 找出事件中涉及的品种作为 leader
    for (const leaderCode of event.varieties) {
      // 在白名单中查找以该品种为 leader 的传播对（按 hr 阈值过滤噪声）
      for (const pair of PROPAGATION_WHITELIST) {
        if (pair.leader === leaderCode && pair.hr >= PROPAGATION_HR_THRESHOLD) {
          alerts.push({
            leader: pair.leader,
            follower: pair.follower,
            direction,
            sector: pair.sector,
            logic: pair.logic,
            lag: pair.lag,
          });
        }
      }
    }
  }

  // 去重
  const uniqueAlerts: PropagationAlert[] = [];
  const seen = new Set<string>();
  for (const alert of alerts) {
    const key = `${alert.leader}-${alert.follower}-${alert.direction}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueAlerts.push(alert);
    }
  }

  return uniqueAlerts;
}

/**
 * 完整的新闻扫描流程：搜索新闻 -> 检测事件 -> 生成传播链预警
 */
export async function scanNewsForEvents(): Promise<{
  news: NewsItem[];
  detectedEvents: DetectedEvent[];
  propagationAlerts: PropagationAlert[];
  scanTime: string;
}> {
  // 1. 搜索市场热点新闻
  const marketNews = await searchMarketNews();
  
  // 2. 检测黑天鹅事件
  const detectedEvents = detectEventsFromNews(marketNews.news);
  
  // 3. 生成传播链预警
  const propagationAlerts = generatePropagationAlerts(detectedEvents);

  return {
    news: marketNews.news,
    detectedEvents,
    propagationAlerts,
    scanTime: new Date().toISOString(),
  };
}

// ========== AI 深度解读 ==========

const NEWS_AI_MODEL = process.env.AI_MODEL || 'doubao-seed-2-0-lite-260215';
const NEWS_AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS) || 60000;

/**
 * 新闻 AI 解读结果
 */
export interface NewsInterpretation {
  interpretation: string;       // LLM 深度解读文本
  direction: '利多' | '利空' | '中性';
  affectedVarieties: string[];
  detectedEvents: DetectedEvent[];
  generatedAt: string;
}

/**
 * 对新闻进行 AI 深度解读
 * 结合结构化事件检测 + LLM 文本生成，提供可操作的市场解读
 */
export async function generateNewsInterpretation(
  news: NewsItem[],
  varietyCode?: string
): Promise<NewsInterpretation> {
  // 1. 结构化事件检测
  const detectedEvents = detectEventsFromNews(news);

  // 2. 组装新闻文本供 LLM 分析
  const newsText = news
    .slice(0, 10)
    .map((item, i) => `${i + 1}. ${item.title}（${item.source}）\n   ${(item.snippet || '').slice(0, 120)}`)
    .join('\n');

  const eventText = detectedEvents.length > 0
    ? detectedEvents.slice(0, 5).map((e) =>
        `- ${e.event.title}（${e.event.categoryName}，${e.event.direction}，置信度 ${(e.confidence * 100).toFixed(0)}%）`
      ).join('\n')
    : '未检测到明确的黑天鹅事件模板匹配';

  const varietyHint = varietyCode ? `\n\n注意：请重点围绕品种「${varietyCode}」给出针对性解读。` : '';

  const prompt = `你是 Brooks，一名专业的期货市场分析师。请对以下最新市场新闻进行深度解读。

【新闻列表】
${newsText || '暂无新闻'}

【检测到的事件】
${eventText}${varietyHint}

请按以下结构输出解读（简洁中文，共 300 字以内）：
1. 核心驱动：当前市场最主要的利多/利空因素是什么？
2. 品种影响：哪些期货品种会受影响，方向如何？
3. 交易提示：给出可操作的建议（做多/做空/观望），并说明关键风控点。`;

  // 3. 调用 LLM 生成深度解读（带超时兜底）
  let interpretation = '';
  try {
    const config = new Config();
    const client = new LLMClient(config);
    const response = await Promise.race([
      client.invoke(
        [
          {
            role: 'system',
            content:
              '你是一名严谨的期货市场分析师。解读必须基于给定新闻，不得编造数据；无法判断时明确说明不确定性。',
          },
          { role: 'user', content: prompt },
        ],
        { model: NEWS_AI_MODEL, temperature: 0.4 }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`新闻AI解读超时（>${Math.round(NEWS_AI_TIMEOUT_MS / 1000)}s）`)),
          NEWS_AI_TIMEOUT_MS
        )
      ),
    ]);
    interpretation = response.content;
  } catch (error) {
    console.error('[NewsService] AI 解读失败:', error);
    interpretation = 'AI 解读暂时不可用，请稍后重试。当前已基于关键词完成事件检测（见下方事件列表）。';
  }

  // 4. 汇总方向与影响品种
  const direction: '利多' | '利空' | '中性' =
    detectedEvents.length > 0
      ? detectedEvents[0].event.direction === '利多'
        ? '利多'
        : '利空'
      : '中性';

  const affectedVarieties = Array.from(
    new Set(detectedEvents.flatMap((e) => e.affectedVarieties))
  );

  return {
    interpretation,
    direction,
    affectedVarieties,
    detectedEvents,
    generatedAt: new Date().toISOString(),
  };
}

// ========== 逐条事件/预警 AI 交易建议 ==========

/**
 * 单条事件的 AI 交易建议
 */
export interface EventTradeAdvice {
  eventId: string;              // 对应 DetectedEvent.event.id
  eventTitle: string;
  direction: '利多' | '利空' | '中性';
  varieties: string[];
  advice: string;               // 可操作建议：做多/做空/观望 + 介入方式
  riskHint: string;             // 关键风控点
}

/**
 * 单条传播链预警的 AI 交易建议
 */
export interface AlertTradeAdvice {
  key: string;                  // `${leader}-${follower}-${direction}`
  leader: string;
  follower: string;
  direction: '利多' | '利空';
  advice: string;               // 跟随建议 + 持有天数
  riskHint: string;             // 止损/仓位提示
}

/**
 * 逐条事件/预警 AI 交易建议集合
 */
export interface NewsTradeAdvices {
  eventAdvices: EventTradeAdvice[];
  alertAdvices: AlertTradeAdvice[];
  generatedAt: string;
}

/**
 * 规则兜底：根据事件方向生成默认交易建议
 */
function buildFallbackEventAdvice(de: DetectedEvent): string {
  const varietyText = de.affectedVarieties.length > 0 ? de.affectedVarieties.join('、') : '相关品种';
  if (de.event.direction === '利多') {
    return `事件偏利多，关注 ${varietyText} 回踩企稳后的做多机会，避免追高。`;
  }
  if (de.event.direction === '利空') {
    return `事件偏利空，关注 ${varietyText} 反弹乏力后的做空机会，避免盲目抄底。`;
  }
  return `事件方向不明朗，建议对 ${varietyText} 保持观望，等待信号进一步明确。`;
}

/**
 * 规则兜底：根据传播链预警生成默认交易建议
 */
function buildFallbackAlertAdvice(a: PropagationAlert): string {
  const dirText = a.direction === '利多' ? '做多' : '做空';
  return `${a.leader} 已现${a.direction}冲击，关注 ${a.follower} 滞后 ${a.lag} 天${dirText}跟随的机会。`;
}

/**
 * 从 LLM 输出中稳健地提取 JSON 对象
 */
function extractJsonFromText(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 为每个事件/预警生成一条 AI 交易建议
 * 采用一次 LLM 调用输出结构化 JSON，失败时降级为规则兜底（不阻塞主流程）
 */
export async function generateNewsTradeAdvices(
  detectedEvents: DetectedEvent[],
  propagationAlerts: PropagationAlert[]
): Promise<NewsTradeAdvices> {
  const generatedAt = new Date().toISOString();

  // 规则兜底建议（始终生成，LLM 失败时直接使用）
  const fallbackEventAdvices: EventTradeAdvice[] = detectedEvents.map((de) => ({
    eventId: de.event.id,
    eventTitle: de.event.title,
    direction: de.event.direction,
    varieties: de.affectedVarieties,
    advice: buildFallbackEventAdvice(de),
    riskHint: '关注事件后续发酵，控制仓位，严格设置止损。',
  }));

  const fallbackAlertAdvices: AlertTradeAdvice[] = propagationAlerts.map((a) => ({
    key: `${a.leader}-${a.follower}-${a.direction}`,
    leader: a.leader,
    follower: a.follower,
    direction: a.direction,
    advice: buildFallbackAlertAdvice(a),
    riskHint: '跟随品种滞后联动，建议轻仓试单，跌破 leader 冲击起点止损。',
  }));

  if (detectedEvents.length === 0 && propagationAlerts.length === 0) {
    return { eventAdvices: [], alertAdvices: [], generatedAt };
  }

  const eventText = detectedEvents
    .map((e, i) => `[事件${i}] id=${e.event.id} 标题=${e.event.title} 方向=${e.event.direction} 影响品种=${e.affectedVarieties.join('/') || '无'}`)
    .join('\n');
  const alertText = propagationAlerts
    .map((a, i) => `[预警${i}] key=${a.leader}-${a.follower}-${a.direction} leader=${a.leader} follower=${a.follower} 方向=${a.direction} 板块=${a.sector} 逻辑=${a.logic} 滞后=${a.lag}天`)
    .join('\n');

  const prompt = `你是 Brooks，一名专业的期货交易分析师。请针对以下事件与传播链预警，逐条给出简洁、可操作的交易建议。

【事件列表】
${eventText || '无'}

【传播链预警列表】
${alertText || '无'}

请只输出一个 JSON 对象，不要输出任何解释文字，格式如下：
{"eventAdvices":[{"eventId":"对应事件id","eventTitle":"事件标题","direction":"利多或利空或中性","varieties":["品种代码"],"advice":"1-2句可操作建议","riskHint":"1句关键风控点"}],"alertAdvices":[{"key":"leader-follower-方向","leader":"leader代码","follower":"follower代码","direction":"利多或利空","advice":"1-2句跟随建议","riskHint":"1句止损/仓位提示"}]}

要求：
1. eventAdvices 必须覆盖上面每个事件，eventId 与之一一对应。
2. alertAdvices 必须覆盖上面每条预警，key 与之一一对应。
3. advice 必须包含明确的方向动作（做多/做空/观望）和介入方式，不得含糊。
4. 内容基于给定信息，不得编造数据。`;

  try {
    const config = new Config();
    const client = new LLMClient(config);
    const response = await Promise.race([
      client.invoke(
        [
          {
            role: 'system',
            content: '你是一名严谨的期货交易分析师，只输出合法 JSON，不得编造数据。',
          },
          { role: 'user', content: prompt },
        ],
        { model: NEWS_AI_MODEL, temperature: 0.3 }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`新闻AI逐条建议超时（>${Math.round(NEWS_AI_TIMEOUT_MS / 1000)}s）`)),
          NEWS_AI_TIMEOUT_MS
        )
      ),
    ]);

    const parsed = extractJsonFromText(response.content);
    if (parsed) {
      const llmEventAdvices = Array.isArray(parsed.eventAdvices) ? (parsed.eventAdvices as EventTradeAdvice[]) : [];
      const llmAlertAdvices = Array.isArray(parsed.alertAdvices) ? (parsed.alertAdvices as AlertTradeAdvice[]) : [];

      // 合并策略：以 LLM 结果为主，缺失的条目用规则兜底补全
      const eventMap = new Map(fallbackEventAdvices.map((a) => [a.eventId, a]));
      for (const adv of llmEventAdvices) {
        if (adv && typeof adv.eventId === 'string') {
          eventMap.set(adv.eventId, {
            eventId: adv.eventId,
            eventTitle: adv.eventTitle || '',
            direction: adv.direction || '中性',
            varieties: Array.isArray(adv.varieties) ? adv.varieties : [],
            advice: adv.advice || '暂无建议',
            riskHint: adv.riskHint || '',
          });
        }
      }

      const alertMap = new Map(fallbackAlertAdvices.map((a) => [a.key, a]));
      for (const adv of llmAlertAdvices) {
        if (adv && typeof adv.key === 'string') {
          alertMap.set(adv.key, {
            key: adv.key,
            leader: adv.leader || '',
            follower: adv.follower || '',
            direction: adv.direction === '利空' ? '利空' : '利多',
            advice: adv.advice || '暂无建议',
            riskHint: adv.riskHint || '',
          });
        }
      }

      return {
        eventAdvices: Array.from(eventMap.values()),
        alertAdvices: Array.from(alertMap.values()),
        generatedAt,
      };
    }
  } catch (error) {
    console.error('[NewsService] AI 逐条交易建议生成失败:', error);
  }

  return { eventAdvices: fallbackEventAdvices, alertAdvices: fallbackAlertAdvices, generatedAt };
}

// ========== 逐条新闻 AI 解读 ==========

/**
 * 单条新闻的 AI 解读
 */
export interface NewsItemInterpretation {
  newsTitle: string;
  url: string;
  direction: '利多' | '利空' | '中性';
  affectedVarieties: string[];
  impact: '高' | '中' | '低';
  interpretation: string;   // 1-2 句解读
  tradeHint: string;        // 可操作提示 + 风控
}

/**
 * 规则兜底：根据新闻标题/摘要判断方向
 */
function buildFallbackNewsInterpretation(item: NewsItem): NewsItemInterpretation {
  const text = `${item.title} ${item.snippet || ''}`.toLowerCase();
  const bearish = ['暴跌', '下跌', '利空', '崩盘', '过剩', '需求疲软', '减产', '停产', '灾害', '疫情', '病毒', '危机', '制裁', '贸易战', '收紧', '加息', '下调'];
  const bullish = ['暴涨', '上涨', '利多', '紧缺', '需求旺盛', '增产', '复苏', '宽松', '降息', '涨价', '上调'];

  const bearishCount = bearish.filter(kw => text.includes(kw.toLowerCase())).length;
  const bullishCount = bullish.filter(kw => text.includes(kw.toLowerCase())).length;

  let direction: '利多' | '利空' | '中性' = '中性';
  if (bearishCount > bullishCount) direction = '利空';
  else if (bullishCount > bearishCount) direction = '利多';

  const affectedVarieties = inferVarieties(text);

  return {
    newsTitle: item.title,
    url: item.url,
    direction,
    affectedVarieties,
    impact: '低',
    interpretation: direction === '中性'
      ? '该新闻方向性信号不强，对期货市场影响有限，建议保持观望。'
      : `该新闻整体偏${direction}，可能对相关品种带来${direction === '利多' ? '上行' : '下行'}扰动，需结合盘面进一步确认。`,
    tradeHint: '消息面扰动较大，建议轻仓或观望，等待信号明确后再操作。',
  };
}

/**
 * 从 LLM 输出中稳健地提取 JSON 数组
 */
function extractJsonArrayFromText(text: string): unknown[] | null {
  if (!text) return null;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 为每条新闻生成一条 AI 解读（方向 + 影响品种 + 可操作提示）
 * 一次 LLM 调用输出结构化 JSON，失败时降级为规则兜底（不阻塞主流程）
 */
export async function generateNewsItemInterpretations(
  news: NewsItem[]
): Promise<NewsItemInterpretation[]> {
  if (news.length === 0) return [];

  // 规则兜底（始终生成，LLM 失败时直接使用）
  const fallback = news.map((item) => buildFallbackNewsInterpretation(item));

  const newsText = news
    .map((item, i) => `[新闻${i}] 标题=${item.title} 来源=${item.source} 摘要=${(item.snippet || '').slice(0, 120)}`)
    .join('\n');

  const prompt = `你是 Brooks，一名专业的期货市场分析师。请逐条解读以下市场新闻，判断其对期货品种的影响。

【新闻列表】
${newsText}

请只输出一个 JSON 数组，不要输出任何解释文字，格式如下：
[{"newsTitle":"新闻标题","url":"原文链接","direction":"利多或利空或中性","affectedVarieties":["影响的品种代码"],"impact":"高或中或低","interpretation":"1-2句解读","tradeHint":"1句可操作提示与风控"}]

要求：
1. 数组长度必须等于新闻条数，与输入顺序一一对应。
2. newsTitle 必须与输入标题完全一致，url 保持不变。
3. direction 为利多/利空/中性，impact 为高/中/低。
4. affectedVarieties 仅填写确实受影响的期货品种代码（如 AU0、CU0），无则空数组。
5. 内容基于给定新闻，不得编造数据；无法判断方向时填中性。`;

  try {
    const config = new Config();
    const client = new LLMClient(config);
    const response = await Promise.race([
      client.invoke(
        [
          {
            role: 'system',
            content: '你是一名严谨的期货市场分析师，只输出合法 JSON 数组，不得编造数据。',
          },
          { role: 'user', content: prompt },
        ],
        { model: NEWS_AI_MODEL, temperature: 0.3 }
      ),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`新闻AI逐条解读超时（>${Math.round(NEWS_AI_TIMEOUT_MS / 1000)}s）`)),
          NEWS_AI_TIMEOUT_MS
        )
      ),
    ]);

    const parsed = extractJsonArrayFromText(response.content);
    if (parsed && Array.isArray(parsed)) {
      const result: NewsItemInterpretation[] = [];
      for (let i = 0; i < news.length; i++) {
        const fb = fallback[i];
        const llm = (parsed as Array<Record<string, unknown>>)[i];
        if (llm && typeof llm === 'object') {
          result.push({
            newsTitle: fb.newsTitle,
            url: fb.url,
            direction: llm.direction === '利多' || llm.direction === '利空' || llm.direction === '中性' ? llm.direction : fb.direction,
            affectedVarieties: Array.isArray(llm.affectedVarieties) ? (llm.affectedVarieties as string[]) : fb.affectedVarieties,
            impact: llm.impact === '高' || llm.impact === '中' || llm.impact === '低' ? llm.impact : fb.impact,
            interpretation: typeof llm.interpretation === 'string' && llm.interpretation ? llm.interpretation : fb.interpretation,
            tradeHint: typeof llm.tradeHint === 'string' && llm.tradeHint ? llm.tradeHint : fb.tradeHint,
          });
        } else {
          result.push(fb);
        }
      }
      return result;
    }
  } catch (error) {
    console.error('[NewsService] AI 逐条新闻解读生成失败:', error);
  }

  return fallback;
}
