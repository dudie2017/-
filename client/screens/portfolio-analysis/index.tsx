import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Modal,
  TouchableWithoutFeedback,
  Keyboard,
  Platform,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';


function formatTime(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface PnlHistogram {
  min: number;
  max: number;
  p25: number;
  median: number;
  p75: number;
  mean: number;
  std: number;
  binWidth: number;
  counts: number[];
}

interface Variety {
  code: string;
  name?: string;
  sector?: string;
  avgPnl: number;
  avgPf: number;
  avgWinRate: number;
  avgMaxDd: number;
  experiments: number;
  rank: number;
  tier: string;
  score: number;
  pnlHistogram?: PnlHistogram;
}

interface CorrelationMatrix {
  [key: string]: { [key: string]: number };
}

interface AnalysisData {
  summary: {
    totalVarieties: number;
    sTier: number;
    aTier: number;
    bTier: number;
    cTier: number;
  };
  varieties: Variety[];
  correlation: CorrelationMatrix;
  generatedAt?: string;
}

export function PortfolioAnalysisContent() {
  const router = useSafeRouter();
  const [data, setData] = useState<AnalysisData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'ranking' | 'correlation'>('ranking');
  const [selectedVariety, setSelectedVariety] = useState<Variety | null>(null);
  const [refreshingData, setRefreshingData] = useState(false);
  const [selectedSector, setSelectedSector] = useState<string>('全部');

  const fetchData = useCallback(async () => {
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/analysis`);
      const result = await response.json();
      if (result.success) {
        setData(result.data);
        setError(null);
      } else {
        setError(result.error || '加载分析数据失败');
      }
    } catch (err) {
      console.error('Error fetching portfolio analysis:', err);
      setError('网络异常，无法加载分析数据');
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

  const handleRefreshData = async () => {
    if (refreshingData) return;
    setRefreshingData(true);
    try {
      const response = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio/refresh`, {
        method: 'POST',
      });
      const result = await response.json();
      if (result.success) {
        // 刷新任务已后台启动，稍后下拉刷新即可拉取新数据
        console.log('刷新任务已启动');
      }
    } catch (error) {
      console.error('触发刷新失败:', error);
    } finally {
      setRefreshingData(false);
    }
  };

  const getTierColor = (tier: string) => {
    switch (tier) {
      case 'S': return '#FFD700';
      case 'A': return '#00F0FF';
      case 'B': return '#BF00FF';
      default: return '#555570';
    }
  };

  const getSectorColor = (sector: string) => {
    const colors: { [key: string]: string } = {
      '黑色系': '#9CA3AF',
      '有色': '#FFB873',
      '贵金属': '#FFD700',
      '能源化工': '#5EEAD4',
      '农产品': '#86EFAC',
      '金融': '#818CF8',
    };
    return colors[sector] || '#888';
  };

  // 板块选项（从品种列表动态提取）
  const sectorOptions = useMemo(() => {
    if (!data?.varieties) return ['全部'];
    const sectors = Array.from(
      new Set(data.varieties.map((v) => v.sector).filter((s): s is string => !!s))
    );
    return ['全部', ...sectors];
  }, [data]);

  // 按板块筛选后的品种列表
  const filteredVarieties = useMemo(() => {
    if (!data?.varieties) return [];
    if (selectedSector === '全部') return data.varieties;
    return data.varieties.filter((v) => v.sector === selectedSector);
  }, [data, selectedSector]);

  // 从相关性矩阵动态计算高相关品种对（corr > 0.7，取前 3）
  const highCorrPairs = useMemo(() => {
    if (!data?.correlation) return [];
    const pairs: { pair: string; corr: number }[] = [];
    const codes = filteredVarieties.map((v) => v.code);
    for (let i = 0; i < codes.length; i++) {
      for (let j = i + 1; j < codes.length; j++) {
        const corr = data.correlation[codes[i]]?.[codes[j]];
        if (typeof corr === 'number' && corr > 0.7) {
          pairs.push({ pair: `${codes[i]}-${codes[j]}`, corr });
        }
      }
    }
    return pairs.sort((a, b) => b.corr - a.corr).slice(0, 3);
  }, [data, filteredVarieties]);

  // 从相关性矩阵动态计算低相关品种（与其他品种平均相关性最低，取前 3）
  const lowCorrVarieties = useMemo(() => {
    if (!data?.correlation) return [];
    const codes = filteredVarieties.map((v) => v.code);
    const avgCorr = codes.map((code) => {
      const row = data.correlation[code] || {};
      const values = Object.entries(row)
        .filter(([k, v]) => k !== code && typeof v === 'number')
        .map(([, v]) => v as number);
      const sum = values.reduce((acc, v) => acc + v, 0);
      return { code, corr: values.length > 0 ? sum / values.length : 0 };
    });
    return avgCorr.sort((a, b) => a.corr - b.corr).slice(0, 3);
  }, [data, filteredVarieties]);

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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#00F0FF', fontSize: 24, fontWeight: 'bold' }}>
                {data?.summary?.totalVarieties ?? ''} 品种组合分析
              </Text>
              <Text style={{ color: '#C8C8D8', fontSize: 14, marginTop: 8 }}>
                基于 1000 次 LHS 回测实验
              </Text>
              {data?.generatedAt ? (
                <Text style={{ color: '#666680', fontSize: 11, marginTop: 6 }}>
                  数据更新于 {formatTime(data.generatedAt)}
                </Text>
              ) : null}
            </View>
            <TouchableOpacity
              onPress={handleRefreshData}
              disabled={refreshingData}
              style={{
                backgroundColor: refreshingData ? '#1A1A2E' : '#00F0FF',
                paddingHorizontal: 14,
                paddingVertical: 8,
                borderRadius: 8,
                marginLeft: 12,
              }}
            >
              <Text style={{ color: refreshingData ? '#888' : '#0A0A0F', fontWeight: 'bold', fontSize: 13 }}>
                {refreshingData ? '生成中…' : '刷新数据'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Tabs */}
        <View style={{ flexDirection: 'row', backgroundColor: '#12121A', borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
          <TouchableOpacity
            style={{ flex: 1, paddingVertical: 16, alignItems: 'center' }}
            onPress={() => setActiveTab('ranking')}
          >
            <Text style={{
              color: activeTab === 'ranking' ? '#00F0FF' : '#AAA',
              fontWeight: activeTab === 'ranking' ? 'bold' : 'normal',
              fontSize: 16,
            }}>
              品种排名
            </Text>
            {activeTab === 'ranking' && (
              <View style={{ width: 40, height: 3, backgroundColor: '#00F0FF', marginTop: 4, borderRadius: 2 }} />
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={{ flex: 1, paddingVertical: 16, alignItems: 'center' }}
            onPress={() => setActiveTab('correlation')}
          >
            <Text style={{
              color: activeTab === 'correlation' ? '#00F0FF' : '#AAA',
              fontWeight: activeTab === 'correlation' ? 'bold' : 'normal',
              fontSize: 16,
            }}>
              相关性矩阵
            </Text>
            {activeTab === 'correlation' && (
              <View style={{ width: 40, height: 3, backgroundColor: '#00F0FF', marginTop: 4, borderRadius: 2 }} />
            )}
          </TouchableOpacity>
        </View>

        {/* Content */}
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
        >
          {activeTab === 'ranking' && data && (
            <View style={{ padding: 16 }}>
              {/* Summary Cards */}
              <View style={{ flexDirection: 'row', marginBottom: 16, gap: 12 }}>
                <View style={{ flex: 1, backgroundColor: '#12121A', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ color: '#AAA', fontSize: 12 }}>总品种数</Text>
                  <Text style={{ color: '#00F0FF', fontSize: 24, fontWeight: 'bold', marginTop: 4 }}>
                    {data.summary.totalVarieties}
                  </Text>
                </View>
                <View style={{ flex: 1, backgroundColor: '#12121A', padding: 16, borderRadius: 12, borderWidth: 1, borderColor: '#1E1E2E' }}>
                  <Text style={{ color: '#AAA', fontSize: 12 }}>S/A 级品种</Text>
                  <Text style={{ color: '#00FF88', fontSize: 24, fontWeight: 'bold', marginTop: 4 }}>
                    {data.summary.sTier + data.summary.aTier}
                  </Text>
                </View>
              </View>

              {/* Variety List */}
              <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1E1E2E' }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#E8E8ED' }}>综合评分排名</Text>
                {data.varieties.map((variety, index) => (
                  <TouchableOpacity
                    key={variety.code}
                    onPress={() => setSelectedVariety(variety)}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 12,
                      borderBottomWidth: index < data.varieties.length - 1 ? 1 : 0,
                      borderBottomColor: '#1E1E2E',
                    }}
                  >
                    <Text style={{ width: 30, color: '#888', fontSize: 14 }}>{index + 1}</Text>
                    <View style={{
                      width: 32,
                      height: 32,
                      borderRadius: 16,
                      backgroundColor: getTierColor(variety.tier),
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginRight: 12,
                    }}>
                      <Text style={{ color: '#FFF', fontWeight: 'bold', fontSize: 14 }}>
                        {variety.tier}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={{ fontSize: 16, fontWeight: '600', color: '#E8E8ED' }}>{variety.code}</Text>
                        <View style={{ backgroundColor: '#1A1A2E', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8 }}>
                          <Text style={{ fontSize: 11, color: '#00F0FF', fontWeight: '600' }}>
                            评分 {variety.score.toFixed(1)}
                          </Text>
                        </View>
                      </View>
                      <Text style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                        收益 {(variety.avgPnl / 10000).toFixed(2)}万
                      </Text>
                    </View>
                    <View style={{ alignItems: 'flex-end' }}>
                      <Text style={{ fontSize: 16, fontWeight: 'bold', color: '#00F0FF' }}>
                        PF {variety.avgPf.toFixed(2)}
                      </Text>
                      <View style={{ flexDirection: 'row', marginTop: 4, gap: 8 }}>
                        <Text style={{ fontSize: 11, color: '#00FF88' }}>
                          胜率 {(variety.avgWinRate * 100).toFixed(0)}%
                        </Text>
                        <Text style={{ fontSize: 11, color: '#FFB800' }}>
                          回撤 {(variety.avgMaxDd * 100).toFixed(1)}%
                        </Text>
                      </View>
                    </View>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {activeTab === 'correlation' && data && (
            <View style={{ padding: 16 }}>
              <View style={{ backgroundColor: '#12121A', borderRadius: 12, padding: 16, borderWidth: 1, borderColor: '#1E1E2E' }}>
                <Text style={{ fontSize: 18, fontWeight: 'bold', marginBottom: 16, color: '#E8E8ED' }}>品种相关性矩阵</Text>
                <Text style={{ fontSize: 12, color: '#AAA', marginBottom: 12 }}>
                  数值范围：-1（负相关）到 1（正相关），0 表示无相关
                </Text>

                {/* 颜色图例 */}
                <View style={{ flexDirection: 'row', gap: 16, marginBottom: 16, alignItems: 'center' }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View style={{ width: 16, height: 16, borderRadius: 3, backgroundColor: 'rgba(255, 68, 68, 0.6)' }} />
                    <Text style={{ fontSize: 11, color: '#AAA' }}>强正相关 &gt;0.7</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View style={{ width: 16, height: 16, borderRadius: 3, backgroundColor: 'rgba(0, 240, 255, 0.4)' }} />
                    <Text style={{ fontSize: 11, color: '#AAA' }}>强负相关 &lt;-0.5</Text>
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <View style={{ width: 16, height: 16, borderRadius: 3, backgroundColor: '#1A1A2E', borderWidth: 1, borderColor: '#1E1E2E' }} />
                    <Text style={{ fontSize: 11, color: '#AAA' }}>无相关</Text>
                  </View>
                </View>

                {/* 板块筛选 */}
                <View style={{ marginBottom: 16 }}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <View style={{ flexDirection: 'row', gap: 8 }}>
                      {sectorOptions.map((sector) => {
                        const active = selectedSector === sector;
                        return (
                          <TouchableOpacity
                            key={sector}
                            onPress={() => setSelectedSector(sector)}
                            style={{
                              paddingHorizontal: 14,
                              paddingVertical: 8,
                              borderRadius: 18,
                              backgroundColor: active ? '#00F0FF' : '#1A1A2E',
                              borderWidth: 1,
                              borderColor: active ? '#00F0FF' : '#1E1E2E',
                            }}
                          >
                            <Text style={{ color: active ? '#0A0A0F' : '#C8C8D8', fontSize: 13, fontWeight: active ? 'bold' : 'normal' }}>
                              {sector}
                            </Text>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  </ScrollView>
                </View>

                {/* Simplified Correlation Display */}
                <View>
                  <ScrollView horizontal>
                    <View>
                    {filteredVarieties.map((v1, i) => (
                      <View key={v1.code} style={{ flexDirection: 'row', marginBottom: 4 }}>
                        <Text style={{ width: 60, fontSize: 12, fontWeight: '600', color: '#E8E8ED' }}>{v1.code}</Text>
                        {filteredVarieties.map((v2, j) => {
                          const corr = data?.correlation?.[v1.code]?.[v2.code] ?? 0;
                          const corrNum = typeof corr === 'number' ? corr : 0;
                          // 热力图颜色映射：强正相关→红色，强负相关→青色，无相关→深色
                          const absCorr = Math.abs(corrNum);
                          let bgColor = '#1A1A2E';
                          let textColor = '#E8E8ED';
                          if (corrNum > 0.7) {
                            // 强正相关：深红
                            bgColor = `rgba(255, 68, 68, ${0.3 + absCorr * 0.5})`;
                            textColor = '#FF6B6B';
                          } else if (corrNum > 0.5) {
                            // 中等正相关：浅红
                            bgColor = `rgba(255, 68, 68, ${0.15 + absCorr * 0.2})`;
                          } else if (corrNum < -0.5) {
                            // 强负相关：深青
                            bgColor = `rgba(0, 240, 255, ${0.2 + absCorr * 0.4})`;
                            textColor = '#00F0FF';
                          } else if (corrNum < -0.3) {
                            // 中等负相关：浅青
                            bgColor = `rgba(0, 240, 255, ${0.1 + absCorr * 0.2})`;
                          }
                          // 高相关性品种对视觉突出（对角线除外）
                          const isHighCorr = i !== j && absCorr > 0.7;
                          return (
                            <View
                              key={v2.code}
                              style={{
                                width: 50,
                                height: 30,
                                backgroundColor: bgColor,
                                alignItems: 'center',
                                justifyContent: 'center',
                                marginRight: 2,
                                borderRadius: 4,
                                borderWidth: isHighCorr ? 1.5 : 0,
                                borderColor: isHighCorr ? (corrNum > 0 ? '#FF4444' : '#00F0FF') : 'transparent',
                              }}
                            >
                              <Text style={{ fontSize: 10, color: textColor, fontWeight: isHighCorr ? 'bold' : 'normal' }}>
                                {corrNum.toFixed(2)}
                              </Text>
                            </View>
                          );
                        })}
                      </View>
                    ))}
                  </View>
                </ScrollView>
                </View>

                {/* High Correlation Pairs */}
                <View style={{ marginTop: 24 }}>
                  <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: '#E8E8ED' }}>高相关品种对</Text>
                  {highCorrPairs.map((item, index) => (
                    <View
                      key={index}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingVertical: 8,
                        borderBottomWidth: 1,
                        borderBottomColor: '#1E1E2E',
                      }}
                    >
                      <Text style={{ fontSize: 14, color: '#E8E8ED' }}>{item.pair}</Text>
                      <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#FF4444' }}>
                        {item.corr.toFixed(3)}
                      </Text>
                    </View>
                  ))}
                </View>

                {/* Low Correlation Varieties */}
                <View style={{ marginTop: 24 }}>
                  <Text style={{ fontSize: 16, fontWeight: 'bold', marginBottom: 12, color: '#E8E8ED' }}>低相关分散化品种</Text>
                  {lowCorrVarieties.map((item, index) => (
                    <View
                      key={index}
                      style={{
                        flexDirection: 'row',
                        justifyContent: 'space-between',
                        paddingVertical: 8,
                        borderBottomWidth: 1,
                        borderBottomColor: '#1E1E2E',
                      }}
                    >
                      <Text style={{ fontSize: 14, color: '#E8E8ED' }}>{item.code}</Text>
                      <Text style={{ fontSize: 14, fontWeight: 'bold', color: '#00FF88' }}>
                        {item.corr.toFixed(3)}
                      </Text>
                    </View>
                  ))}
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      </View>
      <VarietyDetailModal variety={selectedVariety} onClose={() => setSelectedVariety(null)} />
    </>
  );
}

export default function PortfolioAnalysisScreen() {
  return (
    <Screen>
      <PortfolioAnalysisContent />
    </Screen>
  );
}

// ===== 单品种下钻组件（暗黑科技风）=====
const TIER_COLORS: Record<string, string> = {
  S: '#FFD700',
  A: '#00F0FF',
  B: '#BF00FF',
  C: '#555570',
};

function fmtPnl(v: number): string {
  const wan = v / 10000;
  if (Math.abs(wan) >= 100) return wan.toFixed(0) + '万';
  if (Math.abs(wan) >= 1) return wan.toFixed(1) + '万';
  return v.toFixed(0) + '元';
}

function MetricBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View
      style={{
        width: '48%',
        backgroundColor: '#1A1A2E',
        borderRadius: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: '#1E1E2E',
      }}
    >
      <Text style={{ color: '#888', fontSize: 12 }}>{label}</Text>
      <Text style={{ color, fontSize: 18, fontWeight: 'bold', marginTop: 4 }}>{value}</Text>
    </View>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ backgroundColor: '#1A1A2E', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 }}>
      <Text style={{ color: '#888', fontSize: 11 }}>{label}</Text>
      <Text style={{ color: '#E8E8ED', fontSize: 13, fontWeight: 'bold', marginTop: 2 }}>{value}</Text>
    </View>
  );
}

function PnlHistogram({ histogram }: { histogram: PnlHistogram }) {
  const { min, max, counts, p25, median, p75, mean } = histogram;
  const maxCount = Math.max(...counts);
  return (
    <View>
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: 120, marginTop: 8 }}>
        {counts.map((count, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              marginHorizontal: 1.5,
              height: maxCount > 0 ? Math.max((count / maxCount) * 120, 2) : 2,
              backgroundColor: '#00F0FF',
              borderRadius: 2,
            }}
          />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 6 }}>
        <Text style={{ color: '#888', fontSize: 10 }}>{fmtPnl(min)}</Text>
        <Text style={{ color: '#888', fontSize: 10 }}>{fmtPnl(max)}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
        <StatChip label="P25" value={fmtPnl(p25)} />
        <StatChip label="中位数" value={fmtPnl(median)} />
        <StatChip label="P75" value={fmtPnl(p75)} />
        <StatChip label="均值" value={fmtPnl(mean)} />
      </View>
    </View>
  );
}

