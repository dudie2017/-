import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Animated, Dimensions } from 'react-native';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

interface PulseEffectProps {
  /** 是否显示脉冲效果 */
  visible: boolean;
  /** 脉冲类型：盈利（绿色）或亏损（红色） */
  type: 'profit' | 'loss';
  /** 脉冲中心位置（可选，默认屏幕中心） */
  position?: { x: number; y: number };
  /** 动画完成回调 */
  onComplete?: () => void;
}

/**
 * 脉冲效果组件
 * 在交易盈利/亏损时显示扩散脉冲动画
 */
export function PulseEffect({ visible, type, position, onComplete }: PulseEffectProps) {
  const [scaleAnim] = useState(() => new Animated.Value(0));
  const [opacityAnim] = useState(() => new Animated.Value(0));

  const color = type === 'profit' ? '#00D084' : '#FF4757';
  const centerX = position?.x ?? SCREEN_WIDTH / 2;
  const centerY = position?.y ?? SCREEN_HEIGHT / 2;

  useEffect(() => {
    if (visible) {
      // 重置动画值
      scaleAnim.setValue(0);
      opacityAnim.setValue(1);

      // 并行执行扩散和淡出动画
      Animated.parallel([
        Animated.timing(scaleAnim, {
          toValue: 1,
          duration: 600,
          useNativeDriver: true,
        }),
        Animated.timing(opacityAnim, {
          toValue: 0,
          duration: 600,
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished && onComplete) {
          onComplete();
        }
      });
    }
  }, [visible, scaleAnim, opacityAnim, onComplete]);

  if (!visible) {
    return null;
  }

  const scale = scaleAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0.5, 3],
  });

  return (
    <View style={styles.container} pointerEvents="none">
      <Animated.View
        style={[
          styles.pulse,
          {
            backgroundColor: color,
            left: centerX - 50,
            top: centerY - 50,
            opacity: opacityAnim,
            transform: [{ scale }],
          },
        ]}
      />
      <Animated.View
        style={[
          styles.pulse,
          styles.pulseInner,
          {
            backgroundColor: color,
            left: centerX - 30,
            top: centerY - 30,
            opacity: opacityAnim,
            transform: [{ scale }],
          },
        ]}
      />
    </View>
  );
}

/**
 * 简单脉冲指示器
 * 在按钮或区域上显示小型脉冲动画
 */
export function PulseIndicator({ visible, color = '#00F0FF', size = 20 }: { visible: boolean; color?: string; size?: number }) {
  const [scaleAnim] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (visible) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.3,
            duration: 500,
            useNativeDriver: true,
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      ).start();
    }
  }, [visible, scaleAnim]);

  if (!visible) {
    return null;
  }

  return (
    <Animated.View
      style={[
        styles.indicator,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
          transform: [{ scale: scaleAnim }],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  pulse: {
    position: 'absolute',
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  pulseInner: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  indicator: {
    boxShadow: '0px 2px 4px rgba(0,0,0,0.3)',
    elevation: 5,
  },
});

export default PulseEffect;
