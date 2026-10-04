import { StyleSheet, Text, View } from 'react-native';

import { Constellation, isSign, signLabel } from '@/ui/Constellation';
import { DESIGN_WIDTH, StarField } from '@/ui/StarField';
import { colors, font } from '@/ui/theme';

/** The Horoscope frame places Aries in a 287 × 194 box centred at (215, 214); every sign fits that box. */
const BOX = { width: 287, height: 194, centerX: 215, centerY: 214 };
/** Sign name: Manrope Regular 25, centred on y = 314 in the frame. */
const NAME_CENTER_Y = 314;
const NAME_LINE = 34;
/** Where page content starts, below the sign name. */
const HEADER_HEIGHT = 346;
/** Without a sign there is no constellation, so the name sits among the stars instead. */
const PLAIN_NAME_CENTER_Y = 176;
const PLAIN_HEADER_HEIGHT = 214;

export function ZodiacHeader({ sign, width }: { sign: string | null; width: number }) {
  const scaleX = width / DESIGN_WIDTH;
  const hasArt = isSign(sign);
  const shrink = Math.min(1, scaleX);

  return (
    <View style={[styles.header, { height: hasArt ? HEADER_HEIGHT : PLAIN_HEADER_HEIGHT }]}>
      <StarField width={width} />
      {hasArt ? (
        <Constellation
          sign={sign}
          width={BOX.width * shrink}
          height={BOX.height * shrink}
          centerX={BOX.centerX * scaleX}
          centerY={BOX.centerY}
        />
      ) : null}
      <Text
        accessibilityRole="header"
        accessibilityLabel={sign ? `Your sign, ${signLabel(sign)}` : 'Your Orbit'}
        maxFontSizeMultiplier={1.4}
        style={[styles.name, { top: (hasArt ? NAME_CENTER_Y : PLAIN_NAME_CENTER_Y) - NAME_LINE / 2 }]}>
        {sign ? signLabel(sign) : 'Your Orbit'}
      </Text>
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
    fontSize: 25,
    lineHeight: NAME_LINE,
    color: colors.text,
  },
});
