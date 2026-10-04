import { LinearGradient } from 'expo-linear-gradient';
import { type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { graphFillOpacity, radius, space } from '@/ui/theme';

/** The graph-card surface: dark-to-violet fill at 30% so the screen shows through, with a soft violet halo. */
export function GlowCard({ children }: { children: ReactNode }) {
  return (
    <View style={styles.shadow}>
      <View style={styles.card}>
        <LinearGradient
          colors={[`rgba(0, 0, 0, ${graphFillOpacity})`, `rgba(31, 4, 87, ${graphFillOpacity})`]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    borderRadius: radius.xl,
    boxShadow: '0px 0px 20px 1px rgba(75, 36, 103, 0.22)',
  },
  card: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    padding: space.lg + 2,
    gap: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
});
