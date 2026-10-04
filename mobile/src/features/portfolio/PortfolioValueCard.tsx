import * as Haptics from 'expo-haptics';
import { useEffect, useId, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, G, Line, Path, Rect } from 'react-native-svg';

import { formatMicros, money, signedPct, stamp } from '@/features/market/format';
import type { PaperAccountVM } from '@/realtime/connection';
import { DOT_RADIUS, GLOW_BLUR, GLOW_OPACITY, LINE_GAP, segments, starIndexes, type Point } from '@/ui/StockGraph';
import { colors, font, HIT, space } from '@/ui/theme';

import { GlowCard } from './GlowCard';
import type { HistoryGap, ValueHistory, ValuePoint } from './history';

const CHART_HEIGHT = 156;
const PAD_X = 14;
const PAD_TOP = 22;
const PAD_BOTTOM = 18;
/** Moves smaller than this read as unchanged, so a flat day is not coloured as a gain. */
const FLAT = 0.00005;
/** How long a tapped point stays up when no finger is down. */
const TAP_HOLD_MS = 2400;
const TOOLTIP_WIDTH = 148;
const TOOLTIP_HEIGHT = 46;
/** Space between the focused point and the tooltip beside it. */
const TOOLTIP_OFFSET = 18;

const GAP_COPY: Record<HistoryGap, string> = {
  no_fills: 'Your value line starts with your first filled trade.',
  untracked_positions: 'Some shares were traded outside Orbit, so the history can’t be rebuilt here.',
  no_closes: 'Waiting for session prices to draw the history.',
};

function shortDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function pointDate(point: ValuePoint): string {
  if (point.sessionDate == null) return 'Now';
  const [y, m, d] = point.sessionDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function toneOf(fraction: number | null): string {
  if (fraction == null || Math.abs(fraction) < FLAT) return colors.textMuted;
  return fraction > 0 ? colors.success : colors.danger;
}

function plot(values: number[], width: number): Point[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.02, 0.01);
  const lo = min - span * 0.08;
  const range = max + span * 0.08 - lo;
  const inner = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  return values.map((value, index) => ({
    x: PAD_X + (index / (values.length - 1)) * (width - PAD_X * 2),
    y: PAD_TOP + (1 - (value - lo) / range) * inner,
  }));
}

function ChangePill({ fraction }: { fraction: number }) {
  const flat = Math.abs(fraction) < FLAT;
  const up = fraction > 0;
  const tone = toneOf(fraction);
  return (
    <View style={[styles.pill, { backgroundColor: flat ? 'rgba(163, 154, 173, 0.14)' : up ? 'rgba(127, 216, 166, 0.14)' : 'rgba(255, 138, 138, 0.14)' }]}>
      {flat ? null : (
        <Svg width={8} height={8} viewBox="0 0 8 8">
          <Path d={up ? 'M4 1 L7.5 6.5 H0.5 Z' : 'M4 7 L7.5 1.5 H0.5 Z'} fill={tone} />
        </Svg>
      )}
      <Text style={[styles.pillText, { color: tone }]} maxFontSizeMultiplier={1.3}>
        {flat ? '0.00%' : signedPct(fraction).replace(/^[+−]/, '')}
      </Text>
    </View>
  );
}

