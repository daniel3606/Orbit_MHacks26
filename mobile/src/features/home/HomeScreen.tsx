import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  Easing,
  Image,
  Keyboard,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
} from 'react-native';
import Svg, { Path, SvgXml } from 'react-native-svg';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { chartSeries } from '@/features/market/series';
import { realtime, type StockVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { StockGraph } from '@/ui/StockGraph';
import { T } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

/** Same artwork as assets/images/Template-orbit.svg, stretched to the screen. */
const orbitTemplate = `<svg width="430" height="932" viewBox="0 0 430 932" preserveAspectRatio="none" fill="none" xmlns="http://www.w3.org/2000/svg">
<rect width="430" height="932" fill="url(#paint0_linear_14_774)"/>
<defs>
<linearGradient id="paint0_linear_14_774" x1="215" y1="0" x2="215" y2="932" gradientUnits="userSpaceOnUse">
<stop stop-color="#050308"/>
<stop offset="0.5" stop-color="#0A0710"/>
<stop offset="1" stop-color="#150E22"/>
</linearGradient>
</defs>
</svg>`;

const mark = require('../../../assets/images/icon-transparent.png');
const bell = require('../../../assets/images/bell-icon.png');

function salutation(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

const INTRO =
  'Are you ready to start your early financial life? I see how you haven’t invested on any stock yet. Let me recommend you some best stocks for today.';

const TYPE_PACE_MS = 34;
const ASK_CLEARANCE = 88;

/** How far the composer should rise so it sits just above the keyboard, not the tab bar. */
function useKeyboardLift(tabBarHeight: number) {
  const lift = useRef(new Animated.Value(0)).current;
  const [inset, setInset] = useState(0);

  useEffect(() => {
    function onFrame(event: KeyboardEvent) {
      const covered = Math.max(0, Dimensions.get('window').height - event.endCoordinates.screenY);
      const next = Math.max(0, covered - tabBarHeight);
      setInset(next);
      const duration = event.duration && event.duration > 0 ? event.duration : 0;
      if (duration === 0) {
        lift.setValue(-next);
        return;
      }
      Animated.timing(lift, {
        toValue: -next,
        duration,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    }

    const frames =
      Platform.OS === 'ios'
        ? [Keyboard.addListener('keyboardWillChangeFrame', onFrame)]
        : [
            Keyboard.addListener('keyboardDidShow', onFrame),
            Keyboard.addListener('keyboardDidHide', () => {
              setInset(0);
              Animated.timing(lift, { toValue: 0, duration: 180, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
            }),
          ];
    return () => frames.forEach(frame => frame.remove());
  }, [lift, tabBarHeight]);

  return { lift, inset };
}

/** Reveals `text` one character at a time, with a light tick on each key. */
function TypedText({
  text,
  active,
  onDone,
  style,
  accessibilityRole,
}: {
  text: string;
  active: boolean;
  onDone?: () => void;
  style?: StyleProp<TextStyle>;
  accessibilityRole?: 'header' | 'text';
}) {
  const [count, setCount] = useState(0);
  const [caretOn, setCaretOn] = useState(true);
  const done = !active || count >= text.length;

  useEffect(() => {
    if (!active || count >= text.length) return;
    const timer = setTimeout(() => {
      const next = text[count];
      setCount(current => current + 1);
      if (next && !/\s/.test(next)) {
        try {
          void Haptics.selectionAsync();
        } catch {
          // The dev client needs a rebuild before the haptic module is available.
        }
      }
    }, TYPE_PACE_MS);
    return () => clearTimeout(timer);
  }, [active, count, text]);

  useEffect(() => {
    if (active && count >= text.length) onDone?.();
  }, [active, count, onDone, text.length]);

  useEffect(() => {
    if (done) return;
    const timer = setInterval(() => setCaretOn(on => !on), 460);
    return () => clearInterval(timer);
  }, [done]);

  return (
    <Text style={style} accessibilityRole={accessibilityRole} accessibilityLabel={text}>
      {text.slice(0, active ? count : 0)}
      {done ? null : <Text style={{ color: caretOn ? '#FFFFFF' : 'transparent' }}>▍</Text>}
    </Text>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const greeting = `${salutation()} Daniel!`;
  const [greetingDone, setGreetingDone] = useState(false);
  const markGreetingDone = useCallback(() => setGreetingDone(true), []);
  const insets = useSafeAreaInsets();
  const tabBarHeight = (Platform.OS === 'ios' ? 49 : 56) + insets.bottom;
  const { lift, inset } = useKeyboardLift(tabBarHeight);
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const stocks = rt.market.stocks;
  const hero = stocks.find(stock => stock.ticker === 'SPY') ?? stocks.find(stock => stock.kind === 'benchmark');
  const heroQuote = hero ? rt.market.quotes[hero.ticker] : undefined;
  const recommendations = rt.recommendations;
  const checkout: StockVM[] =
    recommendations.length > 0
      ? recommendations
          .map(item => stocks.find(stock => stock.ticker === item.ticker))
          .filter((stock): stock is StockVM => stock != null)
      : stocks.filter(stock => stock.kind === 'equity');

  function openTicker(ticker: string) {
    router.push({ pathname: '/stock/[ticker]', params: { ticker } });
  }

  function onFrame(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setFrame(current => (current.width === width && current.height === height ? current : { width, height }));
  }

  return (
    <View style={styles.root} onLayout={onFrame}>
      {frame.width > 0 ? (
        <SvgXml
          xml={orbitTemplate}
          width={frame.width}
          height={frame.height}
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
        />
      ) : null}
      <SafeAreaView style={styles.fill} edges={['top']}>
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: ASK_CLEARANCE + inset }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}>
          <ConnectionBanner />
          <View style={styles.header}>
            <View style={styles.brand}>
              <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
              <T variant="title" style={styles.wordmark}>
                Orbit
              </T>
            </View>
            <View accessibilityLabel="Notifications" style={styles.bellWrap}>
              <Image source={bell} style={styles.bell} resizeMode="contain" accessibilityIgnoresInvertColors />
              <View style={styles.badge} />
            </View>
          </View>

          <TypedText text={greeting} active onDone={markGreetingDone} style={styles.greeting} accessibilityRole="header" />
          <TypedText text={INTRO} active={greetingDone} style={styles.intro} />

          {hero ? (
            <Pressable accessibilityRole="button" accessibilityLabel={`Open ${hero.ticker}`} onPress={() => openTicker(hero.ticker)}>
              <StockGraph
                title="S&P 500"
                plain
                price={heroQuote?.price ?? null}
                previousClose={heroQuote?.previousClose}
                points={chartSeries(rt.market.closes[hero.ticker], heroQuote)}
              />
            </Pressable>
          ) : null}

          <T variant="heading" style={styles.section}>
            Stocks to Check Out!
          </T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
            {checkout.map(stock => {
              const quote = rt.market.quotes[stock.ticker];
              return (
                <Pressable
                  key={stock.ticker}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${stock.ticker}`}
                  onPress={() => openTicker(stock.ticker)}
                  style={styles.mini}>
                  <StockGraph
                    title={stock.name || stock.ticker}
                    compact
                    price={quote?.price ?? null}
                    previousClose={quote?.previousClose}
                    points={chartSeries(rt.market.closes[stock.ticker], quote)}
                  />
                </Pressable>
              );
            })}
          </ScrollView>
        </ScrollView>

        <Animated.View style={[styles.askWrap, { transform: [{ translateY: lift }] }]}>
          <View style={styles.ask}>
            <TextInput
              placeholder="Ask Anything..."
              placeholderTextColor="#999999"
              style={styles.askInput}
              accessibilityLabel="Ask Anything"
            />
            <Pressable accessibilityRole="button" accessibilityLabel="Send" style={styles.askButton}>
              <Svg width={16} height={16} viewBox="0 0 16 16">
                <Path
                  d="M8 12.5 V3.5 M3.8 7.4 L8 3.2 L12.2 7.4"
                  stroke="#FFFFFF"
                  strokeWidth={1.7}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  fill="none"
                />
              </Svg>
            </Pressable>
          </View>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1, backgroundColor: 'transparent' },
  scroll: {
    paddingHorizontal: space.xl,
    paddingTop: space.sm,
    paddingBottom: ASK_CLEARANCE,
    gap: space.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.md,
  },
  brand: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  mark: { width: 34, height: 34 },
  wordmark: { fontFamily: font.bold, fontSize: 26, lineHeight: 32, color: '#FFFFFF' },
  bellWrap: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  bell: { width: 26, height: 26 },
  badge: {
    position: 'absolute',
    top: 1,
    right: 0,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#FF3B30',
  },
  greeting: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, color: '#FFFFFF' },
  intro: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: colors.text, marginTop: -space.sm },
  section: { fontFamily: font.bold, fontSize: 22, lineHeight: 28, color: '#FFFFFF' },
  row: {
    gap: space.md,
    paddingRight: space.xl,
    paddingVertical: space.lg,
    overflow: 'visible',
  },
  mini: { width: 176 },
  askWrap: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.sm,
  },
  ask: {
    minHeight: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: space.lg,
    paddingRight: 8,
    backgroundColor: '#1E1F20',
  },
  askInput: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    color: colors.text,
    paddingVertical: space.md,
  },
  askButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
