/**
 * 交易提醒中心页
 * 展示监控引擎生成的交易机会 / 持仓止损 / 信号变化等提醒
 * 数据来源：GET /api/v1/monitor/alerts
 */
import React, { useCallback, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  MonitorAlertItem,
  fetchMonitorAlerts,
  fetchUnreadAlertCount,
  markAlertRead,
  markAllAlertsRead,
  triggerMonitorScan,
  fetchScanStatus,
  clearMonitorAlerts,
  fetchVarietyQualityScores,
  VarietyQuality,
} from '@/utils/monitorApi';
import { fetchVarietyDetail, ScanDetail } from '@/utils/api';

const BG = '#0A0A0F';
const CARD = '#16161F';
const CARD2 = '#1D1D28';
const BORDER = 'rgba(255,255,255,0.08)';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#8A8A93';
const ACCENT = '#00F0FF';
const GREEN = '#00C853';
const RED = '#FF3B30';
const ORANGE = '#FF9500';
const PURPLE = '#BF00FF';
const YELLOW = '#FFD60A';

const TYPE_META: Record<string, { label: string; color: string; icon: string }> = {
  opportunity: { label: '交易机会', color: GREEN, icon: 'bullseye' },
  signal_change: { label: '信号变化', color: ORANGE, icon: 'arrows-left-right' },
  position_stop: { label: '止损提醒', color: RED, icon: 'triangle-exclamation' },
  position_target: { label: '目标提醒', color: ACCENT, icon: 'flag-checkered' },
  position_reverse: { label: '信号反转', color: PURPLE, icon: 'rotate' },
  position_trend: { label: '逆势警告', color: YELLOW, icon: 'wind' },
  position_timeout: { label: '时间止损', color: TEXT2, icon: 'clock' },
  news_black_swan: { label: '黑天鹅事件', color: RED, icon: 'bolt' },
};

interface BlackSwanDetail {
  eventId?: string;
  category?: string;
  direction?: string;
  aiDirection?: string;
  consensus?: string;
  confidence?: number;
  affectedVarieties?: string[];
  date?: string;
  aiInterpretation?: string;
  matchedNews?: Array<{
    title: string;
    source: string;
    snippet?: string;
    url?: string;
    publishTime?: string;
  }>;
  // 稳健性字段（机会/信号变化/持仓提醒均有）
  robustPct?: number;
  validationStatus?: string;
  sampleReliability?: 'high' | 'medium' | 'low';
  // 机会/信号变化详情字段
  close?: number;
  p_follow?: number;
  signal_grade?: string;
  gate4?: number;
  edge_grade?: string;
  win_rate_20?: number;
  avg_rr?: number;
  ch_entry?: number;
  ch_stop?: number;
  mm_tier1?: number;
  mm_tier2?: number;
  position_multiplier?: number;
  spectrum?: string;
  trend_momentum?: number;
  mtf_resonance?: string;
  tight_channel?: boolean;
  // 持仓详情字段
  entry?: number;
  target?: number;
  stop_loss?: number;
  days?: number;
  entry_time?: string;
}

/** 稳健性标签配置（颜色 + 文案） */
const ROBUST_COLORS: Record<string, { bg: string; text: string; label: string }> = {
  iron_clad: { bg: '#00C85333', text: '#00C853', label: '铁底验证' },
  robust: { bg: '#00C85333', text: '#00C853', label: '稳健验证' },
  sensitive: { bg: '#FFD60A33', text: '#FFD60A', label: '敏感·降仓' },
  overfit: { bg: '#FF3B3033', text: '#FF3B30', label: '过拟合' },
  untested: { bg: '#8A8A9333', text: '#8A8A93', label: '未通过P1验证' },
};

