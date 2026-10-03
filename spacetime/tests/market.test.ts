/**
 * Market publication tests against a real local SpacetimeDB (orbit-test).
 * Values are FIXTURES; the final test runs the real Python worker/handler/
 * gateway with the labeled fixture provider.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.ts';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'orbit-test';
const SPACETIME = process.env.SPACETIME_BIN ?? 'spacetime';
const BACKEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../backend');

type Session = { conn: DbConnection; identityHex: string; token: string };
const open: DbConnection[] = [];

function connect(): Promise<Session> {
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withCompression('none')
      .onConnect((_c, identity, token) => resolve({ conn, identityHex: identity.toHexString(), token }))
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
    const v = probe();
    if (v !== undefined) return v;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}
async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: Error) => {
    assert.match(String(err?.message ?? err), new RegExp(code));
    return true;
  });
}
function cli(...args: string[]) {
  return execFileSync(SPACETIME, ['call', '--no-config', DB, '--server', 'local', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const nowMicros = () => BigInt(Date.now()) * 1000n;
const ts = (micros: bigint) => new Timestamp(micros);
const SESSION_CLOSE = 1790971200n * 1_000_000n; // 2026-10-02 16:00 ET

function quote(ticker: string, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    priceMicros: 100_000_000n,
    previousCloseMicros: 99_000_000n,
    openMicros: 99_500_000n,
    highMicros: 101_000_000n,
    lowMicros: 98_000_000n,
    providerTime: ts(SESSION_CLOSE),
    ingestedAt: ts(nowMicros()),
    source: 'finnhub',
    ...overrides,
  };
}
function signal(ticker: string, overrides: Record<string, unknown> = {}) {
  return {
    ticker,
    sessionDate: '2026-10-02',
    status: 'insufficient_data',
    trendScore: undefined,
    composite: undefined,
    coverage: 0,
    coverageScope: 'price_volume',
    benchmark: 'SPY',
    historySessions: 2,
    requiredSessions: 81,
    dayReturn: 0.0101,
    benchmarkDayReturn: 0.005,
    relativeDayReturn: 0.0051,
    features: [
      {
        name: 'relative_momentum',
        available: false,
        raw: undefined,
        normalized: undefined,
        weight: 0.25,
        sampleCount: 2,
        baselineCount: 0,
        reason: 'insufficient_history:2/21',
      },
    ],
    notes: [],
    ...overrides,
  };
}

let user: Session;
let svc: Session;
let svc2: Session;

function snapshot(jobId: bigint, attempt: number, generation: bigint, parts: Record<string, unknown> = {}) {
  return {
    jobId,
    attempt,
    generation,
    asOf: ts(generation),
    algorithmVersion: 'trend-v1.0.0',
    provider: 'finnhub',
    marketOpen: false,
    marketSession: 'closed',
    marketStatusAt: ts(nowMicros()),
    lastCompletedSession: '2026-10-02',
    quotes: [quote('AAA')],
    bars: [],
    signals: [signal('AAA')],
    ...parts,
  };
}

/** Request (or join) the shared ingestion job and lease it as `who`. */
async function lease(who: Session) {
  await svc.conn.reducers.requestMarketIngest({});
  const job = await waitFor('ingest job', () =>
    [...who.conn.db.workerJobs.iter()].find(
      j => j.kind === 'ingest_market' && (j.status === 'queued' || j.status === 'retry_wait')
    )
  );
  await who.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
  const leased = await waitFor('lease', () =>
    [...who.conn.db.workerJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'running')
  );
  return { jobId: leased.jobId, attempt: leased.attemptCount };
}
async function release(who: Session, job: { jobId: bigint; attempt: number }) {
  const row = [...who.conn.db.workerJobs.iter()].find(j => j.jobId === job.jobId);
  if (row?.status === 'running') {
    await who.conn.reducers.failJob({ jobId: job.jobId, attempt: job.attempt, errorCode: 'test_release', retryable: false });
  }
}

