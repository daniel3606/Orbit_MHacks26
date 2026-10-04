import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useEffect, useId, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Circle, Defs, FeGaussianBlur, Filter, G, Line } from 'react-native-svg';

import { money, sessionLabel, signedPct } from '@/features/market/format';
import { T } from '@/ui/components';
import { colors, font, graphFillOpacity, radius, space } from '@/ui/theme';

const CHART_HEIGHT = 148;

export type Point = { x: number; y: number };

function changeCopy(amount: number, fraction: number): string {
  const sign = amount >= 0 ? '+' : '−';
  const pct = Math.abs(fraction * 100).toFixed(2);
  return `${sign}${money(Math.abs(amount))} (${pct}%)`;
}

function plainNumber(value: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** `+12.55 (+0.36%)` — no currency symbol, sign on both figures. */
function plainChange(amount: number, fraction: number): string {
  const sign = amount >= 0 ? '+' : '−';
  const pct = Math.abs(fraction * 100).toFixed(2);
  return `${sign}${plainNumber(Math.abs(amount))} (${sign}${pct}%)`;
}

function plot(
  values: number[],
  width: number,
  height: number,
  compact: boolean,
): { points: Point[]; yOf: (value: number) => number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(Math.abs(max) * 0.02, 0.01);
  const lo = min - span * 0.12;
  const hi = max + span * 0.12;
  const range = hi - lo;
  // Room for the star glow to fade before the rounded card edge.
  const padX = compact ? 28 : 24;
  const padY = compact ? 32 : 28;
  const yOf = (value: number) => padY + (1 - (value - lo) / range) * (height - padY * 2);
  const points = values.map((value, index) => ({
    x: padX + (values.length === 1 ? (width - padX * 2) / 2 : (index / (values.length - 1)) * (width - padX * 2)),
    y: yOf(value),
  }));
  return { points, yOf };
}

/** Solid star radius. Segments stop just outside each star. */
export const DOT_RADIUS = 4;
export const LINE_GAP = 6;
/** Soft bloom under the constellation. Stronger than the earlier 45% line glow. */
export const GLOW_OPACITY = 0.8;
export const GLOW_BLUR = 8;

type Segment = { x1: number; y1: number; x2: number; y2: number };

/** Above this many closes, local turns are too dense to read as stars. */
const DENSE_SERIES = 12;

/** Endpoints, plus any close that is a local high or low. Long series keep only the endpoints and the range extremes. */
export function starIndexes(values: number[]): number[] {
  if (values.length > DENSE_SERIES) {
    const high = values.indexOf(Math.max(...values));
    const low = values.indexOf(Math.min(...values));
    return [...new Set([0, high, low, values.length - 1])].sort((a, b) => a - b);
  }
  const stars: number[] = [];
  values.forEach((value, index) => {
    if (index === 0 || index === values.length - 1) {
      stars.push(index);
      return;
    }
    const previous = values[index - 1];
    const next = values[index + 1];
    if ((value > previous && value > next) || (value < previous && value < next)) stars.push(index);
  });
  return stars;
}

/** Break the path just short of each star so the dots read as a constellation. */
export function segments(points: Point[], stars: Set<number>, inset: number): Segment[] {
  const drawn: Segment[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);
    const startInset = stars.has(index) ? inset : 0;
    const endInset = stars.has(index + 1) ? inset : 0;
    if (length <= startInset + endInset) continue;
    const ux = dx / length;
    const uy = dy / length;
    drawn.push({
      x1: start.x + ux * startInset,
      y1: start.y + uy * startInset,
      x2: end.x - ux * endInset,
      y2: end.y - uy * endInset,
    });
  }
  return drawn;
}

function scrubCaption(date: string | null, index: number, count: number): string {
  if (date) return sessionLabel(date);
  if (count === 2 && index === 0) return 'Previous close';
  if (index === count - 1) return 'Latest price';
  return 'Earlier close';
}

