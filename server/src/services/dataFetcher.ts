import iconv from 'iconv-lite';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FINANCIAL_FUTURES, type BarData } from './varieties.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_EXPIRY_NORMAL = 2 * 60 * 60 * 1000; // 非交易时段：2小时缓存
const CACHE_EXPIRY_TRADING = 30 * 1000; // 交易时段：30秒缓存
const STALE_IF_BAR_OLDER_MS = 36 * 60 * 60 * 1000; // 最新K线超过36小时视为缺今日数据

// 判断当前是否在交易时段
export function isTradingHours(): boolean {
  const now = new Date();
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const time = hours * 60 + minutes; // 转换为分钟数

  // 日盘：09:00-11:30, 13:30-15:00
  const morningStart = 9 * 60; // 09:00
  const morningEnd = 11 * 60 + 30; // 11:30
  const afternoonStart = 13 * 60 + 30; // 13:30
  const afternoonEnd = 15 * 60; // 15:00

  // 夜盘：21:00 - 次日 02:30（黄金/白银等品种夜盘到 02:30）
  const nightStart = 21 * 60; // 21:00
  const nightEndNextDay = 2 * 60 + 30; // 次日 02:30

  // 判断是否在交易时段
  const isDaySession = (time >= morningStart && time <= morningEnd) ||
                       (time >= afternoonStart && time <= afternoonEnd);
  // 夜盘跨日：21:00-23:59 或 00:00-02:30
  const isNightSession = time >= nightStart || time <= nightEndNextDay;

  return isDaySession || isNightSession;
}

// 动态获取缓存有效期
function getCacheExpiry(): number {
  return isTradingHours() ? CACHE_EXPIRY_TRADING : CACHE_EXPIRY_NORMAL;
}

// 缓存目录解析：
// - 开发（tsx 直接运行）：src/services → ../../data-cache = server/data-cache（预置品种种子缓存）
// - 生产（esbuild 打包为单文件 dist/index.js）：dist → ../data-cache = server/data-cache
// 注意：veFaaS 生产环境文件系统只读（仅 /tmp 可写），项目内缓存目录仅作只读种子，
// 写入一律落到可写目录，且目录创建失败不允许导致进程崩溃。
const SEED_CACHE_DIR = [
  path.join(__dirname, '..', '..', 'data-cache'),
  path.join(__dirname, '..', 'data-cache'),
].find((p) => fs.existsSync(p)) ?? null;

// 20 年历史日线缓存目录（只读种子，用于历史回填 / 事件复盘）
const HISTORY_CACHE_DIR = [
  path.join(__dirname, '..', '..', 'data-cache-daily-20y'),
  path.join(__dirname, '..', 'data-cache-daily-20y'),
].find((p) => fs.existsSync(p)) ?? null;

function isDirWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

const WRITE_CACHE_DIR = SEED_CACHE_DIR && isDirWritable(SEED_CACHE_DIR)
  ? SEED_CACHE_DIR
  : path.join('/tmp', 'data-cache');

let cacheWriteEnabled = true;
try {
  if (!fs.existsSync(WRITE_CACHE_DIR)) {
    fs.mkdirSync(WRITE_CACHE_DIR, { recursive: true });
  }
} catch (e) {
  cacheWriteEnabled = false;
  console.warn('[DataFetcher] 缓存目录不可写，磁盘缓存写入已禁用:', e);
}

