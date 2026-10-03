import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import {
  ago,
  explainNote,
  explainReason,
  FEATURE_LABELS,
  historyFeed,
  money,
  providerLabel,
  sessionLabel,
  signedPct,
  signedPoints,
  stamp,
} from '@/features/market/format';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { realtime, type QuoteVM, type SignalVM, type StockVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Banner, Card, Chip, Row, Screen, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';

/** Publication older than this is shown as stale (scheduled every 5 minutes). */
const STALE_AFTER_MS = 15 * 60 * 1000;

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export default function MarketScreen() {
  const rt = useRealtime();
  const m = rt.market;
  const now = useNow();
  // Subscribe only while this screen is focused.
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const equities = m.stocks.filter(s => s.kind === 'equity');
  const benchmarks = m.stocks.filter(s => s.kind === 'benchmark');
  const generation = m.generation;
  const feed = historyFeed(m.capabilities);
  const [details, setDetails] = useState(false);
  const stale = generation ? now - generation.publishedAt.getTime() > STALE_AFTER_MS : false;
  const loading = m.subscribed && !m.applied && equities.length === 0;

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <View style={{ gap: space.xs }}>
        <T variant="title" accessibilityRole="header">
          Market
        </T>
        <T variant="caption" muted>
          Market intelligence for a small set of stocks. Not personalized recommendations and not advice.
        </T>
      </View>

      {m.error ? <Banner tone="danger" title="Couldn't load market data" body={m.error} /> : null}
      {loading ? (
        <View style={{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md }}>
          <ActivityIndicator color={colors.accent} accessibilityLabel="Loading market data" />
          <T muted>Loading market data…</T>
        </View>
      ) : null}

      {!loading && m.applied && !generation ? (
        <Card>
          <T variant="heading">No market data yet</T>
          <T muted>The market worker publishes on a schedule. Nothing is shown until real data arrives.</T>
        </Card>
      ) : null}

      {generation ? (
        <Card>
          <T variant="heading">
            {generation.marketOpen ? 'US market open' : 'US market closed'}
            {generation.marketSession.startsWith('holiday:') ? ` · ${generation.marketSession.slice(8)}` : ''}
          </T>
          <Row label="Last completed session" value={sessionLabel(generation.lastCompletedSession)} />
          <Row label="Status checked" value={stamp(generation.marketStatusAt)} />
          <Row label="Published" value={`${stamp(generation.publishedAt)} · ${providerLabel(generation.provider)}`} />
          {!generation.marketOpen ? (
            <T variant="caption" muted>
              Prices below are the latest available from the provider, with their own timestamps. They do not change
              while the market is closed.
            </T>
          ) : null}
        </Card>
      ) : null}

      {stale ? (
        <Banner
          tone="warning"
          title="Market data may be out of date"
          body={`Last published ${ago(generation!.publishedAt, now)}. The ingestion worker may not be running.`}
        />
      ) : null}

      {generation ? (
        <Card>
          <T variant="heading">What you can see</T>
          <T muted>Prices are the latest Finnhub quotes, shown with the time Finnhub reported.</T>
          {feed === 'sip' ? (
            <T muted>
              Trend Scores use completed daily prices and full US market volume, adjusted for stock splits. News is
              not included yet. Each stock shows the date its score uses.
            </T>
          ) : null}
          {feed === 'iex' ? (
            <T muted>
              Trend Scores use completed daily prices adjusted for stock splits. Volume counts only the IEX exchange,
              not the whole US market. News is not included yet.
            </T>
          ) : null}
          {feed === 'none' ? (
            <T muted>
              Daily price and volume history is not available, so Trend Scores stay hidden instead of being estimated.
            </T>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: details }}
            onPress={() => setDetails(v => !v)}
            style={{ minHeight: 44, justifyContent: 'center' }}>
            <T variant="label" color={colors.accent}>
              {details ? 'Hide data details' : 'Data details'}
            </T>
          </Pressable>
          {details
            ? m.capabilities.map(c => (
                <View key={c.key} style={{ gap: space.xs }}>
                  <Row label={c.capability} value={c.available ? 'Available' : 'Unavailable'} />
                  <T variant="caption" muted>
                    {c.detail}
                  </T>
                </View>
              ))
            : null}
          {details && generation ? (
            <T variant="caption" muted>
              {generation.algorithmVersion}
            </T>
          ) : null}
        </Card>
      ) : null}

      {equities.map(s => (
        <StockRow key={s.ticker} stock={s} quote={m.quotes[s.ticker]} signal={m.signals[s.ticker]} />
      ))}

      {benchmarks.length > 0 ? (
        <Card>
          <T variant="heading">Benchmarks</T>
          {benchmarks.map(b => {
            const q = m.quotes[b.ticker];
            return (
              <Row
                key={b.ticker}
                label={`${b.ticker} · ${b.name}`}
                value={q ? `${money(q.price)} (${signedPct(q.price / q.previousClose - 1)})` : 'No quote'}
              />
            );
          })}
        </Card>
      ) : null}
    </Screen>
  );
}

