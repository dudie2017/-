/**
 * 组合风控监控页面
 * 展示：单日亏损、组合回撤、板块集中度、相关性告警、品种验证状态
 */
import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useFocusEffect } from 'expo-router';


const BG = '#0A0A0F';
const CARD = '#16161F';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#8A8A93';
const ACCENT = '#00F0FF';
const GREEN = '#00C853';
const RED = '#FF3B30';
const ORANGE = '#FF9500';
const YELLOW = '#FFD700';

interface RiskCheck {
  name: string;
  level: 'normal' | 'warning' | 'danger';
  message: string;
}

interface PortfolioRiskData {
  riskLevel: 'normal' | 'warning' | 'danger';
  canTrade: boolean;
  checks: RiskCheck[];
  blockedReasons: string[];
  portfolio?: {
    totalCapital: number;
    currentValue: number;
    dailyPnl: number;
    dailyPnlPct: number;
    maxDrawdown: number;
    maxDrawdownPct: number;
    openPositions: number;
  };
  positions?: Array<{
    code: string;
    sector: string;
    positionValue: number;
    weight: number;
  }>;
  sectorConcentration?: Array<{
    sector: string;
    weight: number;
    varieties: string[];
  }>;
  correlations?: Array<{
    code1: string;
    code2: string;
    correlation: number;
  }>;
}

interface VarietyValidation {
  code: string;
  validationStatus: 'iron_clad' | 'robust' | 'sensitive' | 'overfit';
  maxPositionPct: number;
  volReduce: string;
  dailyLossLimit: number;
  circuitBreaker: number;
}

