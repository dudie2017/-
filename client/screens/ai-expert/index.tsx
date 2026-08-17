import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
  Modal,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Animated,
  Image,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Screen } from '@/components/Screen';
import { useSafeRouter, useSafeSearchParams } from '@/hooks/useSafeRouter';
import { FontAwesome6 } from '@expo/vector-icons';
import { getBackendBaseUrl, fetchWithTimeout } from '@/utils/api';
import { createFormDataFile } from '@/utils';
import EventSource from 'react-native-sse';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as ImagePicker from 'expo-image-picker';

interface VarietyItem {
  code: string;
  name: string;
  spectrum?: string;
  ai_direction?: string;
  edge_grade?: string;
  close?: number;
  ret_pct?: number;
  change_pct?: number;
  decision?: string;
  advice?: string;
  adx?: number;
  trend_strength?: number;
  lc_stage?: string;
  oi_signal?: string;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  image?: string; // 图片 URI
}

// 品种相关性映射（前端版本，用于可视化提醒）
const CORRELATED_GROUPS: Record<string, string[]> = {
  '有色金属': ['CU0', 'AL0', 'ZN0', 'NI0', 'SN0', 'PB0'],
  '黑色系': ['RB0', 'HC0', 'I0', 'J0', 'JM0', 'SS0'],
  '化工': ['MA0', 'TA0', 'EG0', 'PP0', 'L0', 'V0'],
  '农产品': ['CF0', 'SR0', 'OI0', 'P0', 'Y0', 'M0'],
  '贵金属': ['AU0', 'AG0'],
  '能源': ['SC0', 'LU0', 'FU0', 'BU0'],
};

// 获取品种所属板块
function getVarietyGroup(code: string): string | null {
  for (const [group, codes] of Object.entries(CORRELATED_GROUPS)) {
    if (codes.includes(code)) return group;
  }
  return null;
}

// 获取同板块品种
function getCorrelatedVarieties(code: string): { group: string; others: string[] } | null {
  const group = getVarietyGroup(code);
  if (!group) return null;
  const others = CORRELATED_GROUPS[group].filter(c => c !== code);
  return { group, others };
}

// ADX 强度等级
function getAdxLevel(adx?: number): { label: string; color: string; percent: number } {
  if (adx == null) return { label: 'N/A', color: '#6B7280', percent: 0 };
  if (adx >= 30) return { label: '强趋势', color: '#10B981', percent: Math.min(adx / 50 * 100, 100) };
  if (adx >= 20) return { label: '趋势形成', color: '#F59E0B', percent: adx / 50 * 100 };
  return { label: '无趋势', color: '#EF4444', percent: adx / 50 * 100 };
}

// 信号等级可视化
function getGradeVisual(grade?: string): { label: string; color: string; stars: number } {
  switch (grade?.toUpperCase()) {
    case 'A': return { label: 'A级 - 优秀', color: '#10B981', stars: 3 };
    case 'B': return { label: 'B级 - 良好', color: '#3B82F6', stars: 2 };
    case 'C': return { label: 'C级 - 一般', color: '#F59E0B', stars: 1 };
    case 'D': return { label: 'D级 - 差', color: '#EF4444', stars: 0 };
    default: return { label: '未评级', color: '#6B7280', stars: 0 };
  }
}

// 快捷追问按钮配置
const QUICK_QUESTIONS = [
  '具体入场点位？',
  '止损设多少？',
  '持仓多久？',
  '风险有多大？',
  '能加仓吗？',
  '什么时候平仓？',
];

// 分析结果缓存键
const CACHE_KEY_PREFIX = 'ai_analysis_';
const CACHE_EXPIRY = 30 * 60 * 1000; // 30 分钟过期

// 聊天记录存储键
const CHAT_HISTORY_KEY = 'ai_expert_chat_history';

// 品种分组
const VARIETY_GROUPS: Record<string, string[]> = {
  '上期所': ['CU0', 'AL0', 'ZN0', 'NI0', 'AG0', 'HC0', 'SP0', 'FU0', 'BU0', 'AO0'],
  '上期能源': ['SC0', 'LU0', 'BC0', 'EC0'],
  '大商所': ['I0', 'JM0', 'J0', 'P0', 'LH0', 'JD0', 'L0', 'PP0', 'EB0', 'PG0'],
  '郑商所': ['AP0', 'SA0', 'FG0', 'TA0', 'EG0', 'MA0', 'RM0', 'CJ0', 'SF0', 'SM0', 'PF0', 'PX0', 'SH0'],
  '中金所': ['IM0'],
  '广期所': ['SI0', 'LC0'],
};

type StreamBody = { message: string; context?: string };
type StreamHandlers = {
  onChunk: (content: string) => void;
  onDone: () => void;
  onError: (msg: string) => void;
};

