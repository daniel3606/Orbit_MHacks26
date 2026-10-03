/**
 * Recommendation publication: one generation per transaction, owner isolation,
 * and rejection of stale profiles without hiding the previous generation.
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

const LIMITS = ['horizon_not_scored', 'style_not_classified', 'price_volume_only'];
const PREFS = {
  riskTolerance: 'moderate',
  investmentHorizon: 'years',
  investmentStyle: 'growth',
  sectorInterests: ['technology'],
  experienceLevel: 'new',
  primaryGoal: 'learn_basics',
  zodiacSign: 'leo',
};

function item(ticker: string, overrides: Record<string, unknown> = {}) {
  const trendScore = 40;
  const fitScore = 100;
  return {
    ticker,
    displayRank: 1,
    trendScore,
    fitScore,
    recommendationRank: 0.6 * trendScore + 0.4 * fitScore,
    fitCoverage: 0.5,
    components: [
      { name: 'risk_match', available: true, value: 1, weight: 0.4, reason: 'within_risk_limit' },
      { name: 'horizon_match', available: false, value: undefined, weight: 0.3, reason: 'horizon_not_scored' },
      { name: 'style_match', available: false, value: undefined, weight: 0.2, reason: 'style_not_classified' },
      { name: 'sector_preference', available: true, value: 1, weight: 0.1, reason: 'sector_selected' },
    ],
    realizedVol: 0.01,
    maxDrawdown: -0.05,
    volSessions: 21,
    drawdownSessions: 21,
    sector: 'technology',
    benchmark: 'SPY',
    sessionDate: '2026-10-02',
    historySource: 'alpaca_sip',
    matchReason: `${ticker} is in technology, one of the sectors you chose. Its recent day-to-day price swings are inside the balanced limit you set.`,
    marketActivity: 'Through October 2, 2026, the Trend Score is 40 out of 100. It is not a chance of making money.',
    riskObservation: 'Over the last 21 trading days, a typical daily move was about 1.0%.',
    learningNote: 'You said you want to learn the basics, so the notes stay in everyday words.',
    limitations: [
      'Trend analysis uses completed daily prices and volume only. News is not included.',
      'Time horizon was not scored. A recent trend does not show whether a stock fits weeks, months, or years.',
      'Growth, value, and income were not scored. Orbit does not have the fundamentals that would support those labels.',
    ],
    ...overrides,
  };
}

let user: Session;
let other: Session;
let svc: Session;
let marketGeneration: bigint;

async function claimRefresh(owner: Session) {
  const job = await waitFor('refresh job', () =>
    [...svc.conn.db.workerJobs.iter()].find(
      j =>
        j.kind === 'refresh_recommendations' &&
        j.owner.toHexString() === owner.identityHex &&
        (j.status === 'queued' || j.status === 'retry_wait')
    )
  );
  await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
  const leased = await waitFor('leased refresh', () =>
    [...svc.conn.db.workerJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'running')
  );
  return leased;
}

before(async () => {
  user = await connect();
  other = await connect();
  svc = await connect();
  cli('grant_service_identity', `"0x${svc.identityHex}"`, '"rec-test"');
  await svc.conn.reducers.registerWorker({ kinds: ['ingest_market', 'refresh_recommendations'] });
  await subscribe(svc.conn, ['SELECT * FROM worker_jobs', 'SELECT * FROM worker_job_profiles']);
  await subscribe(user.conn, [
    'SELECT * FROM my_profile',
    'SELECT * FROM my_jobs',
    'SELECT * FROM my_recommendations',
    'SELECT * FROM my_recommendation_generation',
  ]);
  await subscribe(other.conn, ['SELECT * FROM my_recommendations', 'SELECT * FROM my_recommendation_generation']);
  await svc.conn.reducers.upsertStocks({
    stocks: [
      { ticker: 'SPY', name: 'Benchmark', exchange: 'TEST', industry: 'ETF', sector: '', currency: 'USD', kind: 'benchmark', benchmark: '', displayOrder: 0 },
      { ticker: 'REC', name: 'Rec Co', exchange: 'TEST', industry: 'Software', sector: 'technology', currency: 'USD', kind: 'equity', benchmark: 'SPY', displayOrder: 1 },
      { ticker: 'ALT', name: 'Alt Co', exchange: 'TEST', industry: 'Software', sector: 'technology', currency: 'USD', kind: 'equity', benchmark: 'SPY', displayOrder: 2 },
    ],
  });
  await svc.conn.reducers.requestMarketIngest({});
  const ingest = await waitFor('ingest job', () =>
    [...svc.conn.db.workerJobs.iter()].find(j => j.kind === 'ingest_market' && j.status === 'queued')
  );
  await svc.conn.reducers.claimJob({ jobId: ingest.jobId, leaseSeconds: 60 });
  const leased = await waitFor('ingest lease', () =>
    [...svc.conn.db.workerJobs.iter()].find(j => j.jobId === ingest.jobId && j.status === 'running')
  );
  marketGeneration = BigInt(Date.now() + 5_000) * 1000n;
  const at = new Timestamp(marketGeneration);
  await svc.conn.reducers.publishMarketSnapshot({
    jobId: leased.jobId,
    attempt: leased.attemptCount,
    generation: marketGeneration,
    asOf: at,
    algorithmVersion: 'trend-v1.0.0',
    provider: 'finnhub',
    marketOpen: false,
    marketSession: 'closed',
    marketStatusAt: at,
    lastCompletedSession: '2026-10-02',
    quotes: [],
    bars: [],
    signals: [],
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

describe('recommendation publication', () => {
  test('a partial batch is rejected and nothing is stored', async () => {
    await user.conn.reducers.completeOnboarding(PREFS);
    const active = () => [...user.conn.db.myJobs.iter()].filter(j => j.kind === 'refresh_recommendations' && j.status === 'queued');
    await waitFor('queued refresh', () => (active().length === 1 ? true : undefined));
    await user.conn.reducers.requestRecommendations({});
    await user.conn.reducers.requestRecommendations({});
    assert.equal(active().length, 1);

    const job = await claimRefresh(user);
    const profile = await waitFor('leased profile', () =>
      [...svc.conn.db.workerJobProfiles.iter()].find(p => p.owner.toHexString() === user.identityHex)
    );
    assert.equal('zodiacSign' in profile, false);

    await rejectsWith(
      svc.conn.reducers.publishRecommendations({
        jobId: job.jobId,
        attempt: job.attemptCount,
        generation: marketGeneration + 1n,
        profileVersion: 1,
        marketGeneration,
        signalAlgorithmVersion: 'trend-v1.0.0',
        fitAlgorithmVersion: 'fit-v1.0.0',
        signalSessionDate: '2026-10-02',
        status: 'ready',
        consideredCount: 2,
        eligibleCount: 2,
        summary: 'Two names that stayed inside your risk limit.',
        limitations: LIMITS,
        items: [item('REC'), item('NOPE', { displayRank: 2 })],
      }),
      'unknown_ticker'
    );
    assert.equal([...user.conn.db.myRecommendations.iter()].length, 0);
    assert.equal([...user.conn.db.myRecommendationGeneration.iter()].length, 0);

    await svc.conn.reducers.publishRecommendations({
      jobId: job.jobId,
      attempt: job.attemptCount,
      generation: marketGeneration + 1n,
      profileVersion: 1,
      marketGeneration,
      signalAlgorithmVersion: 'trend-v1.0.0',
      fitAlgorithmVersion: 'fit-v1.0.0',
      signalSessionDate: '2026-10-02',
      status: 'ready',
      consideredCount: 1,
      eligibleCount: 1,
      summary: '1 stock that stayed inside your risk limit, ranked from recent market activity and the sectors you saved.',
      limitations: LIMITS,
      items: [item('REC')],
    });
    const row = await waitFor('recommendation', () => [...user.conn.db.myRecommendations.iter()][0]);
    assert.equal(row.ticker, 'REC');
    assert.equal(row.displayRank, 1);
    const generation = [...user.conn.db.myRecommendationGeneration.iter()][0];
    assert.equal(generation.status, 'ready');
    assert.equal(generation.profileVersion, 1);
    assert.equal(generation.publishedCount, 1);
    assert.equal([...other.conn.db.myRecommendations.iter()].length, 0);
    await rejectsWith(subscribe(other.conn, ['SELECT * FROM recommendation']), '.');
    await rejectsWith(
      user.conn.reducers.publishRecommendations({
        jobId: job.jobId,
        attempt: job.attemptCount,
        generation: marketGeneration + 2n,
        profileVersion: 1,
        marketGeneration,
        signalAlgorithmVersion: 'trend-v1.0.0',
        fitAlgorithmVersion: 'fit-v1.0.0',
        signalSessionDate: '2026-10-02',
        status: 'no_eligible',
        consideredCount: 1,
        eligibleCount: 0,
        summary: 'None.',
        limitations: LIMITS,
        items: [],
      }),
      'not_authorized_service'
    );
  });

  test('a stale profile cannot replace the visible generation', async () => {
    await user.conn.reducers.updatePreferences({ ...PREFS, expectedVersion: 1, riskTolerance: 'conservative' });
    const previous = [...user.conn.db.myRecommendations.iter()][0];
    assert.equal(previous.ticker, 'REC');
    const job = await claimRefresh(user);
    await rejectsWith(
      svc.conn.reducers.publishRecommendations({
        jobId: job.jobId,
        attempt: job.attemptCount,
        generation: marketGeneration + 3n,
        profileVersion: 1,
        marketGeneration,
        signalAlgorithmVersion: 'trend-v1.0.0',
        fitAlgorithmVersion: 'fit-v1.0.0',
        signalSessionDate: '2026-10-02',
        status: 'no_eligible',
        consideredCount: 1,
        eligibleCount: 0,
        summary: 'No stock with a published Trend Score stays inside the risk limit you set. The list is empty on purpose. That limit was not relaxed.',
        limitations: LIMITS,
        items: [],
      }),
      'stale_profile_version'
    );
    assert.equal([...user.conn.db.myRecommendations.iter()][0].ticker, 'REC');

    await svc.conn.reducers.publishRecommendations({
      jobId: job.jobId,
      attempt: job.attemptCount,
      generation: marketGeneration + 4n,
      profileVersion: 2,
      marketGeneration,
      signalAlgorithmVersion: 'trend-v1.0.0',
      fitAlgorithmVersion: 'fit-v1.0.0',
      signalSessionDate: '2026-10-02',
      status: 'no_eligible',
      consideredCount: 1,
      eligibleCount: 0,
      summary: 'No stock with a published Trend Score stays inside the risk limit you set. The list is empty on purpose. That limit was not relaxed.',
      limitations: LIMITS,
      items: [],
    });
    await waitFor('empty generation', () => {
      const generation = [...user.conn.db.myRecommendationGeneration.iter()][0];
      return generation?.status === 'no_eligible' ? generation : undefined;
    });
    assert.equal([...user.conn.db.myRecommendations.iter()].length, 0);
    assert.equal([...other.conn.db.myRecommendations.iter()].length, 0);
  });
});
