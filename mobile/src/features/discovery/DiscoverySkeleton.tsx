import { useEffect } from 'react';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { radius, space } from '@/ui/theme';

function Bar({ width, height = 12 }: { width: DimensionValue; height?: number }) {
  return <View style={[styles.bar, { width, height, borderRadius: height / 2 }]} />;
}

/** Same footprint as the theme and three cards, breathing softly while today's set is prepared. */
export function DiscoverySkeleton() {
  const reduceMotion = useReducedMotion();
  const pulse = useSharedValue(0.55);
  useEffect(() => {
    if (reduceMotion) return;
    pulse.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [pulse, reduceMotion]);
  const breathe = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      style={[styles.root, breathe]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Finding today's discoveries">
      <View style={styles.theme}>
        <Bar width={110} height={10} />
        <Bar width="72%" height={26} />
        <Bar width="92%" />
        <Bar width="64%" />
      </View>
      <Bar width={170} height={16} />
      {[0, 1, 2].map(key => (
        <View key={key} style={styles.card}>
          <View style={styles.row}>
            <View style={styles.logo} />
            <View style={{ flex: 1, gap: space.sm }}>
              <Bar width="58%" height={14} />
              <Bar width={44} height={10} />
            </View>
            <View style={{ alignItems: 'flex-end', gap: space.sm }}>
              <Bar width={66} height={14} />
              <Bar width={44} height={10} />
            </View>
          </View>
          <Bar width={92} height={22} />
          <Bar width="94%" />
          <Bar width="70%" />
        </View>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { gap: space.lg },
  theme: { gap: space.md, marginBottom: space.sm },
  bar: { backgroundColor: 'rgba(255, 255, 255, 0.08)' },
  card: {
    borderRadius: radius.xl,
    padding: space.lg + 2,
    gap: space.md,
    backgroundColor: 'rgba(31, 4, 87, 0.16)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  logo: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255, 255, 255, 0.08)' },
});
