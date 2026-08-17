import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dot,
  matVec,
  quadraticForm,
  buildCovariance,
  portfolioStats,
  ercWeights,
  maxSharpeWeights,
  shrinkMu,
  applyConstraints,
  computeThreePortfolios,
} from '../services/portfolioMath';

const sum = (a: number[]) => a.reduce((s, v) => s + v, 0);
const approx = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `期望 ${b}，实际 ${a}`);

test('dot / matVec / quadraticForm 基本运算', () => {
  approx(dot([1, 2, 3], [4, 5, 6]), 32);
  assert.deepEqual(matVec([[1, 2], [3, 4]], [1, 1]), [3, 7]);
  const A = [[2, 0], [0, 3]];
  approx(quadraticForm([1, 2], A), 2 * 1 + 3 * 4); // 14
});

test('buildCovariance 对角线为方差、非对角为 corr*vol_i*vol_j 且对称', () => {
  const corr = [[1, 0.5], [0.5, 1]];
  const vols = [0.2, 0.1];
  const S = buildCovariance(corr, vols);
  approx(S[0][0], 0.04);
  approx(S[1][1], 0.01);
  approx(S[0][1], 0.5 * 0.2 * 0.1);
  approx(S[0][1], S[1][0]);
});

test('portfolioStats 计算 return/volatility/sharpe', () => {
  const w = [0.5, 0.5];
  const mu = [0.1, 0.2];
  const Sigma = [[0.04, 0], [0, 0.01]];
  const s = portfolioStats(w, mu, Sigma);
  approx(s.return, 0.15);
  const vol = Math.sqrt(0.25 * 0.04 + 0.25 * 0.01);
  approx(s.volatility, vol);
  approx(s.sharpe, 0.15 / vol);
});

test('portfolioStats 对零波动率返回 sharpe 0 而非 NaN', () => {
  const s = portfolioStats([1], [0.1], [[0]]);
  approx(s.sharpe, 0);
});

test('ercWeights 权重和为 1 且非负', () => {
  const Sigma = [[0.04, 0.005], [0.005, 0.01]];
  const w = ercWeights(Sigma);
  approx(sum(w), 1);
  assert.ok(w.every((x) => x >= -1e-9));
});

test('ercWeights 遵守 maxWeight 上限', () => {
  // 低波动品种会吸引更多权重，用 maxWeight 限制
  const Sigma = [[0.16, 0], [0, 0.01]];
  const w = ercWeights(Sigma, { maxWeight: 0.6 });
  approx(sum(w), 1);
  assert.ok(w.every((x) => x <= 0.6 + 1e-6));
});

test('maxSharpeWeights 权重和为 1、非负、夏普不低于等权重', () => {
  const mu = [0.3, 0.1, 0.05];
  const Sigma = [[0.09, 0, 0], [0, 0.04, 0], [0, 0, 0.01]];
  const w = maxSharpeWeights(mu, Sigma, { restarts: 5, maxIter: 1000 });
  approx(sum(w), 1, 1e-4);
  assert.ok(w.every((x) => x >= -1e-6));
  const sharpeOpt = portfolioStats(w, mu, Sigma).sharpe;
  const sharpeEqual = portfolioStats([1 / 3, 1 / 3, 1 / 3], mu, Sigma).sharpe;
  assert.ok(sharpeOpt >= sharpeEqual - 1e-3);
});

test('shrinkMu 收缩结果介于 muTop 与 muAll 之间', () => {
  const muTop = [0.4, 0.2];
  const muAll = [0.1, 0.1];
  const mu = shrinkMu(muTop, muAll, 0.5);
  approx(mu[0], 0.25);
  approx(mu[1], 0.15);
});

test('applyConstraints 应用权重下限与最小持仓', () => {
  const w = [0.4, 0.35, 0.15, 0.08, 0.02];
  const out = applyConstraints(w, {
    maxWeight: 0.4,
    minWeight: 0.05,
    minHoldings: 3,
    maxSectorWeight: 1.0,
  });
  approx(sum(out), 1, 1e-6);
  // 0.02 < minWeight 应被归零
  assert.ok(out.every((x) => x === 0 || x >= 0.05 - 1e-6));
});

test('applyConstraints 应用板块上限', () => {
  const w = [0.5, 0.4, 0.1];
  const sectors = ['金属', '金属', '农产品'];
  const out = applyConstraints(w, {
    maxWeight: 1.0,
    maxSectorWeight: 0.6,
    minWeight: 0.0,
    minHoldings: 1,
    sectors,
  });
  approx(sum(out), 1, 1e-6);
  const metal = out[0] + out[1];
  assert.ok(metal <= 0.6 + 1e-6);
});

test('computeThreePortfolios 返回三种合法权重', () => {
  const mu = [0.2, 0.15, 0.1, 0.05];
  const Sigma = [
    [0.04, 0, 0, 0],
    [0, 0.0225, 0, 0],
    [0, 0, 0.01, 0],
    [0, 0, 0, 0.0025],
  ];
  const sectors = ['A', 'A', 'B', 'B'];
  const p = computeThreePortfolios(mu, Sigma, sectors);
  for (const w of [p.equalWeight, p.riskParity, p.maxSharpe]) {
    approx(sum(w), 1, 1e-4);
    assert.ok(w.every((x) => x >= -1e-6));
  }
});

test('computeThreePortfolios 无板块信息时跳过板块约束', () => {
  const mu = [0.2, 0.15, 0.1];
  const Sigma = [[0.04, 0, 0], [0, 0.0225, 0], [0, 0, 0.01]];
  const p = computeThreePortfolios(mu, Sigma, undefined);
  for (const w of [p.equalWeight, p.riskParity, p.maxSharpe]) {
    approx(sum(w), 1, 1e-4);
    assert.ok(w.every((x) => x >= -1e-6));
  }
});
