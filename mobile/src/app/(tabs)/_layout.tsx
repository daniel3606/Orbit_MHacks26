import { Tabs } from 'expo-router';
import { SymbolView, type SFSymbol } from 'expo-symbols';
import type { ColorValue } from 'react-native';

import { colors } from '@/ui/theme';

function icon(name: SFSymbol) {
  return function TabIcon({ color }: { color: ColorValue }) {
    return <SymbolView name={name} tintColor={color} size={24} />;
  };
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}>
      <Tabs.Screen name="index" options={{ title: 'Home', tabBarIcon: icon('sparkles') }} />
      <Tabs.Screen name="market" options={{ title: 'Market', tabBarIcon: icon('chart.line.uptrend.xyaxis') }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover', tabBarIcon: icon('scope') }} />
      <Tabs.Screen name="portfolio" options={{ title: 'Practice', tabBarIcon: icon('chart.pie') }} />
    </Tabs>
  );
}
