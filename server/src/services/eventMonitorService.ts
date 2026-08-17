/**
 * 事件驱动传播链监控服务（方案C / v15 组合策略落地）
 *
 * 核心逻辑：
 * 1. 加载白名单 55 对传播对（板块内真联动）
 * 2. 扫描 60 品种日线缓存，计算 ATR14 / ATR60
 * 3. 高波动过滤：ATR14 > ATR60 * 0.8（放宽，允许波动率略降）
 * 4. 检测 leader 冲击：|ret × close| >= 1.0 × ATR14（近 3 个交易日，含 next1 确认）
 * 5. next1 确认：leader 冲击日后延续方向（内置于 detectShock）
 * 6. S6 板块联动过滤：同板块内其他品种同向移动 ≥50%（v15）
 * 7. S7 季节性过滤：历史同期（±15天）平均收益率同向（v15）
 * 8. 命中白名单 → 生成预警（follower 跟随预期）
 *
 * 策略来源：v15 新信号融合回测最优组合
 *   v13（ATR4+H20+高波动+SL0.01+next1+白名单）+ S6板块联动 + S7季节性
 *   回测 PF=14.69，胜率 62.5%
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PROPAGATION_WHITELIST, type WhitelistPair } from '../data/propagationWhitelist.js';
import { VARIETIES } from './varieties.js';
import { getDb } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_DIR = path.join(__dirname, '..', '..', 'data-cache');

// ===== 类型定义 =====

export interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold?: number;
  ret: number | null;
}

export interface ShockEvent {
  variety: string;
  varietyName: string;
  date: string;
  direction: 'up' | 'down';
  retPct: number;       // 涨跌幅 %
  atrMult: number;      // ATR 倍数
  atrValue: number;     // ATR14 值
  close: number;
}

export interface PropagationAlert {
  id: string;
  scanDate: string;          // 扫描日期（最新交易日）
  leader: string;            // leader 品种代码
  leaderName: string;        // leader 中文名
  follower: string;          // follower 品种代码
  followerName: string;      // follower 中文名
  direction: 'LONG' | 'SHORT'; // 冲击方向（与前端对齐：LONG=上涨，SHORT=下跌）
  sector: string;            // 板块
  logic: string;             // 联动逻辑
  lagDays: number;           // 预期滞后天数
  shockDate: string;         // leader 冲击日期
  shockReturn: number;       // leader 涨跌幅（小数）
  shockAtrMult: number;      // ATR 倍数
  // next1 确认
  next1Confirmed: boolean;   // 次日延续确认
  next1Return: number;       // 次日涨跌幅（小数）
  // 风控建议
  stopLoss: number;          // 止损比例（小数，-0.01 = -1%）
  holdDays: number;          // 预期持仓天数
  // 信号强度
  signalStrength: 'strong' | 'medium';  // strong: atrMult>=2, medium: >=1
  // 置信度评分（0-100，多因子加权）
  confidenceScore: number;
  // v15 过滤器结果
  sectorCorrelation: number | null;   // S6 板块联动相关系数
  seasonalAlignment: boolean | null;  // S7 季节性是否同向
}

/** 30 分钟级别盘中异动信号 */
export interface IntradaySignal {
  variety: string;          // 品种代码
  varietyName: string;      // 品种中文名
  direction: 'up' | 'down'; // 盘中异动方向
  atrMult: number;          // 30 分钟 ATR 倍数
  datetime: string;         // 最新 30 分钟 bar 时间
  close: number;            // 最新 30 分钟收盘价
}

export interface ScanResult {
  scanDate: string;
  scanTime: string;
  leaderShocks: ShockEvent[];
  alerts: PropagationAlert[];
  intradaySignals: IntradaySignal[];  // 盘中异动信号（30分钟级别）
  summary: {
    totalVarieties: number;
    shockCount: number;
    alertCount: number;
    sectors: Record<string, number>;  // 板块 → 预警数
  };
}

// ===== 内存缓存 =====
let lastScanResult: ScanResult | null = null;
let lastScanDate: string | null = null;

// ===== 数据加载 =====

