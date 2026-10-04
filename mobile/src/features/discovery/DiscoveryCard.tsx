import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { ago, money, signedPct } from '@/features/market/format';
import { StockLogo } from '@/features/market/StockLogo';
import type { DiscoveryItemVM, QuoteVM, StockVM } from '@/realtime/connection';
import { colors, font, graphFillOpacity, radius, space } from '@/ui/theme';

/** Moves smaller than this read as unchanged, so a flat day is not coloured as a gain. */
const FLAT = 0.00005;

function changeOf(quote: QuoteVM | undefined): number | null {
  if (!quote || !(quote.previousClose > 0)) return null;
  return quote.price / quote.previousClose - 1;
}

function spokenChange(fraction: number): string {
  if (Math.abs(fraction) < FLAT) return 'unchanged from the previous close';
  const pct = `${Math.abs(fraction * 100).toFixed(2)} percent`;
  return `${fraction > 0 ? 'up' : 'down'} ${pct} from the previous close`;
}

export function DiscoveryCard({
  item,
  stock,
  quote,
  index,
  onOpen,
}: {
  item: DiscoveryItemVM;
  stock: StockVM | undefined;
  quote: QuoteVM | undefined;
  index: number;
  onOpen: () => void;
}) {
  const reduceMotion = useReducedMotion();
  // Story age is read once when the card mounts; it does not need to tick.
  const [mountedAt] = useState(() => Date.now());
  const name = stock?.name || item.ticker;
  const fraction = changeOf(quote);
  const flat = fraction != null && Math.abs(fraction) < FLAT;
  const changeColor = fraction == null || flat ? colors.textMuted : fraction > 0 ? colors.success : colors.danger;
  const priceLabel = quote
    ? `${money(quote.price)}${fraction != null ? `, ${spokenChange(fraction)}` : ''}`
    : 'Price unavailable';
  const label = [
    `${name}, ${item.ticker}`,
    priceLabel,
    item.angle,
    item.about,
    `Why it found you: ${item.reasons.join('. ')}`,
  ].join('. ');

  function open() {
    try {
      void Haptics.selectionAsync();
    } catch {
      // Haptics are optional.
    }
    onOpen();
  }

  return (
    <Animated.View entering={reduceMotion ? undefined : FadeInDown.duration(380).delay(90 + index * 80)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint="Opens the company page"
        onPress={open}
        style={({ pressed }) => [styles.shadow, { transform: [{ scale: pressed ? 0.985 : 1 }] }]}>
        <View style={styles.card}>
          <LinearGradient
            colors={[`rgba(0, 0, 0, ${graphFillOpacity})`, `rgba(31, 4, 87, ${graphFillOpacity})`]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 1 }}
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.top}>
            <StockLogo ticker={item.ticker} logoUrl={stock?.logoUrl ?? ''} size={44} />
            <View style={styles.identity}>
              <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                {name}
              </Text>
              <Text style={styles.ticker} maxFontSizeMultiplier={1.3}>
                {item.ticker}
              </Text>
            </View>
            <View style={styles.quote}>
              <Text style={styles.price} maxFontSizeMultiplier={1.3}>
                {quote ? money(quote.price) : '—'}
              </Text>
              {fraction != null ? (
                <Text style={[styles.change, { color: changeColor }]} maxFontSizeMultiplier={1.3}>
                  {flat ? '0.00%' : signedPct(fraction)}
                </Text>
              ) : null}
            </View>
          </View>

          <View style={styles.angle}>
            <Text style={styles.angleText} maxFontSizeMultiplier={1.3}>
              {item.angle}
            </Text>
          </View>
          <Text style={styles.about}>{item.about}</Text>

          <View style={styles.why}>
            <Text style={styles.whyLabel} maxFontSizeMultiplier={1.3}>
              Why it found you
            </Text>
            {item.reasons.map(reason => (
              <View key={reason} style={styles.reason}>
                <Text style={styles.spark}>✦</Text>
                <Text style={styles.reasonText}>{reason}</Text>
              </View>
            ))}
          </View>

          {item.news ? (
            <View style={styles.news}>
              <Text style={styles.newsMeta} numberOfLines={1} maxFontSizeMultiplier={1.3}>
                In the news · {item.news.source} · {ago(item.news.publishedAt, mountedAt)}
              </Text>
              <Text style={styles.headline} numberOfLines={2}>
                {item.news.headline}
              </Text>
            </View>
          ) : null}
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shadow: {
    borderRadius: radius.xl,
    boxShadow: '0px 0px 20px 1px rgba(75, 36, 103, 0.22)',
  },
  card: {
    borderRadius: radius.xl,
    overflow: 'hidden',
    padding: space.lg + 2,
    gap: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  top: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  identity: { flex: 1, minWidth: 0, gap: 2 },
  name: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: '#FFFFFF' },
  ticker: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: colors.textSubtle },
  quote: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  change: { fontFamily: font.medium, fontSize: 13, lineHeight: 17, fontVariant: ['tabular-nums'] },
  angle: {
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    backgroundColor: 'rgba(59, 15, 95, 0.55)',
    paddingHorizontal: space.md,
    paddingVertical: 5,
  },
  angleText: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: colors.text },
  about: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: colors.text },
  why: {
    gap: 6,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255, 255, 255, 0.10)',
  },
  whyLabel: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.4,
    color: colors.textSubtle,
    marginBottom: 2,
  },
  reason: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  spark: { fontSize: 10, lineHeight: 20, color: colors.accent },
  reasonText: { flex: 1, fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.text },
  news: { gap: 2 },
  newsMeta: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textSubtle },
  headline: { fontFamily: font.regular, fontSize: 14, lineHeight: 19, color: colors.textMuted },
});
