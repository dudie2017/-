/**
 * 监控方案回测：5 监控逻辑 × 3 参数组合 = 15 方案
 * 运行：npx tsx src/scripts/runMonitoringBacktest.ts
 * 输出：src/data/monitoringResult.json + 控制台摘要
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { BLACK_SWAN_EVENTS } from '../data/blackswanEvents';

interface Bar { date: string; o: number; h: number; l: number; c: number; vol: number; hold: number; ret: number | null }

interface Params {
  window: number;       // 监控窗口（天）
  threshold: number;    // ATR 阈值
  levels: 'all' | 'warn-severe' | 'severe-only';
  lagLimit: number;     // 传播链滞后上限（天）
}

const PARAM_SETS: Record<string, Params> = {
  P1: { window: 5,  threshold: 4, levels: 'severe-only', lagLimit: 3 },
  P2: { window: 10, threshold: 3, levels: 'warn-severe', lagLimit: 2 },
  P3: { window: 20, threshold: 2, levels: 'all',         lagLimit: 1 },
};

const CACHE_DIR = join(__dirname, '../../data-cache-daily-20y');

function loadVarietyBars(code: string): Bar[] {
  const fp = join(CACHE_DIR, `${code}.json`);
  if (!existsSync(fp)) return [];
  return JSON.parse(readFileSync(fp, 'utf8'));
}

function computeATR(bars: Bar[], i: number, period = 14): number {
  if (i < period) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) {
    const prev = bars[k - 1]?.c ?? bars[k].o;
    const tr = Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - prev), Math.abs(bars[k].l - prev));
    sum += tr;
  }
  return sum / period;
}

function computeSMA(values: number[], i: number, period = 20): number {
  if (i < period - 1) return 0;
  let sum = 0;
  for (let k = i - period + 1; k <= i; k++) sum += values[k];
  return sum / period;
}

// ============ 冲击检测 ============
interface Shock { code: string; barDate: string; atrMult: number; dir: 'up' | 'down'; dayRetPct: number }

function detectShocks(bars: Bar[], code: string, threshold: number): Shock[] {
  const shocks: Shock[] = [];
  const atrVals: number[] = [];
  const retVals: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    atrVals.push(computeATR(bars, i));
    retVals.push(bars[i].ret ?? 0);
  }
  const volMA = computeSMA(bars.map(b => b.vol), bars.length - 1);
  const volMA20: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    volMA20.push(computeSMA(bars.map(b => b.vol), i, 20));
  }

  for (let i = 1; i < bars.length; i++) {
    const atr = atrVals[i];
    if (atr <= 0) continue;
    const ret = retVals[i];
    const atrMult = Math.abs(ret) / (atr / bars[i - 1].c);
    if (atrMult >= threshold) {
      shocks.push({
        code,
        barDate: bars[i].date,
        atrMult,
        dir: ret > 0 ? 'up' : 'down',
        dayRetPct: ret * 100,
      });
    }
  }
  return shocks;
}

// ============ 事件匹配 ============
function findEventForShock(code: string, date: string, eventWindow: number): { event: typeof BLACK_SWAN_EVENTS[0]; daysSince: number } | null {
  const d = new Date(date).getTime();
  for (const ev of BLACK_SWAN_EVENTS) {
    if (!ev.varieties.includes(code)) continue;
    const evDate = new Date(ev.date).getTime();
    const diffDays = Math.round((d - evDate) / 86400000);
    if (diffDays >= -2 && diffDays <= eventWindow) {
      return { event: ev, daysSince: diffDays };
    }
  }
  return null;
}

// ============ 品种敏感度数据 ============
interface SensitivityEntry { code: string; sector: string; overallSensitivity: number; overallContinuation: number }
let sensitivityData: Record<string, SensitivityEntry> = {};

function loadSensitivity(): void {
  const fp = join(__dirname, '../../data/varietySensitivityResult.json');
  if (!existsSync(fp)) return;
  const arr = JSON.parse(readFileSync(fp, 'utf8')) as SensitivityEntry[];
  for (const e of arr) sensitivityData[e.code] = e;
}

// ============ 各方案评估 ============
interface SchemeResult {
  id: string;
  logic: string;
  params: string;
  warnings: number;
  correct: number;
  accuracy: number;      // 准确率
  missed: number;        // 漏报
  falseAlarm: number;    // 误报
  falseAlarmRate: number;
  leadTimeAvg: number;   // 平均提前天数
  returnImprov: number;  // 收益提升（%）
  winTrades: number;     // 盈利笔数
  loseTrades: number;    // 亏损笔数
  avgWin: number;        // 平均盈利（%）
  avgLose: number;       // 平均亏损（%）
  profitFactor: number;  // 盈亏比（总盈利/总亏损）
  perTradeAvg: number;   // 每笔平均收益（%）
  alertPerYear: number;  // 每年预警次数（20年×60品种）
}

/**
 * 基于 ATR 冲击动态学习传播对
 * 逻辑：leader 冲击后，在滞后窗口内 follower 出现同向显著波动即记为一次传播
 * 统计每个 (leader, follower) 对的传播次数与同向率，过滤出高置信度传播对
 */
