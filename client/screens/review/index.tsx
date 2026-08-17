import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert, Switch, Modal, FlatList,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  fetchReview, saveReview,
  fetchVarietyReviews, saveVarietyReview, deleteVarietyReviewApi,
  fetchTrades, fetchMarketSummary,
  type DailyReview, type VarietyReview, type TradeRecord, type VarietyItem,
  type TomorrowPlan,
} from '@/utils/api';

const IRON_RULES = [
  '止损设在入场前',
  '止损用自动单',
  '没有追高/追空',
  '没有逆势加仓',
  '没有扛单',
  '没有同时持多空',
  '宏观事件前未开新方向',
  '连亏2笔后停手',
  '交易不超过3笔',
];

const STATE_OPTIONS = ['趋势', '通道', '区间'];
const GRADE_OPTIONS = ['A', 'B', 'C', 'D'];

interface KeyLevelsSnap {
  ema20?: number;
  prev_high?: number;
  prev_low?: number;
  range_high_20?: number;
  range_low_20?: number;
  support?: number;
  resistance?: number;
}

interface VarietyFormState {
  variety_code: string;
  variety_name: string;
  premarket_state: string;
  market_state_actual: string;
  state_correct: boolean;
  ai_direction: string;
  signal_grade: string;
  notes: string;
  key_levels: KeyLevelsSnap | null;
  trades: TradeRecord[];
  saved: boolean; // 是否已有保存记录
}

