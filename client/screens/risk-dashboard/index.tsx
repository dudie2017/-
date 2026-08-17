/**
 * 风险仪表盘页面
 * 
 * 展示：
 * - 当前总风险敞口（按板块/品种）
 * - 实时最大回撤 vs 回测预期
 * - 夏普比率实时追踪
 * - 持仓分布统计
 * - 账户级风控检查
 * - 品种相关性矩阵
 * - 持仓集中度预警
 */

import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_BASE, BACKEND_BASE, fetchWithTimeout } from '@/utils/api';

interface GroupExposure {
  count: number;
  totalPosition: number;
  totalPnl: number;
  trades: string[];
}

interface RiskDashboardData {
  summary: {
    totalOpenTrades: number;
    totalClosedTrades: number;
    totalPosition: number;
    longCount: number;
    shortCount: number;
  };
  groupExposure: Record<string, GroupExposure>;
  riskMetrics: {
    maxDrawdown: number;
    sharpeRatio: number;
    avgReturn: number;
    stdDev: number;
  };
  equityCurve: { date: string; equity: number }[];
  gradeDistribution: Record<string, number>;
  adaptiveParams?: {
    pThresholdAdj: number;
    stopAtrMultAdj: number;
    targetAtrMultAdj: number;
    maxHoldDaysAdj: number;
    minScoreAdj: number;
    confidence: number;
    effectivePThreshold: number;
    effectiveStopAtrMult: number;
    effectiveTargetAtrMult: number;
    effectiveMaxHoldDays: number;
    effectiveMinScore: number;
  };
  warnings: string[];
}

interface AccountRiskResult {
  passed: boolean;
  equity: number;
  checks: Array<{
    name: string;
    passed: boolean;
    current: number;
    limit: number;
    message: string;
  }>;
  warnings: string[];
  circuitBreaker: {
    triggered: boolean;
    reason: string;
    cooldownUntil: string | null;
  };
}

interface CorrelationData {
  matrix: Record<string, Record<string, number>>;
  high_correlation_pairs: Array<{
    codeA: string;
    codeB: string;
    correlation: number;
    group: string;
  }>;
  correlated_groups: Record<string, string[]>;
}

interface ConcentrationResult {
  risky: boolean;
  groups: Array<{
    group: string;
    codes: string[];
    ratio: number;
    threshold: number;
  }>;
  suggestions: string[];
}

