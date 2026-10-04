import { LinearGradient } from 'expo-linear-gradient';
import { useEffect } from 'react';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { useRealtime } from '@/realtime/hooks';
import { useReveal } from '@/state/reveal';
import { Constellation, isSign, signLabel } from '@/ui/Constellation';
import { DESIGN_WIDTH, StarField } from '@/ui/StarField';
import { backgroundGradient, colors, font } from '@/ui/theme';

/** Long enough to see your sign, even when the profile saves instantly. */
const MIN_MS = 3200;
/** Stop waiting for the first recommendations; Home shows its own loading state. */
const MAX_MS = 9000;

/** "Loading after onboarding": the constellation sits in a 242 × 142.5 box centred at (213, 363). */
const BOX = { width: 242, height: 142.5, centerX: 213, centerY: 363 };
/** Sign name and headline, measured down from the constellation's centre. */
const NAME_OFFSET = 100;
const NAME_LINE = 34;
const HEADLINE_OFFSET = 150;

/**
 * Shown over everything from the moment onboarding is submitted until the
 * profile exists and the first recommendations arrive (or MAX_MS passes).
 */
export function BuildingScreen() {
  const { sign, startedAt, end } = useReveal();
  const rt = useRealtime();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const glow = useSharedValue(reduceMotion ? 1 : 0);

  const hasProfile = rt.profile !== null;
  const hasRecommendations = rt.recommendationGeneration !== null;

  useEffect(() => {
    if (!hasProfile) return;
    const elapsed = Date.now() - startedAt;
    const wait = hasRecommendations ? Math.max(0, MIN_MS - elapsed) : Math.max(0, MAX_MS - elapsed);
    const timer = setTimeout(end, wait);
    return () => clearTimeout(timer);
  }, [hasProfile, hasRecommendations, startedAt, end]);

  useEffect(() => {
    if (reduceMotion) return;
    // Fade the constellation in, then let it breathe.
    glow.value = withTiming(1, { duration: 900, easing: Easing.out(Easing.cubic) }, () => {
      glow.value = withDelay(200, withRepeat(withTiming(0.65, { duration: 1400, easing: Easing.inOut(Easing.quad) }), -1, true));
    });
  }, [glow, reduceMotion]);

  const breathe = useAnimatedStyle(() => ({ opacity: glow.value }));

  const scaleX = width / DESIGN_WIDTH;
  const centerY = Math.min(BOX.centerY, height * 0.39);
  const known = isSign(sign);

  return (
    <Animated.View
      entering={FadeIn.duration(250)}
      exiting={FadeOut.duration(450)}
      style={StyleSheet.absoluteFill}
      accessible
      accessibilityViewIsModal
      accessibilityRole="progressbar"
      accessibilityLabel={known ? `${signLabel(sign)}. Building your personal experience.` : 'Building your personal experience.'}>
      <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={StyleSheet.absoluteFill} />
      <StarField width={width} />
      {known ? (
        <>
          <Animated.View style={[StyleSheet.absoluteFill, breathe]}>
            <Constellation
              sign={sign}
              width={BOX.width * Math.min(1, scaleX)}
              height={BOX.height * Math.min(1, scaleX)}
              centerX={BOX.centerX * scaleX}
              centerY={centerY}
            />
          </Animated.View>
          <Text style={[styles.name, { top: centerY + NAME_OFFSET - NAME_LINE / 2 }]} maxFontSizeMultiplier={1.3}>
            {signLabel(sign)}
          </Text>
        </>
      ) : null}
      <View style={[styles.headlineWrap, { top: centerY + HEADLINE_OFFSET }]}>
        <Text style={styles.headline} maxFontSizeMultiplier={1.2}>
          Building Your Personal Experience...
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  name: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: 25,
    lineHeight: NAME_LINE,
    color: colors.text,
  },
  headlineWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  headline: {
    width: 283,
    textAlign: 'center',
    fontFamily: font.semibold,
    fontSize: 35,
    lineHeight: 48,
    color: '#FFFFFF',
  },
});
