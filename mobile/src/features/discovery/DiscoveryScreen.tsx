import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import { requestRecommendations } from '@/features/profile/actions';
import { labelFor, RISK_TOLERANCE, SECTORS, ZODIAC_SIGNS } from '@/features/onboarding/options';
import { money, sessionLabel, signedPct, stamp } from '@/features/market/format';
import { ConnectionBanner } from '@/features/session/ConnectionBanner';
import { AppError, messageFor } from '@/realtime/errors';
import { realtime, type RecommendationVM } from '@/realtime/connection';
import { useRealtime } from '@/realtime/hooks';
import { Banner, Button, Card, Chip, Screen, T } from '@/ui/components';
import { colors, space } from '@/ui/theme';

const ACTIVE = new Set(['queued', 'running', 'retry_wait']);

const COMPONENT_LABELS: Record<string, string> = {
  risk_match: 'Risk limit',
  horizon_match: 'Time horizon',
  style_match: 'Growth, value, or income',
  sector_preference: 'Sectors you chose',
};

/** Coverage stays visible. A sector-only score of 100 is not shown as a match percentage. */
function fitDetail(coverage: number, fitScore: number): string {
  const coverageText = `Coverage ${coverage.toFixed(2)} of the planned checks. Horizon and style were not scored.`;
  if (coverage <= 0.11 && fitScore >= 99) {
    return `${coverageText} The only check that ran is the sector. A sector match is not overall suitability.`;
  }
  return `${coverageText} Internal fit figure ${fitScore.toFixed(1)} for the checks that ran. Not a match percentage.`;
}

function historyLabel(source: string): string {
  if (source === 'alpaca_sip') return 'Alpaca consolidated US tape (SIP)';
  if (source === 'alpaca_iex') return 'Alpaca IEX only — not full-market volume';
  return source;
}

