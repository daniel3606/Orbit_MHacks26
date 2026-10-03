import {
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  useFonts,
} from '@expo-google-fonts/manrope';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { StartupScreen } from '@/features/session/StartupScreen';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { colors, font } from '@/ui/theme';

void SplashScreen.preventAutoHideAsync();

const navTheme = {
  ...DarkTheme,
  colors: {
    ...DarkTheme.colors,
    background: colors.background,
    card: colors.background,
    text: colors.text,
    border: colors.border,
    primary: colors.accent,
    notification: colors.danger,
  },
  fonts: {
    regular: { fontFamily: font.regular, fontWeight: '400' as const },
    medium: { fontFamily: font.medium, fontWeight: '500' as const },
    bold: { fontFamily: font.semibold, fontWeight: '600' as const },
    heavy: { fontFamily: font.bold, fontWeight: '700' as const },
  },
};

export default function RootLayout() {
  const rt = useRealtime();
  const [fontsLoaded, fontError] = useFonts({
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
  });

  useEffect(() => {
    realtime.start();
  }, []);

  useEffect(() => {
    if (fontsLoaded || fontError) void SplashScreen.hideAsync();
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

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
      <Stack
        screenOptions={{
          headerShown: false,
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerTitleStyle: { fontFamily: font.semibold, color: colors.text },
          contentStyle: { backgroundColor: colors.background },
        }}>
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