/** 根据 robustPct + sampleReliability 判断稳健性等级 */
function getRobustnessLevel(pct?: number, reliability?: 'high' | 'medium' | 'low'): string {
  if (pct == null) return 'untested';
  if (reliability === 'low') return 'sensitive'; // 样本不足降级
  if (pct >= 40) return 'iron_clad';
  if (pct >= 20) return 'robust';
  if (pct >= 10) return 'sensitive';
  return 'overfit';
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = (now.getTime() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
    return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** 格式化自动扫描状态文案 */
function formatLastScan(ts: number | null): string {
  if (!ts) return '自动扫描中';
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return '刚刚自动扫描';
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前自动扫描`;
  return `${Math.floor(diff / 3600)}小时前自动扫描`;
}

function parseDetail(detail?: string): BlackSwanDetail | null {
  if (!detail) return null;
  try {
    return JSON.parse(detail) as BlackSwanDetail;
  } catch {
    return null;
  }
}

// 机会/信号变化/持仓提醒详情弹窗
function OpportunityDetailModal({
  visible,
  item,
  qualityScores,
  onClose,
}: {
  visible: boolean;
  item: MonitorAlertItem | null;
  qualityScores: VarietyQuality[];
  onClose: () => void;
}) {
  const router = useSafeRouter();

  if (!item) return null;
  const detail = parseDetail(item.detail);
  const meta = TYPE_META[item.alert_type] || { label: '提醒', color: TEXT2, icon: 'bell' };
  const dir = detail?.direction;
  const dirColor = dir === 'long' || dir === 'LONG' || dir === '多' ? GREEN : dir === 'short' || dir === 'SHORT' || dir === '空' ? RED : TEXT2;

  // 稳健性等级
  const robustLevel = getRobustnessLevel(detail?.robustPct, detail?.sampleReliability);
  const robustCfg = ROBUST_COLORS[robustLevel];

  // 综合质量分
  const varietyQuality = qualityScores.find((q) => q.code === item?.code);
  const compositeScore = varietyQuality?.compositeScore;
  const compositeColor = compositeScore != null
    ? compositeScore >= 70 ? GREEN : compositeScore >= 50 ? YELLOW : RED
    : TEXT2;

  // 方向映射
  const dirMap: Record<string, string> = { long: '做多', LONG: '做多', 多: '做多', short: '做空', SHORT: '做空', 空: '做空', neutral: '观望', NEUTRAL: '观望' };
  const dirLabel = dirMap[dir || ''] || '观望';

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: BG,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '85%',
            borderWidth: 1,
            borderColor: BORDER,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: BORDER,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: meta.color + '22',
                marginRight: 12,
              }}
            >
              <FontAwesome6 name={meta.icon} size={16} color={meta.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: TEXT1 }} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={{ fontSize: 12, color: TEXT2, marginTop: 2 }}>
                {meta.label} · {formatTime(item.created_at)}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
              <FontAwesome6 name="xmark" size={18} color={TEXT2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: '80%' }} contentContainerStyle={{ padding: 16 }}>
            {/* 方向 + 信号等级 */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              {dir && (
                <View style={{ paddingHorizontal: 12, paddingVertical: 5, borderRadius: 10, backgroundColor: dirColor + '22' }}>
                  <Text style={{ fontSize: 14, fontWeight: '700', color: dirColor }}>
                    {dirLabel}
                  </Text>
                </View>
              )}
              {detail?.signal_grade && (
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: CARD2 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1 }}>
                    信号 {detail.signal_grade}
                  </Text>
                </View>
              )}
              {detail?.edge_grade && (
                <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, backgroundColor: CARD2 }}>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1 }}>
                    Edge {detail.edge_grade}
                  </Text>
                </View>
              )}
            </View>

            {/* 稳健性标签 */}
            {detail?.robustPct != null && (
              <View
                style={{
                  marginBottom: 16,
                  backgroundColor: CARD,
                  borderRadius: 12,
                  padding: 14,
                  borderWidth: 1,
                  borderColor: robustCfg.bg,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                  <FontAwesome6 name="chart-line" size={14} color={robustCfg.text} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: robustCfg.text, marginLeft: 6 }}>
                    回测稳健性评估
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', marginBottom: 8 }}>
                  <Text style={{ fontSize: 28, fontWeight: '800', color: robustCfg.text }}>
                    {detail.robustPct.toFixed(1)}%
                  </Text>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: robustCfg.bg }}>
                    <Text style={{ fontSize: 11, fontWeight: '600', color: robustCfg.text }}>
                      {robustCfg.label}
                    </Text>
                  </View>
                  {detail.sampleReliability === 'low' && (
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: '#FF3B3022' }}>
                      <Text style={{ fontSize: 10, color: RED }}>样本不足</Text>
                    </View>
                  )}
                  {detail.sampleReliability === 'medium' && (
                    <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: '#FFD60A22' }}>
                      <Text style={{ fontSize: 10, color: YELLOW }}>样本偏少</Text>
                    </View>
                  )}
                </View>
                {/* 综合质量分 */}
                {compositeScore != null && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <Text style={{ fontSize: 12, color: TEXT2, marginRight: 8 }}>综合质量分</Text>
                    <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: `${compositeColor}22` }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: compositeColor }}>
                        {compositeScore.toFixed(1)}
                        <Text style={{ fontSize: 11, fontWeight: '400' }}> /100</Text>
                      </Text>
                    </View>
                    <Text style={{ fontSize: 11, color: TEXT2, marginLeft: 6 }}>
                      含盈亏比/回撤/胜率
                    </Text>
                  </View>
                )}
                <Text style={{ fontSize: 12, color: TEXT2, lineHeight: 18 }}>
                  基于 1000 次拉丁超立方采样（LHS）蒙特卡洛回测，{detail.robustPct.toFixed(1)}% 的实验实现了盈利。
                  {detail.sampleReliability === 'low' && ' 但该品种历史交易仅 30 笔以内，样本不足，稳健性结论仅供参考。'}
                  {detail.sampleReliability === 'medium' && ' 该品种历史交易偏少，稳健性结论需谨慎参考。'}
                  {detail.sampleReliability === 'high' && ' 样本量充足，稳健性结论可信度高。'}
                </Text>
              </View>
            )}

            {/* 关键指标 */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 10 }}>
                关键指标
              </Text>
              <View style={{ backgroundColor: CARD, borderRadius: 12, padding: 14, gap: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: TEXT2 }}>P(顺)</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: detail?.p_follow && detail.p_follow >= 0.7 ? GREEN : detail?.p_follow && detail.p_follow >= 0.5 ? YELLOW : RED }}>
                    {detail?.p_follow?.toFixed(3) ?? '--'}
                  </Text>
                </View>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <Text style={{ fontSize: 13, color: TEXT2 }}>Gate4</Text>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: detail?.gate4 && detail.gate4 >= 4 ? GREEN : detail?.gate4 && detail.gate4 >= 3 ? YELLOW : RED }}>
                    {detail?.gate4 != null ? `${detail.gate4}/5` : '--'}
                  </Text>
                </View>
                {detail?.win_rate_20 != null && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: TEXT2 }}>近20笔胜率</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: detail.win_rate_20 >= 0.55 ? GREEN : detail.win_rate_20 >= 0.45 ? YELLOW : RED }}>
                      {(detail.win_rate_20 * 100).toFixed(0)}%
                    </Text>
                  </View>
                )}
                {detail?.avg_rr != null && (
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 13, color: TEXT2 }}>平均盈亏比</Text>
                    <Text style={{ fontSize: 13, fontWeight: '600', color: detail.avg_rr >= 1.5 ? GREEN : detail.avg_rr >= 1.0 ? YELLOW : RED }}>
                      {detail.avg_rr.toFixed(2)}
                    </Text>
                  </View>
                )}
              </View>
            </View>

            {/* 入场 / 止损 / 目标 */}
            {(detail?.ch_entry != null || detail?.ch_stop != null || detail?.mm_tier1 != null || detail?.close != null) && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 10 }}>
                  交易参考
                </Text>
                <View style={{ backgroundColor: CARD, borderRadius: 12, padding: 14, gap: 10 }}>
                  {detail?.close != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>现价</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1 }}>{detail.close}</Text>
                    </View>
                  )}
                  {detail?.ch_entry != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>入场参考</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: GREEN }}>{detail.ch_entry}</Text>
                    </View>
                  )}
                  {detail?.ch_stop != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>止损参考</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: RED }}>{detail.ch_stop}</Text>
                    </View>
                  )}
                  {detail?.mm_tier1 != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>第一目标</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: ACCENT }}>{detail.mm_tier1}</Text>
                    </View>
                  )}
                  {detail?.mm_tier2 != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>第二目标</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: ACCENT }}>{detail.mm_tier2}</Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* 持仓信息（如果有） */}
            {(detail?.entry != null || detail?.target != null || detail?.stop_loss != null || detail?.days != null) && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 10 }}>
                  持仓信息
                </Text>
                <View style={{ backgroundColor: CARD, borderRadius: 12, padding: 14, gap: 10 }}>
                  {detail?.entry != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>持仓成本</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1 }}>{detail.entry}</Text>
                    </View>
                  )}
                  {detail?.stop_loss != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>止损位</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: RED }}>{detail.stop_loss}</Text>
                    </View>
                  )}
                  {detail?.target != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>目标位</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: GREEN }}>{detail.target}</Text>
                    </View>
                  )}
                  {detail?.days != null && (
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text style={{ fontSize: 13, color: TEXT2 }}>持仓天数</Text>
                      <Text style={{ fontSize: 13, fontWeight: '600', color: detail.days >= 10 ? RED : YELLOW }}>{detail.days} 天</Text>
                    </View>
                  )}
                </View>
              </View>
            )}

            {/* 原始消息 */}
            <View style={{ marginBottom: 8 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 8 }}>
                扫描摘要
              </Text>
              <Text style={{ fontSize: 13, color: TEXT2, lineHeight: 20 }}>{item.message}</Text>
            </View>

            {/* 跳转详情页 */}
            {item.code && (
              <TouchableOpacity
                style={{
                  marginTop: 16,
                  backgroundColor: ACCENT + '18',
                  borderRadius: 12,
                  padding: 14,
                  alignItems: 'center',
                  borderWidth: 1,
                  borderColor: ACCENT + '33',
                }}
                onPress={() => {
                  onClose();
                  router.push('/detail', { code: item.code });
                }}
              >
                <Text style={{ fontSize: 14, fontWeight: '600', color: ACCENT }}>
                  查看 {item.code} 完整技术分析
                </Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

// 黑天鹅事件详情弹窗
function BlackSwanDetailModal({
  visible,
  item,
  onClose,
}: {
  visible: boolean;
  item: MonitorAlertItem | null;
  onClose: () => void;
}) {
  const router = useSafeRouter();
  const [varietyScans, setVarietyScans] = useState<Record<string, ScanDetail | null>>({});
  const [loadingScans, setLoadingScans] = useState(false);

  // 加载受影响品种的技术分析数据
  React.useEffect(() => {
    if (!visible || !item) return;
    const detail = parseDetail(item.detail);
    if (!detail?.affectedVarieties || detail.affectedVarieties.length === 0) return;

    const loadVarietyScans = async () => {
      if (!detail?.affectedVarieties || detail.affectedVarieties.length === 0) return;
      setLoadingScans(true);
      const results: Record<string, ScanDetail | null> = {};
      for (const code of detail.affectedVarieties) {
        try {
          const scanData = await fetchVarietyDetail(code);
          results[code] = scanData;
        } catch (e) {
          console.error(`[Alerts] Failed to fetch scan for ${code}:`, e);
          results[code] = null;
        }
      }
      setVarietyScans(results);
      setLoadingScans(false);
    };

    loadVarietyScans();
  }, [visible, item]);

  if (!item) return null;
  const detail = parseDetail(item.detail);
  const meta = TYPE_META[item.alert_type] || { label: '提醒', color: TEXT2, icon: 'bell' };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' }}>
        <View
          style={{
            backgroundColor: BG,
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
            maxHeight: '85%',
            borderWidth: 1,
            borderColor: BORDER,
          }}
        >
          {/* Header */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 14,
              borderBottomWidth: 1,
              borderBottomColor: BORDER,
            }}
          >
            <View
              style={{
                width: 36,
                height: 36,
                borderRadius: 10,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: meta.color + '22',
                marginRight: 12,
              }}
            >
              <FontAwesome6 name={meta.icon} size={16} color={meta.color} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: TEXT1 }} numberOfLines={2}>
                {item.title}
              </Text>
              <Text style={{ fontSize: 12, color: TEXT2, marginTop: 2 }}>
                {detail?.category} · {formatTime(item.created_at)}
              </Text>
            </View>
            <TouchableOpacity onPress={onClose} style={{ padding: 6 }}>
              <FontAwesome6 name="xmark" size={18} color={TEXT2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={{ maxHeight: '80%' }} contentContainerStyle={{ padding: 16 }}>
            {/* 事件概要 */}
            <View style={{ marginBottom: 16 }}>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {detail?.aiDirection && (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: 12,
                      backgroundColor: detail.aiDirection === '利多' ? GREEN + '22' : detail.aiDirection === '利空' ? RED + '22' : TEXT2 + '22',
                    }}
                  >
                    <Text
                      style={{
                        fontSize: 12,
                        fontWeight: '600',
                        color: detail.aiDirection === '利多' ? GREEN : detail.aiDirection === '利空' ? RED : TEXT2,
                      }}
                    >
                      AI 判断：{detail.aiDirection}
                    </Text>
                  </View>
                )}
                {detail?.confidence != null && (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: 12,
                      backgroundColor: CARD2,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: TEXT2 }}>
                      置信度：{Math.round(detail.confidence * 100)}%
                    </Text>
                  </View>
                )}
                {detail?.date && (
                  <View
                    style={{
                      paddingHorizontal: 10,
                      paddingVertical: 4,
                      borderRadius: 12,
                      backgroundColor: CARD2,
                    }}
                  >
                    <Text style={{ fontSize: 12, color: TEXT2 }}>事件日期：{detail.date}</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 13, color: TEXT2, lineHeight: 19 }}>{detail?.consensus}</Text>
            </View>

            {/* 影响品种 */}
            {detail?.affectedVarieties && detail.affectedVarieties.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 8 }}>
                  影响品种
                </Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {detail.affectedVarieties.map((v) => (
                    <TouchableOpacity
                      key={v}
                      style={{
                        paddingHorizontal: 10,
                        paddingVertical: 4,
                        borderRadius: 8,
                        backgroundColor: ACCENT + '18',
                        borderWidth: 1,
                        borderColor: ACCENT + '33',
                      }}
                      onPress={() => {
                        router.push('/detail', { code: v });
                      }}
                    >
                      <Text style={{ fontSize: 12, color: ACCENT }}>{v}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}

            {/* 品种对比分析 */}
            {detail?.affectedVarieties && detail.affectedVarieties.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                  <FontAwesome6 name="chart-line" size={14} color={ACCENT} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginLeft: 6 }}>
                    品种对比分析
                  </Text>
                  {loadingScans && (
                    <ActivityIndicator size="small" color={ACCENT} style={{ marginLeft: 8 }} />
                  )}
                </View>
                {detail.affectedVarieties.map((v) => {
                  const scan = varietyScans[v];
                  const techDirection = scan?.ai_direction;
                  const eventDirection = detail.aiDirection;
                  const isConsistent =
                    (eventDirection === '利多' && techDirection === 'LONG') ||
                    (eventDirection === '利空' && techDirection === 'SHORT') ||
                    (eventDirection === '中性' && techDirection === 'NEUTRAL');
                  const isContradictory =
                    (eventDirection === '利多' && techDirection === 'SHORT') ||
                    (eventDirection === '利空' && techDirection === 'LONG');

                  return (
                    <View
                      key={v}
                      style={{
                        marginBottom: 10,
                        backgroundColor: CARD,
                        borderRadius: 10,
                        padding: 12,
                        borderWidth: 1,
                        borderColor: BORDER,
                      }}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                        <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1 }}>{v}</Text>
                        {scan && (
                          <View
                            style={{
                              marginLeft: 8,
                              paddingHorizontal: 6,
                              paddingVertical: 2,
                              borderRadius: 6,
                              backgroundColor: scan.change_pct >= 0 ? RED + '22' : GREEN + '22',
                            }}
                          >
                            <Text
                              style={{
                                fontSize: 10,
                                color: scan.change_pct >= 0 ? RED : GREEN,
                              }}
                            >
                              {scan.change_pct >= 0 ? '+' : ''}{scan.change_pct.toFixed(2)}%
                            </Text>
                          </View>
                        )}
                      </View>
                      <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>事件方向</Text>
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color: eventDirection === '利多' ? GREEN : eventDirection === '利空' ? RED : TEXT2,
                            }}
                          >
                            {eventDirection || '未知'}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>技术方向</Text>
                          <Text
                            style={{
                              fontSize: 12,
                              fontWeight: '600',
                              color: techDirection === 'LONG' ? GREEN : techDirection === 'SHORT' ? RED : TEXT2,
                            }}
                          >
                            {techDirection === 'LONG' ? '多头' : techDirection === 'SHORT' ? '空头' : techDirection === 'NEUTRAL' ? '中性' : '加载中...'}
                          </Text>
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>一致性</Text>
                          {scan ? (
                            <Text
                              style={{
                                fontSize: 12,
                                fontWeight: '600',
                                color: isConsistent ? GREEN : isContradictory ? RED : TEXT2,
                              }}
                            >
                              {isConsistent ? '✓ 一致' : isContradictory ? '✗ 矛盾' : '? 观望'}
                            </Text>
                          ) : (
                            <Text style={{ fontSize: 12, color: TEXT2 }}>...</Text>
                          )}
                        </View>
                      </View>
                      {/* 频谱和趋势强度 */}
                      {scan && (
                        <View style={{ flexDirection: 'row', gap: 12 }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>频谱</Text>
                            <Text style={{ fontSize: 12, color: TEXT1 }}>{scan.spectrum}</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>趋势强度</Text>
                            <Text style={{ fontSize: 12, color: TEXT1 }}>{scan.trend_strength}/100</Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 2 }}>ADX</Text>
                            <Text style={{ fontSize: 12, color: TEXT1 }}>{scan.adx.toFixed(1)}</Text>
                          </View>
                        </View>
                      )}
                      {/* 价格与关键位 */}
                      {scan && (
                        <View style={{ marginTop: 12, backgroundColor: BG, borderRadius: 8, padding: 10 }}>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ fontSize: 11, color: TEXT2 }}>现价</Text>
                            <Text style={{ fontSize: 12, fontWeight: '600', color: TEXT1 }}>{scan.close ?? '--'}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ fontSize: 11, color: TEXT2 }}>支撑位</Text>
                            <Text style={{ fontSize: 12, color: GREEN }}>{scan.key_levels?.support ?? '--'}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ fontSize: 11, color: TEXT2 }}>压力位</Text>
                            <Text style={{ fontSize: 12, color: RED }}>{scan.key_levels?.resistance ?? '--'}</Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                            <Text style={{ fontSize: 11, color: TEXT2 }}>止损建议</Text>
                            <Text style={{ fontSize: 12, color: RED }}>
                              {scan.ch_stop ??
                                (techDirection === 'LONG'
                                  ? scan.key_levels?.support
                                  : techDirection === 'SHORT'
                                    ? scan.key_levels?.resistance
                                    : null) ??
                                '--'}
                            </Text>
                          </View>
                          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                            <Text style={{ fontSize: 11, color: TEXT2 }}>止盈建议</Text>
                            <Text style={{ fontSize: 12, color: GREEN }}>
                              {scan.ch_target ??
                                scan.mm_tier1 ??
                                (techDirection === 'LONG'
                                  ? scan.key_levels?.resistance
                                  : techDirection === 'SHORT'
                                    ? scan.key_levels?.support
                                    : null) ??
                                '--'}
                            </Text>
                          </View>
                        </View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}

            {/* AI 深度解读 */}
            {detail?.aiInterpretation ? (
              <View
                style={{
                  marginBottom: 16,
                  backgroundColor: CARD,
                  borderRadius: 12,
                  padding: 14,
                  borderWidth: 1,
                  borderColor: ACCENT + '22',
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                  <FontAwesome6 name="robot" size={14} color={ACCENT} />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: ACCENT, marginLeft: 6 }}>
                    AI 深度解读
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: TEXT1, lineHeight: 20 }}>
                  {detail.aiInterpretation}
                </Text>
              </View>
            ) : null}

            {/* 相关新闻 */}
            {detail?.matchedNews && detail.matchedNews.length > 0 && (
              <View style={{ marginBottom: 16 }}>
                <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 8 }}>
                  相关新闻
                </Text>
                {detail.matchedNews.map((news, idx) => (
                  <View
                    key={idx}
                    style={{
                      backgroundColor: CARD,
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 8,
                      borderWidth: 1,
                      borderColor: BORDER,
                    }}
                  >
                    <Text style={{ fontSize: 13, fontWeight: '500', color: TEXT1, lineHeight: 18 }} numberOfLines={3}>
                      {news.title}
                    </Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 6, gap: 8 }}>
                      <Text style={{ fontSize: 11, color: TEXT2 }}>{news.source}</Text>
                      {news.publishTime && (
                        <Text style={{ fontSize: 11, color: TEXT2 }}>· {news.publishTime}</Text>
                      )}
                    </View>
                    {news.snippet && (
                      <Text
                        style={{ fontSize: 12, color: TEXT2, lineHeight: 17, marginTop: 6 }}
                        numberOfLines={3}
                      >
                        {news.snippet}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            )}

            {/* 原始消息 */}
            <View style={{ marginBottom: 16 }}>
              <Text style={{ fontSize: 13, fontWeight: '600', color: TEXT1, marginBottom: 8 }}>
                提醒摘要
              </Text>
              <Text style={{ fontSize: 13, color: TEXT2, lineHeight: 19 }}>{item.message}</Text>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export default function AlertsScreen() {
  const router = useSafeRouter();
  const [alerts, setAlerts] = useState<MonitorAlertItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [detailItem, setDetailItem] = useState<MonitorAlertItem | null>(null);
  const [qualityScores, setQualityScores] = useState<VarietyQuality[]>([]);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoScanRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastAutoScanAtRef = useRef<number>(0);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await fetchMonitorAlerts({ limit: 100 });
      setAlerts(data.alerts);
      setUnreadCount(data.unreadCount);
    } catch {
      // 后端不可用时保持现状
    } finally {
      setLoading(false);
    }
  }, []);

  const loadUnreadOnly = useCallback(async () => {
    try {
      const data = await fetchMonitorAlerts({ unreadOnly: true, limit: 100 });
      setAlerts(data.alerts);
      setUnreadCount(data.unreadCount);
    } catch {
      // 后端不可用时保持现状
    } finally {
      setLoading(false);
    }
  }, []);

  // 静默自动扫描：进入页面与定时触发，替代手动点击
  const runAutoScan = useCallback(async () => {
    const now = Date.now();
    // 距上次自动扫描不足 3 分钟则跳过（后端定时任务 + 互斥锁兜底）
    if (now - lastAutoScanAtRef.current < 3 * 60 * 1000) return;
    lastAutoScanAtRef.current = now;

    setScanning(true);
    try {
      const result = await triggerMonitorScan();
      // 仅在真正执行了扫描（未被后端并发互斥跳过）时刷新列表
      if (!result.skipped) {
        if (filter === 'all') await loadAlerts();
        else await loadUnreadOnly();
      }
      const status = await fetchScanStatus();
      setLastScanAt(status.lastScanAt);
    } catch {
      // 自动扫描静默失败，不打扰用户
    } finally {
      setScanning(false);
    }
  }, [filter, loadAlerts, loadUnreadOnly]);

  useFocusEffect(
    useCallback(() => {
      // 首帧加载
      if (filter === 'all') loadAlerts();
      else loadUnreadOnly();

      // 拉取后端自动扫描状态（上次扫描时间）
      fetchScanStatus().then((s) => setLastScanAt(s.lastScanAt)).catch(() => undefined);

      // 拉取品种综合质量评分（一次性加载）
      if (qualityScores.length === 0) {
        fetchVarietyQualityScores().then(setQualityScores).catch(() => undefined);
      }

      // 进入页面自动触发一次扫描
      runAutoScan();

      // 30s 轮询刷新列表
      pollingRef.current = setInterval(() => {
        if (filter === 'all') loadAlerts();
        else loadUnreadOnly();
      }, 30000);

      // 每 5 分钟自动扫描一次
      autoScanRef.current = setInterval(() => {
        runAutoScan();
      }, 5 * 60 * 1000);

      return () => {
        if (pollingRef.current) clearInterval(pollingRef.current);
        if (autoScanRef.current) clearInterval(autoScanRef.current);
      };
    }, [filter, loadAlerts, loadUnreadOnly, runAutoScan])
  );

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    if (filter === 'all') await loadAlerts();
    else await loadUnreadOnly();
    setRefreshing(false);
  }, [filter, loadAlerts, loadUnreadOnly]);

  const handleScan = useCallback(async () => {
    setScanning(true);
    try {
      const result = await triggerMonitorScan();
      if (result.skipped) {
        Alert.alert('扫描进行中', '后台正在自动扫描，请稍后查看最新提醒');
      } else {
        if (filter === 'all') await loadAlerts();
        else await loadUnreadOnly();
        const newCount =
          (result.opportunities?.length || 0) +
          (result.positionAlerts?.length || 0) +
          (result.newsAlerts?.length || 0);
        Alert.alert(
          '扫描完成',
          newCount > 0
            ? `发现 ${result.opportunities?.length || 0} 个新机会，${result.positionAlerts?.length || 0} 条持仓提醒，${result.newsAlerts?.length || 0} 条新闻事件`
            : '当前无新交易机会，持仓无异常，无新闻事件'
        );
      }
      const status = await fetchScanStatus();
      setLastScanAt(status.lastScanAt);
    } catch (e) {
      Alert.alert('扫描失败', '请稍后重试');
    } finally {
      setScanning(false);
    }
  }, [filter, loadAlerts, loadUnreadOnly]);

  const handleOpen = useCallback(
    (item: MonitorAlertItem) => {
      if (!item.is_read) {
        markAlertRead(item.id).catch(() => undefined);
        setUnreadCount((c) => Math.max(0, c - 1));
        setAlerts((prev) => prev.map((a) => (a.id === item.id ? { ...a, is_read: 1 } : a)));
      }
      // 黑天鹅事件 / 机会 / 信号变化 / 持仓提醒显示详情弹窗
      if (item.alert_type === 'news_black_swan') {
        setDetailItem(item);
      } else if (item.alert_type === 'opportunity' || item.alert_type === 'signal_change' ||
        item.alert_type.startsWith('position_')) {
        setDetailItem(item);
      } else if (item.code) {
        router.push('/detail', { code: item.code });
      }
    },
    [router]
  );

  const handleReadAll = useCallback(() => {
    markAllAlertsRead().catch(() => undefined);
    setUnreadCount(0);
    setAlerts((prev) => prev.map((a) => ({ ...a, is_read: 1 })));
  }, []);

  const handleClearAll = useCallback(() => {
    Alert.alert('清空提醒', '确定清空所有提醒记录？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearMonitorAlerts();
            setAlerts([]);
            setUnreadCount(0);
          } catch {
            Alert.alert('操作失败', '请稍后重试');
          }
        },
      },
    ]);
  }, []);

  const handleFilter = useCallback(
    (f: 'all' | 'unread') => {
      setFilter(f);
    },
    []
  );

  const displayed = filter === 'all' ? alerts : alerts.filter((a) => !a.is_read);

  return (
    <Screen>
      <View style={{ flex: 1, backgroundColor: BG }}>
        {/* 头部 */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: BORDER,
          }}
        >
          <TouchableOpacity onPress={() => router.back()} style={{ width: 40, paddingVertical: 4 }}>
            <FontAwesome6 name="arrow-left" size={18} color={TEXT1} />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: 'bold', color: TEXT1 }}>
              交易提醒{unreadCount > 0 ? ` (${unreadCount})` : ''}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
              <FontAwesome6 name="rotate" size={10} color={ACCENT} />
              <Text style={{ fontSize: 11, color: TEXT2, marginLeft: 4 }}>
                {scanning ? '自动扫描中...' : formatLastScan(lastScanAt)}
              </Text>
            </View>
          </View>
          <TouchableOpacity onPress={handleScan} style={{ marginRight: 14, paddingVertical: 4 }} disabled={scanning}>
            {scanning ? (
              <ActivityIndicator size="small" color={ACCENT} />
            ) : (
              <FontAwesome6 name="satellite-dish" size={17} color={ACCENT} />
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={handleReadAll} style={{ marginRight: 14, paddingVertical: 4 }}>
            <FontAwesome6 name="check-double" size={18} color={TEXT2} />
          </TouchableOpacity>
          <TouchableOpacity onPress={handleClearAll} style={{ paddingVertical: 4 }}>
            <FontAwesome6 name="trash" size={16} color={TEXT2} />
          </TouchableOpacity>
        </View>

        {/* 筛选 */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 10, gap: 8 }}>
          {(['all', 'unread'] as const).map((f) => (
            <TouchableOpacity
              key={f}
              onPress={() => handleFilter(f)}
              style={{
                paddingHorizontal: 14,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: filter === f ? ACCENT : CARD2,
              }}
            >
              <Text style={{ fontSize: 13, fontWeight: '600', color: filter === f ? '#0A0A0F' : TEXT2 }}>
                {f === 'all' ? '全部' : `未读${unreadCount > 0 ? ` ${unreadCount}` : ''}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 列表 */}
        {loading ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={ACCENT} />
          </View>
        ) : displayed.length === 0 ? (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 }}>
            <FontAwesome6 name="bell-slash" size={40} color={TEXT2} />
            <Text style={{ marginTop: 12, fontSize: 14, color: TEXT2 }}>
              {filter === 'unread' ? '暂无未读提醒' : '暂无提醒，自动扫描进行中'}
            </Text>
          </View>
        ) : (
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 30 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={ACCENT} />}
          >
            {displayed.map((item) => {
              const meta = TYPE_META[item.alert_type] || { label: '提醒', color: TEXT2, icon: 'bell' };
              const detail = parseDetail(item.detail);
              const isBlackSwan = item.alert_type === 'news_black_swan';
              return (
                <TouchableOpacity
                  key={item.id}
                  onPress={() => handleOpen(item)}
                  style={{
                    backgroundColor: CARD,
                    borderRadius: 14,
                    padding: 14,
                    marginBottom: 10,
                    borderWidth: 1,
                    borderColor: item.is_read ? BORDER : meta.color,
                    borderLeftWidth: 4,
                    borderLeftColor: meta.color,
                    opacity: item.is_read ? 0.72 : 1,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                    <View
                      style={{
                        width: 30,
                        height: 30,
                        borderRadius: 8,
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: meta.color + '22',
                        marginRight: 10,
                      }}
                    >
                      <FontAwesome6 name={meta.icon} size={14} color={meta.color} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: TEXT1 }} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={{ fontSize: 11, color: TEXT2, marginTop: 2 }}>
                        {item.name || item.code} · {meta.label} · {formatTime(item.created_at)}
                      </Text>
                    </View>
                    {!item.is_read && (
                      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: meta.color }} />
                    )}
                  </View>
                  <Text style={{ fontSize: 13, color: TEXT2, lineHeight: 19 }}>{item.message}</Text>
                  {/* 稳健性标签：机会/信号变化/持仓提醒展示，样本不足追加警示 */}
                  {!isBlackSwan && detail?.robustPct != null && (
                    (() => {
                      const level = getRobustnessLevel(detail.robustPct, detail.sampleReliability);
                      const cfg = ROBUST_COLORS[level];
                      return (
                        <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 }}>
                          <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: cfg.bg }}>
                            <Text style={{ fontSize: 11, fontWeight: '600', color: cfg.text }}>
                              {cfg.label}
                            </Text>
                          </View>
                          <Text style={{ fontSize: 11, color: TEXT2 }}>
                            回测稳健性 {detail.robustPct.toFixed(1)}%
                          </Text>
                          {detail.sampleReliability === 'low' && (
                            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: '#FF3B3022' }}>
                              <Text style={{ fontSize: 10, color: RED }}>样本不足</Text>
                            </View>
                          )}
                          {detail.sampleReliability === 'medium' && (
                            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: '#FFD60A22' }}>
                              <Text style={{ fontSize: 10, color: YELLOW }}>样本偏少</Text>
                            </View>
                          )}
                        </View>
                      );
                    })()
                  )}
                  {/* 黑天鹅事件显示 AI 判断标签 */}
                  {isBlackSwan && detail?.aiDirection && (
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 8, gap: 6 }}>
                      <View
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 3,
                          borderRadius: 8,
                          backgroundColor:
                            detail.aiDirection === '利多'
                              ? GREEN + '22'
                              : detail.aiDirection === '利空'
                                ? RED + '22'
                                : TEXT2 + '22',
                        }}
                      >
                        <Text
                          style={{
                            fontSize: 11,
                            fontWeight: '600',
                            color:
                              detail.aiDirection === '利多'
                                ? GREEN
                                : detail.aiDirection === '利空'
                                  ? RED
                                  : TEXT2,
                          }}
                        >
                          AI: {detail.aiDirection}
                        </Text>
                      </View>
                      {detail.matchedNews && detail.matchedNews.length > 0 && (
                        <Text style={{ fontSize: 11, color: TEXT2 }}>
                          {detail.matchedNews.length} 条相关新闻
                        </Text>
                      )}
                    </View>
                  )}
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        )}

        {/* 机会/信号变化/持仓提醒详情弹窗 */}
        <OpportunityDetailModal
          visible={detailItem !== null && detailItem.alert_type !== 'news_black_swan'}
          item={detailItem}
          qualityScores={qualityScores}
          onClose={() => setDetailItem(null)}
        />

        {/* 黑天鹅事件详情弹窗 */}
        <BlackSwanDetailModal
          visible={detailItem !== null && detailItem.alert_type === 'news_black_swan'}
          item={detailItem}
          onClose={() => setDetailItem(null)}
        />
      </View>
    </Screen>
  );
}