function MatchCard({ item, onOpen }: { item: RecommendationVM; onOpen: () => void }) {
  const rt = useRealtime();
  const stock = rt.market.stocks.find(row => row.ticker === item.ticker);
  const quote = rt.market.quotes[item.ticker];
  const change = quote && quote.previousClose > 0 ? quote.price / quote.previousClose - 1 : null;
  const [open, setOpen] = useState(false);
  const priceLine = quote
    ? `${quote.source === 'finnhub' ? 'Finnhub' : quote.source} price at ${stamp(quote.providerTime)}`
    : rt.market.applied
      ? 'A current price is not available.'
      : 'Loading the latest price…';

  return (
    <Card>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open ${item.ticker}`} onPress={onOpen}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: space.md }}>
          <View style={{ flex: 1 }}>
            <T variant="heading">{stock?.name || item.ticker}</T>
            <T variant="caption" muted>
              {item.ticker}
              {stock?.exchange ? ` · ${stock.exchange}` : ''}
            </T>
          </View>
          <View style={{ alignItems: 'flex-end' }}>
            <T variant="heading">{quote ? money(quote.price) : '—'}</T>
            {change !== null ? (
              <T variant="caption" muted>
                {signedPct(change)} vs previous close
              </T>
            ) : null}
          </View>
        </View>
        <T variant="caption" muted>
          {priceLine}
        </T>
        <T>{item.matchReason}</T>
        <T muted>{item.marketActivity}</T>
        <T variant="caption" muted>
          {item.limitations[0]}
        </T>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(value => !value)}>
        <T variant="label" color={colors.accent}>
          {open ? 'Hide data details' : 'Data details'}
        </T>
      </Pressable>
      {open ? (
        <View style={{ gap: space.xs }}>
          <T variant="caption" muted>
            {fitDetail(item.fitCoverage, item.fitScore)} Trend Score {item.trendScore.toFixed(1)}. Rank{' '}
            {item.recommendationRank.toFixed(1)}.
          </T>
          <T variant="caption" muted>
            Daily history: {historyLabel(item.historySource)}. Score date {sessionLabel(item.sessionDate)}.
          </T>
          {item.components.map(component => (
            <T key={component.name} variant="caption" muted>
              {COMPONENT_LABELS[component.name] ?? component.name}:{' '}
              {component.available ? `used (${component.value?.toFixed(2)})` : `not scored${component.reason ? ` — ${component.reason}` : ''}`}
            </T>
          ))}
          {item.limitations.slice(1).map(line => (
            <T key={line} variant="caption" muted>
              {line}
            </T>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

/** Personalized discovery. Reasons come from the published generation, not from this screen. */
export default function DiscoveryScreen() {
  const router = useRouter();
  const rt = useRealtime();
  const profile = rt.profile;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => realtime.acquireMarket(), []));

  if (!profile) return null;

  const generation = rt.recommendationGeneration;
  const refresh = rt.jobs.find(job => job.kind === 'refresh_recommendations');
  const updating = refresh ? ACTIVE.has(refresh.status) : false;
  const failed = refresh?.status === 'failed';
  const offline = rt.status !== 'ready';
  const marketMoved =
    generation &&
    rt.market.generation &&
    generation.marketGeneration !== rt.market.generation.generation &&
    generation.status !== 'insufficient_market';
  const sign = rt.branding?.zodiacSign ?? null;

  async function refreshMatches() {
    setBusy(true);
    setError(null);
    try {
      await requestRecommendations();
    } catch (err) {
      setError(messageFor(err instanceof AppError ? err.code : 'unexpected_error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen edges={['top']}>
      <ConnectionBanner />
      <View style={{ gap: space.xs }}>
        <T variant="caption" muted>
          {sign ? `${labelFor(ZODIAC_SIGNS, sign)} · ` : ''}Your Orbit
        </T>
        <T variant="display" accessibilityRole="header">
          For you
        </T>
        <T muted>Up to three stocks from the profile you saved. Not a promise that any of them will suit you.</T>
      </View>

      {offline && generation ? (
        <Banner tone="warning" title="Showing your last matches" body="Reconnect to refresh them. Nothing new is being calculated while you are offline." />
      ) : null}
      {updating && generation ? (
        <Banner tone="info" title="Updating your matches" body="The list below stays visible until the new one is ready." />
      ) : null}
      {marketMoved ? (
        <Banner
          tone="info"
          title="Market data has moved on"
          body="These matches still describe the earlier session. Refresh when you want them recalculated."
        />
      ) : null}
      {error ? <Banner tone="danger" title="Couldn’t refresh" body={error} /> : null}
      {failed && !updating ? (
        <Banner
          tone="warning"
          title="The last refresh did not finish"
          body={generation ? 'Your previous matches are still shown.' : 'No matches are available yet.'}
          action={offline ? undefined : { label: 'Try again', onPress: () => void refreshMatches() }}
        />
      ) : null}

      {!generation && updating ? (
        <View style={{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md }}>
          <ActivityIndicator color={colors.accent} accessibilityLabel="Finding matches" />
          <T muted>Finding matches from your saved profile…</T>
        </View>
      ) : null}

      {!generation && !updating ? (
        <Card>
          <T variant="heading">{failed ? 'No matches yet' : 'Matches are not ready'}</T>
          <T muted>
            {failed
              ? 'The refresh failed before a list could be saved.'
              : 'A refresh has not produced a list yet. Nothing is filled in while we wait.'}
          </T>
          <Button label="Refresh matches" kind="secondary" disabled={offline || busy} busy={busy} onPress={() => void refreshMatches()} />
        </Card>
      ) : null}

      {generation && generation.status === 'insufficient_market' ? (
        <Card>
          <T variant="heading">Not enough market data</T>
          <T>{generation.summary}</T>
        </Card>
      ) : null}

      {generation && generation.status === 'no_eligible' ? (
        <Card>
          <T variant="heading">No stocks passed your limits</T>
          <T>{generation.summary}</T>
        </Card>
      ) : null}

      {generation && generation.status === 'ready'
        ? rt.recommendations.map(item => (
            <MatchCard
              key={item.ticker}
              item={item}
              onOpen={() => router.push({ pathname: '/stock/[ticker]', params: { ticker: item.ticker } })}
            />
          ))
        : null}

      {generation ? (
        <T variant="caption" muted>
          {generation.summary} Saved for profile version {generation.profileVersion}.
          {generation.signalSessionDate ? ` Score date ${sessionLabel(generation.signalSessionDate)}.` : ''}
        </T>
      ) : null}

      {generation && !updating ? (
        <Button label="Refresh matches" kind="secondary" disabled={offline || busy} busy={busy} onPress={() => void refreshMatches()} />
      ) : null}

      <Card>
        <T variant="heading">Your preferences</T>
        <T muted>
          {labelFor(RISK_TOLERANCE, profile.riskTolerance)}. Sectors are used in the match. Time horizon and style are
          saved and explained, not scored.
        </T>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {profile.sectorInterests.map(sector => (
            <Chip key={sector} label={labelFor(SECTORS, sector)} />
          ))}
        </View>
        <Button label="Edit preferences" kind="secondary" disabled={offline} onPress={() => router.push('/edit-preferences')} />
      </Card>

      <Button label="Connection diagnostics" kind="secondary" onPress={() => router.push('/diagnostics')} />
    </Screen>
  );
}
