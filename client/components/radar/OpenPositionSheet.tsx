import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal,
  TouchableWithoutFeedback, KeyboardAvoidingView, Platform,
  ScrollView, ActivityIndicator,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { createTrade, type VarietyItem } from '@/utils/api';

interface OpenPositionSheetProps {
  visible: boolean;
  variety?: VarietyItem | null;
  allVarieties?: VarietyItem[];
  defaultContract?: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function OpenPositionSheet({
  visible, variety, allVarieties = [], defaultContract, onClose, onSuccess,
}: OpenPositionSheetProps) {
  // Stage management: 'select' | 'analyze'
  const [stage, setStage] = useState<'select' | 'analyze'>('analyze');
  const [selectedVariety, setSelectedVariety] = useState<VarietyItem | null>(null);
  const [varietySearch, setVarietySearch] = useState('');
  const [showPicker, setShowPicker] = useState(false);
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [contract, setContract] = useState('');
  const [entryPrice, setEntryPrice] = useState('');
  const [stopLoss, setStopLoss] = useState('');
  const [target, setTarget] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Determine the active variety (from prop or from picker)
  const activeVariety = variety || selectedVariety;

  useEffect(() => {
    if (!visible) return;
    if (variety) {
      // Pre-selected variety - go directly to analyze stage
      setSelectedVariety(variety);
      setStage('analyze');
    } else if (!selectedVariety && allVarieties.length > 0) {
      // No variety pre-selected - show picker
      setStage('select');
      setShowPicker(true);
    } else if (!selectedVariety && allVarieties.length === 0) {
      setStage('select');
    }
  }, [visible, variety, allVarieties]);

  useEffect(() => {
    if (!visible || !activeVariety) return;
    const v = activeVariety;
    const aiDir = v.ai_direction || 'BOTH';
    setDirection(aiDir.startsWith('多') || aiDir === 'LONG' ? 'long' : aiDir.startsWith('空') || aiDir === 'SHORT' ? 'short' : 'long');
    setContract(defaultContract || v.code || '');
    setEntryPrice(v.close != null ? String(v.close) : '');
    const support = v.key_levels?.support;
    const resistance = v.key_levels?.resistance;
    if (aiDir.startsWith('空') || aiDir === 'SHORT') {
      setStopLoss(resistance ? String(resistance) : '');
      setTarget(support ? String(support) : '');
    } else {
      setStopLoss(support ? String(support) : '');
      setTarget(resistance ? String(resistance) : '');
    }
    setQuantity('1');
    setError('');
    setStage('analyze');
  }, [visible, selectedVariety, activeVariety, defaultContract]);

  const handleSelectVariety = (v: VarietyItem) => {
    setSelectedVariety(v);
    setVarietySearch('');
    setShowPicker(false);
    setStage('analyze');
  };

  // Compute derived values
  const signalGrade = activeVariety?.signal_grade || 'N/A';
  const mtfResonance = (activeVariety as any)?.mtf_resonance;
  const equationRR = entryPrice && stopLoss
    ? (Number(entryPrice) - Number(stopLoss)) !== 0
      ? Math.abs((Number(target || entryPrice) - Number(entryPrice)) / (Number(entryPrice) - Number(stopLoss)))
      : 0
    : 0;
  const maxPosition = 5; // Based on 2000 risk / (entry - stop) * contract multiplier

  // Filter varieties for picker
  const filteredPickerVarieties = allVarieties.filter((v) => {
    if (!varietySearch) return true;
    const s = varietySearch.toLowerCase();
    return v.code.toLowerCase().includes(s) || v.name.includes(s);
  });

  const handleSubmit = async () => {
    setError('');
    if (!contract.trim()) { setError('请输入合约代码'); return; }
    const ep = parseFloat(entryPrice);
    if (isNaN(ep) || ep <= 0) { setError('请输入有效入场价'); return; }
    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty <= 0) { setError('手数至少为1'); return; }

    setSubmitting(true);
    try {
      const now = new Date().toISOString();
      await createTrade({
        variety_code: contract.trim(),
        variety_name: activeVariety?.name || '',
        direction: direction === 'long' ? 'long' : 'short',
        open_price: ep,
        open_time: now,
        open_quantity: qty,
        open_reason: `快捷开仓 — ${activeVariety?.name || ''}`,
        signal_grade: activeVariety?.signal_grade || '',
        ai_direction: activeVariety?.ai_direction || '',
        support_level: activeVariety?.key_levels?.support,
        resistance_level: activeVariety?.key_levels?.resistance,
        ema20: activeVariety?.key_levels?.ema20,
        notes: `止损: ${stopLoss || '未设'} | 目标: ${target || '未设'}`,
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e?.message || '开仓失败');
    } finally {
      setSubmitting(false);
    }
  };

  const onDirectionToggle = (d: 'long' | 'short') => {
    setDirection(d);
    const support = activeVariety?.key_levels?.support;
    const resistance = activeVariety?.key_levels?.resistance;
    if (d === 'short') {
      setStopLoss(resistance ? String(resistance) : '');
      setTarget(support ? String(support) : '');
    } else {
      setStopLoss(support ? String(support) : '');
      setTarget(resistance ? String(resistance) : '');
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide">
      <TouchableWithoutFeedback onPress={onClose}>
        <View className="flex-1 bg-black/60 justify-end">
          <TouchableWithoutFeedback>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
              <View className="bg-gray-900 rounded-t-2xl max-h-[85%]">
                {/* Header */}
                <View className="flex-row items-center justify-between p-4 border-b border-gray-800">
                  <View>
                    <Text className="text-lg font-semibold text-gray-100">
                      开仓 — {activeVariety?.name || activeVariety?.code || "选择品种"}
                    </Text>
                    <Text className="text-xs text-gray-500 mt-0.5">
                      {activeVariety?.ai_direction || '无方向'} · Edge {activeVariety?.signal_grade || '-'}
                    </Text>
                  </View>
                  <TouchableOpacity onPress={onClose} activeOpacity={0.6}>
                    <FontAwesome6 name="xmark" size={20} color="#6B7280" />
                  </TouchableOpacity>
                </View>

                <ScrollView className="px-4 py-3" showsVerticalScrollIndicator={false}>
                  {/* Variety Picker (when no variety pre-selected) */}
                  {!variety && (
                    <View className="mb-3">
                      <Text className="text-xs text-gray-400 mb-1.5">选择品种</Text>
                      <TextInput
                        className="bg-gray-800 text-gray-100 rounded-md px-3 py-2 text-sm"
                        placeholder="搜索品种代码或名称..."
                        placeholderTextColor="#6B7280"
                        value={varietySearch}
                        onChangeText={setVarietySearch}
                      />
                      {varietySearch.length > 0 && (
                        <View className="bg-gray-800 rounded-md mt-1 max-h-40">
                          {(allVarieties || []).filter(v => 
                            v.code.includes(varietySearch.toUpperCase()) || 
                            (v.name && v.name.includes(varietySearch))
                          ).slice(0, 8).map(v => (
                            <TouchableOpacity
                              key={v.code}
                              className="flex-row items-center justify-between px-3 py-2 border-b border-gray-700/50"
                              onPress={() => { setSelectedVariety(v); setVarietySearch(''); }}
                            >
                              <View>
                                <Text className="text-gray-100 text-sm">{v.code} {v.name || ''}</Text>
                                <Text className="text-gray-500 text-xs">{v.ai_direction || '-'} · {v.signal_grade || '-'}</Text>
                              </View>
                              <Text className="text-gray-300 text-sm">{v.close}</Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                    </View>
                  )}

                  {/* Analysis Summary */}
                  {activeVariety && (
                    <View className="bg-gray-800/50 rounded-lg p-3 mb-4">
                      <Text className="text-xs text-blue-400 mb-1.5">分析摘要</Text>
                      <View className="flex-row flex-wrap gap-2">
                        <View className="bg-gray-700/50 rounded px-2 py-0.5">
                          <Text className="text-xs text-gray-300">Gate4 {activeVariety.g4_count ?? '?'}</Text>
                        </View>
                        <View className="bg-gray-700/50 rounded px-2 py-0.5">
                          <Text className="text-xs text-gray-300">Edge {activeVariety.signal_grade || '-'}</Text>
                        </View>
                        <View className="bg-gray-700/50 rounded px-2 py-0.5">
                          <Text className="text-xs text-gray-300">Var {activeVariety.signal_variant || '-'}</Text>
                        </View>
                        {equationRR > 0 && (
                          <View className={`rounded px-2 py-0.5 ${equationRR >= 1.5 ? 'bg-green-700/30' : 'bg-red-700/30'}`}>
                            <Text className="text-xs text-gray-300">RR {equationRR.toFixed(1)}</Text>
                          </View>
                        )}
                      </View>
                      {/* MTF Status */}
                      {(activeVariety as any).mtf_resonance && (
                        <View className="mt-2 pt-2 border-t border-gray-700/50">
                          <Text className="text-xs text-gray-500 mb-1">多时间框架</Text>
                          <View className="flex-row gap-3">
                            <Text className="text-xs text-gray-400">
                              日线 {(activeVariety as any).mtf_resonance?.htf_direction === '多' ? '✓' : '✗'}
                            </Text>
                            <Text className="text-xs text-gray-400">
                              60min {(activeVariety as any).mtf_resonance?.ttf_direction === ((activeVariety as any).mtf_resonance?.htf_direction) ? '✓' : '✗'}
                            </Text>
                            <Text className={`text-xs ${(activeVariety as any).mtf_resonance?.resonance === 'full' ? 'text-green-400' : (activeVariety as any).mtf_resonance?.resonance === 'conflict' ? 'text-red-400' : 'text-yellow-400'}`}>
                              共振: {(activeVariety as any).mtf_resonance?.resonance}
                            </Text>
                          </View>
                        </View>
                      )}
                      {/* 回测建议持仓周期 */}
                      <View className="mt-2 pt-2 border-t border-gray-700/50">
                        <View className="flex-row items-center gap-2">
                          <FontAwesome6 name="clock" size={10} color="#6B7280" />
                          <Text className="text-xs text-gray-500">回测建议持仓</Text>
                          <Text className="text-xs text-emerald-400 font-medium">15bar（约75天）</Text>
                        </View>
                      </View>
                    </View>
                  )}

                  {/* 合约输入 */}
                  <Text className="text-xs text-gray-400 mb-1.5">合约代码</Text>
                  <TextInput
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-gray-100 font-mono mb-3"
                    placeholder="如 EB2509"
                    placeholderTextColor="#4B5563"
                    value={contract}
                    onChangeText={setContract}
                    autoCapitalize="characters"
                  />

                  {/* 方向切换 */}
                  <Text className="text-xs text-gray-400 mb-1.5">方向</Text>
                  <View className="flex-row mb-3" style={{ gap: 8 }}>
                    <TouchableOpacity
                      className={`flex-1 py-3 rounded-xl items-center ${
                        direction === 'long'
                          ? 'bg-emerald-500/20 border border-emerald-500/50'
                          : 'bg-gray-800 border border-gray-700'
                      }`}
                      onPress={() => onDirectionToggle('long')}
                      activeOpacity={0.7}
                    >
                      <Text className={`text-base font-semibold ${
                        direction === 'long' ? 'text-emerald-400' : 'text-gray-500'
                      }`}>
                        多
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      className={`flex-1 py-3 rounded-xl items-center ${
                        direction === 'short'
                          ? 'bg-rose-500/20 border border-rose-500/50'
                          : 'bg-gray-800 border border-gray-700'
                      }`}
                      onPress={() => onDirectionToggle('short')}
                      activeOpacity={0.7}
                    >
                      <Text className={`text-base font-semibold ${
                        direction === 'short' ? 'text-rose-400' : 'text-gray-500'
                      }`}>
                        空
                      </Text>
                    </TouchableOpacity>
                  </View>

                  {/* 价格输入行 */}
                  <View className="flex-row mb-3" style={{ gap: 8 }}>
                    <View className="flex-1">
                      <Text className="text-xs text-gray-400 mb-1">入场价</Text>
                      <TextInput
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 font-mono text-center"
                        placeholder="0"
                        placeholderTextColor="#4B5563"
                        value={entryPrice}
                        onChangeText={setEntryPrice}
                        keyboardType="numeric"
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-xs text-gray-400 mb-1">止损</Text>
                      <TextInput
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-rose-400 font-mono text-center"
                        placeholder="0"
                        placeholderTextColor="#4B5563"
                        value={stopLoss}
                        onChangeText={setStopLoss}
                        keyboardType="numeric"
                      />
                    </View>
                    <View className="flex-1">
                      <Text className="text-xs text-gray-400 mb-1">目标</Text>
                      <TextInput
                        className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-emerald-400 font-mono text-center"
                        placeholder="0"
                        placeholderTextColor="#4B5563"
                        value={target}
                        onChangeText={setTarget}
                        keyboardType="numeric"
                      />
                    </View>
                  </View>

                  {/* 手数 */}
                  <Text className="text-xs text-gray-400 mb-1">手数</Text>
                  <TextInput
                    className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-gray-100 font-mono mb-4"
                    placeholder="1"
                    placeholderTextColor="#4B5563"
                    value={quantity}
                    onChangeText={setQuantity}
                    keyboardType="number-pad"
                  />
                  <View className="bg-gray-800/50 rounded-lg p-3 mb-4">
                    <Text className="text-xs text-gray-400 mb-1">仓位计算</Text>
                    <View className="flex-row justify-between">
                      <Text className="text-xs text-gray-500">最大推荐手数</Text>
                      <Text className="text-xs text-gray-300">{maxPosition} 手</Text>
                    </View>
                    <View className="flex-row justify-between mt-0.5">
                      <Text className="text-xs text-gray-500">每手风险</Text>
                      <Text className="text-xs text-gray-300">
                        {entryPrice && stopLoss ? (Math.abs(Number(entryPrice) - Number(stopLoss)) * 5).toFixed(0) : '--'} 元
                      </Text>
                    </View>
                    {equationRR > 0 && (
                      <View className="flex-row justify-between mt-0.5">
                        <Text className="text-xs text-gray-500">风险回报比</Text>
                        <Text className={`text-xs ${equationRR >= 1.5 ? 'text-green-400' : 'text-red-400'}`}>
                          {equationRR.toFixed(1)}
                        </Text>
                      </View>
                    )}
                  </View>

                  {/* 错误提示 */}
                  {error ? (
                    <Text className="text-rose-400 text-xs mb-3">{error}</Text>
                  ) : null}

                  {/* 确认按钮 */}
                  <TouchableOpacity
                    className="w-full bg-cyan-500 rounded-xl py-3.5 items-center mb-6"
                    onPress={handleSubmit}
                    disabled={submitting}
                    activeOpacity={0.7}
                  >
                    {submitting ? (
                      <ActivityIndicator color="#0A0A0F" size="small" />
                    ) : (
                      <Text className="text-base font-bold text-gray-900">
                        确认开仓
                      </Text>
                    )}
                  </TouchableOpacity>
                </ScrollView>
              </View>
            </KeyboardAvoidingView>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}
