import { useState } from 'react';

import { requestPaperSync } from '@/features/profile/actions';
import { formatMicros, formatShares, stamp } from '@/features/market/format';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { AppError, messageFor } from '@/realtime/errors';
import { useRealtime } from '@/realtime/hooks';
import { Button, Card, Screen, T } from '@/ui/components';
import { colors } from '@/ui/theme';

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
  const rt = useRealtime();
  const [error, setError] = useState<string | null>(null);
  const account = rt.paperAccount;

  async function refresh() {
    setError(null);
    try {
      await requestPaperSync();
    } catch (err) {
      setError(messageFor(err instanceof AppError ? err.code : 'unexpected_error'));
    }
  }

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <T variant="title" accessibilityRole="header">
        Practice
      </T>
      <T muted>Virtual money on the Alpaca paper account. Nothing here is a live trade.</T>
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
          <Button label="Refresh paper account" kind="secondary" onPress={() => void refresh()} />
        </Card>
      ) : (
        <>
          <Card>
            <T variant="heading">Cash {formatMicros(account.cashMicros)}</T>
            <T>Equity {formatMicros(account.equityMicros)}</T>
            <T variant="caption" muted>
              Alpaca buying power {formatMicros(account.buyingPowerMicros)} includes margin. Buys in Orbit are limited to cash.
            </T>
            <T variant="caption" muted>
              {account.marketOpen ? 'Market open.' : 'Market closed.'}
              {account.nextOpen ? ` Next open ${stamp(account.nextOpen)}.` : ''} Provider time {stamp(account.providerTime)}. Synced{' '}
              {stamp(account.syncedAt)}. Revision {account.revision}.
            </T>
            <Button label="Refresh paper account" kind="secondary" onPress={() => void refresh()} />
          </Card>
          <Card>
            <T variant="heading">Positions</T>
            {rt.paperPositions.length === 0 ? <T muted>No open positions on the paper account.</T> : null}
            {rt.paperPositions.map(position => (
              <T key={position.ticker}>
                {position.ticker} · {formatShares(position.quantityMicros)} shares · average {formatMicros(position.avgEntryMicros)}
                {position.unrealizedPlMicros ? ` · unrealized ${formatMicros(position.unrealizedPlMicros)}` : ''}
              </T>
            ))}
          </Card>
          <Card>
            <T variant="heading">Recent orders</T>
            {rt.paperOrders.length === 0 ? <T muted>No paper orders yet.</T> : null}
            {rt.paperOrders.map(order => (
              <T key={order.clientOrderKey}>
                {order.side} {order.ticker}
                {order.quantityMicros ? ` · ${formatShares(order.quantityMicros)} shares` : ''}
                {order.notionalMicros ? ` · ${formatMicros(order.notionalMicros)}` : ''} · {orderLine(order.status, account.marketOpen)}
                {order.rejectReason ? ` ${order.rejectReason}` : ''}
              </T>
            ))}
          </Card>
        </>
      )}
      {error ? <T color={colors.danger}>{error}</T> : null}
    </Screen>
  );
}