// 缓存辅助函数
function getCachePath(key: string): string {
  return path.join(WRITE_CACHE_DIR, `${key.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
}

// 读取磁盘缓存：先查可写缓存目录，未命中再回退项目种子缓存目录。
// ignoreExpiry=true 时接受过期缓存（用于 API 失败时的兜底）。
function readCache(key: string, ignoreExpiry = false): { bars: BarData[]; contract: string; timestamp: number } | null {
  const filename = `${key.replace(/[^a-zA-Z0-9]/g, '_')}.json`;
  const dirs = SEED_CACHE_DIR && SEED_CACHE_DIR !== WRITE_CACHE_DIR
    ? [WRITE_CACHE_DIR, SEED_CACHE_DIR]
    : [WRITE_CACHE_DIR];
  const cacheExpiry = getCacheExpiry(); // 动态缓存有效期
  for (const dir of dirs) {
    try {
      const cachePath = path.join(dir, filename);
      if (!fs.existsSync(cachePath)) continue;
      const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
      if (!ignoreExpiry && Date.now() - data.timestamp > cacheExpiry) continue; // 缓存过期
      return data;
    } catch {
      continue;
    }
  }
  return null;
}

function writeCache(key: string, data: { bars: BarData[]; contract: string }): void {
  if (!cacheWriteEnabled) return;
  try {
    const cachePath = getCachePath(key);
    fs.writeFileSync(cachePath, JSON.stringify({ ...data, timestamp: Date.now() }));
  } catch (e) {
    console.error('[DataFetcher] 写入缓存失败:', e);
  }
}

// 读取 20 年历史日线缓存（只读种子，仅当常规缓存数据不足时使用）
function readHistoryCache(code: string): { bars: BarData[]; contract: string } | null {
  if (!HISTORY_CACHE_DIR) return null;
  try {
    const cachePath = path.join(HISTORY_CACHE_DIR, `${code}.json`);
    if (!fs.existsSync(cachePath)) return null;
    const data = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
    const bars = Array.isArray(data) ? data : (data.bars || []);
    const contract = data.contract || code;
    if (bars.length < 20) return null;
    return { bars, contract };
  } catch {
    return null;
  }
}

/**
 * 从新浪财经获取期货数据
 */

// 检测主力合约
export async function detectMainContract(codeWith0: string): Promise<string> {
  const base = codeWith0.replace(/0$/, '').toUpperCase();
  const isFinancial = FINANCIAL_FUTURES.has(codeWith0);

  const candidates: string[] = [];
  const now = new Date();
  for (let i = -1; i < 9; i++) {
    const d = new Date(now.getTime() + 30 * 24 * 3600000 * i);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    candidates.push(`${base}${yy}${mm}`);
  }

  let bestContract = codeWith0;
  let bestVolume = 0;

  for (const cc of candidates) {
    try {
      const url = `https://hq.sinajs.cn/list=nf_${cc}`;
      const resp = await fetch(url, {
        headers: { Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(3000),
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const raw = iconv.decode(buf, 'gbk');

      if (raw.includes('=""') || raw.length < 30) continue;
      const fields = raw.split(',');

      let vol = 0;
      if (isFinancial) {
        vol = fields[6] ? parseFloat(fields[6].trim()) : 0;
      } else {
        vol = fields[14] ? parseFloat(fields[14].trim()) : 0;
      }

      if (vol > bestVolume) {
        bestVolume = vol;
        bestContract = cc;
      }
    } catch (e: any) {
      console.error('[DataFetcher] 解析合约成交量失败:', e?.message || e);
      continue;
    }
  }

  return bestContract;
}

// 获取日线数据
export async function fetchDaily(symbol: string, n = 120): Promise<BarData[] | null> {
  try {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${symbol}=/InnerFuturesNewService.getDailyKLine?symbol=${symbol}`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();

    // 解析 JSONP 响应 - 格式: var _XXX=([{...}])
    const jsonMatch = text.match(/\=\((\[.*\])\)/);
    if (!jsonMatch) return null;

    const rawData = JSON.parse(jsonMatch[1]) as Array<Record<string, string>>;
    if (!rawData || rawData.length < 30) return null;

    const bars: BarData[] = rawData.slice(-n).map((item) => ({
      date: item.d || '',
      o: parseFloat(item.o) || 0,
      h: parseFloat(item.h) || 0,
      l: parseFloat(item.l) || 0,
      c: parseFloat(item.c) || 0,
      vol: parseFloat(item.v) || 0,
      hold: parseFloat(item.p) || 0,
      settle: parseFloat(item.s) || 0,
    }));

    return bars.filter((b) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0);
  } catch (e: any) {
    console.error('[DataFetcher] 获取日线数据失败:', e?.message || e);
    return null;
  }
}

// 获取实时行情（用于补充今日数据）
// === 双源兜底：EastMoney 实时行情 ===

// 品种代码前缀 → EastMoney 交易所代码
function getEastMoneyExchange(contractCode: string): number | null {
  const prefix = contractCode.replace(/\d+$/, '').toLowerCase();
  // 上期所 SHFE → 113
  const shfe = ['rb', 'hc', 'au', 'ag', 'cu', 'al', 'zn', 'pb', 'ni', 'sn', 'ru', 'bu', 'fu', 'sp', 'ss', 'wr', 'ao', 'br'];
  if (shfe.includes(prefix)) return 113;
  // 大商所 DCE → 114
  const dce = ['m', 'y', 'a', 'b', 'p', 'c', 'cs', 'j', 'jm', 'i', 'l', 'v', 'pp', 'eg', 'eb', 'pg', 'rr', 'lh', 'fb', 'bb'];
  if (dce.includes(prefix)) return 114;
  // 郑商所 ZCE → 115
  const zce = ['cf', 'sr', 'ta', 'ma', 'fg', 'zc', 'rm', 'oi', 'cj', 'cy', 'ap', 'ur', 'sa', 'pf', 'pk', 'sf', 'sm', 'sh', 'wh', 'pm', 'ri', 'lr', 'jr', 'rs'];
  if (zce.includes(prefix)) return 115;
  // 中金所 CFFEX → 8
  const cffex = ['if', 'ic', 'ih', 'im', 'ts', 'tf', 't', 'tl'];
  if (cffex.includes(prefix)) return 8;
  // 上能所 INE → 138
  const ine = ['sc', 'nr', 'lu', 'bc'];
  if (ine.includes(prefix)) return 138;
  return null;
}

async function fetchRealtimeEastMoney(contractCode: string): Promise<Partial<BarData> | null> {
  const exchange = getEastMoneyExchange(contractCode);
  if (exchange === null) return null;

  try {
    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=8.${exchange}.${contractCode}&fields=f43,f44,f45,f46,f47,f60`;
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(3000),
    });
    const json: any = await resp.json();
    const data = json?.data;
    if (!data || !data.f43 || data.f43 === '-') return null;

    const c = parseFloat(data.f43); // 最新价
    if (isNaN(c) || c <= 0) return null;

    return {
      o: data.f46 && data.f46 !== '-' ? parseFloat(data.f46) : c,
      h: data.f44 && data.f44 !== '-' ? parseFloat(data.f44) : c,
      l: data.f45 && data.f45 !== '-' ? parseFloat(data.f45) : c,
      c,
      vol: data.f47 && data.f47 !== '-' ? parseFloat(data.f47) : 0,
    };
  } catch {
    return null;
  }
}

