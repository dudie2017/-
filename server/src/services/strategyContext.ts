/**
 * 策略上下文服务（Strategy Context）
 *
 * 基于 1000 次 LHS 回测实验（*_1000Experiments.json）与品种熔断参数表（circuitBreakerParams.ts），
 * 生成每个品种的"策略上下文"——把回测验证结论标准化，供交易建议、AI 专家、执行清单使用。
 *
 * 数据源：
 *  - server/src/data/{CODE}_1000Experiments.json   （排名/方差分解/脆弱点/最优配方/专项分析）
 *  - server/src/data/circuitBreakerParams.ts        （五方验证的熔断档位）
 *  - server/src/data/longOptParams.ts / shortOptParams.ts （生产参数：持仓周期）
 */

import * as fs from 'fs';
import * as path from 'path';
import { CIRCUIT_BREAKER_PARAMS } from '../data/circuitBreakerParams';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');

// 回测实验内存缓存：避免每次请求重复 readFileSync + JSON.parse 59 个 ~1MB 文件（首次冷启动曾达 14s）
const experimentCache = new Map<string, any | null>();

export const VARIETY_NAMES: Record<string, string> = {
  SC0: '原油',
  CU0: '铜',
  LH0: '生猪',
  JM0: '焦煤',
  M0: '豆粕',
  AG0: '沪银',
  RU0: '橡胶',
  AU0: '黄金',
  SP0: '纸浆',
  EC0: '集运欧线',
  CF0: '棉花',
  I0: '铁矿',
  RB0: '螺纹',
  HC0: '热卷',
  J0: '焦炭',
  Y0: '豆油',
  P0: '棕榈油',
  OI0: '菜油',
  RM0: '菜粕',
  A0: '豆一',
  B0: '豆二',
  TA0: 'PTA',
  MA0: '甲醇',
  PP0: '聚丙烯',
  L0: '塑料',
  EG0: '乙二醇',
  FU0: '燃油',
  LU0: '低硫燃油',
  BU0: '沥青',
  PG0: '液化气',
  NR0: '20号胶',
  C0: '玉米',
  CS0: '淀粉',
  SR0: '白糖',
  AL0: '沪铝',
  ZN0: '沪锌',
  NI0: '沪镍',
  PB0: '沪铅',
  SN0: '沪锡',
  SS0: '不锈钢',
  BC0: '国际铜',
  SF0: '硅铁',
  SM0: '锰硅',
  FG0: '玻璃',
  SA0: '纯碱',
  AP0: '苹果',
  CJ0: '红枣',
  UR0: '尿素',
  PK0: '花生',
  SH0: '烧碱',
  PX0: '对二甲苯',
  BR0: '丁二烯橡胶',
  AO0: '氧化铝',
  CL0: '原油(外盘)',
  HC1: '热卷(下月)',
};

export interface StrategyContext {
  code: string;
  name: string;
  verified: boolean;
  /** 1000 次实验验证排名 */
  verification: {
    pnlRank: number;
    ddRank: number;
    captureRank: number;
    total: number;
    pnlTopPct: number; // 越小越靠前
    ddTopPct: number;
  } | null;
  /** 方向有效性（基于生产形态捕获率 + 采样均值） */
  directionBias: {
    dominant: 'LONG' | 'SHORT' | 'BALANCED';
    longCapture: number; // 生产基线捕获率
    shortCapture: number;
    splitLongAvg: number | null; // 采样空间 split 组均值
    splitShortAvg: number | null;
    note: string;
  } | null;
  /** 熔断档位（五方回测验证） */
  circuitBreaker: { lossStreak: number; pauseBars: number } | null;
  /** 持仓周期建议 */
  hold: {
    productionLong: number;
    productionShort: number;
    verifiedBest: number | null; // 采样空间内（n>=30）均值最优
    note: string;
  } | null;
  /** 脆弱点警示 */
  fragilityWarnings: string[];
  /** 捕获率>100% 解读 */
  captureNote: string;
}

function loadExperiment(code: string): any | null {
  if (experimentCache.has(code)) {
    return experimentCache.get(code)!;
  }
  let result: any | null = null;
  try {
    const f = path.join(DATA_DIR, `${code}_1000Experiments.json`);
    if (fs.existsSync(f)) {
      result = JSON.parse(fs.readFileSync(f, 'utf8'));
    }
  } catch {
    result = null;
  }
  experimentCache.set(code, result);
  return result;
}

/** 找到 specific 字段名（ru0Specific / jm0Specific ...） */
function findSpecificKey(d: any): string | null {
  if (!d) return null;
  const k = Object.keys(d).find((x) => x.toLowerCase().includes('specific'));
  return k ?? null;
}

