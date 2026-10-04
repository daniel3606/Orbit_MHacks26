/**
 * Home assistant ownership: a caller only sees their own messages, a repeated
 * client key does not create a second job, and a guest cannot publish a reply.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { DbConnection } from './module_bindings/index.ts';

const URI = process.env.STDB_URI ?? 'ws://127.0.0.1:3000';
const DB = process.env.STDB_DB ?? 'orbit-test';

type Session = { conn: DbConnection; disconnected: Promise<void> };
const open: DbConnection[] = [];

function connect(): Promise<Session> {
  let markDisconnected!: () => void;
  const disconnected = new Promise<void>(r => (markDisconnected = r));
  return new Promise((resolve, reject) => {
    const conn = DbConnection.builder()
      .withUri(URI)
      .withDatabaseName(DB)
      .withCompression('none')
      .onConnect(() => resolve({ conn, disconnected }))
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

async function waitFor(label: string, probe: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe()) return;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let a: Session;
let b: Session;

before(async () => {
  a = await connect();
  b = await connect();
  await subscribe(a.conn, ['SELECT * FROM my_assistant_messages', 'SELECT * FROM my_jobs']);
  await subscribe(b.conn, ['SELECT * FROM my_assistant_messages']);
});

after(async () => {
  for (const conn of open) conn.disconnect();
  await Promise.all([a.disconnected, b.disconnected]);
});

describe('assistant messages stay with their owner', () => {
  test('another guest cannot see the question, and a second tap does not duplicate it', async () => {
    const clientKey = `ask-test-${Date.now().toString(36)}`;
    await a.conn.reducers.enqueueAssistantMessage({ clientKey, text: 'What is a stock?' });
    await waitFor('owner messages', () => [...a.conn.db.myAssistantMessages.iter()].length === 2);
    assert.equal([...b.conn.db.myAssistantMessages.iter()].length, 0);
    const jobs = [...a.conn.db.myJobs.iter()].filter(job => job.requestKey === clientKey);
    assert.equal(jobs.length, 1);

    await a.conn.reducers.enqueueAssistantMessage({ clientKey, text: 'What is a stock?' });
    assert.equal([...a.conn.db.myAssistantMessages.iter()].length, 2);
    assert.equal([...a.conn.db.myJobs.iter()].filter(job => job.requestKey === clientKey).length, 1);
  });

  test('an overlong question is rejected', async () => {
    await assert.rejects(
      a.conn.reducers.enqueueAssistantMessage({ clientKey: 'ask-too-long-key', text: 'x'.repeat(501) }),
      (err: Error) => {
        assert.match(String(err?.message ?? err), /invalid_message_length/);
        return true;
      }
    );
  });

  test('a guest cannot publish an assistant reply', async () => {
    await assert.rejects(
      a.conn.reducers.publishAssistantReply({
        jobId: 1n,
        attempt: 1,
        replyClientKey: 'reply:missing',
        body: 'invented',
        citations: '[]',
        status: 'complete',
      }),
      (err: Error) => {
        assert.match(String(err?.message ?? err), /not_authorized_service/);
        return true;
      }
    );
  });
});