// 聊天记录持久化
async function saveChatHistory(messages: ChatMessage[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(messages));
  } catch (error) {
    console.error('保存聊天记录失败:', error);
  }
}

async function loadChatHistory(): Promise<ChatMessage[]> {
  try {
    const data = await AsyncStorage.getItem(CHAT_HISTORY_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('加载聊天记录失败:', error);
  }
  return [];
}

// 分析结果缓存
function getCacheKey(varietyCode: string): string {
  return `${CACHE_KEY_PREFIX}${varietyCode}`;
}

async function getCachedAnalysis(varietyCode: string): Promise<string | null> {
  try {
    const key = getCacheKey(varietyCode);
    const cached = await AsyncStorage.getItem(key);
    if (cached) {
      const { analysis, timestamp } = JSON.parse(cached);
      // 检查是否过期
      if (Date.now() - timestamp < CACHE_EXPIRY) {
        return analysis;
      }
    }
  } catch (error) {
    console.error('读取缓存失败:', error);
  }
  return null;
}

async function setCachedAnalysis(varietyCode: string, analysis: string): Promise<void> {
  try {
    const key = getCacheKey(varietyCode);
    await AsyncStorage.setItem(key, JSON.stringify({
      analysis,
      timestamp: Date.now(),
    }));
  } catch (error) {
    console.error('保存缓存失败:', error);
  }
}

// Web 端流式读取：浏览器原生 fetch + ReadableStream（最可靠）
async function streamChatWeb(url: string, body: StreamBody, handlers: StreamHandlers): Promise<void> {
  const { onChunk, onDone, onError } = handlers;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 关键：显式声明 SSE，确保 Metro 代理走 streamProxy 分支并禁用压缩
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      onError(response.status >= 500 ? '服务端错误，请稍后重试。' : '服务响应异常，请重试。');
      return;
    }
    if (!response.body) {
      onError('当前环境不支持流式响应。');
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of block.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const data = t.slice(5).trim();
          if (data === '[DONE]') {
            onDone();
            return;
          }
          try {
            const parsed = JSON.parse(data);
            if (parsed && typeof parsed.content === 'string' && parsed.content) {
              onChunk(parsed.content);
            }
          } catch {
            // 忽略单块解析错误
          }
        }
      }
    }

    onDone();
  } catch {
    onError('连接异常，请稍后重试。');
  }
}

// Native 端流式读取：react-native-sse（RN 原生 fetch 不支持标准 ReadableStream）
function streamChatNative(url: string, body: StreamBody, handlers: StreamHandlers): Promise<void> {
  const { onChunk, onDone, onError } = handlers;
  return new Promise((resolve) => {
    let completed = false; // 标记是否已正常完成
    const sse = new EventSource(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 关键：显式声明 SSE，确保 Metro 代理走 streamProxy 分支并禁用压缩
        'Accept': 'text/event-stream',
      },
      body: JSON.stringify(body),
      timeout: 120000,
      pollingInterval: 0, // 禁止自动重连（单次请求完成后不重新连接）
    });

    sse.addEventListener('message', (event) => {
      const data = (event as { data?: string } | null)?.data;
      if (data === '[DONE]') {
        completed = true;
        sse.close();
        onDone();
        resolve();
        return;
      }
      try {
        const parsed = JSON.parse(data || '');
        // 检查是否是错误消息
        if (parsed && parsed.error) {
          completed = true;
          sse.close();
          onError(parsed.error);
          resolve();
          return;
        }
        if (parsed && typeof parsed.content === 'string' && parsed.content) {
          onChunk(parsed.content);
        }
      } catch {
        // 忽略单块解析错误
      }
    });

    sse.addEventListener('error', (event) => {
      // 如果已正常完成，忽略后续 error 事件（SSE 连接关闭时可能触发）
      if (completed) return;
      sse.close();
      const evt = event as { type?: string; xhrStatus?: number } | null;
      const errorType = evt?.type;
      const xhrStatus = evt?.xhrStatus;
      let msg = '抱歉，响应失败，请重试。';
      if (errorType === 'timeout') {
        msg = '响应超时，请稍后重试。';
      } else if (xhrStatus === 401 || xhrStatus === 403) {
        msg = '认证失败，请检查服务配置。';
      } else if (xhrStatus === 502 || xhrStatus === 504) {
        msg = '服务响应超时，请稍后重试。';
      } else if (xhrStatus && xhrStatus >= 500) {
        msg = '服务端错误，请稍后重试。';
      } else if (errorType === 'exception') {
        msg = '连接异常，请稍后重试。';
      }
      onError(msg);
      resolve();
    });
  });
}