/** 加载单品种日线缓存（支持 data-cache 实时格式） */
function loadDailyData(variety: string): DailyBar[] {
  const filePath = path.join(CACHE_DIR, `${variety}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // 支持两种格式：数组格式 或 { bars, contract, timestamp } 对象格式
    const bars: DailyBar[] = Array.isArray(raw) ? raw : (raw.bars || []);
    // 如果没有 ret 字段，计算收益率
    for (let i = 1; i < bars.length; i++) {
      if (bars[i].ret === undefined || bars[i].ret === null) {
        const prev = bars[i - 1];
        if (prev && prev.c && prev.c !== 0) {
          bars[i].ret = (bars[i].c - prev.c) / prev.c;
        }
      }
    }
    return bars;
  } catch {
    return [];
  }
}

/** 计算 ATR14（True Range 的 14 日简单平均） */
function calcATR14(bars: DailyBar[]): number {
  if (bars.length < 15) return 0;
  const trs: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!prev) continue;
    const tr = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prev.c),
      Math.abs(bar.l - prev.c)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** 计算 ATR60（True Range 的 60 日简单平均，用于波动率状态判断） */
function calcATR60(bars: DailyBar[]): number {
  if (bars.length < 61) return 0;
  const trs: number[] = [];
  for (let i = bars.length - 60; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!prev) continue;
    const tr = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prev.c),
      Math.abs(bar.l - prev.c)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return 0;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/** 动态止损：-1×ATR14 比例（限制在 -0.5% ~ -3%），兜底 -1% */
function computeDynamicStopLoss(followerBars: DailyBar[] | undefined): number {
  if (!followerBars || followerBars.length < 15) return -0.01;
  const atr14 = calcATR14(followerBars);
  const close = followerBars[followerBars.length - 1]?.c ?? 0;
  if (close <= 0 || atr14 <= 0) return -0.01;
  const stopPct = -(atr14 / close);
  // 限制在 -0.5% ~ -3% 之间，避免极端值
  return Math.max(-0.03, Math.min(-0.005, stopPct));
}

/** 30 分钟数据目录 */
const INTRA_30M_DIR = path.join(process.cwd(), 'data-cache-30m-long');

/** 30 分钟 bar */
interface MinuteBar {
  date: string;  // "YYYY-MM-DD HH:mm:ss"
  o: number;
  h: number;
  l: number;
  c: number;
  vol?: number;
  hold?: number;
}

/** 加载 30 分钟数据 */
function load30MinData(variety: string): MinuteBar[] {
  const filePath = path.join(INTRA_30M_DIR, `${variety}.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return Array.isArray(raw) ? (raw as MinuteBar[]) : [];
  } catch {
    return [];
  }
}

/** 检测 30 分钟级别盘中异动（最新一根 30 分钟 bar 涨跌 vs 30分钟 ATR14） */
function detectIntradayShock(variety: string): IntradaySignal | null {
  const bars = load30MinData(variety);
  if (bars.length < 30) return null;

  // 计算 30 分钟级别 ATR14
  const trs: number[] = [];
  for (let i = bars.length - 14; i < bars.length; i++) {
    const bar = bars[i];
    const prev = bars[i - 1];
    if (!prev) continue;
    const tr = Math.max(
      bar.h - bar.l,
      Math.abs(bar.h - prev.c),
      Math.abs(bar.l - prev.c)
    );
    trs.push(tr);
  }
  if (trs.length === 0) return null;
  const atr14 = trs.reduce((a, b) => a + b, 0) / trs.length;
  if (atr14 <= 0) return null;

  // 最新一根 30 分钟 bar 的涨跌
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  if (!prev || !last) return null;
  const change = last.c - prev.c;
  const atrMult = Math.abs(change) / atr14;

  // 盘中异动阈值：1×ATR14（30分钟级别）
  if (atrMult < 1.0) return null;

  return {
    variety,
    varietyName: VARIETIES[variety] || variety,
    direction: change > 0 ? 'up' : 'down',
    atrMult: Math.round(atrMult * 100) / 100,
    datetime: last.date,
    close: last.c,
  };
}

