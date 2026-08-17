import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  RefreshControl, ActivityIndicator, TextInput, Modal, Alert, Platform,
  FlatList, KeyboardAvoidingView,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { useFocusEffect } from 'expo-router';
import {
  fetchTrades, createTrade, closeTrade, deleteTrade,
  fetchMarketSummary, fetchVarietyDetail,
  type TradeRecord, type VarietyItem,
} from '@/utils/api';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { checkPositionAlerts, type OpenPosition, type PositionAlert } from '@/utils/positionManager';
import { calcTradersEquation, estimateProbability } from '@/utils/tradersEquation';
import { fetchTrainingKline } from '@/utils/trainingApi';

type TabKey = 'open' | 'closed';

type PositionSnapshot = {
  currentPrice: number;
  floatPnl: number;
  alerts: PositionAlert[];
};

// ===== 仓位计算常量 =====
// 单笔风险预算：20万本金 × 2% = 4000 元
const RISK_BUDGET = 4000;

// 各品种合约乘数（元/点，即每手每波动1个价格单位的盈亏）
const CONTRACT_MULTIPLIERS: Record<string, number> = {
  A: 10, AG: 15, AL: 5, AO: 20, AP: 10, AU: 1000, BC: 5, BU: 10,
  C: 10, CF: 5, CJ: 5, CS: 10, CU: 5, EB: 5, EC: 50, EG: 10,
  FG: 20, FU: 10, HC: 10, I: 100, IC: 200, IF: 300, IH: 300, IM: 200,
  J: 100, JD: 10, JM: 60, L: 5, LC: 1, LH: 16, LU: 10, M: 10,
  MA: 10, NI: 1, NR: 10, OI: 10, P: 10, PB: 5, PF: 5, PG: 20,
  PK: 5, PP: 5, PX: 5, RB: 10, RM: 10, RU: 10, SA: 20, SC: 1000,
  SF: 5, SH: 30, SI: 5, SM: 5, SN: 1, SP: 10, SR: 10, SS: 5,
  T: 10000, TA: 5, TF: 10000, TL: 10000, TS: 20000, UR: 20, V: 5,
  Y: 10, ZN: 5,
};

// 品种代码（如 SA0/CU0）→ 合约乘数
function getMultiplier(code: string): { mult: number; estimated: boolean } {
  const base = code.replace(/0+$/, '').toUpperCase();
  if (CONTRACT_MULTIPLIERS[base] != null) return { mult: CONTRACT_MULTIPLIERS[base], estimated: false };
  return { mult: 10, estimated: true }; // 未知品种按10元/点估算
}

// 将日志交易记录适配为持仓结构，复用持仓提醒逻辑（checkPositionAlerts）
function tradeToPosition(t: TradeRecord): OpenPosition {
  return {
    id: String(t.id),
    varietyCode: t.variety_code,
    varietyName: t.variety_name,
    direction: t.direction,
    entryPrice: t.open_price,
    entryTime: t.open_time,
    entryBarIndex: 0,
    stopLoss: t.stop_loss ?? 0,
    targetPrice: t.target_price ?? 0,
    lots: t.open_quantity,
    mode: 'swing',
    maxFloatingPnl: 0,
    addCount: 0,
    equationPositive: false,
    createdAt: t.open_time,
  };
}

