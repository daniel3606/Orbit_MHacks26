import { SenderError, t } from 'spacetimedb/server';
import spacetimedb, { StockNewsStory } from './schema';
import { requireConsumer, requireService, type Ctx } from './auth';
import { JOB_KIND, JOB_STATUS, insertJob, isActiveStatus, requireLease } from './jobs';

/** Classifier output vocabularies; Python validates Jev's response against the same lists. */
export const EVENT_TYPES = [
  'earnings',
  'product',
  'partnership',
  'regulation',
  'M&A',
  'analyst_rating',
  'executive',
  'legal',
  'macro',
  'financing',
  'other',
] as const;
export const SENTIMENTS = ['positive', 'neutral', 'negative'] as const;
export const MATERIALITIES = ['low', 'medium', 'high', 'critical'] as const;

/** Jobs that read news for a person and may record what they classified. */
const CLASSIFYING_JOBS: readonly string[] = [
  JOB_KIND.dailyDiscovery,
  JOB_KIND.answerMessage,
  JOB_KIND.homeBrief,
  JOB_KIND.stockNews,
];
const MAX_ROWS_PER_CALL = 64;
/** Rows kept; the oldest classifications are pruned past this (they are a cache, not a ledger). */
const RETENTION = 4_000;
const PRUNE_TO = 3_600;
const MAX_FUTURE_MICROS = 5n * 60n * 1_000_000n;
const HEX64 = /^[0-9a-f]{64}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;
const VERSION_PATTERN = /^[A-Za-z0-9:._~\/-]{1,80}$/;

const NewsClassificationInput = t.object('NewsClassificationInput', {
  cacheKey: t.string(),
  ticker: t.string(),
  articleId: t.string(),
  contentHash: t.string(),
  classifierVersion: t.string(),
  relevant: t.bool(),
  relevanceScore: t.f64(),
  eventType: t.string(),
  sentiment: t.string(),
  materiality: t.string(),
  keep: t.bool(),
  publishedAt: t.timestamp(),
});

/**
 * Worker: stores classifications made while holding the lease on a news-reading
 * job. Everything is validated before anything is written. A key that already
 * exists keeps its first judgment, so a retried call is a no-op.
 */
export const recordNewsClassifications = spacetimedb.reducer(
  { jobId: t.u64(), attempt: t.u32(), rows: t.array(NewsClassificationInput) },
  (ctx, { jobId, attempt, rows }) => {
    requireService(ctx);
    const { row: job, holdsLease } = requireLease(ctx, jobId, attempt);
    if (!CLASSIFYING_JOBS.includes(job.kind)) throw new SenderError('wrong_job_kind');
    if (!holdsLease) throw new SenderError('lease_mismatch');
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < now) {
      throw new SenderError('lease_expired');
    }
    if (rows.length < 1 || rows.length > MAX_ROWS_PER_CALL) throw new SenderError('invalid_row_count');

    const keys = new Set<string>();
    for (const r of rows) {
      if (!HEX64.test(r.cacheKey) || keys.has(r.cacheKey)) throw new SenderError('invalid_cache_key');
      keys.add(r.cacheKey);
      if (!HEX64.test(r.contentHash)) throw new SenderError('invalid_content_hash');
      if (!TICKER_PATTERN.test(r.ticker) || !ctx.db.stock.ticker.find(r.ticker)) throw new SenderError('unknown_ticker');
      if (r.articleId.length === 0 || r.articleId.length > 128) throw new SenderError('invalid_article_id');
      if (!VERSION_PATTERN.test(r.classifierVersion)) throw new SenderError('invalid_classifier_version');
      if (!Number.isFinite(r.relevanceScore) || r.relevanceScore < 0 || r.relevanceScore > 1) {
        throw new SenderError('invalid_relevance');
      }
      if (r.keep && !r.relevant) throw new SenderError('keep_requires_relevant');
      if (!(EVENT_TYPES as readonly string[]).includes(r.eventType)) throw new SenderError('invalid_event_type');
      if (!(SENTIMENTS as readonly string[]).includes(r.sentiment)) throw new SenderError('invalid_sentiment');
      if (!(MATERIALITIES as readonly string[]).includes(r.materiality)) throw new SenderError('invalid_materiality');
      if (r.publishedAt.microsSinceUnixEpoch > now + MAX_FUTURE_MICROS) throw new SenderError('future_timestamp');
    }

    // Writes begin only after every check above has passed.
    for (const r of rows) {
      if (ctx.db.newsClassification.cacheKey.find(r.cacheKey)) continue;
      ctx.db.newsClassification.insert({ ...r, classifiedAt: ctx.timestamp, jobId });
    }
    if (ctx.db.newsClassification.count() > BigInt(RETENTION)) {
      const oldest = [...ctx.db.newsClassification.iter()].sort((a, b) =>
        Number(a.classifiedAt.microsSinceUnixEpoch - b.classifiedAt.microsSinceUnixEpoch)
      );
      for (const old of oldest.slice(0, oldest.length - PRUNE_TO)) ctx.db.newsClassification.cacheKey.delete(old.cacheKey);
    }
  }
);

// ---- Stock Detail news: requested by a person, fetched and classified by the worker ----

