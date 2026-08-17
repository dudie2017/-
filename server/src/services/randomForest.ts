/**
 * CART 决策树 + 随机森林
 * 纯自实现，无外部依赖，兼容 ESM + Node 24
 *
 * 提供能力：
 * - 基尼不纯度分裂的多分类 CART 决策树
 * - bootstrap + 特征子集抽样的随机森林
 * - 多树概率平均预测（置信度更平滑）
 * - 基尼重要性（真实树模型特征重要性）
 * - 森林序列化/反序列化（用于模型持久化）
 */

export interface ForestNode {
  featureIndex?: number;
  threshold?: number;
  left?: ForestNode;
  right?: ForestNode;
  /** 分裂时的基尼减少量，用于特征重要性 */
  gain?: number;
  /** 叶子节点：多数类标签 */
  label?: string;
  /** 叶子节点：各类别概率（按 labelSet 顺序） */
  prob?: number[];
}

export interface TreeOptions {
  maxDepth: number;
  minSamplesLeaf: number;
}

export interface ForestOptions extends TreeOptions {
  nTrees: number;
  /** 每棵树随机选择的特征数量 */
  maxFeatures: number;
  /** bootstrap 采样比例，默认 1.0 */
  sampleRatio?: number;
  /** 随机种子，用于可复现（可选） */
  seed?: number;
}

const DEFAULT_OPTIONS: ForestOptions = {
  nTrees: 20,
  maxDepth: 8,
  minSamplesLeaf: 20,
  maxFeatures: 4,
  sampleRatio: 1.0,
};

// ============================================================
// 基础工具
// ============================================================

/** 简单可复现随机数（mulberry32） */
function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 基尼不纯度 */
function giniImpurity(counts: number[]): number {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let sum = 0;
  for (const c of counts) sum += (c / total) ** 2;
  return 1 - sum;
}

function countLabels(y: string[], labelSet: string[]): number[] {
  const counts = new Array(labelSet.length).fill(0);
  for (const label of y) {
    const idx = labelSet.indexOf(label);
    if (idx >= 0) counts[idx]++;
  }
  return counts;
}

function argmax(arr: number[]): number {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i;
  }
  return best;
}

// ============================================================
// 决策树
// ============================================================

/**
 * 递归构建 CART 决策树
 */
function buildTree(
  X: number[][],
  y: string[],
  labelSet: string[],
  featureIndices: number[],
  options: TreeOptions,
  depth: number
): ForestNode {
  const counts = countLabels(y, labelSet);
  const majorityLabel = labelSet[argmax(counts)];

  // 停止条件：达到最大深度 / 样本过少 / 已纯
  const total = y.length;
  if (
    depth >= options.maxDepth ||
    total < options.minSamplesLeaf * 2 ||
    giniImpurity(counts) === 0 ||
    featureIndices.length === 0
  ) {
    return {
      label: majorityLabel,
      prob: counts.map((c) => (total > 0 ? c / total : 0)),
    };
  }

  const parentGini = giniImpurity(counts);

  let bestSplit: {
    featureIndex: number;
    threshold: number;
    leftY: string[];
    rightY: string[];
    gain: number;
  } | null = null;

  // 对每个候选特征寻找最优分裂点
  for (const featureIndex of featureIndices) {
    // 提取 (value, label) 对并排序
    const pairs = y
      .map((label, i) => ({ value: X[i][featureIndex], label }))
      .filter((p) => typeof p.value === 'number' && Number.isFinite(p.value))
      .sort((a, b) => a.value - b.value);

    if (pairs.length < options.minSamplesLeaf * 2) continue;

    // 扫描阈值（相邻不同值的中点）
    let leftCounts = new Array(labelSet.length).fill(0);
    let rightCounts = countLabels(
      pairs.map((p) => p.label),
      labelSet
    );

    for (let i = 0; i < pairs.length - 1; i++) {
      const idx = labelSet.indexOf(pairs[i].label);
      if (idx >= 0) {
        leftCounts[idx]++;
        rightCounts[idx]--;
      }

      // 跳过相同值，避免无效阈值
      if (pairs[i].value === pairs[i + 1].value) continue;

      const leftSize = i + 1;
      const rightSize = pairs.length - leftSize;
      if (leftSize < options.minSamplesLeaf || rightSize < options.minSamplesLeaf) continue;

      const giniLeft = giniImpurity(leftCounts);
      const giniRight = giniImpurity(rightCounts);
      const weighted = (leftSize / pairs.length) * giniLeft + (rightSize / pairs.length) * giniRight;
      const gain = parentGini - weighted;

      if (gain > 0 && (!bestSplit || gain > bestSplit.gain)) {
        bestSplit = {
          featureIndex,
          threshold: (pairs[i].value + pairs[i + 1].value) / 2,
          leftY: pairs.slice(0, i + 1).map((p) => p.label),
          rightY: pairs.slice(i + 1).map((p) => p.label),
          gain,
        };
      }
    }
  }

  if (!bestSplit) {
    return {
      label: majorityLabel,
      prob: counts.map((c) => (total > 0 ? c / total : 0)),
    };
  }

  // 根据阈值切分 X
  const leftX: number[][] = [];
  const rightX: number[][] = [];
  const leftY: string[] = [];
  const rightY: string[] = [];
  for (let i = 0; i < X.length; i++) {
    const value = X[i][bestSplit.featureIndex];
    if (typeof value === 'number' && Number.isFinite(value) && value < bestSplit.threshold) {
      leftX.push(X[i]);
      leftY.push(y[i]);
    } else {
      rightX.push(X[i]);
      rightY.push(y[i]);
    }
  }

  return {
    featureIndex: bestSplit.featureIndex,
    threshold: bestSplit.threshold,
    gain: bestSplit.gain,
    left: buildTree(leftX, leftY, labelSet, featureIndices, options, depth + 1),
    right: buildTree(rightX, rightY, labelSet, featureIndices, options, depth + 1),
  };
}

