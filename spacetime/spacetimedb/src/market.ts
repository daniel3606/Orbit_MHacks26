import { SenderError, t } from 'spacetimedb/server';
import { ScheduleAt } from 'spacetimedb';
import spacetimedb, { marketSchedule, SignalFeature } from './schema';
import { requireAdmin, requireService, type Ctx } from './auth';
import { enqueueMarketIngest, JOB_KIND, JOB_STATUS, requireLease } from './jobs';

export const MARKET_SCOPE = 'us_equities';
export const FEATURE_NAMES = [
  'relative_momentum',
  'vol_adjusted_momentum',
  'abnormal_volume',
  'news_velocity',
  'sentiment_shift',
  'breadth_materiality',
] as const;
const SIGNAL_STATUSES = ['published', 'insufficient_data'] as const;
/** Higher rank wins when two sources cover the same session. */
/** Equal Alpaca ranks may replace each other; signal code never mixes the two feeds. */
const BAR_SOURCE_RANK: Record<string, number> = {
  fixture: 1,
  finnhub_quote: 2,
  finnhub_candle: 3,
  alpaca_iex: 4,
  alpaca_sip: 4,
};
const QUOTE_SOURCES = ['finnhub', 'fixture'];
const FIXTURE_FLAG = 'allow_fixture_data';
const MAX_BARS_PER_TICKER = 400;
const MAX_HISTORY_PER_TICKER = 120;
const MAX_FUTURE_MICROS = 5n * 60n * 1_000_000n;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MIN_INTERVAL_SECONDS = 60;
const MAX_INTERVAL_SECONDS = 86_400;

// ---- schedule (shared ingestion, separate from user commands) ----

export function scheduleMarketIngest(ctx: Ctx, intervalSeconds: number) {
  for (const row of [...ctx.db.marketSchedule.iter()]) ctx.db.marketSchedule.scheduledId.delete(row.scheduledId);
  ctx.db.marketSchedule.insert({
    scheduledId: 0n,
    scheduledAt: ScheduleAt.interval(BigInt(intervalSeconds) * 1_000_000n),
    intervalSeconds,
  });
}

export const marketTick = spacetimedb.reducer(
  { onSchedule: marketSchedule },
  { timer: marketSchedule.rowType },
  ctx => {
    if (!ctx.sender.isEqual(ctx.databaseIdentity)) throw new SenderError('scheduler_only');
    enqueueMarketIngest(ctx, 'schedule');
  }
);

export const configureMarketSchedule = spacetimedb.reducer(
  { intervalSeconds: t.u32() },
  (ctx, { intervalSeconds }) => {
    requireAdmin(ctx);
    if (intervalSeconds < MIN_INTERVAL_SECONDS || intervalSeconds > MAX_INTERVAL_SECONDS) {
      throw new SenderError('invalid_interval');
    }
    scheduleMarketIngest(ctx, intervalSeconds);
  }
);

/** Admin-only flags. `allow_fixture_data` must stay false outside test databases. */
export const setServiceFlag = spacetimedb.reducer(
  { key: t.string(), value: t.bool() },
  (ctx, { key, value }) => {
    requireAdmin(ctx);
    if (key !== FIXTURE_FLAG) throw new SenderError('unknown_flag');
    const row = { key, boolValue: value, updatedAt: ctx.timestamp };
    if (ctx.db.serviceConfig.key.find(key)) ctx.db.serviceConfig.key.update(row);
    else ctx.db.serviceConfig.insert(row);
  }
);

function fixturesAllowed(ctx: Ctx) {
  return ctx.db.serviceConfig.key.find(FIXTURE_FLAG)?.boolValue === true;
}

// ---- universe and capabilities ----

const StockInput = t.object('StockInput', {
  ticker: t.string(),
  name: t.string(),
  exchange: t.string(),
  industry: t.string(),
  sector: t.string(),
  currency: t.string(),
  kind: t.string(),
  benchmark: t.string(),
  displayOrder: t.u16(),
  logoUrl: t.string(),
});

