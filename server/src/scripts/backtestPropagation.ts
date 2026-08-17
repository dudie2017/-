/**
 * 传播链预警回测脚本（v2）
 * 用 20 年日线数据（data-cache-daily-20y），验证 PROPAGATION_WHITELIST 中每个
 * "leader 冲击 → follower 跟随"传播对的命中率，发现优化点。
 *
 * 验证口径（v2 修正）：
 * - 冲击检测：leader 在 T 日 |ret| >= threshold × ATR% (threshold 默认 1.0/2.0/3.0)
 * - next1 确认（可选）：T+1 日 leader 继续同向（与实时 detectShock 的 confirmNext1 一致）
 * - 跟随验证：follower 从 T 日收盘到「T+lag 日」收盘的累计涨跌幅方向，是否与 leader 冲击方向同向
 *   （比单日口径更符合"跟随"语义，避免单日噪音）
 * - 命中率 = 累计同向次数 / 总冲击次数
 *
 * 输出：
 * 1. 每个 pair 在不同阈值下的命中率（无确认 / 有 next1 确认）
 * 2. 板块级命中率汇总
 * 3. 无效 pair 清单（命中率 < 50%）
 * 4. 优化建议
 */
import * as fs from 'fs';
import * as path from 'path';
import { PROPAGATION_WHITELIST, type WhitelistPair } from '../data/propagationWhitelist.js';
import { VARIETIES } from '../services/varieties.js';

interface Bar {
  date: string;
  o: number;
  h: number;
  l: number;
  c: number;
  vol?: number | null;
  hold?: number | null;
  ret: number | null;
  rollover?: boolean;
}

const DATA_DIR = 'data-cache-daily-20y';

function loadBars(code: string): Bar[] {
  const fp = path.join(DATA_DIR, `${code}.json`);
  if (!fs.existsSync(fp)) return [];
  try {
    return JSON.parse(fs.readFileSync(fp, 'utf-8')) as Bar[];
  } catch {
    return [];
  }
}

function nameOf(code: string): string {
  return (VARIETIES as Record<string, string>)[code] || code;
}

/** 计算 ATR 序列（返回每个 bar 的 ATR14） */
function computeATR(bars: Bar[], period = 14): number[] {
  const trs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) {
      trs.push(b.h - b.l);
      continue;
    }
    const prevC = bars[i - 1].c;
    trs.push(Math.max(b.h - b.l, Math.abs(b.h - prevC), Math.abs(b.l - prevC)));
  }
  const atrs: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) {
      atrs.push(NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trs[j];
    atrs.push(sum / period);
  }
  return atrs;
}

interface Stat {
  n: number;
  hit: number;
  winRate: number;
  avgFollowPct: number; // follower 累计跟随幅度（平均）
}

interface PairResult {
  pair: WhitelistPair;
  leaderName: string;
  followerName: string;
  // threshold -> { noConfirm: Stat, confirmed: Stat }
  stats: Record<number, { noConfirm: Stat; confirmed: Stat }>;
}

/** 对单个 pair 做回测 */
function backtestPair(pair: WhitelistPair, thresholds: number[]): PairResult {
  const leaderBars = loadBars(pair.leader);
  const followerBars = loadBars(pair.follower);
  const stats: PairResult['stats'] = {};

  for (const t of thresholds) {
    stats[t] = {
      noConfirm: { n: 0, hit: 0, winRate: 0, avgFollowPct: 0 },
      confirmed: { n: 0, hit: 0, winRate: 0, avgFollowPct: 0 },
    };
  }

  if (leaderBars.length < 60 || followerBars.length < 60) {
    return { pair, leaderName: nameOf(pair.leader), followerName: nameOf(pair.follower), stats };
  }

  const atrs = computeATR(leaderBars);
  const followerDates = followerBars.map((b) => b.date);
  const followerByIdx = new Map<string, number>();
  followerDates.forEach((d, i) => followerByIdx.set(d, i));

  for (const threshold of thresholds) {
    for (let i = 14; i < leaderBars.length - 1; i++) {
      const b = leaderBars[i];
      if (b.rollover) continue;
      if (b.ret === null || b.ret === undefined) continue;
      const atr = atrs[i];
      if (!isFinite(atr) || atr <= 0 || b.c <= 0) continue;
      const atrPct = atr / b.c;

      // 冲击检测
      if (Math.abs(b.ret) < threshold * atrPct) continue;

      const leaderUp = b.ret >= 0;
      const shockDate = b.date;

      // follower 在冲击日的索引
      const fIdx = followerByIdx.get(shockDate);
      if (fIdx === undefined) continue;

      // 找 follower 在「冲击日 + lag 天」的收盘价（用 follower 自己的 bar 序列对齐，避免停牌缺失）
      const fTarget = followerBars[fIdx + pair.lag];
      if (!fTarget) continue;

      const fStart = followerBars[fIdx];
      if (!fStart || fStart.c <= 0) continue;

      // follower 累计收益：从冲击日收盘到 lag 日收盘
      const fCumRet = (fTarget.c - fStart.c) / fStart.c;
      const followerUp = fCumRet >= 0;
      const sameDir = leaderUp === followerUp;

      // next1 确认：leader 在 T+1 日继续同向
      const nextLeader = leaderBars[i + 1];
      const confirmed = nextLeader && nextLeader.ret !== null && nextLeader.ret !== undefined
        ? (leaderUp ? nextLeader.ret >= 0 : nextLeader.ret < 0)
        : false;

      const bucket = stats[threshold];
      const st = confirmed ? bucket.confirmed : bucket.noConfirm;
      st.n++;
      if (sameDir) st.hit++;
      st.avgFollowPct += (fCumRet * 100);
    }
    // 收尾计算 winRate / avg
    for (const key of ['noConfirm', 'confirmed'] as const) {
      const st = stats[threshold][key];
      st.winRate = st.n > 0 ? st.hit / st.n : 0;
      st.avgFollowPct = st.n > 0 ? st.avgFollowPct / st.n : 0;
    }
  }

  return { pair, leaderName: nameOf(pair.leader), followerName: nameOf(pair.follower), stats };
}

