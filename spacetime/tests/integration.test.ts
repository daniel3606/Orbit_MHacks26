/**
 * Integration tests against a real local SpacetimeDB server using the
 * generated bindings and the WebSocket SDK. Run via `npm test`, which
 * republishes a throwaway `orbit-test` database first.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DbConnection } from './module_bindings/index.ts';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'orbit-test';
const SPACETIME = process.env.SPACETIME_BIN ?? 'spacetime';

type Session = { conn: DbConnection; identityHex: string; token: string; disconnected: Promise<void> };
const open: DbConnection[] = [];

function connect(token?: string): Promise<Session> {
  let markDisconnected!: () => void;
  const disconnected = new Promise<void>(r => (markDisconnected = r));
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withToken(token)
      .withCompression('none')
      .onConnect((_c, identity, tok) =>
        resolve({ conn, identityHex: identity.toHexString(), token: tok, disconnected })
      )
      .onConnectError((_c, err) => reject(err))
      .onDisconnect(() => markDisconnected())
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

async function waitFor<T>(label: string, probe: () => T | undefined, timeoutMs = 5000): Promise<T> {
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
  return execFileSync(SPACETIME, [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function grantService(identityHex: string, label: string) {
  cli('call', '--no-config', DB, '--server', 'local', 'grant_service_identity', `"0x${identityHex}"`, `"${label}"`);
}
function revokeService(identityHex: string) {
  cli('call', '--no-config', DB, '--server', 'local', 'revoke_service_identity', `"0x${identityHex}"`);
}

const PREFS_A = {
  riskTolerance: 'moderate',
  investmentHorizon: 'years',
  investmentStyle: 'growth',
  sectorInterests: ['healthcare', 'technology'],
  experienceLevel: 'new',
  primaryGoal: 'learn_basics',
  zodiacSign: 'leo',
};
const PREFS_B = {
  riskTolerance: 'conservative',
  investmentHorizon: 'months',
  investmentStyle: 'income',
  sectorInterests: ['utilities'],
  experienceLevel: 'some',
  primaryGoal: 'generate_income',
  zodiacSign: undefined,
};
const USER_QUERIES = [
  'SELECT * FROM my_account',
  'SELECT * FROM my_profile',
  'SELECT * FROM my_branding',
  'SELECT * FROM my_jobs',
];

let a: Session;
let b: Session;
let svc: Session;
let svc2: Session;

before(async () => {
  a = await connect();
  b = await connect();
  svc = await connect();
  svc2 = await connect();
  grantService(svc.identityHex, 'test-worker-1');
  grantService(svc2.identityHex, 'test-worker-2');
  await subscribe(a.conn, USER_QUERIES);
  await subscribe(b.conn, USER_QUERIES);
  await subscribe(svc.conn, ['SELECT * FROM worker_jobs', 'SELECT * FROM worker_job_profiles']);
  await subscribe(svc2.conn, ['SELECT * FROM worker_jobs']);
});

after(() => {
  for (const conn of open) {
    try {
      conn.disconnect();
    } catch {
      /* already closed */
    }
  }
});

describe('identity and caller-scoped views', () => {
  test('two connections receive distinct identities and their own account rows', async () => {
    assert.notEqual(a.identityHex, b.identityHex);
    const accA = await waitFor('A account', () => [...a.conn.db.myAccount.iter()][0]);
    assert.equal(accA.identity.toHexString(), a.identityHex);
    assert.equal([...a.conn.db.myAccount.iter()].length, 1);
  });

  test('profile is empty after subscription applies (not an error)', () => {
    assert.equal(a.conn.db.myProfile.count(), 0n);
  });
});

