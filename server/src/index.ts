import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import express from "express";
import cors from "cors";
import scanRouter, { preloadScanCache, preload30mCache, startScanCacheRefresh } from "./routes/scan.js";
import optimizationRouter from "./routes/optimization.js";
import tradingRouter from "./routes/trading.js";
import dceRouter from "./routes/dce.js";
import capitalFlowRouter from "./routes/capitalFlow.js";
import tradingCostRouter from "./routes/tradingCost.js";
import historyRouter from "./routes/history.js";
import historyCollectRouter from "./routes/historyCollect.js";
import alertsRouter from "./routes/alerts.js";
import supplyDemandRouter from "./routes/supplyDemand.js";
import aiRouter from "./routes/ai.js";
import technicalRouter from "./routes/technical.js";
import varietyRouter from "./routes/variety.js";
import circuitBreakerRouter from "./routes/circuitBreaker.js";
import spotPriceRouter from "./routes/spotPrice.js";
import feishuRouter from "./routes/feishu.js";
import analyzerRouter from "./routes/analyzer.js";
import backtestRouter from "./routes/backtest.js";
import tushareRouter from "./routes/tushare.js";
import akshareRouter from "./routes/akshare.js";
import dceApiRouter from "./routes/dceApi.js";
import externalDataRouter from "./routes/externalData.js";
import trainingRouter from "./routes/training.js";
import monitorRouter from "./routes/monitor.js";
import eventMonitorRouter from "./routes/eventMonitor.js";
import paperTradingRouter from "./routes/paperTrading.js";
import newsRouter from "./routes/news.js";
import journalRouter from "./routes/journal.js";
import eventDailyRouter from "./routes/eventDaily.js";
import { scanPropagationAlerts } from "./services/eventMonitorService.js";
import strategyOptimizationRouter from "./routes/strategyOptimization.js";
import mlOptimizationRouter from "./routes/mlOptimization.js";
import modelMonitoringRouter from "./routes/modelMonitoring.js";
import portfolioRouter from "./routes/portfolio.js";
import varietyExpansionRouter from "./routes/varietyExpansion.js";
import portfolioRiskRouter from "./routes/portfolioRisk.js";
import optimizationDashboardRouter from "./routes/optimizationDashboard.js";
import { initScheduler } from "./services/scheduler.js";
import { waitForDbInit } from "./services/database.js";
import { initTradingTables } from "./services/tradingRecord.js";
import { syncFromFeishu } from "./scripts/syncFromFeishu.js";
import { createLogger } from "./utils/logger.js";

const log = createLogger('http');

const app = express();
const port = process.env.PORT || 9091;

// Middleware
// CORS 白名单：本地开发端口 + 部署域名（*.coze.site）
// 注意：RN 移动端 fetch 不携带 Origin 头，不受 CORS 约束，直接放行
const allowedOriginPatterns: RegExp[] = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https:\/\/[a-z0-9-]+\.dev\.coze\.site$/,
  /^https:\/\/[a-z0-9-]+\.coze\.site$/,
];
// 支持通过环境变量追加前端域名（精确匹配）
const extraOrigin = process.env.FRONTEND_URL;
if (extraOrigin) {
  const escaped = extraOrigin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  allowedOriginPatterns.push(new RegExp(`^${escaped}$`));
}
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true); // 无 Origin 头：移动端 / 服务端间调用
    if (allowedOriginPatterns.some(re => re.test(origin))) return callback(null, true);
    callback(new Error(`CORS origin not allowed: ${origin}`));
  },
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/api/v1/health', (req, res) => {
  log.debug('Health check success');
  res.status(200).json({ status: 'ok' });
});

// Routes（单用户本地工具：已移除 JWT 认证体系，所有路由直接公开）
app.use('/api/v1/variety', varietyRouter); // 品种列表公开
app.use('/api/v1/dce', dceRouter); // 大商所数据公开
app.use('/api/v1/dce-api', dceApiRouter); // 大商所官方API公开
app.use('/api/v1/tushare', tushareRouter); // Tushare数据公开
app.use('/api/v1/akshare', akshareRouter); // AKShare数据公开
app.use('/api/v1/external', externalDataRouter); // 外部数据公开
app.use('/api/v1/news', newsRouter); // 方案 C：实时新闻接入（必须在 scanRouter 之前）
app.use('/api/v1', scanRouter); // 扫描数据公开（路由内部已包含 /scan 前缀）
app.use('/api/v1/analyzer', analyzerRouter); // 深度分析公开
app.use('/api/v1/capital-flow', capitalFlowRouter); // 资金流向公开
app.use('/api/v1/supply-demand', supplyDemandRouter); // 供需分析公开
app.use('/api/v1/feishu', feishuRouter); // 飞书数据公开
app.use('/api/v1/ai', aiRouter); // AI助手公开
app.use('/api/v1/optimization', optimizationRouter); // 优化分析公开（品种分级、组合推荐、共振分析、交易建议）

