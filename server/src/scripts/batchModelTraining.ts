import { trainModels } from '../services/modelTraining';
import { recordModelVersion } from '../services/modelVersionManager';
import { waitForDbInit } from '../services/database';

const NEW_VARIETIES = [
  { code: 'MA0', name: '甲醇' },
  { code: 'EG0', name: '乙二醇' },
  { code: 'EB0', name: '苯乙烯' },
  { code: 'C0', name: '玉米' },
  { code: 'JD0', name: '鸡蛋' },
  { code: 'RM0', name: '菜粕' },
  { code: 'CJ0', name: '红枣' },
  { code: 'OI0', name: '菜油' },
  { code: 'FG0', name: '玻璃' },
  { code: 'SA0', name: '纯碱' },
];

async function main() {
  console.log('=== 批量训练新品种模型 ===\n');
  
  // 初始化数据库
  await waitForDbInit();
  console.log('数据库已初始化\n');
  
  // 训练全局模型
  console.log('训练全局模型...');
  const performance = trainModels();
  console.log(`  准确率：${(performance.accuracy * 100).toFixed(1)}%`);
  console.log(`  F1 分数：${performance.f1Score.toFixed(3)}`);
  
  // 记录模型版本
  await recordModelVersion({
    version: `global_v2_${NEW_VARIETIES.length}varieties`,
    accuracy: performance.accuracy,
    precision_score: performance.precision,
    recall_score: performance.recall,
    f1_score: performance.f1Score,
    training_samples: 0, // 由 trainModels 内部处理
    varieties_count: 26 + NEW_VARIETIES.length,
    notes: `全局模型，包含 ${NEW_VARIETIES.length} 个新品种`,
  });
  
  console.log('\n=== 训练完成 ===');
  console.log(`新品种数量：${NEW_VARIETIES.length}`);
  console.log('模型已记录到数据库');
}

main().catch(console.error);