before(async () => {
  user = await connect();
  svc = await connect();
  svc2 = await connect();
  cli('grant_service_identity', `"0x${svc.identityHex}"`, '"market-test-1"');
  cli('grant_service_identity', `"0x${svc2.identityHex}"`, '"market-test-2"');
  cli('set_service_flag', '"allow_fixture_data"', 'false');
  await svc.conn.reducers.registerWorker({ kinds: ['ingest_market'] });
  await svc2.conn.reducers.registerWorker({ kinds: ['ingest_market'] });
  await subscribe(svc.conn, ['SELECT * FROM worker_jobs']);
  await subscribe(svc2.conn, ['SELECT * FROM worker_jobs']);
  await subscribe(user.conn, [
    'SELECT * FROM stock',
    'SELECT * FROM market_quote',
    'SELECT * FROM trend_signal',
    'SELECT * FROM market_generation',
    'SELECT * FROM provider_capability',
  ]);
  const base = { exchange: 'TEST', industry: 'Test', currency: 'USD' };
  await svc.conn.reducers.upsertStocks({
    stocks: [
      { ...base, ticker: 'SPY', name: 'Benchmark (fixture)', sector: '', kind: 'benchmark', benchmark: '', displayOrder: 1 },
      { ...base, ticker: 'AAA', name: 'Equity (fixture)', sector: 'technology', kind: 'equity', benchmark: 'SPY', displayOrder: 0 },
    ],
  });
});

after(() => {
  for (const c of open) {
    try {
      c.disconnect();
    } catch {
      /* closed */
    }
  }
});

describe('market publication authorization', () => {
  test('consumers cannot publish or administer market data', async () => {
    const r = user.conn.reducers;
    await rejectsWith(r.upsertStocks({ stocks: [] }), 'not_authorized_service');
    await rejectsWith(
      r.publishProviderCapabilities({ capabilities: [{ key: 'x.quote', provider: 'x', capability: 'q', available: true, detail: '' }] }),
      'not_authorized_service'
    );
    await rejectsWith(r.publishMarketSnapshot(snapshot(1n, 1, nowMicros())), 'not_authorized_service');
    await rejectsWith(r.requestMarketIngest({}), 'not_authorized_service');
    await rejectsWith(r.registerWorker({ kinds: ['ingest_market'] }), 'not_authorized_service');
    await rejectsWith(r.configureMarketSchedule({ intervalSeconds: 60 }), 'not_authorized_admin');
    await rejectsWith(r.setServiceFlag({ key: 'allow_fixture_data', value: true }), 'not_authorized_admin');
  });

  test('consumers see shared projections but no private market tables', async () => {
    assert.ok([...user.conn.db.stock.iter()].some(s => s.ticker === 'AAA'));
    await rejectsWith(subscribe(user.conn, ['SELECT * FROM daily_bar']), '.');
  });

  test('a service without the job lease cannot publish', async () => {
    const job = await lease(svc);
    await rejectsWith(svc2.conn.reducers.publishMarketSnapshot(snapshot(job.jobId, job.attempt, nowMicros())), 'lease_mismatch');
    await rejectsWith(svc.conn.reducers.publishMarketSnapshot(snapshot(job.jobId, job.attempt + 1, nowMicros())), 'lease_mismatch');
    await release(svc, job);
  });
});