/** Replaces the active universe; tickers not listed are deactivated, never deleted. */
export const upsertStocks = spacetimedb.reducer(
  { stocks: t.array(StockInput) },
  (ctx, { stocks }) => {
    requireService(ctx);
    const listed = new Set<string>();
    for (const s of stocks) {
      if (!TICKER_PATTERN.test(s.ticker) || listed.has(s.ticker)) throw new SenderError('invalid_ticker');
      if (s.kind !== 'equity' && s.kind !== 'benchmark') throw new SenderError('invalid_stock_kind');
      if (s.name.length === 0 || s.name.length > 120) throw new SenderError('invalid_stock_name');
      if (s.logoUrl !== '' && (!s.logoUrl.startsWith('https://') || s.logoUrl.length > 300)) {
        throw new SenderError('invalid_logo_url');
      }
      listed.add(s.ticker);
    }
    for (const s of stocks) {
      if (s.kind === 'equity' && !listed.has(s.benchmark)) throw new SenderError('unknown_benchmark');
    }
    for (const existing of [...ctx.db.stock.active.filter(true)]) {
      if (!listed.has(existing.ticker)) ctx.db.stock.ticker.update({ ...existing, active: false, updatedAt: ctx.timestamp });
    }
    for (const s of stocks) {
      const row = { ...s, active: true, updatedAt: ctx.timestamp };
      if (ctx.db.stock.ticker.find(s.ticker)) ctx.db.stock.ticker.update(row);
      else ctx.db.stock.insert(row);
    }
  }
);

const CapabilityInput = t.object('CapabilityInput', {
  key: t.string(),
  provider: t.string(),
  capability: t.string(),
  available: t.bool(),
  detail: t.string(),
});

export const publishProviderCapabilities = spacetimedb.reducer(
  { capabilities: t.array(CapabilityInput) },
  (ctx, { capabilities }) => {
    requireService(ctx);
    for (const c of capabilities) {
      if (!/^[a-z0-9_.]{1,64}$/.test(c.key) || c.detail.length > 240) throw new SenderError('invalid_capability');
      const row = { ...c, checkedAt: ctx.timestamp };
      if (ctx.db.providerCapability.key.find(c.key)) ctx.db.providerCapability.key.update(row);
      else ctx.db.providerCapability.insert(row);
    }
  }
);

// ---- coherent snapshot publication ----

const QuoteInput = t.object('QuoteInput', {
  ticker: t.string(),
  priceMicros: t.i64(),
  previousCloseMicros: t.i64(),
  openMicros: t.i64(),
  highMicros: t.i64(),
  lowMicros: t.i64(),
  providerTime: t.timestamp(),
  ingestedAt: t.timestamp(),
  source: t.string(),
});

const BarInput = t.object('BarInput', {
  ticker: t.string(),
  sessionDate: t.string(),
  openMicros: t.option(t.i64()),
  highMicros: t.option(t.i64()),
  lowMicros: t.option(t.i64()),
  closeMicros: t.i64(),
  volume: t.option(t.u64()),
  adjusted: t.bool(),
  source: t.string(),
});

const SignalInput = t.object('SignalInput', {
  ticker: t.string(),
  sessionDate: t.string(),
  status: t.string(),
  trendScore: t.option(t.f64()),
  composite: t.option(t.f64()),
  coverage: t.f64(),
  coverageScope: t.string(),
  benchmark: t.string(),
  historySessions: t.u32(),
  requiredSessions: t.u32(),
  dayReturn: t.option(t.f64()),
  benchmarkDayReturn: t.option(t.f64()),
  relativeDayReturn: t.option(t.f64()),
  features: t.array(SignalFeature),
  notes: t.array(t.string()),
});

function utcDate(ctx: Ctx): string {
  return new Date(Number(ctx.timestamp.microsSinceUnixEpoch / 1000n)).toISOString().slice(0, 10);
}

const finiteOrNone = (v: number | undefined) => v === undefined || Number.isFinite(v);

function requireKnownTicker(ctx: Ctx, ticker: string) {
  const s = ctx.db.stock.ticker.find(ticker);
  if (!s || !s.active) throw new SenderError('unknown_ticker');
  return s;
}

/**
 * Publishes one coherent market generation and completes the ingestion job in
 * the same transaction. Requires the caller's current lease on that job, a
 * strictly newer generation, and per-ticker non-decreasing provider time, so
 * delayed or duplicate work can never overwrite newer results.
 */
