import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Modal,
  KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { closeTrade, TradeRecord } from '@/utils/api';

interface ClosePositionSheetProps {
  visible: boolean;
  trade: TradeRecord | null;
  currentPrice?: number;
  onClose: () => void;
  onSuccess: () => void;
}

export default function ClosePositionSheet({
  visible, trade, currentPrice, onClose, onSuccess,
}: ClosePositionSheetProps) {
  const [exitPrice, setExitPrice] = useState('');
  const [exitReason, setExitReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (visible && trade) {
      setExitPrice(currentPrice != null ? String(currentPrice) : '');
      setExitReason('');
      setError('');
    }
  }, [visible, trade, currentPrice]);

  const handleClose = async () => {
    setError('');
    if (!trade) return;
    const ep = parseFloat(exitPrice);
    if (isNaN(ep) || ep <= 0) { setError('请输入有效平仓价'); return; }

    setSubmitting(true);
    try {
      await closeTrade(trade.id, {
        close_price: ep,
        close_time: new Date().toISOString(),
        close_reason: exitReason.trim() || '快捷平仓',
      });
      onSuccess();
      onClose();
    } catch (e: any) {
      setError(e?.message || '平仓失败');
    } finally {
      setSubmitting(false);
    }
  };

  if (!trade) return null;

  const cp = currentPrice ?? (trade.direction === 'long'
    ? trade.open_price + (trade.profit_loss ?? 0) / Math.max(trade.open_quantity, 1)
    : trade.open_price - (trade.profit_loss ?? 0) / Math.max(trade.open_quantity, 1));

  const estimatedPnl = trade.direction === 'long'
    ? (cp - trade.open_price) * trade.open_quantity
    : (trade.open_price - cp) * trade.open_quantity;
  const pnlPct = trade.open_price > 0
    ? (estimatedPnl / (trade.open_price * trade.open_quantity) * 100)
    : 0;
  const isProfit = estimatedPnl >= 0;

  return (
    <Modal visible={visible} transparent animationType="fade">
      <View className="flex-1 bg-black/70 justify-center items-center px-6">
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View className="bg-gray-900 rounded-2xl w-full max-w-sm overflow-hidden border border-gray-800">
            {/* Header */}
            <View className="flex-row items-center justify-between p-4 border-b border-gray-800">
              <View>
                <Text className="text-lg font-semibold text-gray-100">
                  平仓确认
                </Text>
                <Text className="text-sm text-gray-400 mt-0.5" numberOfLines={1}>
                  {trade.variety_code} {trade.variety_name}
                </Text>
              </View>
              <TouchableOpacity onPress={onClose} activeOpacity={0.6}>
                <FontAwesome6 name="xmark" size={20} color="#6B7280" />
              </TouchableOpacity>
            </View>

            {/* Body */}
            <View className="p-4">
              {/* 方向 */}
              <View className="flex-row items-center mb-3">
                <View className={`px-2 py-0.5 rounded ${
                  trade.direction === 'long' ? 'bg-emerald-500/15' : 'bg-rose-500/15'
                }`}>
                  <Text className={`text-xs font-semibold ${
                    trade.direction === 'long' ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {trade.direction === 'long' ? '多' : '空'}
                  </Text>
                </View>
                <Text className="text-xs text-gray-500 ml-2">
                  手数: {trade.open_quantity}
                </Text>
              </View>

              {/* 价格对比 */}
              <View className="flex-row justify-between bg-gray-800/50 rounded-xl p-3 mb-3">
                <View className="items-center flex-1">
                  <Text className="text-xs text-gray-500 mb-1">入场价</Text>
                  <Text className="text-sm font-mono text-gray-300">{trade.open_price}</Text>
                </View>
                <View className="w-px bg-gray-700" />
                <View className="items-center flex-1">
                  <Text className="text-xs text-gray-500 mb-1">现价</Text>
                  <Text className={`text-sm font-mono font-semibold ${
                    isProfit ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {cp}
                  </Text>
                </View>
                <View className="w-px bg-gray-700" />
                <View className="items-center flex-1">
                  <Text className="text-xs text-gray-500 mb-1">预估盈亏</Text>
                  <Text className={`text-sm font-mono font-bold ${
                    isProfit ? 'text-emerald-400' : 'text-rose-400'
                  }`}>
                    {isProfit ? '+' : ''}{estimatedPnl.toFixed(0)}
                  </Text>
                  <Text className={`text-xs ${
                    isProfit ? 'text-emerald-500' : 'text-rose-500'
                  }`}>
                    {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
                  </Text>
                </View>
              </View>

              {/* 平仓价 */}
              <Text className="text-xs text-gray-400 mb-1">平仓价</Text>
              <TextInput
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-base text-gray-100 font-mono mb-3"
                placeholder="现价"
                placeholderTextColor="#4B5563"
                value={exitPrice}
                onChangeText={setExitPrice}
                keyboardType="numeric"
              />

              {/* 平仓理由 */}
              <Text className="text-xs text-gray-400 mb-1">平仓理由（可选）</Text>
              <TextInput
                className="w-full bg-gray-800 border border-gray-700 rounded-xl px-4 py-3 text-sm text-gray-300 mb-3"
                placeholder="如：到达目标位 / 止损触发"
                placeholderTextColor="#4B5563"
                value={exitReason}
                onChangeText={setExitReason}
              />

              {error ? (
                <Text className="text-rose-400 text-xs mb-2">{error}</Text>
              ) : null}

              {/* 按钮 */}
              <View className="flex-row" style={{ gap: 8 }}>
                <TouchableOpacity
                  className="flex-1 py-3 rounded-xl items-center bg-gray-800 border border-gray-700"
                  onPress={onClose}
                  activeOpacity={0.7}
                >
                  <Text className="text-sm text-gray-400">取消</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  className="flex-1 py-3 rounded-xl items-center bg-rose-500"
                  onPress={handleClose}
                  disabled={submitting}
                  activeOpacity={0.7}
                >
                  {submitting ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <Text className="text-sm font-bold text-white">确认平仓</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}
