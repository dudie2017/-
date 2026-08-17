import AsyncStorage from '@react-native-async-storage/async-storage';
import { ErrorQuestion, loadErrorQuestions } from './trainingData';

// ============ 艾宾浩斯遗忘曲线复习调度 ============

/**
 * 艾宾浩斯遗忘曲线间隔（分钟）
 * 学完立即复习 -> 20分钟 -> 1小时 -> 9小时 -> 1天 -> 2天 -> 6天 -> 31天
 */
const EBINGHAUS_INTERVALS_MINUTES = [
  0,          // 第0次：立即
  20,         // 第1次：20分钟后
  60,         // 第2次：1小时后
  540,        // 第3次：9小时后
  1440,       // 第4次：1天后
  2880,       // 第5次：2天后
  8640,       // 第6次：6天后
  44640,      // 第7次：31天后（永久掌握）
];

const REVIEW_KEY = '@brooks_review_schedule';

export interface ReviewItem {
  /** 错题ID */
  errorId: string;
  /** 当前复习次数（0-7） */
  reviewCount: number;
  /** 下次复习时间戳 */
  nextReviewTime: number;
  /** 是否已掌握（复习完所有阶段） */
  mastered: boolean;
  /** 创建时间 */
  createdAt: string;
}

/**
 * 加载复习调度表
 */
export async function loadReviewSchedule(): Promise<ReviewItem[]> {
  try {
    const raw = await AsyncStorage.getItem(REVIEW_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    console.error('[Review] Failed to load schedule:', e);
    return [];
  }
}

/**
 * 保存复习调度表
 */
async function saveReviewSchedule(schedule: ReviewItem[]): Promise<void> {
  try {
    await AsyncStorage.setItem(REVIEW_KEY, JSON.stringify(schedule));
  } catch (e) {
    console.error('[Review] Failed to save schedule:', e);
  }
}

/**
 * 将错题加入复习队列
 */
export async function addToReviewQueue(errorId: string): Promise<void> {
  const schedule = await loadReviewSchedule();
  // 检查是否已存在
  if (schedule.some(item => item.errorId === errorId)) {
    return;
  }

  const now = Date.now();
  const newItem: ReviewItem = {
    errorId,
    reviewCount: 0,
    nextReviewTime: now + EBINGHAUS_INTERVALS_MINUTES[0] * 60 * 1000,
    mastered: false,
    createdAt: new Date().toISOString(),
  };

  schedule.push(newItem);
  await saveReviewSchedule(schedule);
}

/**
 * 标记复习完成（答对了进入下一阶段，答错了回到第0阶段）
 */
export async function markReviewed(errorId: string, correct: boolean): Promise<void> {
  const schedule = await loadReviewSchedule();
  const item = schedule.find(i => i.errorId === errorId);
  if (!item) return;

  const now = Date.now();

  if (correct) {
    // 答对：进入下一阶段
    item.reviewCount = Math.min(item.reviewCount + 1, EBINGHAUS_INTERVALS_MINUTES.length - 1);
    if (item.reviewCount >= EBINGHAUS_INTERVALS_MINUTES.length - 1) {
      // 完成所有阶段，标记为已掌握
      item.mastered = true;
    } else {
      const interval = EBINGHAUS_INTERVALS_MINUTES[item.reviewCount];
      item.nextReviewTime = now + interval * 60 * 1000;
    }
  } else {
    // 答错：重置到第0阶段，20分钟后重新复习
    item.reviewCount = 0;
    item.mastered = false;
    item.nextReviewTime = now + EBINGHAUS_INTERVALS_MINUTES[1] * 60 * 1000;
  }

  await saveReviewSchedule(schedule);
}

/**
 * 从复习队列中移除
 */
export async function removeFromReviewQueue(errorId: string): Promise<void> {
  const schedule = await loadReviewSchedule();
  const filtered = schedule.filter(i => i.errorId !== errorId);
  await saveReviewSchedule(filtered);
}

/**
 * 获取当前待复习的错题ID列表
 */
export async function getPendingReviewIds(): Promise<string[]> {
  const schedule = await loadReviewSchedule();
  const now = Date.now();
  return schedule
    .filter(item => !item.mastered && item.nextReviewTime <= now)
    .map(item => item.errorId);
}

/**
 * 获取复习统计
 */
export async function getReviewStats(): Promise<{
  total: number;
  pending: number;
  mastered: number;
  upcoming: number;
}> {
  const schedule = await loadReviewSchedule();
  const now = Date.now();

  return {
    total: schedule.length,
    pending: schedule.filter(i => !i.mastered && i.nextReviewTime <= now).length,
    mastered: schedule.filter(i => i.mastered).length,
    upcoming: schedule.filter(i => !i.mastered && i.nextReviewTime > now).length,
  };
}

/**
 * 获取待复习的错题详情
 */
export async function getPendingReviewQuestions(): Promise<ErrorQuestion[]> {
  const pendingIds = await getPendingReviewIds();
  const allErrors = await loadErrorQuestions();
  return allErrors.filter(e => pendingIds.includes(e.id));
}

/**
 * 获取下次复习的时间描述
 */
export function getNextReviewTimeDesc(nextReviewTime: number): string {
  const now = Date.now();
  const diff = nextReviewTime - now;

  if (diff <= 0) return '现在';

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (days > 0) return `${days}天后`;
  if (hours > 0) return `${hours}小时后`;
  if (minutes > 0) return `${minutes}分钟后`;
  return '现在';
}
