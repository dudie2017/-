/**
 * 模型版本管理服务
 * 负责模型版本记录、性能监控、回滚机制
 */

import db from './database';

export interface ModelVersion {
  id: number;
  version: string;
  created_at: string;
  accuracy: number;
  precision_score: number;
  recall_score: number;
  f1_score: number;
  training_samples: number;
  varieties_count: number;
  is_active: boolean;
  performance_decay: number;
  rollback_version: string | null;
  notes: string | null;
  model_path: string | null;
}

/**
 * 记录新模型版本
 */
export async function recordModelVersion(params: {
  version: string;
  accuracy: number;
  precision_score: number;
  recall_score: number;
  f1_score: number;
  training_samples: number;
  varieties_count: number;
  notes?: string;
  model_path?: string;
}): Promise<ModelVersion | null> {
  const sql = `
    INSERT INTO ml_model_versions (version, accuracy, precision_score, recall_score, f1_score, training_samples, varieties_count, created_at, notes, is_active, model_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, 1, ?)
  `;
  
  try {
    // 先停用所有旧版本，确保只有一个活跃版本
    db.run(`UPDATE ml_model_versions SET is_active = 0`);
    
    db.run(sql, [
      params.version,
      params.accuracy,
      params.precision_score,
      params.recall_score,
      params.f1_score,
      params.training_samples,
      params.varieties_count,
      params.notes || null,
      params.model_path || null,
    ]);
    // 查询刚插入的行
    const row = db.queryOne(
      'SELECT * FROM ml_model_versions WHERE version = ? ORDER BY created_at DESC LIMIT 1',
      [params.version]
    );
    return row as ModelVersion;
  } catch (error) {
    console.error('Error recording model version:', error);
    return null;
  }
}

/**
 * 获取当前活跃模型版本
 */
export async function getActiveModelVersion(): Promise<ModelVersion | null> {
  const sql = `SELECT * FROM ml_model_versions WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`;
  
  try {
    const result = db.query(sql);
    const rows = result as ModelVersion[];
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting active model version:', error);
    return null;
  }
}

/**
 * 获取当前活跃模型版本（同步版，供模型加载时使用）
 * 注意：底层 sql.js 查询为同步，此处直接同步返回
 */
export function getActiveModelVersionSync(): ModelVersion | null {
  const sql = `SELECT * FROM ml_model_versions WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1`;

  try {
    const result = db.query(sql);
    const rows = result as ModelVersion[];
    return rows && rows.length > 0 ? rows[0] : null;
  } catch (error) {
    console.error('Error getting active model version (sync):', error);
    return null;
  }
}

/**
 * 激活指定模型版本
 */
export async function activateModelVersion(version: string): Promise<boolean> {
  try {
    // 先停用所有版本
    db.run(`UPDATE ml_model_versions SET is_active = 0`);
    
    // 激活指定版本
    db.run(`UPDATE ml_model_versions SET is_active = 1 WHERE version = ?`, [version]);
    
    return true;
  } catch (error) {
    console.error('Error activating version:', error);
    return false;
  }
}

/**
 * 获取所有模型版本（按时间倒序）
 */
export async function getAllModelVersions(): Promise<ModelVersion[]> {
  const sql = `SELECT * FROM ml_model_versions ORDER BY created_at DESC`;
  
  try {
    const result = db.query(sql);
    return (result || []) as ModelVersion[];
  } catch (error) {
    console.error('Error getting all model versions:', error);
    return [];
  }
}

/**
 * 计算模型性能衰减
 */
export async function calculatePerformanceDecay(
  currentVersion: string,
  previousVersion: string
): Promise<number> {
  try {
    const currentRows = db.query(`SELECT f1_score FROM ml_model_versions WHERE version = ?`, [currentVersion]) as any[];
    const previousRows = db.query(`SELECT f1_score FROM ml_model_versions WHERE version = ?`, [previousVersion]) as any[];
    
    const current = currentRows && currentRows.length > 0 ? currentRows[0] : null;
    const previous = previousRows && previousRows.length > 0 ? previousRows[0] : null;
    
    if (!current || !previous) {
      return 0;
    }
    
    const decay = (previous.f1_score - current.f1_score) / previous.f1_score;
    return Math.round(decay * 10000) / 10000;
  } catch (error) {
    console.error('Error calculating performance decay:', error);
    return 0;
  }
}

/**
 * 检查是否需要回滚（性能衰减超过阈值）
 */
