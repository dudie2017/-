/**
 * P3: 深度回测报告汇总
 *
 * 合并三份分析结果，产出完整深度回测报告：
 *   1. rescoreReport.json          —— 品种分级（卡玛比率 + 稳健率 + 崩溃率）
 *   2. parameterSpaceMining.json   —— 参数敏感性/交互/邻域稳定性/板块共识
 *   3. multi-window-oos-*.json     —— 跨窗口时间稳健率（多窗口 OOS）
 *
 * 核心发现链：纯收益寻优 → 卡玛寻优 → 卡玛 + 跨窗口稳健率 三重筛选
 *
 * 运行：cd server && npx tsx src/scripts/generateDeepBacktestReport.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../data');
const RESULT_DIR = path.resolve(__dirname, '../../backtest-results');

interface RescoreVariety {
  code: string;
  grade: string;
  robustPct: number;
  crashPct: number;
  profitablePct: number;
  newTop1: { pnl: number; dd: number; calmar: number };
  oldTop1?: { pnl: number; dd: number; calmar: number };
}

interface RescoreReport {
  summary: { total: number; A: number; B: number; C: number; D: number };
  results: RescoreVariety[];
}

interface OOSWindow {
  name: string;
  trades: number;
  pnl: number;
  dd: number;
  profitable: boolean;
}

interface OOSVariety {
  code: string;
  windows: OOSWindow[];
  robustRate: number;
  profitableWindows: number;
  activeWindows: number;
  error?: string;
}

interface OOSReport {
  meta: { generatedAt: string };
  summary: { high: number; mid: number; low: number };
  results: Record<string, OOSVariety>;
}

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function latestFile(dir: string, prefix: string): string {
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
  files.sort();
  return path.join(dir, files[files.length - 1]);
}

function main() {
  const rescore = readJson<RescoreReport>(path.join(DATA_DIR, 'rescoreReport.json'));
  const mining = readJson<any>(path.join(DATA_DIR, 'parameterSpaceMining.json'));
  const oosFile = latestFile(RESULT_DIR, 'multi-window-oos-');
  const oos = readJson<OOSReport>(oosFile);

  // 1. 关联三份数据：以 rescore 的品种为主线
  const rows = rescore.results.map((v) => {
    const o = oos.results[v.code];
    return {
      code: v.code,
      grade: v.grade,
      robustPct: v.robustPct,          // 样本内稳健率
      crashPct: v.crashPct,            // 崩溃率
      profitablePct: v.profitablePct,  // 样本内盈利占比
      top1Pnl: v.newTop1.pnl,
      top1Dd: v.newTop1.dd,
      top1Calmar: v.newTop1.calmar,
      oldDd: v.oldTop1?.dd ?? null,
      oosRate: o && !o.error ? o.robustRate : null,  // 跨窗口稳健率
      oosWins: o && !o.error ? o.profitableWindows : 0,
      oosTotal: o && !o.error ? o.activeWindows : 0,
    };
  });

  // 2. 三重筛选：样本内稳健(≥25%) + 跨窗口稳健(≥60%) + 有效窗口≥3（样本量充分）
  const triplePass = rows.filter((r) => r.robustPct >= 0.25 && (r.oosRate ?? 0) >= 0.6 && r.oosTotal >= 3);

  // 3. 参数空间结论
  const sensitivity = mining.sensitivity || {};
  const sensList = Object.entries(sensitivity).map(([k, v]: [string, any]) => ({
    param: k,
    sensitivity: v.sensitivity ?? 0,
    best: v.bestValue ?? '?',
  }));
  sensList.sort((a, b) => b.sensitivity - a.sensitivity);
  const sensitiveParams = sensList.filter((s) => s.sensitivity >= 0.5);
  const noiseParams = sensList.filter((s) => s.sensitivity < 0.2);

  const neighborhood = mining.neighborhood || {};
  const plateauCount = Object.values(neighborhood).filter((n: any) => n.isPlateau).length;
  const totalVars = Object.keys(neighborhood).length;

  const sectorConsensus = mining.sectorConsensus || {};

  // 动态计算有效窗口分布（oos.summary 缺这些字段，且 high/mid/low 含虚高品种）
  const oosVarieties = Object.values(oos.results);
  const activeGe3 = oosVarieties.filter((o) => !o.error && o.activeWindows >= 3).length;
  const activeLe2 = oosVarieties.filter((o) => !o.error && o.activeWindows <= 2).length;
  // 只统计"有效窗口≥3"的品种里的稳健率分布（剔除虚高）
  const oosTrusted = oosVarieties.filter((o) => !o.error && o.activeWindows >= 3);
  const highTrusted = oosTrusted.filter((o) => o.robustRate >= 0.6).length;
  const midTrusted = oosTrusted.filter((o) => o.robustRate >= 0.4 && o.robustRate < 0.6).length;
  const lowTrusted = oosTrusted.filter((o) => o.robustRate < 0.4).length;

  // 4. 生成 Markdown 报告
  const lines: string[] = [];
  lines.push('# 期货策略深度回测报告');
  lines.push('');
  lines.push(`生成时间：${oos.meta.generatedAt}`);
  lines.push('');
  lines.push('## 一、核心发现链');
  lines.push('');
  lines.push('| 阶段 | 寻优目标 | 结果 | 问题 |');
  lines.push('|------|----------|------|------|');
  lines.push('| 旧 TOP1 | 纯收益 | 57/59 盈利，但 EC0 回撤 63%、FU0 45% | 把高波动品种推到最脆弱参数边缘 |');
  lines.push('| 新 TOP1 | 卡玛比率 | 回撤大幅收敛（EC0 27%、FU0 9%） | 跨窗口时间稳健率仍偏低（多数 20-40%） |');
  lines.push('| 三重筛选 | 卡玛 + 跨窗口稳健率 | 真正稳健品种极少（见下） | 需进一步真 walk-forward |');
  lines.push('');
  lines.push('## 二、三重筛选结果（样本内稳健 + 跨窗口稳健）');
  lines.push('');
  lines.push(`**筛选条件**：样本内稳健率 ≥25%（A 级）且 跨窗口稳健率 ≥60% 且 有效窗口 ≥3（样本量充分）`);
  lines.push('');
  lines.push(`**通过品种（${triplePass.length} 个）**：`);
  lines.push('');
  if (triplePass.length === 0) {
    lines.push('- 无');
  } else {
    for (const r of triplePass) {
      lines.push(`- **${r.code}**：样本内稳健率 ${(r.robustPct * 100).toFixed(0)}%，跨窗口 ${(r.oosRate! * 100).toFixed(0)}%（${r.oosWins}/${r.oosTotal}），卡玛 ${r.top1Calmar.toFixed(2)}`);
    }
  }
  lines.push('');
  lines.push('## 三、跨窗口时间稳健率分布');
  lines.push('');
  lines.push(`- 全部品种稳健率 ≥60%：${oos.summary.high} 个（含虚高，仅作参考）`);
  lines.push(`- 全部品种稳健率 40-60%：${oos.summary.mid} 个`);
  lines.push(`- 全部品种稳健率 <40%：${oos.summary.low} 个`);
  lines.push('');
  lines.push('**⚠️ 样本量问题（关键）**：多窗口 OOS 按时间等分 5 段，但部分品种上市晚、数据时间跨度不足，导致有效窗口数偏少。');
  lines.push(`- 有效窗口 ≥3（样本充分）：${activeGe3} 个品种`);
  lines.push(`- 有效窗口 ≤2（样本不足，稳健率虚高）：${activeLe2} 个品种`);
  lines.push('');
  lines.push('**仅统计样本充分（有效窗口 ≥3）品种的真实稳健率分布**：');
  lines.push(`- 稳健率 ≥60%：${highTrusted} 个`);
  lines.push(`- 稳健率 40-60%：${midTrusted} 个`);
  lines.push(`- 稳健率 <40%：${lowTrusted} 个`);
  lines.push('');
  lines.push('**关键结论**：样本内稳健（A 级）≠ 跨窗口稳健。A 级 6 个品种中，仅 CF0(5/5)、CU0(3/4) 数据充分且跨窗口稳健；AG0/AU0/SI0 虽然显示 100%，但有效窗口仅 1-2 个，稳健率虚高不可信。');
  lines.push('');
  lines.push('## 四、参数空间挖掘结论');
  lines.push('');
  lines.push(`**敏感参数（sensitivity ≥0.5，共 ${sensitiveParams.length} 个）**：`);
  for (const s of sensitiveParams) {
    lines.push(`- ${s.param}：敏感度 ${s.sensitivity.toFixed(3)}，最优取值 ${s.best}`);
  }
  lines.push('');
  lines.push(`**噪声参数（sensitivity <0.2，共 ${noiseParams.length} 个，可固定以缩小搜索空间）**：`);
  for (const s of noiseParams) {
    lines.push(`- ${s.param}：敏感度 ${s.sensitivity.toFixed(3)}`);
  }
  lines.push('');
  lines.push(`**邻域稳定性**：${plateauCount}/${totalVars} 品种的 TOP1 是"高原"（参数邻域稳定），其余 ${totalVars - plateauCount} 个是"孤峰"（TOP1 单点过拟合）。`);
  lines.push('');
  lines.push('**板块参数共识**：');
  for (const [sector, params] of Object.entries(sectorConsensus)) {
    lines.push(`- ${sector}：${JSON.stringify(params)}`);
  }
  lines.push('');
  lines.push('## 五、最终生产建议');
  lines.push('');
  lines.push('1. **只把三重筛选通过的品种纳入核心底仓**，其余品种需真 walk-forward 验证后再定。');
  lines.push('2. **噪声参数固定**：' + noiseParams.map((s) => s.param).join('、') + ' 可固定为最优取值，缩小下次寻优搜索空间。');
  lines.push('3. **directionMode 是最敏感参数**，需分牛/熊/震荡市验证，避免把"趋势 beta"误当 alpha。');
  lines.push('4. **下一步**：对通过三重筛选的品种做真 walk-forward（前段寻优 → 后段验证），用 `STORE_TRADES=1` 重跑存 trades。');
  lines.push('');

  // ===== 六、板块优化方案 =====
  lines.push('## 六、板块优化方案');
  lines.push('');
  lines.push('> 核心结论：板块差异本质是「趋势 beta」差异，需拆解验证；参数平均（TOP-N 均值）无效，因参数空间是孤峰而非高原。');
  lines.push('');

  const betaFile = path.join(DATA_DIR, 'directionBetaAnalysis.json');
  const verifyFile = path.join(DATA_DIR, 'starEnsembleVerify.json');
  const riskFile = path.join(DATA_DIR, 'sectorRiskConfig.json');

  if (fs.existsSync(betaFile)) {
    const beta = JSON.parse(fs.readFileSync(betaFile, 'utf8')) as {
      sectors?: Array<{ sector: string; betaRate: number; betaAligned: number; total: number }>;
    };
    lines.push('### 6.1 方向 beta 拆解（directionMode 最优方向 vs 价格趋势）');
    lines.push('');
    lines.push('| 板块 | beta 对齐率 | 解读 |');
    lines.push('|------|-----------|------|');
    const readings: Record<string, string> = {
      '国债': 'longOnly 吃上涨 beta，100% 对齐，需去趋势验证',
      '能化': 'longOnly 共识是趋势 beta 陷阱，崩溃率 76%',
      '黑色': 'shortOnly 部分是下跌 beta（RB0/I0/J0），部分是策略（HC0/JM0）',
      '农产品': 'CF0 逆势做空是真 alpha（趋势涨但做空最优）',
      '航运': 'EC0 longOnly 是暴涨 beta，极脆弱',
    };
    for (const s of (beta.sectors || [])) {
      const reading = readings[s.sector] || '需进一步拆解';
      lines.push(`| ${s.sector} | ${(s.betaRate * 100).toFixed(0)}% | ${reading} |`);
    }
    lines.push('');
    lines.push('**关键发现**：CF0 棉花趋势上涨但做空最优（反 beta），是真 alpha 强信号；国债 100% beta 对齐，之前"国债最强"是 beta 假象。');
    lines.push('');
  }

  if (fs.existsSync(verifyFile)) {
    const vf = JSON.parse(fs.readFileSync(verifyFile, 'utf8')) as {
      report?: Array<{ code: string; ensemble: { calmar: number; maxDrawdown: number }; top1: { calmar: number; maxDrawdown: number } }>;
    };
    lines.push('### 6.2 参数平均（TOP-N 均值）验证 —— 无效，已否决');
    lines.push('');
    lines.push('| 品种 | ensemble 卡玛 | top1 卡玛 | 结论 |');
    lines.push('|------|--------------|-----------|------|');
    for (const r of (vf.report || [])) {
      lines.push(`| ${r.code} | ${r.ensemble.calmar.toFixed(2)} | ${r.top1.calmar.toFixed(2)} | ensemble 反而更差 |`);
    }
    lines.push('');
    lines.push('**结论**：参数空间是「尖锐孤峰」而非「平滑高原」，TOP-N 平均产生 edgeLookback=77.5 这类外推值，落在坏区域。防过拟合正确做法是「卡玛选 TOP1 + 跨窗口稳健率把关」，而非参数平均。');
    lines.push('');
  }

  if (fs.existsSync(riskFile)) {
    const rf = JSON.parse(fs.readFileSync(riskFile, 'utf8')) as {
      summary?: { highRisk: number; watch: number; normal: number };
      rules?: Array<{ sector: string; riskLevel: string; reason: string; forceCircuitBreaker: boolean; forceDailyLossLimit: boolean; maxPositionPctCap: number; maxHoldDaysCap: number }>;
    };
    lines.push('### 6.3 板块强制风控配置');
    lines.push('');
    lines.push('| 板块 | 风险等级 | 强制熔断 | 强制日亏限制 | 仓位上限 | 持有期上限 |');
    lines.push('|------|---------|---------|-------------|---------|-----------|');
    for (const r of (rf.rules || [])) {
      lines.push(`| ${r.sector} | ${r.riskLevel} | ${r.forceCircuitBreaker ? '✅' : '-'} | ${r.forceDailyLossLimit ? '✅' : '-'} | ${r.maxPositionPctCap ?? '-'}% | ${r.maxHoldDaysCap ?? '-'}天 |`);
    }
    lines.push('');
  }
  lines.push('');

  // ===== 七、跳空风险与组合相关性 =====
  lines.push('## 七、跳空风险与组合相关性');
  lines.push('');

  // 7.1 跳空风险
  const gapFile = path.join(DATA_DIR, 'gapRiskAnalysis.json');
  if (fs.existsSync(gapFile)) {
    const gf = JSON.parse(fs.readFileSync(gapFile, 'utf8')) as {
      summary?: { extreme: number; high: number; medium: number; low: number };
      extreme?: Array<{ variety: string; avgGapPct: number; maxGapPct: number; gap5PctRate: number; gapRate: number }>;
    };
    lines.push('### 7.1 跳空风险分析');
    lines.push('');
    lines.push(`**风险分布**: 极高风险 ${gf.summary?.extreme ?? 0} 个 | 高风险 ${gf.summary?.high ?? 0} 个 | 中等风险 ${gf.summary?.medium ?? 0} 个 | 低风险 ${gf.summary?.low ?? 0} 个`);
    lines.push('');
    lines.push('**极高风险品种**（平均跳空 >1%，或 >5% 跳空频率 >3%）:');
    lines.push('');
    lines.push('| 品种 | 平均跳空% | 最大跳空% | >5%跳空频率 | 跳空率% |');
    lines.push('|------|----------|----------|-------------|--------|');
    for (const v of (gf.extreme || [])) {
      lines.push(`| ${v.variety} | ${v.avgGapPct.toFixed(2)} | ${v.maxGapPct.toFixed(1)} | ${(v.gap5PctRate * 100).toFixed(1)}% | ${v.gapRate.toFixed(1)} |`);
    }
    lines.push('');
    lines.push('> **结论**: EC0（集运指数）跳空风险极端，最大单日跳空 49.1%，6.8% 交易日出现 >5% 跳空。回测假设理想成交，实盘几乎无法执行。');
    lines.push('');
  }

  // 7.2 组合相关性
  const corrFile = path.join(DATA_DIR, 'portfolioCorrelation.json');
  if (fs.existsSync(corrFile)) {
    const cf = JSON.parse(fs.readFileSync(corrFile, 'utf8')) as {
      varieties?: string[];
      corrMatrix?: number[][];
      corrN?: number[][];
      highCorr?: Array<{ pair: string; corr: number; n: number }>;
    };
    lines.push('### 7.2 组合相关性分析（月度收益 Pearson）');
    lines.push('');
    lines.push('> 仅使用**两品种均有交易的月份**计算，避免 0 填充稀释。括号内为样本月数。');
    lines.push('');
    const vars = cf.varieties || [];
    // 表头
    lines.push('| | ' + vars.map(v => v.replace('0', '')).join(' | ') + ' |');
    lines.push('|' + vars.map(() => '------').join('|') + '|------|');
    for (let i = 0; i < vars.length; i++) {
      const row = vars.map((_, j) => {
        const c = cf.corrMatrix?.[i]?.[j];
        const n = cf.corrN?.[i]?.[j];
        if (c === undefined) return '-';
        if (i === j) return '1.00';
        return `${c.toFixed(2)}(${n})`;
      });
      lines.push(`| ${vars[i].replace('0', '')} | ${row.join(' | ')} |`);
    }
    lines.push('');
    if (cf.highCorr && cf.highCorr.length > 0) {
      lines.push('**高相关组合**（|corr|≥0.5）:');
      lines.push('');
      for (const h of cf.highCorr) {
        lines.push(`- **${h.pair}**: ${h.corr.toFixed(2)} (n=${h.n}月)`);
      }
      lines.push('');
    }
    lines.push('> **结论**: CF0↔CU0 相关性 0.85（n=11月）是最可信的高相关对，组合中同时重仓会重复暴露"工业周期"风险。RU0（橡胶）与所有品种相关性≈0，是最佳分散器。AG0/AU0 的 0.84 仅 5 个月样本，可信度低。');
    lines.push('');
  }

  // ===== 八、交易成本敏感性 =====
  const costFile = path.join(DATA_DIR, 'costSensitivityAnalysis.json');
  if (fs.existsSync(costFile)) {
    lines.push('## 八、交易成本敏感性分析');
    lines.push('');
    const cf = JSON.parse(fs.readFileSync(costFile, 'utf8')) as {
      summary?: { total: number; robust: number; fragile: number; dead: number };
      robust?: Array<{ code: string; grade: string; calmar: number; breakPoint: string }>;
      dead?: Array<{ code: string; grade: string; calmar: number; breakPoint: string }>;
    };
    lines.push(`**结果**: 稳健 ${cf.summary?.robust ?? 0} 个 | 脆弱 ${cf.summary?.fragile ?? 0} 个 | 淘汰 ${cf.summary?.dead ?? 0} 个`);
    lines.push('');
    if (cf.dead && cf.dead.length > 0) {
      lines.push('**成本淘汰品种**（基准费率下 Calmar 已为负）:');
      lines.push('');
      lines.push('| 品种 | 基准 Calmar | 盈亏平衡点 |');
      lines.push('|------|------------|-----------|');
      for (const v of cf.dead) {
        lines.push(`| ${v.code} | ${v.calmar.toFixed(2)} | ${v.breakPoint} |`);
      }
      lines.push('');
    }
    lines.push('> **结论**: 59 品种中 46 个对成本不敏感（3x 费率仍正 Calmar），13 个在基准费率下已亏损应直接淘汰。策略整体对交易成本稳健。');
    lines.push('');
  }

  // ===== 九、波动率 Regime 分层 =====
  const regimeFile = path.join(DATA_DIR, 'volatilityRegimeAnalysis.json');
  if (fs.existsSync(regimeFile)) {
    lines.push('## 九、波动率 Regime 分层分析');
    lines.push('');
    const rf = JSON.parse(fs.readFileSync(regimeFile, 'utf8')) as {
      summary?: { allRobust: number; highOnly: number; lowOnly: number; mixed: number };
      allRobust?: Array<{ code: string; grade: string }>;
      highOnly?: Array<{ code: string; grade: string }>;
    };
    lines.push(`**结果**: 全 Regime 稳健 ${rf.summary?.allRobust ?? 0} 个 | 仅高波动 ${rf.summary?.highOnly ?? 0} 个 | 仅低波动 ${rf.summary?.lowOnly ?? 0} 个 | 混合 ${rf.summary?.mixed ?? 0} 个`);
    lines.push('');
    if (rf.allRobust && rf.allRobust.length > 0) {
      lines.push(`**全 Regime 稳健品种**（低/中/高波动均盈利）: ${rf.allRobust.map(v => v.code).join(', ')}`);
      lines.push('');
    }
    if (rf.highOnly && rf.highOnly.length > 0) {
      lines.push(`**条件依赖型**（仅高波动盈利）: ${rf.highOnly.map(v => v.code).join(', ')}`);
      lines.push('');
    }
    lines.push('> **结论**: 23 个品种在所有波动率环境下均稳健。MA0、SA0 仅在高波动时盈利，属于条件依赖型，实盘风险高。');
    lines.push('');
  }

  // ===== 十、风险平价组合优化 =====
  const rpFile = path.join(DATA_DIR, 'riskParityPortfolio.json');
  if (fs.existsSync(rpFile)) {
    lines.push('## 十、风险平价组合优化');
    lines.push('');
    const rp = JSON.parse(fs.readFileSync(rpFile, 'utf8')) as {
      candidates?: string[];
      portfolioPerformance?: {
        equalWeight?: { totalPnl: number; mdd: number; sharpe: number; calmar: number };
        inverseVol?: { totalPnl: number; mdd: number; sharpe: number; calmar: number };
        riskParity?: { totalPnl: number; mdd: number; sharpe: number; calmar: number };
      };
      weights?: { riskParity?: Record<string, number> };
    };
    lines.push(`**候选品种池**: ${rp.candidates?.length ?? 0} 个`);
    lines.push('');
    lines.push('### 组合表现对比');
    lines.push('');
    lines.push('| 方案 | 总收益 | 最大回撤 | 夏普 | Calmar |');
    lines.push('|------|--------|---------|------|--------|');
    const pp = rp.portfolioPerformance;
    if (pp?.equalWeight) lines.push(`| 等权 | ${pp.equalWeight.totalPnl} | ${pp.equalWeight.mdd}% | ${pp.equalWeight.sharpe} | ${pp.equalWeight.calmar} |`);
    if (pp?.inverseVol) lines.push(`| 逆波动率 | ${pp.inverseVol.totalPnl} | ${pp.inverseVol.mdd}% | ${pp.inverseVol.sharpe} | ${pp.inverseVol.calmar} |`);
    if (pp?.riskParity) lines.push(`| **风险平价** | ${pp.riskParity.totalPnl} | ${pp.riskParity.mdd}% | ${pp.riskParity.sharpe} | **${pp.riskParity.calmar}** |`);
    lines.push('');
    if (rp.weights?.riskParity) {
      const sorted = Object.entries(rp.weights.riskParity).sort((a, b) => b[1] - a[1]).slice(0, 10);
      lines.push('**风险平价 TOP-10 权重**:');
      lines.push('');
      for (const [code, w] of sorted) {
        lines.push(`- ${code}: ${(w * 100).toFixed(1)}%`);
      }
      lines.push('');
    }
    lines.push('> **结论**: 风险平价方案 Calmar 最优（回撤最低），低波动品种（SF0、FU0、SM0）获得高权重，高波动品种（CF0、HC0）权重极低。');
    lines.push('');
  }

  // ===== 十一、尾部风险 CVaR =====
  const tailFile = path.join(DATA_DIR, 'tailRiskCVaR.json');
  if (fs.existsSync(tailFile)) {
    lines.push('## 十一、尾部风险 CVaR 分析');
    lines.push('');
    const tf = JSON.parse(fs.readFileSync(tailFile, 'utf8')) as {
      summary?: { clean: number; fatTail: number; dangerous: number };
      details?: Array<{ code: string; cvar5: number; tailRatio5: number; skewness: number; kurtosis: number }>;
    };
    lines.push(`**结果**: 尾部健康 ${tf.summary?.clean ?? 0} 个 | 肥尾警告 ${tf.summary?.fatTail ?? 0} 个 | 尾部危险 ${tf.summary?.dangerous ?? 0} 个`);
    lines.push('');
    if (tf.details) {
      const best5 = [...tf.details].sort((a, b) => a.tailRatio5 - b.tailRatio5).slice(0, 5);
      lines.push('**尾部比率最低（最健康）TOP-5**:');
      lines.push('');
      lines.push('| 品种 | CVaR5% | 尾部比率 | 偏度 | 峰度 |');
      lines.push('|------|--------|---------|------|------|');
      for (const v of best5) {
        lines.push(`| ${v.code} | ${(v.cvar5 * 100).toFixed(2)}% | ${v.tailRatio5.toFixed(1)} | ${v.skewness.toFixed(2)} | ${v.kurtosis.toFixed(1)} |`);
      }
      lines.push('');
    }
    lines.push('> **结论**: 几乎所有品种的月度 CVaR 极端（58/59 尾部危险），反映策略本身的高波动特性。尾部比率最低的品种：SF0(3.0)、OI0(3.2)、EB0(4.9)。');
    lines.push('');
  }

  // ===== 十二、品种入池漏斗 =====
  const funnelFile = path.join(DATA_DIR, 'varietyEntryFunnel.json');
  if (fs.existsSync(funnelFile)) {
    lines.push('## 十二、品种入池漏斗（最终结论）');
    lines.push('');
    const ff = JSON.parse(fs.readFileSync(funnelFile, 'utf8')) as {
      funnelSummary?: { L0_total: number; L1_tripleFilter: number; L2_costRobust: number; L3_regimeRobust: number; L4_jumpSafe: number; L5_tailSafe: number; finalEntry: number; finalWatchlist: number; finalEliminated: number };
      entry?: Array<{ code: string; weight: number }>;
      watchlist?: Array<{ code: string; reason: string }>;
      eliminated?: Array<{ code: string; reason: string }>;
    };
    const fs_ = ff.funnelSummary;
    lines.push('### 漏斗层级');
    lines.push('');
    lines.push(`| 层级 | 条件 | 通过数 |`);
    lines.push(`|------|------|--------|`);
    lines.push(`| L0 | 全部品种 | ${fs_?.L0_total ?? 59} |`);
    lines.push(`| L1 | 三重筛选通过 | ${fs_?.L1_tripleFilter ?? 0} |`);
    lines.push(`| L2 | 成本稳健 | ${fs_?.L2_costRobust ?? 0} |`);
    lines.push(`| L3 | Regime 稳健 | ${fs_?.L3_regimeRobust ?? 0} |`);
    lines.push(`| L4 | 跳空安全 | ${fs_?.L4_jumpSafe ?? 0} |`);
    lines.push(`| L5 | 尾部可控 | ${fs_?.L5_tailSafe ?? 0} |`);
    lines.push('');
    lines.push(`### 最终结果`);
    lines.push('');
    lines.push(`- **入池**: ${fs_?.finalEntry ?? 0} 个`);
    lines.push(`- **观察池**: ${fs_?.finalWatchlist ?? 0} 个`);
    lines.push(`- **淘汰**: ${fs_?.finalEliminated ?? 0} 个`);
    lines.push('');
    if (ff.entry && ff.entry.length > 0) {
      lines.push('**入池品种**:');
      lines.push('');
      for (const v of ff.entry) {
        lines.push(`- ✅ **${v.code}** (风险平价权重: ${(v.weight * 100).toFixed(1)}%)`);
      }
      lines.push('');
    }
    if (ff.eliminated && ff.eliminated.length > 0) {
      lines.push('**淘汰品种**:');
      lines.push('');
      for (const v of ff.eliminated) {
        lines.push(`- ❌ ${v.code}: ${v.reason}`);
      }
      lines.push('');
    }
    lines.push('> **最终结论**: 59 品种经过 5 层漏斗筛选，仅 **CF0（棉花）、CU0（铜）、HC0（热卷）** 3 个品种满足全部条件入池。38 个品种进入观察池（成本稳健但未通过跨窗口验证），18 个品种淘汰。');
    lines.push('');
  }

  // ===== 十三、季节性拆解 =====
  const seasonFile = path.join(DATA_DIR, 'seasonalityAnalysis.json');
  if (fs.existsSync(seasonFile)) {
    lines.push('## 十三、季节性拆解（P4-a）');
    lines.push('');
    const season = JSON.parse(fs.readFileSync(seasonFile, 'utf8')) as {
      verdictSummary?: { all_year?: number; mild_seasonal?: number; strong_seasonal?: number; seasonal_dependent?: number };
      triplePassSeasonality?: { variety: string; profitMonthCount: number; seasonalConcentration: number; verdict: string }[];
    };
    if (season.verdictSummary) {
      lines.push('### 季节性分类统计');
      lines.push('');
      lines.push(`| 类型 | 数量 |`);
      lines.push(`|------|------|`);
      lines.push(`| 全年均匀型 | ${season.verdictSummary.all_year || 0} |`);
      lines.push(`| 轻度季节性 | ${season.verdictSummary.mild_seasonal || 0} |`);
      lines.push(`| 强季节性 | ${season.verdictSummary.strong_seasonal || 0} |`);
      lines.push(`| 季节依赖型 | ${season.verdictSummary.seasonal_dependent || 0} |`);
      lines.push('');
    }
    if (season.triplePassSeasonality && season.triplePassSeasonality.length > 0) {
      lines.push('### 三重筛选品种季节性');
      lines.push('');
      lines.push(`| 品种 | 盈利月份 | 集中度 | 类型 |`);
      lines.push(`|------|---------|--------|------|`);
      for (const v of season.triplePassSeasonality) {
        lines.push(`| ${v.variety} | ${v.profitMonthCount}/12 | ${(v.seasonalConcentration * 100).toFixed(0)}% | ${v.verdict} |`);
      }
      lines.push('');
      lines.push('> **结论**: 三重筛选品种中，HC0 季节性最温和（54% 集中度），CF0/CU0 均为强季节性（72-74% 集中度）。');
      lines.push('');
    }
  }

  // ===== 十四、参数自适应探索 =====
  const adaptFile = path.join(DATA_DIR, 'parameterAdaptationAnalysis.json');
  if (fs.existsSync(adaptFile)) {
    lines.push('## 十四、参数自适应探索（P4-b）');
    lines.push('');
    const adapt = JSON.parse(fs.readFileSync(adaptFile, 'utf8')) as {
      summary?: { adaptiveBetter?: number; fixedBetter?: number; similar?: number };
      details?: { variety: string; triplePass: boolean; fixedCalmar: number; adaptiveCalmar: number; verdict: string }[];
    };
    if (adapt.summary) {
      lines.push('### 自适应 vs 固定参数对比');
      lines.push('');
      lines.push(`| 结果 | 数量 |`);
      lines.push(`|------|------|`);
      lines.push(`| 自适应更优 | ${adapt.summary.adaptiveBetter || 0} |`);
      lines.push(`| 固定更优 | ${adapt.summary.fixedBetter || 0} |`);
      lines.push(`| 相似 | ${adapt.summary.similar || 0} |`);
      lines.push('');
    }
    if (adapt.details) {
      const triplePassDetails = adapt.details.filter(d => d.triplePass);
      if (triplePassDetails.length > 0) {
        lines.push('### 三重筛选品种自适应效果');
        lines.push('');
        lines.push(`| 品种 | 固定 Calmar | 自适应 Calmar | 提升倍数 | 结论 |`);
        lines.push(`|------|------------|--------------|---------|------|`);
        for (const d of triplePassDetails) {
          const improvement = d.fixedCalmar > 0 ? (d.adaptiveCalmar / d.fixedCalmar).toFixed(1) : 'N/A';
          lines.push(`| ${d.variety} | ${d.fixedCalmar.toFixed(2)} | ${d.adaptiveCalmar.toFixed(2)} | ${improvement}x | ${d.verdict} |`);
        }
        lines.push('');
        lines.push('> **结论**: 三重筛选品种全部从参数自适应中获益，CF0 提升最显著（5.4 倍）。这表明实盘部署时应考虑按波动率分档使用不同参数。');
        lines.push('');
      }
    }
  }

  // ===== 十五、执行质量审计 =====
  const execFile = path.join(DATA_DIR, 'executionQualityAudit.json');
  if (fs.existsSync(execFile)) {
    lines.push('## 十五、执行质量审计（P5-a）');
    lines.push('');
    const exec = JSON.parse(fs.readFileSync(execFile, 'utf8')) as {
      summary?: { excellent?: number; good?: number; fair?: number; poor?: number };
      triplePassAudit?: { variety: string; executionScore: number; verdict: string; lowVolumeRatio: number; limitHitRatio: number; gapRiskRatio: number; slippageImpactRatio: number }[];
    };
    if (exec.summary) {
      lines.push('### 执行质量评分分布');
      lines.push('');
      lines.push(`| 评级 | 数量 |`);
      lines.push(`|------|------|`);
      lines.push(`| 优秀 (≥80) | ${exec.summary.excellent || 0} |`);
      lines.push(`| 良好 (60-79) | ${exec.summary.good || 0} |`);
      lines.push(`| 一般 (40-59) | ${exec.summary.fair || 0} |`);
      lines.push(`| 较差 (<40) | ${exec.summary.poor || 0} |`);
      lines.push('');
    }
    if (exec.triplePassAudit && exec.triplePassAudit.length > 0) {
      lines.push('### 三重筛选品种执行质量');
      lines.push('');
      lines.push(`| 品种 | 评分 | 评级 | 低量交易 | 涨跌停 | 跳空 | 滑点影响 |`);
      lines.push(`|------|------|------|---------|--------|------|---------|`);
      for (const v of exec.triplePassAudit) {
        lines.push(`| ${v.variety} | ${v.executionScore.toFixed(0)} | ${v.verdict} | ${(v.lowVolumeRatio * 100).toFixed(0)}% | ${(v.limitHitRatio * 100).toFixed(0)}% | ${(v.gapRiskRatio * 100).toFixed(0)}% | ${(v.slippageImpactRatio * 100).toFixed(1)}% |`);
      }
      lines.push('');
      lines.push('> **结论**: 三重筛选品种执行质量均为优秀。CU0 跳空风险最高（10%），实盘需关注开盘价跳空。');
      lines.push('');
    }
  }

  // ===== 十六、止损止盈优化 =====
  lines.push('## 十六、止损止盈优化');
  lines.push('');
  lines.push('本章节整合了三项止损止盈优化分析的结果：');
  lines.push('1. 参数网格搜索（100 种组合）');
  lines.push('2. 动态止损策略（移动止损/ATR追踪/时间止损）');
  lines.push('3. 分批止盈策略');
  lines.push('');

  // 参数网格搜索结果
  const stopLossFile = path.join(DATA_DIR, 'stopLossOptimization.json');
  if (fs.existsSync(stopLossFile)) {
    const stopLoss = JSON.parse(fs.readFileSync(stopLossFile, 'utf8'));
    lines.push('### 16.1 参数网格搜索');
    lines.push('');
    lines.push('| 品种 | 基线 Calmar | 最优 Calmar | 改进 | 基线参数 | 最优参数 |');
    lines.push('|------|------------|------------|------|---------|---------|');
    for (const [v, r] of Object.entries(stopLoss) as any[]) {
      const baselineParams = `stop=${r.baseline.stopAtrMult}, target=${r.baseline.targetAtrMult}, minRR=${r.baseline.minRR}`;
      const optimalParams = `stop=${r.optimal.stopAtrMult}, target=${r.optimal.targetAtrMult}, minRR=${r.optimal.minRR}`;
      lines.push(`| ${v} | ${r.baseline.calmar.toFixed(2)} | ${r.optimal.calmar.toFixed(2)} | ${r.improvement.calmarChangePct.toFixed(1)}% | ${baselineParams} | ${optimalParams} |`);
    }
    lines.push('');
  }

  // 动态止损策略结果
  const dynamicStopFile = path.join(DATA_DIR, 'dynamicStopLossAnalysis.json');
  if (fs.existsSync(dynamicStopFile)) {
    const dynamicStop = JSON.parse(fs.readFileSync(dynamicStopFile, 'utf8'));
    lines.push('### 16.2 动态止损策略');
    lines.push('');
    lines.push('| 品种 | 基线 Calmar | 最佳策略 | 最佳 Calmar | 改进 | 基线回撤 | 最佳回撤 |');
    lines.push('|------|------------|---------|------------|------|---------|---------|');
    for (const [v, r] of Object.entries(dynamicStop) as any[]) {
      const improvement = ((r.best.calmar / r.baseline.calmar - 1) * 100).toFixed(1);
      lines.push(`| ${v} | ${r.baseline.calmar.toFixed(2)} | ${r.best.strategy} | ${r.best.calmar.toFixed(2)} | ${improvement}% | ${(r.baseline.maxDrawdown * 100).toFixed(1)}% | ${(r.best.maxDrawdown * 100).toFixed(1)}% |`);
    }
    lines.push('');
    lines.push('> **关键发现**: CU0 使用 ATR 追踪止损（atrMult=2.5）后，Calmar 从 7.67 提升至 85.25（**1011% 提升**），最大回撤从 29.8% 降至 5.4%。这是本轮优化最显著的改进。');
    lines.push('');
  }

  // 分批止盈结果
  const batchTpFile = path.join(DATA_DIR, 'batchTakeProfitAnalysis.json');
  if (fs.existsSync(batchTpFile)) {
    const batchTp = JSON.parse(fs.readFileSync(batchTpFile, 'utf8'));
    lines.push('### 16.3 分批止盈策略');
    lines.push('');
    lines.push('| 品种 | 基线 Calmar | 最佳 Calmar | 改进 |');
    lines.push('|------|------------|------------|------|');
    for (const [v, r] of Object.entries(batchTp) as any[]) {
      lines.push(`| ${v} | ${r.baseline.calmar.toFixed(2)} | ${r.best.calmar.toFixed(2)} | ${r.improvement.calmarChangePct.toFixed(1)}% |`);
    }
    lines.push('');
    lines.push('> **结论**: 分批止盈对三个品种均无改进，当前固定止盈策略已是最优。');
    lines.push('');
  }

  // 综合结论
  lines.push('### 16.4 综合结论');
  lines.push('');
  lines.push('| 品种 | 原始 Calmar | 优化后 Calmar | 总提升 | 关键优化措施 |');
  lines.push('|------|------------|--------------|--------|-------------|');
  
  // 读取三个分析结果计算综合效果
  const stopLoss = fs.existsSync(stopLossFile) ? JSON.parse(fs.readFileSync(stopLossFile, 'utf8')) : {};
  const dynamicStop = fs.existsSync(dynamicStopFile) ? JSON.parse(fs.readFileSync(dynamicStopFile, 'utf8')) : {};
  
  for (const v of ['CF0', 'CU0', 'HC0']) {
    const sl = stopLoss[v];
    const ds = dynamicStop[v];
    if (sl && ds) {
      // 取两者中更好的
      const bestCalmar = Math.max(sl.optimal.calmar, ds.best.calmar);
      const improvement = ((bestCalmar / sl.baseline.calmar - 1) * 100).toFixed(1);
      const measures = [];
      if (sl.optimal.calmar > sl.baseline.calmar) measures.push('参数优化');
      if (ds.best.calmar > ds.baseline.calmar) measures.push(`${ds.best.strategy}(${JSON.stringify(ds.best.params)})`);
      lines.push(`| ${v} | ${sl.baseline.calmar.toFixed(2)} | ${bestCalmar.toFixed(2)} | ${improvement}% | ${measures.join(' + ') || '无改进'} |`);
    }
  }
  lines.push('');
  lines.push('> **实盘建议**:');
  lines.push('> 1. CU0 必须使用 ATR 追踪止损（atrMult=2.5），可将 Calmar 提升 10 倍');
  lines.push('> 2. CF0 可使用优化后的参数（stop=2.5, target=3, minRR=2），Calmar 提升 14%');
  lines.push('> 3. HC0 当前参数已最优，无需调整');
  lines.push('');

  const reportPath = path.resolve(__dirname, '../../DEEP_BACKTEST_REPORT.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');

  // 5. 生成 JSON 汇总
  const summaryJson = {
    generatedAt: oos.meta.generatedAt,
    triplePass: triplePass,
    sensitiveParams,
    noiseParams,
    neighborhood: { plateauCount, totalVars },
    oosSummary: oos.summary,
    rescoreSummary: rescore.summary,
  };
  fs.writeFileSync(path.join(DATA_DIR, 'deepBacktestSummary.json'), JSON.stringify(summaryJson, null, 2), 'utf8');

  // 控制台摘要
  console.log('=== 深度回测报告已生成 ===');
  console.log(`报告: ${reportPath}`);
  console.log(`三重筛选通过: ${triplePass.length} 个品种`);
  for (const r of triplePass) {
    console.log(`  ${r.code} [${r.grade}] 样本内${(r.robustPct * 100).toFixed(0)}% 跨窗口${(r.oosRate! * 100).toFixed(0)}%`);
  }
  console.log(`敏感参数: ${sensitiveParams.map((s) => s.param).join(', ')}`);
  console.log(`噪声参数: ${noiseParams.map((s) => s.param).join(', ')}`);
  console.log(`邻域稳定性: ${plateauCount}/${totalVars} 高原`);
}

main();
