import React, { useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  calcTradersEquation,
  estimateProbability,
  calcPositionSize,
  minRRForProbability,
  TradeDirection,
} from '@/utils/tradersEquation';
import type { VarietyItem } from '@/utils/api';

const BG = '#0A0A0F';
const CARD = '#15151F';
const BORDER = '#2A2A3A';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#AAAAAA';
const ACCENT = '#00F0FF';
const GREEN = '#00FF88';
const RED = '#FF4466';
const GOLD = '#FFB800';
const PURPLE = '#BF00FF';

interface Props {
  visible: boolean;
  item: VarietyItem | null;
  onClose: () => void;
  /** 可选：精确的预设三要素（如 CH 通道信号），优先于自动估算 */
  preset?: { entry: number; stop: number; target: number } | null;
}

/** 常用品种每点价值（元/点/手），未列出的默认 10 */
const POINT_VALUE_MAP: Record<string, number> = {
  RB: 10, HC: 10, I: 100, J: 100, JM: 60, FG: 20, SA: 20, MA: 10,
  TA: 5, PP: 5, L: 5, V: 5, EG: 10, EB: 5, PG: 20, LU: 10, FU: 10,
  BU: 10, RU: 10, NR: 10, BR: 25, SP: 20, CU: 5, AL: 5, ZN: 5,
  PB: 5, NI: 1, SN: 1, AO: 20, AG: 15, AU: 1000, M: 10, Y: 10,
  P: 10, A: 10, B: 10, C: 10, CS: 10, JD: 5, LH: 16, AP: 10, CJ: 5,
  CF: 5, SR: 10, OI: 10, RM: 10, PK: 5, UR: 20, PF: 5, SH: 10,
  SC: 1000, EC: 50, SI: 5, LC: 500, PS: 5, LG: 90, IM: 200, IF: 300,
  IC: 200, IH: 300, T: 10000, TF: 10000, TS: 20000, TL: 10000,
};

function guessPointValue(code: string): number {
  const prefix = code.replace(/\d/g, '').toUpperCase();
  return POINT_VALUE_MAP[prefix] ?? 10;
}

/** 品种稳健性分级 → 仓位系数（1000 次回测三维度：稳健率/崩溃率/盈利占比） */
const GRADE_COEF: Record<string, number> = {
  A: 1.0, // 稳健底仓：全仓位
  B: 0.6, // 可用：降 40%
  C: 0.3, // 脆弱：降 70%
  D: 0, // 失效：禁止开仓
};

function gradeCoef(grade?: string): number {
  return GRADE_COEF[grade ?? ''] ?? 0.5; // 未分级保守默认 50%
}