/** 预测样本的类别概率分布 */
function predictProb(node: ForestNode, x: number[]): number[] {
  if (node.prob) return node.prob;
  if (node.featureIndex === undefined || node.threshold === undefined) {
    // 兜底：均匀分布
    return [];
  }
  const value = x[node.featureIndex];
  const goLeft =
    typeof value === 'number' && Number.isFinite(value) && value < node.threshold;
  const child = goLeft ? node.left : node.right;
  if (!child) {
    return node.prob || [];
  }
  return predictProb(child, x);
}

// ============================================================
// 随机森林
// ============================================================

export class RandomForest {
  private trees: ForestNode[] = [];
  private labelSet: string[] = [];
  private featureNames: string[] = [];
  private featureCount = 0;
  private importance: number[] = [];

  /**
   * 训练随机森林
   * @param X 特征矩阵（n × m，数值）
   * @param y 标签数组（长度 n）
   * @param featureNames 特征名数组（长度 m），用于特征重要性展示
   * @param options 超参数
   */
  fit(
    X: number[][],
    y: string[],
    featureNames: string[],
    options: Partial<ForestOptions> = {}
  ): void {
    if (X.length === 0 || X.length !== y.length) {
      throw new Error('RandomForest.fit: 特征矩阵与标签长度不一致或为空');
    }

    const opts: ForestOptions = { ...DEFAULT_OPTIONS, ...options };
    this.featureNames = featureNames;
    this.featureCount = featureNames.length;
    this.labelSet = [...new Set(y)].sort();
    this.importance = new Array(this.featureCount).fill(0);
    this.trees = [];

    const n = X.length;
    const rng = createRng(opts.seed ?? Date.now());
    const nFeatures = Math.min(opts.maxFeatures, this.featureCount);
    const sampleSize = Math.max(1, Math.floor(n * (opts.sampleRatio ?? 1.0)));

    for (let t = 0; t < opts.nTrees; t++) {
      // bootstrap 采样（有放回）
      const sampleX: number[][] = [];
      const sampleY: string[] = [];
      for (let i = 0; i < sampleSize; i++) {
        const idx = Math.floor(rng() * n);
        sampleX.push(X[idx]);
        sampleY.push(y[idx]);
      }

      // 随机选择特征子集
      const shuffled = [...Array(this.featureCount).keys()].sort(() => rng() - 0.5);
      const featureSubset = shuffled.slice(0, nFeatures);

      const tree = buildTree(sampleX, sampleY, this.labelSet, featureSubset, opts, 0);
      this.trees.push(tree);

      // 累加特征重要性（该树每个分裂点的基尼增益）
      this.accumulateImportance(tree);
    }
  }

  private accumulateImportance(node: ForestNode): void {
    if (node.featureIndex !== undefined && node.gain !== undefined) {
      this.importance[node.featureIndex] += node.gain;
    }
    if (node.left) this.accumulateImportance(node.left);
    if (node.right) this.accumulateImportance(node.right);
  }

  /** 预测类别概率分布（多树平均），返回按 labelSet 顺序的概率数组 */
  predictProb(x: number[]): number[] {
    if (this.trees.length === 0) {
      return this.labelSet.map(() => 0);
    }

    const probSum = new Array(this.labelSet.length).fill(0);
    for (const tree of this.trees) {
      const probs = predictProb(tree, x);
      if (probs.length === this.labelSet.length) {
        for (let i = 0; i < probs.length; i++) {
          probSum[i] += probs[i];
        }
      }
    }

    return probSum.map((v) => v / this.trees.length);
  }

  /** 预测标签 + 置信度 */
  predict(x: number[]): { label: string; confidence: number } {
    const probs = this.predictProb(x);
    if (probs.length === 0) {
      return { label: this.labelSet[0] || '', confidence: 0 };
    }
    const best = argmax(probs);
    return { label: this.labelSet[best], confidence: probs[best] };
  }

  /** 基尼重要性（归一化到 0~1，按特征名返回） */
  getFeatureImportance(): Record<string, number> {
    const result: Record<string, number> = {};
    const total = this.importance.reduce((a, b) => a + b, 0);

    for (let i = 0; i < this.featureCount; i++) {
      const name = this.featureNames[i] || `feature_${i}`;
      result[name] = total > 0 ? this.importance[i] / total : 0;
    }
    return result;
  }

  get labels(): string[] {
    return this.labelSet;
  }

  get treeCount(): number {
    return this.trees.length;
  }

  /** 序列化森林（用于落盘持久化） */
  toJSON(): {
    trees: ForestNode[];
    labelSet: string[];
    featureNames: string[];
    featureCount: number;
  } {
    return {
      trees: this.trees,
      labelSet: this.labelSet,
      featureNames: this.featureNames,
      featureCount: this.featureCount,
    };
  }

  /** 从 JSON 反序列化重建森林 */
  static fromJSON(json: {
    trees: ForestNode[];
    labelSet: string[];
    featureNames: string[];
    featureCount?: number;
  }): RandomForest {
    const forest = new RandomForest();
    forest.trees = json.trees || [];
    forest.labelSet = json.labelSet || [];
    forest.featureNames = json.featureNames || [];
    forest.featureCount = json.featureCount ?? forest.featureNames.length;
    // 重新计算重要性
    forest.importance = new Array(forest.featureCount).fill(0);
    for (const tree of forest.trees) {
      forest.accumulateImportance(tree);
    }
    return forest;
  }
}
