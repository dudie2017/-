import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ActivityIndicator,
  ScrollView,
  Dimensions,
  TouchableOpacity,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeSearchParams } from '@/hooks/useSafeRouter';
import { LineChart } from 'react-native-gifted-charts';
import { API_BASE, fetchWithTimeout } from '@/utils/api';
import {
  fetchJournalByCode,
  fetchSimTrades,
  type JournalRecord,
  type SimTrade,
  type JournalStats,
} from '@/utils/journalApi';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_WIDTH = SCREEN_WIDTH - 48;

// 止盈止损建议数据类型
interface StopLossAdvice {
  code: string;
  direction: string;
  close: number;
  atr: number;
  entry: { aggressive: number; conservative: number; current: number };
  stop: { price: number; distance: number; distancePct: number; atrMultiple: number; basis: string };
  targets: {
    t1: { price: number; rr: number; basis: string };
    t2: { price: number; rr: number; basis: string };
    t3: { price: number; rr: number; basis: string };
  };
  assessment: { bestRR: number; conservativeRR: number; timeStop: string; liquidity: string };
  trading_cost?: { totalCostPct: number; slippagePct: number; commissionPct: number };
  signal_decay?: { decayFactor: number; effectiveScore: number; level: string; daysSinceSignal: number };
  liquidity?: string;
  grade?: { calibratedGrade: string; calibratedGradeLabel: string };
}

// 频谱颜色映射
const SPECTRUM_COLORS: Record<string, string> = {
  '趋势': '#10B981',
  '通道': '#3B82F6',
  '区间': '#9CA3AF',
};

// 方向颜色
const DIR_COLORS: Record<string, string> = {
  '多': '#10B981',
  '空': '#EF4444',
};