function StockRow({ stock, quote, signal }: { stock: StockVM; quote?: QuoteVM; signal?: SignalVM }) {
  const [open, setOpen] = useState(false);
  const change = quote ? quote.price / quote.previousClose - 1 : null;
  const changeColor = change === null ? colors.textMuted : change >= 0 ? colors.success : colors.danger;
  const published = signal?.status === 'published' && signal.trendScore !== null;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      accessibilityHint="Shows signal details"
      onPress={() => setOpen(v => !v)}>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <T variant="heading">{stock.ticker}</T>
            <T variant="caption" muted numberOfLines={1}>
              {stock.name}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T variant="heading">{quote ? money(quote.price) : '—'}</T>
            {change !== null ? (
              <T variant="caption" color={changeColor}>
                {signedPct(change)} vs prev. close
              </T>
            ) : (
              <T variant="caption" muted>
                No valid quote
              </T>
            )}
          </View>
        </View>

        {quote ? (
          <T variant="caption" muted>
            {quote.source === 'finnhub' ? 'Finnhub' : quote.source === 'fixture' ? 'Test fixture' : quote.source} · data
            time {stamp(quote.providerTime)}
          </T>
        ) : null}

        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {signal?.relativeDayReturn != null ? (
            <Chip label={`1-day vs ${signal.benchmark}: ${signedPoints(signal.relativeDayReturn)}`} />
          ) : null}
          {published ? (
            <Chip label={`Trend Score ${Math.round(signal!.trendScore!)} · heuristic`} />
          ) : (
            <Chip label="Trend Score unavailable" />
          )}
        </View>

        {signal && !published ? (
          <T variant="caption" muted>
            Not enough completed daily history to score this stock yet.
          </T>
        ) : null}
        {published ? (
          <T variant="caption" muted>
            Through {sessionLabel(signal!.sessionDate)}, compared with {signal!.benchmark}. A heuristic from price and
            volume, not a probability of gains.
          </T>
        ) : null}

        {open && signal ? (
          <View style={{ gap: space.xs, paddingTop: space.sm }}>
            <T variant="label">Diagnostics</T>
            <T variant="caption" muted>
              {signal.historySessions} completed sessions ({signal.requiredSessions} needed). Price and volume coverage{' '}
              {signal.coverage.toFixed(2)} (needs 0.55). Score date {sessionLabel(signal.sessionDate)}.
            </T>
            {signal.notes.map(note => {
              const text = explainNote(note);
              return text ? (
                <T key={note} variant="caption" muted>
                  {text}
                </T>
              ) : null;
            })}
            {signal.features.map(f => (
              <View key={f.name} style={{ paddingVertical: space.xs }}>
                <T variant="label" color={f.available ? colors.text : colors.textMuted}>
                  {FEATURE_LABELS[f.name] ?? f.name}
                </T>
                <T variant="caption" muted>
                  {f.available
                    ? `Normalized ${f.normalized!.toFixed(2)} (raw ${f.raw!.toFixed(4)}, weight ${f.weight})`
                    : explainReason(f.reason)}
                </T>
              </View>
            ))}
            <T variant="caption" muted>
              Session {sessionLabel(signal.sessionDate)} · {signal.algorithmVersion}
            </T>
          </View>
        ) : null}
      </Card>
    </Pressable>
  );
}
