import { BACKEND_BASE, fetchWithTimeout } from '@/utils/api';
import { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Dimensions,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeSearchParams, useSafeRouter } from '@/hooks/useSafeRouter';
import { CandlestickChart, type TradeMarker } from '@/components/chart/CandlestickChart';
import { fetchTrainingKline, type KlineBar } from '@/utils/trainingApi';

const API_BASE = BACKEND_BASE;

const UP = '#22C55E';
const DOWN = '#EF4444';
const WARN = '#F59E0B';
const ACCENT = '#00F0FF';

const VARIETY_NAMES: Record<string, string> = {
  'LH0': '生猪', 'JM0': '焦煤', 'M0': '豆粕', 'AG0': '沪银', 'RU0': '橡胶',
};

interface StrategyContext {
  code: string;
  name: string;
  verified: boolean;
  verification?: {
    pnlRank: number; ddRank: number; total: number;
    pnlTopPct: number; ddTopPct: number;
  };
  directionBias?: {
    dominant: 'LONG' | 'SHORT' | 'BALANCED';
    longCapture: number; shortCapture: number;
    note: string;
  };
  circuitBreaker?: { lossStreak: number; pauseBars: number } | null;
  hold?: { productionLong: number; productionShort: number; verifiedBest: number | null; note: string };
  fragilityWarnings: string[];
  captureNote: string;
}

interface AdviceData {
  varietyCode?: string;
  varietyName?: string;
  direction?: string;
  signalGrade?: string;
  entryPrice?: number;
  stopLoss?: number;
  support?: number;
  resistance?: number;
  target1?: number;
  target2?: number;
  riskAmount?: number;
  riskPerUnit?: number;
  contractMultiplier?: number;
  maxPosition?: number;
  costData?: {
    openFee: number; closeFee: number; totalFee: number;
    marginRate: number; marginPerContract: number;
    breakevenPoints: number; actualRisk: number; totalCapitalRequired: number;
  };
  entryTiming?: string;
  entryConditions?: string[];
  summary?: string;
  analysis?: string;
  alertLevel?: string;
  alertMessage?: string;
  equationRR?: number;
  equationPassed?: boolean;
  currentPrice?: number;
  contract?: string;
  strategyContext?: StrategyContext | null;
  newsContext?: {
    varietyName: string;
    news: Array<{ title: string; source: string; url: string; snippet?: string }>;
    detectedEvents: Array<{
      event: { title: string; categoryName: string; direction: '利多' | '利空'; varieties: string[] };
      confidence: number;
      affectedVarieties: string[];
    }>;
    propagationAlerts: Array<{
      leader: string; follower: string; direction: '利多' | '利空';
      sector: string; logic: string; lag: number;
    }>;
  } | null;
}

function fmt(n: number | undefined, digits = 2): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function fmtWan(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '-';
  if (Math.abs(n) >= 10000) return (n / 10000).toFixed(1) + '万';
  return n.toLocaleString('zh-CN');
}

