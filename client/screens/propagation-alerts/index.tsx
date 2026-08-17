/**
 * 传播链预警页
 * 展示事件驱动传播链监控的当日活跃信号
 * 数据来源：GET /api/v1/event-monitor/daily
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import {
  EventMonitorAlert,
  EventMonitorDailyResponse,
  LeaderShock,
  PropagationStats,
  IntradaySignal,
  fetchEventMonitorDaily,
  fetchPropagationStats,
  triggerEventMonitorScan,
  streamEventMonitorInterpretation,
} from '@/utils/eventMonitorApi';

const BG = '#0A0A0F';
const CARD = '#16161F';
const CARD2 = '#1D1D28';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#8A8A93';
const ACCENT = '#00F0FF';
const GREEN = '#00C853';
const RED = '#FF3B30';
const PURPLE = '#BF00FF';
const YELLOW = '#FFD60A';

const SECTOR_COLORS: Record<string, string> = {
  黑色系: '#FF6B6B',
  有色: '#4ECDC4',
  贵金属: '#FFD93D',
  油脂油料: '#6BCB77',
  软商品: '#FF8C42',
  能源: '#4D96A9',
  化工: '#9B59B6',
  金融: '#3498DB',
};

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });
  } catch {
    return dateStr;
  }
}

function SectorHeatmap({ alerts }: { alerts: EventMonitorAlert[] }) {
  const sectorCounts = alerts.reduce((acc, alert) => {
    acc[alert.sector] = (acc[alert.sector] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const sectors = Object.keys(SECTOR_COLORS);

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
      {sectors.map((sector) => {
        const count = sectorCounts[sector] || 0;
        const color = SECTOR_COLORS[sector];
        const opacity = count > 0 ? 1 : 0.3;
        return (
          <View
            key={sector}
            style={{
              backgroundColor: count > 0 ? `${color}20` : CARD2,
              borderWidth: 1,
              borderColor: count > 0 ? `${color}60` : BORDER,
              borderRadius: 12,
              paddingHorizontal: 12,
              paddingVertical: 8,
              minWidth: 80,
              opacity,
            }}
          >
            <Text style={{ color: count > 0 ? color : TEXT2, fontSize: 12, fontWeight: '600' }}>
              {sector}
            </Text>
            <Text style={{ color: TEXT1, fontSize: 18, fontWeight: '700' }}>
              {count > 0 ? count : '—'}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function AlertCard({ alert }: { alert: EventMonitorAlert }) {
  const isLong = alert.direction === 'LONG';
  const directionColor = isLong ? GREEN : RED;
  const directionIcon = isLong ? 'arrow-trend-up' : 'arrow-trend-down';
  const sectorColor = SECTOR_COLORS[alert.sector] || ACCENT;
  const confidence = alert.confidenceScore || 0;
  const confidenceColor = confidence >= 75 ? GREEN : confidence >= 60 ? YELLOW : TEXT2;
  const confidenceLabel = confidence >= 75 ? '高置信' : confidence >= 60 ? '中置信' : '低置信';

  return (
    <View
      style={{
        backgroundColor: CARD,
        borderRadius: 16,
        padding: 16,
        marginBottom: 12,
        borderWidth: 1,
        borderColor: BORDER,
      }}
    >
      {/* Header */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: `${directionColor}20`,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <FontAwesome6 name={directionIcon as any} size={16} color={directionColor} />
          </View>
          <View>
            <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '700' }}>
              {alert.leaderName} → {alert.followerName}
            </Text>
            <Text style={{ color: TEXT2, fontSize: 11 }}>
              {formatDate(alert.shockDate)} · {alert.sector}
            </Text>
          </View>
        </View>
        <View
          style={{
            backgroundColor: `${sectorColor}20`,
            paddingHorizontal: 8,
            paddingVertical: 4,
            borderRadius: 6,
          }}
        >
          <Text style={{ color: sectorColor, fontSize: 11, fontWeight: '600' }}>
            {alert.sector}
          </Text>
        </View>
      </View>

      {/* Details */}
      <View style={{ flexDirection: 'row', gap: 16, marginBottom: 12 }}>
        <View>
          <Text style={{ color: TEXT2, fontSize: 10 }}>冲击幅度</Text>
          <Text style={{ color: TEXT1, fontSize: 13, fontWeight: '600' }}>
            {(alert.shockReturn * 100).toFixed(1)}%
          </Text>
        </View>
        <View>
          <Text style={{ color: TEXT2, fontSize: 10 }}>ATR倍数</Text>
          <Text style={{ color: ACCENT, fontSize: 13, fontWeight: '600' }}>
            {alert.shockAtrMult.toFixed(1)}×
          </Text>
        </View>
        <View>
          <Text style={{ color: TEXT2, fontSize: 10 }}>滞后天数</Text>
          <Text style={{ color: TEXT1, fontSize: 13, fontWeight: '600' }}>
            {alert.lagDays}天
          </Text>
        </View>
        <View>
          <Text style={{ color: TEXT2, fontSize: 10 }}>止损</Text>
          <Text style={{ color: RED, fontSize: 13, fontWeight: '600' }}>
            {(alert.stopLoss * 100).toFixed(1)}%
          </Text>
        </View>
      </View>

      {/* Confidence */}
      <View style={{ marginBottom: 12 }}>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 4,
          }}
        >
          <Text style={{ color: TEXT2, fontSize: 10 }}>信号置信度</Text>
          <Text style={{ color: confidenceColor, fontSize: 12, fontWeight: '700' }}>
            {confidence}分 · {confidenceLabel}
          </Text>
        </View>
        <View
          style={{
            height: 6,
            backgroundColor: CARD2,
            borderRadius: 3,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.min(Math.max(confidence, 0), 100)}%`,
              height: '100%',
              backgroundColor: confidenceColor,
              borderRadius: 3,
            }}
          />
        </View>
      </View>

      {/* Filters */}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {alert.sectorCorrelation !== null && (
          <View
            style={{
              backgroundColor: alert.sectorCorrelation >= 0.4 ? `${GREEN}20` : `${TEXT2}20`,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
            }}
          >
            <Text style={{ color: alert.sectorCorrelation >= 0.4 ? GREEN : TEXT2, fontSize: 10 }}>
              板块联动 {(alert.sectorCorrelation * 100).toFixed(0)}%
            </Text>
          </View>
        )}
        {alert.seasonalAlignment !== null && (
          <View
            style={{
              backgroundColor: alert.seasonalAlignment ? `${GREEN}20` : `${TEXT2}20`,
              paddingHorizontal: 8,
              paddingVertical: 4,
              borderRadius: 6,
            }}
          >
            <Text style={{ color: alert.seasonalAlignment ? GREEN : TEXT2, fontSize: 10 }}>
              {alert.seasonalAlignment ? '✓ 季节性同向' : '✗ 季节性反向'}
            </Text>
          </View>
        )}
      </View>

      {/* Logic */}
      <Text style={{ color: TEXT2, fontSize: 11, marginTop: 8, fontStyle: 'italic' }}>
        {alert.logic}
      </Text>
    </View>
  );
}

function ShockCard({ shock }: { shock: LeaderShock }) {
  const isUp = shock.direction === 'up';
  const directionColor = isUp ? GREEN : RED;
  const directionIcon = isUp ? 'arrow-trend-up' : 'arrow-trend-down';

  return (
    <View
      style={{
        backgroundColor: CARD2,
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: BORDER,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <FontAwesome6 name={directionIcon as any} size={14} color={directionColor} />
        <View>
          <Text style={{ color: TEXT1, fontSize: 13, fontWeight: '600' }}>
            {shock.varietyName} ({shock.variety})
          </Text>
          <Text style={{ color: TEXT2, fontSize: 10 }}>{formatDate(shock.date)}</Text>
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: directionColor, fontSize: 13, fontWeight: '700' }}>
          {(shock.retPct * 100).toFixed(1)}%
        </Text>
        <Text style={{ color: TEXT2, fontSize: 10 }}>
          {shock.atrMult.toFixed(1)}×ATR
        </Text>
      </View>
    </View>
  );
}

function IntradaySignalCard({ signal }: { signal: IntradaySignal }) {
  const isUp = signal.direction === 'up';
  const directionColor = isUp ? GREEN : RED;
  const directionIcon = isUp ? 'arrow-trend-up' : 'arrow-trend-down';

  return (
    <View
      style={{
        backgroundColor: CARD2,
        borderRadius: 12,
        padding: 12,
        marginBottom: 8,
        borderWidth: 1,
        borderColor: `${directionColor}40`,
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            backgroundColor: `${directionColor}20`,
            justifyContent: 'center',
            alignItems: 'center',
          }}
        >
          <FontAwesome6 name={directionIcon as any} size={14} color={directionColor} />
        </View>
        <View>
          <Text style={{ color: TEXT1, fontSize: 13, fontWeight: '600' }}>
            {signal.varietyName} ({signal.variety})
          </Text>
          <Text style={{ color: TEXT2, fontSize: 10 }}>
            {signal.datetime?.slice(5, 16) || ''} · 30分钟盘中异动
          </Text>
        </View>
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ color: directionColor, fontSize: 13, fontWeight: '700' }}>
          {signal.atrMult.toFixed(1)}×ATR
        </Text>
        <Text style={{ color: TEXT2, fontSize: 10 }}>盘中冲击</Text>
      </View>
    </View>
  );
}

function LeaderGroupCard({
  leader,
  leaderName,
  alerts,
}: {
  leader: string;
  leaderName: string;
  alerts: EventMonitorAlert[];
}) {
  const topConfidence = Math.max(...alerts.map((a) => a.confidenceScore || 0));
  const topColor = topConfidence >= 75 ? GREEN : topConfidence >= 60 ? YELLOW : TEXT2;

  return (
    <View
      style={{
        backgroundColor: CARD,
        borderRadius: 16,
        padding: 16,
        marginBottom: 14,
        borderWidth: 1,
        borderColor: BORDER,
      }}
    >
      {/* Leader header */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View
            style={{
              width: 32,
              height: 32,
              borderRadius: 8,
              backgroundColor: `${ACCENT}20`,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <FontAwesome6 name="bolt" size={16} color={ACCENT} />
          </View>
          <View>
            <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '700' }}>
              {leaderName} ({leader})
            </Text>
            <Text style={{ color: TEXT2, fontSize: 11 }}>
              冲击事件 · {alerts.length} 个跟随预警
            </Text>
          </View>
        </View>
        <Text style={{ color: topColor, fontSize: 12, fontWeight: '700' }}>
          最高 {topConfidence}分
        </Text>
      </View>

      {/* Follower alerts */}
      {alerts.map((alert) => (
        <View
          key={alert.id}
          style={{
            marginLeft: 6,
            paddingLeft: 12,
            borderLeftWidth: 2,
            borderLeftColor: BORDER,
            marginBottom: 8,
          }}
        >
          <AlertCard alert={alert} />
        </View>
      ))}
    </View>
  );
}

export default function PropagationAlertsScreen() {
  const [data, setData] = useState<EventMonitorDailyResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [aiText, setAiText] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [stats, setStats] = useState<PropagationStats | null>(null);

  const loadData = useCallback(async () => {
    try {
      const result = await fetchEventMonitorDaily();
      setData(result);
      setLoadError('');
    } catch {
      setLoadError('服务暂不可用，请稍后下拉刷新重试');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStats = useCallback(async () => {
    try {
      const result = await fetchPropagationStats();
      setStats(result);
    } catch {
      // 历史统计加载失败，静默忽略
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      loadStats();
    }, [loadData, loadStats])
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  }, [loadData]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      await triggerEventMonitorScan();
      await loadData();
    } catch {
      // 扫描失败
    } finally {
      setScanning(false);
    }
  }, [loadData]);

  const handleAIInterpretation = useCallback(() => {
    if (aiLoading) return;
    setAiText('');
    setAiError('');
    setAiLoading(true);

    streamEventMonitorInterpretation({
      onChunk: (content) => {
        setAiText((prev) => prev + content);
      },
      onDone: () => {
        setAiLoading(false);
      },
      onError: (msg) => {
        setAiError(msg);
        setAiLoading(false);
      },
    });
  }, [aiLoading]);

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={ACCENT} />
        </View>
      </Screen>
    );
  }

  const alerts = [...(data?.alerts || [])].sort(
    (a, b) => (b.confidenceScore || 0) - (a.confidenceScore || 0)
  );
  const leaderShocks = data?.leaderShocks || [];
  const intradaySignals = data?.intradaySignals || [];
  const summary = data?.summary;

  // 按 leader 分组（组内按置信度降序）
  const groupedByLeader = alerts.reduce((acc, alert) => {
    if (!acc[alert.leader]) acc[alert.leader] = [];
    acc[alert.leader].push(alert);
    return acc;
  }, {} as Record<string, EventMonitorAlert[]>);

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1, backgroundColor: BG }}
        contentContainerStyle={{ padding: 16, paddingBottom: 32 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={handleRefresh}
            tintColor={ACCENT}
            colors={[ACCENT]}
          />
        }
      >
        {/* Header */}
        <View style={{ marginBottom: 20 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <Text style={{ color: TEXT1, fontSize: 24, fontWeight: '700' }}>
              传播链预警
            </Text>
            <TouchableOpacity
              onPress={handleScan}
              disabled={scanning}
              style={{
                backgroundColor: scanning ? CARD2 : `${ACCENT}20`,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              <FontAwesome6
                name="arrows-rotate"
                size={14}
                color={ACCENT}
                style={scanning ? { transform: [{ rotate: '180deg' }] } : undefined}
              />
              <Text style={{ color: ACCENT, fontSize: 12, fontWeight: '600' }}>
                {scanning ? '扫描中...' : '手动扫描'}
              </Text>
            </TouchableOpacity>
          </View>
          {summary && (
            <Text style={{ color: TEXT2, fontSize: 12 }}>
              扫描日期：{formatDate(data?.scanDate || '')} · 检测到 {summary.shockCount} 个冲击 · {summary.alertCount} 个预警
            </Text>
          )}
        </View>

        {/* Sector Heatmap */}
        <View style={{ backgroundColor: CARD, borderRadius: 16, padding: 16, marginBottom: 16, borderWidth: 1, borderColor: BORDER }}>
          <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '600', marginBottom: 12 }}>
            板块热力图
          </Text>
          <SectorHeatmap alerts={alerts} />
        </View>

        {/* AI Interpretation */}
        <View
          style={{
            backgroundColor: CARD,
            borderRadius: 16,
            padding: 16,
            marginBottom: 16,
            borderWidth: 1,
            borderColor: aiText ? `${PURPLE}40` : BORDER,
          }}
        >
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  backgroundColor: `${PURPLE}20`,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name="wand-magic-sparkles" size={16} color={PURPLE} />
              </View>
              <View>
                <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '700' }}>
                  AI 深度解读
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10 }}>
                  产业链传导逻辑 · V16 交叉验证 · 风险提示
                </Text>
              </View>
            </View>
            <TouchableOpacity
              onPress={handleAIInterpretation}
              disabled={aiLoading}
              style={{
                backgroundColor: aiLoading ? CARD2 : `${PURPLE}20`,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: 8,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {aiLoading ? (
                <ActivityIndicator size="small" color={PURPLE} />
              ) : (
                <FontAwesome6 name="bolt" size={12} color={PURPLE} />
              )}
              <Text style={{ color: PURPLE, fontSize: 12, fontWeight: '600' }}>
                {aiLoading ? '解读中...' : aiText ? '重新解读' : '开始解读'}
              </Text>
            </TouchableOpacity>
          </View>

          {aiError ? (
            <Text style={{ color: RED, fontSize: 12 }}>{aiError}</Text>
          ) : aiText ? (
            <Text style={{ color: TEXT1, fontSize: 13, lineHeight: 21 }}>{aiText}</Text>
          ) : (
            <Text style={{ color: TEXT2, fontSize: 12, lineHeight: 18 }}>
              点击「开始解读」，AI 将基于当前传播链预警，输出产业链传导逻辑、置信度判断与 V16 信号交叉验证。
            </Text>
          )}
        </View>

        {/* Intraday Signals */}
        {intradaySignals.length > 0 && (
          <View
            style={{
              backgroundColor: CARD,
              borderRadius: 16,
              padding: 16,
              borderWidth: 1,
              borderColor: BORDER,
              marginBottom: 16,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <View
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  backgroundColor: `${ACCENT}20`,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name="bolt" size={16} color={ACCENT} />
              </View>
              <View>
                <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '700' }}>盘中异动信号</Text>
                <Text style={{ color: TEXT2, fontSize: 10 }}>30 分钟级别 · 收盘前提前预警</Text>
              </View>
            </View>
            {intradaySignals.map((sig) => (
              <View
                key={`${sig.variety}-${sig.datetime}`}
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  paddingVertical: 8,
                  borderTopWidth: 1,
                  borderTopColor: BORDER,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <FontAwesome6
                    name={sig.direction === 'up' ? 'arrow-trend-up' : 'arrow-trend-down'}
                    size={14}
                    color={sig.direction === 'up' ? RED : GREEN}
                  />
                  <Text style={{ color: TEXT1, fontSize: 13, fontWeight: '600' }}>
                    {sig.varietyName}
                  </Text>
                  <Text style={{ color: TEXT2, fontSize: 10 }}>{sig.datetime?.slice(5, 16)}</Text>
                </View>
                <Text
                  style={{
                    color: sig.direction === 'up' ? RED : GREEN,
                    fontSize: 13,
                    fontWeight: '700',
                  }}
                >
                  {sig.atrMult}×ATR
                </Text>
              </View>
            ))}
          </View>
        )}

        {/* Alerts List */}
        {loadError ? (
          <View
            style={{
              backgroundColor: CARD,
              borderRadius: 16,
              padding: 24,
              alignItems: 'center',
              borderWidth: 1,
              borderColor: BORDER,
            }}
          >
            <FontAwesome6 name="triangle-exclamation" size={48} color={ACCENT} />
            <Text style={{ color: TEXT1, fontSize: 14, marginTop: 12, textAlign: 'center' }}>
              {loadError}
            </Text>
          </View>
        ) : alerts.length === 0 ? (
          <View>
            <View
              style={{
                backgroundColor: CARD,
                borderRadius: 16,
                padding: 24,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: BORDER,
              }}
            >
              <FontAwesome6 name="bell-slash" size={48} color={TEXT2} />
              <Text style={{ color: TEXT2, fontSize: 14, marginTop: 12, textAlign: 'center' }}>
                当前无活跃传播链预警
              </Text>
              <Text style={{ color: TEXT2, fontSize: 11, marginTop: 4, textAlign: 'center' }}>
                以下冲击事件未通过 next1 确认或板块联动/季节性过滤
              </Text>
            </View>

            {leaderShocks.length > 0 && (
              <>
                <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '600', marginTop: 16, marginBottom: 12 }}>
                  检测到的冲击事件 ({leaderShocks.length})
                </Text>
                {leaderShocks.map((shock, idx) => (
                  <ShockCard key={`${shock.variety}-${shock.date}-${idx}`} shock={shock} />
                ))}
              </>
            )}
          </View>
        ) : (
          <>
            <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '600', marginBottom: 12 }}>
              活跃预警 ({alerts.length})
            </Text>
            {Object.entries(groupedByLeader).map(([leader, groupAlerts]) => (
              <LeaderGroupCard
                key={leader}
                leader={leader}
                leaderName={groupAlerts[0]?.leaderName || leader}
                alerts={groupAlerts}
              />
            ))}
          </>
        )}

        {/* Performance History */}
        {stats && stats.total > 0 && (
          <View
            style={{
              backgroundColor: CARD,
              borderRadius: 16,
              padding: 16,
              marginTop: 16,
              borderWidth: 1,
              borderColor: BORDER,
            }}
          >
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              }}
            >
              <Text style={{ color: TEXT1, fontSize: 14, fontWeight: '600' }}>
                历史绩效追踪
              </Text>
              <FontAwesome6 name="chart-line" size={14} color={ACCENT} />
            </View>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View
                style={{
                  flex: 1,
                  backgroundColor: CARD2,
                  borderRadius: 10,
                  padding: 12,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>
                  {stats.total}
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10, marginTop: 4 }}>总预警</Text>
              </View>
              <View
                style={{
                  flex: 1,
                  backgroundColor: CARD2,
                  borderRadius: 10,
                  padding: 12,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>
                  {stats.verified}
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10, marginTop: 4 }}>已验证</Text>
              </View>
              <View
                style={{
                  flex: 1,
                  backgroundColor: CARD2,
                  borderRadius: 10,
                  padding: 12,
                  alignItems: 'center',
                }}
              >
                <Text
                  style={{
                    color:
                      stats.hitRate !== null
                        ? stats.hitRate >= 60
                          ? GREEN
                          : YELLOW
                        : TEXT1,
                    fontSize: 20,
                    fontWeight: '700',
                  }}
                >
                  {stats.hitRate !== null
                    ? `${(stats.hitRate * 100).toFixed(0)}%`
                    : '—'}
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10, marginTop: 4 }}>命中率</Text>
              </View>
            </View>
            {stats.verified > 0 && (
              <Text style={{ color: TEXT2, fontSize: 10, marginTop: 8, textAlign: 'center' }}>
                已验证 {stats.verified} 条 · 命中 {stats.hit} 条 · 未命中 {stats.verified - stats.hit} 条
              </Text>
            )}
          </View>
        )}

        {/* Strategy Info */}
        <View
          style={{
            backgroundColor: CARD2,
            borderRadius: 12,
            padding: 12,
            marginTop: 16,
            borderWidth: 1,
            borderColor: BORDER,
          }}
        >
          <Text style={{ color: TEXT2, fontSize: 10, textAlign: 'center' }}>
            传播链预警 v2 · ATR冲击 + next1确认 · S6板块联动 · S7季节性 · 动态止损
          </Text>
          <Text style={{ color: TEXT2, fontSize: 10, textAlign: 'center', marginTop: 4 }}>
            55 对白名单 · 20 年日线回测 · 板块命中率 65%~92% · 按置信度排序
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}
