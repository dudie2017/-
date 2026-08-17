/**
 * 策略优化页面
 * 展示品种推荐（元模型）、参数稳健性分析、市场状态与自适应参数
 */

import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';


// 暗色终端配色（与 portfolio-risk 保持一致）
const BG = '#0A0A0F';
const CARD = '#16161F';
const CARD2 = '#1E1E2A';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#8A8A93';
const ACCENT = '#00F0FF';
const GREEN = '#00C853';
const RED = '#FF3B30';
const AMBER = '#FFB800';
const PURPLE = '#BF00FF';

interface MetaModelResult {
  timestamp: string;
  varietiesCount: number;
  featureImportance: Record<string, { feature: string; correlation: number }[]>;
  varietyRecommendations: Array<{
    code: string;
    score: number;
    totalPnl: number;
    profitFactor: number;
    capture: number;
    winRate: number;
    bars: number;
    recommendation: string;
  }>;
}

interface ParameterAnalysis {
  timestamp: string;
  varietiesCount: number;
  recommendations: Record<string, string>;
  paramAnalysis: Record<
    string,
    Array<{
      value: string;
      avgPnl: number;
      avgPF: number;
      avgCapture: number;
      avgWinRate: number;
      count: number;
    }>
  >;
}

interface RegimeVariety {
  code: string;
  bars: number;
  dateRange: string;
  avgStopAtr: string;
  avgTargetAtr: string;
  directionModeDistribution: Record<string, string>;
  baseline: { totalPnl: number; profitFactor: number; capture: number; winRate: number };
}

interface MarketRegimeResult {
  timestamp: string;
  varietiesCount: number;
  results: RegimeVariety[];
  adaptiveParamMap: Record<
    string,
    {
      stopAtrMult: number;
      targetAtrMult: number;
      maxHoldDays: number;
      directionMode: string;
      circuitBreaker?: string;
      minSignalGrade?: string;
    }
  >;
}

const VOL_OPTIONS = [
  { key: 'low', label: '低波动' },
  { key: 'medium', label: '中波动' },
  { key: 'high', label: '高波动' },
];

const TREND_OPTIONS = [
  { key: 'strong_up', label: '强涨' },
  { key: 'neutral', label: '震荡' },
  { key: 'strong_down', label: '强跌' },
];

const REGIME_LABELS: Record<string, string> = {
  high_strong_up: '高波动 · 强涨',
  high_strong_down: '高波动 · 强跌',
  high_neutral: '高波动 · 震荡',
  medium_strong_up: '中波动 · 强涨',
  medium_strong_down: '中波动 · 强跌',
  medium_neutral: '中波动 · 震荡',
  low_strong_up: '低波动 · 强涨',
  low_strong_down: '低波动 · 强跌',
  low_neutral: '低波动 · 震荡',
};

