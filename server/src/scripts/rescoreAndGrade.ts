/**
 * 改进评分 + 品种重分级脚本（覆盖全部 59 品种）
 *
 * 背景：现有 TOP1 由 runVariety1000Experiments.ts 的 score 选出：
 *   score = totalPnl - maxDrawdown*2e6 + winRate*5e5 + capture*8e5
 * 该评分有回撤惩罚，但缺少「崩溃率 / 稳健率」惩罚，导致 EC0（崩溃率 75%）、
 * FU0（崩溃率 31%）等高脆弱品种仍能进入 TOP1 生产池。
 *
 * 本脚本在不重跑 1000 次实验的前提下，直接复用各品种 fullResults，
 * 用「风险调整收益（卡玛比率）+ 稳健率 + 崩溃率」重新打分与分级，产出：
 *   1) 每个品种的「稳健 TOP1」配方（改进评分选出的 recipe）
 *   2) 品种分级 A/B/C/D（稳健底仓 / 可用 / 脆弱 / 失效）
 *   3) 与旧 TOP1（topComposite[0]）的逐项对比
 *
 * 用法：cd server && npx tsx src/scripts/rescoreAndGrade.ts
 * 输出：src/data/rescoreReport.json + 控制台摘要
 */
import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src', 'data');
const OUT_FILE = path.join(DATA_DIR, 'rescoreReport.json');

// ============ 类型 ============
interface ExpStats {
  totalTrades: number;
  winRate: number;
  totalPnl: number;
  maxDrawdown: number;
  profitFactor: number;
  capture: number;
  avgRR?: number;
  longCapture?: number;
  shortCapture?: number;
}

interface Exp {
  id: number;
  recipe: Record<string, any>;
  stats: ExpStats;
  score?: number;
}

interface VarietyData {
  meta: { code?: string; startCapital?: number };
  fullResults: Exp[];
  topComposite: Exp[];
  baseline?: any;
}

interface GradeResult {
  code: string;
  grade: 'A' | 'B' | 'C' | 'D';
  gradeLabel: string;
  profitablePct: number;
  robustPct: number;
  crashPct: number;
  newTop1: {
    recipe: Record<string, any>;
    pnl: number;
    dd: number;
    winRate: number;
    pf: number;
    calmar: number;
    trades: number;
  };
  oldTop1: {
    pnl: number;
    dd: number;
    winRate: number;
    pf: number;
    calmar: number;
    isRobust: boolean;
    isCrash: boolean;
    directionMode: string;
    dataWindow: string;
  };
}

// ============ 阈值常量（可调）============
const CAPITAL = 500000;
// 稳健实验：盈利 + 回撤<30% + 胜率>=40% + PF>=1.2 + 交易数>=20（样本量兜底）
const ROBUST_MIN_TRADES = 20;
// 崩溃实验（与 findFragility 一致）：收益<0 或 回撤>50%
const CRASH_DD = 0.5;

// ============ 工具函数 ============
function calmarOf(pnl: number, dd: number): number {
  const ddAmt = Math.max(dd * CAPITAL, 1);
  return pnl / ddAmt;
}

function isRobust(s: ExpStats): boolean {
  return (
    s.totalPnl > 0 &&
    s.maxDrawdown < 0.3 &&
    s.winRate >= 0.4 &&
    s.profitFactor >= 1.2 &&
    s.totalTrades >= ROBUST_MIN_TRADES
  );
}

