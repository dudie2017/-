import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, TextInput, Dimensions, Alert } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadTrainingData, getRankInfo, SPECIAL_TRAINING_MODULES, generateLevels,
  loadTradeHistory, type TrainingData, type TradeHistoryEntry,
} from '@/utils/trainingData';

const { width: SW } = Dimensions.get('window');
const NICKNAME_KEY = '@brooks_user_nickname';

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const PURPLE = '#BF00FF';
const GREEN = '#00FF88';
const RED = '#FF003C';
const AMBER = '#FFB800';
const GOLD = '#FFD700';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';
const BORDER = 'rgba(0,240,255,0.12)';

export default function TrainingProfileScreen() {
  const router = useSafeRouter();
  const [data, setData] = useState<TrainingData | null>(null);
  const [nickname, setNickname] = useState('交易者');
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryEntry[]>([]);

  const totalLevels = useMemo(() => generateLevels().length, []);

  useFocusEffect(useCallback(() => {
    loadTrainingData().then(setData);
    loadTradeHistory().then(setTradeHistory);
    AsyncStorage.getItem(NICKNAME_KEY).then(val => {
      if (val) setNickname(val);
    });
  }, []));

  const handleSaveNickname = useCallback(async () => {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      Alert.alert('提示', '昵称不能为空');
      return;
    }
    setNickname(trimmed);
    setEditingName(false);
    await AsyncStorage.setItem(NICKNAME_KEY, trimmed);
  }, [nameInput]);

  const stats = data?.stats;
  const rankInfo = getRankInfo(stats?.xp || 0);
  const achievements = data?.achievements || [];
  const unlockedCount = achievements.filter(a => a.unlocked).length;

  // 信号对齐率
  const alignedCount = tradeHistory.filter(t => t.alwaysInAligned).length;
  const alignedPct = tradeHistory.length > 0 ? Math.round((alignedCount / tradeHistory.length) * 100) : 0;
  const avgSignalScore = tradeHistory.length > 0
    ? Math.round(tradeHistory.reduce((s, t) => s + t.signalScore, 0) / tradeHistory.length)
    : 0;

  return (
    <Screen>
      <ScrollView style={{ flex: 1, backgroundColor: BG }} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>个人中心</Text>
          </View>
        </View>

        {/* Rank Card */}
        <View style={{
          marginHorizontal: 16, padding: 20,
          backgroundColor: SURFACE, borderRadius: 16,
          borderWidth: 1, borderColor: 'rgba(255,215,0,0.2)',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
            <View style={{
              width: 64, height: 64, borderRadius: 32,
              backgroundColor: 'rgba(255,215,0,0.1)',
              borderWidth: 2, borderColor: GOLD,
              justifyContent: 'center', alignItems: 'center',
              marginRight: 16,
            }}>
              <Text style={{ color: GOLD, fontSize: 24, fontWeight: '700' }}>
                {rankInfo.rank}
              </Text>
            </View>
            <View style={{ flex: 1 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {editingName ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                    <TextInput
                      style={{
                        color: TEXT1, fontSize: 16, fontWeight: '600',
                        backgroundColor: 'rgba(255,255,255,0.06)',
                        borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4,
                        flex: 1, maxWidth: 140,
                      }}
                      value={nameInput}
                      onChangeText={setNameInput}
                      placeholder="输入昵称"
                      placeholderTextColor={TEXT2}
                      maxLength={12}
                      autoFocus
                    />
                    <TouchableOpacity onPress={handleSaveNickname}>
                      <FontAwesome6 name="check" size={14} color={GREEN} />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => setEditingName(false)}>
                      <FontAwesome6 name="xmark" size={14} color={RED} />
                    </TouchableOpacity>
                  </View>
                ) : (
                  <>
                    <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600' }}>{nickname}</Text>
                    <TouchableOpacity onPress={() => { setNameInput(nickname); setEditingName(true); }}>
                      <FontAwesome6 name="pen" size={10} color={TEXT2} />
                    </TouchableOpacity>
                  </>
                )}
              </View>
              <Text style={{ color: GOLD, fontSize: 20, fontWeight: '700', marginTop: 2 }}>
                {rankInfo.title}
              </Text>
              <Text style={{ color: TEXT2, fontSize: 12, marginTop: 2 }}>
                段位等级 {rankInfo.rank}/20 · 总经验 {stats?.xp || 0} XP
              </Text>
            </View>
          </View>

          {/* XP Progress */}
          <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>
            <View style={{
              height: 6, borderRadius: 3,
              width: `${rankInfo.progress * 100}%`,
              backgroundColor: GOLD,
            }} />
          </View>
          <Text style={{ color: TEXT2, fontSize: 10, marginTop: 4 }}>
            距下一级还需 {rankInfo.nextXP - rankInfo.currentXP} XP
          </Text>
        </View>

        {/* Trading Stats */}
        <View style={{
          marginHorizontal: 16, marginTop: 16, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            交易数据
          </Text>
          <View style={{ flexDirection: 'row', gap: 12 }}>
            {[
              { label: '累计收益', value: `${(stats?.totalReturn || 0).toFixed(1)}%`, color: GREEN },
              { label: '胜率', value: `${(stats?.winRate || 0).toFixed(0)}%`, color: CYAN },
              { label: '总交易', value: `${stats?.totalTrades || 0}`, color: TEXT1 },
              { label: '总正确', value: `${stats?.totalCorrect || 0}`, color: GREEN },
            ].map((item, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ color: item.color, fontSize: 18, fontWeight: '700', marginBottom: 4 }}>
                  {item.value}
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10 }}>{item.label}</Text>
              </View>
            ))}
          </View>
          <View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}>
            {[
              { label: '通关数', value: `${stats?.levelsCleared || 0}/${totalLevels}`, color: PURPLE },
              { label: '当前连胜', value: `${stats?.consecutiveCorrect || 0}`, color: AMBER },
              { label: '最大连胜', value: `${stats?.maxConsecutiveCorrect || 0}`, color: GOLD },
              { label: '正确率', value: `${(stats?.totalTrades ?? 0) > 0 ? Math.round(((stats?.totalCorrect ?? 0) / (stats?.totalTrades ?? 1)) * 100) : 0}%`, color: CYAN },
            ].map((item, i) => (
              <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                <Text style={{ color: item.color, fontSize: 18, fontWeight: '700', marginBottom: 4 }}>
                  {item.value}
                </Text>
                <Text style={{ color: TEXT2, fontSize: 10 }}>{item.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Signal Accuracy Stats */}
        {tradeHistory.length > 0 && (
          <View style={{
            marginHorizontal: 16, marginTop: 16, padding: 16,
            backgroundColor: SURFACE, borderRadius: 12,
            borderWidth: 1, borderColor: BORDER,
          }}>
            <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
              信号质量
            </Text>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {[
                { label: 'Always In对齐率', value: `${alignedPct}%`, color: CYAN, desc: '顺势交易比例' },
                { label: '平均信号分', value: `${avgSignalScore}`, color: AMBER, desc: '入场信号质量' },
                { label: '总交易记录', value: `${tradeHistory.length}`, color: TEXT1, desc: '历史交易笔数' },
              ].map((item, i) => (
                <View key={i} style={{ flex: 1, alignItems: 'center' }}>
                  <Text style={{ color: item.color, fontSize: 22, fontWeight: '700', marginBottom: 4 }}>
                    {item.value}
                  </Text>
                  <Text style={{ color: TEXT1, fontSize: 11, marginBottom: 2 }}>{item.label}</Text>
                  <Text style={{ color: TEXT2, fontSize: 9 }}>{item.desc}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* Special Training Scores */}
        <View style={{
          marginHorizontal: 16, marginTop: 16, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            专项训练成绩
          </Text>
          {SPECIAL_TRAINING_MODULES.map(mod => {
            const progress = data?.specialTraining[mod.id];
            const score = progress?.bestScore || 0;
            const total = progress?.totalCount || 0;

            return (
              <View key={mod.id} style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: 8,
                borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)',
              }}>
                <Text style={{ color: TEXT1, fontSize: 12, flex: 1 }}>{mod.name}</Text>
                {total > 0 ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <View style={{ width: 60, height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                      <View style={{
                        height: 4, borderRadius: 2,
                        width: `${score}%`,
                        backgroundColor: score >= 80 ? GREEN : score >= 60 ? CYAN : AMBER,
                      }} />
                    </View>
                    <Text style={{
                      color: score >= 80 ? GREEN : score >= 60 ? CYAN : AMBER,
                      fontSize: 12, fontWeight: '600', width: 36, textAlign: 'right',
                    }}>
                      {score}%
                    </Text>
                  </View>
                ) : (
                  <Text style={{ color: TEXT2, fontSize: 11 }}>未开始</Text>
                )}
              </View>
            );
          })}
        </View>

        {/* Achievements */}
        <View style={{
          marginHorizontal: 16, marginTop: 16, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1 }}>
              成就
            </Text>
            <Text style={{ color: TEXT2, fontSize: 11 }}>
              {unlockedCount}/{achievements.length}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {achievements.map(ach => (
              <View
                key={ach.id}
                style={{
                  width: (SW - 72) / 3,
                  padding: 10,
                  backgroundColor: ach.unlocked ? 'rgba(255,215,0,0.06)' : 'rgba(255,255,255,0.02)',
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: ach.unlocked ? 'rgba(255,215,0,0.2)' : 'rgba(255,255,255,0.04)',
                  alignItems: 'center',
                  opacity: ach.unlocked ? 1 : 0.4,
                }}
              >
                <View style={{ marginBottom: 4 }}>
                  {ach.unlocked ? (
                    <FontAwesome6
                      name={ach.icon as any}
                      size={22}
                      color={GOLD}
                    />
                  ) : (
                    <FontAwesome6 name="lock" size={22} color={TEXT2} />
                  )}
                </View>
                <Text style={{ color: ach.unlocked ? GOLD : TEXT2, fontSize: 10, textAlign: 'center', fontWeight: '500' }}>
                  {ach.name}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