function RefreshIcon() {
  return (
    <Svg width={16} height={16} viewBox="0 0 24 24">
      <Path
        d="M20 11a8 8 0 0 0-14.3-4.9L4 8 M4 4v4h4 M4 13a8 8 0 0 0 14.3 4.9L20 16 M20 20v-4h-4"
        stroke={colors.text}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}

function ValueChart({ history }: { history: ValueHistory }) {
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  /** Set when a tap (not a drag) put the tooltip up, so it can clear itself. */
  const [tap, setTap] = useState<number | null>(null);
  const glowId = `glow${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const values = history.points.map(point => point.value);
  const plotted = width > 0 ? plot(values, width) : [];
  // A high or low right beside an endpoint would draw two touching stars; the endpoint wins.
  const step = values.length > 1 ? (width - PAD_X * 2) / (values.length - 1) : 0;
  const minGap = Math.ceil((DOT_RADIUS * 2 + LINE_GAP) / Math.max(step, 1));
  const stars = starIndexes(values).filter(
    index => index === 0 || index === values.length - 1 || (index >= minGap && index <= values.length - 1 - minGap),
  );
  const starPoints = stars.map(index => plotted[index]).filter((point): point is Point => point != null);
  const pieces = segments(plotted, new Set(stars), DOT_RADIUS + LINE_GAP);
  // The change is measured from the first point, so the dashed line starts level with it.
  const baseY = plotted[0]?.y ?? null;

  useEffect(() => {
    if (tap == null) return;
    const timer = setTimeout(() => {
      setActive(null);
      setTap(null);
    }, TAP_HOLD_MS);
    return () => clearTimeout(timer);
  }, [tap]);

  function nearest(x: number): number {
    if (plotted.length < 2) return 0;
    const step = (width - PAD_X * 2) / (plotted.length - 1);
    return Math.max(0, Math.min(plotted.length - 1, Math.round((x - PAD_X) / step)));
  }

  function show(x: number) {
    const index = nearest(x);
    setActive(current => {
      if (current !== index) {
        try {
          void Haptics.selectionAsync();
        } catch {
          // Haptics are optional.
        }
      }
      return index;
    });
  }

  // Horizontal drags scrub; vertical drags fail fast so the page still scrolls.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onStart(event => {
      setTap(null);
      show(event.x);
    })
    .onUpdate(event => show(event.x))
    // onEnd, not onFinalize: a pan that never activated (the tap won) must not clear the tap's point.
    .onEnd(() => setActive(null));
  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onEnd(event => {
      show(event.x);
      setTap(count => (count ?? 0) + 1);
    });

  const high = Math.max(...values);
  const low = Math.min(...values);
  const summary = `Portfolio value since ${shortDate(history.since)}: from ${money(values[0])} to ${money(values[values.length - 1])}. High ${money(high)}, low ${money(low)}.`;
  const focus = active != null ? plotted[active] : null;
  const focusPoint = active != null ? history.points[active] : null;
  const focusChange = focusPoint && history.base > 0 ? focusPoint.value / history.base - 1 : null;
  // Beside the point, never over it: right of it unless that runs off the card.
  const tooltipLeft = focus
    ? focus.x + TOOLTIP_OFFSET + TOOLTIP_WIDTH <= width
      ? focus.x + TOOLTIP_OFFSET
      : focus.x - TOOLTIP_OFFSET - TOOLTIP_WIDTH
    : 0;
  const tooltipTop = focus ? Math.max(0, Math.min(CHART_HEIGHT - TOOLTIP_HEIGHT, focus.y - TOOLTIP_HEIGHT / 2)) : 0;

  return (
    <View accessible accessibilityRole="image" accessibilityLabel={summary}>
      <GestureHandlerRootView>
        <GestureDetector gesture={Gesture.Race(pan, tapGesture)}>
          <View
            style={styles.chart}
            onLayout={event => {
              const next = event.nativeEvent.layout.width;
              setWidth(current => (current === next ? current : next));
            }}>
            {plotted.length >= 2 ? (
              <Svg width={width} height={CHART_HEIGHT}>
                <Defs>
                  <Filter id={glowId} x={-48} y={-48} width={width + 96} height={CHART_HEIGHT + 96} filterUnits="userSpaceOnUse">
                    <FeGaussianBlur stdDeviation={GLOW_BLUR} />
                  </Filter>
                </Defs>
                {focus ? <Rect x={focus.x - 14} y={2} width={28} height={CHART_HEIGHT - 4} rx={12} fill={colors.rangeActive} opacity={0.85} /> : null}
                {baseY != null ? (
                  <Line
                    x1={4}
                    x2={width - 4}
                    y1={baseY}
                    y2={baseY}
                    stroke={colors.text}
                    strokeOpacity={0.35}
                    strokeWidth={1}
                    strokeDasharray="1.5 6"
                    strokeLinecap="round"
                  />
                ) : null}
                <G filter={`url(#${glowId})`} opacity={GLOW_OPACITY}>
                  {pieces.map(piece => (
                    <Line key={`glow-${piece.x1}-${piece.y1}`} {...piece} stroke={colors.graphLine} strokeWidth={3.2} strokeLinecap="round" />
                  ))}
                  {starPoints.map(point => (
                    <Circle key={`glow-${point.x}-${point.y}`} cx={point.x} cy={point.y} r={DOT_RADIUS + 1.4} fill={colors.graphLine} />
                  ))}
                </G>
                {pieces.map(piece => (
                  <Line key={`${piece.x1}-${piece.y1}`} {...piece} stroke={colors.graphLine} strokeWidth={1.6} strokeLinecap="butt" />
                ))}
                {starPoints.map((point, index) => (
                  <Circle
                    key={`${point.x}-${point.y}`}
                    cx={point.x}
                    cy={point.y}
                    r={DOT_RADIUS}
                    fill={index === starPoints.length - 1 ? colors.accent : colors.graphLine}
                  />
                ))}
                {focus ? (
                  <>
                    <Circle cx={focus.x} cy={focus.y} r={9} fill={colors.graphLine} opacity={0.18} />
                    <Circle cx={focus.x} cy={focus.y} r={4.5} fill={colors.graphLine} />
                  </>
                ) : null}
              </Svg>
            ) : null}
            {focus && focusPoint ? (
              <View pointerEvents="none" style={[styles.tooltip, { left: tooltipLeft, top: tooltipTop }]}>
                <Text style={styles.tooltipValue} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                  {money(focusPoint.value)}
                </Text>
                <Text style={styles.tooltipDate} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                  {focusChange != null ? (
                    <Text style={{ color: toneOf(focusChange) }}>{`${signedPct(focusChange, 1)} · `}</Text>
                  ) : null}
                  {pointDate(focusPoint)}
                </Text>
              </View>
            ) : null}
          </View>
        </GestureDetector>
      </GestureHandlerRootView>
      <View style={styles.axis}>
        <Text style={styles.axisText} maxFontSizeMultiplier={1.3}>
          {shortDate(history.since)}
        </Text>
        <Text style={styles.axisText} maxFontSizeMultiplier={1.3}>
          Now
        </Text>
      </View>
    </View>
  );
}

