import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';
import { LineChart } from 'react-native-gifted-charts';
import { FontAwesome6 } from '@expo/vector-icons';

const { width } = Dimensions.get('window');

interface VarietyInfo {
  code: string;
  name: string;
  sector: string;
  avgPnl: number;
  avgMaxDd: number;
  avgWinRate: number;
}

interface CompareData {
  varieties: VarietyInfo[];
  normalizedPrices: Record<string, { date: string; value: number }[]>;
  returns: Record<string, { mean: number; std: number; max: number; min: number }>;
  correlation: number[][];
}

const COLORS = ['#00F0FF', '#FF00FF', '#FFFF00'];

export function VarietyCompareContent() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<CompareData | null>(null);
  const [selectedCodes, setSelectedCodes] = useState<string[]>([]);
  const [allVarieties, setAllVarieties] = useState<VarietyInfo[]>([]);

  const fetchVarieties = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/analysis`);
      const result = await response.json();
      if (result.success && result.data?.varieties) {
        setAllVarieties(result.data.varieties.slice(0, 20)); // 取前20个品种
      }
    } catch (err) {
      console.error('Failed to fetch varieties:', err);
    }
  }, []);

  const fetchCompare = useCallback(async (codes: string[]) => {
    if (codes.length < 2) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/portfolio/compare?codes=${codes.join(',')}`
      );
      const result = await response.json();
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error || '对比失败');
      }
    } catch (err) {
      setError('网络请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchVarieties();
    }, [fetchVarieties])
  );

  const toggleCode = (code: string) => {
    setSelectedCodes((prev) => {
      if (prev.includes(code)) {
        return prev.filter((c) => c !== code);
      } else if (prev.length < 3) {
        return [...prev, code];
      }
      return prev;
    });
  };

  const handleCompare = () => {
    if (selectedCodes.length >= 2) {
      fetchCompare(selectedCodes);
    }
  };

  const renderChart = () => {
    if (!data) return null;

    // 找到所有品种的共同日期
    const allDates = new Set<string>();
    data.varieties.forEach((v) => {
      const prices = data.normalizedPrices[v.code] || [];
      prices.forEach((p) => allDates.add(p.date));
    });
    const sortedDates = Array.from(allDates).sort();

    // 构建每个品种的数据点
    const lineData = data.varieties.map((v, idx) => {
      const prices = data.normalizedPrices[v.code] || [];
      const priceMap = new Map(prices.map((p) => [p.date, p.value]));
      return {
        data: sortedDates.map((date) => ({ value: priceMap.get(date) || 100 })),
        color: COLORS[idx],
        label: v.name,
      };
    });

    return (
      <View style={{ marginTop: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 14, marginBottom: 10 }}>
          净值走势对比（基准=100）
        </Text>
        <View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <LineChart
              data={lineData}
              width={Math.max(width - 40, sortedDates.length * 8)}
              height={250}
              yAxisColor="#333"
              xAxisColor="#333"
              rulesColor="#222"
              hideDataPoints
              initialSpacing={0}
              endSpacing={0}
            />
          </ScrollView>
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'center', marginTop: 10 }}>
          {data.varieties.map((v, idx) => (
            <View key={v.code} style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 10 }}>
              <View style={{ width: 12, height: 12, backgroundColor: COLORS[idx], borderRadius: 6 }} />
              <Text style={{ color: '#E0E0E0', fontSize: 12, marginLeft: 4 }}>{v.name}</Text>
            </View>
          ))}
        </View>
      </View>
    );
  };

  const renderStats = () => {
    if (!data) return null;

    return (
      <View style={{ marginTop: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 14, marginBottom: 10 }}>
          收益率统计
        </Text>
        {data.varieties.map((v) => {
          const r = data.returns[v.code];
          return (
            <View key={v.code} style={{ backgroundColor: '#1E1E2E', borderRadius: 12, padding: 12, marginBottom: 10 }}>
              <Text style={{ color: COLORS[data.varieties.indexOf(v)], fontSize: 14, fontWeight: 'bold' }}>
                {v.name}
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>年化收益</Text>
                <Text style={{ color: r.mean > 0 ? '#00FF88' : '#FF4444', fontSize: 12 }}>
                  {(r.mean * 100).toFixed(2)}%
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>年化波动</Text>
                <Text style={{ color: '#E0E0E0', fontSize: 12 }}>
                  {(r.std * 100).toFixed(2)}%
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>最大日涨幅</Text>
                <Text style={{ color: '#00FF88', fontSize: 12 }}>
                  {(r.max * 100).toFixed(2)}%
                </Text>
              </View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>最大日跌幅</Text>
                <Text style={{ color: '#FF4444', fontSize: 12 }}>
                  {(r.min * 100).toFixed(2)}%
                </Text>
              </View>
            </View>
          );
        })}
      </View>
    );
  };

  const renderCorrelation = () => {
    if (!data || data.varieties.length < 2) return null;

    return (
      <View style={{ marginTop: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 14, marginBottom: 10 }}>
          相关性矩阵
        </Text>
        <View style={{ backgroundColor: '#1E1E2E', borderRadius: 12, padding: 12 }}>
          {data.varieties.map((v1, i) => (
            <View key={v1.code} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <Text style={{ color: COLORS[i], fontSize: 12, width: 60 }}>{v1.name}</Text>
              {data.varieties.map((v2, j) => {
                const corr = data.correlation[i][j];
                const bgColor = corr > 0.7 ? '#FF444440' : corr < -0.7 ? '#00FF8840' : 'transparent';
                return (
                  <View
                    key={v2.code}
                    style={{
                      flex: 1,
                      backgroundColor: bgColor,
                      padding: 8,
                      borderRadius: 4,
                      marginHorizontal: 2,
                    }}
                  >
                    <Text style={{ color: '#E0E0E0', fontSize: 12, textAlign: 'center' }}>
                      {corr.toFixed(2)}
                    </Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </View>
    );
  };

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: '#0A0A0F' }} contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 24, fontWeight: 'bold', marginBottom: 20 }}>
          品种对比分析
        </Text>

        <Text style={{ color: '#888', fontSize: 14, marginBottom: 10 }}>
          选择2-3个品种进行对比
        </Text>

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
          {allVarieties.map((v) => {
            const isSelected = selectedCodes.includes(v.code);
            return (
              <TouchableOpacity
                key={v.code}
                onPress={() => toggleCode(v.code)}
                style={{
                  backgroundColor: isSelected ? '#00F0FF20' : '#1E1E2E',
                  borderWidth: 1,
                  borderColor: isSelected ? '#00F0FF' : '#333',
                  borderRadius: 8,
                  padding: 8,
                  minWidth: 80,
                }}
              >
                <Text style={{ color: isSelected ? '#00F0FF' : '#888', fontSize: 12, textAlign: 'center' }}>
                  {v.name}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <TouchableOpacity
          onPress={handleCompare}
          disabled={selectedCodes.length < 2 || loading}
          style={{
            backgroundColor: selectedCodes.length >= 2 ? '#00F0FF' : '#333',
            borderRadius: 12,
            padding: 16,
            alignItems: 'center',
            marginBottom: 20,
          }}
        >
          {loading ? (
            <ActivityIndicator color="#0A0A0F" />
          ) : (
            <Text style={{ color: '#0A0A0F', fontSize: 16, fontWeight: 'bold' }}>
              开始对比（已选 {selectedCodes.length} 个）
            </Text>
          )}
        </TouchableOpacity>

        {error && (
          <View style={{ backgroundColor: '#FF444420', borderRadius: 12, padding: 12, marginBottom: 20 }}>
            <Text style={{ color: '#FF4444', fontSize: 14 }}>{error}</Text>
          </View>
        )}

        {data && (
          <>
            {renderChart()}
            {renderStats()}
            {renderCorrelation()}
          </>
        )}
      </ScrollView>
    </>
  );
}

export default function VarietyCompareScreen() {
  return (
    <Screen>
      <VarietyCompareContent />
    </Screen>
  );
}
