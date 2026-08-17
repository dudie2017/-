/**
 * 定时重训练脚本
 * 定期用最新数据重训练 ML 模型，防止性能衰减
 *
 * 使用方式：
 *   npx tsx src/scripts/scheduledRetrain.ts
 *
 * 建议配置 cron 任务：
 *   每周日凌晨 2 点执行：0 2 * * 0
 */

import { executeRetrain } from '../services/modelTraining';
import {
  recordModelVersion,
  getActiveModelVersion,
  getAllModelVersions,
  activateModelVersion,
  calculatePerformanceDecay,
} from '../services/modelVersionManager';
import { waitForDbInit } from '../services/database';
import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'src/data');
const RETRAIN_THRESHOLD = 0.1; // 性能衰减阈值（10%）

interface RetrainResult {
  success: boolean;
  newVersion: string;
  oldVersion: string | null;
  accuracy: number;
  f1Score: number;
  decay: number;
  message: string;
}

/**
 * 生成版本号（基于时间戳）
 */
function generateVersion(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  return `v${year}${month}${day}_${hour}${minute}`;
}

/**
 * 执行训练并保存模型版本
 * 返回完整训练结果
 */
async function trainAndSaveModel(version: string): Promise<{
  success: boolean;
  message: string;
  accuracy: number;
  precision: number;
  recall: number;
  f1: number;
  samples: number;
  varietiesCount: number;
}> {
  try {
    const performance = await executeRetrain();

    // 统计实验数据样本数和品种数
    const experimentFiles = fs
      .readdirSync(DATA_DIR)
      .filter((f) => f.endsWith('_1000Experiments.json'));

    let samples = 0;
    let varietiesCount = experimentFiles.length;

    for (const file of experimentFiles) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf-8'));
        if (Array.isArray(content)) {
          samples += content.length;
        } else if (content && Array.isArray(content.experiments)) {
          samples += content.experiments.length;
        }
      } catch (e) {
        console.warn(`读取实验数据失败 ${file}:`, e);
      }
    }

    return {
      success: true,
      message: '训练成功',
      accuracy: performance.accuracy,
      precision: performance.precision,
      recall: performance.recall,
      f1: performance.f1Score,
      samples,
      varietiesCount,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
      accuracy: 0,
      precision: 0,
      recall: 0,
      f1: 0,
      samples: 0,
      varietiesCount: 0,
    };
  }
}

/**
 * 执行重训练
 */
async function runScheduledRetrain(): Promise<RetrainResult> {
  console.log('=== 开始定时重训练 ===');
  console.log(`时间：${new Date().toISOString()}`);

  // 1. 获取当前活跃版本
  const currentVersion = await getActiveModelVersion();
  const oldVersion = currentVersion?.version || null;
  console.log(`当前版本：${oldVersion || '无'}`);

  // 2. 检查是否有实验数据
  const experimentFiles = fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('_1000Experiments.json'));

  if (experimentFiles.length === 0) {
    return {
      success: false,
      newVersion: '',
      oldVersion,
      accuracy: 0,
      f1Score: 0,
      decay: 0,
      message: '无实验数据文件',
    };
  }

  console.log(`找到 ${experimentFiles.length} 个实验数据文件`);

  // 3. 执行训练
  const newVersion = generateVersion();
  console.log(`新版本号：${newVersion}`);

  const trainResult = await trainAndSaveModel(newVersion);

  if (!trainResult.success) {
    return {
      success: false,
      newVersion,
      oldVersion,
      accuracy: 0,
      f1Score: 0,
      decay: 0,
      message: `训练失败：${trainResult.message}`,
    };
  }

  // 4. 记录新版本
  const versionRecord = await recordModelVersion({
    version: newVersion,
    accuracy: trainResult.accuracy,
    precision_score: trainResult.precision,
    recall_score: trainResult.recall,
    f1_score: trainResult.f1,
    training_samples: trainResult.samples,
    varieties_count: trainResult.varietiesCount,
    notes: `定时重训练 - ${new Date().toISOString()}`,
  });

  if (!versionRecord) {
    return {
      success: false,
      newVersion,
      oldVersion,
      accuracy: trainResult.accuracy,
      f1Score: trainResult.f1,
      decay: 0,
      message: '记录版本失败',
    };
  }

  // 5. 计算性能衰减
  let decay = 0;
  if (oldVersion) {
    decay = await calculatePerformanceDecay(newVersion, oldVersion);
    console.log(`性能衰减：${(decay * 100).toFixed(2)}%`);
  }

  // 6. 判断是否激活新版本
  const shouldActivate = decay <= RETRAIN_THRESHOLD;

  if (shouldActivate) {
    await activateModelVersion(newVersion);
    console.log(`✅ 新版本已激活：${newVersion}`);
  } else {
    console.log(`⚠️ 性能衰减超过阈值 (${(decay * 100).toFixed(2)}% > ${(RETRAIN_THRESHOLD * 100).toFixed(0)}%)，保留旧版本`);
  }

  return {
    success: true,
    newVersion,
    oldVersion,
    accuracy: trainResult.accuracy,
    f1Score: trainResult.f1,
    decay,
    message: shouldActivate
      ? '训练成功，新版本已激活'
      : '训练成功，但性能衰减超过阈值，保留旧版本',
  };
}

/**
 * 主函数
 */
async function main() {
  try {
    // 等待数据库初始化
    await waitForDbInit();

    const result = await runScheduledRetrain();

    console.log('\n=== 重训练结果 ===');
    console.log(`成功：${result.success}`);
    console.log(`新版本：${result.newVersion}`);
    console.log(`旧版本：${result.oldVersion}`);
    console.log(`准确率：${(result.accuracy * 100).toFixed(2)}%`);
    console.log(`F1 分数：${result.f1Score.toFixed(4)}`);
    console.log(`性能衰减：${(result.decay * 100).toFixed(2)}%`);
    console.log(`消息：${result.message}`);

    if (!result.success) {
      process.exit(1);
    }
  } catch (error) {
    console.error('重训练失败:', error);
    process.exit(1);
  }
}

main();
