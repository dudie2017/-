/**
 * PositionRegistrationSheet — 两阶段持仓登记组件
 *
 * 阶段1：搜索/选择品种（代码+名称+价格+信号等级）
 * 阶段2：查看完整分析 + 登记表单（交易建议 + 交易者方程 + 仓位计算）
 */
import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal,
  TouchableWithoutFeedback, KeyboardAvoidingView, Platform,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { createTrade, fetchVarietyAdvice, type VarietyItem, type VarietyAdvice } from '@/utils/api';

interface PositionRegistrationSheetProps {
  visible: boolean;
  allVarieties: VarietyItem[];
  preselected?: VarietyItem | null;
  onClose: () => void;
  onSuccess: () => void;
}

// ---------- 颜色常量（暗黑科技风） ----------
const BG = '#0A0A0F';
const CARD = '#14141C';
const ACCENT = '#00F0FF';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#AAAAAA';
const TEXT3 = '#666680';
const UP = '#F43F5E';
const DOWN = '#10B981';
const WARN = '#F59E0B';
const GOLD = '#FFD700';

// 信号等级颜色
function gradeColor(g?: string): string {
  if (!g) return TEXT3;
  if (g.startsWith('L4')) return '#FFD700';
  if (g.startsWith('L3')) return '#00F0FF';
  if (g.startsWith('L2')) return '#10B981';
  if (g.startsWith('L1')) return '#F59E0B';
  return TEXT3;
}

function gradeBg(g?: string): string {
  return (gradeColor(g) || TEXT3) + '20';
}

