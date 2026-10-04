import { Pressable, StyleSheet, Text, View } from 'react-native';

import { money, signedPct } from '@/features/market/format';
import { StockLogo } from '@/features/market/StockLogo';
import type { QuoteVM, StockVM } from '@/realtime/connection';
import { colors, font, space } from '@/ui/theme';

const FLAT = 0.00005;

function changeOf(quote: QuoteVM | undefined): number | null {
  if (!quote || !(quote.previousClose > 0)) return null;
  return quote.price / quote.previousClose - 1;
}

export function WatchlistRow({
  ticker,
  stock,
  quote,
  onPress,
}: {
  ticker: string;
  stock: StockVM | undefined;
  quote: QuoteVM | undefined;
  onPress: () => void;
}) {
  const name = stock?.name || ticker;
  const fraction = changeOf(quote);
  const flat = fraction != null && Math.abs(fraction) < FLAT;
  const changeColor = fraction == null || flat ? colors.textMuted : fraction > 0 ? colors.success : colors.danger;
  const price = quote ? money(quote.price) : '—';
  const change = fraction == null ? '' : flat ? '0.00%' : signedPct(fraction);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${name}, ${ticker}. ${price}${change ? `, ${change}` : ''}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
      <StockLogo ticker={ticker} logoUrl={stock?.logoUrl ?? ''} size={40} />
      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={styles.ticker} numberOfLines={1}>
          {ticker}
        </Text>
      </View>
      <View style={styles.quote}>
        <Text style={styles.price}>{price}</Text>
        {change ? <Text style={[styles.change, { color: changeColor }]}>{change}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm + 2,
  },
  pressed: { opacity: 0.62 },
  identity: { flex: 1, gap: 2 },
  name: { fontFamily: font.semibold, fontSize: 16, lineHeight: 21, color: colors.text },
  ticker: { fontFamily: font.regular, fontSize: 13, lineHeight: 17, color: colors.textMuted },
  quote: { alignItems: 'flex-end', gap: 2 },
  price: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: colors.text, fontVariant: ['tabular-nums'] },
  change: { fontFamily: font.medium, fontSize: 13, lineHeight: 17, fontVariant: ['tabular-nums'] },
});
