import React, { useState, useEffect, useRef } from "react";
import {
  View, Text, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions,
} from "react-native";
import { useSafeSearchParams } from "@/hooks/useSafeRouter";
import { Screen } from "@/components/Screen";
import { CandlestickChart, CandleBar } from "@/components/chart/CandlestickChart";
import { FontAwesome6 } from "@expo/vector-icons";
import {
  SPECIAL_TRAINING_MODULES,
  CATEGORY_VARIETIES,
  loadTrainingData,
  saveTrainingData,
  updateSpecialProgress,
  saveErrorQuestion,
} from "@/utils/trainingData";
import { addToReviewQueue } from "@/utils/reviewScheduler";
import { generateModuleQuestions, GeneratedQuestion } from "@/utils/trainingQuestions";
import { fetchTrainingKline, fetchVarietyStats, VarietyStat } from "@/utils/trainingApi";

const { width: SCREEN_W } = Dimensions.get("window");
const ALL_VARIETY_CODES = Object.values(CATEGORY_VARIETIES).flat().map(v => v.code);

type Phase = "loading" | "answering" | "feedback" | "result";

export default function TrainingQuizScreen() {
  const params = useSafeSearchParams<{ moduleId?: string }>();
  const moduleId = params.moduleId || "signal_bar";
  const mod = SPECIAL_TRAINING_MODULES.find((m: { id: string }) => m.id === moduleId)
    || SPECIAL_TRAINING_MODULES.find((m: { id: string }) => m.id === "signal_bar")
    || null;

  const [phase, setPhase] = useState<Phase>("loading");
  const [questions, setQuestions] = useState<GeneratedQuestion[]>([]);
  const [currentQ, setCurrentQ] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const errorCounter = useRef(0);
  const [tappedBar, setTappedBar] = useState<number | null>(null);
  const [isCorrect, setIsCorrect] = useState(false);
  const [error, setError] = useState("");

  const QUESTION_COUNT = 5;

  const [loadTrigger, setLoadTrigger] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase("loading");
      setError("");
      try {
        const pool = ALL_VARIETY_CODES;
        const code = pool[Math.floor(Math.random() * pool.length)];
        const data = await fetchTrainingKline(code, 120);
        if (cancelled) return;
        if (!data || data.bars.length < 40) {
          setError("数据加载失败，请重试");
          setPhase("result");
          return;
        }
        const candleBars: CandleBar[] = data.bars.map((b) => ({
          date: b.date, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol, hold: b.hold || 0,
        }));
        let context: VarietyStat | null = null;
        if (moduleId === "variety_traits") {
          try {
            const statsRes = await fetchVarietyStats();
            context = statsRes?.find((s) => s.code === code) || null;
          } catch {
            context = null;
          }
        }
        const qs = generateModuleQuestions(moduleId, candleBars, code, QUESTION_COUNT, context);
        if (qs.length === 0) {
          setError("该模块暂不支持此品种数据，请重试");
          setPhase("result");
          return;
        }
        setQuestions(qs);
        setCurrentQ(0);
        setScore(0);
        setStreak(0);
        setPhase("answering");
      } catch (e) {
        if (cancelled) return;
        console.error("[Quiz] Load error:", e);
        setError("加载失败，请检查网络后重试");
        setPhase("result");
      }
    })();
    return () => { cancelled = true; };
  }, [moduleId, loadTrigger]);

  const question = questions[currentQ];

  const handleOptionSelect = (idx: number) => {
    if (phase !== "answering" || !question) return;
    setSelectedOption(idx);
    const correct = idx === question.correctOptionIndex;
    setIsCorrect(correct);
    if (correct) {
      setScore((s) => s + 1);
      setStreak((s) => s + 1);
    } else {
      setStreak(0);
      const errorId = `err_${moduleId}_${++errorCounter.current}`;
      saveErrorQuestion({
        id: errorId,
        moduleId,
        moduleName: mod?.name || moduleId,
        question: question.question,
        options: (question.options || []).map((o) => ({ label: o, value: o })),
        correctAnswer: question.options?.[question.correctOptionIndex ?? 0] || "",
        userAnswer: question.options?.[idx] || "",
        explanation: question.explanation,
        timestamp: new Date().toISOString(),
      });
      addToReviewQueue(errorId);
    }
    setPhase("feedback");
  };

  const handleBarPress = (index: number, _bar: CandleBar) => {
    if (phase !== "answering" || !question || question.type !== "tap") return;
    setTappedBar(index);
    const correct = index === question.correctBarIndex;
    setIsCorrect(correct);
    if (correct) {
      setScore((s) => s + 1);
      setStreak((s) => s + 1);
    } else {
      setStreak(0);
      const errorId = `err_${moduleId}_${++errorCounter.current}`;
      saveErrorQuestion({
        id: errorId,
        moduleId,
        moduleName: mod?.name || moduleId,
        question: question.question,
        options: [],
        correctAnswer: `第${question.correctBarIndex + 1}根K线`,
        userAnswer: `第${index + 1}根K线`,
        explanation: question.explanation,
        timestamp: new Date().toISOString(),
      });
      addToReviewQueue(errorId);
    }
    setPhase("feedback");
  };

  const handleNext = async () => {
    if (currentQ + 1 >= questions.length) {
      const pct = Math.round((score / questions.length) * 100);
      const data = await loadTrainingData();
      const xpGain = pct >= 80 ? 50 : pct >= 60 ? 30 : 10;
      data.stats.xp = (data.stats.xp || 0) + xpGain;
      await saveTrainingData(data);
      setPhase("result");
    } else {
      setCurrentQ((q) => q + 1);
      setSelectedOption(null);
      setTappedBar(null);
      setIsCorrect(false);
      setPhase("answering");
    }
  };

  // ── Render ──

  const BG = "#0A0A0F";
  const TEXT1 = "#EAEAEA";
  const TEXT2 = "#8888A0";
  const CYAN = "#00F0FF";

  if (!mod) {
    return (
      <Screen backgroundColor={BG} statusBarStyle="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: TEXT2 }}>未知训练模块</Text>
        </View>
      </Screen>
    );
  }

  // Loading
  if (phase === "loading") {
    return (
      <Screen backgroundColor={BG} statusBarStyle="light">
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 16 }}>
          <ActivityIndicator size="large" color={CYAN} />
          <Text style={{ color: TEXT2, fontSize: 14 }}>正在加载真实行情数据...</Text>
        </View>
      </Screen>
    );
  }

  // Result / Error
  if (phase === "result") {
    const pct = questions.length > 0 ? Math.round((score / questions.length) * 100) : 0;
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 32, gap: 20 }}>
          {error ? (
            <>
              <FontAwesome6 name="triangle-exclamation" size={48} color="#FF4444" />
              <Text style={{ color: "#FF4444", fontSize: 16, textAlign: "center" }}>{error}</Text>
            </>
          ) : (
            <>
              <FontAwesome6
                name={pct >= 80 ? "trophy" : pct >= 60 ? "medal" : "rotate-right"}
                size={48}
                color={pct >= 80 ? "#FFD700" : pct >= 60 ? "#00F0FF" : "#888"}
              />
              <Text style={{ color: "#FFF", fontSize: 24, fontWeight: "bold" }}>
                {pct >= 80 ? "优秀！" : pct >= 60 ? "不错！" : "继续加油！"}
              </Text>
              <Text style={{ color: "#00F0FF", fontSize: 48, fontWeight: "bold" }}>{pct}%</Text>
              <Text style={{ color: "#888", fontSize: 14 }}>
                答对 {score}/{questions.length} 题
              </Text>
            </>
          )}
          <TouchableOpacity
            onPress={() => setLoadTrigger(t => t + 1)}
            style={{
              backgroundColor: "rgba(0,240,255,0.15)", borderWidth: 1, borderColor: "#00F0FF",
              borderRadius: 12, paddingHorizontal: 32, paddingVertical: 12, marginTop: 12,
            }}
          >
            <Text style={{ color: "#00F0FF", fontSize: 16, fontWeight: "bold" }}>再来一组</Text>
          </TouchableOpacity>
        </View>
      </Screen>
    );
  }

  // Answering / Feedback
  if (!question) return null;

  return (
    <Screen backgroundColor={BG} statusBarStyle="light">
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 40 }}>
        {/* Header */}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 16, paddingVertical: 10 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <FontAwesome6 name={mod.icon} size={16} color={CYAN} />
            <Text style={{ color: TEXT1, fontSize: 16, fontWeight: "bold" }}>{mod.name}</Text>
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            {streak >= 2 && (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
                <FontAwesome6 name="fire" size={12} color="#FF6B35" />
                <Text style={{ color: "#FF6B35", fontSize: 12, fontWeight: "bold" }}>{streak}连胜</Text>
              </View>
            )}
            <Text style={{ color: TEXT2, fontSize: 13 }}>
              {currentQ + 1}/{questions.length}
            </Text>
          </View>
        </View>

        {/* Progress bar */}
        <View style={{ height: 3, backgroundColor: "rgba(255,255,255,0.05)", marginHorizontal: 16, borderRadius: 2, marginBottom: 12 }}>
          <View
            style={{
              height: 3, borderRadius: 2, backgroundColor: "#00F0FF",
              width: `${((currentQ + 1) / questions.length) * 100}%`,
            }}
          />
        </View>

        {/* Question */}
        <View style={{ paddingHorizontal: 16, marginBottom: 12 }}>
          <Text style={{ color: TEXT1, fontSize: 16, fontWeight: "600", lineHeight: 24 }}>
            {question.question}
          </Text>
        </View>

        {/* Chart */}
        {question.bars.length > 0 && (
          <View style={{ marginHorizontal: 8, marginBottom: 12 }}>
            <CandlestickChart
              bars={question.bars}
              visibleCount={question.bars.length}
              width={SCREEN_W - 16}
              height={300}
              interactive={true}
              showEMA={true}
              showVolume={true}
              showOI={question.showOI || false}
              selectedBar={phase === "feedback" ? question.correctBarIndex : tappedBar}
              onBarPress={question.type === "tap" ? handleBarPress : undefined}
              highlightBars={phase === "feedback" && question.correctBarIndex != null ? [question.correctBarIndex] : []}
              highlightColor="#FFD700"
            />
            {phase === "answering" && question.type === "tap" && (
              <Text style={{ color: "#555570", fontSize: 11, textAlign: "center", marginTop: 4 }}>
                点击K线图选择答案
              </Text>
            )}
          </View>
        )}

        {/* Options */}
        {question.type === "multi" && question.options && (
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            {question.options.map((opt, i) => {
              let bgColor = "rgba(255,255,255,0.04)";
              let borderColor = "rgba(255,255,255,0.08)";
              let textColor = TEXT2;
              if (phase === "feedback") {
                if (i === question.correctOptionIndex) {
                  bgColor = "rgba(0,204,102,0.15)";
                  borderColor = "#00CC66";
                  textColor = "#00CC66";
                } else if (i === selectedOption && !isCorrect) {
                  bgColor = "rgba(255,68,68,0.15)";
                  borderColor = "#FF4444";
                  textColor = "#FF4444";
                }
              } else if (selectedOption === i) {
                bgColor = "rgba(0,240,255,0.1)";
                borderColor = "#00F0FF";
                textColor = "#00F0FF";
              }
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => handleOptionSelect(i)}
                  disabled={phase === "feedback"}
                  style={{
                    backgroundColor: bgColor, borderWidth: 1, borderColor,
                    borderRadius: 12, padding: 14,
                  }}
                >
                  <Text style={{ color: textColor, fontSize: 14, lineHeight: 20 }}>{opt}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Feedback */}
        {phase === "feedback" && (
          <View style={{ paddingHorizontal: 16, marginTop: 16 }}>
            <View
              style={{
                backgroundColor: isCorrect ? "rgba(0,204,102,0.08)" : "rgba(255,68,68,0.08)",
                borderWidth: 1,
                borderColor: isCorrect ? "rgba(0,204,102,0.3)" : "rgba(255,68,68,0.3)",
                borderRadius: 12, padding: 16,
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <FontAwesome6
                  name={isCorrect ? "circle-check" : "circle-xmark"}
                  size={18}
                  color={isCorrect ? "#00CC66" : "#FF4444"}
                />
                <Text
                  style={{
                    color: isCorrect ? "#00CC66" : "#FF4444",
                    fontSize: 16, fontWeight: "bold",
                  }}
                >
                  {isCorrect ? "回答正确！" : "回答错误"}
                </Text>
              </View>
              <Text style={{ color: "#AAA", fontSize: 14, lineHeight: 22 }}>
                {question.explanation}
              </Text>
            </View>

            <TouchableOpacity
              onPress={handleNext}
              style={{
                backgroundColor: "rgba(0,240,255,0.15)", borderWidth: 1, borderColor: "#00F0FF",
                borderRadius: 12, paddingVertical: 14, alignItems: "center", marginTop: 16,
              }}
            >
              <Text style={{ color: "#00F0FF", fontSize: 16, fontWeight: "bold" }}>
                {currentQ + 1 >= questions.length ? "查看成绩" : "下一题"}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