function learnPropagationPairs(
  allShocks: Map<string, Array<{ code: string; barDate: string; atrMult: number; dir: 'up' | 'down'; dayRetPct: number }>>,
  allBars: Map<string, Bar[]>,
  params: Params,
): Array<{ leader: string; follower: string; lag: number }> {
  const pairStats = new Map<string, { leader: string; follower: string; total: number; same: number; lagSum: number }>();

  const codes = Array.from(allBars.keys());
  const minThreshold = Math.max(2, params.threshold - 1); // 学习时放宽阈值

  for (const leader of codes) {
    const shocks = allShocks.get(leader) || [];
    if (shocks.length === 0) continue;
    const lb = allBars.get(leader);
    if (!lb) continue;

    for (const sh of shocks) {
      if (sh.atrMult < minThreshold) continue; // 只学习显著冲击
      const lIdx = lb.findIndex(b => b.date === sh.barDate);
      if (lIdx < 0) continue;

      // 先计算 leader 在冲击后的窗口累计收益方向
      const lStart = lIdx + 1;
      const lEnd = Math.min(lIdx + params.window + 1, lb.length);
      let leadCum = 0;
      for (let k = lStart; k < lEnd; k++) {
        leadCum += (lb[k]?.ret ?? 0);
      }
      if (Math.abs(leadCum) < 0.005) continue; // leader 窗口内无明显方向，跳过（0.5%）

      for (const follower of codes) {
        if (follower === leader) continue;
        const fb = allBars.get(follower);
        if (!fb) continue;

        // 【修复】必须用跟随品种自身的日期数组索引，不能复用 lIdx（两个品种日期序列不对齐）
        const leadDate = sh.barDate;
        const fStart = fb.findIndex(b => b.date > leadDate);
        if (fStart < 0) continue;
        const fEnd = Math.min(fStart + Math.max(params.lagLimit, 1) + params.window, fb.length);

        // 计算 follower 在滞后窗口内的累计收益
        let follCum = 0;
        for (let k = fStart; k < fEnd; k++) {
          follCum += (fb[k]?.ret ?? 0);
        }
        if (Math.abs(follCum) < 0.008) continue; // follower 无明显波动，不算传播（0.8%）

        const key = `${leader}->${follower}`;
        if (!pairStats.has(key)) {
          pairStats.set(key, { leader, follower, total: 0, same: 0, lagSum: 0 });
        }
        const stat = pairStats.get(key)!;
        stat.total++;
        // 找到第一个显著波动日作为滞后
        let firstMoveIdx = -1;
        for (let k = fStart; k < fEnd; k++) {
          if (Math.abs(fb[k]?.ret ?? 0) > 0.003) { firstMoveIdx = k; break; }
        }
        if (firstMoveIdx >= 0) stat.lagSum += (firstMoveIdx - fStart);
        if ((leadCum > 0 && follCum > 0) || (leadCum < 0 && follCum < 0)) {
          stat.same++;
        }
      }
    }
  }

  // 过滤出高置信度传播对：至少2次传播，同向率>=60%
  const result: Array<{ leader: string; follower: string; lag: number }> = [];
  for (const stat of pairStats.values()) {
    const sameRate = stat.total > 0 ? stat.same / stat.total : 0;
    if (stat.total >= 2 && sameRate >= 0.6) {
      result.push({
        leader: stat.leader,
        follower: stat.follower,
        lag: Math.max(1, Math.round(stat.lagSum / stat.total)),
      });
    }
  }

  // 按传播次数排序，取前30
  const sorted = [...pairStats.values()]
    .filter(s => s.total >= 2 && (s.same / s.total) >= 0.6)
    .sort((a, b) => b.total - a.total);
  const topPairs = sorted.slice(0, 30).map(s => ({
    leader: s.leader,
    follower: s.follower,
    lag: Math.max(1, Math.round(s.lagSum / s.total)),
  }));

  return topPairs.length > 0 ? topPairs : result;
}