export default function JournalScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>('open');
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [varieties, setVarieties] = useState<VarietyItem[]>([]);
  const [showOpenModal, setShowOpenModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [selectedTrade, setSelectedTrade] = useState<TradeRecord | null>(null);
  const [openSnapshots, setOpenSnapshots] = useState<Record<number, PositionSnapshot>>({});

  // 开仓表单
  const [formCode, setFormCode] = useState('');
  const [formDirection, setFormDirection] = useState<'long' | 'short'>('long');
  const [formOpenPrice, setFormOpenPrice] = useState('');
  const [formQuantity, setFormQuantity] = useState('');
  const [formStopLoss, setFormStopLoss] = useState('');
  const [formTarget, setFormTarget] = useState('');
  const [formSignalGrade, setFormSignalGrade] = useState('B');
  const [formAiDirection, setFormAiDirection] = useState('');
  const [formMarketState, setFormMarketState] = useState('');
  const [formSupport, setFormSupport] = useState('');
  const [formResistance, setFormResistance] = useState('');
  const [formEma20, setFormEma20] = useState('');
  const [formPrevHigh, setFormPrevHigh] = useState('');
  const [formPrevLow, setFormPrevLow] = useState('');
  const [formRangeLow, setFormRangeLow] = useState('');
  const [formRangeHigh, setFormRangeHigh] = useState('');
  const [formSignalType, setFormSignalType] = useState('');
  const [formEntryReason, setFormEntryReason] = useState('');
  const [formOpenReason, setFormOpenReason] = useState('');

  // V16.2 预测参考值（选品种后自动带出，仅作标注展示，不覆盖手动输入）
  const [predStop, setPredStop] = useState<number | null>(null);
  const [predTarget, setPredTarget] = useState<number | null>(null);
  const [predGrade, setPredGrade] = useState('');
  const [formAdvice, setFormAdvice] = useState('');

  // 平仓表单
  const [closePrice, setClosePrice] = useState('');
  const [closeReason, setCloseReason] = useState('');
  const [closeSignalReview, setCloseSignalReview] = useState('');
  const [closeNotes, setCloseNotes] = useState('');
  const [closeLessons, setCloseLessons] = useState('');

  const [showCodePicker, setShowCodePicker] = useState(false);
  const [showVarietyPicker, setShowVarietyPicker] = useState(false);

  // 加载 open 持仓的实时快照（最新价 + 浮动盈亏 + 风险提醒）
  const loadOpenSnapshots = useCallback(async (openList: TradeRecord[]) => {
    if (openList.length === 0) {
      setOpenSnapshots({});
      return;
    }
    const snapshots: Record<number, PositionSnapshot> = {};
    await Promise.all(openList.map(async (t) => {
      try {
        const kline = await fetchTrainingKline(t.variety_code, 120);
        if (!kline?.bars || kline.bars.length === 0) return;
        const bars = kline.bars;
        const currentPrice = bars[bars.length - 1].c;
        const pos = tradeToPosition(t);
        const { alerts } = checkPositionAlerts(pos, bars);
        const dirSign = t.direction === 'long' ? 1 : -1;
        const floatPnl = (currentPrice - t.open_price) * dirSign;
        snapshots[t.id] = { currentPrice, floatPnl, alerts };
      } catch (e) {
        console.error('加载持仓快照失败:', t.variety_code, e);
      }
    }));
    setOpenSnapshots(snapshots);
  }, []);

  const loadData = useCallback(async () => {
    try {
      const [tradesData, marketData] = await Promise.all([
        fetchTrades(),
        fetchMarketSummary(),
      ]);
      const tradeList = tradesData.trades || [];
      setTrades(tradeList);
      setVarieties(marketData.results || []);
      loadOpenSnapshots(tradeList.filter(t => t.status === 'open'));
    } catch (e) {
      console.error('Failed to load data:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [loadOpenSnapshots]);

  useFocusEffect(useCallback(() => { loadData(); }, [loadData]));

  const onRefresh = () => { setRefreshing(true); loadData(); };

  const openTrades = trades.filter(t => t.status === 'open');
  const closedTrades = trades.filter(t => t.status === 'closed');
  const displayTrades = activeTab === 'open' ? openTrades : closedTrades;

  // 选择品种后自动带出分析数据（含关键位、预测止损/目标/等级、交易建议）
  const handleSelectVariety = async (v: VarietyItem) => {
    setFormCode(v.code);
    setFormAiDirection(v.ai_direction === 'LONG' ? '多' : v.ai_direction === 'SHORT' ? '空' : '中性');
    setFormMarketState(v.spectrum || '');
    const dir = v.ai_direction === 'LONG' ? 'long' : v.ai_direction === 'SHORT' ? 'short' : 'long';
    setFormDirection(dir);
    const g4 = v.g4_count ?? 0;
    // 优先使用后端 1000 次回测的稳健性分级（grade），无则回退 g4_count 粗算
    const grade = v.grade || (g4 >= 4 ? 'A' : g4 >= 3 ? 'B' : g4 >= 2 ? 'C' : 'D');
    setFormSignalGrade(grade);
    setPredGrade(grade);
    setFormAdvice(v.advice || '');
    setShowVarietyPicker(false);
    setShowOpenModal(true);

    // 自动获取详情数据填充关键位
    try {
      const detail = await fetchVarietyDetail(v.code);
      if (detail) {
        const currentPrice = detail.close || 0;
        const atr = detail.atr14 || 0;
        const kl = detail.key_levels;

        // 入场价填入当前价（品种切换时同步更新，可手动修改），使建议手数立即可算
        if (currentPrice) setFormOpenPrice(String(currentPrice));

        if (kl) {
          // 真实关键位（后端基于K线计算）
          setFormEma20(kl.ema20 ? String(Math.round(kl.ema20)) : '');
          setFormSupport(kl.support ? String(Math.round(kl.support)) : '');
          setFormResistance(kl.resistance ? String(Math.round(kl.resistance)) : '');
          setFormPrevHigh(kl.prev_high ? String(Math.round(kl.prev_high)) : '');
          setFormPrevLow(kl.prev_low ? String(Math.round(kl.prev_low)) : '');
          setFormRangeLow(kl.range_low_20 ? String(Math.round(kl.range_low_20)) : '');
          setFormRangeHigh(kl.range_high_20 ? String(Math.round(kl.range_high_20)) : '');
        } else if (currentPrice && atr) {
          // 兜底: 无关键位数据时用 ATR 估算
          setFormEma20(currentPrice.toFixed(0));
          setFormSupport((currentPrice - atr * 1.5).toFixed(0));
          setFormResistance((currentPrice + atr * 1.5).toFixed(0));
          setFormPrevHigh((currentPrice + atr).toFixed(0));
          setFormPrevLow((currentPrice - atr).toFixed(0));
          setFormRangeLow((currentPrice - atr * 2).toFixed(0));
          setFormRangeHigh((currentPrice + atr * 2).toFixed(0));
        }
        // 信号类型
        if (detail.ch_has_signal) setFormSignalType('CH通道');
        else if (detail.mm_found) setFormSignalType('MM测距');
        else if (detail.wedge_found) setFormSignalType('楔形');

        // 预测止损：CH止损 → 关键位(多用支撑/空用阻力) → ATR兜底
        let stop = detail.ch_stop || 0;
        if (!stop && kl) stop = dir === 'long' ? (kl.support || 0) : (kl.resistance || 0);
        if (!stop && currentPrice && atr) stop = dir === 'long' ? currentPrice - 2 * atr : currentPrice + 2 * atr;
        // 预测目标：MM第一目标 → CH目标 → ATR兜底(1:2盈亏比)
        let target = detail.mm_tier1 || detail.ch_target || 0;
        if (!target && currentPrice && atr) target = dir === 'long' ? currentPrice + 2 * atr : currentPrice - 2 * atr;

        if (stop) {
          const s = Math.round(stop * 100) / 100;
          setPredStop(s);
          setFormStopLoss(String(s));
        }
        if (target) {
          const t = Math.round(target * 100) / 100;
          setPredTarget(t);
          setFormTarget(String(t));
        }
        if (detail.advice) setFormAdvice(detail.advice);
      }
    } catch (e) {
      console.error('获取品种详情失败:', e);
    }
  };

  const resetOpenForm = () => {
    setFormCode(''); setFormOpenPrice(''); setFormQuantity('');
    setFormStopLoss(''); setFormTarget(''); setFormSignalGrade('B');
    setFormAiDirection(''); setFormMarketState(''); setFormSupport('');
    setFormResistance(''); setFormEma20(''); setFormPrevHigh(''); setFormPrevLow('');
    setFormRangeLow(''); setFormRangeHigh(''); setFormSignalType('');
    setFormEntryReason(''); setFormOpenReason('');
    setPredStop(null); setPredTarget(null); setPredGrade(''); setFormAdvice('');
  };

  // ===== 建议手数计算（随入场价/止损价等额联动重算）=====
  // 规则：每手风险 = |入场价 − 止损价| × 合约乘数；建议手数 = ⌊4000 ÷ 每手风险⌋
  const { mult: contractMult, estimated: multEstimated } = formCode
    ? getMultiplier(formCode)
    : { mult: 0, estimated: false };
  const entryPriceNum = parseFloat(formOpenPrice);
  const stopPriceNum = parseFloat(formStopLoss);
  const perLotRisk =
    contractMult > 0 && !isNaN(entryPriceNum) && !isNaN(stopPriceNum)
      ? Math.abs(entryPriceNum - stopPriceNum) * contractMult
      : 0;
  const suggestedLots = perLotRisk > 0 ? Math.floor(RISK_BUDGET / perLotRisk) : null;

  // ===== 交易者方程实时预览（盈亏比 + 方程正负）=====
  const targetPriceNum = parseFloat(formTarget);
  const { probability: equationProb } = estimateProbability({
    edgeGrade: (formSignalGrade as 'A' | 'B' | 'C' | 'D') || null,
    aiDirection: formAiDirection || null,
    tradeDirection: formDirection,
    spectrum: formMarketState || null,
  });
  const equation =
    entryPriceNum > 0 && stopPriceNum > 0 && targetPriceNum > 0
      ? calcTradersEquation({
          direction: formDirection,
          entry: entryPriceNum,
          stop: stopPriceNum,
          target: targetPriceNum,
          probability: equationProb,
        })
      : null;

  const handleOpenTrade = async () => {
    if (!formCode || !formOpenPrice || !formQuantity) {
      Alert.alert('提示', '请填写品种、入场价和手数');
      return;
    }
    try {
      await createTrade({
        variety_code: formCode,
        variety_name: varieties.find(v => v.code === formCode)?.name || formCode,
        direction: formDirection,
        open_price: parseFloat(formOpenPrice),
        open_quantity: parseFloat(formQuantity),
        open_time: new Date().toISOString(),
        open_reason: formOpenReason || formEntryReason,
        stop_loss: formStopLoss ? parseFloat(formStopLoss) : undefined,
        target_price: formTarget ? parseFloat(formTarget) : undefined,
        signal_grade: formSignalGrade,
        ai_direction: formAiDirection,
        market_state: formMarketState,
        support_level: formSupport ? parseFloat(formSupport) : undefined,
        resistance_level: formResistance ? parseFloat(formResistance) : undefined,
        ema20: formEma20 ? parseFloat(formEma20) : undefined,
        prev_high: formPrevHigh ? parseFloat(formPrevHigh) : undefined,
        prev_low: formPrevLow ? parseFloat(formPrevLow) : undefined,
        price_range_low: formRangeLow ? parseFloat(formRangeLow) : undefined,
        price_range_high: formRangeHigh ? parseFloat(formRangeHigh) : undefined,
        signal_type: formSignalType,
        entry_reason: formEntryReason,
      } as any);
      setShowOpenModal(false);
      resetOpenForm();
      loadData();
      Alert.alert('成功', '开仓记录已保存');
    } catch (e: any) {
      Alert.alert('错误', e.message || '保存失败');
    }
  };

  const handleCloseTrade = async () => {
    if (!selectedTrade || !closePrice) {
      Alert.alert('提示', '请填写出场价');
      return;
    }
    try {
      const result = await closeTrade(selectedTrade.id, {
        close_price: parseFloat(closePrice),
        close_time: new Date().toISOString(),
        close_reason: closeReason,
        close_signal_review: closeSignalReview,
        close_notes: closeNotes,
        lessons_learned: closeLessons,
      });
      setShowCloseModal(false);
      setSelectedTrade(null);
      setClosePrice(''); setCloseReason(''); setCloseSignalReview(''); setCloseNotes(''); setCloseLessons('');
      loadData();
      const pl = result.profit_loss;
      Alert.alert('平仓完成', `盈亏: ${pl >= 0 ? '+' : ''}${pl?.toFixed(2) || '0.00'}`);
    } catch (e: any) {
      Alert.alert('错误', e.message || '平仓失败');
    }
  };

  const handleDeleteTrade = (id: number) => {
    Alert.alert('确认删除', '确定要删除这条记录吗？', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: async () => { await deleteTrade(id); loadData(); } },
    ]);
  };

  if (loading) {
    return (
      <View className="flex-1">
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#C9A96E" />
          <Text style={styles.loadingText}>加载交易日志...</Text>
        </View>
  
      {/* 品种选择 Modal */}
      <Modal visible={showVarietyPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.varietyPickerContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>选择品种</Text>
              <TouchableOpacity onPress={() => { setShowVarietyPicker(false); setShowOpenModal(true); }}>
                <FontAwesome6 name="xmark" size={18} color="#888" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={varieties}
              keyExtractor={(item) => item.code}
              style={styles.varietyList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.varietyItem}
                  onPress={() => handleSelectVariety(item)}
                >
                  <View style={styles.varietyItemLeft}>
                    <Text style={styles.varietyItemName}>{item.name}</Text>
                    <Text style={styles.varietyItemCode}>{item.code}</Text>
                  </View>
                  <View style={styles.varietyItemRight}>
                    <Text style={[styles.varietyItemG4, { color: (item.g4_count ?? 0) >= 4 ? '#FFD700' : '#888' }]}>
                      G4:{item.g4_count ?? 0}/5
                    </Text>
                    <Text style={[styles.varietyItemDir, { color: item.ai_direction === 'LONG' ? '#00FF88' : item.ai_direction === 'SHORT' ? '#FF4444' : '#888' }]}>
                      {item.ai_direction === 'LONG' ? '多' : item.ai_direction === 'SHORT' ? '空' : '中'}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
    );
  }

  return (
    <View className="flex-1">
      <ScrollView style={styles.container} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>交易日志</Text>
            <Text style={styles.subtitle}>Brooks 体系 · 记录与分析</Text>
          </View>
          <View style={styles.headerBtns}>
            <TouchableOpacity style={styles.reviewBtn} onPress={() => Alert.alert('提示', '请从首页进入复盘页面')}>
              <FontAwesome6 name="clipboard-check" size={14} color="#C9A96E" />
              <Text style={styles.reviewBtnText}>复盘</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.addBtn} onPress={() => { resetOpenForm(); setShowOpenModal(true); }}>
              <FontAwesome6 name="plus" size={16} color="#000" />
              <Text style={styles.addBtnText}>开仓</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{openTrades.length}</Text>
            <Text style={styles.statLabel}>持仓中</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{closedTrades.length}</Text>
            <Text style={styles.statLabel}>已平仓</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: '#4ade80' }]}>
              {closedTrades.filter(t => (t.profit_loss || 0) > 0).length}
            </Text>
            <Text style={styles.statLabel}>盈利</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={[styles.statValue, { color: '#ef4444' }]}>
              {closedTrades.filter(t => (t.profit_loss || 0) <= 0).length}
            </Text>
            <Text style={styles.statLabel}>亏损</Text>
          </View>
        </View>

        {/* Tab */}
        <View style={styles.tabRow}>
          {(['open', 'closed'] as TabKey[]).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
              onPress={() => setActiveTab(tab)}
            >
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab === 'open' ? `持仓中 (${openTrades.length})` : `已平仓 (${closedTrades.length})`}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Trade List */}
        {displayTrades.length === 0 ? (
          <View style={styles.emptyState}>
            <FontAwesome6 name="book-open" size={40} color="#333" />
            <Text style={styles.emptyTitle}>{activeTab === 'open' ? '暂无持仓' : '暂无平仓记录'}</Text>
            <Text style={styles.emptySubtitle}>{activeTab === 'open' ? '点击"开仓"记录第一笔交易' : '完成一笔交易后自动显示'}</Text>
          </View>
        ) : (
          displayTrades.map(trade => (
            <TradeCard
              key={trade.id}
              trade={trade}
              snapshot={openSnapshots[trade.id]}
              onClose={() => { setSelectedTrade(trade); setClosePrice(''); setShowCloseModal(true); }}
              onDelete={() => handleDeleteTrade(trade.id)}
            />
          ))
        )}
      </ScrollView>

      {/* ===== 开仓 Modal ===== */}
      <Modal visible={showOpenModal} transparent animationType="slide" statusBarTranslucent>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>开仓记录</Text>
              <TouchableOpacity onPress={() => setShowOpenModal(false)}>
                <FontAwesome6 name="xmark" size={20} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
              {/* 品种选择 */}
              <Text style={styles.formLabel}>品种 *</Text>
              <TouchableOpacity style={styles.pickerBtn} onPress={() => { setShowOpenModal(false); setShowVarietyPicker(true); }}>
                <Text style={styles.pickerBtnText}>
                  {formCode ? `${formCode} ${varieties.find(v => v.code === formCode)?.name || ''}` : '点击选择品种'}
                </Text>
                <FontAwesome6 name="chevron-right" size={12} color="#888" />
              </TouchableOpacity>

              {/* 自动带出的分析字段 */}
              {formCode ? (
                <View style={styles.autoFillSection}>
                  <Text style={styles.autoFillTitle}>V16.2 分析数据（自动带出）</Text>
                  <View style={styles.autoFillGrid}>
                    <View style={styles.autoFillItem}><Text style={styles.autoFillLabel}>信号等级</Text><Text style={styles.autoFillValue}>{formSignalGrade}</Text></View>
                    <View style={styles.autoFillItem}><Text style={styles.autoFillLabel}>AI方向</Text><Text style={styles.autoFillValue}>{formAiDirection}</Text></View>
                    <View style={styles.autoFillItem}><Text style={styles.autoFillLabel}>市场状态</Text><Text style={styles.autoFillValue}>{formMarketState}</Text></View>
                  </View>
                </View>
              ) : null}

              {/* 方向 */}
              <Text style={styles.formLabel}>方向 *</Text>
              <View style={styles.directionRow}>
                <TouchableOpacity
                  style={[styles.dirBtn, formDirection === 'long' && styles.dirBtnLong]}
                  onPress={() => setFormDirection('long')}
                >
                  <Text style={[styles.dirBtnText, formDirection === 'long' && { color: '#4ade80' }]}>做多</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.dirBtn, formDirection === 'short' && styles.dirBtnShort]}
                  onPress={() => setFormDirection('short')}
                >
                  <Text style={[styles.dirBtnText, formDirection === 'short' && { color: '#ef4444' }]}>做空</Text>
                </TouchableOpacity>
              </View>

              {/* 核心价格 */}
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>入场价 *</Text>
                  <TextInput style={styles.input} value={formOpenPrice} onChangeText={setFormOpenPrice} placeholder="入场价" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>手数 *</Text>
                  <TextInput style={styles.input} value={formQuantity} onChangeText={setFormQuantity} placeholder="手数" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
              </View>

              {/* 建议手数提示（按 20万×2%=4000元 风险预算，随入场价/止损价等额联动重算）*/}
              {formCode && perLotRisk > 0 ? (
                <View style={styles.lotsHintBlock}>
                  <View style={styles.lotsHintRow}>
                    <FontAwesome6 name="calculator" size={11} color="#C9A96E" />
                    {suggestedLots != null && suggestedLots > 0 ? (
                      <Text style={styles.lotsHintText}>
                        建议 <Text style={styles.lotsHintNum}>{suggestedLots}</Text> 手（每手风险 ≈ {Math.round(perLotRisk)} 元）
                      </Text>
                    ) : (
                      <Text style={[styles.lotsHintText, { color: '#ef4444' }]}>
                        1 手风险 ≈ {Math.round(perLotRisk)} 元，已超 4000 元上限
                      </Text>
                    )}
                    {suggestedLots != null && suggestedLots > 0 ? (
                      <TouchableOpacity style={styles.lotsUseBtn} onPress={() => setFormQuantity(String(suggestedLots))}>
                        <Text style={styles.lotsUseBtnText}>使用</Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                  <Text style={styles.lotsHintSub}>
                    按 20 万本金 2% = 4000 元风险上限计算；入场价或止损价变动时将按此预算等额联动重算{multEstimated ? '（该品种乘数为估算值）' : ''}
                  </Text>
                </View>
              ) : null}

              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <View style={styles.labelRow}>
                    <Text style={[styles.formLabel, styles.labelInRow]}>止损价</Text>
                    {predStop != null ? <Text style={styles.predTag}>预测 {predStop}</Text> : null}
                  </View>
                  <TextInput style={styles.input} value={formStopLoss} onChangeText={setFormStopLoss} placeholder="止损价" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <View style={styles.labelRow}>
                    <Text style={[styles.formLabel, styles.labelInRow]}>目标价</Text>
                    {predTarget != null ? <Text style={styles.predTag}>预测 {predTarget}</Text> : null}
                  </View>
                  <TextInput style={styles.input} value={formTarget} onChangeText={setFormTarget} placeholder="目标价" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
              </View>

              {/* 交易者方程实时预览 */}
              {equation ? (
                <View style={styles.equationBlock}>
                  <View style={styles.equationRow}>
                    <FontAwesome6 name="scale-balanced" size={12} color={equation.isPositive ? '#4ade80' : '#ef4444'} />
                    <Text style={[styles.equationText, { color: equation.isPositive ? '#4ade80' : '#ef4444' }]}>
                      方程 {equation.isPositive ? '为正' : '为负'} · 盈亏比 {equation.rrRatio.toFixed(2)}
                    </Text>
                  </View>
                  <Text style={styles.equationSub}>
                    风险 {equation.riskPoints.toFixed(1)} 点 · 预期 {equation.rewardPoints.toFixed(1)} 点 · 预估胜率 {Math.round(equationProb * 100)}%
                    {!equation.rrSatisfied ? ` · 需盈亏比 ≥ ${equation.minRR.toFixed(2)}` : ''}
                  </Text>
                </View>
              ) : null}

              {/* 信号等级 */}
              <View style={styles.labelRow}>
                <Text style={[styles.formLabel, styles.labelInRow]}>信号等级</Text>
                {predGrade ? <Text style={styles.predTag}>预测 {predGrade}</Text> : null}
              </View>
              <View style={styles.gradeRow}>
                {['A', 'B', 'C', 'D'].map(g => (
                  <TouchableOpacity key={g} style={[styles.gradeBtn, formSignalGrade === g && styles.gradeBtnActive]} onPress={() => setFormSignalGrade(g)}>
                    <Text style={[styles.gradeBtnText, formSignalGrade === g && { color: '#C9A96E' }]}>{g}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {/* 关键位 */}
              <Text style={styles.formSectionTitle}>关键位标注</Text>
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>支撑位</Text>
                  <TextInput style={styles.input} value={formSupport} onChangeText={setFormSupport} placeholder="支撑位" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>阻力位</Text>
                  <TextInput style={styles.input} value={formResistance} onChangeText={setFormResistance} placeholder="阻力位" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
              </View>
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>20EMA</Text>
                  <TextInput style={styles.input} value={formEma20} onChangeText={setFormEma20} placeholder="20EMA" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>前高</Text>
                  <TextInput style={styles.input} value={formPrevHigh} onChangeText={setFormPrevHigh} placeholder="前高" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
              </View>
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>前低</Text>
                  <TextInput style={styles.input} value={formPrevLow} onChangeText={setFormPrevLow} placeholder="前低" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>价格区间下限</Text>
                  <TextInput style={styles.input} value={formRangeLow} onChangeText={setFormRangeLow} placeholder="区间下限" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
              </View>
              <View style={styles.formRow}>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>价格区间上限</Text>
                  <TextInput style={styles.input} value={formRangeHigh} onChangeText={setFormRangeHigh} placeholder="区间上限" placeholderTextColor="#555" keyboardType="numeric" />
                </View>
                <View style={styles.formHalf}>
                  <Text style={styles.formLabel}>信号类型</Text>
                  <TextInput style={styles.input} value={formSignalType} onChangeText={setFormSignalType} placeholder="信号棒/外包棒/回踩EMA" placeholderTextColor="#555" />
                </View>
              </View>

              {/* 理由 */}
              <Text style={styles.formLabel}>入场理由</Text>
              <TextInput style={[styles.input, styles.textArea]} value={formEntryReason} onChangeText={setFormEntryReason} placeholder="基于V16.2分析的入场理由..." placeholderTextColor="#555" multiline />

              {/* V16.2 交易建议（参考） */}
              {formAdvice ? (
                <View style={styles.adviceRefBlock}>
                  <View style={styles.adviceRefHeader}>
                    <FontAwesome6 name="lightbulb" size={11} color="#C9A96E" />
                    <Text style={styles.adviceRefTitle}>V16.2 交易建议（参考）</Text>
                  </View>
                  <Text style={styles.adviceRefText}>{formAdvice}</Text>
                </View>
              ) : null}

              <Text style={styles.formLabel}>备注</Text>
              <TextInput style={[styles.input, styles.textArea]} value={formOpenReason} onChangeText={setFormOpenReason} placeholder="其他备注..." placeholderTextColor="#555" multiline />
            </ScrollView>
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowOpenModal(false)}>
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitBtn} onPress={handleOpenTrade}>
                <Text style={styles.submitBtnText}>确认开仓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ===== 平仓 Modal ===== */}
      <Modal visible={showCloseModal} transparent animationType="slide" statusBarTranslucent>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>平仓 - {selectedTrade?.variety_name}</Text>
              <TouchableOpacity onPress={() => setShowCloseModal(false)}>
                <FontAwesome6 name="xmark" size={20} color="#888" />
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.modalBody} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
              <Text style={styles.formLabel}>出场价 *</Text>
              <TextInput style={styles.input} value={closePrice} onChangeText={setClosePrice} placeholder="出场价" placeholderTextColor="#555" keyboardType="numeric" />

              <Text style={styles.formLabel}>出场原因</Text>
              <View style={styles.closeReasonRow}>
                {['止损', '止盈', '信号反转', '手动离场'].map(r => (
                  <TouchableOpacity key={r} style={[styles.reasonChip, closeReason === r && styles.reasonChipActive]} onPress={() => setCloseReason(r)}>
                    <Text style={[styles.reasonChipText, closeReason === r && { color: '#C9A96E' }]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.formLabel}>信号回顾</Text>
              <View style={styles.closeReasonRow}>
                {['信号有效走了', '信号失败反转', '没走震荡'].map(r => (
                  <TouchableOpacity key={r} style={[styles.reasonChip, closeSignalReview === r && styles.reasonChipActive]} onPress={() => setCloseSignalReview(r)}>
                    <Text style={[styles.reasonChipText, closeSignalReview === r && { color: '#C9A96E' }]}>{r}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              <Text style={styles.formLabel}>平仓备注</Text>
              <TextInput style={[styles.input, styles.textArea]} value={closeNotes} onChangeText={setCloseNotes} placeholder="平仓时的情况..." placeholderTextColor="#555" multiline />

              <Text style={styles.formLabel}>经验教训</Text>
              <TextInput style={[styles.input, styles.textArea]} value={closeLessons} onChangeText={setCloseLessons} placeholder="从这笔交易中学到了什么..." placeholderTextColor="#555" multiline />
            </ScrollView>
            <View style={styles.modalFooter}>
              <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowCloseModal(false)}>
                <Text style={styles.cancelBtnText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.submitBtn} onPress={handleCloseTrade}>
                <Text style={styles.submitBtnText}>确认平仓</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
        </KeyboardAvoidingView>
      </Modal>

      {/* ===== 品种选择 Modal ===== */}
      <Modal visible={showVarietyPicker} transparent animationType="slide">
        <View style={styles.modalOverlay}>
          <View style={styles.varietyPickerContent}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>选择品种</Text>
              <TouchableOpacity onPress={() => { setShowVarietyPicker(false); setShowOpenModal(true); }}>
                <FontAwesome6 name="xmark" size={18} color="#888" />
              </TouchableOpacity>
            </View>
            <FlatList
              data={varieties}
              keyExtractor={(item) => item.code}
              style={styles.varietyList}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={styles.varietyItem}
                  onPress={() => handleSelectVariety(item)}
                >
                  <View style={styles.varietyItemLeft}>
                    <Text style={styles.varietyItemName}>{item.name}</Text>
                    <Text style={styles.varietyItemCode}>{item.code}</Text>
                  </View>
                  <View style={styles.varietyItemRight}>
                    <Text style={[styles.varietyItemG4, { color: (item.g4_count ?? 0) >= 4 ? '#FFD700' : '#888' }]}>
                      G4:{item.g4_count ?? 0}/5
                    </Text>
                    <Text style={[styles.varietyItemDir, { color: item.ai_direction === 'LONG' ? '#00FF88' : item.ai_direction === 'SHORT' ? '#FF4444' : '#888' }]}>
                      {item.ai_direction === 'LONG' ? '多' : item.ai_direction === 'SHORT' ? '空' : '中'}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ===== 交易卡片组件 =====
function TradeCard({ trade, snapshot, onClose, onDelete }: {
  trade: TradeRecord;
  snapshot?: PositionSnapshot;
  onClose: () => void;
  onDelete: () => void;
}) {
  const isOpen = trade.status === 'open';
  const pl = trade.profit_loss;
  const plColor = (pl || 0) >= 0 ? '#4ade80' : '#ef4444';
  const dirColor = trade.direction === 'long' ? '#4ade80' : '#ef4444';

  return (
    <View style={styles.tradeCard}>
      <View style={styles.tradeHeader}>
        <View style={styles.tradeLeft}>
          <Text style={styles.tradeCode}>{trade.variety_code}</Text>
          <Text style={styles.tradeName}>{trade.variety_name}</Text>
        </View>
        <View style={styles.tradeRight}>
          <View style={[styles.dirBadge, { backgroundColor: `${dirColor}20` }]}>
            <Text style={[styles.dirText, { color: dirColor }]}>{trade.direction === 'long' ? '多' : '空'}</Text>
          </View>
          {trade.signal_grade && (
            <View style={[styles.gradeBadge, { backgroundColor: trade.signal_grade === 'A' ? '#4ade8020' : trade.signal_grade === 'B' ? '#C9A96E20' : '#ef444420' }]}>
              <Text style={[styles.gradeText, { color: trade.signal_grade === 'A' ? '#4ade80' : trade.signal_grade === 'B' ? '#C9A96E' : '#ef4444' }]}>
                {trade.signal_grade}
              </Text>
            </View>
          )}
        </View>
      </View>

      <View style={styles.tradeBody}>
        <View style={styles.tradeRow}>
          <Text style={styles.tradeLabel}>入场价</Text>
          <Text style={styles.tradeValue}>{trade.open_price}</Text>
        </View>
        <View style={styles.tradeRow}>
          <Text style={styles.tradeLabel}>手数</Text>
          <Text style={styles.tradeValue}>{trade.open_quantity}</Text>
        </View>
        {isOpen && snapshot && (
          <>
            <View style={styles.tradeRow}>
              <Text style={styles.tradeLabel}>最新价</Text>
              <Text style={styles.tradeValue}>{snapshot.currentPrice.toFixed(2)}</Text>
            </View>
            <View style={styles.tradeRow}>
              <Text style={styles.tradeLabel}>浮动盈亏</Text>
              <Text style={[styles.tradeValue, { color: snapshot.floatPnl >= 0 ? '#4ade80' : '#ef4444', fontWeight: '700' }]}>
                {snapshot.floatPnl >= 0 ? '+' : ''}{snapshot.floatPnl.toFixed(2)}
              </Text>
            </View>
            {snapshot.alerts.length > 0 && (
              <View style={styles.alertSection}>
                {snapshot.alerts.map((a, i) => (
                  <View key={i} style={[styles.alertItem, { backgroundColor: a.severity === 'danger' ? '#ef444420' : a.severity === 'warning' ? '#C9A96E20' : '#4ade8020' }]}>
                    <FontAwesome6 name={a.severity === 'danger' ? 'triangle-exclamation' : 'bell'} size={11} color={a.severity === 'danger' ? '#ef4444' : a.severity === 'warning' ? '#C9A96E' : '#4ade80'} />
                    <Text style={[styles.alertText, { color: a.severity === 'danger' ? '#ef4444' : a.severity === 'warning' ? '#C9A96E' : '#4ade80' }]}>
                      {a.title}{a.message ? `：${a.message}` : ''}
                    </Text>
                  </View>
                ))}
              </View>
            )}
          </>
        )}
        {trade.close_price !== undefined && (
          <View style={styles.tradeRow}>
            <Text style={styles.tradeLabel}>出场价</Text>
            <Text style={styles.tradeValue}>{trade.close_price}</Text>
          </View>
        )}
        {!isOpen && pl !== undefined && (
          <View style={styles.tradeRow}>
            <Text style={styles.tradeLabel}>盈亏</Text>
            <Text style={[styles.tradeValue, { color: plColor, fontWeight: '700' }]}>
              {pl >= 0 ? '+' : ''}{pl?.toFixed(2)}
            </Text>
          </View>
        )}
        {trade.ai_direction && (
          <View style={styles.tradeRow}>
            <Text style={styles.tradeLabel}>AI方向</Text>
            <Text style={styles.tradeValue}>{trade.ai_direction}</Text>
          </View>
        )}
        {trade.market_state && (
          <View style={styles.tradeRow}>
            <Text style={styles.tradeLabel}>市场状态</Text>
            <Text style={styles.tradeValue}>{trade.market_state}</Text>
          </View>
        )}
      </View>

      {/* 关键位信息 */}
      {(trade.support_level || trade.resistance_level || trade.ema20) && (
        <View style={styles.keyLevelsSection}>
          <Text style={styles.keyLevelsTitle}>关键位</Text>
          <View style={styles.keyLevelsGrid}>
            {trade.support_level && <View style={styles.keyLevel}><Text style={styles.keyLevelLabel}>支撑</Text><Text style={styles.keyLevelValue}>{trade.support_level}</Text></View>}
            {trade.resistance_level && <View style={styles.keyLevel}><Text style={styles.keyLevelLabel}>阻力</Text><Text style={styles.keyLevelValue}>{trade.resistance_level}</Text></View>}
            {trade.ema20 && <View style={styles.keyLevel}><Text style={styles.keyLevelLabel}>20EMA</Text><Text style={styles.keyLevelValue}>{trade.ema20}</Text></View>}
            {trade.prev_high && <View style={styles.keyLevel}><Text style={styles.keyLevelLabel}>前高</Text><Text style={styles.keyLevelValue}>{trade.prev_high}</Text></View>}
            {trade.prev_low && <View style={styles.keyLevel}><Text style={styles.keyLevelLabel}>前低</Text><Text style={styles.keyLevelValue}>{trade.prev_low}</Text></View>}
          </View>
        </View>
      )}

      {/* 理由/备注 */}
      {trade.entry_reason ? <Text style={styles.tradeNotes}>入场理由: {trade.entry_reason}</Text> : null}
      {trade.close_notes ? <Text style={styles.tradeNotes}>平仓备注: {trade.close_notes}</Text> : null}
      {trade.lessons_learned ? <Text style={styles.tradeNotes}>经验: {trade.lessons_learned}</Text> : null}

      {/* 操作按钮 */}
      <View style={styles.tradeActions}>
        {isOpen && (
          <TouchableOpacity style={styles.closeActionBtn} onPress={onClose}>
            <FontAwesome6 name="lock" size={12} color="#C9A96E" />
            <Text style={styles.closeActionText}>平仓</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={styles.deleteActionBtn} onPress={onDelete}>
          <FontAwesome6 name="trash" size={12} color="#ef4444" />
          <Text style={styles.deleteActionText}>删除</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ===== 样式 =====
const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0f' },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  loadingText: { marginTop: 12, fontSize: 14, color: '#888' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12 },
  title: { fontSize: 24, fontWeight: '800', color: '#fff' },
  subtitle: { fontSize: 12, color: '#888', marginTop: 2 },
  headerBtns: { flexDirection: 'row', gap: 8 },
  reviewBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#C9A96E20', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  reviewBtnText: { fontSize: 13, color: '#C9A96E', fontWeight: '600' },
  addBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#C9A96E', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 },
  addBtnText: { fontSize: 14, fontWeight: '700', color: '#000' },
  statsRow: { flexDirection: 'row', gap: 10, paddingHorizontal: 20, marginBottom: 16 },
  statCard: { flex: 1, backgroundColor: '#111118', borderRadius: 12, padding: 14, alignItems: 'center', borderWidth: 1, borderColor: '#1a1a25' },
  statValue: { fontSize: 22, fontWeight: '800', color: '#fff' },
  statLabel: { fontSize: 11, color: '#888', marginTop: 4 },
  tabRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, marginBottom: 16 },
  tabBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#111118', alignItems: 'center', borderWidth: 1, borderColor: '#1a1a25' },
  tabBtnActive: { backgroundColor: '#C9A96E20', borderColor: '#C9A96E' },
  tabText: { fontSize: 14, color: '#888' },
  tabTextActive: { color: '#C9A96E', fontWeight: '600' },
  emptyState: { alignItems: 'center', paddingVertical: 60 },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#555', marginTop: 12 },
  emptySubtitle: { fontSize: 13, color: '#444', marginTop: 4 },
  // Trade Card
  tradeCard: { backgroundColor: '#111118', borderRadius: 14, padding: 16, marginHorizontal: 20, marginBottom: 12, borderWidth: 1, borderColor: '#1a1a25' },
  tradeHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  tradeLeft: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  tradeCode: { fontSize: 16, fontWeight: '700', color: '#fff' },
  tradeName: { fontSize: 13, color: '#888' },
  tradeRight: { flexDirection: 'row', gap: 6 },
  dirBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  dirText: { fontSize: 12, fontWeight: '700' },
  gradeBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  gradeText: { fontSize: 12, fontWeight: '700' },
  tradeBody: { gap: 6 },
  tradeRow: { flexDirection: 'row', justifyContent: 'space-between' },
  tradeLabel: { fontSize: 13, color: '#888' },
  tradeValue: { fontSize: 13, color: '#fff', fontWeight: '600' },
  keyLevelsSection: { marginTop: 10, paddingTop: 10, borderTopWidth: 1, borderTopColor: '#1a1a25' },
  keyLevelsTitle: { fontSize: 12, color: '#C9A96E', fontWeight: '600', marginBottom: 8 },
  keyLevelsGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  keyLevel: { backgroundColor: '#0a0a0f', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  keyLevelLabel: { fontSize: 10, color: '#888' },
  keyLevelValue: { fontSize: 12, color: '#fff', fontWeight: '600' },
  tradeNotes: { fontSize: 12, color: '#666', marginTop: 8, fontStyle: 'italic' },
  tradeActions: { flexDirection: 'row', gap: 10, marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#1a1a25' },
  closeActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#C9A96E20', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  closeActionText: { fontSize: 13, color: '#C9A96E', fontWeight: '600' },
  deleteActionBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#ef444420', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  deleteActionText: { fontSize: 13, color: '#ef4444' },
  // Modal
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  modalContent: { backgroundColor: '#111118', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%' },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderBottomWidth: 1, borderBottomColor: '#1a1a25' },
  modalTitle: { fontSize: 18, fontWeight: '700', color: '#fff' },
  modalBody: { padding: 20, flexGrow: 0, flexShrink: 1 },
  modalFooter: { flexDirection: 'row', gap: 12, padding: 20, borderTopWidth: 1, borderTopColor: '#1a1a25' },
  cancelBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: '#1a1a25', alignItems: 'center' },
  cancelBtnText: { fontSize: 15, color: '#888', fontWeight: '600' },
  submitBtn: { flex: 1, paddingVertical: 14, borderRadius: 10, backgroundColor: '#C9A96E', alignItems: 'center' },
  submitBtnText: { fontSize: 15, color: '#000', fontWeight: '700' },
  // Form
  formLabel: { fontSize: 13, color: '#888', marginBottom: 6, marginTop: 12 },
  labelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  labelInRow: { flex: 1 },
  predTag: { fontSize: 11, color: '#C9A96E', marginBottom: 6, marginTop: 12 },
  lotsHintBlock: { backgroundColor: 'rgba(201,169,110,0.08)', borderWidth: 1, borderColor: 'rgba(201,169,110,0.25)', borderRadius: 10, padding: 10, marginTop: 8 },
  lotsHintRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  lotsHintText: { flex: 1, fontSize: 12, color: '#ccc' },
  lotsHintNum: { fontSize: 14, fontWeight: '700', color: '#C9A96E' },
  lotsUseBtn: { backgroundColor: '#C9A96E', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 4 },
  lotsUseBtnText: { fontSize: 11, fontWeight: '700', color: '#000' },
  lotsHintSub: { fontSize: 10, color: '#666', marginTop: 6, lineHeight: 14 },
  adviceRefBlock: { backgroundColor: 'rgba(201,169,110,0.06)', borderLeftWidth: 3, borderLeftColor: '#C9A96E', borderRadius: 8, padding: 12, marginTop: 8 },
  adviceRefHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 6 },
  adviceRefTitle: { fontSize: 12, fontWeight: '700', color: '#C9A96E' },
  adviceRefText: { fontSize: 12, color: '#aaa', lineHeight: 18 },
  formSectionTitle: { fontSize: 15, fontWeight: '700', color: '#C9A96E', marginTop: 20, marginBottom: 8 },
  formRow: { flexDirection: 'row', gap: 10 },
  formHalf: { flex: 1 },
  input: { backgroundColor: '#0a0a0f', borderRadius: 10, padding: 12, fontSize: 14, color: '#fff', borderWidth: 1, borderColor: '#1a1a25' },
  textArea: { minHeight: 60, textAlignVertical: 'top' },
  directionRow: { flexDirection: 'row', gap: 10 },
  dirBtn: { flex: 1, paddingVertical: 12, borderRadius: 10, backgroundColor: '#0a0a0f', alignItems: 'center', borderWidth: 1, borderColor: '#1a1a25' },
  dirBtnLong: { borderColor: '#4ade80', backgroundColor: '#4ade8010' },
  dirBtnShort: { borderColor: '#ef4444', backgroundColor: '#ef444410' },
  dirBtnText: { fontSize: 15, fontWeight: '600', color: '#888' },
  gradeRow: { flexDirection: 'row', gap: 8 },
  gradeBtn: { flex: 1, paddingVertical: 10, borderRadius: 10, backgroundColor: '#0a0a0f', alignItems: 'center', borderWidth: 1, borderColor: '#1a1a25' },
  gradeBtnActive: { borderColor: '#C9A96E', backgroundColor: '#C9A96E10' },
  gradeBtnText: { fontSize: 14, fontWeight: '600', color: '#888' },
  pickerBtn: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#0a0a0f', borderRadius: 10, padding: 14, borderWidth: 1, borderColor: '#1a1a25' },
  pickerBtnText: { fontSize: 14, color: '#fff' },
  pickerList: { backgroundColor: '#0a0a0f', borderRadius: 10, marginTop: 4, borderWidth: 1, borderColor: '#1a1a25', overflow: 'hidden' },
  pickerItem: { flexDirection: 'row', alignItems: 'center', padding: 12, borderBottomWidth: 1, borderBottomColor: '#1a1a25', gap: 8 },
  pickerItemCode: { fontSize: 14, fontWeight: '700', color: '#fff', width: 50 },
  pickerItemName: { fontSize: 13, color: '#888', flex: 1 },
  pickerItemDir: { fontSize: 13, fontWeight: '600' },
  // 品种选择 Modal
  varietyPickerContent: { flex: 1, backgroundColor: '#0a0a0f', marginTop: 100, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' },
  varietyList: { flex: 1 },
  varietyItem: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: '#1a1a25' },
  varietyItemLeft: { flex: 1 },
  varietyItemName: { fontSize: 16, fontWeight: '700', color: '#fff' },
  varietyItemCode: { fontSize: 12, color: '#888', marginTop: 2 },
  varietyItemRight: { alignItems: 'flex-end' },
  varietyItemG4: { fontSize: 12, fontWeight: '700' },
  varietyItemDir: { fontSize: 14, fontWeight: '700', marginTop: 2 },
  // 返回按钮
  backBtn: { padding: 4, marginRight: 8 },
  autoFillSection: { backgroundColor: '#C9A96E10', borderRadius: 10, padding: 12, marginTop: 12, borderWidth: 1, borderColor: '#C9A96E30' },
  autoFillTitle: { fontSize: 12, color: '#C9A96E', fontWeight: '600', marginBottom: 8 },
  autoFillGrid: { flexDirection: 'row', gap: 10 },
  autoFillItem: { flex: 1 },
  autoFillLabel: { fontSize: 11, color: '#888' },
  autoFillValue: { fontSize: 14, color: '#fff', fontWeight: '600', marginTop: 2 },
  closeReasonRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  reasonChip: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, backgroundColor: '#0a0a0f', borderWidth: 1, borderColor: '#1a1a25' },
  reasonChipActive: { borderColor: '#C9A96E', backgroundColor: '#C9A96E10' },
  reasonChipText: { fontSize: 13, color: '#888' },
  // 交易者方程 + 持仓提醒
  equationBlock: { backgroundColor: 'rgba(201,169,110,0.08)', borderWidth: 1, borderColor: 'rgba(201,169,110,0.25)', borderRadius: 10, padding: 12, marginTop: 12 },
  equationRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  equationText: { fontSize: 13, color: '#ccc', fontWeight: '600' },
  equationSub: { fontSize: 11, color: '#666', marginTop: 2 },
  alertSection: { marginTop: 10, gap: 6 },
  alertItem: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  alertText: { fontSize: 11, flex: 1 },
});