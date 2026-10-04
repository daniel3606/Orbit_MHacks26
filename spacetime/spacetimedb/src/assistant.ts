import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireConsumer, requireService } from './auth';
import { JOB_KIND, JOB_STATUS, findByRequestKey, insertJob, isActiveStatus, requireLease } from './jobs';
import { notifyDailyBriefReady } from './notifications';

const MAX_USER_CHARS = 500;
const MAX_REPLY_CHARS = 1800;
const MAX_CITATIONS_CHARS = 2000;
const MESSAGE_WINDOW = 30;
const MAX_USER_MESSAGES_PER_WINDOW = 6;
const WINDOW_SECONDS = 600;
const MIN_GAP_SECONDS = 2;
const BRIEF_FRESH_SECONDS = 600;
const MICROS_PER_SECOND = 1_000_000n;

function nextSequence(ctx: Parameters<typeof requireConsumer>[0]): number {
  let max = 0;
  for (const row of ctx.db.assistantMessage.by_owner.filter(ctx.sender)) {
    if (row.sequence > max) max = row.sequence;
  }
  return max + 1;
}

function prune(ctx: Parameters<typeof requireConsumer>[0]) {
  const rows = [...ctx.db.assistantMessage.by_owner.filter(ctx.sender)].sort((a, b) => a.sequence - b.sequence);
  for (const old of rows.slice(0, Math.max(0, rows.length - MESSAGE_WINDOW))) {
    ctx.db.assistantMessage.id.delete(old.id);
  }
}

function recentUserCount(ctx: Parameters<typeof requireConsumer>[0]): { count: number; latestMicros: bigint } {
  const cutoff = ctx.timestamp.microsSinceUnixEpoch - BigInt(WINDOW_SECONDS) * MICROS_PER_SECOND;
  let count = 0;
  let latest = 0n;
  for (const row of ctx.db.assistantMessage.by_owner.filter(ctx.sender)) {
    if (row.role !== 'user') continue;
    const at = row.createdAt.microsSinceUnixEpoch;
    if (at > latest) latest = at;
    if (at >= cutoff) count += 1;
  }
  return { count, latestMicros: latest };
}

/**
 * The signed-in caller asks a question. Ownership is ctx.sender. A repeated
 * clientKey is the same send and does not create another job.
 */
export const enqueueAssistantMessage = spacetimedb.reducer(
  { clientKey: t.string(), text: t.string() },
  (ctx, { clientKey, text }) => {
    requireConsumer(ctx);
    const body = text.trim();
    if (!/^[A-Za-z0-9:_.-]{8,96}$/.test(clientKey)) throw new SenderError('invalid_request_key');
    if (body.length === 0 || body.length > MAX_USER_CHARS) throw new SenderError('invalid_message_length');
    if (findByRequestKey(ctx, ctx.sender, clientKey)) return;
    for (const row of ctx.db.assistantMessage.by_owner_key.filter([ctx.sender, clientKey])) return;

    for (const row of ctx.db.job.owner.filter(ctx.sender)) {
      if (row.kind === JOB_KIND.answerMessage && isActiveStatus(row.status)) throw new SenderError('rate_limited');
    }
    const recent = recentUserCount(ctx);
    if (recent.count >= MAX_USER_MESSAGES_PER_WINDOW) throw new SenderError('rate_limited');
    if (
      recent.latestMicros > 0n &&
      ctx.timestamp.microsSinceUnixEpoch - recent.latestMicros < BigInt(MIN_GAP_SECONDS) * MICROS_PER_SECOND
    ) {
      throw new SenderError('rate_limited');
    }

    const sequence = nextSequence(ctx);
    ctx.db.assistantMessage.insert({
      id: 0n,
      owner: ctx.sender,
      sequence,
      role: 'user',
      kind: 'chat',
      body,
      citations: '[]',
      status: 'complete',
      clientKey,
      createdAt: ctx.timestamp,
    });
    const replyKey = `reply:${clientKey}`;
    ctx.db.assistantMessage.insert({
      id: 0n,
      owner: ctx.sender,
      sequence: sequence + 1,
      role: 'assistant',
      kind: 'chat',
      body: '',
      citations: '[]',
      status: 'pending',
      clientKey: replyKey,
      createdAt: ctx.timestamp,
    });
    insertJob(ctx, ctx.sender, JOB_KIND.answerMessage, clientKey, 0, JSON.stringify({ replyClientKey: replyKey }));
    prune(ctx);
  }
);

/**
 * The caller starts a new conversation. Their questions and Orbit's answers are
 * deleted, so the worker no longer reads them as context; the daily note stays.
 * Refused while an answer is being written, so a reply cannot land in a cleared thread.
 */
export const clearAssistantChat = spacetimedb.reducer({}, ctx => {
  requireConsumer(ctx);
  for (const row of ctx.db.job.owner.filter(ctx.sender)) {
    if (row.kind === JOB_KIND.answerMessage && isActiveStatus(row.status)) throw new SenderError('assistant_busy');
  }
  for (const row of [...ctx.db.assistantMessage.by_owner.filter(ctx.sender)]) {
    if (row.kind === 'chat') ctx.db.assistantMessage.id.delete(row.id);
  }
});

