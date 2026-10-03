import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { StartupScreen } from '@/features/session/StartupScreen';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { colors } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.surface,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
  },
};

export default function RootLayout() {
  const rt = useRealtime();

  useEffect(() => {
    realtime.start();
    void SplashScreen.hideAsync();
  }, []);

  // Until the first subscription is applied we cannot tell "new user" from
  // "not loaded yet", so no routes render.
  if (!rt.hasSynced) {
    return (
      <ThemeProvider value={navTheme}>
        <StatusBar style="light" />
        <StartupScreen />
      </ThemeProvider>
    );
  }

  const hasProfile = rt.profile !== null;
  return (
    <ThemeProvider value={navTheme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
        <Stack.Protected guard={hasProfile}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen
            name="edit-preferences"
            options={{ presentation: 'modal', headerShown: true, title: 'Edit preferences' }}
          />
          <Stack.Screen name="stock/[ticker]" options={{ headerShown: true, title: 'Stock' }} />
        </Stack.Protected>
        <Stack.Protected guard={!hasProfile}>
          <Stack.Screen name="onboarding" />
        </Stack.Protected>
        <Stack.Screen name="diagnostics" options={{ headerShown: true, title: 'Diagnostics' }} />
      </Stack>
    </ThemeProvider>
  );
}
