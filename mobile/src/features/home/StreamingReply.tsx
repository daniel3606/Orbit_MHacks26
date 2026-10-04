import { useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, type StyleProp, type TextStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';

import { colors, font, space } from '@/ui/theme';

const WORD_MS = 32;
const LABEL = 'Thinking';

function paragraphs(text: string): string[] {
  const parts = text.split(/\n+/).map(part => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : [];
}

/** A light band travels across the word, the way a waiting agent marks that it is working. */
export function ThinkingLine() {
  const progress = useSharedValue(0);
  useEffect(() => {
    progress.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1, false);
  }, [progress]);

  return (
    <View accessibilityRole="text" accessibilityLabel="Thinking" style={styles.row}>
      {LABEL.split('').map((letter, index) => (
        <ShimmerLetter key={`${letter}-${index}`} letter={letter} index={index} progress={progress} />
      ))}
    </View>
  );
}

function ShimmerLetter({
  letter,
  index,
  progress,
}: {
  letter: string;
  index: number;
  progress: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => {
    const center = (index + 0.5) / LABEL.length;
    const head = progress.value * 1.4 - 0.2;
    const shine = Math.max(0, 1 - Math.abs(head - center) / 0.22);
    return { opacity: 0.28 + shine * 0.72 };
  });
  return <Animated.Text style={[styles.thinking, style]}>{letter}</Animated.Text>;
}

/** Reveals a finished answer one word at a time. Already-seen answers pass through whole. */
export function RevealedReply({
  id,
  text,
  animate,
  onDone,
  style,
}: {
  id: string;
  text: string;
  animate: boolean;
  onDone: (id: string) => void;
  style: StyleProp<TextStyle>;
}) {
  const tokens = useMemo(() => text.match(/\S+\s*/g) ?? [], [text]);
  const [count, setCount] = useState(animate ? 0 : tokens.length);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    if (!animate || tokens.length === 0) {
      setCount(tokens.length);
      onDoneRef.current(id);
      return;
    }
    setCount(0);
    let shown = 0;
    const timer = setInterval(() => {
      shown += 1;
      setCount(shown);
      if (shown >= tokens.length) {
        clearInterval(timer);
        onDoneRef.current(id);
      }
    }, WORD_MS);
    return () => clearInterval(timer);
  }, [animate, id, text, tokens.length]);

  const streaming = animate && count < tokens.length;
  const parts = paragraphs(tokens.slice(0, count).join(''));
  return (
    <View accessibilityLabel={text} style={styles.reply}>
      {parts.map((part, index) => (
        <Text key={`${id}:${index}`} style={style}>
          {part}
          {streaming && index === parts.length - 1 ? <Caret /> : null}
        </Text>
      ))}
      {streaming && parts.length === 0 ? (
        <Text style={style}>
          <Caret />
        </Text>
      ) : null}
    </View>
  );
}

function Caret() {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(withTiming(0, { duration: 520, easing: Easing.linear }), -1, true);
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.Text style={[styles.caret, style]}> ▍</Animated.Text>;
}

const styles = {
  row: { flexDirection: 'row' as const, alignItems: 'baseline' as const },
  reply: { gap: space.md },
  thinking: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 23,
    color: colors.text,
  },
  caret: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 23,
    color: colors.text,
  },
};
