import { StyleSheet, Text, View } from 'react-native';
import { LocalSvg } from 'react-native-svg/css';

import { colors, font } from './theme';

/**
 * The large logo lockup from the Loading frame: two stars inside an orbit drawn
 * as two arcs, then the wordmark. Offsets are the design's, measured from the
 * top-left of the three parts' combined bounds (139.3 × 156.7).
 */
const MARK = { width: 139.3, height: 156.73 };
const PARTS = [
  { asset: require('../../assets/images/logo/orbit-arc-lower.svg'), left: 0, top: 56.73, width: 55.9403, height: 88.9401, flip: false },
  { asset: require('../../assets/images/logo/orbit-arc-upper.svg'), left: 60.93, top: 0, width: 78.3732, height: 72.7877, flip: true },
  { asset: require('../../assets/images/logo/orbit-stars.svg'), left: 24.26, top: 10.73, width: 103.343, height: 146, flip: false },
] as const;

/** `scale` 1 is the design size: a 60pt wordmark. */
export function OrbitLogo({ scale = 1 }: { scale?: number }) {
  return (
    <View accessible accessibilityRole="image" accessibilityLabel="Orbit" style={styles.row}>
      <View style={{ width: MARK.width * scale, height: MARK.height * scale }}>
        {PARTS.map((part, index) => (
          <View
            key={index}
            style={{
              position: 'absolute',
              left: part.left * scale,
              top: part.top * scale,
              width: part.width * scale,
              height: part.height * scale,
              transform: part.flip ? [{ rotate: '180deg' }] : undefined,
            }}>
            <LocalSvg asset={part.asset} width={part.width * scale} height={part.height * scale} />
          </View>
        ))}
      </View>
      <Text
        allowFontScaling={false}
        style={[styles.wordmark, { fontSize: 60 * scale, lineHeight: 82 * scale, marginLeft: 12 * scale }]}>
        Orbit
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  wordmark: { fontFamily: font.bold, color: colors.text },
});
