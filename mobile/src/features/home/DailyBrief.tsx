import { useMemo, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { money, signedPct } from '@/features/market/format';
import {
  BRIEF_RANGES,
  briefSeries,
  seriesReturn,
  type BriefRange,
  type ClosePoint,
  type DatedClose,
} from '@/features/market/series';
import { colors, font, space } from '@/ui/theme';

export type DailyBrief = {
  eyebrow: string;
  ticker: string;
  reasonType: string;
  range: BriefRange;
  reasonText: string;
  contextText: string;
  followUps: string[];
  copyReady: boolean;
};

export function parseBrief(body: string): DailyBrief | null {
  try {
    const data = JSON.parse(body) as {
      v?: number;
      eyebrow?: string;
      ticker?: string;
      reasonType?: string;
      range?: string;
      reasonText?: string;
      contextText?: string;
      followUps?: unknown;
      copyReady?: boolean;
    };
    if (!data || data.v !== 1 || typeof data.eyebrow !== 'string') return null;
    const range = BRIEF_RANGES.includes(data.range as BriefRange) ? (data.range as BriefRange) : '1M';
    const followUps = Array.isArray(data.followUps)
      ? data.followUps.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).slice(0, 4)
      : [];
    return {
      eyebrow: data.eyebrow,
      ticker: typeof data.ticker === 'string' ? data.ticker : '',
      reasonType: typeof data.reasonType === 'string' ? data.reasonType : 'FALLBACK',
      range,
      reasonText: typeof data.reasonText === 'string' ? data.reasonText : '',
      contextText: typeof data.contextText === 'string' ? data.contextText : '',
      followUps,
      copyReady: data.copyReady !== false,
    };
  } catch {
    return null;
  }
}

export function presentation(citations: string): { followUps: string[]; practice: string | null } {
  try {
    const parsed = JSON.parse(citations) as { id?: string; followUps?: unknown; practice?: unknown }[];
    if (!Array.isArray(parsed)) return { followUps: [], practice: null };
    const ui = parsed.find(item => item?.id === 'orbit.ui');
    const followUps = Array.isArray(ui?.followUps)
      ? ui.followUps.filter((item): item is string => typeof item === 'string').slice(0, 4)
      : [];
    const practice = typeof ui?.practice === 'string' && /^[A-Z][A-Z0-9.]{0,9}$/.test(ui.practice) ? ui.practice : null;
    return { followUps, practice };
  } catch {
    return { followUps: [], practice: null };
  }
}

export function freshnessLine(at: Date, marketOpen: boolean | null): string {
  const date = at.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const time = at.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  if (marketOpen === false) return `Latest close · ${date} · ${time} ET`;
  return `Market data through ${date} · ${time} ET`;
}

function sessionLabel(iso: string): string {
  return axisLabel(iso, false);
}

