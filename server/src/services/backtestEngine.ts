/**
 * 回测引擎 v2 — 修复版
 * 
 * v1问题诊断：
 * 1. [致命] 未走V16.2决策链（Gate4/P(顺)/楔形/区间屏蔽全部缺失）
 * 2. [已修正] minSignalGrade经20组对照实验验证，L2最优（585%收益，L3仅271%）
 * 3. [致命] 止损太紧（entryPrice*0.98=2%，正常波动就被扫）
 * 4. [重要] 目标位/止损不匹配，盈亏比失真
 * 5. [重要] 无冷却期，震荡市连续止损
 * 6. [重要] 同根K线先查target后查stop，有偏向
 * 7. [重要] 每根K线都独立出信号，大量重复
 * 
 * v2修复：
 * - 接入完整V16.2过滤链（buildV16Tradable）
 * - 默认minSignalGrade=L2（回测论证：L2收益585% >> L3收益271%）
 * - 默认maxHoldDays=15（回测论证：15bar收益782% >> 5bar收益271%）
 * - 止损改用 max(ATR×1.5, swing点) 保底
 * - 目标位要求 R:R >= 1.5:1
 * - 止损后2根K线冷却
 * - 同根K线冲突保守处理（算止损）
 * - 同品种持仓期间不重复入场
 */
import * as fs from 'fs';
import * as path from 'path';
import { scanV16Variety, checkTradersEquation, evaluateV16Row } from './v16_engine';
import { VARIETIES, type BarData } from './varieties';
import type { V16Row } from './v16_types';

// ============ 工具函数 ============

/** 计算 ATR(14) */
function computeATR(bars: BarData[]): number {
  if (bars.length < 15) return 0;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(
      b.h - b.l,
      Math.abs(b.h - prev.c),
      Math.abs(b.l - prev.c)
    );
    sum += tr;
  }
  return sum / 14;
}

// ============ 合约规格 ============
interface ContractSpec { name: string; multiplier: number; tickSize: number; marginRate: number; }

