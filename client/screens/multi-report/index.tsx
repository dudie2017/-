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
  fetchMultiReport,
  type MultiReportData,
  type MultiItem,
  type MultiStats,
} from '@/utils/multiReportApi';

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
const rankColor = (v?: number) => {
  if (v == null) return 'text-[#8b93a7]';
  const p = v / 1001;
  if (p < 0.05) return 'text-emerald-400';
  if (p < 0.25) return 'text-[#00F0FF]';
  if (p < 0.5) return 'text-amber-400';
  return 'text-red-400';
};
const cbLabel = (cb: MultiItem['circuitBreaker']) =>
  cb ? `连亏${cb.lossStreak}笔·暂停${cb.pauseBars}根` : '不启用';

const fmtRank = (r: { pnl: number; dd: number; capture: number } | null) =>
  r ? `收益#${r.pnl} 回撤#${r.dd} 捕获#${r.capture}` : '--';

const DIR_LABEL: Record<string, string> = {
  split: '多空分离',
  both: '统一参数',
  longOnly: '只做多',
  shortOnly: '只做空',
};

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

function StatRow({ stats }: { stats?: MultiStats | null }) {
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
        <StatCard label="盈亏比" value={stats.profitFactor ? stats.profitFactor.toFixed(2) : '--'} />
      </View>
    </View>
  );
}

function CaptureBar({ stats }: { stats?: MultiStats | null }) {
  if (!stats) return null;
  const abnormalLong = (stats.longCapture ?? 0) > 1.0;
  const abnormalShort = (stats.shortCapture ?? 0) > 1.0;
  return (
    <View className="flex-row gap-2 mt-2">
      <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
        <Text className="text-[10px] text-[#5a6272]">做多捕获</Text>
        <Text className={`text-sm font-bold ${abnormalLong ? 'text-amber-400' : 'text-[#e8eaf0]'}`}>
          {pct(stats.longCapture)}
          {abnormalLong ? ' [!]超基准' : ''}
        </Text>
      </View>
      <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
        <Text className="text-[10px] text-[#5a6272]">做空捕获</Text>
        <Text className={`text-sm font-bold ${abnormalShort ? 'text-amber-400' : 'text-[#e8eaf0]'}`}>
          {pct(stats.shortCapture)}
          {abnormalShort ? ' [!]超基准' : ''}
        </Text>
      </View>
      <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
        <Text className="text-[10px] text-[#5a6272]">整体捕获</Text>
        <Text className="text-sm font-bold text-[#e8eaf0]">{pct(stats.capture)}</Text>
      </View>
    </View>
  );
}

// ============ 品种卡片 ============

function VarianceList({ variance }: { variance: MultiItem['variance'] }) {
  if (!variance.length) return null;
  return (
    <View className="mt-3">
      <Text className="text-[11px] text-[#8b93a7] mb-1.5">收益方差分解（影响最大的维度）</Text>
      {variance.slice(0, 3).map((v, i) => (
        <View
          key={v.dimension}
          className="flex-row items-center justify-between py-1.5 border-b border-[#161b26]"
        >
          <Text className="text-xs text-[#e8eaf0] flex-1">
            {i + 1}. {v.dimension}
          </Text>
          <Text className="text-xs font-bold text-[#00F0FF] w-[70px] text-right">
            {(v.explained * 100).toFixed(1)}%
          </Text>
          <Text className="text-[10px] text-[#5a6272] w-[90px] text-right">
            最优={String(v.bestValue)}
          </Text>
        </View>
      ))}
    </View>
  );
}

function FragilityList({ fragility }: { fragility: MultiItem['fragility'] }) {
  if (!fragility.length) return null;
  return (
    <View className="mt-3">
      <Text className="text-[11px] text-[#8b93a7] mb-1.5">脆弱点（崩溃率提升）</Text>
      {fragility.slice(0, 3).map((f, i) => (
        <View
          key={`${f.dimension}-${String(f.value)}`}
          className="flex-row items-center justify-between py-1.5 border-b border-[#161b26]"
        >
          <Text className="text-xs text-[#e8eaf0] flex-1">
            {f.dimension}={String(f.value)}
          </Text>
          <Text className="text-xs font-bold text-red-400 w-[60px] text-right">
            {f.lift.toFixed(2)}x
          </Text>
        </View>
      ))}
    </View>
  );
}