function evaluateScheme(
  logic: string,
  params: Params,
  allBars: Map<string, Bar[]>,
  allShocks: Map<string, Shock[]>,
): SchemeResult {
  let warnings = 0;
  let correct = 0;
  let falseAlarm = 0;
  let missed = 0;
  const leadTimes: number[] = [];
  let sumWin = 0;
  let sumLose = 0;

  if (logic === 'M1') {
    // M1 事件驱动：对每个事件，预测方向，验证
    for (const ev of BLACK_SWAN_EVENTS) {
      for (const code of ev.varieties) {
        const bars = allBars.get(code);
        if (!bars || bars.length === 0) continue;
        const evIdx = bars.findIndex(b => b.date >= ev.date);
        if (evIdx < 0) continue;

        // 用事件类别预测方向（简化：direction 字段）
        const predictedDir = ev.direction.includes('利空') ? 'down' : 'up';
        // 找到事件窗口内的实际方向
        let actualDir: 'up' | 'down' | 'none' = 'none';
        let actualReturn = 0;
        for (let k = evIdx + 1; k < Math.min(evIdx + params.window, bars.length); k++) {
          actualReturn += (bars[k].ret ?? 0);
        }
        if (actualReturn > 0) actualDir = 'up';
        else if (actualReturn < 0) actualDir = 'down';
        else actualDir = 'none';

        warnings++;
        if (actualDir === predictedDir) correct++;
        else if (actualDir !== 'none') falseAlarm++;
        // 漏报：事件发生但无显著波动（这里事件驱动总是预警，漏报=0）
        // 简化：如果实际波动 < 阈值，视为漏报（预警无意义）
        if (actualDir === 'none') missed++;

        if (actualReturn > 0) sumWin += actualReturn * 100;
        else if (actualReturn < 0) sumLose += Math.abs(actualReturn) * 100;
        leadTimes.push(1);
      }
    }
  } else if (logic === 'M2') {
    // M2 信号驱动：检查 V16 信号 + 新闻确认
    // 简化：用冲击作为"信号"，检查是否命中事件
    for (const [code, shocks] of allShocks) {
      const bars = allBars.get(code);
      if (!bars) continue;
      for (const sh of shocks) {
        const match = findEventForShock(code, sh.barDate, params.window);
        const idx = bars.findIndex(b => b.date === sh.barDate);
        if (idx < 0) continue;

        let afterRet = 0;
        for (let k = idx + 1; k < Math.min(idx + params.window, bars.length); k++) {
          afterRet += (bars[k].ret ?? 0);
        }
        const actualDir = afterRet > 0 ? 'up' : 'down';

        if (match) {
          // 新闻确认信号
          warnings++;
          const evDir = match.event.direction.includes('利空') ? 'down' : 'up';
          if (actualDir === evDir) {
            correct++;
            sumWin += afterRet * 100;
          } else {
            falseAlarm++;
            sumLose += Math.abs(afterRet) * 100;
          }
          leadTimes.push(Math.max(0, match.daysSince));
        } else {
          // 无新闻的信号 → 漏报（信号本身有效但未预警）
          // 简化：如果该冲击后续有显著波动，视为漏报
          if (Math.abs(afterRet) > params.threshold / 100) missed++;
        }
      }
    }
  } else if (logic === 'M3') {
    // M3 阈值预警：冲击超过阈值 → 预警
    for (const [code, shocks] of allShocks) {
      const bars = allBars.get(code);
      if (!bars) continue;
      for (const sh of shocks) {
        const idx = bars.findIndex(b => b.date === sh.barDate);
        if (idx < 0) continue;

        let afterRet = 0;
        for (let k = idx + 1; k < Math.min(idx + params.window, bars.length); k++) {
          afterRet += (bars[k].ret ?? 0);
        }
        const hasSignificantMove = Math.abs(afterRet) > 0.01; // >1% 视为显著（小数格式）

        // 预警条件：冲击强度 >= 阈值（不同参数级别）
        const isWarnLevel = params.levels === 'all'
          ? sh.atrMult >= params.threshold
          : params.levels === 'warn-severe'
            ? sh.atrMult >= params.threshold + 1
            : sh.atrMult >= params.threshold + 2;

        if (isWarnLevel) {
          warnings++;
          if (hasSignificantMove) {
            correct++;
            if (afterRet > 0) sumWin += afterRet * 100;
            else sumLose += Math.abs(afterRet) * 100;
          } else {
            falseAlarm++;
          }
          leadTimes.push(1);
        } else {
          // 低于阈值的冲击但有显著波动 → 漏报
          if (hasSignificantMove) missed++;
        }
      }
    }
  } else if (logic === 'M4') {
    // M4 传播链预警：领先品种冲击 → 预警跟随品种
    // 修复版：使用真实传播对（来自 propagationChainResult.json），
    // 根据领先品种的实际冲击方向（sh.dir）判断预期跟随方向，
    // 并排除同一天同步冲击（跟随品种波动必须晚于领先品种）
    // 先用 ATR 冲击动态学习传播对（样本多，可靠性高）
    const learnedPairs = learnPropagationPairs(allShocks, allBars, params);
    // 再补充事件库验证过的高置信度传播对
    const pp = join(__dirname, '../../src/data/propagationChainResult.json');
    const staticPairs: Array<{ leader: string; follower: string; lag: number }> = [];
    if (existsSync(pp)) {
      try {
        const pdata = JSON.parse(readFileSync(pp, 'utf8')) as any;
        const top = (pdata?.topPairs || []) as Array<Record<string, any>>;
        for (const pair of top) {
          if ((pair.coOccurrence || 0) >= 2 && (pair.correlation || 0) >= 0.6) {
            staticPairs.push({
              leader: pair.leader,
              follower: pair.follower,
              lag: Math.max(1, Math.round(pair.avgLag || 2)),
            });
          }
        }
      } catch (e) {
        // 忽略加载错误
      }
    }
    // 合并去重
    const seen = new Set<string>();
    const propagationPairs: Array<{ leader: string; follower: string; lag: number }> = [];
    for (const p of [...learnedPairs, ...staticPairs]) {
      const key = `${p.leader}->${p.follower}`;
      if (!seen.has(key)) {
        seen.add(key);
        propagationPairs.push(p);
      }
    }

    for (const pair of propagationPairs) {
      const lb = allBars.get(pair.leader);
      const fb = allBars.get(pair.follower);
      if (!lb || !fb) continue;

      // 找到跟随品种的所有冲击日期，用于排除同步冲击
      const followerShockDates = new Set((allShocks.get(pair.follower) || []).map(s => s.barDate));

      for (const sh of allShocks.get(pair.leader) || []) {
        const lIdx = lb.findIndex(b => b.date === sh.barDate);
        if (lIdx < 0) continue;

        // 只考虑大冲击作为传播源
        const isWarnLevel = params.levels === 'all'
          ? sh.atrMult >= params.threshold
          : params.levels === 'warn-severe'
            ? sh.atrMult >= params.threshold + 1
            : sh.atrMult >= params.threshold + 2;
        if (!isWarnLevel) continue;

        // 领先品种的实际冲击方向
        const leadDir = sh.dir; // 'up' | 'down'

        // 在滞后窗口内（1~lag+window天）检查跟随品种是否同向波动
        // 排除同一天（同步冲击不算传播）
        // 【修复】必须用跟随品种自身的日期数组索引，不能直接复用 lIdx（两个品种日期序列不对齐）
        const leadDate = sh.barDate;
        let fStart = fb.findIndex(b => b.date > leadDate); // 严格晚于领先冲击日
        if (fStart < 0) continue;
        let afterRet = 0;
        let hasLaterMove = false;
        let firstMoveDay = 0;
        const maxLook = Math.min(fStart + Math.max(pair.lag, 1) + params.window, fb.length);
        for (let k = fStart; k < maxLook; k++) {
          const ret = fb[k]?.ret ?? 0;
          afterRet += ret;
          const fbDate = fb[k]?.date || '';
          // 排除同步冲击（跟随品种当天也有冲击记录）
          if (followerShockDates.has(fbDate)) continue;
          if (!hasLaterMove && Math.abs(ret) > 0.003) {
            hasLaterMove = true;
            firstMoveDay = k - fStart;
          }
        }

        warnings++;
        // 正确：跟随品种有显著同向波动（方向与领先品种一致）
        const correctDir = (leadDir === 'up' && afterRet > 0) || (leadDir === 'down' && afterRet < 0);
        const hasMove = Math.abs(afterRet) > 0.01; // >1%（小数格式）
        if (hasLaterMove && correctDir && hasMove) {
          correct++;
          if (afterRet > 0) sumWin += afterRet * 100;
          else sumLose += Math.abs(afterRet) * 100;
        } else {
          falseAlarm++;
        }
        leadTimes.push(firstMoveDay > 0 ? firstMoveDay : pair.lag);
      }
    }
    // M4 结束
  } else if (logic === 'M5') {
    // M5 组合监控：M1 + M2 + M3 + M4 的简化合并
    const m1 = evaluateScheme('M1', params, allBars, allShocks);
    const m2 = evaluateScheme('M2', params, allBars, allShocks);
    const m3 = evaluateScheme('M3', params, allBars, allShocks);
    const m4 = evaluateScheme('M4', params, allBars, allShocks);

    warnings = m1.warnings + m2.warnings + m3.warnings + m4.warnings;
    correct = m1.correct + m2.correct + m3.correct + m4.correct;
    falseAlarm = m1.falseAlarm + m2.falseAlarm + m3.falseAlarm + m4.falseAlarm;
    missed = m1.missed + m2.missed + m3.missed + m4.missed;
    leadTimes.push(...m1.leadTimeAvg > 0 ? [m1.leadTimeAvg] : [], ...(m2.leadTimeAvg > 0 ? [m2.leadTimeAvg] : []), ...(m3.leadTimeAvg > 0 ? [m3.leadTimeAvg] : []), ...(m4.leadTimeAvg > 0 ? [m4.leadTimeAvg] : []));
    sumWin = m1.returnImprov > 0 ? m1.returnImprov : 0;
    sumLose = m1.warnings > 0 ? Math.max(0, m1.warnings - m1.correct - m1.missed) : 0;
  }

  const accuracy = warnings > 0 ? correct / warnings : 0;
  const falseAlarmRate = warnings > 0 ? falseAlarm / warnings : 0;
  const leadTimeAvg = leadTimes.length > 0 ? leadTimes.reduce((a, b) => a + b, 0) / leadTimes.length : 0;
  const returnImprov = sumWin - sumLose;
  const winTrades = correct;   // 方向正确且盈利的笔数（简化：correct 即计入 sumWin 的笔数）
  const loseTrades = falseAlarm; // 误报即亏损笔数（简化：falseAlarm 即计入 sumLose 的笔数）
  const avgWin = winTrades > 0 ? sumWin / winTrades : 0;
  const avgLose = loseTrades > 0 ? sumLose / loseTrades : 0;
  const profitFactor = sumLose > 0 ? sumWin / sumLose : (sumWin > 0 ? 999 : 0);
  const perTradeAvg = (warnings + missed) > 0 ? returnImprov / (warnings + missed) : 0;
  const alertPerYear = warnings / (20 * 60);

  return {
    id: `${logic}-${params.window}-${params.threshold}-${params.levels === 'all' ? 'A' : params.levels === 'warn-severe' ? 'W' : 'S'}-${params.lagLimit}`,
    logic,
    params: params.window === 5 ? 'P1' : params.window === 10 ? 'P2' : 'P3',
    warnings,
    correct,
    accuracy: accuracy * 100,
    missed,
    falseAlarm,
    falseAlarmRate: falseAlarmRate * 100,
    leadTimeAvg,
    returnImprov,
    winTrades,
    loseTrades,
    avgWin,
    avgLose,
    profitFactor,
    perTradeAvg,
    alertPerYear,
  };
}

