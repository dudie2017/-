import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { LineChart, BarChart } from 'react-native-gifted-charts';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  fetchSimTrades,
  fetchSimTradeStats,
  type SimTrade,
  type SimTradeStats,
} from '@/utils/journalApi';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const CHART_WIDTH = SCREEN_WIDTH - 48;

// 方向颜色
const DIR_COLORS: Record<string, string> = {
  '多': '#10B981',
  '空': '#EF4444',
};

export default function SimTradesScreen() {
  const router = useSafeRouter();
  const [stats, setStats] = useState<SimTradeStats>({ totalTrades: 0, winTrades: 0, lossTrades: 0, winRate: 0, totalPnl: 0, maxDrawdown: 0, openTrades: 0, closedTrades: 0, floatingPnl: 0, avgPnl: 0, bestTrade: 0, worstTrade: 0, avgWin: 0, avgLoss: 0, profitFactor: 0 });
  const [openTrades, setOpenTrades] = useState<SimTrade[]>([]);
  const [closedTrades, setClosedTrades] = useState<SimTrade[]>([]);
  const [equityCurve, setEquityCurve] = useState<{ date: string; value: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'open' | 'closed'>('open');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [statsData, openList, closedList] = await Promise.all([
        fetchSimTradeStats(),
        fetchSimTrades({ status: 'open' }),
        fetchSimTrades({ status: 'closed', limit: 100 }),
      ]);
      setStats(statsData);
      setOpenTrades(openList);
      setClosedTrades(closedList);

      // 计算资金曲线
      const curve: { date: string; value: number }[] = [];
      let cumPnl = 0;
      const sortedClosed = [...closedList].sort((a, b) =>
        (a.exit_date || '').localeCompare(b.exit_date || '')
      );
      curve.push({ date: '起始', value: 0 });
      for (const trade of sortedClosed) {
        cumPnl += trade.pnl || 0;
        curve.push({ date: (trade.exit_date || '').slice(5), value: cumPnl });
      }
      setEquityCurve(curve);
    } catch (e) {
      console.error('加载模拟交易失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  if (loading) {
    return (
      <View className="flex-1">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text className="text-gray-500 dark:text-gray-400 mt-4">加载模拟交易...</Text>
        </View>
      </View>
    );
  }

  const renderStatCard = (title: string, value: string | number, color: string, icon: string) => (
    <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
      <View className="flex-row items-center mb-1">
        <FontAwesome6 name={icon as any} size={12} color={color} />
        <Text className="text-xs text-gray-500 dark:text-gray-400 ml-1">{title}</Text>
      </View>
      <Text className="text-lg font-bold" style={{ color }}>
        {value}
      </Text>
    </View>
  );

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* 标题 */}
        <View className="px-4 pt-4 pb-2">
          <View className="flex-row items-center justify-between">
            <View>
              <Text className="text-2xl font-bold text-gray-900 dark:text-white">
                模拟交易
              </Text>
              <Text className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                基于信号建议的自动模拟交易记录
              </Text>
            </View>
            <TouchableOpacity
              onPress={() => router.push('/risk-dashboard')}
              className="bg-amber-500 px-3 py-2 rounded-lg"
            >
              <View className="flex-row items-center">
                <FontAwesome6 name="shield-halved" size={14} color="white" />
                <Text className="text-white text-sm font-medium ml-1.5">风险</Text>
              </View>
            </TouchableOpacity>
          </View>
        </View>

        {/* 统计卡片 */}
        <View className="px-4 mt-2">
          <View className="flex-row gap-3 mb-3">
            {renderStatCard('总交易', stats.totalTrades, '#3B82F6', 'chart-line')}
            {renderStatCard('胜率', `${(stats.winRate * 100).toFixed(0)}%`, stats.winRate >= 0.5 ? '#10B981' : '#F59E0B', 'trophy')}
          </View>
          <View className="flex-row gap-3">
            {renderStatCard(
              '累计盈亏',
              `${stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(0)}`,
              stats.totalPnl >= 0 ? '#10B981' : '#EF4444',
              'coins'
            )}
            {renderStatCard('最大回撤', `${stats.maxDrawdown.toFixed(0)}`, '#EF4444', 'arrow-trend-down')}
          </View>
        </View>

        {/* 资金曲线图 */}
        {equityCurve.length > 2 && (
          <View className="px-4 mt-4">
            <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
              资金曲线
            </Text>
            <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
              <LineChart
                data={equityCurve.map(d => ({ value: d.value }))}
                width={CHART_WIDTH}
                height={160}
                spacing={CHART_WIDTH / Math.max(equityCurve.length - 1, 1)}
                hideRules
                noOfSections={4}
                curved
                isAnimated
                animationDuration={800}
                hideDataPoints={equityCurve.length > 20}
                color1={stats.totalPnl >= 0 ? '#10B981' : '#EF4444'}
                yAxisColor="#E5E7EB"
                xAxisColor="#E5E7EB"
              />
            </View>
          </View>
        )}

        {/* Tab 切换 */}
        <View className="px-4 mt-4">
          <View className="flex-row bg-gray-100 dark:bg-gray-700 rounded-xl p-1">
            <TouchableOpacity
              onPress={() => setActiveTab('open')}
              className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'open' ? 'bg-white dark:bg-gray-600 shadow-sm' : ''}`}
            >
              <Text className={`text-sm font-medium ${activeTab === 'open' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}>
                持仓中 ({openTrades.length})
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setActiveTab('closed')}
              className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'closed' ? 'bg-white dark:bg-gray-600 shadow-sm' : ''}`}
            >
              <Text className={`text-sm font-medium ${activeTab === 'closed' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500'}`}>
                已平仓 ({closedTrades.length})
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 交易列表 */}
        <View className="px-4 mt-3">
          {activeTab === 'open' ? (
            openTrades.length === 0 ? (
              <View className="bg-white dark:bg-gray-800 rounded-2xl p-8 items-center shadow-sm">
                <FontAwesome6 name="inbox" size={36} color="#ccc" />
                <Text className="text-gray-500 dark:text-gray-400 mt-3">暂无持仓</Text>
              </View>
            ) : (
              <View className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm overflow-hidden">
                {openTrades.map((trade, index) => (
                  <TouchableOpacity
                    key={trade.id || index}
                    onPress={() => router.push('/signal-detail', { code: trade.code, name: trade.name })}
                    className={`px-4 py-4 ${index < openTrades.length - 1 ? 'border-b border-gray-100 dark:border-gray-700' : ''}`}
                  >
                    <View className="flex-row items-center justify-between">
                      <View className="flex-row items-center">
                        <View
                          className="w-8 h-8 rounded-full items-center justify-center mr-3"
                          style={{ backgroundColor: (DIR_COLORS[trade.direction] || '#9CA3AF') + '20' }}
                        >
                          <FontAwesome6
                            name={trade.direction === '多' ? 'arrow-trend-up' : 'arrow-trend-down'}
                            size={14}
                            color={DIR_COLORS[trade.direction] || '#9CA3AF'}
                          />
                        </View>
                        <View>
                          <View className="flex-row items-center">
                            <Text className="text-sm font-medium text-gray-900 dark:text-white">
                              {trade.name}
                            </Text>
                            {trade.signal_grade ? (
                              <Text className="text-[10px] font-bold text-blue-600 dark:text-blue-400 ml-1.5 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded">
                                {trade.signal_grade}
                              </Text>
                            ) : null}
                          </View>
                          <Text className="text-xs text-gray-500 dark:text-gray-400">
                            {trade.code} · {trade.direction}
                          </Text>
                        </View>
                      </View>
                      <View className="items-end">
                        <Text className="text-xs text-gray-500 dark:text-gray-400">
                          开仓 {trade.entry_date}
                        </Text>
                        <Text className="text-xs text-gray-500 dark:text-gray-400">
                          @ {trade.entry_price?.toFixed(0)}
                        </Text>
                      </View>
                    </View>
                    {/* 止损止盈标签 */}
                    {(trade.stop_loss || trade.take_profit || trade.position_size) && (
                      <View className="flex-row items-center mt-2 ml-11 gap-2">
                        {trade.position_size && trade.position_size > 1 ? (
                          <Text className="text-[10px] text-purple-500 dark:text-purple-400 font-medium">
                            Kelly {trade.position_size}手
                          </Text>
                        ) : null}
                        {trade.stop_loss ? (
                          <Text className="text-[10px] text-red-500 dark:text-red-400">
                            止损 {trade.stop_loss.toFixed(0)}
                          </Text>
                        ) : null}
                        {trade.take_profit ? (
                          <Text className="text-[10px] text-green-500 dark:text-green-400">
                            止盈 {trade.take_profit.toFixed(0)}
                          </Text>
                        ) : null}
                        {trade.max_hold_days ? (
                          <Text className="text-[10px] text-gray-400 dark:text-gray-500">
                            最长{trade.max_hold_days}天
                          </Text>
                        ) : null}
                      </View>
                    )}
                    {trade.entry_reason ? (
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1.5 ml-11">
                        {trade.entry_reason}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                ))}
              </View>
            )
          ) : (
            closedTrades.length === 0 ? (
              <View className="bg-white dark:bg-gray-800 rounded-2xl p-8 items-center shadow-sm">
                <FontAwesome6 name="inbox" size={36} color="#ccc" />
                <Text className="text-gray-500 dark:text-gray-400 mt-3">暂无平仓记录</Text>
              </View>
            ) : (
              <View className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm overflow-hidden">
                {closedTrades.map((trade, index) => {
                  const isProfit = (trade.pnl || 0) > 0;
                  return (
                    <TouchableOpacity
                      key={trade.id || index}
                      onPress={() => router.push('/signal-detail', { code: trade.code, name: trade.name })}
                      className={`px-4 py-4 ${index < closedTrades.length - 1 ? 'border-b border-gray-100 dark:border-gray-700' : ''}`}
                    >
                      <View className="flex-row items-center justify-between">
                        <View className="flex-row items-center flex-1">
                          <View
                            className="w-8 h-8 rounded-full items-center justify-center mr-3"
                            style={{ backgroundColor: (DIR_COLORS[trade.direction] || '#9CA3AF') + '20' }}
                          >
                            <FontAwesome6
                              name={trade.direction === '多' ? 'arrow-trend-up' : 'arrow-trend-down'}
                              size={14}
                              color={DIR_COLORS[trade.direction] || '#9CA3AF'}
                            />
                          </View>
                          <View className="flex-1">
                            <View className="flex-row items-center">
                              <Text className="text-sm font-medium text-gray-900 dark:text-white">
                                {trade.name}
                              </Text>
                              <Text className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                                {trade.code}
                              </Text>
                            </View>
                            <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                              {trade.entry_date} → {trade.exit_date} · {trade.direction}
                            </Text>
                          </View>
                        </View>
                        <View className="items-end ml-2">
                          <Text className={`text-sm font-bold ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                            {isProfit ? '+' : ''}{trade.pnl?.toFixed(0)}
                          </Text>
                          <Text className={`text-xs ${isProfit ? 'text-green-600' : 'text-red-600'}`}>
                            {isProfit ? '+' : ''}{trade.pnl_pct?.toFixed(1)}%
                          </Text>
                        </View>
                      </View>
                      {/* 平仓原因 */}
                      {trade.exit_reason ? (
                        <Text className="text-[10px] text-gray-400 dark:text-gray-500 mt-1.5 ml-11">
                          {trade.exit_reason}
                          {trade.fee ? ` · 手续费 ${trade.fee.toFixed(0)}` : ''}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )
          )}
        </View>
      </ScrollView>
    </View>
  );
}
