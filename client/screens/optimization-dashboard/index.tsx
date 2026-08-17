import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl } from 'react-native';
import { Screen } from '@/components/Screen';
import { FontAwesome6 } from '@expo/vector-icons';

const API_BASE = `${BACKEND_BASE}/api/v1/optimization-dashboard`;

type TabKey = 'overview' | 'stopLoss' | 'positionSizing' | 'timeframe' | 'funnel';

interface Tab {
  key: TabKey;
  label: string;
  icon: keyof typeof FontAwesome6.glyphMap;
}

const TABS: Tab[] = [
  { key: 'overview', label: '总览', icon: 'chart-line' },
  { key: 'stopLoss', label: '止损', icon: 'shield-halved' },
  { key: 'positionSizing', label: '仓位', icon: 'ruler' },
  { key: 'timeframe', label: '时间', icon: 'clock' },
  { key: 'funnel', label: '漏斗', icon: 'filter' },
];

export function OptimizationDashboardContent() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      setError(null);
      const res = await fetchWithTimeout(`${API_BASE}/overview`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const onRefresh = () => {
    setRefreshing(true);
    fetchData();
  };

  if (loading) {
    return (
      <View className="flex-1 items-center justify-center bg-gray-50">
        <ActivityIndicator size="large" color="#4F46E5" />
        <Text className="mt-4 text-gray-500 text-sm">加载分析数据...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View className="flex-1 items-center justify-center bg-gray-50 p-8">
        <Text className="text-red-500 text-lg font-bold">加载失败</Text>
        <Text className="text-gray-500 mt-2 text-center">{error}</Text>
        <TouchableOpacity onPress={fetchData} className="mt-4 bg-indigo-500 px-6 py-3 rounded-xl">
          <Text className="text-white font-bold">重试</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-gray-50"
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
    >
        {/* Header */}
        <View className="bg-indigo-600 px-6 pt-12 pb-6">
          <Text className="text-white text-2xl font-bold">优化仪表板</Text>
          <Text className="text-indigo-200 text-sm mt-1">期货量化系统深度分析结果</Text>
        </View>

        {/* Tabs */}
        <View className="flex-row bg-white mx-4 -mt-4 rounded-xl shadow-sm">
          {TABS.map((tab) => (
            <TouchableOpacity
              key={tab.key}
              onPress={() => setActiveTab(tab.key)}
              className={`flex-1 py-3 items-center rounded-xl ${activeTab === tab.key ? 'bg-indigo-50' : ''}`}
            >
              <FontAwesome6 name={tab.icon} size={16} color={activeTab === tab.key ? '#4F46E5' : '#9CA3AF'} />
              <Text className={`text-xs mt-1 font-bold ${activeTab === tab.key ? 'text-indigo-600' : 'text-gray-400'}`}>
                {tab.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Content */}
        <View className="px-4 mt-4 pb-8">
          {activeTab === 'overview' && <OverviewTab data={data} />}
          {activeTab === 'stopLoss' && <StopLossTab data={data} />}
          {activeTab === 'positionSizing' && <PositionSizingTab data={data} />}
          {activeTab === 'timeframe' && <TimeframeTab data={data} />}
          {activeTab === 'funnel' && <FunnelTab data={data} />}
        </View>
      </ScrollView>
  );
}

export default function OptimizationDashboardScreen() {
  return (
    <Screen>
      <OptimizationDashboardContent />
    </Screen>
  );
}

// ==================== Overview Tab ====================
function OverviewTab({ data }: { data: any }) {
  const funnel = data?.varietyEntryFunnel;
  const stopLoss = data?.stopLossOptimization;
  const dynamic = data?.dynamicStopLossAnalysis;
  const positionSizing = data?.positionSizingAnalysis;
  const timeframe = data?.multiTimeframeValidation;

  const entryCount = funnel?.entry?.length || funnel?.funnelSummary?.finalEntry || 0;
  const watchlistCount = funnel?.watchlist?.length || funnel?.funnelSummary?.finalWatchlist || 0;
  const eliminatedCount = funnel?.eliminated?.length || funnel?.funnelSummary?.finalEliminated || 0;

  const summaryCards = [
    {
      title: '品种入池',
      value: `${entryCount} 个`,
      subtitle: `观察池 ${watchlistCount} / 淘汰 ${eliminatedCount}`,
      color: 'bg-green-500',
    },
    {
      title: '止损优化',
      value: stopLoss ? `${Object.values(stopLoss).filter((r: any) => r.improvement?.calmarChangePct > 0).length} 个改善` : 'N/A',
      subtitle: dynamic ? `动态止损: ${Object.values(dynamic).filter((r: any) => r.improvement?.calmarChangePct > 0).length} 个改善` : '',
      color: 'bg-blue-500',
    },
    {
      title: '仓位管理',
      value: positionSizing ? `${Object.values(positionSizing).filter((r: any) => r.best?.method !== 'baseline').length} 个可优化` : 'N/A',
      subtitle: '波动率倒数加权最优',
      color: 'bg-purple-500',
    },
    {
      title: '时间框架',
      value: timeframe?.summary?.robust?.length ? `${timeframe.summary.robust.length} 个稳健` : 'N/A',
      subtitle: timeframe?.summary?.fragile?.length ? `${timeframe.summary.fragile.length} 个脆弱` : '全部通过',
      color: 'bg-orange-500',
    },
  ];

  return (
    <View>
      {/* Summary Cards */}
      <View className="flex-row flex-wrap -mx-1">
        {summaryCards.map((card, i) => (
          <View key={i} className="w-1/2 px-1 mb-2">
            <View className="bg-white rounded-xl p-4 shadow-sm">
              <View className={`w-8 h-8 ${card.color} rounded-lg items-center justify-center mb-2`}>
                <Text className="text-white text-xs font-bold">{i + 1}</Text>
              </View>
              <Text className="text-gray-500 text-xs">{card.title}</Text>
              <Text className="text-xl font-bold text-gray-900 mt-1">{card.value}</Text>
              <Text className="text-gray-400 text-xs mt-1">{card.subtitle}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Triple-filter varieties status */}
      <View className="bg-white rounded-xl p-4 shadow-sm mt-2">
        <Text className="text-lg font-bold text-gray-900 mb-3">三重筛选品种状态</Text>
        {['CF0', 'CU0', 'HC0'].map((v) => {
          const sl = stopLoss?.[v];
          const dl = dynamic?.[v];
          const ps = positionSizing?.[v];
          const tf = timeframe?.results?.[v];

          return (
            <View key={v} className="border-b border-gray-100 py-3">
              <Text className="text-base font-bold text-indigo-600">{v}</Text>
              <View className="flex-row flex-wrap mt-2">
                <StatusBadge label="止损" value={sl?.improvement?.calmarChangePct > 0 ? `+${sl.improvement.calmarChangePct.toFixed(1)}%` : '最优'} ok />
                <StatusBadge label="动态止损" value={dl?.improvement?.calmarChangePct > 0 ? `+${dl.improvement.calmarChangePct.toFixed(0)}%` : '最优'} ok={dl?.improvement?.calmarChangePct > 0} />
                <StatusBadge label="仓位" value={ps?.best?.method || 'baseline'} ok={ps?.best?.method === 'baseline'} />
                <StatusBadge label="时间框架" value={tf?.consistency || 'N/A'} ok={tf?.consistency === 'robust'} />
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// ==================== Stop Loss Tab ====================
function StopLossTab({ data }: { data: any }) {
  const stopLoss = data?.stopLossOptimization || {};
  const dynamic = data?.dynamicStopLossAnalysis || {};
  const batchTP = data?.batchTakeProfitAnalysis || {};

  return (
    <View>
      {/* Grid Search */}
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-gray-900 mb-3">参数网格搜索</Text>
        {Object.entries(stopLoss).map(([variety, result]: [string, any]) => (
          <View key={variety} className="border-b border-gray-100 py-3">
            <Text className="text-base font-bold text-indigo-600">{variety}</Text>
            <View className="flex-row justify-between mt-2">
              <View>
                <Text className="text-gray-500 text-xs">基线 Calmar</Text>
                <Text className="text-lg font-bold text-gray-900">{result.baseline?.calmar?.toFixed(2) || 'N/A'}</Text>
              </View>
              <View>
                <Text className="text-gray-500 text-xs">最优 Calmar</Text>
                <Text className="text-lg font-bold text-green-600">{result.optimal?.calmar?.toFixed(2) || 'N/A'}</Text>
              </View>
              <View>
                <Text className="text-gray-500 text-xs">改进</Text>
                <Text className={`text-lg font-bold ${result.improvement?.calmarChangePct > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                  {result.improvement?.calmarChangePct > 0 ? '+' : ''}{result.improvement?.calmarChangePct?.toFixed(1) || 0}%
                </Text>
              </View>
            </View>
            {result.optimal && (
              <Text className="text-gray-400 text-xs mt-1">
                最优参数: stop={result.optimal.stopAtrMult}, target={result.optimal.targetAtrMult}, minRR={result.optimal.minRR}
              </Text>
            )}
          </View>
        ))}
      </View>

      {/* Dynamic Stop Loss */}
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-gray-900 mb-3">动态止损策略</Text>
        {Object.entries(dynamic).map(([variety, result]: [string, any]) => (
          <View key={variety} className="border-b border-gray-100 py-3">
            <Text className="text-base font-bold text-indigo-600">{variety}</Text>
            <View className="flex-row justify-between mt-2">
              <View>
                <Text className="text-gray-500 text-xs">基线</Text>
                <Text className="text-lg font-bold text-gray-900">{result.baseline?.calmar?.toFixed(2) || 'N/A'}</Text>
              </View>
              <View>
                <Text className="text-gray-500 text-xs">最佳策略</Text>
                <Text className="text-lg font-bold text-green-600">{result.best?.strategy || 'N/A'}</Text>
              </View>
              <View>
                <Text className="text-gray-500 text-xs">改进</Text>
                <Text className={`text-lg font-bold ${result.improvement?.calmarChangePct > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                  {result.improvement?.calmarChangePct > 0 ? '+' : ''}{result.improvement?.calmarChangePct?.toFixed(0) || 0}%
                </Text>
              </View>
            </View>
          </View>
        ))}
      </View>

      {/* Batch Take Profit */}
      <View className="bg-white rounded-xl p-4 shadow-sm">
        <Text className="text-lg font-bold text-gray-900 mb-3">分批止盈</Text>
        {Object.entries(batchTP).map(([variety, result]: [string, any]) => (
          <View key={variety} className="py-2">
            <View className="flex-row justify-between">
              <Text className="text-base font-bold text-indigo-600">{variety}</Text>
              <Text className={`text-sm font-bold ${result.improvement?.calmarChangePct > 0 ? 'text-green-600' : 'text-gray-400'}`}>
                {result.improvement?.calmarChangePct > 0 ? `+${result.improvement.calmarChangePct.toFixed(1)}%` : '无改进'}
              </Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

// ==================== Position Sizing Tab ====================
function PositionSizingTab({ data }: { data: any }) {
  const positionSizing = data?.positionSizingAnalysis || {};

  return (
    <View>
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-gray-900 mb-3">品种级仓位管理</Text>
        {Object.entries(positionSizing).filter(([k]) => k !== 'portfolio').map(([variety, result]: [string, any]) => (
          <View key={variety} className="border-b border-gray-100 py-3">
            <Text className="text-base font-bold text-indigo-600">{variety}</Text>
            <View className="mt-2">
              <Text className="text-gray-500 text-xs">基线 Calmar: <Text className="text-gray-900 font-bold">{result.baseline?.calmar?.toFixed(2) || 'N/A'}</Text></Text>
              <Text className="text-gray-500 text-xs">最优方法: <Text className="text-green-600 font-bold">{result.best?.method || 'baseline'}</Text></Text>
              <Text className="text-gray-500 text-xs">最优 Calmar: <Text className="text-green-600 font-bold">{result.best?.calmar?.toFixed(2) || 'N/A'}</Text></Text>
            </View>
          </View>
        ))}
      </View>

      {positionSizing.portfolio && (
        <View className="bg-white rounded-xl p-4 shadow-sm">
          <Text className="text-lg font-bold text-gray-900 mb-3">组合级优化</Text>
          <View className="flex-row justify-between">
            <View>
              <Text className="text-gray-500 text-xs">等权 Calmar</Text>
              <Text className="text-lg font-bold text-gray-900">{positionSizing.portfolio.equalWeight?.calmar?.toFixed(2) || 'N/A'}</Text>
            </View>
            <View>
              <Text className="text-gray-500 text-xs">波动率倒数 Calmar</Text>
              <Text className="text-lg font-bold text-green-600">{positionSizing.portfolio.volInverse?.calmar?.toFixed(2) || 'N/A'}</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ==================== Timeframe Tab ====================
function TimeframeTab({ data }: { data: any }) {
  const timeframe = data?.multiTimeframeValidation || {};
  const results = timeframe.results || {};

  return (
    <View>
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-gray-900 mb-3">多时间框架验证</Text>
        {Object.entries(results).map(([variety, result]: [string, any]) => (
          <View key={variety} className="border-b border-gray-100 py-3">
            <View className="flex-row justify-between items-center">
              <Text className="text-base font-bold text-indigo-600">{variety}</Text>
              <View className={`px-3 py-1 rounded-full ${result.consistency === 'robust' ? 'bg-green-100' : result.consistency === 'partial' ? 'bg-yellow-100' : 'bg-red-100'}`}>
                <Text className={`text-xs font-bold ${result.consistency === 'robust' ? 'text-green-700' : result.consistency === 'partial' ? 'text-yellow-700' : 'text-red-700'}`}>
                  {result.consistency === 'robust' ? '稳健' : result.consistency === 'partial' ? '部分' : '脆弱'}
                </Text>
              </View>
            </View>
            <Text className="text-gray-500 text-xs mt-1">{result.notes}</Text>
            <View className="flex-row flex-wrap mt-2">
              {Object.entries(result.timeframes || {}).map(([tf, tfResult]: [string, any]) => (
                <View key={tf} className="bg-gray-50 rounded-lg px-3 py-2 mr-2 mb-1">
                  <Text className="text-gray-400 text-xs">{tf}</Text>
                  <Text className="text-gray-900 text-sm font-bold">Calmar {tfResult.calmar?.toFixed(2)}</Text>
                  <Text className="text-gray-400 text-xs">{tfResult.totalTrades} 笔</Text>
                </View>
              ))}
            </View>
          </View>
        ))}
      </View>

      {timeframe.summary && (
        <View className="bg-white rounded-xl p-4 shadow-sm">
          <Text className="text-lg font-bold text-gray-900 mb-3">汇总</Text>
          <View className="flex-row">
            <View className="flex-1 items-center">
              <Text className="text-2xl font-bold text-green-600">{timeframe.summary.robust?.length || 0}</Text>
              <Text className="text-gray-500 text-xs">稳健</Text>
            </View>
            <View className="flex-1 items-center">
              <Text className="text-2xl font-bold text-yellow-600">{timeframe.summary.partial?.length || 0}</Text>
              <Text className="text-gray-500 text-xs">部分</Text>
            </View>
            <View className="flex-1 items-center">
              <Text className="text-2xl font-bold text-red-600">{timeframe.summary.fragile?.length || 0}</Text>
              <Text className="text-gray-500 text-xs">脆弱</Text>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

// ==================== Funnel Tab ====================
function FunnelTab({ data }: { data: any }) {
  const funnel = data?.varietyEntryFunnel || {};
  const entry = funnel.entry || [];
  const watchlist = funnel.watchlist || [];
  const eliminated = funnel.eliminated || [];
  const summary = funnel.funnelSummary || {};

  return (
    <View>
      {/* Funnel visualization */}
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-gray-900 mb-3">品种入池漏斗</Text>
        <View className="items-center">
          <FunnelStep label="全部品种" count={summary.L0_total || 59} width="100%" color="bg-gray-200" />
          <FunnelStep label="三重筛选通过" count={summary.L1_tripleFilter || 3} width="80%" color="bg-blue-200" />
          <FunnelStep label="成本稳健" count={summary.L2_costRobust || 46} width="65%" color="bg-indigo-200" />
          <FunnelStep label="Regime稳健" count={summary.L3_regimeRobust || 43} width="50%" color="bg-purple-200" />
          <FunnelStep label="跳空安全" count={summary.L4_jumpSafe || 48} width="35%" color="bg-pink-200" />
          <FunnelStep label="尾部可控" count={summary.L5_tailSafe || 40} width="20%" color="bg-green-200" />
          <FunnelStep label="最终入池" count={summary.finalEntry || entry.length} width="10%" color="bg-green-500" />
        </View>
      </View>

      {/* Final entry varieties */}
      <View className="bg-white rounded-xl p-4 shadow-sm mb-3">
        <Text className="text-lg font-bold text-green-600 mb-3">入池品种 ({entry.length})</Text>
        {entry.map((item: any, i: number) => (
          <View key={i} className="flex-row justify-between py-2 border-b border-gray-100">
            <Text className="text-base font-bold text-gray-900">{item.code}</Text>
            <View className="flex-row">
              <Text className="text-gray-500 text-sm mr-3">权重: {(item.weight * 100).toFixed(2)}%</Text>
              <Text className="text-gray-500 text-sm">{item.grade || 'A'}</Text>
            </View>
          </View>
        ))}
      </View>

      {/* Eliminated varieties */}
      <View className="bg-white rounded-xl p-4 shadow-sm">
        <Text className="text-lg font-bold text-red-600 mb-3">淘汰品种 ({eliminated.length})</Text>
        <View className="flex-row flex-wrap">
          {eliminated.map((item: any, i: number) => (
            <View key={i} className="bg-red-50 rounded-lg px-3 py-1 mr-2 mb-2">
              <Text className="text-red-700 text-sm font-bold">{item.code}</Text>
              <Text className="text-red-500 text-xs">{item.reason || '不达标'}</Text>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

// ==================== Helper Components ====================
function StatusBadge({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <View className={`px-2 py-1 rounded mr-2 mb-1 ${ok ? 'bg-green-100' : 'bg-yellow-100'}`}>
      <Text className={`text-xs ${ok ? 'text-green-700' : 'text-yellow-700'}`}>{label}: {value}</Text>
    </View>
  );
}

function FunnelStep({ label, count, width, color }: { label: string; count: number; width: string; color: string }) {
  return (
    <View className={`items-center justify-center py-2 px-4 rounded-lg mb-1 ${color}`} style={{ width: width as any }}>
      <Text className="text-gray-900 text-xs font-bold">{label}</Text>
      <Text className="text-gray-700 text-sm font-bold">{count}</Text>
    </View>
  );
}
