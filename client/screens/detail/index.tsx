import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { fetchVarietyDetail, type ScanDetail, type VarietyItem } from '@/utils/api';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { Ionicons } from '@expo/vector-icons';
import { EquationPanel } from '@/components/radar/EquationPanel';

// 指标卡片
function MetricCard({ label, value, color = '#EAEAEA', sub }: { label: string; value: string; color?: string; sub?: string }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricLabel}>{label}</Text>
      <Text style={[styles.metricValue, { color }]}>{value}</Text>
      {sub && <Text style={styles.metricSub}>{sub}</Text>}
    </View>
  );
}

// 价格格式化：按量级自适应小数位
function formatPrice(p: number): string {
  if (!p || p <= 0) return '--';
  if (p >= 1000) return p.toFixed(0);
  if (p >= 10) return p.toFixed(1);
  return p.toFixed(2);
}

// 时间格式化：ISO -> HH:MM（本地时区）
function formatTime(iso?: string): string {
  if (!iso) return '--:--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// 信号标签
function SignalTag({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.signalTag, { borderColor: color, backgroundColor: color + '15' }]}>
      <Text style={[styles.signalTagText, { color }]}>{text}</Text>
    </View>
  );
}

// 维度行
/** ADX 趋势强度解读 */
function adxInterpret(adx: number): string {
  if (adx >= 40) return 'ADX解读：极强趋势。趋势运行强劲，跟随策略为主，警惕过热反转';
  if (adx >= 25) return 'ADX解读：强趋势。适合顺势交易，回调至EMA20/关键位入场';
  if (adx >= 20) return 'ADX解读：趋势形成中。关注突破方向，轻仓试探';
  if (adx > 0) return 'ADX解读：弱趋势/区间。高抛低吸或观望，避免追单';
  return 'ADX解读：数据不足';
}

/** Follow-Through 解读 */
function ftInterpret(rank: number): string {
  if (rank >= 4) return '信号K线后跟随力度强（近10根中趋势K线占比高），趋势延续概率高';
  if (rank >= 3) return '跟随力度有效（≥3根趋势K线），可正常参与';
  if (rank === 2) return '跟随力度一般，入场需更严格的位置与确认';
  return '缺乏跟随（<2根趋势K线），信号可能失败，观望为宜';
}

function DimensionRow({ label, value, color = '#EAEAEA', bar }: { label: string; value: string; color?: string; bar?: number }) {
  return (
    <View style={styles.dimRow}>
      <Text style={styles.dimLabel}>{label}</Text>
      <View style={styles.dimRight}>
        {bar !== undefined && (
          <View style={styles.barBg}>
            <View style={[styles.barFill, { width: `${Math.min(100, bar)}%`, backgroundColor: color }]} />
          </View>
        )}
        <Text style={[styles.dimValue, { color }]}>{value}</Text>
      </View>
    </View>
  );
}

