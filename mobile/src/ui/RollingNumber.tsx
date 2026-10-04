/**
 * Numbers that move when they change.
 *
 * RollingText: each character slides in from below as it is typed and drops
 * out as it is deleted, and the whole figure re-centres as its width changes.
 * Odometer: each digit column rolls through the digits in between.
 */
import { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolateColor,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

const ROLL_IN = { duration: 150, easing: Easing.out(Easing.cubic) };
const ROLL_OUT = { duration: 130, easing: Easing.in(Easing.quad) };
const RECENTER = LinearTransition.duration(170).easing(Easing.out(Easing.cubic));

/** 1 when the value grows (characters rise), −1 when it shrinks (characters fall). */
export type RollDirection = SharedValue<number>;

type Glyph = { key: string; ch: string };

/**
 * Stable slots so unchanged digits keep their place: whole digits count from the
 * left, separators sit after a digit, fraction digits count from the point.
 * A slot whose character changes gets a new key and rolls.
 */
function glyphs(text: string): Glyph[] {
  const out: Glyph[] = [];
  let whole = 0;
  let frac = -1;
  for (const ch of text) {
    let slot: string;
    if (/\d/.test(ch)) {
      if (frac >= 0) slot = `f${frac++}`;
      else slot = `d${whole++}`;
    } else if (ch === '.') {
      slot = 'dot';
      frac = 0;
    } else if (ch === ',') {
      slot = `c${whole}`;
    } else {
      slot = `s${out.length}`;
    }
    out.push({ key: `${slot}:${ch}`, ch });
  }
  return out;
}

function rollIn(distance: number, direction: RollDirection) {
  return () => {
    'worklet';
    const from = direction.get() >= 0 ? distance : -distance;
    return {
      initialValues: { opacity: 0, transform: [{ translateY: from }] },
      animations: { opacity: withTiming(1, ROLL_IN), transform: [{ translateY: withTiming(0, ROLL_IN) }] },
    };
  };
}

function rollOut(distance: number, direction: RollDirection) {
  return () => {
    'worklet';
    const to = direction.get() >= 0 ? -distance : distance;
    return {
      initialValues: { opacity: 1, transform: [{ translateY: 0 }] },
      animations: { opacity: withTiming(0, ROLL_OUT), transform: [{ translateY: withTiming(to, ROLL_OUT) }] },
    };
  };
}

export function RollingText({
  text,
  direction,
  fontSize,
  lineHeight,
  style,
  color,
  dimColor,
  dim = false,
  accessibilityLabel,
}: {
  text: string;
  direction: RollDirection;
  fontSize: number;
  lineHeight: number;
  style?: StyleProp<TextStyle>;
  color: string;
  /** Colour while `dim`, e.g. an empty "$0". */
  dimColor: string;
  dim?: boolean;
  accessibilityLabel?: string;
}) {
  const shade = useSharedValue(dim ? 1 : 0);
  useEffect(() => {
    shade.set(withTiming(dim ? 1 : 0, { duration: 220 }));
  }, [dim, shade]);
  const colorStyle = useAnimatedStyle(() => ({ color: interpolateColor(shade.get(), [0, 1], [color, dimColor]) }));

  const distance = lineHeight * 0.6;
  return (
    <View
      style={[styles.row, { height: lineHeight }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? text}>
      {glyphs(text).map(glyph => (
        <Animated.Text
          key={glyph.key}
          entering={rollIn(distance, direction)}
          exiting={rollOut(distance, direction)}
          layout={RECENTER}
          style={[style, { fontSize, lineHeight }, colorStyle]}>
          {glyph.ch}
        </Animated.Text>
      ))}
    </View>
  );
}

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

function DigitColumn({ digit, lineHeight, style }: { digit: number; lineHeight: number; style?: StyleProp<TextStyle> }) {
  const offset = useSharedValue(-digit * lineHeight);
  useEffect(() => {
    offset.set(withTiming(-digit * lineHeight, { duration: 300, easing: Easing.out(Easing.cubic) }));
  }, [digit, lineHeight, offset]);
  const strip = useAnimatedStyle(() => ({ transform: [{ translateY: offset.get() }] }));
  return (
    <View style={{ height: lineHeight, overflow: 'hidden' }}>
      <Animated.View style={strip}>
        {DIGITS.map(d => (
          <Text key={d} style={[style, { lineHeight, height: lineHeight }]}>
            {d}
          </Text>
        ))}
      </Animated.View>
    </View>
  );
}

/** "≈ 0.301 shares" where each digit rolls like a meter. */
export function Odometer({
  value,
  digits,
  prefix = '',
  suffix = '',
  lineHeight,
  style,
}: {
  value: number;
  digits: number;
  prefix?: string;
  suffix?: string;
  lineHeight: number;
  style?: StyleProp<TextStyle>;
}) {
  const text = value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const point = text.indexOf('.');
  const wholeLength = point >= 0 ? point : text.length;
  return (
    <View style={[styles.row, { height: lineHeight }]} accessible accessibilityRole="text" accessibilityLabel={`${prefix}${text}${suffix}`}>
      {prefix ? (
        <Animated.View layout={RECENTER}>
          <Text style={[style, { lineHeight }]}>{prefix}</Text>
        </Animated.View>
      ) : null}
      {[...text].map((ch, index) => {
        // Whole digits are keyed from the point leftward so new leading digits fade in.
        const key = index < wholeLength ? `w${wholeLength - index}` : `f${index - wholeLength}`;
        return (
          <Animated.View key={key} entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)} layout={RECENTER}>
            {/\d/.test(ch) ? (
              <DigitColumn digit={Number(ch)} lineHeight={lineHeight} style={style} />
            ) : (
              <Text style={[style, { lineHeight }]}>{ch}</Text>
            )}
          </Animated.View>
        );
      })}
      {suffix ? (
        <Animated.View layout={RECENTER}>
          <Text style={[style, { lineHeight }]}>{suffix}</Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'center', overflow: 'hidden' },
});