export default function TradePlanScreen() {
  const router = useSafeRouter();
  const { varietyCode: code } = useSafeSearchParams<{ varietyCode: string }>();
  const [data, setData] = useState<AdviceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [klineBars, setKlineBars] = useState<KlineBar[]>([]);
  const [tradeMarkers, setTradeMarkers] = useState<TradeMarker[]>([]);

  const load = useCallback(async () => {
    if (!code) { setError('缺少品种代码'); setLoading(false); return; }
    try {
      setError('');
      /**
       * 服务端文件：server/src/routes/optimization.ts
       * 接口：GET /api/v1/optimization/trading-advice/:code
       * Path 参数：code: string（品种代码，如 AG0）
       */
      /**
       * 服务端文件：server/src/routes/optimization.ts
       * 接口：GET /api/v1/optimization/trading-advice/:code
       * Path 参数：code: string
       */
      const [adviceRes, klineRes, tradesRes] = await Promise.all([
        fetchWithTimeout(`${API_BASE}/api/v1/optimization/trading-advice/${encodeURIComponent(code)}`),
        fetchTrainingKline(code, 120),
        fetchWithTimeout(`${API_BASE}/api/v1/sim-trades?code=${encodeURIComponent(code)}`),
      ]);

      const j = await adviceRes.json();
      if (j.success && j.data) {
        // 后端返回扁平结构：data = { ...advice, currentPrice, contract, strategyContext, newsContext }
        setData(j.data);
      } else {
        setError(j.error || '未获取到建议');
      }

      // K 线
      if (klineRes && Array.isArray(klineRes.bars) && klineRes.bars.length > 0) {
        setKlineBars(klineRes.bars);
      }

      /**
       * 服务端文件：server/src/routes/journal.ts
       * 接口：GET /api/v1/sim-trades?code=:code
       * Query 参数：code: string
       */
      const tj = await tradesRes.json();
      if (Array.isArray(tj.trades)) {
        const markers: TradeMarker[] = [];
        for (const t of tj.trades) {
          const entryDate = (t.entry_date || '').slice(0, 10);
          const entryPrice = Number(t.entry_price);
          if (entryDate && !Number.isNaN(entryPrice) && entryPrice > 0) {
            markers.push({ date: entryDate, price: entryPrice, type: t.direction === '多' ? 'long-open' : 'short-open' });
          }
          const exitDate = (t.exit_date || '').slice(0, 10);
          const exitPrice = Number(t.exit_price);
          if (t.status === 'closed' && exitDate && !Number.isNaN(exitPrice) && exitPrice > 0) {
            markers.push({ date: exitDate, price: exitPrice, type: t.direction === '多' ? 'long-close' : 'short-close' });
          }
        }
        setTradeMarkers(markers);
      }
    } catch (e: any) {
      setError(e.message || '加载失败');
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
          <ActivityIndicator size="large" color={ACCENT} />
          <Text className="mt-3 text-sm text-gray-500">正在生成交易计划...</Text>
        </View>
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen>
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-base font-bold text-red-400">{error}</Text>
          <TouchableOpacity className="mt-4 rounded-xl bg-gray-800 px-6 py-3" onPress={() => router.back()}>
            <Text className="text-sm text-white">返回</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  if (!data) return null;

  const dir = (data.direction || '').toUpperCase();
  const hasSignal = !!data.direction;
  const isLong = dir === 'BUY' || dir === 'LONG' || dir === '做多';
  const dirColor = hasSignal ? (isLong ? UP : DOWN) : '#6B7280';
  const sc = data.strategyContext;
  const nc = data.newsContext;
  const grade = data.signalGrade || '';

  // 可实施交易清单（基于建议 + 策略上下文生成）
  const steps: Array<{ title: string; desc: string; color?: string }> = [];
  const entryCond = (data.entryConditions || []).join('；');
  let stepNum = 1;
  if (hasSignal) {
    steps.push({ title: `${stepNum}. 入场触发`, desc: `${isLong ? '做多' : '做空'}：当价格${isLong ? '站稳突破' : '跌破'} ${fmt(data.entryPrice)} 且信号等级 ≥ ${grade || 'L2'} 时执行入场${entryCond ? '（确认条件：' + entryCond + '）' : ''}` });
    stepNum++;
    steps.push({ title: `${stepNum}. 止损位`, desc: `初始止损设于 ${fmt(data.stopLoss)}（每手风险 ${fmt(data.riskPerUnit)} 点 / ${fmtWan(data.costData?.actualRisk)} 元）` });
    stepNum++;
    steps.push({ title: `${stepNum}. 移动止损`, desc: `盈利达到 1 倍风险后，止损上移/下移至入场价（保本）；达到目标1后止损移至目标1位置` });
    stepNum++;
    steps.push({ title: `${stepNum}. 分批止盈`, desc: `目标1 ${fmt(data.target1)} 减仓一半；目标2 ${fmt(data.target2)} 清仓剩余。全程盈亏比约 ${data.equationRR ? data.equationRR.toFixed(2) : '-'} : 1` });
    stepNum++;
  } else {
    steps.push({ title: `${stepNum}. 当前无触发信号`, desc: '该品种当前未满足入场条件（信号等级/结构验证未达标）。建议观望，等待价格触发关键位或信号增强后再入场。', color: '#6B7280' });
    stepNum++;
  }
  // 持仓周期（无论有无信号都展示）
  const holdVal = sc?.hold?.verifiedBest || sc?.hold?.productionLong;
  if (holdVal) {
    steps.push({ title: `${stepNum}. 持仓周期`, desc: `建议持有约 ${holdVal} 根 K 线；超过后重新评估趋势是否延续（${sc?.hold?.note || ''}）`, color: ACCENT });
    stepNum++;
  }
  // 熔断风控（无论有无信号都展示）
  if (sc?.circuitBreaker) {
    steps.push({ title: `${stepNum}. 熔断风控`, desc: `连亏 ${sc.circuitBreaker.lossStreak} 笔后暂停交易 ${sc.circuitBreaker.pauseBars} 根 K 线，冷却后重新评估方向`, color: WARN });
    stepNum++;
  }
  if (hasSignal) {
    steps.push({ title: `${stepNum}. 仓位明细`, desc: `建议 ${data.maxPosition ?? '-'} 手 | 保证金 ${fmtWan(data.costData?.marginPerContract)} 元/手 | 开平手续费 ${fmtWan(data.costData?.totalFee)} 元 | 所需总资金约 ${fmtWan(data.costData?.totalCapitalRequired)} 元` });
    stepNum++;
    steps.push({ title: `${stepNum}. 计划失效`, desc: `跌破/突破结构位 ${fmt(isLong ? data.support : data.resistance)} 或出现反向信号（信号等级 ≥ L2）时，立即止损离场，计划作废` });
  }

  // 策略上下文徽章
  const badges: Array<{ text: string; color: string }> = [];
  if (sc?.verification) {
    const v = sc.verification;
    badges.push({ text: `千次验证·收益前${v.pnlTopPct.toFixed(0)}%`, color: v.pnlTopPct <= 5 ? UP : v.pnlTopPct <= 20 ? ACCENT : WARN });
    badges.push({ text: `回撤前${v.ddTopPct.toFixed(0)}%`, color: v.ddTopPct <= 30 ? UP : v.ddTopPct <= 70 ? WARN : '#EF4444' });
  }
  if (sc?.circuitBreaker) {
    badges.push({ text: `熔断 ${sc.circuitBreaker.lossStreak}x${sc.circuitBreaker.pauseBars}`, color: WARN });
  } else if (sc?.verified) {
    badges.push({ text: '熔断 off', color: '#555' });
  }
  if (sc?.directionBias) {
    const db = sc.directionBias;
    badges.push({ text: db.dominant === 'LONG' ? '做多强' : db.dominant === 'SHORT' ? '做空强' : '双向均衡', color: db.dominant === 'BALANCED' ? '#888' : ACCENT });
  }

  // 方向警告（建议方向与验证方向相悖，仅在有信号时展示）
  let directionWarning = '';
  if (hasSignal && sc?.directionBias) {
    const db = sc.directionBias;
    if (db.dominant === 'LONG' && !isLong) directionWarning = `该品种经 1000 次回测做多显著更强（捕获 ${(db.longCapture * 100).toFixed(0)}% vs 做空 ${(db.shortCapture * 100).toFixed(0)}%），做空需更高信号确认`;
    if (db.dominant === 'SHORT' && isLong) directionWarning = `该品种做空显著更强（捕获 ${(db.shortCapture * 100).toFixed(0)}% vs 做多 ${(db.longCapture * 100).toFixed(0)}%），做多需更高信号确认`;
  }
  const fragileWarning = (sc?.fragilityWarnings || []).slice(0, 2).join('；');

  return (
    <Screen>
      <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
        {/* 顶部：品种 + 方向 */}
        <View className="flex-row items-center justify-between">
          <View className="flex-row items-center">
            <Text className="text-2xl font-extrabold text-white">{data.varietyCode || code}</Text>
            <Text className="ml-2 text-base text-gray-400">{data.varietyName || VARIETY_NAMES[code || ''] || ''}</Text>
            <View style={{ backgroundColor: dirColor + '22', borderColor: dirColor, borderWidth: 1 }} className="ml-3 rounded-lg px-2 py-0.5">
              <Text style={{ color: dirColor }} className="text-xs font-bold">{hasSignal ? (isLong ? '做多' : '做空') : '观望'}</Text>
            </View>
          </View>
          <Text className="text-lg font-bold text-gray-300">现价 {fmt(data.currentPrice ?? data.entryPrice)}</Text>
        </View>

        {/* 信号等级 */}
        <View className="mt-2 flex-row items-center">
          <Text className="text-xs text-gray-400">信号等级</Text>
          <View style={{ backgroundColor: ACCENT + '22' }} className="ml-2 rounded-md px-2 py-0.5">
            <Text style={{ color: ACCENT }} className="text-xs font-bold">{grade || 'L2'}</Text>
          </View>
          {data.equationPassed !== undefined && (
            <Text className="ml-2 text-xs text-gray-500">| 交易者方程 {data.equationPassed ? '通过' : '未过'} RR {data.equationRR?.toFixed(2) ?? '-'}</Text>
          )}
        </View>

        {/* 策略上下文徽章 */}
        {badges.length > 0 && (
          <View className="mt-3 flex-row flex-wrap gap-2">
            {badges.map((b, i) => (
              <View key={i} style={{ backgroundColor: b.color + '1A', borderColor: b.color, borderWidth: 0.8 }} className="rounded-lg px-2.5 py-1">
                <Text style={{ color: b.color }} className="text-[11px] font-semibold">{b.text}</Text>
              </View>
            ))}
          </View>
        )}

        {/* K 线 + 模拟交易标记 */}
        {klineBars.length > 0 && (
          <View className="mt-5">
            <View className="mb-2 flex-row items-center justify-between">
              <Text className="text-base font-extrabold text-white">走势与模拟交易</Text>
              <Text className="text-[11px] text-gray-500">{klineBars.length} 根 · {tradeMarkers.length} 个标记</Text>
            </View>
            <View className="overflow-hidden rounded-2xl bg-[#16161F] p-3">
              <CandlestickChart
                bars={klineBars}
                visibleCount={Math.min(klineBars.length, 80)}
                width={Dimensions.get('window').width - 56}
                height={240}
                showVolume
                trades={tradeMarkers}
              />
              {tradeMarkers.length > 0 ? (
                <View className="mt-2 flex-row flex-wrap gap-3">
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-0 w-0 border-l-[5px] border-r-[5px] border-b-[8px] border-l-transparent border-r-transparent border-b-[#22C55E]" />
                    <Text className="text-[10px] text-gray-400">开多</Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-0 w-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-[#22C55E]" />
                    <Text className="text-[10px] text-gray-400">平多</Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-0 w-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-[#EF4444]" />
                    <Text className="text-[10px] text-gray-400">开空</Text>
                  </View>
                  <View className="flex-row items-center gap-1.5">
                    <View className="h-0 w-0 border-l-[5px] border-r-[5px] border-b-[8px] border-l-transparent border-r-transparent border-b-[#EF4444]" />
                    <Text className="text-[10px] text-gray-400">平空</Text>
                  </View>
                </View>
              ) : (
                <Text className="mt-2 text-[11px] text-gray-500">暂无模拟交易记录</Text>
              )}
            </View>
          </View>
        )}

        {/* 可实施交易清单 */}
        <View className="mt-5">
          <Text className="mb-2 text-base font-extrabold text-white">可实施交易清单</Text>
          <View className="rounded-2xl bg-[#16161F] p-4">
            {steps.map((s, i) => (
              <View key={i} className="mb-3 border-b border-white/5 pb-3 last:mb-0 last:border-b-0 last:pb-0">
                <Text style={{ color: s.color || ACCENT }} className="text-[13px] font-bold">{s.title}</Text>
                <Text className="mt-1 text-[13px] leading-5 text-gray-300">{s.desc}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 方向警告 */}
        {directionWarning ? (
          <View className="mt-4 rounded-xl bg-[#F59E0B1A] p-3" style={{ borderColor: WARN + '66', borderWidth: 1 }}>
            <Text className="text-xs font-bold text-amber-400">方向预警</Text>
            <Text className="mt-1 text-[13px] leading-5 text-amber-200/90">{directionWarning}</Text>
          </View>
        ) : null}

        {/* 脆弱点警示 */}
        {fragileWarning ? (
          <View className="mt-3 rounded-xl bg-[#EF44441A] p-3" style={{ borderColor: '#EF444466', borderWidth: 1 }}>
            <Text className="text-xs font-bold text-red-400">脆弱点警示</Text>
            <Text className="mt-1 text-[13px] leading-5 text-red-200/90">{fragileWarning}</Text>
          </View>
        ) : null}

        {/* 捕获率解读 */}
        {sc?.captureNote ? (
          <View className="mt-3 rounded-xl bg-[#22C55E14] p-3" style={{ borderColor: UP + '44', borderWidth: 1 }}>
            <Text className="text-xs font-bold text-emerald-400">捕获率解读</Text>
            <Text className="mt-1 text-[13px] leading-5 text-emerald-100/80">{sc.captureNote}</Text>
          </View>
        ) : null}

        {/* 关键价位 */}
        <View className="mt-5">
          <Text className="mb-2 text-base font-extrabold text-white">关键价位</Text>
          <View className="flex-row flex-wrap gap-2">
            {[
              { label: '入场', val: fmt(data.entryPrice), c: ACCENT },
              { label: '止损', val: fmt(data.stopLoss), c: '#EF4444' },
              { label: '支撑', val: fmt(data.support), c: '#888' },
              { label: '压力', val: fmt(data.resistance), c: '#888' },
              { label: '目标1', val: fmt(data.target1), c: UP },
              { label: '目标2', val: fmt(data.target2), c: UP },
            ].map((p, i) => (
              <View key={i} className="w-[31%] rounded-xl bg-[#16161F] p-3">
                <Text className="text-[11px] text-gray-500">{p.label}</Text>
                <Text style={{ color: p.c }} className="mt-0.5 text-sm font-bold">{p.val}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* 入场时机与条件 */}
        {data.entryTiming ? (
          <View className="mt-5">
            <Text className="mb-2 text-base font-extrabold text-white">入场时机与条件</Text>
            <View className="rounded-2xl bg-[#16161F] p-4">
              <Text className="text-[13px] leading-5 text-gray-300">{data.entryTiming}</Text>
              {(data.entryConditions || []).map((c, i) => (
                <View key={i} className="mt-2 flex-row items-start">
                  <Text className="mt-0.5 mr-2 text-[11px] text-amber-400">{'>'}</Text>
                  <Text className="flex-1 text-[13px] text-gray-300">{c}</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        {/* 分析摘要 */}
        {data.summary ? (
          <View className="mt-5">
            <Text className="mb-2 text-base font-extrabold text-white">建议摘要</Text>
            <View className="rounded-2xl bg-[#16161F] p-4">
              <Text className="text-[13px] leading-5 text-gray-300">{data.summary}</Text>
              {data.analysis ? <Text className="mt-2 text-[13px] leading-5 text-gray-400">{data.analysis}</Text> : null}
            </View>
          </View>
        ) : null}

        {/* 新闻与事件上下文（黑天鹅事件 / 传播链预警） */}
        {nc ? (
          <View className="mt-5">
            <Text className="mb-2 text-base font-extrabold text-white">新闻与事件上下文</Text>
            <View className="rounded-2xl bg-[#16161F] p-4">
              {/* 相关新闻 */}
              {nc.news && nc.news.length > 0 ? (
                <View className="mb-3">
                  <Text className="text-xs font-bold text-gray-400">相关新闻</Text>
                  {nc.news.slice(0, 3).map((n, i) => (
                    <View key={i} className="mt-2">
                      <Text className="text-[13px] leading-5 text-gray-200">{n.title}</Text>
                      <Text className="mt-0.5 text-[11px] text-gray-500">{n.source}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* 检测到的黑天鹅事件 */}
              {nc.detectedEvents && nc.detectedEvents.length > 0 ? (
                <View className="mb-3 border-t border-white/5 pt-3">
                  <Text className="text-xs font-bold text-red-400">关联黑天鹅事件</Text>
                  {nc.detectedEvents.map((e, i) => (
                    <View key={i} className="mt-2">
                      <View className="flex-row items-center">
                        <Text className="flex-1 text-[13px] font-bold text-red-200">{e.event?.title || '事件'}</Text>
                        <Text className="text-[11px] text-red-400">置信 {(e.confidence * 100).toFixed(0)}%</Text>
                      </View>
                      <Text className="mt-0.5 text-[12px] text-gray-400">
                        {e.event?.categoryName} · {e.event?.direction} · 涉及 {e.affectedVarieties?.length || 0} 品种
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {/* 传播链预警 */}
              {nc.propagationAlerts && nc.propagationAlerts.length > 0 ? (
                <View className="border-t border-white/5 pt-3">
                  <Text className="text-xs font-bold text-amber-400">传播链预警</Text>
                  {nc.propagationAlerts.map((p, i) => (
                    <View key={i} className="mt-2">
                      <Text className="text-[13px] text-gray-200">
                        {p.leader} → {p.follower}（{p.direction}）
                      </Text>
                      <Text className="mt-0.5 text-[12px] text-gray-400">{p.sector} · 滞后 {p.lag} 根K线</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {(!nc.news || nc.news.length === 0) && (!nc.detectedEvents || nc.detectedEvents.length === 0) && (!nc.propagationAlerts || nc.propagationAlerts.length === 0) ? (
                <Text className="text-[13px] text-gray-500">近期暂无相关新闻、事件或传播链预警</Text>
              ) : null}
            </View>
          </View>
        ) : null}

        {/* 返回按钮 */}
        <TouchableOpacity
          className="mt-6 rounded-xl py-3"
          style={{ backgroundColor: '#1E293B' }}
          onPress={() => router.back()}
        >
          <Text className="text-center text-sm font-bold text-gray-200">返回建议列表</Text>
        </TouchableOpacity>
      </ScrollView>
    </Screen>
  );
}