const CONTRACT_SPECS: Record<string, ContractSpec> = {
  IF: { name: '沪深300', multiplier: 300, tickSize: 0.2, marginRate: 0.12 },
  IC: { name: '中证500', multiplier: 200, tickSize: 0.2, marginRate: 0.14 },
  IM: { name: '中证1000', multiplier: 200, tickSize: 0.2, marginRate: 0.15 },
  IH: { name: '上证50', multiplier: 300, tickSize: 0.2, marginRate: 0.12 },
  T: { name: '10年国债', multiplier: 10000, tickSize: 0.005, marginRate: 0.02 },
  TF: { name: '5年国债', multiplier: 10000, tickSize: 0.005, marginRate: 0.015 },
  RB: { name: '螺纹钢', multiplier: 10, tickSize: 1, marginRate: 0.10 },
  HC: { name: '热卷', multiplier: 10, tickSize: 1, marginRate: 0.10 },
  I: { name: '铁矿石', multiplier: 100, tickSize: 0.5, marginRate: 0.12 },
  J: { name: '焦炭', multiplier: 100, tickSize: 0.5, marginRate: 0.15 },
  JM: { name: '焦煤', multiplier: 60, tickSize: 0.5, marginRate: 0.15 },
  CU: { name: '铜', multiplier: 5, tickSize: 10, marginRate: 0.10 },
  AL: { name: '铝', multiplier: 5, tickSize: 5, marginRate: 0.10 },
  ZN: { name: '锌', multiplier: 5, tickSize: 5, marginRate: 0.10 },
  NI: { name: '镍', multiplier: 1, tickSize: 10, marginRate: 0.12 },
  AG: { name: '白银', multiplier: 15, tickSize: 1, marginRate: 0.12 },
  AU: { name: '黄金', multiplier: 1000, tickSize: 0.02, marginRate: 0.08 },
  M: { name: '豆粕', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  Y: { name: '豆油', multiplier: 10, tickSize: 2, marginRate: 0.08 },
  OI: { name: '菜油', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  RM: { name: '菜粕', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  P: { name: '棕榈油', multiplier: 10, tickSize: 2, marginRate: 0.08 },
  A: { name: '豆一', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  MA: { name: '甲醇', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  TA: { name: 'PTA', multiplier: 5, tickSize: 2, marginRate: 0.08 },
  PP: { name: '聚丙烯', multiplier: 5, tickSize: 1, marginRate: 0.08 },
  L: { name: '塑料', multiplier: 5, tickSize: 1, marginRate: 0.08 },
  SA: { name: '纯碱', multiplier: 20, tickSize: 1, marginRate: 0.10 },
  FU: { name: '燃油', multiplier: 10, tickSize: 1, marginRate: 0.10 },
  BU: { name: '沥青', multiplier: 10, tickSize: 2, marginRate: 0.10 },
  JD: { name: '鸡蛋', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  AP: { name: '苹果', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  LH: { name: '生猪', multiplier: 16, tickSize: 5, marginRate: 0.12 },
  SF: { name: '硅铁', multiplier: 5, tickSize: 2, marginRate: 0.08 },
  SM: { name: '锰硅', multiplier: 5, tickSize: 2, marginRate: 0.08 },
  FG: { name: '玻璃', multiplier: 20, tickSize: 1, marginRate: 0.10 },
  SC: { name: '原油', multiplier: 1000, tickSize: 0.1, marginRate: 0.12 },
  RU: { name: '橡胶', multiplier: 10, tickSize: 5, marginRate: 0.10 },
  CF: { name: '棉花', multiplier: 5, tickSize: 5, marginRate: 0.08 },
  SR: { name: '白糖', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  EG: { name: '乙二醇', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  SP: { name: '纸浆', multiplier: 10, tickSize: 2, marginRate: 0.08 },
  WR0: { name: '线材', multiplier: 10, tickSize: 1, marginRate: 0.08 },
  SI: { name: '工业硅', multiplier: 5, tickSize: 5, marginRate: 0.12 },
};

export function getSpec(code: string): ContractSpec {
  const key = code.replace(/0$/, '');
  return CONTRACT_SPECS[key] || { name: code, multiplier: 10, tickSize: 1, marginRate: 0.10 };
}

// ============ 类型 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

interface TradeRecord {
  code: string; signalDate: string; entryDate: string;
  direction: 'LONG' | 'SHORT'; signalGrade: string; spectrum: string;
  entryPrice: number; stopLoss: number; target: number;
  exitDate: string | null; exitPrice: number;
  exitReason: 'target' | 'stop' | 'timeout' | 'shock' | 'rollover';
  holdDays: number; result: string; pnl: number; pnlPct: number; rMultiple: number;
  posMul: number;
  lots: number;
}

export interface BacktestResult {
  params: Record<string, number | string>;
  summary: Record<string, number>;
  byGrade: Record<string, Record<string, number>>;
  bySpectrum: Record<string, Record<string, number>>;
  trades: TradeRecord[];
  equityCurve: { date: string; equity: number }[];
}

const CACHE_DIR = path.join(process.cwd(), 'data-cache');
const GRADE_ORDER = ['L0', 'L1', 'L2', 'L3', 'L4'];

// ============ 工具函数 ============

export function loadBars(code: string): Bar[] {
  try {
    const fp = path.join(CACHE_DIR, `${code}.json`);
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data?.bars && Array.isArray(data.bars)) return data.bars;
    return [];
  } catch { return []; }
}

/**
 * v2: 修复止损/目标位计算
 * 
 * 核心改动:
 * 1. 止损 = max(key_levels.swing点, ATR×1.5) — 保证止损不会太紧
 * 2. 目标位: 优先mm_tier1（需通过完成度过滤），否则用 ATR×3
 * 3. 强制 R:R >= 1.5:1（旧版是0.5太松）
 * 4. 止损距离下限 = ATR×1.5（不被2%固定比例替代）
 */
export function extractTradeParams(row: V16Row, bars: Bar[], idx: number, opts?: {
  stopAtrMult?: number;
  targetAtrMult?: number;
  minRR?: number;
}) {
  if (!row.ai_direction || row.ai_direction === '中性') return null;
  const lastBar = bars[idx];
  const entryPrice = lastBar.c;
  const atrVal = computeATR(bars.slice(0, idx + 1));
  if (atrVal <= 0) return null;

  const stopAtrMult = opts?.stopAtrMult ?? 1.5;
  const targetAtrMult = opts?.targetAtrMult ?? 3.0;
  const minRR = opts?.minRR ?? 1.0; // 回测论证: RR≥1.0收益2064%是RR≥1.5(1745%)的1.18倍

  const minStopDistance = atrVal * stopAtrMult;

  let stopLoss = 0;
  if (row.key_levels) {
    if (row.ai_direction === '多') {
      const swingStop = row.key_levels.support || 0;
      // 止损取swing低点和ATR止损中更远的（给趋势呼吸空间）
      const atrStop = entryPrice - minStopDistance;
      stopLoss = swingStop > 0 && swingStop < entryPrice
        ? Math.min(swingStop, atrStop)  // swing点更近就用ATR，swing点更远就用swing
        : atrStop;
    } else {
      const swingStop = row.key_levels.resistance || 0;
      const atrStop = entryPrice + minStopDistance;
      stopLoss = swingStop > 0 && swingStop > entryPrice
        ? Math.max(swingStop, atrStop)
        : atrStop;
    }
  }
  if (stopLoss === 0) {
    stopLoss = row.ai_direction === '多' ? entryPrice - minStopDistance : entryPrice + minStopDistance;
  }

  // 验证止损方向正确
  if (row.ai_direction === '多' && stopLoss >= entryPrice) return null;
  if (row.ai_direction === '空' && stopLoss <= entryPrice) return null;

  // 目标位
  let target = 0;
  const mmSameDir = row.mm_found && row.mm_direction === (row.ai_direction === '多' ? '多' : '空');

  if (mmSameDir && row.mm_tier1 != null && row.mm_tier1 > 0) {
    // mm_tier1已通过V18完成度过滤（在v16_engine中），可直接使用
    target = row.ai_direction === '多'
      ? Math.max(row.mm_tier1, entryPrice * 1.01)
      : Math.min(row.mm_tier1, entryPrice * 0.99);
  }

  // mm不可用时用ATR×targetAtrMult做目标
  if (target === 0 || target === entryPrice || Math.abs(target - entryPrice) / entryPrice < 0.005) {
    target = row.ai_direction === '多' ? entryPrice + targetAtrMult * atrVal : entryPrice - targetAtrMult * atrVal;
  }

  // 验证目标方向正确
  if (row.ai_direction === '多' && target <= entryPrice) return null;
  if (row.ai_direction === '空' && target >= entryPrice) return null;

  // 强制 R:R >= minRR
  const risk = Math.abs(entryPrice - stopLoss);
  const reward = Math.abs(target - entryPrice);
  if (risk <= 0) return null;
  const rr = reward / risk;
  if (rr < minRR) return null; // R:R不够直接跳过

  return { entryPrice, stopLoss, target, rr };
}

/**
 * v4: 修复成交价越界问题
 * 
 * 保守成交价：确保 exitPrice 在 bar 的 [l, h] 范围内
 * - 同时触及时计为止损（保守假设）
 * - 考虑跳空：如果开盘价已越过止损/目标位，使用开盘价
 * - 考虑价格回落：如果收盘价反向偏离目标/止损，使用收盘价
 */
export function simulate(direction: 'LONG' | 'SHORT', entryPrice: number, stopLoss: number, target: number, futureBars: Bar[], maxDays: number, shockDates?: Set<string>, rolloverDates?: Set<string>) {
  const bars = futureBars.slice(0, maxDays);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // v3: 黑天鹅冲击提前平仓（防止跳空/滑点）
    if (shockDates && shockDates.has(b.date)) {
      return { exitPrice: b.c, exitDate: b.date, exitReason: 'shock' as const, holdDays: i + 1 };
    }
    // v5: 换月日强制平仓（避免持仓跨越合约切换产生虚假盈亏）
    if (rolloverDates && rolloverDates.has(b.date)) {
      return { exitPrice: b.c, exitDate: b.date, exitReason: 'rollover' as const, holdDays: i + 1 };
    }
    if (direction === 'LONG') {
      const hitTarget = b.h >= target;
      const hitStop = b.l <= stopLoss;
      // 同时触及算止损（保守）
      if (hitStop && hitTarget) {
        // 成交价必须在 bar 范围内
        const exitPrice = Math.max(b.l, Math.min(b.h, stopLoss));
        return { exitPrice, exitDate: b.date, exitReason: 'stop' as const, holdDays: i + 1 };
      }
      if (hitTarget) {
        // 保守成交价：如果收盘价低于目标，说明价格回落，使用收盘价
        // 确保成交价在 bar 范围内
        const exitPrice = Math.max(b.l, Math.min(b.h, Math.min(target, b.c)));
        return { exitPrice, exitDate: b.date, exitReason: 'target' as const, holdDays: i + 1 };
      }
      if (hitStop) {
        // 保守成交价：如果收盘价高于止损，说明价格反弹，使用收盘价
        // 考虑跳空：如果开盘价已低于止损，使用开盘价
        const exitPrice = Math.max(b.l, Math.min(b.h, b.o <= stopLoss ? b.o : Math.max(stopLoss, b.c)));
        return { exitPrice, exitDate: b.date, exitReason: 'stop' as const, holdDays: i + 1 };
      }
    } else {
      const hitTarget = b.l <= target;
      const hitStop = b.h >= stopLoss;
      if (hitStop && hitTarget) {
        const exitPrice = Math.max(b.l, Math.min(b.h, stopLoss));
        return { exitPrice, exitDate: b.date, exitReason: 'stop' as const, holdDays: i + 1 };
      }
      if (hitTarget) {
        // 保守成交价：如果收盘价高于目标，说明价格反弹，使用收盘价
        const exitPrice = Math.max(b.l, Math.min(b.h, Math.max(target, b.c)));
        return { exitPrice, exitDate: b.date, exitReason: 'target' as const, holdDays: i + 1 };
      }
      if (hitStop) {
        // 考虑跳空：如果开盘价已高于止损，使用开盘价
        const exitPrice = Math.max(b.l, Math.min(b.h, b.o >= stopLoss ? b.o : Math.min(stopLoss, b.c)));
        return { exitPrice, exitDate: b.date, exitReason: 'stop' as const, holdDays: i + 1 };
      }
    }
  }
  const lastBar = bars[bars.length - 1];
  return { exitPrice: lastBar.c, exitDate: lastBar.date, exitReason: 'timeout' as const, holdDays: bars.length };
}

export function calcPnl(direction: 'LONG' | 'SHORT', code: string, entryPrice: number, exitPrice: number) {
  const spec = getSpec(code);
  // 使用增强版交易成本模型（含手续费+滑点+冲击成本）
  const contractValue = entryPrice * spec.multiplier;
  // 手续费：按合约价值 × 费率（开+平）
  const feeRate = 0.00015; // 万1.5（含交易所+期货公司）
  const fee = contractValue * feeRate * 2;
  // 滑点：按 tickSize × 1 tick（保守估计）
  const slippage = spec.tickSize * spec.multiplier * 1;
  // 冲击成本：按合约价值的 0.02%（流动性差的品种更高）
  const impactCost = contractValue * 0.0002;
  const priceDiff = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = priceDiff * spec.multiplier;
  const netPnl = grossPnl - fee - slippage - impactCost;
  return { grossPnl, fee, slippage, impactCost, netPnl, totalCost: fee + slippage + impactCost };
}

// ============ 主函数 ============

export async function runBacktest(opts: {
  startCapital?: number; maxPositionPct?: number;
  minSignalGrade?: string; maxHoldDays?: number; warmupBars?: number;
  dataDir?: string; codes?: string[]; cooldownBars?: number; returnAllTrades?: boolean;
  newsFilter?: {
    mode: 'none' | 'riskOff' | 'full';
    cooldownMap?: Map<string, boolean[]>;      // 品种 → 每根bar是否处于冲击冷却窗口
    shockDirMap?: Map<string, Array<'up' | 'down' | null>>; // 品种 → 每根bar最近冲击方向
    shockDates?: Map<string, Set<string>>;     // 品种 → 冲击日期（用于持仓提前平仓）
    resonanceBoost?: number;                   // 共振仓位系数
    divergenceCut?: number;                    // 背离仓位系数
  };
  edgeLookback?: number; allowRangeTrading?: boolean;
  gate4Config?: import('./v16_engine').Gate4Config;
  pThreshold?: number;
  equationMode?: 'hard' | 'soft' | 'none';
  softEquationMul?: number;
  chExemptEquation?: boolean;
  stopAtrMult?: number;
  targetAtrMult?: number;
  minRR?: number;
  nonGreenMul?: number;
  counterCampMul?: number;
  campWindow?: number;
  trendFilter?: boolean; // EMA20趋势过滤：只做顺势信号
  // 组合风控
  maxPositions?: number; // 最大同时持仓数
  maxPerSector?: number; // 单板块最大持仓数
  sectorMap?: Record<string, string>; // 品种→板块映射
  // 方向分离参数：做多/做空可使用不同参数（未指定的回退到全局参数）
  sideParams?: {
    long?: { stopAtrMult?: number; targetAtrMult?: number; minRR?: number; minSignalGrade?: string; maxHoldDays?: number; trendFilter?: boolean; cooldownBars?: number };
    short?: { stopAtrMult?: number; targetAtrMult?: number; minRR?: number; minSignalGrade?: string; maxHoldDays?: number; trendFilter?: boolean; cooldownBars?: number };
  };
  /** 预扫描信号缓存：code -> V16Row[]（从 warmupBars 索引对齐） */
  signalCache?: Map<string, import('./v16_types').V16Row[]>;
  /** 熔断机制（可选）：连亏 lossStreak 笔后暂停开仓 pauseBars 根K线 */
  circuitBreaker?: { lossStreak: number; pauseBars: number };
  /** 静默模式：不打印每次回测的逐笔日志 */
  quiet?: boolean;
} = {}): Promise<BacktestResult> {
  const startCapital = opts.startCapital || 500000;
  const maxPositionPct = opts.maxPositionPct || 0.15;
  const minSignalGrade = opts.minSignalGrade || 'L2';
  const maxHoldDays = opts.maxHoldDays || 15;
  const edgeLookback = opts.edgeLookback ?? 70;
  const allowRangeTrading = opts.allowRangeTrading ?? false;
  const gate4Config = opts.gate4Config;
  const pThreshold = opts.pThreshold;
  const equationMode = opts.equationMode ?? 'none';
  const softEquationMul = opts.softEquationMul ?? 0.5;
  const chExemptEquation = opts.chExemptEquation ?? false;
  const warmupBars = opts.warmupBars || 20;
  const cooldownBars = opts.cooldownBars ?? 0;
  const circuitBreaker = opts.circuitBreaker;
  const dataDir = opts.dataDir || CACHE_DIR;
  const nonGreenMul = opts.nonGreenMul ?? 1.0;
  const counterCampMul = opts.counterCampMul ?? 1.0;
  const campWindow = opts.campWindow ?? 21;
  const trendFilter = opts.trendFilter ?? false;
  const maxPositions = opts.maxPositions ?? 0; // 0 = unlimited
  const maxPerSector = opts.maxPerSector ?? 0; // 0 = unlimited
  const sectorMap = opts.sectorMap || {};
  // 多空分离参数（v3 扩展）：longParams / shortParams 覆盖同方向参数（兼容旧调用）
  // 例: shortParams: { stopAtrMult: 2.0, trendFilter: true, minSignalGrade: 'L3', maxHoldDays: 20 }
  const longParams = (opts as any).longParams || {};
  const shortParams = (opts as any).shortParams || {};
  const nf = opts.newsFilter; // 新闻/黑天鹅过滤器（默认 undefined，完全不影响原逻辑）

  // 组合风控：持仓跟踪 { barIndex, exitBar, code, sector }
  interface PositionSlot { exitBar: number; code: string; sector: string; }
  const openPositions: PositionSlot[] = [];
  const cleanExpiredPositions = (currentBar: number) => {
    while (openPositions.length > 0 && openPositions[0].exitBar <= currentBar) {
      openPositions.shift();
    }
  };
  const checkRiskLimits = (code: string, currentBar: number, estimatedExit: number): boolean => {
    cleanExpiredPositions(currentBar);
    // v4: 品种级别互斥——同品种同时只允许1笔持仓
    const hasSameVariety = openPositions.some(p => p.code === code);
    if (hasSameVariety) return false;
    if (maxPositions > 0 && openPositions.length >= maxPositions) return false;
    if (maxPerSector > 0) {
      const sector = sectorMap[code] || '其他';
      const sectorCount = openPositions.filter(p => p.sector === sector).length;
      if (sectorCount >= maxPerSector) return false;
    }
    return true;
  };
  const addPosition = (code: string, exitBar: number) => {
    const sector = sectorMap[code] || '其他';
    openPositions.push({ exitBar, code, sector });
    openPositions.sort((a, b) => a.exitBar - b.exitBar);
  };

  const loadBarsFrom = (code: string): Bar[] => {
    try {
      const fp = path.join(dataDir, `${code}.json`);
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) return data;
      if (data?.bars && Array.isArray(data.bars)) return data.bars;
      return [];
    } catch { return []; }
  };

  // v5: 加载换月日期集合（用于换月日强制平仓/不开仓）
  const loadRolloverDates = (code: string): Set<string> => {
    const dates = new Set<string>();
    try {
      const fp = path.join(dataDir, `${code}_rollover.json`);
      if (!fs.existsSync(fp)) return dates;
      const raw = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      const rollovers = data?.rollovers;
      if (Array.isArray(rollovers)) {
        for (const r of rollovers) {
          if (r?.date) dates.add(r.date);
        }
      }
    } catch { /* 忽略换月文件解析错误 */ }
    return dates;
  };

  const allCodes = opts.codes || Object.keys(VARIETIES);
  const allTrades: TradeRecord[] = [];
  // v8: 复利权益——初始为起始资金，每笔交易后更新（用于资金管理计算手数）
  let runningEquity = startCapital;
  // v9: 记录权益曲线（用于准确计算最大回撤）
  const equityHistory: { date: string; equity: number }[] = [{ date: 'start', equity: startCapital }];

  if (!opts.quiet) console.log(`[回测v2] ${allCodes.length}品种, 本金${startCapital}, 仓位${(maxPositionPct*100).toFixed(0)}%, 最低等级${minSignalGrade}, 持仓${maxHoldDays}bar, 数据:${dataDir}`);

  for (const code of allCodes) {
    const bars = loadBarsFrom(code);
    if (bars.length < warmupBars + maxHoldDays + 2) continue;

    // v5: 加载换月日期集合
    const rolloverDates = loadRolloverDates(code);

    // v2: 品种级别去重——同品种同一时间只有一个持仓
    let lastExitBar = -1; // 上次出场的bar索引
    // 熔断状态（可选）：连亏N笔后暂停M根K线开仓
    let cbLossStreak = 0;
    let cbFrozenUntilBar = -1;
    // 方向阵营追踪（用单品种历史方向作为市场阵营代理）
    let campLongCount = 0, campShortCount = 0;
    const campHistory: string[] = []; // 记录最近的方向

    for (let i = warmupBars; i < bars.length - maxHoldDays - 1; i++) {
      // v2: 冷却期检查
      if (i <= lastExitBar + cooldownBars) continue;
      // 熔断检查（可选）：连亏N笔后暂停M根K线开仓
      if (circuitBreaker && cbFrozenUntilBar > i) continue;

      const histBars = bars.slice(0, i) as unknown as BarData[];
      const futureBars = bars.slice(i);

      try {
        // 预扫描缓存：跳过重复扫描（同一品种多次回测时大幅提速）
        const cacheArr = opts.signalCache?.get(code);
        const row = cacheArr && cacheArr[i - warmupBars]
          ? cacheArr[i - warmupBars]
          : await scanV16Variety(code, histBars, code, { edgeLookback, allowRangeTrading, gate4Config });

        // 更新方向阵营历史
        const dir = row.ai_direction;
        campHistory.push(dir);
        if (campHistory.length > campWindow) {
          const old = campHistory.shift();
          if (old === '多') campLongCount--;
          else if (old === '空') campShortCount--;
        }
        if (dir === '多') campLongCount++;
        else if (dir === '空') campShortCount++;

        // 计算当前阵营
        const isGreen = campLongCount >= campWindow || campShortCount >= campWindow;
        const isCounterCamp = (campLongCount >= campWindow && dir !== '多') || (campShortCount >= campWindow && dir !== '空');

        // 统一 V16.2 过滤（与 APP buildV16Tradable 同一真相源）
        const ev = evaluateV16Row(row, { allowRangeTrading, pThreshold, equationMode, softEquationMul, chExemptEquation });
        if (!ev.tradable) continue;

        // ===== 方向分离参数（做多/做空可使用不同参数）=====
        const direction: 'LONG' | 'SHORT' = dir === '多' ? 'LONG' : 'SHORT';
        const side = direction === 'LONG' ? 'long' : 'short';
        const sp = opts.sideParams?.[side] || {};
        const sideStop = sp.stopAtrMult ?? opts.stopAtrMult;
        const sideTarget = sp.targetAtrMult ?? opts.targetAtrMult;
        const sideMinRR = sp.minRR ?? opts.minRR;
        const sideMinGrade = sp.minSignalGrade ?? opts.minSignalGrade ?? minSignalGrade;
        const sideTrend = sp.trendFilter ?? opts.trendFilter;
        const sideMaxHold = sp.maxHoldDays ?? opts.maxHoldDays ?? maxHoldDays;

        // ===== 趋势过滤（模拟多周期融合：日线定方向）=====
        if (sideTrend && histBars.length >= 20) {
          // 计算EMA20
          let ema = histBars[0].c;
          const k = 2 / 21;
          for (let j = 1; j < histBars.length; j++) {
            ema = histBars[j].c * k + ema * (1 - k);
          }
          const trendDir = histBars[histBars.length - 1].c > ema ? '多' : '空';
          // 信号方向与趋势不一致则过滤
          if (dir !== trendDir) continue;
        }

        // ===== 新闻/黑天鹅过滤器（v3 扩展）=====
        if (nf && nf.mode !== 'none') {
          // 冷却窗口过滤：冲击发生后的 cooldown 根内跳过开仓
          const cdArr = nf.cooldownMap?.get(code);
          if (cdArr && cdArr[i]) continue;
        }

        // 回测特有: 信号等级门槛（L3+）
        if (GRADE_ORDER.indexOf(row.signal_grade || 'L0') < GRADE_ORDER.indexOf(sideMinGrade)) continue;

        // 方向阵营降级/过滤
        let campMul = 1.0;
        if (!isGreen && (nonGreenMul < 1.0 || counterCampMul < 1.0)) {
          campMul = nonGreenMul;
        }
        if (isCounterCamp) {
          campMul = Math.min(campMul, counterCampMul);
        }
        // 融合过滤：counterCampMul=0 时直接跳过逆势信号（模拟60min方向冲突过滤）
        if (isCounterCamp && counterCampMul === 0) continue;
        // 非GREEN过滤：nonGreenMul=0 时跳过非GREEN阵营信号
        if (!isGreen && nonGreenMul === 0) continue;

        // v2: 止损/目标位计算
        const params = extractTradeParams(row, bars, i, {
          stopAtrMult: sideStop,
          targetAtrMult: sideTarget,
          minRR: sideMinRR,
        });
        if (!params) continue;

        // 共振/背离增强：full 模式下，最近冲击方向与技术方向共振时加仓、背离时降仓
        let finalPosMul = ev.posMul * campMul;
        if (nf && nf.mode === 'full') {
          const dirArr = nf.shockDirMap?.get(code);
          const dir = dirArr ? dirArr[i] : null;
          if (dir) {
            const techDir = direction === 'LONG' ? 'up' : 'down';
            if (dir === techDir) finalPosMul *= (nf.resonanceBoost ?? 1.3);
            else finalPosMul *= (nf.divergenceCut ?? 0.5);
          }
        }
        // ===== 组合风控检查 =====
        const estimatedExitBar = Math.min(i + sideMaxHold, bars.length - 1);
        if (!checkRiskLimits(code, i, estimatedExitBar)) continue;

        // v5: 换月日不开新仓（避免在合约切换当天入场）
        if (rolloverDates.has(bars[i].date)) continue;

        const sim = simulate(direction, params.entryPrice, params.stopLoss, params.target, futureBars, sideMaxHold, nf?.shockDates?.get(code), rolloverDates);
        const rawPnl = calcPnl(direction, code, params.entryPrice, sim.exitPrice);

        // v8: 资金管理——按当前权益×仓位计算等效手数（复利）
        // 等效手数 = 可用资金 / 每手保证金，finalPosMul 保留为 0.7~1.3 的信号强度因子
        // v9: 破产保护——权益归零则停止交易
        if (runningEquity <= 0) continue;
        const spec = getSpec(code);
        const perLotMargin = params.entryPrice * spec.multiplier * spec.marginRate;
        const equivalentLots = perLotMargin > 0 ? Math.max(0, (runningEquity * maxPositionPct) / perLotMargin) : 0;
        if (equivalentLots < 0.01) continue; // 资金不足一手，跳过
        const totalPosMul = equivalentLots * finalPosMul;

        const pnl = { ...rawPnl, netPnl: rawPnl.netPnl * totalPosMul };

        // v4: 修复 R 倍数口径——risk 也要乘 totalPosMul
        const riskPerUnit = Math.abs(params.entryPrice - params.stopLoss) * spec.multiplier;
        const totalRisk = riskPerUnit * totalPosMul;
        // v4: 修复结果标记——基于实际盈亏而非出场原因
        const tradeResult = pnl.netPnl > 0 ? 'WIN' : pnl.netPnl < 0 ? 'LOSS' : 'EVEN';
        const rMultiple = totalRisk > 0 ? pnl.netPnl / totalRisk : 0;

        // 修复：盈亏%使用保证金作为分母（而非名义价值）
        const marginRequired = perLotMargin * totalPosMul;

        allTrades.push({
          result: tradeResult,
          code,
          signalDate: bars[i].date,
          entryDate: bars[i].date,
          direction,
          signalGrade: row.signal_grade || 'L0',
          spectrum: row.spectrum || '区间',
          entryPrice: params.entryPrice,
          stopLoss: params.stopLoss,
          target: params.target,
          exitDate: sim.exitDate,
          exitPrice: sim.exitPrice,
          exitReason: sim.exitReason,
          pnl: Math.round(pnl.netPnl),
          holdDays: sim.holdDays,
          pnlPct: marginRequired > 0 ? Math.round((pnl.netPnl / marginRequired) * 10000) / 100 : 0,
          rMultiple: Math.round(rMultiple * 100) / 100,
          posMul: Math.round(totalPosMul * 100) / 100,
          lots: Math.round(equivalentLots * 100) / 100,
        });

        // v8: 复利——每笔交易后更新权益，供下一笔计算手数
        runningEquity += pnl.netPnl;
        
        // v9: 记录权益曲线
        equityHistory.push({ date: sim.exitDate || bars[i].date, equity: runningEquity });

        // 记录持仓（用于组合风控）
        addPosition(code, i + sim.holdDays);

        // v2: 更新冷却期（如果这笔交易被止损，冷却2根K线）
        if (sim.exitReason === 'stop') {
          lastExitBar = i + sim.holdDays;
        }

        // 熔断状态更新（可选）：连亏N笔后冻结M根K线
        if (circuitBreaker) {
          if (pnl.netPnl <= 0) {
            cbLossStreak++;
            if (cbLossStreak >= circuitBreaker.lossStreak) {
              cbFrozenUntilBar = i + sim.holdDays + circuitBreaker.pauseBars;
              cbLossStreak = 0;
            }
          } else {
            cbLossStreak = 0;
          }
        }
      } catch { /* skip individual scan errors */ }
    }
  }

  // 排序
  allTrades.sort((a, b) => a.signalDate.localeCompare(b.signalDate));
  if (!opts.quiet) console.log(`[回测v2] 总信号: ${allTrades.length}（经过完整V16.2过滤链）`);

  // 模拟资金曲线
  const equityCurve: { date: string; equity: number }[] = [];
  let capital = startCapital;
  const dateMap = new Map<string, number>();
  for (const t of allTrades) {
    if (t.exitDate) {
      dateMap.set(t.exitDate, (dateMap.get(t.exitDate) || 0) + t.pnl);
    }
  }
  const dates = [...new Set(allTrades.map(t => t.signalDate).concat(allTrades.map(t => t.exitDate || '')))].filter(Boolean).sort();
  for (const d of dates) {
    capital += dateMap.get(d) || 0;
    equityCurve.push({ date: d, equity: Math.round(capital * 100) / 100 });
  }

  // 统计
  const wins = allTrades.filter(t => t.pnl > 0);
  const losses = allTrades.filter(t => t.pnl <= 0);
  const totalPnl = allTrades.reduce((s, t) => s + t.pnl, 0);

  // 最大回撤（v9: 使用实际权益曲线 equityHistory，而非重新计算的 equityCurve）
  let peak = startCapital, maxDD = 0;
  for (const pt of equityHistory) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = peak > 0 ? (peak - pt.equity) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // 夏普（v9: 使用 equityHistory）
  const dailyReturns: number[] = [];
  for (let i = 1; i < equityHistory.length; i++) {
    if (equityHistory[i - 1].equity > 0) {
      dailyReturns.push((equityHistory[i].equity - equityHistory[i - 1].equity) / equityHistory[i - 1].equity);
    }
  }
  const avgRet = dailyReturns.length > 0 ? dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length : 0;
  const stdRet = dailyReturns.length > 1
    ? Math.sqrt(dailyReturns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (dailyReturns.length - 1))
    : 0;
  const sharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(252) : 0;

  // 连胜/连亏
  let maxCW = 0, maxCL = 0, cw = 0, cl = 0;
  for (const t of allTrades) {
    if (t.pnl > 0) { cw++; cl = 0; if (cw > maxCW) maxCW = cw; }
    else { cl++; cw = 0; if (cl > maxCL) maxCL = cl; }
  }

  const winCount = wins.length;
  const winRate = allTrades.length > 0 ? winCount / allTrades.length : 0;
  const avgWin = winCount > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / winCount : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const r2 = (v: number) => Math.round(v * 100) / 100;

  // 按等级分组
  const byGrade: Record<string, { signals: number; trades: number; wins: number; winRate: number; avgRR: number; totalPnlPct: number }> = {};
  for (const g of GRADE_ORDER) {
    const gt = allTrades.filter(t => t.signalGrade === g);
    if (gt.length === 0) continue;
    const gw = gt.filter(t => t.pnl > 0);
    const grr = gt.length > 0 ? gt.reduce((s, t) => s + t.rMultiple, 0) / gt.length : 0;
    byGrade[g] = {
      signals: gt.length, trades: gt.length,
      wins: gw.length, winRate: r2(gw.length / gt.length),
      avgRR: r2(grr),
      totalPnlPct: r2(gt.reduce((s, t) => s + t.pnl, 0) / startCapital),
    };
  }

  // v9: 使用实际复利权益（runningEquity），而非 startCapital + totalPnl（后者在复利模式下不准确）
  const finalEquity = runningEquity;
  const totalReturn = (runningEquity - startCapital) / startCapital;

  // 频谱分类
  const bySpectrum: Record<string, any> = {};
  for (const t of allTrades) {
    const spec = t.spectrum || '区间';
    if (!bySpectrum[spec]) bySpectrum[spec] = { trades: 0, wins: 0, totalPnl: 0, totalRR: 0, totalReturn: 0 };
    bySpectrum[spec].trades++;
    if (t.pnl > 0) bySpectrum[spec].wins++;
    bySpectrum[spec].totalPnl += t.pnl;
    bySpectrum[spec].totalRR += t.rMultiple;
  }
  for (const k of Object.keys(bySpectrum)) {
    const d = bySpectrum[k];
    d.totalPnl = r2(d.totalPnl);
    d.totalRR = r2(d.totalRR);
    d.winRate = r2(d.trades > 0 ? d.wins / d.trades : 0);
    d.avgRR = r2(d.trades > 0 ? d.totalRR / d.trades : 0);
    d.totalReturn = r2(d.trades > 0 ? d.totalPnl / startCapital : 0);
  }

  const summary = {
    totalSignals: allTrades.length,
    totalTrades: allTrades.length,
    wins: winCount,
    losses: losses.length,
    winRate: r2(winRate),
    avgRR: r2(avgLoss > 0 ? avgWin / avgLoss : 0),
    totalReturn: r2(totalReturn),
    finalEquity: r2(finalEquity),
    maxDrawdown: r2(Math.min(maxDD, 1.0)),
    sharpeRatio: r2(sharpe),
    avgDailyReturn: r2(avgRet),
    profitFactor: r2(grossLoss > 0 ? grossProfit / grossLoss : 0),
    maxConsecutiveWins: maxCW,
    maxConsecutiveLosses: maxCL,
  };

  if (!opts.quiet) console.log(`[回测v2] 总${allTrades.length}笔 胜率${(winRate*100).toFixed(1)}% R:R=${summary.avgRR.toFixed(2)} 收益${(totalReturn*100).toFixed(1)}% 夏普${sharpe.toFixed(2)} 回撤${(maxDD*100).toFixed(1)}%`);

  return {
    params: { startCapital, maxPositionPct, minSignalGrade, maxHoldDays, warmupBars, startDate: allTrades[0]?.signalDate || '', endDate: allTrades[allTrades.length - 1]?.exitDate || '' },
    summary,
    byGrade,
    bySpectrum,
    trades: opts.returnAllTrades ? allTrades : allTrades.slice(-200),
    equityCurve: opts.returnAllTrades ? equityCurve : equityCurve.slice(-200),
  };
}
