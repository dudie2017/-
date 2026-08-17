/**
 * 批量运行剩余品种的 1000 次 LHS 回测实验
 * 
 * 待回测品种（12 个）：
 * - 能源化工：MA0（甲醇）、EG0（乙二醇）、EB0（苯乙烯）
 * - 农产品：C0（玉米）、JD0（鸡蛋）、RM0（菜粕）
 * - 软商品：CJ0（红枣）、OI0（菜油）
 * - 其他：FG0（玻璃）、SA0（纯碱）、UR0（尿素）、PK0（花生）
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

// 品种配置（合约乘数、baseRecipe 等）
const VARIETY_CONFIG: Record<string, {
  multiplier: number;
  baseRecipe: any;
  note: string;
}> = {
  // 能源化工
  MA0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '甲醇' },
  EG0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '乙二醇' },
  EB0: { multiplier: 5, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '苯乙烯' },
  
  // 农产品
  C0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '玉米' },
  JD0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '鸡蛋' },
  RM0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '菜粕' },
  
  // 软商品
  CJ0: { multiplier: 5, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '红枣' },
  OI0: { multiplier: 10, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '菜油' },
  PK0: { multiplier: 5, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '花生' },
  
  // 其他
  FG0: { multiplier: 20, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '玻璃' },
  SA0: { multiplier: 20, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '纯碱' },
  UR0: { multiplier: 20, baseRecipe: { atrPeriod: 14, holdPeriod: 15, stopAtrMult: 2.0, targetAtrMult: 3.0 }, note: '尿素' },
};

const SCRIPTS_DIR = path.join(process.cwd(), 'src/scripts');
const DATA_DIR = path.join(process.cwd(), 'data-cache-daily-20y');

// 检查品种数据是否存在
function checkDataExists(code: string): boolean {
  const filePath = path.join(DATA_DIR, `${code}.json`);
  return fs.existsSync(filePath);
}

// 运行单个品种的回测
function runVariety(code: string): { success: boolean; message: string } {
  const config = VARIETY_CONFIG[code];
  if (!config) {
    return { success: false, message: '未找到品种配置' };
  }
  
  if (!checkDataExists(code)) {
    return { success: false, message: '数据文件不存在' };
  }
  
  // 检查是否已有回测结果
  const outputFile = path.join(process.cwd(), 'src/data', `${code}_1000Experiments.json`);
  if (fs.existsSync(outputFile)) {
    return { success: false, message: '已存在回测结果，跳过' };
  }
  
  try {
    // 创建临时脚本
    const tempScript = path.join(SCRIPTS_DIR, `run${code}_temp.ts`);
    const scriptContent = `
import { run1000Experiments } from './runGeneric_1000Experiments';

const CODE = '${code}';
const MULTIPLIER = ${config.multiplier};
const BASE_RECIPE = ${JSON.stringify(config.baseRecipe)};

run1000Experiments(CODE, MULTIPLIER, BASE_RECIPE, '${config.note}').catch(console.error);
`;
    fs.writeFileSync(tempScript, scriptContent);
    
    // 执行脚本
    execSync(`npx tsx ${tempScript}`, { 
      cwd: process.cwd(), 
      stdio: 'inherit',
      timeout: 600000 // 10 分钟超时
    });
    
    // 删除临时脚本
    fs.unlinkSync(tempScript);
    
    return { success: true, message: '回测完成' };
  } catch (error: any) {
    return { success: false, message: error.message || '执行失败' };
  }
}

// 主函数
async function main() {
  console.log('=== 批量运行 1000 次 LHS 回测实验 ===\n');
  
  const varieties = Object.keys(VARIETY_CONFIG);
  const results: Array<{ code: string; success: boolean; message: string }> = [];
  
  for (const code of varieties) {
    console.log(`\n[${code}] ${VARIETY_CONFIG[code].note}...`);
    const result = runVariety(code);
    results.push({ code, ...result });
    console.log(`  ${result.message}`);
  }
  
  // 汇总
  console.log('\n=== 回测汇总 ===');
  const successCount = results.filter(r => r.success).length;
  const skipCount = results.filter(r => !r.success && r.message.includes('已存在')).length;
  const failCount = results.filter(r => !r.success && !r.message.includes('已存在')).length;
  
  console.log(`\n总计：${varieties.length} 个品种`);
  console.log(`  ✅ 成功：${successCount}`);
  console.log(`  ⏭️  跳过：${skipCount}`);
  console.log(`  ❌ 失败：${failCount}`);
  
  if (failCount > 0) {
    console.log('\n失败品种:');
    results.filter(r => !r.success && !r.message.includes('已存在')).forEach(r => {
      console.log(`  ${r.code}: ${r.message}`);
    });
  }
}

main().catch(console.error);
