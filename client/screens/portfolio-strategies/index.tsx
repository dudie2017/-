import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';


interface StrategyResult {
  strategy: string;
  description?: string;
  totalReturn: number;
  winRate: number;
  trades: number;
  annualized?: number;
  bestSector?: string;
  maxDrawdown?: number;
  sharpe?: number;
  navCurve?: number[];
}

interface ArbitragePair {
  code1: string;
  code2: string;
  corr: number;
}

interface ArbitrageResult extends StrategyResult {
  pairs: ArbitragePair[];
}

interface StrategyData {
  strategies: {
    sectorRotation: StrategyResult;
    arbitrage: ArbitrageResult;
  };
  varieties?: unknown[];
}

export function StrategyBacktestContent() {
  const [data, setData] = useState<StrategyData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeStrategy, setActiveStrategy] = useState<'rotation' | 'arbitrage'>('rotation');

  const fetchData = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/strategies`);
      const result = await response.json();
      if (result.success) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error || '加载策略数据失败');
      }
    } catch (err) {
      console.error('Error fetching strategies:', err);
      setError('网络异常，无法加载策略数据');
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

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0A0A0F' }}>
          <ActivityIndicator size="large" color="#00F0FF" />
          <Text style={{ marginTop: 16, color: '#AAA' }}>加载中...</Text>
        </View>
      </Screen>
    );
  }

  if (error && !data) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#0A0A0F' }}>
          <Text style={{ color: '#FF4444', fontSize: 18, fontWeight: 'bold' }}>加载失败</Text>
          <Text style={{ color: '#AAA', fontSize: 14, marginTop: 8, textAlign: 'center' }}>{error}</Text>
          <TouchableOpacity
            onPress={() => {
              setLoading(true);
              setError(null);
              fetchData();
            }}
            style={{ marginTop: 20, backgroundColor: '#00F0FF', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 8 }}
          >
            <Text style={{ color: '#0A0A0F', fontWeight: 'bold' }}>重试</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  return (
    <>
      <View style={{ flex: 1, backgroundColor: '#0A0A0F' }}>
        {/* Header */}
        <View style={{ backgroundColor: '#12121A', padding: 20, paddingTop: 60, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
          <Text style={{ color: '#00F0FF', fontSize: 24, fontWeight: 'bold' }}>
            策略回测
          </Text>
          <Text style={{ color: '#C8C8D8', fontSize: 14, marginTop: 8 }}>
            板块轮动与跨品种套利
          </Text>
        </View>

        {/* Strategy Selector */}
        <View style={{ flexDirection: 'row', padding: 16, gap: 12 }}>
          <TouchableOpacity
            style={{
              flex: 1,
              padding: 16,
              backgroundColor: activeStrategy === 'rotation' ? 'rgba(0,240,255,0.12)' : '#12121A',
              borderWidth: 1,
              borderColor: activeStrategy === 'rotation' ? '#00F0FF' : '#1E1E2E',
              borderRadius: 12,
              alignItems: 'center',
            }}
            onPress={() => setActiveStrategy('rotation')}
          >
            <Text style={{
              color: activeStrategy === 'rotation' ? '#00F0FF' : '#C8C8D8',
              fontWeight: 'bold',
              fontSize: 16,
            }}>
              板块轮动
            </Text>
            <Text style={{
              color: activeStrategy === 'rotation' ? '#00F0FF' : '#888',
              fontSize: 12,
              marginTop: 4,
            }}>
              动量策略
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={{
              flex: 1,
              padding: 16,
              backgroundColor: activeStrategy === 'arbitrage' ? 'rgba(0,255,136,0.12)' : '#12121A',
              borderWidth: 1,
              borderColor: activeStrategy === 'arbitrage' ? '#00FF88' : '#1E1E2E',
              borderRadius: 12,
              alignItems: 'center',
            }}
            onPress={() => setActiveStrategy('arbitrage')}
          >
            <Text style={{
              color: activeStrategy === 'arbitrage' ? '#00FF88' : '#C8C8D8',
              fontWeight: 'bold',
              fontSize: 16,
            }}>
              跨品种套利
            </Text>
            <Text style={{
              color: activeStrategy === 'arbitrage' ? '#00FF88' : '#888',
              fontSize: 12,
              marginTop: 4,
            }}>
              价差回归
            </Text>
          </TouchableOpacity>
        </View>

        {/* Content */}
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          <View style={{ padding: 16, gap: 16 }}>
            {activeStrategy === 'rotation' && data?.strategies?.sectorRotation && (
              <>
                {/* Performance Metrics */}
                <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#00F0FF' }}>
                    板块动量轮动策略
                  </Text>

                  <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>总收益</Text>
                      <Text style={{ color: '#00FF88', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {(data.strategies.sectorRotation.totalReturn / 10000).toFixed(0)}
                        <Text style={{ fontSize: 12, color: '#C8C8D8' }}> 万</Text>
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>胜率</Text>
                      <Text style={{ color: '#FFD700', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {(data.strategies.sectorRotation.winRate * 100).toFixed(0)}%
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>交易次数</Text>
                      <Text style={{ color: '#00F0FF', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {data.strategies.sectorRotation.trades}
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>最大回撤</Text>
                      <Text style={{ color: '#FF6B6B', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {((data.strategies.sectorRotation.maxDrawdown ?? 0) * 100).toFixed(1)}%
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>夏普比率</Text>
                      <Text style={{ color: '#C8C8D8', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {(data.strategies.sectorRotation.sharpe ?? 0).toFixed(2)}
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>最佳板块</Text>
                      <Text style={{ color: '#C8C8D8', fontSize: 14, fontWeight: 'bold', marginTop: 4 }}>
                        {data.strategies.sectorRotation.bestSector || '—'}
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Strategy Description */}
                <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 12, color: '#E8E8ED' }}>策略说明</Text>
                  <Text style={{ color: '#C8C8D8', lineHeight: 24 }}>
                    每月末计算各板块过去 20 日动量，全仓切换至动量最强的板块。基于真实行情逐日回放，该策略在当前品种池中表现为负收益（动量反转效应明显），回撤与波动较大，仅作研究参考，不构成投资建议。
                  </Text>
                </View>
              </>
            )}

            {activeStrategy === 'arbitrage' && data?.strategies?.arbitrage && (
              <>
                {/* Performance Metrics */}
                <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#00FF88' }}>
                    跨品种套利策略
                  </Text>

                  <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>总收益</Text>
                      <Text style={{ color: '#00FF88', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {(data.strategies.arbitrage.totalReturn / 10000).toFixed(0)}
                        <Text style={{ fontSize: 12, color: '#C8C8D8' }}> 万</Text>
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>年化收益</Text>
                      <Text style={{ color: '#00FF88', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {((data.strategies.arbitrage.annualized ?? data.strategies.arbitrage.totalReturn) / 10000).toFixed(0)}
                        <Text style={{ fontSize: 12, color: '#C8C8D8' }}> 万</Text>
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12, marginBottom: 16 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>胜率</Text>
                      <Text style={{ color: '#FFD700', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {(data.strategies.arbitrage.winRate * 100).toFixed(0)}%
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>交易次数</Text>
                      <Text style={{ color: '#00F0FF', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {data.strategies.arbitrage.trades}
                      </Text>
                    </View>
                  </View>

                  <View style={{ flexDirection: 'row', gap: 12 }}>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>套利对数</Text>
                      <Text style={{ color: '#C8C8D8', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {data.strategies.arbitrage.pairs?.length || 0}
                      </Text>
                    </View>
                    <View style={{ flex: 1, backgroundColor: '#1A1A2E', padding: 16, borderRadius: 8 }}>
                      <Text style={{ color: '#C8C8D8', fontSize: 12 }}>最大回撤</Text>
                      <Text style={{ color: '#FF6B6B', fontSize: 20, fontWeight: 'bold', marginTop: 4 }}>
                        {((data.strategies.arbitrage.maxDrawdown ?? 0) / 10000).toFixed(1)}
                        <Text style={{ fontSize: 12, color: '#C8C8D8' }}> 万</Text>
                      </Text>
                    </View>
                  </View>
                </View>

                {/* Top Arbitrage Pairs */}
                {data.strategies.arbitrage.pairs && (
                  <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                    <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#E8E8ED' }}>推荐套利品种对</Text>
                    {data.strategies.arbitrage.pairs.map((pair, index) => (
                      <View
                        key={index}
                        style={{
                          flexDirection: 'row',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          paddingVertical: 12,
                          borderBottomWidth: index < data.strategies.arbitrage.pairs.length - 1 ? 1 : 0,
                          borderBottomColor: '#1E1E2E',
                        }}
                      >
                        <View>
                          <Text style={{ fontSize: 16, fontWeight: '600', color: '#E8E8ED' }}>{pair.code1} - {pair.code2}</Text>
                          <Text style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                            相关性 {pair.corr.toFixed(3)}
                          </Text>
                        </View>
                      </View>
                    ))}
                  </View>
                )}

                {/* Strategy Description */}
                <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 20, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 12, color: '#E8E8ED' }}>策略说明</Text>
                  <Text style={{ color: '#C8C8D8', lineHeight: 24 }}>
                    对高相关品种对构建价差，当价差 z-score 偏离均值时反向开仓、回归时平仓。基于真实行情逐日回放，当前品种池下该策略胜率不足五成、小幅亏损，说明价差并未稳定收敛，仅作研究参考。
                  </Text>
                </View>
              </>
            )}
          </View>
        </ScrollView>
      </View>
    </>
  );
}

export default function StrategyBacktestScreen() {
  return (
    <Screen>
      <StrategyBacktestContent />
    </Screen>
  );
}
