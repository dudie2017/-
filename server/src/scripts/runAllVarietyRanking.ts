/**
 * 全品种回测（App最新逻辑）
 * 70个品种 × 全量历史，包括白名单 + 被剔除品种 + 国债 + 其他常见
 * 输出完整指标：交易数 / 胜率 / 盈亏比 / 收益率 / PF / 回撤 / 夏普
 *
 * App最新配置：
 * - minSignalGrade = L2
 * - maxHoldDays = 15bar
 * - equationMode = none（移除方程）
 * - minRR = 1.0
 * - nonGreenMul / counterCampMul = 1.0（移除降级）
 * - cooldownBars = 0（移除冷却）
 * - allowRangeTrading = true（开放区间市）
 */
import * as path from 'path';
import * as fs from 'fs';
import { runBacktest } from '../services/backtestEngine.js';

const DATA_DIR = path.resolve(process.cwd(), 'data-cache-all70');

// App 最新逻辑配置
const APP_CFG = {
  minSignalGrade: 'L2' as const,
  maxHoldDays: 15,
  equationMode: 'none' as const,
  minRR: 1.0,
  nonGreenMul: 1.0,
  counterCampMul: 1.0,
  cooldownBars: 0,
  allowRangeTrading: true,
  edgeLookback: 70,
  warmupBars: 60,
};

// 分类标记
const EXCLUDED1 = new Set(['SN0', 'SS0', 'RU0', 'RB0', 'WR0', 'PB0', 'NR0']); // 第一批剔除
const EXCLUDED2 = new Set(['IF0', 'IH0', 'IC0', 'AU0', 'CF0', 'A0', 'M0', 'UR0']); // 第二批剔除
const BONDS = new Set(['T0', 'TF0', 'TS0', 'TL0']); // 国债
const WHITELIST = new Set([
  'CU0', 'AL0', 'ZN0', 'NI0', 'AG0', 'HC0', 'SP0', 'FU0', 'BU0', 'AO0',
  'SC0', 'LU0', 'BC0', 'EC0',
  'I0', 'JM0', 'J0', 'P0', 'LH0', 'JD0', 'L0', 'PP0', 'EB0', 'PG0',
  'AP0', 'SA0', 'FG0', 'TA0', 'EG0', 'MA0', 'RM0', 'CJ0', 'SF0', 'SM0', 'PF0', 'PX0', 'SH0',
  'IM0', 'SI0', 'LC0',
]);

const NAME_MAP: Record<string, string> = {
  CU0: '铜', AL0: '铝', ZN0: '锌', NI0: '镍', AG0: '白银', HC0: '热卷', SP0: '纸浆',
  FU0: '燃油', BU0: '沥青', AO0: '氧化铝', SC0: '原油', LU0: '低硫油', BC0: '国际铜',
  EC0: '欧线', I0: '铁矿石', JM0: '焦煤', J0: '焦炭', P0: '棕榈油', LH0: '生猪',
  JD0: '鸡蛋', L0: '塑料', PP0: '聚丙烯', EB0: '苯乙烯', PG0: '液化气', AP0: '苹果',
  SA0: '纯碱', FG0: '玻璃', TA0: 'PTA', EG0: '乙二醇', MA0: '甲醇', RM0: '菜粕',
  CJ0: '红枣', SF0: '硅铁', SM0: '锰硅', PF0: '短纤', PX0: '对二甲苯', SH0: '烧碱',
  IM0: '中证1000', SI0: '工业硅', LC0: '碳酸锂',
  SN0: '锡', SS0: '不锈钢', RU0: '橡胶', RB0: '螺纹钢', WR0: '线材', PB0: '铅', NR0: '20号胶',
  IF0: '沪深300', IH0: '上证50', IC0: '中证500', AU0: '黄金', CF0: '棉花', A0: '豆一',
  M0: '豆粕', UR0: '尿素',
  T0: '10年国债', TF0: '5年国债', TS0: '2年国债', TL0: '30年国债',
  SR0: '白糖', C0: '玉米', CS0: '淀粉', B0: '豆二', V0: 'PVC', OI0: '菜油',
  PK0: '花生', CY0: '棉纱', ZC0: '动力煤', RR0: '粳米', WH0: '强麦',
};

function tag(code: string): string {
  if (BONDS.has(code)) return '国债';
  if (EXCLUDED1.has(code)) return '剔1';
  if (EXCLUDED2.has(code)) return '剔2';
  if (WHITELIST.has(code)) return '白名单';
  return '其他';
}

