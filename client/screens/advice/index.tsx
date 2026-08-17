import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { FontAwesome6 } from '@expo/vector-icons';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import { API_BASE, fetchWithTimeout } from '@/utils/api';

const BG = '#0A0A0F';
const CARD = '#14141C';
const ACCENT = '#00F0FF';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#AAAAAA';
const UP = '#F43F5E';
const DOWN = '#10B981';
const WARN = '#F59E0B';

// 与 server/src/routes/optimization.ts 返回结构对齐
interface AdviceCostData {
  actualRisk: number;
  totalCapitalRequired: number;
}

// 与 server/src/services/strategyContext.ts 对齐（千次回测验证的策略上下文）
interface StrategyContext {
  code: string;
  name: string;
  verified: boolean;
  verification: {
    pnlRank: number;
    ddRank: number;
    captureRank: number;
    total: number;
    pnlTopPct: number;
    ddTopPct: number;
  } | null;
  directionBias: {
    dominant: 'LONG' | 'SHORT' | 'BALANCED';
    longCapture: number;
    shortCapture: number;
    note: string;
  } | null;
  circuitBreaker: { lossStreak: number; pauseBars: number } | null;
  hold: {
    productionLong: number;
    productionShort: number;
    verifiedBest: number | null;
    note: string;
  } | null;
  fragilityWarnings: string[];
  captureNote: string;
}

interface AdviceItem {
  varietyCode: string;
  varietyName: string;
  direction: 'LONG' | 'SHORT';
  resonanceScore: number;
  resonanceLevel: string;
  signalGrade?: string;        // L0-L4
  signalVariant?: string;      // S/A+/A/A-/B+
  spectrum?: string;
  g4ReasonCount?: number;
  mtfResonanceText?: string;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  target1: number | null;
  target2: number | null;
  maxPosition: number;
  riskAmount: number;
  contractMultiplier: number;
  summary: string;
  entryTiming: string;
  costData?: AdviceCostData;
  // 结构验证 (价格行为分析)
  structureValidation?: {
    alwaysIn: string;
    entryVsSupport: number | null;   // 入场价距支撑位百分比
    entryVsResistance: number | null; // 入场价距阻力位百分比
    structureGrade: 'A' | 'B' | 'C'; // 结构位置评级
    structureNote: string;
  } | null;
  // 千次回测验证的策略上下文
  strategyContext?: StrategyContext | null;
  // 方向一致性校验（建议方向 vs 回测主导方向）
  directionConsistency?: {
    checked: boolean;
    dominant: 'LONG' | 'SHORT' | 'BALANCED';
    adviceDirection: 'LONG' | 'SHORT';
    consistent: boolean;
    warning: string | null;
  } | null;
  // ML 增强字段
  mlRecommendation?: {
    predictedReturn: number;     // ML 预测收益率（百分比数值）
    confidence: number;          // ML 置信度 (0-1)
    predictedMaxDrawdown: number; // ML 预测最大回撤（百分比数值）
    reason: string;              // ML 推荐理由
    featureImportance: Record<string, number>; // 特征重要性
    modelVersion: string;        // 模型版本
  } | null;
}

// 观望品种（全市场报告）
interface WatchItem {
  code: string;
  name: string;
  reason: string;
  strategyContext?: StrategyContext | null;
}

// 全市场报告汇总
interface MarketSummary {
  scanTime: string;
  totalCount: number;
  tradableCount: number;
  watchCount: number;
  longCount: number;
  shortCount: number;
  riskAmount: number;
}

interface TimeframePerf {
  timeframe: string;
  profitFactor: number;
  winRate: number;
}

interface GradeItem {
  code: string;
  name: string;
  exchange: string;
  grade: string;
  bestTimeframe: string;
  bestProfitFactor: number;
  avgProfitFactor: number;
  timeframes: TimeframePerf[];
}

const GRADE_COLORS: Record<string, string> = {
  S: '#FFD700',
  A: '#00F0FF',
  B: '#10B981',
  C: '#F59E0B',
};

