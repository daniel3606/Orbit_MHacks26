import { LinearGradient } from 'expo-linear-gradient';
import { Image, StyleSheet, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';

import { colors } from './theme';

/**
 * Profile picture on the graph-card surface: dark-to-violet fill with a soft
 * violet halo. Without a photo it shows a plain person outline, so the slot
 * reads as "no picture yet" rather than blank.
 */
export function Avatar({ uri, size = 96 }: { uri?: string | null; size?: number }) {
  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <View
      style={[styles.halo, round]}
      accessibilityRole="image"
      accessibilityLabel={uri ? 'Profile picture' : 'No profile picture'}>
      <View style={[styles.clip, round]}>
        {uri ? (
          <Image source={{ uri }} style={round} accessibilityIgnoresInvertColors />
        ) : (
          <>
            <LinearGradient
              colors={[colors.surfaceRaised, colors.graphBottom]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Svg width={size} height={size} viewBox="0 0 96 96">
              <Circle cx="48" cy="38" r="15" fill={colors.textMuted} />
              <Path d="M18 96c2-20 14-33 30-33s28 13 30 33z" fill={colors.textMuted} />
            </Svg>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  halo: { boxShadow: '0px 0px 24px 2px rgba(75, 36, 103, 0.45)' },
  clip: {
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
});
