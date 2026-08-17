import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
  Alert,
  ScrollView,
  Modal,
  TextInput,
  Pressable,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  fetchJournalDates,
  fetchJournalByDate,
  triggerJournalGenerate,
  triggerJournalBackfill,
  triggerReviewUpdate,
  updateJournalReviewStatus,
  fetchJournalReviews,
  fetchJournalReviewStats,
  type JournalRecord,
  type JournalReviewRecord,
  type ReviewStats,
} from '@/utils/journalApi';
import { fetchSignalStats, type SignalStats } from '@/utils/api';
import {
  fetchHistoricalEvents,
  fetchRealtimeEvents,
  refreshRealtimeEvents,
  generateEventDaily,
  generateAllEventDailies,
  fetchEventDailyList,
  type BlackSwanEventItem,
  type EventDailyReport,
  type EventDailyReportRecord,
} from '@/utils/eventDailyApi';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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

// 信号等级颜色
const LEVEL_COLORS: Record<string, string> = {
  'A': '#10B981',
  'B': '#3B82F6',
  'C': '#F59E0B',
  'D': '#9CA3AF',
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const weekDay = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
  return `${month}月${day}日 周${weekDay}`;
}

/**
 * 获取本地时区日期字符串（YYYY-MM-DD）
 * 避免 toISOString() 使用 UTC 时区导致中国时区日期差一天
 */