function isCrash(s: ExpStats): boolean {
  return s.totalPnl < 0 || s.maxDrawdown > CRASH_DD;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

// ============ 单品种处理 ============
function processVariety(code: string, data: VarietyData): GradeResult | null {
  const exps = data.fullResults || [];
  if (exps.length === 0) return null;

  const robust = exps.filter((e) => isRobust(e.stats));
  const profitable = exps.filter((e) => e.stats.totalPnl > 0);
  const crash = exps.filter((e) => isCrash(e.stats));

  const profitablePct = profitable.length / exps.length;
  const robustPct = robust.length / exps.length;
  const crashPct = crash.length / exps.length;

  // 改进 TOP1 选择：稳健集 → 盈利且回撤<50% 兜底 → 全量兜底
  const pool = robust.length > 0 ? robust : exps.filter((e) => e.stats.totalPnl > 0 && e.stats.maxDrawdown < CRASH_DD);
  const finalPool = pool.length > 0 ? pool : exps;
  const sorted = [...finalPool].sort(
    (a, b) =>
      calmarOf(b.stats.totalPnl, b.stats.maxDrawdown) - calmarOf(a.stats.totalPnl, a.stats.maxDrawdown) ||
      b.stats.totalPnl - a.stats.totalPnl,
  );
  const newTop = sorted[0];

  const oldTop = (data.topComposite || [])[0];

  const grade: GradeResult['grade'] =
    newTop.stats.totalPnl <= 0
      ? 'D'
      : crashPct >= 0.5
        ? 'C'
        : robustPct >= 0.25 && profitablePct >= 0.55 && crashPct < 0.35
          ? 'A'
          : robustPct >= 0.1
            ? 'B'
            : 'C';

  const gradeLabel: Record<GradeResult['grade'], string> = {
    A: '稳健底仓',
    B: '可用',
    C: '脆弱',
    D: '失效',
  };

  return {
    code,
    grade,
    gradeLabel: gradeLabel[grade],
    profitablePct,
    robustPct,
    crashPct,
    newTop1: {
      recipe: newTop.recipe,
      pnl: newTop.stats.totalPnl,
      dd: newTop.stats.maxDrawdown,
      winRate: newTop.stats.winRate,
      pf: newTop.stats.profitFactor,
      calmar: calmarOf(newTop.stats.totalPnl, newTop.stats.maxDrawdown),
      trades: newTop.stats.totalTrades,
    },
    oldTop1: oldTop
      ? {
          pnl: oldTop.stats.totalPnl,
          dd: oldTop.stats.maxDrawdown,
          winRate: oldTop.stats.winRate,
          pf: oldTop.stats.profitFactor,
          calmar: calmarOf(oldTop.stats.totalPnl, oldTop.stats.maxDrawdown),
          isRobust: isRobust(oldTop.stats),
          isCrash: isCrash(oldTop.stats),
          directionMode: String(oldTop.recipe?.directionMode ?? ''),
          dataWindow: String(oldTop.recipe?.dataWindow ?? ''),
        }
      : {
          pnl: 0,
          dd: 0,
          winRate: 0,
          pf: 0,
          calmar: 0,
          isRobust: false,
          isCrash: false,
          directionMode: '',
          dataWindow: '',
        },
  };
}

// ============ 主流程 ============
function main() {
  const files = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('_1000Experiments.json'))
    .sort();

  console.log(`========== 改进评分 + 品种重分级（${files.length} 品种）==========`);
  console.log(`评分口径：卡玛比率(收益/回撤) 排序，稳健集=盈利+回撤<30%+胜率≥40%+PF≥1.2+交易≥${ROBUST_MIN_TRADES}`);
  console.log(`崩溃口径：收益<0 或 回撤>50%（与 findFragility 一致）\n`);

  const results: GradeResult[] = [];
  for (const f of files) {
    const code = f.split('_')[0];
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')) as VarietyData;
    const r = processVariety(code, raw);
    if (r) results.push(r);
  }

  results.sort((a, b) => a.code.localeCompare(b.code));

  const gradeOrder: GradeResult['grade'][] = ['A', 'B', 'C', 'D'];
  const count = (g: GradeResult['grade']) => results.filter((r) => r.grade === g).length;

  // 控制台摘要
  console.log('===== 品种分级汇总 =====');
  for (const g of gradeOrder) {
    const list = results.filter((r) => r.grade === g).map((r) => r.code);
    console.log(`【${g} ${({ A: '稳健底仓', B: '可用', C: '脆弱', D: '失效' } as any)[g]}】${count(g)} 个: ${list.join(', ') || '无'}`);
  }

  console.log('\n===== 新旧 TOP1 对比（旧 TOP1 是脆弱/高回撤，但被改进 TOP1 替换的品种）=====');
  for (const r of results) {
    if (r.oldTop1.isCrash || (r.oldTop1.pnl > 0 && !r.oldTop1.isRobust)) {
      console.log(
        `[${r.code}] 旧TOP1 收益${Math.round(r.oldTop1.pnl).toLocaleString()} 回撤${pct(r.oldTop1.dd)} ${r.oldTop1.isCrash ? '崩溃' : '非稳健'} | 新TOP1 收益${Math.round(r.newTop1.pnl).toLocaleString()} 回撤${pct(r.newTop1.dd)} 卡玛${r.newTop1.calmar.toFixed(2)}`,
      );
    }
  }

  console.log('\n===== 全量明细（分级 + 稳健率 + 崩溃率 + 新旧卡玛）=====');
  for (const r of results) {
    console.log(
      `[${r.code}] ${r.grade} ${r.gradeLabel.padEnd(4)} | 盈利${pct(r.profitablePct)} 稳健${pct(r.robustPct)} 崩溃${pct(r.crashPct)} | 新TOP1 收益${Math.round(r.newTop1.pnl).toLocaleString()} 回撤${pct(r.newTop1.dd)} 卡玛${r.newTop1.calmar.toFixed(2)} | 旧TOP1 卡玛${r.oldTop1.calmar.toFixed(2)}`,
    );
  }

  // 落盘
  const out = {
    generatedAt: new Date().toISOString(),
    thresholds: { robustMinTrades: ROBUST_MIN_TRADES, crashDd: CRASH_DD, capital: CAPITAL },
    summary: {
      total: results.length,
      A: count('A'),
      B: count('B'),
      C: count('C'),
      D: count('D'),
      AList: results.filter((r) => r.grade === 'A').map((r) => r.code),
      BList: results.filter((r) => r.grade === 'B').map((r) => r.code),
      CList: results.filter((r) => r.grade === 'C').map((r) => r.code),
      DList: results.filter((r) => r.grade === 'D').map((r) => r.code),
    },
    results,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n结果已写入: ${OUT_FILE}`);
}

main();

