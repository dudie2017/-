/**
 * 全品种 1000 次实验批量运行脚本
 *
 * 依次运行 17 个品种的 1000 次 LHS 实验，每个品种生成独立的 JSON 结果文件。
 *
 * 运行：cd server && npx tsx src/scripts/runAll1000Experiments.ts
 * 输出：src/data/{CODE}_1000Experiments.json（每个品种一个文件）
 */

import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALL_CODES = [
  'SC0', 'JM0', 'RU0', 'M0', 'AG0', 'LH0', 'CU0', 'AU0',
  'RB0', 'I0', 'CF0', 'Y0', 'J0', 'P0', 'TA0', 'AL0', 'SI0'
];

const VARIETY_NAMES: Record<string, string> = {
  SC0: '原油', JM0: '焦煤', RU0: '橡胶', M0: '豆粕', AG0: '白银', LH0: '生猪',
  CU0: '铜', AU0: '黄金', RB0: '螺纹钢', I0: '铁矿石', CF0: '棉花', Y0: '豆油',
  J0: '焦炭', P0: '棕榈油', TA0: 'PTA', AL0: '铝', SI0: '工业硅',
};

function main() {
  console.log('=== 全品种 1000 次实验批量运行 ===\n');
  console.log(`共 ${ALL_CODES.length} 个品种\n`);

  const startTime = Date.now();
  const results: Array<{
    code: string;
    name: string;
    status: 'success' | 'failed';
    duration: number;
    error?: string;
  }> = [];

  for (let i = 0; i < ALL_CODES.length; i++) {
    const code = ALL_CODES[i];
    const name = VARIETY_NAMES[code] || code;
    const scriptPath = path.join(__dirname, `run${code}_1000Experiments.ts`);

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[${i + 1}/${ALL_CODES.length}] ${code} ${name}`);
    console.log(`${'='.repeat(60)}\n`);

    const varietyStart = Date.now();

    try {
      // 运行单个品种的 1000 次实验
      execSync(`npx tsx ${scriptPath}`, {
        stdio: 'inherit',
        cwd: process.cwd(),
      });

      const duration = (Date.now() - varietyStart) / 1000;
      results.push({
        code,
        name,
        status: 'success',
        duration,
      });

      console.log(`\n✅ ${code} ${name} 完成，耗时 ${duration.toFixed(1)}s\n`);
    } catch (error) {
      const duration = (Date.now() - varietyStart) / 1000;
      const errorMsg = error instanceof Error ? error.message : String(error);
      results.push({
        code,
        name,
        status: 'failed',
        duration,
        error: errorMsg,
      });

      console.error(`\n❌ ${code} ${name} 失败，耗时 ${duration.toFixed(1)}s`);
      console.error(`错误: ${errorMsg}\n`);
    }
  }

  // 输出汇总
  const totalDuration = (Date.now() - startTime) / 1000;
  console.log('\n' + '='.repeat(60));
  console.log('批量运行完成汇总');
  console.log('='.repeat(60));
  console.log(`总耗时: ${(totalDuration / 60).toFixed(1)} 分钟\n`);

  const successCount = results.filter(r => r.status === 'success').length;
  const failedCount = results.filter(r => r.status === 'failed').length;

  console.log(`成功: ${successCount}/${ALL_CODES.length}`);
  console.log(`失败: ${failedCount}/${ALL_CODES.length}\n`);

  if (failedCount > 0) {
    console.log('失败品种:');
    results.filter(r => r.status === 'failed').forEach(r => {
      console.log(`  - ${r.code} ${r.name}: ${r.error}`);
    });
  }

  console.log('\n各品种耗时:');
  results.forEach(r => {
    const status = r.status === 'success' ? '✅' : '❌';
    console.log(`  ${status} ${r.code} ${r.name}: ${r.duration.toFixed(1)}s`);
  });

  console.log('\n输出文件位置: server/src/data/{CODE}_1000Experiments.json');
}

main();
