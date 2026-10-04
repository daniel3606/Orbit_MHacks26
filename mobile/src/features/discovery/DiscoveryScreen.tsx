import { LinearGradient } from 'expo-linear-gradient';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DiscoveryCard } from '@/features/discovery/DiscoveryCard';
import { DiscoverySkeleton } from '@/features/discovery/DiscoverySkeleton';
import { useLocalDay } from '@/features/discovery/local-day';
import { ZodiacHeader } from '@/features/discovery/ZodiacHeader';
import { sessionLabel } from '@/features/market/format';
import { requestDailyDiscovery } from '@/features/profile/actions';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { backgroundGradient, colors, font, HIT, radius, space } from '@/ui/theme';

const WORKING = new Set(['queued', 'running', 'retry_wait']);

/**
 * Today's Discovery. The sign picks which corner of the market to explore; the companies come
 * from market data, news, the saved profile and what this person has already seen, all chosen
 * on the server. One set per local day: reopening the tab shows the same companies, with live prices.
 */
export default function DiscoveryScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const today = useLocalDay();
  const [requestFailed, setRequestFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const askedFor = useRef<string | null>(null);
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const live = rt.status === 'ready';
  const todays = rt.discovery?.discoveryDate === today ? rt.discovery : null;
  const earlier = rt.discovery && !todays ? rt.discovery : null;
  const job = rt.jobs.find(row => row.kind === 'daily_discovery' && row.requestKey.startsWith(`discovery:${today}:`));
  const working = !!job && WORKING.has(job.status);
  const failed = !todays && !working && (requestFailed || job?.status === 'failed');

  const ask = useCallback(async () => {
    setRequestFailed(false);
    try {
      await requestDailyDiscovery(today);
    } catch (err) {
      console.warn('[discovery] request failed', err);
      setRequestFailed(true);
    }
  }, [today]);

  // Ask once per day on its own; after a failure, trying again is the person's choice.
  useEffect(() => {
    if (!live || todays || working || askedFor.current === today) return;
    askedFor.current = today;
    void ask();
  }, [live, todays, working, today, ask]);

  async function retry() {
    setRetrying(true);
    await ask();
    setRetrying(false);
  }

  const shown = todays ?? (!live ? earlier : null);
  const sign = shown?.zodiacSign ?? rt.branding?.zodiacSign ?? null;
  const stocks = rt.market.stocks;

  return (
    <View style={styles.root}>
      <LinearGradient colors={backgroundGradient} locations={[0, 0.5, 1] as const} style={StyleSheet.absoluteFill} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <ZodiacHeader sign={sign} width={width} />

        <View style={styles.body}>
          <ConnectionBanner />

          {shown ? (
            <>
              <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(420)} style={styles.theme}>
                <Text style={styles.kicker} maxFontSizeMultiplier={1.3}>
                  {todays ? 'TODAY’S THEME' : 'THEME'} · {shown.sectorName.toUpperCase()}
                </Text>
                <Text style={styles.title} accessibilityRole="header">
                  {shown.title}
                </Text>
                <Text style={styles.description}>{shown.description}</Text>
                {!todays ? (
                  <Text style={styles.note}>
                    From {sessionLabel(shown.discoveryDate)}. Today’s set arrives when you’re back online.
                  </Text>
                ) : null}
              </Animated.View>

              <Text style={styles.section} accessibilityRole="header">
                {todays ? 'Today’s Discoveries' : 'Your Last Discoveries'}
              </Text>
              {rt.discoveryItems.map((item, index) => (
                <DiscoveryCard
                  key={item.ticker}
                  item={item}
                  index={index}
                  stock={stocks.find(row => row.ticker === item.ticker)}
                  quote={rt.market.quotes[item.ticker]}
                  onOpen={() => router.push({ pathname: '/stock/[ticker]', params: { ticker: item.ticker } })}
                />
              ))}
              <Text style={styles.footnote}>
                Your sign picks which part of the market to explore. The companies come from market data, news and the
                preferences you saved, not from astrology. For learning, not a recommendation to buy or sell.
              </Text>
            </>
          ) : failed ? (
            <View style={styles.calm} accessibilityRole="alert">
              <Text style={styles.calmTitle}>Couldn’t load today’s discoveries.</Text>
              <Text style={styles.calmBody}>Try again in a moment.</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !live || retrying, busy: retrying }}
                disabled={!live || retrying}
                onPress={() => void retry()}
                style={({ pressed }) => [styles.retry, { opacity: !live || retrying ? 0.5 : pressed ? 0.85 : 1 }]}>
                <Text style={styles.retryText}>{retrying ? 'Trying…' : 'Try again'}</Text>
              </Pressable>
            </View>
          ) : !live && !rt.hasSynced ? null : !live ? (
            <View style={styles.calm}>
              <Text style={styles.calmTitle}>Today’s discoveries are waiting.</Text>
              <Text style={styles.calmBody}>They’ll appear as soon as you’re back online.</Text>
            </View>
          ) : (
            <DiscoverySkeleton />
          )}
        </View>
      </ScrollView>
      {/* Solid band behind the status bar, as in the design, so scrolled content never runs under the clock. */}
      <View pointerEvents="none" style={[styles.statusBand, { height: insets.top }]} />
      <LinearGradient
        pointerEvents="none"
        colors={[colors.background, 'rgba(5, 3, 8, 0)']}
        style={[styles.statusFade, { top: insets.top }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  scroll: { paddingBottom: space.xxxl },
  statusBand: { position: 'absolute', top: 0, left: 0, right: 0, backgroundColor: colors.background },
  statusFade: { position: 'absolute', left: 0, right: 0, height: 14 },
  body: { paddingHorizontal: space.xl, gap: space.lg },
  theme: { gap: space.sm, marginBottom: space.sm },
  kicker: {
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 1.2,
    color: colors.textSubtle,
  },
  title: { fontFamily: font.bold, fontSize: 28, lineHeight: 34, color: '#FFFFFF' },
  description: { fontFamily: font.regular, fontSize: 16, lineHeight: 23, color: colors.text },
  note: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textSubtle },
  section: { fontFamily: font.semibold, fontSize: 18, lineHeight: 24, color: '#FFFFFF', marginTop: space.xs },
  footnote: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: colors.textSubtle,
    textAlign: 'center',
    marginTop: space.sm,
    paddingHorizontal: space.sm,
  },
  calm: { alignItems: 'center', gap: space.sm, paddingVertical: space.xxl },
  calmTitle: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: colors.text, textAlign: 'center' },
  calmBody: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: colors.textMuted, textAlign: 'center' },
  retry: {
    marginTop: space.md,
    minHeight: HIT,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.secondary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryText: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: colors.secondaryText },
});
