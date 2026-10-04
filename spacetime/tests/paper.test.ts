/**
 * Paper-order reducers: one demo identity, one order per client key,
 * and snapshots that reject an older revision.
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
function now() {
  return new Timestamp(BigInt(Date.now()) * 1000n);
}

let demo: Session;
let other: Session;
let svc: Session;

before(async () => {
  demo = await connect();
  other = await connect();
  svc = await connect();
  cli('grant_service_identity', `"0x${svc.identityHex}"`, '"paper-test"');
  cli('bind_paper_demo', `"0x${demo.identityHex}"`);
  await svc.conn.reducers.registerWorker({ kinds: ['submit_paper_order', 'reconcile_paper_account'] });
  await svc.conn.reducers.upsertStocks({
    stocks: [
      {
        ticker: 'SPY',
        name: 'Benchmark',
        exchange: 'TEST',
        industry: 'Test',
        sector: '',
        currency: 'USD',
        kind: 'benchmark',
        benchmark: '',
        displayOrder: 1,
        logoUrl: '',
      },
      {
        ticker: 'CAT',
        name: 'Caterpillar',
        exchange: 'TEST',
        industry: 'Machinery',
        sector: 'industrials',
        currency: 'USD',
        kind: 'equity',
        benchmark: 'SPY',
        displayOrder: 0,
        logoUrl: '',
      },
    ],
  });
  await subscribe(svc.conn, ['SELECT * FROM worker_jobs']);
  await subscribe(demo.conn, [
    'SELECT * FROM my_paper_access',
    'SELECT * FROM my_paper_account',
    'SELECT * FROM my_paper_positions',
    'SELECT * FROM my_paper_orders',
    'SELECT * FROM my_notifications',
  ]);
  await subscribe(other.conn, ['SELECT * FROM my_paper_access', 'SELECT * FROM my_paper_orders']);
});

after(() => {
  for (const c of open) {
    try {
      c.disconnect();
    } catch {
      // already closed
    }
  }
});

describe('paper orders', () => {
  test('only the bound identity can create an intent, and the key is idempotent', async () => {
    const access = await waitFor('demo access', () => [...demo.conn.db.myPaperAccess.iter()][0]);
    assert.equal(access.slot, 'demo');
    assert.equal([...other.conn.db.myPaperAccess.iter()].length, 0);

    const quoteTime = now();
    const intent = {
      ticker: 'CAT',
      side: 'buy',
      quantityMicros: 1_000_000n,
      notionalMicros: undefined,
      clientOrderKey: 'orbit-paperkey01',
      quoteMicros: 150_000_000n,
      quoteTime,
    };
    await rejectsWith(other.conn.reducers.createPaperOrderIntent(intent), 'paper_not_enabled');
    await rejectsWith(
      demo.conn.reducers.createPaperOrderIntent({ ...intent, ticker: 'NOPE' }),
      'unknown_ticker'
    );
    await rejectsWith(
      demo.conn.reducers.createPaperOrderIntent({
        ...intent,
        clientOrderKey: 'orbit-bothamounts',
        notionalMicros: 1n,
      }),
      'invalid_order_amount'
    );
    await demo.conn.reducers.createPaperOrderIntent(intent);
    await demo.conn.reducers.createPaperOrderIntent(intent);
    const orders = await waitFor('queued order', () => {
      const rows = [...demo.conn.db.myPaperOrders.iter()].filter(row => row.clientOrderKey === 'orbit-paperkey01');
      return rows.length === 1 ? rows : undefined;
    });
    assert.equal(orders[0].status, 'queued');
    assert.equal([...other.conn.db.myPaperOrders.iter()].length, 0);
    await rejectsWith(cliBindOther(), 'paper_demo_already_bound');
  });

  test('a snapshot is owner-scoped, and an older revision does not replace it', async () => {
    const job = await waitFor('submit job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.kind === 'submit_paper_order' && row.status === 'queued')
    );
    await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
    const leased = await waitFor('leased submit', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.jobId === job.jobId && row.status === 'running')
    );
    const stamped = now();
    const snapshot = {
      jobId: leased.jobId,
      attempt: leased.attemptCount,
      revision: 2n,
      providerAccountId: 'paper-account-1',
      cashMicros: 99_000_000_000n,
      equityMicros: 100_000_000_000n,
      buyingPowerMicros: 400_000_000_000n,
      currency: 'USD',
      providerTime: stamped,
      marketOpen: false,
      nextOpen: stamped,
      nextClose: undefined,
      positions: [
        {
          ticker: 'CAT',
          quantityMicros: 1_000_000n,
          avgEntryMicros: 150_000_000n,
          marketValueMicros: 150_000_000n,
          unrealizedPlMicros: 0n,
        },
      ],
      orders: [
        {
          clientOrderKey: 'orbit-paperkey01',
          status: 'pending',
          providerOrderId: 'broker-1',
          filledQuantityMicros: 0n,
          filledAvgPriceMicros: undefined,
          rejectReason: undefined,
        },
      ],
    };
    await svc.conn.reducers.applyPaperSnapshot(snapshot);
    const account = await waitFor('account', () => [...demo.conn.db.myPaperAccount.iter()][0]);
    assert.equal(account.cashMicros, 99_000_000_000n);
    assert.equal(account.revision, 2n);
    assert.equal(account.marketOpen, false);
    const position = [...demo.conn.db.myPaperPositions.iter()][0];
    assert.equal(position.ticker, 'CAT');
    assert.equal(position.quantityMicros, 1_000_000n);
    const order = [...demo.conn.db.myPaperOrders.iter()][0];
    assert.equal(order.status, 'pending');
    assert.notEqual(order.status, 'filled');

    await rejectsWith(svc.conn.reducers.applyPaperSnapshot({ ...snapshot, revision: 1n, cashMicros: 1n }), 'stale_revision');
    assert.equal([...demo.conn.db.myPaperAccount.iter()][0].cashMicros, 99_000_000_000n);
  });

  test('partial fill, rejection, and a restarted lease still share one order', async () => {
    const quoteTime = now();
    await demo.conn.reducers.createPaperOrderIntent({
      ticker: 'CAT',
      side: 'sell',
      quantityMicros: 1_000_000n,
      notionalMicros: undefined,
      clientOrderKey: 'orbit-partial01',
      quoteMicros: 150_000_000n,
      quoteTime,
    });
    const job = await waitFor('partial job', () =>
      [...svc.conn.db.workerJobs.iter()].find(
        row => row.requestKey === 'orbit-partial01' && (row.status === 'queued' || row.status === 'retry_wait')
      )
    );
    await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 5 });
    const first = await waitFor('first lease', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.jobId === job.jobId && row.status === 'running')
    );
    await new Promise(r => setTimeout(r, 5500));
    await svc.conn.reducers.claimJob({ jobId: job.jobId, leaseSeconds: 60 });
    const restarted = await waitFor('restarted lease', () =>
      [...svc.conn.db.workerJobs.iter()].find(
        row => row.jobId === job.jobId && row.status === 'running' && row.attemptCount > first.attemptCount
      )
    );
    const stamped = now();
    const badFill = svc.conn.reducers.applyPaperSnapshot({
      jobId: restarted.jobId,
      attempt: restarted.attemptCount,
      revision: 4n,
      providerAccountId: 'paper-account-1',
      cashMicros: 99_000_000_000n,
      equityMicros: 100_000_000_000n,
      buyingPowerMicros: 400_000_000_000n,
      currency: 'USD',
      providerTime: stamped,
      marketOpen: false,
      nextOpen: undefined,
      nextClose: undefined,
      positions: [],
      orders: [
        {
          clientOrderKey: 'orbit-partial01',
          status: 'filled',
          providerOrderId: 'broker-2',
          filledQuantityMicros: 0n,
          filledAvgPriceMicros: undefined,
          rejectReason: undefined,
        },
      ],
    });
    await rejectsWith(badFill, 'fill_without_quantity');
    await svc.conn.reducers.applyPaperSnapshot({
      jobId: restarted.jobId,
      attempt: restarted.attemptCount,
      revision: 4n,
      providerAccountId: 'paper-account-1',
      cashMicros: 99_000_000_000n,
      equityMicros: 100_000_000_000n,
      buyingPowerMicros: 400_000_000_000n,
      currency: 'USD',
      providerTime: stamped,
      marketOpen: false,
      nextOpen: undefined,
      nextClose: undefined,
      positions: [],
      orders: [
        {
          clientOrderKey: 'orbit-partial01',
          status: 'partially_filled',
          providerOrderId: 'broker-2',
          filledQuantityMicros: 400_000n,
          filledAvgPriceMicros: 150_000_000n,
          rejectReason: undefined,
        },
      ],
    });
    const partial = await waitFor('partial', () =>
      [...demo.conn.db.myPaperOrders.iter()].find(row => row.clientOrderKey === 'orbit-partial01' && row.status === 'partially_filled')
    );
    assert.equal(partial.filledQuantityMicros, 400_000n);
    assert.equal([...demo.conn.db.myPaperOrders.iter()].filter(row => row.clientOrderKey === 'orbit-partial01').length, 1);
    const partialNotice = await waitFor('partial notice', () =>
      [...demo.conn.db.myNotifications.iter()].find(
        row => row.dedupeKey === 'order:orbit-partial01:partially_filled'
      )
    );
    assert.match(partialNotice.title, /CAT/);

    await demo.conn.reducers.createPaperOrderIntent({
      ticker: 'CAT',
      side: 'buy',
      quantityMicros: 1_000_000n,
      notionalMicros: undefined,
      clientOrderKey: 'orbit-rejected1',
      quoteMicros: 150_000_000n,
      quoteTime,
    });
    const rejectJob = await waitFor('reject job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.requestKey === 'orbit-rejected1' && row.status === 'queued')
    );
    await svc.conn.reducers.claimJob({ jobId: rejectJob.jobId, leaseSeconds: 60 });
    const leased = await waitFor('reject lease', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.jobId === rejectJob.jobId && row.status === 'running')
    );
    await svc.conn.reducers.applyPaperSnapshot({
      jobId: leased.jobId,
      attempt: leased.attemptCount,
      revision: 5n,
      providerAccountId: 'paper-account-1',
      cashMicros: 99_000_000_000n,
      equityMicros: 100_000_000_000n,
      buyingPowerMicros: 400_000_000_000n,
      currency: 'USD',
      providerTime: now(),
      marketOpen: false,
      nextOpen: undefined,
      nextClose: undefined,
      positions: [],
      orders: [
        {
          clientOrderKey: 'orbit-rejected1',
          status: 'rejected',
          providerOrderId: undefined,
          filledQuantityMicros: 0n,
          filledAvgPriceMicros: undefined,
          rejectReason: 'insufficient_cash',
        },
      ],
    });
    const rejectNotice = await waitFor('reject notice', () =>
      [...demo.conn.db.myNotifications.iter()].find(row => row.dedupeKey === 'order:orbit-rejected1:rejected')
    );
    assert.match(rejectNotice.body, /insufficient_cash/);
    const rejected = await waitFor('rejected', () =>
      [...demo.conn.db.myPaperOrders.iter()].find(
        row => row.clientOrderKey === 'orbit-rejected1' && row.status === 'rejected'
      )
    );
    assert.equal(rejected.status, 'rejected');
    assert.equal(rejected.rejectReason, 'insufficient_cash');
  });

  test('an admin rebind keeps the provider account and retires the previous owner', async () => {
    await subscribe(demo.conn, ['SELECT * FROM my_jobs']);
    await subscribe(other.conn, ['SELECT * FROM my_paper_account', 'SELECT * FROM my_paper_positions']);
    const quoteTime = now();
    await demo.conn.reducers.createPaperOrderIntent({
      ticker: 'CAT',
      side: 'buy',
      quantityMicros: 1_000_000n,
      notionalMicros: undefined,
      clientOrderKey: 'orbit-rebind001',
      quoteMicros: 150_000_000n,
      quoteTime,
    });
    const queued = await waitFor('rebind submit job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.requestKey === 'orbit-rebind001' && row.status === 'queued')
    );
    await svc.conn.reducers.requestPaperReconcile({});

    await rejectsWith(
      demo.conn.reducers.rebindPaperDemo({ identity: other.conn.identity! }),
      'not_authorized_admin'
    );
    await rejectsWith(cliCall('rebind_paper_demo', `"0x${svc.identityHex}"`), 'service_cannot_own_profile');
    cli('rebind_paper_demo', `"0x${demo.identityHex}"`);
    const stillQueued = await waitFor('same-owner rebind leaves the job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.jobId === queued.jobId && row.status === 'queued')
    );

    await svc.conn.reducers.claimJob({ jobId: stillQueued.jobId, leaseSeconds: 60 });
    const leased = await waitFor('leased rebind job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.jobId === queued.jobId && row.status === 'running')
    );
    const beforeAccount = [...demo.conn.db.myPaperAccount.iter()][0];
    assert.ok(beforeAccount);

    cli('rebind_paper_demo', `"0x${other.identityHex}"`);

    await waitFor('previous guest loses access', () => ([...demo.conn.db.myPaperAccess.iter()].length === 0 ? true : undefined));
    assert.equal([...demo.conn.db.myPaperAccount.iter()].length, 0);
    assert.equal([...demo.conn.db.myPaperPositions.iter()].length, 0);
    assert.equal([...demo.conn.db.myPaperOrders.iter()].length, 0);
    const moved = await waitFor('new guest access', () => [...other.conn.db.myPaperAccess.iter()][0]);
    assert.equal(moved.owner.toHexString(), other.identityHex);
    assert.equal(moved.providerAccountId, 'paper-account-1');
    assert.equal([...other.conn.db.myPaperAccount.iter()].length, 0);

    const retired = await waitFor('retired submit job', () =>
      [...demo.conn.db.myJobs.iter()].find(row => row.jobId === leased.jobId && row.status === 'failed')
    );
    assert.equal(retired.errorCode, 'binding_rebound');
    assert.equal(retired.leaseOwner, undefined);
    const retiredReconcile = [...demo.conn.db.myJobs.iter()].filter(
      row => row.kind === 'reconcile_paper_account' && row.status === 'failed' && row.errorCode === 'binding_rebound'
    );
    assert.ok(retiredReconcile.length >= 1);
    await waitFor('retired job leaves the worker view', () =>
      [...svc.conn.db.workerJobs.iter()].some(row => row.jobId === leased.jobId) ? undefined : true
    );

    await rejectsWith(
      svc.conn.reducers.applyPaperSnapshot({
        jobId: leased.jobId,
        attempt: leased.attemptCount,
        revision: 9n,
        providerAccountId: 'paper-account-1',
        cashMicros: 1n,
        equityMicros: 1n,
        buyingPowerMicros: 1n,
        currency: 'USD',
        providerTime: now(),
        marketOpen: false,
        nextOpen: undefined,
        nextClose: undefined,
        positions: [],
        orders: [],
      }),
      'lease_mismatch'
    );
    await rejectsWith(svc.conn.reducers.claimJob({ jobId: leased.jobId, leaseSeconds: 60 }), 'paper_not_enabled');
    await rejectsWith(
      demo.conn.reducers.createPaperOrderIntent({
        ticker: 'CAT',
        side: 'buy',
        quantityMicros: 1_000_000n,
        notionalMicros: undefined,
        clientOrderKey: 'orbit-rebindold1',
        quoteMicros: 150_000_000n,
        quoteTime,
      }),
      'paper_not_enabled'
    );
    await rejectsWith(cliCall('bind_paper_demo', `"0x${demo.identityHex}"`), 'paper_demo_already_bound');

    await other.conn.reducers.createPaperOrderIntent({
      ticker: 'CAT',
      side: 'buy',
      quantityMicros: 1_000_000n,
      notionalMicros: undefined,
      clientOrderKey: 'orbit-rebindnew1',
      quoteMicros: 150_000_000n,
      quoteTime,
    });
    const next = await waitFor('new owner submit job', () =>
      [...svc.conn.db.workerJobs.iter()].find(row => row.requestKey === 'orbit-rebindnew1' && row.status === 'queued')
    );
    assert.equal(next.owner.toHexString(), other.identityHex);
  });
});

function cliBindOther() {
  return cliCall('bind_paper_demo', `"0x${other.identityHex}"`);
}

function cliCall(reducer: string, arg: string) {
  return new Promise((_resolve, reject) => {
    try {
      cli(reducer, arg);
      reject(new Error(`${reducer} should have failed`));
    } catch (err) {
      reject(err);
    }
  });
}