async function runOne(code: string) {
  const r = await runBacktest({
    dataDir: DATA_DIR,
    codes: [code],
    ...APP_CFG,
  });
  const s = r.summary;
  const ret = (s.finalEquity - 500000) / 500000 * 100;
  const maxDd = (s.maxDrawdown ?? 0) * 100;
  return {
    code,
    trades: s.totalTrades,
    winRate: (s.winRate ?? 0) * 100,
    avgRR: s.avgRR ?? 0,
    ret,
    pf: s.profitFactor ?? 0,
    maxDd,
    sharpe: s.sharpeRatio ?? 0,
    retPerDd: maxDd > 0 ? ret / maxDd : 0,
  };
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    console.error(`数据目录不存在: ${DATA_DIR}`);
    process.exit(1);
  }
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.replace('.json', ''));
  console.log(`共 ${files.length} 个品种有数据，按App最新逻辑回测`);
  console.log('');

  const results: Awaited<ReturnType<typeof runOne>>[] = [];
  for (const code of files) {
    try {
      const res = await runOne(code);
      results.push(res);
      console.log(`✅ ${code}: ${res.trades}笔 胜率${res.winRate.toFixed(1)}% R:R=${res.avgRR.toFixed(2)} 收益${res.ret.toFixed(1)}% PF=${res.pf.toFixed(2)} 回撤${res.maxDd.toFixed(1)}% 夏普${res.sharpe.toFixed(2)}`);
    } catch (e) {
      console.log(`❌ ${code}: ${(e as Error).message}`);
    }
  }

  // 按收益率排序
  const sorted = [...results].sort((a, b) => b.ret - a.ret);

  console.log('');
  console.log('========== 全品种收益排名（按收益率降序） ==========');
  console.log('排名  品种   分类    交易数  胜率   盈亏比  收益率    PF    回撤   夏普   收益/回撤');
  sorted.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}   ${r.code.padEnd(4)} ${tag(r.code).padEnd(4)}  ${String(r.trades).padStart(5)}  ${r.winRate.toFixed(1).padStart(5)}%  ${r.avgRR.toFixed(2).padStart(5)}  ${r.ret.toFixed(1).padStart(7)}%  ${r.pf.toFixed(2).padStart(5)}  ${r.maxDd.toFixed(1).padStart(5)}%  ${r.sharpe.toFixed(2).padStart(5)}  ${r.retPerDd.toFixed(2).padStart(6)}`
    );
  });

  // 统计
  const positive = sorted.filter((r) => r.ret > 0).length;
  const negative = sorted.length - positive;
  console.log('');
  console.log(`盈利品种: ${positive} / ${sorted.length}, 亏损品种: ${negative}`);

  // 被剔除品种表现（重点）
  console.log('');
  console.log('===== 被剔除品种在新逻辑下的表现（重点） =====');
  const excluded = sorted.filter((r) => EXCLUDED1.has(r.code) || EXCLUDED2.has(r.code) || BONDS.has(r.code));
  excluded.forEach((r, i) => {
    const why = EXCLUDED1.has(r.code) ? '30min大样本亏损' : EXCLUDED2.has(r.code) ? 'OOS样本外失败' : '国债';
    console.log(`${r.code.padEnd(4)} ${NAME_MAP[r.code]?.padEnd(6) || ''} 收益${r.ret.toFixed(1).padStart(8)}%  胜率${r.winRate.toFixed(1)}%  R:R=${r.avgRR.toFixed(2)}  PF=${r.pf.toFixed(2)}  回撤${r.maxDd.toFixed(1)}%  (原剔除原因: ${why})`);
  });

  console.log('');
  console.log('===== TOP 15 品种 =====');
  sorted.slice(0, 15).forEach((r, i) => console.log(`${i + 1}. ${r.code} ${NAME_MAP[r.code] || ''} [${tag(r.code)}]: 收益${r.ret.toFixed(1)}% PF=${r.pf.toFixed(2)} 回撤${r.maxDd.toFixed(1)}% 胜率${r.winRate.toFixed(1)}% R:R=${r.avgRR.toFixed(2)}`));

  console.log('');
  console.log('===== 收益为负或极低的品种 =====');
  sorted.filter((r) => r.ret < 30).forEach((r, i) => console.log(`${i + 1}. ${r.code} ${NAME_MAP[r.code] || ''} [${tag(r.code)}]: 收益${r.ret.toFixed(1)}% PF=${r.pf.toFixed(2)} 胜率${r.winRate.toFixed(1)}% R:R=${r.avgRR.toFixed(2)}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