export default function SignalDetailScreen() {
  const { code, name } = useSafeSearchParams<{ code: string; name: string }>();
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [stats, setStats] = useState<JournalStats>({ directionChanges: 0, spectrumUpgrades: 0, spectrumDowngrades: 0, consecutiveSameDirection: 0, avgPFollow: 0 });
  const [trades, setTrades] = useState<SimTrade[]>([]);
  const [loading, setLoading] = useState(true);
  const [advice, setAdvice] = useState<StopLossAdvice | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);

  const loadAdvice = useCallback(async () => {
    if (!code) return;
    setAdviceLoading(true);
    try {
      /**
       * 服务端文件：server/src/routes/scan.ts
       * 接口：GET /api/v1/scan/advice/:code
       * Path 参数：code: string (品种代码如 CU0)
       */
      const resp = await fetchWithTimeout(`${API_BASE}/scan/advice/${code}`);
      const data = await resp.json();
      if (data.direction) {
        setAdvice(data);
      }
    } catch (e) {
      console.warn('加载止盈止损建议失败:', e);
    } finally {
      setAdviceLoading(false);
    }
  }, [code]);

  const loadData = useCallback(async () => {
    if (!code) return;
    setLoading(true);
    try {
      const [journalData, tradeList] = await Promise.all([
        fetchJournalByCode(code, 60),
        fetchSimTrades({ code, limit: 50 }),
      ]);
      setRecords(journalData.records);
      setStats(journalData.stats);
      setTrades(tradeList);
    } catch (e) {
      console.error('加载品种详情失败:', e);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useFocusEffect(
    useCallback(() => {
      loadData();
      loadAdvice();
    }, [loadData, loadAdvice])
  );

  if (loading) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text className="text-gray-500 dark:text-gray-400 mt-4">加载品种详情...</Text>
        </View>
      </Screen>
    );
  }

  if (records.length === 0) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <FontAwesome6 name="chart-line" size={48} color="#ccc" />
          <Text className="text-gray-500 dark:text-gray-400 mt-4">暂无日报记录</Text>
        </View>
      </Screen>
    );
  }

  // 准备图表数据
  const chartData = records
    .slice()
    .reverse()
    .map(r => ({
      value: r.close || 0,
      label: r.trade_date.slice(5), // MM-DD
      date: r.trade_date,
      direction: r.ai_direction,
      spectrum: r.spectrum,
    }));

  // 最新记录
  const latest = records[0];

  return (
    <Screen>
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 40 }}>
        {/* 品种信息头部 */}
        <View className="px-4 pt-4 pb-4 bg-white dark:bg-gray-800">
          <View className="flex-row items-center justify-between mb-2">
            <View>
              <Text className="text-2xl font-bold text-gray-900 dark:text-white">
                {name || code}
              </Text>
              <Text className="text-sm text-gray-500 dark:text-gray-400">{code}</Text>
            </View>
            <View className="items-end">
              <Text className="text-2xl font-bold text-gray-900 dark:text-white">
                {latest.close?.toFixed(0)}
              </Text>
              <Text className={`text-sm font-medium ${latest.change_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {latest.change_pct >= 0 ? '+' : ''}{latest.change_pct.toFixed(2)}%
              </Text>
            </View>
          </View>

          {/* 当前信号状态 */}
          <View className="flex-row items-center gap-2 mt-3">
            <View
              className="px-3 py-1 rounded-full"
              style={{ backgroundColor: (SPECTRUM_COLORS[latest.spectrum] || '#9CA3AF') + '20' }}
            >
              <Text className="text-sm font-medium" style={{ color: SPECTRUM_COLORS[latest.spectrum] || '#9CA3AF' }}>
                {latest.spectrum}
              </Text>
            </View>
            <View
              className="px-3 py-1 rounded-full"
              style={{ backgroundColor: (DIR_COLORS[latest.ai_direction] || '#9CA3AF') + '20' }}
            >
              <Text className="text-sm font-medium" style={{ color: DIR_COLORS[latest.ai_direction] || '#9CA3AF' }}>
                {latest.ai_direction}
              </Text>
            </View>
            <View className="px-3 py-1 rounded-full bg-blue-100 dark:bg-blue-900/30">
              <Text className="text-sm font-medium text-blue-600 dark:text-blue-400">
                P顺 {(latest.p_follow * 100).toFixed(0)}%
              </Text>
            </View>
          </View>
        </View>

        {/* 止盈止损建议 */}
        {adviceLoading ? (
          <View className="px-4 mt-4">
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 items-center">
              <ActivityIndicator size="small" color="#3B82F6" />
              <Text className="text-sm text-gray-500 mt-2">加载交易建议...</Text>
            </View>
          </View>
        ) : advice ? (
          <View className="px-4 mt-4">
            <View className="flex-row items-center mb-3">
              <FontAwesome6 name="crosshairs" size={14} color="#f59e0b" />
              <Text className="text-lg font-bold text-gray-900 dark:text-white ml-2">交易计划</Text>
              {advice.grade?.calibratedGrade ? (
                <View className="ml-auto px-2 py-0.5 rounded-full" style={{ backgroundColor: (advice.grade.calibratedGrade === 'A' ? '#10B981' : advice.grade.calibratedGrade === 'B' ? '#3B82F6' : '#f59e0b') + '20' }}>
                  <Text className="text-xs font-bold" style={{ color: advice.grade.calibratedGrade === 'A' ? '#10B981' : advice.grade.calibratedGrade === 'B' ? '#3B82F6' : '#f59e0b' }}>
                    {advice.grade.calibratedGrade}级 · {advice.grade.calibratedGradeLabel}
                  </Text>
                </View>
              ) : null}
            </View>
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
              {/* 方向 + 当前价 */}
              <View className="flex-row items-center justify-between mb-3">
                <View className="flex-row items-center">
                  <View className="w-3 h-3 rounded-full mr-2" style={{ backgroundColor: advice.direction === '多' ? '#10B981' : '#EF4444' }} />
                  <Text className="text-base font-bold text-gray-900 dark:text-white">{advice.direction}</Text>
                </View>
                <Text className="text-lg font-bold text-gray-900 dark:text-white">{advice.close?.toFixed(1)}</Text>
              </View>

              {/* 入场价建议 */}
              <View className="mb-3 p-3 rounded-xl bg-blue-50 dark:bg-blue-900/20">
                <Text className="text-xs text-blue-600 dark:text-blue-400 font-bold mb-1">入场价建议</Text>
                <View className="flex-row justify-between">
                  <View>
                    <Text className="text-xs text-gray-500">激进</Text>
                    <Text className="text-sm font-bold text-gray-900 dark:text-white">{advice.entry?.aggressive?.toFixed(1)}</Text>
                  </View>
                  <View>
                    <Text className="text-xs text-gray-500">保守</Text>
                    <Text className="text-sm font-bold text-gray-900 dark:text-white">{advice.entry?.conservative?.toFixed(1)}</Text>
                  </View>
                  <View>
                    <Text className="text-xs text-gray-500">ATR</Text>
                    <Text className="text-sm font-bold text-gray-900 dark:text-white">{advice.atr?.toFixed(1)}</Text>
                  </View>
                </View>
              </View>

              {/* 止损价 */}
              <View className="mb-3 p-3 rounded-xl bg-red-50 dark:bg-red-900/20">
                <Text className="text-xs text-red-600 dark:text-red-400 font-bold mb-1">止损价</Text>
                <View className="flex-row justify-between items-center">
                  <Text className="text-lg font-bold text-red-600 dark:text-red-400">{advice.stop?.price?.toFixed(1)}</Text>
                  <View className="items-end">
                    <Text className="text-xs text-gray-500">
                      距离 {advice.stop?.distancePct?.toFixed(1)}% ({advice.stop?.atrMultiple?.toFixed(1)}x ATR)
                    </Text>
                    <Text className="text-xs text-gray-400">依据: {advice.stop?.basis}</Text>
                  </View>
                </View>
              </View>

              {/* 目标价三档 */}
              <View className="mb-3 p-3 rounded-xl bg-green-50 dark:bg-green-900/20">
                <Text className="text-xs text-green-600 dark:text-green-400 font-bold mb-2">目标价</Text>
                <View className="flex-row justify-between">
                  <View className="items-center">
                    <Text className="text-xs text-gray-500">T1 保守</Text>
                    <Text className="text-sm font-bold text-green-600 dark:text-green-400">{advice.targets?.t1?.price?.toFixed(1)}</Text>
                    <Text className="text-xs text-gray-400">盈亏比 {advice.targets?.t1?.rr?.toFixed(1)}</Text>
                  </View>
                  <View className="items-center">
                    <Text className="text-xs text-gray-500">T2 标准</Text>
                    <Text className="text-sm font-bold text-green-600 dark:text-green-400">{advice.targets?.t2?.price?.toFixed(1)}</Text>
                    <Text className="text-xs text-gray-400">盈亏比 {advice.targets?.t2?.rr?.toFixed(1)}</Text>
                  </View>
                  <View className="items-center">
                    <Text className="text-xs text-gray-500">T3 激进</Text>
                    <Text className="text-sm font-bold text-green-600 dark:text-green-400">{advice.targets?.t3?.price?.toFixed(1)}</Text>
                    <Text className="text-xs text-gray-400">盈亏比 {advice.targets?.t3?.rr?.toFixed(1)}</Text>
                  </View>
                </View>
              </View>

              {/* 综合评估 */}
              <View className="flex-row flex-wrap gap-2">
                <View className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700">
                  <Text className="text-xs text-gray-600 dark:text-gray-300">
                    最佳盈亏比 {advice.assessment?.bestRR?.toFixed(1)}
                  </Text>
                </View>
                {advice.assessment?.timeStop ? (
                  <View className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700">
                    <Text className="text-xs text-gray-600 dark:text-gray-300">
                      时间止损: {advice.assessment.timeStop}
                    </Text>
                  </View>
                ) : null}
                {advice.trading_cost ? (
                  <View className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700">
                    <Text className="text-xs text-gray-600 dark:text-gray-300">
                      交易成本 {advice.trading_cost.totalCostPct?.toFixed(2)}%
                    </Text>
                  </View>
                ) : null}
                {advice.signal_decay ? (
                  <View className="px-2 py-1 rounded-lg" style={{ backgroundColor: advice.signal_decay.level === 'fresh' ? '#10B98120' : advice.signal_decay.level === 'aging' ? '#f59e0b20' : '#EF444420' }}>
                    <Text className="text-xs" style={{ color: advice.signal_decay.level === 'fresh' ? '#10B981' : advice.signal_decay.level === 'aging' ? '#f59e0b' : '#EF4444' }}>
                      {advice.signal_decay.level === 'fresh' ? '新鲜信号' : advice.signal_decay.level === 'aging' ? '信号衰减中' : '信号过期'} · {advice.signal_decay.daysSinceSignal}天
                    </Text>
                  </View>
                ) : null}
                {advice.liquidity ? (
                  <View className="px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-700">
                    <Text className="text-xs text-gray-600 dark:text-gray-300">
                      流动性: {advice.liquidity}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          </View>
        ) : null}

        {/* 信号变化统计 */}
        <View className="px-4 mt-4">
          <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
            信号演化统计（近{records.length}天）
          </Text>
          <View className="flex-row gap-3">
            <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
              <Text className="text-xs text-gray-500 dark:text-gray-400">方向翻转</Text>
              <Text className="text-xl font-bold text-orange-600 dark:text-orange-400">
                {stats.directionChanges}次
              </Text>
            </View>
            <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
              <Text className="text-xs text-gray-500 dark:text-gray-400">频谱升级</Text>
              <Text className="text-xl font-bold text-green-600 dark:text-green-400">
                {stats.spectrumUpgrades}次
              </Text>
            </View>
            <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
              <Text className="text-xs text-gray-500 dark:text-gray-400">连续同向</Text>
              <Text className="text-xl font-bold text-blue-600 dark:text-blue-400">
                {stats.consecutiveSameDirection}天
              </Text>
            </View>
          </View>
        </View>

        {/* 价格走势折线图 */}
        <View className="px-4 mt-4">
          <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
            价格走势
          </Text>
          <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
            {chartData.length > 1 ? (
              <LineChart
                data={chartData.map(d => ({ value: d.value }))}
                width={CHART_WIDTH}
                height={180}
                spacing={CHART_WIDTH / Math.max(chartData.length - 1, 1)}
                hideRules
                noOfSections={4}
                curved
                isAnimated
                animationDuration={800}
                hideDataPoints={chartData.length > 20}
                color1="#3B82F6"
                yAxisColor="#E5E7EB"
                xAxisColor="#E5E7EB"
              />
            ) : (
              <View className="h-[180px] items-center justify-center">
                <Text className="text-gray-400">数据不足，无法绘制图表</Text>
              </View>
            )}
          </View>
        </View>

        {/* 信号时间线 */}
        <View className="px-4 mt-4">
          <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
            信号时间线
          </Text>
          <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
            {records.map((record, index) => {
              const prev = index > 0 ? records[index - 1] : null;
              const dirChanged = prev && record.ai_direction !== prev.ai_direction;
              const specChanged = prev && record.spectrum !== prev.spectrum;
              const specColor = SPECTRUM_COLORS[record.spectrum] || '#9CA3AF';
              const dirColor = DIR_COLORS[record.ai_direction] || '#9CA3AF';

              return (
                <View key={record.id || index} className="mb-4 last:mb-0">
                  {/* 日期和变化标记 */}
                  <View className="flex-row items-center mb-1">
                    <Text className="text-sm font-medium text-gray-900 dark:text-white">
                      {record.trade_date}
                    </Text>
                    {dirChanged && (
                      <View className="ml-2 px-2 py-0.5 rounded-full bg-orange-100 dark:bg-orange-900/30">
                        <Text className="text-xs text-orange-600 dark:text-orange-400">
                          方向翻转 {prev?.ai_direction}→{record.ai_direction}
                        </Text>
                      </View>
                    )}
                    {specChanged && (
                      <View className="ml-2 px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30">
                        <Text className="text-xs text-purple-600 dark:text-purple-400">
                          频谱变化 {prev?.spectrum}→{record.spectrum}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* 信号详情 */}
                  <View className="flex-row items-center gap-2 mb-1">
                    <View className="w-2 h-2 rounded-full" style={{ backgroundColor: specColor }} />
                    <Text className="text-xs" style={{ color: specColor }}>{record.spectrum}</Text>
                    <View className="w-2 h-2 rounded-full" style={{ backgroundColor: dirColor }} />
                    <Text className="text-xs" style={{ color: dirColor }}>{record.ai_direction}</Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      P顺 {(record.p_follow * 100).toFixed(0)}%
                    </Text>
                    <Text className="text-xs text-gray-500 dark:text-gray-400">
                      ADX {record.adx?.toFixed(1)}
                    </Text>
                  </View>

                  {/* 一句话摘要 */}
                  <Text className="text-xs text-gray-600 dark:text-gray-300" numberOfLines={2}>
                    {record.one_liner}
                  </Text>

                  {/* 分隔线 */}
                  {index < records.length - 1 && (
                    <View className="mt-3 border-b border-gray-100 dark:border-gray-700" />
                  )}
                </View>
              );
            })}
          </View>
        </View>

        {/* 模拟交易记录 */}
        {trades.length > 0 && (
          <View className="px-4 mt-4">
            <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
              模拟交易记录
            </Text>
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
              {trades.map((trade, index) => {
                const isProfit = (trade.pnl || 0) > 0;
                const isOpen = trade.status === 'open';

                return (
                  <View key={trade.id || index} className="mb-4 last:mb-0">
                    <View className="flex-row items-center justify-between mb-1">
                      <View className="flex-row items-center">
                        <View
                          className="w-6 h-6 rounded-full items-center justify-center mr-2"
                          style={{ backgroundColor: (DIR_COLORS[trade.direction] || '#9CA3AF') + '20' }}
                        >
                          <FontAwesome6
                            name={trade.direction === '多' ? 'arrow-trend-up' : 'arrow-trend-down'}
                            size={12}
                            color={DIR_COLORS[trade.direction] || '#9CA3AF'}
                          />
                        </View>
                        <Text className="text-sm font-medium text-gray-900 dark:text-white">
                          {trade.direction}
                        </Text>
                      </View>
                      {isOpen ? (
                        <View className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/30">
                          <Text className="text-xs text-blue-600 dark:text-blue-400">持仓中</Text>
                        </View>
                      ) : (
                        <Text className={`text-sm font-bold ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                          {isProfit ? '+' : ''}{trade.pnl?.toFixed(0)} ({isProfit ? '+' : ''}{trade.pnl_pct?.toFixed(1)}%)
                        </Text>
                      )}
                    </View>

                    <View className="flex-row items-center justify-between ml-8">
                      <View>
                        <Text className="text-xs text-gray-500 dark:text-gray-400">
                          开仓 {trade.entry_date} @ {trade.entry_price?.toFixed(0)}
                        </Text>
                        {trade.exit_date && (
                          <Text className="text-xs text-gray-500 dark:text-gray-400">
                            平仓 {trade.exit_date} @ {trade.exit_price?.toFixed(0)}
                          </Text>
                        )}
                      </View>
                    </View>

                    {/* 开仓/平仓原因 */}
                    {trade.entry_reason && (
                      <Text className="text-xs text-gray-500 dark:text-gray-400 ml-8 mt-1">
                        {trade.entry_reason}
                      </Text>
                    )}
                    {trade.exit_reason && (
                      <Text className="text-xs text-gray-500 dark:text-gray-400 ml-8">
                        {trade.exit_reason}
                      </Text>
                    )}

                    {index < trades.length - 1 && (
                      <View className="mt-3 border-b border-gray-100 dark:border-gray-700" />
                    )}
                  </View>
                );
              })}
            </View>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
