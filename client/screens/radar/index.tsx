/**
 * Brooks Radar 首页 - V16.2 信号驱动
 * 整合：市场概览 + 高质量信号 + 全部品种列表
 */

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Modal,
  TouchableWithoutFeedback,
  Pressable,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { FontAwesome6 } from '@expo/vector-icons';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { fetchMarketSummary, fetchMarketInsight, fetchRefreshScan, fetchTrades, type VarietyItem, type MarketSummary, type MarketInsight, type TradeRecord } from '@/utils/api';
import { fetchUnreadAlertCount } from '@/utils/monitorApi';
import { EquationPanel } from '@/components/radar/EquationPanel';
import PositionBoard from '@/components/radar/PositionBoard';
import ClosePositionSheet from '@/components/radar/ClosePositionSheet';
import PositionRegistrationSheet from '@/components/radar/PositionRegistrationSheet';

// ---------- 工具函数（顶层定义） ----------

// 价格格式化：按量级自适应小数位
function formatPrice(p: number): string {
  if (!p || p <= 0) return '--';
  if (p >= 1000) return p.toFixed(0);
  if (p >= 10) return p.toFixed(1);
  return p.toFixed(2);
}

// 时间格式化：ISO -> HH:MM（本地时区）
function formatTime(iso?: string): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear()
    && d.getMonth() === now.getMonth()
    && d.getDate() === now.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

// 涨跌幅颜色（国内习惯：红涨绿跌）
function changeColor(pct: number): string {
  if (pct > 0) return '#FF5252';
  if (pct < 0) return '#00E676';
  return '#8888A0';
}

// V17信号等级颜色
function gradeColor(grade: string): string {
  if (grade.startsWith('L4')) return '#FFD700';
  if (grade.startsWith('L3')) return '#00F0FF';
  if (grade.startsWith('L2')) return '#00FF88';
  if (grade.startsWith('L1')) return '#FFB800';
  return '#555570';
}

// 品种稳健性分级颜色（1000次回测三维度：A稳健底仓/B可用/C脆弱/D失效）
function varietyGradeColor(grade?: string): string {
  if (grade === 'A') return '#00F0FF';
  if (grade === 'B') return '#00FF88';
  if (grade === 'C') return '#FFB800';
  if (grade === 'D') return '#FF5252';
  return '#555570';
}

// 品种稳健性分级排序权重（A=0 最优，D=3 失效，未知放最后）
function varietyGradeRank(grade?: string): number {
  if (grade === 'A') return 0;
  if (grade === 'B') return 1;
  if (grade === 'C') return 2;
  if (grade === 'D') return 3;
  return 4;
}

// 百分比格式化（0~1 -> 百分比字符串）
function pctStr(v?: number): string {
  if (v === undefined || v === null || isNaN(v)) return '--';
  return `${(v * 100).toFixed(0)}%`;
}

// ---------- 子组件（顶层定义，防止引用不稳定） ----------