function axisLabel(iso: string, withYear: boolean): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  return new Date(Date.UTC(year, month - 1, day, 12)).toLocaleDateString('en-US', {
    month: 'short',
    day: withYear ? undefined : 'numeric',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}

function spanDays(points: DatedClose[]): number {
  const start = Date.parse(`${points[0].sessionDate}T00:00:00Z`);
  const end = Date.parse(`${points[points.length - 1].sessionDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

function moveCopy(price: number, base: number): string | null {
  if (!(base > 0) || !Number.isFinite(price)) return null;
  const amount = price - base;
  const sign = amount >= 0 ? '+' : '−';
  return `${sign}${money(Math.abs(amount))} (${signedPct(amount / base)})`;
}

export function DailyBriefCard({
  brief,
  pending,
  name,
  quote,
  closes,
  marketOpen,
  onOpen,
}: {
  brief: DailyBrief | null;
  pending: boolean;
  name: string;
  quote?: { price: number; previousClose: number; providerTime: Date } | null;
  closes?: ClosePoint[];
  marketOpen: boolean | null;
  onOpen: (ticker: string) => void;
}) {
  const ticker = brief?.ticker ?? '';
  const [picked, setPicked] = useState<{ ticker: string; range: BriefRange } | null>(null);
  const selected = picked && picked.ticker === ticker ? picked.range : (brief?.range ?? '1M');
  const available = BRIEF_RANGES.filter(item => briefSeries(item, closes, quote) !== null);
  const activeRange = available.includes(selected) ? selected : (available[0] ?? selected);
  const points = briefSeries(activeRange, closes, quote);
  const [scrub, setScrub] = useState<number | null>(null);
  const point = scrub != null && points ? points[scrub] : null;
  const price = point?.close ?? quote?.price ?? null;
  const change = point
    ? points && scrub != null && scrub > 0
      ? moveCopy(point.close, points[scrub - 1].close)
      : null
    : quote
      ? moveCopy(quote.price, quote.previousClose)
      : null;
  const up = change == null || !change.startsWith('−');
  const rangeMove = seriesReturn(points);
  const rangeUp = rangeMove == null || rangeMove >= 0;

  return (
    <View style={styles.card}>
      {pending && !ticker ? (
        <BriefSkeleton />
      ) : (
        <>
          <Text style={styles.eyebrow}>{brief?.eyebrow || 'TODAY\'S WATCH'}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open ${name || ticker}`}
            disabled={!ticker}
            onPress={() => ticker && onOpen(ticker)}>
            <Text style={styles.company} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.72}>
              {name || ticker}
            </Text>
            {ticker ? <Text style={styles.symbol}>{ticker}</Text> : null}
          </Pressable>
          {price != null ? (
            <View>
              {point ? <Text style={styles.scrubDate}>{sessionLabel(point.sessionDate)}</Text> : null}
              <Text style={styles.price}>{money(price)}</Text>
              {change ? (
                <View style={styles.changeRow}>
                  {point ? null : <Text style={styles.period}>Latest session</Text>}
                  <Text style={[styles.change, { color: up ? colors.success : colors.danger }]}>{change}</Text>
                </View>
              ) : null}
            </View>
          ) : (
            <Text style={styles.missing}>Price isn’t available for this one yet.</Text>
          )}
          <View style={styles.ranges}>
            {BRIEF_RANGES.map(item => {
              const enabled = available.includes(item);
              const on = item === activeRange && enabled;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on, disabled: !enabled }}
                  disabled={!enabled}
                  onPress={() => {
                    setScrub(null);
                    setPicked({ ticker, range: item });
                  }}
                  style={[styles.range, on && styles.rangeOn, !enabled && styles.rangeOff]}>
                  <Text style={[styles.rangeText, on && styles.rangeTextOn]}>{item}</Text>
                </Pressable>
              );
            })}
          </View>
          {rangeMove != null ? (
            <Text style={styles.rangeReturn}>
              {activeRange} performance{' '}
              <Text style={{ color: rangeUp ? colors.success : colors.danger }}>{signedPct(rangeMove)}</Text>
            </Text>
          ) : null}
          <BriefChart points={points} active={scrub} onActive={setScrub} />
          <Text style={styles.label}>Why it’s here</Text>
          {brief?.copyReady && brief.reasonText ? (
            <Text style={styles.copy}>{brief.reasonText}</Text>
          ) : (
            <View style={styles.line} />
          )}
          <Text style={styles.label}>What’s happening</Text>
          {brief?.copyReady && brief.contextText ? (
            <Text style={styles.copy}>{brief.contextText}</Text>
          ) : (
            <View style={[styles.line, styles.lineWide]} />
          )}
          {quote ? <Text style={styles.fresh}>{freshnessLine(quote.providerTime, marketOpen)}</Text> : null}
        </>
      )}
    </View>
  );
}

function BriefSkeleton() {
  return (
    <View accessibilityLabel="Loading today's watch">
      <View style={[styles.line, { width: 120 }]} />
      <View style={[styles.line, styles.lineTitle]} />
      <View style={[styles.line, { width: 88, marginTop: space.sm }]} />
      <View style={styles.chartHole} />
      <View style={[styles.line, styles.lineWide]} />
    </View>
  );
}

