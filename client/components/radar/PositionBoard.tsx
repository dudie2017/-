import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { fetchTrades, TradeRecord } from '@/utils/api';

interface PositionBoardProps {
  scanData: Map<string, any>; // variety_code → scan row data
  onClosePosition: (trade: TradeRecord) => void;
  onRegisterPosition?: () => void; // 登记持仓按钮回调
}

export default function PositionBoard({ scanData, onClosePosition, onRegisterPosition }: PositionBoardProps) {
  const [positions, setPositions] = useState<TradeRecord[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);

  useFocusEffect(
    useCallback(() => {
      loadPositions();
    }, [])
  );

  const loadPositions = async () => {
    try {
      setLoading(true);
      const { trades } = await fetchTrades('open');
      setPositions(trades);
    } catch (e) {
      console.warn('加载持仓失败:', e);
    } finally {
      setLoading(false);
    }
  };

  // 即使无持仓也显示看板（方便登记新持仓）
  if (loading) return null;

  return (
    <View className="mb-4">
      <TouchableOpacity
        className="flex-row items-center justify-between py-3 px-1"
        onPress={() => setCollapsed(!collapsed)}
        activeOpacity={0.7}
      >
        <View className="flex-row items-center">
          <FontAwesome6 name="chart-line" size={16} color="#00E5FF" style={{ marginRight: 8 }} />
          <Text className="text-base font-semibold text-cyan-400">
            持仓 ({positions.length})
          </Text>
        </View>
        <View className="flex-row items-center" style={{ gap: 12 }}>
          {onRegisterPosition && (
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); onRegisterPosition(); }}
              activeOpacity={0.7}
              className="flex-row items-center bg-cyan-500/10 px-2.5 py-1 rounded-lg border border-cyan-500/30"
            >
              <FontAwesome6 name="plus" size={10} color="#00E5FF" style={{ marginRight: 4 }} />
              <Text className="text-xs font-semibold text-cyan-400">登记</Text>
            </TouchableOpacity>
          )}
          <FontAwesome6
            name={collapsed ? 'chevron-down' : 'chevron-up'}
            size={14}
            color="#6B7280"
          />
        </View>
      </TouchableOpacity>

      {!collapsed && (
        <View style={{ gap: 8 }}>
          {positions.map((pos) => {
            const row = scanData.get(pos.variety_code);
            const currentPrice = row?.close ?? pos.open_price;
            const pnl = pos.direction === 'long'
              ? (currentPrice - pos.open_price) * pos.open_quantity
              : (pos.open_price - currentPrice) * pos.open_quantity;
            const pnlPct = pos.open_price > 0
              ? ((pos.direction === 'long'
                ? (currentPrice - pos.open_price)
                : (pos.open_price - currentPrice)) / pos.open_price * 100)
              : 0;
            const isProfit = pnl >= 0;

            return (
              <TouchableOpacity
                key={pos.id}
                className="bg-gray-800/60 rounded-xl p-3 border border-gray-700/50"
                activeOpacity={0.7}
                onPress={() => onClosePosition(pos)}
              >
                <View className="flex-row items-center justify-between">
                  {/* 左侧信息 */}
                  <View className="flex-1 mr-3">
                    <View className="flex-row items-center mb-1">
                      <Text className="text-sm font-semibold text-gray-200">
                        {pos.variety_code} {pos.variety_name}
                      </Text>
                      <View className={`ml-2 px-1.5 py-0.5 rounded ${
                        pos.direction === 'long' ? 'bg-emerald-500/15' : 'bg-rose-500/15'
                      }`}>
                        <Text className={`text-xs font-semibold ${
                          pos.direction === 'long' ? 'text-emerald-400' : 'text-rose-400'
                        }`}>
                          {pos.direction === 'long' ? '多' : '空'}
                        </Text>
                      </View>
                    </View>
                    <View className="flex-row items-center gap-3">
                      <Text className="text-xs text-gray-400">
                        入场 <Text className="text-gray-300 font-mono">{pos.open_price}</Text>
                      </Text>
                      <Text className="text-xs text-gray-400">
                        现价 <Text className="text-gray-300 font-mono">{currentPrice}</Text>
                      </Text>
                    </View>
                  </View>
                  {/* 右侧盈亏+平仓 */}
                  <View className="items-end">
                    <Text className={`text-base font-mono font-bold ${
                      isProfit ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      {isProfit ? '+' : ''}{pnl.toFixed(0)}
                    </Text>
                    <Text className={`text-xs ${
                      isProfit ? 'text-emerald-500' : 'text-rose-500'
                    }`}>
                      {isProfit ? '+' : ''}{pnlPct.toFixed(2)}%
                    </Text>
                    <TouchableOpacity
                      className="mt-1.5 bg-rose-500/15 rounded-lg px-2.5 py-1"
                      onPress={(e) => {
                        e.stopPropagation?.();
                        onClosePosition(pos);
                      }}
                      activeOpacity={0.6}
                    >
                      <Text className="text-xs text-rose-400 font-semibold">平仓</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}
