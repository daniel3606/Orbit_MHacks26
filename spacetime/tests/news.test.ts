/**
 * Jev news classifications: written only by an allowlisted worker under its
 * lease on a news-reading job, validated before any write, idempotent per key,
 * and readable only through the service-gated view.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.ts';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'orbit-test';
const SPACETIME = process.env.SPACETIME_BIN ?? 'spacetime';

type Session = { conn: DbConnection; identityHex: string };
const open: DbConnection[] = [];

function connect(): Promise<Session> {
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withCompression('none')
      .onConnect((_c, identity) => resolve({ conn, identityHex: identity.toHexString() }))
      .onConnectError((_c, err) => reject(err))
      .build();
    open.push(conn);
  });
}
function subscribe(conn: DbConnection, queries: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => resolve())
      .onError(ctx => reject(ctx.event ?? new Error('subscription error')))
      .subscribe(queries);
  });
}
async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 8000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = probe();
    if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (err: Error) => {
    assert.match(String(err?.message ?? err), new RegExp(code));
    return true;
  });
}
function cli(...args: string[]) {
  execFileSync(SPACETIME, ['call', '--no-config', DB, '--server', 'local', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const TODAY = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
const HEX = (seed: string) => seed.repeat(64).slice(0, 64);

function row(key: string, overrides: Record<string, unknown> = {}) {
  return {
    cacheKey: HEX(key),
    ticker: 'NVDA',
    articleId: `news:NVDA:${key}`,
    contentHash: HEX('c'),
    classifierVersion: 'jev-news-v1:typesafe/jev-1.13',
    relevant: true,
    relevanceScore: 0.93,
    eventType: 'earnings',
    sentiment: 'positive',
    materiality: 'high',
    keep: true,
    publishedAt: Timestamp.now(),
    ...overrides,
  };
}

let user: Session;
let svc: Session;
let rival: Session;

async function claim(kind: string, owner: Session, worker: Session) {
  const job = await waitFor(`${kind} job`, () =>
    [...worker.conn.db.workerJobs.iter()].find(
      j => j.kind === kind && j.owner.toHexString() === owner.identityHex && j.status === 'queued'
    )
  );
  await worker.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
  return waitFor('leased job', () =>
    [...worker.conn.db.workerJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'running')
  );
}

const stored = () => [...svc.conn.db.workerNewsClassifications.iter()];

before(async () => {
  user = await connect();
  svc = await connect();
  rival = await connect();
  cli('grant_service_identity', `"0x${svc.identityHex}"`, '"news-test"');
  cli('grant_service_identity', `"0x${rival.identityHex}"`, '"news-test-rival"');
  await svc.conn.reducers.registerWorker({ kinds: ['daily_discovery', 'backend_check'] });
  await rival.conn.reducers.registerWorker({ kinds: ['daily_discovery'] });
  await subscribe(svc.conn, ['SELECT * FROM worker_jobs', 'SELECT * FROM worker_news_classifications']);
  await subscribe(rival.conn, ['SELECT * FROM worker_jobs']);
  await subscribe(user.conn, ['SELECT * FROM my_jobs', 'SELECT * FROM worker_news_classifications']);
  await svc.conn.reducers.upsertStocks({
    stocks: [
      { ticker: 'SPY', name: 'Benchmark', exchange: 'TEST', industry: 'ETF', sector: '', currency: 'USD', kind: 'benchmark', benchmark: '', displayOrder: 0, logoUrl: '' },
      { ticker: 'NVDA', name: 'NVDA Co', exchange: 'TEST', industry: 'Chips', sector: 'technology', currency: 'USD', kind: 'equity', benchmark: 'SPY', displayOrder: 1, logoUrl: '' },
    ],
  });
  await user.conn.reducers.completeOnboarding({
    riskTolerance: 'moderate',
    investmentHorizon: 'years',
    investmentStyle: 'growth',
    sectorInterests: ['technology'],
    experienceLevel: 'new',
    primaryGoal: 'learn_basics',
    zodiacSign: undefined,
  });
});

after(() => {
  for (const conn of open) {
    try {
      conn.disconnect();
    } catch {
      /* closed */
    }
  }
});