/** 获取最新 N 根 K 线（含 ret） */
function getLatestBars(bars: DailyBar[], n: number): DailyBar[] {
  const valid = bars.filter(b => b.ret !== null && b.ret !== undefined);
  return valid.slice(-n);
}

// ===== 冲击检测 =====

/** 检测品种在最近 lookback 天内是否有冲击事件（遍历窗口，支持 next1 确认） */
function detectShock(variety: string, bars: DailyBar[], lookback: number = 3): ShockEvent | null {
  const valid = bars.filter(b => b.ret !== null && b.ret !== undefined);
  if (valid.length < 2) return null;

  const atr = calcATR14(bars);
  if (atr <= 0) return null;

  // 从最近 lookback+1 根 K 线中，遍历每根（除最后一根外），检查冲击 + next1 确认
  // 最后一根作为"确认日"，前面的作为"冲击候选日"
  const window = valid.slice(-(lookback + 1));
  if (window.length < 2) return null;

  let bestShock: ShockEvent | null = null;
  let bestAtrMult = 0;

  for (let i = 0; i < window.length - 1; i++) {
    const candidate = window[i];
    const nextBar = window[i + 1];

    // 修复单位：ret 是比率，需乘以收盘价转为绝对价格变动，再除以 ATR
    const priceChange = Math.abs(candidate.ret! * candidate.c);
    const atrMult = priceChange / atr;

    if (atrMult >= 1.0 && atrMult > bestAtrMult) {
      const dir: 'up' | 'down' = candidate.ret! > 0 ? 'up' : 'down';
      // next1 确认：后续 K 线延续冲击方向
      const nextConfirmed = dir === 'up' ? nextBar.ret! > 0 : nextBar.ret! < 0;
      if (nextConfirmed) {
        bestAtrMult = atrMult;
        bestShock = {
          variety,
          varietyName: VARIETIES[variety] || variety,
          date: candidate.date,
          direction: dir,
          retPct: candidate.ret!,
          atrMult: Math.round(atrMult * 100) / 100,
          atrValue: Math.round(atr * 100) / 100,
          close: candidate.c,
        };
      }
    }
  }
  return bestShock;
}

/** next1 确认：最新日延续冲击方向（收益率同号） */
function confirmNext1(bars: DailyBar[], shockDate: string, shockDir: 'up' | 'down'): { confirmed: boolean; next1RetPct: number } {
  const valid = bars.filter(b => b.ret !== null && b.ret !== undefined);
  const shockIdx = valid.findIndex(b => b.date === shockDate);
  if (shockIdx < 0 || shockIdx >= valid.length - 1) {
    return { confirmed: false, next1RetPct: 0 };
  }
  const nextBar = valid[shockIdx + 1];
  const nextRet = nextBar.ret!;
  const confirmed = shockDir === 'up' ? nextRet > 0 : nextRet < 0;
  return { confirmed, next1RetPct: Math.round(nextRet * 100) / 100 };
}

// ===== 置信度评分 =====

/**
 * 多因子置信度评分（0-100）
 * 权重设计：
 *   1. ATR 倍数（冲击强度）：35 分 —— 1.0×ATR 起算，3.0×ATR 封顶
 *   2. 白名单历史命中率：30 分 —— 50% 起算，90% 封顶
 *   3. 板块联动率：20 分 —— 0% 起算，100% 封顶
 *   4. 季节性同向：15 分 —— 同向满分，逆向 0 分
 */
function computeConfidenceScore(params: {
  atrMult: number;
  hr: number;
  sectorCorrelation: number | null;
  seasonalAligned: boolean | null;
}): number {
  // 1. ATR 倍数（冲击强度）：1.0 → 0分，3.0+ → 35分
  const atrScore = (Math.min(Math.max(params.atrMult, 1.0), 3.0) / 3.0) * 35;

  // 2. 历史命中率：0.5 → 0分，0.9+ → 30分
  const hr = Math.min(Math.max(params.hr, 0), 1);
  const hrScore = Math.min(Math.max((hr - 0.5) / 0.4, 0), 1) * 30;

  // 3. 板块联动率：0 → 0分，1.0 → 20分
  const corr = params.sectorCorrelation ?? 0.5;
  const corrScore = Math.min(Math.max(corr, 0), 1) * 20;

  // 4. 季节性同向：15分（逆向已被 S7 过滤，正常都为同向）
  const seasonalScore = params.seasonalAligned !== false ? 15 : 0;

  const total = atrScore + hrScore + corrScore + seasonalScore;
  return Math.round(Math.min(Math.max(total, 0), 100));
}

