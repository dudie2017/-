import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { TabView, SceneMap, TabBar } from 'react-native-tab-view';
import { Screen } from '@/components/Screen';
import { StrategyOptimizationContent } from '@/screens/strategy-optimization';
import { MLOptimizationContent } from '@/screens/ml-optimization';
import { OptimizationDashboardContent } from '@/screens/optimization-dashboard';

const BG = '#0A0A0F';
const ACCENT = '#00F0FF';
const TEXT2 = '#8A8A93';
const BORDER = 'rgba(255,255,255,0.08)';

const renderScene = SceneMap({
  strategy: StrategyOptimizationContent,
  ml: MLOptimizationContent,
  dashboard: OptimizationDashboardContent,
});

export default function StrategyHubScreen() {
  const layout = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [routes] = useState([
    { key: 'strategy', title: '策略优化' },
    { key: 'ml', title: 'ML优化' },
    { key: 'dashboard', title: '优化仪表板' },
  ]);

  return (
    <Screen statusBarStyle="light" backgroundColor={BG}>
      <View style={{ flex: 1, backgroundColor: BG }}>
        <TabView
          navigationState={{ index, routes }}
          renderScene={renderScene}
          onIndexChange={setIndex}
          initialLayout={{ width: layout.width }}
          lazy
          renderTabBar={(props) => (
            <TabBar
              {...props}
              scrollEnabled={routes.length > 4}
              indicatorStyle={{ backgroundColor: ACCENT }}
              style={{ backgroundColor: BG, borderBottomWidth: 1, borderBottomColor: BORDER }}
              activeColor={ACCENT}
              inactiveColor={TEXT2}
              tabStyle={routes.length > 4 ? { width: 'auto' } : undefined}
            />
          )}
        />
      </View>
    </Screen>
  );
}
