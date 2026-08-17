import React, { useEffect, useState } from 'react';
import {
  View, Text, TouchableOpacity, Modal, Animated, Dimensions,
} from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';

const { width: SW, height: SH } = Dimensions.get('window');

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const GREEN = '#00FF88';
const PURPLE = '#BF00FF';
const GOLD = '#FFD700';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';

export interface OnboardingStep {
  title: string;
  description: string;
  icon: string;
  iconColor: string;
  position?: 'top' | 'center' | 'bottom';
  highlight?: { x: number; y: number; width: number; height: number };
}

interface Props {
  visible: boolean;
  steps: OnboardingStep[];
  currentStep: number;
  onNext: () => void;
  onSkip: () => void;
  onComplete: () => void;
}

export function TrainingOnboarding({
  visible,
  steps,
  currentStep,
  onNext,
  onSkip,
  onComplete,
}: Props) {
  const [fadeAnim] = useState(() => new Animated.Value(0));
  const [slideAnim] = useState(() => new Animated.Value(30));

  useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(fadeAnim, {
          toValue: 1,
          duration: 300,
          useNativeDriver: true,
        }),
        Animated.spring(slideAnim, {
          toValue: 0,
          friction: 8,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible, currentStep]);

  if (!visible || currentStep >= steps.length) return null;

  const step = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  const getPositionStyle = () => {
    switch (step.position) {
      case 'top':
        return { justifyContent: 'flex-start' as const, paddingTop: 100 };
      case 'bottom':
        return { justifyContent: 'flex-end' as const, paddingBottom: 100 };
      default:
        return { justifyContent: 'center' as const };
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none">
      <Animated.View
        style={{
          flex: 1,
          backgroundColor: 'rgba(0,0,0,0.85)',
          opacity: fadeAnim,
        }}
      >
        {/* 高亮区域 */}
        {step.highlight && (
          <View
            style={{
              position: 'absolute',
              left: step.highlight.x - 8,
              top: step.highlight.y - 8,
              width: step.highlight.width + 16,
              height: step.highlight.height + 16,
              borderRadius: 12,
              borderWidth: 2,
              borderColor: CYAN,
              boxShadow: '0px 0px 20px rgba(0,240,255,0.5)',
            }}
          />
        )}

        {/* 内容区域 */}
        <View style={[{ flex: 1, padding: 24 }, getPositionStyle()]}>
          <Animated.View
            style={{
              transform: [{ translateY: slideAnim }],
              opacity: fadeAnim,
            }}
          >
            {/* 图标 */}
            <View style={{ alignItems: 'center', marginBottom: 24 }}>
              <View
                style={{
                  width: 80,
                  height: 80,
                  borderRadius: 40,
                  backgroundColor: `${step.iconColor}15`,
                  borderWidth: 2,
                  borderColor: step.iconColor,
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <FontAwesome6 name={step.icon as any} size={32} color={step.iconColor} />
              </View>
            </View>

            {/* 标题和描述 */}
            <View style={{ alignItems: 'center', marginBottom: 32 }}>
              <Text
                style={{
                  color: TEXT1,
                  fontSize: 24,
                  fontWeight: '700',
                  textAlign: 'center',
                  marginBottom: 12,
                }}
              >
                {step.title}
              </Text>
              <Text
                style={{
                  color: TEXT2,
                  fontSize: 15,
                  textAlign: 'center',
                  lineHeight: 24,
                  paddingHorizontal: 20,
                }}
              >
                {step.description}
              </Text>
            </View>

            {/* 步骤指示器 */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                marginBottom: 32,
                gap: 8,
              }}
            >
              {steps.map((_, index) => (
                <View
                  key={index}
                  style={{
                    width: index === currentStep ? 24 : 8,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: index === currentStep ? CYAN : 'rgba(255,255,255,0.2)',
                  }}
                />
              ))}
            </View>

            {/* 按钮 */}
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {!isLastStep && (
                <TouchableOpacity
                  onPress={onSkip}
                  style={{
                    flex: 1,
                    paddingVertical: 14,
                    borderRadius: 12,
                    borderWidth: 1,
                    borderColor: 'rgba(255,255,255,0.2)',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: TEXT2, fontSize: 15, fontWeight: '600' }}>
                    跳过
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={isLastStep ? onComplete : onNext}
                style={{
                  flex: isLastStep ? 1 : 2,
                  paddingVertical: 14,
                  borderRadius: 12,
                  backgroundColor: CYAN,
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: BG, fontSize: 15, fontWeight: '700' }}>
                  {isLastStep ? '开始训练' : '下一步'}
                </Text>
              </TouchableOpacity>
            </View>
          </Animated.View>
        </View>
      </Animated.View>
    </Modal>
  );
}

// 默认引导步骤
export const DEFAULT_ONBOARDING_STEPS: OnboardingStep[] = [
  {
    title: '欢迎来到训练中心',
    description: '在这里，你将通过真实历史K线数据，学习 Brooks Price Action 交易体系，提升你的交易技能。',
    icon: 'graduation-cap',
    iconColor: CYAN,
    position: 'center',
  },
  {
    title: '剧情闯关',
    description: '260个关卡，涵盖10大品类、65个品种。逐根推演K线，做出交易决策，像玩游戏一样学习交易。',
    icon: 'gamepad',
    iconColor: GREEN,
    position: 'center',
  },
  {
    title: '专项训练',
    description: '12个专项训练模块，针对特定技能进行深度练习。错题自动收集，帮助你针对性提升。',
    icon: 'bullseye',
    iconColor: PURPLE,
    position: 'center',
  },
  {
    title: '开始你的交易之旅',
    description: '点击"剧情闯关"开始第一关，或点击"专项训练"针对特定技能进行练习。祝你交易顺利！',
    icon: 'rocket',
    iconColor: GOLD,
    position: 'center',
  },
];