export default function PositionRegistrationSheet({
  visible, allVarieties, preselected, onClose, onSuccess,
}: PositionRegistrationSheetProps) {
  // -- 阶段控制 --
  const [stage, setStage] = useState<'select' | 'analyze'>('select');
  const [selectedVariety, setSelectedVariety] = useState<VarietyItem | null>(null);

  // -- 搜索 --
  const [searchQuery, setSearchQuery] = useState('');

  // -- 表单 --
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [contract, setContract] = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [target, setTarget] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // -- AI 结构化建议（与品种分析页同一数据源） --
  const [advice, setAdvice] = useState<VarietyAdvice | null>(null);
  const [loadingAdvice, setLoadingAdvice] = useState(false);

  // -- 重置/初始化 --
  useEffect(() => {
    if (!visible) return;
    setStage('select');
    setSearchQuery('');
    setError('');
    setAdvice(null);
    setLoadingAdvice(false);

    if (preselected) {
      // 有预选品种 → 直接进入阶段2
      setSelectedVariety(preselected);
      setStage('analyze');
    } else {
      setSelectedVariety(null);
    }
  }, [visible, preselected]);

  // -- 品种选中时填充表单 + 拉取结构化建议 --
  useEffect(() => {
    if (!selectedVariety || stage !== 'analyze') return;
    const v = selectedVariety;
    const aiDir = v.ai_direction || '';
    const isLong = aiDir === 'LONG' || aiDir.startsWith('多');
    const isShort = aiDir === 'SHORT' || aiDir.startsWith('空');
    setDirection(isShort ? 'short' : 'long');
    setContract(v.code || '');
    setEntryPrice(v.close != null ? String(v.close) : '');
    const support = v.key_levels?.support;
    const resistance = v.key_levels?.resistance;
    if (isShort) {
      setStopLoss(resistance ? String(resistance) : '');
      setTarget(support ? String(support) : '');
    } else {
      setStopLoss(support ? String(support) : '');
      setTarget(resistance ? String(resistance) : '');
    }
    setQuantity('1');
    setError('');

    // 拉取结构化建议（ATR 自适应止损 + 1.5R 目标），与品种分析页逻辑一致
    let cancelled = false;
    setAdvice(null);
    setLoadingAdvice(true);
    fetchVarietyAdvice(v.code)
      .then((a) => {
        if (cancelled) return;
        setAdvice(a);
        if (a) {
          const d: 'long' | 'short' = a.direction === 'SHORT' ? 'short' : 'long';
          setDirection(d);
          setStopLoss(a.stopLoss != null ? String(a.stopLoss) : '');
          setTarget(a.target1 != null ? String(a.target1) : '');
        }
      })
      .catch(() => {
        // 拉取失败不阻塞登记，保留 key_levels 预填值
      })
      .finally(() => {
        if (!cancelled) setLoadingAdvice(false);
      });

    return () => { cancelled = true; };
  }, [selectedVariety, stage]);

  // -- 过滤品种列表 --
  const filteredVarieties = useMemo(() => {
    if (!searchQuery.trim()) {
      // 未搜索时：按g4_count降序排列
      return [...allVarieties].sort((a, b) => (b.g4_count ?? 0) - (a.g4_count ?? 0));
    }
    const q = searchQuery.trim().toLowerCase();
    return allVarieties
      .filter(v => v.code.toLowerCase().includes(q) || v.name.includes(q))
      .sort((a, b) => (b.g4_count ?? 0) - (a.g4_count ?? 0));
  }, [allVarieties, searchQuery]);

  // -- 选择品种 --
  const handleSelect = (v: VarietyItem) => {
    setSelectedVariety(v);
    setSearchQuery('');
    setStage('analyze');
  };

  // -- 方向切换 --
  const onDirectionToggle = (d: 'long' | 'short') => {
    setDirection(d);
    const support = selectedVariety?.key_levels?.support;
    const resistance = selectedVariety?.key_levels?.resistance;
    if (d === 'short') {
      setStopLoss(resistance ? String(resistance) : '');
      setTarget(support ? String(support) : '');
    } else {
      setStopLoss(support ? String(support) : '');
      setTarget(resistance ? String(resistance) : '');
    }
  };

  // -- 计算衍生值 --
  const ep = parseFloat(entryPrice) || 0;
  const sl = parseFloat(stopLoss) || 0;
  const tp = parseFloat(target) || 0;
  const riskPerUnit = Math.abs(ep - sl);
  const reward = Math.abs(tp - ep);
  const rr = riskPerUnit > 0 ? (reward / riskPerUnit).toFixed(1) : '-';
  const qty = parseInt(quantity, 10) || 1;
  const totalRisk = (riskPerUnit * qty * 10).toFixed(0);
  const sg = selectedVariety?.signal_grade || '';

  // -- 提交登记 --
  const handleSubmit = async () => {
    setError('');
    if (!contract.trim()) { setError('请输入合约代码'); return; }
    if (isNaN(ep) || ep <= 0) { setError('请输入有效入场价'); return; }
    if (qty <= 0) { setError('手数至少为1'); return; }

    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      await createTrade({
        variety_code: contract.trim(),
        variety_name: selectedVariety?.name || '',
        direction,
        open_price: ep,
        open_time: now,
        open_quantity: qty,
        open_reason: `Radar登记 — ${selectedVariety?.name || ''} ${sg}`,
        signal_grade: sg,
        ai_direction: selectedVariety?.ai_direction || '',
        support_level: selectedVariety?.key_levels?.support,
        resistance_level: selectedVariety?.key_levels?.resistance,
        ema20: selectedVariety?.key_levels?.ema20,
        stop_loss: sl || undefined,
        target_price: tp || undefined,
        gate4_count: selectedVariety?.g4_count ?? 0,
        edge_grade: selectedVariety?.edge_grade,
        notes: `止损: ${stopLoss || '未设'} | 目标: ${target || '未设'} | RR: ${rr}`,
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e?.message || '登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  // -- 价格格式化 --
  const fmt = (v: number | null | undefined) =>
    v == null ? '--' : v >= 100 ? v.toFixed(0) : v.toFixed(1);

  // ============== 阶段1：品种选择 ==============
  const renderSelectStage = () => (
    <>
      {/* 搜索框 */}
      <View style={{
        flexDirection: 'row', alignItems: 'center', backgroundColor: CARD,
        borderRadius: 12, paddingHorizontal: 14, height: 44, marginBottom: 12, gap: 10,
      }}>
        <FontAwesome6 name="magnifying-glass" size={14} color={TEXT3} />
        <TextInput
          style={{ flex: 1, color: TEXT1, fontSize: 15 }}
          placeholder="搜索品种代码或名称..."
          placeholderTextColor={TEXT3}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
        {searchQuery.length > 0 && (
          <TouchableOpacity onPress={() => setSearchQuery('')}>
            <FontAwesome6 name="xmark" size={14} color={TEXT3} />
          </TouchableOpacity>
        )}
      </View>
      <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 8 }}>
        共 {filteredVarieties.length} 个品种 · 按 Gate4 信号数排序
      </Text>
      {/* 品种列表 */}
      {filteredVarieties.length === 0 ? (
        <View style={{ alignItems: 'center', paddingVertical: 40 }}>
          <Text style={{ color: TEXT3, fontSize: 14 }}>无匹配品种</Text>
        </View>
      ) : (
        filteredVarieties.map(v => (
          <TouchableOpacity
            key={v.code}
            activeOpacity={0.7}
            onPress={() => handleSelect(v)}
            style={{
              flexDirection: 'row', alignItems: 'center', backgroundColor: CARD,
              borderRadius: 12, padding: 14, marginBottom: 8, gap: 12,
            }}
          >
            {/* 信号等级 */}
            <View style={{
              width: 40, height: 40, borderRadius: 10, alignItems: 'center',
              justifyContent: 'center', backgroundColor: gradeBg(v.signal_grade),
            }}>
              <Text style={{ fontSize: 12, fontWeight: '800', color: gradeColor(v.signal_grade) }}>
                {v.signal_grade || '-'}
              </Text>
            </View>
            {/* 品种信息 */}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: TEXT1 }}>{v.code}</Text>
              <Text style={{ fontSize: 12, color: TEXT3, marginTop: 1 }}>{v.name}</Text>
            </View>
            {/* 价格和方向 */}
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 15, fontWeight: '700', color: TEXT1 }}>{fmt(v.close)}</Text>
              <View style={{
                flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2,
              }}>
                <FontAwesome6
                  name={v.ai_direction?.startsWith('空') || v.ai_direction === 'SHORT' ? 'arrow-down' : 'arrow-up'}
                  size={10}
                  color={v.ai_direction?.startsWith('空') || v.ai_direction === 'SHORT' ? DOWN : UP}
                />
                <Text style={{
                  fontSize: 11, fontWeight: '600',
                  color: v.ai_direction?.startsWith('空') || v.ai_direction === 'SHORT' ? DOWN : UP,
                }}>
                  {v.ai_direction || '-'}
                </Text>
              </View>
              {/* Gate4 计数 */}
              {(v.g4_count ?? 0) > 0 && (
                <Text style={{ fontSize: 10, color: WARN, marginTop: 1 }}>
                  G4×{v.g4_count}
                </Text>
              )}
            </View>
            <FontAwesome6 name="chevron-right" size={12} color={TEXT3} />
          </TouchableOpacity>
        ))
      )}
    </>
  );

  // ============== 阶段2：分析+登记 ==============
  const renderAnalyzeStage = () => {
    if (!selectedVariety) return null;
    const v = selectedVariety;
    const aiDir = v.ai_direction || '';
    const isLong = aiDir === 'LONG' || aiDir.startsWith('多');
    const isShort = aiDir === 'SHORT' || aiDir.startsWith('空');

    return (
      <>
        {/* 品种信息卡片 */}
        <View style={{
          backgroundColor: CARD, borderRadius: 14, padding: 16, marginBottom: 12,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={{ fontSize: 18, fontWeight: '800', color: TEXT1 }}>{v.code}</Text>
                {sg && (
                  <View style={{
                    backgroundColor: gradeBg(sg), borderRadius: 8, paddingHorizontal: 10, paddingVertical: 3,
                  }}>
                    <Text style={{ fontSize: 12, fontWeight: '800', color: gradeColor(sg) }}>{sg}</Text>
                  </View>
                )}
              </View>
              <Text style={{ fontSize: 13, color: TEXT3, marginTop: 3 }}>{v.name}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ fontSize: 20, fontWeight: '800', color: TEXT1 }}>{fmt(v.close)}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <FontAwesome6
                  name={isShort ? 'arrow-down' : 'arrow-up'}
                  size={12}
                  color={isShort ? DOWN : UP}
                />
                <Text style={{ fontSize: 13, fontWeight: '700', color: isShort ? DOWN : UP }}>
                  {aiDir || '-'}
                </Text>
              </View>
            </View>
          </View>
          {/* 关键价位 */}
          <View style={{
            flexDirection: 'row', justifyContent: 'space-around', marginTop: 14, paddingTop: 12,
            borderTopWidth: 1, borderTopColor: '#1E1E2E',
          }}>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>支撑</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: DOWN }}>{fmt(v.key_levels?.support)}</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>EMA20</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: ACCENT }}>{fmt(v.key_levels?.ema20)}</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>阻力</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: UP }}>{fmt(v.key_levels?.resistance)}</Text>
            </View>
            <View style={{ alignItems: 'center' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>Gate4</Text>
              <Text style={{ fontSize: 13, fontWeight: '700', color: WARN }}>{v.g4_count ?? 0}</Text>
            </View>
          </View>
        </View>

        {/* AI 建议卡片 */}
        {loadingAdvice ? (
          <View style={{
            backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 12,
            flexDirection: 'row', alignItems: 'center', gap: 10,
          }}>
            <ActivityIndicator color={ACCENT} size="small" />
            <Text style={{ fontSize: 13, color: TEXT2 }}>正在生成交易建议...</Text>
          </View>
        ) : advice ? (
          <View style={{
            backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 12,
            borderLeftWidth: 3, borderLeftColor: ACCENT,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: ACCENT }}>AI 建议</Text>
              <Text style={{
                fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
                backgroundColor: (advice.alertLevel === 'CRITICAL' ? UP : advice.alertLevel === 'ALERT' ? WARN : advice.alertLevel === 'WATCH' ? ACCENT : '#1E1E2E') + '20',
                color: advice.alertLevel === 'CRITICAL' ? UP : advice.alertLevel === 'ALERT' ? WARN : advice.alertLevel === 'WATCH' ? ACCENT : TEXT3,
              }}>
                {advice.alertLevel || 'NONE'}
              </Text>
            </View>

            {/* 方向 / 止损 / 目标1 */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
              <View style={{ flex: 1, backgroundColor: BG, borderRadius: 10, padding: 10 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>方向</Text>
                <Text style={{ fontSize: 15, fontWeight: '800', color: advice.direction === 'SHORT' ? DOWN : UP }}>
                  {advice.direction === 'SHORT' ? '做空 ↓' : '做多 ↑'}
                </Text>
              </View>
              <View style={{ flex: 1, backgroundColor: BG, borderRadius: 10, padding: 10 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>止损</Text>
                <Text style={{ fontSize: 15, fontWeight: '800', color: UP }}>{fmt(advice.stopLoss)}</Text>
              </View>
              <View style={{ flex: 1, backgroundColor: BG, borderRadius: 10, padding: 10 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>目标1</Text>
                <Text style={{ fontSize: 15, fontWeight: '800', color: DOWN }}>{fmt(advice.target1)}</Text>
              </View>
            </View>

            {/* 支撑 / 阻力 / 目标2 */}
            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>支撑</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: DOWN }}>{fmt(advice.support)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>阻力</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: UP }}>{fmt(advice.resistance)}</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 10, color: TEXT3 }}>目标2</Text>
                <Text style={{ fontSize: 13, fontWeight: '700', color: DOWN }}>{fmt(advice.target2)}</Text>
              </View>
            </View>

            {/* 多时间框架共振 */}
            {advice.mtfResonanceText ? (
              <Text style={{ fontSize: 11, color: TEXT2, marginBottom: 8 }}>{advice.mtfResonanceText}</Text>
            ) : null}

            {/* 文字建议摘要 */}
            {advice.summary ? (
              <View style={{ backgroundColor: BG, borderRadius: 10, padding: 10 }}>
                <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>建议摘要</Text>
                <Text style={{ fontSize: 12, lineHeight: 18, color: TEXT2 }} numberOfLines={4}>
                  {advice.summary}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* 方向切换 */}
        <View style={{
          flexDirection: 'row', backgroundColor: CARD, borderRadius: 12, padding: 4,
          marginBottom: 12,
        }}>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => onDirectionToggle('long')}
            style={{
              flex: 1, alignItems: 'center', paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: direction === 'long' ? UP : 'transparent',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: direction === 'long' ? '#fff' : TEXT2 }}>
              做多 ↑
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.8}
            onPress={() => onDirectionToggle('short')}
            style={{
              flex: 1, alignItems: 'center', paddingVertical: 10,
              borderRadius: 10,
              backgroundColor: direction === 'short' ? DOWN : 'transparent',
            }}
          >
            <Text style={{ fontSize: 14, fontWeight: '700', color: direction === 'short' ? '#fff' : TEXT2 }}>
              做空 ↓
            </Text>
          </TouchableOpacity>
        </View>

        {/* 交易者方程 */}
        <View style={{
          backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 12,
        }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: ACCENT, marginBottom: 10 }}>
            交易者方程
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <View style={{ width: '50%', marginBottom: 10 }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>进场</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: TEXT1 }}>{entryPrice || '-'}</Text>
            </View>
            <View style={{ width: '50%', marginBottom: 10 }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>止损</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: UP }}>{stopLoss || '-'}</Text>
            </View>
            <View style={{ width: '50%', marginBottom: 10 }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>目标</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: DOWN }}>{target || '-'}</Text>
            </View>
            <View style={{ width: '50%', marginBottom: 10 }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>RR 比</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: GOLD }}>{rr}</Text>
            </View>
            <View style={{ width: '50%' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>单笔风险（点）</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: WARN }}>{riskPerUnit.toFixed(1)}</Text>
            </View>
            <View style={{ width: '50%' }}>
              <Text style={{ fontSize: 10, color: TEXT3 }}>预估风险（$）</Text>
              <Text style={{ fontSize: 14, fontWeight: '700', color: WARN }}>{totalRisk}</Text>
            </View>
          </View>
        </View>

        {/* 登记表单 */}
        <View style={{
          backgroundColor: CARD, borderRadius: 14, padding: 14, marginBottom: 12,
        }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: TEXT1, marginBottom: 12 }}>
            登记持仓
          </Text>

          {/* 合约代码 */}
          <View style={{ marginBottom: 10 }}>
            <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>合约代码</Text>
            <TextInput
              style={{
                backgroundColor: BG, borderRadius: 10, paddingHorizontal: 14, height: 42,
                color: TEXT1, fontSize: 15, borderWidth: 1, borderColor: '#1E1E2E',
              }}
              value={contract}
              onChangeText={setContract}
              placeholder="如 CL-FUT"
              placeholderTextColor={TEXT3}
            />
          </View>

          {/* 入场 / 止损 / 目标 三列 */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>入场价</Text>
              <TextInput
                style={{
                  backgroundColor: BG, borderRadius: 10, paddingHorizontal: 12, height: 42,
                  color: TEXT1, fontSize: 15, textAlign: 'center',
                  borderWidth: 1, borderColor: '#1E1E2E',
                }}
                value={entryPrice}
                onChangeText={setEntryPrice}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>止损</Text>
              <TextInput
                style={{
                  backgroundColor: BG, borderRadius: 10, paddingHorizontal: 12, height: 42,
                  color: UP, fontSize: 15, textAlign: 'center',
                  borderWidth: 1, borderColor: '#1E1E2E',
                }}
                value={stopLoss}
                onChangeText={setStopLoss}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>目标</Text>
              <TextInput
                style={{
                  backgroundColor: BG, borderRadius: 10, paddingHorizontal: 12, height: 42,
                  color: DOWN, fontSize: 15, textAlign: 'center',
                  borderWidth: 1, borderColor: '#1E1E2E',
                }}
                value={target}
                onChangeText={setTarget}
                keyboardType="decimal-pad"
              />
            </View>
          </View>

          {/* 手数 */}
          <View style={{ marginBottom: 10 }}>
            <Text style={{ fontSize: 11, color: TEXT3, marginBottom: 4 }}>手数</Text>
            <TextInput
              style={{
                backgroundColor: BG, borderRadius: 10, paddingHorizontal: 14, height: 42,
                color: TEXT1, fontSize: 15,
                borderWidth: 1, borderColor: '#1E1E2E',
              }}
              value={quantity}
              onChangeText={setQuantity}
              keyboardType="number-pad"
            />
          </View>
        </View>

        {/* 错误提示 */}
        {error ? (
          <View style={{
            backgroundColor: '#F43F5E15', borderRadius: 10, padding: 12, marginBottom: 12,
          }}>
            <Text style={{ color: UP, fontSize: 13, textAlign: 'center' }}>{error}</Text>
          </View>
        ) : null}

        {/* 提交按钮 */}
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={handleSubmit}
          disabled={submitting}
          style={{
            backgroundColor: ACCENT, borderRadius: 14, paddingVertical: 15,
            alignItems: 'center', justifyContent: 'center', marginBottom: 12,
            opacity: submitting ? 0.5 : 1,
          }}
        >
          {submitting ? (
            <ActivityIndicator color="#000" size="small" />
          ) : (
            <Text style={{ fontSize: 16, fontWeight: '800', color: '#0A0A0F' }}>
              确认登记
            </Text>
          )}
        </TouchableOpacity>

        {/* 快捷数值摘要 */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 10,
          backgroundColor: CARD, borderRadius: 12, marginBottom: 12,
        }}>
          <Text style={{ fontSize: 10, color: TEXT3 }}>
            RR {rr}
          </Text>
          <Text style={{ fontSize: 10, color: TEXT3 }}>
            风险 {riskPerUnit.toFixed(1)}点
          </Text>
          <Text style={{ fontSize: 10, color: TEXT3 }}>
            {qty}手 · ${totalRisk}
          </Text>
        </View>
      </>
    );
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}>
          <TouchableWithoutFeedback>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View style={{ backgroundColor: BG, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '90%', flexShrink: 1 }}>
                {/* Header */}
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: '#1E1E2E' }}>
                  <View>
                    <Text style={{ fontSize: 17, fontWeight: '700', color: TEXT1 }}>
                      {stage === 'select' ? '选择品种' : '登记持仓'}
                    </Text>
                    {stage === 'analyze' && selectedVariety && (
                      <Text style={{ fontSize: 12, color: TEXT3, marginTop: 2 }}>
                        {selectedVariety.code} {selectedVariety.name} · {selectedVariety.ai_direction || '-'}
                      </Text>
                    )}
                  </View>
                  <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
                    {stage === 'analyze' && (
                      <TouchableOpacity onPress={() => { setStage('select'); setSearchQuery(''); }} activeOpacity={0.7}>
                        <FontAwesome6 name="magnifying-glass" size={16} color={ACCENT} />
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity onPress={onClose} activeOpacity={0.6}>
                      <FontAwesome6 name="xmark" size={20} color={TEXT3} />
                    </TouchableOpacity>
                  </View>
                </View>

                <ScrollView
                  style={{ paddingHorizontal: 16, paddingTop: 12, flexGrow: 1 }}
                  contentContainerStyle={{ paddingBottom: 30 }}
                  showsVerticalScrollIndicator={false}
                >
                  {stage === 'select' ? renderSelectStage() : renderAnalyzeStage()}
                </ScrollView>
              </View>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
