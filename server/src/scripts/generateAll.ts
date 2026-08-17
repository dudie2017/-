/**
 * 一键生成配置建议模块的全部数据：
 *  1. generateFullAnalysis.ts   -> full_analysis.json（含 costImpact）
 *  2. configBacktest.ts         -> config_oos_stats.json（1000 次 bootstrap 样本外）
 *  3. timeSeriesValidation.ts   -> config_time_series.json（时间序列 OOS + 动态再平衡）
 *
 * 运行：pnpm run generate:all
 */
import { spawnSync } from 'node:child_process';

const scripts = [
  'generateFullAnalysis.ts',
  'configBacktest.ts',
  'timeSeriesValidation.ts',
];

for (const script of scripts) {
  console.log(`\n========== 运行 ${script} ==========`);
  const result = spawnSync('node', ['--import', 'tsx', `src/scripts/${script}`], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  if (result.status !== 0) {
    console.error(`❌ ${script} 失败（exit ${result.status ?? '未知'}），终止后续步骤`);
    process.exit(result.status ?? 1);
  }
  console.log(`✅ ${script} 完成`);
}

console.log('\n========== 全部数据生成完成 ==========');