describe('news classifications', () => {
  test('only the leaseholder of a news-reading job can record, and bad rows write nothing', async () => {
    await user.conn.reducers.requestDailyDiscovery({ localDate: TODAY });
    const job = await claim('daily_discovery', user, svc);
    const args = (rows: ReturnType<typeof row>[]) => ({ jobId: job.jobId, attempt: job.attemptCount, rows });

    await rejectsWith(user.conn.reducers.recordNewsClassifications(args([row('a')])), 'not_authorized_service');
    await rejectsWith(rival.conn.reducers.recordNewsClassifications(args([row('a')])), 'lease_mismatch');
    await rejectsWith(
      svc.conn.reducers.recordNewsClassifications({ ...args([row('a')]), attempt: job.attemptCount + 1 }),
      'lease_mismatch'
    );
    for (const [overrides, code] of [
      [{ sentiment: 'bullish' }, 'invalid_sentiment'],
      [{ eventType: 'ipo' }, 'invalid_event_type'],
      [{ materiality: 'huge' }, 'invalid_materiality'],
      [{ relevanceScore: 1.2 }, 'invalid_relevance'],
      [{ relevant: false, keep: true }, 'keep_requires_relevant'],
      [{ ticker: 'NOPE' }, 'unknown_ticker'],
      [{ cacheKey: 'short' }, 'invalid_cache_key'],
      [{ classifierVersion: 'has spaces' }, 'invalid_classifier_version'],
      [{ publishedAt: new Timestamp(Timestamp.now().microsSinceUnixEpoch + 3_600_000_000n) }, 'future_timestamp'],
    ] as const) {
      await rejectsWith(svc.conn.reducers.recordNewsClassifications(args([row('a'), row('b', overrides)])), code);
    }
    await rejectsWith(svc.conn.reducers.recordNewsClassifications(args([])), 'invalid_row_count');
    await new Promise(r => setTimeout(r, 150));
    assert.equal(stored().length, 0);

    await svc.conn.reducers.recordNewsClassifications(
      args([row('a'), row('b', { relevant: false, relevanceScore: 0.1, keep: false, sentiment: 'neutral', eventType: 'other' })])
    );
    const rows = await waitFor('stored rows', () => (stored().length === 2 ? stored() : undefined));
    const a = rows.find(r => r.cacheKey === HEX('a'))!;
    assert.equal(a.jobId, job.jobId);
    assert.equal(a.sentiment, 'positive');

    // A retried call keeps the first judgment for an existing key.
    await svc.conn.reducers.recordNewsClassifications(args([row('a', { sentiment: 'negative' })]));
    await new Promise(r => setTimeout(r, 150));
    assert.equal(stored().find(r => r.cacheKey === HEX('a'))?.sentiment, 'positive');
    assert.equal(stored().length, 2);

    // Consumers can subscribe to the view but never see rows.
    assert.equal([...user.conn.db.workerNewsClassifications.iter()].length, 0);
  });

  test('jobs that do not read news cannot record, and a finished job cannot either', async () => {
    await user.conn.reducers.requestBackendCheck({ requestKey: 'news-test-check' });
    const check = await claim('backend_check', user, svc);
    await rejectsWith(
      svc.conn.reducers.recordNewsClassifications({ jobId: check.jobId, attempt: check.attemptCount, rows: [row('d')] }),
      'wrong_job_kind'
    );

    const discovery = [...svc.conn.db.workerJobs.iter()].find(j => j.kind === 'daily_discovery' && j.status === 'running')!;
    await svc.conn.reducers.failJob({ jobId: discovery.jobId, attempt: discovery.attemptCount, errorCode: 'test_done', retryable: false });
    await rejectsWith(
      svc.conn.reducers.recordNewsClassifications({ jobId: discovery.jobId, attempt: discovery.attemptCount, rows: [row('e')] }),
      'job_not_running'
    );
  });
});