export function EquationPanel({ visible, item, onClose, preset }: Props) {
  // 方向：跟随 AI 方向
  const direction: TradeDirection = item?.ai_direction === 'SHORT' ? 'short' : 'long';

  // 自动填充默认值
  const defaults = useMemo(() => {
    if (!item) return { entry: 0, stop: 0, target: 0 };
    // 优先使用精确预设
    if (preset && preset.entry > 0 && preset.stop > 0 && preset.target > 0) {
      return { entry: preset.entry, stop: preset.stop, target: preset.target };
    }
    const entry = item.close;
    const kl = item.key_levels;
    if (direction === 'long') {
      const stop = kl ? Math.min(kl.prev_low, kl.support) : entry * 0.98;
      const target = kl ? Math.max(kl.range_high_20, kl.resistance) : entry * 1.04;
      return { entry, stop, target };
    }
    const stop = kl ? Math.max(kl.prev_high, kl.resistance) : entry * 1.02;
    const target = kl ? Math.min(kl.range_low_20, kl.support) : entry * 0.96;
    return { entry, stop, target };
  }, [item, direction, preset]);

  const [entryText, setEntryText] = useState('');
  const [stopText, setStopText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [customP, setCustomP] = useState<number | null>(null);
  const [equityText, setEquityText] = useState('1000000');
  const [riskPctText, setRiskPctText] = useState('2');
  const [pointValueText, setPointValueText] = useState('');
  const [lastItemCode, setLastItemCode] = useState<string | null>(null);

  // item 变化时重置输入（渲染期派生状态模式）
  const resetKey = item ? `${item.code}:${preset?.entry ?? 0}:${preset?.stop ?? 0}:${preset?.target ?? 0}` : null;
  if (item && resetKey !== lastItemCode) {
    setLastItemCode(resetKey);
    setEntryText(String(defaults.entry));
    setStopText(String(defaults.stop));
    setTargetText(String(defaults.target));
    setCustomP(null);
    setPointValueText(String(guessPointValue(item.code)));
  }

  // 概率估算（优先使用历史胜率，与后端判定链同源）
  const probEstimate = useMemo(() => {
    if (!item) return { probability: 0.5, breakdown: [] };
    return estimateProbability({
      edgeGrade: item.edge_grade ?? null,
      winRate20: item.win_rate_20 ?? null,
      aiDirection: item.ai_direction,
      tradeDirection: direction,
      spectrum: item.spectrum,
    });
  }, [item, direction]);

  // 止损距离 ATR 倍数（Brooks：止损超过 2~2.5 倍 ATR 说明入场时机不佳）
  const stopAtrMultiple = useMemo(() => {
    const atr = item?.atr14 ?? 0;
    if (!atr || atr <= 0) return null;
    const e = parseFloat(entryText);
    const s = parseFloat(stopText);
    if (isNaN(e) || isNaN(s) || e === s) return null;
    return Math.abs(e - s) / atr;
  }, [item, entryText, stopText]);

  const probability = customP ?? probEstimate.probability;

  // 方程计算
  const equation = useMemo(() => {
    const entry = parseFloat(entryText) || 0;
    const stop = parseFloat(stopText) || 0;
    const target = parseFloat(targetText) || 0;
    return calcTradersEquation({ direction, entry, stop, target, probability });
  }, [direction, entryText, stopText, targetText, probability]);

  // 仓位计算（交易者方程 × 品种稳健性分级系数）
  const position = useMemo(() => {
    const base = calcPositionSize({
      accountEquity: parseFloat(equityText) || 0,
      riskPct: (parseFloat(riskPctText) || 2) / 100,
      stopPoints: equation.riskPoints,
      pointValue: parseFloat(pointValueText) || 10,
    });
    const coef = gradeCoef(item?.grade);
    const adjustedLots = base.valid ? Math.floor(base.lots * coef) : 0;
    return {
      ...base,
      grade: item?.grade,
      gradeCoef: coef,
      adjustedLots,
    };
  }, [equityText, riskPctText, equation.riskPoints, pointValueText, item?.grade]);

  if (!item) return null;

  const pOptions = [0.4, 0.5, 0.55, 0.6];

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.overlay} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.panel}>
          {/* Header */}
          <View style={styles.header}>
            <View style={styles.headerLeft}>
              <View style={[styles.dirBadge, direction === 'long' ? styles.dirLong : styles.dirShort]}>
                <FontAwesome6 name={direction === 'long' ? 'arrow-up' : 'arrow-down'} size={12} color="#FFF" />
                <Text style={styles.dirBadgeText}>{direction === 'long' ? '做多' : '做空'}</Text>
              </View>
              <Text style={styles.headerTitle}>{item.name} {item.contract}</Text>
            </View>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <FontAwesome6 name="xmark" size={18} color={TEXT2} />
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
            {/* 价格三要素 */}
            <Text style={styles.sectionTitle}>交易者方程</Text>
            <View style={styles.priceRow}>
              <View style={styles.priceField}>
                <Text style={styles.priceLabel}>入场位</Text>
                <TextInput
                  style={styles.priceInput}
                  value={entryText}
                  onChangeText={setEntryText}
                  keyboardType="decimal-pad"
                  placeholderTextColor={TEXT2}
                />
              </View>
              <View style={styles.priceField}>
                <Text style={[styles.priceLabel, { color: RED }]}>止损位</Text>
                <TextInput
                  style={[styles.priceInput, { borderColor: RED + '60' }]}
                  value={stopText}
                  onChangeText={setStopText}
                  keyboardType="decimal-pad"
                  placeholderTextColor={TEXT2}
                />
              </View>
              <View style={styles.priceField}>
                <Text style={[styles.priceLabel, { color: GREEN }]}>目标位</Text>
                <TextInput
                  style={[styles.priceInput, { borderColor: GREEN + '60' }]}
                  value={targetText}
                  onChangeText={setTargetText}
                  keyboardType="decimal-pad"
                  placeholderTextColor={TEXT2}
                />
              </View>
            </View>

            {/* 概率选择 */}
            <View style={styles.probSection}>
              <Text style={styles.probTitle}>
                概率估计 <Text style={styles.probAuto}>(自动: {Math.round(probEstimate.probability * 100)}%)</Text>
              </Text>
              <View style={styles.probOptions}>
                {pOptions.map(p => (
                  <TouchableOpacity
                    key={p}
                    style={[styles.probChip, probability === p && styles.probChipActive]}
                    onPress={() => setCustomP(p)}
                  >
                    <Text style={[styles.probChipText, probability === p && styles.probChipTextActive]}>
                      {Math.round(p * 100)}%
                    </Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  style={[styles.probChip, customP === null && styles.probChipActive]}
                  onPress={() => setCustomP(null)}
                >
                  <Text style={[styles.probChipText, customP === null && styles.probChipTextActive]}>自动</Text>
                </TouchableOpacity>
              </View>
              {probEstimate.breakdown.length > 0 && (
                <View style={styles.breakdownRow}>
                  {probEstimate.breakdown.map((b, i) => (
                    <Text key={i} style={styles.breakdownText}>
                      {b.label} {b.delta > 0 && i > 0 ? '+' : ''}{i === 0 ? `${Math.round(b.delta * 100)}%` : `${Math.round(b.delta * 100)}%`}
                    </Text>
                  ))}
                </View>
              )}
            </View>

            {/* 方程结果 */}
            {equation.valid ? (
              <View style={[styles.resultCard, equation.isPositive ? styles.resultPositive : styles.resultNegative]}>
                <View style={styles.resultRow}>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLabel}>止损</Text>
                    <Text style={[styles.resultValue, { color: RED }]}>{equation.riskPoints.toFixed(0)}点</Text>
                  </View>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLabel}>目标</Text>
                    <Text style={[styles.resultValue, { color: GREEN }]}>{equation.rewardPoints.toFixed(0)}点</Text>
                  </View>
                  <View style={styles.resultItem}>
                    <Text style={styles.resultLabel}>盈亏比</Text>
                    <Text style={[styles.resultValue, { color: equation.rrSatisfied ? GREEN : GOLD }]}>
                      {equation.rrRatio.toFixed(2)}:1
                    </Text>
                  </View>
                </View>
                <View style={styles.equationLine}>
                  <Text style={styles.equationText}>
                    {Math.round(probability * 100)}% × {equation.rewardPoints.toFixed(0)} = {equation.expectedWin.toFixed(1)}
                    {'  '}vs{'  '}
                    {Math.round((1 - probability) * 100)}% × {equation.riskPoints.toFixed(0)} = {equation.expectedLoss.toFixed(1)}
                  </Text>
                </View>
                <View style={styles.verdictRow}>
                  <FontAwesome6
                    name={equation.isPositive ? 'circle-check' : 'circle-xmark'}
                    size={16}
                    color={equation.isPositive ? GREEN : RED}
                  />
                  <Text style={[styles.verdictText, { color: equation.isPositive ? GREEN : RED }]}>
                    {equation.isPositive ? '方程为正，值得做' : '方程为负，放弃这笔交易'}
                  </Text>
                </View>
                {!equation.rrSatisfied && (
                  <Text style={styles.warnText}>
                    概率 {Math.round(probability * 100)}% 需要盈亏比 ≥ {minRRForProbability(probability)}:1
                  </Text>
                )}
                {stopAtrMultiple != null && stopAtrMultiple > 2.5 && (
                  <View style={styles.atrWarnBox}>
                    <FontAwesome6 name="triangle-exclamation" size={12} color="#F59E0B" />
                    <Text style={styles.atrWarnText}>
                      止损距离 {stopAtrMultiple.toFixed(1)} 倍 ATR，超过 2.5 倍说明入场时机不佳——错的是入场，不是仓位（Brooks）
                    </Text>
                  </View>
                )}
              </View>
            ) : (
              <View style={[styles.resultCard, styles.resultNegative]}>
                <Text style={styles.warnText}>{equation.invalidReason}</Text>
              </View>
            )}

            {/* 仓位计算器 */}
            <Text style={styles.sectionTitle}>仓位计算</Text>
            <View style={styles.posCard}>
              <View style={styles.posRow}>
                <View style={styles.posField}>
                  <Text style={styles.posLabel}>账户权益(元)</Text>
                  <TextInput
                    style={styles.posInput}
                    value={equityText}
                    onChangeText={setEquityText}
                    keyboardType="decimal-pad"
                    placeholderTextColor={TEXT2}
                  />
                </View>
                <View style={styles.posField}>
                  <Text style={styles.posLabel}>风险比例(%)</Text>
                  <TextInput
                    style={styles.posInput}
                    value={riskPctText}
                    onChangeText={setRiskPctText}
                    keyboardType="decimal-pad"
                    placeholderTextColor={TEXT2}
                  />
                </View>
                <View style={styles.posField}>
                  <Text style={styles.posLabel}>每点价值(元)</Text>
                  <TextInput
                    style={styles.posInput}
                    value={pointValueText}
                    onChangeText={setPointValueText}
                    keyboardType="decimal-pad"
                    placeholderTextColor={TEXT2}
                  />
                </View>
              </View>
              {position.valid && equation.valid ? (
                <View style={styles.posResult}>
                  <View style={styles.posResultItem}>
                    <Text style={styles.posResultLabel}>最大可亏</Text>
                    <Text style={[styles.posResultValue, { color: RED }]}>¥{position.riskAmount.toFixed(0)}</Text>
                  </View>
                  <View style={styles.posResultItem}>
                    <Text style={styles.posResultLabel}>每手风险</Text>
                    <Text style={styles.posResultValue}>¥{position.perLotRisk.toFixed(0)}</Text>
                  </View>
                  <View style={styles.posResultItem}>
                    <Text style={styles.posResultLabel}>建议仓位</Text>
                    <Text style={[styles.posResultValue, { color: ACCENT, fontSize: 22 }]}>{position.adjustedLots} 手</Text>
                  </View>
                </View>
              ) : (
                <Text style={styles.warnText}>{position.invalidReason ?? '请先完成方程计算'}</Text>
              )}
              {position.valid && equation.valid && item?.grade ? (
                <Text style={styles.gradeHint}>
                  品种稳健性 {item.grade_label ?? item.grade}级（{item.grade}）→ 仓位系数 ×{position.gradeCoef}，原始 {position.lots} 手调整为 {position.adjustedLots} 手
                </Text>
              ) : null}
              <Text style={styles.posHint}>止损越远，仓位越小。这是数学，不是主观判断。</Text>
            </View>

            {/* 规则速查 */}
            <View style={styles.rulesCard}>
              <Text style={styles.rulesTitle}>概率与盈亏比匹配</Text>
              {[
                { p: '≥60%', rr: '1.0:1', note: '高概率允许低盈亏比' },
                { p: '50%', rr: '1.5:1', note: '中等概率需要1.5:1' },
                { p: '≤40%', rr: '2.0:1+', note: '低概率要求高盈亏比' },
              ].map((r, i) => (
                <View key={i} style={styles.ruleRow}>
                  <Text style={styles.ruleP}>{r.p}</Text>
                  <Text style={styles.ruleRR}>{r.rr}</Text>
                  <Text style={styles.ruleNote}>{r.note}</Text>
                </View>
              ))}
              <Text style={styles.rulesFooter}>不确定时假设50% —— Brooks</Text>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
  panel: { backgroundColor: BG, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '92%' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: BORDER,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dirBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  dirLong: { backgroundColor: RED },
  dirShort: { backgroundColor: GREEN },
  dirBadgeText: { color: '#FFF', fontSize: 12, fontWeight: '700' },
  headerTitle: { fontSize: 16, fontWeight: '700', color: TEXT1 },
  closeBtn: { padding: 4 },
  body: { paddingHorizontal: 16 },
  sectionTitle: { fontSize: 14, fontWeight: '700', color: ACCENT, marginTop: 16, marginBottom: 10 },
  priceRow: { flexDirection: 'row', gap: 10 },
  priceField: { flex: 1 },
  priceLabel: { fontSize: 11, color: TEXT2, marginBottom: 4 },
  priceInput: {
    backgroundColor: CARD, borderWidth: 1, borderColor: BORDER, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, color: TEXT1, fontSize: 15, fontWeight: '600',
  },
  probSection: { marginTop: 14 },
  probTitle: { fontSize: 13, color: TEXT1, fontWeight: '600', marginBottom: 8 },
  probAuto: { color: TEXT2, fontWeight: '400', fontSize: 12 },
  probOptions: { flexDirection: 'row', gap: 8 },
  probChip: {
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 8,
    backgroundColor: CARD, borderWidth: 1, borderColor: BORDER,
  },
  probChipActive: { backgroundColor: ACCENT + '25', borderColor: ACCENT },
  probChipText: { color: TEXT2, fontSize: 13, fontWeight: '600' },
  probChipTextActive: { color: ACCENT },
  breakdownRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  breakdownText: { fontSize: 11, color: TEXT2 },
  resultCard: { marginTop: 14, borderRadius: 12, padding: 14, borderWidth: 1 },
  resultPositive: { backgroundColor: GREEN + '10', borderColor: GREEN + '40' },
  resultNegative: { backgroundColor: RED + '10', borderColor: RED + '40' },
  resultRow: { flexDirection: 'row', justifyContent: 'space-around' },
  resultItem: { alignItems: 'center' },
  resultLabel: { fontSize: 11, color: TEXT2, marginBottom: 2 },
  resultValue: { fontSize: 16, fontWeight: '700', color: TEXT1 },
  equationLine: { marginTop: 12, paddingTop: 10, borderTopWidth: 1, borderTopColor: BORDER },
  equationText: { fontSize: 12, color: TEXT2, textAlign: 'center', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  verdictRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 10 },
  verdictText: { fontSize: 14, fontWeight: '700' },
  gradeHint: {
    marginTop: 8, paddingHorizontal: 10, paddingVertical: 7, borderRadius: 10,
    backgroundColor: 'rgba(79,70,229,0.08)', borderWidth: 1, borderColor: 'rgba(79,70,229,0.25)',
  },
  gradeHintText: { fontSize: 11, color: TEXT2, lineHeight: 16 },
  warnText: { fontSize: 12, color: GOLD, textAlign: 'center', marginTop: 8 },
  atrWarnBox: {
    marginTop: 10, backgroundColor: 'rgba(255,107,107,0.10)', borderWidth: 1,
    borderColor: 'rgba(255,107,107,0.35)', borderRadius: 10, padding: 10,
  },
  atrWarnText: { fontSize: 12, color: '#ff8a8a', lineHeight: 18 },
  posCard: { backgroundColor: CARD, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: BORDER },
  posRow: { flexDirection: 'row', gap: 10 },
  posField: { flex: 1 },
  posLabel: { fontSize: 11, color: TEXT2, marginBottom: 4 },
  posInput: {
    backgroundColor: BG, borderWidth: 1, borderColor: BORDER, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 8, color: TEXT1, fontSize: 14, fontWeight: '600',
  },
  posResult: { flexDirection: 'row', justifyContent: 'space-around', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: BORDER },
  posResultItem: { alignItems: 'center' },
  posResultLabel: { fontSize: 11, color: TEXT2, marginBottom: 2 },
  posResultValue: { fontSize: 16, fontWeight: '700', color: TEXT1 },
  posHint: { fontSize: 11, color: PURPLE, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
  rulesCard: { backgroundColor: CARD, borderRadius: 12, padding: 14, marginTop: 16, marginBottom: 30, borderWidth: 1, borderColor: BORDER },
  rulesTitle: { fontSize: 13, fontWeight: '700', color: TEXT1, marginBottom: 10 },
  ruleRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 12 },
  ruleP: { width: 50, fontSize: 13, fontWeight: '700', color: GOLD },
  ruleRR: { width: 60, fontSize: 13, fontWeight: '600', color: ACCENT },
  ruleNote: { flex: 1, fontSize: 12, color: TEXT2 },
  rulesFooter: { fontSize: 11, color: TEXT2, textAlign: 'center', marginTop: 10, fontStyle: 'italic' },
});
