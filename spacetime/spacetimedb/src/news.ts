import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireService } from './auth';
import { JOB_KIND, JOB_STATUS, requireLease } from './jobs';

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
const CLASSIFYING_JOBS: readonly string[] = [JOB_KIND.dailyDiscovery, JOB_KIND.answerMessage, JOB_KIND.homeBrief];
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
