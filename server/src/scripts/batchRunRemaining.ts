// @ts-nocheck
/**
 * 批量运行剩余品种的 1000 次 LHS 实验
 * 
 * 用法：npx tsx src/scripts/batchRunRemaining.ts [maxExperiments]
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 剩余品种列表（数据存在但实验未运行）
const REMAINING_VARIETIES = [
  'C0',   // 玉米
  'CJ0',  // 红枣
  'EB0',  // 苯乙烯
  'EG0',  // 乙二醇
  'FG0',  // 玻璃
  'JD0',  // 鸡蛋
  'OI0',  // 菜油
  'RM0',  // 菜粕
  'SA0',  // 纯碱
  'SR0',  // 白糖
  'UR0',  // 尿素
];

const MAX_EXPERIMENTS = parseInt(process.argv[2] || '1000', 10);
const SCRIPT_PATH = path.resolve(__dirname, 'runGeneric_1000Experiments.ts');

console.log('=== 批量运行剩余品种 1000 次实验 ===\n');
console.log(`品种数量：${REMAINING_VARIETIES.length}`);
console.log(`实验次数：${MAX_EXPERIMENTS}`);
console.log(`脚本路径：${SCRIPT_PATH}\n`);

let successCount = 0;
let failCount = 0;

for (const code of REMAINING_VARIETIES) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`运行品种：${code}`);
  console.log('='.repeat(60));
  
  try {
    const cmd = `npx tsx "${SCRIPT_PATH}" "${code}" "${MAX_EXPERIMENTS}"`;
    execSync(cmd, { 
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..')
    });
    successCount++;
    console.log(`\n✅ ${code} 完成`);
  } catch (error) {
    failCount++;
    console.error(`\n❌ ${code} 失败：`, error.message);
  }
}

console.log('\n' + '='.repeat(60));
console.log('批量运行完成');
console.log('='.repeat(60));
console.log(`成功：${successCount}/${REMAINING_VARIETIES.length}`);
console.log(`失败：${failCount}/${REMAINING_VARIETIES.length}`);
