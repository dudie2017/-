// @ts-nocheck
/**
 * 临时调试：SC0 生产基线 0 交易问题定位（内联后处理）
 */
import * as fs from 'fs';
import * as path from 'path';
import { runBacktest } from '../services/backtestEngine';
import { scanV16Variety } from '../services/v16_engine';

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

function loadBars(code: string): any[] {
  const p = path.join(DATA_DIR, `${code}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// 简化版熔断：连亏 n 笔暂停 m 天（与引擎一致口径）
function circuitBreaker(trades: any[], lossStreak: number, pauseDays: number): any[] {
  if (!trades || trades.length === 0) return trades;
  const out: any[] = [];
  let streak = 0;
  let pauseUntil = 0;
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const idx = i;
    if (idx < pauseUntil) continue;
    out.push(t);
    if (t.pnl < 0) {
      streak++;
      if (streak >= lossStreak) {
        pauseUntil = idx + pauseDays;
        streak = 0;
      }
    } else {
      streak = 0;
    }
  }
  return out;
}

async function debug() {
  const code = 'SC0';
  const bars = loadBars(code);
  console.log(`bars.length = ${bars.length}`);

  const hist = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'src/data', code + '_1000Experiments.json'), 'utf8'));
  const baseRecipe = hist.baseline.recipe;
  console.log('baseRecipe:', JSON.stringify(baseRecipe));

  const warmup = 60;
  const edgeLookback = Number(baseRecipe.edgeLookback) || 70;
  const allowRangeTrading = baseRecipe.allowRangeTrading !== false;

  // 预扫描（逐行对齐）
  const rows: any[] = [];
  for (let i = warmup; i < bars.length - 2; i++) {
    const histBars = bars.slice(0, i);
    const row = await scanV16Variety(code, histBars as any, code, { edgeLookback, allowRangeTrading });
    rows.push(row);
  }
  console.log(`prescanned rows = ${rows.length}`);

  const startCapital = Number(baseRecipe.startCapital) || 500000;
  const maxPositionPct = Number(baseRecipe.maxPositionPct) ?? 0.15;
  const baseParams = {
    stopAtrMult: Number(baseRecipe.stopAtrMult) ?? 2.14,
    targetAtrMult: Number(baseRecipe.targetAtrMult) ?? 4.44,
    maxHoldDays: Number(baseRecipe.maxHoldDays) ?? 20,
    cooldownBars: Number(baseRecipe.cooldownBars) ?? 1,
    trendFilter: Boolean(baseRecipe.trendFilter),
    minSignalGrade: String(baseRecipe.minSignalGrade || 'L1'),
  };
  console.log('baseParams:', JSON.stringify(baseParams));

  const sideParams = {
    long: { ...baseParams },
    short: { ...baseParams },
  };

  const signalCache: Map<string, any[]> = new Map([[code, rows]]);

  try {
    const result: any = await runBacktest({
      startCapital,
      maxPositionPct,
      minSignalGrade: 'L2',
      maxHoldDays: 15,
      stopAtrMult: 1.5,
      targetAtrMult: 3.0,
      minRR: 1.0,
      cooldownBars: 0,
      trendFilter: false,
      warmupBars: warmup,
      equationMode: baseRecipe.equationMode || 'none',
      softEquationMul: Number(baseRecipe.softEquationMul) || 0.5,
      pThreshold: Number(baseRecipe.pThreshold) ?? 0.5,
      nonGreenMul: Number(baseRecipe.nonGreenMul) ?? 1.0,
      counterCampMul: Number(baseRecipe.counterCampMul) ?? 1.0,
      campWindow: Number(baseRecipe.campWindow) ?? 21,
      feeMult: 1.0,
      dataDir: DATA_DIR,
      codes: [code],
      signalCache,
      sideParams,
      edgeLookback,
      allowRangeTrading,
      chExemptEquation: false,
      returnAllTrades: true,
      quiet: true,
    });
    console.log('raw trades:', (result.trades || []).length);

    let trades = (result.trades || []) as any[];
    console.log('after directionFilter(both):', trades.length);

    const cbStr = String(baseRecipe.circuitBreaker || 'off');
    if (cbStr !== 'off') {
      const [n, m] = cbStr.split('x').map(Number);
      trades = circuitBreaker(trades, n, m);
      console.log(`after circuitBreaker(${cbStr}):`, trades.length);
    }

    const volReduce = String(baseRecipe.volReduce || 'off');
    if (volReduce !== 'off') {
      console.log(`volReduce(${volReduce}) 逻辑未内联，跳过（数量不变）`);
    }

    const dailyLossLimit = String(baseRecipe.dailyLossLimit || 'off');
    if (dailyLossLimit !== 'off') {
      console.log(`dailyLossLimit(${dailyLossLimit}) 逻辑未内联，跳过（数量不变）`);
    }

    console.log('final trades:', trades.length);
    if (trades.length > 0) {
      const pnl = trades.reduce((s: number, t: any) => s + (t.pnl || 0), 0);
      console.log('total pnl:', (pnl / 10000).toFixed(1) + '万');
    }
  } catch (e) {
    console.error('ERROR:', e);
  }
}

debug();