// ===== v15 新增过滤器 =====

/** S6 板块联动：检查同板块内其他品种是否同向移动 */
function checkSectorCorrelation(
  leaderCode: string,
  sector: string,
  direction: 'up' | 'down',
  allData: Map<string, DailyBar[]>
): { passed: boolean; correlation: number } {
  // 获取同板块的所有品种
  const sectorPairs = PROPAGATION_WHITELIST.filter(p => p.sector === sector);
  const sectorVarieties = new Set([
    ...sectorPairs.map(p => p.leader),
    ...sectorPairs.map(p => p.follower),
  ]);
  sectorVarieties.delete(leaderCode); // 排除 leader 自己

  if (sectorVarieties.size === 0) return { passed: true, correlation: 1 };

  let sameDirectionCount = 0;
  let totalCount = 0;

  for (const variety of sectorVarieties) {
    const bars = allData.get(variety);
    if (!bars || bars.length < 5) continue;

    const recent = getLatestBars(bars, 5);
    if (recent.length === 0) continue;

    // 检查最近 5 天的平均方向
    const avgRet = recent.reduce((sum, b) => sum + (b.ret || 0), 0) / recent.length;
    const isSameDirection = direction === 'up' ? avgRet > 0 : avgRet < 0;

    totalCount++;
    if (isSameDirection) sameDirectionCount++;
  }

  if (totalCount === 0) return { passed: true, correlation: 1 };

  const correlation = sameDirectionCount / totalCount;
  return { passed: correlation >= 0.4, correlation }; // v15.1 阈值放宽至 40%（原 50%）
}

/** S7 季节性：检查历史同期（±15天）平均收益率方向 */
function checkSeasonalPattern(
  bars: DailyBar[],
  shockDate: string,
  direction: 'up' | 'down'
): { passed: boolean; seasonalReturn: number } {
  const shockMonth = parseInt(shockDate.slice(5, 7)); // MM
  const shockDay = parseInt(shockDate.slice(8, 10)); // DD

  // 收集历史同期（±15天）的收益率
  const historicalReturns: number[] = [];
  const valid = bars.filter(b => b.ret !== null && b.ret !== undefined);

  for (const bar of valid) {
    const barMonth = parseInt(bar.date.slice(5, 7));
    const barDay = parseInt(bar.date.slice(8, 10));

    // 检查是否在 ±15 天范围内（简化为月份相同且日期差≤15）
    if (barMonth === shockMonth && Math.abs(barDay - shockDay) <= 15) {
      historicalReturns.push(bar.ret!);
    }
  }

  if (historicalReturns.length === 0) return { passed: true, seasonalReturn: 0 };

  const avgReturn = historicalReturns.reduce((a, b) => a + b, 0) / historicalReturns.length;
  const isAligned = direction === 'up' ? avgReturn > 0 : avgReturn < 0;

  return { passed: isAligned, seasonalReturn: Math.round(avgReturn * 100) / 100 };
}

// ===== 主扫描逻辑 =====

