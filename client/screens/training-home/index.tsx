import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, Dimensions } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import {
  loadTrainingData, getRankInfo, generateLevels, type TrainingData,
} from '@/utils/trainingData';
import {
  TrainingOnboarding,
  DEFAULT_ONBOARDING_STEPS,
} from '@/components/onboarding/TrainingOnboarding';

const ONBOARDING_KEY = 'training_onboarded';

const { width: SW } = Dimensions.get('window');

// 颜色
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

export default function TrainingHomeScreen() {
  const router = useSafeRouter();
  const [data, setData] = useState<TrainingData | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);

  const totalLevels = useMemo(() => generateLevels().length, []);

  const checkOnboarding = async () => {
    try {
      const onboarded = await AsyncStorage.getItem(ONBOARDING_KEY);
      if (!onboarded) {
        setShowOnboarding(true);
      }
    } catch (e) {
      console.error('Failed to check onboarding:', e);
    }
  };

  useFocusEffect(useCallback(() => {
    loadTrainingData().then(setData);
    checkOnboarding();
  }, []));

  const handleOnboardingNext = () => {
    if (onboardingStep < DEFAULT_ONBOARDING_STEPS.length - 1) {
      setOnboardingStep(onboardingStep + 1);
    }
  };

  const handleOnboardingSkip = () => {
    completeOnboarding();
  };

  const handleOnboardingComplete = () => {
    completeOnboarding();
  };

  const completeOnboarding = async () => {
    try {
      await AsyncStorage.setItem(ONBOARDING_KEY, 'true');
      setShowOnboarding(false);
    } catch (e) {
      console.error('Failed to save onboarding:', e);
      setShowOnboarding(false);
    }
  };

  const stats = data?.stats;
  const rankInfo = getRankInfo(stats?.xp || 0);

  return (
    <Screen>
      <ScrollView
        style={{ flex: 1, backgroundColor: BG }}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8 }}>
          <Text style={{ color: CYAN, fontSize: 11, letterSpacing: 2, marginBottom: 4 }}>
            BROOKS PRICE ACTION
          </Text>
          <Text style={{ color: TEXT1, fontSize: 24, fontWeight: '700' }}>
            训练中心
          </Text>
        </View>

        {/* Rank Card */}
        <View style={{
          marginHorizontal: 16, marginTop: 12, padding: 16,
          backgroundColor: SURFACE, borderRadius: 12,
          borderWidth: 1, borderColor: BORDER,
        }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <View>
              <Text style={{ color: TEXT2, fontSize: 11, marginBottom: 4 }}>当前段位</Text>
              <Text style={{ color: GOLD, fontSize: 20, fontWeight: '700' }}>
                {rankInfo.title}
              </Text>
              <Text style={{ color: TEXT2, fontSize: 12, marginTop: 2 }}>
                Lv.{rankInfo.rank} · {stats?.xp || 0} XP
              </Text>
            </View>
            <View style={{
              width: 56, height: 56, borderRadius: 28,
              backgroundColor: 'rgba(255,215,0,0.1)',
              borderWidth: 2, borderColor: GOLD,
              justifyContent: 'center', alignItems: 'center',
            }}>
              <FontAwesome6 name="trophy" size={24} color={GOLD} />
            </View>
          </View>
          {/* XP Progress */}
          <View style={{ marginTop: 12 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 }}>
              <Text style={{ color: TEXT2, fontSize: 10 }}>经验进度</Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>
                {rankInfo.currentXP}/{rankInfo.nextXP} XP
              </Text>
            </View>
            <View style={{ height: 4, backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: 2 }}>
              <View style={{
                height: 4, borderRadius: 2,
                width: `${rankInfo.progress * 100}%`,
                backgroundColor: GOLD,
              }} />
            </View>
          </View>
        </View>

        {/* Stats Row */}
        <View style={{
          flexDirection: 'row', marginHorizontal: 16, marginTop: 12, gap: 8,
        }}>
          {[
            { label: '累计收益', value: `${(stats?.totalReturn || 0).toFixed(1)}%`, color: GREEN, icon: 'chart-line' as const },
            { label: '胜率', value: `${(stats?.winRate || 0).toFixed(0)}%`, color: CYAN, icon: 'bullseye' as const },
            { label: '通关', value: `${stats?.levelsCleared || 0}`, color: PURPLE, icon: 'flag-checkered' as const },
            { label: '交易', value: `${stats?.totalTrades || 0}`, color: AMBER, icon: 'repeat' as const },
          ].map((item, i) => (
            <View key={i} style={{
              flex: 1, padding: 12,
              backgroundColor: SURFACE, borderRadius: 10,
              borderWidth: 1, borderColor: BORDER,
              alignItems: 'center',
            }}>
              <FontAwesome6 name={item.icon} size={14} color={item.color} style={{ marginBottom: 6 }} />
              <Text style={{ color: item.color, fontSize: 18, fontWeight: '700', marginBottom: 2 }}>
                {item.value}
              </Text>
              <Text style={{ color: TEXT2, fontSize: 10 }}>{item.label}</Text>
            </View>
          ))}
        </View>

        {/* Entry Cards */}
        <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
          <Text style={{ color: TEXT2, fontSize: 11, letterSpacing: 1, marginBottom: 12 }}>
            训练模块
          </Text>

          {/* 剧情闯关 */}
          <TouchableOpacity
            onPress={() => router.push('/training-levels')}
            style={{
              padding: 20, marginBottom: 12,
              backgroundColor: SURFACE, borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(0,255,136,0.15)',
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: 'rgba(0,255,136,0.1)',
                justifyContent: 'center', alignItems: 'center', marginRight: 16,
              }}>
                <FontAwesome6 name="gamepad" size={22} color={GREEN} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  剧情闯关
                </Text>
                <Text style={{ color: TEXT2, fontSize: 12 }}>
                  {totalLevels}关卡 · 10大品类 · 真实历史K线逐根推演
                </Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={TEXT2} />
            </View>
            <View style={{ flexDirection: 'row', marginTop: 12, gap: 16 }}>
              <Text style={{ color: GREEN, fontSize: 11 }}>
                已通关 {stats?.levelsCleared || 0}/{totalLevels}
              </Text>
              <Text style={{ color: TEXT2, fontSize: 11 }}>
                最佳收益 {((stats?.totalReturn || 0)).toFixed(1)}%
              </Text>
            </View>
          </TouchableOpacity>

          {/* 专项训练 */}
          <TouchableOpacity
            onPress={() => router.push('/training-special')}
            style={{
              padding: 20, marginBottom: 12,
              backgroundColor: SURFACE, borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(191,0,255,0.15)',
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: 'rgba(191,0,255,0.1)',
                justifyContent: 'center', alignItems: 'center', marginRight: 16,
              }}>
                <FontAwesome6 name="dumbbell" size={22} color={PURPLE} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  专项训练
                </Text>
                <Text style={{ color: TEXT2, fontSize: 12 }}>
                  12个专项模块 · 信号识别/量仓/突破/三态/AI方向
                </Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={TEXT2} />
            </View>
          </TouchableOpacity>

          {/* 错题复习 */}
          <TouchableOpacity
            onPress={() => router.push('/training-review')}
            style={{
              padding: 20, marginBottom: 12,
              backgroundColor: SURFACE, borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(255,184,0,0.15)',
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: 'rgba(255,184,0,0.1)',
                justifyContent: 'center', alignItems: 'center', marginRight: 16,
              }}>
                <FontAwesome6 name="rotate-left" size={22} color={AMBER} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  错题复习
                </Text>
                <Text style={{ color: TEXT2, fontSize: 12 }}>
                  艾宾浩斯遗忘曲线 · 智能复习调度
                </Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={TEXT2} />
            </View>
          </TouchableOpacity>

          {/* 训练分析 */}
          <TouchableOpacity
            onPress={() => router.push('/training-analytics')}
            style={{
              padding: 20, marginBottom: 12,
              backgroundColor: SURFACE, borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(0,255,136,0.15)',
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: 'rgba(0,255,136,0.1)',
                justifyContent: 'center', alignItems: 'center', marginRight: 16,
              }}>
                <FontAwesome6 name="chart-line" size={22} color={GREEN} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  训练分析
                </Text>
                <Text style={{ color: TEXT2, fontSize: 12 }}>
                  品类掌握度 · 难度进度 · 弱点识别
                </Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={TEXT2} />
            </View>
          </TouchableOpacity>

          {/* 个人中心 */}
          <TouchableOpacity
            onPress={() => router.push('/training-profile')}
            style={{
              padding: 20,
              backgroundColor: SURFACE, borderRadius: 12,
              borderWidth: 1, borderColor: 'rgba(0,240,255,0.15)',
            }}
            activeOpacity={0.7}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <View style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: 'rgba(0,240,255,0.1)',
                justifyContent: 'center', alignItems: 'center', marginRight: 16,
              }}>
                <FontAwesome6 name="user-shield" size={22} color={CYAN} />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginBottom: 4 }}>
                  个人中心
                </Text>
                <Text style={{ color: TEXT2, fontSize: 12 }}>
                  段位/成绩/成就 · 训练数据总览
                </Text>
              </View>
              <FontAwesome6 name="chevron-right" size={14} color={TEXT2} />
            </View>
          </TouchableOpacity>
        </View>
      </ScrollView>

      {/* 新手引导 */}
      {showOnboarding && (
        <TrainingOnboarding
          visible={showOnboarding}
          steps={DEFAULT_ONBOARDING_STEPS}
          currentStep={onboardingStep}
          onNext={handleOnboardingNext}
          onSkip={handleOnboardingSkip}
          onComplete={handleOnboardingComplete}
        />
      )}
    </Screen>
  );
}
