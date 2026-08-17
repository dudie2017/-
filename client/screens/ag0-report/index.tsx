import { useCallback, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  fetchAg0Report,
  type Ag0Report,
  type BacktestStats,
  type SideParams,
} from '@/utils/ag0ReportApi';

// ============ 工具函数 ============

const pct = (v?: number | null) => `${((v ?? 0) * 100).toFixed(1)}%`;
const money = (v?: number | null) => {
  const n = v ?? 0;
  const sign = n >= 0 ? '+' : '';
  const abs = Math.abs(n);
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(1)}万`;
  return `${sign}${n.toFixed(0)}`;
};
const color = (v?: number | null) => (v != null && v >= 0 ? 'text-emerald-400' : 'text-red-400');

const fmtParams = (p?: SideParams | null) =>
  p
    ? `止损${p.stopAtrMult}·目标${p.targetAtrMult}·持仓${p.maxHoldDays}天·冷却${p.cooldownBars}根${p.trendFilter ? '·趋势过滤' : ''}·${p.minSignalGrade}`
    : '--';

// ============ 通用卡片 ============

function StatCard({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <View className="flex-1 rounded-2xl bg-[#131722] p-3 border border-[#1e2431]">
      <Text className="text-[11px] text-[#8b93a7]">{label}</Text>
      <Text className={`text-lg font-bold mt-1 ${valueColor ?? 'text-[#e8eaf0]'}`}>{value}</Text>
      {sub ? <Text className="text-[10px] text-[#5a6272] mt-0.5">{sub}</Text> : null}
    </View>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
      <Text className="text-sm font-bold text-[#e8eaf0] mb-3">{title}</Text>
      {children}
    </View>
  );
}

function StatsRow({ stats }: { stats?: BacktestStats | null }) {
  if (!stats) return null;
  return (
    <View className="flex-row flex-wrap gap-2">
      <View className="w-[23%]">
        <StatCard label="胜率" value={pct(stats.winRate)} valueColor="text-emerald-400" />
      </View>
      <View className="w-[23%]">
        <StatCard label="总收益" value={money(stats.totalPnl)} valueColor={color(stats.totalPnl)} />
      </View>
      <View className="w-[23%]">
        <StatCard label="最大回撤" value={pct(stats.maxDrawdown)} valueColor="text-amber-400" />
      </View>
      <View className="w-[23%]">
        <StatCard label="盈亏比" value={stats.avgRR ? stats.avgRR.toFixed(2) : '--'} />
      </View>
    </View>
  );
}

function ParamRow({ label, params }: { label: string; params?: SideParams | null }) {
  return (
    <View className="flex-row justify-between py-1.5 border-b border-[#1e2431] last:border-0">
      <Text className="text-[11px] text-[#8b93a7]">{label}</Text>
      <Text className="text-[11px] text-[#e8eaf0] flex-1 text-right ml-3">{fmtParams(params)}</Text>
    </View>
  );
}

// ============ 方案对比表 ============

function PlanCompare({ report }: { report: Ag0Report }) {
  const plans = [
    { name: '基线（旧参数）', stats: report.baseline?.stats, params: report.baseline?.params },
    { name: '方向寻优', stats: report.optimized?.stats, params: report.optimized?.params },
    { name: '寻优+熔断(落地)', stats: report.optimizedWithCB?.stats, params: report.optimizedWithCB?.params },
  ];
  return (
    <SectionCard title="方案对比（1000 次回测结论）">
      {plans.map((p) => (
        <View key={p.name} className="mb-4">
          <Text className="text-xs font-bold text-[#00F0FF] mb-1.5">{p.name}</Text>
          <StatsRow stats={p.stats} />
          <View className="mt-2">
            <ParamRow label="做多参数" params={p.params?.long} />
            <ParamRow label="做空参数" params={p.params?.short} />
          </View>
        </View>
      ))}
    </SectionCard>
  );
}

// ============ 熔断场景表 ============

function DrawdownScenarios({ scenarios }: { scenarios: Ag0Report['drawdownScenarios'] }) {
  if (!scenarios || scenarios.length === 0) return null;
  return (
    <SectionCard title="回撤控制实验（风控工具性价比）">
      <View className="flex-row justify-between pb-2 border-b border-[#1e2431]">
        <Text className="text-[10px] text-[#5a6272] flex-1">方案</Text>
        <Text className="text-[10px] text-[#5a6272] w-14 text-right">胜率</Text>
        <Text className="text-[10px] text-[#5a6272] w-20 text-right">收益</Text>
        <Text className="text-[10px] text-[#5a6272] w-14 text-right">回撤</Text>
      </View>
      {scenarios.map((s) => (
        <View key={s.name} className="flex-row justify-between py-2 border-b border-[#1e2431] last:border-0">
          <Text className="text-[11px] text-[#e8eaf0] flex-1">{s.name}</Text>
          <Text className="text-[11px] text-[#8b93a7] w-14 text-right">{pct(s.winRate)}</Text>
          <Text className={`text-[11px] w-20 text-right ${color(s.pnl)}`}>{money(s.pnl)}</Text>
          <Text className="text-[11px] text-amber-400 w-14 text-right">{pct(s.maxDrawdown)}</Text>
        </View>
      ))}
    </SectionCard>
  );
}

// ============ 多目标 Top10 ============

function TopRank({ report }: { report: Ag0Report }) {
  const top = report.multiObjective?.topAll ?? [];
  if (top.length === 0) return null;
  return (
    <SectionCard title={`多目标寻优 TOP${top.length}（${report.sampleCount ?? 1000} 次采样）`}>
      {top.map((r, i) => (
        <View key={i} className="py-2 border-b border-[#1e2431] last:border-0">
          <View className="flex-row justify-between items-center">
            <Text className="text-[10px] text-[#5a6272] w-5">#{i + 1}</Text>
            <Text className={`text-[11px] font-semibold flex-1 ${i === 0 ? 'text-[#00F0FF]' : 'text-[#e8eaf0]'}`}>
              {fmtParams(r.params)}
            </Text>
            <Text className="text-[10px] text-[#5a6272]">评分 {r.composite?.toFixed(2)}</Text>
          </View>
          <View className="flex-row mt-1 ml-5">
            <Text className="text-[10px] text-emerald-400">胜率{pct(r.stats?.winRate)}</Text>
            <Text className="text-[10px] text-amber-400 ml-3">回撤{pct(r.stats?.maxDrawdown)}</Text>
            <Text className={`text-[10px] ml-3 ${color(r.stats?.totalPnl)}`}>收益{money(r.stats?.totalPnl)}</Text>
          </View>
        </View>
      ))}
    </SectionCard>
  );
}

// ============ 稳健性审计 ============

function RobustAudit({ report }: { report: Ag0Report }) {
  const audit = report.robustAudit;
  if (!audit) return null;
  const years = audit.byYear ?? [];
  return (
    <SectionCard title="稳健性审计（200 次参数扰动 + 按年分解）">
      <View className="flex-row gap-2 mb-3">
        <View className="w-[48%]">
          <StatCard
            label="扰动 CV（参数稳健性）"
            value={((audit.perturbation?.pnlCV ?? 0) * 100).toFixed(2) + '%'}
            sub="<15% 视为稳健，白银 1.2% 极稳健"
            valueColor="text-emerald-400"
          />
        </View>
        <View className="w-[48%]">
          <StatCard
            label="收益集中度"
            value={`${((audit.concentration?.topYearRatio ?? 0) * 100).toFixed(0)}%`}
            sub={`${audit.concentration?.topYear ?? ''}年贡献·前3年${((audit.concentration?.top3Ratio ?? 0) * 100).toFixed(0)}%`}
            valueColor="text-amber-400"
          />
        </View>
      </View>
      <Text className="text-[11px] text-[#8b93a7] mb-2">
        按年盈利：{audit.concentration?.positiveYears ?? 0}/{years.length} 年
      </Text>
      {years.slice(-6).map((y) => (
        <View key={y.year} className="flex-row items-center justify-between py-1 border-b border-[#1e2431] last:border-0">
          <Text className="text-[11px] text-[#8b93a7] w-12">{y.year}</Text>
          <Text className="text-[10px] text-[#5a6272] flex-1">{y.trades}笔·{y.wins}胜</Text>
          <Text className={`text-[11px] font-semibold ${color(y.pnl)}`}>{money(y.pnl)}</Text>
        </View>
      ))}
    </SectionCard>
  );
}

// ============ 主组件 ============

export default function Ag0ReportScreen() {
  const [report, setReport] = useState<Ag0Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useSafeRouter();

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const result = await fetchAg0Report();
      setReport(result);
    } catch (e: any) {
      setError(e.message || '加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  return (
    <Screen>
      <View className="px-4 pt-4">
        {/* 顶部 Header */}
        <View className="flex-row items-center justify-between">
          <TouchableOpacity
            onPress={() => router.back()}
            className="w-9 h-9 rounded-xl bg-[#131722] border border-[#1e2431] items-center justify-center"
          >
            <Text className="text-[#8b93a7] text-lg">←</Text>
          </TouchableOpacity>
          <Text className="text-base font-bold text-[#e8eaf0]">白银回测报告</Text>
          <View className="w-9 h-9" />
        </View>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center py-20">
          <ActivityIndicator size="large" color="#00F0FF" />
          <Text className="text-xs text-[#5a6272] mt-3">加载中…</Text>
        </View>
      ) : error ? (
        <View className="flex-1 items-center justify-center py-20 px-6">
          <Text className="text-sm text-red-400 text-center">{error}</Text>
          <TouchableOpacity
            onPress={() => load()}
            className="mt-4 px-5 py-2 rounded-xl bg-[#00F0FF]"
          >
            <Text className="text-xs font-bold text-black">重试</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView
          className="flex-1 px-4 pb-8"
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#00F0FF" />
          }
        >
          {report && (
            <>
              {/* 概览 */}
              <View className="rounded-2xl bg-gradient-to-br from-[#131722] to-[#0d1117] border border-[#1e2431] p-4 mt-4">
                <View className="flex-row justify-between items-center">
                  <View>
                    <Text className="text-xl font-bold text-[#e8eaf0]">AG0 白银</Text>
                    <Text className="text-[11px] text-[#5a6272] mt-0.5">
                      14.2 年 · {report.sampleCount ?? 1000} 次参数采样寻优
                    </Text>
                  </View>
                  <View className="rounded-xl bg-[#00F0FF]/10 px-3 py-1.5">
                    <Text className="text-[11px] font-bold text-[#00F0FF]">已落地</Text>
                  </View>
                </View>
              </View>

              {/* 当前生产参数 */}
              <SectionCard title="当前生产参数（已落库）">
                <ParamRow label="做多" params={report.currentParams?.long} />
                <ParamRow label="做空" params={report.currentParams?.short} />
                <View className="flex-row justify-between py-1.5">
                  <Text className="text-[11px] text-[#8b93a7]">风控熔断</Text>
                  <Text className="text-[11px] text-[#00F0FF]">
                    连亏{report.currentParams?.circuitBreaker?.lossStreak ?? 4}笔·暂停
                    {report.currentParams?.circuitBreaker?.pauseDays ?? 10}天
                  </Text>
                </View>
              </SectionCard>

              {/* 方案对比 */}
              <PlanCompare report={report} />

              {/* 结论摘要 */}
              <SectionCard title="结论摘要">
                <Text className="text-[11px] text-[#8b93a7] leading-5">
                  {report.conclusion
                    ? `相对基线：${report.conclusion}`
                    : '寻优后胜率、捕捉率提升，最大回撤显著下降，收益基本持平。'}
                </Text>
              </SectionCard>

              {/* 熔断场景 */}
              <DrawdownScenarios scenarios={report.drawdownScenarios} />

              {/* 多目标 TOP */}
              <TopRank report={report} />

              {/* 稳健性 */}
              <RobustAudit report={report} />
            </>
          )}
        </ScrollView>
      )}
    </Screen>
  );
}