/** 执行全品种扫描，生成传播链预警 */
export function scanPropagationAlerts(): ScanResult {
  const now = new Date();
  const scanTime = now.toISOString();

  // 1. 收集所有白名单涉及的品种（leader + follower）
  const allVarieties = new Set<string>();
  for (const p of PROPAGATION_WHITELIST) {
    allVarieties.add(p.leader);
    allVarieties.add(p.follower);
  }

  // 2. 预加载所有品种数据（S6 板块联动需要）
  const allData = new Map<string, DailyBar[]>();
  for (const variety of allVarieties) {
    const bars = loadDailyData(variety);
    if (bars.length >= 65) {
      allData.set(variety, bars);
    }
  }

  // 3. 收集所有白名单涉及的 leader 品种
  const leaderSet = new Set(PROPAGATION_WHITELIST.map(p => p.leader));

  // 4. 检测冲击（含高波动过滤）
  const shocks = new Map<string, { shock: ShockEvent; bars: DailyBar[] }>();
  for (const leader of leaderSet) {
    const bars = allData.get(leader);
    if (!bars) continue;

    // v13 高波动过滤（放宽：ATR14 > ATR60 * 0.8，允许波动率略降的品种）
    const atr14 = calcATR14(bars);
    const atr60 = calcATR60(bars);
    if (atr60 > 0 && atr14 <= atr60 * 0.8) continue; // 波动率过低，跳过

    const shock = detectShock(leader, bars, 3);
    if (shock) {
      shocks.set(leader, { shock, bars });
    }
  }

  // 5. 对每个冲击的 leader，匹配白名单并应用过滤器
  const alerts: PropagationAlert[] = [];
  for (const [leaderCode, { shock, bars }] of shocks) {
    // next1 确认
    const { confirmed, next1RetPct } = confirmNext1(bars, shock.date, shock.direction);

    // 策略要求 next1 确认通过
    if (!confirmed) continue;

    // 匹配白名单
    const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === leaderCode);
    for (const pair of pairs) {
      // v15 S6 板块联动过滤
      const s6 = checkSectorCorrelation(leaderCode, pair.sector, shock.direction, allData);
      if (!s6.passed) continue;

      // v15 S7 季节性过滤
      const s7 = checkSeasonalPattern(bars, shock.date, shock.direction);
      if (!s7.passed) continue;

      const alert: PropagationAlert = {
        id: `${shock.date}_${leaderCode}_${pair.follower}`,
        scanDate: shock.date,
        leader: leaderCode,
        leaderName: shock.varietyName,
        follower: pair.follower,
        followerName: VARIETIES[pair.follower] || pair.follower,
        direction: shock.direction === 'up' ? 'LONG' : 'SHORT',
        sector: pair.sector,
        logic: pair.logic,
        lagDays: pair.lag,
        shockDate: shock.date,
        shockReturn: Math.round(shock.retPct * 10000) / 10000,
        shockAtrMult: shock.atrMult,
        next1Confirmed: true,
        next1Return: next1RetPct,
        stopLoss: computeDynamicStopLoss(allData.get(pair.follower)),  // 动态止损：-1×ATR14
        holdDays: pair.lag,  // 预期持仓天数与滞后天数一致
        signalStrength: shock.atrMult >= 2 ? 'strong' : 'medium',
        confidenceScore: computeConfidenceScore({
          atrMult: shock.atrMult,
          hr: pair.hr,
          sectorCorrelation: s6.correlation,
          seasonalAligned: s7.passed,
        }),
        sectorCorrelation: s6.correlation,
        seasonalAlignment: s7.passed,
      };
      alerts.push(alert);
    }
  }

  // 6. 统计
  const sectorCounts: Record<string, number> = {};
  for (const a of alerts) {
    sectorCounts[a.sector] = (sectorCounts[a.sector] || 0) + 1;
  }

  // 6.5 盘中异动检测（30分钟级别，覆盖所有白名单 leader）
  const intradaySignals: IntradaySignal[] = [];
  for (const leader of leaderSet) {
    const sig = detectIntradayShock(leader);
    if (sig) intradaySignals.push(sig);
  }
  // 按 ATR 倍数降序
  intradaySignals.sort((a, b) => b.atrMult - a.atrMult);

  const result: ScanResult = {
    scanDate: alerts.length > 0 ? alerts[0].scanDate : now.toISOString().slice(0, 10),
    scanTime,
    leaderShocks: Array.from(shocks.values()).map(s => s.shock),
    alerts,
    intradaySignals,
    summary: {
      totalVarieties: leaderSet.size,
      shockCount: shocks.size,
      alertCount: alerts.length,
      sectors: sectorCounts,
    },
  };

  // 缓存结果
  lastScanResult = result;
  lastScanDate = result.scanDate;

  // 持久化预警（用于绩效追踪闭环）
  persistPropagationAlerts(alerts, scanTime);

  return result;
}

