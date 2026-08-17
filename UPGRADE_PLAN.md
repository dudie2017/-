# 期货量化系统升级计划

## 当前状态
- 59 个品种经过 15 章深度分析
- 最终入池 3 个品种：CF0（棉花）、CU0（铜）、HC0（热卷）
- 已有分析：成本敏感性、波动率 Regime、风险平价、CVaR、季节性、参数自适应、执行质量

---

## 升级方向一：止损止盈优化

### 目标
优化现有策略的止损止盈参数，提升风险调整后收益。

### 当前参数
```typescript
stopAtrMult: 1.5      // 止损 = 1.5 × ATR
targetAtrMult: 4      // 止盈 = 4 × ATR
maxHoldDays: 40       // 最大持仓天数
minRR: 1.5            // 最小盈亏比
```

### 实施步骤

#### 1.1 参数网格搜索
- 创建 `optimizeStopLoss.ts` 脚本
- 对入池 3 个品种，分别测试：
  - `stopAtrMult`: [1.0, 1.5, 2.0, 2.5, 3.0]
  - `targetAtrMult`: [2.0, 3.0, 4.0, 5.0, 6.0]
  - `minRR`: [1.0, 1.5, 2.0, 2.5]
- 组合总数：5 × 5 × 4 = 100 种参数组合
- 对每个品种跑 100 次回测，记录 Calmar、最大回撤、胜率

#### 1.2 动态止损策略
- 创建 `dynamicStopLoss.ts` 脚本
- 实现以下动态止损逻辑：
  - **移动止损**：盈利超过 1R 后，止损移至成本价
  - **ATR 追踪止损**：止损 = 最高价 - N × ATR（N 可优化）
  - **时间止损**：持仓超过 N 天未达目标，强制平仓
- 对比固定止损 vs 动态止损的效果

#### 1.3 分批止盈
- 创建 `scaledExit.ts` 脚本
- 实现分批止盈逻辑：
  - 达到 1R 时平仓 50%
  - 达到 2R 时平仓 30%
  - 剩余 20% 持有至目标或止损
- 分析分批止盈对收益分布的影响

### 预期产出
- `stopLossOptimization.json`: 最优止损止盈参数
- `dynamicStopLossAnalysis.json`: 动态止损效果对比
- 预期 Calmar 提升 20-50%

### 复杂度：低
- 依赖现有回测引擎
- 无需修改核心策略逻辑
- 预计开发时间：2-3 天

---

## 升级方向二：动态仓位管理

### 目标
根据市场状态动态调整仓位大小，降低回撤。

### 当前状态
- 固定仓位：`maxPositionPct: 0.3`（最大 30% 资金）
- 无动态调整

### 实施步骤

#### 2.1 波动率倒数加权
- 创建 `volatilityWeightedPosition.ts` 脚本
- 实现逻辑：
  ```
  positionSize = baseSize × (targetVol / currentVol)
  ```
  - `targetVol`: 目标年化波动率（如 20%）
  - `currentVol`: 当前 20 日年化波动率
- 波动率高时减仓，波动率低时加仓

#### 2.2 信号强度加权
- 创建 `signalStrengthPosition.ts` 脚本
- 实现逻辑：
  ```
  positionSize = baseSize × signalStrength
  signalStrength = abs(entryPrice - stopLoss) / ATR
  ```
- 信号强（止损远）时加仓，信号弱时减仓

#### 2.3 凯利公式仓位
- 创建 `kellyPosition.ts` 脚本
- 实现逻辑：
  ```
  kellyFraction = (winRate × avgWin - (1-winRate) × avgLoss) / avgWin
  positionSize = baseSize × kellyFraction × 0.5  // 半凯利
  ```
- 根据历史胜率和盈亏比动态调整

#### 2.4 组合层面仓位优化
- 创建 `portfolioPositionOptimizer.ts` 脚本
- 整合风险平价结果，动态调整各品种权重
- 每周/每月再平衡一次

### 预期产出
- `positionSizingAnalysis.json`: 四种仓位策略对比
- 预期最大回撤降低 30-50%

### 复杂度：中
- 需要修改回测引擎的仓位计算逻辑
- 需要实现多种仓位模型
- 预计开发时间：3-5 天

---

## 升级方向三：多时间框架验证

### 目标
在不同 K 线周期上验证策略稳健性，避免单一时间框架过拟合。

### 当前状态
- 仅使用日线数据
- 无多时间框架验证