interface PlanForm {
  variety_code: string;
  variety_name: string;
  direction: '' | 'long' | 'short' | 'both';
  breakout_long: string;
  breakdown_short: string;
  range_low: string;
  range_high: string;
  notes: string;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function isSameDay(iso: string | undefined, date: string) {
  if (!iso) return false;
  return iso.slice(0, 10) === date;
}

function fmtNum(v?: number | null) {
  if (v === undefined || v === null) return '--';
  return v % 1 === 0 ? String(v) : v.toFixed(2);
}

// ============ 品种复盘卡片（文件顶层组件，受控） ============
interface CardProps {
  form: VarietyFormState;
  onChange: (patch: Partial<VarietyFormState>) => void;
  onRemove: () => void;
}

function VarietyReviewCard({ form, onChange, onRemove }: CardProps) {
  const pnlTotal = form.trades.reduce((s, t) => s + (t.profit_loss || 0), 0);
  const kl = form.key_levels;
  const dirLabel = form.ai_direction === 'long' ? '做多' : form.ai_direction === 'short' ? '做空' : form.ai_direction || '--';
  const dirColor = form.ai_direction === 'long' ? '#22c55e' : form.ai_direction === 'short' ? '#ef4444' : '#C9A96E';

  return (
    <View style={styles.card}>
      {/* 卡片头：品种 + 当日交易概况 + 删除 */}
      <View style={styles.cardHeader}>
        <View style={{ flex: 1 }}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.cardTitle}>{form.variety_name}</Text>
            <Text style={styles.cardCode}>{form.variety_code}</Text>
            <View style={[styles.dirBadge, { borderColor: dirColor }]}>
              <Text style={[styles.dirBadgeText, { color: dirColor }]}>{dirLabel}</Text>
            </View>
          </View>
          <Text style={styles.cardSub}>
            当日 {form.trades.length} 笔
            {form.trades.length > 0 && (
              <Text style={{ color: pnlTotal >= 0 ? '#22c55e' : '#ef4444' }}>
                {'  '}合计 {pnlTotal >= 0 ? '+' : ''}{fmtNum(pnlTotal)}
              </Text>
            )}
          </Text>
        </View>
        <TouchableOpacity onPress={onRemove} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <FontAwesome6 name="xmark" size={14} color="#666" />
        </TouchableOpacity>
      </View>

      {/* 当日交易明细（自动关联，只读） */}
      {form.trades.length > 0 && (
        <View style={styles.tradesBox}>
          {form.trades.map(t => (
            <View key={t.id} style={styles.tradeRow}>
              <Text style={[styles.tradeDir, { color: t.direction === 'long' ? '#22c55e' : '#ef4444' }]}>
                {t.direction === 'long' ? '多' : '空'}
              </Text>
              <Text style={styles.tradePrice}>{fmtNum(t.open_price)}</Text>
              <Text style={styles.tradeArrow}>→</Text>
              <Text style={styles.tradePrice}>{t.close_price ? fmtNum(t.close_price) : '持仓中'}</Text>
              {t.signal_grade ? <Text style={styles.tradeGrade}>{t.signal_grade}级</Text> : null}
              {t.profit_loss !== undefined && t.profit_loss !== null && (
                <Text style={[styles.tradePnl, { color: t.profit_loss >= 0 ? '#22c55e' : '#ef4444' }]}>
                  {t.profit_loss >= 0 ? '+' : ''}{fmtNum(t.profit_loss)}
                </Text>
              )}
            </View>
          ))}
        </View>
      )}

      {/* 关键位快照（自动带出，只读） */}
      {kl && (
        <View style={styles.klBox}>
          <Text style={styles.klTitle}>关键位快照</Text>
          <View style={styles.klGrid}>
            <Text style={styles.klItem}>支撑 <Text style={styles.klVal}>{fmtNum(kl.support)}</Text></Text>
            <Text style={styles.klItem}>阻力 <Text style={styles.klVal}>{fmtNum(kl.resistance)}</Text></Text>
            <Text style={styles.klItem}>20EMA <Text style={styles.klVal}>{fmtNum(kl.ema20)}</Text></Text>
            <Text style={styles.klItem}>前高 <Text style={styles.klVal}>{fmtNum(kl.prev_high)}</Text></Text>
            <Text style={styles.klItem}>前低 <Text style={styles.klVal}>{fmtNum(kl.prev_low)}</Text></Text>
            <Text style={styles.klItem}>区间 <Text style={styles.klVal}>{fmtNum(kl.range_low_20)}~{fmtNum(kl.range_high_20)}</Text></Text>
          </View>
        </View>
      )}

      {/* 三态识别（品种级） */}
      <Text style={styles.fieldLabel}>盘前判断</Text>
      <View style={styles.chipRow}>
        {STATE_OPTIONS.map(s => (
          <TouchableOpacity
            key={s}
            style={[styles.chip, form.premarket_state === s && styles.chipActive]}
            onPress={() => onChange({ premarket_state: s })}
          >
            <Text style={[styles.chipText, form.premarket_state === s && styles.chipTextActive]}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.fieldLabel}>实际走势</Text>
      <View style={styles.chipRow}>
        {STATE_OPTIONS.map(s => (
          <TouchableOpacity
            key={s}
            style={[styles.chip, form.market_state_actual === s && styles.chipActive]}
            onPress={() => onChange({ market_state_actual: s })}
          >
            <Text style={[styles.chipText, form.market_state_actual === s && styles.chipTextActive]}>{s}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>三态判断正确</Text>
        <Switch
          value={form.state_correct}
          onValueChange={v => onChange({ state_correct: v })}
          trackColor={{ true: '#C9A96E', false: '#333' }}
          thumbColor="#fff"
        />
      </View>

      {/* 信号等级 */}
      <Text style={styles.fieldLabel}>信号等级</Text>
      <View style={styles.chipRow}>
        {GRADE_OPTIONS.map(g => (
          <TouchableOpacity
            key={g}
            style={[styles.chip, form.signal_grade === g && styles.chipActive]}
            onPress={() => onChange({ signal_grade: form.signal_grade === g ? '' : g })}
          >
            <Text style={[styles.chipText, form.signal_grade === g && styles.chipTextActive]}>{g}级</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 单品种反思 */}
      <Text style={styles.fieldLabel}>品种反思</Text>
      <TextInput
        style={[styles.input, { minHeight: 64 }]}
        value={form.notes}
        onChangeText={v => onChange({ notes: v })}
        placeholder="该品种今日：信号质量如何？执行是否到位？关键位是否有效？"
        placeholderTextColor="#555"
        multiline
      />
    </View>
  );
}

// ============ 主页面 ============
export default function ReviewScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [selectedDate, setSelectedDate] = useState(todayStr());

  // 品种级复盘
  const [varietyForms, setVarietyForms] = useState<VarietyFormState[]>([]);
  const [allTrades, setAllTrades] = useState<TradeRecord[]>([]);
  const [marketVarieties, setMarketVarieties] = useState<VarietyItem[]>([]);

  // 账户级
  const [premarketState, setPremarketState] = useState('');
  const [actualState, setActualState] = useState('');
  const [stateCorrect, setStateCorrect] = useState(true);
  const [ironRules, setIronRules] = useState<boolean[]>(Array(9).fill(true));
  const [whatWentWell, setWhatWentWell] = useState('');
  const [whatWentPoorly, setWhatWentPoorly] = useState('');
  const [keyLesson, setKeyLesson] = useState('');
  const [newPattern, setNewPattern] = useState('');
  const [emotionalState, setEmotionalState] = useState('');

  // 明日计划（品种级数组）
  const [plans, setPlans] = useState<PlanForm[]>([]);

  // 品种选择器
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerMode, setPickerMode] = useState<'review' | 'plan'>('review');
  const [planEditIndex, setPlanEditIndex] = useState(-1);

  // 从交易记录构建关键位快照
  const buildKeyLevelsFromTrades = (trades: TradeRecord[]): KeyLevelsSnap | null => {
    const t = trades.find(x => x.ema20 || x.support_level || x.resistance_level);
    if (!t) return null;
    return {
      ema20: t.ema20,
      support: t.support_level,
      resistance: t.resistance_level,
      prev_high: t.prev_high,
      prev_low: t.prev_low,
      range_low_20: t.price_range_low,
      range_high_20: t.price_range_high,
    };
  };

  const loadAll = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const [reviewRes, vReviewsRes, tradesRes, marketRes] = await Promise.all([
        fetchReview(date).catch(() => ({ review: null })),
        fetchVarietyReviews(date).catch(() => ({ reviews: [] })),
        fetchTrades().catch(() => ({ trades: [] })),
        fetchMarketSummary().catch(() => ({ results: [] as VarietyItem[], summary: null })),
      ]);

      const trades = tradesRes.trades || [];
      setAllTrades(trades);
      const varieties = marketRes.results || [];
      setMarketVarieties(varieties);

      // 账户级字段
      const r = reviewRes.review;
      if (r) {
        setPremarketState(r.premarket_state || '');
        setActualState(r.market_state_actual || '');
        setStateCorrect(r.state_correct ?? true);
        try {
          const rules = r.iron_rules_check ? JSON.parse(r.iron_rules_check) : null;
          setIronRules(Array.isArray(rules) && rules.length === 9 ? rules : Array(9).fill(true));
        } catch { setIronRules(Array(9).fill(true)); }
        setWhatWentWell(r.what_went_well || '');
        setWhatWentPoorly(r.what_went_poorly || '');
        setKeyLesson(r.key_lesson || '');
        setNewPattern(r.new_pa_pattern || '');
        setEmotionalState(r.emotional_state || '');
        try {
          const p = r.tomorrow_plans ? JSON.parse(r.tomorrow_plans) : [];
          setPlans(Array.isArray(p) ? p.map((x: TomorrowPlan) => ({
            variety_code: x.variety_code || '',
            variety_name: x.variety_name || '',
            direction: x.direction || '',
            breakout_long: x.breakout_long || '',
            breakdown_short: x.breakdown_short || '',
            range_low: x.range_low || '',
            range_high: x.range_high || '',
            notes: x.notes || '',
          })) : []);
        } catch { setPlans([]); }
      } else {
        setPremarketState(''); setActualState(''); setStateCorrect(true);
        setIronRules(Array(9).fill(true));
        setWhatWentWell(''); setWhatWentPoorly(''); setKeyLesson('');
        setNewPattern(''); setEmotionalState(''); setPlans([]);
      }

      // 当日交易按品种分组（开仓或平仓发生在当日）
      const dayTrades = trades.filter(t => isSameDay(t.open_time, date) || isSameDay(t.close_time, date));
      const byVariety = new Map<string, TradeRecord[]>();
      for (const t of dayTrades) {
        const arr = byVariety.get(t.variety_code) || [];
        arr.push(t);
        byVariety.set(t.variety_code, arr);
      }

      // 已保存的品种复盘
      const savedMap = new Map<string, VarietyReview>();
      for (const vr of vReviewsRes.reviews || []) savedMap.set(vr.variety_code, vr);

      // 合并：当日交易品种 ∪ 已保存品种复盘
      const codes = new Set<string>([...byVariety.keys(), ...savedMap.keys()]);
      const forms: VarietyFormState[] = [];
      for (const code of codes) {
        const vTrades = byVariety.get(code) || [];
        const saved = savedMap.get(code);
        const market = varieties.find(v => v.code === code);
        let kl: KeyLevelsSnap | null = null;
        if (saved?.key_levels) {
          try { kl = JSON.parse(saved.key_levels); } catch { kl = null; }
        }
        if (!kl) kl = buildKeyLevelsFromTrades(vTrades);
        if (!kl && market?.key_levels) kl = market.key_levels;

        forms.push({
          variety_code: code,
          variety_name: saved?.variety_name || vTrades[0]?.variety_name || market?.name || code,
          premarket_state: saved?.premarket_state || '',
          market_state_actual: saved?.market_state_actual || '',
          state_correct: saved?.state_correct ?? true,
          ai_direction: saved?.ai_direction || vTrades[0]?.ai_direction || market?.ai_direction || '',
          signal_grade: saved?.signal_grade || vTrades[0]?.signal_grade || '',
          notes: saved?.notes || '',
          key_levels: kl,
          trades: vTrades,
          saved: !!saved,
        });
      }
      setVarietyForms(forms);
    } catch (e) {
      console.error('Failed to load review data:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadAll(selectedDate); }, [loadAll, selectedDate]));

  const violations = ironRules.filter(v => !v).length;

  // 品种表单更新
  const updateVarietyForm = (code: string, patch: Partial<VarietyFormState>) => {
    setVarietyForms(prev => prev.map(f => f.variety_code === code ? { ...f, ...patch } : f));
  };

  const removeVarietyForm = (code: string) => {
    Alert.alert('移除品种', `确定从今日复盘移除 ${code} 吗？已保存的内容将被删除。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '移除', style: 'destructive',
        onPress: async () => {
          setVarietyForms(prev => prev.filter(f => f.variety_code !== code));
          try { await deleteVarietyReviewApi(selectedDate, code); } catch { /* 忽略未保存的 */ }
        },
      },
    ]);
  };

  // 品种选择器
  const openPicker = (mode: 'review' | 'plan', planIndex = -1) => {
    setPickerMode(mode);
    setPlanEditIndex(planIndex);
    setPickerVisible(true);
  };

  const handlePickVariety = (v: VarietyItem) => {
    setPickerVisible(false);
    if (pickerMode === 'review') {
      if (varietyForms.some(f => f.variety_code === v.code)) return;
      const vTrades = allTrades.filter(t => t.variety_code === v.code && (isSameDay(t.open_time, selectedDate) || isSameDay(t.close_time, selectedDate)));
      setVarietyForms(prev => [...prev, {
        variety_code: v.code,
        variety_name: v.name,
        premarket_state: '',
        market_state_actual: '',
        state_correct: true,
        ai_direction: v.ai_direction || '',
        signal_grade: '',
        notes: '',
        key_levels: v.key_levels || buildKeyLevelsFromTrades(vTrades),
        trades: vTrades,
        saved: false,
      }]);
    } else {
      const item: PlanForm = {
        variety_code: v.code,
        variety_name: v.name,
        direction: v.ai_direction === 'short' ? 'short' : 'long',
        breakout_long: v.key_levels?.resistance ? String(v.key_levels.resistance) : '',
        breakdown_short: v.key_levels?.support ? String(v.key_levels.support) : '',
        range_low: v.key_levels?.range_low_20 ? String(v.key_levels.range_low_20) : '',
        range_high: v.key_levels?.range_high_20 ? String(v.key_levels.range_high_20) : '',
        notes: '',
      };
      if (planEditIndex >= 0) {
        setPlans(prev => prev.map((p, i) => i === planEditIndex ? item : p));
      } else {
        setPlans(prev => [...prev, item]);
      }
    }
  };

  // 保存
  const handleSave = async () => {
    setSaving(true);
    try {
      // 信号统计自动汇总
      const grade = (g: string) => varietyForms.filter(f => f.signal_grade === g).length;
      const dayTrades = allTrades.filter(t => isSameDay(t.open_time, selectedDate) || isSameDay(t.close_time, selectedDate));
      const totalSignals = varietyForms.filter(f => f.signal_grade).length;

      const reviewPayload: Partial<DailyReview> = {
        review_date: selectedDate,
        premarket_state: premarketState,
        market_state_actual: actualState,
        state_correct: stateCorrect,
        iron_rules_check: JSON.stringify(ironRules),
        total_signals: totalSignals,
        a_level_signals: grade('A'),
        b_level_signals: grade('B'),
        c_level_signals: grade('C'),
        entered_signals: dayTrades.filter(t => isSameDay(t.open_time, selectedDate)).length,
        missed_signals: Math.max(0, totalSignals - dayTrades.filter(t => isSameDay(t.open_time, selectedDate)).length),
        what_went_well: whatWentWell,
        what_went_poorly: whatWentPoorly,
        key_lesson: keyLesson,
        new_pa_pattern: newPattern,
        emotional_state: emotionalState,
        tomorrow_plans: JSON.stringify(plans.filter(p => p.variety_code)),
      };
      await saveReview(reviewPayload);

      // 逐品种保存
      for (const f of varietyForms) {
        await saveVarietyReview(selectedDate, {
          variety_code: f.variety_code,
          variety_name: f.variety_name,
          premarket_state: f.premarket_state,
          market_state_actual: f.market_state_actual,
          state_correct: f.state_correct,
          ai_direction: f.ai_direction,
          signal_grade: f.signal_grade,
          key_levels: f.key_levels ? JSON.stringify(f.key_levels) : undefined,
          notes: f.notes,
        });
      }

      Alert.alert('成功', `复盘已保存（${varietyForms.length} 个品种）`);
    } catch (e: any) {
      Alert.alert('错误', e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading && varietyForms.length === 0) {
    return (
      <View className="flex-1">
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#C9A96E" />
          <Text style={styles.loadingText}>加载复盘数据...</Text>
        </View>
      </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView style={styles.container} keyboardShouldPersistTaps="handled">
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <FontAwesome6 name="arrow-left" size={16} color="#C9A96E" />
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>每日复盘</Text>
            <Text style={styles.subtitle}>品种维度 · Brooks 体系</Text>
          </View>
          <TouchableOpacity
            style={[styles.saveBtn, saving && { opacity: 0.5 }]}
            onPress={handleSave}
            disabled={saving}
          >
            <Text style={styles.saveBtnText}>{saving ? '保存中...' : '保存复盘'}</Text>
          </TouchableOpacity>
        </View>

        {/* 日期选择 */}
        <View style={styles.dateRow}>
          <TouchableOpacity style={styles.dateNavBtn} onPress={() => {
            const d = new Date(selectedDate); d.setDate(d.getDate() - 1);
            setSelectedDate(d.toISOString().split('T')[0]);
          }}>
            <FontAwesome6 name="chevron-left" size={13} color="#C9A96E" />
          </TouchableOpacity>
          <Text style={styles.dateText}>{selectedDate}{selectedDate === todayStr() ? '（今天）' : ''}</Text>
          <TouchableOpacity style={styles.dateNavBtn} onPress={() => {
            const d = new Date(selectedDate); d.setDate(d.getDate() + 1);
            setSelectedDate(d.toISOString().split('T')[0]);
          }}>
            <FontAwesome6 name="chevron-right" size={13} color="#C9A96E" />
          </TouchableOpacity>
        </View>

        {/* 一、品种复盘（核心区域） */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>一、品种复盘</Text>
            <Text style={styles.sectionHint}>{varietyForms.length} 个品种</Text>
          </View>

          {varietyForms.length === 0 && (
            <View style={styles.emptyBox}>
              <FontAwesome6 name="clipboard-list" size={22} color="#444" />
              <Text style={styles.emptyText}>当日暂无交易记录关联的品种{'\n'}可手动添加关注品种进行复盘</Text>
            </View>
          )}

          {varietyForms.map(f => (
            <VarietyReviewCard
              key={f.variety_code}
              form={f}
              onChange={patch => updateVarietyForm(f.variety_code, patch)}
              onRemove={() => removeVarietyForm(f.variety_code)}
            />
          ))}

          <TouchableOpacity style={styles.addBtn} onPress={() => openPicker('review')}>
            <FontAwesome6 name="plus" size={13} color="#C9A96E" />
            <Text style={styles.addBtnText}>添加关注品种</Text>
          </TouchableOpacity>
        </View>

        {/* 二、账户级三态识别（整体市场背景） */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>二、整体市场状态</Text>
          <Text style={styles.fieldLabel}>盘前判断（大势背景）</Text>
          <View style={styles.chipRow}>
            {STATE_OPTIONS.map(s => (
              <TouchableOpacity key={s} style={[styles.chip, premarketState === s && styles.chipActive]} onPress={() => setPremarketState(s)}>
                <Text style={[styles.chipText, premarketState === s && styles.chipTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.fieldLabel}>实际走势</Text>
          <View style={styles.chipRow}>
            {STATE_OPTIONS.map(s => (
              <TouchableOpacity key={s} style={[styles.chip, actualState === s && styles.chipActive]} onPress={() => setActualState(s)}>
                <Text style={[styles.chipText, actualState === s && styles.chipTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={styles.switchRow}>
            <Text style={styles.switchLabel}>大势判断正确</Text>
            <Switch value={stateCorrect} onValueChange={setStateCorrect} trackColor={{ true: '#C9A96E', false: '#333' }} thumbColor="#fff" />
          </View>
        </View>

        {/* 三、铁律检查 */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>三、铁律检查</Text>
            <View style={[styles.violationBadge, violations > 0 && styles.violationBadgeRed]}>
              <Text style={[styles.violationText, violations > 0 && { color: '#ef4444' }]}>
                违反 {violations} 条
              </Text>
            </View>
          </View>
          {IRON_RULES.map((rule, i) => (
            <TouchableOpacity key={i} style={styles.ruleRow} onPress={() => {
              const next = [...ironRules]; next[i] = !next[i]; setIronRules(next);
            }}>
              <View style={[styles.checkbox, ironRules[i] && styles.checkboxChecked]}>
                {ironRules[i] && <FontAwesome6 name="check" size={12} color="#000" />}
              </View>
              <Text style={[styles.ruleText, !ironRules[i] && styles.ruleViolated]}>
                {`${i + 1}. ${rule}`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 四、整体反思 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>四、整体反思</Text>
          <Text style={styles.fieldLabel}>做得好的</Text>
          <TextInput style={styles.input} value={whatWentWell} onChangeText={setWhatWentWell} placeholder="哪些执行到位？哪些信号抓住了？" placeholderTextColor="#555" multiline />
          <Text style={styles.fieldLabel}>做得差的</Text>
          <TextInput style={styles.input} value={whatWentPoorly} onChangeText={setWhatWentPoorly} placeholder="哪些失误？追高？扛单？错过信号？" placeholderTextColor="#555" multiline />
          <Text style={styles.fieldLabel}>关键教训</Text>
          <TextInput style={styles.input} value={keyLesson} onChangeText={setKeyLesson} placeholder="今天最重要的一条教训" placeholderTextColor="#555" multiline />
          <Text style={styles.fieldLabel}>新发现的 PA 模式</Text>
          <TextInput style={styles.input} value={newPattern} onChangeText={setNewPattern} placeholder="是否观察到新的价格行为模式？" placeholderTextColor="#555" multiline />
          <Text style={styles.fieldLabel}>情绪状态</Text>
          <View style={styles.chipRow}>
            {['平静', '贪婪', '恐惧', '急躁', '亢奋'].map(s => (
              <TouchableOpacity key={s} style={[styles.chip, emotionalState === s && styles.chipActive]} onPress={() => setEmotionalState(s === emotionalState ? '' : s)}>
                <Text style={[styles.chipText, emotionalState === s && styles.chipTextActive]}>{s}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* 五、明日计划（品种级） */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>五、明日计划</Text>
            <Text style={styles.sectionHint}>{plans.length} 个品种</Text>
          </View>

          {plans.length === 0 && (
            <Text style={styles.emptyText}>暂无计划，添加明日重点关注的品种</Text>
          )}

          {plans.map((p, idx) => (
            <View key={`${p.variety_code}-${idx}`} style={styles.planCard}>
              <View style={styles.cardHeader}>
                <View style={{ flex: 1 }}>
                  <View style={styles.cardTitleRow}>
                    <Text style={styles.cardTitle}>{p.variety_name}</Text>
                    <Text style={styles.cardCode}>{p.variety_code}</Text>
                  </View>
                </View>
                <TouchableOpacity onPress={() => setPlans(prev => prev.filter((_, i) => i !== idx))} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <FontAwesome6 name="xmark" size={14} color="#666" />
                </TouchableOpacity>
              </View>

              <Text style={styles.fieldLabel}>方向</Text>
              <View style={styles.chipRow}>
                {([['long', '做多'], ['short', '做空'], ['both', '双向观察']] as const).map(([val, label]) => (
                  <TouchableOpacity
                    key={val}
                    style={[styles.chip, p.direction === val && styles.chipActive]}
                    onPress={() => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, direction: val } : x))}
                  >
                    <Text style={[styles.chipText, p.direction === val && styles.chipTextActive]}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <View style={styles.planGrid}>
                <View style={styles.planField}>
                  <Text style={styles.planLabel}>突破做多</Text>
                  <TextInput
                    style={styles.planInput}
                    value={p.breakout_long}
                    onChangeText={v => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, breakout_long: v } : x))}
                    placeholder="价位"
                    placeholderTextColor="#555"
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.planField}>
                  <Text style={styles.planLabel}>跌破做空</Text>
                  <TextInput
                    style={styles.planInput}
                    value={p.breakdown_short}
                    onChangeText={v => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, breakdown_short: v } : x))}
                    placeholder="价位"
                    placeholderTextColor="#555"
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.planField}>
                  <Text style={styles.planLabel}>区间下限</Text>
                  <TextInput
                    style={styles.planInput}
                    value={p.range_low}
                    onChangeText={v => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, range_low: v } : x))}
                    placeholder="价位"
                    placeholderTextColor="#555"
                    keyboardType="numeric"
                  />
                </View>
                <View style={styles.planField}>
                  <Text style={styles.planLabel}>区间上限</Text>
                  <TextInput
                    style={styles.planInput}
                    value={p.range_high}
                    onChangeText={v => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, range_high: v } : x))}
                    placeholder="价位"
                    placeholderTextColor="#555"
                    keyboardType="numeric"
                  />
                </View>
              </View>

              <TextInput
                style={[styles.input, { marginTop: 8 }]}
                value={p.notes}
                onChangeText={v => setPlans(prev => prev.map((x, i) => i === idx ? { ...x, notes: v } : x))}
                placeholder="备注：关注什么形态/信号？"
                placeholderTextColor="#555"
              />
            </View>
          ))}

          <TouchableOpacity style={styles.addBtn} onPress={() => openPicker('plan')}>
            <FontAwesome6 name="plus" size={13} color="#C9A96E" />
            <Text style={styles.addBtnText}>添加明日关注品种</Text>
          </TouchableOpacity>
        </View>

        {/* 底部保存 */}
        <TouchableOpacity
          style={[styles.bottomSaveBtn, saving && { opacity: 0.5 }]}
          onPress={handleSave}
          disabled={saving}
        >
          <FontAwesome6 name="floppy-disk" size={15} color="#000" />
          <Text style={styles.bottomSaveBtnText}>{saving ? '保存中...' : '保存全部复盘'}</Text>
        </TouchableOpacity>

        <View style={{ height: 40 }} />
      </ScrollView>

      {/* 品种选择器 */}
      <Modal visible={pickerVisible} transparent animationType="slide" onRequestClose={() => setPickerVisible(false)}>
        <View style={styles.pickerOverlay}>
          <View style={styles.pickerContent}>
            <View style={styles.pickerHeader}>
              <Text style={styles.pickerTitle}>{pickerMode === 'review' ? '添加复盘品种' : '添加明日关注品种'}</Text>
              <TouchableOpacity onPress={() => setPickerVisible(false)}>
                <FontAwesome6 name="xmark" size={16} color="#999" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={marketVarieties}
              keyExtractor={item => item.code}
              style={{ maxHeight: 420 }}
              renderItem={({ item }) => (
                <TouchableOpacity style={styles.pickerItem} onPress={() => handlePickVariety(item)}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.pickerItemName}>{item.name}</Text>
                    <Text style={styles.pickerItemCode}>{item.code}</Text>
                  </View>
                  <Text style={styles.pickerItemG4}>G4 {item.g4_count ?? 0}/5</Text>
                  <Text style={[
                    styles.pickerItemDir,
                    { color: item.ai_direction === 'long' ? '#22c55e' : item.ai_direction === 'short' ? '#ef4444' : '#888' },
                  ]}>
                    {item.ai_direction === 'long' ? '多' : item.ai_direction === 'short' ? '空' : '--'}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={<Text style={styles.emptyText}>品种列表加载中...</Text>}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: '#888', marginTop: 12, fontSize: 13 },
  header: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 12 },
  backBtn: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: 'rgba(201,169,110,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  title: { fontSize: 20, fontWeight: '700', color: '#F5F0E6' },
  subtitle: { fontSize: 11, color: '#888', marginTop: 2 },
  saveBtn: {
    backgroundColor: '#C9A96E', paddingHorizontal: 16, paddingVertical: 9, borderRadius: 10,
  },
  saveBtnText: { color: '#000', fontSize: 13, fontWeight: '700' },
  dateRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16,
    paddingVertical: 10, marginBottom: 6,
  },
  dateNavBtn: {
    width: 32, height: 32, borderRadius: 8, backgroundColor: 'rgba(201,169,110,0.12)',
    justifyContent: 'center', alignItems: 'center',
  },
  dateText: { fontSize: 15, fontWeight: '600', color: '#F5F0E6' },
  section: {
    backgroundColor: 'rgba(255,253,240,0.04)', borderRadius: 14, padding: 14,
    marginTop: 12, borderWidth: 1, borderColor: 'rgba(201,169,110,0.15)',
  },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#C9A96E', marginBottom: 10 },
  sectionHint: { fontSize: 11, color: '#888', marginBottom: 10 },
  emptyBox: { alignItems: 'center', paddingVertical: 24, gap: 10 },
  emptyText: { color: '#666', fontSize: 12, textAlign: 'center', lineHeight: 18 },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1, borderColor: 'rgba(201,169,110,0.4)', borderStyle: 'dashed',
    borderRadius: 10, paddingVertical: 11, marginTop: 10,
  },
  addBtnText: { color: '#C9A96E', fontSize: 13, fontWeight: '600' },
  // 品种卡片
  card: {
    backgroundColor: 'rgba(13,16,38,0.6)', borderRadius: 12, padding: 12,
    marginBottom: 10, borderWidth: 1, borderColor: 'rgba(201,169,110,0.2)',
  },
  cardHeader: { flexDirection: 'row', alignItems: 'flex-start', marginBottom: 8 },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#F5F0E6' },
  cardCode: { fontSize: 11, color: '#888' },
  cardSub: { fontSize: 11, color: '#999', marginTop: 3 },
  dirBadge: {
    borderWidth: 1, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
  },
  dirBadgeText: { fontSize: 10, fontWeight: '700' },
  tradesBox: {
    backgroundColor: 'rgba(255,253,240,0.03)', borderRadius: 8, padding: 8, marginBottom: 8,
  },
  tradeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 3 },
  tradeDir: { fontSize: 12, fontWeight: '700', width: 18 },
  tradePrice: { fontSize: 12, color: '#DDD', fontVariant: ['tabular-nums'] },
  tradeArrow: { fontSize: 11, color: '#666' },
  tradeGrade: {
    fontSize: 10, color: '#C9A96E', backgroundColor: 'rgba(201,169,110,0.15)',
    paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4, overflow: 'hidden',
  },
  tradePnl: { fontSize: 12, fontWeight: '700', marginLeft: 'auto', fontVariant: ['tabular-nums'] },
  klBox: {
    backgroundColor: 'rgba(201,169,110,0.06)', borderRadius: 8, padding: 8, marginBottom: 8,
  },
  klTitle: { fontSize: 10, color: '#C9A96E', fontWeight: '600', marginBottom: 5 },
  klGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  klItem: { fontSize: 11, color: '#999', width: '47%' },
  klVal: { color: '#F5F0E6', fontWeight: '600', fontVariant: ['tabular-nums'] },
  fieldLabel: { fontSize: 12, color: '#AAA', marginTop: 10, marginBottom: 6 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8,
    backgroundColor: 'rgba(255,253,240,0.06)', borderWidth: 1, borderColor: 'transparent',
  },
  chipActive: { backgroundColor: 'rgba(201,169,110,0.2)', borderColor: '#C9A96E' },
  chipText: { fontSize: 12, color: '#999' },
  chipTextActive: { color: '#C9A96E', fontWeight: '700' },
  switchRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 8, marginTop: 4,
  },
  switchLabel: { fontSize: 13, color: '#CCC' },
  input: {
    backgroundColor: 'rgba(255,253,240,0.05)', borderRadius: 10, padding: 10,
    color: '#F5F0E6', fontSize: 13, minHeight: 42, textAlignVertical: 'top',
  },
  violationBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6,
    backgroundColor: 'rgba(34,197,94,0.12)',
  },
  violationBadgeRed: { backgroundColor: 'rgba(239,68,68,0.12)' },
  violationText: { fontSize: 11, color: '#22c55e', fontWeight: '600' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 7 },
  checkbox: {
    width: 20, height: 20, borderRadius: 6, borderWidth: 1.5,
    borderColor: '#555', justifyContent: 'center', alignItems: 'center',
  },
  checkboxChecked: { backgroundColor: '#C9A96E', borderColor: '#C9A96E' },
  ruleText: { fontSize: 13, color: '#CCC' },
  ruleViolated: { color: '#ef4444', textDecorationLine: 'line-through' },
  // 明日计划
  planCard: {
    backgroundColor: 'rgba(13,16,38,0.6)', borderRadius: 12, padding: 12,
    marginBottom: 10, borderWidth: 1, borderColor: 'rgba(201,169,110,0.2)',
  },
  planGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  planField: { width: '48%' },
  planLabel: { fontSize: 11, color: '#AAA', marginBottom: 4 },
  planInput: {
    backgroundColor: 'rgba(255,253,240,0.05)', borderRadius: 8, padding: 8,
    color: '#F5F0E6', fontSize: 13,
  },
  bottomSaveBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: '#C9A96E', borderRadius: 12, paddingVertical: 14, marginTop: 16,
  },
  bottomSaveBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },
  // 品种选择器
  pickerOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  pickerContent: {
    backgroundColor: '#151930', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 16, maxHeight: '80%',
  },
  pickerHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12,
  },
  pickerTitle: { fontSize: 16, fontWeight: '700', color: '#F5F0E6' },
  pickerItem: {
    flexDirection: 'row', alignItems: 'center', paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,253,240,0.06)', gap: 10,
  },
  pickerItemName: { fontSize: 14, fontWeight: '600', color: '#F5F0E6' },
  pickerItemCode: { fontSize: 11, color: '#888', marginTop: 2 },
  pickerItemG4: { fontSize: 12, color: '#C9A96E', fontWeight: '600' },
  pickerItemDir: { fontSize: 13, fontWeight: '700', width: 24, textAlign: 'right' },
});