export function PortfolioValueCard({
  account,
  history,
  refreshing,
  onRefresh,
}: {
  account: PaperAccountVM;
  history: ValueHistory | HistoryGap;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const equity = Number(account.equityMicros) / 1_000_000;
  const drawn = typeof history === 'object' && history.points.length >= 2 ? history : null;
  const amount = drawn ? equity - drawn.base : null;
  const fraction = drawn && drawn.base > 0 ? equity / drawn.base - 1 : null;
  const tone = toneOf(fraction);
  const headline =
    amount != null && fraction != null
      ? `${money(equity)}, ${Math.abs(fraction) < FLAT ? 'unchanged' : `${fraction > 0 ? 'up' : 'down'} ${money(Math.abs(amount))}`} since ${shortDate(drawn!.since)}`
      : money(equity);

  return (
    <GlowCard>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Portfolio value
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh paper account"
          accessibilityState={{ busy: refreshing, disabled: refreshing }}
          disabled={refreshing}
          onPress={onRefresh}
          hitSlop={(HIT - 32) / 2}
          style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.6 }]}>
          {refreshing ? <ActivityIndicator size="small" color={colors.text} /> : <RefreshIcon />}
        </Pressable>
      </View>

      <View accessible accessibilityLabel={headline} style={styles.figures}>
        <View style={styles.valueRow}>
          <Text style={styles.value} maxFontSizeMultiplier={1.2} adjustsFontSizeToFit numberOfLines={1}>
            {formatMicros(account.equityMicros)}
          </Text>
          {fraction != null ? <ChangePill fraction={fraction} /> : null}
        </View>
        {amount != null && drawn ? (
          <Text style={styles.changeLine} maxFontSizeMultiplier={1.3}>
            <Text style={[styles.changeAmount, { color: tone }]}>
              {`${amount >= 0 ? '+' : '−'}${money(Math.abs(amount))}`}
            </Text>
            {` since ${shortDate(drawn.since)}`}
          </Text>
        ) : (
          <Text style={styles.changeLine} maxFontSizeMultiplier={1.3}>
            Cash {formatMicros(account.cashMicros)}
          </Text>
        )}
      </View>

      {drawn ? (
        <ValueChart history={drawn} />
      ) : (
        <View style={styles.gap}>
          <Text style={styles.gapText}>{GAP_COPY[typeof history === 'string' ? history : 'no_closes']}</Text>
        </View>
      )}

      <Text style={styles.footnote} maxFontSizeMultiplier={1.3}>
        {account.marketOpen ? 'Market open' : 'Market closed'} · Synced {stamp(account.syncedAt)}
      </Text>
    </GlowCard>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: colors.text },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.24)',
  },
  figures: { gap: 2 },
  valueRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  value: {
    flexShrink: 1,
    fontFamily: font.semibold,
    fontSize: 32,
    lineHeight: 40,
    letterSpacing: 0.5,
    color: colors.text,
    fontVariant: ['tabular-nums'],
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: 999,
  },
  pillText: { fontFamily: font.semibold, fontSize: 12, lineHeight: 16, fontVariant: ['tabular-nums'] },
  changeLine: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  changeAmount: { fontFamily: font.semibold, fontVariant: ['tabular-nums'] },
  chart: { height: CHART_HEIGHT, marginHorizontal: -space.xs },
  tooltip: {
    position: 'absolute',
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: space.sm,
    borderRadius: 12,
    backgroundColor: '#000000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.16)',
    alignItems: 'center',
  },
  tooltipValue: { fontFamily: font.semibold, fontSize: 14, lineHeight: 18, color: '#FFFFFF', fontVariant: ['tabular-nums'] },
  tooltipDate: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted, marginTop: 1 },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: space.xs, paddingHorizontal: PAD_X - space.xs },
  axisText: { fontFamily: font.medium, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  gap: {
    minHeight: 96,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.1)',
    borderStyle: 'dashed',
  },
  gapText: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted, textAlign: 'center' },
  footnote: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted },
});
