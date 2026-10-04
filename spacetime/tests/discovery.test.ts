/**
 * Daily Discovery: one set per person per local day, published atomically by
 * the worker, readable only by its owner, and never rebuilt the same day.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
function utcDay(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
/** Local dates in use right now span UTC−12 to UTC+14, so these two always differ and are both valid. */
const FIRST_DAY = new Date(Date.now() - 12 * 3_600_000).toISOString().slice(0, 10);
const NEXT_DAY = new Date(Date.now() + 14 * 3_600_000).toISOString().slice(0, 10);

const PREFS = {
  riskTolerance: 'moderate',
  investmentHorizon: 'years',
  investmentStyle: 'growth',
  sectorInterests: ['technology'],
  experienceLevel: 'new',
  primaryGoal: 'learn_basics',
  zodiacSign: 'aquarius',
};

function item(ticker: string, rank: number, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    rank,
    score: 0.72,
    trendScore: 0.6,
    fitScore: 0.8,
    newsScore: undefined,
    momentumScore: 0.55,
    noveltyScore: 1,
    angle: 'AI chips',
    about: 'Designs chips.',
    reasons: ["Part of today's Machines That Think theme"],
    newsCount: 0,
    newsHeadline: undefined,
    newsSource: undefined,
    newsUrl: undefined,
    newsPublishedAt: undefined,
    newsClassification: 'not_configured',
    ...overrides,
  };
}

let user: Session;
let other: Session;
let svc: Session;

function publishArgs(job: { jobId: bigint; attemptCount: number }, date: string, items: ReturnType<typeof item>[]) {
  return {
    jobId: job.jobId,
    attempt: job.attemptCount,
    discoveryDate: date,
    zodiacSign: 'aquarius',
    sectorId: 'ai',
    sectorName: 'Artificial Intelligence',
    subthemeId: 'machines-that-think',
    title: 'Machines That Think',
    description: 'Explore companies building the infrastructure behind modern AI.',
    algorithmVersion: 'discovery-v1.0.0',
    themeVersion: 'themes-v1',
    marketGeneration: 0n,
    consideredCount: 4,
    eligibleCount: 3,
    items,
  };
}

async function claimDiscovery(owner: Session, date: string) {
  const job = await waitFor('discovery job', () =>
    [...svc.conn.db.workerJobs.iter()].find(
      j =>
        j.kind === 'daily_discovery' &&
        j.owner.toHexString() === owner.identityHex &&
        j.requestKey.startsWith(`discovery:${date}:`) &&
        (j.status === 'queued' || j.status === 'retry_wait')
    )
  );
  await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
  return waitFor('leased discovery', () =>
    [...svc.conn.db.workerJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'running')
  );
}

