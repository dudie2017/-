/**
 * APP 全板块审计测试
 * 对每个板块的核心 GET 接口进行 100 次调用，统计成功率、响应时间、错误率
 * 运行：npx tsx src/scripts/auditApp.ts
 */

const BASE = 'http://localhost:9091/api/v1';
const TIMES = 100;
const TIMEOUT_MS = 30000;

// 板块 → 核心接口清单（GET，无副作用）
const BOARDS: Array<{ name: string; path: string }> = [
  { name: '健康检查', path: '/health' },
  { name: '雷达扫描', path: '/scan' },
  { name: '扫描分组', path: '/scan/groups' },
  { name: '扫描摘要', path: '/scan/summary' },
  { name: '扫描绩效', path: '/scan/varieties/performance' },
  { name: '品种列表', path: '/variety' },
  { name: '深度分析品种', path: '/analyzer/varieties' },
  { name: '多品种对比报告', path: '/backtest/multi-report' },
  { name: '品种回测列表', path: '/backtest/varieties' },
  { name: '品种扩展状态', path: '/variety-expansion/status' },
  { name: '优化分级', path: '/optimization/grades' },
  { name: '组合分析', path: '/portfolio/analysis' },
  { name: '组合配置', path: '/portfolio/configurations' },
  { name: '组合策略', path: '/portfolio/strategies' },
  { name: '组合风险', path: '/portfolio-risk/' },
  { name: '模拟交易绩效', path: '/paper-trading/performance' },
  { name: '模拟交易对比', path: '/paper-trading/comparison' },
  { name: '模拟交易记录', path: '/sim-trades' },
  { name: '信号日报日期', path: '/journal/dates' },
  { name: '预警', path: '/alerts/' },
  { name: '监控预警', path: '/monitor/alerts' },
  { name: '监控持仓', path: '/monitor/positions' },
  { name: '新闻最新', path: '/news/latest' },
  { name: '事件日报', path: '/event-daily/events' },
  { name: '事件监控', path: '/event-monitor/daily' },
  { name: '资金流向', path: '/capital-flow/ranking' },
  { name: '供需分析', path: '/supply-demand/' },
  { name: '现货价格', path: '/spot-price/' },
  { name: '飞书库存', path: '/feishu/inventory' },
  { name: '飞书现货', path: '/feishu/spot-price' },
  { name: '策略优化', path: '/strategy-optimization/parameter-analysis' },
  { name: 'ML优化', path: '/ml-optimization/recommendations' },
  { name: '模型监控', path: '/model-monitoring/versions' },
  { name: '训练品种', path: '/training/varieties' },
  { name: 'Tushare状态', path: '/tushare/status' },
  { name: 'AKShare状态', path: '/akshare/status' },
  { name: '外部数据状态', path: '/external/status' },
  { name: '技术分析', path: '/technical/CU0' },
  { name: '历史分析', path: '/history/analysis/CU0' },
  { name: '交易账户', path: '/trading/simulated/account' },
  { name: '深度分析摘要', path: '/analyzer/summary' },
  { name: '优化组合', path: '/optimization/portfolio' },
];

interface BoardResult {
  name: string;
  path: string;
  total: number;
  success: number;
  fail: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
  minMs: number;
  statusCodes: Record<number, number>;
  errors: string[];
}

async function fetchOnce(path: string): Promise<{ status: number; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(`${BASE}${path}`, { signal: controller.signal });
    clearTimeout(t);
    const ms = Date.now() - start;
    return { status: res.status, ms };
  } catch (e: any) {
    return { status: 0, ms: Date.now() - start, error: e?.message || String(e) };
  }
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}

async function testBoard(board: { name: string; path: string }): Promise<BoardResult> {
  const times: number[] = [];
  const statusCodes: Record<number, number> = {};
  const errors: string[] = [];
  let success = 0;
  let fail = 0;

  for (let i = 0; i < TIMES; i++) {
    const r = await fetchOnce(board.path);
    times.push(r.ms);
    statusCodes[r.status] = (statusCodes[r.status] || 0) + 1;
    if (r.status >= 200 && r.status < 400) {
      success++;
    } else {
      fail++;
      if (r.error && errors.length < 5) {
        errors.push(r.error);
      } else if (!r.error && r.status !== 0 && errors.length < 5) {
        errors.push(`HTTP ${r.status}`);
      }
    }
  }

  const sorted = [...times].sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;

  return {
    name: board.name,
    path: board.path,
    total: TIMES,
    success,
    fail,
    avgMs: Math.round(avg),
    p50Ms: pct(sorted, 0.5),
    p95Ms: pct(sorted, 0.95),
    maxMs: sorted[sorted.length - 1] || 0,
    minMs: sorted[0] || 0,
    statusCodes,
    errors,
  };
}

function fmtRow(r: BoardResult): string {
  const status = Object.entries(r.statusCodes)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
  const err = r.errors.length ? ` | 错误: ${r.errors.join('; ')}` : '';
  return (
    `${r.name.padEnd(14)} ${r.path.padEnd(34)} ` +
    `成功 ${String(r.success).padStart(3)}/${r.total} ` +
    `失败 ${String(r.fail).padStart(2)} ` +
    `均 ${String(r.avgMs).padStart(5)}ms p50 ${String(r.p50Ms).padStart(5)}ms p95 ${String(r.p95Ms).padStart(5)}ms max ${String(r.maxMs).padStart(6)}ms ` +
    `[${status}]${err}`
  );
}

async function main() {
  console.log('================================================================');
  console.log(`APP 全板块审计测试 | 每板块 ${TIMES} 次 | 超时 ${TIMEOUT_MS / 1000}s`);
  console.log('================================================================');
  const results: BoardResult[] = [];
  for (const b of BOARDS) {
    process.stdout.write(`测试中: ${b.name} (${b.path}) ... `);
    const r = await testBoard(b);
    results.push(r);
    console.log(`完成 成功率 ${((r.success / r.total) * 100).toFixed(1)}% 均 ${r.avgMs}ms`);
  }

  console.log('\n================================================================');
  console.log('审计结果明细');
  console.log('================================================================');
  for (const r of results) {
    console.log(fmtRow(r));
  }

  // 汇总
  const failBoards = results.filter((r) => r.fail > 0);
  const slowBoards = results.filter((r) => r.avgMs > 2000);
  const badBoards = results.filter((r) => r.success < r.total);
  console.log('\n================================================================');
  console.log('审计汇总');
  console.log('================================================================');
  console.log(`板块总数: ${results.length}`);
  console.log(`全部通过(100/100): ${results.length - badBoards.length}`);
  console.log(`有失败: ${badBoards.length} 个`);
  console.log(`慢接口(均>2s): ${slowBoards.length} 个`);
  if (badBoards.length) {
    console.log('\n[需关注] 失败板块:');
    for (const r of badBoards) {
      console.log(`  - ${r.name} (${r.path}): 失败 ${r.fail} 次 ${r.errors.join('; ')}`);
    }
  }
  if (slowBoards.length) {
    console.log('\n[性能提示] 慢接口(均>2s):');
    for (const r of slowBoards) {
      console.log(`  - ${r.name}: 均 ${r.avgMs}ms p95 ${r.p95Ms}ms`);
    }
  }
  console.log('\n审计测试结束。');
}

main().catch((e) => {
  console.error('审计脚本异常:', e);
  process.exit(1);
});
