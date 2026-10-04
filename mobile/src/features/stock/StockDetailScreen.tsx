import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { exchangeLabel, formatMicros, formatShares, money, sessionLabel, signedPct, stamp } from '@/features/market/format';
import { RANGES, rangeSeries, type Range } from '@/features/market/series';
import { labelFor, SECTORS } from '@/features/onboarding/options';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { StockGraph } from '@/ui/StockGraph';
import { backgroundGradient, colors, font, HIT, space } from '@/ui/theme';

const backIcon = require('../../../assets/icon/arrow-back.svg');
const chevronIcon = require('../../../assets/icon/chevron-down.svg');

const CHART_HEIGHT = 164;
const FOOTER_HEIGHT = 55;

function fitDetail(coverage: number, fitScore: number): string {
  const coverageText = `Coverage ${coverage.toFixed(2)} of the planned checks. Horizon and style were not scored.`;
  if (coverage <= 0.11 && fitScore >= 99) {
    return `${coverageText} The only check that ran is the sector. A sector match is not overall suitability.`;
  }
  return `${coverageText} Internal fit figure ${fitScore.toFixed(1)} for the checks that ran. Not a match percentage.`;
}

function historyLabel(source: string): string {
  if (source === 'alpaca_sip') return 'Daily history is Alpaca’s consolidated US tape (SIP), split-adjusted.';
  if (source === 'alpaca_iex') return 'Daily history is Alpaca’s IEX feed. That volume is one exchange, not the full US market.';
  if (!source) return 'The daily-history source was not recorded.';
  return `Daily history source: ${source}.`;
}

function signedMoney(amount: number): string {
  return `${amount >= 0 ? '+' : '−'}${money(Math.abs(amount))}`;
}

function percent(fraction: number, digits = 2): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}

function animateNextLayout() {
  LayoutAnimation.configureNext(LayoutAnimation.create(220, 'easeInEaseOut', 'opacity'));
}

/** One labelled line of analysis, e.g. "Risk: …". */
function Point({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Text style={styles.point}>
      <Text style={styles.pointLabel}>{label}: </Text>
      {children}
    </Text>
  );
}

/** Label on the left, figure on the right. The label gets the room; figures are short. */
function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      {typeof value === 'string' ? <Text style={styles.statValue}>{value}</Text> : value}
    </View>
  );
}

/** A section whose body opens and closes from its header. */
function Drawer({
  title,
  prominent = false,
  open,
  onToggle,
  children,
}: {
  title: string;
  prominent?: boolean;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <View style={styles.drawer}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          animateNextLayout();
          onToggle();
        }}
        style={({ pressed }) => [styles.drawerHeader, pressed && styles.pressed]}>
        <Text style={prominent ? styles.sectionTitle : styles.drawerTitle} accessibilityRole="header">
          {title}
        </Text>
        <Image
          source={chevronIcon}
          style={[styles.chevron, open && styles.chevronOpen]}
          contentFit="contain"
          accessible={false}
        />
      </Pressable>
      {open ? <View style={styles.drawerBody}>{children}</View> : null}
    </View>
  );
}