function fmt(s: Stat): string {
  if (s.n < 5) return '(样本不足)'.padEnd(18);
  return `${(s.winRate * 100).toFixed(0)}%/${s.n}`.padEnd(18);
}

function main() {
  const thresholds = [1.0, 2.0, 3.0];
  const results = PROPAGATION_WHITELIST.map((p) => backtestPair(p, thresholds));

  console.log('================================================================================================');
  console.log('传播链预警回测报告 v2（数据源：data-cache-daily-20y，20 年日线，累计跟随口径）');
  console.log('口径：leader |ret|≥阈值×ATR% → follower 从冲击日收盘到 lag 日收盘的累计涨跌方向是否同向');
  console.log('================================================================================================');
  console.log(
    '传播对'.padEnd(26),
    ...thresholds.map((t) => `≥${t}×ATR(无确认/有确认)`.padEnd(26))
  );
  console.log('------------------------------------------------------------------------------------------------');

  // 板块聚合（用 2×ATR + next1 确认作为主口径）
  const bySector: Record<string, { n: number; hit: number }> = {};
  const invalidPairs: string[] = [];
  const strongPairs: string[] = [];

  for (const r of results) {
    const name = `${r.pair.leader}(${r.leaderName})→${r.pair.follower}(${r.followerName})`.padEnd(24);
    const cols = thresholds.map((t) => {
      const s = r.stats[t];
      return `${fmt(s.noConfirm)}|${fmt(s.confirmed)}`.padEnd(26);
    });
    console.log(name, ...cols);

    const main = r.stats[2.0].confirmed;
    if (main.n >= 10) {
      if (!bySector[r.pair.sector]) bySector[r.pair.sector] = { n: 0, hit: 0 };
      bySector[r.pair.sector].n += main.n;
      bySector[r.pair.sector].hit += main.hit;
      if (main.winRate < 0.5) {
        invalidPairs.push(`${r.pair.leader}→${r.pair.follower}(${r.leaderName}→${r.followerName}) ${(main.winRate * 100).toFixed(0)}% N=${main.n}`);
      }
      if (main.winRate >= 0.55 && main.n >= 20) {
        strongPairs.push(`${r.pair.leader}→${r.pair.follower}(${r.leaderName}→${r.followerName}) ${(main.winRate * 100).toFixed(0)}% N=${main.n}`);
      }
    }
  }

  console.log('================================================================================================');
  console.log('板块级命中率汇总（阈值 2×ATR + next1 确认，样本 N≥10 的 pair）');
  console.log('------------------------------------------------------------------------------------------------');
  for (const [sector, v] of Object.entries(bySector)) {
    const wr = v.n > 0 ? (v.hit / v.n) * 100 : 0;
    console.log(`  ${sector.padEnd(10)} 命中率 ${wr.toFixed(1)}%  (N=${v.n})`);
  }

  console.log('');
  console.log('--------------------------------------------------------------------------------');
  console.log('❌ 命中率 < 50% 的传播对（阈值 2×ATR + next1 确认，建议审查/移除/修正）');
  console.log('--------------------------------------------------------------------------------');
  if (invalidPairs.length === 0) console.log('  无');
  else for (const p of invalidPairs) console.log(`  ${p}`);

  console.log('');
  console.log('--------------------------------------------------------------------------------');
  console.log('✅ 命中率 ≥ 55% 且样本充足的传播对（建议强化/保留）');
  console.log('--------------------------------------------------------------------------------');
  if (strongPairs.length === 0) console.log('  无');
  else for (const p of strongPairs) console.log(`  ${p}`);
}

main();
