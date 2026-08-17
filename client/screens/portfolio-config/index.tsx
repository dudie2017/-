import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Dimensions,
  TextInput,
  Modal,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { LineChart } from 'react-native-gifted-charts';


interface Backtest {
  startDate: string;
  endDate: string;
  tradingDays: number;
  totalReturn: number;
  maxDrawdown: number;
  annualizedReturn: number;
  sharpe: number;
  navCurve: number[];
}

interface CostImpact {
  breakEvenCost: number;
  erosionPer1k: number | null;
  scenarios: {
    label: string;
    cost: number;
    netReturn: number;
    netSharpe: number;
  }[];
}

interface SchemeConfig {
  weights: number[];
  return: number;
  volatility: number;
  sharpe: number;
  backtest?: Backtest;
  costImpact?: CostImpact;
}

interface PortfolioConfig {
  equalWeight: SchemeConfig;
  riskParity: SchemeConfig;
  maxSharpe: SchemeConfig;
  bestSingle?: {
    code: string;
    name: string;
    return: number;
    volatility: number;
    sharpe: number;
    costImpact?: CostImpact;
  };
}

interface Variety {
  code: string;
  name: string;
  sector: string;
}

interface OosSchemeStats {
  name: string;
  inSharpe: number;
  oosSharpe: number;
  winRate: number; // 正收益概率（%）
  mean: number; // 收益均值（元）
  worst: number; // 最差单次（元）
  var95: number; // 5% VaR（元）
  cvar95: number; // 5% CVaR（元）
  overfitDecay: number; // 过拟合衰减
}

interface OosStatsData {
  generatedAt: string;
  nBootstrap: number;
  trainSize: number;
  topRatio: number;
  shrinkAlpha: number;
  schemes: {
    equalWeight: OosSchemeStats;
    riskParity: OosSchemeStats;
    maxSharpe: OosSchemeStats;
    bestSingle?: OosSchemeStats;
    momentum?: OosSchemeStats;
  };
}

interface TimeSeriesOosScheme {
  name: string;
  trainSharpe: number;
  testSharpe: number;
  decay: number; // 衰减 = trainSharpe - testSharpe
  testAnnualReturn: number; // 测试期年化收益（元/手）
  testVolatility: number; // 测试期波动率（元/手）
  testWinMonths: number; // 测试期正收益月占比（%）
}

interface TimeSeriesRebalanceScheme {
  name: string;
  sharpe: number;
  annualReturn: number; // 年化收益（净值口径，0.218 = 21.8%）
  maxDrawdown: number; // 最大回撤（净值口径，0.173 = 17.3%）
  turnoverPerYear: number; // 年换手率
  costPerYear: number; // 年换仓成本（元/手）
  navCurve: number[];
}

interface TimeSeriesData {
  generatedAt: string;
  nVarieties: number;
  months: number;
  splitRatio: number;
  warmupMonths: number;
  window: { start: string; end: string; total: number };
  timeSeriesOOS: {
    equalWeight: TimeSeriesOosScheme;
    riskParity: TimeSeriesOosScheme;
    maxSharpe: TimeSeriesOosScheme;
  };
  dynamicRebalance: {
    equalWeight: TimeSeriesRebalanceScheme;
    riskParity: TimeSeriesRebalanceScheme;
    maxSharpe: TimeSeriesRebalanceScheme;
  };
}

interface ConfigData {
  portfolios: PortfolioConfig;
  varieties: Variety[];
  oosStats?: OosStatsData | null;
  timeSeries?: TimeSeriesData | null;
}