export function RiskDashboardContent() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<RiskDashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [riskCheck, setRiskCheck] = useState<AccountRiskResult | null>(null);
  const [correlation, setCorrelation] = useState<CorrelationData | null>(null);
  const [concentration, setConcentration] = useState<ConcentrationResult | null>(null);
  const [activeTab, setActiveTab] = useState<'overview' | 'risk' | 'correlation'>('overview');

  const loadData = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/sim-trades/risk-dashboard`);
      const result = await response.json();

      if (result.success) {
        setData(result.data);
        // Load additional risk data
        loadRiskData(result.data);
      } else {
        setError(result.message || '加载失败');
      }
    } catch (e: any) {
      setError(e.message || '网络错误');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const loadRiskData = useCallback(async (dashboardData: RiskDashboardData) => {
    try {
      // Load correlation matrix
      /**
       * 服务端文件：server/src/routes/scan.ts
       * 接口：GET /api/v1/scan/correlation
       * Query 参数：lookback?: number (回看天数，默认120)
       */
      const corrResp = await fetchWithTimeout(`${API_BASE}/scan/correlation?lookback=60`);
      const corrData = await corrResp.json();
      setCorrelation(corrData);

      // Load account risk check if we have open trades
      if (dashboardData.summary.totalOpenTrades > 0) {
        const openTradesResp = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/sim-trades?status=open`);
        const openTradesResult = await openTradesResp.json();
        if (openTradesResult.success && openTradesResult.data?.length > 0) {
          const positions = openTradesResult.data.map((t: any) => ({
            code: t.variety_code,
            direction: t.direction === '多' ? 'long' : 'short',
            lots: t.lots || 1,
            margin: t.margin || 0,
          }));
          const equity = openTradesResult.data[0]?.account_equity || 1000000;

          /**
           * 服务端文件：server/src/routes/scan.ts
           * 接口：POST /api/v1/scan/risk-check
           * Body 参数：positions: PositionInfo[], equity: number, closed_trades?: any[]
           */
          const riskResp = await fetchWithTimeout(`${API_BASE}/scan/risk-check`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ positions, equity, closed_trades: [] }),
          });
          const riskData = await riskResp.json();
          setRiskCheck(riskData);

          // Concentration check
          const codes = positions.map((p: any) => p.code);
          if (codes.length >= 2) {
            /**
             * 服务端文件：server/src/routes/scan.ts
             * 接口：POST /api/v1/scan/concentration-check
             * Body 参数：codes: string[], threshold?: number (默认0.7)
             */
            const concResp = await fetchWithTimeout(`${API_BASE}/scan/concentration-check`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ codes, threshold: 0.7 }),
            });
            const concData = await concResp.json();
            setConcentration(concData);
          }
        }
      }
    } catch (e) {
      console.warn('加载风控数据失败:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  if (loading) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#f59e0b" />
          <Text className="mt-4 text-gray-500">加载风险数据...</Text>
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center p-4">
          <Text className="text-center text-red-500">{error}</Text>
          <TouchableOpacity onPress={() => loadData()} className="mt-4 rounded-lg bg-amber-500 px-6 py-2">
            <Text className="text-white">重试</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  if (!data) return null;

  const { summary, groupExposure, riskMetrics, gradeDistribution, warnings } = data;
  const allWarnings = [
    ...warnings,
    ...(riskCheck?.warnings || []),
    ...(concentration?.risky ? (concentration.suggestions || []) : []),
  ];

  return (
    <>
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => loadData(true)} />
        }
      >
        {/* 标题栏 */}
        <View className="flex-row items-center justify-between bg-gray-50 px-4 py-3 dark:bg-gray-800">
          <TouchableOpacity onPress={() => router.back()}>
            <Text className="text-lg text-amber-500">← 返回</Text>
          </TouchableOpacity>
          <Text className="text-lg font-bold text-gray-900 dark:text-white">风险仪表盘</Text>
          <TouchableOpacity onPress={() => router.push('/performance-report')}>
            <FontAwesome6 name="chart-bar" size={18} color="#f59e0b" />
          </TouchableOpacity>
        </View>

        {/* Tab 切换 */}
        <View className="flex-row px-4 pt-3 gap-2">
          {([
            { key: 'overview' as const, label: '概览', icon: 'eye' },
            { key: 'risk' as const, label: '风控', icon: 'shield-halved' },
            { key: 'correlation' as const, label: '相关性', icon: 'diagram-project' },
          ]).map(tab => (
            <TouchableOpacity
              key={tab.key}
              className={`flex-1 flex-row items-center justify-center py-2 rounded-lg ${activeTab === tab.key ? 'bg-amber-500' : 'bg-gray-100 dark:bg-gray-700'}`}
              onPress={() => setActiveTab(tab.key)}
            >
              <FontAwesome6 name={tab.icon} size={12} color={activeTab === tab.key ? '#fff' : '#9CA3AF'} />
              <Text className={`ml-1 text-xs font-bold ${activeTab === tab.key ? 'text-white' : 'text-gray-500'}`}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 风险警告 */}
        {allWarnings.length > 0 && (
          <View className="mx-4 mt-4 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
            <View className="flex-row items-center mb-2">
              <FontAwesome6 name="triangle-exclamation" size={14} color="#dc2626" />
              <Text className="ml-2 font-bold text-red-600 dark:text-red-400">风险警告</Text>
            </View>
            {allWarnings.map((w, i) => (
              <Text key={i} className="text-sm text-red-600 dark:text-red-400">• {w}</Text>
            ))}
          </View>
        )}

        {/* ===== 概览 Tab ===== */}
        {activeTab === 'overview' && (
          <>
            {/* 概览统计 */}
            <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">持仓概览</Text>
              <View className="flex-row flex-wrap gap-3">
                <StatCard label="持仓数量" value={`${summary.totalOpenTrades}`} />
                <StatCard label="总手数" value={`${summary.totalPosition}`} />
                <StatCard label="多头" value={`${summary.longCount}`} accent="green" />
                <StatCard label="空头" value={`${summary.shortCount}`} accent="red" />
              </View>
            </View>

            {/* 风险指标 */}
            <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">风险指标</Text>
              <View className="flex-row flex-wrap gap-3">
                <StatCard 
                  label="最大回撤" 
                  value={`${riskMetrics.maxDrawdown.toFixed(0)}`}
                  sub="元"
                  accent={riskMetrics.maxDrawdown > 1000 ? 'red' : undefined}
                />
                <StatCard 
                  label="夏普比率" 
                  value={riskMetrics.sharpeRatio.toFixed(2)}
                  sub={riskMetrics.sharpeRatio > 1 ? '优秀' : riskMetrics.sharpeRatio > 0 ? '一般' : '较差'}
                  accent={riskMetrics.sharpeRatio > 1 ? 'green' : undefined}
                />
                <StatCard 
                  label="平均收益" 
                  value={riskMetrics.avgReturn.toFixed(0)}
                  sub="元/笔"
                />
                <StatCard 
                  label="收益波动" 
                  value={riskMetrics.stdDev.toFixed(0)}
                  sub="标准差"
                />
              </View>
            </View>

            {/* 自适应参数状态 */}
            {data.adaptiveParams && data.adaptiveParams.confidence > 0 && (
              <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
                <View className="flex-row items-center mb-3">
                  <FontAwesome6 name="sliders" size={14} color="#f59e0b" />
                  <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">自适应参数</Text>
                  <View className="ml-auto px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30">
                    <Text className="text-xs font-bold text-amber-600">
                      置信度 {(data.adaptiveParams.confidence * 100).toFixed(0)}%
                    </Text>
                  </View>
                </View>
                <View className="flex-row flex-wrap gap-3">
                  <StatCard
                    label="P顺阈值"
                    value={data.adaptiveParams.effectivePThreshold.toFixed(3)}
                    sub={`×${data.adaptiveParams.pThresholdAdj.toFixed(2)}`}
                    accent={data.adaptiveParams.pThresholdAdj > 1 ? 'red' : data.adaptiveParams.pThresholdAdj < 1 ? 'green' : undefined}
                  />
                  <StatCard
                    label="止损ATR"
                    value={data.adaptiveParams.effectiveStopAtrMult.toFixed(2)}
                    sub={`×${data.adaptiveParams.stopAtrMultAdj.toFixed(2)}`}
                    accent={data.adaptiveParams.stopAtrMultAdj > 1 ? 'green' : data.adaptiveParams.stopAtrMultAdj < 1 ? 'red' : undefined}
                  />
                  <StatCard
                    label="止盈ATR"
                    value={data.adaptiveParams.effectiveTargetAtrMult.toFixed(2)}
                    sub={`×${data.adaptiveParams.targetAtrMultAdj.toFixed(2)}`}
                  />
                  <StatCard
                    label="最大持仓"
                    value={`${data.adaptiveParams.effectiveMaxHoldDays}天`}
                    sub={`×${data.adaptiveParams.maxHoldDaysAdj.toFixed(2)}`}
                  />
                  <StatCard
                    label="评分阈值"
                    value={`${data.adaptiveParams.effectiveMinScore}`}
                    sub={`${data.adaptiveParams.minScoreAdj > 0 ? '+' : ''}${data.adaptiveParams.minScoreAdj}`}
                    accent={data.adaptiveParams.minScoreAdj > 0 ? 'red' : data.adaptiveParams.minScoreAdj < 0 ? 'green' : undefined}
                  />
                </View>
              </View>
            )}

            {/* 板块风险敞口 */}
            <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">板块风险敞口</Text>
              {Object.entries(groupExposure).map(([group, exposure]) => (
                <View key={group} className="mb-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
                  <View className="flex-row items-center justify-between">
                    <Text className="font-bold text-gray-900 dark:text-white">{group}</Text>
                    <Text className={`text-sm ${exposure.count >= 2 ? 'text-red-500' : 'text-gray-500'}`}>
                      {exposure.count} 个品种
                    </Text>
                  </View>
                  <View className="mt-2 flex-row justify-between">
                    <Text className="text-xs text-gray-500">手数: {exposure.totalPosition}</Text>
                    <Text className={`text-xs ${exposure.totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      浮盈: {exposure.totalPnl.toFixed(0)}
                    </Text>
                  </View>
                  <Text className="mt-1 text-xs text-gray-400">
                    {exposure.trades.join(', ')}
                  </Text>
                </View>
              ))}
              {Object.keys(groupExposure).length === 0 && (
                <Text className="text-center text-gray-500">暂无持仓</Text>
              )}
            </View>

            {/* 信号等级分布 */}
            <View className="mx-4 mt-4 mb-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">信号等级分布</Text>
              <View className="flex-row flex-wrap gap-3">
                {Object.entries(gradeDistribution).map(([grade, count]) => (
                  <View key={grade} className="rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-700">
                    <Text className="text-center font-bold text-gray-900 dark:text-white">{grade}</Text>
                    <Text className="text-center text-sm text-gray-500">{count} 笔</Text>
                  </View>
                ))}
                {Object.keys(gradeDistribution).length === 0 && (
                  <Text className="text-gray-500">暂无数据</Text>
                )}
              </View>
            </View>
          </>
        )}

        {/* ===== 风控 Tab ===== */}
        {activeTab === 'risk' && (
          <>
            {/* 账户风控检查 */}
            <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <View className="flex-row items-center mb-3">
                <FontAwesome6 name="shield-halved" size={14} color={riskCheck?.passed ? '#10B981' : '#EF4444'} />
                <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">账户风控</Text>
                {riskCheck && (
                  <View className={`ml-auto px-2 py-0.5 rounded-full ${riskCheck.passed ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
                    <Text className={`text-xs font-bold ${riskCheck.passed ? 'text-green-600' : 'text-red-600'}`}>
                      {riskCheck.passed ? '通过' : '未通过'}
                    </Text>
                  </View>
                )}
              </View>
              {riskCheck ? (
                <View className="gap-2">
                  {riskCheck.checks.map((check, i) => (
                    <View key={i} className="flex-row items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
                      <View className="flex-1">
                        <Text className="text-sm font-medium text-gray-900 dark:text-white">{check.name}</Text>
                        <Text className="text-xs text-gray-500">{check.message}</Text>
                      </View>
                      <View className={`px-2 py-0.5 rounded-full ${check.passed ? 'bg-green-100 dark:bg-green-900/30' : 'bg-red-100 dark:bg-red-900/30'}`}>
                        <Text className={`text-xs font-bold ${check.passed ? 'text-green-600' : 'text-red-600'}`}>
                          {check.passed ? 'OK' : 'WARN'}
                        </Text>
                      </View>
                    </View>
                  ))}
                  {riskCheck.circuitBreaker?.triggered && (
                    <View className="mt-2 rounded-lg border border-red-300 bg-red-50 p-3 dark:border-red-700 dark:bg-red-900/20">
                      <View className="flex-row items-center">
                        <FontAwesome6 name="ban" size={12} color="#EF4444" />
                        <Text className="ml-2 text-sm font-bold text-red-600">熔断已触发</Text>
                      </View>
                      <Text className="mt-1 text-xs text-red-500">{riskCheck.circuitBreaker.reason}</Text>
                      {riskCheck.circuitBreaker.cooldownUntil && (
                        <Text className="text-xs text-red-400">冷却至: {riskCheck.circuitBreaker.cooldownUntil}</Text>
                      )}
                    </View>
                  )}
                </View>
              ) : (
                <Text className="text-center text-gray-500 py-4">暂无持仓数据</Text>
              )}
            </View>

            {/* 集中度检查 */}
            {concentration && (
              <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
                <View className="flex-row items-center mb-3">
                  <FontAwesome6 name="layer-group" size={14} color={concentration.risky ? '#EF4444' : '#10B981'} />
                  <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">集中度检查</Text>
                </View>
                {concentration.risky ? (
                  <View>
                    {concentration.groups.map((g, i) => (
                      <View key={i} className="mb-2 rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
                        <Text className="text-sm font-bold text-red-600">{g.group}</Text>
                        <Text className="text-xs text-red-500">
                          占比 {(g.ratio * 100).toFixed(0)}% (阈值 {(g.threshold * 100).toFixed(0)}%)
                        </Text>
                        <Text className="text-xs text-gray-500 mt-1">{g.codes.join(', ')}</Text>
                      </View>
                    ))}
                    {concentration.suggestions.map((s, i) => (
                      <Text key={i} className="text-xs text-amber-600 mt-1">• {s}</Text>
                    ))}
                  </View>
                ) : (
                  <Text className="text-center text-green-600 py-2">持仓分散良好</Text>
                )}
              </View>
            )}
          </>
        )}

        {/* ===== 相关性 Tab ===== */}
        {activeTab === 'correlation' && correlation && (
          <>
            {/* 高相关品种对 */}
            <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <View className="flex-row items-center mb-3">
                <FontAwesome6 name="link" size={14} color="#8B5CF6" />
                <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">高相关品种对</Text>
                <Text className="ml-auto text-xs text-gray-500">相关系数 &gt; 0.7</Text>
              </View>
              {correlation.high_correlation_pairs?.length > 0 ? (
                <View className="gap-2">
                  {correlation.high_correlation_pairs.slice(0, 15).map((pair, i) => (
                    <View key={i} className="flex-row items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
                      <View className="flex-row items-center flex-1">
                        <Text className="text-sm font-bold text-gray-900 dark:text-white">{pair.codeA}</Text>
                        <FontAwesome6 name="arrows-left-right" size={10} color="#9CA3AF" />
                        <Text className="text-sm font-bold text-gray-900 dark:text-white">{pair.codeB}</Text>
                      </View>
                      <View className="flex-row items-center">
                        <View
                          className="h-2 rounded-full mr-2"
                          style={{
                            width: Math.abs(pair.correlation) * 60,
                            backgroundColor: pair.correlation > 0.8 ? '#EF4444' : pair.correlation > 0.7 ? '#f59e0b' : '#10B981',
                          }}
                        />
                        <Text className={`text-sm font-bold ${pair.correlation > 0.8 ? 'text-red-500' : 'text-amber-500'}`}>
                          {pair.correlation.toFixed(2)}
                        </Text>
                      </View>
                    </View>
                  ))}
                </View>
              ) : (
                <Text className="text-center text-gray-500 py-4">暂无高相关品种对</Text>
              )}
            </View>

            {/* 相关品种群 */}
            <View className="mx-4 mt-4 mb-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
              <View className="flex-row items-center mb-3">
                <FontAwesome6 name="object-group" size={14} color="#3B82F6" />
                <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">品种关联群</Text>
              </View>
              {Object.entries(correlation.correlated_groups || {}).map(([group, codes]) => (
                <View key={group} className="mb-2 rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
                  <Text className="text-sm font-bold text-gray-900 dark:text-white">{group}</Text>
                  <Text className="text-xs text-gray-500 mt-1">{(codes as string[]).join(', ')}</Text>
                </View>
              ))}
            </View>
          </>
        )}

        {activeTab === 'correlation' && !correlation && (
          <View className="mx-4 mt-4 rounded-xl bg-white p-4 items-center dark:bg-gray-800">
            <ActivityIndicator size="small" color="#f59e0b" />
            <Text className="text-sm text-gray-500 mt-2">加载相关性数据...</Text>
          </View>
        )}
      </ScrollView>
    </>
  );
}

function StatCard({ 
  label, 
  value, 
  sub,
  accent 
}: { 
  label: string; 
  value: string; 
  sub?: string;
  accent?: 'green' | 'red';
}) {
  const valueColor = accent === 'green' ? 'text-green-500' : accent === 'red' ? 'text-red-500' : 'text-gray-900 dark:text-white';
  
  return (
    <View className="min-w-[80px] flex-1 rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
      <Text className="text-xs text-gray-500">{label}</Text>
      <Text className={`mt-1 text-lg font-bold ${valueColor}`}>{value}</Text>
      {sub ? <Text className="text-xs text-gray-400">{sub}</Text> : null}
    </View>
  );
}

export default function RiskDashboardScreen() {
  return (
    <Screen>
      <RiskDashboardContent />
    </Screen>
  );
}
