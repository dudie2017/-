/**
 * 理论最大收益基准 (theoreticalMax.ts)
 *
 * 定义：完美摆动交易者基准
 * - ZigZag 摆动检测识别所有 swing high / swing low
 * - 在 swing low（支撑位）做多 → swing high（阻力位）平多并反手做空
 * - 在 swing high 做空 → swing low 平空并反手做多
 * - 永远买在最低点、卖在最高点、反手开仓、吃满每段行情
 *
 * 输出：多档阈值（3% / 5% / 8%）的理论最大收益（做多段 / 做空段 / 合计）
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold?: number; }

const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

export function loadBars(code: string): Bar[] {
  try {
    const fp = path.join(DATA_DIR, `${code}.json`);
    const raw = fs.readFileSync(fp, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data?.bars && Array.isArray(data.bars)) return data.bars;
    return [];
  } catch { return []; }
}

// ============ ZigZag 摆动检测 ============

interface SwingPoint {
  index: number;
  date: string;
  price: number;
  type: 'high' | 'low';
}

/**
 * ZigZag 摆动检测（基于收盘价的百分比阈值）
 * 返回确认后的摆动点序列（从第一个极值开始交替 high/low）
 */
export function zigzag(bars: Bar[], thresholdPct: number): SwingPoint[] {
  if (bars.length < 2) return [];
  const thresh = thresholdPct / 100;

  const points: SwingPoint[] = [];
  // 初始化：找第一个极值
  let startIdx = 0;
  let startPrice = bars[0].c;

  // 状态: 1 = 寻找更高高点（可能做多段）; -1 = 寻找更低低点（可能做空段）
  let state = 0;

  let lastExtreme: SwingPoint = { index: 0, date: bars[0].date, price: bars[0].c, type: 'low' };

  for (let i = 1; i < bars.length; i++) {
    const price = bars[i].c;

    if (state === 0) {
      // 初始：判断第一段方向
      if (price > startPrice + startPrice * thresh) {
        state = 1;
        points.push({ index: startIdx, date: bars[startIdx].date, price: startPrice, type: 'low' });
        lastExtreme = { index: startIdx, date: bars[startIdx].date, price: startPrice, type: 'low' };
      } else if (price < startPrice - startPrice * thresh) {
        state = -1;
        points.push({ index: startIdx, date: bars[startIdx].date, price: startPrice, type: 'high' });
        lastExtreme = { index: startIdx, date: bars[startIdx].date, price: startPrice, type: 'high' };
      }
      continue;
    }

    if (state === 1) {
      // 寻找高点：当前价格创新高则更新，回落超过阈值则确认高点
      if (price > lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      } else if (lastExtreme.price - price >= lastExtreme.price * thresh) {
        points.push(lastExtreme);
        state = -1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      }
    } else {
      // 寻找低点：当前价格创新低则更新，反弹超过阈值则确认低点
      if (price < lastExtreme.price) {
        lastExtreme = { index: i, date: bars[i].date, price, type: 'low' };
      } else if (price - lastExtreme.price >= lastExtreme.price * thresh) {
        points.push(lastExtreme);
        state = 1;
        lastExtreme = { index: i, date: bars[i].date, price, type: 'high' };
      }
    }
  }

  // 最后未确认的极值点（作为末端参考，不参与已确认收益计算）
  return points;
}

// ============ 理论收益计算 ============

interface TheoreticalResult {
  thresholdPct: number;
  swingCount: number;
  longSegments: number;
  shortSegments: number;
  longReturn: number;   // 做多段累计收益（简单累加）
  shortReturn: number;  // 做空段累计收益（简单累加）
  totalReturn: number;  // 合计累计收益
  compoundLong: number; // 做多段复利收益
  compoundShort: number;
  compoundTotal: number;
  maxDrawdown: number;  // 理论路径的最大回撤（按累计权益）
  withFeeReturn: number; // 计费后合计收益（每段往返手续费0.03%）
  avgLongMovePct: number; // 平均每段做多涨幅
  avgShortMovePct: number; // 平均每段做空跌幅
}

/**
 * 计算理论最大收益
 * 策略：每段 swing low → swing high 做多（吃满涨幅），swing high → swing low 做空（吃满跌幅）
 * 反手开仓 = 无缝衔接
 */
