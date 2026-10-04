import { StyleSheet, View } from 'react-native';
import { LocalSvg } from 'react-native-svg/css';

/**
 * Star field from the design (Horoscope and trade ticket frames), laid out on a 430pt-wide
 * frame. `x`/`y` are each star's centre measured from the top of the screen; x scales with
 * the screen width, y does not, so the stars keep their distance from the status bar.
 */
const STARS = [
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 81.5, y: 115.5 },
  { asset: require('../../assets/images/stars/star-5.svg'), size: 50.7971, x: 47.5, y: 103.5 },
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 159.5, y: 113.5 },
  { asset: require('../../assets/images/stars/star-2.svg'), size: 47.7971, x: 26, y: 201 },
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 247.5, y: 88.5 },
  { asset: require('../../assets/images/stars/star-5.svg'), size: 50.7971, x: 336.5, y: 63.5 },
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 309.5, y: 121.5 },
  { asset: require('../../assets/images/stars/star-8.svg'), size: 53.7971, x: 143, y: 60 },
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 390.5, y: 234.5 },
  { asset: require('../../assets/images/stars/star-3.svg'), size: 48.7971, x: 397.5, y: 157.5 },
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
          <LocalSvg asset={star.asset} width={star.size} height={star.size} />
        </View>
      ))}
    </View>
  );
}
