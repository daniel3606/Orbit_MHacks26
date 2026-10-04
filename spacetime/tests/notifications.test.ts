/**
 * In-app inbox: welcome on onboarding, mark-read ownership, and isolation.
 * Order-fill alerts are covered in paper.test.ts alongside fill snapshots.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DbConnection } from './module_bindings/index.ts';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'orbit-test';

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

const PREFS = {
  riskTolerance: 'moderate',
  investmentHorizon: 'years',
  investmentStyle: 'growth',
  sectorInterests: ['technology'],
  experienceLevel: 'new',
  primaryGoal: 'learn_basics',
  zodiacSign: 'aries',
};

let owner: Session;
let other: Session;

before(async () => {
  owner = await connect();
  other = await connect();
  await subscribe(owner.conn, ['SELECT * FROM my_notifications']);
  await subscribe(other.conn, ['SELECT * FROM my_notifications']);
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

describe('notification inbox', () => {
  test('onboarding creates a welcome notification only for the owner', async () => {
    await owner.conn.reducers.completeOnboarding(PREFS);
    const welcome = await waitFor('welcome', () =>
      [...owner.conn.db.myNotifications.iter()].find(row => row.kind === 'welcome')
    );
    assert.equal(welcome.title, 'Welcome to Orbit');
    assert.equal(welcome.readAt, undefined);
    assert.equal([...other.conn.db.myNotifications.iter()].length, 0);
  });

  test('mark read is owner-scoped and mark-all clears unread rows', async () => {
    const welcome = [...owner.conn.db.myNotifications.iter()].find(row => row.kind === 'welcome');
    assert.ok(welcome);
    await rejectsWith(other.conn.reducers.markNotificationRead({ notificationId: welcome.id }), 'notification_not_found');
    await owner.conn.reducers.markNotificationRead({ notificationId: welcome.id });
    const read = await waitFor('read welcome', () => {
      const row = [...owner.conn.db.myNotifications.iter()].find(item => item.id === welcome.id);
      return row?.readAt !== undefined ? row : undefined;
    });
    assert.ok(read.readAt);

    await owner.conn.reducers.markAllNotificationsRead({});
    assert.equal(
      [...owner.conn.db.myNotifications.iter()].filter(row => row.readAt === undefined).length,
      0
    );
  });
});