export async function checkRollbackNeeded(threshold = 0.05): Promise<{
  needsRollback: boolean;
  currentVersion: string | null;
  rollbackVersion: string | null;
  decay: number;
}> {
  const activeVersion = await getActiveModelVersion();
  
  if (!activeVersion) {
    return { needsRollback: false, currentVersion: null, rollbackVersion: null, decay: 0 };
  }
  
  // 获取前一个版本
  const previousVersion = db.queryOne(
    `SELECT version, f1_score FROM ml_model_versions 
     WHERE created_at < ? AND is_active = 0 
     ORDER BY created_at DESC LIMIT 1`,
    [activeVersion.created_at]
  ) as { version: string; f1_score: number } | null;
  
  if (!previousVersion) {
    return { needsRollback: false, currentVersion: activeVersion.version, rollbackVersion: null, decay: 0 };
  }
  
  const decay = await calculatePerformanceDecay(activeVersion.version, previousVersion.version);
  
  if (decay > threshold) {
    return {
      needsRollback: true,
      currentVersion: activeVersion.version,
      rollbackVersion: previousVersion.version,
      decay,
    };
  }
  
  return { needsRollback: false, currentVersion: activeVersion.version, rollbackVersion: null, decay };
}

/**
 * 执行模型回滚
 */
export async function rollbackModel(targetVersion: string): Promise<boolean> {
  try {
    // 记录回滚操作
    db.run(
      `UPDATE ml_model_versions SET rollback_version = ? WHERE version = ?`,
      [targetVersion, (await getActiveModelVersion())?.version]
    );
    
    // 激活目标版本
    return await activateModelVersion(targetVersion);
  } catch (error) {
    console.error('Error rolling back model:', error);
    return false;
  }
}

/**
 * 获取模型性能历史
 */
export async function getModelPerformanceHistory(limit = 10): Promise<ModelVersion[]> {
  const sql = `SELECT * FROM ml_model_versions ORDER BY created_at DESC LIMIT ?`;
  
  try {
    const result = db.query(sql, [limit]);
    return (result || []) as ModelVersion[];
  } catch (error) {
    console.error('Error getting model performance history:', error);
    return [];
  }
}

export async function needsRetraining(threshold = 0.1): Promise<{
  needsRetraining: boolean;
  currentVersion: string | null;
  decay: number;
}> {
  const activeVersion = await getActiveModelVersion();

  if (!activeVersion) {
    // 没有活跃版本，需要首次训练
    return { needsRetraining: true, currentVersion: null, decay: 0 };
  }

  // 获取上一个版本用于计算性能衰减
  const previousVersion = db.queryOne(
    `SELECT version, f1_score FROM ml_model_versions 
     WHERE created_at < ? AND is_active = 0 
     ORDER BY created_at DESC LIMIT 1`,
    [activeVersion.created_at]
  ) as { version: string; f1_score: number } | null;

  if (!previousVersion) {
    // 只有一个版本，判断是否超过训练周期（7天）
    const lastTrainedAt = new Date(activeVersion.created_at).getTime();
    const daysSinceTraining = (Date.now() - lastTrainedAt) / (1000 * 60 * 60 * 24);
    const needsRetrain = daysSinceTraining > 7;
    return {
      needsRetraining: needsRetrain,
      currentVersion: activeVersion.version,
      decay: 0,
    };
  }

  // 计算性能衰减
  const decay = await calculatePerformanceDecay(activeVersion.version, previousVersion.version);

  return {
    needsRetraining: decay > threshold,
    currentVersion: activeVersion.version,
    decay,
  };
}

export async function rollbackToPreviousVersion(): Promise<{
  success: boolean;
  message: string;
  previousVersion: string | null;
}> {
  try {
    // 获取当前版本
    const current = await getActiveModelVersion();
    if (!current) {
      return { success: false, message: '没有当前模型版本', previousVersion: null };
    }

    // 获取前一个版本
    const versions = await getAllModelVersions();
    const previous = versions.find(v => v.version !== current.version && v.accuracy > 0);

    if (!previous) {
      return { success: false, message: '没有可回滚的先前版本', previousVersion: null };
    }

    // 执行回滚
    const success = await rollbackModel(previous.version);
    return {
      success,
      message: success ? `已回滚到版本 ${previous.version}` : '回滚失败',
      previousVersion: previous.version,
    };
  } catch (error) {
    return {
      success: false,
      message: `回滚失败：${error instanceof Error ? error.message : String(error)}`,
      previousVersion: null,
    };
  }
}
