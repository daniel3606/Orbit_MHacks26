import { Tabs, useIsFocused } from 'expo-router';
import { useEffect, useRef, type ReactNode } from 'react';
import { Image, StyleSheet, type ImageSourcePropType } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { colors, font } from '@/ui/theme';

const ICON = 26;
const FADE_IN = { duration: 280, easing: Easing.out(Easing.cubic) };

/**
 * Fades a tab in each time it gains focus. The navigator's own `animation: 'fade'` drives scene
 * opacity with the core Animated native driver, and on the New Architecture that opacity can be
 * left at 0 when a detached tab is reattached — the tab then stays blank until the next switch.
 * Reanimated commits its values to the view, so the tab always ends up visible.
 */
function TabScene({ children }: { children: ReactNode }) {
  const focused = useIsFocused();
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(1);
  const firstFocus = useRef(true);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  useEffect(() => {
    if (!focused) return;
    // The tab shown at launch appears at once, as before.
    if (firstFocus.current || reduceMotion) {
      firstFocus.current = false;
      opacity.set(1);
      return;
    }
    opacity.set(0);
    opacity.set(withTiming(1, FADE_IN));
  }, [focused, opacity, reduceMotion]);

  return <Animated.View style={[styles.scene, style]}>{children}</Animated.View>;
}

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
      }}
      screenLayout={({ children }) => <TabScene>{children}</TabScene>}>
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

const styles = StyleSheet.create({
  scene: { flex: 1 },
});