export default function AIExpertScreen() {
  const router = useSafeRouter();
  const { code: presetCode } = useSafeSearchParams<{ code?: string }>();
  const [varieties, setVarieties] = useState<VarietyItem[]>([]);
  const [selectedVariety, setSelectedVariety] = useState<VarietyItem | null>(null);
  const [analysis, setAnalysis] = useState<string>('');
  const [analyzing, setAnalyzing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);

  // 对话相关状态
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatSending, setChatSending] = useState(false);
  const chatScrollRef = useRef<ScrollView>(null);
  
  // 图片上传状态
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  
  // 打字机效果状态
  const [typingText, setTypingText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const typingAnimationRef = useRef<Animated.Value>(new Animated.Value(0));
  const typingTimerRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  
  // 加载缓存的聊天记录
  useEffect(() => {
    loadChatHistory().then(messages => {
      if (messages.length > 0) {
        setChatMessages(messages);
      }
    });
  }, []);
  
  // 保存聊天记录
  useEffect(() => {
    if (chatMessages.length > 0) {
      saveChatHistory(chatMessages);
    }
  }, [chatMessages]);

  // 请求 AI 解读（非流式），接收品种对象参数，供手动按钮与自动分析共用
  const analyzeVariety = useCallback(async (variety: VarietyItem) => {
    setSelectedVariety(variety);
    setAnalyzing(true);
    setAnalysis('');

    // 先检查缓存
    const cached = await getCachedAnalysis(variety.code);
    if (cached) {
      setAnalysis(cached);
      setChatMessages([{
        id: 'init-' + Date.now(),
        role: 'assistant',
        content: cached,
        timestamp: Date.now(),
      }]);
      setAnalyzing(false);
      return;
    }

    // 超时控制：深度解读最长等待 120 秒
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), 120000);

    try {
      const baseUrl = getBackendBaseUrl();
      const response = await fetch(`${baseUrl}/api/v1/ai/analyze-variety`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ varietyCode: variety.code }),
        signal: controller.signal,
      });

      // 先读取文本再解析，避免后端返回非 JSON（如网关纯文本错误）时 response.json() 抛 SyntaxError
      const rawText = await response.text();
      let data: any;
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch {
        throw new Error(rawText.slice(0, 120) || `HTTP ${response.status}`);
      }

      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }

      if (data.success && data.data) {
        const analysisText = data.data.analysis;
        setAnalysis(analysisText);
        // 缓存分析结果
        await setCachedAnalysis(variety.code, analysisText);
        // 添加初始分析作为对话的第一条消息
        setChatMessages([{
          id: 'init-' + Date.now(),
          role: 'assistant',
          content: analysisText,
          timestamp: Date.now(),
        }]);
      } else {
        Alert.alert('错误', data.error || '分析失败');
      }
    } catch (error) {
      console.error('AI 分析失败:', error);
      if (error instanceof Error && error.name === 'AbortError') {
        Alert.alert('提示', '深度解读超时，请稍后重试');
      } else {
        Alert.alert('错误', 'AI 服务调用失败');
      }
    } finally {
      clearTimeout(timeoutId);
      setAnalyzing(false);
      abortControllerRef.current = null;
    }
  }, []);

  // 加载品种列表
  const loadVarieties = useCallback(async () => {
    try {
      const baseUrl = getBackendBaseUrl();
      const scanResponse = await fetchWithTimeout(`${baseUrl}/api/v1/scan`, {}, 60000);
      const scanData = await scanResponse.json();
      if (scanData.rows && scanData.rows.length > 0) {
        setVarieties(scanData.rows);
        // 携带 code 进入时：自动选中并触发一次深度解读
        if (presetCode) {
          const target = scanData.rows.find((v: VarietyItem) => v.code === presetCode);
          if (target) {
            analyzeVariety(target);
          }
        }
        return;
      }
      const varietiesResponse = await fetchWithTimeout(`${baseUrl}/api/v1/scan/varieties`, {}, 60000);
      const varietiesData = await varietiesResponse.json();
      if (varietiesData.varieties) {
        const list = Object.entries(varietiesData.varieties).map(([code, name]) => ({
          code,
          name: name as string,
        }));
        setVarieties(list);
        if (presetCode) {
          const target = list.find((v: VarietyItem) => v.code === presetCode);
          if (target) {
            analyzeVariety(target);
          }
        }
      }
    } catch (error) {
      console.error('加载品种列表失败:', error);
    }
  }, [presetCode, analyzeVariety]);

  useFocusEffect(
    useCallback(() => {
      loadVarieties();
    }, [loadVarieties])
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadVarieties();
    setRefreshing(false);
  };

  // 选择品种
  const handleSelectVariety = (variety: VarietyItem) => {
    setSelectedVariety(variety);
    setAnalysis('');
    setChatMessages([]);
    setPickerVisible(false);
  };

  const handleAnalyze = async () => {
    if (!selectedVariety) {
      Alert.alert('提示', '请先选择一个品种');
      return;
    }
    await analyzeVariety(selectedVariety);
  };

  // 停止生成
  const handleStopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setChatSending(false);
    setIsTyping(false);
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  };

  // 快捷追问
  const handleQuickQuestion = (question: string) => {
    setChatInput(question);
    // 自动发送
    setTimeout(() => {
      handleSendChatWithText(question);
    }, 100);
  };

  // 发送对话消息（流式）
  const handleSendChat = async () => {
    const text = chatInput.trim();
    if (!text || chatSending) return;
    await handleSendChatWithText(text);
  };

  // 选择图片
  const handlePickImage = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      Alert.alert('权限不足', '需要相册权限才能选择图片');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setSelectedImage(result.assets[0].uri);
    }
  };

  // 移除图片
  const handleRemoveImage = () => {
    setSelectedImage(null);
  };

  const handleSendChatWithText = async (text: string) => {
    if (!selectedVariety) {
      Alert.alert('提示', '请先选择一个品种');
      return;
    }

    // 上传图片（如果有）
    let imageUrl: string | undefined;
    if (selectedImage) {
      try {
        const baseUrl = getBackendBaseUrl();
        const formData = new FormData();
        const imageFile = await createFormDataFile(selectedImage, 'chart.jpg', 'image/jpeg');
        formData.append('image', imageFile as any);
        
        const uploadRes = await fetch(`${baseUrl}/api/v1/ai/upload-image`, {
          method: 'POST',
          body: formData,
        });
        const uploadData = await uploadRes.json();
        if (uploadData.success) {
          imageUrl = uploadData.data.url;
        }
      } catch (error) {
        console.error('图片上传失败:', error);
      }
    }

    const userMsg: ChatMessage = {
      id: 'user-' + Date.now(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      image: selectedImage || undefined,
    };
    setChatMessages(prev => [...prev, userMsg]);
    setChatInput('');
    setSelectedImage(null);
    setChatSending(true);
    setIsTyping(true);

    const assistantMsg: ChatMessage = {
      id: 'assistant-' + Date.now(),
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    };
    setChatMessages(prev => [...prev, assistantMsg]);

    let fullContent = '';
    let displayIndex = 0;

    // 打字机效果：逐字显示
    const typeNextChar = () => {
      if (displayIndex < fullContent.length) {
        const char = fullContent[displayIndex];
        displayIndex++;
        setTypingText(fullContent.substring(0, displayIndex));
        setChatMessages(prev =>
          prev.map(m => m.id === assistantMsg.id ? { ...m, content: fullContent.substring(0, displayIndex) } : m)
        );
        // 随机延迟，模拟真实打字效果
        const delay = 10 + Math.random() * 20;
        typingTimerRef.current = setTimeout(typeNextChar, delay);
      } else {
        setIsTyping(false);
      }
    };

    const updateContent = (content: string) => {
      fullContent += content;
      // 如果打字机效果未完成，加速显示
      if (!isTyping) {
        typeNextChar();
      }
    };

    const handleError = (msg: string) => {
      if (!fullContent) {
        setChatMessages(prev =>
          prev.map(m => m.id === assistantMsg.id ? { ...m, content: msg } : m)
        );
      }
      setIsTyping(false);
    };

    try {
      const baseUrl = getBackendBaseUrl();
      // 构建上下文：当前品种数据 + 之前的分析
      const context = selectedVariety
        ? `当前分析品种: ${selectedVariety.code}(${selectedVariety.name}), 方向:${selectedVariety.ai_direction || '未知'}, 等级:${selectedVariety.edge_grade || '未知'}, 收盘:${selectedVariety.close || '未知'}, 频谱:${selectedVariety.spectrum || '未知'}, ADX:${selectedVariety.adx || '未知'}`
        : '';

      /**
       * 服务端文件：server/src/routes/ai.ts
       * 接口：POST /api/v1/ai/chat/stream
       * Body 参数：message: string, context?: string, imageUrl?: string
       */
      const url = `${baseUrl}/api/v1/ai/chat/stream`;
      const body = { message: text, context, imageUrl };

      const controller = new AbortController();
      abortControllerRef.current = controller;

      if (Platform.OS === 'web') {
        // Web 端：浏览器原生 fetch + ReadableStream，最可靠
        await streamChatWeb(url, body, {
          onChunk: updateContent,
          onDone: () => {
            setChatSending(false);
            // 完成打字机效果
            if (displayIndex < fullContent.length) {
              typeNextChar();
            }
          },
          onError: handleError,
        });
      } else {
        // Native 端：react-native-sse
        await streamChatNative(url, body, {
          onChunk: updateContent,
          onDone: () => {
            setChatSending(false);
            // 完成打字机效果
            if (displayIndex < fullContent.length) {
              typeNextChar();
            }
          },
          onError: handleError,
        });
      }
    } catch (error) {
      console.error('对话失败:', error);
      handleError('抱歉，响应失败，请重试。');
    } finally {
      setChatSending(false);
      abortControllerRef.current = null;
    }
  };

  // 方向颜色
  const getDirectionColor = (direction?: string) => {
    if (direction === '多') return '#10B981';
    if (direction === '空') return '#EF4444';
    return '#6B7280';
  };

  // 品种列表按分组排列
  const getGroupedVarieties = () => {
    const varietyMap = new Map(varieties.map(v => [v.code, v]));
    const groups: { groupName: string; items: VarietyItem[] }[] = [];

    for (const [groupName, codes] of Object.entries(VARIETY_GROUPS)) {
      const items = codes.map(c => varietyMap.get(c)).filter((v): v is VarietyItem => !!v);
      if (items.length > 0) {
        groups.push({ groupName, items });
      }
    }

    // 添加未在分组中的品种
    const allGroupedCodes = new Set(Object.values(VARIETY_GROUPS).flat());
    const ungrouped = varieties.filter(v => !allGroupedCodes.has(v.code));
    if (ungrouped.length > 0) {
      groups.push({ groupName: '其他', items: ungrouped });
    }

    return groups;
  };

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 0}
      >
        <View className="flex-1 bg-[#0F172A]">
          {/* 标题栏 */}
          <View className="px-4 pt-12 pb-3 bg-[#1E293B] border-b border-[#334155]">
            <View className="flex-row items-center justify-between">
              <TouchableOpacity onPress={() => router.back()} className="p-2">
                <FontAwesome6 name="arrow-left" size={20} color="#E2E8F0" />
              </TouchableOpacity>
              <Text className="text-lg font-bold text-[#E2E8F0]">Brooks AI 专家</Text>
              <View className="w-10" />
            </View>
          </View>

          {/* 品种选择下拉按钮 */}
          <View className="px-4 py-3 bg-[#1E293B] border-b border-[#334155]">
            <TouchableOpacity
              onPress={() => setPickerVisible(true)}
              className="flex-row items-center justify-between bg-[#334155] rounded-xl px-4 py-3"
            >
              <View className="flex-row items-center">
                <FontAwesome6 name="chart-line" size={16} color="#94A3B8" />
                <Text className="text-[#E2E8F0] text-base ml-3">
                  {selectedVariety
                    ? `${selectedVariety.name} (${selectedVariety.code})`
                    : '请选择品种'}
                </Text>
              </View>
              <FontAwesome6 name="chevron-down" size={14} color="#94A3B8" />
            </TouchableOpacity>
          </View>

          {/* 主内容区 - 可滚动 */}
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 20 }}
            refreshControl={
              <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#3B82F6" />
            }
            keyboardShouldPersistTaps="handled"
          >
            {/* 品种信息卡片 */}
            {selectedVariety && (
              <View className="mx-4 mt-4 p-4 bg-[#1E293B] rounded-xl border border-[#334155]">
                <View className="flex-row items-center justify-between mb-3">
                  <Text className="text-lg font-bold text-[#E2E8F0]">
                    {selectedVariety.name || selectedVariety.code}
                  </Text>
                  <View className="flex-row items-center gap-2">
                    {selectedVariety.ai_direction && (
                      <View className="px-2 py-1 rounded bg-[#334155]">
                        <Text className="text-sm font-bold" style={{ color: getDirectionColor(selectedVariety.ai_direction) }}>
                          {selectedVariety.ai_direction}
                        </Text>
                      </View>
                    )}
                    <Text className="text-sm text-[#94A3B8]">{selectedVariety.code}</Text>
                  </View>
                </View>

                {/* 信号强度可视化 */}
                <View className="mb-3 p-3 bg-[#0F172A] rounded-lg">
                  <View className="flex-row items-center justify-between mb-2">
                    <Text className="text-xs text-[#94A3B8]">信号强度</Text>
                    {(() => {
                      const gradeVis = getGradeVisual(selectedVariety.edge_grade);
                      return (
                        <View className="flex-row items-center">
                          {[0, 1, 2].map(i => (
                            <FontAwesome6
                              key={i}
                              name="star"
                              size={10}
                              color={i < gradeVis.stars ? gradeVis.color : '#334155'}
                              style={{ marginLeft: i > 0 ? 2 : 0 }}
                            />
                          ))}
                          <Text className="text-xs ml-2" style={{ color: gradeVis.color }}>
                            {gradeVis.label}
                          </Text>
                        </View>
                      );
                    })()}
                  </View>

                  {/* ADX 进度条 */}
                  {selectedVariety.adx != null && (() => {
                    const adxLevel = getAdxLevel(selectedVariety.adx);
                    return (
                      <View>
                        <View className="flex-row items-center justify-between mb-1">
                          <Text className="text-xs text-[#94A3B8]">
                            ADX: {selectedVariety.adx.toFixed(1)}
                          </Text>
                          <Text className="text-xs font-bold" style={{ color: adxLevel.color }}>
                            {adxLevel.label}
                          </Text>
                        </View>
                        <View className="h-2 bg-[#334155] rounded-full overflow-hidden">
                          <View
                            style={{
                              width: `${adxLevel.percent}%`,
                              height: '100%',
                              backgroundColor: adxLevel.color,
                              borderRadius: 999,
                            }}
                          />
                        </View>
                      </View>
                    );
                  })()}
                </View>

                {/* 相关性风险提醒 */}
                {(() => {
                  const corr = getCorrelatedVarieties(selectedVariety.code);
                  if (!corr) return null;
                  return (
                    <View className="mb-3 p-3 bg-[#1a1a2e] rounded-lg border border-[#F59E0B]/20">
                      <View className="flex-row items-center mb-1">
                        <FontAwesome6 name="triangle-exclamation" size={12} color="#F59E0B" />
                        <Text className="text-xs font-bold text-[#F59E0B] ml-2">
                          {corr.group}板块集中风险
                        </Text>
                      </View>
                      <Text className="text-xs text-[#94A3B8]">
                        同板块品种: {corr.others.slice(0, 4).join('、')}
                        {corr.others.length > 4 ? `等${corr.others.length}个` : ''}
                      </Text>
                      <Text className="text-xs text-[#94A3B8] mt-1">
                        建议：同板块最多持有 2 个品种，总仓位不超过 1.5 倍
                      </Text>
                    </View>
                  );
                })()}

                <View className="flex-row flex-wrap gap-2">
                  {selectedVariety.spectrum && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">频谱</Text>
                      <Text className="text-sm text-[#E2E8F0]">{selectedVariety.spectrum}</Text>
                    </View>
                  )}
                  {selectedVariety.edge_grade && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">等级</Text>
                      <Text className="text-sm font-bold text-[#F59E0B]">{selectedVariety.edge_grade}</Text>
                    </View>
                  )}
                  {selectedVariety.close != null && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">收盘</Text>
                      <Text className="text-sm text-[#E2E8F0]">{selectedVariety.close.toFixed(2)}</Text>
                    </View>
                  )}
                  {(selectedVariety.ret_pct != null || selectedVariety.change_pct != null) && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">涨跌</Text>
                      <Text
                        className="text-sm font-bold"
                        style={{
                          color: (selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0) >= 0 ? '#10B981' : '#EF4444',
                        }}
                      >
                        {(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0) >= 0 ? '+' : ''}
                        {(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0).toFixed(2)}%
                      </Text>
                    </View>
                  )}
                  {selectedVariety.adx != null && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">ADX</Text>
                      <Text className="text-sm text-[#E2E8F0]">{selectedVariety.adx.toFixed(1)}</Text>
                    </View>
                  )}
                  {selectedVariety.lc_stage && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">生命周期</Text>
                      <Text className="text-sm text-[#E2E8F0]">{selectedVariety.lc_stage}</Text>
                    </View>
                  )}
                  {selectedVariety.oi_signal && (
                    <View className="px-2 py-1 bg-[#334155] rounded">
                      <Text className="text-xs text-[#94A3B8]">量仓</Text>
                      <Text className="text-sm text-[#E2E8F0]">{selectedVariety.oi_signal}</Text>
                    </View>
                  )}
                </View>

                {/* 分析按钮 */}
                <TouchableOpacity
                  onPress={handleAnalyze}
                  disabled={analyzing}
                  className="mt-4 py-3 bg-[#3B82F6] rounded-lg items-center"
                >
                  {analyzing ? (
                    <ActivityIndicator color="#FFFFFF" />
                  ) : (
                    <View className="flex-row items-center">
                      <FontAwesome6 name="robot" size={16} color="#FFFFFF" />
                      <Text className="text-white font-bold ml-2">请求 AI 专家深度解读</Text>
                    </View>
                  )}
                </TouchableOpacity>
              </View>
            )}

            {/* AI 解读结果 */}
            {analysis && !chatMessages.length && (
              <View className="mx-4 mt-4 p-4 bg-[#1E293B] rounded-xl border border-[#334155]">
                <View className="flex-row items-center mb-3">
                  <FontAwesome6 name="brain" size={18} color="#3B82F6" />
                  <Text className="text-base font-bold text-[#E2E8F0] ml-2">AI 专家解读</Text>
                </View>
                
                {/* 关键数据卡片 */}
                {selectedVariety && (
                  <View className="mb-4 p-3 bg-[#0F172A] rounded-lg border border-[#334155]">
                    <Text className="text-xs text-[#64748B] mb-2">关键指标</Text>
                    <View className="flex-row flex-wrap gap-2">
                      {selectedVariety.ai_direction && (
                        <View className="flex-row items-center bg-[#1E293B] px-2 py-1 rounded">
                          <FontAwesome6
                            name={selectedVariety.ai_direction === '多' ? 'arrow-trend-up' : 'arrow-trend-down'}
                            size={12}
                            color={getDirectionColor(selectedVariety.ai_direction)}
                          />
                          <Text className="text-xs text-[#E2E8F0] ml-1">
                            方向：{selectedVariety.ai_direction}
                          </Text>
                        </View>
                      )}
                      {selectedVariety.edge_grade && (
                        <View className="flex-row items-center bg-[#1E293B] px-2 py-1 rounded">
                          <FontAwesome6 name="star" size={12} color="#F59E0B" />
                          <Text className="text-xs text-[#E2E8F0] ml-1">
                            信号等级：{selectedVariety.edge_grade}
                          </Text>
                        </View>
                      )}
                      {selectedVariety.close != null && (
                        <View className="flex-row items-center bg-[#1E293B] px-2 py-1 rounded">
                          <FontAwesome6 name="dollar-sign" size={12} color="#10B981" />
                          <Text className="text-xs text-[#E2E8F0] ml-1">
                            收盘：{selectedVariety.close.toFixed(2)}
                          </Text>
                        </View>
                      )}
                      {(selectedVariety.ret_pct != null || selectedVariety.change_pct != null) && (
                        <View className="flex-row items-center bg-[#1E293B] px-2 py-1 rounded">
                          <FontAwesome6
                            name={(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0) >= 0 ? 'arrow-up' : 'arrow-down'}
                            size={12}
                            color={(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0) >= 0 ? '#10B981' : '#EF4444'}
                          />
                          <Text className="text-xs text-[#E2E8F0] ml-1">
                            涨跌：{(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0) >= 0 ? '+' : ''}
                            {(selectedVariety.ret_pct ?? selectedVariety.change_pct ?? 0).toFixed(2)}%
                          </Text>
                        </View>
                      )}
                      {selectedVariety.adx != null && (
                        <View className="flex-row items-center bg-[#1E293B] px-2 py-1 rounded">
                          <FontAwesome6 name="gauge-high" size={12} color="#8B5CF6" />
                          <Text className="text-xs text-[#E2E8F0] ml-1">
                            ADX：{selectedVariety.adx.toFixed(1)}
                          </Text>
                        </View>
                      )}
                    </View>
                  </View>
                )}
                
                <Text className="text-sm text-[#CBD5E1] leading-6">{analysis}</Text>
              </View>
            )}

            {/* 对话区域 */}
            {chatMessages.length > 0 && (
              <View className="mx-4 mt-4 bg-[#1E293B] rounded-xl border border-[#334155] overflow-hidden">
                <View className="flex-row items-center px-4 py-3 border-b border-[#334155]">
                  <FontAwesome6 name="comments" size={16} color="#3B82F6" />
                  <Text className="text-base font-bold text-[#E2E8F0] ml-2">深入对话</Text>
                </View>

                {chatMessages.map((msg) => (
                  <View
                    key={msg.id}
                    className={`px-4 py-3 ${msg.role === 'user' ? 'bg-[#1E293B]' : 'bg-[#0F172A]'}`}
                  >
                    <View className="flex-row items-center mb-1">
                      <FontAwesome6
                        name={msg.role === 'user' ? 'user' : 'robot'}
                        size={12}
                        color={msg.role === 'user' ? '#60A5FA' : '#34D399'}
                      />
                      <Text className={`text-xs ml-2 ${msg.role === 'user' ? 'text-[#60A5FA]' : 'text-[#34D399]'}`}>
                        {msg.role === 'user' ? '我' : 'Brooks AI'}
                      </Text>
                    </View>
                    {msg.image && (
                      <Image
                        source={{ uri: msg.image }}
                        className="w-full h-40 rounded-lg mb-2"
                        resizeMode="cover"
                      />
                    )}
                    <Text className="text-sm text-[#CBD5E1] leading-6">
                      {msg.content || (chatSending && msg.id === chatMessages[chatMessages.length - 1]?.id ? '思考中...' : '')}
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* 空状态 */}
            {!selectedVariety && (
              <View className="items-center justify-center px-8 pt-20">
                <FontAwesome6 name="robot" size={64} color="#475569" />
                <Text className="text-lg text-[#94A3B8] text-center mt-4 mb-2">Brooks AI 专家</Text>
                <Text className="text-sm text-[#64748B] text-center">
                  选择一个品种，AI 专家将为您解读市场状况、信号含义和交易建议，并支持深入对话
                </Text>
              </View>
            )}
          </ScrollView>

          {/* 快捷追问按钮 */}
          {selectedVariety && !chatSending && chatMessages.length > 0 && (
            <View className="px-4 py-2 bg-[#1E293B] border-t border-[#334155]">
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View className="flex-row gap-2">
                  {QUICK_QUESTIONS.map((question) => (
                    <TouchableOpacity
                      key={question}
                      onPress={() => handleQuickQuestion(question)}
                      className="px-3 py-1.5 bg-[#334155] rounded-full"
                    >
                      <Text className="text-xs text-[#CBD5E1]">{question}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            </View>
          )}

          {/* 对话输入框 - 固定在底部 */}
          {selectedVariety && (
            <View className="px-4 py-3 bg-[#1E293B] border-t border-[#334155]">
              {/* 图片预览 */}
              {selectedImage && (
                <View className="mb-2 flex-row items-center">
                  <View className="relative">
                    <Image
                      source={{ uri: selectedImage }}
                      className="w-16 h-16 rounded-lg"
                      resizeMode="cover"
                    />
                    <TouchableOpacity
                      onPress={handleRemoveImage}
                      className="absolute -top-2 -right-2 w-5 h-5 rounded-full bg-[#EF4444] items-center justify-center"
                    >
                      <FontAwesome6 name="xmark" size={10} color="#FFFFFF" />
                    </TouchableOpacity>
                  </View>
                  <Text className="ml-2 text-xs text-[#94A3B8]">图表已附加</Text>
                </View>
              )}
              
              <View className="flex-row items-center gap-2">
                {/* 图片选择按钮 */}
                <TouchableOpacity
                  onPress={handlePickImage}
                  className="w-11 h-11 rounded-full bg-[#334155] items-center justify-center"
                  disabled={chatSending}
                >
                  <FontAwesome6 name="image" size={16} color="#94A3B8" />
                </TouchableOpacity>
                
                <TextInput
                  value={chatInput}
                  onChangeText={setChatInput}
                  placeholder="追问 AI 专家..."
                  placeholderTextColor="#64748B"
                  className="flex-1 bg-[#334155] rounded-xl px-4 py-3 text-[#E2E8F0] text-sm"
                  multiline
                  maxLength={500}
                  onSubmitEditing={handleSendChat}
                  blurOnSubmit={false}
                  editable={!chatSending}
                />
                {chatSending ? (
                  <TouchableOpacity
                    onPress={handleStopGeneration}
                    className="w-11 h-11 rounded-full bg-[#EF4444] items-center justify-center"
                  >
                    <FontAwesome6 name="stop" size={16} color="#FFFFFF" />
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    onPress={handleSendChat}
                    disabled={!chatInput.trim() && !selectedImage}
                    className="w-11 h-11 rounded-full bg-[#3B82F6] items-center justify-center"
                    style={{ opacity: (!chatInput.trim() && !selectedImage) ? 0.5 : 1 }}
                  >
                    <FontAwesome6 name="paper-plane" size={16} color="#FFFFFF" />
                  </TouchableOpacity>
                )}
              </View>
              
              {/* 清空对话按钮 */}
              {chatMessages.length > 0 && !chatSending && (
                <TouchableOpacity
                  onPress={() => {
                    Alert.alert(
                      '确认清空',
                      '确定要清空所有对话记录吗？',
                      [
                        { text: '取消', style: 'cancel' },
                        {
                          text: '清空',
                          style: 'destructive',
                          onPress: () => {
                            setChatMessages([]);
                            AsyncStorage.removeItem(CHAT_HISTORY_KEY);
                          },
                        },
                      ]
                    );
                  }}
                  className="mt-2 items-center"
                >
                  <Text className="text-xs text-[#64748B]">清空对话</Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* 品种选择 Modal */}
          <Modal visible={pickerVisible} transparent animationType="slide">
            <View className="flex-1 bg-black/60 justify-end">
              <View className="bg-[#1E293B] rounded-t-2xl max-h-[70%]">
                <View className="flex-row items-center justify-between px-4 py-4 border-b border-[#334155]">
                  <Text className="text-lg font-bold text-[#E2E8F0]">选择品种</Text>
                  <TouchableOpacity onPress={() => setPickerVisible(false)}>
                    <FontAwesome6 name="xmark" size={20} color="#94A3B8" />
                  </TouchableOpacity>
                </View>
                <ScrollView className="px-4 py-2">
                  {getGroupedVarieties().map((group) => (
                    <View key={group.groupName}>
                      <Text className="text-xs text-[#64748B] font-bold mt-3 mb-2 uppercase">
                        {group.groupName}
                      </Text>
                      <View className="flex-row flex-wrap gap-2">
                        {group.items.map((variety) => (
                          <TouchableOpacity
                            key={variety.code}
                            onPress={() => handleSelectVariety(variety)}
                            className={`px-3 py-2 rounded-lg ${
                              selectedVariety?.code === variety.code ? 'bg-[#3B82F6]' : 'bg-[#334155]'
                            }`}
                          >
                            <Text
                              className={`text-sm font-medium ${
                                selectedVariety?.code === variety.code ? 'text-white' : 'text-[#E2E8F0]'
                              }`}
                            >
                              {variety.name}({variety.code})
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    </View>
                  ))}
                  <View className="h-6" />
                </ScrollView>
              </View>
            </View>
          </Modal>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