/** 获取最近一次扫描结果（带缓存） */
export function getLatestScanResult(): ScanResult {
  if (!lastScanResult) {
    return scanPropagationAlerts();
  }
  return lastScanResult;
}

/** 获取指定品种的传播链预警历史（回测用） */
export function getAlertsForVariety(variety: string): PropagationAlert[] {
  const result = getLatestScanResult();
  return result.alerts.filter(
    a => a.leader === variety || a.follower === variety
  );
}

/** 生成 AI 解读用的信号摘要文本 */
export function generateAISignalSummary(): string {
  const result = getLatestScanResult();
  if (result.alerts.length === 0) {
    return `【传播链监控】当前无活跃信号。已检测到 ${result.leaderShocks.length} 个 leader 冲击事件，但均未通过 next1 确认或板块联动/季节性过滤。`;
  }

  const dirLabel = (d: string) => d === 'LONG' ? '上涨冲击' : '下跌冲击';
  const strengthLabel = (s: string) => s === 'strong' ? '强信号(≥2×ATR)' : '中信号(≥1×ATR)';

  const lines = [
    `【传播链监控 - ${result.scanDate}】检测到 ${result.alerts.length} 条活跃信号：`,
    '',
  ];

  // 按板块分组
  const bySector: Record<string, PropagationAlert[]> = {};
  for (const a of result.alerts) {
    if (!bySector[a.sector]) bySector[a.sector] = [];
    bySector[a.sector].push(a);
  }

  for (const [sector, alerts] of Object.entries(bySector)) {
    lines.push(`▎${sector}（${alerts.length} 条）`);
    for (const a of alerts) {
      lines.push(
        `  • ${a.leaderName}(${a.leader}) ${dirLabel(a.direction)} ${(a.shockReturn * 100).toFixed(1)}% ` +
        `[${strengthLabel(a.signalStrength)}] → 预期 ${a.followerName}(${a.follower}) ` +
        `滞后 ${a.lagDays} 天跟随 | 逻辑：${a.logic}`
      );
    }
  }

  lines.push('');
  lines.push(`策略：v15 组合（next1确认+白名单传播对+SL1止损-1%），回测 PF=14.69`);

  return lines.join('\n');
}

// ===== 传播链预警持久化 + 绩效追踪 =====

/** 建传播链预警历史表（幂等） */
function ensurePropagationTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS propagation_alert_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_time TEXT NOT NULL,
      shock_date TEXT NOT NULL,
      leader TEXT NOT NULL,
      leader_name TEXT NOT NULL,
      follower TEXT NOT NULL,
      follower_name TEXT NOT NULL,
      direction TEXT NOT NULL,
      signal_strength TEXT NOT NULL,
      atr_mult REAL DEFAULT 0,
      confidence_score REAL DEFAULT 0,
      sector TEXT DEFAULT '',
      logic TEXT DEFAULT '',
      lag_days INTEGER DEFAULT 0,
      hold_days INTEGER DEFAULT 0,
      entry_price REAL DEFAULT 0,
      stop_loss REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      verified_hit INTEGER DEFAULT 0,
      follower_return_pct REAL DEFAULT 0,
      verified_at TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(leader, follower, shock_date)
    )
  `);
}

/** 持久化扫描结果（按 leader + follower + shock_date 去重，重复扫描不重复插入） */
export function persistPropagationAlerts(alerts: PropagationAlert[], scanTime: string): void {
  if (alerts.length === 0) return;
  try {
    ensurePropagationTable();
    const db = getDb();
    for (const a of alerts) {
      db.run(
        `INSERT OR IGNORE INTO propagation_alert_history
          (scan_time, shock_date, leader, leader_name, follower, follower_name, direction,
           signal_strength, atr_mult, confidence_score, sector, logic, lag_days, hold_days, stop_loss)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          scanTime,
          a.shockDate,
          a.leader,
          a.leaderName,
          a.follower,
          a.followerName,
          a.direction,
          a.signalStrength,
          a.shockAtrMult,
          a.confidenceScore,
          a.sector,
          a.logic,
          a.lagDays,
          a.holdDays,
          a.stopLoss,
        ],
      );
    }
  } catch (err) {
    console.error('[eventMonitor] 持久化传播链预警失败:', err);
  }
}