export default function DetailScreen() {
  const { code } = useSafeSearchParams<{ code: string }>();
  const [detail, setDetail] = useState<ScanDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showEquation, setShowEquation] = useState(false);
  const router = useSafeRouter();

  const loadDetail = useCallback(async () => {
    if (!code) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const data = await fetchVarietyDetail(code);
      setDetail(data);
    } catch (err) {
      console.error('Load detail error:', err);
    } finally {
      setLoading(false);
    }
  }, [code]);

  useFocusEffect(useCallback(() => { loadDetail(); }, [loadDetail]));

  if (loading) {
    return (
      <Screen statusBarStyle="light">
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#00F0FF" />
          <Text style={styles.loadingText}>扫描分析中...</Text>
        </View>
      </Screen>
    );
  }

  if (!detail) {
    return (
      <Screen statusBarStyle="light">
        <View style={styles.loadingContainer}>
          <Text style={styles.loadingText}>数据加载失败</Text>
          <TouchableOpacity onPress={loadDetail} style={styles.retryBtn}>
            <Text style={styles.retryText}>重试</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  const changeColor = detail.change_pct > 0 ? '#FF5252' : detail.change_pct < 0 ? '#00E676' : '#8888A0';
  const aiColor = detail.ai_direction === 'LONG' ? '#00FF88' : detail.ai_direction === 'SHORT' ? '#FF003C' : '#555570';
  const spectrumColor = detail.spectrum === '趋势' ? '#00FF88' : detail.spectrum === '通道' ? '#00F0FF' : detail.spectrum === '突破' ? '#FFB800' : '#BF00FF';

  // 转换为 VarietyItem 供方程面板使用（CH 信号位作为预设）
  const varietyItem: VarietyItem = {
    code: detail.code,
    name: detail.name,
    contract: detail.contract,
    close: detail.close,
    change_pct: detail.change_pct,
    spectrum: detail.spectrum,
    ai_direction: detail.ai_direction,
    bar_identity: detail.bar_identity,
    buy_sell_pressure: detail.buy_sell_pressure,
    breakout_score: detail.breakout_score,
    breakout_label: detail.breakout_label,
    trend_strength: detail.trend_strength,
    trend_label: detail.trend_label,
    ai_flip: detail.ai_flip,
    signal_level: detail.signal_level,
    signals: detail.signals,
    g4_count: detail.g4_reason_count,
    edge_grade: (detail.edge_grade === 'A' || detail.edge_grade === 'B' || detail.edge_grade === 'C' || detail.edge_grade === 'D')
      ? detail.edge_grade
      : undefined,
    p_follow: detail.p_follow,
    win_rate_20: detail.win_rate_20,
    atr14: detail.atr14,
    key_levels: detail.key_levels ?? null,
  };
  const equationPreset = detail.ch_entry && detail.ch_stop && detail.ch_target
    ? { entry: detail.ch_entry, stop: detail.ch_stop, target: detail.ch_target }
    : undefined;

  return (
    <Screen safeAreaEdges={['left', 'right', 'bottom']} statusBarStyle="light">
      <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: 40 }} showsVerticalScrollIndicator={false}>
        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Text style={styles.backText}>{'< 返回'}</Text>
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={styles.headerName}>{detail.name}</Text>
            <Text style={styles.headerContract}>{detail.contract}</Text>
          </View>
          <View style={styles.headerRight}>
            <View style={styles.headerPrice}>
              <Text style={[styles.headerPriceValue, { color: changeColor }]}>{formatPrice(detail.close)}</Text>
              <Text style={[styles.headerChange, { color: changeColor }]}>
                {detail.change_pct >= 0 ? '+' : ''}{detail.change_pct.toFixed(2)}%
              </Text>
              <Text style={styles.headerUpdateTime}>更新 {formatTime(detail.scan_time)}</Text>
            </View>
          </View>
        </View>

        {/* 可交易性状态 + 方程入口 */}
        <View style={styles.section}>
          <View style={[styles.tradableBadge, { 
            backgroundColor: detail.trade_worthiness === 'tradable' ? '#00FF8820' : '#55557020',
            borderColor: detail.trade_worthiness === 'tradable' ? '#00FF88' : '#555570',
          }]}>
            <Text style={[styles.tradableText, { 
              color: detail.trade_worthiness === 'tradable' ? '#00FF88' : '#555570',
            }]}>
              {detail.trade_worthiness === 'tradable' ? '✓ 可交易' : '✗ 已过滤'}
            </Text>
          </View>
          <TouchableOpacity style={styles.equationEntry} onPress={() => setShowEquation(true)}>
            <Ionicons name="calculator" size={14} color="#00F0FF" />
            <Text style={styles.equationEntryText}>交易者方程 · 仓位计算</Text>
            <Ionicons name="chevron-forward" size={12} color="#555570" />
          </TouchableOpacity>
        </View>

        {/* 核心指标 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>CORE INDICATORS</Text>
          <View style={styles.metricsGrid}>
            <MetricCard 
              label="光谱定位" 
              value={detail.spectrum} 
              color={spectrumColor} 
            />
            <MetricCard 
              label="AI方向" 
              value={detail.ai_direction === 'LONG' ? '做多' : detail.ai_direction === 'SHORT' ? '做空' : '中性'} 
              color={aiColor} 
            />
            <MetricCard 
              label="P(顺)" 
              value={`${(detail.p_follow * 100).toFixed(0)}%`} 
              color={detail.p_follow >= 0.45 ? '#00FF88' : '#555570'} 
              sub={`逆势 ${(detail.p_counter * 100).toFixed(0)}%`}
            />
            <MetricCard 
              label="趋势强度" 
              value={`${detail.trend_strength}`} 
              color={detail.trend_strength >= 70 ? '#00FF88' : detail.trend_strength >= 50 ? '#FFB800' : '#555570'} 
            />
          </View>
        </View>

        {/* 价格行为分析 */}
        {detail.price_action && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>PRICE ACTION · 价格行为</Text>
            {/* Always In 方向 */}
            <View style={styles.paRow}>
              <Text style={styles.paLabel}>Always In</Text>
              <Text style={[styles.paValue, { color: detail.price_action.ema.aboveEma ? '#00FF88' : '#FF003C' }]}>
                {detail.price_action.ema.aboveEma ? '多头背景' : '空头背景'}
              </Text>
            </View>
            <View style={styles.paRow}>
              <Text style={styles.paLabel}>EMA20</Text>
              <Text style={styles.paValue}>{detail.price_action.ema.ema20.toFixed(2)}</Text>
            </View>
            <View style={styles.paRow}>
              <Text style={styles.paLabel}>EMA20 斜率(5日)</Text>
              <Text style={[styles.paValue, { color: detail.price_action.ema.slope5 > 0 ? '#00FF88' : '#FF003C' }]}>
                {detail.price_action.ema.slope5 > 0 ? '↑ 上行' : '↓ 下行'} ({detail.price_action.ema.slope5.toFixed(2)})
              </Text>
            </View>
            <View style={styles.paRow}>
              <Text style={styles.paLabel}>Always In 判定</Text>
              <Text style={styles.paValue}>{detail.price_action.ema.alwaysIn}</Text>
            </View>

            {/* 最近3根K线 */}
            {detail.price_action.last3Candles.length > 0 && (
              <View style={styles.paSubSection}>
                <Text style={styles.paSubTitle}>最近 K 线</Text>
                {detail.price_action.last3Candles.map((c, i) => (
                  <View key={i} style={styles.paCandleRow}>
                    <Text style={styles.paCandleDate}>{c.date}</Text>
                    <Text style={[styles.paCandleBody, { color: c.change >= 0 ? '#00FF88' : '#FF003C' }]}>
                      开{c.o.toFixed(1)} 高{c.h.toFixed(1)} 低{c.l.toFixed(1)} 收{c.c.toFixed(1)}
                    </Text>
                    <Text style={[styles.paCandlePct, { color: c.change >= 0 ? '#00FF88' : '#FF003C' }]}>
                      {c.change >= 0 ? '+' : ''}{c.change.toFixed(1)}%
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* 结构支撑/阻力 */}
            {detail.price_action.swingStructures.length > 0 && (
              <View style={styles.paSubSection}>
                <Text style={styles.paSubTitle}>结构支撑/阻力</Text>
                {detail.price_action.swingStructures.map((s, i) => (
                  <View key={i} style={styles.paRow}>
                    <Text style={styles.paLabel}>{s.type === 'swing_high' ? '摆动高点' : '摆动低点'}</Text>
                    <Text style={[styles.paValue, { color: s.type === 'swing_high' ? '#FFB800' : '#00F0FF' }]}>
                      {s.price.toFixed(2)} <Text style={styles.paDate}>({s.date})</Text>
                    </Text>
                  </View>
                ))}
                {detail.price_action.doubleStructure !== '无' && (
                  <View style={styles.paRow}>
                    <Text style={styles.paLabel}>双底/双顶</Text>
                    <Text style={styles.paValue}>{detail.price_action.doubleStructure}</Text>
                  </View>
                )}
              </View>
            )}

            {/* 突破检验 */}
            {detail.price_action.breakoutTest !== '无' && (
              <View style={styles.paSubSection}>
                <Text style={styles.paSubTitle}>突破检验</Text>
                <View style={styles.paRow}>
                  <Text style={[styles.paValue, { color: '#FFB800', fontSize: 12, lineHeight: 18 }]}>
                    {detail.price_action.breakoutTest}
                  </Text>
                </View>
              </View>
            )}

            {/* 双 R:R */}
            {detail.price_action.riskReward.rrNow !== null && (
              <View style={styles.paSubSection}>
                <Text style={styles.paSubTitle}>风险收益比</Text>
                <View style={styles.paRow}>
                  <Text style={styles.paLabel}>现价入场 R:R</Text>
                  <Text style={[styles.paValue, { color: (detail.price_action.riskReward.rrNow || 0) >= 1 ? '#00FF88' : '#FF003C' }]}>
                    {detail.price_action.riskReward.rrNow.toFixed(2)}:1
                  </Text>
                </View>
                {detail.price_action.riskReward.rrPullback !== null && (
                  <View style={styles.paRow}>
                    <Text style={styles.paLabel}>回踩入场 R:R</Text>
                    <Text style={[styles.paValue, { color: (detail.price_action.riskReward.rrPullback || 0) >= 1 ? '#00FF88' : '#FF003C' }]}>
                      {detail.price_action.riskReward.rrPullback.toFixed(2)}:1
                    </Text>
                  </View>
                )}
                <Text style={styles.paHint}>{detail.price_action.riskReward.pullbackText}</Text>
              </View>
            )}
          </View>
        )}

        {/* Gate4 决策门 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>GATE4 v3 决策门</Text>
          <View style={styles.gate4Header}>
            <Text style={[styles.gate4Verdict, { 
              color: detail.g4_pass ? '#00FF88' : '#FF003C',
            }]}>
              {detail.g4_verdict}
            </Text>
            <Text style={styles.gate4Count}>
              {detail.g4_reason_count}/5 通过
            </Text>
          </View>
          {detail.g4_reasons_met.length > 0 && (
            <View style={styles.signalList}>
              {detail.g4_reasons_met.map((s, i) => (
                <SignalTag key={i} text={s} color="#00FF88" />
              ))}
            </View>
          )}
        </View>

        {/* 市场环境 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>MARKET CONTEXT</Text>
          <View style={styles.dimSection}>
            <DimensionRow label="市场环境" value={detail.market_context} color="#EAEAEA" />
            {/* 生命周期（含解释） */}
            <View>
              <DimensionRow label="生命周期" value={detail.lc_stage} color="#EAEAEA" />
              {detail.lc_desc ? <Text style={styles.dimDesc}>{detail.lc_desc}</Text> : null}
            </View>
            {/* Follow-Through（含排名与解释） */}
            <View>
              <DimensionRow
                label="Follow-Through"
                value={`${detail.fw_type_cn} · ${detail.fw_rank}/5`}
                color={detail.fw_rank >= 3 ? '#00FF88' : detail.fw_rank === 2 ? '#FFB800' : '#555570'}
              />
              <Text style={styles.dimDesc}>{ftInterpret(detail.fw_rank)}</Text>
            </View>
            <DimensionRow label="持仓量信号" value={detail.oi_signal} color={detail.oi_signal === '增仓' ? '#00FF88' : detail.oi_signal === '减仓' ? '#FF003C' : '#555570'} />
          </View>
        </View>

        {/* 技术指标 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>TECHNICAL</Text>
          <View style={styles.dimSection}>
            <DimensionRow 
              label="ADX" 
              value={detail.adx.toFixed(1)} 
              color={detail.adx > 25 ? '#00FF88' : '#555570'} 
              bar={Math.min(100, detail.adx * 2)} 
            />
            <DimensionRow label="ATR(14)" value={detail.atr14.toFixed(2)} color="#EAEAEA" />
            <Text style={styles.dimDesc}>{adxInterpret(detail.adx)}</Text>
          </View>
        </View>

        {/* CH通道信号 */}
        {detail.ch_has_signal && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>CH CHANNEL SIGNAL</Text>
            <View style={styles.dimSection}>
              <DimensionRow 
                label="通道方向" 
                value={detail.ch_direction === '多' ? '做多' : detail.ch_direction === '空' ? '做空' : '无'} 
                color={detail.ch_direction === '多' ? '#00FF88' : detail.ch_direction === '空' ? '#FF003C' : '#555570'} 
              />
              {detail.ch_entry && <DimensionRow label="入场位" value={detail.ch_entry.toFixed(2)} color="#00F0FF" />}
              {detail.ch_stop && <DimensionRow label="止损位" value={detail.ch_stop.toFixed(2)} color="#FF003C" />}
              {detail.ch_target && <DimensionRow label="目标位" value={detail.ch_target.toFixed(2)} color="#00FF88" />}
              <DimensionRow label="信号强度" value={detail.ch_strength} color={detail.ch_strength === '强' ? '#00FF88' : detail.ch_strength === '中' ? '#FFB800' : '#555570'} />
            </View>
          </View>
        )}

        {/* MM测量运动 */}
        {detail.mm_found && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>MM MEASURED MOVE</Text>
            <View style={styles.dimSection}>
              <DimensionRow 
                label="MM方向" 
                value={detail.mm_direction === '多' ? '做多' : detail.mm_direction === '空' ? '做空' : '无'} 
                color={detail.mm_direction === '多' ? '#00FF88' : detail.mm_direction === '空' ? '#FF003C' : '#555570'} 
              />
              <DimensionRow label="变体数" value={`${detail.mm_variant_count}`} color="#EAEAEA" />
              {detail.mm_tier1 && <DimensionRow label="目标1" value={detail.mm_tier1.toFixed(2)} color="#00FF88" />}
              {detail.mm_tier2 && <DimensionRow label="目标2" value={detail.mm_tier2.toFixed(2)} color="#FFB800" />}
              {detail.mm_tier3 && <DimensionRow label="目标3" value={detail.mm_tier3.toFixed(2)} color="#FF003C" />}
            </View>
          </View>
        )}

        {/* 边沿统计 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>EDGE STATISTICS</Text>
          <View style={styles.dimSection}>
            <DimensionRow 
              label="Edge状态" 
              value={detail.edge_status} 
              color={detail.edge_status === 'active' ? '#00FF88' : detail.edge_status === 'expired' ? '#FF003C' : '#555570'} 
            />
            <DimensionRow 
              label="Edge等级" 
              value={detail.edge_grade} 
              color={detail.edge_grade === 'A' ? '#00FF88' : detail.edge_grade === 'B' ? '#00F0FF' : detail.edge_grade === 'C' ? '#FFB800' : '#555570'} 
            />
            {detail.win_rate_20 !== null && (
              <DimensionRow 
                label="近20笔胜率" 
                value={`${(detail.win_rate_20 * 100).toFixed(0)}%`} 
                color={detail.win_rate_20 >= 0.5 ? '#00FF88' : '#FF003C'} 
              />
            )}
            {detail.avg_rr !== null && (
              <DimensionRow 
                label="平均盈亏比" 
                value={`${detail.avg_rr.toFixed(2)}`} 
                color={detail.avg_rr >= 1.5 ? '#00FF88' : '#FFB800'} 
              />
            )}
          </View>
        </View>

        {/* 纪律阶梯 */}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>纪律阶梯 DISCIPLINE LADDER</Text>
          {(() => {
            const disc = detail.account_discipline;
            const level = Math.min(disc?.level ?? detail.disc_ladder ?? 0, 4);
            const colors = ['#00FF88', '#FFB800', '#F97316', '#FF003C', '#991B1B'];
            const labels = ['L0 正常交易', 'L1 警告', 'L2 仓位减半', 'L3 停止开新仓', 'L4 强制复盘'];
            const descs = [
              '无连续亏损，按标准仓位执行',
              '连续1笔亏损：检查信号质量，确认是否严格执行入场条件',
              '连续2笔亏损：仓位降至50%，只做A级信号',
              '连续3笔亏损：当日停止开新仓，仅管理持仓',
              '连续4笔及以上：停止交易，完成复盘前禁止开新仓',
            ];
            return (
              <View>
                <View style={styles.ladderHeader}>
                  <View style={[styles.ladderBadge, { backgroundColor: colors[level] + '22', borderColor: colors[level] }]}>
                    <Text style={[styles.ladderBadgeText, { color: colors[level] }]}>{labels[level]}</Text>
                  </View>
                  {disc ? <Text style={styles.ladderLosses}>连续亏损 {disc.consecutive_losses} 笔</Text> : null}
                </View>
                {disc && disc.recent_results.length > 0 && (
                  <View style={styles.recentRow}>
                    <Text style={styles.recentLabel}>最近{disc.recent_results.length}笔</Text>
                    <View style={styles.recentDots}>
                      {disc.recent_results.map((r, i) => (
                        <View key={i} style={[styles.recentDot, { backgroundColor: r === 'win' ? '#00FF88' : '#FF003C' }]}>
                          <Text style={styles.recentDotText}>{r === 'win' ? '盈' : '亏'}</Text>
                        </View>
                      ))}
                    </View>
                  </View>
                )}
                <View style={styles.ladderList}>
                  {labels.map((label, i) => (
                    <View key={i} style={[styles.ladderItem, i === level && styles.ladderItemActive]}>
                      <View style={[styles.ladderDot, { backgroundColor: colors[i] }]} />
                      <View style={styles.ladderItemBody}>
                        <Text style={[styles.ladderItemTitle, i === level && { color: colors[i] }]}>{label}</Text>
                        <Text style={styles.ladderItemDesc}>{descs[i]}</Text>
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            );
          })()}
        </View>

        {/* 楔形过滤 */}
        {detail.wedge_found && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>WEDGE FILTER</Text>
            <View style={styles.dimSection}>
              <DimensionRow 
                label="楔形检测" 
                value={detail.wedge_found ? '已检测' : '未检测'} 
                color={detail.wedge_found ? '#BF00FF' : '#555570'} 
              />
              {detail.wedge_filter_on && (
                <DimensionRow 
                  label="过滤方向" 
                  value={detail.wedge_filtered_dir} 
                  color="#FF003C" 
                />
              )}
            </View>
          </View>
        )}
      </ScrollView>

      {/* 交易者方程面板（CH 信号位作为预设） */}
      <EquationPanel
        visible={showEquation}
        item={varietyItem}
        onClose={() => setShowEquation(false)}
        preset={equationPreset}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#0A0A0F',
  },
  loadingText: {
    color: '#EAEAEA',
    fontSize: 16,
    marginTop: 16,
  },
  retryBtn: {
    marginTop: 24,
    paddingHorizontal: 32,
    paddingVertical: 12,
    backgroundColor: '#00F0FF20',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#00F0FF',
  },
  retryText: {
    color: '#00F0FF',
    fontSize: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A2E',
  },
  backBtn: {
    marginRight: 12,
  },
  backText: {
    color: '#00F0FF',
    fontSize: 14,
  },
  headerInfo: {
    flex: 1,
  },
  headerName: {
    color: '#EAEAEA',
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerContract: {
    color: '#555570',
    fontSize: 12,
    marginTop: 2,
  },
  headerRight: {
    alignItems: 'flex-end',
  },
  headerPrice: {
    alignItems: 'flex-end',
  },
  headerPriceValue: {
    fontSize: 18,
    fontWeight: 'bold',
  },
  headerChange: {
    fontSize: 12,
    marginTop: 2,
  },
  headerUpdateTime: {
    fontSize: 10,
    color: '#555570',
    marginTop: 3,
  },
  tradableBadge: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
    alignSelf: 'center',
  },
  tradableText: {
    fontSize: 14,
    fontWeight: '600',
  },
  equationEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 12,
    paddingVertical: 12,
    borderRadius: 10,
    backgroundColor: '#12121A',
    borderWidth: 1,
    borderColor: '#00F0FF',
  },
  equationEntryText: {
    color: '#00F0FF',
    fontSize: 13,
    fontWeight: '700',
  },
  section: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1A1A2E',
  },
  sectionTitle: {
    color: '#555570',
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    marginBottom: 12,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  metricCard: {
    width: '48%',
    backgroundColor: '#1A1A2E',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  metricLabel: {
    color: '#555570',
    fontSize: 10,
    marginBottom: 4,
  },
  metricValue: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  metricSub: {
    color: '#555570',
    fontSize: 10,
    marginTop: 4,
  },
  paRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#16161F',
  },
  paLabel: {
    color: '#555570',
    fontSize: 12,
  },
  paValue: {
    fontSize: 13,
    fontWeight: '600',
    flex: 1,
    textAlign: 'right',
  },
  paDate: {
    color: '#555570',
    fontSize: 10,
    fontWeight: '400',
  },
  paSubSection: {
    marginTop: 12,
    padding: 10,
    backgroundColor: '#12121A',
    borderRadius: 8,
  },
  paSubTitle: {
    color: '#00F0FF',
    fontSize: 11,
    fontWeight: '600',
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  paCandleRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 4,
  },
  paCandleDate: {
    color: '#555570',
    fontSize: 11,
    width: 60,
  },
  paCandleBody: {
    fontSize: 11,
    flex: 1,
  },
  paCandlePct: {
    fontSize: 12,
    fontWeight: '600',
    width: 60,
    textAlign: 'right',
  },
  paHint: {
    color: '#8888A0',
    fontSize: 10,
    marginTop: 6,
    lineHeight: 15,
  },
  gate4Header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  gate4Verdict: {
    fontSize: 14,
    fontWeight: '600',
  },
  gate4Count: {
    color: '#555570',
    fontSize: 12,
  },
  signalList: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  signalTag: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    borderWidth: 1,
  },
  signalTagText: {
    fontSize: 11,
  },
  dimSection: {
    gap: 8,
  },
  dimRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  dimDesc: { color: '#8888A0', fontSize: 12, lineHeight: 18, marginBottom: 8, marginTop: -4 },
  ladderHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 12 },
  ladderBadge: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1 },
  ladderBadgeText: { fontSize: 14, fontWeight: '800', letterSpacing: 0.5 },
  ladderLosses: { color: '#FF003C', fontSize: 13, fontWeight: '700' },
  recentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 12 },
  recentLabel: { color: '#8888A0', fontSize: 12 },
  recentDots: { flexDirection: 'row', gap: 6 },
  recentDot: { width: 24, height: 24, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  recentDotText: { color: '#0A0A0F', fontSize: 11, fontWeight: '800' },
  ladderList: { gap: 8 },
  ladderItem: { flexDirection: 'row', gap: 10, padding: 10, borderRadius: 10, backgroundColor: '#14141C', borderWidth: 1, borderColor: 'transparent' },
  ladderItemActive: { borderColor: '#2A2A35', backgroundColor: '#1C1C26' },
  ladderDot: { width: 10, height: 10, borderRadius: 5, marginTop: 4 },
  ladderItemBody: { flex: 1, gap: 2 },
  ladderItemTitle: { color: '#EAEAEA', fontSize: 13, fontWeight: '700' },
  ladderItemDesc: { color: '#8888A0', fontSize: 12, lineHeight: 17 },
  dimLabel: {
    color: '#555570',
    fontSize: 12,
  },
  dimRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  barBg: {
    width: 60,
    height: 4,
    backgroundColor: '#1A1A2E',
    borderRadius: 2,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    borderRadius: 2,
  },
  dimValue: {
    fontSize: 12,
    fontWeight: '500',
    minWidth: 60,
    textAlign: 'right',
  },
});
