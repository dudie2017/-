import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LogBox } from 'react-native';
import Toast from 'react-native-toast-message';
import { Provider } from '@/components/Provider';

import '../global.css';

LogBox.ignoreLogs([
  "TurboModuleRegistry.getEnforcing(...): 'RNMapsAirModule' could not be found",
]);

export default function RootLayout() {
  return (
    <Provider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          animation: 'slide_from_right',
          gestureEnabled: true,
          gestureDirection: 'horizontal',
          headerShown: false,
          contentStyle: { backgroundColor: '#0A0A0F' },
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="radar" />
        <Stack.Screen name="alerts" />
        <Stack.Screen name="detail" />
        <Stack.Screen name="trade-record-hub" />
        <Stack.Screen name="strategy-optimization" />
        <Stack.Screen name="ml-optimization" />
        <Stack.Screen name="variety-expansion" />
        <Stack.Screen name="advice" />
        <Stack.Screen name="signal-journal" />
        <Stack.Screen name="signal-detail" />
        <Stack.Screen name="sim-trading-hub" />
        <Stack.Screen name="ai-expert" />
        <Stack.Screen name="propagation-alerts" />
        <Stack.Screen name="ag0-report" />
        <Stack.Screen name="variety-report" />
        <Stack.Screen name="training-home" />
        <Stack.Screen name="training-levels" />
        <Stack.Screen name="training-special" />
        <Stack.Screen name="training-review" />
        <Stack.Screen name="training-analytics" />
        <Stack.Screen name="training-profile" />
        <Stack.Screen name="training-game" />
        <Stack.Screen name="training-quiz" />
        <Stack.Screen name="multi-report" />
        <Stack.Screen name="trade-plan" />
        <Stack.Screen name="news-monitor" />
        <Stack.Screen name="portfolio-analysis" />
        <Stack.Screen name="portfolio-config" />
        <Stack.Screen name="portfolio-strategies" />
        <Stack.Screen name="portfolio-risk" />
        <Stack.Screen name="risk-dashboard" />
        <Stack.Screen name="performance-report" />
        <Stack.Screen name="variety-compare" />
        <Stack.Screen name="trading-calendar" />
        <Stack.Screen name="position-analysis" />
        <Stack.Screen name="optimization-dashboard" />
        <Stack.Screen name="paper-trading" />
        <Stack.Screen name="paper-performance" />
        <Stack.Screen name="portfolio-hub" />
        <Stack.Screen name="risk-hub" />
        <Stack.Screen name="combo-hub" />
        <Stack.Screen name="strategy-hub" />
      </Stack>
      <Toast />
    </Provider>
  );
}