function getLocalDateStr(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 生成最近 N 天的日期列表（倒序，用于日期选择器）
 */
function generateRecentDates(days = 30): string[] {
  const result: string[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    result.push(getLocalDateStr(d));
  }
  return result;
}

export default function SignalJournalScreen() {
  const router = useSafeRouter();
  const [dates, setDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(getLocalDateStr());
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'daily' | 'review' | 'stats'>('daily');
  const [signalStats, setSignalStats] = useState<SignalStats | null>(null);
  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null);
  const [reviews, setReviews] = useState<JournalReviewRecord[]>([]);
  const [statusUpdatingId, setStatusUpdatingId] = useState<number | null>(null);

  // 事件日报相关状态
  const [dailyMode, setDailyMode] = useState<'event' | 'signal'>('event');
  const [events, setEvents] = useState<BlackSwanEventItem[]>([]);
  const [realtimeEvents, setRealtimeEvents] = useState<BlackSwanEventItem[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [realtimeLoading, setRealtimeLoading] = useState(false);
  const [realtimeRefreshing, setRealtimeRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);
  const [eventKeyword, setEventKeyword] = useState('');
  const [reportGenerating, setReportGenerating] = useState(false);
  const [currentReport, setCurrentReport] = useState<EventDailyReport | null>(null);
  const [reportVisible, setReportVisible] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyList, setHistoryList] = useState<EventDailyReportRecord[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [eventTab, setEventTab] = useState<'realtime' | 'historical'>('realtime');

  // 日期选择器状态
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [recentDates] = useState<string[]>(() => generateRecentDates(30));

  const loadData = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const [dateList, journalRecords] = await Promise.all([
        fetchJournalDates(),
        fetchJournalByDate(date),
      ]);
      setDates(dateList);
      setRecords(journalRecords);
    } catch (e) {
      console.error('加载日报失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData(selectedDate);
    }, [selectedDate, loadData])
  );

  const loadRealtimeEvents = useCallback(async () => {
    setRealtimeLoading(true);
    try {
      const list = await fetchRealtimeEvents();
      setRealtimeEvents(list);
    } catch (e) {
      console.error('加载实时事件列表失败:', e);
    } finally {
      setRealtimeLoading(false);
    }
  }, []);

  // 手动强制刷新实时事件（重新检测新闻）
  const handleRefreshRealtime = useCallback(async () => {
    if (realtimeRefreshing) return;
    setRealtimeRefreshing(true);
    try {
      const list = await refreshRealtimeEvents();
      setRealtimeEvents(list);
      Alert.alert('更新完成', `已检测到 ${list.length} 条实时事件`);
    } catch (e: any) {
      console.error('手动刷新实时事件失败:', e);
      Alert.alert('更新失败', e?.message || '手动刷新实时事件失败');
    } finally {
      setRealtimeRefreshing(false);
    }
  }, [realtimeRefreshing]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData(selectedDate);
    await loadRealtimeEvents();
    setRefreshing(false);
  }, [selectedDate, loadData, loadRealtimeEvents]);

  const handleGenerate = async () => {
    setGenerating(true);
    try {
      const result = await triggerJournalGenerate(selectedDate);
      if (result.success) {
        Alert.alert('成功', `已生成 ${result.count} 条日报记录（${formatDate(selectedDate)}）`);
      } else {
        Alert.alert('提示', result.message || '生成完成');
      }
      await loadData(selectedDate);
    } catch (e: any) {
      console.error('生成日报失败:', e);
      Alert.alert('生成失败', e.message || '请检查网络连接后重试');
    } finally {
      setGenerating(false);
    }
  };

  const handleBackfill = () => {
    Alert.alert(
      '生成历史日报',
      '将一键生成 2026-01-01 至今的所有历史信号日报（已有日报的日期自动跳过）。\n\n预计耗时 2-5 分钟，期间请勿离开此页面。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '开始生成',
          onPress: () => doBackfill(),
        },
      ]
    );
  };

  const doBackfill = async () => {
    setBackfilling(true);
    try {
      const result = await triggerJournalBackfill('2026-01-01');
      const msg =
        `共处理 ${result.total} 天\n` +
        `新增 ${result.generated} 天\n` +
        `跳过 ${result.skipped} 天\n` +
        `失败 ${result.failed} 天`;
      Alert.alert('历史日报生成完成', msg);
      // 刷新日期列表和当前日报
      const dateList = await fetchJournalDates();
      setDates(dateList);
      await loadData(selectedDate);
    } catch (e: any) {
      console.error('回填历史日报失败:', e);
      Alert.alert('回填失败', e.message || '请检查网络连接后重试');
    } finally {
      setBackfilling(false);
    }
  };

  const handleSelectDate = (date: string) => {
    setSelectedDate(date);
    setDatePickerVisible(false);
  };

  const handleGoToday = () => {
    setSelectedDate(getLocalDateStr());
    setDatePickerVisible(false);
  };

  const handleDateChange = (direction: 'prev' | 'next') => {
    const currentIndex = dates.indexOf(selectedDate);
    if (direction === 'prev' && currentIndex < dates.length - 1) {
      setSelectedDate(dates[currentIndex + 1]);
    } else if (direction === 'next' && currentIndex > 0) {
      setSelectedDate(dates[currentIndex - 1]);
    }
  };

  const loadReviewData = useCallback(async () => {
    try {
      const [stats, reviewList] = await Promise.all([
        fetchJournalReviewStats(),
        fetchJournalReviews(),
      ]);
      setReviewStats(stats);
      setReviews(reviewList);
    } catch (e) {
      console.error('加载复盘数据失败:', e);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'review') {
      loadReviewData();
    } else if (activeTab === 'stats') {
      loadSignalStats();
    }
  }, [activeTab, loadReviewData]);

  const loadSignalStats = useCallback(async () => {
    try {
      // 获取所有可交易品种的代码
      const allRecords = records.filter(r => r.signal_level && r.signal_level !== 'D');
      if (allRecords.length > 0) {
        // 获取第一个品种的统计作为示例（实际可以聚合多个）
        const code = allRecords[0].code;
        const stats = await fetchSignalStats(code);
        setSignalStats(stats);
      }
    } catch (e) {
      console.error('加载信号统计失败:', e);
    }
  }, [records]);

  // ====== 事件日报相关逻辑 ======
  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const list = await fetchHistoricalEvents();
      setEvents(list);
    } catch (e) {
      console.error('加载历史事件列表失败:', e);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const list = await fetchEventDailyList(200);
      setHistoryList(list);
    } catch (e) {
      console.error('加载历史日报失败:', e);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadEvents();
      loadRealtimeEvents();
      loadHistory();
    }, [loadEvents, loadRealtimeEvents, loadHistory])
  );

  // 根据 event_id 在已生成日报中查找缓存
  const findCachedReport = useCallback(
    (eventId: string): { id: string; report: EventDailyReport } | null => {
      const record = historyList.find((r) => r.event_id === eventId);
      if (!record) return null;
      try {
        return { id: record.id, report: JSON.parse(record.report_json) as EventDailyReport };
      } catch {
        return null;
      }
    },
    [historyList]
  );

  const handleGenerateEventDaily = async (eventId: string) => {
    console.log('[EventDaily] 开始处理事件日报, eventId:', eventId);
    // 优先命中已生成日报（秒开，不发请求）
    const cached = findCachedReport(eventId);
    console.log('[EventDaily] 缓存查找结果:', cached ? '找到' : '未找到');
    if (cached) {
      console.log('[EventDaily] 使用缓存数据, report:', cached.report ? '有数据' : '无数据');
      setCurrentReport(cached.report);
      setReportVisible(true);
      return;
    }

    setReportGenerating(true);
    setReportVisible(true);
    setCurrentReport(null);
    try {
      console.log('[EventDaily] 调用 API 生成日报...');
      const result = await generateEventDaily(eventId);
      console.log('[EventDaily] API 返回结果:', result);
      console.log('[EventDaily] result.report:', result.report ? '有数据' : '无数据');
      setCurrentReport(result.report);
      await loadHistory();
    } catch (e: any) {
      console.error('[EventDaily] 生成事件日报失败:', e);
      Alert.alert('生成失败', e.message || '请检查网络连接后重试');
      setReportVisible(false);
    } finally {
      setReportGenerating(false);
    }
  };

  const handleGenerateAllEventDailies = async () => {
    setReportGenerating(true);
    try {
      const result = await generateAllEventDailies();
      Alert.alert(
        '完成',
        `历史日报已更新：共 ${result.total} 个事件，新增 ${result.generated}，已存在 ${result.skipped}，失败 ${result.failed}`
      );
      await loadHistory();
    } catch (e: any) {
      console.error('全量生成事件日报失败:', e);
      Alert.alert('生成失败', e.message || '请检查网络连接后重试');
    } finally {
      setReportGenerating(false);
    }
  };

  const handleOpenHistory = async () => {
    setHistoryVisible(true);
    await loadHistory();
  };

  // 单条复盘状态流转（pending -> 已止盈/已止损）
  const handleReviewStatus = async (id: number, status: string, closePrice?: number) => {
    try {
      setStatusUpdatingId(id);
      await updateJournalReviewStatus(id, status, closePrice != null ? { closePrice } : {});
      await loadReviewData();
      const tip = status === 'hit_target' ? '已标记为止盈' : status === 'stopped' ? '已标记为止损' : '已标记为失效';
      Alert.alert('成功', tip);
    } catch (e: any) {
      Alert.alert('失败', e?.message || '更新复盘状态失败');
    } finally {
      setStatusUpdatingId(null);
    }
  };

  // 事件类别（去重）- 合并实时和历史事件的类别
  const allEventsForCategory = [...realtimeEvents, ...events];
  const eventCategories = Array.from(
    new Map(allEventsForCategory.map((e) => [e.category, e.categoryName] as [number, string])).entries()
  ).sort((a, b) => a[0] - b[0]);

  // 筛选后的事件列表（根据当前 Tab 选择实时或历史）
  const currentYear = new Date().getFullYear().toString();
  // 实时 Tab：只显示当年的实时检测事件；往年的实时事件自动归入历史
  const sourceEvents =
    eventTab === 'realtime'
      ? realtimeEvents.filter((e) => e.date.startsWith(currentYear))
      : [...events, ...realtimeEvents.filter((e) => !e.date.startsWith(currentYear))];
  const filteredEvents = sourceEvents.filter((e) => {
    if (selectedCategory !== null && e.category !== selectedCategory) return false;
    if (eventKeyword) {
      const kw = eventKeyword.toLowerCase();
      const hit =
        e.title.toLowerCase().includes(kw) ||
        e.consensus.toLowerCase().includes(kw) ||
        e.varieties.join(' ').toLowerCase().includes(kw);
      if (!hit) return false;
    }
    return true;
  });

  // 统计数据
  const tradableRecords = records.filter(r => r.signal_level && r.signal_level !== 'D');
  const longCount = records.filter(r => r.ai_direction === '多').length;
  const shortCount = records.filter(r => r.ai_direction === '空').length;
  const trendCount = records.filter(r => r.spectrum === '趋势').length;
  const channelCount = records.filter(r => r.spectrum === '通道').length;
  const rangeCount = records.filter(r => r.spectrum === '区间').length;

  const directionColor = (direction: string) => {
    if (direction === '利多') return '#16a34a';
    if (direction === '利空') return '#dc2626';
    return '#6b7280';
  };

  const formatPct = (v?: number) => (v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`);

  // 判断事件是否为实时事件（当年实时检测的事件）
  const isRealtimeEvent = (item: BlackSwanEventItem) => {
    return item.date.startsWith(currentYear);
  };

  const renderEventCard = ({ item }: { item: BlackSwanEventItem }) => (
    <TouchableOpacity
      className="bg-white dark:bg-gray-800 rounded-2xl p-4 mb-3 shadow-sm"
      onPress={() => handleGenerateEventDaily(item.id)}
    >
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-xs font-medium text-gray-500 dark:text-gray-400">{item.date}</Text>
        <View className="flex-row items-center gap-1.5">
          {isRealtimeEvent(item) ? (
            <View className="px-2 py-0.5 rounded-full bg-orange-50 dark:bg-orange-900/30">
              <Text className="text-[11px] text-orange-600 dark:text-orange-400">实时</Text>
            </View>
          ) : null}
          {findCachedReport(item.id) ? (
            <View className="px-2 py-0.5 rounded-full bg-emerald-50 dark:bg-emerald-900/30">
              <Text className="text-[11px] text-emerald-600 dark:text-emerald-400">已生成</Text>
            </View>
          ) : null}
          <View className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700">
            <Text className="text-[11px] text-gray-600 dark:text-gray-300">{item.categoryName}</Text>
          </View>
        </View>
      </View>
      <Text className="text-base font-bold text-gray-900 dark:text-white mb-2">{item.title}</Text>
      <View className="flex-row items-center mb-1.5">
        <Text className="text-xs font-semibold" style={{ color: directionColor(item.direction) }}>
          {item.direction}
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400 ml-2 flex-1" numberOfLines={2}>
          {item.consensus}
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-1 mt-1">
        {item.varieties.map((v) => (
          <View key={v} className="px-1.5 py-0.5 rounded bg-gray-50 dark:bg-gray-700">
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">{v}</Text>
          </View>
        ))}
      </View>
    </TouchableOpacity>
  );

  const renderEventReport = () => {
    if (!currentReport) return null;
    const { event, varieties, groups, aiConclusion } = currentReport;
    return (
      <ScrollView className="flex-1 px-4 pt-4">
        <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 mb-3">
          <Text className="text-lg font-bold text-gray-900 dark:text-white mb-2">{event.title}</Text>
          <View className="flex-row items-center mb-2">
            <Text className="text-xs text-gray-500 dark:text-gray-400">{event.date}</Text>
            <View className="px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 ml-2">
              <Text className="text-[11px] text-gray-600 dark:text-gray-300">{event.categoryName}</Text>
            </View>
          </View>
          <Text className="text-sm text-gray-700 dark:text-gray-200 mb-1">
            方向：
            <Text style={{ color: directionColor(event.direction), fontWeight: '600' }}>
              {event.direction}
            </Text>
          </Text>
          <Text className="text-xs text-gray-600 dark:text-gray-300 mb-1">市场共识：{event.consensus}</Text>
          {event.note ? (
            <Text className="text-xs text-gray-500 dark:text-gray-400">备注：{event.note}</Text>
          ) : null}
        </View>

        <Text className="text-sm font-bold text-gray-900 dark:text-white mb-2">涉及品种技术面</Text>
        {varieties.map((v) => (
          <View key={v.code} className="bg-white dark:bg-gray-800 rounded-2xl p-3 mb-2">
            <View className="flex-row items-center justify-between mb-1.5">
              <Text className="text-sm font-semibold text-gray-900 dark:text-white">
                {v.name}（{v.code}）
              </Text>
              <Text className="text-xs text-gray-400">{v.group}</Text>
            </View>
            {v.hasData ? (
              <View className="flex-row flex-wrap gap-x-4 gap-y-1">
                <Text className="text-xs text-gray-600 dark:text-gray-300">频谱：{v.spectrum}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">AI方向：{v.aiDirection}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">趋势强度：{v.trendStrength}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">ADX：{v.adx}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">市场环境：{v.marketContext}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">近5日：{formatPct(v.recent5dReturn)}</Text>
                <Text className="text-xs text-gray-600 dark:text-gray-300">近20日：{formatPct(v.recent20dReturn)}</Text>
              </View>
            ) : (
              <Text className="text-xs text-gray-400">暂无行情数据</Text>
            )}
          </View>
        ))}

        <Text className="text-sm font-bold text-gray-900 dark:text-white mb-2 mt-1">板块分布</Text>
        <View className="bg-white dark:bg-gray-800 rounded-2xl p-3 mb-3">
          {Object.entries(groups).map(([group, names]) => (
            <View key={group} className="flex-row items-center mb-1.5">
              <Text className="text-xs font-semibold text-gray-700 dark:text-gray-200 w-20">{group}</Text>
              <Text className="text-xs text-gray-500 dark:text-gray-400 flex-1">{names.join('、')}</Text>
            </View>
          ))}
        </View>

        <Text className="text-sm font-bold text-gray-900 dark:text-white mb-2">AI 综合分析</Text>
        <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 mb-6">
          <Text className="text-sm leading-6 text-gray-700 dark:text-gray-200">{aiConclusion}</Text>
        </View>
      </ScrollView>
    );
  };

  const renderHeader = () => (
    <View className="px-4 pb-4">
      {/* 日期导航 */}
      <View className="flex-row items-center justify-between mb-4 bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
        <TouchableOpacity
          onPress={() => handleDateChange('prev')}
          disabled={dates.indexOf(selectedDate) >= dates.length - 1}
          className="p-2"
        >
          <FontAwesome6
            name="chevron-left"
            size={20}
            color={dates.indexOf(selectedDate) >= dates.length - 1 ? '#ccc' : '#3B82F6'}
          />
        </TouchableOpacity>
        <TouchableOpacity className="items-center" onPress={() => setDatePickerVisible(true)}>
          <View className="flex-row items-center">
            <Text className="text-lg font-bold text-gray-900 dark:text-white">
              {formatDate(selectedDate)}
            </Text>
            <FontAwesome6 name="chevron-down" size={14} color="#9ca3af" style={{ marginLeft: 6 }} />
          </View>
          <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {records.length} 个品种 · 点击选择日期
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleDateChange('next')}
          disabled={dates.indexOf(selectedDate) <= 0}
          className="p-2"
        >
          <FontAwesome6
            name="chevron-right"
            size={20}
            color={dates.indexOf(selectedDate) <= 0 ? '#ccc' : '#3B82F6'}
          />
        </TouchableOpacity>
      </View>

      {/* 统计卡片 */}
      <View className="flex-row gap-3 mb-4">
        <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
          <Text className="text-xs text-gray-500 dark:text-gray-400">可交易</Text>
          <Text className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {tradableRecords.length}
          </Text>
        </View>
        <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
          <Text className="text-xs text-gray-500 dark:text-gray-400">多/空</Text>
          <Text className="text-2xl font-bold">
            <Text className="text-green-600 dark:text-green-400">{longCount}</Text>
            <Text className="text-gray-400">/</Text>
            <Text className="text-red-600 dark:text-red-400">{shortCount}</Text>
          </Text>
        </View>
        <View className="flex-1 bg-white dark:bg-gray-800 rounded-xl p-3 shadow-sm">
          <Text className="text-xs text-gray-500 dark:text-gray-400">频谱</Text>
          <View className="flex-row items-center gap-1 mt-1">
            <View className="w-2 h-2 rounded-full bg-green-500" />
            <Text className="text-xs text-gray-600 dark:text-gray-300">{trendCount}</Text>
            <View className="w-2 h-2 rounded-full bg-blue-500 ml-1" />
            <Text className="text-xs text-gray-600 dark:text-gray-300">{channelCount}</Text>
            <View className="w-2 h-2 rounded-full bg-gray-400 ml-1" />
            <Text className="text-xs text-gray-600 dark:text-gray-300">{rangeCount}</Text>
          </View>
        </View>
      </View>

      {/* 操作栏 */}
      <View className="flex-row items-center justify-between mb-3">
        <View className="flex-row bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
          <TouchableOpacity
            onPress={() => setViewMode('card')}
            className={`px-3 py-1.5 rounded-md ${viewMode === 'card' ? 'bg-white dark:bg-gray-600 shadow-sm' : ''}`}
          >
            <FontAwesome6 name="table-cells" size={14} color={viewMode === 'card' ? '#3B82F6' : '#9CA3AF'} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setViewMode('list')}
            className={`px-3 py-1.5 rounded-md ${viewMode === 'list' ? 'bg-white dark:bg-gray-600 shadow-sm' : ''}`}
          >
            <FontAwesome6 name="list" size={14} color={viewMode === 'list' ? '#3B82F6' : '#9CA3AF'} />
          </TouchableOpacity>
        </View>
        <View className="flex-row items-center gap-2">
          <TouchableOpacity
            onPress={handleBackfill}
            disabled={backfilling}
            className="flex-row items-center bg-indigo-500 px-3 py-1.5 rounded-lg"
          >
            {backfilling ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <FontAwesome6 name="wand-magic-sparkles" size={12} color="#fff" />
            )}
            <Text className="text-white text-xs ml-1.5 font-medium">
              {backfilling ? '生成中...' : '生成历史日报'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleGenerate}
            disabled={generating}
            className="flex-row items-center bg-blue-500 px-3 py-1.5 rounded-lg"
          >
            {generating ? (
              <ActivityIndicator size="small" color="#fff" />
            ) : (
              <FontAwesome6 name="rotate" size={12} color="#fff" />
            )}
            <Text className="text-white text-xs ml-1.5 font-medium">
              {generating ? '生成中...' : '生成日报'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );

  const renderCard = ({ item }: { item: JournalRecord }) => {
    const isTradable = item.signal_level && item.signal_level !== 'D';
    const specColor = SPECTRUM_COLORS[item.spectrum] || '#9CA3AF';
    const dirColor = DIR_COLORS[item.ai_direction] || '#9CA3AF';
    const levelColor = LEVEL_COLORS[item.signal_level] || '#9CA3AF';

    return (
      <TouchableOpacity
        onPress={() => router.push('/signal-detail', { code: item.code, name: item.name })}
        className="bg-white dark:bg-gray-800 rounded-2xl p-4 mb-3 shadow-sm"
      >
        <View className="flex-row items-center justify-between mb-2">
          <View className="flex-row items-center">
            <Text className="text-base font-bold text-gray-900 dark:text-white">
              {item.name}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 ml-2">
              {item.code}
            </Text>
          </View>
          <View className="flex-row items-center">
            <Text className={`text-sm font-medium ${item.change_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
              {item.change_pct >= 0 ? '+' : ''}{item.change_pct.toFixed(2)}%
            </Text>
          </View>
        </View>

        <View className="flex-row items-center gap-2 mb-2">
          {/* 频谱标签 */}
          <View
            className="px-2 py-0.5 rounded-full"
            style={{ backgroundColor: specColor + '20' }}
          >
            <Text className="text-xs font-medium" style={{ color: specColor }}>
              {item.spectrum}
            </Text>
          </View>
          {/* 方向标签 */}
          <View
            className="px-2 py-0.5 rounded-full"
            style={{ backgroundColor: dirColor + '20' }}
          >
            <Text className="text-xs font-medium" style={{ color: dirColor }}>
              {item.ai_direction}
            </Text>
          </View>
          {/* 信号等级 */}
          {isTradable && (
            <View
              className="px-2 py-0.5 rounded-full"
              style={{ backgroundColor: levelColor + '20' }}
            >
              <Text className="text-xs font-bold" style={{ color: levelColor }}>
                {item.signal_level}
              </Text>
            </View>
          )}
        </View>

        {/* 一句话摘要 */}
        <Text className="text-sm text-gray-700 dark:text-gray-300 mb-1" numberOfLines={1}>
          {item.one_liner}
        </Text>

        {/* 价格和建议 */}
        <View className="flex-row items-center justify-between mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            收盘 {item.close?.toFixed(0)}
          </Text>
          {isTradable && (
            <Text className="text-xs text-blue-600 dark:text-blue-400" numberOfLines={1} style={{ maxWidth: '60%' }}>
              {item.advice?.slice(0, 30)}...
            </Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const renderListItem = ({ item }: { item: JournalRecord }) => {
    const isTradable = item.signal_level && item.signal_level !== 'D';
    const specColor = SPECTRUM_COLORS[item.spectrum] || '#9CA3AF';
    const dirColor = DIR_COLORS[item.ai_direction] || '#9CA3AF';

    return (
      <TouchableOpacity
        onPress={() => router.push('/signal-detail', { code: item.code, name: item.name })}
        className="flex-row items-center bg-white dark:bg-gray-800 px-4 py-3 border-b border-gray-100 dark:border-gray-700"
      >
        <View className="flex-1">
          <View className="flex-row items-center">
            <Text className="text-sm font-medium text-gray-900 dark:text-white">
              {item.name}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 ml-1">
              {item.code}
            </Text>
          </View>
          <Text className="text-xs text-gray-500 dark:text-gray-400 mt-0.5" numberOfLines={1}>
            {item.one_liner}
          </Text>
        </View>
        <View className="items-end ml-2">
          <View className="flex-row items-center gap-1 mb-1">
            <View className="w-2 h-2 rounded-full" style={{ backgroundColor: specColor }} />
            <View className="w-2 h-2 rounded-full" style={{ backgroundColor: dirColor }} />
          </View>
          <Text className={`text-xs font-medium ${item.change_pct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
            {item.change_pct >= 0 ? '+' : ''}{item.change_pct.toFixed(2)}%
          </Text>
          <Text className="text-xs text-gray-500 dark:text-gray-400">
            {item.close?.toFixed(0)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  const REVIEW_STATUS_LABELS: Record<string, string> = {
    pending: '跟踪中',
    entered: '已入场',
    stopped: '已止损',
    hit_target: '已达目标',
    expired: '已过期',
  };

  const REVIEW_STATUS_COLORS: Record<string, string> = {
    pending: '#F59E0B',
    entered: '#3B82F6',
    stopped: '#EF4444',
    hit_target: '#10B981',
    expired: '#9CA3AF',
  };

  const renderReviewItem = ({ item }: { item: JournalReviewRecord }) => {
    const statusColor = REVIEW_STATUS_COLORS[item.status] || '#9CA3AF';
    const isWin = item.status === 'hit_target';
    const isLoss = item.status === 'stopped';

    return (
      <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 mb-3 shadow-sm mx-4">
        <View className="flex-row items-center justify-between mb-2">
          <View className="flex-row items-center">
            <Text className="text-sm font-bold text-gray-900 dark:text-white">
              {item.name}
            </Text>
            <Text className="text-xs text-gray-500 dark:text-gray-400 ml-1">
              {item.code}
            </Text>
          </View>
          <View
            className="px-2.5 py-1 rounded-full"
            style={{ backgroundColor: `${statusColor}20` }}
          >
            <Text className="text-xs font-semibold" style={{ color: statusColor }}>
              {REVIEW_STATUS_LABELS[item.status] || item.status}
            </Text>
          </View>
        </View>

        <View className="flex-row gap-3 mb-2">
          <View className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">方向</Text>
            <Text className="text-xs font-semibold text-gray-900 dark:text-white">
              {item.direction === '多' ? '做多' : item.direction === '空' ? '做空' : '中性'}
            </Text>
          </View>
          <View className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">入场建议</Text>
            <Text className="text-xs font-semibold text-gray-900 dark:text-white">
              {item.entry_price ? item.entry_price.toFixed(2) : '-'}
            </Text>
          </View>
          <View className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">止损</Text>
            <Text className="text-xs font-semibold text-gray-900 dark:text-white">
              {item.stop_price ? item.stop_price.toFixed(2) : '-'}
            </Text>
          </View>
          <View className="flex-1 bg-gray-50 dark:bg-gray-900 rounded-lg p-2">
            <Text className="text-[10px] text-gray-500 dark:text-gray-400">目标</Text>
            <Text className="text-xs font-semibold text-gray-900 dark:text-white">
              {item.target_price ? item.target_price.toFixed(2) : '-'}
            </Text>
          </View>
        </View>

        <View className="flex-row justify-between">
          <Text className="text-[10px] text-gray-400">
            {item.trade_date} 生成
            {item.close_date ? ` · ${item.close_date} 结束` : ''}
          </Text>
          {item.pnl_pct !== null && item.pnl_pct !== undefined && (
            <Text
              className={`text-xs font-bold ${
                item.pnl_pct >= 0 ? 'text-green-600' : 'text-red-600'
              }`}
            >
              {item.pnl_pct >= 0 ? '+' : ''}
              {item.pnl_pct.toFixed(2)}%
            </Text>
          )}
        </View>
        {isWin && (
          <Text className="text-[11px] text-green-600 dark:text-green-400 mt-1">✓ 建议有效，方向正确</Text>
        )}
        {isLoss && (
          <Text className="text-[11px] text-red-600 dark:text-red-400 mt-1">✗ 建议失效，触发止损</Text>
        )}
        {item.status === 'pending' && (
          <View className="flex-row gap-2 mt-2">
            <TouchableOpacity
              className="flex-1 bg-green-500 rounded-lg py-2 items-center"
              onPress={() => handleReviewStatus(item.id, 'hit_target')}
            >
              <Text className="text-xs font-semibold text-white">标记止盈</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="flex-1 bg-red-500 rounded-lg py-2 items-center"
              onPress={() => handleReviewStatus(item.id, 'stopped')}
            >
              <Text className="text-xs font-semibold text-white">标记止损</Text>
            </TouchableOpacity>
            <TouchableOpacity
              className="flex-1 bg-gray-500 rounded-lg py-2 items-center"
              onPress={() => handleReviewStatus(item.id, 'expired')}
            >
              <Text className="text-xs font-semibold text-white">标记失效</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  if (loading && records.length === 0) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#3B82F6" />
          <Text className="text-gray-500 dark:text-gray-400 mt-4">加载日报...</Text>
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <View className="flex-1">
        {/* 标题栏 */}
        <View className="px-4 pt-4 pb-2">
          <Text className="text-2xl font-bold text-gray-900 dark:text-white">
            信号日报
          </Text>
          <Text className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            每日研判记录与信号演化追踪
          </Text>
        </View>

        {/* Tab 切换：日报 / 复盘 / 胜率 */}
        <View className="px-4 pb-2">
          <View className="flex-row bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
            <TouchableOpacity
              onPress={() => setActiveTab('daily')}
              className={`flex-1 py-2 rounded-lg items-center ${activeTab === 'daily' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
            >
              <Text className={`text-sm font-medium ${activeTab === 'daily' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                日报
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setActiveTab('review')}
              className={`flex-1 py-2 rounded-lg items-center ${activeTab === 'review' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
            >
              <Text className={`text-sm font-medium ${activeTab === 'review' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                复盘
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setActiveTab('stats')}
              className={`flex-1 py-2 rounded-lg items-center ${activeTab === 'stats' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
            >
              <Text className={`text-sm font-medium ${activeTab === 'stats' ? 'text-blue-600 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>
                胜率
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {activeTab === 'stats' ? (
          <ScrollView className="flex-1 px-4" contentContainerStyle={{ paddingBottom: 40 }}>
            {/* 胜率统计内容 */}
            {signalStats ? (
              <View className="gap-4">
                {/* 总体统计 */}
                <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
                  <Text className="text-base font-bold text-gray-900 dark:text-white mb-3">
                    交易统计
                  </Text>
                  <View className="flex-row flex-wrap gap-3">
                    <View className="flex-1 min-w-[100px] bg-gray-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                        {signalStats.tradeStats.totalTrades}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">总交易</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-gray-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-green-600 dark:text-green-400">
                        {signalStats.tradeStats.winRate.toFixed(1)}%
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">胜率</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-gray-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                        {signalStats.tradeStats.profitFactor.toFixed(2)}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">盈亏比</Text>
                    </View>
                  </View>
                </View>

                {/* 多空统计 */}
                <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
                  <Text className="text-base font-bold text-gray-900 dark:text-white mb-3">
                    多空表现
                  </Text>
                  <View className="flex-row gap-3">
                    <View className="flex-1 bg-green-50 dark:bg-green-900/20 rounded-xl p-3">
                      <Text className="text-xs text-gray-500 dark:text-gray-400">做多</Text>
                      <Text className="text-lg font-bold text-green-600 dark:text-green-400">
                        {signalStats.tradeStats.longTrades} 笔
                      </Text>
                      <Text className="text-xs text-green-600 dark:text-green-400 mt-1">
                        胜率 {signalStats.tradeStats.longWinRate.toFixed(1)}%
                      </Text>
                    </View>
                    <View className="flex-1 bg-red-50 dark:bg-red-900/20 rounded-xl p-3">
                      <Text className="text-xs text-gray-500 dark:text-gray-400">做空</Text>
                      <Text className="text-lg font-bold text-red-600 dark:text-red-400">
                        {signalStats.tradeStats.shortTrades} 笔
                      </Text>
                      <Text className="text-xs text-red-600 dark:text-red-400 mt-1">
                        胜率 {signalStats.tradeStats.shortWinRate.toFixed(1)}%
                      </Text>
                    </View>
                  </View>
                </View>

                {/* 信号等级胜率 */}
                {signalStats.signalGradeStats.length > 0 && (
                  <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
                    <Text className="text-base font-bold text-gray-900 dark:text-white mb-3">
                      信号等级胜率
                    </Text>
                    {signalStats.signalGradeStats.map((stat) => (
                      <View key={stat.grade} className="flex-row items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700">
                        <View className="flex-row items-center gap-2">
                          <View className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/30 items-center justify-center">
                            <Text className="text-xs font-bold text-blue-600 dark:text-blue-400">
                              {stat.grade}
                            </Text>
                          </View>
                          <Text className="text-sm text-gray-700 dark:text-gray-300">
                            {stat.total} 笔信号
                          </Text>
                        </View>
                        <View className="items-end">
                          <Text className={`text-sm font-bold ${stat.winRate >= 50 ? 'text-green-600' : 'text-red-600'}`}>
                            {stat.winRate.toFixed(1)}%
                          </Text>
                          <Text className="text-xs text-gray-500 dark:text-gray-400">
                            {stat.wins}胜 {stat.losses}负
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {signalStats.tradeStats.totalTrades === 0 && (
                  <View className="bg-gray-50 dark:bg-gray-800 rounded-2xl p-8 items-center">
                    <FontAwesome6 name="chart-line" size={32} color="#9CA3AF" />
                    <Text className="text-gray-500 dark:text-gray-400 mt-3 text-center">
                      暂无历史交易数据{'\n'}模拟交易积累后将自动统计胜率
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View className="bg-gray-50 dark:bg-gray-800 rounded-2xl p-8 items-center">
                <ActivityIndicator size="small" color="#3B82F6" />
                <Text className="text-gray-500 dark:text-gray-400 mt-3">加载统计中...</Text>
              </View>
            )}
          </ScrollView>
        ) : activeTab === 'review' ? (
          <>
            {/* 复盘统计 */}
            {reviewStats && (
              <View className="px-4 mb-4">
                <View className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm">
                  <Text className="text-base font-bold text-gray-900 dark:text-white mb-3">
                    复盘统计
                  </Text>
                  <View className="flex-row flex-wrap gap-3">
                    <View className="flex-1 min-w-[100px] bg-gray-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                        {reviewStats.total ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">总建议</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-green-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-green-600 dark:text-green-400">
                        {reviewStats.hitTarget ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">已止盈</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-red-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-red-600 dark:text-red-400">
                        {reviewStats.stopped ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">已止损</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-yellow-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">
                        {reviewStats.pending ?? 0}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">跟踪中</Text>
                    </View>
                    <View className="flex-1 min-w-[100px] bg-gray-50 dark:bg-gray-700 rounded-xl p-3">
                      <Text className="text-2xl font-bold text-gray-600 dark:text-gray-300">
                        {reviewStats.winRate ? `${(reviewStats.winRate * 100).toFixed(0)}%` : '--'}
                      </Text>
                      <Text className="text-xs text-gray-500 dark:text-gray-400 mt-1">胜率</Text>
                    </View>
                  </View>
                </View>

                <TouchableOpacity
                  onPress={async () => {
                    await triggerReviewUpdate();
                    await loadReviewData();
                  }}
                  className="mt-3 bg-blue-500 rounded-xl py-3 items-center"
                >
                  <Text className="text-white font-semibold">立即更新复盘状态</Text>
                </TouchableOpacity>
              </View>
            )}

            {/* 复盘记录 */}
            <FlatList
              data={reviews}
              renderItem={renderReviewItem}
              keyExtractor={(item, index) => `${item.id}-${index}`}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
              ListEmptyComponent={
                <View className="items-center py-10">
                  <FontAwesome6 name="clipboard-list" size={48} color="#ccc" />
                  <Text className="text-gray-500 dark:text-gray-400 mt-4 text-center">
                    暂无复盘记录，先生成日报或点击「立即更新复盘状态」
                  </Text>
                </View>
              }
            />
          </>
        ) : (
          <>
            {/* 日报模式切换 */}
            <View className="px-4 pb-3">
              <View className="flex-row bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
                <TouchableOpacity
                  className={`flex-1 py-2 rounded-lg ${dailyMode === 'event' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
                  onPress={() => setDailyMode('event')}
                >
                  <Text className={`text-center text-sm font-semibold ${dailyMode === 'event' ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'}`}>
                    事件日报
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className={`flex-1 py-2 rounded-lg ${dailyMode === 'signal' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
                  onPress={() => setDailyMode('signal')}
                >
                  <Text className={`text-center text-sm font-semibold ${dailyMode === 'signal' ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'}`}>
                    信号日报
                  </Text>
                </TouchableOpacity>
              </View>
            </View>

            {dailyMode === 'event' ? (
              <>
                {/* 实时/历史事件 Tab 切换 */}
                <View className="px-4 pb-2">
                  <View className="flex-row items-center gap-2">
                    <View className="flex-1 flex-row bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
                      <TouchableOpacity
                        className={`flex-1 py-2 rounded-lg ${eventTab === 'realtime' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
                        onPress={() => setEventTab('realtime')}
                      >
                        <Text className={`text-center text-sm font-semibold ${eventTab === 'realtime' ? 'text-orange-600 dark:text-orange-400' : 'text-gray-500 dark:text-gray-400'}`}>
                          实时事件 ({realtimeEvents.filter((e) => e.date.startsWith(currentYear)).length})
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        className={`flex-1 py-2 rounded-lg ${eventTab === 'historical' ? 'bg-white dark:bg-gray-700 shadow-sm' : ''}`}
                        onPress={() => setEventTab('historical')}
                      >
                        <Text className={`text-center text-sm font-semibold ${eventTab === 'historical' ? 'text-indigo-600 dark:text-indigo-400' : 'text-gray-500 dark:text-gray-400'}`}>
                          历史事件 ({events.length})
                        </Text>
                      </TouchableOpacity>
                    </View>
                    {/* 手动刷新实时事件 */}
                    <TouchableOpacity
                      className="w-10 h-10 rounded-xl bg-white dark:bg-gray-800 items-center justify-center shadow-sm"
                      onPress={handleRefreshRealtime}
                      disabled={realtimeRefreshing}
                    >
                      {realtimeRefreshing ? (
                        <ActivityIndicator size="small" color="#f97316" />
                      ) : (
                        <FontAwesome6 name="rotate" size={16} color="#f97316" />
                      )}
                    </TouchableOpacity>
                  </View>
                </View>

                {/* 事件筛选器 */}
                <View className="px-4 pb-3">
                  <View className="flex-row items-center bg-white dark:bg-gray-800 rounded-xl px-3 py-2 mb-2 shadow-sm">
                    <FontAwesome6 name="magnifying-glass" size={14} color="#9ca3af" />
                    <TextInput
                      className="flex-1 ml-2 text-sm text-gray-900 dark:text-white"
                      placeholder="搜索事件标题 / 共识 / 品种"
                      placeholderTextColor="#9ca3af"
                      value={eventKeyword}
                      onChangeText={setEventKeyword}
                    />
                    {eventKeyword ? (
                      <TouchableOpacity onPress={() => setEventKeyword('')}>
                        <FontAwesome6 name="xmark" size={14} color="#9ca3af" />
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="mb-2">
                      <View className="flex-row gap-2">
                        <TouchableOpacity
                          className={`px-3 py-1.5 rounded-full ${selectedCategory === null ? 'bg-indigo-600' : 'bg-white dark:bg-gray-800'}`}
                          onPress={() => setSelectedCategory(null)}
                        >
                          <Text className={`text-xs font-medium ${selectedCategory === null ? 'text-white' : 'text-gray-600 dark:text-gray-300'}`}>
                            全部
                          </Text>
                        </TouchableOpacity>
                        {eventCategories.map(([cat, name]) => (
                          <TouchableOpacity
                            key={cat}
                            className={`px-3 py-1.5 rounded-full ${selectedCategory === cat ? 'bg-indigo-600' : 'bg-white dark:bg-gray-800'}`}
                            onPress={() => setSelectedCategory(cat)}
                          >
                            <Text className={`text-xs font-medium ${selectedCategory === cat ? 'text-white' : 'text-gray-600 dark:text-gray-300'}`}>
                              {name}
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </ScrollView>
                  </View>
                </View>

                {(eventTab === 'realtime' ? realtimeLoading : eventsLoading) ? (
                  <View className="flex-1 items-center justify-center py-16">
                    <ActivityIndicator color="#6366f1" />
                    <Text className="text-gray-400 mt-3 text-xs">
                      {eventTab === 'realtime' ? '加载实时事件...' : '加载历史事件...'}
                    </Text>
                  </View>
                ) : (
                  <FlatList
                    data={filteredEvents}
                    renderItem={renderEventCard}
                    keyExtractor={(item, index) => `${item.id}-${index}`}
                    contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
                    ListHeaderComponent={
                      eventTab === 'historical' ? (
                        <View className="mb-3">
                          <View className="flex-row gap-2">
                            <TouchableOpacity
                              className="flex-1 flex-row items-center justify-center py-2.5 rounded-xl bg-indigo-600"
                              onPress={handleGenerateAllEventDailies}
                              disabled={reportGenerating}
                            >
                              {reportGenerating ? (
                                <ActivityIndicator size="small" color="#fff" />
                              ) : (
                                <FontAwesome6 name="wand-magic-sparkles" size={14} color="#fff" />
                              )}
                              <Text className="text-sm font-medium text-white ml-2">
                                {reportGenerating ? '生成中...' : '补全历史日报'}
                              </Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                              className="flex-1 flex-row items-center justify-center py-2.5 rounded-xl bg-indigo-50 dark:bg-indigo-900/30"
                              onPress={handleOpenHistory}
                            >
                              <FontAwesome6 name="clock-rotate-left" size={14} color="#6366f1" />
                              <Text className="text-sm font-medium text-indigo-600 dark:text-indigo-400 ml-2">
                                历史日报（{historyList.length}）
                              </Text>
                            </TouchableOpacity>
                          </View>
                        </View>
                      ) : null
                    }
                    ListEmptyComponent={
                      <View className="items-center justify-center py-16">
                        <FontAwesome6 name="calendar-xmark" size={40} color="#ccc" />
                        <Text className="text-gray-400 mt-3 text-xs text-center">
                          {eventTab === 'realtime'
                            ? '暂无实时事件\n系统每小时自动检测新闻中的市场事件'
                            : '未找到匹配的历史事件'}
                        </Text>
                      </View>
                    }
                  />
                )}
              </>
            ) : (
              <>
                {renderHeader()}

                {records.length === 0 ? (
                  <View className="flex-1 items-center justify-center px-8">
                    <FontAwesome6 name="calendar-xmark" size={48} color="#ccc" />
                    <Text className="text-gray-500 dark:text-gray-400 mt-4 text-center">
                      {selectedDate === getLocalDateStr()
                        ? '今日暂无日报，点击"生成日报"开始'
                        : '该日期暂无日报记录'}
                    </Text>
                  </View>
                ) : viewMode === 'card' ? (
                  <FlatList
                    data={records}
                    renderItem={renderCard}
                    keyExtractor={(item) => `${item.code}-${item.trade_date}`}
                    contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 20 }}
                    refreshControl={
                      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                    }
                  />
                ) : (
                  <FlatList
                    data={records}
                    renderItem={renderListItem}
                    keyExtractor={(item) => `${item.code}-${item.trade_date}`}
                    refreshControl={
                      <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                    }
                  />
                )}
              </>
            )}
          </>
        )}

        {/* 事件日报详情 */}
        <Modal
          visible={reportVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setReportVisible(false)}
        >
          <View className="flex-1 bg-black/50 justify-end">
            <View className="bg-white dark:bg-gray-900 rounded-t-3xl" style={{ maxHeight: '88%' }}>
              <View className="flex-row items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <Text className="text-base font-bold text-gray-900 dark:text-white">
                  {reportGenerating ? '生成日报中...' : '事件日报'}
                </Text>
                <TouchableOpacity onPress={() => setReportVisible(false)}>
                  <FontAwesome6 name="xmark" size={18} color="#9ca3af" />
                </TouchableOpacity>
              </View>
              {reportGenerating ? (
                <View className="items-center justify-center py-16">
                  <ActivityIndicator color="#6366f1" />
                  <Text className="text-gray-400 mt-3 text-xs">正在综合分析事件与品种技术面...</Text>
                </View>
              ) : currentReport ? (
                renderEventReport()
              ) : (
                <View className="items-center justify-center py-16">
                  <FontAwesome6 name="circle-exclamation" size={40} color="#f59e0b" />
                  <Text className="text-gray-400 mt-3 text-xs">日报内容加载失败，请重试</Text>
                </View>
              )}
            </View>
          </View>
        </Modal>

        {/* 历史日报（复盘数据） */}
        <Modal
          visible={historyVisible}
          transparent
          animationType="slide"
          onRequestClose={() => setHistoryVisible(false)}
        >
          <View className="flex-1 bg-black/50 justify-end">
            <View className="bg-white dark:bg-gray-900 rounded-t-3xl" style={{ maxHeight: '88%' }}>
              <View className="flex-row items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <Text className="text-base font-bold text-gray-900 dark:text-white">历史日报</Text>
                <TouchableOpacity onPress={() => setHistoryVisible(false)}>
                  <FontAwesome6 name="xmark" size={18} color="#9ca3af" />
                </TouchableOpacity>
              </View>
              <ScrollView className="px-5 pb-6" style={{ flexGrow: 0 }}>
                {historyList.length === 0 ? (
                  <View className="items-center justify-center py-16">
                    <FontAwesome6 name="clock-rotate-left" size={40} color="#ccc" />
                    <Text className="text-gray-400 mt-3 text-xs">暂无历史日报</Text>
                  </View>
                ) : (
                  historyList.map((item) => (
                    <TouchableOpacity
                      key={item.id}
                      className="flex-row items-center justify-between py-3 border-b border-gray-100 dark:border-gray-800"
                      onPress={() => {
                        setHistoryVisible(false);
                        try {
                          const report = JSON.parse(item.report_json) as EventDailyReport;
                          setCurrentReport(report);
                          setReportVisible(true);
                        } catch {
                          Alert.alert('提示', '日报数据解析失败');
                        }
                      }}
                    >
                      <View className="flex-1 pr-3">
                        <Text className="text-sm font-medium text-gray-900 dark:text-white">{item.title}</Text>
                        <Text className="text-xs text-gray-400 mt-1">
                          {item.event_date} · {item.category}
                        </Text>
                      </View>
                      <FontAwesome6 name="chevron-right" size={14} color="#ccc" />
                    </TouchableOpacity>
                  ))
                )}
              </ScrollView>
            </View>
          </View>
        </Modal>

        {/* 日期选择器 */}
        <Modal
          visible={datePickerVisible}
          transparent
          animationType="fade"
          onRequestClose={() => setDatePickerVisible(false)}
        >
          <View className="flex-1 bg-black/50 justify-end">
            <View className="bg-white dark:bg-gray-900 rounded-t-3xl" style={{ maxHeight: '75%' }}>
              <View className="flex-row items-center justify-between px-5 py-4 border-b border-gray-100 dark:border-gray-800">
                <Text className="text-base font-bold text-gray-900 dark:text-white">选择日期</Text>
                <View className="flex-row items-center gap-3">
                  <TouchableOpacity onPress={handleGoToday}>
                    <Text className="text-sm font-medium text-indigo-600 dark:text-indigo-400">今天</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setDatePickerVisible(false)}>
                    <FontAwesome6 name="xmark" size={18} color="#9ca3af" />
                  </TouchableOpacity>
                </View>
              </View>
              <FlatList
                data={recentDates}
                keyExtractor={(item) => item}
                renderItem={({ item }) => {
                  const isSelected = item === selectedDate;
                  const hasJournal = dates.includes(item);
                  return (
                    <TouchableOpacity
                      className={`flex-row items-center justify-between px-5 py-3 border-b border-gray-50 dark:border-gray-800 ${isSelected ? 'bg-indigo-50 dark:bg-indigo-900/20' : ''}`}
                      onPress={() => handleSelectDate(item)}
                    >
                      <View className="flex-row items-center">
                        <Text className={`text-sm ${isSelected ? 'font-bold text-indigo-600 dark:text-indigo-400' : 'text-gray-700 dark:text-gray-200'}`}>
                          {formatDate(item)}
                        </Text>
                        {item === getLocalDateStr() ? (
                          <Text className="text-xs text-indigo-500 dark:text-indigo-400 ml-2">今天</Text>
                        ) : null}
                      </View>
                      <View className="flex-row items-center gap-2">
                        {hasJournal ? (
                          <Text className="text-xs text-gray-400">有日报</Text>
                        ) : null}
                        {isSelected ? (
                          <FontAwesome6 name="check" size={14} color="#6366f1" />
                        ) : null}
                      </View>
                    </TouchableOpacity>
                  );
                }}
              />
            </View>
          </View>
        </Modal>
      </View>
    </Screen>
  );
}
