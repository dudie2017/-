/**
 * 数据格式契约测试
 *
 * 目的：锁定回测数据文件的字段格式，防止"格式漂移"类 bug 重演。
 *
 * 历史背景：
 * 1. triggerBacktest 曾生成 { params/results } 格式，而全系统读取的是 { recipe/stats }，导致数据读不到。
 * 2. runGeneric_1000Experiments.ts 曾输出 { top5 }，而消费端 /backtest/varieties 读取的是 { topComposite/topPnl }。
 *
 * 本测试通过断言真实数据文件的字段契约，确保任何改动一旦偏离标准格式就会立刻失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { listBacktestCodes, VARIETIES, GROUP_NAMES } from '../services/varieties';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../data');

/** 读取某个品种的回测数据文件 */
function loadBacktestData(code: string) {
  const file = path.join(DATA_DIR, `${code}_1000Experiments.json`);
  assert.ok(fs.existsSync(file), `${code} 的回测文件不存在: ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

test('回测数据文件遵循 recipe/stats 契约（防格式漂移）', () => {
  const codes = listBacktestCodes();
  assert.ok(codes.length > 0, '应至少存在一个回测数据文件');

  // 抽样首/中/尾三个品种，验证完整字段契约
  const samples = [codes[0], codes[Math.floor(codes.length / 2)], codes[codes.length - 1]];
  const uniqueSamples = [...new Set(samples)];

  for (const code of uniqueSamples) {
    const data = loadBacktestData(code);

    // 顶层契约
    assert.ok(data.meta, `${code}: 缺少 meta`);
    assert.ok(data.baseline, `${code}: 缺少 baseline`);
    assert.ok(Array.isArray(data.fullResults), `${code}: fullResults 应为数组`);
    assert.ok(data.fullResults.length > 0, `${code}: fullResults 不应为空`);
    assert.ok(Array.isArray(data.topComposite), `${code}: 缺少 topComposite`);

    // 关键契约：baseline 使用 recipe/stats，而非 params/results
    assert.ok(data.baseline.recipe, `${code}: baseline 缺少 recipe`);
    assert.ok(data.baseline.stats, `${code}: baseline 缺少 stats`);
    assert.equal(data.baseline.params, undefined, `${code}: baseline 出现非法字段 params（应为 recipe）`);
    assert.equal(data.baseline.results, undefined, `${code}: baseline 出现非法字段 results（应为 stats）`);

    // 关键契约：fullResults 每项使用 recipe/stats
    const first = data.fullResults[0];
    assert.ok(first.recipe, `${code}: fullResults[0] 缺少 recipe`);
    assert.ok(first.stats, `${code}: fullResults[0] 缺少 stats`);
    assert.equal(first.params, undefined, `${code}: fullResults[0] 出现非法字段 params（应为 recipe）`);
    assert.equal(first.results, undefined, `${code}: fullResults[0] 出现非法字段 results（应为 stats）`);
  }
});

test('VARIETIES 与 GROUP_NAMES 覆盖所有已回测品种', () => {
  const codes = listBacktestCodes();
  assert.ok(codes.length > 0, '应至少存在一个回测数据文件');

  const missingName = codes.filter((c) => !VARIETIES[c]);
  const missingGroup = codes.filter((c) => !GROUP_NAMES[c]);

  assert.deepEqual(missingName, [], `以下品种缺少中文名映射: ${missingName.join(', ')}`);
  assert.deepEqual(missingGroup, [], `以下品种缺少分组映射: ${missingGroup.join(', ')}`);
});

test('stats 字段满足特征工程依赖', () => {
  const codes = listBacktestCodes();
  assert.ok(codes.length > 0);
  const data = loadBacktestData(codes[0]);
  const stats = data.fullResults[0].stats;

  // featureEngineering.extractFeatures 依赖这些统计字段（来自 stats，而非 results）
  for (const field of ['totalTrades', 'winRate', 'totalPnl', 'maxDrawdown', 'profitFactor', 'capture']) {
    assert.equal(
      typeof stats[field],
      'number',
      `${codes[0]}: stats.${field} 应为 number，实际为 ${typeof stats[field]}`,
    );
  }
});
