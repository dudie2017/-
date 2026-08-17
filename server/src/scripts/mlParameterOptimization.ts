/**
 * 机器学习参数优化
 * 
 * 使用简单的线性回归模型预测最优参数组合
 * 基于历史实验数据（1000次实验）训练模型
 */

import fs from 'fs';
import path from 'path';
import { TOP1_UNIFIED_PARAMS } from '../data/top1UnifiedParams.ts';

const DATA_DIR = path.resolve(new URL('.', import.meta.url).pathname, '../data');

interface ExperimentResult {
  params: Record<string, number>;
  calmar: number;
  maxDrawdown: number;
  totalPnl: number;
  winRate: number;
}

interface MLPrediction {
  variety: string;
  predictedOptimalParams: Record<string, number>;
  predictedCalmar: number;
  currentCalmar: number;
  improvement: number;
  confidence: number;
}

// 简单的线性回归实现
class LinearRegression {
  private weights: number[] = [];
  private bias: number = 0;

  fit(X: number[][], y: number[]) {
    const n = X.length;
    const m = X[0].length;
    
    // 过滤掉 NaN/Infinity 的训练数据
    const validIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      const rowValid = X[i].every(v => isFinite(v));
      const targetValid = isFinite(y[i]);
      if (rowValid && targetValid) {
        validIndices.push(i);
      }
    }
    
    if (validIndices.length < m + 1) {
      console.log(`  警告: 有效训练数据不足 (${validIndices.length} < ${m + 1})`);
      this.weights = Array(m).fill(0);
      this.bias = 0;
      return;
    }
    
    const validX = validIndices.map(i => X[i]);
    const validY = validIndices.map(i => y[i]);
    
    // 添加偏置项
    const XWithBias = validX.map(row => [...row, 1]);
    
    // 使用正规方程求解: w = (X^T * X)^-1 * X^T * y
    const Xt = this.transpose(XWithBias);
    const XtX = this.multiply(Xt, XWithBias);
    const Xty = this.multiplyVector(Xt, validY);
    
    // 求解线性方程组
    this.weights = this.solve(XtX, Xty);
    this.bias = this.weights.pop() || 0;
    
    // 检查权重是否有效
    if (this.weights.some(w => !isFinite(w)) || !isFinite(this.bias)) {
      console.log(`  警告: 线性回归求解失败，权重包含 NaN/Infinity`);
      this.weights = this.weights.map(w => isFinite(w) ? w : 0);
      this.bias = isFinite(this.bias) ? this.bias : 0;
    }
  }

  predict(X: number[]): number {
    let sum = this.bias;
    for (let i = 0; i < this.weights.length; i++) {
      const xVal = isFinite(X[i]) ? X[i] : 0;
      sum += this.weights[i] * xVal;
    }
    return isFinite(sum) ? sum : 0;
  }

  private transpose(matrix: number[][]): number[][] {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const result: number[][] = Array(cols).fill(null).map(() => Array(rows).fill(0));
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        result[j][i] = matrix[i][j];
      }
    }
    return result;
  }

  private multiply(a: number[][], b: number[][]): number[][] {
    const rowsA = a.length;
    const colsA = a[0].length;
    const colsB = b[0].length;
    const result: number[][] = Array(rowsA).fill(null).map(() => Array(colsB).fill(0));
    for (let i = 0; i < rowsA; i++) {
      for (let j = 0; j < colsB; j++) {
        for (let k = 0; k < colsA; k++) {
          result[i][j] += a[i][k] * b[k][j];
        }
      }
    }
    return result;
  }

  private multiplyVector(matrix: number[][], vector: number[]): number[] {
    const rows = matrix.length;
    const cols = matrix[0].length;
    const result: number[] = Array(rows).fill(0);
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        result[i] += matrix[i][j] * vector[j];
      }
    }
    return result;
  }

  private solve(A: number[][], b: number[]): number[] {
    const n = A.length;
    const augmented = A.map((row, i) => [...row, b[i]]);
    
    // 高斯消元
    for (let i = 0; i < n; i++) {
      let maxRow = i;
      for (let k = i + 1; k < n; k++) {
        if (Math.abs(augmented[k][i]) > Math.abs(augmented[maxRow][i])) {
          maxRow = k;
        }
      }
      [augmented[i], augmented[maxRow]] = [augmented[maxRow], augmented[i]];
      
      // 防止除零：如果主元为0，添加小值
      if (Math.abs(augmented[i][i]) < 1e-10) {
        augmented[i][i] = 1e-10;
      }
      
      for (let k = i + 1; k < n; k++) {
        const factor = augmented[k][i] / augmented[i][i];
        for (let j = i; j <= n; j++) {
          augmented[k][j] -= factor * augmented[i][j];
        }
      }
    }
    
    // 回代
    const result = Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      result[i] = augmented[i][n];
      for (let j = i + 1; j < n; j++) {
        result[i] -= augmented[i][j] * result[j];
      }
      // 防止除零
      if (Math.abs(augmented[i][i]) < 1e-10) {
        result[i] = 0;
      } else {
        result[i] /= augmented[i][i];
      }
      // 防止 NaN/Infinity 传播
      if (!isFinite(result[i])) {
        result[i] = 0;
      }
    }
    return result;
  }
}