// ============ 主流程 ============
async function main() {
  console.log('加载数据...');
  loadSensitivity();

  const codes = BLACK_SWAN_EVENTS.reduce<string[]>((acc, ev) => {
    for (const c of ev.varieties) if (!acc.includes(c)) acc.push(c);
    return acc;
  }, []);

  console.log(`品种数: ${codes.length}`);

  const allBars = new Map<string, Bar[]>();
  const allShocks = new Map<string, Shock[]>();
  for (const code of codes) {
    const bars = loadVarietyBars(code);
    if (bars.length > 0) {
      allBars.set(code, bars);
      // 用低阈值 1.5×ATR 检测所有潜在冲击，再按参数过滤
      allShocks.set(code, detectShocks(bars, code, 1.5));
    }
  }
  console.log(`有数据品种: ${allBars.size}, 冲击总数: ${[...allShocks.values()].reduce((a, s) => a + s.length, 0)}`);

  const logics = ['M1', 'M2', 'M3', 'M4', 'M5'];
  const results: any[] = [];
  for (const logic of logics) {
    for (const pName of ['P1', 'P2', 'P3']) {
      const params = PARAM_SETS[pName];
      const r = evaluateScheme(logic, params, allBars, allShocks);
      results.push(r);
      console.log(`${r.id} | 预警${r.warnings} | 准确率${r.accuracy.toFixed(1)}% | 误报率${r.falseAlarmRate.toFixed(1)}% | 提前${r.leadTimeAvg.toFixed(1)}天 | 盈亏比${r.profitFactor.toFixed(2)} | 每笔${r.perTradeAvg.toFixed(3)}% | 收益${r.returnImprov.toFixed(2)}%`);
    }
  }

  // 保存结果
  const outPath = join(__dirname, '../data/monitoringResult.json');
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\n结果已保存: ${outPath}`);

  // 按准确率排序输出 TOP
  const sorted = [...results].sort((a, b) => b.accuracy - a.accuracy);
  console.log('\n=== 准确率 TOP5 ===');
  sorted.slice(0, 5).forEach(r => console.log(`${r.id} | 准确率${r.accuracy.toFixed(1)}% | 预警${r.warnings}次 | 盈亏比${r.profitFactor.toFixed(2)} | 收益${r.returnImprov.toFixed(2)}%`));

  // 按收益提升排序输出 TOP
  const sortedRet = [...results].sort((a, b) => b.returnImprov - a.returnImprov);
  console.log('\n=== 收益提升 TOP5 ===');
  sortedRet.slice(0, 5).forEach(r => console.log(`${r.id} | 收益${r.returnImprov.toFixed(2)}% | 准确率${r.accuracy.toFixed(1)}% | 盈亏比${r.profitFactor.toFixed(2)} | 预警${r.warnings}次`));

  // 按每笔平均收益排序输出 TOP
  const sortedPer = [...results].sort((a, b) => b.perTradeAvg - a.perTradeAvg);
  console.log('\n=== 每笔平均收益 TOP5 ===');
  sortedPer.slice(0, 5).forEach(r => console.log(`${r.id} | 每笔${r.perTradeAvg.toFixed(3)}% | 准确率${r.accuracy.toFixed(1)}% | 收益${r.returnImprov.toFixed(2)}%`));

  // 按盈亏比排序输出 TOP
  const sortedPF = [...results].sort((a, b) => b.profitFactor - a.profitFactor);
  console.log('\n=== 盈亏比 TOP5 ===');
  sortedPF.slice(0, 5).forEach(r => console.log(`${r.id} | 盈亏比${r.profitFactor.toFixed(2)} | 每笔${r.perTradeAvg.toFixed(3)}% | 准确率${r.accuracy.toFixed(1)}%`));
}

main().catch(err => {
  console.error('执行失败:', err);
  process.exit(1);
});
