import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, View } from 'react-native';

import { money, sessionLabel, signedPct, stamp } from '@/features/market/format';
import { labelFor, SECTORS } from '@/features/onboarding/options';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { PaperOrderCard } from '@/features/trading/PaperOrderCard';
import { realtime } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Button, Card, Chip, Screen, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';

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

export default function StockDetailScreen() {
  const router = useRouter();
  const { ticker } = useLocalSearchParams<{ ticker: string }>();
  const symbol = typeof ticker === 'string' ? ticker : '';
  const rt = useRealtime();
  const [open, setOpen] = useState(false);
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  const stock = rt.market.stocks.find(row => row.ticker === symbol);
  const quote = rt.market.quotes[symbol];
  const signal = rt.market.signals[symbol];
  const match = rt.recommendations.find(row => row.ticker === symbol);
  const change = quote && quote.previousClose > 0 ? quote.price / quote.previousClose - 1 : null;

  return (
    <Screen edges={['bottom']}>
      <ConnectionBanner />
      <View style={{ gap: space.xs }}>
        <T variant="caption" muted>
          {symbol}
          {stock?.exchange ? ` · ${stock.exchange}` : ''}
        </T>
        <T variant="display" accessibilityRole="header">
          {stock?.name || symbol || 'Stock'}
        </T>
        {stock?.industry ? <T muted>{stock.industry}</T> : null}
        {stock?.sector ? <Chip label={labelFor(SECTORS, stock.sector)} /> : null}
      </View>

      <Card>
        <T variant="heading">{quote ? money(quote.price) : 'Price unavailable'}</T>
        {quote ? (
          <T variant="caption" muted>
            {quote.source === 'finnhub' ? 'Finnhub' : quote.source} · {stamp(quote.providerTime)}
            {change !== null ? ` · ${signedPct(change)} vs previous close` : ''}
          </T>
        ) : (
          <T variant="caption" muted>
            No quote has been published for this ticker.
          </T>
        )}
      </Card>

      {match ? (
        <>
          <Card>
            <T variant="heading">Why it matched</T>
            <T>{match.matchReason}</T>
            <T muted>{match.learningNote}</T>
          </Card>
          <Card>
            <T variant="heading">Recent market activity</T>
            <T>{match.marketActivity}</T>
            <T variant="caption" muted>
              Through {sessionLabel(match.sessionDate)}, compared with {match.benchmark}.
            </T>
          </Card>
          <Card>
            <T variant="heading">Risk from the daily prices</T>
            <T>{match.riskObservation}</T>
          </Card>
          <Card>
            <T variant="heading">What this does not say</T>
            {match.limitations.map(line => (
              <T key={line} muted>
                {line}
              </T>
            ))}
          </Card>
        </>
      ) : (
        <Card>
          <T variant="heading">Not in your current matches</T>
          <T muted>
            This stock is not one of the recommendations saved for your profile. Orbit will not invent a reason it
            matches you.
          </T>
          <Button label="Back" kind="secondary" onPress={() => router.back()} />
        </Card>
      )}

      <Card>
        <T variant="heading">What the scores mean</T>
        <T muted>
          Trend Score compares recent price and volume with a benchmark. It is not a chance of making money. Fit Score
          uses only the checks we can support: the risk limit you set, measured from daily price swings, and whether
          the sector is one you chose. Time horizon and growth, value, or income style are saved on your profile and
          are not part of the score.
        </T>
        <T variant="caption" muted>
          {historyLabel(match?.historySource ?? '')} Quotes on this screen are separate from those daily bars.
        </T>
      </Card>

      {signal ? (
        <Card>
          <T variant="heading">Published signal</T>
          <T muted>
            {signal.status === 'published' && signal.trendScore !== null
              ? `Trend Score ${signal.trendScore.toFixed(1)} through ${sessionLabel(signal.sessionDate)}.`
              : `No Trend Score was published for ${sessionLabel(signal.sessionDate)}.`}
          </T>
          <T variant="caption" muted>
            Algorithm {signal.algorithmVersion}. Price and volume coverage {signal.coverage.toFixed(2)}.
          </T>
        </Card>
      ) : null}

      <PaperOrderCard ticker={symbol} quoteMicros={quote?.priceMicros ?? null} quoteTime={quote?.providerTime ?? null} />

      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)}>
        <T variant="label" color={colors.accent}>
          {open ? 'Hide data details' : 'Data details'}
        </T>
      </Pressable>
      {open && match ? (
        <Card>
          <T variant="caption" muted>
            {fitDetail(match.fitCoverage, match.fitScore)} Recommendation rank {match.recommendationRank.toFixed(2)},
            from 60% Trend Score and 40% of the fit figure. {match.volSessions} sessions in the volatility window,{' '}
            {match.drawdownSessions} in the drawdown window.
          </T>
          {rt.recommendationGeneration ? (
            <T variant="caption" muted>
              Fit rubric {rt.recommendationGeneration.fitAlgorithmVersion}. Signal{' '}
              {rt.recommendationGeneration.signalAlgorithmVersion}. Profile version{' '}
              {rt.recommendationGeneration.profileVersion}.
            </T>
          ) : null}
          {match.components.map(component => (
            <T key={component.name} variant="caption" muted>
              {component.name}: {component.available ? component.value?.toFixed(3) : 'not scored'}
              {component.reason ? ` (${component.reason})` : ''} · weight {component.weight.toFixed(2)}
            </T>
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}
