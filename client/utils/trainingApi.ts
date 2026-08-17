/**
 * 训练模块 API 调用
 * 后端路由: server/src/routes/training.ts
 */

import { fetchWithTimeout } from '@/utils/api';
import Constants from 'expo-constants';

function getTrainingBaseUrl(): string {
  // 1. 使用 app.config.ts extra 中配置的 URL（最可靠的方式，构建时注入公网域名）
  const extraUrl = Constants.expoConfig?.extra?.backendBaseURL;
  if (extraUrl) {
    return extraUrl;
  }

  // 2. 优先使用环境变量
  if (process.env.EXPO_PUBLIC_BACKEND_BASE_URL) {
    return process.env.EXPO_PUBLIC_BACKEND_BASE_URL;
  }

  // 3. Web 环境：使用当前域名（与 api.ts 保持一致）
  if (typeof window !== 'undefined' && window.location) {
    const hostname = window.location.hostname;
    if (hostname.includes('dev.coze.site')) {
      return `${window.location.protocol}//${hostname}`;
    }
  }

  // 4. 原生端（手机）：通过 Expo hostUri 推断后端地址
  if (typeof window === 'undefined') {
    const hostUri = (Constants.expoConfig?.hostUri ||
      Constants.expoGoConfig?.debuggerHost) as string | undefined;
    if (hostUri) {
      const host = hostUri.split(':')[0];
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        if (host.includes('dev.coze.site')) {
          return `https://${host}`;
        }
        // 局域网开发：后端与 Expo 服务同机
        return `http://${host}:9091`;
      }
    }
  }

  // 5. 本地开发
  return 'http://localhost:9091';
}

const BASE = getTrainingBaseUrl();

export interface KlineBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
}

export interface KlineResponse {
  code: string;
  name: string;
  group: string;
  contract: string;
  barCount: number;
  bars: KlineBar[];
}

/**
 * 后端文件: server/src/routes/training.ts
 * 接口: GET /api/v1/training/kline/:code
 * Query 参数: bars?: number (默认120, 最大250)
 */
export async function fetchTrainingKline(code: string, bars = 120): Promise<KlineResponse | null> {
  try {
    const resp = await fetchWithTimeout(`${BASE}/api/v1/training/kline/${code}?bars=${bars}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('[Training API] fetchKline error:', e);
    return null;
  }
}

/**
 * 后端文件: server/src/routes/training.ts
 * 接口: GET /api/v1/training/varieties
 * 无参数
 */
export async function fetchTrainingVarieties(): Promise<Record<string, { code: string; name: string }[]> | null> {
  try {
    const resp = await fetchWithTimeout(`${BASE}/api/v1/training/varieties`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.groups;
  } catch (e) {
    console.error('[Training API] fetchVarieties error:', e);
    return null;
  }
}

export interface VarietyStat {
  code: string;
  name: string;
  medianReturnPct: number;
  positiveRate: number;
  bestReturnPct: number;
  avgWinRate: number;
  avgProfitFactor: number;
  avgMaxDrawdown: number;
  volatility: number;
}

/**
 * 后端文件: server/src/routes/training.ts
 * 接口: GET /api/v1/training/variety-stats
 * 无参数（返回 59 品种回测统计摘要）
 */
export async function fetchVarietyStats(): Promise<VarietyStat[] | null> {
  try {
    const resp = await fetchWithTimeout(`${BASE}/api/v1/training/variety-stats`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.stats ?? null;
  } catch (e) {
    console.error('[Training API] fetchVarietyStats error:', e);
    return null;
  }
}
