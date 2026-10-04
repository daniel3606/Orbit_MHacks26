import { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { Constellation, isSign, signLabel } from '@/ui/Constellation';
import { DESIGN_WIDTH, StarField } from '@/ui/StarField';
import { colors, font } from '@/ui/theme';

/** The Horoscope frame places Aries in a 287 × 194 box centred at (215, 214); every sign fits that box. */
const BOX = { width: 287, height: 194, centerX: 215, centerY: 214 };
/** Sign name: Manrope Regular 20, centred well clear of the constellation box (which ends at y = 311). */
const NAME_CENTER_Y = 344;
const NAME_LINE = 28;
/** Where page content starts, below the sign name. */
const HEADER_HEIGHT = 372;
/** Without a sign there is no constellation, so the name sits among the stars instead. */
const PLAIN_NAME_CENTER_Y = 176;
const PLAIN_HEADER_HEIGHT = 214;

const REVEAL = { duration: 320, easing: Easing.out(Easing.cubic) };

/**
 * The stars draw at once; the constellation and its name fade in together once the image is
 * ready, so the header never assembles piece by piece. `pending` means the sign is not known
 * yet: the header keeps its full height so the page does not jump when the sign arrives.
 */
export function ZodiacHeader({ sign, width, pending = false }: { sign: string | null; width: number; pending?: boolean }) {
  const scaleX = width / DESIGN_WIDTH;
  const hasArt = isSign(sign);
  const shrink = Math.min(1, scaleX);
  const reduceMotion = useReducedMotion();
  const [drawn, setDrawn] = useState<string | null>(null);
  const ready = !pending && (!hasArt || drawn === sign);
  const opacity = useSharedValue(ready ? 1 : 0);
  const artStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  useEffect(() => {
    opacity.set(ready ? withTiming(1, reduceMotion ? { duration: 0 } : REVEAL) : 0);
  }, [opacity, ready, reduceMotion]);

  return (
    <View style={[styles.header, { height: hasArt || pending ? HEADER_HEIGHT : PLAIN_HEADER_HEIGHT }]}>
      <StarField width={width} />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, artStyle]}>
        {hasArt ? (
          <Constellation
            sign={sign}
            width={BOX.width * shrink}
            height={BOX.height * shrink}
            centerX={BOX.centerX * scaleX}
            centerY={BOX.centerY}
            onLoad={() => setDrawn(sign)}
          />
        ) : null}
        {pending ? null : (
          <Text
            accessibilityRole="header"
            accessibilityLabel={sign ? `Your sign, ${signLabel(sign)}` : 'Your Orbit'}
            maxFontSizeMultiplier={1.4}
            style={[styles.name, { top: (hasArt ? NAME_CENTER_Y : PLAIN_NAME_CENTER_Y) - NAME_LINE / 2 }]}>
            {sign ? signLabel(sign) : 'Your Orbit'}
          </Text>
        )}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { width: '100%' },
  name: {
    position: 'absolute',
    left: 0,
    right: 0,
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: 20,
    lineHeight: NAME_LINE,
    color: colors.text,
  },
});
