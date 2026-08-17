/**
 * 组合数学纯函数模块（无 IO，可独立单测）
 *
 * 用于「配置建议」板块的三种组合配置计算：
 * 1. 协方差矩阵构建
 * 2. 组合收益 / 波动率 / 夏普（协方差矩阵口径）
 * 3. 风险平价（ERC，风险贡献平价）
 * 4. 最大夏普（long-only 投影梯度上升）
 */

/** 向量点积 */
export function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** 矩阵 × 向量 */
export function matVec(A: number[][], v: number[]): number[] {
  const n = A.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    out[i] = dot(A[i], v);
  }
  return out;
}

/** 二次型 wᵀΣw */
export function quadraticForm(v: number[], A: number[][]): number {
  return dot(v, matVec(A, v));
}

/**
 * 由相关性矩阵 + 波动率构建协方差矩阵
 * Σ_ij = corr_ij · vol_i · vol_j
 * vol 为 0 时兜底为极小正数，避免矩阵奇异
 */
export function buildCovariance(corr: number[][], vols: number[]): number[][] {
  const n = corr.length;
  const safeVols = vols.map((v) => (v > 1e-9 ? v : 1e-6));
  const Sigma: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n);
    for (let j = 0; j < n; j++) {
      row[j] = (corr[i]?.[j] ?? (i === j ? 1 : 0)) * safeVols[i] * safeVols[j];
    }
    Sigma.push(row);
  }
  return Sigma;
}

/** 组合指标（收益 / 波动率 / 夏普） */
export function portfolioStats(
  w: number[],
  mu: number[],
  Sigma: number[][]
): { return: number; volatility: number; sharpe: number } {
  const ret = dot(w, mu);
  const vol = Math.sqrt(Math.max(quadraticForm(w, Sigma), 0));
  return {
    return: ret,
    volatility: vol,
    sharpe: vol > 1e-9 ? ret / vol : 0,
  };
}

/**
 * 风险平价（ERC，Equal Risk Contribution）
 * 迭代使每个品种的风险贡献 RC_i = w_i·(Σw)_i / σ_p 收敛到 1/n
 * 参考 Maillard, Roncalli & Teiletche (2010) 的简单迭代法
 */
export function ercWeights(
  Sigma: number[][],
  opts: { tol?: number; maxIter?: number; maxWeight?: number } = {}
): number[] {
  const n = Sigma.length;
  const tol = opts.tol ?? 1e-8;
  const maxIter = opts.maxIter ?? 2000;
  const maxWeight = opts.maxWeight ?? 1;
  let w = new Array<number>(n).fill(1 / n);

  for (let it = 0; it < maxIter; it++) {
    const Sw = matVec(Sigma, w);
    const sigmaP = Math.sqrt(Math.max(dot(w, Sw), 0));
    if (sigmaP < 1e-12) return w; // 退化：全部波动为 0，保持等权
    const target = 1 / n;
    let maxDiff = 0;
    const rc = w.map((wi, i) => (wi * Sw[i]) / sigmaP);
    const next = w.map((wi, i) => {
      const scale = Math.sqrt(target / Math.max(rc[i], 1e-12));
      maxDiff = Math.max(maxDiff, Math.abs(rc[i] - target));
      return wi * scale;
    });
    const sum = next.reduce((a, b) => a + b, 0);
    if (sum < 1e-12) return w;
    w = next.map((x) => x / sum);
    if (maxDiff < tol) break;
  }
  if (maxWeight < 1) {
    w = clampWeights(w, maxWeight);
  }
  return w;
}

/**
 * 权重上限约束：把超过 maxWeight 的品种裁剪到上限，
 * 多余权重按剩余容量比例分配给未超限品种，迭代至收敛。
 */
function clampWeights(w: number[], maxWeight: number): number[] {
  let cur = [...w];
  for (let it = 0; it < 200; it++) {
    const excess = cur.map((x) => Math.max(0, x - maxWeight));
    const totalExcess = excess.reduce((a, b) => a + b, 0);
    if (totalExcess < 1e-9) break;
    const capped = cur.map((x, i) => x - excess[i]);
    const freeCapacity = capped.map((x) =>
      x < maxWeight - 1e-9 ? maxWeight - x : 0
    );
    const totalFree = freeCapacity.reduce((a, b) => a + b, 0);
    if (totalFree < 1e-9) break;
    cur = capped.map((x, i) => x + (freeCapacity[i] / totalFree) * totalExcess);
  }
  const sum = cur.reduce((a, b) => a + b, 0);
  return sum > 1e-12 ? cur.map((x) => x / sum) : cur;
}