/** 方向偏好判断 */
function judgeDirectionBias(d: any): StrategyContext['directionBias'] {
  const stats = d?.baseline?.stats;
  if (!stats) return null;
  // 零交易品种（如 SR0）没有可参考的多空捕获率，返回 null 而非"均衡"，避免误导
  const totalTrades = stats.totalTrades ?? 0;
  if (totalTrades === 0) return null;
  const longCapture = stats.longCapture ?? 0;
  const shortCapture = stats.shortCapture ?? 0;

  // 采样空间 split 组均值（更稳健的方向倾向）
  let splitLongAvg: number | null = null;
  let splitShortAvg: number | null = null;
  if (d) {
    const spec = d[findSpecificKey(d) ?? ''];
    const splitMode = (spec?.directionModes ?? []).find(
      (m: any) => m.directionMode === 'split'
    );
    splitLongAvg = splitMode?.avgLongCapture ?? null;
    splitShortAvg = splitMode?.avgShortCapture ?? null;
  }

  let dominant: 'LONG' | 'SHORT' | 'BALANCED' = 'BALANCED';
  const gap = longCapture - shortCapture;

  // 方向偏好判断：优先利用负捕获率语义（某方向亏钱、另一方向赚钱时，明确偏好赚钱方向）
  if (longCapture > 0.02 && shortCapture < -0.02) {
    dominant = 'LONG';
  } else if (shortCapture > 0.02 && longCapture < -0.02) {
    dominant = 'SHORT';
  } else if (gap > 0.05) {
    dominant = 'LONG';
  } else if (gap < -0.05) {
    dominant = 'SHORT';
  }

  let note = '';
  if (dominant === 'LONG') {
    note = `做多捕获 ${(longCapture * 100).toFixed(0)}% 明显优于做空 ${(shortCapture * 100).toFixed(0)}%，做多是该品种主导方向；做空建议仅在高信号（≥L2）且结构确认时参与`;
  } else if (dominant === 'SHORT') {
    note = `做空捕获 ${(shortCapture * 100).toFixed(0)}% 明显优于做多 ${(longCapture * 100).toFixed(0)}%，做空是主导方向；做多建议仅在强趋势确认时参与`;
  } else {
    note = `多空捕获率接近（多 ${(longCapture * 100).toFixed(0)}% / 空 ${(shortCapture * 100).toFixed(0)}%），双向均可，按信号等级与结构验证择优入场`;
  }
  if (splitLongAvg != null && splitShortAvg != null) {
    note += `。采样空间均值：做多 ${(splitLongAvg * 100).toFixed(0)}% / 做空 ${(splitShortAvg * 100).toFixed(0)}%`;
  }
  return { dominant, longCapture, shortCapture, splitLongAvg, splitShortAvg, note };
}

/** 持仓周期：生产值 + 采样空间最优 */
function judgeHold(code: string, d: any): StrategyContext['hold'] | null {
  const longOpt = LONG_OPT_PARAMS[code];
  const shortOpt = SHORT_OPT_PARAMS[code];
  if (!longOpt && !shortOpt) return null;
  const productionLong = longOpt?.maxHoldDays ?? 0;
  const productionShort = shortOpt?.maxHoldDays ?? 0;

  // 采样空间最优（specific 中 longHold/shortHold，n>=30）
  let verifiedBest: number | null = null;
  if (d) {
    const spec = d[findSpecificKey(d) ?? ''];
    if (spec) {
      const holdKey = Object.keys(spec).find((k) => k.includes('Hold'));
      if (holdKey) {
        const arr: any[] = spec[holdKey] ?? [];
        const valid = arr.filter((x) => (x.n ?? 0) >= 30 && typeof x.maxHoldDays === 'number');
        if (valid.length > 0) {
          const isLong = holdKey.includes('Long');
          const best = valid.reduce((a, b) =>
            ((isLong ? a.avgLongPnl : a.avgShortPnl) ?? 0) >
            ((isLong ? b.avgLongPnl : b.avgShortPnl) ?? 0)
              ? a
              : b
          );
          verifiedBest = best.maxHoldDays;
        }
      }
    }
  }

  const note =
    productionLong === productionShort
      ? `生产多空持仓均为 ${productionLong} 根；${
          verifiedBest ? `采样验证（n≥30）最优持仓为 ${verifiedBest} 根` : '持仓不敏感，维持生产值即可'
        }`
      : `生产做多持仓 ${productionLong} 根 / 做空 ${productionShort} 根；${
          verifiedBest ? `采样验证最优持仓约 ${verifiedBest} 根` : ''
        }`;
  return { productionLong, productionShort, verifiedBest, note };
}

