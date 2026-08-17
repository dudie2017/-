import React, { useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  loadTrainingData, SPECIAL_TRAINING_MODULES, type TrainingData,
} from '@/utils/trainingData';

const { width: SW } = Dimensions.get('window');

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const PURPLE = '#BF00FF';
const GREEN = '#00FF88';
const AMBER = '#FFB800';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';
const BORDER = 'rgba(0,240,255,0.12)';

export default function TrainingSpecialScreen() {
  const router = useSafeRouter();
  const [data, setData] = useState<TrainingData | null>(null);

  useFocusEffect(useCallback(() => {
    loadTrainingData().then(setData);
  }, []));

  const getModuleProgress = (moduleId: string) => {
    const p = data?.specialTraining[moduleId];
    if (!p) return { correct: 0, total: 0, score: 0 };
    return {
      correct: p.correctCount,
      total: p.totalCount,
      score: p.bestScore,
    };
  };

  return (
    <Screen backgroundColor={BG} statusBarStyle="light">
      <View style={{ flex: 1, backgroundColor: BG }}>
        {/* Header */}
        <View style={{ paddingHorizontal: 16, paddingTop: 16, paddingBottom: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={PURPLE} />
            </TouchableOpacity>
            <Text style={{ color: TEXT1, fontSize: 20, fontWeight: '700' }}>专项训练</Text>
          </View>
          <Text style={{ color: TEXT2, fontSize: 12, marginLeft: 28 }}>
            12个训练模块 · 针对性提升交易技能
          </Text>
        </View>

        {/* Module List */}
        <ScrollView
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
          showsVerticalScrollIndicator={false}
        >
          {SPECIAL_TRAINING_MODULES.map((mod, i) => {
            const progress = getModuleProgress(mod.id);
            const hasProgress = progress.total > 0;
            const scoreColor = progress.score >= 80 ? GREEN : progress.score >= 60 ? CYAN : progress.score > 0 ? AMBER : TEXT2;

            return (
              <TouchableOpacity
                key={mod.id}
                onPress={() => {
                  if (mod.id === 'error_review') {
                    router.push('/training-review');
                    return;
                  }
                  router.push(`/training-quiz?moduleId=${mod.id}&moduleName=${encodeURIComponent(mod.name)}&moduleColor=${encodeURIComponent(mod.color)}`);
                }}
                style={{
                  padding: 16, marginBottom: 10,
                  backgroundColor: SURFACE, borderRadius: 12,
                  borderWidth: 1, borderColor: `${mod.color}25`,
                }}
                activeOpacity={0.7}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  {/* Icon */}
                  <View style={{
                    width: 44, height: 44, borderRadius: 12,
                    backgroundColor: `${mod.color}15`,
                    justifyContent: 'center', alignItems: 'center',
                    marginRight: 14,
                  }}>
                    <FontAwesome6
                      name={getModuleIcon(mod.id)}
                      size={18}
                      color={mod.color}
                    />
                  </View>

                  {/* Content */}
                  <View style={{ flex: 1 }}>
                    <Text style={{ color: TEXT1, fontSize: 15, fontWeight: '600', marginBottom: 3 }}>
                      {mod.name}
                    </Text>
                    <Text style={{ color: TEXT2, fontSize: 11, marginBottom: 6 }} numberOfLines={1}>
                      {mod.desc}
                    </Text>

                    {/* Progress */}
                    {hasProgress ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                        <Text style={{ color: scoreColor, fontSize: 11, fontWeight: '600' }}>
                          最佳 {progress.score}%
                        </Text>
                        <Text style={{ color: TEXT2, fontSize: 10 }}>
                          {progress.correct}/{progress.total} 正确
                        </Text>
                        {/* Mini progress bar */}
                        <View style={{ flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
                          <View style={{
                            height: 3, borderRadius: 2,
                            width: `${Math.min(progress.score, 100)}%`,
                            backgroundColor: mod.color,
                          }} />
                        </View>
                      </View>
                    ) : (
                      <Text style={{ color: TEXT2, fontSize: 11 }}>
                        {mod.questionCount} 题 · 未开始
                      </Text>
                    )}
                  </View>

                  <FontAwesome6 name="chevron-right" size={12} color={TEXT2} style={{ marginLeft: 8 }} />
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>
    </Screen>
  );
}

function getModuleIcon(moduleId: string): keyof typeof FontAwesome6.glyphMap {
  const iconMap: Record<string, keyof typeof FontAwesome6.glyphMap> = {
    signal_bar: 'crosshairs',
    volume_oi: 'chart-bar',
    breakout: 'bolt',
    market_state: 'arrows-rotate',
    always_in: 'compass',
    stop_loss: 'shield-halved',
    basic_patterns: 'chart-line',
    pullback: 'rotate-left',
    error_review: 'clipboard-list',
    socratic: 'brain',
    radar_v16: 'satellite-dish',
    variety_traits: 'masks-theater',
  };
  return iconMap[moduleId] || 'circle';
}
