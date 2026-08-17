import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';


interface PositionData {
  positions: any[];
  distribution: {
    sector: Record<string, number>;
    direction: { long: number; short: number };
  };
  risk: {
    var95: number;
    var99: number;
    expectedShortfall: number;
    note?: string;
  };
}

export function PositionAnalysisContent() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<PositionData | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/portfolio/position-analysis`
      );
      const result = await response.json();
      if (result.success) {
        setData(result.data);
      } else {
        setError(result.error || '获取持仓分析失败');
      }
    } catch (err) {
      setError('网络请求失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchData();
    }, [fetchData])
  );

  return (
    <>
      <ScrollView style={{ flex: 1, backgroundColor: '#0A0A0F' }} contentContainerStyle={{ padding: 20 }}>
        <Text style={{ color: '#E0E0E0', fontSize: 24, fontWeight: 'bold', marginBottom: 10 }}>
          持仓分析
        </Text>
        <Text style={{ color: '#888', fontSize: 14, marginBottom: 20 }}>
          当前持仓分布与风险指标
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

        {!loading && !error && data && (
          <>
            {/* 持仓统计 */}
            <View style={{ backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <Text style={{ color: '#00F0FF', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>
                持仓统计
              </Text>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <View>
                  <Text style={{ color: '#888', fontSize: 12 }}>总持仓</Text>
                  <Text style={{ color: '#E0E0E0', fontSize: 20, fontWeight: 'bold' }}>
                    {data.positions.length}
                  </Text>
                </View>
                <View>
                  <Text style={{ color: '#888', fontSize: 12 }}>多头</Text>
                  <Text style={{ color: '#00FF88', fontSize: 20, fontWeight: 'bold' }}>
                    {data.distribution.direction.long || 0}
                  </Text>
                </View>
                <View>
                  <Text style={{ color: '#888', fontSize: 12 }}>空头</Text>
                  <Text style={{ color: '#FF4444', fontSize: 20, fontWeight: 'bold' }}>
                    {data.distribution.direction.short || 0}
                  </Text>
                </View>
              </View>
            </View>

            {/* 板块分布 */}
            <View style={{ backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16, marginBottom: 16 }}>
              <Text style={{ color: '#00F0FF', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>
                板块分布
              </Text>
              {Object.keys(data.distribution.sector).length === 0 ? (
                <Text style={{ color: '#666', fontSize: 14 }}>暂无持仓数据</Text>
              ) : (
                Object.entries(data.distribution.sector).map(([sector, count]) => (
                  <View key={sector} style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 8 }}>
                    <Text style={{ color: '#E0E0E0', fontSize: 14 }}>{sector}</Text>
                    <Text style={{ color: '#888', fontSize: 14 }}>{count as number} 个品种</Text>
                  </View>
                ))
              )}
            </View>

            {/* 风险指标 */}
            <View style={{ backgroundColor: '#1E1E2E', borderRadius: 12, padding: 16 }}>
              <Text style={{ color: '#00F0FF', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>
                风险指标
              </Text>
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>VaR (95%)</Text>
                <Text style={{ color: '#FFB800', fontSize: 18, fontWeight: 'bold' }}>
                  {(data.risk.var95 * 100).toFixed(2)}%
                </Text>
              </View>
              <View style={{ marginBottom: 12 }}>
                <Text style={{ color: '#888', fontSize: 12 }}>VaR (99%)</Text>
                <Text style={{ color: '#FF4444', fontSize: 18, fontWeight: 'bold' }}>
                  {(data.risk.var99 * 100).toFixed(2)}%
                </Text>
              </View>
              <View>
                <Text style={{ color: '#888', fontSize: 12 }}>Expected Shortfall</Text>
                <Text style={{ color: '#FF4444', fontSize: 18, fontWeight: 'bold' }}>
                  {(data.risk.expectedShortfall * 100).toFixed(2)}%
                </Text>
              </View>
              {data.risk.note && (
                <Text style={{ color: '#666', fontSize: 12, marginTop: 12, fontStyle: 'italic' }}>
                  {data.risk.note}
                </Text>
              )}
            </View>
          </>
        )}
      </ScrollView>
    </>
  );
}

export default function PositionAnalysisScreen() {
  return (
    <Screen>
      <PositionAnalysisContent />
    </Screen>
  );
}
