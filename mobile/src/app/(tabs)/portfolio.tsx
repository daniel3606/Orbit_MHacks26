import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { requestPaperSync } from '@/features/profile/actions';
import { formatMicros, formatShares } from '@/features/market/format';
import { valueHistory } from '@/features/portfolio/history';
import { PortfolioDistributionCard } from '@/features/portfolio/PortfolioDistributionCard';
import { PortfolioValueCard } from '@/features/portfolio/PortfolioValueCard';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { realtime } from '@/realtime/connection';
import { AppError, messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Button, Card, Screen, T } from '@/ui/components';
import { colors, font, space } from '@/ui/theme';

function orderLine(status: string, marketOpen: boolean): string {
  if (status === 'pending' || status === 'submitted') {
    return marketOpen
      ? 'Accepted by Alpaca. Still pending — not a fill.'
      : 'Accepted by Alpaca. Pending until the market opens. Not a fill.';
  }
  if (status === 'partially_filled') return 'Partly filled. The rest is still open.';
  if (status === 'filled') return 'Filled.';
  if (status === 'rejected') return 'Rejected.';
  if (status === 'canceled') return 'Canceled.';
  if (status === 'reconciling') return 'Checking with Alpaca. Not a fill.';
  if (status === 'queued' || status === 'submitting') return 'Sending. Not a fill.';
  return status;
}

/** Subscribed paper account. Figures come from Alpaca snapshots, not a local balance. */
export default function PortfolioScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const account = rt.paperAccount;
  // Session closes for the value line, and names and logos for the holdings.
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  async function refresh() {
    setError(null);
    setRefreshing(true);
    try {
      await requestPaperSync();
    } catch (err) {
      setError(messageFor(err instanceof AppError ? err.code : 'unexpected_error'));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <View style={styles.titleBlock}>
        <Text style={styles.title} accessibilityRole="header">
          Portfolio
        </Text>
        <Text style={styles.subtitle}>Virtual money on the Alpaca paper account. Nothing here is a live trade.</Text>
      </View>
      {!rt.paperEnabled ? (
        <Card>
          <T variant="heading">Paper trading is not on for this guest</T>
          <T muted>
            One designated guest is bound to the paper account. This session cannot see that balance or place an order.
          </T>
        </Card>
      ) : !account ? (
        <Card>
          <T variant="heading">Waiting for the paper account</T>
          <T muted>The balance appears after Alpaca answers. No amount is shown until then.</T>
          <Button label="Refresh paper account" kind="secondary" busy={refreshing} onPress={() => void refresh()} />
        </Card>
      ) : (
        <>
          <PortfolioValueCard
            account={account}
            history={valueHistory(account, rt.paperPositions, rt.paperOrders, rt.market.closes)}
            refreshing={refreshing}
            onRefresh={() => void refresh()}
          />
          {error ? <T color={colors.danger}>{error}</T> : null}
          <PortfolioDistributionCard
            positions={rt.paperPositions}
            cashMicros={account.cashMicros}
            stocks={rt.market.stocks}
            onOpen={ticker => router.push({ pathname: '/stock/[ticker]', params: { ticker } })}
            onDiscover={() => router.navigate('/discover')}
          />
          <Text style={styles.note}>
            Alpaca buying power {formatMicros(account.buyingPowerMicros)} includes margin. Buys in Orbit are limited to cash.
          </Text>

          <View style={styles.section}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              Recent orders
            </Text>
            {rt.paperOrders.length === 0 ? <Text style={styles.note}>No paper orders yet.</Text> : null}
            {rt.paperOrders.map(order => (
              <View key={order.clientOrderKey} style={styles.order}>
                <View style={styles.orderText}>
                  <Text style={styles.orderTitle}>
                    {order.side === 'sell' ? 'Sell' : 'Buy'} {order.ticker}
                  </Text>
                  <Text style={styles.orderStatus}>
                    {orderLine(order.status, account.marketOpen)}
                    {order.rejectReason ? ` ${order.rejectReason}` : ''}
                  </Text>
                </View>
                <Text style={styles.orderAmount}>
                  {order.notionalMicros
                    ? formatMicros(order.notionalMicros)
                    : order.quantityMicros
                      ? `${formatShares(order.quantityMicros)} sh`
                      : ''}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
      {error && !account ? <T color={colors.danger}>{error}</T> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  titleBlock: { gap: 2 },
  title: { fontFamily: font.semibold, fontSize: 24, lineHeight: 32, color: colors.text },
  subtitle: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  note: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textMuted, paddingHorizontal: space.xs },
  section: { gap: space.xs, marginTop: space.sm },
  sectionTitle: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, color: colors.text, marginBottom: space.xs },
  order: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.lg,
    paddingVertical: space.sm + 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(227, 227, 227, 0.12)',
  },
  orderText: { flex: 1, gap: 2 },
  orderTitle: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: colors.text },
  orderStatus: { fontFamily: font.regular, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  orderAmount: { fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: colors.text, fontVariant: ['tabular-nums'] },
});
