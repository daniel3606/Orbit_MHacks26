import { Tabs } from 'expo-router';
import { Easing, Image, type ImageSourcePropType } from 'react-native';

import { colors, font } from '@/ui/theme';

const ICON = 26;

function tabIcon(active: ImageSourcePropType, inactive: ImageSourcePropType) {
  return function TabIcon({ focused }: { focused: boolean }) {
    return (
      <Image
        source={focused ? active : inactive}
        style={{ width: ICON, height: ICON }}
        resizeMode="contain"
        accessibilityIgnoresInvertColors
      />
    );
  };
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: '#000000',
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        tabBarLabelStyle: { fontFamily: font.regular, fontSize: 11 },
        tabBarActiveTintColor: colors.tabActive,
        tabBarInactiveTintColor: colors.tabInactive,
        animation: 'fade',
        transitionSpec: {
          animation: 'timing',
          config: { duration: 280, easing: Easing.out(Easing.cubic) },
        },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: tabIcon(
            require('../../../assets/icon/home-active.png'),
            require('../../../assets/icon/home-notactive.png'),
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: 'Search',
          tabBarIcon: tabIcon(
            require('../../../assets/icon/search-active.png'),
            require('../../../assets/icon/search-notactive.png'),
          ),
        }}
      />
      <Tabs.Screen
        name="discover"
        options={{
          title: 'Discover',
          tabBarIcon: tabIcon(
            require('../../../assets/icon/discover-active.png'),
            require('../../../assets/icon/discover-notactive.png'),
          ),
        }}
      />
      <Tabs.Screen
        name="portfolio"
        options={{
          title: 'Portfolio',
          tabBarIcon: tabIcon(
            require('../../../assets/icon/portfolio-active.png'),
            require('../../../assets/icon/portfolio-notactive.png'),
          ),
        }}
      />
      <Tabs.Screen
        name="menu"
        options={{
          title: 'Menu',
          tabBarIcon: tabIcon(
            require('../../../assets/icon/menu-active.png'),
            require('../../../assets/icon/menu-notactive.png'),
          ),
        }}
      />
      <Tabs.Screen name="market" options={{ href: null }} />
    </Tabs>
  );
}
