import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';

const { width } = Dimensions.get('window');

interface CalendarDay {
  date: string;
  dayOfWeek: string;
  isWeekend: boolean;
  isTradingDay: boolean;
  month: number;
  day: number;
}

export default function TradingCalendarScreen() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calendar, setCalendar] = useState<CalendarDay[]>([]);

  const fetchCalendar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/portfolio/trading-calendar?days=60`
      );
      const result = await response.json();
      if (result.success) {
        setCalendar(result.data);
      } else {
        setError(result.error || '获取交易日历失败');
      }
    } catch (err) {
      setError('网络请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchCalendar();
    }, [fetchCalendar])
  );

  const renderCalendar = () => {
    // 按月份分组
    const grouped: Record<string, CalendarDay[]> = {};
    calendar.forEach((day) => {
      const monthKey = `${day.month}月`;
      if (!grouped[monthKey]) {
        grouped[monthKey] = [];
      }
      grouped[monthKey].push(day);
    });

    return Object.entries(grouped).map(([month, days]) => (
      <View key={month} style={{ marginBottom: 20 }}>
        <Text style={{ color: '#00F0FF', fontSize: 18, fontWeight: 'bold', marginBottom: 10 }}>
          {month}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {days.map((day) => (
            <View
              key={day.date}
              style={{
                width: (width - 60) / 7,
                aspectRatio: 1,
                backgroundColor: day.isWeekend ? '#1E1E2E' : '#0F0F1E',
                borderWidth: 1,
                borderColor: day.isTradingDay ? '#00F0FF40' : '#333',
                borderRadius: 8,
                justifyContent: 'center',
                alignItems: 'center',
              }}
            >
              <Text
                style={{
                  color: day.isWeekend ? '#666' : '#E0E0E0',
                  fontSize: 16,
                  fontWeight: day.isTradingDay ? 'bold' : 'normal',
                }}
              >
                {day.day}
              </Text>
              <Text
                style={{
                  color: day.isWeekend ? '#666' : '#888',
                  fontSize: 10,
                  marginTop: 2,
                }}
              >
                {day.dayOfWeek}
              </Text>
            </View>
          ))}
        </View>
      </View>
    ));
  };

  return (
    <Screen>
      <ScrollView style={{ flex: 1, backgroundColor: '#0A0A0F' }} contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 24, fontWeight: 'bold', marginBottom: 10 }}>
          交易日历
        </Text>
        <Text style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>
          未来60天交易日展示（周末标记为灰色）
        </Text>

        {loading && (
          <View style={{ alignItems: 'center', padding: 40 }}>
            <ActivityIndicator size="large" color="#00F0FF" />
            <Text style={{ color: '#888', fontSize: 14, marginTop: 10 }}>加载中...</Text>
          </View>
        )}

        {error && (
          <View style={{ backgroundColor: '#FF444420', borderRadius: 12, padding: 12, marginBottom: 20 }}>
            <Text style={{ color: '#FF4444', fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {!loading && !error && calendar.length > 0 && (
          <>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 12, height: 12, backgroundColor: '#0F0F1E', borderWidth: 1, borderColor: '#00F0FF40', borderRadius: 2 }} />
                <Text style={{ color: '#888', fontSize: 12, marginLeft: 6 }}>交易日</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <View style={{ width: 12, height: 12, backgroundColor: '#1E1E2E', borderWidth: 1, borderColor: '#333', borderRadius: 2 }} />
                <Text style={{ color: '#888', fontSize: 12, marginLeft: 6 }}>周末</Text>
              </View>
            </View>
            {renderCalendar()}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
