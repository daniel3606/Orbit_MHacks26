import { useFocusEffect, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useCallback, useMemo, useState, type ComponentProps } from 'react';
import {
  Image,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolateColor,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Path, SvgXml } from 'react-native-svg';

import { money } from '@/features/market/format';
import { filterStocks } from '@/features/search/filter';
import { useRecents } from '@/features/search/recents';
import { realtime, type QuoteVM, type StockVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { colors, font } from '@/ui/theme';

/** Same artwork as the home screen, stretched to this tab. */
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

const GAIN = '#34C759';
const MUTED = '#8E8E93';
const FIELD_EASE = { duration: 220, easing: Easing.out(Easing.cubic) };

function tick() {
  try {
    void Haptics.selectionAsync();
  } catch {
    // The dev client needs a rebuild before the haptic module is available.
  }
}

function changeLabel(quote: QuoteVM | undefined): { text: string; color: string } | null {
  if (!quote || !(quote.previousClose > 0)) return null;
  const delta = quote.price - quote.previousClose;
  const fraction = delta / quote.previousClose;
  const sign = delta >= 0 ? '+' : '−';
  const pct = Math.abs(fraction * 100).toFixed(2);
  return {
    text: `${sign}${money(Math.abs(delta))} (${pct}%)`,
    color: delta >= 0 ? GAIN : colors.danger,
  };
}

/** A remembered ticker still renders before its catalog row arrives. */
function resolveRecent(ticker: string, stocks: readonly StockVM[]): StockVM {
  const found = stocks.find(stock => stock.ticker === ticker);
  if (found) return found;
  return {
    ticker,
    name: ticker === 'AAPL' ? 'Apple' : ticker,
    exchange: '',
    industry: '',
    sector: '',
    kind: 'equity',
    benchmark: '',
    displayOrder: 0,
  };
}

function SearchGlyph() {
  return (
    <Svg width={18} height={18} viewBox="0 0 18 18">
      <Circle cx="7.6" cy="7.6" r="5.15" stroke="#C8C8CD" strokeWidth={1.6} fill="none" />
      <Path d="M11.5 11.5 L15.4 15.4" stroke="#C8C8CD" strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

function ClearGlyph() {
  return (
    <Svg width={14} height={14} viewBox="0 0 14 14">
      <Path d="M3.2 3.2 L10.8 10.8 M10.8 3.2 L3.2 10.8" stroke="#C8C8CD" strokeWidth={1.6} strokeLinecap="round" />
    </Svg>
  );
}

type Entering = ComponentProps<typeof Animated.View>['entering'];
type Exiting = ComponentProps<typeof Animated.View>['exiting'];
type LayoutAnim = ComponentProps<typeof Animated.View>['layout'];

function StockRow({
  stock,
  quote,
  onPress,
  enter,
  exit,
  layout,
}: {
  stock: StockVM;
  quote: QuoteVM | undefined;
  onPress: () => void;
  enter: Entering;
  exit: Exiting;
  layout: LayoutAnim;
}) {
  const change = changeLabel(quote);
  const price = quote ? money(quote.price) : '—';
  const label = [stock.ticker, stock.name, price, change?.text].filter(Boolean).join(', ');

  return (
    <Animated.View entering={enter} exiting={exit} layout={layout}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Open ${label}`}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <View style={styles.markWrap}>
          <Image source={mark} style={styles.mark} resizeMode="contain" accessibilityIgnoresInvertColors />
        </View>
        <View style={styles.identity}>
          <Text style={styles.ticker} numberOfLines={1}>
            {stock.ticker}
          </Text>
          <Text style={styles.company} numberOfLines={1}>
            {stock.name}
          </Text>
        </View>
        <View style={styles.quote}>
          <Text style={[styles.price, !quote && styles.priceMuted]} numberOfLines={1}>
            {price}
          </Text>
          <Text style={[styles.change, { color: change?.color ?? 'transparent' }]} numberOfLines={1}>
            {change?.text ?? ' '}
          </Text>
        </View>
      </Pressable>
    </Animated.View>
  );
}

export default function SearchScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const recents = useRecents(state => state.tickers);
  const remember = useRecents(state => state.remember);
  const clearRecents = useRecents(state => state.clear);
  const [query, setQuery] = useState('');
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const reduceMotion = useReducedMotion();
  const focused = useSharedValue(0);

  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const searching = query.trim().length > 0;
  const stocks = rt.market.stocks;
  const quotes = rt.market.quotes;
  const applied = rt.market.applied;
  const rows = useMemo(
    () => (searching ? filterStocks(stocks, query) : recents.map(ticker => resolveRecent(ticker, stocks))),
    [searching, stocks, query, recents],
  );
  const showEmpty = searching && applied && rows.length === 0;

  const enter = useMemo(
    () => (reduceMotion ? undefined : FadeIn.duration(240).easing(Easing.out(Easing.cubic))),
    [reduceMotion],
  );
  const exit = useMemo(
    () => (reduceMotion ? undefined : FadeOut.duration(160).easing(Easing.out(Easing.cubic))),
    [reduceMotion],
  );
  const layout = useMemo(
    () => (reduceMotion ? undefined : LinearTransition.duration(240).easing(Easing.out(Easing.cubic))),
    [reduceMotion],
  );

  const fieldStyle = useAnimatedStyle(() => ({
    borderColor: interpolateColor(focused.get(), [0, 1], ['rgba(255,255,255,0.38)', 'rgba(255,255,255,0.88)']),
    backgroundColor: interpolateColor(focused.get(), [0, 1], ['rgba(255,255,255,0.025)', 'rgba(255,255,255,0.06)']),
  }));

  function onFrame(event: LayoutChangeEvent) {
    const { width, height } = event.nativeEvent.layout;
    setFrame(current => (current.width === width && current.height === height ? current : { width, height }));
  }

  function setFocus(next: boolean) {
    focused.set(withTiming(next ? 1 : 0, reduceMotion ? { duration: 0 } : FIELD_EASE));
  }

  function clearQuery() {
    if (query.length > 0) tick();
    setQuery('');
  }

  function clearRecentList() {
    if (recents.length === 0) return;
    tick();
    clearRecents();
  }

  function openTicker(ticker: string) {
    tick();
    remember(ticker);
    Keyboard.dismiss();
    router.push({ pathname: '/stock/[ticker]', params: { ticker } });
  }

  return (
    <View style={styles.root} onLayout={onFrame}>
      {frame.width > 0 ? (
        <SvgXml xml={orbitTemplate} width={frame.width} height={frame.height} pointerEvents="none" style={StyleSheet.absoluteFill} />
      ) : null}
      <SafeAreaView style={styles.fill} edges={['top']}>
        <Animated.View style={[styles.field, fieldStyle]}>
          <View style={styles.glyph}>
            <SearchGlyph />
          </View>
          <TextInput
            value={query}
            onChangeText={setQuery}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            placeholder="Search Orbit..."
            placeholderTextColor={MUTED}
            style={styles.input}
            accessibilityLabel="Search Orbit"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            clearButtonMode="never"
            returnKeyType="search"
            keyboardAppearance="dark"
            selectionColor="#FFFFFF"
            onSubmitEditing={() => Keyboard.dismiss()}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            onPress={clearQuery}
            hitSlop={8}
            style={styles.clearButton}>
            <ClearGlyph />
          </Pressable>
        </Animated.View>

        <Animated.ScrollView
          style={styles.fill}
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}>
          {searching ? null : (
            <Animated.View entering={enter} exiting={exit} layout={layout} style={styles.section}>
              <Text style={styles.recent} accessibilityRole="header">
                Recent
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear recent"
                accessibilityState={{ disabled: recents.length === 0 }}
                disabled={recents.length === 0}
                onPress={clearRecentList}
                hitSlop={8}>
                <Text style={[styles.clear, recents.length === 0 && styles.clearDisabled]}>Clear</Text>
              </Pressable>
            </Animated.View>
          )}

          {rows.map(stock => (
            <StockRow
              key={stock.ticker}
              stock={stock}
              quote={quotes[stock.ticker]}
              onPress={() => openTicker(stock.ticker)}
              enter={enter}
              exit={exit}
              layout={layout}
            />
          ))}

          {showEmpty ? (
            <Animated.View entering={enter} exiting={exit}>
              <Text style={styles.empty}>No matches</Text>
            </Animated.View>
          ) : null}
        </Animated.ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1, backgroundColor: 'transparent' },
  field: {
    marginTop: 8,
    marginHorizontal: 20,
    minHeight: 50,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 8,
  },
  glyph: { width: 22, alignItems: 'center', justifyContent: 'center' },
  input: {
    flex: 1,
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 21,
    color: '#FFFFFF',
    backgroundColor: 'transparent',
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  clearButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scroll: {
    paddingHorizontal: 20,
    paddingBottom: 32,
    flexGrow: 1,
  },
  section: {
    marginTop: 28,
    marginBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  recent: {
    fontFamily: font.bold,
    fontSize: 22,
    lineHeight: 28,
    color: '#FFFFFF',
  },
  clear: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 22,
    color: MUTED,
  },
  clearDisabled: { opacity: 0.35 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
  },
  rowPressed: { opacity: 0.62 },
  markWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mark: { width: 40, height: 40 },
  identity: { flex: 1, gap: 2 },
  ticker: {
    fontFamily: font.bold,
    fontSize: 17,
    lineHeight: 22,
    color: '#FFFFFF',
  },
  company: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 18,
    color: MUTED,
  },
  quote: { alignItems: 'flex-end', gap: 2, flexShrink: 0, minWidth: 108 },
  price: {
    fontFamily: font.regular,
    fontSize: 16,
    lineHeight: 21,
    color: '#FFFFFF',
    textAlign: 'right',
  },
  priceMuted: { color: MUTED },
  change: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 18,
    textAlign: 'right',
  },
  empty: {
    marginTop: 22,
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 20,
    color: MUTED,
  },
});