export function PortfolioConfigContent() {
  const [data, setData] = useState<ConfigData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeConfig, setActiveConfig] = useState<'equalWeight' | 'riskParity' | 'maxSharpe' | 'custom'>('riskParity');
  const [applyingConfig, setApplyingConfig] = useState(false);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [customWeightsModal, setCustomWeightsModal] = useState(false);
  const [customWeights, setCustomWeights] = useState<{ code: string; weight: number }[]>([]);
  const [customResult, setCustomResult] = useState<{ return: number; volatility: number; sharpe: number } | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/configurations`);
      const result = await response.json();
      if (result.success) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error || '加载配置数据失败');
      }
    } catch (err) {
      console.error('Error fetching configurations:', err);
      setError('网络异常，无法加载配置数据');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
    }, [fetchData])
  );

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  /**
   * 服务端文件：server/src/routes/portfolio.ts
   * 接口：POST /api/v1/portfolio/apply-config
   * Body 参数：configName: 'equalWeight' | 'riskParity' | 'maxSharpe'
   */
  const handleApplyConfig = useCallback(async () => {
    setApplyingConfig(true);
    setApplyResult(null);
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/apply-config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ configName: activeConfig }),
      });
      const result = await response.json();
      if (result.success) {
        const { opened, failed } = result.data;
        const names = opened.map((t: { name?: string; code: string }) => t.name || t.code).join('、');
        setApplyResult(
          `已生成模拟盘：开仓 ${opened.length} 个品种${failed.length ? `，${failed.length} 个失败` : ''}（${names}）`
        );
      } else {
        setApplyResult(result.error || '生成模拟盘失败');
      }
    } catch (err) {
      setApplyResult('网络异常，生成模拟盘失败');
    } finally {
      setApplyingConfig(false);
    }
  }, [activeConfig]);

  /**
   * 服务端文件：server/src/routes/portfolio.ts
   * 接口：POST /api/v1/portfolio/custom-weights
   * Body 参数：weights: { code: string, weight: number }[]
   */
  const handleCalculateCustomWeights = useCallback(async () => {
    if (customWeights.length === 0) {
      setCustomResult(null);
      return;
    }
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/custom-weights`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weights: customWeights }),
      });
      const result = await response.json();
      if (result.success) {
        setCustomResult(result.data);
      } else {
        console.error('计算自定义权重失败:', result.error);
      }
    } catch (err) {
      console.error('计算自定义权重失败:', err);
    }
  }, [customWeights]);

  const handleOpenCustomModal = useCallback(() => {
    // 初始化自定义权重（从当前配置的权重）
    const currentConfig = data?.portfolios[activeConfig as 'equalWeight' | 'riskParity' | 'maxSharpe'];
    if (currentConfig && data?.varieties) {
      const initialWeights = data.varieties.slice(0, 10).map((v, i) => ({
        code: v.code,
        weight: currentConfig.weights?.[i] ?? 0.1,
      }));
      setCustomWeights(initialWeights);
    }
    setCustomWeightsModal(true);
  }, [data, activeConfig]);

  const configLabels = {
    equalWeight: { name: '均衡型', desc: '等权重配置', color: '#00F0FF' },
    riskParity: { name: '保守型', desc: '风险平价', color: '#00FF88' },
    maxSharpe: { name: '进取型', desc: '最大夏普', color: '#BF00FF' },
    custom: { name: '自定义', desc: '手动配置', color: '#FF9F43' },
  };

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0A0A0F' }}>
          <ActivityIndicator size="large" color="#00F0FF" />
          <Text style={{ marginTop: 16, color: '#AAA' }}>加载中...</Text>
        </View>
      </Screen>
    );
  }

  if (error && !data) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#0A0A0F' }}>
          <Text style={{ color: '#FF4444', fontSize: 18, fontWeight: 'bold' }}>加载失败</Text>
          <Text style={{ color: '#AAA', fontSize: 14, marginTop: 8, textAlign: 'center' }}>{error}</Text>
          <TouchableOpacity
            onPress={() => {
              setLoading(true);
              setError(null);
              fetchData();
            }}
            style={{ marginTop: 20, backgroundColor: '#00F0FF', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 }}
          >
            <Text style={{ color: '#0A0A0F', fontWeight: 'bold' }}>重试</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  const currentConfig = activeConfig !== 'custom' ? data?.portfolios[activeConfig] : null;
  const configInfo = configLabels[activeConfig];

  return (
    <>
      <View style={{ flex: 1, backgroundColor: '#0A0A0F' }}>
        {/* Header */}
        <View style={{ backgroundColor: '#12121A', padding: 20, paddingTop: 60, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
          <Text style={{ color: '#00F0FF', fontSize: 24, fontWeight: 'bold' }}>
            组合配置建议
          </Text>
          <Text style={{ color: '#C8C8D8', fontSize: 14, marginTop: 8 }}>
            三种风险偏好配置方案
          </Text>
        </View>

        {/* Config Type Selector */}
        <View style={{ flexDirection: 'row', padding: 16, gap: 12 }}>
          {Object.entries(configLabels).map(([key, info]) => {
            const active = activeConfig === key;
            return (
              <TouchableOpacity
                key={key}
                style={{
                  flex: 1,
                  padding: 12,
                  backgroundColor: active ? info.color : '#12121A',
                  borderRadius: 12,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: active ? info.color : '#1E1E2E',
                }}
                onPress={() => {
                  if (key === 'custom') {
                    handleOpenCustomModal();
                  } else {
                    setActiveConfig(key as any);
                  }
                }}
              >
                <Text style={{
                  color: active ? '#0A0A0F' : '#C8C8D8',
                  fontWeight: 'bold',
                  fontSize: 14,
                }}>
                  {info.name}
                </Text>
                <Text style={{
                  color: active ? '#0A0A0F' : '#888',
                  fontSize: 11,
                  marginTop: 4,
                  opacity: active ? 0.85 : 1,
                }}>
                  {info.desc}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Content */}
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={{ padding: 16, gap: 16 }}>
            {/* Performance Metrics */}
            {currentConfig && (
              <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: configInfo.color }}>
                  {configInfo.name}配置
                </Text>

                <View style={{ flexDirection: 'row', gap: 16, marginBottom: 16 }}>
                  <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                    <Text style={{ color: '#888', fontSize: 12 }}>预期收益</Text>
                    <Text style={{ color: currentConfig.return < 0 ? '#FF4444' : '#00FF88', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                      {(currentConfig.return / 10000).toFixed(2)}
                      <Text style={{ fontSize: 12, color: '#888' }}> 万</Text>
                    </Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                    <Text style={{ color: '#888', fontSize: 12 }}>波动率</Text>
                    <Text style={{ color: '#BF00FF', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                      {(currentConfig.volatility / 10000).toFixed(2)}
                      <Text style={{ fontSize: 12, color: '#888' }}> 万</Text>
                    </Text>
                  </View>
                </View>

                <View style={{ backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                  <Text style={{ color: '#888', fontSize: 12 }}>夏普比率</Text>
                  <Text style={{ color: currentConfig.sharpe < 0 ? '#FF4444' : '#00F0FF', fontSize: 24, fontWeight: 'bold', marginTop: 4 }}>
                    {currentConfig.sharpe.toFixed(3)}
                  </Text>
                  {currentConfig.sharpe < 0 && (
                    <Text style={{ color: '#FF4444', fontSize: 12, marginTop: 4 }}>
                      负夏普：预期收益为负，谨慎配置
                    </Text>
                  )}
                </View>

                <TouchableOpacity
                  onPress={handleApplyConfig}
                  disabled={applyingConfig}
                  style={{
                    marginTop: 16,
                    backgroundColor: applyingConfig ? '#2A2A3A' : configInfo.color,
                    paddingVertical: 14,
                    borderRadius: 10,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: applyingConfig ? '#888' : '#0A0A0F', fontWeight: 'bold', fontSize: 15 }}>
                    {applyingConfig ? '生成中...' : '一键生成模拟盘'}
                  </Text>
                </TouchableOpacity>
                {applyResult && (
                  <Text style={{ color: '#00FF88', fontSize: 12, marginTop: 10, lineHeight: 18 }}>{applyResult}</Text>
                )}
              </View>
            )}

            {/* 组合历史回测净值对比 */}
            {data?.portfolios && <NavCurveChart portfolios={data.portfolios} />}

            {/* Best Single Benchmark */}
            {data?.portfolios?.bestSingle && (
              <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#BF00FF' }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 4, color: '#BF00FF' }}>
                  单品种最优 · 对照基准
                </Text>
                <Text style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
                  全押夏普最高单品种「{data.portfolios.bestSingle.name}」的样本外表现，用于对照分散配置的真实代价
                </Text>
                <View style={{ flexDirection: 'row', gap: 12 }}>
                  <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
                    <Text style={{ color: '#888', fontSize: 12 }}>预期收益</Text>
                    <Text style={{ color: '#00FF88', fontSize: 18, fontWeight: 'bold', marginTop: 4 }}>
                      {(data.portfolios.bestSingle.return / 10000).toFixed(2)}
                      <Text style={{ fontSize: 11, color: '#888' }}> 万</Text>
                    </Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
                    <Text style={{ color: '#888', fontSize: 12 }}>波动率</Text>
                    <Text style={{ color: '#BF00FF', fontSize: 18, fontWeight: 'bold', marginTop: 4 }}>
                      {(data.portfolios.bestSingle.volatility / 10000).toFixed(2)}
                      <Text style={{ fontSize: 11, color: '#888' }}> 万</Text>
                    </Text>
                  </View>
                  <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
                    <Text style={{ color: '#888', fontSize: 12 }}>夏普</Text>
                    <Text style={{ color: '#00F0FF', fontSize: 18, fontWeight: 'bold', marginTop: 4 }}>
                      {data.portfolios.bestSingle.sharpe.toFixed(3)}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* 样本外稳健性 */}
            {activeConfig !== 'custom' && data?.oosStats?.schemes[activeConfig] && (
              <OosStatsCard
                stats={data.oosStats.schemes[activeConfig]}
                color={configInfo.color}
                nBootstrap={data.oosStats.nBootstrap}
              />
            )}

            {/* 交易成本敏感性 */}
            {currentConfig?.costImpact && (
              <CostImpactCard costImpact={currentConfig.costImpact} color={configInfo.color} />
            )}

            {/* 时间序列稳健性 */}
            {data?.timeSeries && <TimeSeriesCard data={data.timeSeries} />}

            {/* Top Holdings */}
            {currentConfig && data && (
              <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#E8E8ED' }}>
                  重点持仓品种
                </Text>

                {/* Sort by weight and show top 10 */}
                {currentConfig.weights
                  .map((weight: number, index: number) => ({ weight, variety: data.varieties[index] }))
                  .filter((item: any) => item.weight > 0)
                  .sort((a: any, b: any) => b.weight - a.weight)
                  .slice(0, 10)
                  .map((item: any, index: number) => (
                    <View
                      key={item.variety.code}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        paddingVertical: 12,
                        borderBottomWidth: index < 9 ? 1 : 0,
                        borderBottomColor: '#1E1E2E',
                      }}
                    >
                      <Text style={{ width: 30, color: '#888', fontSize: 14 }}>{index + 1}</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={{ fontSize: 16, fontWeight: '600', color: '#E8E8ED' }}>{item.variety.name}</Text>
                        <Text style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                          {item.variety.code} · {item.variety.sector}
                        </Text>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <Text style={{ fontSize: 18, fontWeight: 'bold', color: configInfo.color }}>
                          {(item.weight * 100).toFixed(1)}%
                        </Text>
                      </View>
                    </View>
                  ))}
              </View>
            )}

            {/* Recommendation */}
            <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
              <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 12, color: '#E8E8ED' }}>配置建议</Text>
              {activeConfig === 'riskParity' && (
                <Text style={{ color: '#C8C8D8', lineHeight: 24 }}>
                  适合稳健型投资者。通过风险平价方法，使每个品种对组合的风险贡献相等，降低单一品种波动对整体组合的影响。建议搭配跨品种套利策略增强收益。
                </Text>
              )}
              {activeConfig === 'equalWeight' && (
                <Text style={{ color: '#C8C8D8', lineHeight: 24 }}>
                  适合平衡型投资者。简单等权重配置，分散化程度高，易于理解和执行。定期再平衡可维持风险分散效果。
                </Text>
              )}
              {activeConfig === 'maxSharpe' && (
                <Text style={{ color: '#C8C8D8', lineHeight: 24 }}>
                  适合进取型投资者。追求单位风险下的最高收益，集中配置高效品种。波动较大，需要较强的风险承受能力。建议搭配板块轮动策略。
                </Text>
              )}
            </View>
          </View>
        </ScrollView>

        {/* 自定义权重 Modal */}
        <CustomWeightsModal
          visible={customWeightsModal}
          onClose={() => setCustomWeightsModal(false)}
          varieties={data?.varieties || []}
          customWeights={customWeights}
          setCustomWeights={setCustomWeights}
          customResult={customResult}
          onCalculate={handleCalculateCustomWeights}
        />
      </View>
    </>
  );
}

export default function PortfolioConfigScreen() {
  return (
    <Screen>
      <PortfolioConfigContent />
    </Screen>
  );
}

// 组合历史回测净值曲线对比（三种配置）
function NavCurveChart({ portfolios }: { portfolios: PortfolioConfig }) {
  const eq = portfolios.equalWeight?.backtest?.navCurve;
  const rp = portfolios.riskParity?.backtest?.navCurve;
  const ms = portfolios.maxSharpe?.backtest?.navCurve;
  if (!eq || !rp || !ms) return null;

  const maxLen = Math.max(eq.length, rp.length, ms.length);
  const pad = (arr: number[]) => {
    const out = [...arr];
    const last = out[out.length - 1] ?? 1;
    while (out.length < maxLen) out.push(last);
    return out;
  };
  // 净值 → 累计收益百分比
  const toPct = (arr: number[]) =>
    pad(arr).map((v) => ({ value: Math.round((v - 1) * 10000) / 100 }));

  const chartWidth = Dimensions.get('window').width - 72;

  return (
    <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E', marginTop: 16 }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 4, color: '#E8E8ED' }}>历史回测净值对比</Text>
      <Text style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>
        基于行情日收益率回测 · 累计收益（%）
      </Text>
      <LineChart
        data={toPct(eq)}
        data2={toPct(rp)}
        data3={toPct(ms)}
        height={180}
        width={chartWidth}
        thickness={2}
        curved
        isAnimated
        hideDataPoints
        adjustToWidth
        color1="#00F0FF"
        color2="#00FF88"
        color3="#BF00FF"
        yAxisTextStyle={{ color: '#888', fontSize: 10 }}
        xAxisLabelsHeight={0}
        noOfSections={4}
        initialSpacing={10}
        endSpacing={10}
      />
      <View style={{ flexDirection: 'row', justifyContent: 'space-around', marginTop: 12 }}>
        <Legend color="#00F0FF" label="均衡（等权）" />
        <Legend color="#00FF88" label="保守（风险平价）" />
        <Legend color="#BF00FF" label="进取（最大夏普）" />
      </View>
    </View>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, marginRight: 6 }} />
      <Text style={{ fontSize: 12, color: '#C8C8D8' }}>{label}</Text>
    </View>
  );
}

// 样本外稳健性卡片（数据来自 configBacktest.ts 的 1000 次 bootstrap 验证）
function OosStatsCard({ stats, color, nBootstrap }: { stats: OosSchemeStats; color: string; nBootstrap: number }) {
  const fmtWan = (v: number) => (v / 10000).toFixed(2);
  const oosColor = stats.oosSharpe < 0 ? '#FF4444' : color;
  return (
    <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#00F0FF' }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 4, color: '#00F0FF' }}>样本外稳健性</Text>
      <Text style={{ fontSize: 12, color: '#888', marginBottom: 16, lineHeight: 18 }}>
        {nBootstrap} 次 Bootstrap 样本外验证（现实口径）：训练/测试各半，度量配置在未见过的数据上的真实表现
      </Text>

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>样本内夏普</Text>
          <Text style={{ color: '#BF00FF', fontSize: 19, fontWeight: 'bold', marginTop: 4 }}>{stats.inSharpe.toFixed(2)}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>样本外夏普</Text>
          <Text style={{ color: oosColor, fontSize: 19, fontWeight: 'bold', marginTop: 4 }}>{stats.oosSharpe.toFixed(2)}</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>过拟合衰减</Text>
          <Text style={{ color: '#FF9F43', fontSize: 19, fontWeight: 'bold', marginTop: 4 }}>{stats.overfitDecay.toFixed(2)}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>正收益概率</Text>
          <Text style={{ color: '#00FF88', fontSize: 17, fontWeight: 'bold', marginTop: 4 }}>{stats.winRate.toFixed(1)}%</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>最差单次</Text>
          <Text style={{ color: '#FF4444', fontSize: 17, fontWeight: 'bold', marginTop: 4 }}>
            {fmtWan(stats.worst)}
            <Text style={{ fontSize: 11, color: '#888' }}> 万</Text>
          </Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>5% CVaR</Text>
          <Text style={{ color: '#FF4444', fontSize: 17, fontWeight: 'bold', marginTop: 4 }}>
            {fmtWan(stats.cvar95)}
            <Text style={{ fontSize: 11, color: '#888' }}> 万</Text>
          </Text>
        </View>
      </View>

      <Text style={{ color: '#888', fontSize: 11, marginTop: 12, lineHeight: 16 }}>
        过拟合衰减 = 样本内夏普 − 样本外夏普，越小越稳健；正收益概率、最差单次与 5% CVaR 反映尾部风险。
      </Text>
    </View>
  );
}

// 交易成本敏感性卡片（数据来自 generateFullAnalysis.ts 的 costImpact 字段）
function CostImpactCard({ costImpact, color }: { costImpact: CostImpact; color: string }) {
  const fmtWan = (v: number) => (v / 10000).toFixed(2);
  return (
    <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: color }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 4, color }}>交易成本敏感性</Text>
      <Text style={{ fontSize: 12, color: '#888', marginBottom: 16, lineHeight: 18 }}>
        额外换仓摩擦对累计每手净收益的侵蚀（收益已含单品种交易成本）
      </Text>

      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>盈亏平衡成本</Text>
          <Text style={{ color: '#00FF88', fontSize: 19, fontWeight: 'bold', marginTop: 4 }}>
            {fmtWan(costImpact.breakEvenCost)}
            <Text style={{ fontSize: 11, color: '#888' }}> 万</Text>
          </Text>
          <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>收益被完全吃光的临界值</Text>
        </View>
        <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
          <Text style={{ color: '#888', fontSize: 12 }}>每千元侵蚀率</Text>
          <Text style={{ color: '#FF9F43', fontSize: 19, fontWeight: 'bold', marginTop: 4 }}>
            {costImpact.erosionPer1k == null ? '—' : `${costImpact.erosionPer1k.toFixed(2)}%`}
          </Text>
          <Text style={{ color: '#888', fontSize: 10, marginTop: 2 }}>每多 1000 元换仓成本的收益损失</Text>
        </View>
      </View>

      {costImpact.scenarios.map((s, index) => (
        <View
          key={s.label}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingVertical: 10,
            borderBottomWidth: index < costImpact.scenarios.length - 1 ? 1 : 0,
            borderBottomColor: '#1E1E2E',
          }}
        >
          <Text style={{ width: 56, color: '#C8C8D8', fontSize: 13 }}>{s.label}</Text>
          <Text style={{ width: 74, color: '#888', fontSize: 12 }}>成本 {s.cost} 元</Text>
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Text style={{ color: s.netReturn < 0 ? '#FF4444' : '#00FF88', fontSize: 14, fontWeight: 'bold' }}>
              净收益 {fmtWan(s.netReturn)} 万
            </Text>
            <Text style={{ color: s.netSharpe < 0 ? '#FF4444' : '#888', fontSize: 12, marginTop: 2 }}>
              净夏普 {s.netSharpe.toFixed(2)}
            </Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const TS_SCHEMES = ['equalWeight', 'riskParity', 'maxSharpe'] as const;
const TS_COLORS: Record<string, string> = {
  equalWeight: '#00F0FF',
  riskParity: '#00FF88',
  maxSharpe: '#FF9F43',
};

function TimeSeriesCard({ data }: { data: TimeSeriesData }) {
  const trainMonths = Math.round(data.months * data.splitRatio);
  const testMonths = data.months - trainMonths;
  return (
    <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#00F0FF' }}>
      <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 4, color: '#00F0FF' }}>
        时间序列稳健性
      </Text>
      <Text style={{ fontSize: 12, color: '#888', marginBottom: 16, lineHeight: 16 }}>
        前 {trainMonths} 月训练 / 后 {testMonths} 月测试（共 {data.nVarieties} 个有长历史的品种）。时间切分而非随机，消除 bootstrap 数据泄漏；动态再平衡按月滚动重估权重。
      </Text>

      <Text style={{ color: '#C8C8D8', fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>
        训练 → 测试（时间切分 OOS）
      </Text>
      {TS_SCHEMES.map((k) => {
        const s = data.timeSeriesOOS[k];
        return (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
            <Text style={{ width: 52, color: TS_COLORS[k], fontSize: 13, fontWeight: 'bold' }}>{s.name}</Text>
            <Text style={{ flex: 1, color: '#C8C8D8', fontSize: 13 }}>
              夏普 {s.trainSharpe.toFixed(2)} → {s.testSharpe.toFixed(2)}
            </Text>
            <Text style={{ color: s.decay > 0.3 ? '#FF9F43' : '#00FF88', fontSize: 13, fontWeight: 'bold' }}>
              {s.decay > 0.3 ? `衰减 ${s.decay.toFixed(2)}` : '稳健'}
            </Text>
          </View>
        );
      })}
      <Text style={{ color: '#888', fontSize: 11, marginTop: 6, marginBottom: 18, lineHeight: 15 }}>
        衰减 = 训练夏普 − 测试夏普，正值越大越过拟合；负值表示测试期反而更好。
      </Text>

      <Text style={{ color: '#C8C8D8', fontSize: 13, fontWeight: 'bold', marginBottom: 8 }}>
        动态再平衡（月度滚动 + 换仓成本）
      </Text>
      {TS_SCHEMES.map((k) => {
        const s = data.dynamicRebalance[k];
        return (
          <View key={k} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
            <Text style={{ width: 52, color: TS_COLORS[k], fontSize: 13, fontWeight: 'bold' }}>{s.name}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#C8C8D8', fontSize: 13 }}>
                年化 {(s.annualReturn * 100).toFixed(1)}% · 夏普 {s.sharpe.toFixed(2)}
              </Text>
              <Text style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
                回撤 {(s.maxDrawdown * 100).toFixed(1)}% · 年换手 {s.turnoverPerYear.toFixed(1)} · 换仓 {s.costPerYear.toFixed(0)} 元/手/年
              </Text>
            </View>
          </View>
        );
      })}
      <Text style={{ color: '#888', fontSize: 11, marginTop: 8, lineHeight: 15 }}>
        动态再平衡按「各品种 1 手」组合的月度盈亏复利计算，已扣除换仓成本。这是配置建议在时间序列上的真实落地表现。
      </Text>
    </View>
  );
}

// 自定义权重编辑器 Modal
function CustomWeightsModal({
  visible,
  onClose,
  varieties,
  customWeights,
  setCustomWeights,
  customResult,
  onCalculate,
}: {
  visible: boolean;
  onClose: () => void;
  varieties: { code: string; name: string }[];
  customWeights: { code: string; weight: number }[];
  setCustomWeights: (w: { code: string; weight: number }[]) => void;
  customResult: { return: number; volatility: number; sharpe: number } | null;
  onCalculate: () => void;
}) {
  if (!visible) return null;

  const handleAddVariety = (code: string) => {
    if (customWeights.find((w) => w.code === code)) return;
    setCustomWeights([...customWeights, { code, weight: 0.1 }]);
  };

  const handleRemoveVariety = (code: string) => {
    setCustomWeights(customWeights.filter((w) => w.code !== code));
  };

  const handleWeightChange = (code: string, weight: string) => {
    const w = parseFloat(weight) || 0;
    setCustomWeights(customWeights.map((item) => (item.code === code ? { ...item, weight: w } : item)));
  };

  const availableVarieties = varieties.filter((v) => !customWeights.find((w) => w.code === v.code));
  const totalWeight = customWeights.reduce((sum, w) => sum + w.weight, 0);

  return (
    <Modal visible={visible} transparent animationType="slide">
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'flex-end' }}>
        <View style={{ backgroundColor: '#0A0A0F', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%' }}>
          <View style={{ padding: 20, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
            <Text style={{ fontSize: 20, fontWeight: 'bold', color: '#FF9F43' }}>自定义权重配置</Text>
            <Text style={{ fontSize: 12, color: '#888', marginTop: 4 }}>手动选择品种并分配权重，实时计算组合指标</Text>
          </View>

          <ScrollView style={{ maxHeight: 400 }}>
            <View style={{ padding: 20, gap: 12 }}>
              {/* 已选品种 */}
              {customWeights.map((item) => {
                const variety = varieties.find((v) => v.code === item.code);
                return (
                  <View key={item.code} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 12, borderRadius: 8 }}>
                      <Text style={{ color: '#E8E8ED', fontSize: 14, fontWeight: 'bold' }}>{item.code}</Text>
                      <Text style={{ color: '#888', fontSize: 11 }}>{variety?.name}</Text>
                    </View>
                    <View style={{ width: 100 }}>
                      <Text style={{ color: '#888', fontSize: 11, marginBottom: 4 }}>权重</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: '#1A1A2E', borderRadius: 8, padding: 8 }}>
                        <TextInput
                          value={String(item.weight)}
                          onChangeText={(t) => handleWeightChange(item.code, t)}
                          keyboardType="numeric"
                          style={{ color: '#FF9F43', fontSize: 14, fontWeight: 'bold', flex: 1 }}
                        />
                      </View>
                    </View>
                    <TouchableOpacity onPress={() => handleRemoveVariety(item.code)} style={{ padding: 8 }}>
                      <Text style={{ color: '#FF4444', fontSize: 18 }}>×</Text>
                    </TouchableOpacity>
                  </View>
                );
              })}

              {/* 添加品种 */}
              {availableVarieties.length > 0 && (
                <View style={{ marginTop: 12 }}>
                  <Text style={{ color: '#888', fontSize: 12, marginBottom: 8 }}>添加品种</Text>
                  <View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      <View style={{ flexDirection: 'row', gap: 8 }}>
                        {availableVarieties.slice(0, 20).map((v) => (
                          <TouchableOpacity
                            key={v.code}
                            onPress={() => handleAddVariety(v.code)}
                            style={{ paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#1A1A2E', borderRadius: 8 }}
                          >
                            <Text style={{ color: '#00F0FF', fontSize: 12 }}>{v.code}</Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                </View>
              )}

              {/* 权重总和 */}
              <View style={{ marginTop: 12, padding: 12, backgroundColor: '#1A1A2E', borderRadius: 8 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>权重总和</Text>
                <Text style={{ color: Math.abs(totalWeight - 1) < 0.01 ? '#00FF88' : '#FF9F43', fontSize: 18, fontWeight: 'bold', marginTop: 4 }}>
                  {(totalWeight * 100).toFixed(1)}%
                </Text>
                {Math.abs(totalWeight - 1) > 0.01 && (
                  <Text style={{ color: '#FF9F43', fontSize: 11, marginTop: 4 }}>
                    权重总和应为 100%，系统将自动归一化
                  </Text>
                )}
              </View>

              {/* 计算结果 */}
              {customResult && (
                <View style={{ marginTop: 12, padding: 16, backgroundColor: '#12121A', borderRadius: 12, borderWidth: 1, borderColor: '#FF9F43' }}>
                  <Text style={{ color: '#FF9F43', fontSize: 14, fontWeight: 'bold', marginBottom: 12 }}>组合指标</Text>
                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#888', fontSize: 11 }}>预期收益</Text>
                      <Text style={{ color: customResult.return < 0 ? '#FF4444' : '#00FF88', fontSize: 16, fontWeight: 'bold' }}>
                        {(customResult.return / 10000).toFixed(2)}万
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#888', fontSize: 11 }}>波动率</Text>
                      <Text style={{ color: '#BF00FF', fontSize: 16, fontWeight: 'bold' }}>
                        {(customResult.volatility / 10000).toFixed(2)}万
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#888', fontSize: 11 }}>夏普</Text>
                      <Text style={{ color: customResult.sharpe < 0 ? '#FF4444' : '#00F0FF', fontSize: 16, fontWeight: 'bold' }}>
                        {customResult.sharpe.toFixed(3)}
                      </Text>
                    </View>
                  </View>
                </View>
              )}
            </View>
          </ScrollView>

          <View style={{ padding: 20, gap: 12, borderTopWidth: 1, borderTopColor: '#1E1E2E' }}>
            <TouchableOpacity
              onPress={onCalculate}
              disabled={customWeights.length === 0}
              style={{
                backgroundColor: customWeights.length === 0 ? '#2A2A3A' : '#FF9F43',
                paddingVertical: 14,
                borderRadius: 10,
                alignItems: 'center',
              }}
            >
              <Text style={{ color: customWeights.length === 0 ? '#888' : '#0A0A0F', fontWeight: 'bold', fontSize: 15 }}>
                计算组合指标
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose} style={{ paddingVertical: 12, alignItems: 'center' }}>
              <Text style={{ color: '#888', fontSize: 14 }}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}
