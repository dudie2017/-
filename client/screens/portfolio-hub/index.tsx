import React, { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { TabView, SceneMap, TabBar } from 'react-native-tab-view';
import { Screen } from '@/components/Screen';
import { MultiReportContent } from '@/screens/multi-report';
import { VarietyCompareContent } from '@/screens/variety-compare';

const BG = '#0A0A0F';
const ACCENT = '#00F0FF';
const TEXT1 = '#EAEAEA';
const TEXT2 = '#8A8A93';
const BORDER = 'rgba(255,255,255,0.08)';

const renderScene = SceneMap({
  multi: MultiReportContent,
  compare: VarietyCompareContent,
});

export default function PortfolioHubScreen() {
  const layout = useWindowDimensions();
  const [index, setIndex] = useState(0);
  const [routes] = useState([
    { key: 'multi', title: '绩效对比' },
    { key: 'compare', title: '价格相关性' },
  ]);

  return (
    <Screen statusBarStyle="light" backgroundColor={BG}>
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
    </Screen>
  );
}