describe('versioned snapshot publication', () => {
  let firstGeneration: bigint;

  test('a valid snapshot reaches subscribed consumers atomically and completes the job', async () => {
    const job = await lease(svc);
    firstGeneration = nowMicros();
    const args = snapshot(job.jobId, job.attempt, firstGeneration, {
      bars: [
        { ticker: 'AAA', sessionDate: '2026-10-01', openMicros: undefined, highMicros: undefined, lowMicros: undefined, closeMicros: 99_000_000n, volume: undefined, adjusted: false, source: 'finnhub_quote' },
      ],
    });
    await svc.conn.reducers.publishMarketSnapshot(args);
    const q = await waitFor('quote', () => [...user.conn.db.marketQuote.iter()].find(r => r.ticker === 'AAA'));
    assert.equal(q.priceMicros, 100_000_000n);
    assert.equal(q.providerTime.microsSinceUnixEpoch, SESSION_CLOSE);
    const s = await waitFor('signal', () => [...user.conn.db.trendSignal.iter()].find(r => r.ticker === 'AAA'));
    assert.equal(s.status, 'insufficient_data');
    assert.equal(s.trendScore, undefined);
    const g = [...user.conn.db.marketGeneration.iter()][0];
    assert.equal(g.generation, firstGeneration);
    assert.equal(g.jobId, job.jobId);
    await waitFor('job no longer offered', () =>
      [...svc.conn.db.workerJobs.iter()].some(j => j.jobId === job.jobId) ? undefined : true
    );

    // Stored bars are private: the service view returns them, consumers get nothing.
    await subscribe(svc.conn, ['SELECT * FROM worker_daily_bars']);
    await subscribe(user.conn, ['SELECT * FROM worker_daily_bars']);
    assert.ok([...svc.conn.db.workerDailyBars.iter()].some(b => b.ticker === 'AAA' && b.sessionDate === '2026-10-01'));
    assert.equal(user.conn.db.workerDailyBars.count(), 0n);

    await subscribe(user.conn, ['SELECT * FROM market_closes']);
    const close = [...user.conn.db.marketCloses.iter()].find(b => b.ticker === 'AAA');
    assert.ok(close);
    assert.equal(close.closeMicros, 99_000_000n);

    // A retried identical publish is a no-op.
    await svc.conn.reducers.publishMarketSnapshot(args);
    assert.equal([...user.conn.db.marketGeneration.iter()][0].generation, firstGeneration);
  });

  test('older or equal generations are rejected', async () => {
    const job = await lease(svc);
    await rejectsWith(svc.conn.reducers.publishMarketSnapshot(snapshot(job.jobId, job.attempt, firstGeneration)), 'stale_generation');
    await rejectsWith(svc.conn.reducers.publishMarketSnapshot(snapshot(job.jobId, job.attempt, firstGeneration - 1n)), 'stale_generation');
    await release(svc, job);
  });

  test('an out-of-order quote rejects the whole snapshot (nothing partially written)', async () => {
    const job = await lease(svc);
    const before = [...user.conn.db.marketQuote.iter()].find(r => r.ticker === 'AAA')!;
    const older = quote('AAA', { providerTime: ts(SESSION_CLOSE - 86_400_000_000n), priceMicros: 1n });
    await rejectsWith(
      svc.conn.reducers.publishMarketSnapshot(
        snapshot(job.jobId, job.attempt, nowMicros(), { quotes: [quote('SPY'), older], signals: [] })
      ),
      'out_of_order_quote'
    );
    await new Promise(r => setTimeout(r, 150));
    assert.equal([...user.conn.db.marketQuote.iter()].find(r => r.ticker === 'AAA')!.priceMicros, before.priceMicros);
    assert.equal([...user.conn.db.marketQuote.iter()].some(r => r.ticker === 'SPY'), false);
    assert.equal([...user.conn.db.marketGeneration.iter()][0].generation, firstGeneration);
    await release(svc, job);
  });

  test('invalid values are rejected', async () => {
    const job = await lease(svc);
    const pub = (parts: Record<string, unknown>) =>
      svc.conn.reducers.publishMarketSnapshot(snapshot(job.jobId, job.attempt, nowMicros(), parts));
    await rejectsWith(pub({ quotes: [quote('AAA', { providerTime: ts(nowMicros() + 3_600_000_000n) })] }), 'future_timestamp');
    await rejectsWith(pub({ quotes: [quote('AAA', { priceMicros: 0n })] }), 'invalid_price');
    await rejectsWith(pub({ quotes: [quote('ZZZ')] }), 'unknown_ticker');
    await rejectsWith(pub({ quotes: [quote('AAA'), quote('AAA')] }), 'duplicate_ticker');
    await rejectsWith(pub({ signals: [signal('AAA', { trendScore: 71 })] }), 'score_status_mismatch');
    await rejectsWith(pub({ signals: [signal('AAA', { status: 'published', trendScore: 140, coverage: 0.55 })] }), 'invalid_score');
    await rejectsWith(pub({ signals: [signal('AAA', { coverage: 1.5 })] }), 'invalid_coverage');
    await rejectsWith(pub({ signals: [signal('AAA', { dayReturn: Number.NaN })] }), 'non_finite_value');
    await rejectsWith(
      pub({ bars: [{ ticker: 'AAA', sessionDate: '2999-01-01', openMicros: undefined, highMicros: undefined, lowMicros: undefined, closeMicros: 1n, volume: undefined, adjusted: false, source: 'finnhub_quote' }] }),
      'future_session'
    );
    await rejectsWith(pub({ quotes: [quote('AAA', { source: 'fixture' })] }), 'fixture_data_disabled');
    await release(svc, job);
  });
});

