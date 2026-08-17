import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * 触觉反馈工具
 * 在交易决策时提供触觉反馈，增强用户体验
 */

export type HapticType = 'success' | 'error' | 'warning' | 'light' | 'medium' | 'heavy' | 'selection';

/**
 * 触发触觉反馈
 * @param type 反馈类型
 */
export const triggerHaptic = async (type: HapticType): Promise<void> => {
  // Web 平台不支持触觉反馈
  if (Platform.OS === 'web') {
    return;
  }

  try {
    switch (type) {
      case 'success':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        break;
      case 'error':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        break;
      case 'warning':
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        break;
      case 'light':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        break;
      case 'medium':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        break;
      case 'heavy':
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        break;
      case 'selection':
        await Haptics.selectionAsync();
        break;
      default:
        await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  } catch (error) {
    // 忽略触觉反馈错误，不影响主要功能
    console.log('[Haptics] Error:', error);
  }
};

/**
 * 开仓时触觉反馈
 */
export const hapticOpenPosition = () => triggerHaptic('medium');

/**
 * 平仓盈利时触觉反馈
 */
export const hapticCloseProfit = () => triggerHaptic('success');

/**
 * 平仓亏损时触觉反馈
 */
export const hapticCloseLoss = () => triggerHaptic('error');

/**
 * 止损触发时触觉反馈
 */
export const hapticStopLoss = () => triggerHaptic('heavy');

/**
 * 按钮点击时触觉反馈
 */
export const hapticButtonPress = () => triggerHaptic('light');

/**
 * 切换K线时触觉反馈
 */
export const hapticBarAdvance = () => triggerHaptic('selection');