/**
 * 最大夏普组合（long-only）
 * 用投影梯度上升最大化 S(w) = wᵀμ / sqrt(wᵀΣw)，约束 w≥0, Σw=1
 * 多次随机初始化取最优，末尾剔除 <minWeight 的微小权重
 */
/** 确定性伪随机数生成器（mulberry32），保证优化器结果可复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function maxSharpeWeights(
  mu: number[],
  Sigma: number[][],
  opts: {
    lr?: number;
    maxIter?: number;
    restarts?: number;
    tol?: number;
    minWeight?: number;
    seed?: number;
  } = {}
): number[] {
  const n = mu.length;
  const lr = opts.lr ?? 1e-4;
  const maxIter = opts.maxIter ?? 5000;
  const restarts = opts.restarts ?? 20;
  const tol = opts.tol ?? 1e-8;
  const minWeight = opts.minWeight ?? 0.005;
  const rnd = mulberry32(opts.seed ?? 42);

  // 梯度：∇S = μ/σ - (wᵀμ)(Σw)/σ³
  const gradient = (w: number[], sigma: number, ret: number, Sw: number[]) => {
    const g = new Array<number>(n);
    const c = (ret / Math.pow(sigma, 3));
    for (let i = 0; i < n; i++) {
      g[i] = mu[i] / sigma - c * Sw[i];
    }
    return g;
  };

  const project = (w: number[]) => {
    const clipped = w.map((x) => Math.max(x, 0));
    const sum = clipped.reduce((a, b) => a + b, 0);
    if (sum < 1e-12) return new Array<number>(n).fill(1 / n);
    return clipped.map((x) => x / sum);
  };

  const evaluate = (w: number[]) => {
    const ret = dot(w, mu);
    const sigma = Math.sqrt(Math.max(quadraticForm(w, Sigma), 0));
    return { sharpe: sigma > 1e-9 ? ret / sigma : -Infinity, ret, sigma };
  };

  let best = { sharpe: -Infinity, w: new Array<number>(n).fill(1 / n) };

  for (let r = 0; r < restarts; r++) {
    // 随机初始化在单纯形上
    let w = new Array<number>(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      w[i] = rnd() + 1e-3;
      sum += w[i];
    }
    w = w.map((x) => x / sum);

    let prevSharpe = -Infinity;
    for (let it = 0; it < maxIter; it++) {
      const Sw = matVec(Sigma, w);
      const ret = dot(w, mu);
      const sigma = Math.sqrt(Math.max(dot(w, Sw), 0));
      if (sigma < 1e-9) break;
      const g = gradient(w, sigma, ret, Sw);
      const next = w.map((wi, i) => wi + lr * g[i]);
      w = project(next);

      const curSharpe = ret / sigma;
      if (Math.abs(curSharpe - prevSharpe) < tol) break;
      prevSharpe = curSharpe;
    }

    const final = evaluate(w);
    if (final.sharpe > best.sharpe) {
      best = { sharpe: final.sharpe, w: [...w] };
    }
  }

  // 剔除微小权重并重新归一化
  const cleaned = best.w.map((x) => (x >= minWeight ? x : 0));
  const total = cleaned.reduce((a, b) => a + b, 0);
  if (total < 1e-12) return best.w;
  return cleaned.map((x) => x / total);
}

/**
 * μ 收缩估计：向全体均值收缩，降低 Top-K 事后选择偏差
 * μ_shrink = alpha·μ_top + (1-alpha)·μ_all
 */
export function shrinkMu(muTop: number[], muAll: number[], alpha: number): number[] {
  return muTop.map((t, i) => alpha * t + (1 - alpha) * muAll[i]);
}

/**
 * 统一约束后处理：单品种上限 → 板块上限 → 权重下限 → 最小持仓数 → 归一化
 */