function BriefChart({
  points,
  active,
  onActive,
}: {
  points: DatedClose[] | null;
  active: number | null;
  onActive: (index: number | null) => void;
}) {
  const [width, setWidth] = useState(0);
  const height = 120;
  const plotted = useMemo(() => {
    if (!points || points.length < 2 || width <= 0) return null;
    const values = points.map(point => point.close);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || Math.max(Math.abs(max) * 0.02, 0.01);
    const lo = min - span * 0.08;
    const hi = max + span * 0.08;
    const padX = 8;
    const padY = 16;
    return points.map((point, index) => ({
      x: padX + (index / (points.length - 1)) * (width - padX * 2),
      y: padY + (1 - (point.close - lo) / (hi - lo)) * (height - padY * 2),
    }));
  }, [points, width]);

  const responder = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: event => choose(event.nativeEvent.locationX),
    onPanResponderMove: event => choose(event.nativeEvent.locationX),
    onPanResponderRelease: () => onActive(null),
    onPanResponderTerminate: () => onActive(null),
  });

  function choose(x: number) {
    if (!points || points.length < 2 || width <= 0) return;
    const pad = 8;
    const ratio = Math.min(1, Math.max(0, (x - pad) / Math.max(1, width - pad * 2)));
    onActive(Math.round(ratio * (points.length - 1)));
  }

  const path =
    plotted?.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ') ?? '';
  const marker = active != null && plotted ? plotted[active] : plotted ? plotted[plotted.length - 1] : null;
  const longAxis = points != null && spanDays(points) > 200;
  const startLabel = points && points.length > 1 ? axisLabel(points[0].sessionDate, longAxis) : null;
  const endLabel = points && points.length > 1 ? axisLabel(points[points.length - 1].sessionDate, longAxis) : null;

  return (
    <View
      style={styles.chart}
      onLayout={event => setWidth(event.nativeEvent.layout.width)}
      accessibilityLabel={points ? `Price history, ${points.length} sessions` : 'Price history unavailable'}
      {...(plotted ? responder.panHandlers : {})}>
      {plotted ? (
        <Svg width={width} height={height}>
          <Path d={path} stroke={colors.graphLine} strokeWidth={1.75} fill="none" />
          {marker ? (
            <>
              {active != null ? (
                <Line x1={marker.x} y1={12} x2={marker.x} y2={height - 12} stroke="rgba(255,255,255,0.35)" strokeWidth={1} />
              ) : null}
              <Circle cx={marker.x} cy={marker.y} r={3.5} fill="#FFFFFF" />
            </>
          ) : null}
        </Svg>
      ) : (
        <Text style={styles.chartEmpty}>History isn’t available for this range yet.</Text>
      )}
      {startLabel && endLabel ? (
        <View style={styles.axis}>
          <Text style={styles.axisText}>{startLabel}</Text>
          <Text style={styles.axisText}>{endLabel}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { gap: space.xs },
  eyebrow: {
    fontFamily: font.semibold,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.2,
    color: colors.textMuted,
  },
  company: { fontFamily: font.bold, fontSize: 24, lineHeight: 28, color: '#FFFFFF' },
  symbol: { fontFamily: font.medium, fontSize: 14, lineHeight: 18, color: colors.textMuted },
  scrubDate: { fontFamily: font.medium, fontSize: 13, lineHeight: 16, color: colors.textMuted, marginTop: space.xs },
  price: { fontFamily: font.bold, fontSize: 28, lineHeight: 32, color: '#FFFFFF', marginTop: 2 },
  changeRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  period: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  change: { fontFamily: font.semibold, fontSize: 16, lineHeight: 20 },
  missing: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: colors.textMuted, marginTop: space.sm },
  ranges: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  rangeReturn: { fontFamily: font.medium, fontSize: 13, lineHeight: 16, color: colors.textMuted },
  range: {
    minWidth: 40,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  rangeOn: { backgroundColor: colors.rangeActive },
  rangeOff: { opacity: 0.35 },
  rangeText: { fontFamily: font.medium, fontSize: 13, lineHeight: 16, color: colors.textMuted, textAlign: 'center' },
  rangeTextOn: { color: '#FFFFFF' },
  chart: { height: 140, justifyContent: 'center' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 2 },
  axisText: { fontFamily: font.regular, fontSize: 11, lineHeight: 14, color: colors.textSubtle },
  chartEmpty: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  chartHole: { height: 140, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.04)', marginTop: space.md },
  label: {
    fontFamily: font.semibold,
    fontSize: 13,
    lineHeight: 18,
    color: colors.textMuted,
    marginTop: space.xs,
  },
  copy: { fontFamily: font.regular, fontSize: 15, lineHeight: 20, color: colors.text },
  fresh: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textSubtle, marginTop: space.xs },
  line: { height: 14, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.08)', marginTop: space.sm },
  lineWide: { width: '92%', height: 36 },
  lineTitle: { width: 180, height: 28, marginTop: space.md },
});