export async function fetchRealtime(contractCode: string): Promise<Partial<BarData> | null> {
  // 主数据源：新浪
  try {
    const url = `https://hq.sinajs.cn/list=nf_${contractCode}`;
    const resp = await fetch(url, {
      headers: { Referer: 'https://finance.sina.com.cn' },
      signal: AbortSignal.timeout(3000),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    const raw = iconv.decode(buf, 'gbk');

    if (!raw.includes('=""') && raw.length >= 30) {
      const fields = raw.split(',');

      return {
        o: parseFloat(fields[2]),
        h: parseFloat(fields[3]),
        l: parseFloat(fields[4]),
        c: parseFloat(fields[8]),
        vol: parseFloat(fields[14]) || parseFloat(fields[6]) || 0,
      };
    }
  } catch (e: any) {
    console.error('[DataFetcher] 新浪实时数据失败:', e?.message || e);
  }

  // 备用数据源：东方财富
  const em = await fetchRealtimeEastMoney(contractCode);
  if (em) {
    console.log(`[DataFetcher] 新浪失败，东方财富兜底成功: ${contractCode} c=${em.c}`);
    return em;
  }

  return null;
}

// 用实时数据补丁今日最后一根日线 bar
async function patchTodayBar(bars: BarData[], contract: string): Promise<{ bars: BarData[]; freshness: 'realtime' | 'cached' | 'stale' }> {
  if (!bars || bars.length === 0) {
    return { bars, freshness: 'stale' };
  }

  const lastBar = bars[bars.length - 1];
  const today = new Date().toISOString().split('T')[0];
  const lastBarDate = lastBar.date;

  // 如果最后一根 bar 不是今天的，尝试获取实时数据创建今日 bar
  if (lastBarDate !== today) {
    const realtime = await fetchRealtime(contract);
    if (realtime && realtime.c && realtime.c > 0) {
      // 创建今日 bar
      const todayBar: BarData = {
        date: today,
        o: realtime.o || realtime.c,
        h: realtime.h || realtime.c,
        l: realtime.l || realtime.c,
        c: realtime.c,
        vol: realtime.vol || 0,
        hold: 0,
        settle: 0,
      };
      bars.push(todayBar);
      return { bars, freshness: 'realtime' };
    }
    return { bars, freshness: 'stale' };
  }

  // 最后一根 bar 是今天的，用实时数据更新
  const realtime = await fetchRealtime(contract);
  if (realtime && realtime.c && realtime.c > 0) {
    lastBar.c = realtime.c;
    lastBar.h = Math.max(lastBar.h, realtime.h || realtime.c);
    lastBar.l = Math.min(lastBar.l, realtime.l || realtime.c);
    if (realtime.vol) lastBar.vol = realtime.vol;
    return { bars, freshness: 'realtime' };
  }

  // 实时数据获取失败，但今日 bar 存在
  return { bars, freshness: 'cached' };
}

// 获取品种下所有活跃合约列表（按成交量排序）
export async function getAvailableContracts(code: string): Promise<{ contracts: { code: string; volume: number; isMain: boolean }[] }> {
  const base = code.replace(/0$/, '').toUpperCase();
  const isFinancial = FINANCIAL_FUTURES.has(code);

  const candidates: string[] = [];
  const now = new Date();
  for (let i = -1; i < 9; i++) {
    const d = new Date(now.getTime() + 30 * 24 * 3600000 * i);
    const yy = String(d.getFullYear()).slice(2);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    candidates.push(`${base}${yy}${mm}`);
  }

  const contracts: { code: string; volume: number; isMain: boolean }[] = [];
  let maxVol = 0;

  for (const cc of candidates) {
    try {
      const url = `https://hq.sinajs.cn/list=nf_${cc}`;
      const resp = await fetch(url, {
        headers: { Referer: 'https://finance.sina.com.cn' },
        signal: AbortSignal.timeout(3000),
      });
      const buf = Buffer.from(await resp.arrayBuffer());
      const raw = iconv.decode(buf, 'gbk');

      if (raw.includes('=""') || raw.length < 30) continue;
      const fields = raw.split(',');
      const vol = isFinancial
        ? (fields[6] ? parseFloat(fields[6].trim()) : 0)
        : (fields[14] ? parseFloat(fields[14].trim()) : 0);

      if (vol > 0) {
        contracts.push({ code: cc, volume: vol, isMain: false });
        if (vol > maxVol) maxVol = vol;
      }
    } catch {
      continue;
    }
  }

  // 标记主力合约
  if (maxVol > 0) {
    contracts.forEach(c => { c.isMain = c.volume >= maxVol; });
  }
  contracts.sort((a, b) => b.volume - a.volume);

  return { contracts };
}

// 获取品种的完整数据（主力合约检测 + 日线获取 + 实时补丁）
export async function getVarietyData(code: string, n = 120, forceRefresh = false): Promise<{ bars: BarData[]; contract: string; dataFreshness?: 'realtime' | 'cached' | 'stale' } | null> {
  // 先尝试读取有效缓存（未过期）
  const cached = readCache(code);
  if (cached && cached.bars.length >= 30 && !forceRefresh) {
    // 检查最新K线是否已过期（缺今日数据）：如果最新bar距今超过36小时，仍尝试刷新
    const lastBarDate = cached.bars[cached.bars.length - 1]?.date;
    const lastBarMs = lastBarDate ? new Date(lastBarDate + 'T15:00:00+08:00').getTime() : 0;
    const barAge = Date.now() - lastBarMs;
    if (barAge < STALE_IF_BAR_OLDER_MS) {
      console.log(`[DataFetcher] 使用缓存数据: ${code} (${cached.bars.length} bars)`);
      // 交易时段自动补丁实时数据
      if (isTradingHours()) {
        const patched = await patchTodayBar(cached.bars.slice(-n), cached.contract);
        return { bars: patched.bars, contract: cached.contract, dataFreshness: patched.freshness };
      }
      return { bars: cached.bars.slice(-n), contract: cached.contract, dataFreshness: 'cached' };
    }
    console.log(`[DataFetcher] 缓存数据最新bar过期(${Math.round(barAge/3600000)}h前)，尝试刷新: ${code}`);
  }
  // 过期缓存仅作 API 失败时的兜底
  const staleCache = cached ?? readCache(code, true);

  try {
    const contract = await detectMainContract(code);
    const bars = await fetchDaily(contract, n);

    if (!bars || bars.length < 30) {
      // 尝试直接用 code 获取
      const fallbackBars = await fetchDaily(code, n);
      if (!fallbackBars || fallbackBars.length < 30) {
        // 如果API失败但有缓存（即使过期），也返回缓存
        if (staleCache) {
          console.log(`[DataFetcher] API失败，使用过期缓存: ${code}`);
          return { bars: staleCache.bars.slice(-n), contract: staleCache.contract, dataFreshness: 'stale' };
        }
        return null;
      }
      // 实时补丁
      const patched = await patchTodayBar(fallbackBars, code);
      const result = { bars: patched.bars, contract: code };
      writeCache(code, result);
      return { bars: patched.bars.slice(-n), contract: code, dataFreshness: patched.freshness };
    }

    // 实时补丁
    const patched = await patchTodayBar(bars, contract);
    const result = { bars: patched.bars, contract };
    writeCache(code, result);
    return { bars: patched.bars.slice(-n), contract, dataFreshness: patched.freshness };
  } catch (e: any) {
    console.error('[DataFetcher] 获取日线数据失败:', e?.message || e);
    // 如果API失败但有缓存（即使过期），也返回缓存
    if (staleCache) {
      console.log(`[DataFetcher] API异常，使用过期缓存: ${code}`);
      return { bars: staleCache.bars.slice(-n), contract: staleCache.contract, dataFreshness: 'stale' };
    }
    return null;
  }
}

// 获取截止到指定日期的日线数据（用于历史回放 / 日报按日期扫描）
// 读取缓存（忽略过期，因为要读历史数据），过滤 bars 到 date <= asOfDate，取最后 n 根
export async function getVarietyDataAsOf(
  code: string,
  n = 120,
  asOfDate: string,
): Promise<{ bars: BarData[]; contract: string } | null> {
  // 优先读取 20 年历史缓存（忽略过期，读取完整历史日线）——用于历史回填
  const historyCached = readHistoryCache(code);
  if (historyCached) {
    const filtered = filterBarsAsOf(historyCached.bars, asOfDate);
    if (filtered.length >= 20) {
      return { bars: filtered.slice(-n), contract: historyCached.contract };
    }
  }
  // 其次读取常规缓存（忽略过期，读取完整历史日线）
  const cached = readCache(code, true);
  if (!cached || cached.bars.length < 20) {
    // 兜底：尝试正常获取
    const fresh = await getVarietyData(code, n, false);
    if (!fresh) return null;
    const filtered = filterBarsAsOf(fresh.bars, asOfDate);
    if (filtered.length < 20) return null;
    return { bars: filtered.slice(-n), contract: fresh.contract };
  }
  const filtered = filterBarsAsOf(cached.bars, asOfDate);
  if (filtered.length < 20) return null;
  return { bars: filtered.slice(-n), contract: cached.contract };
}

// 过滤 bars 到 asOfDate 为止（含当天）
function filterBarsAsOf(bars: BarData[], asOfDate: string): BarData[] {
  return bars.filter((b) => (b.date || '').slice(0, 10) <= asOfDate);
}

// 获取分钟线数据（当日）
export async function fetchMinuteData(symbol: string): Promise<BarData[] | null> {
  try {
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${symbol}=/InnerFuturesNewService.getMinLine?symbol=${symbol}`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();

    // 解析 JSONP 响应 - 格式: var _XXX=([["time","price","avg_price","volume","open_interest"],...])
    const jsonMatch = text.match(/\=\((\[.*\])\)/);
    if (!jsonMatch) return null;

    const rawData = JSON.parse(jsonMatch[1]) as string[][];
    if (!rawData || rawData.length < 10) return null;

    // 获取当前日期
    const today = new Date().toISOString().split('T')[0];

    const bars: BarData[] = rawData.map((item) => ({
      date: today,
      o: parseFloat(item[1]) || 0,
      h: parseFloat(item[1]) || 0,
      l: parseFloat(item[1]) || 0,
      c: parseFloat(item[1]) || 0,
      vol: parseFloat(item[3]) || 0,
      hold: parseFloat(item[4]) || 0,
      settle: parseFloat(item[2]) || 0, // avg_price as settle
      time: item[0], // HH:MM format
    }));

    return bars.filter((b) => b.o > 0);
  } catch (e: any) {
    console.error('[DataFetcher] 获取分钟线数据失败:', e?.message || e);
    return null;
  }
}

// 获取5分钟K线数据（当日）
export async function fetch5MinData(symbol: string): Promise<BarData[] | null> {
  try {
    // 使用新浪期货5分钟K线接口
    const url = `https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_${symbol}_5=/InnerFuturesNewService.getFiveMinLine?symbol=${symbol}`;
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn' },
      signal: AbortSignal.timeout(5000),
    });
    const text = await resp.text();

    // 解析 JSONP 响应
    const jsonMatch = text.match(/\=\((\[.*\])\)/);
    if (!jsonMatch) return null;

    const rawData = JSON.parse(jsonMatch[1]) as string[][];
    if (!rawData || rawData.length < 10) return null;

    const today = new Date().toISOString().split('T')[0];

    const bars: BarData[] = rawData.map((item) => ({
      date: today,
      o: parseFloat(item[1]) || 0,
      h: parseFloat(item[2]) || 0,
      l: parseFloat(item[3]) || 0,
      c: parseFloat(item[4]) || 0,
      vol: parseFloat(item[5]) || 0,
      hold: parseFloat(item[6]) || 0,
      time: item[0], // HH:MM format
    }));

    return bars.filter((b) => b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0);
  } catch (e: any) {
    console.error('[DataFetcher] 获取5分钟K线数据失败:', e?.message || e);
    return null;
  }
}

// 聚合分钟线为更大周期（5min → 15min/60min）
function aggregateBars(bars: BarData[], minutesPerBar: number): BarData[] {
  if (!bars || bars.length === 0) return [];

  const aggregated: BarData[] = [];
  let currentBar: BarData | null = null;
  let barCount = 0;

  for (const bar of bars) {
    if (!bar.time) continue;

    // 解析时间
    const [hours, mins] = bar.time.split(':').map(Number);
    const totalMinutes = hours * 60 + mins;
    const barIndex = Math.floor(totalMinutes / minutesPerBar);

    // 如果属于新的聚合周期，保存当前 bar 并开始新的
    if (!currentBar || barIndex !== Math.floor(((currentBar._index || 0)) / minutesPerBar)) {
      if (currentBar) {
        aggregated.push(currentBar);
      }
      currentBar = {
        date: bar.date,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        vol: bar.vol,
        hold: bar.hold,
        time: bar.time,
        _index: barIndex,
      };
      barCount = 1;
    } else {
      // 更新当前聚合 bar
      currentBar.h = Math.max(currentBar.h, bar.h);
      currentBar.l = Math.min(currentBar.l, bar.l);
      currentBar.c = bar.c;
      currentBar.vol += bar.vol;
      currentBar.hold = bar.hold; // 使用最新的持仓量
      barCount++;
    }
  }

  // 保存最后一个 bar
  if (currentBar) {
    aggregated.push(currentBar);
  }

  return aggregated;
}

// 获取多时间框架数据（5min → 15min → 60min）
export async function fetchMTFData(contract: string): Promise<{
  bars5min: BarData[];
  bars15min: BarData[];
  bars60min: BarData[];
} | null> {
  try {
    // 1. 获取5分钟数据
    const bars5min = await fetch5MinData(contract);
    if (!bars5min || bars5min.length < 10) {
      // 如果5分钟接口失败，尝试用1分钟数据聚合
      const minuteBars = await fetchMinuteData(contract);
      if (!minuteBars || minuteBars.length < 30) return null;

      const bars5minFrom1 = aggregateBars(minuteBars, 5);
      const bars15min = aggregateBars(minuteBars, 15);
      const bars60min = aggregateBars(minuteBars, 60);

      return { bars5min: bars5minFrom1, bars15min, bars60min };
    }

    // 2. 从5分钟聚合出15分钟和60分钟
    const bars15min = aggregateBars(bars5min, 15);
    const bars60min = aggregateBars(bars5min, 60);

    return { bars5min, bars15min, bars60min };
  } catch (e: any) {
    console.error('[DataFetcher] 获取MTF数据失败:', e?.message || e);
    return null;
  }
}

// 获取品种的完整实时数据（日线 + 分钟线）
export async function getRealtimeVarietyData(code: string): Promise<{
  code: string;
  name: string;
  contract: string;
  dailyBars: BarData[];
  minuteBars: BarData[];
  currentPrice: number;
} | null> {
  try {
    // 1. 检测主力合约
    const contract = await detectMainContract(code);

    // 2. 获取日线数据（用于日线、60min、15min分析）
    const dailyBars = await fetchDaily(contract, 120);
    if (!dailyBars || dailyBars.length < 30) {
      // 尝试直接用 code 获取
      const fallbackBars = await fetchDaily(code, 120);
      if (!fallbackBars || fallbackBars.length < 30) return null;

      // 获取分钟线数据
      const minuteBars = await fetchMinuteData(code);
      const currentPrice = fallbackBars[fallbackBars.length - 1]?.c || 0;

      return {
        code,
        name: code,
        contract: code,
        dailyBars: fallbackBars,
        minuteBars: minuteBars || [],
        currentPrice,
      };
    }

    // 3. 获取分钟线数据（用于5min分析）
    const minuteBars = await fetchMinuteData(contract);

    // 4. 获取当前价格
    const currentPrice = dailyBars[dailyBars.length - 1]?.c || 0;

    return {
      code,
      name: code,
      contract,
      dailyBars,
      minuteBars: minuteBars || [],
      currentPrice,
    };
  } catch (e: any) {
    console.error('[DataFetcher] 获取日线数据失败:', e?.message || e);
    return null;
  }
}
