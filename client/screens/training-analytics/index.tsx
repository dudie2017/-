import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  loadTrainingData, CATEGORY_VARIETIES, DIFFICULTY_LEVELS, generateLevels,
  loadTradeHistory, type TrainingData, type TradeHistoryEntry,
} from '@/utils/trainingData';

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

interface CategoryStat {
  name: string;
  total: number;
  cleared: number;
  avgScore: number;
  avgStars: number;
}

interface DifficultyStat {
  name: string;
  color: string;
  total: number;
  cleared: number;
  avgScore: number;
}

export default function TrainingAnalyticsScreen() {
  const router = useSafeRouter();
  const [data, setData] = useState<TrainingData | null>(null);
  const [tradeHistory, setTradeHistory] = useState<TradeHistoryEntry[]>([]);

  useFocusEffect(useCallback(() => {
    loadTrainingData().then(setData);
    loadTradeHistory().then(setTradeHistory);
  }, []));

  // 全部关卡（用于统计总关卡数）
  const allLevels = useMemo(() => generateLevels(), []);

  // 分类统计
  const categoryStats = useMemo<CategoryStat[]>(() => {
    if (!data) return [];
    const levels = Object.values(data.levels);
    const result: CategoryStat[] = [];

    for (const [catName, varieties] of Object.entries(CATEGORY_VARIETIES)) {
      const codes = varieties.map(v => v.code);
      const catLevels = levels.filter(l => codes.includes(l.varietyCode));
      const cleared = catLevels.filter(l => l.status === 'cleared');
      const totalInCat = allLevels.filter(l => l.category === catName).length;
      const avgScore = cleared.length > 0
        ? Math.round(cleared.reduce((s, l) => s + l.bestScore, 0) / cleared.length)
        : 0;
      const avgStars = cleared.length > 0
        ? Math.round(cleared.reduce((s, l) => s + l.stars, 0) / cleared.length * 10) / 10
        : 0;

      result.push({
        name: catName,
        total: totalInCat,
        cleared: cleared.length,
        avgScore,
        avgStars,
      });
    }
    return result.sort((a, b) => b.cleared - a.cleared);
  }, [data, allLevels]);

  // 难度统计
  const difficultyStats = useMemo<DifficultyStat[]>(() => {
    if (!data) return [];
    const levels = Object.values(data.levels);

    return DIFFICULTY_LEVELS.map(diff => {
      const diffLevels = levels.filter(l => l.difficulty === diff.id);
      const cleared = diffLevels.filter(l => l.status === 'cleared');
      const totalInDiff = allLevels.filter(l => l.difficulty === diff.id).length;
      const avgScore = cleared.length > 0
        ? Math.round(cleared.reduce((s, l) => s + l.bestScore, 0) / cleared.length)
        : 0;

      return {
        name: diff.name,
        color: diff.color,
        total: totalInDiff,
        cleared: cleared.length,
        avgScore,
      };
    });
  }, [data, allLevels]);

  // 最近通关
  const recentCleared = useMemo(() => {
    if (!data) return [];
    return Object.values(data.levels)
      .filter(l => l.status === 'cleared' && l.lastPlayTime)
      .sort((a, b) => new Date(b.lastPlayTime!).getTime() - new Date(a.lastPlayTime!).getTime())
      .slice(0, 10);
  }, [data]);

  // 弱点分析
  const weakness = useMemo(() => {
    if (!data) return [];
    const levels = Object.values(data.levels);
    const catScores: Record<string, { total: number; count: number }> = {};

    levels.filter(l => l.status === 'cleared').forEach(l => {
      if (!catScores[l.category]) {
        catScores[l.category] = { total: 0, count: 0 };
      }
      catScores[l.category].total += l.bestScore;
      catScores[l.category].count += 1;
    });

    return Object.entries(catScores)
      .map(([cat, { total, count }]) => ({
        category: cat,
        avgScore: Math.round(total / count),
      }))
      .filter(c => c.avgScore < 70)
      .sort((a, b) => a.avgScore - b.avgScore)
      .slice(0, 3);
  }, [data]);

  // 总完成率
  const totalCompletion = useMemo(() => {
    if (!data) return 0;
    if (allLevels.length === 0) return 0;
    const levels = Object.values(data.levels);
    const cleared = levels.filter(l => l.status === 'cleared').length;
    return Math.round((cleared / allLevels.length) * 100);
  }, [data, allLevels]);

  return (
    <Screen>
      <ScrollView style={{ flex: 1, backgroundColor: BG }} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>训练分析</Text>
          </View>
        </View>

        {/* Overall Completion */}
        <View style={{
          marginHorizontal: 16, padding: 20,
          backgroundColor: SURFACE, borderRadius: 16,
          borderWidth: 1, borderColor: 'rgba(0,240,255,0.2)',
        }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            总体完成度
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', marginBottom: 8 }}>
            <Text style={{ color: CYAN, fontSize: 42, fontWeight: '700' }}>{totalCompletion}</Text>
            <Text style={{ color: TEXT2, fontSize: 16, marginLeft: 4 }}>%</Text>
          </View>
          <View style={{ height: 6, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 3 }}>
            <View style={{
              height: 6, borderRadius: 3,
              width: `${totalCompletion}%`,
              backgroundColor: CYAN,
            }} />
          </View>
          <Text style={{ color: TEXT2, fontSize: 10, marginTop: 6 }}>
            {data?.stats.levelsCleared || 0} / {allLevels.length} 关已通关
          </Text>
        </View>

        {/* Difficulty Breakdown */}
        <View style={{
          marginHorizontal: 16, marginTop: 16, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            难度进度
          </Text>
          {difficultyStats.map(diff => (
            <View key={diff.name} style={{ marginBottom: 12 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
                <Text style={{ color: diff.color, fontSize: 13, fontWeight: '600' }}>{diff.name}</Text>
                <Text style={{ color: TEXT2, fontSize: 11 }}>
                  {diff.cleared}/{diff.total} · 平均{diff.avgScore}分
                </Text>
              </View>
              <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                <View style={{
                  height: 4, borderRadius: 2,
                  width: `${diff.total > 0 ? (diff.cleared / diff.total) * 100 : 0}%`,
                  backgroundColor: diff.color,
                }} />
              </View>
            </View>
          ))}
        </View>

        {/* Category Breakdown */}
        <View style={{
          marginHorizontal: 16, marginTop: 16, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            品类掌握度
          </Text>
          {categoryStats.map(cat => {
            const pct = cat.total > 0 ? (cat.cleared / cat.total) * 100 : 0;
            const color = pct >= 80 ? GREEN : pct >= 50 ? CYAN : pct >= 20 ? AMBER : TEXT2;
            return (
              <View key={cat.name} style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: 8,
                borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)',
              }}>
                <Text style={{ color: TEXT1, fontSize: 12, width: 60 }}>{cat.name}</Text>
                <View style={{ flex: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2, marginHorizontal: 8 }}>
                  <View style={{
                    height: 4, borderRadius: 2,
                    width: `${pct}%`,
                    backgroundColor: color,
                  }} />
                </View>
                <Text style={{ color, fontSize: 11, width: 50, textAlign: 'right' }}>
                  {cat.cleared}/{cat.total}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Weakness */}
        {weakness.length > 0 && (
          <View style={{
            marginHorizontal: 16, marginTop: 16, padding: 16,
            backgroundColor: SURFACE, borderRadius: 12,
            borderWidth: 1, borderColor: 'rgba(255,0,60,0.15)',
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <FontAwesome6 name="triangle-exclamation" size={12} color={RED} />
              <Text style={{ color: RED, fontSize: 11, letterSpacing: 1, marginLeft: 8 }}>
                待提升领域
              </Text>
            </View>
            {weakness.map(w => (
              <View key={w.category} style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingVertical: 6,
              }}>
                <Text style={{ color: TEXT1, fontSize: 13 }}>{w.category}</Text>
                <Text style={{ color: RED, fontSize: 13, fontWeight: '600' }}>
                  {w.avgScore}分
                </Text>
              </View>
            ))}
            <Text style={{ color: TEXT2, fontSize: 10, marginTop: 8, lineHeight: 14 }}>
              这些品类的平均得分低于70分，建议重点练习相关品种
            </Text>
          </View>
        )}

        {/* Recent Cleared */}
        {recentCleared.length > 0 && (
          <View style={{
            marginHorizontal: 16, marginTop: 16, padding: 16,
            backgroundColor: SURFACE, borderRadius: 12,
            borderWidth: 1, borderColor: BORDER,
          }}>
            <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
              最近通关
            </Text>
            {recentCleared.map(level => {
              const diffInfo = DIFFICULTY_LEVELS.find(d => d.id === level.difficulty);
              return (
                <View key={level.levelId} style={{
                  flexDirection: 'row', alignItems: 'center',
                  paddingVertical: 8,
                  borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)',
                }}>
                  <View style={{
                    width: 32, height: 32, borderRadius: 8,
                    backgroundColor: 'rgba(255,215,0,0.1)',
                    alignItems: 'center', justifyContent: 'center',
                    marginRight: 10,
                  }}>
                    <FontAwesome6 name="trophy" size={12} color={GOLD} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: TEXT1, fontSize: 13 }}>
                      {level.varietyCode}
                    </Text>
                    <Text style={{ color: TEXT2, fontSize: 10 }}>
                      {diffInfo?.name || `难度${level.difficulty}`} · {level.category}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text style={{ color: GOLD, fontSize: 14, fontWeight: '700' }}>
                      {level.bestScore}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 2 }}>
                      {[1, 2, 3].map(s => (
                        <FontAwesome6
                          key={s}
                          name="star"
                          size={8}
                          color={s <= level.stars ? GOLD : 'rgba(255,255,255,0.1)'}
                        />
                      ))}
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

        {/* 交易历史（信号验证） */}
        {tradeHistory.length > 0 && (
          <View style={{
            marginHorizontal: 16, marginTop: 12, padding: 16,
            backgroundColor: SURFACE, borderRadius: 12, borderWidth: 1, borderColor: BORDER,
          }}>
            <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
              近期交易记录
            </Text>
            {/* 信号对齐统计 */}
            {(() => {
              const aligned = tradeHistory.filter(t => t.alwaysInAligned).length;
              const alignedPct = Math.round((aligned / tradeHistory.length) * 100);
              const avgScore = Math.round(tradeHistory.reduce((s, t) => s + t.signalScore, 0) / tradeHistory.length);
              return (
                <View style={{ flexDirection: 'row', gap: 12, marginBottom: 14 }}>
                  <View style={{ flex: 1, alignItems: 'center', padding: 10, backgroundColor: 'rgba(0,240,255,0.04)', borderRadius: 8 }}>
                    <Text style={{ color: CYAN, fontSize: 20, fontWeight: '700' }}>{alignedPct}%</Text>
                    <Text style={{ color: TEXT2, fontSize: 9, marginTop: 2 }}>Always In对齐率</Text>
                  </View>
                  <View style={{ flex: 1, alignItems: 'center', padding: 10, backgroundColor: 'rgba(255,184,0,0.04)', borderRadius: 8 }}>
                    <Text style={{ color: AMBER, fontSize: 20, fontWeight: '700' }}>{avgScore}</Text>
                    <Text style={{ color: TEXT2, fontSize: 9, marginTop: 2 }}>平均信号分</Text>
                  </View>
                  <View style={{ flex: 1, alignItems: 'center', padding: 10, backgroundColor: 'rgba(0,255,136,0.04)', borderRadius: 8 }}>
                    <Text style={{ color: GREEN, fontSize: 20, fontWeight: '700' }}>
                      {tradeHistory.filter(t => t.pnl > 0).length}
                    </Text>
                    <Text style={{ color: TEXT2, fontSize: 9, marginTop: 2 }}>盈利次数</Text>
                  </View>
                </View>
              );
            })()}
            {tradeHistory.slice(0, 8).map(t => (
              <View key={t.id} style={{
                flexDirection: 'row', alignItems: 'center',
                paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.04)',
              }}>
                <View style={{
                  width: 32, height: 32, borderRadius: 8,
                  backgroundColor: t.direction === 'long' ? 'rgba(255,0,60,0.1)' : 'rgba(0,255,136,0.1)',
                  alignItems: 'center', justifyContent: 'center', marginRight: 10,
                }}>
                  <FontAwesome6
                    name={t.direction === 'long' ? 'arrow-up' : 'arrow-down'}
                    size={12}
                    color={t.direction === 'long' ? RED : GREEN}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: TEXT1, fontSize: 13 }}>{t.varietyName}</Text>
                  <Text style={{ color: TEXT2, fontSize: 10 }}>
                    信号{t.signalScore}分({t.signalGrade}级) · {t.alwaysInAligned ? '顺势' : '逆势'}
                  </Text>
                </View>
                <Text style={{
                  color: t.pnl > 0 ? RED : GREEN,
                  fontSize: 14, fontWeight: '600',
                }}>
                  {t.pnl > 0 ? '+' : ''}{t.pnl.toFixed(1)}
                </Text>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
