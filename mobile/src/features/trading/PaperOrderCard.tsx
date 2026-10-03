import { useState } from 'react';
import { TextInput, View } from 'react-native';

import { createPaperOrder } from '@/features/profile/actions';
import { formatMicros, formatShares, parseDecimalMicros, stamp } from '@/features/market/format';
import { AppError, messageFor } from '@/realtime/errors';
import type { PaperOrderVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Button, Card, T } from '@/ui/components';
import { colors, radius, space } from '@/ui/theme';

function clientKey(): string {
  // Hermes on a device has no global crypto. This id only has to be unique.
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(12);
  const random = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (random) random(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = 'orbit-';
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return out;
}

function statusCopy(order: PaperOrderVM, marketOpen: boolean | null): string {
  if (order.status === 'queued' || order.status === 'submitting') return 'Sending to the paper account. This is not a fill.';
  if (order.status === 'submitted' || order.status === 'pending') {
    return marketOpen === false
      ? 'Alpaca accepted this order and it is still pending. The market is closed, so it can stay unfilled until the next open. It is not a fill.'
      : 'Alpaca accepted this order and it is still pending. It is not a fill.';
  }
  if (order.status === 'partially_filled') {
    return `${formatShares(order.filledQuantityMicros)} shares have filled. The rest is still open.`;
  }
  if (order.status === 'filled') return 'Filled on the paper account.';
  if (order.status === 'rejected') return order.rejectReason ? `Rejected (${order.rejectReason}). Nothing was bought or sold.` : 'Rejected. Nothing was bought or sold.';
  if (order.status === 'canceled') return 'Canceled.';
  if (order.status === 'reconciling') return 'Checking this order with Alpaca before anything else is sent. Not a fill.';
  return order.status;
}

/** Review and explicit confirmation. No order exists until Confirm is pressed. */
export function PaperOrderCard({ ticker, quoteMicros, quoteTime }: { ticker: string; quoteMicros: string | null; quoteTime: Date | null }) {
  const rt = useRealtime();
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [mode, setMode] = useState<'shares' | 'dollars'>('shares');
  const [amount, setAmount] = useState('1');
  const [reviewing, setReviewing] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!rt.paperEnabled) {
    return (
      <Card>
        <T variant="heading">Paper order</T>
        <T muted>Paper trading is turned on for one designated guest. This session is not that guest, so no order can be sent.</T>
      </Card>
    );
  }

  const existing = key ? rt.paperOrders.find(row => row.clientOrderKey === key) : undefined;
  const parsed = parseDecimalMicros(amount);
  const marketOpen = rt.paperAccount?.marketOpen ?? null;

  async function confirm() {
    if (!quoteMicros || !quoteTime || !parsed || !key) return;
    setBusy(true);
    setError(null);
    try {
      await createPaperOrder({
        ticker,
        side,
        quantityMicros: mode === 'shares' ? parsed : undefined,
        notionalMicros: mode === 'dollars' ? parsed : undefined,
        clientOrderKey: key,
        quoteMicros: BigInt(quoteMicros),
        quoteTime,
      });
    } catch (err) {
      setError(messageFor(err instanceof AppError ? err.code : 'unexpected_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <T variant="heading">Paper order</T>
      <T>Virtual money only. This uses the Alpaca paper account, not a live brokerage account.</T>
      {existing ? (
        <>
          <T>
            {existing.side === 'buy' ? 'Buy' : 'Sell'} {existing.ticker}
            {existing.quantityMicros ? ` · ${formatShares(existing.quantityMicros)} shares` : ''}
            {existing.notionalMicros ? ` · ${formatMicros(existing.notionalMicros)}` : ''}
          </T>
          <T muted>Quote used at review: {formatMicros(existing.quoteMicros)} at {stamp(existing.quoteTime)}.</T>
          <T>{statusCopy(existing, marketOpen)}</T>
        </>
      ) : (
        <>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label="Buy" kind={side === 'buy' ? 'primary' : 'secondary'} onPress={() => { setSide('buy'); setReviewing(false); }} />
            <Button label="Sell" kind={side === 'sell' ? 'primary' : 'secondary'} onPress={() => { setSide('sell'); setReviewing(false); }} />
          </View>
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <Button label="Shares" kind={mode === 'shares' ? 'primary' : 'secondary'} onPress={() => { setMode('shares'); setReviewing(false); }} />
            <Button label="Dollars" kind={mode === 'dollars' ? 'primary' : 'secondary'} onPress={() => { setMode('dollars'); setReviewing(false); }} />
          </View>
          <TextInput
            accessibilityLabel={mode === 'shares' ? 'Share quantity' : 'Dollar amount'}
            value={amount}
            onChangeText={value => { setAmount(value); setReviewing(false); }}
            keyboardType="decimal-pad"
            style={{
              color: colors.text,
              borderColor: colors.border,
              borderWidth: 1,
              borderRadius: radius.sm,
              padding: space.md,
            }}
          />
          {reviewing && parsed && quoteMicros && quoteTime && key ? (
            <>
              <T>
                {side === 'buy' ? 'Buy' : 'Sell'} {ticker} · {mode === 'shares' ? `${formatShares(parsed.toString())} shares` : formatMicros(parsed.toString())}
              </T>
              <T muted>Indicative quote {formatMicros(quoteMicros)} at {stamp(quoteTime)}. The fill price can differ.</T>
              <T muted>
                {marketOpen === false && rt.paperAccount?.nextOpen
                  ? `The market is closed. A confirmed order stays pending until ${stamp(rt.paperAccount.nextOpen)}. It will not be marked filled here.`
                  : 'Confirming sends the order to Alpaca. An accepted order is not a fill.'}
              </T>
              <Button label="Confirm paper order" onPress={() => void confirm()} busy={busy} disabled={!rt.hasSynced || rt.stale} />
            </>
          ) : (
            <Button
              label="Review order"
              kind="secondary"
              disabled={!parsed || !quoteMicros}
              onPress={() => {
                setKey(current => current ?? clientKey());
                setReviewing(true);
                setError(null);
              }}
            />
          )}
        </>
      )}
      {error ? <T color={colors.danger}>{error}</T> : null}
    </Card>
  );
}
