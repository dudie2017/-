/**
 * v17 回测：S6/S7 过滤器阈值优化
 * 
 * 目标：放宽 S6/S7 阈值，增加信号数量，同时保持 PF
 * 
 * 测试矩阵：
 * - S6 板块联动阈值：30% / 40% / 50%
 * - S7 季节性阈值：弱同向 / 同向 / 强同向
 * 
 * 正确实现 v15 策略：在 follower 上模拟交易
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { PROPAGATION_WHITELIST } from '../data/propagationWhitelist';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==================== 数据加载 ====================

interface DailyBar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  hold: number;
  ret: number | null;
}

const DATA_DIR = path.resolve(__dirname, '../../data-cache-daily-20y');

function loadAllData(): Map<string, DailyBar[]> {
  const result = new Map<string, DailyBar[]>();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
  
  for (const file of files) {
    const code = file.replace('.json', '');
    const filePath = path.join(DATA_DIR, file);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    
    // 计算收益率
    const bars: DailyBar[] = raw.map((d: any, i: number) => ({
      date: d.date || d.trade_date,
      o: d.open || d.o,
      h: d.high || d.h,
      l: d.low || d.l,
      c: d.close || d.c,
      vol: d.vol || d.volume || 0,
      hold: d.oi || d.hold || 0,
      ret: i === 0 ? null : (d.close || d.c) / (raw[i-1].close || raw[i-1].c) - 1
    }));
    
    result.set(code, bars);
  }
  
  return result;
}

// ==================== 板块映射 ====================

const SECTOR_MAP: Record<string, string> = {
  CU0: '有色', ZN0: '有色', AL0: '有色', PB0: '有色', NI0: '有色', SN0: '有色', SS0: '有色',
  RB0: '黑色系', I0: '黑色系', J0: '黑色系', JM0: '黑色系', HC0: '黑色系', SF0: '黑色系', SM0: '黑色系', FG0: '黑色系', SA0: '黑色系',
  AU0: '贵金属', AG0: '贵金属',
  M0: '油脂油料', Y0: '油脂油料', OI0: '油脂油料', RM0: '油脂油料', A0: '油脂油料', B0: '油脂油料', P0: '油脂油料',
  CF0: '软商品', SR0: '软商品', AP0: '软商品',
  BU0: '能源', SC0: '能源', LU0: '能源', NR0: '能源',
  MA0: '化工', TA0: '化工', PP0: '化工', EG0: '化工', EB0: '化工', PG0: '化工', V0: '化工',
  IF0: '金融', IH0: '金融', IC0: '金融', IM0: '金融',
};

// ==================== ATR 计算 ====================

function calcATR(bars: DailyBar[], period: number): number[] {
  const atr: number[] = new Array(bars.length).fill(0);
  for (let i = period; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += bars[j].h - bars[j].l;
    }
    atr[i] = sum / period;
  }
  return atr;
}

// ==================== 冲击检测 ====================

interface Shock {
  code: string;
  date: string;
  direction: 'up' | 'down';
  atrMult: number;
  barIdx: number;
}

function detectShocks(data: Map<string, DailyBar[]>, threshold: number = 4): Shock[] {
  const shocks: Shock[] = [];
  
  for (const [code, bars] of data) {
    const atr = calcATR(bars, 14);
    
    for (let i = 14; i < bars.length; i++) {
      const bar = bars[i];
      if (bar.ret === null) continue;
      
      const atrVal = atr[i];
      if (atrVal <= 0) continue;
      
      // 将 ATR 转换为百分比（与 v15 回测一致）
      const atrPct = atrVal / bar.c;
      const atrMult = Math.abs(bar.ret) / atrPct;
      if (atrMult >= threshold) {
        shocks.push({
          code,
          date: bar.date,
          direction: bar.ret > 0 ? 'up' : 'down',
          atrMult,
          barIdx: i
        });
      }
    }
  }
  
  return shocks;
}

// ==================== 过滤器 ====================

// S6: 板块联动
function checkSectorCorrelation(shock: Shock, data: Map<string, DailyBar[]>, threshold: number): boolean {
  const sector = SECTOR_MAP[shock.code];
  if (!sector) return false;
  
  // 找同板块其他品种
  const peers: string[] = [];
  for (const [code, s] of Object.entries(SECTOR_MAP)) {
    if (s === sector && code !== shock.code && data.has(code)) {
      peers.push(code);
    }
  }
  if (peers.length === 0) return false;
  
  // 检查冲击日同板块品种同向比例
  const shockBar = data.get(shock.code)![shock.barIdx];
  const shockDate = shockBar.date;
  let sameDirCount = 0;
  let validCount = 0;
  
  for (const peer of peers) {
    const peerBars = data.get(peer)!;
    const peerIdx = peerBars.findIndex(b => b.date === shockDate);
    if (peerIdx < 1) continue;
    const peerRet = peerBars[peerIdx].ret;
    if (peerRet === null || peerRet === undefined) continue;
    
    validCount++;
    if ((shock.direction === 'up' && peerRet > 0) ||
        (shock.direction === 'down' && peerRet < 0)) {
      sameDirCount++;
    }
  }
  
  if (validCount === 0) return false;
  return (sameDirCount / validCount) >= threshold;
}

// S7: 季节性
function checkSeasonality(shock: Shock, bars: DailyBar[], threshold: number): boolean {
  const shockIdx = shock.barIdx;
  const shockDate = new Date(bars[shockIdx].date);
  const shockMonth = shockDate.getMonth();
  const shockDay = shockDate.getDate();
  
  // 收集历史同期收益
  const historicalReturns: number[] = [];
  for (let i = 14; i < bars.length; i++) {
    if (i === shockIdx) continue;
    const d = new Date(bars[i].date);
    const m = d.getMonth();
    const day = d.getDate();
    // 检查是否在±15天内
    const monthDiff = Math.abs(m - shockMonth);
    const dayDiff = Math.abs(day - shockDay);
    if (monthDiff <= 1 && dayDiff <= 15) {
      const ret = bars[i].ret;
      if (ret !== null && ret !== undefined) {
        historicalReturns.push(ret);
      }
    }
  }
  
  if (historicalReturns.length < 5) return false;
  const avgRet = historicalReturns.reduce((a, b) => a + b, 0) / historicalReturns.length;
  
  // 根据阈值判断
  if (threshold <= 0.3) {
    // 弱同向：平均收益方向与冲击相同
    return (shock.direction === 'up' && avgRet > 0) ||
           (shock.direction === 'down' && avgRet < 0);
  } else if (threshold <= 0.5) {
    // 同向：平均收益方向与冲击相同，且平均收益绝对值 > 0.1%
    return (shock.direction === 'up' && avgRet > 0.001) ||
           (shock.direction === 'down' && avgRet < -0.001);
  } else if (threshold >= 0.7) {
    // 强同向：平均收益方向与冲击相同，且平均收益绝对值 > 0.3%
    return (shock.direction === 'up' && avgRet > 0.003) ||
           (shock.direction === 'down' && avgRet < -0.003);
  }
  
  return false;
}

// ==================== 交易模拟（在 follower 上） ====================

interface Trade {
  leaderCode: string;
  followerCode: string;
  direction: 'up' | 'down';
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  holdDays: number;
}

function simulateTrade(
  shock: Shock,
  pair: { leader: string; follower: string; lag: number },
  data: Map<string, DailyBar[]>,
  s6Threshold: number,
  s7Threshold: number
): Trade | null {
  const leaderBars = data.get(shock.code);
  const followerBars = data.get(pair.follower);
  if (!leaderBars || !followerBars) return null;
  
  // 高波动过滤
  const atrShort = calcATR(leaderBars, 14);
  const atrLong = calcATR(leaderBars, 60);
  if (shock.barIdx < 60) return null;
  if (atrShort[shock.barIdx] <= atrLong[shock.barIdx]) return null;
  
  // next1确认
  if (shock.barIdx + 1 >= leaderBars.length) return null;
  const nextRet = leaderBars[shock.barIdx + 1].ret;
  if (nextRet === null || nextRet === undefined) return null;
  if ((shock.direction === 'up' && nextRet <= 0) ||
      (shock.direction === 'down' && nextRet >= 0)) return null;
  
  // S6: 板块联动过滤
  if (!checkSectorCorrelation(shock, data, s6Threshold)) return null;
  
  // S7: 季节性过滤
  if (!checkSeasonality(shock, leaderBars, s7Threshold)) return null;
  
  // 找follower入场点（lag天后）
  const shockDate = leaderBars[shock.barIdx].date;
  const followerStartIdx = followerBars.findIndex(b => b.date === shockDate);
  if (followerStartIdx < 0) return null;
  const entryIdx = Math.min(followerStartIdx + pair.lag, followerBars.length - 1);
  if (entryIdx >= followerBars.length - 1) return null;
  
  const entryPrice = followerBars[entryIdx].c;
  const dir = shock.direction === 'up' ? 1 : -1;
  
  // 模拟持有（最多20天，止损1%）
  let exitIdx = entryIdx;
  for (let i = 1; i <= 20 && entryIdx + i < followerBars.length; i++) {
    const bar = followerBars[entryIdx + i];
    const pnl = ((bar.c - entryPrice) / entryPrice) * dir;
    
    // 止损
    if (pnl <= -0.01) {
      exitIdx = entryIdx + i;
      break;
    }
    
    exitIdx = entryIdx + i;
    
    // 达到20天
    if (i === 20) break;
  }
  
  const exitPrice = followerBars[exitIdx].c;
  const pnl = ((exitPrice - entryPrice) / entryPrice) * dir;
  
  return {
    leaderCode: shock.code,
    followerCode: pair.follower,
    direction: shock.direction,
    entryDate: followerBars[entryIdx].date,
    exitDate: followerBars[exitIdx].date,
    entryPrice,
    exitPrice,
    pnl,
    holdDays: exitIdx - entryIdx
  };
}

// ==================== 主函数 ====================

async function main() {
  console.log('=== v17 S6/S7 过滤器阈值优化回测 ===\n');
  
  const data = loadAllData();
  console.log(`加载 ${data.size} 个品种\n`);
  
  // 检测冲击
  const shocks = detectShocks(data, 4);
  console.log(`检测到 ${shocks.length} 个 ≥4×ATR 冲击`);
  
  // 检查白名单中的 leader 是否有冲击
  const leaderCodes = [...new Set(PROPAGATION_WHITELIST.map(p => p.leader))];
  const shockCodes = [...new Set(shocks.map(s => s.code))];
  const matchingLeaders = leaderCodes.filter(l => shockCodes.includes(l));
  console.log(`白名单中有 ${leaderCodes.length} 个 unique leader`);
  console.log(`冲击中有 ${shockCodes.length} 个 unique code`);
  console.log(`匹配的 leader: ${matchingLeaders.length} 个 (${matchingLeaders.slice(0, 10).join(', ')})\n`);
  
  // 测试矩阵
  const configs = [
    { s6: 0.3, s7: 0.5, name: 'S6_30%_S7_weak' },
    { s6: 0.4, s7: 0.5, name: 'S6_40%_S7_weak' },
    { s6: 0.5, s7: 0.5, name: 'S6_50%_S7_weak' },
    { s6: 0.3, s7: 0.6, name: 'S6_30%_S7_normal' },
    { s6: 0.4, s7: 0.6, name: 'S6_40%_S7_normal' },
    { s6: 0.5, s7: 0.6, name: 'S6_50%_S7_normal' },
    { s6: 0.3, s7: 0.7, name: 'S6_30%_S7_strong' },
    { s6: 0.4, s7: 0.7, name: 'S6_40%_S7_strong' },
    { s6: 0.5, s7: 0.7, name: 'S6_50%_S7_strong' },
  ];
  
  const results: any[] = [];
  
  for (const config of configs) {
    const trades: Trade[] = [];
    
    for (const shock of shocks) {
      // 找白名单对
      const pairs = PROPAGATION_WHITELIST.filter(p => p.leader === shock.code);
      
      for (const pair of pairs) {
        const trade = simulateTrade(shock, pair, data, config.s6, config.s7);
        if (trade) trades.push(trade);
      }
    }
    
    // 计算统计
    const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0);
    const winCount = trades.filter(t => t.pnl > 0).length;
    const lossCount = trades.filter(t => t.pnl < 0).length;
    const grossProfit = trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0);
    const grossLoss = Math.abs(trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0));
    const pf = grossLoss > 0 ? grossProfit / grossLoss : 0;
    
    // 计算最大回撤
    let peak = 0;
    let maxDrawdown = 0;
    let cumPnl = 0;
    for (const trade of trades) {
      cumPnl += trade.pnl;
      if (cumPnl > peak) peak = cumPnl;
      const drawdown = peak - cumPnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
    
    results.push({
      name: config.name,
      signalCount: trades.length,
      totalPnl,
      winRate: trades.length > 0 ? winCount / trades.length : 0,
      pf,
      maxDrawdown,
      avgHoldDays: trades.length > 0 ? trades.reduce((sum, t) => sum + t.holdDays, 0) / trades.length : 0
    });
  }
  
  // 排序并输出
  results.sort((a, b) => b.pf - a.pf);
  
  console.log('=== 排序结果（按 PF 降序）===\n');
  for (const r of results) {
    console.log(`${r.name}: 信号=${r.signalCount}, PF=${r.pf.toFixed(2)}, 胜率=${(r.winRate * 100).toFixed(1)}%, 最大回撤=${(r.maxDrawdown * 100).toFixed(2)}%`);
  }
  
  // 保存结果
  const outputPath = path.resolve(__dirname, '../data/v17Result.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存到: ${outputPath}`);
}

main().catch(console.error);
