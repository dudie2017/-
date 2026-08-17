import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { fetchBacktestVarieties, type BacktestVariety } from '@/utils/paperTradingApi';

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
    dominant: string;
    longCapture: number;
    shortCapture: number;
    splitLongAvg: number;
    splitShortAvg: number;
    note: string;
  } | null;
  circuitBreaker: { lossStreak: number; pauseBars: number } | null;
  hold: {
    productionLong: number;
    productionShort: number;
    verifiedBest: number;
    note: string;
  } | null;
  fragilityWarnings: string[];
  captureNote: string;
}

export default function VarietyReportScreen() {
  const { code } = useSafeSearchParams<{ code: string }>();
  const router = useSafeRouter();
  const [variety, setVariety] = useState<BacktestVariety | null>(null);
  const [context, setContext] = useState<StrategyContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!code) {
      setError('缺少品种代码');
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);

      const varietyList = await fetchBacktestVarieties();
      const found = varietyList.find((v) => v.code === code) ?? null;
      setVariety(found);

      /**
       * 服务端文件：server/src/routes/backtest.ts
       * 接口：GET /api/v1/backtest/strategy-context/:code
       * Path 参数：code: string
       */
      const ctxRes = await fetchWithTimeout(
        `${BACKEND_BASE}/api/v1/backtest/strategy-context/${code}`,
      );
      if (ctxRes.ok) {
        const ctxResult = await ctxRes.json();
        if (ctxResult.success && ctxResult.data) {
          setContext(ctxResult.data);
        }
      }
    } catch (e) {
      setError((e as Error).message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [code]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  if (loading) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator color="#00F0FF" />
          <Text className="text-[12px] text-[#8b93a7] mt-3">加载回测报告...</Text>
        </View>
      </Screen>
    );
  }

  if (error || !variety) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-[14px] text-[#e8eaf0] font-bold">
            {error || '未找到该品种的回测报告'}
          </Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="mt-4 px-5 py-2.5 rounded-xl bg-[#00F0FF]/10 border border-[#00F0FF]/30"
          >
            <Text className="text-[13px] text-[#00F0FF]">返回</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  const best = variety.best;
  const winRate = best?.winRate ?? variety.baseline.winRate;
  const profitFactor = best?.profitFactor ?? variety.baseline.profitFactor;
  const maxDrawdown = best?.maxDrawdown ?? variety.baseline.maxDrawdown;
  const totalPnl = best?.totalPnl ?? variety.baseline.totalPnl;

  return (
    <Screen>
      <ScrollView className="flex-1 px-4 pb-8" showsVerticalScrollIndicator={false}>
        {/* 顶部返回栏 */}
        <View className="flex-row items-center justify-between mt-2 mb-4">
          <TouchableOpacity onPress={() => router.back()} className="px-2 py-1">
            <Text className="text-[14px] text-[#00F0FF]">← 返回</Text>
          </TouchableOpacity>
          <Text className="text-[14px] font-bold text-[#e8eaf0]">品种回测报告</Text>
          <View className="w-12" />
        </View>

        {/* 品种基本信息 */}
        <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4">
          <View className="flex-row items-center gap-2">
            <Text className="text-[22px] font-bold text-[#e8eaf0]">{variety.name}</Text>
            <Text className="text-[13px] text-[#5a6272]">{variety.code}</Text>
            <Text className="text-[10px] text-[#00F0FF] bg-[#00F0FF]/10 px-2 py-0.5 rounded">
              {variety.sector}
            </Text>
          </View>
          <View className="flex-row flex-wrap gap-x-5 gap-y-1 mt-2">
            <Text className="text-[11px] text-[#8b93a7]">
              {variety.experiments} 次实验
            </Text>
            <Text className="text-[11px] text-[#8b93a7]">{variety.bars} 根K线</Text>
            <Text className="text-[11px] text-[#8b93a7]">{variety.dateRange}</Text>
          </View>
        </View>

        {/* 回测指标卡 */}
        <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
          <Text className="text-sm font-bold text-[#e8eaf0] mb-3">核心回测指标</Text>
          <View className="flex-row flex-wrap">
            <MetricItem label="胜率" value={`${winRate.toFixed(1)}%`} accent={winRate >= 50} />
            <MetricItem label="盈亏比 PF" value={profitFactor.toFixed(2)} accent={profitFactor >= 1.5} />
            <MetricItem label="最大回撤" value={`${maxDrawdown.toFixed(1)}%`} accent={maxDrawdown < 30} danger={maxDrawdown >= 30} />
            <MetricItem label="总收益" value={`${totalPnl.toFixed(0)}`} accent={totalPnl >= 0} danger={totalPnl < 0} />
          </View>
          {best && (
            <View className="mt-3 pt-3 border-t border-[#1e2431]">
              <Text className="text-[11px] text-[#8b93a7]">
                基线（默认参数）→ 最优综合方案（评分 {best.score.toFixed(1)}）：
                胜率 {variety.baseline.winRate.toFixed(1)}% → {best.winRate.toFixed(1)}%，
                回撤 {variety.baseline.maxDrawdown.toFixed(1)}% → {best.maxDrawdown.toFixed(1)}%
              </Text>
            </View>
          )}
        </View>

        {/* 策略上下文 */}
        {context && (
          <View className="rounded-2xl bg-[#131722] border border-[#1e2431] p-4 mt-3">
            <Text className="text-sm font-bold text-[#e8eaf0] mb-3">策略寻优结论</Text>

            {context.verification && (
              <View className="mb-3">
                <Text className="text-[12px] font-bold text-[#00F0FF] mb-1">寻优可信度</Text>
                <Text className="text-[12px] leading-5 text-[#c3c9d6]">
                  收益排名 {context.verification.pnlRank}/{context.verification.total}
                  （前 {context.verification.pnlTopPct}%），回撤排名 {context.verification.ddRank}/
                  {context.verification.total}（前 {context.verification.ddTopPct}%）
                </Text>
              </View>
            )}

            {context.directionBias && (
              <View className="mb-3">
                <Text className="text-[12px] font-bold text-[#00F0FF] mb-1">
                  方向偏好：{context.directionBias.dominant}
                </Text>
                <Text className="text-[12px] leading-5 text-[#c3c9d6]">
                  多头捕获率 {context.directionBias.longCapture.toFixed(2)}，空头捕获率{' '}
                  {context.directionBias.shortCapture.toFixed(2)}
                </Text>
                <Text className="text-[11px] leading-5 text-[#8b93a7] mt-1">
                  {context.directionBias.note}
                </Text>
              </View>
            )}

            {context.hold && (
              <View className="mb-3">
                <Text className="text-[12px] font-bold text-[#00F0FF] mb-1">持仓周期</Text>
                <Text className="text-[12px] leading-5 text-[#c3c9d6]">
                  多单 {context.hold.productionLong} 根 · 空单 {context.hold.productionShort} 根
                  {context.hold.verifiedBest
                    ? ` · 寻优最优 ${context.hold.verifiedBest} 根`
                    : ''}
                </Text>
                {context.hold.note ? (
                  <Text className="text-[11px] leading-5 text-[#8b93a7] mt-1">
                    {context.hold.note}
                  </Text>
                ) : null}
              </View>
            )}

            {context.circuitBreaker && (
              <View className="mb-3">
                <Text className="text-[12px] font-bold text-[#00F0FF] mb-1">熔断参数</Text>
                <Text className="text-[12px] leading-5 text-[#c3c9d6]">
                  连亏 {context.circuitBreaker.lossStreak} 笔 · 暂停 {context.circuitBreaker.pauseBars} 根
                </Text>
              </View>
            )}

            {context.fragilityWarnings.length > 0 && (
              <View className="mb-3">
                <Text className="text-[12px] font-bold text-amber-400 mb-1">脆弱点警告</Text>
                {context.fragilityWarnings.map((w, i) => (
                  <Text key={i} className="text-[11px] leading-5 text-amber-300/80">
                    · {w}
                  </Text>
                ))}
              </View>
            )}

            {context.captureNote ? (
              <View className="pt-3 border-t border-[#1e2431]">
                <Text className="text-[11px] leading-5 text-[#8b93a7]">{context.captureNote}</Text>
              </View>
            ) : null}
          </View>
        )}

        {/* AG0 专项深度研究（保留入口，统一从深度报告进入） */}
        {code === 'AG0' && (
          <TouchableOpacity
            onPress={() => router.push('/ag0-report')}
            className="mt-3 rounded-2xl bg-[#141a2b] border border-[#2a3550] p-4 flex-row items-center justify-between"
          >
            <View className="flex-1">
              <Text className="text-sm font-bold text-[#e8eaf0]">AG0 专项深度研究</Text>
              <Text className="text-[11px] text-[#8b93a7] mt-1 leading-4">
                三方案参数对比 · 熔断回撤实验 · 多目标 TOP10 · 稳健性审计
              </Text>
            </View>
            <Text className="text-[#00F0FF] text-[12px] font-bold ml-3">查看 →</Text>
          </TouchableOpacity>
        )}

        <Text className="text-[10px] text-[#5a6272] text-center mt-4 leading-4">
          数据来源：{variety.code} 的 {variety.experiments} 次参数寻优实验{'\n'}
          回测结果不代表未来收益，实盘请结合当前行情与风险控制
        </Text>
      </ScrollView>
    </Screen>
  );
}

function MetricItem({
  label,
  value,
  accent,
  danger,
}: {
  label: string;
  value: string;
  accent: boolean;
  danger?: boolean;
}) {
  const color = danger ? 'text-rose-400' : accent ? 'text-emerald-400' : 'text-[#e8eaf0]';
  return (
    <View className="w-1/2 mb-3">
      <Text className="text-[11px] text-[#8b93a7]">{label}</Text>
      <Text className={`text-[18px] font-bold ${color}`}>{value}</Text>
    </View>
  );
}
