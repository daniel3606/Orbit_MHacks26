import { Pressable, StyleSheet, Text, View } from 'react-native';

import { WatchlistRow } from '@/features/watchlist/WatchlistRows';
import type { QuoteVM, StockVM } from '@/realtime/connection';
import { colors, font, space } from '@/ui/theme';

export const WATCHLIST_PREVIEW = 3;

export function WatchlistBlock({
  tickers,
  stocks,
  quotes,
  onOpen,
  onViewAll,
}: {
  tickers: readonly string[];
  stocks: readonly StockVM[];
  quotes: Readonly<Record<string, QuoteVM>>;
  onOpen: (ticker: string) => void;
  onViewAll: () => void;
}) {
  const shown = tickers.slice(0, WATCHLIST_PREVIEW);

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          Watchlist
        </Text>
        {tickers.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View all saved stocks"
            hitSlop={8}
            onPress={onViewAll}
            style={({ pressed }) => pressed && styles.pressed}>
            <Text style={styles.viewAll}>View all</Text>
          </Pressable>
        ) : null}
      </View>
      {shown.length === 0 ? (
        <Text style={styles.empty}>Tap the star on a stock to save it here.</Text>
      ) : (
        shown.map(ticker => (
          <WatchlistRow
            key={ticker}
            ticker={ticker}
            stock={stocks.find(row => row.ticker === ticker)}
            quote={quotes[ticker]}
            onPress={() => onOpen(ticker)}
          />
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.xs, marginTop: space.sm },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.xs,
  },
  title: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, color: colors.text },
  viewAll: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: colors.info },
  pressed: { opacity: 0.6 },
  empty: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
});
