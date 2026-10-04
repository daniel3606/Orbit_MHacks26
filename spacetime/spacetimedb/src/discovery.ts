import { SenderError, t } from 'spacetimedb/server';
import type { Identity, Timestamp } from 'spacetimedb';
import spacetimedb from './schema';
import { requireConsumer, requireService, type Ctx } from './auth';
import { JOB_KIND, JOB_STATUS, insertJob, isActiveStatus, requireLease } from './jobs';
import { notifyDailyDiscoveryReady } from './notifications';
import { ZODIAC_SIGNS } from './preferences';

export const DISCOVERY_ALGORITHM_VERSION = 'discovery-v1.0.0';
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const TICKER_PATTERN = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_ITEMS = 3;
const MAX_REASONS = 2;
/** Requests per local day, so a failing job cannot be retried without bound. */
const MAX_JOBS_PER_DAY = 6;
/** Discovery sets kept per person; older sets and their items are pruned. */
const RETENTION = 45;
/** UTC offsets in use span −12:00 to +14:00. */
const MIN_OFFSET_MICROS = -12n * 3600n * 1_000_000n;
const MAX_OFFSET_MICROS = 14n * 3600n * 1_000_000n;

function isoDay(micros: bigint): string {
  return new Date(Number(micros / 1000n)).toISOString().slice(0, 10);
}