export function StrategyOptimizationContent() {
  const router = useSafeRouter();
  const [activeTab, setActiveTab] = useState<'meta' | 'params' | 'regime'>('meta');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [metaModel, setMetaModel] = useState<MetaModelResult | null>(null);
  const [paramAnalysis, setParamAnalysis] = useState<ParameterAnalysis | null>(null);
  const [marketRegime, setMarketRegime] = useState<MarketRegimeResult | null>(null);

  // 参数计算器
  const [calcCode, setCalcCode] = useState('AG0');
  const [volatility, setVolatility] = useState('medium');
  const [trend, setTrend] = useState('neutral');
  const [adaptiveParams, setAdaptiveParams] = useState<Record<string, any> | null>(null);
  const [calcLoading, setCalcLoading] = useState(false);

  // 刷新分析
  const [runningAnalysis, setRunningAnalysis] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      // 元模型分析
      const metaRes = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/strategy-optimization/meta-model`
      );
      const metaData = await metaRes.json();
      if (metaData.success) setMetaModel(metaData.data);

      // 参数稳健性分析
      const paramRes = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/strategy-optimization/parameter-analysis`
      );
      const paramData = await paramRes.json();
      if (paramData.success) setParamAnalysis(paramData.data);

      // 市场状态分析
      const regimeRes = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/strategy-optimization/market-regime`
      );
      const regimeData = await regimeRes.json();
      if (regimeData.success) {
        setMarketRegime(regimeData.data);
        const firstCode = regimeData.data?.results?.[0]?.code;
        if (firstCode) setCalcCode(firstCode);
      }
    } catch (error) {
      console.error('Error fetching strategy optimization data:', error);
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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchData();
  }, [fetchData]);

  /**
   * 服务端文件：server/src/routes/strategyOptimization.ts
   * 接口：POST /api/v1/strategy-optimization/run-analysis
   * Body 参数：无
   */
  const handleRunAnalysis = async () => {
    try {
      setRunningAnalysis(true);
      const res = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/strategy-optimization/run-analysis`,
        { method: 'POST' }
      );
      const data = await res.json();
      if (data.success) {
        Alert.alert('分析完成', data.data?.message || '已重新生成分析结果');
        fetchData();
      } else {
        Alert.alert('分析失败', data.error || '未知错误');
      }
    } catch (error) {
      Alert.alert('分析出错', '网络错误');
    } finally {
      setRunningAnalysis(false);
    }
  };

  /**
   * 服务端文件：server/src/routes/strategyOptimization.ts
   * 接口：GET /api/v1/strategy-optimization/adaptive-params/:code
   * Path 参数：code: string
   * Query 参数：volatility: 'low'|'medium'|'high', trend: 'strong_up'|'neutral'|'strong_down'
   */
  const handleCalcAdaptive = async () => {
    try {
      setCalcLoading(true);
      setAdaptiveParams(null);
      const res = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/strategy-optimization/adaptive-params/${calcCode}?volatility=${volatility}&trend=${trend}`
      );
      const data = await res.json();
      if (data.success) {
        setAdaptiveParams(data.data.params);
      } else {
        Alert.alert('计算失败', data.error || '未知错误');
      }
    } catch (error) {
      Alert.alert('计算出错', '网络错误');
    } finally {
      setCalcLoading(false);
    }
  };

  const renderRegimeTab = () => {
    if (!marketRegime) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>暂无数据</Text>
        </View>
      );
    }

    return (
      <View style={styles.content}>
        {/* 参数计算器 */}
        <Text style={styles.sectionTitle}>参数计算器</Text>
        <View style={styles.card}>
          <Text style={styles.calcLabel}>品种</Text>
          <View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
              {marketRegime.results.map((v) => (
                <TouchableOpacity
                  key={v.code}
                  style={[styles.chip, calcCode === v.code && styles.chipActive]}
                  onPress={() => setCalcCode(v.code)}
                >
                  <Text style={[styles.chipText, calcCode === v.code && styles.chipTextActive]}>
                    {v.code}
                  </Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>

          <Text style={styles.calcLabel}>波动率</Text>
          <View style={styles.chipRow}>
            {VOL_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.key}
                style={[styles.chip, volatility === o.key && styles.chipActive]}
                onPress={() => setVolatility(o.key)}
              >
                <Text style={[styles.chipText, volatility === o.key && styles.chipTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.calcLabel}>趋势</Text>
          <View style={styles.chipRow}>
            {TREND_OPTIONS.map((o) => (
              <TouchableOpacity
                key={o.key}
                style={[styles.chip, trend === o.key && styles.chipActive]}
                onPress={() => setTrend(o.key)}
              >
                <Text style={[styles.chipText, trend === o.key && styles.chipTextActive]}>
                  {o.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity style={styles.primaryBtn} onPress={handleCalcAdaptive} disabled={calcLoading}>
            {calcLoading ? (
              <ActivityIndicator size="small" color="#0A0A0F" />
            ) : (
              <Text style={styles.primaryBtnText}>计算参数</Text>
            )}
          </TouchableOpacity>

          {adaptiveParams && (
            <View style={styles.resultBox}>
              {Object.entries(adaptiveParams).map(([k, v]) => (
                <View key={k} style={styles.paramRow}>
                  <Text style={styles.paramKey}>{k}</Text>
                  <Text style={styles.paramVal}>{String(v)}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* 自适应参数映射表 */}
        <Text style={styles.sectionTitle}>市场状态自适应参数</Text>
        {Object.entries(marketRegime.adaptiveParamMap).map(([key, params]) => (
          <View key={key} style={styles.card}>
            <Text style={styles.regimeTitle}>{REGIME_LABELS[key] || key}</Text>
            <View style={styles.paramGrid}>
              <Text style={styles.paramCell}>止损 {params.stopAtrMult}x</Text>
              <Text style={styles.paramCell}>目标 {params.targetAtrMult}x</Text>
              <Text style={styles.paramCell}>持仓 {params.maxHoldDays}天</Text>
              <Text style={styles.paramCell}>{params.directionMode}</Text>
              {params.circuitBreaker && (
                <Text style={styles.paramCell}>熔断 {params.circuitBreaker}</Text>
              )}
              {params.minSignalGrade && (
                <Text style={styles.paramCell}>信号 {params.minSignalGrade}</Text>
              )}
            </View>
          </View>
        ))}

        {/* 品种市场状态列表 */}
        <Text style={styles.sectionTitle}>品种基准表现</Text>
        {marketRegime.results.map((v) => (
          <TouchableOpacity
            key={v.code}
            style={styles.card}
            onPress={() => router.push('/detail', { code: v.code })}
          >
            <View style={styles.rowBetween}>
              <Text style={styles.varietyCode}>{v.code}</Text>
              <Text style={styles.varietyMeta}>{v.dateRange}</Text>
            </View>
            <View style={styles.statRow}>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>收益</Text>
                <Text style={[styles.statValue, { color: v.baseline.totalPnl >= 0 ? GREEN : RED }]}>
                  {v.baseline.totalPnl.toFixed(0)}
                </Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>PF</Text>
                <Text style={styles.statValue}>{v.baseline.profitFactor.toFixed(2)}</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>捕获率</Text>
                <Text style={styles.statValue}>{(v.baseline.capture * 100).toFixed(1)}%</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>胜率</Text>
                <Text style={styles.statValue}>{(v.baseline.winRate * 100).toFixed(1)}%</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}
      </View>
    );
  };

  const renderMetaModelTab = () => {
    if (!metaModel) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>暂无数据</Text>
        </View>
      );
    }

    const importance = metaModel.featureImportance?.totalPnl || [];

    return (
      <View style={styles.content}>
        <Text style={styles.sectionTitle}>品种推荐</Text>
        {metaModel.varietyRecommendations.map((rec) => (
          <TouchableOpacity
            key={rec.code}
            style={styles.card}
            onPress={() => router.push('/detail', { code: rec.code })}
          >
            <View style={styles.rowBetween}>
              <Text style={styles.varietyCode}>{rec.code}</Text>
              <View
                style={[
                  styles.badge,
                  {
                    backgroundColor: rec.recommendation.includes('强烈')
                      ? 'rgba(0,240,255,0.15)'
                      : rec.recommendation.includes('推荐')
                        ? 'rgba(0,200,83,0.15)'
                        : 'rgba(255,184,0,0.15)',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.badgeText,
                    {
                      color: rec.recommendation.includes('强烈')
                        ? ACCENT
                        : rec.recommendation.includes('推荐')
                          ? GREEN
                          : AMBER,
                    },
                  ]}
                >
                  {rec.recommendation}
                </Text>
              </View>
            </View>
            <View style={styles.statRow}>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>收益</Text>
                <Text style={[styles.statValue, { color: rec.totalPnl >= 0 ? GREEN : RED }]}>
                  {rec.totalPnl.toFixed(0)}
                </Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>PF</Text>
                <Text style={styles.statValue}>{rec.profitFactor.toFixed(2)}</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>捕获率</Text>
                <Text style={styles.statValue}>{(rec.capture * 100).toFixed(1)}%</Text>
              </View>
              <View style={styles.statCol}>
                <Text style={styles.statLabel}>胜率</Text>
                <Text style={styles.statValue}>{(rec.winRate * 100).toFixed(1)}%</Text>
              </View>
            </View>
          </TouchableOpacity>
        ))}

        <Text style={styles.sectionTitle}>特征重要性</Text>
        <View style={styles.card}>
          {importance.map((item, idx) => {
            const width = Math.max(Math.abs(item.correlation) * 100, 4);
            return (
              <View key={idx} style={styles.featureRow}>
                <View style={styles.featureHeader}>
                  <Text style={styles.featureName}>{item.feature}</Text>
                  <Text style={styles.featureVal}>{item.correlation.toFixed(3)}</Text>
                </View>
                <View style={styles.featureBarTrack}>
                  <View
                    style={[
                      styles.featureBarFill,
                      {
                        width: `${width}%`,
                        backgroundColor: item.correlation >= 0 ? ACCENT : RED,
                      },
                    ]}
                  />
                </View>
              </View>
            );
          })}
        </View>
      </View>
    );
  };

  const renderParamsTab = () => {
    if (!paramAnalysis) {
      return (
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>暂无数据</Text>
        </View>
      );
    }

    const recEntries = Object.entries(paramAnalysis.recommendations || {});
    const paramEntries = Object.entries(paramAnalysis.paramAnalysis || {});

    return (
      <View style={styles.content}>
        <Text style={styles.sectionTitle}>推荐参数</Text>
        <View style={styles.card}>
          {recEntries.map(([key, value]) => (
            <View key={key} style={styles.paramRow}>
              <Text style={styles.paramKey}>{key}</Text>
              <Text style={styles.paramVal}>{String(value)}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>参数稳健性分析</Text>
        {paramEntries.map(([paramName, rows]) => (
          <View key={paramName} style={styles.card}>
            <Text style={styles.regimeTitle}>{paramName}</Text>
            {rows.map((row, idx) => (
              <View key={idx} style={styles.sensRow}>
                <Text style={styles.sensValue}>{row.value}</Text>
                <Text style={styles.sensPF}>PF {row.avgPF.toFixed(2)}</Text>
                <Text style={[styles.sensPnl, { color: row.avgPnl >= 0 ? GREEN : RED }]}>
                  {row.avgPnl >= 0 ? '+' : ''}
                  {row.avgPnl.toFixed(0)}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    );
  };

  const renderContent = () => {
    if (activeTab === 'meta') return renderMetaModelTab();
    if (activeTab === 'params') return renderParamsTab();
    return renderRegimeTab();
  };

  return (
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>策略优化</Text>
          <TouchableOpacity
            style={[styles.refreshBtn, runningAnalysis && styles.refreshBtnDisabled]}
            onPress={handleRunAnalysis}
            disabled={runningAnalysis}
          >
            {runningAnalysis ? (
              <ActivityIndicator size="small" color={ACCENT} />
            ) : (
              <Text style={styles.refreshBtnText}>重新分析</Text>
            )}
          </TouchableOpacity>
        </View>

        {/* Tab 切换 */}
        <View style={styles.tabs}>
          {(
            [
              { key: 'meta', label: '品种推荐' },
              { key: 'params', label: '参数分析' },
              { key: 'regime', label: '市场状态' },
            ] as const
          ).map((tab) => (
            <TouchableOpacity
              key={tab.key}
              style={[styles.tab, activeTab === tab.key && styles.tabActive]}
              onPress={() => setActiveTab(tab.key)}
            >
              <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 内容 */}
        {loading ? (
          <View style={styles.emptyWrap}>
            <ActivityIndicator size="large" color={ACCENT} />
            <Text style={styles.emptyText}>加载中...</Text>
          </View>
        ) : (
          <ScrollView
            style={styles.content}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />
            }
            contentContainerStyle={{ paddingBottom: 40 }}
          >
            {renderContent()}
          </ScrollView>
        )}
      </View>
  );
}

export default function StrategyOptimizationScreen() {
  return (
    <Screen statusBarStyle="light" backgroundColor={BG}>
      <StrategyOptimizationContent />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 8,
  },
  title: { fontSize: 26, fontWeight: '800', color: TEXT1 },
  refreshBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(0,240,255,0.4)',
    backgroundColor: 'rgba(0,240,255,0.08)',
  },
  refreshBtnDisabled: { opacity: 0.5 },
  refreshBtnText: { color: ACCENT, fontSize: 13, fontWeight: '600' },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 8,
    marginTop: 8,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD,
  },
  tabActive: {
    borderColor: 'rgba(0,240,255,0.5)',
    backgroundColor: 'rgba(0,240,255,0.1)',
  },
  tabText: { color: TEXT2, fontSize: 14, fontWeight: '600' },
  tabTextActive: { color: ACCENT },
  content: { flex: 1 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 60 },
  emptyText: { color: TEXT2, fontSize: 14, marginTop: 12 },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: TEXT2,
    marginTop: 20,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  card: {
    backgroundColor: CARD,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: BORDER,
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 12,
  },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  varietyCode: { fontSize: 17, fontWeight: '800', color: TEXT1 },
  varietyMeta: { fontSize: 11, color: TEXT2 },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  statCol: { flex: 1 },
  statLabel: { fontSize: 11, color: TEXT2, marginBottom: 4 },
  statValue: { fontSize: 16, fontWeight: '800', color: TEXT1 },
  featureRow: { marginBottom: 12 },
  featureHeader: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  featureName: { fontSize: 12, color: TEXT2 },
  featureVal: { fontSize: 12, fontWeight: '700', color: ACCENT },
  featureBarTrack: { height: 6, borderRadius: 3, backgroundColor: CARD2, overflow: 'hidden' },
  featureBarFill: { height: '100%', borderRadius: 3 },
  paramRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  paramKey: { fontSize: 13, color: TEXT2 },
  paramVal: { fontSize: 13, fontWeight: '700', color: TEXT1 },
  regimeTitle: { fontSize: 15, fontWeight: '700', color: ACCENT, marginBottom: 10 },
  paramGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  paramCell: {
    fontSize: 12,
    color: TEXT1,
    backgroundColor: CARD2,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
  },
  sensRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: BORDER,
  },
  sensValue: { flex: 1, fontSize: 13, color: TEXT1 },
  sensPF: { width: 80, fontSize: 13, color: ACCENT, textAlign: 'right' },
  sensPnl: { width: 90, fontSize: 13, fontWeight: '700', textAlign: 'right' },
  calcLabel: { fontSize: 12, color: TEXT2, marginBottom: 8, marginTop: 4 },
  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: BORDER,
    backgroundColor: CARD2,
  },
  chipActive: {
    borderColor: 'rgba(0,240,255,0.5)',
    backgroundColor: 'rgba(0,240,255,0.1)',
  },
  chipText: { fontSize: 13, color: TEXT2 },
  chipTextActive: { color: ACCENT, fontWeight: '700' },
  primaryBtn: {
    marginTop: 8,
    backgroundColor: ACCENT,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#0A0A0F', fontSize: 15, fontWeight: '800' },
  resultBox: { marginTop: 14, backgroundColor: CARD2, borderRadius: 10, padding: 12 },
});