describe('profile validation and persistence', () => {
  test('invalid enum values are rejected', async () => {
    await rejectsWith(a.conn.reducers.completeOnboarding({ ...PREFS_A, riskTolerance: 'yolo' }), 'invalid_risk_tolerance');
    await rejectsWith(a.conn.reducers.completeOnboarding({ ...PREFS_A, sectorInterests: [] }), 'invalid_sector_interests_count');
    await rejectsWith(
      a.conn.reducers.completeOnboarding({ ...PREFS_A, sectorInterests: ['energy', 'energy'] }),
      'invalid_sector_interests_duplicate'
    );
    await rejectsWith(a.conn.reducers.completeOnboarding({ ...PREFS_A, zodiacSign: 'ophiuchus' }), 'invalid_zodiac_sign');
    assert.equal(a.conn.db.myProfile.count(), 0n);
  });

  test('onboarding after subscription applied produces a subscribed row update', async () => {
    const inserted = new Promise(resolve => a.conn.db.myProfile.onInsert((_ctx, row) => resolve(row)));
    await a.conn.reducers.completeOnboarding(PREFS_A);
    const row = (await inserted) as any;
    assert.equal(row.owner.toHexString(), a.identityHex);
    assert.equal(row.profileVersion, 1);
    assert.equal(row.riskTolerance, 'moderate');
    assert.deepEqual(row.sectorInterests, ['technology', 'healthcare']); // canonical order
    const branding = await waitFor('A branding', () => [...a.conn.db.myBranding.iter()][0]);
    assert.equal(branding.zodiacSign, 'leo');
  });

  test('a second onboarding is rejected', async () => {
    await rejectsWith(a.conn.reducers.completeOnboarding(PREFS_A), 'profile_already_exists');
  });

  test('two identities are isolated', async () => {
    await b.conn.reducers.completeOnboarding(PREFS_B);
    const rowB = await waitFor('B profile', () => [...b.conn.db.myProfile.iter()][0]);
    assert.equal(rowB.riskTolerance, 'conservative');
    assert.equal(b.conn.db.myProfile.count(), 1n);
    assert.equal(a.conn.db.myProfile.count(), 1n);
    assert.equal([...a.conn.db.myProfile.iter()][0].riskTolerance, 'moderate');
    for (const job of a.conn.db.myJobs.iter()) assert.equal(job.owner.toHexString(), a.identityHex);
  });

  test('stale edits are rejected; a valid edit updates the row and coalesces the refresh job', async () => {
    await rejectsWith(
      a.conn.reducers.updatePreferences({ expectedVersion: 7, ...PREFS_A, riskTolerance: 'aggressive' }),
      'profile_version_conflict'
    );
    const updated = new Promise<any>(resolve => a.conn.db.myProfile.onUpdate((_ctx, _old, row) => resolve(row)));
    await a.conn.reducers.updatePreferences({ expectedVersion: 1, ...PREFS_A, riskTolerance: 'aggressive' });
    const row = await updated;
    assert.equal(row.profileVersion, 2);
    assert.equal(row.riskTolerance, 'aggressive');
    const refresh = [...a.conn.db.myJobs.iter()].filter(j => j.kind === 'refresh_recommendations');
    assert.equal(refresh.length, 1);
    await waitFor('refresh coalesced', () => ([...a.conn.db.myJobs.iter()].find(j => j.kind === 'refresh_recommendations')?.inputVersion === 2 ? true : undefined));
  });

  test('branding-only edits do not bump the profile version', async () => {
    await a.conn.reducers.updatePreferences({ expectedVersion: 2, ...PREFS_A, riskTolerance: 'aggressive', zodiacSign: 'virgo' });
    await waitFor('branding update', () => ([...a.conn.db.myBranding.iter()][0]?.zodiacSign === 'virgo' ? true : undefined));
    assert.equal([...a.conn.db.myProfile.iter()][0].profileVersion, 2);
  });

  test('session restore with the saved token yields the same identity and data', async () => {
    const restored = await connect(a.token);
    assert.equal(restored.identityHex, a.identityHex);
    await subscribe(restored.conn, USER_QUERIES);
    const row = [...restored.conn.db.myProfile.iter()][0];
    assert.equal(row?.riskTolerance, 'aggressive');
    restored.conn.disconnect();
    await restored.disconnected;
    assert.equal(restored.conn.isActive, false);
  });
});

describe('service authorization', () => {
  test('consumers see nothing in worker views', async () => {
    await subscribe(a.conn, ['SELECT * FROM worker_jobs', 'SELECT * FROM worker_job_profiles']);
    assert.equal(a.conn.db.workerJobs.count(), 0n);
    assert.equal(a.conn.db.workerJobProfiles.count(), 0n);
  });

  test('consumers cannot call worker or admin reducers', async () => {
    const jobId = [...a.conn.db.myJobs.iter()][0].jobId;
    await rejectsWith(a.conn.reducers.claimJob({ jobId, leaseSeconds: 30 }), 'not_authorized_service');
    await rejectsWith(a.conn.reducers.completeJob({ jobId, attempt: 1, inputVersion: 1, resultRef: 'x' }), 'not_authorized_service');
    await rejectsWith(a.conn.reducers.failJob({ jobId, attempt: 1, errorCode: 'x', retryable: false }), 'not_authorized_service');
    await rejectsWith(a.conn.reducers.grantServiceIdentity({ identity: a.conn.identity!, label: 'me' }), 'not_authorized_admin');
  });

  test('service identities cannot own consumer profiles', async () => {
    await rejectsWith(svc.conn.reducers.completeOnboarding(PREFS_A), 'service_cannot_own_profile');
  });
});

