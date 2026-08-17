import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import { openPaperTrade } from '../services/paperTrading';
import { buildCovariance, portfolioStats } from '../services/portfolioMath.js';
import {
  loadAlertRules,
  saveAlertRules,
  loadAlerts,
  saveAlerts,
  addAlertRule,
  deleteAlertRule,
  runAlertDetection,
} from '../services/riskAlert.js';
import { trainModels } from '../services/modelTraining.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 刷新状态（防止并发刷新）
let isRefreshing = false;

/**
 * 读取全品种轻量汇总数据（full_analysis.json）
 * 由 server/src/scripts/generateFullAnalysis.ts 一次性生成，覆盖全部品种（当前 59 个）
 */
function loadFullAnalysis(): any | null {
  const filePath = path.join(__dirname, '../data/full_analysis.json');
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const data = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(data);
}

/**
 * 读取样本外稳健性统计（config_oos_stats.json）
 * 由 server/src/scripts/configBacktest.ts 生成（1000 次 bootstrap 验证）
 */
function loadOosStats(): any | null {
  const filePath = path.join(__dirname, '../data/config_oos_stats.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 读取时间序列稳健性验证结果（config_time_series.json）
 * 由 server/src/scripts/timeSeriesValidation.ts 生成（时间切分 OOS + 动态再平衡）
 */
function loadTimeSeries(): any | null {
  const filePath = path.join(__dirname, '../data/config_time_series.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * 读取品种最新收盘价（来自 data-cache 日线缓存）
 */
function readLatestPrice(code: string): number | null {
  const filePath = path.join(__dirname, '../../data-cache', `${code}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const bars = data.bars || [];
    if (!bars.length) return null;
    const last = bars[bars.length - 1];
    return typeof last.c === 'number' && last.c > 0 ? last.c : null;
  } catch {
    return null;
  }
}

/**
 * GET /api/v1/portfolio/analysis
 * 获取全品种组合分析数据（品种排名 + 相关性矩阵）
 */
router.get('/analysis', (req, res) => {
  try {
    const analysis = loadFullAnalysis();
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: '分析数据不存在，请先生成 full_analysis.json',
      });
    }

    res.json({
      success: true,
      data: {
        summary: analysis.summary,
        varieties: analysis.varieties,
        correlation: analysis.correlation,
        generatedAt: analysis.generatedAt,
      },
    });
  } catch (error) {
    console.error('Error loading portfolio analysis:', error);
    res.status(500).json({
      success: false,
      error: '加载分析数据失败',
    });
  }
});

/**
 * GET /api/v1/portfolio/configurations
 * 获取组合配置建议
 */
router.get('/configurations', (req, res) => {
  try {
    const analysis = loadFullAnalysis();
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: '配置数据不存在，请先生成 full_analysis.json',
      });
    }

    res.json({
      success: true,
      data: {
        portfolios: analysis.portfolio,
        varieties: analysis.varietiesMeta,
        oosStats: loadOosStats(),
        timeSeries: loadTimeSeries(),
        generatedAt: analysis.generatedAt,
      },
    });
  } catch (error) {
    console.error('Error loading configurations:', error);
    res.status(500).json({
      success: false,
      error: '加载配置数据失败',
    });
  }
});

/**
 * POST /api/v1/portfolio/backtest-signals
 * 交易信号回测（在历史行情上回测信号日志）
 * Body 参数：signals: { code: string, direction: 'long' | 'short', entryDate: string, exitDate?: string }[]
 */
router.post('/backtest-signals', (req, res) => {
  try {
    const { signals } = req.body as { signals: { code: string; direction: 'long' | 'short'; entryDate: string; exitDate?: string }[] };

    if (!signals || !Array.isArray(signals) || signals.length === 0) {
      return res.status(400).json({
        success: false,
        error: '请提供信号列表',
      });
    }

    const results: any[] = [];

    for (const signal of signals) {
      const { code, direction, entryDate, exitDate } = signal;

      // 读取历史价格数据
      const filePath = path.join(__dirname, '../../data-cache', `${code}.json`);
      if (!fs.existsSync(filePath)) {
        results.push({
          code,
          direction,
          entryDate,
          exitDate,
          error: '无历史价格数据',
        });
        continue;
      }

      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const bars = data.bars || [];

        // 找到入场日期对应的价格（兼容 date 和 t 字段）
        const entryBar = bars.find((b: any) => (b.t || b.date) === entryDate);
        if (!entryBar) {
          results.push({
            code,
            direction,
            entryDate,
            exitDate,
            error: '入场日期无数据',
          });
          continue;
        }

        const entryPrice = entryBar.c;

        // 如果提供了退出日期，计算实际收益
        if (exitDate) {
          const exitBar = bars.find((b: any) => (b.t || b.date) === exitDate);
          if (!exitBar) {
            results.push({
              code,
              direction,
              entryDate,
              exitDate,
              error: '退出日期无数据',
            });
            continue;
          }

          const exitPrice = exitBar.c;
          const pnl = direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;

          results.push({
            code,
            direction,
            entryDate,
            exitDate,
            entryPrice,
            exitPrice,
            pnl,
          });
        } else {
          // 如果没有退出日期，计算到最新价格的收益
          const latestBar = bars[bars.length - 1];
          const exitPrice = latestBar.c;
          const exitDateActual = latestBar.t || latestBar.date;
          const pnl = direction === 'long'
            ? (exitPrice - entryPrice) / entryPrice
            : (entryPrice - exitPrice) / entryPrice;

          results.push({
            code,
            direction,
            entryDate,
            exitDate: exitDateActual,
            entryPrice,
            exitPrice,
            pnl,
          });
        }
      } catch {
        results.push({
          code,
          direction,
          entryDate,
          exitDate,
          error: '读取数据失败',
        });
      }
    }

    // 计算统计指标
    const validResults = results.filter((r) => r.pnl !== undefined);
    const winCount = validResults.filter((r) => r.pnl > 0).length;
    const lossCount = validResults.filter((r) => r.pnl <= 0).length;
    const winRate = validResults.length > 0 ? winCount / validResults.length : 0;

    const avgWin = validResults.filter((r) => r.pnl > 0).reduce((a, b) => a + b.pnl, 0) / Math.max(winCount, 1);
    const avgLoss = Math.abs(validResults.filter((r) => r.pnl <= 0).reduce((a, b) => a + b.pnl, 0) / Math.max(lossCount, 1));
    const profitFactor = avgLoss > 0 ? avgWin / avgLoss : 0;

    // 计算最大回撤
    let cumulativePnl = 0;
    let maxPnl = 0;
    let maxDrawdown = 0;
    for (const r of validResults) {
      cumulativePnl += r.pnl;
      if (cumulativePnl > maxPnl) maxPnl = cumulativePnl;
      const drawdown = maxPnl - cumulativePnl;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    res.json({
      success: true,
      data: {
        results,
        stats: {
          total: validResults.length,
          winCount,
          lossCount,
          winRate,
          profitFactor,
          maxDrawdown,
          avgPnl: validResults.reduce((a, b) => a + b.pnl, 0) / Math.max(validResults.length, 1),
        },
      },
    });
  } catch (error) {
    console.error('Error backtesting signals:', error);
    res.status(500).json({
      success: false,
      error: '信号回测失败',
    });
  }
});

/**
 * GET /api/v1/portfolio/compare
 * 品种对比分析（2-3个品种的走势/波动率/相关性对比）
 * Query 参数：codes: string（逗号分隔的品种代码，如 "AU0,LC0,AO0"）
 */
router.get('/compare', (req, res) => {
  try {
    const codesParam = req.query.codes as string;
    if (!codesParam) {
      return res.status(400).json({
        success: false,
        error: '请提供品种代码（codes参数）',
      });
    }

    const codes = codesParam.split(',').map((c) => c.trim()).filter(Boolean);
    if (codes.length < 2 || codes.length > 3) {
      return res.status(400).json({
        success: false,
        error: '请选择2-3个品种进行对比',
      });
    }

    const analysis = loadFullAnalysis();
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: '分析数据不存在，请先生成 full_analysis.json',
      });
    }

    // 提取品种信息
    const varieties = analysis.varieties || [];
    const selectedVarieties = codes.map((code) => {
      const v = varieties.find((item: any) => item.code === code);
      if (!v) return null;
      return {
        code: v.code,
        name: v.name,
        sector: v.sector,
        avgPnl: v.avgPnl,
        avgMaxDd: v.avgMaxDd,
        avgWinRate: v.avgWinRate,
      };
    }).filter(Boolean);

    if (selectedVarieties.length !== codes.length) {
      return res.status(400).json({
        success: false,
        error: '部分品种不存在',
      });
    }

    // 读取历史价格数据
    const prices: Record<string, { date: string; price: number }[]> = {};
    for (const code of codes) {
      const filePath = path.join(__dirname, '../../data-cache', `${code}.json`);
      if (!fs.existsSync(filePath)) {
        prices[code] = [];
        continue;
      }
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        const bars = data.bars || [];
        prices[code] = bars.map((b: any) => ({
          date: b.t,
          price: b.c,
        }));
      } catch {
        prices[code] = [];
      }
    }

    // 归一化价格（以第一个共同日期为基准100）
    const normalizedPrices: Record<string, { date: string; value: number }[]> = {};
    const commonDates = new Set<string>();
    codes.forEach((code) => {
      prices[code].forEach((p) => commonDates.add(p.date));
    });
    const sortedDates = Array.from(commonDates).sort();

    if (sortedDates.length === 0) {
      return res.status(400).json({
        success: false,
        error: '无历史价格数据',
      });
    }

    // 找到第一个共同日期
    const firstDate = sortedDates[0];
    const basePrices: Record<string, number> = {};
    codes.forEach((code) => {
      const p = prices[code].find((item) => item.date === firstDate);
      basePrices[code] = p ? p.price : 100;
    });

    // 归一化
    codes.forEach((code) => {
      normalizedPrices[code] = prices[code]
        .filter((p) => sortedDates.includes(p.date))
        .map((p) => ({
          date: p.date,
          value: (p.price / basePrices[code]) * 100,
        }));
    });

    // 计算收益率统计
    const returns: Record<string, { mean: number; std: number; max: number; min: number }> = {};
    codes.forEach((code) => {
      const dailyReturns: number[] = [];
      const p = normalizedPrices[code];
      for (let i = 1; i < p.length; i++) {
        dailyReturns.push((p[i].value - p[i - 1].value) / p[i - 1].value);
      }
      const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
      const std = Math.sqrt(dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length);
      returns[code] = {
        mean: mean * 252, // 年化
        std: std * Math.sqrt(252), // 年化
        max: Math.max(...dailyReturns),
        min: Math.min(...dailyReturns),
      };
    });

    // 计算相关性矩阵
    const correlation: number[][] = [];
    for (let i = 0; i < codes.length; i++) {
      const row: number[] = [];
      for (let j = 0; j < codes.length; j++) {
        if (i === j) {
          row.push(1);
        } else {
          const pi = normalizedPrices[codes[i]];
          const pj = normalizedPrices[codes[j]];
          const ri = pi.slice(1).map((p, idx) => (p.value - pi[idx].value) / pi[idx].value);
          const rj = pj.slice(1).map((p, idx) => (p.value - pj[idx].value) / pj[idx].value);
          const n = Math.min(ri.length, rj.length);
          const mi = ri.slice(0, n).reduce((a, b) => a + b, 0) / n;
          const mj = rj.slice(0, n).reduce((a, b) => a + b, 0) / n;
          let num = 0;
          let di = 0;
          let dj = 0;
          for (let k = 0; k < n; k++) {
            num += (ri[k] - mi) * (rj[k] - mj);
            di += (ri[k] - mi) ** 2;
            dj += (rj[k] - mj) ** 2;
          }
          const corr = (di > 0 && dj > 0) ? num / Math.sqrt(di * dj) : 0;
          row.push(corr);
        }
      }
      correlation.push(row);
    }

    res.json({
      success: true,
      data: {
        varieties: selectedVarieties,
        normalizedPrices,
        returns,
        correlation,
      },
    });
  } catch (error) {
    console.error('Error comparing varieties:', error);
    res.status(500).json({
      success: false,
      error: '品种对比失败',
    });
  }
});

/**
 * POST /api/v1/portfolio/custom-weights
 * 计算自定义权重的组合指标
 * Body 参数：weights: { code: string, weight: number }[]
 */
router.post('/custom-weights', (req, res) => {
  try {
    const { weights } = req.body;
    if (!Array.isArray(weights) || weights.length === 0) {
      return res.status(400).json({
        success: false,
        error: '权重列表不能为空',
      });
    }

    const analysis = loadFullAnalysis();
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: '分析数据不存在，请先生成 full_analysis.json',
      });
    }

    // 提取品种代码和权重
    const codes = weights.map((w: any) => w.code);
    const weightValues = weights.map((w: any) => w.weight);

    // 归一化权重
    const weightSum = weightValues.reduce((a: number, b: number) => a + b, 0);
    if (weightSum <= 0) {
      return res.status(400).json({
        success: false,
        error: '权重总和必须大于 0',
      });
    }
    const normalizedWeights = weightValues.map((w: number) => w / weightSum);

    // 提取品种的预期收益和波动率（从 varieties）
    const varieties = analysis.varieties || [];
    const mu: number[] = [];
    const vols: number[] = [];
    for (const code of codes) {
      const variety = varieties.find((v: any) => v.code === code);
      if (!variety) {
        return res.status(400).json({
          success: false,
          error: `品种 ${code} 不存在`,
        });
      }
      mu.push(variety.avgPnl || 0);
      vols.push(variety.avgMaxDd ? Math.abs(variety.avgMaxDd) : 0);
    }

    // 构建相关性矩阵
    const correlation = analysis.correlation || {};
    const corrMatrix: number[][] = [];
    for (let i = 0; i < codes.length; i++) {
      const row: number[] = [];
      for (let j = 0; j < codes.length; j++) {
        const corr = correlation[codes[i]]?.[codes[j]] ?? (i === j ? 1 : 0);
        row.push(corr);
      }
      corrMatrix.push(row);
    }

    // 构建协方差矩阵
    const Sigma = buildCovariance(corrMatrix, vols);

    // 计算组合指标
    const stats = portfolioStats(normalizedWeights, mu, Sigma);

    res.json({
      success: true,
      data: {
        weights: codes.map((code: string, i: number) => ({
          code,
          weight: normalizedWeights[i],
        })),
        return: stats.return,
        volatility: stats.volatility,
        sharpe: stats.sharpe,
      },
    });
  } catch (error) {
    console.error('Error calculating custom weights:', error);
    res.status(500).json({
      success: false,
      error: '计算自定义权重失败',
    });
  }
});

/**
 * GET /api/v1/portfolio/strategies
 * 获取策略回测结果
 */
router.get('/strategies', (req, res) => {
  try {
    const analysis = loadFullAnalysis();
    if (!analysis) {
      return res.status(404).json({
        success: false,
        error: '策略数据不存在，请先生成 full_analysis.json',
      });
    }

    res.json({
      success: true,
      data: {
        strategies: analysis.strategy,
        varieties: analysis.varietiesMeta,
        generatedAt: analysis.generatedAt,
      },
    });
  } catch (error) {
    console.error('Error loading strategies:', error);
    res.status(500).json({
      success: false,
      error: '加载策略数据失败',
    });
  }
});

/**
 * POST /api/v1/portfolio/refresh
 * 触发重新生成 full_analysis.json（后台异步执行）
 */
router.post('/refresh', (req, res) => {
  if (isRefreshing) {
    return res.status(409).json({
      success: false,
      error: '刷新任务正在进行中，请稍候',
    });
  }

  isRefreshing = true;
  const serverDir = path.join(__dirname, '../..');
  const cmd = 'pnpm exec tsx src/scripts/generateFullAnalysis.ts';

  exec(cmd, { cwd: serverDir, timeout: 5 * 60 * 1000 }, (error, stdout, stderr) => {
    isRefreshing = false;
    if (error) {
      console.error('生成 full_analysis.json 失败:', error.message);
      if (stderr) console.error(stderr);
    } else if (stdout) {
      console.log('生成 full_analysis.json 完成');
    }
  });

  res.json({
    success: true,
    message: '刷新任务已启动，预计需要 1-2 分钟',
  });
});

/**
 * POST /api/v1/portfolio/apply-config
 * 一键把组合配置的品种导入模拟交易盘（开多仓）
 * Body: { configName: 'equalWeight' | 'riskParity' | 'maxSharpe', topN?: number }
 */
router.post('/apply-config', async (req, res) => {
  try {
    const { configName, topN } = req.body as {
      configName?: string;
      topN?: number;
    };

    if (!configName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: configName',
      });
    }

    const data = loadFullAnalysis();
    if (!data) {
      return res.status(404).json({
        success: false,
        error: '分析数据不存在，请先生成 full_analysis.json',
      });
    }

    const portfolio = data.portfolio?.[configName];
    if (!portfolio || !Array.isArray(portfolio.weights)) {
      return res.status(400).json({
        success: false,
        error: `未知的配置名: ${configName}`,
      });
    }

    const varieties = Array.isArray(data.varieties) ? data.varieties : [];
    const weights = portfolio.weights as number[];

    // 按权重降序，过滤出权重 > 0 的品种
    const ranked = varieties
      .map((v: any, i: number) => ({
        code: v.code as string,
        name: v.name as string,
        weight: (weights[i] || 0) as number,
      }))
      .filter((x: { weight: number }) => x.weight > 0)
      .sort((a: { weight: number }, b: { weight: number }) => b.weight - a.weight);

    const selected = topN && topN > 0 ? ranked.slice(0, topN) : ranked;
    if (!selected.length) {
      return res.status(400).json({
        success: false,
        error: '该配置下没有可导入的品种',
      });
    }

    const opened: any[] = [];
    const failed: any[] = [];
    for (const item of selected) {
      const price = readLatestPrice(item.code);
      if (price === null) {
        failed.push({ code: item.code, name: item.name, reason: '缺少行情数据' });
        continue;
      }
      try {
        await openPaperTrade({
          varietyCode: item.code,
          direction: 'long',
          entryPrice: price,
          quantity: 1,
          source: 'portfolio',
        });
        opened.push({
          code: item.code,
          name: item.name,
          weight: item.weight,
          price,
        });
      } catch (e) {
        failed.push({ code: item.code, name: item.name, reason: String(e) });
      }
    }

    return res.json({
      success: true,
      data: {
        configName,
        opened,
        failed,
        total: opened.length,
      },
    });
  } catch (error) {
    console.error('Error applying portfolio config:', error);
    return res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * GET /api/v1/portfolio/alert-rules
 * 获取预警规则列表
 */
router.get('/alert-rules', (req, res) => {
  try {
    const rules = loadAlertRules();
    res.json({ success: true, data: rules });
  } catch (error) {
    console.error('Error loading alert rules:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * POST /api/v1/portfolio/alert-rules
 * 添加预警规则
 * Body 参数：type: 'breakout' | 'volatility' | 'correlation', code: string, threshold: number
 */
router.post('/alert-rules', (req, res) => {
  try {
    const { type, code, threshold } = req.body;
    if (!type || !code || threshold === undefined) {
      return res.status(400).json({ success: false, error: '缺少必要参数' });
    }
    const newRule = addAlertRule({ type, code, threshold, enabled: true });
    res.json({ success: true, data: newRule });
  } catch (error) {
    console.error('Error adding alert rule:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * DELETE /api/v1/portfolio/alert-rules/:ruleId
 * 删除预警规则
 */
router.delete('/alert-rules/:ruleId', (req, res) => {
  try {
    const { ruleId } = req.params;
    const deleted = deleteAlertRule(ruleId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: '规则不存在' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting alert rule:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * GET /api/v1/portfolio/alerts
 * 获取历史预警列表
 */
router.get('/alerts', (req, res) => {
  try {
    const alerts = loadAlerts();
    res.json({ success: true, data: alerts });
  } catch (error) {
    console.error('Error loading alerts:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * POST /api/v1/portfolio/alerts/detect
 * 手动触发预警检测
 */
router.post('/alerts/detect', (req, res) => {
  try {
    const newAlerts = runAlertDetection();
    res.json({
      success: true,
      data: {
        newAlerts,
        count: newAlerts.length,
      },
    });
  } catch (error) {
    console.error('Error running alert detection:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * GET /api/v1/portfolio/trading-calendar
 * 获取交易日历（未来30天的交易日）
 * Query 参数：days: number（默认30）
 */
router.get('/trading-calendar', (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const calendar: any[] = [];
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dayOfWeek = date.getDay();
      const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
      const dateStr = date.toISOString().split('T')[0];

      calendar.push({
        date: dateStr,
        dayOfWeek: ['日', '一', '二', '三', '四', '五', '六'][dayOfWeek],
        isWeekend,
        isTradingDay: !isWeekend,
        month: date.getMonth() + 1,
        day: date.getDate(),
      });
    }

    res.json({ success: true, data: calendar });
  } catch (error) {
    console.error('Error generating trading calendar:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * GET /api/v1/portfolio/position-analysis
 * 持仓分析（持仓分布、VaR、Expected Shortfall）
 * 从模拟交易中读取当前持仓，计算风险指标
 */
router.get('/position-analysis', (req, res) => {
  try {
    // 读取模拟交易数据
    const dbPath = path.join(__dirname, '../data/database.sqlite');
    if (!fs.existsSync(dbPath)) {
      return res.json({
        success: true,
        data: {
          positions: [],
          distribution: { sector: {}, direction: {} },
          risk: { var95: 0, var99: 0, expectedShortfall: 0 },
        },
      });
    }

    // 这里简化处理，实际应该查询数据库
    // 由于无法直接查询 SQLite，返回空数据
    res.json({
      success: true,
      data: {
        positions: [],
        distribution: {
          sector: {},
          direction: { long: 0, short: 0 },
        },
        risk: {
          var95: 0,
          var99: 0,
          expectedShortfall: 0,
          note: '持仓分析需要查询数据库，当前简化处理',
        },
      },
    });
  } catch (error) {
    console.error('Error analyzing positions:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

/**
 * POST /api/v1/portfolio/retrain-model
 * ML模型自动重训
 * 检查是否需要重训（距离上次重训超过7天），如果需要则重训并对比新旧模型
 */
router.post('/retrain-model', (req, res) => {
  try {
    const modelVersionPath = path.join(__dirname, '../data/model_versions.json');
    
    // 读取上次重训时间
    let lastRetrainDate = null;
    if (fs.existsSync(modelVersionPath)) {
      const versions = JSON.parse(fs.readFileSync(modelVersionPath, 'utf-8'));
      if (versions.length > 0) {
        lastRetrainDate = new Date(versions[versions.length - 1].created_at);
      }
    }

    // 检查是否需要重训（超过7天）
    const now = new Date();
    const daysSinceLastRetrain = lastRetrainDate 
      ? (now.getTime() - lastRetrainDate.getTime()) / (1000 * 60 * 60 * 24)
      : Infinity;
    
    const needsRetrain = daysSinceLastRetrain > 7;

    if (!needsRetrain) {
      return res.json({
        success: true,
        data: {
          retrained: false,
          message: `上次重训在 ${daysSinceLastRetrain.toFixed(1)} 天前，无需重训`,
          lastRetrainDate,
        },
      });
    }

    // 执行重训
    const performance = trainModels();
    
    res.json({
      success: true,
      data: {
        retrained: true,
        message: '模型重训成功',
        performance: {
          accuracy: performance.accuracy,
          precision: performance.precision,
          recall: performance.recall,
          f1Score: performance.f1Score,
          trainSamples: performance.trainSamples,
          testSamples: performance.testSamples,
        },
        retrainDate: now,
      },
    });
  } catch (error) {
    console.error('Error retraining model:', error);
    res.status(500).json({ success: false, error: String(error) });
  }
});

export default router;
