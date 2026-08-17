import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { TabView, SceneMap, TabBar } from 'react-native-tab-view';
import { Screen } from '@/components/Screen';
import { RiskDashboardContent } from '@/screens/risk-dashboard';
import { PortfolioRiskContent } from '@/screens/portfolio-risk';
import { PositionAnalysisContent } from '@/screens/position-analysis';

const BG = '#0A0A0F';
const ACCENT = '#00F0FF';
const TEXT2 = '#8A8A93';
const BORDER = 'rgba(255,255,255,0.08)';

const renderScene = SceneMap({
  dashboard: RiskDashboardContent,
  risk: PortfolioRiskContent,
  position: PositionAnalysisContent,
});

export default function RiskHubScreen() {
  const layout = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [routes] = useState([
    { key: 'dashboard', title: '风险仪表盘' },
    { key: 'risk', title: '组合风控' },
    { key: 'position', title: '持仓与VaR' },
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
