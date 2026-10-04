import { Pressable, StyleSheet, Text, View } from 'react-native';

import { freshnessLine } from '@/features/home/DailyBrief';
import { money, signedPct } from '@/features/market/format';
import { briefSeries, seriesReturn, type BriefRange, type ClosePoint } from '@/features/market/series';
import type { QuoteVM, SignalVM } from '@/realtime/connection';
import { colors, font, space } from '@/ui/theme';

const WINDOWS: { range: BriefRange; label: string }[] = [
  { range: '1W', label: '1W' },
  { range: '1M', label: '1M' },
  { range: '1Y', label: '1Y' },
];

/** Presentation bands for Orbit's descriptive activity score. Not a forecast. */
export function activityLabel(score: number): string {
  if (score < 25) return 'Low recent activity';
  if (score < 50) return 'Below-average recent activity';
  if (score < 75) return 'Moderate recent activity';
  if (score < 90) return 'Strong recent activity';
  return 'Very strong recent activity';
}

export function AnswerFacts({
  tickers,
  names,
  quotes,
  closes,
  signals,
  marketOpen,
  onOpen,
  density = 'full',
}: {
  tickers: string[];
  names: Record<string, string>;
  quotes: Record<string, QuoteVM | undefined>;
  closes: Record<string, ClosePoint[] | undefined>;
  signals: Record<string, SignalVM | undefined>;
  marketOpen: boolean | null;
  onOpen: (ticker: string) => void;
  density?: 'full' | 'compact';
}) {
  if (tickers.length === 0) return null;
  if (density === 'compact') {
    return (
      <View style={styles.block}>
        {tickers.map(ticker => (
          <CompactHeader
            key={ticker}
            ticker={ticker}
            name={names[ticker] || ticker}
            quote={quotes[ticker]}
            onOpen={onOpen}
          />
        ))}
      </View>
    );
  }
  const freshest = tickers
    .map(ticker => quotes[ticker]?.providerTime)
    .filter((time): time is Date => time instanceof Date)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return (
    <View style={styles.block}>
      {tickers.map(ticker => (
        <Snapshot
          key={ticker}
          ticker={ticker}
          name={names[ticker] || ticker}
          quote={quotes[ticker]}
          closes={closes[ticker]}
          signal={signals[ticker]}
          onOpen={onOpen}
        />
      ))}
      {freshest ? <Text style={styles.fresh}>{freshnessLine(freshest, marketOpen)}</Text> : null}
    </View>
  );
}

function CompactHeader({
  ticker,
  name,
  quote,
  onOpen,
}: {
  ticker: string;
  name: string;
  quote?: QuoteVM;
  onOpen: (ticker: string) => void;
}) {
  const day = quote && quote.previousClose > 0 ? quote.price / quote.previousClose - 1 : null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}`} onPress={() => onOpen(ticker)}>
      <Text style={styles.compact}>
        {ticker}
        {quote ? ` · ${money(quote.price)}` : ''}
        {day != null ? (
          <Text style={{ color: day >= 0 ? colors.success : colors.danger }}>{` · ${signedPct(day)} latest session`}</Text>
        ) : null}
      </Text>
    </Pressable>
  );
}

function Snapshot({
  ticker,
  name,
  quote,
  closes,
  signal,
  onOpen,
}: {
  ticker: string;
  name: string;
  quote?: QuoteVM;
  closes?: ClosePoint[];
  signal?: SignalVM;
  onOpen: (ticker: string) => void;
}) {
  const day =
    quote && quote.previousClose > 0 ? quote.price / quote.previousClose - 1 : null;
  const windows = WINDOWS.map(item => ({
    label: item.label,
    value: seriesReturn(briefSeries(item.range, closes, quote)),
  })).filter(item => item.value != null);
  const score = signal && signal.status === 'published' ? signal.trendScore : null;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`Open ${name}`} onPress={() => onOpen(ticker)} style={styles.snapshot}>
      <Text style={styles.company} numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.75}>
        {name}
      </Text>
      <Text style={styles.symbol}>{ticker}</Text>
      {quote ? (
        <View style={styles.priceRow}>
          <Text style={styles.price}>{money(quote.price)}</Text>
          {day != null ? (
            <Text style={[styles.change, { color: day >= 0 ? colors.success : colors.danger }]}>
              {signedPct(day)}
              <Text style={styles.period}>  latest session</Text>
            </Text>
          ) : null}
        </View>
      ) : (
        <Text style={styles.missing}>Price isn’t available yet.</Text>
      )}
      {windows.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.label}>Performance</Text>
          <Text style={styles.metrics}>
            {windows.map((item, index) => (
              <Text key={item.label}>
                {index > 0 ? '   ' : ''}
                {item.label}{' '}
                <Text style={{ color: (item.value ?? 0) >= 0 ? colors.success : colors.danger }}>{signedPct(item.value ?? 0)}</Text>
              </Text>
            ))}
          </Text>
        </View>
      ) : null}
      {score != null ? (
        <View style={styles.section}>
          <Text style={styles.label}>Trend Score</Text>
          <Text style={styles.score}>
            {Math.round(score)} / 100
            <Text style={styles.activity}>  {activityLabel(score)}</Text>
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.md },
  snapshot: { gap: 2 },
  company: { fontFamily: font.bold, fontSize: 20, lineHeight: 24, color: '#FFFFFF' },
  symbol: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', gap: space.sm, marginTop: 2 },
  price: { fontFamily: font.bold, fontSize: 22, lineHeight: 26, color: '#FFFFFF' },
  change: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20 },
  period: { fontFamily: font.medium, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  missing: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.textMuted },
  section: { marginTop: space.sm, gap: 2 },
  label: { fontFamily: font.semibold, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  metrics: { fontFamily: font.medium, fontSize: 15, lineHeight: 20, color: colors.text },
  score: { fontFamily: font.semibold, fontSize: 15, lineHeight: 20, color: '#FFFFFF' },
  activity: { fontFamily: font.regular, fontSize: 14, lineHeight: 20, color: colors.text },
  fresh: { fontFamily: font.regular, fontSize: 12, lineHeight: 16, color: colors.textSubtle },
  compact: { fontFamily: font.medium, fontSize: 14, lineHeight: 20, color: colors.text },
});