function TopRecipeList({ topComposite }: { topComposite: MultiItem['topComposite'] }) {
  if (!topComposite.length) return null;
  return (
    <View className="mt-3">
      <Text className="text-[11px] text-[#8b93a7] mb-1.5">1000 次实验最优配方 TOP3</Text>
      {topComposite.map((t, i) => (
        <View
          key={i}
          className="rounded-xl bg-[#0e1420] border border-[#1e2431] p-3 mb-2"
        >
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-bold text-[#00F0FF]">TOP {i + 1}</Text>
            <Text className={`text-xs font-bold ${color(t.stats.totalPnl)}`}>
              {money(t.stats.totalPnl)} · {pct(t.stats.winRate)}
            </Text>
          </View>
          <Text className="text-[11px] text-[#8b93a7] mt-1.5 leading-5">
            方向 {DIR_LABEL[t.recipe.directionMode] ?? t.recipe.directionMode} · 熔断{' '}
            {t.recipe.circuitBreaker ?? 'off'} · hold {t.recipe.maxHoldDays} · 止损{' '}
            {t.recipe.stopAtrMult} / 止盈 {t.recipe.targetAtrMult} · {t.recipe.minSignalGrade}
          </Text>
        </View>
      ))}
    </View>
  );
}

function ItemCard({ item, rank }: { item: MultiItem; rank: number }) {
  const [open, setOpen] = useState(false);
  const router = useSafeRouter();
  // TOP1 配方优先展示（生产参数已升级至寻优 TOP1）
  const stats = item.topComposite[0]?.stats ?? item.baseline.stats;
  return (
    <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
      {/* 头部 */}
      <TouchableOpacity onPress={() => setOpen(!open)}>
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center gap-2.5">
            <View className="w-9 h-9 rounded-xl bg-[#00F0FF]/10 border border-[#00F0FF]/30 items-center justify-center">
              <Text className="text-sm font-black text-[#00F0FF]">{rank}</Text>
            </View>
            <View>
              <Text className="text-base font-bold text-[#e8eaf0]">
                {item.code} <Text className="text-xs font-normal text-[#8b93a7]">{item.name}</Text>
              </Text>
              <Text className="text-[10px] text-[#5a6272]">
                {item.dateRange} · {item.bars}根K线
              </Text>
            </View>
          </View>
          <Text className="text-[#5a6272] text-xs">{open ? '收起 ▲' : '展开 ▼'}</Text>
        </View>
        {/* TOP1 核心指标（未展开即可横向对比） */}
        <View className="flex-row gap-2 mt-3">
          <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
            <Text className="text-[10px] text-[#5a6272]">TOP1 胜率</Text>
            <Text className="text-sm font-bold text-emerald-400 mt-0.5">{pct(stats?.winRate)}</Text>
          </View>
          <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
            <Text className="text-[10px] text-[#5a6272]">TOP1 收益</Text>
            <Text className={`text-sm font-bold mt-0.5 ${color(stats?.totalPnl)}`}>{money(stats?.totalPnl)}</Text>
          </View>
          <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
            <Text className="text-[10px] text-[#5a6272]">TOP1 回撤</Text>
            <Text className="text-sm font-bold text-amber-400 mt-0.5">{pct(stats?.maxDrawdown)}</Text>
          </View>
        </View>
      </TouchableOpacity>

      {/* 深度报告入口 */}
      <TouchableOpacity
        onPress={() => router.push('/variety-report', { code: item.code })}
        className="mt-3 flex-row items-center justify-center gap-1.5 rounded-xl bg-[#00F0FF]/10 border border-[#00F0FF]/25 py-2.5"
      >
        <Text className="text-xs font-bold text-[#00F0FF]">查看 {item.code} 深度报告 →</Text>
      </TouchableOpacity>

      {/* 折叠详情 */}
      {open ? (
        <>
          <View className="mt-3">
            <StatRow stats={stats} />
          </View>
          <CaptureBar stats={stats} />
          <View className="flex-row gap-2 mt-2">
            <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
              <Text className="text-[10px] text-[#5a6272]">1000次排名</Text>
              <Text className={`text-xs font-bold mt-0.5 ${rankColor(item.baseline.rank?.pnl)}`}>
                {fmtRank(item.baseline.rank)}
              </Text>
            </View>
            <View className="flex-1 rounded-xl bg-[#0e1420] border border-[#1e2431] px-3 py-2">
              <Text className="text-[10px] text-[#5a6272]">熔断建议</Text>
              <Text className="text-xs font-bold text-[#e8eaf0] mt-0.5">
                {item.circuitBreaker ? cbLabel(item.circuitBreaker) : '不启用'}
              </Text>
            </View>
          </View>
          <VarianceList variance={item.variance} />
          <FragilityList fragility={item.fragility} />
          <TopRecipeList topComposite={item.topComposite} />
        </>
      ) : null}
    </View>
  );
}

// ============ 结论卡片 ============

function ConclusionCard({ conclusions }: { conclusions: string[] }) {
  return (
    <SectionCard title="回测统一结论与生产意见">
      {conclusions.map((c, i) => (
        <View key={i} className="flex-row items-start mb-2.5">
          <View className="w-5 h-5 rounded-md bg-[#00F0FF]/10 border border-[#00F0FF]/30 items-center justify-center mr-2.5 mt-0.5">
            <Text className="text-[10px] font-bold text-[#00F0FF]">{i + 1}</Text>
          </View>
          <Text className="flex-1 text-xs text-[#c9ced8] leading-5">{c}</Text>
        </View>
      ))}
    </SectionCard>
  );
}

// ============ 主页面 ============

export function MultiReportContent() {
  const router = useSafeRouter();
  const [data, setData] = useState<MultiReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await fetchMultiReport();
      setData(d);
      setError(null);
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
    <>
      <ScrollView
        className="flex-1 px-4 pt-3"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              load();
            }}
            tintColor="#00F0FF"
          />
        }
      >
        {/* 头部 */}
        <View className="mt-2">
          <TouchableOpacity onPress={() => router.back()} className="mb-3">
            <Text className="text-[#00F0FF] text-sm">← 返回</Text>
          </TouchableOpacity>
          <View className="rounded-2xl bg-gradient-to-b from-[#0e2a33] to-[#0a0a0f] border border-[#00F0FF]/25 p-4">
            <Text className="text-lg font-black text-[#e8eaf0]">回测数据对比 · 1000 次回测</Text>
            <Text className="text-[11px] text-[#8b93a7] mt-1">
              {data ? `${data.items.length} 个品种` : '多品种'} · 24 维方法论空间 LHS 采样
            </Text>
          </View>
        </View>

        {/* 加载态 */}
        {loading ? (
          <View className="items-center py-20">
            <ActivityIndicator size="large" color="#00F0FF" />
            <Text className="text-[#8b93a7] text-sm mt-3">加载回测数据对比…</Text>
          </View>
        ) : error ? (
          <View className="rounded-2xl bg-[#1a1220] border border-red-500/30 p-5 mt-4">
            <Text className="text-red-400 text-sm text-center">{error}</Text>
            <TouchableOpacity
              onPress={load}
              className="mt-4 rounded-xl bg-[#00F0FF] py-2.5 items-center"
            >
              <Text className="text-[#0a0a0f] font-bold text-sm">重试</Text>
            </TouchableOpacity>
          </View>
        ) : data ? (
          <>
            <ConclusionCard conclusions={data.conclusions} />
            {data.items.map((item, i) => (
              <ItemCard key={item.code} item={item} rank={i + 1} />
            ))}
            <View className="h-10" />
          </>
        ) : null}
      </ScrollView>
    </>
  );
}

export default function MultiReportScreen() {
  return (
    <Screen className="bg-[#0a0a0f]">
      <MultiReportContent />
    </Screen>
  );
}
