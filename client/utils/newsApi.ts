import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
/**
 * 方案C：实时新闻接入 API 工具
 */

const BASE_URL = BACKEND_BASE;

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  snippet?: string;
  publishedAt?: string;
}

export interface DetectedEvent {
  event: {
    id: string;
    title: string;
    categoryName: string;
    direction: '利多' | '利空';
    varieties: string[];
  };
  matchedNews: NewsItem[];
  confidence: number;
  affectedVarieties: string[];
}

export interface PropagationAlert {
  leader: string;
  follower: string;
  direction: '利多' | '利空';
  sector: string;
  logic: string;
  lag: number;
}

export interface NewsScanResult {
  news: NewsItem[];
  detectedEvents: DetectedEvent[];
  propagationAlerts: PropagationAlert[];
  scanTime: string;
}

export interface NewsInterpretation {
  interpretation: string;
  direction: '利多' | '利空' | '中性';
  affectedVarieties: string[];
  detectedEvents: DetectedEvent[];
  generatedAt: string;
}

/**
 * 完整新闻扫描：搜索新闻 -> 检测事件 -> 生成传播链预警
 */
export async function fetchNewsScan(): Promise<NewsScanResult> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/scan`);
  if (!response.ok) {
    throw new Error(`新闻扫描失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '新闻扫描失败');
  }
  return data.data;
}

/**
 * 获取最新新闻
 */
export async function fetchLatestNews(): Promise<{
  news: NewsItem[];
  summary: string;
  fetchTime: string;
}> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/latest`);
  if (!response.ok) {
    throw new Error(`获取新闻失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取新闻失败');
  }
  return data.data;
}

/**
 * 获取新闻的 AI 深度解读
 */
export async function fetchNewsInterpretation(variety?: string): Promise<NewsInterpretation> {
  const query = variety ? `?variety=${encodeURIComponent(variety)}` : '';
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/interpretation${query}`, {}, 60000);
  if (!response.ok) {
    throw new Error(`获取AI解读失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取AI解读失败');
  }
  return data.data;
}

export interface EventTradeAdvice {
  eventId: string;
  eventTitle: string;
  direction: '利多' | '利空' | '中性';
  varieties: string[];
  advice: string;
  riskHint: string;
}

export interface AlertTradeAdvice {
  key: string;
  leader: string;
  follower: string;
  direction: '利多' | '利空';
  advice: string;
  riskHint: string;
}

export interface NewsTradeAdvices {
  eventAdvices: EventTradeAdvice[];
  alertAdvices: AlertTradeAdvice[];
  generatedAt: string;
}

/**
 * 为每个事件/预警生成一条 AI 交易建议
 * 服务端文件：server/src/routes/news.ts
 * 接口：POST /api/v1/news/trade-advices
 * Body 参数：detectedEvents: DetectedEvent[], propagationAlerts: PropagationAlert[]
 */
export async function fetchNewsTradeAdvices(
  detectedEvents: DetectedEvent[],
  propagationAlerts: PropagationAlert[]
): Promise<NewsTradeAdvices> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/trade-advices`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detectedEvents, propagationAlerts }),
  }, 60000);
  if (!response.ok) {
    throw new Error(`获取逐条交易建议失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取逐条交易建议失败');
  }
  return data.data;
}

export interface NewsItemInterpretation {
  newsTitle: string;
  url: string;
  direction: '利多' | '利空' | '中性';
  affectedVarieties: string[];
  impact: '高' | '中' | '低';
  interpretation: string;
  tradeHint: string;
}

/**
 * 为每条新闻生成一条 AI 解读
 * 服务端文件：server/src/routes/news.ts
 * 接口：POST /api/v1/news/interpretations
 * Body 参数：news: NewsItem[]
 */
export async function fetchNewsItemInterpretations(
  news: NewsItem[]
): Promise<NewsItemInterpretation[]> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/interpretations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ news }),
  }, 60000);
  if (!response.ok) {
    throw new Error(`获取逐条新闻解读失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取逐条新闻解读失败');
  }
  return data.data;
}

/**
 * 获取 AI 解读用新闻摘要
 */
export async function fetchNewsAISummary(): Promise<{
  summary: string;
  detectedEventCount: number;
  propagationAlertCount: number;
  scanTime: string;
}> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/ai-summary`);
  if (!response.ok) {
    throw new Error(`获取AI摘要失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取AI摘要失败');
  }
  return data.data;
}

// ============ 逐品种新闻搜索 ============

export interface VarietyNewsResult {
  variety: string;
  varietyName: string;
  news: NewsItem[];
  summary?: string;
}

/**
 * 服务端文件：server/src/routes/news.ts
 * 接口：GET /api/v1/news/variety/:code
 * Path 参数：code: string (品种代码，如 'RB0', 'I0')
 */
export async function fetchVarietyNews(code: string): Promise<VarietyNewsResult> {
  const response = await fetchWithTimeout(`${BASE_URL}/api/v1/news/variety/${encodeURIComponent(code)}`);
  if (!response.ok) {
    throw new Error(`获取品种新闻失败: ${response.status}`);
  }
  const data = await response.json();
  if (!data.success) {
    throw new Error(data.error || '获取品种新闻失败');
  }
  return data.data;
}
