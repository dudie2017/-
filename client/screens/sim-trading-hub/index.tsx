import React, { useState, Component } from 'react';
import type { ReactNode } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Screen } from '@/components/Screen';
import SimTradesScreen from '@/screens/sim-trades';
import PaperTradingScreen from '@/screens/paper-trading';
import PaperPerformanceScreen from '@/screens/paper-performance';

const TABS = [
  { key: 'signal', label: '信号模拟' },
  { key: 'manual', label: '手动模拟盘' },
  { key: 'performance', label: '模拟绩效' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

// Error Boundary 组件：防止单个 Tab 页面崩溃影响整个 Hub
interface ErrorBoundaryProps {
  children: ReactNode;
  tabName: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

class TabErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, errorMessage: error.message || '未知错误' };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error(`[TabErrorBoundary] ${this.props.tabName} crashed:`, error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-red-400 text-base font-bold mb-2">
            {this.props.tabName} 加载异常
          </Text>
          <Text className="text-gray-400 text-xs text-center mb-4">
            {this.state.errorMessage}
          </Text>
          <TouchableOpacity
            className="bg-blue-500 px-4 py-2 rounded-lg"
            onPress={() => this.setState({ hasError: false, errorMessage: '' })}
          >
            <Text className="text-white text-sm font-medium">重试</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

export default function SimTradingHubScreen() {
  const [tab, setTab] = useState<TabKey>('signal');

  return (
    <Screen className="flex-1 bg-[#0a0a0f]">
      <View className="px-4 pt-3 pb-2">
        <View className="flex-row bg-[#131722] rounded-xl p-1 border border-[#1f2937]">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <TouchableOpacity
                key={t.key}
                className={`flex-1 py-2 rounded-lg ${active ? 'bg-[#c9a96e]' : ''}`}
                onPress={() => setTab(t.key)}
              >
                <Text
                  className={`text-center text-sm font-medium ${
                    active ? 'text-[#0a0a0f]' : 'text-gray-400'
                  }`}
                >
                  {t.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      </View>

      <View className="flex-1">
        {tab === 'signal' && (
          <TabErrorBoundary tabName="信号模拟">
            <SimTradesScreen />
          </TabErrorBoundary>
        )}
        {tab === 'manual' && (
          <TabErrorBoundary tabName="手动模拟盘">
            <PaperTradingScreen />
          </TabErrorBoundary>
        )}
        {tab === 'performance' && (
          <TabErrorBoundary tabName="模拟绩效">
            <PaperPerformanceScreen />
          </TabErrorBoundary>
        )}
      </View>
    </Screen>
  );
}