export function PortfolioRiskContent() {
  const [riskData, setRiskData] = useState<PortfolioRiskData | null>(null);
  const [varieties, setVarieties] = useState<VarietyValidation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<'risk' | 'varieties' | 'positions'>('risk');

  const fetchData = useCallback(async () => {
    try {
      // 获取风控数据
      const riskResponse = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio-risk`);
      const riskResult = await riskResponse.json();
      if (riskResult.success) {
        setRiskData(riskResult.data);
      }

      // 获取品种验证状态（从 realtimeOptParams）
      const varietiesResponse = await fetchWithTimeout(`${BACKEND_BASE}/api/v1/portfolio-risk/varieties`);
      const varietiesResult = await varietiesResponse.json();
      if (varietiesResult.success) {
        setVarieties(varietiesResult.data || []);
      }
    } catch (error) {
      console.error('Error fetching portfolio risk:', error);
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

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'normal': return GREEN;
      case 'warning': return ORANGE;
      case 'danger': return RED;
      default: return TEXT2;
    }
  };

  const getLevelIcon = (level: string) => {
    switch (level) {
      case 'normal': return 'circle-check';
      case 'warning': return 'triangle-exclamation';
      case 'danger': return 'circle-xmark';
      default: return 'circle-question';
    }
  };

  const getValidationColor = (status: string) => {
    switch (status) {
      case 'iron_clad': return '#FFD700'; // 金色
      case 'robust': return GREEN;
      case 'sensitive': return ORANGE;
      case 'overfit': return RED;
      default: return TEXT2;
    }
  };

  const getValidationLabel = (status: string) => {
    switch (status) {
      case 'iron_clad': return '铁底';
      case 'robust': return '稳健';
      case 'sensitive': return '敏感';
      case 'overfit': return '过拟合';
      default: return '未知';
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={ACCENT} />
          <Text style={styles.loadingText}>加载风控数据...</Text>
        </View>
      </Screen>
    );
  }

  return (
    <>
      <View style={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title}>组合风控监控</Text>
          <View style={[styles.statusBadge, { backgroundColor: riskData?.riskLevel === 'normal' ? GREEN : riskData?.riskLevel === 'warning' ? ORANGE : RED }]}>
            <Text style={styles.statusText}>
              {riskData?.riskLevel === 'normal' ? '正常' : riskData?.riskLevel === 'warning' ? '警告' : '危险'}
            </Text>
          </View>
        </View>

        {/* Tabs */}
        <View style={styles.tabs}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'risk' && styles.tabActive]}
            onPress={() => setActiveTab('risk')}
          >
            <Text style={[styles.tabText, activeTab === 'risk' && styles.tabTextActive]}>风控状态</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'varieties' && styles.tabActive]}
            onPress={() => setActiveTab('varieties')}
          >
            <Text style={[styles.tabText, activeTab === 'varieties' && styles.tabTextActive]}>品种验证</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'positions' && styles.tabActive]}
            onPress={() => setActiveTab('positions')}
          >
            <Text style={[styles.tabText, activeTab === 'positions' && styles.tabTextActive]}>持仓分析</Text>
          </TouchableOpacity>
        </View>

        <ScrollView
          style={styles.content}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
        >
          {/* Risk Tab */}
          {activeTab === 'risk' && riskData && (
            <View>
              {/* Can Trade Status */}
              <View style={[styles.card, { borderColor: riskData.canTrade ? GREEN : RED }]}>
                <View style={styles.cardHeader}>
                  <FontAwesome6
                    name={riskData.canTrade ? 'check-circle' : 'ban'}
                    size={24}
                    color={riskData.canTrade ? GREEN : RED}
                  />
                  <Text style={[styles.cardTitle, { color: riskData.canTrade ? GREEN : RED }]}>
                    {riskData.canTrade ? '可以交易' : '交易被拦截'}
                  </Text>
                </View>
                {!riskData.canTrade && riskData.blockedReasons.length > 0 && (
                  <View style={styles.blockedReasons}>
                    {riskData.blockedReasons.map((reason, idx) => (
                      <Text key={idx} style={styles.blockedReasonText}>• {reason}</Text>
                    ))}
                  </View>
                )}
              </View>

              {/* Risk Checks */}
              <Text style={styles.sectionTitle}>风控检查项</Text>
              {riskData.checks.map((check, idx) => (
                <View key={idx} style={styles.checkItem}>
                  <View style={styles.checkLeft}>
                    <FontAwesome6
                      name={getLevelIcon(check.level) as any}
                      size={18}
                      color={getLevelColor(check.level)}
                    />
                    <Text style={styles.checkName}>{check.name}</Text>
                  </View>
                  <Text style={[styles.checkMessage, { color: getLevelColor(check.level) }]}>
                    {check.message}
                  </Text>
                </View>
              ))}

              {/* Portfolio Summary */}
              {riskData.portfolio && (
                <>
                  <Text style={styles.sectionTitle}>组合概况</Text>
                  <View style={styles.card}>
                    <View style={styles.statRow}>
                      <Text style={styles.statLabel}>总资金</Text>
                      <Text style={styles.statValue}>¥{(riskData.portfolio.totalCapital / 10000).toFixed(1)}万</Text>
                    </View>
                    <View style={styles.statRow}>
                      <Text style={styles.statLabel}>当前净值</Text>
                      <Text style={styles.statValue}>¥{(riskData.portfolio.currentValue / 10000).toFixed(1)}万</Text>
                    </View>
                    <View style={styles.statRow}>
                      <Text style={styles.statLabel}>今日盈亏</Text>
                      <Text style={[styles.statValue, { color: riskData.portfolio.dailyPnl >= 0 ? GREEN : RED }]}>
                        {riskData.portfolio.dailyPnl >= 0 ? '+' : ''}{(riskData.portfolio.dailyPnl / 10000).toFixed(2)}万 ({riskData.portfolio.dailyPnlPct.toFixed(2)}%)
                      </Text>
                    </View>
                    <View style={styles.statRow}>
                      <Text style={styles.statLabel}>最大回撤</Text>
                      <Text style={[styles.statValue, { color: RED }]}>
                        {(riskData.portfolio.maxDrawdown / 10000).toFixed(2)}万 ({riskData.portfolio.maxDrawdownPct.toFixed(2)}%)
                      </Text>
                    </View>
                    <View style={styles.statRow}>
                      <Text style={styles.statLabel}>持仓品种</Text>
                      <Text style={styles.statValue}>{riskData.portfolio.openPositions} 个</Text>
                    </View>
                  </View>
                </>
              )}
            </View>
          )}

          {/* Varieties Tab */}
          {activeTab === 'varieties' && (
            <View>
              <Text style={styles.sectionTitle}>品种验证状态</Text>
              {varieties.length === 0 ? (
                <View style={styles.emptyCard}>
                  <Text style={styles.emptyText}>暂无品种验证数据</Text>
                </View>
              ) : (
                varieties.map((v) => (
                  <View key={v.code} style={styles.varietyCard}>
                    <View style={styles.varietyHeader}>
                      <Text style={styles.varietyCode}>{v.code}</Text>
                      <View style={[styles.validationBadge, { backgroundColor: getValidationColor(v.validationStatus) }]}>
                        <Text style={styles.validationText}>{getValidationLabel(v.validationStatus)}</Text>
                      </View>
                    </View>
                    <View style={styles.varietyDetails}>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>最大仓位</Text>
                        <Text style={styles.detailValue}>{(v.maxPositionPct * 100).toFixed(0)}%</Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>波动率过滤</Text>
                        <Text style={styles.detailValue}>{v.volReduce}</Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>日亏损限制</Text>
                        <Text style={styles.detailValue}>{(v.dailyLossLimit * 100).toFixed(1)}%</Text>
                      </View>
                      <View style={styles.detailRow}>
                        <Text style={styles.detailLabel}>熔断阈值</Text>
                        <Text style={styles.detailValue}>{(v.circuitBreaker * 100).toFixed(0)}%</Text>
                      </View>
                    </View>
                  </View>
                ))
              )}
            </View>
          )}

          {/* Positions Tab */}
          {activeTab === 'positions' && riskData && (
            <View>
              {/* Sector Concentration */}
              {riskData.sectorConcentration && riskData.sectorConcentration.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>板块集中度</Text>
                  {riskData.sectorConcentration.map((sector, idx) => (
                    <View key={idx} style={styles.card}>
                      <View style={styles.sectorHeader}>
                        <Text style={styles.sectorName}>{sector.sector}</Text>
                        <Text style={[styles.sectorWeight, { color: sector.weight > 0.4 ? RED : sector.weight > 0.3 ? ORANGE : TEXT1 }]}>
                          {(sector.weight * 100).toFixed(1)}%
                        </Text>
                      </View>
                      <Text style={styles.sectorVarieties}>{sector.varieties.join(', ')}</Text>
                      {sector.weight > 0.4 && (
                        <View style={styles.warningBadge}>
                          <FontAwesome6 name="triangle-exclamation" size={12} color={RED} />
                          <Text style={[styles.warningText, { color: RED }]}>超过 40% 阈值</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </>
              )}

              {/* Correlations */}
              {riskData.correlations && riskData.correlations.length > 0 && (
                <>
                  <Text style={styles.sectionTitle}>品种相关性</Text>
                  {riskData.correlations.map((corr, idx) => (
                    <View key={idx} style={styles.card}>
                      <View style={styles.corrHeader}>
                        <Text style={styles.corrPair}>{corr.code1} - {corr.code2}</Text>
                        <Text style={[styles.corrValue, { color: corr.correlation > 0.7 ? RED : corr.correlation > 0.5 ? ORANGE : TEXT1 }]}>
                          {corr.correlation.toFixed(3)}
                        </Text>
                      </View>
                      {corr.correlation > 0.7 && (
                        <View style={styles.warningBadge}>
                          <FontAwesome6 name="triangle-exclamation" size={12} color={RED} />
                          <Text style={[styles.warningText, { color: RED }]}>高相关性警告</Text>
                        </View>
                      )}
                    </View>
                  ))}
                </>
              )}
            </View>
          )}
        </ScrollView>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: TEXT2, marginTop: 12, fontSize: 14 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 20, fontWeight: '700', color: TEXT1 },
  statusBadge: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 },
  statusText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  tabs: { flexDirection: 'row', paddingHorizontal: 16, marginBottom: 8 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderBottomWidth: 2, borderBottomColor: 'transparent' },
  tabActive: { borderBottomColor: ACCENT },
  tabText: { color: TEXT2, fontSize: 14 },
  tabTextActive: { color: ACCENT, fontWeight: '600' },
  content: { flex: 1, paddingHorizontal: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: TEXT2, marginTop: 16, marginBottom: 8 },
  card: { backgroundColor: CARD, borderRadius: 12, padding: 16, marginBottom: 12, borderWidth: 1, borderColor: BORDER },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: '600' },
  blockedReasons: { marginTop: 12, paddingLeft: 36 },
  blockedReasonText: { color: RED, fontSize: 13, marginBottom: 4 },
  checkItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: CARD, borderRadius: 8, padding: 12, marginBottom: 8 },
  checkLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkName: { color: TEXT1, fontSize: 14 },
  checkMessage: { fontSize: 12 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8 },
  statLabel: { color: TEXT2, fontSize: 14 },
  statValue: { color: TEXT1, fontSize: 14, fontWeight: '600' },
  varietyCard: { backgroundColor: CARD, borderRadius: 12, padding: 16, marginBottom: 12 },
  varietyHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  varietyCode: { fontSize: 18, fontWeight: '700', color: TEXT1 },
  validationBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  validationText: { color: '#fff', fontSize: 12, fontWeight: '600' },
  varietyDetails: { gap: 8 },
  detailRow: { flexDirection: 'row', justifyContent: 'space-between' },
  detailLabel: { color: TEXT2, fontSize: 13 },
  detailValue: { color: TEXT1, fontSize: 13, fontWeight: '500' },
  emptyCard: { backgroundColor: CARD, borderRadius: 12, padding: 32, alignItems: 'center' },
  emptyText: { color: TEXT2, fontSize: 14 },
  sectorHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  sectorName: { fontSize: 16, fontWeight: '600', color: TEXT1 },
  sectorWeight: { fontSize: 16, fontWeight: '700' },
  sectorVarieties: { color: TEXT2, fontSize: 12, marginTop: 4 },
  warningBadge: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8 },
  warningText: { fontSize: 12 },
  corrHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  corrPair: { fontSize: 14, fontWeight: '600', color: TEXT1 },
  corrValue: { fontSize: 16, fontWeight: '700' },
});

export default function PortfolioRiskScreen() {
  return (
    <Screen>
      <PortfolioRiskContent />
    </Screen>
  );
}
