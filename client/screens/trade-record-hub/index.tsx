import { useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Screen } from '@/components/Screen';
import JournalScreen from '@/screens/journal';
import ReviewScreen from '@/screens/review';

const TABS = [
  { key: 'journal', label: '日志' },
  { key: 'review', label: '复盘' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function TradeRecordHubScreen() {
  const [tab, setTab] = useState<TabKey>('journal');

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
        {tab === 'journal' && <JournalScreen />}
        {tab === 'review' && <ReviewScreen />}
      </View>
    </Screen>
  );
}