export const publishMarketSnapshot = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    generation: t.u64(),
    asOf: t.timestamp(),
    algorithmVersion: t.string(),
    provider: t.string(),
    marketOpen: t.bool(),
    marketSession: t.string(),
    marketStatusAt: t.timestamp(),
    lastCompletedSession: t.string(),
    quotes: t.array(QuoteInput),
    bars: t.array(BarInput),
    signals: t.array(SignalInput),
  },
  (ctx, args) => {
    requireService(ctx);
    const { row: jobRow, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (jobRow.kind !== JOB_KIND.ingestMarket) throw new SenderError('wrong_job_kind');
    if (!holdsLease) throw new SenderError('lease_mismatch');
    const current = ctx.db.marketGeneration.scope.find(MARKET_SCOPE);
    if (jobRow.status === JOB_STATUS.succeeded) {
      if (current && current.generation === args.generation && current.jobId === args.jobId) return; // retried publish
      throw new SenderError('job_not_running');
    }
    if (jobRow.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (jobRow.leaseUntil === undefined || jobRow.leaseUntil.microsSinceUnixEpoch < now) {
      throw new SenderError('lease_expired');
    }
    if (current && args.generation <= current.generation) throw new SenderError('stale_generation');
    if (args.asOf.microsSinceUnixEpoch > now + MAX_FUTURE_MICROS) throw new SenderError('future_timestamp');
    if (!DATE_PATTERN.test(args.lastCompletedSession)) throw new SenderError('invalid_session_date');
    const allowFixtures = fixturesAllowed(ctx);
    const today = utcDate(ctx);

    // Validate everything before writing anything.
    const quoteTickers = new Set<string>();
    for (const q of args.quotes) {
      requireKnownTicker(ctx, q.ticker);
      if (quoteTickers.has(q.ticker)) throw new SenderError('duplicate_ticker');
      quoteTickers.add(q.ticker);
      if (!QUOTE_SOURCES.includes(q.source)) throw new SenderError('invalid_source');
      if (q.source === 'fixture' && !allowFixtures) throw new SenderError('fixture_data_disabled');
      if (q.priceMicros <= 0n || q.previousCloseMicros <= 0n) throw new SenderError('invalid_price');
      if (q.openMicros < 0n || q.highMicros < 0n || q.lowMicros < 0n) throw new SenderError('invalid_price');
      if (q.providerTime.microsSinceUnixEpoch > now + MAX_FUTURE_MICROS) throw new SenderError('future_timestamp');
      const existing = ctx.db.marketQuote.ticker.find(q.ticker);
      if (existing && q.providerTime.microsSinceUnixEpoch < existing.providerTime.microsSinceUnixEpoch) {
        throw new SenderError('out_of_order_quote');
      }
    }
    for (const b of args.bars) {
      requireKnownTicker(ctx, b.ticker);
      if (!DATE_PATTERN.test(b.sessionDate)) throw new SenderError('invalid_session_date');
      if (b.sessionDate > today) throw new SenderError('future_session');
      if (!(b.source in BAR_SOURCE_RANK)) throw new SenderError('invalid_source');
      if (b.source === 'fixture' && !allowFixtures) throw new SenderError('fixture_data_disabled');
      if (b.closeMicros <= 0n) throw new SenderError('invalid_price');
      if (b.highMicros !== undefined && b.lowMicros !== undefined && b.highMicros < b.lowMicros) {
        throw new SenderError('invalid_bar_range');
      }
    }
    const signalTickers = new Set<string>();
    for (const s of args.signals) {
      requireKnownTicker(ctx, s.ticker);
      if (signalTickers.has(s.ticker)) throw new SenderError('duplicate_ticker');
      signalTickers.add(s.ticker);
      if (!SIGNAL_STATUSES.includes(s.status as never)) throw new SenderError('invalid_signal_status');
      const hasScore = s.trendScore !== undefined;
      if (hasScore !== (s.status === 'published')) throw new SenderError('score_status_mismatch');
      if (hasScore && !(s.trendScore! >= 0 && s.trendScore! <= 100)) throw new SenderError('invalid_score');
      if (!(s.coverage >= 0 && s.coverage <= 1)) throw new SenderError('invalid_coverage');
      for (const v of [s.trendScore, s.composite, s.dayReturn, s.benchmarkDayReturn, s.relativeDayReturn]) {
        if (!finiteOrNone(v)) throw new SenderError('non_finite_value');
      }
      for (const f of s.features) {
        if (!FEATURE_NAMES.includes(f.name as never)) throw new SenderError('unknown_feature');
        if (!finiteOrNone(f.raw) || !finiteOrNone(f.normalized) || !Number.isFinite(f.weight)) {
          throw new SenderError('non_finite_value');
        }
        if (f.available && f.raw === undefined) throw new SenderError('feature_value_missing');
      }
    }

    // Writes.
    for (const q of args.quotes) {
      const row = { ...q, generation: args.generation, publishedAt: ctx.timestamp };
      if (ctx.db.marketQuote.ticker.find(q.ticker)) ctx.db.marketQuote.ticker.update(row);
      else ctx.db.marketQuote.insert(row);
    }

    const touched = new Set<string>();
    for (const b of args.bars) {
      touched.add(b.ticker);
      let existing;
      for (const r of ctx.db.dailyBar.by_ticker_date.filter([b.ticker, b.sessionDate])) existing = r;
      if (!existing) {
        ctx.db.dailyBar.insert({ ...b, id: 0n, ingestedAt: ctx.timestamp });
      } else if (BAR_SOURCE_RANK[b.source] >= BAR_SOURCE_RANK[existing.source]) {
        ctx.db.dailyBar.id.update({ ...existing, ...b, id: existing.id, ingestedAt: ctx.timestamp });
      }
    }
    for (const ticker of touched) {
      const bars = [...ctx.db.dailyBar.by_ticker_date.filter(ticker)].sort((a, b) =>
        a.sessionDate < b.sessionDate ? -1 : 1
      );
      for (const old of bars.slice(0, Math.max(0, bars.length - MAX_BARS_PER_TICKER))) ctx.db.dailyBar.id.delete(old.id);
    }

    for (const s of args.signals) {
      const row = {
        ...s,
        generation: args.generation,
        algorithmVersion: args.algorithmVersion,
        asOf: args.asOf,
        publishedAt: ctx.timestamp,
      };
      if (ctx.db.trendSignal.ticker.find(s.ticker)) ctx.db.trendSignal.ticker.update(row);
      else ctx.db.trendSignal.insert(row);
      ctx.db.trendSignalHistory.insert({
        id: 0n,
        ticker: s.ticker,
        generation: args.generation,
        algorithmVersion: args.algorithmVersion,
        sessionDate: s.sessionDate,
        status: s.status,
        trendScore: s.trendScore,
        coverage: s.coverage,
        features: s.features,
        asOf: args.asOf,
        publishedAt: ctx.timestamp,
      });
      const history = [...ctx.db.trendSignalHistory.by_ticker.filter(s.ticker)].sort((a, b) =>
        Number(a.generation - b.generation)
      );
      for (const old of history.slice(0, Math.max(0, history.length - MAX_HISTORY_PER_TICKER))) {
        ctx.db.trendSignalHistory.id.delete(old.id);
      }
    }

    const generationRow = {
      scope: MARKET_SCOPE,
      generation: args.generation,
      jobId: args.jobId,
      asOf: args.asOf,
      publishedAt: ctx.timestamp,
      marketOpen: args.marketOpen,
      marketSession: args.marketSession,
      marketStatusAt: args.marketStatusAt,
      lastCompletedSession: args.lastCompletedSession,
      quoteCount: args.quotes.length,
      signalCount: args.signals.length,
      algorithmVersion: args.algorithmVersion,
      provider: args.provider,
    };
    if (current) ctx.db.marketGeneration.scope.update(generationRow);
    else ctx.db.marketGeneration.insert(generationRow);

    ctx.db.job.jobId.update({
      ...jobRow,
      status: JOB_STATUS.succeeded,
      resultRef: `generation=${args.generation};quotes=${args.quotes.length};signals=${args.signals.length}`,
      errorCode: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);
