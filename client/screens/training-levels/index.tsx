import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, FlatList, Dimensions } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  loadTrainingData, generateLevels, DIFFICULTY_LEVELS,
  CATEGORY_VARIETIES, type TrainingData, type LevelProgress,
} from '@/utils/trainingData';

const { width: SW } = Dimensions.get('window');

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const GREEN = '#00FF88';
const PURPLE = '#BF00FF';
const AMBER = '#FFB800';
const GOLD = '#FFD700';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';
const BORDER = 'rgba(0,240,255,0.12)';
const LOCKED = '#2A2A3A';

const CATEGORIES = ['全部', ...Object.keys(CATEGORY_VARIETIES)];

export default function TrainingLevelsScreen() {
  const router = useSafeRouter();
  const [data, setData] = useState<TrainingData | null>(null);
  const [selectedCategory, setSelectedCategory] = useState('全部');
  const [selectedDifficulty, setSelectedDifficulty] = useState<number | null>(null);

  useFocusEffect(useCallback(() => {
    loadTrainingData().then(setData);
  }, []));

  const allLevels = useMemo(() => generateLevels(), []);

  const filteredLevels = useMemo(() => {
    let levels = allLevels;
    if (selectedCategory !== '全部') {
      levels = levels.filter(l => l.category === selectedCategory);
    }
    if (selectedDifficulty !== null) {
      levels = levels.filter(l => l.difficulty === selectedDifficulty);
    }
    return levels;
  }, [allLevels, selectedCategory, selectedDifficulty]);

  // 判断关卡是否解锁: 入门难度全部解锁；高难度需同品类低难度至少通关1关
  const isLevelUnlocked = useCallback((levelId: string, category: string, difficulty: number, _varietyIdx: number): boolean => {
    if (difficulty === 1) return true; // 入门难度全部解锁
    const levels = data?.levels || {};
    // 同品类低难度中是否有已通关的
    const lowerDiffCleared = allLevels.some(
      l => l.category === category && l.difficulty === difficulty - 1 && levels[l.id]?.status === 'cleared'
    );
    return lowerDiffCleared;
  }, [data, allLevels]);

  const getLevelStatus = useCallback((levelId: string, category: string, difficulty: number, varietyIdx: number): 'locked' | 'available' | 'cleared' => {
    if (data?.levels[levelId]?.status === 'cleared') return 'cleared';
    if (isLevelUnlocked(levelId, category, difficulty, varietyIdx)) return 'available';
    return 'locked';
  }, [data, isLevelUnlocked]);

  const renderLevelCard = (level: typeof allLevels[0], index: number) => {
    const sameCatDiff = allLevels.filter(l => l.category === level.category && l.difficulty === level.difficulty);
    const varietyIdx = sameCatDiff.findIndex(l => l.id === level.id);
    const status = getLevelStatus(level.id, level.category, level.difficulty, varietyIdx);
    const progress = data?.levels[level.id];
    const diffInfo = DIFFICULTY_LEVELS[level.difficulty - 1];

    const statusColor = status === 'cleared' ? GREEN : status === 'available' ? CYAN : LOCKED;
    const statusBg = status === 'cleared'
      ? 'rgba(0,255,136,0.08)'
      : status === 'available'
        ? 'rgba(0,240,255,0.06)'
        : 'rgba(42,42,58,0.3)';

    return (
      <TouchableOpacity
        key={level.id}
        onPress={() => {
          if (status === 'locked') return;
          router.push('/training-game', {
            levelId: level.id,
            code: level.variety.code,
            name: level.variety.name,
            category: level.category,
            difficulty: level.difficulty,
            windowStart: level.windowStart,
          });
        }}
        disabled={status === 'locked'}
        style={{
          width: (SW - 48) / 2,
          padding: 12, marginBottom: 10,
          backgroundColor: statusBg,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: status === 'cleared' ? 'rgba(0,255,136,0.2)' : status === 'available' ? BORDER : 'rgba(42,42,58,0.5)',
          opacity: status === 'locked' ? 0.5 : 1,
        }}
        activeOpacity={0.7}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <Text style={{ color: TEXT2, fontSize: 10 }}>
            #{index + 1}
          </Text>
          {status === 'locked' ? (
            <FontAwesome6 name="lock" size={10} color={LOCKED} />
          ) : status === 'cleared' ? (
            <View style={{ flexDirection: 'row', gap: 2 }}>
              {[1, 2, 3].map(s => (
                <FontAwesome6
                  key={s}
                  name="star"
                  size={10}
                  color={s <= (progress?.stars || 0) ? GOLD : 'rgba(255,255,255,0.1)'}
                />
              ))}
            </View>
          ) : (
            <View style={{
              paddingHorizontal: 6, paddingVertical: 2,
              backgroundColor: `${diffInfo.color}20`,
              borderRadius: 4,
            }}>
              <Text style={{ color: diffInfo.color, fontSize: 9, fontWeight: '600' }}>
                {diffInfo.name}
              </Text>
            </View>
          )}
        </View>

        <Text style={{ color: status === 'locked' ? LOCKED : TEXT1, fontSize: 14, fontWeight: '600', marginBottom: 2 }}>
          {level.variety.name}
        </Text>
        <Text style={{ color: TEXT2, fontSize: 10, marginBottom: 4 }}>
          {level.category} · {level.variety.code}
        </Text>
        <Text style={{ color: TEXT2, fontSize: 9 }}>
          窗口 {Math.floor(level.windowStart / 20) + 1}/4 · 60根K线
        </Text>

        {status === 'cleared' && progress && (
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <Text style={{ color: GREEN, fontSize: 10 }}>
              最佳 {progress.bestReturn.toFixed(1)}%
            </Text>
            <Text style={{ color: TEXT2, fontSize: 10 }}>
              {progress.attempts}次
            </Text>
          </View>
        )}
        {status === 'available' && (
          <Text style={{ color: CYAN, fontSize: 10 }}>
            可挑战
          </Text>
        )}
        {status === 'locked' && (
          <Text style={{ color: LOCKED, fontSize: 10 }}>
            未解锁
          </Text>
        )}
      </TouchableOpacity>
    );
  };

  return (
    <Screen>
      <View style={{ flex: 1, backgroundColor: BG }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>剧情闯关</Text>
          </View>
          <Text style={{ color: TEXT2, fontSize: 12, marginLeft: 28 }}>
            真实历史K线 · 逐根推演交易决策
          </Text>
        </View>

        {/* Category Filter */}
        <View style={{ marginTop: 8 }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8, gap: 8 }}
          >
            {CATEGORIES.map(cat => (
              <TouchableOpacity
                key={cat}
                onPress={() => setSelectedCategory(cat)}
                style={{
                  paddingHorizontal: 14, paddingVertical: 6,
                  borderRadius: 16,
                  backgroundColor: selectedCategory === cat ? CYAN : SURFACE,
                  borderWidth: 1,
                  borderColor: selectedCategory === cat ? CYAN : BORDER,
                }}
              >
                <Text style={{
                  color: selectedCategory === cat ? BG : TEXT2,
                  fontSize: 12, fontWeight: selectedCategory === cat ? '600' : '400',
                }}>
                  {cat}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>

        {/* Difficulty Filter */}
        <View style={{ flexDirection: 'row', paddingHorizontal: 16, gap: 8, marginTop: 8 }}>
          <TouchableOpacity
            onPress={() => setSelectedDifficulty(null)}
            style={{
              flex: 1, paddingVertical: 6, alignItems: 'center',
              borderRadius: 8,
              backgroundColor: selectedDifficulty === null ? 'rgba(0,240,255,0.15)' : SURFACE,
              borderWidth: 1, borderColor: selectedDifficulty === null ? CYAN : BORDER,
            }}
          >
            <Text style={{ color: selectedDifficulty === null ? CYAN : TEXT2, fontSize: 11 }}>全部</Text>
          </TouchableOpacity>
          {DIFFICULTY_LEVELS.map(d => (
            <TouchableOpacity
              key={d.id}
              onPress={() => setSelectedDifficulty(selectedDifficulty === d.id ? null : d.id)}
              style={{
                flex: 1, paddingVertical: 6, alignItems: 'center',
                borderRadius: 8,
                backgroundColor: selectedDifficulty === d.id ? `${d.color}20` : SURFACE,
                borderWidth: 1, borderColor: selectedDifficulty === d.id ? d.color : BORDER,
              }}
            >
              <Text style={{ color: selectedDifficulty === d.id ? d.color : TEXT2, fontSize: 11, fontWeight: '600' }}>
                {d.name}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Level count */}
        <View style={{ paddingHorizontal: 16, marginTop: 12, marginBottom: 4 }}>
          <Text style={{ color: TEXT2, fontSize: 11 }}>
            共 {filteredLevels.length} 关
          </Text>
        </View>

        {/* Level Grid */}
        <ScrollView
          contentContainerStyle={{
            paddingHorizontal: 16, paddingBottom: 40,
            flexDirection: 'row', flexWrap: 'wrap',
            justifyContent: 'space-between',
          }}
          showsVerticalScrollIndicator={false}
        >
          {filteredLevels.map((level, i) => renderLevelCard(level, i))}
        </ScrollView>
      </View>
    </Screen>
  );
}
