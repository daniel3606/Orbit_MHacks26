import * as Haptics from 'expo-haptics';
import { useEffect, useState } from 'react';
import { LayoutAnimation, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { formatMicros } from '@/features/market/format';
import { StockLogo } from '@/features/market/StockLogo';
import type { PaperPositionVM, StockVM } from '@/realtime/connection';
import { colors, font, HIT, space } from '@/ui/theme';

import { GlowCard } from './GlowCard';

/**
 * Holding colours, largest first. Checked with the dataviz validator against the
 * dark card (#0D0816): every slot sits in the dark lightness band and adjacent
 * slots stay apart under deutan, protan and tritan vision. Gain/loss green and
 * red are left out so a holding's colour never reads as its performance.
 */
const HOLDING_COLORS = ['#B38C15', '#8169DD', '#00A9A2', '#D46050', '#2784D5'] as const;
const OTHER_COLOR = '#4E4858';
const CASH_COLOR = '#8C8696';
const COLLAPSED_ROWS = HOLDING_COLORS.length;
const BAR_HEIGHT = 12;

type Slice = {
  key: string;
  ticker: string | null;
  name: string;
  logoUrl: string;
  color: string;
  /** Market value in micros, or null when Alpaca has not valued the position yet. */
  valueMicros: string | null;
  weight: number;
  plMicros: string | null;
};

function weightOf(micros: string | null): number {
  if (!micros || !/^-?\d+$/.test(micros)) return 0;
  return Math.max(0, Number(micros) / 1_000_000);
}

function slicesFor(positions: PaperPositionVM[], cashMicros: string, stocks: StockVM[]): Slice[] {
  const holdings = [...positions]
    .sort((a, b) => weightOf(b.marketValueMicros) - weightOf(a.marketValueMicros) || a.ticker.localeCompare(b.ticker))
    .map((position, index): Slice => {
      const stock = stocks.find(row => row.ticker === position.ticker);
      return {
        key: position.ticker,
        ticker: position.ticker,
        name: stock?.name || position.ticker,
        logoUrl: stock?.logoUrl ?? '',
        color: HOLDING_COLORS[index] ?? OTHER_COLOR,
        valueMicros: position.marketValueMicros,
        weight: weightOf(position.marketValueMicros),
        plMicros: position.unrealizedPlMicros,
      };
    });
  const cash: Slice = {
    key: 'cash',
    ticker: null,
    name: 'Cash',
    logoUrl: '',
    color: CASH_COLOR,
    valueMicros: cashMicros,
    weight: weightOf(cashMicros),
    plMicros: null,
  };
  return [...holdings, cash];
}

function share(weight: number, total: number): string {
  if (total <= 0 || weight <= 0) return '0%';
  const pct = (weight / total) * 100;
  if (pct < 0.1) return '<0.1%';
  return `${pct.toFixed(pct >= 10 ? 0 : 1)}%`;
}

/** Holdings past the fifth fold into one "Other" segment so the bar stays readable. */
function barSegments(slices: Slice[]): { key: string; color: string; weight: number }[] {
  const holdings = slices.filter(slice => slice.ticker != null && slice.weight > 0);
  const named = holdings.slice(0, COLLAPSED_ROWS);
  const other = holdings.slice(COLLAPSED_ROWS).reduce((sum, slice) => sum + slice.weight, 0);
  const cash = slices.find(slice => slice.ticker == null);
  return [
    ...named.map(slice => ({ key: slice.key, color: slice.color, weight: slice.weight })),
    ...(other > 0 ? [{ key: 'other', color: OTHER_COLOR, weight: other }] : []),
    ...(cash && cash.weight > 0 ? [{ key: 'cash', color: CASH_COLOR, weight: cash.weight }] : []),
  ];
}

function DistributionBar({ slices }: { slices: Slice[] }) {
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const reveal = useSharedValue(reduceMotion ? 1 : 0);
  const segments = barSegments(slices);
  const clip = useAnimatedStyle(() => ({ width: reveal.get() * width }));

  useEffect(() => {
    if (width > 0) reveal.set(withTiming(1, { duration: reduceMotion ? 0 : 720, easing: Easing.out(Easing.cubic) }));
  }, [reduceMotion, reveal, width]);

  return (
    <View
      style={styles.barTrack}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={event => {
        const next = event.nativeEvent.layout.width;
        setWidth(current => (current === next ? current : next));
      }}>
      <Animated.View style={[styles.barClip, clip]}>
        <View style={[styles.bar, { width }]}>
          {segments.map(segment => (
            <View key={segment.key} style={[styles.segment, { flexGrow: segment.weight, backgroundColor: segment.color }]} />
          ))}
        </View>
      </Animated.View>
    </View>
  );
}

function HoldingRow({ slice, total, onOpen }: { slice: Slice; total: number; onOpen?: () => void }) {
  const pct = share(slice.weight, total);
  const pl = slice.plMicros && /^-?\d+$/.test(slice.plMicros) ? slice.plMicros : null;
  const plTone = pl == null || pl === '0' ? colors.textMuted : pl.startsWith('-') ? colors.danger : colors.success;
  const value = slice.valueMicros ? formatMicros(slice.valueMicros) : '—';
  const label = [
    slice.ticker ? `${slice.name}, ${slice.ticker}` : slice.name,
    `${pct} of the portfolio`,
    value === '—' ? 'Value not reported yet' : value,
    pl ? `Unrealized ${pl.startsWith('-') ? 'loss' : 'gain'} ${formatMicros(pl.replace('-', ''))}` : null,
  ]
    .filter(Boolean)
    .join('. ');

  const body = (
    <>
      <StockLogo ticker={slice.ticker ?? '$'} logoUrl={slice.logoUrl} size={36} />
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1} maxFontSizeMultiplier={1.3}>
          {slice.name}
        </Text>
        <View style={styles.meta}>
          <View style={[styles.dot, { backgroundColor: slice.color }]} />
          <Text style={styles.metaText} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {slice.ticker ? `${slice.ticker} · ${pct}` : pct}
          </Text>
        </View>
      </View>
      <View style={styles.figures}>
        <Text style={styles.value} maxFontSizeMultiplier={1.3}>
          {value}
        </Text>
        {pl ? (
          <Text style={[styles.pl, { color: plTone }]} maxFontSizeMultiplier={1.3}>
            {`${pl.startsWith('-') ? '' : '+'}${formatMicros(pl)}`}
          </Text>
        ) : slice.ticker == null ? (
          <Text style={styles.pl} maxFontSizeMultiplier={1.3}>
            Ready to invest
          </Text>
        ) : null}
      </View>
    </>
  );

  if (!onOpen) {
    return (
      <View style={styles.row} accessible accessibilityLabel={label}>
        {body}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Opens the company page"
      onPress={() => {
        try {
          void Haptics.selectionAsync();
        } catch {
          // Haptics are optional.
        }
        onOpen();
      }}
      style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      {body}
    </Pressable>
  );
}

export function PortfolioDistributionCard({
  positions,
  cashMicros,
  stocks,
  onOpen,
  onDiscover,
}: {
  positions: PaperPositionVM[];
  cashMicros: string;
  stocks: StockVM[];
  onOpen: (ticker: string) => void;
  onDiscover: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const slices = slicesFor(positions, cashMicros, stocks);
  const holdings = slices.filter(slice => slice.ticker != null);
  const cash = slices[slices.length - 1];
  const total = slices.reduce((sum, slice) => sum + slice.weight, 0);
  const folds = holdings.length > COLLAPSED_ROWS;
  const shown = expanded || !folds ? holdings : holdings.slice(0, COLLAPSED_ROWS);

  function toggle() {
    LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
    setExpanded(open => !open);
  }

  return (
    <GlowCard>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Portfolio distribution
        </Text>
        {folds ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={expanded ? 'Show fewer holdings' : `View all ${holdings.length} holdings`}
            accessibilityState={{ expanded }}
            onPress={toggle}
            hitSlop={(HIT - 32) / 2}
            style={({ pressed }) => [styles.pillButton, pressed && { opacity: 0.6 }]}>
            <Text style={styles.pillLabel}>{expanded ? 'Show less' : 'View all'}</Text>
          </Pressable>
        ) : null}
      </View>

      <DistributionBar slices={slices} />

      <View style={styles.rows}>
        {shown.map(slice => (
          <HoldingRow key={slice.key} slice={slice} total={total} onOpen={() => onOpen(slice.ticker!)} />
        ))}
        <HoldingRow slice={cash} total={total} />
      </View>

      {holdings.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>Nothing invested yet. Companies you buy show up here.</Text>
          <Pressable
            accessibilityRole="button"
            onPress={onDiscover}
            hitSlop={(HIT - 32) / 2}
            style={({ pressed }) => [styles.pillButton, pressed && { opacity: 0.6 }]}>
            <Text style={styles.pillLabel}>Find a company</Text>
          </Pressable>
        </View>
      ) : null}
    </GlowCard>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 32 },
  title: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: colors.text },
  pillButton: {
    height: 32,
    paddingHorizontal: space.md,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  pillLabel: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.text },
  barTrack: { height: BAR_HEIGHT, marginTop: space.xs },
  barClip: { height: BAR_HEIGHT, overflow: 'hidden', borderRadius: BAR_HEIGHT / 2 },
  bar: { height: BAR_HEIGHT, flexDirection: 'row', gap: 3 },
  segment: { minWidth: 4, height: BAR_HEIGHT, borderRadius: 4 },
  rows: { marginTop: space.xs },
  row: {
    minHeight: HIT + 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
  },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: colors.text },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  metaText: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  figures: { alignItems: 'flex-end', gap: 2 },
  value: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: colors.text, fontVariant: ['tabular-nums'] },
  pl: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.textMuted, fontVariant: ['tabular-nums'] },
  empty: { alignItems: 'flex-start', gap: space.md, paddingTop: space.xs },
  emptyText: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