export function computeTheoreticalMax(bars: Bar[], thresholdPct: number): TheoreticalResult {
  const points = zigzag(bars, thresholdPct);
  const feeRate = 0.0003; // 每段往返手续费+滑点 0.03%

  let longReturn = 0;
  let shortReturn = 0;
  let compoundLong = 1;
  let compoundShort = 1;
  let longSegments = 0;
  let shortSegments = 0;
  let totalMovePctLong = 0;
  let totalMovePctShort = 0;

  // 权益曲线（累计收益率）用于回撤计算
  let cumulative = 0;
  const equityCurve: number[] = [0];
  let peak = 0;
  let maxDD = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.type === b.type) continue; // 理论不应发生（ZigZag交替）

    if (a.type === 'low' && b.type === 'high') {
      // 做多段：从支撑位到阻力位
      const move = (b.price - a.price) / a.price;
      longReturn += move;
      totalMovePctLong += move;
      longSegments++;
      compoundLong *= (1 + move);
      cumulative += move;
    } else if (a.type === 'high' && b.type === 'low') {
      // 做空段：从阻力位到支撑位
      const move = (a.price - b.price) / a.price;
      shortReturn += move;
      totalMovePctShort += move;
      shortSegments++;
      compoundShort *= (1 + move);
      cumulative += move;
    }

    // 扣除手续费（理论净值版）
    cumulative -= feeRate;
    equityCurve.push(cumulative);
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDD) maxDD = dd;
  }

  const totalReturn = longReturn + shortReturn;
  const compoundTotal = compoundLong * compoundShort;
  const withFeeReturn = totalReturn - feeRate * (points.length - 1);

  return {
    thresholdPct,
    swingCount: points.length,
    longSegments,
    shortSegments,
    longReturn,
    shortReturn,
    totalReturn,
    compoundLong: compoundLong - 1,
    compoundShort: compoundShort - 1,
    compoundTotal: compoundTotal - 1,
    maxDrawdown: maxDD,
    withFeeReturn,
    avgLongMovePct: longSegments > 0 ? totalMovePctLong / longSegments : 0,
    avgShortMovePct: shortSegments > 0 ? totalMovePctShort / shortSegments : 0,
  };
}

// ============ 主函数 ============

async function main() {
  const code = process.argv[2] || 'AG0';
  const name = process.argv[3] || '白银';
  const bars = loadBars(code);

  if (bars.length === 0) {
    console.error(`[ERROR] 未找到 ${code} 数据`);
    process.exit(1);
  }

  const startDate = bars[0].date;
  const endDate = bars[bars.length - 1].date;
  const years = (new Date(endDate).getTime() - new Date(startDate).getTime()) / (365.25 * 24 * 3600 * 1000);

  console.log(`\n${'='.repeat(64)}`);
  console.log(`【理论最大收益基准】${name} ${code}`);
  console.log(`${'='.repeat(64)}`);
  console.log(`数据范围: ${startDate} ~ ${endDate} (${years.toFixed(1)}年, ${bars.length}根日线)`);
  console.log(`理论定义: 支撑位做多→阻力位平多反手做空→支撑位平空反手做多 (买在最低卖在最高)`);
  console.log('');

  const thresholds = [3, 5, 8];
  const results = thresholds.map((t) => computeTheoreticalMax(bars, t));

  console.log(`${'-'.repeat(64)}`);
  console.log(`阈值    摆动点   做多段  做空段   做多收益   做空收益   合计收益   复利合计   最大回撤   计费合计`);
  for (const r of results) {
    console.log(
      `${r.thresholdPct}%     ${String(r.swingCount).padStart(4)}     ${String(r.longSegments).padStart(4)}    ${String(r.shortSegments).padStart(5)}    ` +
      `${(r.longReturn * 100).toFixed(1).padStart(7)}%   ${(r.shortReturn * 100).toFixed(1).padStart(7)}%   ` +
      `${(r.totalReturn * 100).toFixed(1).padStart(7)}%   ${(r.compoundTotal * 100).toFixed(1).padStart(7)}%   ` +
      `${(r.maxDrawdown * 100).toFixed(1).padStart(7)}%   ${(r.withFeeReturn * 100).toFixed(1).padStart(7)}%`
    );
  }
  console.log(`${'-'.repeat(64)}`);
  console.log('');

  // 详细输出每档的段数统计
  for (const r of results) {
    console.log(`▎${r.thresholdPct}% 阈值详细:`);
    console.log(`  做多: ${r.longSegments}段, 平均每段涨幅 ${(r.avgLongMovePct * 100).toFixed(2)}%, 累计 ${(r.longReturn * 100).toFixed(1)}%`);
    console.log(`  做空: ${r.shortSegments}段, 平均每段跌幅 ${(r.avgShortMovePct * 100).toFixed(2)}%, 累计 ${(r.shortReturn * 100).toFixed(1)}%`);
    console.log(`  合计: ${(r.totalReturn * 100).toFixed(1)}% (计费后 ${(r.withFeeReturn * 100).toFixed(1)}%), 复利 ${(r.compoundTotal * 100).toFixed(1)}%, 最大回撤 ${(r.maxDrawdown * 100).toFixed(1)}%`);
    console.log('');
  }

  // 保存结果
  const outDir = path.join(process.cwd(), 'src/data');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `theoreticalMax_${code}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    code, name, startDate, endDate, years: Number(years.toFixed(2)), bars: bars.length,
    results,
  }, null, 2));
  console.log(`[SAVED] ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
