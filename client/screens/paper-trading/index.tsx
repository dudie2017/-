import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  ScrollView,
  TouchableOpacity,
  TextInput,
  Modal,
  Alert,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useSafeRouter } from '@/hooks/useSafeRouter';


interface ComparisonData {
  ml: {
    trades: number;
    pnl: number;
    winRate: number;
    avgReturn: number;
  };
  manual: {
    trades: number;
    pnl: number;
    winRate: number;
    avgReturn: number;
  };
  comparison: {
    pnlDiff: number;
    winRateDiff: number;
    mlOutperform: boolean;
  };
}

interface PaperTrade {
  id: string;
  varietyCode: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  entryTime: string;
  exitTime?: string;
  status: 'open' | 'closed';
  source: 'ml' | 'manual' | 'portfolio';
  mlConfidence?: number;
  mlPredictedReturn?: string;
  realizedPnl?: number;
  realizedReturn?: number;
}

interface Performance {
  total_trades: number;
  winning_trades: number;
  losing_trades: number;
  total_pnl: number;
  total_return: number;
  max_drawdown: number;
  sharpe_ratio?: number;
  profit_factor?: number;
  win_rate: number;
  avg_win?: number;
  avg_loss?: number;
  ml_trades: number;
  manual_trades: number;
  ml_pnl: number;
  manual_pnl: number;
}