describe('Alpaca history source', () => {
  test('split-adjusted SIP bars are accepted and an unknown feed is not', async () => {
    const job = await lease(svc);
    const generation = nowMicros();
    await svc.conn.reducers.publishMarketSnapshot(
      snapshot(job.jobId, job.attempt, generation, {
        bars: [
          {
            ticker: 'AAA',
            sessionDate: '2026-10-01',
            openMicros: 100_000_000n,
            highMicros: 101_000_000n,
            lowMicros: 99_000_000n,
            closeMicros: 100_500_000n,
            volume: 8_000_000n,
            adjusted: true,
            source: 'alpaca_sip',
          },
        ],
      })
    );
    const rejected = await lease(svc);
    await rejectsWith(
      svc.conn.reducers.publishMarketSnapshot(
        snapshot(rejected.jobId, rejected.attempt, nowMicros(), {
          bars: [
            {
              ticker: 'AAA',
              sessionDate: '2026-09-30',
              openMicros: undefined,
              highMicros: undefined,
              lowMicros: undefined,
              closeMicros: 100_000_000n,
              volume: 1n,
              adjusted: true,
              source: 'alpaca_mixed',
            },
          ],
        })
      ),
      'invalid_source'
    );
    await release(svc, rejected);
  });
});

describe('Python worker → SpacetimeDB → subscribed client', () => {
  test('a real ingestion run (fixture provider) is delivered to a subscribed consumer', async () => {
    const pySvc = await connect();
    cli('grant_service_identity', `"0x${pySvc.identityHex}"`, '"python-fixture-worker"');
    cli('set_service_flag', '"allow_fixture_data"', 'true');
    const previous = [...user.conn.db.marketGeneration.iter()][0]?.generation ?? 0n;

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('uv', ['run', 'python', '-m', 'scripts.publish_fixture_snapshot'], {
        cwd: BACKEND_DIR,
        env: { ...process.env, SPACETIME_DATABASE: DB, SPACETIME_SERVICE_TOKEN: pySvc.token },
      });
      let out = '';
      child.stdout.on('data', d => (out += d));
      child.stderr.on('data', d => (out += d));
      child.on('close', code => (code === 0 ? resolve(out) : reject(new Error(`python exited ${code}: ${out}`))));
    });
    assert.match(output, /claimed=1/);

    const generation = await waitFor('new generation', () => {
      const g = [...user.conn.db.marketGeneration.iter()][0];
      return g && g.generation > previous ? g : undefined;
    }, 20_000);
    assert.equal(generation.provider, 'fixture');
    const signals = [...user.conn.db.trendSignal.iter()].filter(s => s.generation === generation.generation);
    assert.ok(signals.length >= 10);
    const scored = signals.filter(s => s.status === 'published');
    assert.ok(scored.length >= 10, `expected scored fixture signals, got ${scored.length}`);
    for (const s of scored) {
      assert.ok(s.trendScore! >= 0 && s.trendScore! <= 100);
      assert.ok(Math.abs(s.coverage - 0.55) < 1e-9);
      assert.equal(s.coverageScope, 'price_volume');
      assert.ok(s.features.filter(f => f.name.startsWith('news') || f.name === 'sentiment_shift' || f.name === 'breadth_materiality').every(f => !f.available));
    }
    const quotes = [...user.conn.db.marketQuote.iter()].filter(q => q.generation === generation.generation);
    assert.ok(quotes.length >= 20 && quotes.every(q => q.source === 'fixture'));
    cli('set_service_flag', '"allow_fixture_data"', 'false');
  });
});