function SignalCard({ item, updateTime, onPress, onTrain, onEquation, onQuickOpen }: { item: VarietyItem; updateTime: string; onPress: () => void; onTrain: () => void; onEquation: () => void; onQuickOpen: () => void }) {
  const dirColor = item.ai_direction === 'LONG' ? '#00FF88' : item.ai_direction === 'SHORT' ? '#FF4444' : '#555570';
  const g4 = item.g4_count ?? 0;
  const pct = item.change_pct ?? 0;
  const grade = item.signal_grade || '';
  const variant = item.signal_variant || '';

  return (
    <TouchableOpacity style={styles.signalCard} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.signalHeader}>
        <View style={styles.signalLeft}>
          <Text style={styles.signalCode}>{item.code}</Text>
          <View style={styles.signalNameRow}>
            <Text style={styles.signalName}>{item.name}</Text>
            {item.grade ? (
              <View style={[styles.varietyGradeBadge, { backgroundColor: varietyGradeColor(item.grade) + '20' }]}>
                <Text style={[styles.varietyGradeText, { color: varietyGradeColor(item.grade) }]}>{item.grade}·{item.grade_label || ''}</Text>
              </View>
            ) : null}
          </View>
        </View>
        <View style={[styles.dirBadge, { backgroundColor: dirColor + '20' }]}>
          <Text style={[styles.dirText, { color: dirColor }]}>{item.ai_direction === 'LONG' ? '做多' : item.ai_direction === 'SHORT' ? '做空' : '观望'}</Text>
        </View>
        <View style={styles.g4Badge}>
          <Text style={styles.g4BadgeText}>{g4}/5</Text>
        </View>
        {grade ? (
          <View style={[styles.gradeBadge, { backgroundColor: gradeColor(grade) + '25' }]}>
            <Text style={[styles.gradeText, { color: gradeColor(grade) }]}>{grade}{variant ? ` ${variant}` : ''}</Text>
          </View>
        ) : null}
        <TouchableOpacity style={styles.quickOpenBtn} onPress={onQuickOpen} activeOpacity={0.6}>
          <FontAwesome6 name="plus" size={14} color="#00E5FF" />
        </TouchableOpacity>
      </View>
      <View style={styles.priceRow}>
        <Text style={styles.priceValue}>{formatPrice(item.close)}</Text>
        <Text style={[styles.priceChange, { color: changeColor(pct) }]}>
          {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
        </Text>
        <View style={styles.updateTimeBox}>
          <FontAwesome6 name="clock" size={9} color="#555570" />
          <Text style={styles.updateTimeText}>{updateTime}</Text>
        </View>
      </View>
      {item.one_liner ? (
        <Text style={styles.signalSummary} numberOfLines={2}>{item.one_liner}</Text>
      ) : null}
      {item.advice ? (
        <View style={styles.adviceBox}>
          <FontAwesome6 name="lightbulb" size={11} color="#C9A96E" style={{ marginTop: 2 }} />
          <Text style={styles.adviceText} numberOfLines={3}>{item.advice}</Text>
        </View>
      ) : null}
      {item.grade && (item.robust_pct !== undefined || item.crash_pct !== undefined || item.profitable_pct !== undefined) ? (
        <View style={styles.trustRow}>
          <FontAwesome6 name="shield-halved" size={10} color={varietyGradeColor(item.grade)} />
          <Text style={styles.trustText}>稳健率 {pctStr(item.robust_pct)} · 崩溃率 {pctStr(item.crash_pct)} · 盈利占比 {pctStr(item.profitable_pct)}</Text>
        </View>
      ) : null}
      <View style={styles.signalFooter}>
        {item.signals && item.signals.length > 0 && (
          <View style={styles.signalTags}>
            {item.signals.slice(0, 3).map((s, i) => (
              <View key={i} style={styles.tag}>
                <Text style={styles.tagText}>{s}</Text>
              </View>
            ))}
          </View>
        )}
        <View style={styles.signalActions}>
          <TouchableOpacity
            style={styles.equationBtn}
            onPress={(e) => { e.stopPropagation?.(); onEquation(); }}
            activeOpacity={0.7}
          >
            <FontAwesome6 name="calculator" size={10} color="#FFB800" />
            <Text style={styles.equationBtnText}>方程</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.trainBtn}
            onPress={(e) => { e.stopPropagation?.(); onTrain(); }}
            activeOpacity={0.7}
          >
            <FontAwesome6 name="graduation-cap" size={10} color="#00F0FF" />
            <Text style={styles.trainBtnText}>练习</Text>
          </TouchableOpacity>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function VarietyRow({ item, updateTime, onPress, onQuickOpen, onAiPress }: { item: VarietyItem; updateTime: string; onPress: () => void; onQuickOpen: () => void; onAiPress: () => void }) {
  const dirColor = item.ai_direction === 'LONG' ? '#00FF88' : item.ai_direction === 'SHORT' ? '#FF4444' : '#555570';
  const g4 = item.g4_count ?? 0;
  const isTradable = item.trade_worthiness === 'tradable';
  const pct = item.change_pct ?? 0;
  const grade = item.signal_grade || '';
  const variant = item.signal_variant || '';

  return (
    <TouchableOpacity style={styles.row} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.rowLeft}>
        <View style={[styles.dirDot, { backgroundColor: dirColor }]} />
        <View style={styles.rowInfo}>
          <View style={styles.rowTop}>
            <Text style={styles.rowCode}>{item.code}</Text>
            <Text style={styles.rowName}>{item.name}</Text>
            {item.tight_channel && (
              <View style={{ backgroundColor: '#FF980020', paddingHorizontal: 4, paddingVertical: 1, borderRadius: 4, marginLeft: 4 }}>
                <Text style={{ fontSize: 9, color: '#FF9800', fontWeight: '600' }}>紧通道</Text>
              </View>
            )}
          </View>
          <View style={styles.rowPriceLine}>
            <Text style={styles.rowPrice}>{formatPrice(item.close)}</Text>
            <Text style={[styles.rowPriceChange, { color: changeColor(pct) }]}>
              {pct > 0 ? '+' : ''}{pct.toFixed(2)}%
            </Text>
            <Text style={styles.rowUpdateTime}>{updateTime}</Text>
          </View>
          {item.advice ? (
            <Text style={styles.rowAdvice} numberOfLines={2}>{item.advice}</Text>
          ) : item.one_liner ? (
            <Text style={styles.rowSummary} numberOfLines={1}>{item.one_liner}</Text>
          ) : null}
        </View>
      </View>
      <View style={styles.rowRight}>
        <Text style={[styles.rowG4, { color: isTradable ? '#00F0FF' : '#555570' }]}>{g4}/5</Text>
        {grade ? (
          <View style={[styles.gradeBadgeSmall, { backgroundColor: gradeColor(grade) + '20' }]}>
            <Text style={[styles.gradeTextSmall, { color: gradeColor(grade) }]}>{grade}{variant ? ` ${variant}` : ''}</Text>
          </View>
        ) : null}
        {item.edge_grade && (
          <View style={[styles.edgeDot, item.edge_grade === 'A' && styles.edgeDotA]}>
            <Text style={[styles.edgeDotText, item.edge_grade === 'A' && styles.edgeDotTextA]}>{item.edge_grade}</Text>
          </View>
        )}
        <TouchableOpacity style={styles.aiBtn} onPress={onAiPress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <FontAwesome6 name="robot" size={13} color="#B388FF" />
        </TouchableOpacity>
        <TouchableOpacity style={styles.quickOpenBtn} onPress={onQuickOpen} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <FontAwesome6 name="plus" size={14} color="#00E5FF" />
        </TouchableOpacity>
      </View>
      <FontAwesome6 name="chevron-right" size={12} color="#333" />
    </TouchableOpacity>
  );
}

// ---------- 主组件 ----------

export default function RadarScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [results, setResults] = useState<VarietyItem[]>([]);
  const [marketInsight, setMarketInsight] = useState<MarketInsight | null>(null);
  const [equationItem, setEquationItem] = useState<VarietyItem | null>(null);
  const [scanTime, setScanTime] = useState('');
  const [filter, setFilter] = useState<'all' | 'tradable' | 'long' | 'short'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  // 持仓 & 开平仓面板状态
  const [openTrades, setOpenTrades] = useState<TradeRecord[]>([]);
  const [registerSheetVisible, setRegisterSheetVisible] = useState(false);
  const [registerSheetPreselected, setRegisterSheetPreselected] = useState<VarietyItem | null>(null);
  const [closeSheetVisible, setCloseSheetVisible] = useState(false);
  const [closeSheetTrade, setCloseSheetTrade] = useState<TradeRecord | null>(null);
  const [closeSheetPrice, setCloseSheetPrice] = useState<number | undefined>();
  const [positionBoardCollapsed, setPositionBoardCollapsed] = useState(false);
  const [alertUnread, setAlertUnread] = useState(0);
  const [menuVisible, setMenuVisible] = useState(false);

  const loadOpenTrades = useCallback(async () => {
    try {
      const result = await fetchTrades('open');
      setOpenTrades(result.trades);
    } catch (_) {}
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [{ summary: s, results: r, scanTime: t }, insight] = await Promise.all([
        fetchMarketSummary(),
        fetchMarketInsight().catch(() => null),
      ]);
      setSummary(s);
      setResults(r);
      setScanTime(t);
      setMarketInsight(insight);
    } catch (err) {
      console.error('加载数据失败:', err);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
      loadOpenTrades();
      // 提醒未读数轮询（30s）
      fetchUnreadAlertCount().then(setAlertUnread).catch(() => undefined);
      const unreadTimer = setInterval(() => {
        fetchUnreadAlertCount().then(setAlertUnread).catch(() => undefined);
      }, 30000);
      return () => clearInterval(unreadTimer);
    }, [loadData, loadOpenTrades])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await fetchRefreshScan(); // 强制刷新后端数据缓存
    } catch (e) {
      console.warn('刷新缓存失败，使用现有数据:', e);
    }
    await Promise.all([loadData(), loadOpenTrades()]);
    setRefreshing(false);
  }, [loadData, loadOpenTrades]);

  // 构建品种代码→扫描数据的映射（用于PositionBoard查现价）
  const tradableMap = useMemo(() => {
    const map: Record<string, VarietyItem> = {};
    results.forEach((r) => { map[r.code] = r; });
    return map;
  }, [results]);

  // 为 PositionBoard 提供 Map 格式的扫描数据
  const scanDataMap = useMemo(() => {
    const map = new Map<string, VarietyItem>();
    results.forEach((r) => { map.set(r.code, r); });
    return map;
  }, [results]);

  // 开仓/平仓成功后刷新持仓列表
  const handlePositionChange = useCallback(() => {
    loadOpenTrades();
  }, [loadOpenTrades]);

  // 满分信号（Gate4 = 5/5），仅展示后端判定为可交易的品种，优先 A/B 稳健级；没有满分则显示 4/5
  const topSignals = useMemo(() => {
    const tradableResults = results.filter(r => r.trade_worthiness === 'tradable');
    // 稳健性排序权重：A/B 优先于 C/D（1000次回测三维度分级）
    const gradeRank = (g?: string) => (g === 'A' ? 0 : g === 'B' ? 1 : g === 'C' ? 2 : 3);
    const perfect = tradableResults.filter(r => (r.g4_count ?? 0) >= 5);
    if (perfect.length > 0) {
      return perfect
        .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || (b.p_follow ?? 0) - (a.p_follow ?? 0))
        .slice(0, 5);
    }
    return tradableResults
      .filter(r => (r.g4_count ?? 0) >= 4)
      .sort((a, b) => gradeRank(a.grade) - gradeRank(b.grade) || (b.p_follow ?? 0) - (a.p_follow ?? 0))
      .slice(0, 5);
  }, [results]);

  // 品种列表（带搜索+过滤：可交易/做多/做空优先显示满分信号 Gate4=5/5，无满分时降级 4/5 次优）
  const filteredData = useMemo(() => {
    // 先按搜索词过滤
    const q = searchQuery.trim().toLowerCase();
    const searched = q
      ? results.filter((r) => r.code.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.spectrum || '').toLowerCase().includes(q))
      : results;
    // 先按品种稳健性分级（A→B→C→D），同级内再按信号强度 g4_count 降序
    const sorted = [...searched].sort(
      (a, b) => varietyGradeRank(a.grade) - varietyGradeRank(b.grade) || (b.g4_count ?? 0) - (a.g4_count ?? 0)
    );
    if (filter === 'all') return { list: sorted, degraded: false };

    // 非"全部"过滤时，仅保留后端判定为可交易的品种（tradable 终判）
    const tradableOnly = sorted.filter(r => r.trade_worthiness === 'tradable');
    const dirMatch = (r: VarietyItem) =>
      filter === 'long' ? r.ai_direction === 'LONG'
      : filter === 'short' ? r.ai_direction === 'SHORT'
      : true;

    const perfect = tradableOnly.filter(r => (r.g4_count ?? 0) >= 5 && dirMatch(r));
    if (perfect.length > 0) return { list: perfect, degraded: false };

    const fallback = tradableOnly.filter(r => (r.g4_count ?? 0) >= 4 && dirMatch(r));
    return { list: fallback, degraded: true };
  }, [results, filter, searchQuery]);
  const filteredResults = filteredData.list;

  if (loading) {
    return (
      <Screen>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#00F0FF" />
          <Text style={styles.loadingText}>V16.2 扫描中...</Text>
        </View>
      </Screen>
    );
  }

  const tradableCount = results.filter(r => r.trade_worthiness === 'tradable').length;
  const highQualityCount = results.filter(r => (r.g4_count ?? 0) >= 4 && r.trade_worthiness === 'tradable').length;
  const longCount = results.filter(r => r.ai_direction === 'LONG' && r.trade_worthiness === 'tradable').length;
  const shortCount = results.filter(r => r.ai_direction === 'SHORT' && r.trade_worthiness === 'tradable').length;
  const updateTime = formatTime(scanTime);

  return (
    <Screen>
      <ScrollView
        style={styles.container}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#00F0FF" />}
      >
        {/* 标题栏 */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>BROOKS RADAR</Text>
            <Text style={styles.subtitle}>V16.2 信号驱动 · 更新 {updateTime}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {/* 菜单按钮 */}
            <TouchableOpacity style={styles.journalBtn} onPress={() => setMenuVisible(true)}>
              <FontAwesome6 name="bars" size={16} color="#00F0FF" />
              <Text style={styles.journalBtnText}>菜单</Text>
            </TouchableOpacity>
            {/* 提醒按钮 */}
            <TouchableOpacity style={styles.journalBtn} onPress={() => router.push('/alerts')}>
              <View style={{ position: 'relative' }}>
                <FontAwesome6 name="bell" size={16} color="#FFD700" />
                {alertUnread > 0 && (
                  <View
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -8,
                      minWidth: 15,
                      height: 15,
                      borderRadius: 8,
                      backgroundColor: '#FF3B30',
                      alignItems: 'center',
                      justifyContent: 'center',
                      paddingHorizontal: 3,
                    }}
                  >
                    <Text style={{ color: '#FFF', fontSize: 9, fontWeight: '700' }}>
                      {alertUnread > 99 ? '99+' : alertUnread}
                    </Text>
                  </View>
                )}
              </View>
              <Text style={[styles.journalBtnText, { color: '#FFD700' }]}>提醒</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* 市场概览统计 */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{results.length}</Text>
            <Text style={styles.statLabel}>总品种</Text>
          </View>
          <View style={[styles.statCard, styles.statCardActive]}>
            <Text style={[styles.statValue, { color: '#00F0FF' }]}>{tradableCount}</Text>
            <Text style={styles.statLabel}>可交易</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: '#00FF88' }]}>{longCount}</Text>
            <Text style={styles.statLabel}>做多</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: '#FF4444' }]}>{shortCount}</Text>
            <Text style={styles.statLabel}>做空</Text>
          </View>
        </View>

        {/* Brooks 市场洞察（封面 AI 分析，规则引擎生成） */}
        {marketInsight && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <FontAwesome6 name="wand-magic-sparkles" size={14} color="#B388FF" />
              <Text style={styles.sectionTitle}>Brooks 市场洞察</Text>
              <Text style={styles.sectionCount}>{marketInsight.market_state}</Text>
            </View>
            <View style={styles.insightCard}>
              <Text style={styles.insightSummary}>{marketInsight.ai_summary}</Text>

              {marketInsight.recommendations.length > 0 && (
                <View style={styles.insightBlock}>
                  <Text style={[styles.insightBlockTitle, { color: '#00F0FF' }]}>重点推荐（A/B级稳健信号）</Text>
                  {marketInsight.recommendations.map(item => (
                    <TouchableOpacity key={item.code} style={styles.insightItem} activeOpacity={0.7}
                      onPress={() => router.push('/detail', { code: item.code })}>
                      <Text style={styles.insightItemCode}>{item.code}</Text>
                      <View style={styles.insightItemBody}>
                        <Text style={styles.insightItemTitle}>{item.title}</Text>
                        <Text style={styles.insightItemDetail}>{item.detail}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}

              {marketInsight.cautions.length > 0 && (
                <View style={styles.insightBlock}>
                  <Text style={[styles.insightBlockTitle, { color: '#FFB800' }]}>高分信号被过滤（谨慎）</Text>
                  {marketInsight.cautions.map(item => (
                    <TouchableOpacity key={item.code} style={styles.insightItem} activeOpacity={0.7}
                      onPress={() => router.push('/detail', { code: item.code })}>
                      <Text style={styles.insightItemCode}>{item.code}</Text>
                      <View style={styles.insightItemBody}>
                        <Text style={styles.insightItemTitle}>{item.title}</Text>
                        <Text style={styles.insightItemDetail}>{item.detail}</Text>
                      </View>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>
          </View>
        )}

        {/* 持仓看板 */}
        <PositionBoard
          scanData={scanDataMap}
          onClosePosition={(trade) => {
            const info = scanDataMap.get(trade.variety_code) || tradableMap[trade.variety_code];
            setCloseSheetTrade(trade);
            setCloseSheetVisible(true);
          }}
          onRegisterPosition={() => {
            setRegisterSheetPreselected(null);
            setRegisterSheetVisible(true);
          }}
        />

        {/* 满分信号 */}
        {topSignals.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <FontAwesome6 name="bolt" size={14} color="#FFD700" />
              <Text style={[styles.sectionTitle, { color: '#FFD700' }]}>满分信号</Text>
              <Text style={styles.sectionCount}>{topSignals.length}个</Text>
            </View>
            {topSignals.map(item => (
              <SignalCard
                key={item.code}
                item={item}
                updateTime={updateTime}
                onPress={() => router.push('/detail', { code: item.code })}
                onTrain={() => router.push('/training-levels')}
                onEquation={() => setEquationItem(item)}
                onQuickOpen={() => {
                  setRegisterSheetPreselected(item);
                  setRegisterSheetVisible(true);
                }}
              />
            ))}
          </View>
        )}

        {/* 品种列表 */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <FontAwesome6 name="layer-group" size={14} color="#00F0FF" />
            <Text style={styles.sectionTitle}>全部品种</Text>
            <Text style={styles.sectionCount}>{filteredResults.length}个</Text>
          </View>

          {/* 搜索框 */}
          <View style={styles.searchBox}>
            <FontAwesome6 name="magnifying-glass" size={13} color="#555570" style={{ marginRight: 8 }} />
            <TextInput
              style={styles.searchInput}
              placeholder="搜索品种代码/名称..."
              placeholderTextColor="#444460"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
            {searchQuery.length > 0 && (
              <TouchableOpacity onPress={() => setSearchQuery('')} activeOpacity={0.6}>
                <FontAwesome6 name="xmark" size={13} color="#555570" />
              </TouchableOpacity>
            )}
          </View>

          {/* 过滤器 */}
          <View style={styles.filterRow}>
            {([
              { key: 'all', label: '全部' },
              { key: 'tradable', label: '可交易' },
              { key: 'long', label: '做多' },
              { key: 'short', label: '做空' },
            ] as const).map(f => (
              <TouchableOpacity
                key={f.key}
                style={[styles.filterBtn, filter === f.key && styles.filterBtnActive]}
                onPress={() => setFilter(f.key)}
              >
                <Text style={[styles.filterText, filter === f.key && styles.filterTextActive]}>{f.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* 降级提示：无满分信号时显示 4/5 次优 */}
          {filter !== 'all' && filteredData.degraded && filteredResults.length > 0 && (
            <View style={styles.degradedTip}>
              <FontAwesome6 name="circle-info" size={11} color="#FFB800" />
              <Text style={styles.degradedTipText}>
                今日无满分{filter === 'long' ? '做多' : filter === 'short' ? '做空' : ''}信号，以下为 4/5 次优信号
              </Text>
            </View>
          )}

          {/* 列表 */}
          <View style={styles.listContainer}>
            {filteredResults.map(item => (
              <VarietyRow
                key={item.code}
                item={item}
                updateTime={updateTime}
                onPress={() => router.push('/detail', { code: item.code })}
                onQuickOpen={() => {
                  setRegisterSheetPreselected(item);
                  setRegisterSheetVisible(true);
                }}
                onAiPress={() => router.push('/ai-expert', { code: item.code })}
              />
            ))}
            {filteredResults.length === 0 && (
              <View style={styles.emptyState}>
                <FontAwesome6 name="inbox" size={32} color="#333" />
                <Text style={styles.emptyText}>
                  {filter === 'all' ? '无匹配品种' : `今日无 4/5 以上${filter === 'long' ? '做多' : filter === 'short' ? '做空' : ''}信号`}
                </Text>
              </View>
            )}
          </View>
        </View>

        {/* 底部空间 */}
        <View style={{ height: 40 }} />
      </ScrollView>

      {/* 交易者方程面板 */}
      <EquationPanel
        visible={equationItem !== null}
        item={equationItem}
        onClose={() => setEquationItem(null)}
      />

      {/* 统一持仓登记面板（品种选择 → 分析 → 登记） */}
      <PositionRegistrationSheet
        visible={registerSheetVisible}
        allVarieties={results}
        preselected={registerSheetPreselected}
        onClose={() => { setRegisterSheetVisible(false); setRegisterSheetPreselected(null); }}
        onSuccess={() => {
          setRegisterSheetVisible(false);
          setRegisterSheetPreselected(null);
          loadOpenTrades();
        }}
      />

      {/* 快捷平仓面板 */}
      <ClosePositionSheet
        visible={closeSheetVisible}
        trade={closeSheetTrade}
        currentPrice={closeSheetTrade ? (tradableMap[closeSheetTrade.variety_code]?.close ?? 0) : 0}
        onClose={() => setCloseSheetVisible(false)}
        onSuccess={() => {
          setCloseSheetVisible(false);
          loadOpenTrades();
        }}
      />

      {/* 导航下拉菜单 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <Pressable style={styles.menuOverlay} onPress={() => setMenuVisible(false)}>
          <Pressable style={styles.menuContainer} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.menuTitle}>功能导航</Text>
            <ScrollView style={styles.menuScroll} showsVerticalScrollIndicator={false}>
              <Text style={styles.menuGroupTitle}>交易管理</Text>
              <View style={styles.menuGrid}>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/signal-journal'); }}>
                  <FontAwesome6 name="calendar-day" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>日报</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/sim-trading-hub'); }}>
                  <FontAwesome6 name="chart-line" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>模拟交易</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/trade-record-hub'); }}>
                  <FontAwesome6 name="book" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>交易记录</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/trading-calendar'); }}>
                  <FontAwesome6 name="calendar" size={22} color="#34d399" />
                  <Text style={styles.menuItemText}>交易日历</Text>
                </Pressable>

              </View>

              <Text style={styles.menuGroupTitle}>决策情报</Text>
              <View style={styles.menuGrid}>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/advice'); }}>
                  <FontAwesome6 name="star" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>建议</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/ai-expert'); }}>
                  <FontAwesome6 name="robot" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>AI 专家</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/news-monitor'); }}>
                  <FontAwesome6 name="newspaper" size={22} color="#3b82f6" />
                  <Text style={styles.menuItemText}>新闻监控</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/propagation-alerts'); }}>
                  <FontAwesome6 name="link" size={22} color="#BF00FF" />
                  <Text style={styles.menuItemText}>传播链</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/training-home'); }}>
                  <FontAwesome6 name="gamepad" size={22} color="#00F0FF" />
                  <Text style={styles.menuItemText}>训练</Text>
                </Pressable>
              </View>

              <Text style={styles.menuGroupTitle}>分析工具</Text>
              <View style={styles.menuGrid}>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/portfolio-hub'); }}>
                  <FontAwesome6 name="left-right" size={22} color="#34d399" />
                  <Text style={styles.menuItemText}>品种对比</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/combo-hub'); }}>
                  <FontAwesome6 name="chart-pie" size={22} color="#10B981" />
                  <Text style={styles.menuItemText}>组合分析</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/strategy-hub'); }}>
                  <FontAwesome6 name="wand-magic-sparkles" size={22} color="#f472b6" />
                  <Text style={styles.menuItemText}>策略优化</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/risk-hub'); }}>
                  <FontAwesome6 name="shield-halved" size={22} color="#ef4444" />
                  <Text style={styles.menuItemText}>风控中心</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/performance-report'); }}>
                  <FontAwesome6 name="chart-bar" size={22} color="#10B981" />
                  <Text style={styles.menuItemText}>绩效报告</Text>
                </Pressable>
                <Pressable style={styles.menuItem} onPress={() => { setMenuVisible(false); router.push('/variety-expansion'); }}>
                  <FontAwesome6 name="plus" size={22} color="#34d399" />
                  <Text style={styles.menuItemText}>品种扩展</Text>
                </Pressable>
              </View>
            </ScrollView>
            <Pressable style={styles.menuCloseButton} onPress={() => setMenuVisible(false)}>
              <Text style={styles.menuCloseText}>关闭</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

// ---------- 样式 ----------

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#555570',
    marginTop: 12,
    fontSize: 14,
  },

  // 标题栏
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 2,
  },
  subtitle: {
    fontSize: 11,
    color: '#555570',
    marginTop: 2,
    letterSpacing: 1,
  },
  journalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,240,255,0.1)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    gap: 6,
  },
  journalBtnText: {
    color: '#00F0FF',
    fontSize: 13,
    fontWeight: '600',
  },

  // 统计卡片
  statsRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 10,
    marginBottom: 16,
  },
  statCard: {
    flex: 1,
    backgroundColor: '#12121A',
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  statCardActive: {
    borderColor: 'rgba(0,240,255,0.3)',
    backgroundColor: 'rgba(0,240,255,0.05)',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  statLabel: {
    fontSize: 10,
    color: '#555570',
    marginTop: 4,
    letterSpacing: 0.5,
  },

  // 区块
  section: {
    marginBottom: 20,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    marginBottom: 12,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  sectionCount: {
    fontSize: 12,
    color: '#555570',
    marginLeft: 'auto',
  },

  // Brooks 市场洞察卡片
  insightCard: {
    marginHorizontal: 20,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#3D3D5C',
    backgroundColor: '#151528',
    padding: 16,
    gap: 14,
  },
  insightSummary: {
    fontSize: 13,
    lineHeight: 20,
    color: '#C0C0D8',
  },
  insightBlock: {
    borderTopWidth: 1,
    borderTopColor: '#26263E',
    paddingTop: 12,
    gap: 8,
  },
  insightBlockTitle: {
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  insightItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    borderRadius: 10,
    backgroundColor: '#1C1C33',
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  insightItemCode: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
    width: 44,
  },
  insightItemBody: {
    flex: 1,
    gap: 2,
  },
  insightItemTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#E8E8F5',
  },
  insightItemDetail: {
    fontSize: 11,
    lineHeight: 16,
    color: '#8888A0',
  },

  // 信号卡片（竖排全宽）
  signalList: {
    paddingHorizontal: 20,
    gap: 8,
  },
  signalCard: {
    backgroundColor: '#12121A',
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  signalCardHigh: {
    borderColor: 'rgba(0,240,255,0.25)',
    backgroundColor: 'rgba(0,240,255,0.04)',
  },
  signalTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  signalLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  signalCode: {
    fontSize: 16,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  signalName: {
    fontSize: 12,
    color: '#888',
  },
  signalNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  signalBadges: {
    flexDirection: 'row',
    gap: 6,
  },
  dirBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
  },
  dirText: {
    fontSize: 10,
    fontWeight: '700',
  },
  g4Badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: 'rgba(255,215,0,0.1)',
  },
  g4Text: {
    fontSize: 10,
    fontWeight: '700',
    color: '#FFD700',
  },
  quickOpenBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,229,255,0.12)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  aiBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(179,136,255,0.14)',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  quickOpenBtnText: {
    fontSize: 20,
    color: '#00E5FF',
    lineHeight: 22,
    fontWeight: '600',
  },
  positionBoardHeader: {
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
    alignItems: 'center' as const,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  positionBoardTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E8E8ED',
  },
  signalLiner: {
    fontSize: 12,
    color: '#AAA',
    lineHeight: 18,
  },
  signalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 8,
  },
  g4BadgeText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#FFD700",
  },
  signalSummary: {
    fontSize: 12,
    color: "#AAA",
    lineHeight: 18,
    marginBottom: 8,
  },
  // 价格行（SignalCard）
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  priceValue: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  priceChange: {
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  updateTimeBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    marginLeft: 'auto',
  },
  updateTimeText: {
    fontSize: 10,
    color: '#555570',
  },
  // 价格行（VarietyRow）
  rowPriceLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  rowPrice: {
    fontSize: 14,
    fontWeight: '700',
    color: '#E0E0F0',
    fontVariant: ['tabular-nums'],
  },
  rowPriceChange: {
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  rowUpdateTime: {
    fontSize: 10,
    color: '#555570',
    marginLeft: 'auto',
  },
  signalTags: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  tag: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  tagText: {
    fontSize: 10,
    color: "#888",
  },
  signalFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  trainBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(0,240,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(0,240,255,0.2)',
  },
  trainBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#00F0FF',
  },
  signalActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  equationBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: 'rgba(255,184,0,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,184,0,0.2)',
  },
  equationBtnText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#FFB800',
  },

  // 过滤器
  filterRow: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 12,
  },
  filterBtn: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 6,
    backgroundColor: '#12121A',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.05)',
  },
  filterBtnActive: {
    backgroundColor: 'rgba(0,240,255,0.1)',
    borderColor: 'rgba(0,240,255,0.3)',
  },
  filterText: {
    fontSize: 12,
    color: '#555570',
    fontWeight: '500',
  },
  filterTextActive: {
    color: '#00F0FF',
  },
  // 降级提示条
  degradedTip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 20,
    marginBottom: 10,
    backgroundColor: 'rgba(255,184,0,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,184,0,0.25)',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  degradedTipText: {
    fontSize: 11,
    color: '#FFB800',
    flex: 1,
  },

  // 品种列表行
  listContainer: {
    paddingHorizontal: 20,
  },
  row: {
    backgroundColor: '#12121A',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.03)',
  },
  rowMain: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    gap: 10,
  },
  rowLiner: {
    fontSize: 11,
    color: '#777',
    marginTop: 6,
    lineHeight: 16,
  },
  rowInfo: {
    flex: 1,
  },
  rowTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  rowSummary: {
    fontSize: 11,
    color: '#777',
    marginTop: 3,
  },
  rowAdvice: {
    fontSize: 11,
    color: '#C9A96E',
    marginTop: 3,
    lineHeight: 15,
  },
  adviceBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    marginTop: 8,
    backgroundColor: '#C9A96E12',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#C9A96E',
  },
  adviceText: {
    flex: 1,
    fontSize: 12,
    color: '#D8BC82',
    lineHeight: 17,
  },
  dirDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  rowCode: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  rowName: {
    fontSize: 11,
    color: '#555570',
    marginTop: 1,
  },
  rowCenter: {
    width: 50,
    alignItems: 'center',
  },
  rowSpectrum: {
    fontSize: 11,
    color: '#888',
  },
  rowRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 8,
  },
  rowG4: {
    fontSize: 14,
    fontWeight: '700',
  },
  edgeDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.05)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  edgeDotA: {
    backgroundColor: 'rgba(0,255,136,0.15)',
  },
  edgeDotText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#555570',
  },
  edgeDotTextA: {
    color: '#00FF88',
  },

  // 空状态
  emptyState: {
    alignItems: 'center',
    paddingVertical: 40,
  },
  emptyText: {
    color: '#555570',
    marginTop: 8,
    fontSize: 13,
  },

  // 搜索框
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#12121A',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: '#C8C8D8',
    padding: 0,
  },

  // V17 信号等级徽章
  gradeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 4,
  },
  gradeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  varietyGradeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    marginLeft: 6,
  },
  varietyGradeText: {
    fontSize: 10,
    fontWeight: '800',
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    gap: 8,
  },
  trustText: {
    fontSize: 10,
    color: '#9A9AB0',
  },
  gradeBadgeSmall: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 4,
    marginLeft: 2,
  },
  gradeTextSmall: {
    fontSize: 9,
    fontWeight: '700',
  },

  // 菜单 Modal
  menuOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  menuContainer: {
    width: '85%',
    maxHeight: '85%',
    backgroundColor: '#1A1A2E',
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: '#2A2A3E',
  },
  menuTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#E8E8F0',
    marginBottom: 16,
    textAlign: 'center',
  },
  menuScroll: {
    maxHeight: 480,
  },
  menuGroupTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#00F0FF',
    marginBottom: 10,
    marginTop: 4,
    letterSpacing: 1,
  },
  menuGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  menuItem: {
    width: '48%',
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#12121A',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  menuItemIcon: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  menuItemText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#E8E8F0',
  },
  menuCloseButton: {
    marginTop: 8,
    paddingVertical: 12,
    backgroundColor: '#12121A',
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  menuCloseText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#8888A0',
  },
});
