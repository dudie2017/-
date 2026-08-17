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
import { useSafeRouter } from '@/hooks/useSafeRouter';
import {
  fetchPaperPerformance,
  fetchBacktestVarieties,
  type PaperPerformance,
  type BacktestVariety,
} from '@/utils/paperTradingApi';

const formatPnl = (v: number | undefined | null) => {
  const val = v ?? 0;
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(2)}%`;
};

const pnlColor = (v: number | undefined | null) => ((v ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400');

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <View className="flex-1 rounded-2xl bg-[#131722] p-3 border border-[#1e2431]">
      <Text className="text-[11px] text-[#8b93a7]">{label}</Text>
      <Text
        className={`text-lg font-bold mt-1 ${accent ? 'text-amber-400' : 'text-[#e8eaf0]'}`}
      >
        {value}
      </Text>
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

// 收益曲线（SVG 风格简化版：用横向条带展示累计收益演进）
function EquityCurve({ points }: { points: PaperPerformance['equityCurve'] }) {
  if (!points || points.length === 0) {
    return <Text className="text-center text-[#5a6272] text-xs py-6">暂无已平仓交易</Text>;
  }

  const maxAbs = points.reduce((max, p) => Math.max(max, Math.abs(p.cumulativePnl ?? 0)), 1);
  // 采样最多 40 个点
  const step = Math.max(1, Math.floor(points.length / 40));
  const sampled = points.filter((_, i) => i % step === 0);
  const last = sampled[sampled.length - 1];

  return (
    <View>
      <View className="flex-row justify-between items-end mb-2">
        <Text className="text-[11px] text-[#5a6272]">起点</Text>
        <Text className={`text-sm font-bold ${pnlColor(last?.cumulativePnl || 0)}`}>
          {formatPnl(last?.cumulativePnl || 0)}
        </Text>
        <Text className="text-[11px] text-[#5a6272]">{last?.date || ''}</Text>
      </View>
      <View className="h-28 justify-center">
        {sampled.map((p, i) => {
          const height = Math.max(2, (Math.abs(p.cumulativePnl ?? 0) / maxAbs) * 80);
          return (
            <View key={i} className="flex-row items-center mb-[3px]">
              <View
                className={`h-[3px] rounded-full ${(p.cumulativePnl ?? 0) >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
                style={{ width: Math.max(4, height * 1.2) }}
              />
              <Text className="ml-2 text-[9px] text-[#5a6272] w-14">{p.date}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

// 信号来源分布
function SignalTypeBar({ data }: { data: PaperPerformance['signalTypeDist'] }) {
  if (!data || data.length === 0) return null;
  const total = data.reduce((s, d) => s + (d.trades ?? 0), 0) || 1;
  return (
    <View>
      {data.map((d) => (
        <View key={d.type} className="mb-2">
          <View className="flex-row justify-between mb-1">
            <Text className="text-[11px] text-[#8b93a7]">
              {d.type} · {d.count ?? 0}笔
            </Text>
            <Text className={`text-[11px] font-semibold ${pnlColor(d.pnl)}`}>
              {formatPnl(d.pnl)} · {d.winRate ?? 0}%
            </Text>
          </View>
          <View className="h-2 bg-[#1e2431] rounded-full overflow-hidden">
            <View
              className={`h-full rounded-full ${d.pnl >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
              style={{ width: `${(d.count / total) * 100}%` }}
            />
          </View>
        </View>
      ))}
    </View>
  );
}

// 多空分布
function DirectionCard({ data }: { data: PaperPerformance['directionDist'] }) {
  if (!data) return null;
  const rows = [
    { label: '做多', count: data.longCount ?? 0, winRate: data.longWinRate ?? 0, pnl: data.longPnl ?? 0 },
    { label: '做空', count: data.shortCount ?? 0, winRate: data.shortWinRate ?? 0, pnl: data.shortPnl ?? 0 },
  ];
  return (
    <View className="flex-row gap-3">
      {rows.map((r) => (
        <View key={r.label} className="flex-1 rounded-xl bg-[#0d1117] p-3">
          <Text className="text-[11px] text-[#8b93a7]">{r.label}</Text>
          <Text className="text-base font-bold text-[#e8eaf0] mt-1">{r.count} 笔</Text>
          <Text className="text-[10px] text-[#5a6272] mt-0.5">胜率 {r.winRate}%</Text>
          <Text className={`text-[11px] font-semibold ${pnlColor(r.pnl)}`}>
            {formatPnl(r.pnl)}
          </Text>
        </View>
      ))}
    </View>
  );
}

// 品种收益排行
function VarietyRank({ data }: { data: PaperPerformance['byVariety'] }) {
  if (!data || data.length === 0) {
    return <Text className="text-center text-[#5a6272] text-xs py-4">暂无数据</Text>;
  }
  return (
    <View>
      {data.slice(0, 8).map((v, i) => (
        <View
          key={v.code}
          className="flex-row items-center justify-between py-2 border-b border-[#1e2431] last:border-0"
        >
          <View className="flex-row items-center gap-2 flex-1">
            <Text className="text-[10px] text-[#5a6272] w-4">{i + 1}</Text>
            <Text className="text-xs font-semibold text-[#e8eaf0]">{v.code}</Text>
            <Text className="text-[10px] text-[#8b93a7]">
              {v.trades ?? 0}笔 · 胜率{v.winRate ?? 0}%
            </Text>
          </View>
          <Text className={`text-xs font-bold ${pnlColor(v.pnl)}`}>{formatPnl(v.pnl)}</Text>
        </View>
      ))}
    </View>
  );
}

// 月度收益
function MonthlyPnl({ data }: { data: PaperPerformance['monthlyPnl'] }) {
  if (!data || data.length === 0) {
    return <Text className="text-center text-[#5a6272] text-xs py-4">暂无数据</Text>;
  }
  const maxAbs = data.reduce((max, m) => Math.max(max, Math.abs(m.pnl ?? 0)), 1);
  return (
    <View>
      {data.map((m) => (
        <View key={m.month} className="flex-row items-center gap-2 py-1.5">
          <Text className="text-[10px] text-[#8b93a7] w-16">{m.month}</Text>
          <View className="flex-1 h-2 bg-[#1e2431] rounded-full overflow-hidden">
            <View
              className={`h-full rounded-full ${(m.pnl ?? 0) >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`}
              style={{
                width: `${Math.max(3, (Math.abs(m.pnl ?? 0) / maxAbs) * 100)}%`,
                alignSelf: (m.pnl ?? 0) >= 0 ? 'flex-start' : 'flex-end',
              }}
            />
          </View>
          <Text className={`text-[10px] font-semibold w-16 text-right ${pnlColor(m.pnl)}`}>
            {formatPnl(m.pnl)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function VarietyReportList({ varieties }: { varieties: BacktestVariety[] }) {
  const router = useSafeRouter();
  if (!varieties || varieties.length === 0) {
    return (
      <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
        <Text className="text-sm font-bold text-[#e8eaf0]">品种回测报告</Text>
        <Text className="text-[11px] text-[#8b93a7] mt-1">暂无回测数据</Text>
      </View>
    );
  }

  return (
    <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
      <View className="flex-row items-center justify-between mb-2">
        <Text className="text-sm font-bold text-[#e8eaf0]">品种回测报告</Text>
        <Text className="text-[10px] text-[#5a6272]">{varieties.length} 个品种 · 点击查看详情</Text>
      </View>
      {varieties.map((v, i) => {
        const bestWin = v.best?.winRate ?? v.baseline?.winRate ?? 0;
        const bestPf = v.best?.profitFactor ?? v.baseline?.profitFactor ?? 0;
        const bestDd = v.best?.maxDrawdown ?? v.baseline?.maxDrawdown ?? 0;
        return (
          <TouchableOpacity
            key={v.code}
            onPress={() => router.push('/variety-report', { code: v.code })}
            className={`flex-row items-center justify-between py-2.5 ${i > 0 ? 'border-t border-[#1e2431]' : ''}`}
          >
            <View className="flex-1">
              <View className="flex-row items-center gap-2">
                <Text className="text-[13px] font-bold text-[#e8eaf0]">{v.name}</Text>
                <Text className="text-[10px] text-[#5a6272]">{v.code}</Text>
                <Text className="text-[9px] text-[#00F0FF] bg-[#00F0FF]/10 px-1.5 py-0.5 rounded">{v.sector}</Text>
              </View>
              <Text className="text-[10px] text-[#8b93a7] mt-0.5">
                {v.experiments} 次实验 · {v.bars} 根K线{v.dateRange ? ` · ${v.dateRange}` : ''}
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-[12px] font-bold text-emerald-400">{bestWin.toFixed(1)}%</Text>
              <Text className="text-[10px] text-[#5a6272]">
                PF {bestPf.toFixed(2)} · 回撤 {bestDd.toFixed(1)}%
              </Text>
            </View>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

export default function PaperPerformanceScreen() {
  const [data, setData] = useState<PaperPerformance | null>(null);
  const [varieties, setVarieties] = useState<BacktestVariety[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useSafeRouter();

  const load = useCallback(async (isRefresh = false) => {
    try {
      if (isRefresh) setRefreshing(true);
      else setLoading(true);
      setError(null);
      const [result, varietyList] = await Promise.all([
        fetchPaperPerformance(),
        fetchBacktestVarieties().catch(() => []),
      ]);
      setData(result);
      setVarieties(varietyList);
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

  if (loading) {
    return (
      <View className="flex-1">
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#f59e0b" />
          <Text className="text-[#8b93a7] mt-3 text-xs">加载绩效数据…</Text>
        </View>
      </View>
    );
  }

  const s = data?.summary;
  const hasClosed = (s?.totalTrades || 0) > 0;

  return (
    <View className="flex-1">
      <ScrollView
        className="flex-1 px-4"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor="#f59e0b" />
        }
      >
        <View className="pt-4 pb-2">
          <Text className="text-xl font-bold text-[#e8eaf0]">模拟盘绩效看板</Text>
          <Text className="text-[11px] text-[#8b93a7] mt-1">
            基于传播链信号的模拟交易统计 · 含交易成本
          </Text>
        </View>

        {/* 回测报告入口 */}
        <VarietyReportList varieties={varieties} />

        {error ? (
          <View className="rounded-2xl bg-red-500/10 border border-red-500/30 p-4 mt-3">
            <Text className="text-red-400 text-xs">{error}</Text>
          </View>
        ) : null}

        {/* 统计卡片 */}
        <View className="flex-row gap-3 mt-2">
          <StatCard label="总交易" value={`${s?.totalTrades || 0}笔`} sub={`持仓 ${s?.openTrades || 0}`} />
          <StatCard label="胜率" value={`${Math.round((s?.winRate || 0) * 100)}%`} sub={`${s?.winTrades || 0}胜`} accent />
          <StatCard label="盈利因子" value={(s?.profitFactor ?? 0).toFixed(2)} sub="PF" />
        </View>
        <View className="flex-row gap-3 mt-3">
          <StatCard label="累计收益" value={formatPnl(s?.totalPnl || 0)} sub="净收益%" accent />
          <StatCard label="最大回撤" value={`${s?.maxDrawdown || 0}%`} sub="从峰值" />
          <StatCard label="平均持有" value={`${s?.avgHoldDays ?? 0}天`} sub={`赢${s?.avgWin ?? 0}% 亏${s?.avgLoss ?? 0}%`} />
        </View>

        {/* 高级风险指标 */}
        {data?.riskMetrics ? (
          <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
            <Text className="text-sm font-bold text-[#e8eaf0] mb-3">风险调整指标</Text>
            <View className="flex-row flex-wrap gap-3">
              <View className="flex-1 min-w-[100px] rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">Sharpe Ratio</Text>
                <Text className={`text-lg font-bold mt-1 ${(data.riskMetrics.sharpeRatio ?? 0) >= 1 ? 'text-emerald-400' : (data.riskMetrics.sharpeRatio ?? 0) >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                  {(data.riskMetrics.sharpeRatio ?? 0).toFixed(2)}
                </Text>
                <Text className="text-[9px] text-[#5a6272] mt-0.5">风险调整收益</Text>
              </View>
              <View className="flex-1 min-w-[100px] rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">Sortino Ratio</Text>
                <Text className={`text-lg font-bold mt-1 ${(data.riskMetrics.sortinoRatio ?? 0) >= 1.5 ? 'text-emerald-400' : (data.riskMetrics.sortinoRatio ?? 0) >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                  {(data.riskMetrics.sortinoRatio ?? 0).toFixed(2)}
                </Text>
                <Text className="text-[9px] text-[#5a6272] mt-0.5">下行风险调整</Text>
              </View>
              <View className="flex-1 min-w-[100px] rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">Calmar Ratio</Text>
                <Text className={`text-lg font-bold mt-1 ${(data.riskMetrics.calmarRatio ?? 0) >= 2 ? 'text-emerald-400' : (data.riskMetrics.calmarRatio ?? 0) >= 0 ? 'text-amber-400' : 'text-red-400'}`}>
                  {(data.riskMetrics.calmarRatio ?? 0).toFixed(2)}
                </Text>
                <Text className="text-[9px] text-[#5a6272] mt-0.5">收益/回撤比</Text>
              </View>
            </View>
            <View className="flex-row gap-3 mt-3">
              <View className="flex-1 rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">年化收益率</Text>
                <Text className={`text-base font-bold mt-1 ${pnlColor(data.riskMetrics.annualizedReturn)}`}>
                  {(data.riskMetrics.annualizedReturn ?? 0).toFixed(2)}%
                </Text>
              </View>
              <View className="flex-1 rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">年化波动率</Text>
                <Text className="text-base font-bold mt-1 text-[#e8eaf0]">
                  {(data.riskMetrics.annualizedVolatility ?? 0).toFixed(2)}%
                </Text>
              </View>
              <View className="flex-1 rounded-xl bg-[#0d1117] p-3">
                <Text className="text-[10px] text-[#8b93a7]">交易天数</Text>
                <Text className="text-base font-bold mt-1 text-[#e8eaf0]">
                  {data.riskMetrics.tradingDays ?? 0}天
                </Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* 收益曲线 */}
        <SectionCard title="累计收益曲线">
          <EquityCurve points={data?.equityCurve || []} />
        </SectionCard>

        {/* 信号来源分布 */}
        <SectionCard title="信号来源分布">
          <SignalTypeBar data={data?.signalTypeDist || []} />
        </SectionCard>

        {/* 多空分布 */}
        <SectionCard title="多空表现">
          <DirectionCard data={data?.directionDist || { longCount: 0, shortCount: 0, longWinRate: 0, shortWinRate: 0, longPnl: 0, shortPnl: 0 }} />
        </SectionCard>

        {/* 品种收益排行 */}
        <SectionCard title="品种收益排行">
          <VarietyRank data={data?.byVariety || []} />
        </SectionCard>

        {/* 月度收益 */}
        <SectionCard title="月度收益">
          <MonthlyPnl data={data?.monthlyPnl || []} />
        </SectionCard>

        <View className="h-8" />
      </ScrollView>
    </View>
  );
}