function VarietyDetailModal({ variety, onClose }: { variety: Variety | null; onClose: () => void }) {
  if (!variety) return null;
  const h = variety.pnlHistogram;
  const tierColor = TIER_COLORS[variety.tier] || '#555570';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: '#12121A',
            borderTopLeftRadius: 24,
            borderTopRightRadius: 24,
            padding: 24,
            maxHeight: '85%',
            borderTopWidth: 1,
            borderTopColor: 'rgba(0,240,255,0.2)',
          }}
        >
          <ScrollView showsVerticalScrollIndicator={false}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ backgroundColor: tierColor, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 6 }}>
                  <Text style={{ color: '#0A0A0F', fontWeight: 'bold', fontSize: 12 }}>{variety.tier}</Text>
                </View>
                <Text style={{ color: '#E8E8ED', fontSize: 20, fontWeight: 'bold' }}>{variety.code}</Text>
              </View>
              <TouchableOpacity onPress={onClose} style={{ padding: 8 }}>
                <Text style={{ color: '#888', fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
            <Text style={{ color: '#00F0FF', fontSize: 14, marginTop: 4 }}>
              综合评分 {(variety.score ?? 0).toFixed(1)}
            </Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 16 }}>
              <MetricBox label="收益" value={fmtPnl(variety.avgPnl)} color="#00F0FF" />
              <MetricBox label="利润因子" value={(variety.avgPf ?? 0).toFixed(2)} color="#00FF88" />
              <MetricBox label="胜率" value={((variety.avgWinRate ?? 0) * 100).toFixed(0) + '%'} color="#FFD700" />
              <MetricBox label="最大回撤" value={((variety.avgMaxDd ?? 0) * 100).toFixed(1) + '%'} color="#FF4444" />
            </View>

            {h && h.counts && h.counts.length > 0 ? (
              <View style={{ marginTop: 20 }}>
                <Text style={{ color: '#E8E8ED', fontSize: 15, fontWeight: 'bold' }}>1000 次实验收益分布</Text>
                <PnlHistogram histogram={h} />
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