/** Ask for the home introduction. An in-flight or fresh brief is left as-is. */
export const requestHomeBrief = spacetimedb.reducer({ clientKey: t.string() }, (ctx, { clientKey }) => {
  requireConsumer(ctx);
  if (!/^[A-Za-z0-9:_.-]{8,96}$/.test(clientKey)) throw new SenderError('invalid_request_key');
  if (findByRequestKey(ctx, ctx.sender, clientKey)) return;
  for (const row of ctx.db.job.owner.filter(ctx.sender)) {
    if (row.kind === JOB_KIND.homeBrief && isActiveStatus(row.status)) return;
  }
  const latest = [...ctx.db.assistantMessage.by_owner.filter(ctx.sender)]
    .filter(row => row.kind === 'brief' && row.role === 'assistant' && row.status === 'complete')
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))[0];
  const staleCopy =
    !!latest && (latest.body.includes('source text') || latest.body.includes('published quotes') || /\d{4}-\d{2}-\d{2}T/.test(latest.body));
  if (
    latest &&
    !staleCopy &&
    ctx.timestamp.microsSinceUnixEpoch - latest.createdAt.microsSinceUnixEpoch <
      BigInt(BRIEF_FRESH_SECONDS) * MICROS_PER_SECOND
  ) {
    return;
  }

  ctx.db.assistantMessage.insert({
    id: 0n,
    owner: ctx.sender,
    sequence: nextSequence(ctx),
    role: 'assistant',
    kind: 'brief',
    body: '',
    citations: '[]',
    status: 'pending',
    clientKey,
    createdAt: ctx.timestamp,
  });
  insertJob(ctx, ctx.sender, JOB_KIND.homeBrief, clientKey, 0, JSON.stringify({ replyClientKey: clientKey }));
  prune(ctx);
});

/**
 * The worker that holds the job writes the reply. No client can call this.
 * The message owner must be the job owner.
 */
export const publishAssistantReply = spacetimedb.reducer(
  {
    jobId: t.u64(),
    attempt: t.u32(),
    replyClientKey: t.string(),
    body: t.string(),
    citations: t.string(),
    status: t.string(),
  },
  (ctx, args) => {
    requireService(ctx);
    if (args.status === 'draft') {
      if (args.body.length > MAX_REPLY_CHARS) throw new SenderError('invalid_message_length');
      if (args.citations.length > MAX_CITATIONS_CHARS || !args.citations.startsWith('[')) {
        throw new SenderError('invalid_citations');
      }
      const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
      if (!holdsLease) throw new SenderError('lease_mismatch');
      if (job.kind !== JOB_KIND.homeBrief) throw new SenderError('invalid_job_kind');
      if (job.status === JOB_STATUS.succeeded) return;
      if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
      let draft;
      for (const row of ctx.db.assistantMessage.by_owner_key.filter([job.owner, args.replyClientKey])) draft = row;
      if (!draft || draft.role !== 'assistant') throw new SenderError('message_not_found');
      ctx.db.assistantMessage.id.update({ ...draft, body: args.body, citations: args.citations, status: 'pending' });
      return;
    }
    if (args.status !== 'complete' && args.status !== 'failed') throw new SenderError('invalid_message_status');
    if (args.body.length > MAX_REPLY_CHARS) throw new SenderError('invalid_message_length');
    if (args.citations.length > MAX_CITATIONS_CHARS || !args.citations.startsWith('[')) {
      throw new SenderError('invalid_citations');
    }
    const { row: job, holdsLease } = requireLease(ctx, args.jobId, args.attempt);
    if (!holdsLease) throw new SenderError('lease_mismatch');
    if (job.kind !== JOB_KIND.answerMessage && job.kind !== JOB_KIND.homeBrief) throw new SenderError('invalid_job_kind');
    if (job.status === JOB_STATUS.succeeded) return;
    if (job.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    if (job.leaseUntil === undefined || job.leaseUntil.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
      throw new SenderError('lease_expired');
    }

    let message;
    for (const row of ctx.db.assistantMessage.by_owner_key.filter([job.owner, args.replyClientKey])) message = row;
    if (!message || message.role !== 'assistant') throw new SenderError('message_not_found');
    ctx.db.assistantMessage.id.update({
      ...message,
      body: args.body,
      citations: args.citations,
      status: args.status,
    });
    if (args.status === 'complete' && message.kind === 'brief') {
      notifyDailyBriefReady(ctx, job.owner, args.replyClientKey);
    }
    ctx.db.job.jobId.update({
      ...job,
      status: JOB_STATUS.succeeded,
      resultRef: `assistant:${args.replyClientKey}`.slice(0, 512),
      errorCode: undefined,
      leaseOwner: undefined,
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);