/** 脆弱点警示（取 lift 最大的前 3 条，转中文提示） */
function buildFragilityWarnings(d: any): string[] {
  const factors: any[] = d?.fragility?.topFactors ?? [];
  const dimLabel: Record<string, string> = {
    directionMode: '方向模式',
    dataWindow: '数据窗口',
    maxHoldDays: '持仓周期',
    minSignalGrade: '信号等级',
    stopAtrMult: '止损倍数',
    targetAtrMult: '止盈倍数',
    cooldownBars: '冷却K线',
    trendFilter: '趋势过滤',
    bsMode: '黑天鹅防护',
    circuitBreaker: '熔断',
    volReduce: '波动率仓位',
    dailyLossLimit: '日亏损限额',
    entryEquation: '入场方程',
    rangeTrading: '区间交易',
    allowRangeTrading: '区间交易',
    positionPct: '仓位比例',
    startCapital: '资金规模',
    maxPositionPct: '最大仓位',
  };
  return factors.slice(0, 3).map((f) => {
    const dim = dimLabel[f.dimension] ?? f.dimension;
    return `${dim}「${f.value}」回测崩溃率提升 ${f.lift.toFixed(1)} 倍，应避免`;
  });
}

/** 捕获率>100% 解读 */
function buildCaptureNote(d: any): string {
  const stats = d?.baseline?.stats;
  if (!stats) return '';
  const lc = stats.longCapture ?? 0;
  const sc = stats.shortCapture ?? 0;
  const over = lc > 1.05 || sc > 1.05;
  if (!over) return '';
  const which = lc > sc ? '做多' : '做空';
  const val = (Math.max(lc, sc) * 100).toFixed(0);
  return `捕获率 ${which} ${val}% 超过理论基准，属于 split 多空分离模式的收割放大效应（可在单段趋势内多次进出累计超额收益），并非数据错误；评价方向优劣应以收益/回撤/PF 为准`;
}

export function getStrategyContext(code: string): StrategyContext | null {
  const d = loadExperiment(code);
  const cb = CIRCUIT_BREAKER_PARAMS[code] ?? null;
  const verification = d?.baseline?.rank
    ? {
        pnlRank: d.baseline.rank.pnl,
        ddRank: d.baseline.rank.dd,
        captureRank: d.baseline.rank.capture,
        total: d.baseline.rank.total,
        pnlTopPct: Number(((d.baseline.rank.pnl / d.baseline.rank.total) * 100).toFixed(1)),
        ddTopPct: Number(((d.baseline.rank.dd / d.baseline.rank.total) * 100).toFixed(1)),
      }
    : null;

  return {
    code,
    name: VARIETY_NAMES[code] ?? code,
    // 有回测排名（rank）才算"已验证"；零交易品种（如 SR0）文件虽在但 rank 为空，不应标记为已验证
    verified: !!verification,
    verification,
    directionBias: judgeDirectionBias(d),
    circuitBreaker: cb,
    hold: judgeHold(code, d),
    fragilityWarnings: buildFragilityWarnings(d),
    captureNote: buildCaptureNote(d),
  };
}

/** 方向一致性校验：实时建议方向 vs 回测主导方向 */
export interface DirectionConsistency {
  checked: boolean;
  dominant: 'LONG' | 'SHORT' | 'BALANCED';
  adviceDirection: 'LONG' | 'SHORT';
  consistent: boolean;
  warning: string | null;
}

export function getDirectionConsistency(
  adviceDirection: 'LONG' | 'SHORT',
  strategyContext: StrategyContext | null
): DirectionConsistency | null {
  if (!strategyContext?.directionBias) return null;
  const dominant = strategyContext.directionBias.dominant;
  // 回测无明确方向偏好时不做校验，避免误报
  if (dominant === 'BALANCED') return null;

  const consistent = dominant === adviceDirection;
  const domLabel = dominant === 'LONG' ? '做多' : '做空';
  const advLabel = adviceDirection === 'LONG' ? '做多' : '做空';
  const lc = (strategyContext.directionBias.longCapture * 100).toFixed(0);
  const sc = (strategyContext.directionBias.shortCapture * 100).toFixed(0);

  return {
    checked: true,
    dominant,
    adviceDirection,
    consistent,
    warning: consistent
      ? null
      : `千次回测显示该品种主导方向为「${domLabel}」（做多捕获 ${lc}% / 做空捕获 ${sc}%），与当前建议「${advLabel}」相悖，建议降低仓位或等待方向确认`,
  };
}

/** 批量获取策略上下文（供 multi-report 等聚合接口） */
export function getMultiStrategyContexts(codes: string[]): StrategyContext[] {
  return codes.map((c) => getStrategyContext(c)).filter(Boolean) as StrategyContext[];
}