// 此前为 authMiddleware 保护路由，认证体系拆除后全部开放
app.use('/api/v1/trading', tradingRouter);
app.use('/api/v1/trading-cost', tradingCostRouter);
app.use('/api/v1/history', historyRouter);
app.use('/api/v1/history-collect', historyCollectRouter);
app.use('/api/v1/alerts', alertsRouter);
app.use('/api/v1/technical', technicalRouter);
app.use('/api/v1/circuit-breaker', circuitBreakerRouter);
app.use('/api/v1/spot-price', spotPriceRouter);
app.use('/api/v1/training', trainingRouter); // 训练模块公开
app.use('/api/v1/backtest', backtestRouter); // 回测引擎公开
app.use('/api/v1/monitor', monitorRouter); // 交易监控（机会/持仓提醒）
app.use('/api/v1/event-monitor', eventMonitorRouter); // 事件驱动传播链监控
app.use('/api/v1/paper-trading', paperTradingRouter); // v15 策略模拟盘
app.use('/api/v1', journalRouter); // 每日信号日报 + 模拟交易
app.use('/api/v1/event-daily', eventDailyRouter); // 事件驱动日报（黑天鹅事件综合分析 + 复盘沉淀）
app.use('/api/v1/strategy-optimization', strategyOptimizationRouter); // 策略优化分析
app.use('/api/v1/ml-optimization', mlOptimizationRouter); // 机器学习优化
app.use('/api/v1/model-monitoring', modelMonitoringRouter); // 模型监控
app.use('/api/v1/portfolio', portfolioRouter); // 全品种组合分析
app.use('/api/v1/variety-expansion', varietyExpansionRouter); // 品种扩展管理
app.use('/api/v1/portfolio-risk', portfolioRiskRouter); // 组合风控监控
app.use('/api/v1/optimization-dashboard', optimizationDashboardRouter); // 优化仪表板

// 404 处理：未匹配的 API 请求返回 JSON（而非 Express 默认 HTML），避免前端解析失败
app.use('/api/v1', (req, res) => {
  res.status(404).json({ success: false, error: `接口不存在: ${req.method} ${req.originalUrl}` });
});

// 全局错误处理中间件：统一返回 JSON 格式错误
// 覆盖场景：路由同步抛错、next(err) 传递、body-parser JSON 解析失败等
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // body-parser JSON 解析错误
  if (err?.type === 'entity.parse.failed') {
    res.status(400).json({ success: false, error: '请求体 JSON 格式错误' });
    return;
  }
  // 请求体过大
  if (err?.type === 'entity.too.large') {
    res.status(413).json({ success: false, error: '请求体过大' });
    return;
  }
  log.error(`[API Error] ${req.method} ${req.path}:`, err?.message || err);
  const status = err?.status || err?.statusCode || 500;
  res.status(status).json({
    success: false,
    error: err?.message || '服务器内部错误，请稍后重试',
  });
});

// Wait for database initialization before starting server
async function startServer() {
  try {
    await waitForDbInit();
    log.info('Database initialized successfully');
    
    // Initialize trading tables after database is ready
    initTradingTables();
    log.info('Trading tables initialized');
    
    // Skip Feishu sync - data already in database
    // Feishu sync requires lark-cli configuration which may not be available
    log.info('Skipping Feishu sync (using existing database data)');
    
    const host = '0.0.0.0';
    const listenPort = Number(port) || 9091;
    app.listen(listenPort, host, () => {
      log.info(`Server listening at http://${host}:${listenPort}/`);
      // 初始化定时任务
      initScheduler();
      // 异步预加载 V16 扫描缓存（不阻塞服务启动，失败静默降级）
      preloadScanCache().catch((err) => {
        log.error('[Bootstrap] 预加载扫描失败:', err);
      });
      // 异步预热 30 分钟 K 线缓存（为 AI 分析提供数据）
      preload30mCache().catch((err) => {
        log.error('[Bootstrap] 30 分钟缓存预热失败:', err);
      });
      // 定时续热 scan 缓存（每 10 分钟后台刷新，避免缓存过期后首次请求白屏 20s+）
      startScanCacheRefresh();
      // 预加载传播链预警扫描（读取本地日线缓存，同步执行，速度很快）
      Promise.resolve()
        .then(() => scanPropagationAlerts())
        .catch((err) => {
          log.error('[Bootstrap] 传播链预警预加载失败:', err);
        });
    });
  } catch (error) {
    log.error('Failed to initialize database:', error);
    process.exit(1);
  }
}

startServer();
