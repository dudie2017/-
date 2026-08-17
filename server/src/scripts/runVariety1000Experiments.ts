// @ts-nocheck
/**
 * 品种 1000 次实验回测脚本（薄封装）
 *
 * 核心逻辑已抽取到 services/varietyBacktestRunner.ts，本文件仅负责 CLI 参数解析与调用。
 *
 * 用法：npx tsx src/scripts/runVariety1000Experiments.ts <品种代码>
 * 示例：npx tsx src/scripts/runVariety1000Experiments.ts IC0
 */
import { runVariety1000Experiments } from '../services/varietyBacktestRunner';

const CODE = process.argv[2];
if (!CODE) {
  console.error('用法: npx tsx src/scripts/runVariety1000Experiments.ts <品种代码>');
  console.error('示例: npx tsx src/scripts/runVariety1000Experiments.ts IC0');
  process.exit(1);
}

runVariety1000Experiments(CODE)
  .then((outPath) => {
    console.log(`\n完成: ${outPath}`);
    process.exit(0);
  })
  .catch((e) => {
    console.error(`[${CODE} 1000次实验失败]`, e);
    process.exit(1);
  });
