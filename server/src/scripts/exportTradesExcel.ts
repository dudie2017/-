// @ts-nocheck
/**
 * 全品种回测买卖点 Excel 导出脚本
 *
 * 目的：用当前生产配置跑全部品种回测，将每笔交易的完整买卖点
 * （信号日、入场/出场、仓位、交易理由、下一步逻辑）导出为 Excel，
 * 供人工在行情图上逐笔复核。
 *
 * 用法：cd server && npx tsx src/scripts/exportTradesExcel.ts
 * 输出：server/src/data/回测买卖点_YYYYMMDD.xlsx
 */

import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';
import type { V16Row } from '../services/v16_types';
import { LONG_OPT_PARAMS } from '../data/longOptParams';
import { LONG_REFINED_PARAMS } from '../data/longRefinedParams';
import { SHORT_OPT_PARAMS } from '../data/shortOptParams';
import { REALTIME_OPT_PARAMS } from '../data/realtimeOptParams';
import { SHORT_DISABLED } from '../data/shortDisabledVarieties';
import { LONG_DISABLED } from '../data/longDisabledVarieties';
import { detectShocks, loadVarietyBars } from '../services/newsBacktestEngine';
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

// ============ 类型 ============
interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

interface TradeLike {
  result?: string;
  code: string;
  signalDate: string;
  entryDate: string;
  entryPrice: number;
  stopLoss: number;
  target: number;
  exitDate: string;
  exitPrice: number;
  exitReason: string;
  holdDays: number;
  direction: 'LONG' | 'SHORT';
  signalGrade: string;
  spectrum: string;
  pnl: number;
  pnlPct: number;
  rMultiple: number;
  posMul: number;
}

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');
const ALL_CODES = ['SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0', 'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0', 'SI0'];

const CONTRACT_NAMES: Record<string, string> = {
  SC0: '原油', JM0: '焦煤', RU0: '橡胶', M0: '豆粕', AG0: '白银', LH0: '生猪', CU0: '铜',
  AU0: '黄金', RB0: '螺纹钢', I0: '铁矿石', CF0: '棉花', Y0: '豆油', J0: '焦炭',
  P0: '棕榈油', TA0: 'PTA', AL0: '铝', SI0: '工业硅',
};

function loadBars(code: string): Bar[] {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, `${code}.json`), 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data as Bar[];
    if (data && Array.isArray((data as any).bars)) return (data as any).bars as Bar[];
  } catch { /* ignore */ }
  return [];
}

