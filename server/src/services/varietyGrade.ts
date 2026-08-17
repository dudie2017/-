import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { getSimTrades, type SimTradeRecord } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface VarietyGrade {
  code: string;
  grade: 'A' | 'B' | 'C' | 'D';
  gradeLabel: string;
  profitablePct: number;
  robustPct: number;
  crashPct: number;
}

/** 实盘表现统计（按品种） */
export interface PaperTradingPerformance {
  code: string;
  totalTrades: number;
  winTrades: number;
  lossTrades: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
  maxDrawdown: number; // 最大连续亏损金额
  profitFactor: number; // 盈利因子 = 总盈利 / 总亏损
  avgHoldDays: number;
}

/** 校准后分级（融合回测 + 实盘） */
export interface CalibratedGrade extends VarietyGrade {
  paperPerformance: PaperTradingPerformance | null;
  calibratedGrade: 'A' | 'B' | 'C' | 'D';
  calibratedGradeLabel: string;
  calibrationNote: string; // 校准说明
}

export const VARIETY_GRADE_LABELS: Record<string, string> = {
  A: '稳健底仓',
  B: '可用',
  C: '脆弱',
  D: '失效',
};

let cache: Record<string, VarietyGrade> | null = null;

function load(): Record<string, VarietyGrade> {
  if (cache) return cache;
  const filePath = path.join(__dirname, '..', 'data', 'rescoreReport.json');
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
    const arr: any[] = Array.isArray(raw) ? raw : raw.results || raw.rows || raw.varieties || [];
    const map: Record<string, VarietyGrade> = {};
    for (const x of arr) {
      if (!x.code) continue;
      const grade = (x.grade || 'C') as 'A' | 'B' | 'C' | 'D';
      map[x.code] = {
        code: x.code,
        grade,
        gradeLabel: x.gradeLabel || VARIETY_GRADE_LABELS[grade] || '未知',
        profitablePct: typeof x.profitablePct === 'number' ? x.profitablePct : 0,
        robustPct: typeof x.robustPct === 'number' ? x.robustPct : 0,
        crashPct: typeof x.crashPct === 'number' ? x.crashPct : 0,
      };
    }
    cache = map;
  } catch (err) {
    // 文件不存在或解析失败时返回空对象，避免阻塞扫描接口
    console.warn('[VarietyGrade] rescoreReport.json 加载失败，使用空分级数据:', (err as Error).message);
    cache = {};
  }
  return cache;
}

export function getVarietyGrade(code: string): VarietyGrade | undefined {
  return load()[code];
}

export function getAllVarietyGrades(): VarietyGrade[] {
  return Object.values(load());
}

export function getVarietyGradeMap(): Record<string, VarietyGrade> {
  return load();
}

// ============ 实盘表现统计 ============

/** 按品种统计模拟交易实盘表现 */
export function getPaperTradingPerformance(): Map<string, PaperTradingPerformance> {
  const closed = getSimTrades({ status: 'closed', limit: 10000 });
  const byCode = new Map<string, SimTradeRecord[]>();
  
  for (const t of closed) {
    if (!t.code) continue;
    if (!byCode.has(t.code)) byCode.set(t.code, []);
    byCode.get(t.code)!.push(t);
  }
  
  const result = new Map<string, PaperTradingPerformance>();
  
  for (const [code, trades] of byCode) {
    const winTrades = trades.filter(t => (t.pnl ?? 0) > 0);
    const lossTrades = trades.filter(t => (t.pnl ?? 0) <= 0);
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalWin = winTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const totalLoss = Math.abs(lossTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0));
    
    // 计算最大连续亏损（回撤）
    let maxDrawdown = 0;
    let runningPnl = 0;
    let peak = 0;
    // 按入场日期排序
    const sorted = [...trades].sort((a, b) => a.entry_date.localeCompare(b.entry_date));
    for (const t of sorted) {
      runningPnl += (t.pnl ?? 0);
      if (runningPnl > peak) peak = runningPnl;
      const dd = peak - runningPnl;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }
    
    // 计算平均持仓天数
    let totalHoldDays = 0;
    let holdDaysCount = 0;
    for (const t of sorted) {
      if (t.exit_date && t.entry_date) {
        const entry = new Date(t.entry_date).getTime();
        const exit = new Date(t.exit_date).getTime();
        const days = (exit - entry) / (1000 * 60 * 60 * 24);
        totalHoldDays += days;
        holdDaysCount++;
      }
    }
    
    result.set(code, {
      code,
      totalTrades: trades.length,
      winTrades: winTrades.length,
      lossTrades: lossTrades.length,
      winRate: trades.length > 0 ? winTrades.length / trades.length : 0,
      totalPnl,
      avgPnl: trades.length > 0 ? totalPnl / trades.length : 0,
      maxDrawdown,
      profitFactor: totalLoss > 0 ? totalWin / totalLoss : totalWin > 0 ? 999 : 0,
      avgHoldDays: holdDaysCount > 0 ? totalHoldDays / holdDaysCount : 0,
    });
  }
  
  return result;
}

// ============ 分级校准 ============