function loadExperiments(variety: string): ExperimentResult[] {
  const filePath = path.join(DATA_DIR, `${variety}_1000Experiments.json`);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  return data.fullResults.map((exp: any) => {
    const totalPnl = exp.stats?.totalPnl || 0;
    const maxDrawdown = exp.stats?.maxDrawdown || 0;
    // Compute Calmar manually: annualized return / max drawdown
    // Assuming ~10 years of data, annualized return = totalPnl / 10
    const annualizedReturn = totalPnl / 10;
    const calmar = maxDrawdown > 0 ? annualizedReturn / (maxDrawdown * 1e6) : 0;
    return {
      params: exp.recipe,
      calmar,
      maxDrawdown,
      totalPnl,
      winRate: exp.stats?.winRate || 0,
    };
  });
}

function extractFeatures(params: Record<string, any>): number[] {
  // 提取关键参数作为特征（只使用实验中实际变化的参数）
  return [
    params.stopAtrMult || 2.0,
    params.targetAtrMult || 3.0,
    params.minRR || 1.0,
    params.maxHoldDays || 20,
    params.cooldownBars || 10,
    params.edgeLookback || 20,
    params.feeMult || 1,
  ];
}

function analyzeVariety(variety: string): MLPrediction | null {
  console.log(`\n分析 ${variety}...`);
  
  const experiments = loadExperiments(variety);
  if (experiments.length < 100) {
    console.log(`  实验数据不足 (${experiments.length} < 100)`);
    return null;
  }
  
  // 准备训练数据
  const X = experiments.map(exp => extractFeatures(exp.params));
  const y = experiments.map(exp => exp.calmar);
  
  // 训练线性回归模型
  const model = new LinearRegression();
  model.fit(X, y);
  
  // 预测当前参数的表现
  const unified = TOP1_UNIFIED_PARAMS[variety];
  const currentFeatures = extractFeatures(unified);
  const currentPredicted = model.predict(currentFeatures);
  
  // 网格搜索预测最优参数
  let bestParams = { ...unified };
  let bestPredictedCalmar = isFinite(currentPredicted) ? currentPredicted : 0;
  
  // 对关键参数进行微调
  const paramRanges = {
    stopAtrMult: [1.5, 2.0, 2.5, 3.0, 3.5],
    targetAtrMult: [2.0, 2.5, 3.0, 3.5, 4.0],
    minRR: [1.0, 1.5, 2.0, 2.5, 3.0],
  };
  
  for (const stopAtrMult of paramRanges.stopAtrMult) {
    for (const targetAtrMult of paramRanges.targetAtrMult) {
      for (const minRR of paramRanges.minRR) {
        const testParams = {
          ...unified,
          stopAtrMult,
          targetAtrMult,
          minRR,
        };
        const testFeatures = extractFeatures(testParams);
        const predictedCalmar = model.predict(testFeatures);
        
        if (isFinite(predictedCalmar) && predictedCalmar > bestPredictedCalmar) {
          bestPredictedCalmar = predictedCalmar;
          bestParams = testParams;
        }
      }
    }
  }
  
  // 计算当前参数的实际 Calmar
  const currentCalmar = experiments
    .filter(exp => 
      exp.params.stopAtrMult === unified.stopAtrMult &&
      exp.params.targetAtrMult === unified.targetAtrMult &&
      exp.params.minRR === unified.minRR
    )
    .map(exp => exp.calmar)
    .reduce((a, b) => Math.max(a, b), 0);
  
  const improvement = (currentCalmar > 0 && isFinite(bestPredictedCalmar)) 
    ? (bestPredictedCalmar / currentCalmar - 1) * 100 
    : 0;
  
  console.log(`  当前 Calmar: ${currentCalmar.toFixed(2)}`);
  console.log(`  预测最优 Calmar: ${isFinite(bestPredictedCalmar) ? bestPredictedCalmar.toFixed(2) : 'N/A'}`);
  console.log(`  改进: ${improvement.toFixed(1)}%`);
  console.log(`  最优参数: stop=${bestParams.stopAtrMult}, target=${bestParams.targetAtrMult}, minRR=${bestParams.minRR}`);
  
  return {
    variety,
    predictedOptimalParams: {
      stopAtrMult: bestParams.stopAtrMult,
      targetAtrMult: bestParams.targetAtrMult,
      minRR: bestParams.minRR,
    },
    predictedCalmar: bestPredictedCalmar,
    currentCalmar,
    improvement,
    confidence: Math.min(experiments.length / 1000, 1),
  };
}

function main() {
  console.log('=== 机器学习参数优化 ===\n');
  
  const varieties = ['CF0', 'CU0', 'HC0'];
  const results: Record<string, MLPrediction> = {};
  
  for (const variety of varieties) {
    const result = analyzeVariety(variety);
    if (result) {
      results[variety] = result;
    }
  }
  
  // 保存结果
  const outputPath = path.join(DATA_DIR, 'mlParameterOptimization.json');
  fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
  console.log(`\n结果已保存: ${outputPath}`);
}

main();