// V17 信号等级颜色
function signalGradeColor(grade?: string): string {
  if (!grade) return '#555';
  if (grade.startsWith('L4')) return '#FFD700';
  if (grade.startsWith('L3')) return '#00F0FF';
  if (grade.startsWith('L2')) return '#10B981';
  if (grade.startsWith('L1')) return '#F59E0B';
  return '#555570';
}

function signalGradeBg(grade?: string): string {
  if (!grade) return '#55557022';
  if (grade.startsWith('L4')) return '#FFD70022';
  if (grade.startsWith('L3')) return '#00F0FF22';
  if (grade.startsWith('L2')) return '#10B98122';
  if (grade.startsWith('L1')) return '#F59E0B22';
  return '#55557022';
}

/**
 * 服务端文件：server/src/routes/optimization.ts
 * 接口1：GET /api/v1/optimization/grades — 无参数，返回 { success, data: GradeItem[] }
 * 接口2：GET /api/v1/optimization/market-report — Query: riskAmount?: number，返回全市场交易机会报告
 *   data: { scanTime, totalCount, tradableCount, watchCount, longCount, shortCount,
 *           riskAmount, dataSource, advices: AdviceItem[], watch: WatchItem[] }
 */
export default function AdviceScreen() {
  const router = useSafeRouter();
  const [loading, setLoading] = useState(true);
  const [advices, setAdvices] = useState<AdviceItem[]>([]);
  const [watch, setWatch] = useState<WatchItem[]>([]);
  const [summary, setSummary] = useState<MarketSummary | null>(null);
  const [grades, setGrades] = useState<GradeItem[]>([]);
  const [tab, setTab] = useState<'advice' | 'grades'>('advice');
  const [watchExpanded, setWatchExpanded] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [adviceRes, gradesRes] = await Promise.all([
        fetchWithTimeout(`${API_BASE}/optimization/market-report`, undefined, 60000),
        fetchWithTimeout(`${API_BASE}/optimization/grades`, undefined, 60000),
      ]);
      if (adviceRes.ok) {
        const json = await adviceRes.json();
        const data = json.data || {};
        setAdvices(data.advices || []);
        setWatch(data.watch || []);
        setSummary({
          scanTime: data.scanTime,
          totalCount: data.totalCount,
          tradableCount: data.tradableCount,
          watchCount: data.watchCount,
          longCount: data.longCount,
          shortCount: data.shortCount,
          riskAmount: data.riskAmount,
        });
      }
      if (gradesRes.ok) {
        const json = await gradesRes.json();
        // 后端返回 { success: true, data: GradeItem[] }，data 本身即数组
        const data = json.data;
        setGrades(Array.isArray(data) ? data : data?.grades || []);
      }
    } catch (e) {
      console.error('[Advice] 加载失败:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadData();
    }, [loadData])
  );

  // ===== 报告头（全市场扫描统计）=====
  const renderReportHeader = () => {
    if (!summary) return null;
    const totalDir = summary.longCount + summary.shortCount;
    const longPct = totalDir > 0 ? (summary.longCount / totalDir) * 100 : 0;
    const shortPct = 100 - longPct;
    return (
      <View style={styles.reportHeader}>
        <View style={styles.reportHeaderTop}>
          <View style={styles.reportTitleWrap}>
            <FontAwesome6 name="satellite-dish" size={15} color={ACCENT} />
            <Text style={styles.reportTitle}>全市场交易机会</Text>
          </View>
          <Text style={styles.reportTime}>{summary.scanTime || '扫描中'}</Text>
        </View>

        <View style={styles.reportStats}>
          <View style={styles.reportStatCell}>
            <Text style={styles.reportStatValue}>{summary.totalCount}</Text>
            <Text style={styles.reportStatLabel}>扫描品种</Text>
          </View>
          <View style={styles.reportStatDivider} />
          <View style={styles.reportStatCell}>
            <Text style={[styles.reportStatValue, { color: ACCENT }]}>
              {summary.tradableCount}
            </Text>
            <Text style={styles.reportStatLabel}>可交易</Text>
          </View>
          <View style={styles.reportStatDivider} />
          <View style={styles.reportStatCell}>
            <Text style={[styles.reportStatValue, { color: '#888' }]}>
              {summary.watchCount}
            </Text>
            <Text style={styles.reportStatLabel}>观望</Text>
          </View>
        </View>

        {totalDir > 0 && (
          <View style={styles.dirBarWrap}>
            <View style={styles.dirBarTrack}>
              <View style={[styles.dirBarLong, { width: `${longPct}%` }]} />
              <View style={[styles.dirBarShort, { width: `${shortPct}%` }]} />
            </View>
            <View style={styles.dirBarLabels}>
              <Text style={[styles.dirBarLabel, { color: UP }]}>
                多头 {summary.longCount}
              </Text>
              <Text style={[styles.dirBarLabel, { color: DOWN }]}>
                空头 {summary.shortCount}
              </Text>
            </View>
          </View>
        )}
      </View>
    );
  };

  // ===== 可交易卡片 =====
  const renderAdviceCard = (item: AdviceItem, index: number) => {
    const dirColor = item.direction === 'LONG' ? UP : DOWN;
    const sgColor = signalGradeColor(item.signalGrade);
    const sgBg = signalGradeBg(item.signalGrade);
    const verified = item.strategyContext?.verified === true;
    const sv = item.structureValidation;
    const sc = item.strategyContext;

    const openPlan = () => {
      router.push('/trade-plan', {
        varietyCode: item.varietyCode,
        varietyName: item.varietyName || item.varietyCode,
        direction: item.direction,
        entryPrice: item.entryPrice,
        stopLoss: item.stopLoss,
        target1: item.target1,
        target2: item.target2,
        riskAmount: item.riskAmount,
        contractMultiplier: item.contractMultiplier,
        maxPosition: item.maxPosition,
        signalGrade: item.signalGrade || '',
        signalVariant: item.signalVariant || '',
        resonanceScore: item.resonanceScore,
        resonanceLevel: item.resonanceLevel,
        spectrum: item.spectrum || '',
        summary: item.summary,
      });
    };

    return (
      <TouchableOpacity
        key={`${item.varietyCode}-${index}`}
        style={[styles.adviceCard, verified && styles.adviceCardVerified]}
        onPress={openPlan}
        activeOpacity={0.85}
      >
        {/* 头部：方向 + 品种 + 等级 */}
        <View style={styles.adviceHeader}>
          <View style={[styles.dirBadge, { backgroundColor: dirColor + '22' }]}>
            <Text style={[styles.dirText, { color: dirColor }]}>
              {item.direction === 'LONG' ? '做多' : '做空'}
            </Text>
          </View>
          <View style={styles.adviceTitleWrap}>
            <View style={styles.adviceNameRow}>
              <Text style={styles.adviceName}>{item.varietyName || item.varietyCode}</Text>
              <Text style={styles.adviceCode}>{item.varietyCode}</Text>
              {verified && (
                <View style={styles.verifiedBadge}>
                  <FontAwesome6 name="circle-check" size={9} color="#4ADE80" />
                  <Text style={styles.verifiedBadgeText}>已验证</Text>
                </View>
              )}
            </View>
            <Text style={styles.signalVariantText}>
              {item.mtfResonanceText || `共振 ${item.resonanceScore}/4`}
            </Text>
          </View>
          <View style={[styles.signalGradeBadge, { backgroundColor: sgBg }]}>
            <Text style={[styles.signalGradeText, { color: sgColor }]}>
              {item.signalGrade || 'L?'}
            </Text>
          </View>
        </View>

        {/* 价位 */}
        <View style={styles.priceRow}>
          <View style={styles.priceCell}>
            <Text style={styles.priceLabel}>现价</Text>
            <Text style={styles.priceValue}>{item.currentPrice}</Text>
          </View>
          <View style={styles.priceCell}>
            <Text style={styles.priceLabel}>入场</Text>
            <Text style={styles.priceValue}>{item.entryPrice}</Text>
          </View>
          <View style={styles.priceCell}>
            <Text style={[styles.priceLabel, { color: dirColor }]}>止损</Text>
            <Text style={[styles.priceValue, { color: dirColor }]}>{item.stopLoss}</Text>
          </View>
          {item.target1 != null && (
            <View style={styles.priceCell}>
              <Text style={[styles.priceLabel, { color: '#4ADE80' }]}>目标1</Text>
              <Text style={[styles.priceValue, { color: '#4ADE80' }]}>{item.target1}</Text>
            </View>
          )}
        </View>

        {/* 仓位 */}
        <View style={styles.equationRow}>
          <FontAwesome6 name="briefcase" size={12} color={TEXT2} />
          <Text style={styles.equationText}>
            建议 {item.maxPosition} 手 · 风险 ¥{Math.round(item.riskAmount).toLocaleString()}
            {item.costData?.totalCapitalRequired
              ? ` · 需保证金 ¥${Math.round(item.costData.totalCapitalRequired).toLocaleString()}`
              : ''}
          </Text>
        </View>

        {/* 结构验证 */}
        {sv && (
          <View style={styles.structureRow}>
            <View style={styles.structureLeft}>
              <FontAwesome6 name="mountain-sun" size={12} color={TEXT2} />
              <Text style={styles.structureLabel}>结构</Text>
              <View
                style={[
                  styles.structureGradeBadge,
                  { backgroundColor: sv.structureGrade === 'A' ? '#4ADE8022' : sv.structureGrade === 'B' ? '#F59E0B22' : '#F43F5E22' },
                ]}
              >
                <Text
                  style={[
                    styles.structureGradeText,
                    { color: sv.structureGrade === 'A' ? '#4ADE80' : sv.structureGrade === 'B' ? '#F59E0B' : '#F43F5E' },
                  ]}
                >
                  {sv.structureGrade}
                </Text>
              </View>
            </View>
            <Text style={styles.structureNote} numberOfLines={1}>
              {sv.structureNote || sv.alwaysIn}
            </Text>
          </View>
        )}

        {/* 千次回测策略上下文 */}
        {sc && sc.verified && (
          <View style={styles.strategyCard}>
            <View style={styles.strategyTitleRow}>
              <Text style={styles.strategyTitle}>▍千次回测验证</Text>
              <Text style={styles.strategyTitle}>
                收益#{sc.verification?.pnlRank}/{sc.verification?.total}
              </Text>
            </View>
            {/* 方向一致性校验（建议方向 vs 回测主导方向） */}
            {item.directionConsistency?.checked && !item.directionConsistency.consistent && (
              <View style={styles.directionWarnRow}>
                <FontAwesome6 name="circle-exclamation" size={12} color={WARN} />
                <Text style={styles.directionWarnText} numberOfLines={2}>
                  {item.directionConsistency.warning || '当前建议方向与回测主导方向相悖'}
                </Text>
              </View>
            )}
            <View style={styles.strategyBadges}>
              {sc.directionBias && (
                <Text
                  style={[
                    styles.strategyBadge,
                    {
                      backgroundColor:
                        sc.directionBias.dominant === 'LONG'
                          ? UP + '22'
                          : sc.directionBias.dominant === 'SHORT'
                          ? DOWN + '22'
                          : '#88888822',
                      color:
                        sc.directionBias.dominant === 'LONG'
                          ? UP
                          : sc.directionBias.dominant === 'SHORT'
                          ? DOWN
                          : '#888',
                    },
                  ]}
                >
                  偏好 {sc.directionBias.dominant === 'LONG' ? '做多' : sc.directionBias.dominant === 'SHORT' ? '做空' : '均衡'}
                </Text>
              )}
              {sc.circuitBreaker && (
                <Text style={[styles.strategyBadge, { backgroundColor: '#88888822', color: '#DDD' }]}>
                  熔断 {sc.circuitBreaker.lossStreak}x{sc.circuitBreaker.pauseBars}
                </Text>
              )}
              {sc.hold && sc.hold.verifiedBest != null && (
                <Text style={[styles.strategyBadge, { backgroundColor: '#88888822', color: '#DDD' }]}>
                  最佳持仓 {sc.hold.verifiedBest}天
                </Text>
              )}
            </View>
            {sc.directionBias?.note && (
              <Text style={styles.strategyText}>{sc.directionBias.note}</Text>
            )}
            {sc.fragilityWarnings && sc.fragilityWarnings.length > 0 && (
              <Text style={styles.strategyNote}>
                <FontAwesome6 name="triangle-exclamation" size={10} color={WARN} />
                {' '}
                {sc.fragilityWarnings.slice(0, 2).join('；')}
              </Text>
            )}
          </View>
        )}

        {/* ML 模型推荐 */}
        {item.mlRecommendation && (
          <View style={styles.mlCard}>
            <View style={styles.mlTitleRow}>
              <FontAwesome6 name="robot" size={11} color="#8B5CF6" />
              <Text style={styles.mlTitle}>ML 预测</Text>
              <View
                style={[
                  styles.mlConfidenceBadge,
                  {
                    backgroundColor:
                      item.mlRecommendation.confidence >= 0.7
                        ? '#4ADE8022'
                        : item.mlRecommendation.confidence >= 0.5
                        ? '#F59E0B22'
                        : '#F43F5E22',
                  },
                ]}
              >
                <Text
                  style={[
                    styles.mlConfidenceText,
                    {
                      color:
                        item.mlRecommendation.confidence >= 0.7
                          ? '#4ADE80'
                          : item.mlRecommendation.confidence >= 0.5
                          ? '#F59E0B'
                          : '#F43F5E',
                    },
                  ]}
                >
                  {(item.mlRecommendation.confidence * 100).toFixed(0)}%
                </Text>
              </View>
            </View>
            <View style={styles.mlBadges}>
              <Text style={[styles.mlBadge, { backgroundColor: '#8B5CF622', color: '#8B5CF6' }]}>
                预测收益 {(item.mlRecommendation.predictedReturn * 100).toFixed(1)}%
              </Text>
              <Text style={[styles.mlBadge, { backgroundColor: '#8B5CF622', color: '#8B5CF6' }]}>
                预测回撤 {(item.mlRecommendation.predictedMaxDrawdown * 100).toFixed(1)}%
              </Text>
            </View>
            {item.mlRecommendation.reason && (
              <Text style={styles.mlReason} numberOfLines={2}>
                {item.mlRecommendation.reason}
              </Text>
            )}
          </View>
        )}

        <Text style={styles.reasonText} numberOfLines={15}>
          {item.summary || item.entryTiming}
        </Text>
      </TouchableOpacity>
    );
  };

  // ===== 观望品种折叠列表 =====
  const renderWatchSection = () => {
    if (!watch.length) return null;
    return (
      <View style={styles.watchSection}>
        <TouchableOpacity
          style={styles.watchHeader}
          onPress={() => setWatchExpanded((v) => !v)}
          activeOpacity={0.7}
        >
          <View style={styles.watchTitleWrap}>
            <FontAwesome6 name="eye" size={13} color={TEXT2} />
            <Text style={styles.watchTitle}>观望品种 ({watch.length})</Text>
          </View>
          <FontAwesome6
            name={watchExpanded ? 'chevron-up' : 'chevron-down'}
            size={12}
            color={TEXT2}
          />
        </TouchableOpacity>

        {watchExpanded && (
          <View style={styles.watchBody}>
            {watch.map((item, idx) => {
              const verified = item.strategyContext?.verified === true;
              return (
                <View key={`${item.code}-${idx}`} style={styles.watchRow}>
                  <Text style={styles.watchCode}>{item.name || item.code}</Text>
                  <Text style={styles.watchCodeSub}>{item.code}</Text>
                  {verified && (
                    <FontAwesome6 name="circle-check" size={10} color="#4ADE80" />
                  )}
                  <Text style={styles.watchReason} numberOfLines={1}>
                    {item.reason}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>
    );
  };

  const renderGradeRow = (item: GradeItem, index: number) => {
    const gradeColor = GRADE_COLORS[item.grade] || TEXT2;
    const bestTf = item.timeframes?.find((t) => t.timeframe === item.bestTimeframe);
    const winRate = bestTf ? bestTf.winRate : null;
    return (
      <View key={`${item.code}-${index}`} style={styles.gradeRow}>
        {/* 主体区域：点击进入品种深度分析页 */}
        <TouchableOpacity
          style={styles.gradeRowMain}
          activeOpacity={0.7}
          onPress={() => router.push('/detail', { code: item.code })}
        >
          <View style={[styles.gradeBadge, { backgroundColor: gradeColor + '22' }]}>
            <Text style={[styles.gradeText, { color: gradeColor }]}>{item.grade}</Text>
          </View>
          <View style={styles.gradeNameWrap}>
            <Text style={styles.gradeName}>{item.name}</Text>
            <Text style={styles.gradeCode}>{item.code} · {item.exchange}</Text>
          </View>
          <View style={styles.gradeStat}>
            <Text style={styles.gradeStatValue}>{item.bestTimeframe}</Text>
            <Text style={styles.gradeStatLabel}>最佳周期</Text>
          </View>
          <View style={styles.gradeStat}>
            <Text style={styles.gradeStatValue}>
              {winRate != null ? `${winRate.toFixed(0)}%` : '-'}
            </Text>
            <Text style={styles.gradeStatLabel}>胜率</Text>
          </View>
          <View style={styles.gradeStat}>
            <Text style={styles.gradeStatValue}>{item.bestProfitFactor.toFixed(1)}</Text>
            <Text style={styles.gradeStatLabel}>盈利因子</Text>
          </View>
        </TouchableOpacity>

        {/* AI 专家快捷入口 */}
        <TouchableOpacity
          style={styles.aiBtn}
          activeOpacity={0.7}
          onPress={() => router.push('/ai-expert', { code: item.code })}
        >
          <FontAwesome6 name="wand-magic-sparkles" size={14} color={ACCENT} />
          <Text style={styles.aiBtnText}>AI 解读</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <Screen style={styles.screen}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <FontAwesome6 name="arrow-left" size={18} color={TEXT1} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>交易机会报告</Text>
        <TouchableOpacity onPress={loadData} style={styles.refreshBtn}>
          <FontAwesome6 name="rotate" size={16} color={ACCENT} />
        </TouchableOpacity>
      </View>

      <View style={styles.tabRow}>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'advice' && styles.tabBtnActive]}
          onPress={() => setTab('advice')}
        >
          <Text style={[styles.tabText, tab === 'advice' && styles.tabTextActive]}>交易机会</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tabBtn, tab === 'grades' && styles.tabBtnActive]}
          onPress={() => setTab('grades')}
        >
          <Text style={[styles.tabText, tab === 'grades' && styles.tabTextActive]}>品种分级</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={styles.loadingWrap}>
          <ActivityIndicator color={ACCENT} size="large" />
          <Text style={styles.loadingText}>全市场扫描中...</Text>
        </View>
      ) : (
        <ScrollView style={styles.body} showsVerticalScrollIndicator={false}>
          {tab === 'advice' ? (
            <>
              {renderReportHeader()}
              <View style={styles.sectionTitleWrap}>
                <FontAwesome6 name="bolt" size={13} color={ACCENT} />
                <Text style={styles.sectionTitle}>可交易机会</Text>
                <Text style={styles.sectionSub}>按共振强度排序</Text>
              </View>
              {advices.length === 0 ? (
                <Text style={styles.emptyText}>暂无可交易机会</Text>
              ) : (
                advices.map(renderAdviceCard)
              )}
              {renderWatchSection()}
            </>
          ) : grades.length === 0 ? (
            <Text style={styles.emptyText}>暂无分级数据</Text>
          ) : (
            grades.map(renderGradeRow)
          )}
          <View style={{ height: 40 }} />
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  backBtn: { padding: 8 },
  headerTitle: { fontSize: 18, fontWeight: '700', color: TEXT1 },
  refreshBtn: { padding: 8 },
  tabRow: {
    flexDirection: 'row',
    marginHorizontal: 16,
    marginBottom: 12,
    backgroundColor: CARD,
    borderRadius: 10,
    padding: 4,
  },
  tabBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
  },
  tabBtnActive: { backgroundColor: ACCENT + '22' },
  tabText: { fontSize: 14, color: TEXT2 },
  tabTextActive: { color: ACCENT, fontWeight: '700' },
  loadingWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { marginTop: 12, fontSize: 13, color: TEXT2 },
  body: { flex: 1, paddingHorizontal: 16 },
  emptyText: { textAlign: 'center', color: TEXT2, marginTop: 40, fontSize: 14 },

  // ===== 报告头 =====
  reportHeader: {
    backgroundColor: '#101020',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: ACCENT + '33',
    padding: 14,
    marginBottom: 14,
    gap: 12,
  },
  reportHeaderTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  reportTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  reportTitle: { fontSize: 15, fontWeight: '800', color: TEXT1, letterSpacing: 1 },
  reportTime: { fontSize: 11, color: TEXT2 },
  reportStats: { flexDirection: 'row', alignItems: 'center' },
  reportStatCell: { flex: 1, alignItems: 'center', gap: 2 },
  reportStatValue: { fontSize: 26, fontWeight: '900', color: TEXT1 },
  reportStatLabel: { fontSize: 11, color: TEXT2 },
  reportStatDivider: { width: 1, height: 32, backgroundColor: '#1E1E2E' },
  dirBarWrap: { gap: 6 },
  dirBarTrack: {
    flexDirection: 'row',
    height: 6,
    borderRadius: 3,
    backgroundColor: '#1E1E2E',
    overflow: 'hidden',
  },
  dirBarLong: { backgroundColor: UP },
  dirBarShort: { backgroundColor: DOWN },
  dirBarLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  dirBarLabel: { fontSize: 11, fontWeight: '700' },

  // ===== 分区标题 =====
  sectionTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionTitle: { fontSize: 14, fontWeight: '800', color: TEXT1 },
  sectionSub: { fontSize: 11, color: TEXT2 },

  // ===== 可交易卡片 =====
  adviceCard: {
    backgroundColor: CARD,
    borderRadius: 14,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  adviceCardVerified: {
    borderColor: 'rgba(74,222,128,0.35)',
  },
  adviceHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 },
  gradeBadge: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradeText: { fontSize: 16, fontWeight: '900' },
  adviceTitleWrap: { flex: 1, marginLeft: 10 },
  adviceNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  adviceName: { fontSize: 15, fontWeight: '700', color: TEXT1 },
  signalVariantText: { fontSize: 11, color: TEXT2, marginTop: 2 },
  verifiedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: 'rgba(74,222,128,0.12)',
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 4,
  },
  verifiedBadgeText: { fontSize: 9, fontWeight: '700', color: '#4ADE80' },
  signalGradeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  signalGradeText: { fontSize: 10, fontWeight: '800' },
  adviceCode: { fontSize: 11, color: TEXT2 },
  dirBadge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 6 },
  dirText: { fontSize: 12, fontWeight: '700' },
  priceRow: {
    flexDirection: 'row',
    backgroundColor: BG,
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  priceCell: { flex: 1, alignItems: 'center' },
  priceLabel: { fontSize: 10, color: TEXT2, marginBottom: 4 },
  priceValue: { fontSize: 14, fontWeight: '700', color: TEXT1 },
  equationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  equationText: { fontSize: 12, color: TEXT2 },
  reasonText: { fontSize: 13, color: '#CCCCCC', lineHeight: 20 },

  // ===== 策略上下文（千次回测验证）=====
  strategyCard: {
    backgroundColor: 'rgba(255,255,255,0.03)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    padding: 10,
    marginBottom: 10,
    gap: 8,
  },
  strategyTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  strategyTitle: { fontSize: 11, color: TEXT2, fontWeight: '600', letterSpacing: 1 },
  strategyBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  strategyBadge: {
    fontSize: 11,
    fontWeight: '700',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    overflow: 'hidden',
  },
  strategyText: { fontSize: 12, color: TEXT2, lineHeight: 18 },
  strategyNote: { fontSize: 12, color: '#9CA3AF', lineHeight: 18 },
  directionWarnRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: 'rgba(245,158,11,0.10)',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: 'rgba(245,158,11,0.28)',
    padding: 8,
  },
  directionWarnText: { flex: 1, fontSize: 12, color: '#FBBF24', lineHeight: 18, fontWeight: '600' },

  // 结构验证行
  structureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#0D0D14',
    borderRadius: 8,
    padding: 8,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1A1A2E',
  },
  structureLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginRight: 8,
  },
  structureLabel: { fontSize: 11, color: TEXT2 },
  structureGradeBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  structureGradeText: { fontSize: 10, fontWeight: '700' },
  structureNote: { fontSize: 11, color: '#AAAAAA', flex: 1 },

  // ===== 观望品种 =====
  watchSection: {
    marginTop: 4,
    marginBottom: 12,
  },
  watchHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: CARD,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderWidth: 1,
    borderColor: '#1E1E2E',
  },
  watchTitleWrap: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  watchTitle: { fontSize: 13, fontWeight: '700', color: TEXT1 },
  watchBody: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderRadius: 12,
    marginTop: 8,
    padding: 8,
    borderWidth: 1,
    borderColor: '#1A1A2E',
  },
  watchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#1E1E2E',
  },
  watchCode: { fontSize: 13, fontWeight: '700', color: TEXT1, minWidth: 52 },
  watchCodeSub: { fontSize: 10, color: TEXT2, minWidth: 40 },
  watchReason: { flex: 1, fontSize: 11, color: '#999999' },

  gradeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: CARD,
    borderRadius: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#1E1E2E',
    overflow: 'hidden',
  },
  gradeRowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  aiBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'stretch',
    paddingHorizontal: 12,
    backgroundColor: ACCENT + '14',
    borderLeftWidth: 1,
    borderLeftColor: '#1E1E2E',
  },
  aiBtnText: {
    fontSize: 11,
    fontWeight: '700',
    color: ACCENT,
  },
  gradeNameWrap: { flex: 1, marginLeft: 10 },
  gradeName: { fontSize: 14, fontWeight: '700', color: TEXT1 },
  gradeCode: { fontSize: 10, color: TEXT2, marginTop: 2 },
  gradeStat: { alignItems: 'center', marginLeft: 10, minWidth: 40 },
  gradeStatValue: { fontSize: 13, fontWeight: '700', color: ACCENT },
  gradeStatLabel: { fontSize: 9, color: TEXT2, marginTop: 2 },

  // ML 推荐卡片
  mlCard: {
    backgroundColor: 'rgba(139, 92, 246, 0.05)',
    borderRadius: 12,
    padding: 12,
    marginTop: 10,
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.2)',
  },
  mlTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  mlTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: '#8B5CF6',
    flex: 1,
  },
  mlConfidenceBadge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  mlConfidenceText: {
    fontSize: 11,
    fontWeight: '700',
  },
  mlBadges: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 6,
  },
  mlBadge: {
    fontSize: 10,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    fontWeight: '600',
  },
  mlReason: {
    fontSize: 11,
    color: '#999999',
    lineHeight: 16,
  },
});
