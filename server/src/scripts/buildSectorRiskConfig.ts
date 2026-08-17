/**
 * buildSectorRiskConfig.ts
 * 生成板块强制风控配置，输出 sectorRiskConfig.json
 *
 * 核心结论来源（P1 板块优化）：
 * 1. 国债(T0/TF0) 100% beta 对齐（longOnly 吃上涨趋势），需降级观察
 * 2. 能化链/航运 崩溃率高（76%/93%），需强制熔断 + 日亏限制
 * 3. 反 beta 真 alpha 品种（CF0/CU0/AG0/RU0）需重点保留
 */
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src/data');
const OUT = path.join(DATA_DIR, 'sectorRiskConfig.json');

// 板块 -> 品种映射（与 analyzeDirectionBeta / buildSectorPriors 一致）
const SECTOR_MAP: Record<string, string[]> = {
  国债: ['T0', 'TF0'],
  贵金属: ['AG0', 'AU0'],
  黑色: ['HC0', 'RB0', 'I0', 'J0', 'JM0', 'SF0', 'SM0'],
  有色: ['CU0', 'AL0', 'ZN0', 'NI0', 'PB0', 'SS0', 'BC0', 'AO0'],
  能化: ['SC0', 'BU0', 'TA0', 'MA0', 'EG0', 'PP0', 'L0', 'V0', 'FU0', 'LU0', 'EB0', 'PG0', 'PX0', 'UR0', 'RU0', 'NR0', 'SP0', 'WR0', 'FG0'],
  农产品: ['A0', 'M0', 'RM0', 'CF0', 'AP0', 'CJ0', 'JD0', 'LH0', 'P0', 'C0', 'Y0', 'OI0', 'SR0'],
  股指: ['IF0', 'IH0', 'IC0', 'IM0'],
  航运: ['EC0'],
  新材料: ['LC0', 'SI0'],
};

interface SectorRiskRule {
  sector: string;
  codes: string[];
  riskLevel: 'high' | 'medium' | 'watch' | 'normal';
  reason: string;
  // 强制风控约束（下次寻优时应用）
  forceCircuitBreaker?: boolean;
  forceDailyLossLimit?: boolean;
  maxPositionPctCap?: number;
  maxHoldDaysCap?: number;
  note?: string;
}

const rules: SectorRiskRule[] = [
  {
    sector: '能化',
    codes: SECTOR_MAP.能化,
    riskLevel: 'high',
    reason: '崩溃率 76%，样本内稳健率仅 6.1%，longOnly 共识是趋势 beta 陷阱',
    forceCircuitBreaker: true,
    forceDailyLossLimit: true,
    maxPositionPctCap: 10,
    maxHoldDaysCap: 10,
    note: '强制熔断 + 日亏限制，降低仓位并缩短持有期以规避隔夜跳空',
  },
  {
    sector: '航运',
    codes: SECTOR_MAP.航运,
    riskLevel: 'high',
    reason: 'EC0 崩溃率 93%，longOnly 吃暴涨 beta，极脆弱',
    forceCircuitBreaker: true,
    forceDailyLossLimit: true,
    maxPositionPctCap: 5,
    maxHoldDaysCap: 5,
    note: '建议移出生产池，或单独研发跳空不可成交模型',
  },
  {
    sector: '国债',
    codes: SECTOR_MAP.国债,
    riskLevel: 'watch',
    reason: '100% beta 对齐（longOnly 吃上涨趋势），无独立 alpha 证据',
    note: '降级为观察池，做去趋势/beta 对冲验证后再决定',
  },
  {
    sector: '黑色',
    codes: SECTOR_MAP.黑色,
    riskLevel: 'medium',
    reason: 'shortOnly 部分为下跌 beta（RB0/I0/J0），部分为策略选择（HC0/JM0 趋势 neutral）',
    note: 'RB0/I0/J0 需验证 long 侧；HC0 是三重筛选通过的稳健品种，重点保留',
  },
  {
    sector: '有色',
    codes: SECTOR_MAP.有色,
    riskLevel: 'normal',
    reason: 'CU0 用 both 双向（反 beta 真 alpha），是三重筛选通过的稳健品种',
    note: 'CU0 重点保留',
  },
  {
    sector: '农产品',
    codes: SECTOR_MAP.农产品,
    riskLevel: 'normal',
    reason: 'CF0 是反 beta 真 alpha（趋势涨但做空最优），三重筛选通过',
    note: 'CF0 重点保留',
  },
  {
    sector: '贵金属',
    codes: SECTOR_MAP.贵金属,
    riskLevel: 'watch',
    reason: 'AG0 用 both（真 alpha 候选），但有效窗口仅 1.5，样本不足',
    note: '降级观察池，等数据积累',
  },
  {
    sector: '新材料',
    codes: SECTOR_MAP.新材料,
    riskLevel: 'watch',
    reason: 'LC0 卡玛虚高（数据仅 2 年），样本不足',
    note: '降级观察池',
  },
  {
    sector: '股指',
    codes: SECTOR_MAP.股指,
    riskLevel: 'normal',
    reason: 'IM0/IC0 用 split 双向，IF0 部分 beta',
    note: 'IF0 需 beta 验证',
  },
];

const report = {
  generatedAt: new Date().toISOString(),
  summary: {
    highRisk: rules.filter((r) => r.riskLevel === 'high').length,
    watch: rules.filter((r) => r.riskLevel === 'watch').length,
    normal: rules.filter((r) => r.riskLevel === 'normal').length,
  },
  rules,
};

fs.writeFileSync(OUT, JSON.stringify(report, null, 2), 'utf-8');
console.log(`已生成风控配置: ${OUT}`);
console.log(`  高风险板块(强制风控): ${report.summary.highRisk} 个`);
console.log(`  观察池(降级): ${report.summary.watch} 个`);
console.log(`  正常: ${report.summary.normal} 个`);
for (const r of rules) {
  const flags = [
    r.forceCircuitBreaker ? '熔断' : '',
    r.forceDailyLossLimit ? '日亏限制' : '',
    r.maxPositionPctCap ? `仓位≤${r.maxPositionPctCap}%` : '',
    r.maxHoldDaysCap ? `持有≤${r.maxHoldDaysCap}天` : '',
  ].filter(Boolean).join('+');
  console.log(`  [${r.riskLevel}] ${r.sector}: ${flags || r.note || ''}`);
}