export default function PaperTradingScreen() {
  const router = useSafeRouter();
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [performance, setPerformance] = useState<Performance | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalVisible, setModalVisible] = useState(false);
  const [comparisonVisible, setComparisonVisible] = useState(false);
  const [comparisonData, setComparisonData] = useState<ComparisonData | null>(null);
  const [comparisonLoading, setComparisonLoading] = useState(false);
  const [comparisonError, setComparisonError] = useState('');
  const [closeModalVisible, setCloseModalVisible] = useState(false);
  const [closingTrade, setClosingTrade] = useState<PaperTrade | null>(null);
  const [exitPriceInput, setExitPriceInput] = useState('');
  const [newTrade, setNewTrade] = useState({
    varietyCode: '',
    direction: 'long' as 'long' | 'short',
    quantity: '',
    entryPrice: '',
    source: 'manual' as 'ml' | 'manual',
  });

  const fetchData = useCallback(async () => {
    try {
      const [tradesRes, perfRes] = await Promise.all([
        fetchWithTimeout(`${BACKEND_BASE}/api/v1/paper-trading/trades`),
        fetchWithTimeout(`${BACKEND_BASE}/api/v1/paper-trading/stats`),
      ]);
      const tradesData = await tradesRes.json();
      const perfData = await perfRes.json();
      setTrades(tradesData.data || []);
      setPerformance(perfData.data || null);
    } catch (error) {
      console.error('Failed to fetch paper trading data:', error);
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

  const loadComparison = async () => {
    setComparisonLoading(true);
    setComparisonError('');
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/paper-trading/comparison`
      );
      const data = await response.json();
      if (data.success) {
        setComparisonData(data.data);
        setComparisonVisible(true);
      } else {
        setComparisonError(data.error || '获取对比数据失败');
      }
    } catch (error) {
      console.error('Failed to load comparison:', error);
      setComparisonError('获取对比数据失败');
    } finally {
      setComparisonLoading(false);
    }
  };

  const handleOpenTrade = async () => {
    if (!newTrade.varietyCode || !newTrade.quantity || !newTrade.entryPrice) {
      Alert.alert('错误', '请填写完整信息');
      return;
    }

    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/paper-trading/open`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            varietyCode: newTrade.varietyCode,
            direction: newTrade.direction,
            quantity: parseFloat(newTrade.quantity),
            entryPrice: parseFloat(newTrade.entryPrice),
            source: newTrade.source,
          }),
        }
      );
      const data = await response.json();
      if (data.success) {
        setModalVisible(false);
        setNewTrade({
          varietyCode: '',
          direction: 'long',
          quantity: '',
          entryPrice: '',
          source: 'manual',
        });
        fetchData();
      } else {
        Alert.alert('错误', data.error || '开仓失败');
      }
    } catch (error) {
      Alert.alert('错误', '网络错误');
    }
  };

  const handleCloseTrade = async (tradeId: string, exitPrice: number) => {
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/paper-trading/close`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tradeId, exitPrice }),
        }
      );
      const data = await response.json();
      if (data.success) {
        fetchData();
      } else {
        Alert.alert('错误', data.error || '平仓失败');
      }
    } catch (error) {
      Alert.alert('错误', '网络错误');
    }
  };

  const handleConfirmClose = async () => {
    const exitPrice = parseFloat(exitPriceInput);
    if (!closingTrade) return;
    if (isNaN(exitPrice) || exitPrice <= 0) {
      Alert.alert('错误', '请输入有效的平仓价格');
      return;
    }
    await handleCloseTrade(closingTrade.id, exitPrice);
    setCloseModalVisible(false);
    setClosingTrade(null);
    setExitPriceInput('');
  };

  const renderTrade = ({ item }: { item: PaperTrade }) => (
    <View className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-3 shadow">
      <View className="flex-row justify-between items-center mb-2">
        <Text className="text-lg font-bold text-gray-900 dark:text-white">
          {item.varietyCode}
        </Text>
        <View className="flex-row items-center gap-2">
          {item.source === 'ml' && (
            <View className="bg-blue-100 dark:bg-blue-900 px-2 py-1 rounded">
              <Text className="text-blue-800 dark:text-blue-200 text-xs font-medium">
                ML
              </Text>
            </View>
          )}
          {item.source === 'portfolio' && (
            <View className="bg-purple-100 dark:bg-purple-900 px-2 py-1 rounded">
              <Text className="text-purple-800 dark:text-purple-200 text-xs font-medium">
                组合
              </Text>
            </View>
          )}
          <View
            className={`px-2 py-1 rounded ${
              item.direction === 'long'
                ? 'bg-green-100 dark:bg-green-900'
                : 'bg-red-100 dark:bg-red-900'
            }`}
          >
            <Text
              className={`text-xs font-medium ${
                item.direction === 'long'
                  ? 'text-green-800 dark:text-green-200'
                  : 'text-red-800 dark:text-red-200'
              }`}
            >
              {item.direction === 'long' ? '多' : '空'}
            </Text>
          </View>
        </View>
      </View>

      <View className="flex-row justify-between mb-1">
        <Text className="text-gray-600 dark:text-gray-400">开仓价:</Text>
        <Text className="text-gray-900 dark:text-white font-medium">
          {(item.entryPrice ?? 0).toFixed(2)}
        </Text>
      </View>

      {item.exitPrice != null && (
        <View className="flex-row justify-between mb-1">
          <Text className="text-gray-600 dark:text-gray-400">平仓价:</Text>
          <Text className="text-gray-900 dark:text-white font-medium">
            {item.exitPrice.toFixed(2)}
          </Text>
        </View>
      )}

      {item.mlConfidence != null && (
        <View className="flex-row justify-between mb-1">
          <Text className="text-gray-600 dark:text-gray-400">ML 置信度:</Text>
          <Text className="text-blue-600 dark:text-blue-400 font-medium">
            {(item.mlConfidence * 100).toFixed(0)}%
          </Text>
        </View>
      )}

      {item.realizedPnl != null && (
        <View className="flex-row justify-between mb-1">
          <Text className="text-gray-600 dark:text-gray-400">盈亏:</Text>
          <Text
            className={`font-bold ${
              item.realizedPnl >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {item.realizedPnl >= 0 ? '+' : ''}
            {item.realizedPnl.toFixed(2)}
          </Text>
        </View>
      )}

      <View className="flex-row justify-between items-center mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {new Date(item.entryTime).toLocaleString('zh-CN')}
        </Text>
        {item.status === 'open' && (
          <TouchableOpacity
            className="bg-orange-500 px-3 py-1 rounded"
            onPress={() => {
              setClosingTrade(item);
              setExitPriceInput('');
              setCloseModalVisible(true);
            }}
          >
            <Text className="text-white text-xs font-medium">平仓</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );

  if (loading) {
    return (
      <View className="flex-1 bg-gray-50 dark:bg-gray-900">
        <View className="flex-1 justify-center items-center">
          <Text className="text-gray-500 dark:text-gray-400">加载中...</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1 bg-gray-50 dark:bg-gray-900">
      <View className="px-4 pt-4 pb-2">
        <View className="flex-row justify-between items-center mb-4">
          <Text className="text-2xl font-bold text-gray-900 dark:text-white">
            模拟交易
          </Text>
          <View className="flex-row gap-2">
            <TouchableOpacity
              className="bg-purple-500 px-4 py-2 rounded-lg"
              onPress={loadComparison}
            >
              <Text className="text-white font-medium">对比分析</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="bg-blue-500 px-4 py-2 rounded-lg"
              onPress={() => setModalVisible(true)}
            >
              <Text className="text-white font-medium">开仓</Text>
            </TouchableOpacity>
          </View>
        </View>

        {performance && (
          <View className="bg-white dark:bg-gray-800 rounded-lg p-4 mb-4 shadow">
            <Text className="text-lg font-bold text-gray-900 dark:text-white mb-3">
              绩效概览
            </Text>
            <View className="gap-3">
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Text className="text-gray-600 dark:text-gray-400 text-xs">
                    总交易
                  </Text>
                  <Text className="text-gray-900 dark:text-white font-bold text-lg">
                    {performance.total_trades ?? 0}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-gray-600 dark:text-gray-400 text-xs">
                    胜率
                  </Text>
                  <Text className="text-gray-900 dark:text-white font-bold text-lg">
                    {((performance.win_rate ?? 0) * 100).toFixed(1)}%
                  </Text>
                </View>
              </View>
              <View className="flex-row gap-3">
                <View className="flex-1">
                  <Text className="text-gray-600 dark:text-gray-400 text-xs">
                    总盈亏
                  </Text>
                  <Text
                    className={`font-bold text-lg ${
                      (performance.total_pnl ?? 0) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {(performance.total_pnl ?? 0) >= 0 ? '+' : ''}
                    {(performance.total_pnl ?? 0).toFixed(2)}
                  </Text>
                </View>
                <View className="flex-1">
                  <Text className="text-gray-600 dark:text-gray-400 text-xs">
                    最大回撤
                  </Text>
                  <Text className="text-red-600 dark:text-red-400 font-bold text-lg">
                    {((performance.max_drawdown ?? 0) * 100).toFixed(2)}%
                  </Text>
                </View>
              </View>
            </View>

            <View className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700">
              <View className="flex-row justify-between mb-2">
                <Text className="text-gray-600 dark:text-gray-400 text-sm">
                  ML 交易
                </Text>
                <Text className="text-blue-600 dark:text-blue-400 font-medium text-sm">
                  {performance.ml_trades ?? 0} 笔 /{' '}
                  {(performance.ml_pnl ?? 0) >= 0 ? '+' : ''}
                  {(performance.ml_pnl ?? 0).toFixed(2)}
                </Text>
              </View>
              <View className="flex-row justify-between">
                <Text className="text-gray-600 dark:text-gray-400 text-sm">
                  人工交易
                </Text>
                <Text className="text-gray-700 dark:text-gray-300 font-medium text-sm">
                  {performance.manual_trades ?? 0} 笔 /{' '}
                  {(performance.manual_pnl ?? 0) >= 0 ? '+' : ''}
                  {(performance.manual_pnl ?? 0).toFixed(2)}
                </Text>
              </View>
            </View>
          </View>
        )}
      </View>

      <FlatList
        data={trades}
        renderItem={renderTrade}
        keyExtractor={(item) => item.id}
        contentContainerStyle={{ padding: 16 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
        ListEmptyComponent={
          <View className="py-12 items-center">
            <Text className="text-gray-500 dark:text-gray-400">暂无交易记录</Text>
          </View>
        }
      />

      <Modal
        visible={modalVisible}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setModalVisible(false)}
      >
        <View className="flex-1 justify-end bg-black/50">
          <View className="bg-white dark:bg-gray-800 rounded-t-2xl p-6">
            <Text className="text-xl font-bold text-gray-900 dark:text-white mb-4">
              新开仓
            </Text>

            <View className="mb-4">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">
                品种代码
              </Text>
              <TextInput
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-white"
                placeholder="例如：AU0"
                value={newTrade.varietyCode}
                onChangeText={(text) =>
                  setNewTrade({ ...newTrade, varietyCode: text })
                }
              />
            </View>

            <View className="mb-4">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">方向</Text>
              <View className="flex-row gap-3">
                <TouchableOpacity
                  className={`flex-1 py-3 rounded-lg ${
                    newTrade.direction === 'long'
                      ? 'bg-green-500'
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                  onPress={() => setNewTrade({ ...newTrade, direction: 'long' })}
                >
                  <Text
                    className={`text-center font-medium ${
                      newTrade.direction === 'long'
                        ? 'text-white'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    做多
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className={`flex-1 py-3 rounded-lg ${
                    newTrade.direction === 'short'
                      ? 'bg-red-500'
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                  onPress={() =>
                    setNewTrade({ ...newTrade, direction: 'short' })
                  }
                >
                  <Text
                    className={`text-center font-medium ${
                      newTrade.direction === 'short'
                        ? 'text-white'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    做空
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View className="mb-4">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">数量</Text>
              <TextInput
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-white"
                placeholder="例如：10"
                keyboardType="numeric"
                value={newTrade.quantity}
                onChangeText={(text) =>
                  setNewTrade({ ...newTrade, quantity: text })
                }
              />
            </View>

            <View className="mb-4">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">
                开仓价格
              </Text>
              <TextInput
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-white"
                placeholder="例如：5000"
                keyboardType="numeric"
                value={newTrade.entryPrice}
                onChangeText={(text) =>
                  setNewTrade({ ...newTrade, entryPrice: text })
                }
              />
            </View>

            <View className="mb-6">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">来源</Text>
              <View className="flex-row gap-3">
                <TouchableOpacity
                  className={`flex-1 py-3 rounded-lg ${
                    newTrade.source === 'ml'
                      ? 'bg-blue-500'
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                  onPress={() => setNewTrade({ ...newTrade, source: 'ml' })}
                >
                  <Text
                    className={`text-center font-medium ${
                      newTrade.source === 'ml'
                        ? 'text-white'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    ML 推荐
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className={`flex-1 py-3 rounded-lg ${
                    newTrade.source === 'manual'
                      ? 'bg-gray-500'
                      : 'bg-gray-200 dark:bg-gray-700'
                  }`}
                  onPress={() => setNewTrade({ ...newTrade, source: 'manual' })}
                >
                  <Text
                    className={`text-center font-medium ${
                      newTrade.source === 'manual'
                        ? 'text-white'
                        : 'text-gray-700 dark:text-gray-300'
                    }`}
                  >
                    人工决策
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            <View className="flex-row gap-3">
              <TouchableOpacity
                className="flex-1 bg-gray-200 dark:bg-gray-700 py-3 rounded-lg"
                onPress={() => setModalVisible(false)}
              >
                <Text className="text-center text-gray-700 dark:text-gray-300 font-medium">
                  取消
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 bg-blue-500 py-3 rounded-lg"
                onPress={handleOpenTrade}
              >
                <Text className="text-center text-white font-medium">确认开仓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 平仓价格输入 Modal */}
      <Modal
        visible={closeModalVisible}
        animationType="fade"
        transparent
        onRequestClose={() => setCloseModalVisible(false)}
      >
        <View className="flex-1 justify-center bg-black/50 px-6">
          <View className="bg-white dark:bg-gray-800 rounded-2xl p-6">
            <Text className="text-xl font-bold text-gray-900 dark:text-white mb-2">
              平仓
            </Text>
            <Text className="text-gray-600 dark:text-gray-400 mb-4">
              品种：{closingTrade?.varietyCode}
            </Text>

            <View className="mb-6">
              <Text className="text-gray-700 dark:text-gray-300 mb-2">
                平仓价格
              </Text>
              <TextInput
                className="border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-white"
                placeholder="请输入平仓价格"
                keyboardType="numeric"
                value={exitPriceInput}
                onChangeText={setExitPriceInput}
              />
            </View>

            <View className="flex-row gap-3">
              <TouchableOpacity
                className="flex-1 bg-gray-200 dark:bg-gray-700 py-3 rounded-lg"
                onPress={() => setCloseModalVisible(false)}
              >
                <Text className="text-center text-gray-700 dark:text-gray-300 font-medium">
                  取消
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                className="flex-1 bg-orange-500 py-3 rounded-lg"
                onPress={handleConfirmClose}
              >
                <Text className="text-center text-white font-medium">确认平仓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 对比分析 Modal */}
      <Modal
        visible={comparisonVisible}
        animationType="slide"
        transparent
        onRequestClose={() => setComparisonVisible(false)}
      >
        <View className="flex-1 bg-black/50 justify-end">
          <View className="bg-white dark:bg-gray-800 rounded-t-3xl p-6 max-h-[80%]">
            <View className="flex-row justify-between items-center mb-4">
              <Text className="text-xl font-bold text-gray-900 dark:text-white">
                ML vs 手动决策对比
              </Text>
              <TouchableOpacity onPress={() => setComparisonVisible(false)}>
                <Text className="text-gray-500 text-2xl">✕</Text>
              </TouchableOpacity>
            </View>

            {comparisonLoading ? (
              <View className="py-10">
                <Text className="text-gray-500 text-center">加载中...</Text>
              </View>
            ) : comparisonError ? (
              <View className="py-10">
                <Text className="text-red-500 text-center">{comparisonError}</Text>
              </View>
            ) : comparisonData ? (
              <ScrollView>
                {/* 总体对比 */}
                <View className="mb-6">
                  <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    总体表现
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-purple-50 dark:bg-purple-900/20 p-4 rounded-xl">
                      <Text className="text-purple-600 dark:text-purple-400 text-sm mb-1">
                        ML 推荐
                      </Text>
                      <Text className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                        {comparisonData.ml?.trades ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">总交易次数</Text>
                    </View>
                    <View className="flex-1 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-xl">
                      <Text className="text-blue-600 dark:text-blue-400 text-sm mb-1">
                        人工决策
                      </Text>
                      <Text className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                        {comparisonData.manual?.trades ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">总交易次数</Text>
                    </View>
                  </View>
                </View>

                {/* 胜率对比 */}
                <View className="mb-6">
                  <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    胜率对比
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-purple-50 dark:bg-purple-900/20 p-4 rounded-xl">
                      <Text className="text-purple-600 dark:text-purple-400 text-sm mb-1">
                        ML 推荐
                      </Text>
                      <Text className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                        {((comparisonData.ml?.winRate ?? 0) * 100).toFixed(1)}%
                      </Text>
                    </View>
                    <View className="flex-1 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-xl">
                      <Text className="text-blue-600 dark:text-blue-400 text-sm mb-1">
                        人工决策
                      </Text>
                      <Text className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                        {((comparisonData.manual?.winRate ?? 0) * 100).toFixed(1)}%
                      </Text>
                    </View>
                  </View>
                </View>

                {/* 收益对比 */}
                <View className="mb-6">
                  <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    收益对比
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-purple-50 dark:bg-purple-900/20 p-4 rounded-xl">
                      <Text className="text-purple-600 dark:text-purple-400 text-sm mb-1">
                        ML 推荐
                      </Text>
                      <Text
                        className={`text-2xl font-bold ${
                          (comparisonData.ml?.pnl ?? 0) >= 0
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {(comparisonData.ml?.pnl ?? 0) >= 0 ? '+' : ''}
                        {(comparisonData.ml?.pnl ?? 0).toFixed(0)}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">总盈亏</Text>
                    </View>
                    <View className="flex-1 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-xl">
                      <Text className="text-blue-600 dark:text-blue-400 text-sm mb-1">
                        人工决策
                      </Text>
                      <Text
                        className={`text-2xl font-bold ${
                          (comparisonData.manual?.pnl ?? 0) >= 0
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                        }`}
                      >
                        {(comparisonData.manual?.pnl ?? 0) >= 0 ? '+' : ''}
                        {(comparisonData.manual?.pnl ?? 0).toFixed(0)}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">总盈亏</Text>
                    </View>
                  </View>
                </View>

                {/* 平均盈亏对比 */}
                <View className="mb-6">
                  <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    平均盈亏
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-purple-50 dark:bg-purple-900/20 p-4 rounded-xl">
                      <Text className="text-purple-600 dark:text-purple-400 text-sm mb-1">
                        ML 推荐
                      </Text>
                      <Text className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                        {(comparisonData.ml?.avgReturn ?? 0).toFixed(0)}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">平均每笔</Text>
                    </View>
                    <View className="flex-1 bg-blue-50 dark:bg-blue-900/20 p-4 rounded-xl">
                      <Text className="text-blue-600 dark:text-blue-400 text-sm mb-1">
                        人工决策
                      </Text>
                      <Text className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                        {(comparisonData.manual?.avgReturn ?? 0).toFixed(0)}
                      </Text>
                      <Text className="text-xs text-gray-500 mt-1">平均每笔</Text>
                    </View>
                  </View>
                </View>

                {/* 对比结论 */}
                <View className="mb-6">
                  <Text className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
                    对比结论
                  </Text>
                  <View className="bg-gray-50 dark:bg-gray-700 p-4 rounded-xl">
                    <Text className="text-sm font-semibold text-gray-900 dark:text-white">
                      {comparisonData.comparison?.mlOutperform
                        ? 'ML 推荐整体表现更优'
                        : '人工决策整体表现更优'}
                    </Text>
                    <Text className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                      盈亏差距：{(comparisonData.comparison?.pnlDiff ?? 0) >= 0 ? '+' : ''}
                      {(comparisonData.comparison?.pnlDiff ?? 0).toFixed(0)}
                    </Text>
                    <Text className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                      胜率差距：{(comparisonData.comparison?.winRateDiff ?? 0) >= 0 ? '+' : ''}
                      {((comparisonData.comparison?.winRateDiff ?? 0) * 100).toFixed(1)}%
                    </Text>
                  </View>
                </View>
              </ScrollView>
            ) : null}
          </View>
        </View>
      </Modal>
    </View>
  );
}