export function applyConstraints(
  weights: number[],
  opts: {
    maxWeight?: number;
    maxSectorWeight?: number;
    minWeight?: number;
    minHoldings?: number;
    sectors?: string[];
  } = {}
): number[] {
  let w = [...weights];

  if (opts.maxWeight != null && opts.maxWeight < 1) {
    w = clampWeights(w, opts.maxWeight);
  }
  if (opts.maxSectorWeight != null && opts.sectors) {
    w = clampSectorWeights(w, opts.sectors, opts.maxSectorWeight);
  }
  if (opts.minWeight != null) {
    const minWeight = opts.minWeight;
    w = w.map((x) => (x < minWeight ? 0 : x));
  }
  if (opts.minHoldings != null && opts.minHoldings > 0) {
    w = enforceMinHoldings(w, opts.minHoldings);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  return sum > 1e-12 ? w.map((x) => x / sum) : w;
}

/**
 * 板块集中度约束：把超限板块缩放到上限，多余权重分配给未超限板块
 */
function clampSectorWeights(w: number[], sectors: string[], maxSectorWeight: number): number[] {
  let cur = [...w];
  for (let it = 0; it < 200; it++) {
    const sectorSum = new Map<string, number>();
    cur.forEach((x, i) => {
      const s = sectors[i] || '未知';
      sectorSum.set(s, (sectorSum.get(s) || 0) + x);
    });
    const sectorExcess = new Map<string, number>();
    let totalExcess = 0;
    sectorSum.forEach((sum, s) => {
      const excess = Math.max(0, sum - maxSectorWeight);
      if (excess > 1e-9) {
        sectorExcess.set(s, excess);
        totalExcess += excess;
      }
    });
    if (totalExcess < 1e-9) break;

    const capped = [...cur];
    sectorExcess.forEach((excess, s) => {
      const sum = sectorSum.get(s)!;
      const scale = (sum - excess) / sum;
      cur.forEach((x, i) => {
        if ((sectors[i] || '未知') === s) capped[i] = x * scale;
      });
    });

    const freeCapacity = capped.map((x, i) => {
      const s = sectors[i] || '未知';
      return sectorExcess.has(s) ? 0 : x;
    });
    const totalFree = freeCapacity.reduce((a, b) => a + b, 0);
    if (totalFree < 1e-9) break;
    cur = capped.map((x, i) => {
      const s = sectors[i] || '未知';
      if (sectorExcess.has(s)) return x;
      return x + (freeCapacity[i] / totalFree) * totalExcess;
    });
  }
  return cur;
}

/**
 * 最小持仓数：归零后若持仓不足 minHoldings，保留权重最大的前 N 个
 */
function enforceMinHoldings(w: number[], minHoldings: number): number[] {
  const nonzero = w.filter((x) => x > 1e-9).length;
  if (nonzero >= minHoldings) return w;
  const idx = w
    .map((x, i) => ({ x, i }))
    .sort((a, b) => b.x - a.x)
    .slice(0, minHoldings)
    .map((o) => o.i);
  const keep = new Set(idx);
  return w.map((x, i) => (keep.has(i) ? x : 0));
}

/**
 * 组合配置约束默认值（三个脚本共用）
 */
export interface PortfolioConstraints {
  maxWeight: number;
  maxSectorWeight: number;
  minWeight: number;
  minHoldings: number;
}

export const DEFAULT_CONSTRAINTS: PortfolioConstraints = {
  maxWeight: 0.2,
  maxSectorWeight: 0.35,
  minWeight: 0.01,
  minHoldings: 5,
};

export const DEFAULT_SHRINK_ALPHA = 0.5;

export interface ThreePortfolios {
  equalWeight: number[];
  riskParity: number[];
  maxSharpe: number[];
}

/**
 * 一次性计算三种配置方案（等权重 / 风险平价 / 最大夏普），统一施加约束。
 * 三个验证脚本共用，避免权重计算逻辑漂移。
 */
export function computeThreePortfolios(
  mu: number[],
  Sigma: number[][],
  sectors?: string[],
  opts: Partial<PortfolioConstraints> & {
    maxSharpeOpts?: Parameters<typeof maxSharpeWeights>[2];
  } = {}
): ThreePortfolios {
  const c: PortfolioConstraints = { ...DEFAULT_CONSTRAINTS, ...opts };
  const n = mu.length;
  const constraint: {
    maxWeight: number;
    maxSectorWeight?: number;
    minWeight: number;
    minHoldings: number;
    sectors?: string[];
  } = {
    maxWeight: c.maxWeight,
    minWeight: c.minWeight,
    minHoldings: c.minHoldings,
  };
  // 仅在提供板块信息时施加板块集中度约束（避免空板块把所有品种归为「未知」而误压权重）
  if (sectors && sectors.length > 0) {
    constraint.maxSectorWeight = c.maxSectorWeight;
    constraint.sectors = sectors;
  }

  const equalWeight = applyConstraints(new Array(n).fill(1 / n), constraint);
  const riskParity = applyConstraints(
    ercWeights(Sigma, { maxWeight: c.maxWeight }),
    constraint
  );
  const maxSharpe = applyConstraints(
    maxSharpeWeights(mu, Sigma, opts.maxSharpeOpts),
    constraint
  );

  return { equalWeight, riskParity, maxSharpe };
}