/**
 * 绩效回填：对 status='pending' 的历史预警，读取 follower 在 lag 天内的实际涨跌，
 * 标记命中/未命中。follower 数据尚未覆盖到 shock_date + lag 天的预警会保留 pending 待下次回填。
 */
export function backfillPropagationPerformance(): { verified: number; hit: number; missed: number } {
  try {
    ensurePropagationTable();
    const db = getDb();
    const pending = db.query(
      `SELECT * FROM propagation_alert_history WHERE status = 'pending'`,
    );

    let verified = 0;
    let hit = 0;
    let missed = 0;

    for (const row of pending) {
      const followerBars = loadDailyData(row.follower as string);
      if (followerBars.length === 0) continue;

      const shockIdx = followerBars.findIndex(b => b.date === row.shock_date);
      if (shockIdx === -1) continue;

      const lagDays = Number(row.lag_days) || 1;
      const endIdx = shockIdx + lagDays;
      // follower 数据尚未覆盖到退出日，保留 pending 等待下次回填
      if (endIdx >= followerBars.length) continue;

      const entryPrice = followerBars[shockIdx].c;
      const exitPrice = followerBars[endIdx].c;
      if (!entryPrice || entryPrice <= 0) continue;

      const returnPct = (exitPrice - entryPrice) / entryPrice;
      const isHit = row.direction === 'LONG' ? returnPct > 0 : returnPct < 0;

      db.run(
        `UPDATE propagation_alert_history
         SET status = 'verified',
             verified_hit = ?,
             follower_return_pct = ?,
             entry_price = ?,
             verified_at = datetime('now', 'localtime')
         WHERE id = ?`,
        [isHit ? 1 : 0, returnPct, entryPrice, row.id],
      );

      verified++;
      if (isHit) hit++;
      else missed++;
    }

    return { verified, hit, missed };
  } catch (err) {
    console.error('[eventMonitor] 绩效回填失败:', err);
    return { verified: 0, hit: 0, missed: 0 };
  }
}

/** 查询历史预警（含绩效），返回最近 limit 条 */
export function queryPropagationHistory(limit = 200): unknown[] {
  try {
    ensurePropagationTable();
    const db = getDb();
    return db.query(
      `SELECT * FROM propagation_alert_history ORDER BY created_at DESC, id DESC LIMIT ?`,
      [limit],
    );
  } catch (err) {
    console.error('[eventMonitor] 查询历史预警失败:', err);
    return [];
  }
}

/** 查询历史预警绩效汇总 */
export function queryPropagationStats(): {
  total: number;
  verified: number;
  hit: number;
  hitRate: number | null;
} {
  try {
    ensurePropagationTable();
    const db = getDb();
    const total = db.queryOne(
      `SELECT COUNT(*) AS c FROM propagation_alert_history`,
    ) as { c: number };
    const verified = db.queryOne(
      `SELECT COUNT(*) AS c, SUM(verified_hit) AS h FROM propagation_alert_history WHERE status = 'verified'`,
    ) as { c: number; h: number };

    const totalCount = total?.c ?? 0;
    const verifiedCount = verified?.c ?? 0;
    const hitCount = verified?.h ?? 0;

    return {
      total: totalCount,
      verified: verifiedCount,
      hit: hitCount,
      hitRate: verifiedCount > 0 ? Math.round((hitCount / verifiedCount) * 10000) / 10000 : null,
    };
  } catch (err) {
    console.error('[eventMonitor] 查询绩效汇总失败:', err);
    return { total: 0, verified: 0, hit: 0, hitRate: null };
  }
}
