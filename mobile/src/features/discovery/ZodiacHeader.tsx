import { Image, StyleSheet, Text, View } from 'react-native';

import { DESIGN_WIDTH, StarField } from '@/ui/StarField';
import { colors, font } from '@/ui/theme';

/**
 * Constellations from the "Horoscope Modules" section of the design. Each export adds room
 * around the stars for their glow; `left`/`top` locate the stars-and-lines box (`w` × `h`)
 * inside the exported canvas (`svgW` × `svgH`). The app shows PNGs rasterized from those SVGs
 * (scripts/rasterize-constellations.mjs): their stacked glow filters are too heavy to draw live.
 */
const CONSTELLATIONS = {
  aries: { asset: require('../../../assets/images/constellations/aries.png'), svgW: 686.581, svgH: 617.001, w: 383, h: 244, left: 149.37, top: 180 },
  taurus: { asset: require('../../../assets/images/constellations/taurus.png'), svgW: 829.801, svgH: 682.8, w: 428, h: 312, left: 225, top: 235 },
  gemini: { asset: require('../../../assets/images/constellations/gemini.png'), svgW: 706.361, svgH: 799, w: 370, h: 402, left: 189, top: 169 },
  cancer: { asset: require('../../../assets/images/constellations/cancer.png'), svgW: 689.001, svgH: 864, w: 230, h: 403, left: 228, top: 229.99 },
  leo: { asset: require('../../../assets/images/constellations/leo.png'), svgW: 817, svgH: 644.284, w: 434, h: 254, left: 221.99, top: 157.28 },
  virgo: { asset: require('../../../assets/images/constellations/virgo.png'), svgW: 806.101, svgH: 711.485, w: 426, h: 354, left: 170.1, top: 213.21 },
  libra: { asset: require('../../../assets/images/constellations/libra.png'), svgW: 699.297, svgH: 805.802, w: 229, h: 388, left: 231.24, top: 224.81 },
  scorpio: { asset: require('../../../assets/images/constellations/scorpio.png'), svgW: 613.397, svgH: 757.397, w: 368, h: 381, left: 79.01, top: 171.41 },
  sagittarius: { asset: require('../../../assets/images/constellations/sagittarius.png'), svgW: 826.033, svgH: 610.669, w: 365, h: 329, left: 223.01, top: 96 },
  capricorn: { asset: require('../../../assets/images/constellations/capricorn.png'), svgW: 780.001, svgH: 691.001, w: 432, h: 299, left: 135.99, top: 197.01 },
  aquarius: { asset: require('../../../assets/images/constellations/aquarius.png'), svgW: 767.997, svgH: 668.737, w: 429, h: 323, left: 229.99, top: 137.73 },
  pisces: { asset: require('../../../assets/images/constellations/pisces.png'), svgW: 509.56, svgH: 363.934, w: 439, h: 318, left: 37.8, top: 16.38 },
} as const;

type Sign = keyof typeof CONSTELLATIONS;

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

export function isSign(value: string | null | undefined): value is Sign {
  return !!value && Object.hasOwn(CONSTELLATIONS, value);
}

export function signLabel(sign: string): string {
  return sign.charAt(0).toUpperCase() + sign.slice(1);
}

export function ZodiacHeader({ sign, width }: { sign: string | null; width: number }) {
  const scaleX = width / DESIGN_WIDTH;
  const art = isSign(sign) ? CONSTELLATIONS[sign] : null;
  const fit = art ? Math.min(BOX.width / art.w, BOX.height / art.h) * Math.min(1, scaleX) : 0;

  return (
    <View style={[styles.header, { height: art ? HEADER_HEIGHT : PLAIN_HEADER_HEIGHT }]}>
      <StarField width={width} />
      {art ? (
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            left: BOX.centerX * scaleX - (art.w * fit) / 2 - art.left * fit,
            top: BOX.centerY - (art.h * fit) / 2 - art.top * fit,
            width: art.svgW * fit,
            height: art.svgH * fit,
          }}>
          <Image
            source={art.asset}
            style={{ width: art.svgW * fit, height: art.svgH * fit }}
            resizeMode="stretch"
            fadeDuration={0}
            accessibilityIgnoresInvertColors
          />
        </View>
      ) : null}
      <Text
        accessibilityRole="header"
        accessibilityLabel={sign ? `Your sign, ${signLabel(sign)}` : 'Your Orbit'}
        maxFontSizeMultiplier={1.4}
        style={[styles.name, { top: (art ? NAME_CENTER_Y : PLAIN_NAME_CENTER_Y) - NAME_LINE / 2 }]}>
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
