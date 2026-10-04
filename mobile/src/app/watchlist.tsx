import { Image } from 'expo-image';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { WatchlistRow } from '@/features/watchlist/WatchlistRows';
import { useWatchlist } from '@/features/watchlist/store';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Screen } from '@/ui/components';
import { colors, font, HIT, space } from '@/ui/theme';

const backIcon = require('../../assets/icon/arrow-back.svg');

export default function WatchlistScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const tickers = useWatchlist(state => state.tickers);
  const load = useWatchlist(state => state.load);

  useEffect(() => {
    void load();
  }, [load]);

  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  function open(ticker: string) {
    router.push({ pathname: '/stock/[ticker]', params: { ticker } });
  }

  return (
    <Screen
      edges={['top']}
      header={
        <View style={styles.nav}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={() => router.back()}
            hitSlop={8}
            style={({ pressed }) => [styles.navButton, pressed && styles.pressed]}>
            <Image source={backIcon} style={styles.backIcon} contentFit="contain" accessible={false} />
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">
            Watchlist
          </Text>
          <View style={styles.navButton} />
        </View>
      }>
      <ConnectionBanner />
      {tickers.length === 0 ? (
        <Text style={styles.empty}>Tap the star on a stock to save it here.</Text>
      ) : (
        tickers.map(ticker => (
          <WatchlistRow
            key={ticker}
            ticker={ticker}
            stock={rt.market.stocks.find(row => row.ticker === ticker)}
            quote={rt.market.quotes[ticker]}
            onPress={() => open(ticker)}
          />
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  nav: {
    minHeight: HIT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: -space.sm,
  },
  navButton: { width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' },
  backIcon: { width: 35, height: 35 },
  pressed: { opacity: 0.7 },
  title: { fontFamily: font.semibold, fontSize: 17, lineHeight: 22, color: colors.text },
  empty: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
