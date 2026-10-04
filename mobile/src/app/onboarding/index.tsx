import { useRouter } from 'expo-router';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { PillButton } from '@/features/onboarding/ui';
import { Screen } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

const mark = require('../../../assets/images/icon-transparent.png');
const phones = require('../../../assets/images/onboarding/welcome-phones.png');

/** The Welcome frame. */
export default function WelcomeScreen() {
  const router = useRouter();
  const reduceMotion = useReducedMotion();

  return (
    <Screen
      scroll={false}
      footerBorder={false}
      footer={
        <Animated.View
          entering={reduceMotion ? undefined : FadeIn.duration(420).delay(280)}
          style={styles.actions}>
          <PillButton label="Sign In" tone="light" onPress={() => router.push('/onboarding/sign-in')} />
          <PillButton label="Sign Up" onPress={() => router.push('/onboarding/sign-up')} />
        </Animated.View>
      }>
      <Animated.View
        entering={reduceMotion ? undefined : FadeInDown.duration(480).delay(40)}
        style={styles.top}>
        {/* Long-press the mark for connection diagnostics while there is no Menu tab yet. */}
        <Pressable
          onLongPress={() => router.push('/diagnostics')}
          accessibilityRole="image"
          accessibilityLabel="Orbit"
          accessibilityHint="Long press for connection diagnostics"
          style={styles.brand}>
          <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
          <Text style={styles.wordmark} allowFontScaling={false}>
            Orbit
          </Text>
        </Pressable>
        <View style={styles.copy}>
          <Text style={styles.title} accessibilityRole="header" maxFontSizeMultiplier={1.3}>
            Start your financial life
          </Text>
          <Text style={styles.subtitle} maxFontSizeMultiplier={1.4}>
            Discover, understand, and practice investing with virtual money.
          </Text>
        </View>
      </Animated.View>
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(560).delay(160)}
        style={styles.art}>
        <Image
          source={phones}
          style={styles.phones}
          resizeMode="contain"
          accessibilityLabel="Orbit's stock and Discover screens"
          accessibilityIgnoresInvertColors
        />
      </Animated.View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  top: { alignItems: 'center', gap: space.xxl, paddingTop: space.sm },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  mark: { width: 56, height: 64 },
  wordmark: {
    fontFamily: font.bold,
    fontSize: 42,
    lineHeight: 48,
    color: colors.text,
    letterSpacing: -0.8,
  },
  copy: { alignItems: 'center', gap: space.md, paddingHorizontal: space.sm },
  title: {
    maxWidth: 300,
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 28,
    lineHeight: 34,
    color: colors.text,
    letterSpacing: -0.4,
  },
  subtitle: {
    maxWidth: 300,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 22,
    color: colors.textMuted,
  },
  // The phones bleed to the screen edges, as in the frame.
  art: { flex: 1, marginHorizontal: -space.xl, marginTop: space.lg, justifyContent: 'center' },
  phones: { width: '100%', height: '100%' },
  actions: { gap: space.md, paddingBottom: space.xs },
});