function nearestIndex(points: Point[], x: number): number {
  let best = 0;
  let bestDist = Infinity;
  points.forEach((point, index) => {
    const dist = Math.abs(point.x - x);
    if (dist < bestDist) {
      best = index;
      bestDist = dist;
    }
  });
  return best;
}

export function StockGraph({
  title,
  price,
  previousClose,
  points,
  dates,
  compact = false,
  plain = false,
  hero = false,
  scrub = false,
  height,
  baseline: reference,
  onScrubbingChange,
  onInspect,
}: {
  title?: string;
  price: number | null;
  previousClose?: number | null;
  /** Real prices, oldest first. Drawn only when at least two values are present. */
  points?: number[];
  /** Session date aligned with `points`. Null is the live print. */
  dates?: (string | null)[];
  /** Title and a shorter chart, without the price line. */
  compact?: boolean;
  /** Price as `7701.61 +12.55 (+0.36%)` instead of currency. */
  plain?: boolean;
  /** Larger price, for the top of a stock's own screen. */
  hero?: boolean;
  /** Drag across the chart to read the price at that point. */
  scrub?: boolean;
  /** Chart height in points. */
  height?: number;
  /** Price for the dashed reference line. Defaults to the average of the drawn prices. */
  baseline?: number | null;
  /** True while a finger is on the chart. */
  onScrubbingChange?: (active: boolean) => void;
  /** The chart point under the finger, or null when the finger lifts. */
  onInspect?: (point: { price: number; date: string | null } | null) => void;
}) {
  const [width, setWidth] = useState(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const track = useRef<ScrollView>(null);
  const chartNode = useRef<View>(null);
  const scrubbing = useRef(false);
  const lockedScroll = useRef(false);
  const chartX = useRef(0);
  const anchorPageX = useRef(0);
  const anchorOffset = useRef(0);
  const labelId = useId();
  const paired = (points ?? [])
    .map((value, index) => ({ value, date: dates?.[index] ?? null }))
    .filter(point => Number.isFinite(point.value));
  const series = paired.map(point => point.value);
  const shownIndex = scrub && scrubIndex != null && scrubIndex < series.length ? scrubIndex : null;
  const shownPrice = shownIndex != null ? series[shownIndex] : price;
  const amount = shownPrice != null && previousClose != null ? shownPrice - previousClose : null;
  const fraction =
    shownPrice != null && previousClose != null && previousClose > 0 ? shownPrice / previousClose - 1 : null;
  const positive = (fraction ?? 0) >= 0;
  const changeColor = fraction == null ? colors.textMuted : positive ? colors.success : colors.danger;
  const chartHeight = height ?? (compact ? 118 : CHART_HEIGHT);
  const chart = width > 0 && series.length >= 2 ? plot(series, width, chartHeight, compact) : null;
  const plotted = chart?.points ?? [];
  const mean = series.length >= 2 ? series.reduce((sum, value) => sum + value, 0) / series.length : null;
  const baselineValue = reference ?? mean;
  const baseline = chart && baselineValue != null ? chart.yOf(baselineValue) : null;
  const cursor = shownIndex != null ? plotted[shownIndex] : null;
  const moment = shownIndex != null ? scrubCaption(paired[shownIndex]?.date ?? null, shownIndex, series.length) : null;
  const inspectedPrice = shownIndex != null ? series[shownIndex] : null;
  const inspectedDate = shownIndex != null ? paired[shownIndex]?.date ?? null : null;

  useEffect(() => {
    if (!onInspect) return;
    onInspect(inspectedPrice == null ? null : { price: inspectedPrice, date: inspectedDate });
  }, [onInspect, inspectedPrice, inspectedDate]);

  const summary =
    shownPrice == null
      ? 'Price unavailable'
      : fraction == null || amount == null
        ? money(shownPrice)
        : moment
          ? `${money(shownPrice)} on ${moment}, ${signedPct(fraction)} from the start of this chart`
          : scrub
            ? `${money(shownPrice)}, ${signedPct(fraction)} from the start of this chart`
            : `${money(shownPrice)}, ${signedPct(fraction)} versus previous close`;

  useEffect(() => {
    if (scrubIndex == null) return;
    const step = series.length > 40 ? Math.ceil(series.length / 24) : 1;
    if (scrubIndex % step !== 0 && scrubIndex !== series.length - 1) return;
    try {
      void Haptics.selectionAsync();
    } catch {
      // Haptics are optional.
    }
  }, [scrubIndex, series.length]);

  function park() {
    if (width > 0) track.current?.scrollTo({ x: width, animated: false });
  }

  function choose(x: number) {
    if (plotted.length < 2) return;
    const index = nearestIndex(plotted, Math.max(0, Math.min(width, x)));
    setScrubIndex(current => (current === index ? current : index));
  }

  function endScrub() {
    const wasScrubbing = scrubbing.current;
    scrubbing.current = false;
    if (wasScrubbing) setScrubIndex(null);
    if (lockedScroll.current) {
      lockedScroll.current = false;
      onScrubbingChange?.(false);
    }
    park();
  }

  function beginScrub(pageX: number) {
    scrubbing.current = true;
    anchorPageX.current = pageX;
    anchorOffset.current = width;
    choose(pageX - chartX.current);
  }

  function follow(offsetX: number) {
    if (!scrubbing.current || width <= 0) return;
    if (!lockedScroll.current) {
      lockedScroll.current = true;
      onScrubbingChange?.(true);
    }
    choose(anchorPageX.current - chartX.current - (offsetX - anchorOffset.current));
  }

  const stars = starIndexes(series);
  const starSet = new Set(stars);
  const pieces = segments(plotted, starSet, DOT_RADIUS + LINE_GAP);
  const glowId = `glow${labelId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const starPoints = stars.map(index => plotted[index]).filter((point): point is Point => point != null);

  return (
    <View style={styles.shadow}>
    <View style={styles.card}>
        <LinearGradient
          colors={[
            `rgba(0, 0, 0, ${graphFillOpacity})`,
            `rgba(31, 4, 87, ${graphFillOpacity})`,
          ]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.body, compact && styles.bodyCompact, hero && styles.bodyHero]}>
          {hero ? null : title ? (
            <View style={styles.splitRow} accessibilityRole="text" accessibilityLabel={title ? `${title}. ${summary}` : summary} nativeID={labelId}>
              <T variant="label" style={styles.cardTitle}>
                {title}
              </T>
              {!compact && price != null && amount != null && fraction != null ? (
                <T variant="label" style={styles.plainQuote}>
                  {plainNumber(price)}{' '}
                  <T variant="label" color={changeColor} style={styles.plainChange}>
                    {plainChange(amount, fraction)}
                  </T>
                </T>
              ) : null}
            </View>
          ) : (
            <View style={styles.quoteBlock} accessibilityRole="text" accessibilityLabel={summary} nativeID={labelId}>
              <View style={styles.priceRow}>
                <T
                  variant="display"
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.7}
                  style={styles.price}>
                  {shownPrice == null ? '—' : money(shownPrice)}
                </T>
                {amount != null && fraction != null ? (
                  <T variant="label" color={changeColor} style={styles.change}>
                    {plain ? plainChange(amount, fraction) : changeCopy(amount, fraction)}
                  </T>
                ) : null}
              </View>
              {moment ? (
                <T variant="caption" muted>
                  {moment}
                </T>
              ) : null}
            </View>
          )}

          <View
            ref={chartNode}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onLayout={event => {
              const next = event.nativeEvent.layout.width;
              setWidth(current => (current === next ? current : next));
              chartNode.current?.measureInWindow(x => {
                chartX.current = x;
              });
            }}>
            {plotted.length >= 2 ? (
              <Svg width={width} height={chartHeight}>
                <Defs>
                  <Filter
                    id={glowId}
                    x={-48}
                    y={-48}
                    width={width + 96}
                    height={chartHeight + 96}
                    filterUnits="userSpaceOnUse">
                    <FeGaussianBlur stdDeviation={GLOW_BLUR} />
                  </Filter>
                </Defs>
                {baseline != null ? (
                  <Line
                    x1={10}
                    x2={width - 10}
                    y1={baseline}
                    y2={baseline}
                    stroke={colors.text}
                    strokeOpacity={0.35}
                    strokeWidth={1}
                    strokeDasharray="1.5 6"
                    strokeLinecap="round"
                  />
                ) : null}
                {cursor ? (
                  <Line
                    x1={cursor.x}
                    x2={cursor.x}
                    y1={8}
                    y2={chartHeight - 8}
                    stroke={colors.accent}
                    strokeOpacity={0.85}
                    strokeWidth={1}
                  />
                ) : null}
                <G filter={`url(#${glowId})`} opacity={GLOW_OPACITY}>
                  {pieces.map(piece => (
                    <Line
                      key={`glow-${piece.x1}-${piece.y1}`}
                      x1={piece.x1}
                      y1={piece.y1}
                      x2={piece.x2}
                      y2={piece.y2}
                      stroke={colors.graphLine}
                      strokeWidth={3.2}
                      strokeLinecap="round"
                    />
                  ))}
                  {starPoints.map(point => (
                    <Circle key={`glow-${point.x}-${point.y}`} cx={point.x} cy={point.y} r={DOT_RADIUS + 1.4} fill={colors.graphLine} />
                  ))}
                </G>
                {pieces.map(piece => (
                  <Line
                    key={`${piece.x1}-${piece.y1}`}
                    x1={piece.x1}
                    y1={piece.y1}
                    x2={piece.x2}
                    y2={piece.y2}
                    stroke={colors.graphLine}
                    strokeWidth={1.6}
                    strokeLinecap="butt"
                  />
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
                {cursor ? <Circle cx={cursor.x} cy={cursor.y} r={DOT_RADIUS + 2} fill={colors.accent} /> : null}
              </Svg>
            ) : (
              <View style={{ height: space.sm }} />
            )}
            {/* Wider than the chart so a sideways drag stays on this scroller.
                On iOS that keeps the full-screen back swipe from popping the page. */}
            {scrub && width > 0 ? (
              <ScrollView
                ref={track}
                horizontal
                bounces={false}
                directionalLockEnabled
                nestedScrollEnabled
                overScrollMode="never"
                scrollEventThrottle={16}
                showsHorizontalScrollIndicator={false}
                style={styles.scrubber}
                contentContainerStyle={{ width: width * 3, height: chartHeight }}
                onLayout={park}
                onTouchStart={event => {
                  chartNode.current?.measureInWindow(x => {
                    chartX.current = x;
                  });
                  beginScrub(event.nativeEvent.pageX);
                }}
                onScroll={event => follow(event.nativeEvent.contentOffset.x)}
                onTouchEnd={endScrub}
                onScrollEndDrag={endScrub}
                onMomentumScrollEnd={endScrub}
              >
                <View style={{ width: width * 3, height: chartHeight }} />
              </ScrollView>
            ) : null}
          </View>
        </View>
    </View>
    </View>
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
    backgroundColor: 'transparent',
  },
  body: {
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    paddingBottom: space.md,
    gap: space.sm,
  },
  bodyCompact: {
    paddingTop: space.md,
    paddingHorizontal: space.md,
    paddingBottom: space.sm,
  },
  bodyHero: {
    paddingTop: space.sm,
    paddingHorizontal: space.md,
    paddingBottom: space.xs,
    gap: 0,
  },
  splitRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  cardTitle: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
    flexShrink: 1,
  },
  plainQuote: {
    fontFamily: font.semibold,
    fontSize: 14,
    lineHeight: 18,
    textAlign: 'right',
  },
  plainChange: {
    fontFamily: font.semibold,
    fontSize: 12,
    lineHeight: 16,
  },
  scrubber: { ...StyleSheet.absoluteFill },
  quoteBlock: { gap: 2 },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  price: {
    fontFamily: font.bold,
    fontSize: 28,
    lineHeight: 34,
  },
  change: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 20,
  },
});
