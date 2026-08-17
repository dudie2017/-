/**
 * 批量参数优化引擎 (batchOptimizer)
 *
 * 用途：对单个品种20年数据进行1000次参数回测，寻找收益最大化配置
 *
 * 核心优化：
 * 1. 预扫描缓存：scanV16Variety 输出与交易参数无关，先扫描所有bar缓存 V16Row
 * 2. 轻量回测：1000次回测只遍历缓存行应用不同参数做交易模拟（毫秒级）
 * 3. 拉丁超立方采样：参数空间均匀覆盖
 *
 * 输出：
 * - Top10 最优参数
 * - 做多/做空分离统计
 * - 成功率（显著盈利组合占比）
 * - 收益最大化判断 + 改进建议
 */
import * as fs from 'fs';
import * as path from 'path';
import { scanV16Variety } from '../services/v16_engine';
import { type BarData } from '../services/varieties';

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
};

function getSpec(code: string): ContractSpec {
  const key = code.replace(/0$/, '');
  return CONTRACT_SPECS[key] || { name: code, multiplier: 10, tickSize: 1, marginRate: 0.10 };
}

// ============ 数据加载 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

function loadBars(code: string): Bar[] {
  try {
    const fp = path.join(DATA_DIR, `${code}.json`);
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data?.bars && Array.isArray(data.bars)) return data.bars;
    return [];
  } catch { return []; }
}

// ============ 工具函数 ============

/** 计算 ATR(14) */
function computeATR(bars: Bar[]): number {
  if (bars.length < 15) return 0;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    sum += tr;
  }
  return sum / 14;
}

/** 交易模拟：同根K线同时触及止损和目标时，保守计为止损 */
function simulate(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  stopLoss: number,
  target: number,
  futureBars: Bar[],
  maxDays: number,
): { exitPrice: number; exitDate: string; exitReason: 'target' | 'stop' | 'timeout'; holdDays: number } {
  const bars = futureBars.slice(0, maxDays);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (direction === 'LONG') {
      const hitTarget = b.h >= target;
      const hitStop = b.l <= stopLoss;
      if (hitStop && hitTarget) return { exitPrice: stopLoss, exitDate: b.date, exitReason: 'stop', holdDays: i + 1 };
      if (hitTarget) return { exitPrice: target, exitDate: b.date, exitReason: 'target', holdDays: i + 1 };
      if (hitStop) return { exitPrice: stopLoss, exitDate: b.date, exitReason: 'stop', holdDays: i + 1 };
    } else {
      const hitTarget = b.l <= target;
      const hitStop = b.h >= stopLoss;
      if (hitStop && hitTarget) return { exitPrice: stopLoss, exitDate: b.date, exitReason: 'stop', holdDays: i + 1 };
      if (hitTarget) return { exitPrice: target, exitDate: b.date, exitReason: 'target', holdDays: i + 1 };
      if (hitStop) return { exitPrice: stopLoss, exitDate: b.date, exitReason: 'stop', holdDays: i + 1 };
    }
  }
  const lastBar = bars[bars.length - 1];
  return { exitPrice: lastBar.c, exitDate: lastBar.date, exitReason: 'timeout', holdDays: bars.length };
}

/** 计算单笔盈亏（含手续费+滑点） */
function calcPnl(direction: 'LONG' | 'SHORT', code: string, entryPrice: number, exitPrice: number) {
  const spec = getSpec(code);
  const contractValue = entryPrice * spec.multiplier;
  const fee = contractValue * 0.00015 * 2;
  const slippage = spec.tickSize * spec.multiplier * 1;
  const priceDiff = direction === 'LONG' ? exitPrice - entryPrice : entryPrice - exitPrice;
  const grossPnl = priceDiff * spec.multiplier;
  const netPnl = grossPnl - fee - slippage;
  return netPnl;
}

// ============ 拉丁超立方采样 ============

interface ParamDim {
  name: string;
  min: number;
  max: number;
  integer?: boolean;
  values?: (number | string)[]; // 离散取值时使用
}

/** mulberry32 伪随机数生成器（可复现） */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function latinHypercubeSample(n: number, dims: ParamDim[], seed: number): Array<Record<string, number | string>> {
  const samples: Array<Record<string, number | string>> = [];
  const rng = mulberry32(seed);

  const perDim: number[][] = dims.map(() => {
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.map((rank) => (rank + rng()) / n);
  });

  for (let i = 0; i < n; i++) {
    const row: Record<string, number | string> = {};
    for (let d = 0; d < dims.length; d++) {
      const dim = dims[d];
      const u = perDim[d][i];
      if (dim.values) {
        const idx = Math.min(Math.floor(u * dim.values.length), dim.values.length - 1);
        row[dim.name] = dim.values[idx];
      } else {
        let v = dim.min + u * (dim.max - dim.min);
        if (dim.integer) v = Math.round(v);
        else v = Math.round(v * 100) / 100;
        row[dim.name] = v;
      }
    }
    samples.push(row);
  }
  return samples;
}