/** A real calendar date that is "today" somewhere on Earth right now. */
function requireLocalToday(ctx: Ctx, localDate: string) {
  if (!DATE_PATTERN.test(localDate)) throw new SenderError('invalid_date');
  const parsed = new Date(`${localDate}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== localDate) {
    throw new SenderError('invalid_date');
  }
  const now = ctx.timestamp.microsSinceUnixEpoch;
  if (localDate < isoDay(now + MIN_OFFSET_MICROS) || localDate > isoDay(now + MAX_OFFSET_MICROS)) {
    throw new SenderError('date_out_of_range');
  }
}

export function findDiscovery(ctx: Ctx, owner: Identity, discoveryDate: string) {
  for (const row of ctx.db.dailyDiscovery.by_owner_date.filter([owner, discoveryDate])) return row;
  return undefined;
}

function discoveryJobs(ctx: Ctx, owner: Identity) {
  return [...ctx.db.job.owner.filter(owner)].filter(row => row.kind === JOB_KIND.dailyDiscovery);
}

/**
 * A sign saved before a queued Discovery job starts is the one it uses. Running jobs and
 * published sets are left alone, so a day's set never changes once it exists.
 */
export function repointQueuedDiscovery(ctx: Ctx, owner: Identity, zodiacSign: string | undefined) {
  for (const row of discoveryJobs(ctx, owner)) {
    if (row.status !== JOB_STATUS.queued && row.status !== JOB_STATUS.retryWait) continue;
    let date: unknown;
    try {
      date = (JSON.parse(row.payload) as { date?: unknown }).date;
    } catch {
      continue;
    }
    if (typeof date !== 'string') continue;
    const payload = JSON.stringify({ date, zodiac: zodiacSign ?? null });
    if (payload !== row.payload) ctx.db.job.jobId.update({ ...row, payload, updatedAt: ctx.timestamp });
  }
}

/**
 * Asks for today's Discovery set. The caller is `ctx.sender`; no user id is
 * accepted. A set that already exists for this local date is never rebuilt, and
 * an in-flight job is not duplicated. The zodiac sign is read from the caller's
 * own branding row here, not from the client.
 */
export const requestDailyDiscovery = spacetimedb.reducer({ localDate: t.string() }, (ctx, { localDate }) => {
  requireConsumer(ctx);
  requireLocalToday(ctx, localDate);
  if (findDiscovery(ctx, ctx.sender, localDate)) return;

  const jobs = discoveryJobs(ctx, ctx.sender);
  for (const row of jobs) {
    if (!isActiveStatus(row.status)) continue;
    if (row.requestKey.startsWith(`discovery:${localDate}:`)) return;
    if (row.status === JOB_STATUS.running) return; // the client asks again once it settles
    // A queued job for another date (e.g. yesterday, never run) moves to today.
    ctx.db.job.jobId.delete(row.jobId);
  }
  const today = jobs.filter(row => row.requestKey.startsWith(`discovery:${localDate}:`));
  if (today.length >= MAX_JOBS_PER_DAY) throw new SenderError('rate_limited');
  for (const old of jobs.filter(row => !isActiveStatus(row.status) && !row.requestKey.startsWith(`discovery:${localDate}:`))) {
    ctx.db.job.jobId.delete(old.jobId);
  }

  const profile = ctx.db.investmentProfile.owner.find(ctx.sender);
  const branding = ctx.db.profileBranding.owner.find(ctx.sender);
  const payload = JSON.stringify({ date: localDate, zodiac: branding?.zodiacSign ?? null });
  insertJob(
    ctx,
    ctx.sender,
    JOB_KIND.dailyDiscovery,
    `discovery:${localDate}:${today.length + 1}`,
    profile?.profileVersion ?? 0,
    payload
  );
});

const DiscoveryItemInput = t.object('DiscoveryItemInput', {
  ticker: t.string(),
  rank: t.u16(),
  score: t.f64(),
  trendScore: t.option(t.f64()),
  fitScore: t.option(t.f64()),
  newsScore: t.option(t.f64()),
  momentumScore: t.option(t.f64()),
  noveltyScore: t.f64(),
  angle: t.string(),
  about: t.string(),
  reasons: t.array(t.string()),
  newsCount: t.u16(),
  newsHeadline: t.option(t.string()),
  newsSource: t.option(t.string()),
  newsUrl: t.option(t.string()),
  newsPublishedAt: t.option(t.timestamp()),
});

type ItemInput = {
  ticker: string;
  rank: number;
  score: number;
  trendScore?: number;
  fitScore?: number;
  newsScore?: number;
  momentumScore?: number;
  noveltyScore: number;
  angle: string;
  about: string;
  reasons: string[];
  newsCount: number;
  newsHeadline?: string;
  newsSource?: string;
  newsUrl?: string;
  newsPublishedAt?: Timestamp;
};

function text(value: string, max: number, code: string) {
  if (value.trim().length === 0 || value.length > max) throw new SenderError(code);
}

function unit(value: number | undefined) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new SenderError('invalid_score');
}

function payloadOf(raw: string): { date: string; zodiac: string | null } {
  try {
    const parsed = JSON.parse(raw) as { date?: unknown; zodiac?: unknown };
    if (typeof parsed.date !== 'string') throw new Error('date');
    return { date: parsed.date, zodiac: typeof parsed.zodiac === 'string' ? parsed.zodiac : null };
  } catch {
    throw new SenderError('invalid_job_payload');
  }
}

/**
 * Worker: writes one complete Discovery set and completes the job in the same
 * transaction. Everything is validated before anything is written.
 */
export const publishDailyDiscovery = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    discoveryDate: t.string(),
    zodiacSign: t.option(t.string()),
    sectorId: t.string(),
    sectorName: t.string(),
    subthemeId: t.string(),
    title: t.string(),
    description: t.string(),
    algorithmVersion: t.string(),
    themeVersion: t.string(),
    marketGeneration: t.u64(),
    consideredCount: t.u16(),
    eligibleCount: t.u16(),
    items: t.array(DiscoveryItemInput),
  },
  (ctx, args) => {
    requireService(ctx);
    const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (job.kind !== JOB_KIND.dailyDiscovery) throw new SenderError('wrong_job_kind');
    if (!holdsLease) throw new SenderError('lease_mismatch');
    const existing = findDiscovery(ctx, job.owner, args.discoveryDate);
    if (job.status === JOB_STATUS.succeeded) {
      if (existing && existing.jobId === args.jobId) return; // retried identical publish
      throw new SenderError('job_not_running');
    }
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
      throw new SenderError('lease_expired');
    }
    if (existing) throw new SenderError('discovery_exists');

    const payload = payloadOf(job.payload);
    if (payload.date !== args.discoveryDate || !DATE_PATTERN.test(args.discoveryDate)) {
      throw new SenderError('date_mismatch');
    }
    if ((args.zodiacSign ?? null) !== payload.zodiac) throw new SenderError('zodiac_mismatch');
    if (args.zodiacSign !== undefined && !(ZODIAC_SIGNS as readonly string[]).includes(args.zodiacSign)) {
      throw new SenderError('invalid_zodiac_sign');
    }
    if (!ID_PATTERN.test(args.sectorId) || !ID_PATTERN.test(args.subthemeId)) throw new SenderError('invalid_theme');
    text(args.sectorName, 40, 'invalid_theme');
    text(args.title, 48, 'invalid_theme');
    text(args.description, 140, 'invalid_theme');
    if (args.algorithmVersion !== DISCOVERY_ALGORITHM_VERSION) throw new SenderError('unknown_algorithm');
    text(args.themeVersion, 32, 'invalid_theme');
    if (args.items.length < 1 || args.items.length > MAX_ITEMS) throw new SenderError('invalid_item_count');
    if (args.eligibleCount < args.items.length || args.consideredCount < args.eligibleCount) {
      throw new SenderError('invalid_counts');
    }

    const tickers = new Set<string>();
    const ranks = new Set<number>();
    for (const item of args.items as ItemInput[]) {
      if (!TICKER_PATTERN.test(item.ticker) || tickers.has(item.ticker)) throw new SenderError('invalid_ticker');
      const stock = ctx.db.stock.ticker.find(item.ticker);
      if (!stock || !stock.active || stock.kind !== 'equity') throw new SenderError('unknown_ticker');
      tickers.add(item.ticker);
      if (item.rank < 1 || item.rank > args.items.length || ranks.has(item.rank)) throw new SenderError('invalid_rank');
      ranks.add(item.rank);
      for (const value of [item.score, item.trendScore, item.fitScore, item.newsScore, item.momentumScore, item.noveltyScore]) {
        unit(value);
      }
      text(item.angle, 40, 'invalid_text');
      text(item.about, 120, 'invalid_text');
      if (item.reasons.length < 1 || item.reasons.length > MAX_REASONS) throw new SenderError('invalid_reasons');
      for (const reason of item.reasons) text(reason, 90, 'invalid_reasons');
      const news = [item.newsHeadline, item.newsSource, item.newsUrl, item.newsPublishedAt];
      const present = news.filter(value => value !== undefined).length;
      if (present !== 0 && present !== news.length) throw new SenderError('invalid_news');
      if (item.newsHeadline !== undefined) {
        text(item.newsHeadline, 180, 'invalid_news');
        text(item.newsSource ?? '', 80, 'invalid_news');
        if (!(item.newsUrl ?? '').startsWith('https://') || (item.newsUrl ?? '').length > 300) {
          throw new SenderError('invalid_news');
        }
        if (item.newsCount < 1) throw new SenderError('invalid_news');
      }
    }

    // Writes begin only after every check above has passed.
    const discovery = ctx.db.dailyDiscovery.insert({
      id: 0n,
      owner: job.owner,
      discoveryDate: args.discoveryDate,
      zodiacSign: args.zodiacSign,
      sectorId: args.sectorId,
      sectorName: args.sectorName,
      subthemeId: args.subthemeId,
      title: args.title,
      description: args.description,
      algorithmVersion: args.algorithmVersion,
      themeVersion: args.themeVersion,
      marketGeneration: args.marketGeneration,
      consideredCount: args.consideredCount,
      eligibleCount: args.eligibleCount,
      jobId: args.jobId,
      createdAt: ctx.timestamp,
    });
    for (const item of args.items as ItemInput[]) {
      ctx.db.dailyDiscoveryItem.insert({
        id: 0n,
        discoveryId: discovery.id,
        owner: job.owner,
        discoveryDate: args.discoveryDate,
        ticker: item.ticker,
        rank: item.rank,
        score: item.score,
        trendScore: item.trendScore,
        fitScore: item.fitScore,
        newsScore: item.newsScore,
        momentumScore: item.momentumScore,
        noveltyScore: item.noveltyScore,
        angle: item.angle,
        about: item.about,
        reasons: item.reasons,
        newsCount: item.newsCount,
        newsHeadline: item.newsHeadline,
        newsSource: item.newsSource,
        newsUrl: item.newsUrl,
        newsPublishedAt: item.newsPublishedAt,
      });
    }

    const sets = [...ctx.db.dailyDiscovery.owner.filter(job.owner)].sort((a, b) =>
      a.discoveryDate < b.discoveryDate ? 1 : a.discoveryDate > b.discoveryDate ? -1 : 0
    );
    for (const old of sets.slice(RETENTION)) {
      for (const item of [...ctx.db.dailyDiscoveryItem.by_discovery.filter(old.id)]) {
        ctx.db.dailyDiscoveryItem.id.delete(item.id);
      }
      ctx.db.dailyDiscovery.id.delete(old.id);
    }

    notifyDailyDiscoveryReady(ctx, job.owner, args.discoveryDate, args.title, args.items.length);

    ctx.db.job.jobId.update({
      ...job,
      status: JOB_STATUS.succeeded,
      resultRef: `discovery=${discovery.id};date=${args.discoveryDate};theme=${args.subthemeId};count=${args.items.length}`,
      errorCode: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);