describe('durable job lifecycle', () => {
  let jobId: bigint;

  test('enqueue is idempotent by request key', async () => {
    await a.conn.reducers.requestBackendCheck({ requestKey: 'check-1' });
    await a.conn.reducers.requestBackendCheck({ requestKey: 'check-1' });
    const checks = [...a.conn.db.myJobs.iter()].filter(j => j.kind === 'backend_check');
    assert.equal(checks.length, 1);
    jobId = checks[0].jobId;
    assert.equal(checks[0].status, 'queued');
    assert.equal(checks[0].inputVersion, 2);
  });

  test('worker sees the job; claim → complete is observed by the owner subscription', async () => {
    await waitFor('worker sees job', () => [...svc.conn.db.workerJobs.iter()].find(j => j.jobId === jobId));

    await svc.conn.reducers.claimJob({ jobId, leaseSeconds: 30 });
    const running = await waitFor('owner sees running', () =>
      [...a.conn.db.myJobs.iter()].find(j => j.jobId === jobId && j.status === 'running')
    );
    assert.equal(running.attemptCount, 1);
    assert.equal(running.leaseOwner?.toHexString(), svc.identityHex);

    // Leased-job inputs are visible to the lease holder only, without branding.
    const profile = await waitFor('worker profile input', () =>
      [...svc.conn.db.workerJobProfiles.iter()].find(p => p.owner.toHexString() === a.identityHex)
    );
    assert.equal(profile.profileVersion, 2);
    assert.equal('zodiacSign' in profile, false);

    await rejectsWith(svc2.conn.reducers.claimJob({ jobId, leaseSeconds: 30 }), 'job_not_claimable');
    await rejectsWith(svc2.conn.reducers.completeJob({ jobId, attempt: 1, inputVersion: 2, resultRef: 'x' }), 'lease_mismatch');
    await rejectsWith(svc.conn.reducers.completeJob({ jobId, attempt: 1, inputVersion: 1, resultRef: 'x' }), 'stale_input_version');

    await svc.conn.reducers.completeJob({ jobId, attempt: 1, inputVersion: 2, resultRef: 'observed_profile_version=2' });
    const done = await waitFor('owner sees succeeded', () =>
      [...a.conn.db.myJobs.iter()].find(j => j.jobId === jobId && j.status === 'succeeded')
    );
    assert.equal(done.resultRef, 'observed_profile_version=2');
  });

  test('duplicate completion is a no-op; later failure reports are rejected', async () => {
    const before = [...a.conn.db.myJobs.iter()].find(j => j.jobId === jobId)!;
    await svc.conn.reducers.completeJob({ jobId, attempt: 1, inputVersion: 2, resultRef: 'different' });
    await new Promise(r => setTimeout(r, 200));
    const afterRow = [...a.conn.db.myJobs.iter()].find(j => j.jobId === jobId)!;
    assert.equal(afterRow.resultRef, 'observed_profile_version=2');
    assert.equal(afterRow.updatedAt.microsSinceUnixEpoch, before.updatedAt.microsSinceUnixEpoch);
    await rejectsWith(svc.conn.reducers.failJob({ jobId, attempt: 1, errorCode: 'late', retryable: false }), 'job_not_running');
    await rejectsWith(svc.conn.reducers.claimJob({ jobId, leaseSeconds: 30 }), 'job_not_claimable');
  });

  test('retryable failure backs off, and an expired lease can be reclaimed with a new fencing token', async () => {
    await a.conn.reducers.requestBackendCheck({ requestKey: 'check-2' });
    const job = await waitFor('second job', () => [...svc.conn.db.workerJobs.iter()].find(j => j.requestKey === 'check-2'));

    await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 5 });
    await svc.conn.reducers.failJob({ jobId: job.jobId, attempt: 1, errorCode: 'provider_timeout', retryable: true });
    const waiting = await waitFor('retry_wait', () =>
      [...a.conn.db.myJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'retry_wait')
    );
    assert.equal(waiting.errorCode, 'provider_timeout');
    assert.ok(waiting.availableAt.microsSinceUnixEpoch > waiting.updatedAt.microsSinceUnixEpoch);
    await rejectsWith(svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 5 }), 'job_not_claimable');

    // Wait out the backoff (base 2s * jitter ≤ 1.5 → ≤ 3s), then claim with the minimum lease.
    await new Promise(r => setTimeout(r, 3200));
    await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 5 });
    await waitFor('attempt 2', () => [...a.conn.db.myJobs.iter()].find(j => j.jobId === job.jobId && j.attemptCount === 2));

    // Lease expires; a second worker reclaims and the first worker's token is fenced off.
    await new Promise(r => setTimeout(r, 5300));
    await svc2.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 30 });
    await rejectsWith(
      svc.conn.reducers.completeJob({ jobId: job.jobId, attempt: 2, inputVersion: 2, resultRef: 'late' }),
      'lease_mismatch'
    );
    await svc2.conn.reducers.completeJob({ jobId: job.jobId, attempt: 3, inputVersion: 2, resultRef: 'reclaimed' });
    const done = await waitFor('reclaimed success', () =>
      [...a.conn.db.myJobs.iter()].find(j => j.jobId === job.jobId && j.status === 'succeeded')
    );
    assert.equal(done.leaseOwner?.toHexString(), svc2.identityHex);
  });

  test('revoked service identities lose access immediately', async () => {
    await a.conn.reducers.requestBackendCheck({ requestKey: 'check-3' });
    const job = await waitFor('third job', () => [...svc2.conn.db.workerJobs.iter()].find(j => j.requestKey === 'check-3'));
    revokeService(svc2.identityHex);
    await rejectsWith(svc2.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 30 }), 'not_authorized_service');
    await waitFor('worker view emptied', () => (svc2.conn.db.workerJobs.count() === 0n ? true : undefined));
  });
});