const MAX_STORIES = 3;
/** A checked ticker is not fetched again for this long (shorter when classification was incomplete). */
const FRESH_SECONDS = 15 * 60;
const RETRY_SECONDS = 2 * 60;
/** News is shared, so jobs are system-owned (never in a person's `my_jobs`); this bounds them all. */
const MAX_ACTIVE_NEWS_JOBS = 12;
const NEWS_JOB_RETENTION = 50;
const COVERAGE_PATTERN = /^(classified|not_configured|no_articles|(partial|unavailable):[a-z_]{1,32})$/;
const MICROS_PER_SECOND = 1_000_000n;

function newsJobTicker(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { ticker?: unknown };
    return typeof parsed.ticker === 'string' ? parsed.ticker : null;
  } catch {
    return null;
  }
}

function requireEquity(ctx: Ctx, ticker: string) {
  if (!TICKER_PATTERN.test(ticker)) throw new SenderError('invalid_ticker');
  const stock = ctx.db.stock.ticker.find(ticker);
  if (!stock || !stock.active || stock.kind !== 'equity') throw new SenderError('unknown_ticker');
}

/**
 * Consumer: ask for recent news on one company. Coalesces: a fresh result or a
 * job already active for that ticker means nothing new is queued. The job is
 * owned by the database identity, like market ingestion, because the result is shared.
 */
export const requestStockNews = spacetimedb.reducer({ ticker: t.string() }, (ctx, { ticker }) => {
  requireConsumer(ctx);
  requireEquity(ctx, ticker);
  const existing = ctx.db.stockNews.ticker.find(ticker);
  if (existing) {
    const window = existing.classification === 'classified' ? FRESH_SECONDS : RETRY_SECONDS;
    const age = ctx.timestamp.microsSinceUnixEpoch - existing.checkedAt.microsSinceUnixEpoch;
    if (age < BigInt(window) * MICROS_PER_SECOND) return;
  }
  let active = 0;
  for (const status of [JOB_STATUS.queued, JOB_STATUS.retryWait, JOB_STATUS.running]) {
    for (const row of ctx.db.job.by_status_kind.filter([status, JOB_KIND.stockNews])) {
      if (newsJobTicker(row.payload) === ticker) return;
      active++;
    }
  }
  if (active >= MAX_ACTIVE_NEWS_JOBS) throw new SenderError('rate_limited');
  const owner = ctx.databaseIdentity;
  const terminal = [...ctx.db.job.owner.filter(owner)]
    .filter(row => row.kind === JOB_KIND.stockNews && !isActiveStatus(row.status))
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch));
  for (const old of terminal.slice(NEWS_JOB_RETENTION - 1)) ctx.db.job.jobId.delete(old.jobId);
  const row = insertJob(
    ctx,
    owner,
    JOB_KIND.stockNews,
    `news:${ticker}:${ctx.timestamp.microsSinceUnixEpoch}`,
    0,
    JSON.stringify({ ticker })
  );
  ctx.db.job.jobId.update({ ...row, maxAttempts: 3 });
});

/**
 * Worker: replaces one ticker's news and completes the job in the same
 * transaction, under the caller's lease. Validated before anything is written.
 */
export const publishStockNews = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    ticker: t.string(),
    stories: t.array(StockNewsStory),
    classification: t.string(),
    classifierVersion: t.string(),
  },
  (ctx, args) => {
    requireService(ctx);
    const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (job.kind !== JOB_KIND.stockNews) throw new SenderError('wrong_job_kind');
    if (!holdsLease) throw new SenderError('lease_mismatch');
    if (job.status === JOB_STATUS.succeeded) {
      if (ctx.db.stockNews.ticker.find(args.ticker)?.jobId === args.jobId) return; // retried publish
      throw new SenderError('job_not_running');
    }
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    const now = ctx.timestamp.microsSinceUnixEpoch;
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < now) throw new SenderError('lease_expired');
    if (newsJobTicker(job.payload) !== args.ticker) throw new SenderError('ticker_mismatch');
    requireEquity(ctx, args.ticker);
    if (args.stories.length > MAX_STORIES) throw new SenderError('invalid_story_count');
    const urls = new Set<string>();
    for (const story of args.stories) {
      if (story.headline.trim().length === 0 || story.headline.length > 180) throw new SenderError('invalid_story');
      if (story.source.trim().length === 0 || story.source.length > 80) throw new SenderError('invalid_story');
      if (!story.url.startsWith('https://') || story.url.length > 300 || urls.has(story.url)) {
        throw new SenderError('invalid_story');
      }
      urls.add(story.url);
      if (story.publishedAt.microsSinceUnixEpoch > now + MAX_FUTURE_MICROS) throw new SenderError('future_timestamp');
    }
    if (!COVERAGE_PATTERN.test(args.classification)) throw new SenderError('invalid_news_classification');
    if (args.classifierVersion !== '' && !VERSION_PATTERN.test(args.classifierVersion)) {
      throw new SenderError('invalid_classifier_version');
    }

    const row = {
      ticker: args.ticker,
      stories: args.stories,
      classification: args.classification,
      classifierVersion: args.classifierVersion,
      checkedAt: ctx.timestamp,
      jobId: args.jobId,
    };
    if (ctx.db.stockNews.ticker.find(args.ticker)) ctx.db.stockNews.ticker.update(row);
    else ctx.db.stockNews.insert(row);
    ctx.db.job.jobId.update({
      ...job,
      status: JOB_STATUS.succeeded,
      resultRef: `news=${args.ticker};stories=${args.stories.length};classification=${args.classification}`,
      errorCode: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);
