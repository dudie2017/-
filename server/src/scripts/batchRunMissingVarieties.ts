// @ts-nocheck
/**
 * 批量运行缺失品种的 1000 次 LHS 实验（使用修复后的正确脚本）
 *
 * 用法：npx tsx src/scripts/batchRunMissingVarieties.ts <code1> <code2> <code3> ...
 * 示例：npx tsx src/scripts/batchRunMissingVarieties.ts C0 A0 RM0
 *
 * 特性：
 * - 串行执行，每批 3 个品种（由调用方传入）
 * - 自动跳过已有完整结果（>100KB）的品种
 * - 错误隔离，单个品种失败不影响后续品种
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const __dirname = path.dirname(new URL(import.meta.url).pathname);
// __dirname = server/src/scripts，需回到 server 根目录（上两级）
const SERVER_DIR = path.resolve(__dirname, '../..');

const codes = process.argv.slice(2);
if (codes.length === 0) {
  console.error('用法: npx tsx src/scripts/batchRunMissingVarieties.ts <code1> <code2> ...');
  process.exit(1);
}

const SCRIPT_PATH = path.resolve(__dirname, 'runVariety1000Experiments.ts');
const DATA_FILE_SIZE_THRESHOLD = 100_000; // 100KB 以上视为完整结果

console.log('=== 批量运行缺失品种 1000 次 LHS 实验 ===\n');
console.log(`本批品种（${codes.length} 个）：${codes.join(', ')}`);
console.log(`脚本：${SCRIPT_PATH}\n`);

let successCount = 0;
let skipCount = 0;
let failCount = 0;
const failures: string[] = [];

for (const code of codes) {
  const outFile = path.join(SERVER_DIR, 'src/data', `${code}_1000Experiments.json`);

  // 跳过已有完整结果
  if (fs.existsSync(outFile) && fs.statSync(outFile).size > DATA_FILE_SIZE_THRESHOLD) {
    console.log(`\n⏭️  ${code} 已有完整结果（${(fs.statSync(outFile).size / 1024).toFixed(0)}KB），跳过`);
    skipCount++;
    continue;
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`▶️  开始回测：${code}（${new Date().toLocaleString()}）`);
  console.log('='.repeat(70));

  try {
    const cmd = `npx tsx "${SCRIPT_PATH}" "${code}"`;
    execSync(cmd, {
      stdio: 'inherit',
      cwd: SERVER_DIR,
      maxBuffer: 10 * 1024 * 1024,
    });
    successCount++;
    console.log(`\n✅ ${code} 完成（${new Date().toLocaleString()}）`);
  } catch (error: any) {
    failCount++;
    failures.push(code);
    console.error(`\n❌ ${code} 失败：`, error?.message || error);
  }
}

console.log('\n' + '='.repeat(70));
console.log(`本批汇总：成功 ${successCount} | 跳过 ${skipCount} | 失败 ${failCount}`);
if (failures.length > 0) {
  console.log(`失败品种：${failures.join(', ')}`);
}
console.log('='.repeat(70));