const GRADE_ORDER: ('A' | 'B' | 'C' | 'D')[] = ['A', 'B', 'C', 'D'];

function gradeIndex(g: string): number {
  return GRADE_ORDER.indexOf(g as 'A' | 'B' | 'C' | 'D');
}

function gradeFromIndex(i: number): 'A' | 'B' | 'C' | 'D' {
  return GRADE_ORDER[Math.max(0, Math.min(GRADE_ORDER.length - 1, i))];
}

/**
 * 融合回测分级 + 实盘表现 → 校准后分级
 * 
 * 校准规则：
 * 1. 实盘交易数 < 5：样本不足，保持原分级
 * 2. 实盘胜率 > 回测盈利占比 * 1.2 且 实盘 PF > 1.5：可能升级
 * 3. 实盘胜率 < 回测盈利占比 * 0.7 或 实盘最大回撤 > 30%：可能降级
 * 4. 实盘总亏损 > 总盈利的 2 倍：强制降级
 */
export function getCalibratedGrade(code: string): CalibratedGrade {
  const base = getVarietyGrade(code);
  const perfMap = getPaperTradingPerformance();
  const perf = perfMap.get(code) || null;
  
  if (!base) {
    // 未知品种，默认 C 级
    return {
      code,
      grade: 'C',
      gradeLabel: VARIETY_GRADE_LABELS['C'],
      profitablePct: 0,
      robustPct: 0,
      crashPct: 0,
      paperPerformance: perf,
      calibratedGrade: 'C',
      calibratedGradeLabel: VARIETY_GRADE_LABELS['C'],
      calibrationNote: '未知品种，默认 C 级',
    };
  }
  
  // 实盘样本不足，保持原分级
  if (!perf || perf.totalTrades < 5) {
    return {
      ...base,
      paperPerformance: perf,
      calibratedGrade: base.grade,
      calibratedGradeLabel: base.gradeLabel,
      calibrationNote: perf ? `实盘仅 ${perf.totalTrades} 笔，样本不足，保持回测分级` : '暂无实盘数据，保持回测分级',
    };
  }
  
  let calibratedIndex = gradeIndex(base.grade);
  const notes: string[] = [];
  
  // 规则 2：实盘表现显著优于回测 → 可能升级
  if (perf.winRate > base.profitablePct * 1.2 && perf.profitFactor > 1.5) {
    if (calibratedIndex > 0) {
      calibratedIndex--;
      notes.push(`实盘胜率 ${(perf.winRate * 100).toFixed(0)}% 显著高于回测 ${(base.profitablePct * 100).toFixed(0)}%，PF=${perf.profitFactor.toFixed(1)}，上调一级`);
    }
  }
  
  // 规则 3a：实盘胜率显著低于回测 → 可能降级
  if (perf.winRate < base.profitablePct * 0.7) {
    if (calibratedIndex < GRADE_ORDER.length - 1) {
      calibratedIndex++;
      notes.push(`实盘胜率 ${(perf.winRate * 100).toFixed(0)}% 显著低于回测 ${(base.profitablePct * 100).toFixed(0)}%，下调一级`);
    }
  }
  
  // 规则 3b：实盘最大回撤 > 30% 且回测崩溃率 < 30% → 降级
  if (perf.maxDrawdown > 0 && base.crashPct < 0.3) {
    // 用初始资金估算回撤比例（假设 50 万初始资金）
    const ddPct = perf.maxDrawdown / 500000;
    if (ddPct > 0.3 && calibratedIndex < GRADE_ORDER.length - 1) {
      calibratedIndex++;
      notes.push(`实盘回撤 ${(ddPct * 100).toFixed(0)}% 超出回测预期（崩溃率 ${(base.crashPct * 100).toFixed(0)}%），下调一级`);
    }
  }
  
  // 规则 4：实盘总亏损 > 总盈利的 2 倍 → 强制降级
  const totalLoss = Math.abs(Math.min(0, perf.totalPnl));
  const totalWin = Math.max(0, perf.totalPnl);
  if (totalLoss > totalWin * 2 && perf.totalPnl < 0 && calibratedIndex < GRADE_ORDER.length - 1) {
    calibratedIndex++;
    notes.push(`实盘亏损 ${totalLoss.toFixed(0)} 远超盈利 ${totalWin.toFixed(0)}，强制下调`);
  }
  
  const calibratedGrade = gradeFromIndex(calibratedIndex);
  const calibratedGradeLabel = VARIETY_GRADE_LABELS[calibratedGrade];
  const calibrationNote = notes.length > 0 ? notes.join('；') : `实盘 ${perf.totalTrades} 笔，胜率 ${(perf.winRate * 100).toFixed(0)}%，与回测一致，保持原分级`;
  
  return {
    ...base,
    paperPerformance: perf,
    calibratedGrade,
    calibratedGradeLabel,
    calibrationNote,
  };
}

/** 获取所有品种的校准后分级 */
export function getAllCalibratedGrades(): CalibratedGrade[] {
  const allGrades = getAllVarietyGrades();
  return allGrades.map(g => getCalibratedGrade(g.code));
}