before(async () => {
  user = await connect();
  other = await connect();
  svc = await connect();
  cli('grant_service_identity', `"0x${svc.identityHex}"`, '"discovery-test"');
  await svc.conn.reducers.registerWorker({ kinds: ['daily_discovery'] });
  await subscribe(svc.conn, [
    'SELECT * FROM worker_jobs',
    'SELECT * FROM worker_discovery_history',
    'SELECT * FROM worker_discovery_items',
  ]);
  await subscribe(user.conn, ['SELECT * FROM my_jobs', 'SELECT * FROM my_daily_discovery', 'SELECT * FROM my_discovery_items']);
  await subscribe(other.conn, ['SELECT * FROM my_jobs', 'SELECT * FROM my_daily_discovery', 'SELECT * FROM my_discovery_items']);
  await svc.conn.reducers.upsertStocks({
    stocks: [
      { ticker: 'SPY', name: 'Benchmark', exchange: 'TEST', industry: 'ETF', sector: '', currency: 'USD', kind: 'benchmark', benchmark: '', displayOrder: 0, logoUrl: '' },
      ...['NVDA', 'AMD', 'AVGO', 'ARM'].map((ticker, i) => ({
        ticker, name: `${ticker} Co`, exchange: 'TEST', industry: 'Chips', sector: 'technology', currency: 'USD',
        kind: 'equity', benchmark: 'SPY', displayOrder: i + 1, logoUrl: '',
      })),
    ],
  });
  await user.conn.reducers.completeOnboarding(PREFS);
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

describe('daily discovery', () => {
  test('dates far from today anywhere on Earth are rejected', async () => {
    await rejectsWith(user.conn.reducers.requestDailyDiscovery({ localDate: utcDay(-3) }), 'date_out_of_range');
    await rejectsWith(user.conn.reducers.requestDailyDiscovery({ localDate: utcDay(4) }), 'date_out_of_range');
    await rejectsWith(user.conn.reducers.requestDailyDiscovery({ localDate: '2026-02-30' }), 'invalid_date');
  });

  test('repeated requests on one day queue one job carrying the stored zodiac sign', async () => {
    const today = FIRST_DAY;
    await user.conn.reducers.requestDailyDiscovery({ localDate: today });
    await user.conn.reducers.requestDailyDiscovery({ localDate: today });
    const jobs = await waitFor('one job', () => {
      const rows = [...user.conn.db.myJobs.iter()].filter(j => j.kind === 'daily_discovery');
      return rows.length > 0 ? rows : undefined;
    });
    assert.equal(jobs.length, 1);
    assert.deepEqual(JSON.parse(jobs[0]!.payload), { date: today, zodiac: 'aquarius' });
  });

  test('a consumer cannot publish, and an invalid set writes nothing', async () => {
    const today = FIRST_DAY;
    const job = await claimDiscovery(user, today);
    await rejectsWith(
      user.conn.reducers.publishDailyDiscovery(publishArgs(job, today, [item('NVDA', 1)])),
      'not_authorized_service'
    );
    await rejectsWith(
      svc.conn.reducers.publishDailyDiscovery(publishArgs(job, today, [item('NVDA', 1), item('NOPE', 2)])),
      'unknown_ticker'
    );
    await rejectsWith(
      svc.conn.reducers.publishDailyDiscovery(publishArgs(job, today, [item('NVDA', 1, { score: 1.5 })])),
      'invalid_score'
    );
    await rejectsWith(
      svc.conn.reducers.publishDailyDiscovery({ ...publishArgs(job, today, [item('NVDA', 1)]), zodiacSign: 'leo' }),
      'zodiac_mismatch'
    );
    await rejectsWith(
      svc.conn.reducers.publishDailyDiscovery(
        publishArgs(job, today, [item('NVDA', 1, { newsHeadline: 'Only a headline', newsCount: 1 })])
      ),
      'invalid_news'
    );
    await rejectsWith(
      svc.conn.reducers.publishDailyDiscovery(
        publishArgs(job, today, [item('NVDA', 1, { newsClassification: 'unavailable:Not A Code' })])
      ),
      'invalid_news_classification'
    );
    assert.equal([...user.conn.db.myDailyDiscovery.iter()].length, 0);
    assert.equal([...user.conn.db.myDiscoveryItems.iter()].length, 0);

    await svc.conn.reducers.publishDailyDiscovery(
      publishArgs(job, today, [
        item('NVDA', 1, { newsClassification: 'classified' }),
        item('AMD', 2, { angle: 'AI chips', newsClassification: 'unavailable:auth_failed' }),
        item('AVGO', 3, { angle: 'AI networking', newsClassification: 'partial:rate_limited' }),
      ])
    );
    const set = await waitFor('published set', () => [...user.conn.db.myDailyDiscovery.iter()][0]);
    assert.equal(set.discoveryDate, today);
    assert.equal(set.title, 'Machines That Think');
    const items = await waitFor('items', () => {
      const rows = [...user.conn.db.myDiscoveryItems.iter()];
      return rows.length === 3 ? rows : undefined;
    });
    assert.deepEqual(items.map(i => i.ticker).sort(), ['AMD', 'AVGO', 'NVDA']);
    assert.deepEqual(
      Object.fromEntries(items.map(i => [i.ticker, i.newsClassification])),
      { NVDA: 'classified', AMD: 'unavailable:auth_failed', AVGO: 'partial:rate_limited' }
    );
    const done = await waitFor('job done', () =>
      [...user.conn.db.myJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'succeeded')
    );
    assert.match(done.resultRef ?? '', /theme=machines-that-think/);
  });

  test('the same day is never rebuilt, and another person sees nothing', async () => {
    const today = FIRST_DAY;
    const before = [...user.conn.db.myJobs.iter()].filter(j => j.kind === 'daily_discovery').length;
    await user.conn.reducers.requestDailyDiscovery({ localDate: today });
    await new Promise(r => setTimeout(r, 200));
    assert.equal([...user.conn.db.myJobs.iter()].filter(j => j.kind === 'daily_discovery').length, before);
    assert.equal([...user.conn.db.myDailyDiscovery.iter()][0]?.discoveryDate, today);
    assert.equal([...other.conn.db.myDailyDiscovery.iter()].length, 0);
    assert.equal([...other.conn.db.myDiscoveryItems.iter()].length, 0);
  });

  test('the next local day gets a new set, and the worker sees only the leased owner history', async () => {
    const tomorrow = NEXT_DAY;
    await user.conn.reducers.requestDailyDiscovery({ localDate: tomorrow });
    const job = await claimDiscovery(user, tomorrow);
    const history = await waitFor('history', () => {
      const rows = [...svc.conn.db.workerDiscoveryHistory.iter()];
      return rows.length > 0 ? rows : undefined;
    });
    assert.ok(history.every(row => row.owner.toHexString() === user.identityHex));
    assert.equal([...svc.conn.db.workerDiscoveryItems.iter()].length, 3);

    await svc.conn.reducers.publishDailyDiscovery({
      ...publishArgs(job, tomorrow, [item('ARM', 1, { angle: 'Chip blueprints' }), item('AMD', 2)]),
      subthemeId: 'tiny-chips-big-world',
      title: 'Tiny Chips, Big World',
      sectorId: 'semiconductors',
      sectorName: 'Semiconductors',
    });
    const latest = await waitFor('latest set', () =>
      [...user.conn.db.myDailyDiscovery.iter()].find(row => row.discoveryDate === tomorrow)
    );
    assert.equal(latest.subthemeId, 'tiny-chips-big-world');
    const items = await waitFor('latest items', () => {
      const rows = [...user.conn.db.myDiscoveryItems.iter()];
      return rows.length === 2 ? rows : undefined;
    });
    assert.deepEqual(items.map(i => i.ticker), ['ARM', 'AMD']);
  });

  test('a sign saved before the job starts is the sign it uses', async () => {
    await other.conn.reducers.completeOnboarding({ ...PREFS, zodiacSign: undefined });
    await other.conn.reducers.requestDailyDiscovery({ localDate: FIRST_DAY });
    const queued = await waitFor('queued job', () =>
      [...other.conn.db.myJobs.iter()].find(j => j.kind === 'daily_discovery' && j.status === 'queued')
    );
    assert.deepEqual(JSON.parse(queued.payload), { date: FIRST_DAY, zodiac: null });
    await other.conn.reducers.updatePreferences({ expectedVersion: 1, ...PREFS, zodiacSign: 'pisces' });
    const moved = await waitFor('re-pointed job', () => {
      const row = [...other.conn.db.myJobs.iter()].find(j => j.jobId === queued.jobId);
      return row && JSON.parse(row.payload).zodiac === 'pisces' ? row : undefined;
    });
    assert.equal(JSON.parse(moved.payload).date, FIRST_DAY);
  });
});
