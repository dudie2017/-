import React, { useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  getPendingReviewQuestions,
  getReviewStats,
  markReviewed,
  removeFromReviewQueue,
  loadReviewSchedule,
  getNextReviewTimeDesc,
  type ReviewItem,
} from '@/utils/reviewScheduler';
import { ErrorQuestion } from '@/utils/trainingData';
import { hapticButtonPress, hapticCloseProfit, hapticCloseLoss } from '@/utils/haptics';

const BG = '#0A0A0F';
const SURFACE = '#12121A';
const CYAN = '#00F0FF';
const GREEN = '#00FF88';
const RED = '#FF003C';
const GOLD = '#FFD700';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#555570';
const BORDER = 'rgba(0,240,255,0.12)';

export default function TrainingReviewScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [pendingQuestions, setPendingQuestions] = useState<ErrorQuestion[]>([]);
  const [schedule, setSchedule] = useState<ReviewItem[]>([]);
  const [stats, setStats] = useState({ total: 0, pending: 0, mastered: 0, upcoming: 0 });
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showAnswer, setShowAnswer] = useState(false);
  const [mode, setMode] = useState<'overview' | 'review'>('overview');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [questions, reviewSchedule, reviewStats] = await Promise.all([
        getPendingReviewQuestions(),
        loadReviewSchedule(),
        getReviewStats(),
      ]);
      setPendingQuestions(questions);
      setSchedule(reviewSchedule);
      setStats(reviewStats);
    } catch (e) {
      console.error('[Review] Failed to load:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  const handleStartReview = () => {
    if (pendingQuestions.length === 0) return;
    hapticButtonPress();
    setMode('review');
    setCurrentIndex(0);
    setShowAnswer(false);
  };

  const handleAnswer = async (correct: boolean) => {
    const question = pendingQuestions[currentIndex];
    if (!question) return;

    if (correct) {
      hapticCloseProfit();
    } else {
      hapticCloseLoss();
    }

    await markReviewed(question.id, correct);

    if (currentIndex + 1 < pendingQuestions.length) {
      setCurrentIndex(currentIndex + 1);
      setShowAnswer(false);
    } else {
      // 复习完成
      setMode('overview');
      loadData();
    }
  };

  const handleRemove = async (errorId: string) => {
    hapticButtonPress();
    await removeFromReviewQueue(errorId);
    loadData();
  };

  const currentQuestion = pendingQuestions[currentIndex];

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, backgroundColor: BG, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="large" color={CYAN} />
        </View>
      </Screen>
    );
  }

  // 复习模式
  if (mode === 'review' && currentQuestion) {
    return (
      <Screen>
        <View style={{ flex: 1, backgroundColor: BG }}>
          {/* Header */}
          <View style={{
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
          }}>
            <TouchableOpacity onPress={() => setMode('overview')} style={{ padding: 4 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <Text style={{ color: TEXT2, fontSize: 12 }}>
              {currentIndex + 1} / {pendingQuestions.length}
            </Text>
          </View>

          {/* Progress Bar */}
          <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.05)', marginHorizontal: 16, borderRadius: 2 }}>
            <View style={{
              height: 3, borderRadius: 2,
              backgroundColor: CYAN,
              width: `${((currentIndex + 1) / pendingQuestions.length) * 100}%`,
            }} />
          </View>

          <ScrollView style={{ flex: 1, padding: 16 }}>
            {/* Module Badge */}
            <View style={{
              backgroundColor: 'rgba(0,240,255,0.1)', borderRadius: 8,
              paddingHorizontal: 10, paddingVertical: 4, alignSelf: 'flex-start',
              marginBottom: 12,
            }}>
              <Text style={{ color: CYAN, fontSize: 11 }}>{currentQuestion.moduleName}</Text>
            </View>

            {/* Question */}
            <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', lineHeight: 24, marginBottom: 16 }}>
              {currentQuestion.question}
            </Text>

            {/* Options */}
            {currentQuestion.options.length > 0 && (
              <View style={{ gap: 8, marginBottom: 16 }}>
                {currentQuestion.options.map((opt, i) => {
                  const isCorrectOpt = opt.value === currentQuestion.correctAnswer;
                  const isUserAnswer = opt.value === currentQuestion.userAnswer;
                  return (
                    <View
                      key={i}
                      style={{
                        padding: 12, borderRadius: 10,
                        backgroundColor: showAnswer
                          ? isCorrectOpt ? 'rgba(0,255,136,0.1)' : isUserAnswer ? 'rgba(255,0,60,0.1)' : SURFACE
                          : SURFACE,
                        borderWidth: 1,
                        borderColor: showAnswer
                          ? isCorrectOpt ? GREEN : isUserAnswer ? RED : BORDER
                          : BORDER,
                      }}
                    >
                      <Text style={{
                        color: showAnswer
                          ? isCorrectOpt ? GREEN : isUserAnswer ? RED : TEXT1
                          : TEXT1,
                        fontSize: 14,
                      }}>
                        {opt.label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            )}

            {/* Show Answer Button */}
            {!showAnswer && (
              <TouchableOpacity
                onPress={() => { hapticButtonPress(); setShowAnswer(true); }}
                style={{
                  paddingVertical: 14, borderRadius: 10,
                  backgroundColor: 'rgba(0,240,255,0.12)',
                  borderWidth: 1, borderColor: CYAN,
                  alignItems: 'center', marginBottom: 16,
                }}
              >
                <Text style={{ color: CYAN, fontSize: 14, fontWeight: '600' }}>显示答案</Text>
              </TouchableOpacity>
            )}

            {/* Answer & Explanation */}
            {showAnswer && (
              <View style={{ marginBottom: 16 }}>
                <View style={{
                  padding: 12, borderRadius: 10,
                  backgroundColor: 'rgba(0,255,136,0.08)',
                  borderWidth: 1, borderColor: GREEN,
                  marginBottom: 12,
                }}>
                  <Text style={{ color: GREEN, fontSize: 13, fontWeight: '600', marginBottom: 4 }}>
                    正确答案
                  </Text>
                  <Text style={{ color: TEXT1, fontSize: 14 }}>
                    {currentQuestion.correctAnswer}
                  </Text>
                </View>

                <View style={{
                  padding: 12, borderRadius: 10,
                  backgroundColor: 'rgba(255,184,0,0.08)',
                  borderWidth: 1, borderColor: 'rgba(255,184,0,0.3)',
                }}>
                  <Text style={{ color: '#FFB800', fontSize: 13, fontWeight: '600', marginBottom: 4 }}>
                    Brooks解析
                  </Text>
                  <Text style={{ color: TEXT1, fontSize: 13, lineHeight: 20 }}>
                    {currentQuestion.explanation}
                  </Text>
                </View>

                {/* Review Buttons */}
                <View style={{ flexDirection: 'row', gap: 12, marginTop: 20 }}>
                  <TouchableOpacity
                    onPress={() => handleAnswer(false)}
                    style={{
                      flex: 1, paddingVertical: 14, borderRadius: 10,
                      backgroundColor: 'rgba(255,0,60,0.12)',
                      borderWidth: 1, borderColor: RED,
                      alignItems: 'center',
                    }}
                  >
                    <FontAwesome6 name="xmark" size={16} color={RED} />
                    <Text style={{ color: RED, fontSize: 13, fontWeight: '600', marginTop: 4 }}>
                      还没掌握
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleAnswer(true)}
                    style={{
                      flex: 1, paddingVertical: 14, borderRadius: 10,
                      backgroundColor: 'rgba(0,255,136,0.12)',
                      borderWidth: 1, borderColor: GREEN,
                      alignItems: 'center',
                    }}
                  >
                    <FontAwesome6 name="check" size={16} color={GREEN} />
                    <Text style={{ color: GREEN, fontSize: 13, fontWeight: '600', marginTop: 4 }}>
                      已掌握
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}
          </ScrollView>
        </View>
      </Screen>
    );
  }

  // 概览模式
  return (
    <Screen>
      <View style={{ flex: 1, backgroundColor: BG }}>
        {/* Header */}
        <View style={{
          flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
          paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8,
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <TouchableOpacity onPress={() => router.back()} style={{ marginRight: 12 }}>
              <FontAwesome6 name="arrow-left" size={16} color={CYAN} />
            </TouchableOpacity>
            <Text style={{ color: TEXT1, fontSize: 18, fontWeight: '700' }}>错题复习</Text>
          </View>
        </View>

        <ScrollView style={{ flex: 1, padding: 16 }}>
          {/* Stats Cards */}
          <View style={{ flexDirection: 'row', gap: 10, marginBottom: 20 }}>
            <View style={{
              flex: 1, padding: 14, borderRadius: 12,
              backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
              alignItems: 'center',
            }}>
              <Text style={{ color: CYAN, fontSize: 24, fontWeight: '700' }}>{stats.pending}</Text>
              <Text style={{ color: TEXT2, fontSize: 11, marginTop: 2 }}>待复习</Text>
            </View>
            <View style={{
              flex: 1, padding: 14, borderRadius: 12,
              backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
              alignItems: 'center',
            }}>
              <Text style={{ color: GOLD, fontSize: 24, fontWeight: '700' }}>{stats.upcoming}</Text>
              <Text style={{ color: TEXT2, fontSize: 11, marginTop: 2 }}>待出现</Text>
            </View>
            <View style={{
              flex: 1, padding: 14, borderRadius: 12,
              backgroundColor: SURFACE, borderWidth: 1, borderColor: BORDER,
              alignItems: 'center',
            }}>
              <Text style={{ color: GREEN, fontSize: 24, fontWeight: '700' }}>{stats.mastered}</Text>
              <Text style={{ color: TEXT2, fontSize: 11, marginTop: 2 }}>已掌握</Text>
            </View>
          </View>

          {/* Start Review Button */}
          {stats.pending > 0 && (
            <TouchableOpacity
              onPress={handleStartReview}
              style={{
                paddingVertical: 16, borderRadius: 12,
                backgroundColor: 'rgba(0,240,255,0.15)',
                borderWidth: 1, borderColor: CYAN,
                alignItems: 'center', marginBottom: 20,
              }}
            >
              <FontAwesome6 name="play" size={20} color={CYAN} />
              <Text style={{ color: CYAN, fontSize: 16, fontWeight: '700', marginTop: 6 }}>
                开始复习 ({stats.pending}题)
              </Text>
            </TouchableOpacity>
          )}

          {/* Ebbinghaus Info */}
          <View style={{
            padding: 14, borderRadius: 12,
            backgroundColor: 'rgba(255,215,0,0.06)',
            borderWidth: 1, borderColor: 'rgba(255,215,0,0.2)',
            marginBottom: 20,
          }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <FontAwesome6 name="brain" size={14} color={GOLD} />
              <Text style={{ color: GOLD, fontSize: 13, fontWeight: '600', marginLeft: 8 }}>
                艾宾浩斯遗忘曲线
              </Text>
            </View>
            <Text style={{ color: TEXT2, fontSize: 11, lineHeight: 16 }}>
              根据遗忘规律，系统会在 20分钟 → 1小时 → 9小时 → 1天 → 2天 → 6天 → 31天 后提醒你复习。
              坚持复习，让知识永久留存。
            </Text>
          </View>

          {/* Review Schedule List */}
          {schedule.length > 0 && (
            <View>
              <Text style={{ color: TEXT1, fontSize: 15, fontWeight: '600', marginBottom: 12 }}>
                复习队列
              </Text>
              {schedule
                .filter(item => !item.mastered)
                .sort((a, b) => a.nextReviewTime - b.nextReviewTime)
                .slice(0, 20)
                .map((item) => {
                  const question = pendingQuestions.find(q => q.id === item.errorId);
                  const isPending = item.nextReviewTime <= Date.now();
                  return (
                    <View
                      key={item.errorId}
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        padding: 12, borderRadius: 10,
                        backgroundColor: isPending ? 'rgba(0,240,255,0.06)' : SURFACE,
                        borderWidth: 1, borderColor: isPending ? CYAN : BORDER,
                        marginBottom: 8,
                      }}
                    >
                      <View style={{
                        width: 36, height: 36, borderRadius: 8,
                        backgroundColor: isPending ? 'rgba(0,240,255,0.15)' : 'rgba(255,255,255,0.05)',
                        alignItems: 'center', justifyContent: 'center',
                        marginRight: 10,
                      }}>
                        <FontAwesome6
                          name={isPending ? 'bell' : 'clock'}
                          size={14}
                          color={isPending ? CYAN : TEXT2}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: TEXT1, fontSize: 13 }} numberOfLines={1}>
                          {question?.question || item.errorId}
                        </Text>
                        <Text style={{ color: TEXT2, fontSize: 10, marginTop: 2 }}>
                          第{item.reviewCount + 1}次复习 · {getNextReviewTimeDesc(item.nextReviewTime)}
                        </Text>
                      </View>
                      <TouchableOpacity
                        onPress={() => handleRemove(item.errorId)}
                        style={{ padding: 6 }}
                      >
                        <FontAwesome6 name="trash-can" size={12} color={TEXT2} />
                      </TouchableOpacity>
                    </View>
                  );
                })}
            </View>
          )}

          {/* Empty State */}
          {schedule.length === 0 && (
            <View style={{ alignItems: 'center', paddingVertical: 40 }}>
              <FontAwesome6 name="circle-check" size={48} color={GREEN} />
              <Text style={{ color: TEXT1, fontSize: 16, fontWeight: '600', marginTop: 16 }}>
                暂无错题
              </Text>
              <Text style={{ color: TEXT2, fontSize: 12, marginTop: 6, textAlign: 'center' }}>
                去专项训练中答题，答错的题目会自动加入复习队列
              </Text>
            </View>
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}