function RangeSelector({
  value,
  available,
  onChange,
}: {
  value: Range;
  available: (range: Range) => boolean;
  onChange: (range: Range) => void;
}) {
  return (
    <View style={styles.ranges} accessibilityRole="tablist">
      {RANGES.map(range => {
        const selected = range === value;
        const enabled = available(range);
        return (
          <Pressable
            key={range}
            accessibilityRole="tab"
            accessibilityLabel={range}
            accessibilityHint={enabled ? undefined : 'Not enough price history for this range yet'}
            accessibilityState={{ selected, disabled: !enabled }}
            disabled={!enabled}
            hitSlop={{ top: 10, bottom: 10 }}
            onPress={() => {
              if (selected) return;
              try {
                void Haptics.selectionAsync();
              } catch {
                // Haptics are optional.
              }
              onChange(range);
            }}
            style={[styles.range, selected && styles.rangeSelected]}>
            <Text style={[styles.rangeText, !enabled && styles.rangeDisabled]}>{range}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export default function StockDetailScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ticker } = useLocalSearchParams<{ ticker: string }>();
  const symbol = typeof ticker === 'string' ? ticker : '';
  const rt = useRealtime();
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const [range, setRange] = useState<Range>('1D');
  const [positionOpen, setPositionOpen] = useState<boolean | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [newsOpen, setNewsOpen] = useState(false);

  const stock = rt.market.stocks.find(row => row.ticker === symbol);
  const quote = rt.market.quotes[symbol];
  const signal = rt.market.signals[symbol];
  const closes = rt.market.closes[symbol];
  const match = rt.recommendations.find(row => row.ticker === symbol);
  const position = rt.paperPositions.find(row => row.ticker === symbol);
  const orders = rt.paperOrders.filter(row => row.ticker === symbol).slice(0, 3);

  const series = rangeSeries(range, closes, quote);
  const available = (candidate: Range) => rangeSeries(candidate, closes, quote) !== null;
  // Closed by default when there is nothing held; the person's own toggle wins after that.
  const showPosition = positionOpen ?? !!position;

  const dayChange = quote && quote.previousClose > 0 ? quote.price - quote.previousClose : null;
  const sessionCloses = (closes ?? []).map(point => point.close);
  const high = sessionCloses.length > 0 ? Math.max(...sessionCloses) : null;
  const low = sessionCloses.length > 0 ? Math.min(...sessionCloses) : null;

  const title = stock?.name ? `${stock.name} (${symbol})` : symbol || 'Stock';
  const pl = position?.unrealizedPlMicros ?? null;
  const plColor = pl == null ? colors.text : pl.startsWith('-') ? colors.danger : colors.success;

  function trade(side: 'buy' | 'sell') {
    router.push({ pathname: '/trade', params: { ticker: symbol, side } });
  }

  return (
    <View style={styles.root}>
      <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={StyleSheet.absoluteFill} />
      <SafeAreaView style={styles.fill} edges={['top']}>
        <View style={styles.nav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            hitSlop={8}
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}>
            <Image source={backIcon} style={styles.backIcon} contentFit="contain" accessible={false} />
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: FOOTER_HEIGHT + space.xxl + insets.bottom }]}
          showsVerticalScrollIndicator={false}>
          <ConnectionBanner />
          <View style={styles.titleBlock}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>
              {title}
            </Text>
            {stock ? (
              <Text style={styles.subtitle} numberOfLines={1}>
                {[stock.exchange ? exchangeLabel(stock.exchange) : null, stock.sector ? labelFor(SECTORS, stock.sector) : null].filter(Boolean).join(' · ')}
              </Text>
            ) : null}
          </View>

          <StockGraph
            hero
            height={CHART_HEIGHT}
            price={quote?.price ?? null}
            previousClose={series?.base ?? quote?.previousClose}
            points={series?.points}
            changeLabel={series?.label}
            baseline={series?.base}
          />

          <RangeSelector value={range} available={available} onChange={setRange} />

          <Text style={styles.source}>
            {quote
              ? `${quote.source === 'finnhub' ? 'Finnhub' : quote.source} · ${stamp(quote.providerTime)}`
              : 'No quote has been published for this ticker.'}
          </Text>

          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              Orbit Analysis
            </Text>
            {match ? (
              <>
                <Point label="Why it matched">{match.matchReason}</Point>
                <Point label="Recent activity">{match.marketActivity}</Point>
                <Point label="Risk">{match.riskObservation}</Point>
                {match.learningNote ? <Text style={styles.note}>{match.learningNote}</Text> : null}
              </>
            ) : (
              <Text style={styles.point}>
                {symbol} isn’t one of the matches saved for your profile, so Orbit has no reason to give for it.
                {signal?.status === 'published' && signal.trendScore !== null
                  ? ` Its Trend Score is ${signal.trendScore.toFixed(1)} through ${sessionLabel(signal.sessionDate)}.`
                  : ''}
              </Text>
            )}
          </View>

          <View style={styles.drawers}>
            <Drawer title="Your Position" prominent open={showPosition} onToggle={() => setPositionOpen(!showPosition)}>
              {!rt.paperEnabled ? (
                <Text style={styles.point}>Practice trading isn’t turned on for this account.</Text>
              ) : position ? (
                <View>
                  <Stat label="Shares" value={formatShares(position.quantityMicros)} />
                  <Stat label="Average cost" value={formatMicros(position.avgEntryMicros)} />
                  <Stat label="Market value" value={position.marketValueMicros ? formatMicros(position.marketValueMicros) : '—'} />
                  <Stat
                    label="Unrealized return"
                    value={
                      <Text style={[styles.statValue, { color: plColor }]}>
                        {pl ? `${pl.startsWith('-') ? '' : '+'}${formatMicros(pl)}` : '—'}
                      </Text>
                    }
                  />
                </View>
              ) : (
                <Text style={styles.point}>You don’t hold {symbol} in your practice account.</Text>
              )}
              {orders.length > 0 ? (
                <View style={styles.orders}>
                  <Text style={styles.subheading}>Recent orders</Text>
                  {orders.map(order => (
                    <Stat
                      key={order.clientOrderKey}
                      label={`${order.side === 'buy' ? 'Buy' : 'Sell'} · ${
                        order.quantityMicros ? `${formatShares(order.quantityMicros)} sh` : formatMicros(order.notionalMicros ?? '0')
                      }`}
                      value={order.status.replace(/_/g, ' ')}
                    />
                  ))}
                </View>
              ) : null}
            </Drawer>

            <Drawer title="Statistics" open={statsOpen} onToggle={() => setStatsOpen(open => !open)}>
              <View>
                <Stat label="Previous close" value={quote ? money(quote.previousClose) : '—'} />
                <Stat
                  label="Day change"
                  value={
                    dayChange != null && quote ? (
                      <Text style={[styles.statValue, { color: dayChange >= 0 ? colors.success : colors.danger }]}>
                        {signedMoney(dayChange)} ({signedPct(quote.price / quote.previousClose - 1)})
                      </Text>
                    ) : (
                      '—'
                    )
                  }
                />
                <Stat label={`${sessionCloses.length}-session high`} value={high != null ? money(high) : '—'} />
                <Stat label={`${sessionCloses.length}-session low`} value={low != null ? money(low) : '—'} />
                <Stat
                  label="Trend Score"
                  value={signal?.status === 'published' && signal.trendScore !== null ? signal.trendScore.toFixed(1) : 'Not published'}
                />
                <Stat
                  label="Daily volatility (20 sessions)"
                  value={match?.realizedVol != null ? percent(match.realizedVol) : '—'}
                />
                <Stat
                  label={`Largest drop (${match?.drawdownSessions || 60} sessions)`}
                  value={match?.maxDrawdown != null ? percent(match.maxDrawdown, 1) : '—'}
                />
              </View>
              <Text style={styles.note}>{historyLabel(match?.historySource ?? '')} Quotes are separate from daily bars.</Text>
            </Drawer>

            <Drawer title="About" open={aboutOpen} onToggle={() => setAboutOpen(open => !open)}>
              <View>
                <Stat label="Company" value={stock?.name || '—'} />
                <Stat label="Exchange" value={stock?.exchange ? exchangeLabel(stock.exchange) : '—'} />
                <Stat label="Sector" value={stock?.sector ? labelFor(SECTORS, stock.sector) : '—'} />
                <Stat label="Industry" value={stock?.industry || '—'} />
                <Stat label="Compared with" value={stock?.benchmark || '—'} />
              </View>
              <Text style={styles.subheading}>How the scores work</Text>
              <Text style={styles.note}>
                Trend Score compares recent price and volume with a benchmark. It is not a chance of making money. Fit uses
                only the checks Orbit can support: the risk limit you set and whether the sector is one you chose.
              </Text>
              {match ? (
                <>
                  <Text style={styles.note}>{fitDetail(match.fitCoverage, match.fitScore)}</Text>
                  {match.limitations.map(line => (
                    <Text key={line} style={styles.note}>
                      {line}
                    </Text>
                  ))}
                </>
              ) : null}
            </Drawer>

            <Drawer title="News" open={newsOpen} onToggle={() => setNewsOpen(open => !open)}>
              <Text style={styles.point}>News isn’t connected yet, so there are no headlines for {symbol}.</Text>
            </Drawer>

          </View>

          <Text style={styles.disclaimer}>For learning. Not a recommendation to buy or sell.</Text>
        </ScrollView>
      </SafeAreaView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, space.lg) }]} pointerEvents="box-none">
        <LinearGradient
          colors={['rgba(21, 14, 34, 0)', colors.backgroundEnd]}
          locations={[0, 0.45]}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Sell ${symbol}`}
          accessibilityHint={position ? undefined : `You don’t hold ${symbol}`}
          accessibilityState={{ disabled: !position }}
          disabled={!position}
          onPress={() => trade('sell')}
          style={({ pressed }) => [styles.action, styles.sell, !position && styles.disabled, pressed && styles.pressed]}>
          <Text style={[styles.actionText, styles.sellText]}>Sell</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Buy ${symbol}`}
          onPress={() => trade('buy')}
          style={({ pressed }) => [styles.action, styles.buy, pressed && styles.pressed]}>
          <Text style={[styles.actionText, styles.buyText]}>Buy</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  fill: { flex: 1 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.45 },
  nav: {
    height: HIT + space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.md,
  },
  navButton: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  backIcon: { width: 35, height: 35 },
  scroll: { paddingHorizontal: space.xl, paddingTop: space.xs, gap: space.lg },
  titleBlock: { gap: 2 },
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 32, color: colors.text },
  subtitle: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  ranges: { flexDirection: 'row', alignItems: 'center', marginTop: -space.xs },
  range: {
    minWidth: 39,
    height: 24,
    borderRadius: 6,
    paddingHorizontal: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rangeSelected: { backgroundColor: colors.rangeActive },
  rangeText: { fontFamily: font.medium, fontSize: 14, lineHeight: 18, color: colors.text },
  rangeDisabled: { color: colors.textMuted, opacity: 0.45 },
  source: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted, marginTop: -space.sm },
  section: { gap: space.sm, marginTop: space.sm },
  sectionTitle: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, color: colors.text },
  drawers: { gap: 2 },
  drawer: { gap: space.xs },
  drawerHeader: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  drawerTitle: { fontFamily: font.semibold, fontSize: 16, lineHeight: 22, color: colors.text },
  drawerBody: { gap: space.sm, paddingBottom: space.sm },
  chevron: { width: 24, height: 24 },
  chevronOpen: { transform: [{ scaleY: -1 }] },
  point: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.text },
  pointLabel: { fontFamily: font.semibold },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  subheading: { fontFamily: font.semibold, fontSize: 14, lineHeight: 20, color: colors.text, marginTop: space.xs },
  orders: { gap: 0 },
  stat: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: space.lg,
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(227, 227, 227, 0.12)',
  },
  statLabel: { flex: 1, fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  statValue: {
    fontFamily: font.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.text,
    textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },
  disclaimer: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 16,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: space.md,
  },
  footer: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    gap: 18,
    paddingHorizontal: space.xl,
    paddingTop: space.xxl,
  },
  action: {
    flex: 1,
    height: FOOTER_HEIGHT,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sell: { backgroundColor: colors.secondary },
  buy: { backgroundColor: colors.text },
  actionText: { fontFamily: font.semibold, fontSize: 20, lineHeight: 26 },
  sellText: { color: colors.secondaryText },
  buyText: { color: colors.background },
});
