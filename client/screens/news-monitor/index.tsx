/**
 * 方案C：实时新闻接入 - 新闻监控页面
 * 展示实时新闻、检测到的黑天鹅事件、传播链预警
 */

import { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, RefreshControl, Linking, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { fetchNewsScan, fetchNewsInterpretation, fetchNewsTradeAdvices, fetchNewsItemInterpretations, fetchVarietyNews, type NewsScanResult, type NewsItem, type DetectedEvent, type PropagationAlert, type NewsInterpretation, type NewsTradeAdvices, type EventTradeAdvice, type AlertTradeAdvice, type NewsItemInterpretation, type VarietyNewsResult } from '@/utils/newsApi';
import { FontAwesome6 } from '@expo/vector-icons';

// 事件类别颜色
const CATEGORY_COLORS: Record<string, string> = {
  '地缘政治': '#ef4444',
  '自然灾害': '#f97316',
  '供应中断': '#eab308',
  '政策调控': '#3b82f6',
  '库存变化': '#22c55e',
  '价格极端': '#a855f7',
  'OPEC': '#06b6d4',
  '环保政策': '#10b981',
  '汇率波动': '#6366f1',
  '投机资金': '#ec4899',
};

// 板块颜色
const SECTOR_COLORS: Record<string, string> = {
  '黑色系': '#64748b',
  '有色金属': '#f59e0b',
  '贵金属': '#eab308',
  '油脂油料': '#22c55e',
  '软商品': '#a855f7',
  '能源化工': '#ef4444',
  '化工': '#3b82f6',
  '金融': '#6366f1',
};

export default function NewsMonitorScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [scanResult, setScanResult] = useState<NewsScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [interpretation, setInterpretation] = useState<NewsInterpretation | null>(null);
  const [interpretationLoading, setInterpretationLoading] = useState(false);
  const [tradeAdvices, setTradeAdvices] = useState<NewsTradeAdvices | null>(null);
  const [tradeAdvicesLoading, setTradeAdvicesLoading] = useState(false);
  const [newsInterpretations, setNewsInterpretations] = useState<NewsItemInterpretation[] | null>(null);
  const [newsInterpretationsLoading, setNewsInterpretationsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'news' | 'events' | 'alerts' | 'variety' | 'ai'>('news');

  // 逐品种新闻搜索
  const [varietyCode, setVarietyCode] = useState('');
  const [varietyNews, setVarietyNews] = useState<VarietyNewsResult | null>(null);
  const [varietyNewsLoading, setVarietyNewsLoading] = useState(false);
  const [varietyNewsError, setVarietyNewsError] = useState<string | null>(null);

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    try {
      const result = await fetchNewsScan();
      setScanResult(result);
      // 扫描成功后自动拉取逐条交易建议（传入当前扫描结果，保证 eventId 一致）
      if (result.detectedEvents.length > 0 || result.propagationAlerts.length > 0) {
        setTradeAdvicesLoading(true);
        fetchNewsTradeAdvices(result.detectedEvents, result.propagationAlerts)
          .then(setTradeAdvices)
          .catch((err) => console.warn('逐条交易建议加载失败:', err))
          .finally(() => setTradeAdvicesLoading(false));
      }
      // 扫描成功后自动拉取逐条新闻 AI 解读（传入当前新闻列表，保证索引一致）
      if (result.news.length > 0) {
        setNewsInterpretationsLoading(true);
        fetchNewsItemInterpretations(result.news)
          .then(setNewsInterpretations)
          .catch((err) => console.warn('逐条新闻解读加载失败:', err))
          .finally(() => setNewsInterpretationsLoading(false));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  const handleRefresh = useCallback(() => {
    loadData(true);
  }, [loadData]);

  // 加载 AI 深度解读
  const loadInterpretation = useCallback(async () => {
    setInterpretationLoading(true);
    try {
      const result = await fetchNewsInterpretation();
      setInterpretation(result);
    } catch (err) {
      console.warn('AI解读加载失败:', err);
    } finally {
      setInterpretationLoading(false);
    }
  }, []);

  // 逐品种新闻搜索
  const handleVarietySearch = useCallback(async () => {
    const code = varietyCode.trim().toUpperCase();
    if (!code) return;
    setVarietyNewsLoading(true);
    setVarietyNewsError(null);
    setVarietyNews(null);
    try {
      const result = await fetchVarietyNews(code);
      setVarietyNews(result);
    } catch (err) {
      setVarietyNewsError(err instanceof Error ? err.message : '搜索失败');
    } finally {
      setVarietyNewsLoading(false);
    }
  }, [varietyCode]);

  // 页面聚焦时加载
  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  // 新闻卡片下方的 AI 解读
  const renderNewsAdvice = (item: NewsItem, index: number) => {
    const interp = newsInterpretations?.[index];
    if (!interp) {
      if (newsInterpretationsLoading) {
        return (
          <View className="mt-3 flex-row items-center">
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text className="text-gray-500 text-xs ml-2">正在生成 AI 解读...</Text>
          </View>
        );
      }
      return null;
    }
    const dirColor =
      interp.direction === '利多' ? 'text-green-400' :
      interp.direction === '利空' ? 'text-red-400' : 'text-gray-300';
    const impactBg =
      interp.impact === '高' ? 'bg-red-500' :
      interp.impact === '中' ? 'bg-amber-500' : 'bg-gray-500';
    return (
      <View className="mt-3 bg-gray-700/40 rounded-lg p-3 border-l-2 border-blue-500">
        <View className="flex-row items-center mb-1 flex-wrap gap-y-1">
          <FontAwesome6 name="robot" size={12} color="#3b82f6" />
          <Text className="text-blue-400 text-xs font-bold ml-1">AI 解读</Text>
          <Text className={`text-xs font-bold ml-2 ${dirColor}`}>{interp.direction}</Text>
          <View className={`ml-2 px-1.5 py-0.5 rounded ${impactBg}`}>
            <Text className="text-white text-[10px] font-bold">影响{interp.impact}</Text>
          </View>
        </View>
        <Text className="text-gray-200 text-sm leading-5">{interp.interpretation}</Text>
        {interp.affectedVarieties.length > 0 && (
          <View className="flex-row flex-wrap gap-1 mt-1.5">
            {interp.affectedVarieties.map((v, i) => (
              <View key={i} className="bg-gray-600 px-1.5 py-0.5 rounded">
                <Text className="text-gray-300 text-[10px]">{v}</Text>
              </View>
            ))}
          </View>
        )}
        {interp.tradeHint ? (
          <Text className="text-amber-400/90 text-xs mt-1.5">提示：{interp.tradeHint}</Text>
        ) : null}
      </View>
    );
  };

  const renderNewsItem = (item: NewsItem, index: number) => (
    <View
      key={index}
      className="bg-gray-800/50 rounded-xl p-4 mb-3 border border-gray-700/50"
    >
      <TouchableOpacity onPress={() => item.url && Linking.openURL(item.url)}>
        <Text className="text-white text-base font-medium mb-2" numberOfLines={2}>
          {item.title}
        </Text>
        <View className="flex-row items-center justify-between">
          <Text className="text-gray-400 text-xs">{item.source}</Text>
          {item.publishedAt && (
            <Text className="text-gray-500 text-xs">{item.publishedAt}</Text>
          )}
        </View>
        {item.snippet && (
          <Text className="text-gray-400 text-sm mt-2" numberOfLines={3}>
            {item.snippet}
          </Text>
        )}
      </TouchableOpacity>
      {renderNewsAdvice(item, index)}
    </View>
  );

  // 事件卡片下方的 AI 交易建议
  const renderEventAdvice = (event: DetectedEvent) => {
    const advice = tradeAdvices?.eventAdvices.find((a) => a.eventId === event.event.id);
    if (!advice) {
      if (tradeAdvicesLoading) {
        return (
          <View className="mt-3 flex-row items-center">
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text className="text-gray-500 text-xs ml-2">正在生成交易建议...</Text>
          </View>
        );
      }
      return null;
    }
    const dirColor =
      advice.direction === '利多' ? 'text-green-400' :
      advice.direction === '利空' ? 'text-red-400' : 'text-gray-300';
    return (
      <View className="mt-3 bg-gray-700/40 rounded-lg p-3 border-l-2 border-blue-500">
        <View className="flex-row items-center mb-1">
          <FontAwesome6 name="robot" size={12} color="#3b82f6" />
          <Text className="text-blue-400 text-xs font-bold ml-1">AI 交易建议</Text>
          <Text className={`text-xs font-bold ml-2 ${dirColor}`}>{advice.direction}</Text>
        </View>
        <Text className="text-gray-200 text-sm leading-5">{advice.advice}</Text>
        {advice.riskHint ? (
          <Text className="text-amber-400/90 text-xs mt-1">风控：{advice.riskHint}</Text>
        ) : null}
      </View>
    );
  };

  // 预警卡片下方的 AI 交易建议
  const renderAlertAdvice = (alert: PropagationAlert) => {
    const key = `${alert.leader}-${alert.follower}-${alert.direction}`;
    const advice = tradeAdvices?.alertAdvices.find((a) => a.key === key);
    if (!advice) {
      if (tradeAdvicesLoading) {
        return (
          <View className="mt-3 flex-row items-center">
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text className="text-gray-500 text-xs ml-2">正在生成交易建议...</Text>
          </View>
        );
      }
      return null;
    }
    const dirColor = advice.direction === '利多' ? 'text-green-400' : 'text-red-400';
    return (
      <View className="mt-3 bg-gray-700/40 rounded-lg p-3 border-l-2 border-blue-500">
        <View className="flex-row items-center mb-1">
          <FontAwesome6 name="robot" size={12} color="#3b82f6" />
          <Text className="text-blue-400 text-xs font-bold ml-1">AI 交易建议</Text>
          <Text className={`text-xs font-bold ml-2 ${dirColor}`}>{advice.direction}</Text>
        </View>
        <Text className="text-gray-200 text-sm leading-5">{advice.advice}</Text>
        {advice.riskHint ? (
          <Text className="text-amber-400/90 text-xs mt-1">风控：{advice.riskHint}</Text>
        ) : null}
      </View>
    );
  };

  const renderEventItem = (event: DetectedEvent, index: number) => (
    <View
      key={index}
      className="bg-gray-800/50 rounded-xl p-4 mb-3 border border-gray-700/50"
    >
      <View className="flex-row items-center mb-2">
        <View
          className="px-2 py-1 rounded mr-2"
          style={{ backgroundColor: CATEGORY_COLORS[event.event.categoryName] || '#6b7280' }}
        >
          <Text className="text-white text-xs font-bold">{event.event.categoryName}</Text>
        </View>
        <Text className={`text-sm font-bold ${event.event.direction === '利多' ? 'text-green-400' : 'text-red-400'}`}>
          {event.event.direction}
        </Text>
        <View className="ml-auto bg-gray-700 px-2 py-1 rounded">
          <Text className="text-gray-300 text-xs">置信度 {(event.confidence * 100).toFixed(0)}%</Text>
        </View>
      </View>
      <Text className="text-white text-base font-medium mb-2">{event.event.title}</Text>
      <Text className="text-gray-400 text-sm mb-2">
        影响品种：{event.affectedVarieties.join(', ')}
      </Text>
      <Text className="text-gray-500 text-xs">
        匹配新闻：{event.matchedNews.length} 条
      </Text>
      {renderEventAdvice(event)}
    </View>
  );

  const renderAlertItem = (alert: PropagationAlert, index: number) => (
    <View
      key={index}
      className="bg-gray-800/50 rounded-xl p-4 mb-3 border border-gray-700/50"
    >
      <View className="flex-row items-center mb-2">
        <View
          className="px-2 py-1 rounded mr-2"
          style={{ backgroundColor: SECTOR_COLORS[alert.sector] || '#6b7280' }}
        >
          <Text className="text-white text-xs font-bold">{alert.sector}</Text>
        </View>
        <Text className={`text-sm font-bold ${alert.direction === '利多' ? 'text-green-400' : 'text-red-400'}`}>
          {alert.direction}
        </Text>
      </View>
      <View className="flex-row items-center mb-2">
        <Text className="text-white text-lg font-bold">{alert.leader}</Text>
        <FontAwesome6 name="arrow-right" size={14} color="#9ca3af" style={{ marginHorizontal: 8 }} />
        <Text className="text-white text-lg font-bold">{alert.follower}</Text>
      </View>
      <Text className="text-gray-400 text-sm mb-1">{alert.logic}</Text>
      <Text className="text-gray-500 text-xs">预期滞后 {alert.lag} 天</Text>
      {renderAlertAdvice(alert)}
    </View>
  );

  const renderInterpretation = () => {
    if (interpretationLoading && !interpretation) {
      return (
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text className="text-gray-400 mt-4">正在生成 AI 深度解读...</Text>
        </View>
      );
    }

    if (!interpretation) {
      return (
        <View className="flex-1 items-center justify-center py-20">
          <FontAwesome6 name="robot" size={48} color="#6b7280" />
          <Text className="text-gray-400 mt-4 mb-4">尚未生成 AI 解读</Text>
          <TouchableOpacity
            className="bg-blue-500 px-6 py-3 rounded-lg"
            onPress={loadInterpretation}
          >
            <Text className="text-white font-medium">生成解读</Text>
          </TouchableOpacity>
        </View>
      );
    }

    const directionColor =
      interpretation.direction === '利多' ? 'text-green-400' :
      interpretation.direction === '利空' ? 'text-red-400' : 'text-gray-300';

    return (
      <View className="px-4 pt-4">
        {/* 方向汇总卡片 */}
        <View className="bg-gray-800/50 rounded-xl p-4 mb-4 border border-gray-700/50">
          <View className="flex-row items-center justify-between mb-2">
            <Text className="text-gray-400 text-sm">综合方向</Text>
            <Text className={`text-lg font-bold ${directionColor}`}>{interpretation.direction}</Text>
          </View>
          {interpretation.affectedVarieties.length > 0 && (
            <View className="flex-row flex-wrap gap-2">
              {interpretation.affectedVarieties.map((v, i) => (
                <View key={i} className="bg-gray-700 px-2 py-1 rounded">
                  <Text className="text-gray-300 text-xs">{v}</Text>
                </View>
              ))}
            </View>
          )}
        </View>

        {/* AI 解读文本 */}
        <View className="bg-gray-800/50 rounded-xl p-4 mb-4 border border-gray-700/50">
          <View className="flex-row items-center mb-3">
            <FontAwesome6 name="robot" size={16} color="#3b82f6" />
            <Text className="text-white text-base font-bold ml-2">AI 深度解读</Text>
          </View>
          <Text className="text-gray-200 text-sm leading-6">{interpretation.interpretation}</Text>
        </View>

        {/* 生成时间 */}
        <Text className="text-gray-500 text-xs text-center mb-4">
          生成时间：{new Date(interpretation.generatedAt).toLocaleString()}
        </Text>
      </View>
    );
  };

  const renderContent = () => {
    if (loading && !scanResult) {
      return (
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#3b82f6" />
          <Text className="text-gray-400 mt-4">正在扫描新闻...</Text>
        </View>
      );
    }

    if (error && !scanResult) {
      return (
        <View className="flex-1 items-center justify-center py-20">
          <FontAwesome6 name="triangle-exclamation" size={48} color="#ef4444" />
          <Text className="text-red-400 mt-4 text-center px-8">{error}</Text>
          <TouchableOpacity
            className="mt-4 bg-blue-500 px-6 py-3 rounded-lg"
            onPress={() => loadData()}
          >
            <Text className="text-white font-medium">重试</Text>
          </TouchableOpacity>
        </View>
      );
    }

    if (!scanResult) {
      return null;
    }

    switch (activeTab) {
      case 'news':
        return (
          <View className="px-4 pt-4">
            <Text className="text-gray-400 text-sm mb-3">
              共 {scanResult.news.length} 条新闻
            </Text>
            {scanResult.news.map((item, index) => renderNewsItem(item, index))}
          </View>
        );
      case 'events':
        return (
          <View className="px-4 pt-4">
            <Text className="text-gray-400 text-sm mb-3">
              检测到 {scanResult.detectedEvents.length} 个潜在黑天鹅事件
            </Text>
            {scanResult.detectedEvents.length === 0 ? (
              <View className="items-center py-12">
                <FontAwesome6 name="circle-check" size={48} color="#22c55e" />
                <Text className="text-green-400 mt-4">未检测到明显黑天鹅事件</Text>
              </View>
            ) : (
              scanResult.detectedEvents.map((event, index) => renderEventItem(event, index))
            )}
          </View>
        );
      case 'alerts':
        return (
          <View className="px-4 pt-4">
            <Text className="text-gray-400 text-sm mb-3">
              传播链预警 {scanResult.propagationAlerts.length} 条
            </Text>
            {scanResult.propagationAlerts.length === 0 ? (
              <View className="items-center py-12">
                <FontAwesome6 name="bell-slash" size={48} color="#6b7280" />
                <Text className="text-gray-400 mt-4">暂无传播链预警</Text>
              </View>
            ) : (
              scanResult.propagationAlerts.map((alert, index) => renderAlertItem(alert, index))
            )}
          </View>
        );
      case 'variety':
        return (
          <View className="px-4 pt-4">
            {/* 品种搜索框 */}
            <View className="flex-row items-center mb-4 gap-2">
              <View className="flex-1 bg-gray-800/50 rounded-lg px-3 py-2 border border-gray-700/50">
                <TextInput
                  className="text-white text-sm"
                  placeholder="输入品种代码（如 RB0, I0, AU0）"
                  placeholderTextColor="#6b7280"
                  value={varietyCode}
                  onChangeText={setVarietyCode}
                  onSubmitEditing={handleVarietySearch}
                  autoCapitalize="characters"
                  autoCorrect={false}
                />
              </View>
              <TouchableOpacity
                className={`px-4 py-2 rounded-lg ${varietyNewsLoading ? 'bg-gray-600' : 'bg-blue-500'}`}
                onPress={handleVarietySearch}
                disabled={varietyNewsLoading}
              >
                {varietyNewsLoading ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text className="text-white font-medium">搜索</Text>
                )}
              </TouchableOpacity>
            </View>

            {/* 搜索结果 */}
            {varietyNewsError && (
              <View className="items-center py-8">
                <FontAwesome6 name="triangle-exclamation" size={32} color="#ef4444" />
                <Text className="text-red-400 mt-2 text-center">{varietyNewsError}</Text>
              </View>
            )}

            {varietyNews && (
              <View>
                <View className="flex-row items-center justify-between mb-3">
                  <Text className="text-gray-400 text-sm">
                    {varietyNews.varietyName}（{varietyNews.variety}）共 {varietyNews.news.length} 条新闻
                  </Text>
                </View>
                {varietyNews.news.length === 0 ? (
                  <View className="items-center py-12">
                    <FontAwesome6 name="newspaper" size={32} color="#6b7280" />
                    <Text className="text-gray-400 mt-2">暂无相关新闻</Text>
                  </View>
                ) : (
                  varietyNews.news.map((item, index) => renderNewsItem(item, index))
                )}
              </View>
            )}

            {!varietyNews && !varietyNewsLoading && !varietyNewsError && (
              <View className="items-center py-12">
                <FontAwesome6 name="magnifying-glass" size={32} color="#6b7280" />
                <Text className="text-gray-400 mt-2">输入品种代码搜索专属新闻</Text>
              </View>
            )}
          </View>
        );
      case 'ai':
        return renderInterpretation();
    }
  };

  return (
    <Screen>
      <View className="flex-1 bg-gray-900">
        {/* Header */}
        <View className="bg-gray-800 px-4 pt-4 pb-3 border-b border-gray-700">
          <View className="flex-row items-center justify-between mb-3">
            <View className="flex-row items-center">
              <FontAwesome6 name="newspaper" size={20} color="#3b82f6" />
              <Text className="text-white text-xl font-bold ml-2">新闻监控</Text>
            </View>
            <TouchableOpacity
              className="bg-blue-500 px-4 py-2 rounded-lg flex-row items-center"
              onPress={() => loadData()}
              disabled={loading || refreshing}
            >
              {loading && <ActivityIndicator size="small" color="#fff" style={{ marginRight: 6 }} />}
              <Text className="text-white font-medium">扫描</Text>
            </TouchableOpacity>
          </View>

          {/* Tabs */}
          <View className="flex-row bg-gray-700/50 rounded-lg p-1">
            <TouchableOpacity
              className={`flex-1 py-2 rounded-md ${activeTab === 'news' ? 'bg-blue-500' : ''}`}
              onPress={() => setActiveTab('news')}
            >
              <Text className={`text-center font-medium ${activeTab === 'news' ? 'text-white' : 'text-gray-400'}`}>
                新闻 {scanResult ? `(${scanResult.news.length})` : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 py-2 rounded-md ${activeTab === 'events' ? 'bg-blue-500' : ''}`}
              onPress={() => setActiveTab('events')}
            >
              <Text className={`text-center font-medium ${activeTab === 'events' ? 'text-white' : 'text-gray-400'}`}>
                事件 {scanResult ? `(${scanResult.detectedEvents.length})` : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 py-2 rounded-md ${activeTab === 'alerts' ? 'bg-blue-500' : ''}`}
              onPress={() => setActiveTab('alerts')}
            >
              <Text className={`text-center font-medium ${activeTab === 'alerts' ? 'text-white' : 'text-gray-400'}`}>
                预警 {scanResult ? `(${scanResult.propagationAlerts.length})` : ''}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 py-2 rounded-md ${activeTab === 'variety' ? 'bg-blue-500' : ''}`}
              onPress={() => setActiveTab('variety')}
            >
              <Text className={`text-center font-medium ${activeTab === 'variety' ? 'text-white' : 'text-gray-400'}`}>
                品种
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              className={`flex-1 py-2 rounded-md ${activeTab === 'ai' ? 'bg-blue-500' : ''}`}
              onPress={() => {
                setActiveTab('ai');
                if (!interpretation && !interpretationLoading) {
                  loadInterpretation();
                }
              }}
            >
              <Text className={`text-center font-medium ${activeTab === 'ai' ? 'text-white' : 'text-gray-400'}`}>
                AI解读
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Content */}
        <ScrollView
          className="flex-1"
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor="#3b82f6" />
          }
        >
          {renderContent()}
        </ScrollView>

        {/* Footer */}
        {scanResult && (
          <View className="bg-gray-800 px-4 py-2 border-t border-gray-700">
            <Text className="text-gray-500 text-xs text-center">
              最后扫描：{new Date(scanResult.scanTime).toLocaleString()}
            </Text>
          </View>
        )}
      </View>
    </Screen>
  );
}
