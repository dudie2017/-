/**
 * 绩效报告页面
 * 
 * 展示周度/月度交易绩效统计：
 * - 胜率、盈亏比、最大回撤、夏普比率
 * - 最佳/最差品种
 * - 方向分析（多头/空头）
 * - 分级分析
 * - 风控建议
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
import { API_BASE, fetchWithTimeout } from '@/utils/api';

interface PerformanceReport {
  period: {
    type: 'weekly' | 'monthly';
    startDate: string;
    endDate: string;
    tradingDays: number;
  };
  summary: {
    totalTrades: number;
    winTrades: number;
    lossTrades: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    profitFactor: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
  bestVarieties: Array<{
    code: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  worstVarieties: Array<{
    code: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  directionAnalysis: {
    longTrades: number;
    longWinRate: number;
    longPnl: number;
    shortTrades: number;
    shortWinRate: number;
    shortPnl: number;
  };
  gradeAnalysis: Array<{
    grade: string;
    trades: number;
    winRate: number;
    pnl: number;
  }>;
  riskMetrics: {
    avgHoldDays: number;
    maxConsecutiveWins: number;
    maxConsecutiveLosses: number;
    avgWinPnl: number;
    avgLossPnl: number;
    largestWin: number;
    largestLoss: number;
  };
  suggestions: string[];
}

export default function PerformanceReportScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [reportType, setReportType] = useState<'weekly' | 'monthly'>('weekly');
  const [error, setError] = useState<string | null>(null);

  const loadReport = useCallback(async (type: 'weekly' | 'monthly' = reportType, isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);

      /**
       * 服务端文件：server/src/routes/scan.ts
       * 接口：GET /api/v1/scan/performance-report
       * Query 参数：type?: 'weekly' | 'monthly' (默认 weekly)
       */
      const resp = await fetchWithTimeout(`${API_BASE}/scan/performance-report?type=${type}`);
      const data = await resp.json();
      setReport(data);
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [reportType]);

  useFocusEffect(
    useCallback(() => {
      loadReport(reportType);
    }, [loadReport, reportType])
  );

  const switchType = (type: 'weekly' | 'monthly') => {
    setReportType(type);
    loadReport(type);
  };

  if (loading) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#f59e0b" />
          <Text className="mt-4 text-gray-500">生成绩效报告...</Text>
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center p-4">
          <Text className="text-center text-red-500">{error}</Text>
          <TouchableOpacity onPress={() => loadReport()} className="mt-4 rounded-lg bg-amber-500 px-6 py-2">
            <Text className="text-white">重试</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  if (!report) return null;

  const { period, summary, bestVarieties, worstVarieties, directionAnalysis, gradeAnalysis, riskMetrics, suggestions } = report;

  return (
    <Screen>
      <ScrollView
        className="flex-1"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => loadReport(reportType, true)} />
        }
      >
        {/* 标题栏 */}
        <View className="flex-row items-center justify-between bg-gray-50 px-4 py-3 dark:bg-gray-800">
          <TouchableOpacity onPress={() => router.back()}>
            <Text className="text-lg text-amber-500">← 返回</Text>
          </TouchableOpacity>
          <Text className="text-lg font-bold text-gray-900 dark:text-white">绩效报告</Text>
          <View className="w-8" />
        </View>

        {/* 周期切换 */}
        <View className="flex-row px-4 pt-3 gap-2">
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${reportType === 'weekly' ? 'bg-amber-500' : 'bg-gray-100 dark:bg-gray-700'}`}
            onPress={() => switchType('weekly')}
          >
            <Text className={`text-sm font-bold ${reportType === 'weekly' ? 'text-white' : 'text-gray-500'}`}>本周</Text>
          </TouchableOpacity>
          <TouchableOpacity
            className={`flex-1 py-2 rounded-lg items-center ${reportType === 'monthly' ? 'bg-amber-500' : 'bg-gray-100 dark:bg-gray-700'}`}
            onPress={() => switchType('monthly')}
          >
            <Text className={`text-sm font-bold ${reportType === 'monthly' ? 'text-white' : 'text-gray-500'}`}>本月</Text>
          </TouchableOpacity>
        </View>

        {/* 报告周期信息 */}
        <View className="mx-4 mt-3 rounded-lg bg-amber-50 p-3 dark:bg-amber-900/20">
          <Text className="text-xs text-amber-700 dark:text-amber-400">
            {period.startDate} ~ {period.endDate} · {period.tradingDays} 个交易日
          </Text>
        </View>

        {/* 核心指标 */}
        <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">核心指标</Text>
          <View className="flex-row flex-wrap gap-3">
            <MetricCard label="总交易" value={`${summary.totalTrades}`} unit="笔" />
            <MetricCard label="胜率" value={`${(summary.winRate * 100).toFixed(1)}%`} accent={summary.winRate > 0.5 ? 'green' : 'red'} />
            <MetricCard label="总盈亏" value={`${summary.totalPnl.toFixed(0)}`} unit="元" accent={summary.totalPnl > 0 ? 'green' : 'red'} />
            <MetricCard label="盈亏比" value={summary.profitFactor.toFixed(2)} accent={summary.profitFactor > 1.5 ? 'green' : undefined} />
            <MetricCard label="最大回撤" value={`${summary.maxDrawdown.toFixed(0)}`} unit="元" accent={summary.maxDrawdown > 500 ? 'red' : undefined} />
            <MetricCard label="夏普比率" value={summary.sharpeRatio.toFixed(2)} accent={summary.sharpeRatio > 1 ? 'green' : undefined} />
          </View>
        </View>

        {/* 风险指标 */}
        <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">风险指标</Text>
          <View className="flex-row flex-wrap gap-3">
            <MetricCard label="平均持仓" value={`${riskMetrics.avgHoldDays.toFixed(1)}`} unit="天" />
            <MetricCard label="最大连胜" value={`${riskMetrics.maxConsecutiveWins}`} unit="笔" accent="green" />
            <MetricCard label="最大连亏" value={`${riskMetrics.maxConsecutiveLosses}`} unit="笔" accent="red" />
            <MetricCard label="平均盈利" value={`${riskMetrics.avgWinPnl.toFixed(0)}`} unit="元" accent="green" />
            <MetricCard label="平均亏损" value={`${riskMetrics.avgLossPnl.toFixed(0)}`} unit="元" accent="red" />
            <MetricCard label="最大单笔盈利" value={`${riskMetrics.largestWin.toFixed(0)}`} unit="元" accent="green" />
            <MetricCard label="最大单笔亏损" value={`${riskMetrics.largestLoss.toFixed(0)}`} unit="元" accent="red" />
          </View>
        </View>

        {/* 方向分析 */}
        <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
          <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">方向分析</Text>
          <View className="flex-row gap-3">
            <View className="flex-1 rounded-lg bg-green-50 p-3 dark:bg-green-900/20">
              <View className="flex-row items-center mb-2">
                <FontAwesome6 name="arrow-trend-up" size={12} color="#10B981" />
                <Text className="ml-1 text-sm font-bold text-green-700 dark:text-green-400">做多</Text>
              </View>
              <Text className="text-xs text-gray-600 dark:text-gray-300">{directionAnalysis.longTrades} 笔</Text>
              <Text className="text-xs text-gray-600 dark:text-gray-300">胜率 {(directionAnalysis.longWinRate * 100).toFixed(0)}%</Text>
              <Text className={`text-sm font-bold ${directionAnalysis.longPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {directionAnalysis.longPnl >= 0 ? '+' : ''}{directionAnalysis.longPnl.toFixed(0)}
              </Text>
            </View>
            <View className="flex-1 rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
              <View className="flex-row items-center mb-2">
                <FontAwesome6 name="arrow-trend-down" size={12} color="#EF4444" />
                <Text className="ml-1 text-sm font-bold text-red-700 dark:text-red-400">做空</Text>
              </View>
              <Text className="text-xs text-gray-600 dark:text-gray-300">{directionAnalysis.shortTrades} 笔</Text>
              <Text className="text-xs text-gray-600 dark:text-gray-300">胜率 {(directionAnalysis.shortWinRate * 100).toFixed(0)}%</Text>
              <Text className={`text-sm font-bold ${directionAnalysis.shortPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {directionAnalysis.shortPnl >= 0 ? '+' : ''}{directionAnalysis.shortPnl.toFixed(0)}
              </Text>
            </View>
          </View>
        </View>

        {/* 分级分析 */}
        {gradeAnalysis.length > 0 && (
          <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <Text className="mb-3 text-base font-bold text-gray-900 dark:text-white">分级表现</Text>
            <View className="gap-2">
              {gradeAnalysis.map((g) => (
                <View key={g.grade} className="flex-row items-center justify-between rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
                  <View className="flex-row items-center">
                    <View className="w-8 h-8 rounded-full items-center justify-center" style={{ backgroundColor: (g.grade === 'A' ? '#10B981' : g.grade === 'B' ? '#3B82F6' : g.grade === 'C' ? '#f59e0b' : '#EF4444') + '20' }}>
                      <Text className="text-sm font-bold" style={{ color: g.grade === 'A' ? '#10B981' : g.grade === 'B' ? '#3B82F6' : g.grade === 'C' ? '#f59e0b' : '#EF4444' }}>{g.grade}</Text>
                    </View>
                    <View className="ml-3">
                      <Text className="text-sm font-medium text-gray-900 dark:text-white">{g.trades} 笔</Text>
                      <Text className="text-xs text-gray-500">胜率 {(g.winRate * 100).toFixed(0)}%</Text>
                    </View>
                  </View>
                  <Text className={`text-sm font-bold ${g.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {g.pnl >= 0 ? '+' : ''}{g.pnl.toFixed(0)}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 最佳品种 */}
        {bestVarieties.length > 0 && (
          <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <View className="flex-row items-center mb-3">
              <FontAwesome6 name="trophy" size={14} color="#f59e0b" />
              <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">最佳品种</Text>
            </View>
            <View className="gap-2">
              {bestVarieties.slice(0, 5).map((v, i) => (
                <View key={v.code} className="flex-row items-center justify-between rounded-lg bg-green-50 p-3 dark:bg-green-900/20">
                  <View className="flex-row items-center">
                    <Text className="text-sm font-bold text-amber-500 mr-2">#{i + 1}</Text>
                    <Text className="text-sm font-bold text-gray-900 dark:text-white">{v.code}</Text>
                  </View>
                  <View className="items-end">
                    <Text className="text-xs text-gray-500">{v.trades}笔 · 胜率{(v.winRate * 100).toFixed(0)}%</Text>
                    <Text className="text-sm font-bold text-green-600">+{v.pnl.toFixed(0)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 最差品种 */}
        {worstVarieties.length > 0 && (
          <View className="mx-4 mt-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <View className="flex-row items-center mb-3">
              <FontAwesome6 name="exclamation" size={14} color="#EF4444" />
              <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">最差品种</Text>
            </View>
            <View className="gap-2">
              {worstVarieties.slice(0, 5).map((v, i) => (
                <View key={v.code} className="flex-row items-center justify-between rounded-lg bg-red-50 p-3 dark:bg-red-900/20">
                  <View className="flex-row items-center">
                    <Text className="text-sm font-bold text-gray-400 mr-2">#{i + 1}</Text>
                    <Text className="text-sm font-bold text-gray-900 dark:text-white">{v.code}</Text>
                  </View>
                  <View className="items-end">
                    <Text className="text-xs text-gray-500">{v.trades}笔 · 胜率{(v.winRate * 100).toFixed(0)}%</Text>
                    <Text className="text-sm font-bold text-red-600">{v.pnl.toFixed(0)}</Text>
                  </View>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* 建议 */}
        {suggestions.length > 0 && (
          <View className="mx-4 mt-4 mb-4 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-800">
            <View className="flex-row items-center mb-3">
              <FontAwesome6 name="lightbulb" size={14} color="#3B82F6" />
              <Text className="ml-2 text-base font-bold text-gray-900 dark:text-white">优化建议</Text>
            </View>
            {suggestions.map((s, i) => (
              <View key={i} className="mb-2 flex-row">
                <Text className="text-amber-500 mr-2">•</Text>
                <Text className="flex-1 text-sm text-gray-700 dark:text-gray-300">{s}</Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

function MetricCard({ label, value, unit, accent }: { label: string; value: string; unit?: string; accent?: 'green' | 'red' }) {
  const valueColor = accent === 'green' ? 'text-green-600 dark:text-green-400' : accent === 'red' ? 'text-red-600 dark:text-red-400' : 'text-gray-900 dark:text-white';
  return (
    <View className="min-w-[90px] flex-1 rounded-lg bg-gray-50 p-3 dark:bg-gray-700">
      <Text className="text-xs text-gray-500">{label}</Text>
      <View className="flex-row items-end mt-1">
        <Text className={`text-lg font-bold ${valueColor}`}>{value}</Text>
        {unit ? <Text className="text-xs text-gray-400 ml-1 mb-0.5">{unit}</Text> : null}
      </View>
    </View>
  );
}