### 实施步骤

#### 3.1 数据准备
- 创建 `prepareMultiTimeframeData.ts` 脚本
- 将日线数据聚合为：
  - 4 小时线（假设每日 6 小时交易）
  - 1 小时线
  - 周线
- 输出：`{code}_4h.json`, `{code}_1h.json`, `{code}_week.json`

#### 3.2 跨时间框架回测
- 创建 `crossTimeframeBacktest.ts` 脚本
- 对入池 3 个品种，分别在 4 个时间框架上回测：
  - 日线（已有）
  - 4 小时线
  - 1 小时线
  - 周线
- 记录每个时间框架的 Calmar、胜率、交易次数

#### 3.3 时间框架一致性检验
- 创建 `timeframeConsistency.ts` 脚本
- 定义一致性指标：
  ```
  consistencyScore = (盈利时间框架数 / 总时间框架数) × avgCalmar
  ```
- 筛选出在所有时间框架上都盈利的品种
- 输出：`timeframeConsistencyReport.json`

#### 3.4 多时间框架信号融合
- 创建 `multiTimeframeSignal.ts` 脚本
- 实现逻辑：
  - 日线产生入场信号
  - 4 小时线确认趋势方向
  - 1 小时线精确入场时机
- 只有多时间框架信号一致时才入场

### 预期产出
- `multiTimeframeData/`: 多时间框架数据
- `crossTimeframeResults.json`: 跨时间框架回测结果
- `timeframeConsistencyReport.json`: 一致性检验报告
- 预期筛选出 1-2 个真正稳健的品种

### 复杂度：中
- 需要实现数据聚合逻辑
- 需要修改回测引擎支持不同时间框架
- 预计开发时间：4-6 天

---

## 升级方向四：交互式仪表板

### 目标
用 Web 界面展示所有分析结果，提升可视化体验。

### 当前状态
- 所有结果在 Markdown 报告和 JSON 文件中
- 无交互式界面

### 实施步骤

#### 4.1 后端 API 扩展
- 修改 `server/src/index.ts`
- 新增 API 端点：
  ```
  GET /api/v1/analysis/summary          // 所有分析摘要
  GET /api/v1/analysis/cost             // 成本敏感性
  GET /api/v1/analysis/regime           // 波动率 Regime
  GET /api/v1/analysis/seasonality      // 季节性
  GET /api/v1/analysis/variety/:code    // 单品种详情
  ```

#### 4.2 前端页面开发
- 创建 `client/screens/dashboard/`
- 页面结构：
  - **总览页**：入池品种、关键指标、风险概览
  - **品种详情页**：单品种的 15 章分析结果
  - **对比页**：多品种横向对比
  - **组合页**：风险平价配置、相关性矩阵

#### 4.3 可视化组件
- 创建 `client/components/charts/`
- 实现图表：
  - **Calmar 分布图**：59 品种的 Calmar 分布
  - **相关性热力图**：品种间相关性矩阵
  - **月度收益柱状图**：季节性分析
  - **回撤曲线**：历史回撤走势
  - **参数敏感性图**：止损止盈参数影响

#### 4.4 实时更新
- 实现 WebSocket 推送
- 实盘运行时实时更新仪表板

### 预期产出
- 完整的 Web 仪表板
- 支持移动端访问
- 预期提升决策效率 50%

### 复杂度：中
- 需要开发前后端
- 需要实现多种图表组件
- 预计开发时间：5-7 天

---

## 执行顺序建议

```
第 1 周：止损止盈优化（低复杂度，直接提升收益）
第 2 周：动态仓位管理（中复杂度，降低回撤）
第 3 周：多时间框架验证（中复杂度，验证稳健性）
第 4 周：交互式仪表板（中复杂度，提升可视化）
```

## 预期成果

完成所有升级后：
- **入池品种**：从 3 个筛选至 1-2 个（多时间框架验证）
- **Calmar 提升**：20-50%（止损止盈优化）
- **最大回撤降低**：30-50%（动态仓位管理）
- **决策效率**：提升 50%（交互式仪表板）

## 风险与注意事项

1. **过拟合风险**：参数优化可能过拟合历史数据，需用 OOS 验证
2. **数据质量**：多时间框架数据需要验证完整性
3. **性能问题**：仪表板需要优化大数据量渲染
4. **实盘差异**：回测结果与实盘可能有差异，需留有余量