// ============ 预扫描缓存 ============
async function getPrescannedRows(code: string, edgeLookback: number, allowRangeTrading: boolean): Promise<V16Row[]> {
  const bars = loadBars(code);
  const warmup = 60;
  const rows: V16Row[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  return rows;
}

// ============ 黑天鹅过滤器 ============
function buildBlackSwanFilter(code: string, mode: 'none' | 'riskOff' | 'full') {
  if (mode === 'none') return undefined;
  const bars = loadVarietyBars(code, DATA_DIR) as any[];
  const cooldown = new Array<boolean>(bars.length).fill(false);
  const shockDates = new Set<string>();
  const shockDir: Array<'up' | 'down' | null> = new Array(bars.length).fill(null);
  try {
    const shocks = detectShocks(bars as any, code) as Array<{ index: number; date: string; direction: 'up' | 'down' }>;
    for (const s of shocks) {
      shockDates.add(s.date);
      const until = Math.min(bars.length, s.index + 10);
      for (let j = s.index; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = s.direction;
      }
    }
    const barDateIdx = new Map<string, number>();
    bars.forEach((b: any, idx: number) => barDateIdx.set(b.date, idx));
    for (const ev of BLACK_SWAN_EVENTS) {
      if (!ev.varieties || !ev.varieties.includes(code)) continue;
      const idx = barDateIdx.get(ev.date);
      if (idx === undefined) continue;
      const until = Math.min(bars.length, idx + 10);
      for (let j = idx; j < until; j++) {
        cooldown[j] = true;
        shockDir[j] = ev.direction === '利空' ? 'down' : 'up';
      }
    }
  } catch (e) {
    console.warn(`[${code}] 黑天鹅检测异常，回退为空过滤器:`, (e as Error).message);
  }
  return {
    mode,
    cooldownMap: new Map([[code, cooldown]]),
    shockDirMap: new Map([[code, shockDir]]),
    shockDates: new Map([[code, shockDates]]),
    resonanceBoost: 1.3,
    divergenceCut: 0.5,
  };
}

// ============ 后处理风控层 ============
function addDays(dateStr: string, days: number): string {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function applyCircuitBreaker(trades: TradeLike[], lossStreak: number, pauseDays: number): TradeLike[] {
  const out: TradeLike[] = [];
  let streak = 0;
  let frozenUntil = '';
  for (const t of trades) {
    if (frozenUntil && (!t.entryDate || t.entryDate < frozenUntil)) continue;
    out.push(t);
    if ((t.pnl || 0) <= 0) {
      streak++;
      if (streak >= lossStreak) {
        frozenUntil = addDays(t.exitDate || t.entryDate || '', pauseDays);
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return out;
}

function applyVolReduce(trades: TradeLike[], bars: Bar[], mode: string): TradeLike[] {
  if (mode === 'off' || bars.length < 60) return trades;
  const atr14: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < 14) { atr14.push(0); continue; }
    let sum = 0;
    for (let j = i - 13; j <= i; j++) {
      const b = bars[j], prev = bars[j - 1];
      sum += Math.max(b.h - b.l, Math.abs(b.h - prev.c), Math.abs(b.l - prev.c));
    }
    atr14.push(sum / 14);
  }
  const dateIdx = new Map<string, number>();
  bars.forEach((b, i) => dateIdx.set(b.date, i));
  return trades.map((t) => {
    const idx = dateIdx.get(t.entryDate);
    if (idx === undefined || idx < 60) return t;
    const short = atr14[idx];
    const longAvg = atr14.slice(Math.max(0, idx - 59), idx + 1).reduce((s, v) => s + v, 0) / Math.min(60, idx + 1);
    if (longAvg <= 0) return t;
    const ratio = short / longAvg;
    if (mode === 'atr2xClear' && ratio > 2.0) {
      return { ...t, pnl: 0, result: 'volclear' };
    }
    if (mode === 'atr15xHalf' && ratio > 1.5) {
      return { ...t, pnl: t.pnl * 0.5 };
    }
    return t;
  });
}

function applyDailyLossLimit(trades: TradeLike[], capital: number, pct: number): TradeLike[] {
  if (pct <= 0) return trades;
  const sorted = [...trades].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  const out: TradeLike[] = [];
  let dayPnl = 0;
  let dayKey = '';
  const limit = capital * pct;
  for (const t of sorted) {
    const key = t.entryDate.slice(0, 10);
    if (key !== dayKey) { dayKey = key; dayPnl = 0; }
    if (dayPnl <= -limit) continue;
    out.push(t);
    dayPnl += t.pnl;
  }
  return out;
}

function applyDirectionFilter(trades: TradeLike[], mode: string): TradeLike[] {
  if (mode === 'both' || mode === 'split') return trades;
  if (mode === 'longOnly') return trades.filter((t) => t.direction === 'LONG');
  if (mode === 'shortOnly') return trades.filter((t) => t.direction === 'SHORT');
  return trades;
}

function applyWindow(bars: Bar[], window: string): { slice: Bar[]; label: string } {
  const len = bars.length;
  let slice: Bar[];
  if (window === 'full') slice = bars;
  else if (window === 'front70') slice = bars.slice(0, Math.floor(len * 0.7));
  else if (window === 'back70') slice = bars.slice(Math.floor(len * 0.3));
  else if (window === 'last2y') slice = bars.slice(Math.max(0, len - 500));
  else if (window === 'last3y') slice = bars.slice(Math.max(0, len - 750));
  else slice = bars;
  return { slice, label: window };
}

function parsePct(v: string): number {
  if (v === 'off') return 0;
  return Number(v.replace('pct', '')) / 100;
}

// ============ 生产基线参数 ============
const BASE_OPTS = {
  startCapital: 500000,
  maxPositionPct: 0.15,
  minSignalGrade: 'L1' as string,
  maxHoldDays: 15,
  stopAtrMult: 1.5,
  targetAtrMult: 3.0,
  minRR: 1.0,
  cooldownBars: 0,
  trendFilter: false,
  warmupBars: 60,
  returnAllTrades: true,
  quiet: true,
};

// ============ 交易理由生成 ============
function buildTradeReason(row: V16Row | undefined, trade: TradeLike): string {
  if (!row) return `信号等级${trade.signalGrade}，光谱${trade.spectrum}`;
  const parts: string[] = [];
  // 方向
  parts.push(trade.direction === 'LONG' ? '做多' : '做空');
  // 信号等级
  parts.push(`信号等级${row.signal_grade || trade.signalGrade}`);
  // 光谱
  const spec = row.spectrum || trade.spectrum;
  if (spec) parts.push(`光谱:${spec}`);
  // 市场环境
  if (row.market_context) parts.push(`环境:${row.market_context}`);
  // 顺势概率
  if (row.p_follow != null) parts.push(`顺势${(row.p_follow * 100).toFixed(0)}%`);
  // Edge
  if (row.edge_status) parts.push(`Edge:${row.edge_status}${row.edge_grade ? '(' + row.edge_grade + ')' : ''}`);
  // MM 测量
  if (row.mm_found) parts.push(`MM测量:${row.mm_direction || ''}(${row.mm_variant_count || 0}变体)`);
  // CH 通道
  if (row.ch_has_signal) parts.push(`通道:${row.ch_direction || ''}(${row.ch_strength || ''})`);
  // FT 类型
  if (row.fw_type_cn) parts.push(`FT:${row.fw_type_cn}`);
  // 生命周期
  if (row.lc_stage) parts.push(`阶段:${row.lc_stage}`);
  // OI
  if (row.oi_signal) parts.push(`OI:${row.oi_signal}`);
  // G4 理由
  if (row.g4_reasons_met) parts.push(`G4:${row.g4_reasons_met}`);
  // 紧通道
  if (row.tight_channel) parts.push('紧通道');
  // 楔子过滤
  if (row.wedge_filtered_dir) parts.push(`楔子过滤:${row.wedge_filtered_dir}`);
  return parts.join('；');
}

// ============ 下一步交易逻辑生成 ============
function buildNextLogic(trade: TradeLike, row: V16Row | undefined): string {
  const reason = trade.exitReason || '';
  const parts: string[] = [];
  if (reason === 'target' || reason === 'tp') {
    parts.push('止盈离场');
    if (row?.spectrum === 'strong_trend') parts.push('趋势未完可等待回踩再入场');
    else parts.push('关注是否形成新的入场信号');
  } else if (reason === 'stop' || reason === 'sl') {
    parts.push('止损离场');
    if (row?.market_context === 'counter_trend') parts.push('方向可能反转，冷却后重评估');
    else parts.push('避免逆势追单，等待新信号');
  } else if (reason === 'shock' || reason === 'blackswan') {
    parts.push('黑天鹅避险离场');
    parts.push('等待冲击窗口(10日)结束后重新评估');
  } else if (reason === 'timeout' || reason === 'maxhold') {
    parts.push('持仓到期离场');
    if (row?.p_follow && row.p_follow > 0.6) parts.push('趋势延续可等回调再入场');
    else parts.push('等待二次突破信号');
  } else {
    parts.push(`出场原因:${reason}`);
    parts.push('重新评估市场环境');
  }
  return parts.join('；');
}

// ============ 单品种跑回测并收集 trades ============
async function runCodeBacktest(code: string): Promise<{
  trades: TradeLike[];
  rows: V16Row[];
  bars: Bar[];
  maxPosPct: number;
}> {
  const bars = loadBars(code);
  if (bars.length === 0) return { trades: [], rows: [], bars: [], maxPosPct: 0.15 };

  // 读取历史基线配方
  const jsonPath = path.join(process.cwd(), 'src', 'data', `${code}_1000Experiments.json`);
  let histRecipe: Record<string, any> = {};
  try { histRecipe = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { /* ignore */ }

  // 构造 sideParams
  const isLongDisabled = (LONG_DISABLED as Set<string> | string[]).has ? (LONG_DISABLED as Set<string>).has(code) : (LONG_DISABLED as string[]).includes(code);
  const isShortDisabled = (SHORT_DISABLED as Set<string> | string[]).has ? (SHORT_DISABLED as Set<string>).has(code) : (SHORT_DISABLED as string[]).includes(code);
  const sideParams: Record<string, any> = {};
  if (!isLongDisabled) {
    const lp = (LONG_REFINED_PARAMS as any)[code] || (LONG_OPT_PARAMS as any)[code];
    if (lp) sideParams.long = lp;
  }
  if (!isShortDisabled) {
    const sp = (SHORT_OPT_PARAMS as any)[code];
    if (sp) sideParams.short = sp;
  }

  // 实时参数覆盖
  const rt = (REALTIME_OPT_PARAMS as any)[code] || {};
  const volReduceMode = rt.volReduce ?? histRecipe.volReduce ?? 'off';
  const dailyLossPct = parsePct(rt.dailyLossLimit ?? histRecipe.dailyLossLimit ?? 'off');
  const dataWindow = rt.dataWindow ?? histRecipe.dataWindow ?? 'full';
  const cbLossStreak = rt.circuitBreakerLossStreak ?? histRecipe.circuitBreakerLossStreak ?? 5;
  const cbPauseDays = rt.circuitBreakerPauseDays ?? histRecipe.circuitBreakerPauseDays ?? 20;
  const directionMode = rt.directionMode ?? histRecipe.directionMode ?? 'both';
  const newsMode = rt.newsFilter ?? histRecipe.newsFilter ?? 'none';
  const maxPosPct = rt.maxPositionPct ?? histRecipe.maxPositionPct ?? BASE_OPTS.maxPositionPct;

  // 预扫描
  const edgeLookback = rt.edgeLookback ?? histRecipe.edgeLookback ?? 60;
  const allowRangeTrading = rt.allowRangeTrading ?? histRecipe.allowRangeTrading ?? false;
  const rows = await getPrescannedRows(code, edgeLookback, allowRangeTrading);

  // 构造 signalCache（必须包含 backtestEngine 需要的所有字段）
  const signalCache = rows.map((r) => ({
    signal_grade: r.signal_grade,
    signalGrade: r.signal_grade,  // 兼容旧字段名
    spectrum: r.spectrum,
    isNonGreen: r.isNonGreen,
    isCounterCamp: r.isCounterCamp,
    ai_direction: r.ai_direction,
    market_context: r.market_context,
    p_follow: r.p_follow,
    edge_status: r.edge_status,
    edge_grade: r.edge_grade,
    mm_found: r.mm_found,
    mm_direction: r.mm_direction,
    mm_variant_count: r.mm_variant_count,
    ch_has_signal: r.ch_has_signal,
    ch_direction: r.ch_direction,
    ch_strength: r.ch_strength,
    fw_type_cn: r.fw_type_cn,
    lc_stage: r.lc_stage,
    oi_signal: r.oi_signal,
    g4_pass: r.g4_pass,  // 关键字段：Gate4 是否通过
    g4_reasons_met: r.g4_reasons_met,
    g4_reason_count: r.g4_reason_count,
    g4_verdict: r.g4_verdict,
    tight_channel: r.tight_channel,
    wedge_filtered_dir: r.wedge_filtered_dir,
    wedge_filter_on: r.wedge_filter_on,  // 关键字段：楔形过滤
    signal_variant: r.signal_variant,
    trend_strength: r.trend_strength,
    trade_worthiness: r.trade_worthiness,  // 关键字段：是否可交易
    mtf_resonance: r.mtf_resonance,
  }));

  // 黑天鹅过滤
  const newsFilter = buildBlackSwanFilter(code, newsMode as any);

  // 跑回测（使用正确的 API：dataDir + codes）
  const opts = {
    ...BASE_OPTS,
    dataDir: DATA_DIR,
    codes: [code],
    maxPositionPct: maxPosPct,
    sideParams,
    signalCache: new Map([[code, signalCache]]) as any,
    newsFilter: newsFilter as any,
    returnAllTrades: true,
    quiet: false,
    edgeLookback: 60,
    allowRangeTrading: false,
  };
  console.log(`  [DEBUG] dataDir=${DATA_DIR}, codes=[${code}], signalCache.length=${signalCache.length}, bars.length=${bars.length}`);
  if (signalCache.length > 0) {
    const midIdx = Math.floor(signalCache.length / 2);
    const sample = signalCache[midIdx];
    console.log(`  [DEBUG] signalCache[${midIdx}]: ai_direction=${sample.ai_direction}, spectrum=${sample.spectrum}, p_follow=${sample.p_follow?.toFixed(3)}, g4_pass=${sample.g4_pass}, signal_grade=${sample.signal_grade}, edge_grade=${sample.edge_grade}`);
  }
  const result = await runBacktest(opts);
  let trades: TradeLike[] = ((result as any).trades || []) as TradeLike[];
  console.log(`  [DEBUG] raw trades count: ${trades.length}`);

  // 后处理
  trades = applyCircuitBreaker(trades, cbLossStreak, cbPauseDays);
  trades = applyVolReduce(trades, bars, volReduceMode);
  trades = applyDailyLossLimit(trades, BASE_OPTS.startCapital, dailyLossPct);
  trades = applyDirectionFilter(trades, directionMode);

  return { trades, rows, bars, maxPosPct };
}

// ============ 主流程 ============
async function main() {
  console.log('=== 全品种回测买卖点导出 ===');
  const allRows: any[] = [];

  for (const code of ALL_CODES) {
    console.log(`\n[${code}] ${CONTRACT_NAMES[code] || code} 回测中...`);
    const { trades, rows, bars, maxPosPct } = await runCodeBacktest(code);
    console.log(`  共 ${trades.length} 笔交易`);

    // 构建 date → V16Row 映射
    const warmup = 60;
    const dateToRow = new Map<string, V16Row>();
    for (let k = 0; k < rows.length; k++) {
      const barIdx = warmup + k;
      if (barIdx < bars.length) {
        dateToRow.set(bars[barIdx].date, rows[k]);
      }
    }

    for (const t of trades) {
      const row = dateToRow.get(t.signalDate);
      const actualPosPct = maxPosPct * (t.posMul || 1);
      allRows.push({
        code,
        name: CONTRACT_NAMES[code] || code,
        direction: t.direction === 'LONG' ? '多' : '空',
        signalDate: t.signalDate,
        entryDate: t.entryDate,
        exitDate: t.exitDate,
        holdDays: t.holdDays,
        entryPrice: t.entryPrice,
        stopLoss: t.stopLoss,
        target: t.target,
        exitPrice: t.exitPrice,
        exitReason: t.exitReason,
        posMul: t.posMul,
        actualPosPct: (actualPosPct * 100).toFixed(1) + '%',
        signalGrade: t.signalGrade,
        spectrum: t.spectrum,
        marketContext: row?.market_context || '',
        pFollow: row?.p_follow != null ? (row.p_follow * 100).toFixed(0) + '%' : '',
        edgeStatus: row?.edge_status || '',
        mmFound: row?.mm_found ? `${row.mm_direction || ''}(${row.mm_variant_count || 0})` : '',
        chSignal: row?.ch_has_signal ? `${row.ch_direction || ''}(${row.ch_strength || ''})` : '',
        fwType: row?.fw_type_cn || '',
        lcStage: row?.lc_stage || '',
        oiSignal: row?.oi_signal || '',
        reason: buildTradeReason(row, t),
        nextLogic: buildNextLogic(t, row),
        pnl: t.pnl,
        pnlPct: (t.pnlPct * 100).toFixed(2) + '%',
        rMultiple: t.rMultiple?.toFixed(2) || '',
        result: t.result || '',
      });
    }
  }

  console.log(`\n=== 共 ${allRows.length} 笔交易，写入 Excel ===`);

  // 写 Excel
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('买卖点');

  ws.columns = [
    { header: '品种代码', key: 'code', width: 10 },
    { header: '品种名称', key: 'name', width: 10 },
    { header: '方向', key: 'direction', width: 6 },
    { header: '信号日期', key: 'signalDate', width: 12 },
    { header: '入场日期', key: 'entryDate', width: 12 },
    { header: '出场日期', key: 'exitDate', width: 12 },
    { header: '持仓天数', key: 'holdDays', width: 10 },
    { header: '入场价', key: 'entryPrice', width: 12 },
    { header: '止损价', key: 'stopLoss', width: 12 },
    { header: '目标价', key: 'target', width: 12 },
    { header: '出场价', key: 'exitPrice', width: 12 },
    { header: '出场原因', key: 'exitReason', width: 12 },
    { header: '仓位倍率', key: 'posMul', width: 10 },
    { header: '实际仓位', key: 'actualPosPct', width: 10 },
    { header: '信号等级', key: 'signalGrade', width: 10 },
    { header: '光谱', key: 'spectrum', width: 14 },
    { header: '市场环境', key: 'marketContext', width: 14 },
    { header: '顺势概率', key: 'pFollow', width: 10 },
    { header: 'Edge状态', key: 'edgeStatus', width: 12 },
    { header: 'MM测量', key: 'mmFound', width: 16 },
    { header: '通道信号', key: 'chSignal', width: 14 },
    { header: 'FT类型', key: 'fwType', width: 12 },
    { header: '生命周期', key: 'lcStage', width: 10 },
    { header: 'OI信号', key: 'oiSignal', width: 10 },
    { header: '交易理由', key: 'reason', width: 60 },
    { header: '下一步交易逻辑', key: 'nextLogic', width: 50 },
    { header: '盈亏(元)', key: 'pnl', width: 12 },
    { header: '盈亏%', key: 'pnlPct', width: 10 },
    { header: 'R倍数', key: 'rMultiple', width: 10 },
    { header: '结果', key: 'result', width: 8 },
  ];

  // 表头样式
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };

  for (const r of allRows) {
    ws.addRow(r);
  }

  // 盈亏着色
  for (let i = 2; i <= allRows.length + 1; i++) {
    const row = ws.getRow(i);
    const pnl = row.getCell('pnl').value as number;
    if (pnl > 0) {
      row.getCell('pnl').font = { color: { argb: 'FF00B050' } };
    } else if (pnl < 0) {
      row.getCell('pnl').font = { color: { argb: 'FFFF0000' } };
    }
  }

  // 冻结首行
  ws.views = [{ state: 'frozen', ySplit: 1 }];

  // 自动筛选
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: allRows.length + 1, column: 30 } };

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outPath = path.join(process.cwd(), 'src', 'data', `回测买卖点_${today}.xlsx`);
  await wb.xlsx.writeFile(outPath);
  console.log(`\n✅ 已导出到: ${outPath}`);
  console.log(`   共 ${allRows.length} 笔交易，${ALL_CODES.length} 个品种`);
}

main().catch((e) => { console.error(e); process.exit(1); });
