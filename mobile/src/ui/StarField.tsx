import { Image, StyleSheet, View } from 'react-native';

/**
 * Star field from the design (Horoscope and trade ticket frames), laid out on a 430pt-wide
 * frame. The stars are PNGs rasterized from the Figma SVGs (scripts/rasterize-stars.mjs): their
 * stacked glow filters arrived late and blocked the UI thread when drawn live. `x`/`y` are each star's centre measured from the top of the screen; x scales with
 * the screen width, y does not, so the stars keep their distance from the status bar.
 */
const STARS = [
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 81.5, y: 115.5 },
  { asset: require('../../assets/images/stars/star-5.png'), size: 50.7971, x: 47.5, y: 103.5 },
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 159.5, y: 113.5 },
  { asset: require('../../assets/images/stars/star-2.png'), size: 47.7971, x: 26, y: 201 },
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 247.5, y: 88.5 },
  { asset: require('../../assets/images/stars/star-5.png'), size: 50.7971, x: 336.5, y: 63.5 },
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 309.5, y: 121.5 },
  { asset: require('../../assets/images/stars/star-8.png'), size: 53.7971, x: 143, y: 60 },
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 390.5, y: 234.5 },
  { asset: require('../../assets/images/stars/star-3.png'), size: 48.7971, x: 397.5, y: 157.5 },
] as const;

export const DESIGN_WIDTH = 430;

export function StarField({ width }: { width: number }) {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {STARS.map((star, index) => (
        <View
          key={index}
          style={{
            position: 'absolute',
            left: (star.x / DESIGN_WIDTH) * width - star.size / 2,
            top: star.y - star.size / 2,
            width: star.size,
            height: star.size,
          }}>
          <Image
            source={star.asset}
            style={{ width: star.size, height: star.size }}
            fadeDuration={0}
            accessibilityIgnoresInvertColors
          />
        </View>
      ))}
    </View>
  );
}
