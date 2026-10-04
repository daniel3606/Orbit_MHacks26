import { SenderError, t } from 'spacetimedb/server';
import { Timestamp, type Identity } from 'spacetimedb';
import spacetimedb from './schema';
import { isService, requireConsumer, requireService, type Ctx } from './auth';

/** Job states (PRD §9): queued → running → succeeded, with retry_wait and failed. */
export const JOB_STATUS = {
  queued: 'queued',
  running: 'running',
  succeeded: 'succeeded',
  retryWait: 'retry_wait',
  failed: 'failed',
} as const;

export const JOB_KIND = {
  refreshRecommendations: 'refresh_recommendations',
  backendCheck: 'backend_check',
  ingestMarket: 'ingest_market',
  submitPaperOrder: 'submit_paper_order',
  reconcilePaperAccount: 'reconcile_paper_account',
  answerMessage: 'answer_message',
  homeBrief: 'home_brief',
} as const;

const KNOWN_JOB_KINDS: readonly string[] = Object.values(JOB_KIND);
const ACTIVE_STATUSES = ['queued', 'retry_wait', 'running'] as const;
/** Terminal system (market) jobs kept for inspection; older ones are pruned. */
const SYSTEM_JOB_RETENTION = 50;

const MAX_ACTIVE_COMMANDS_PER_OWNER = 3;
const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_LEASE_SECONDS = 5;
const MAX_LEASE_SECONDS = 300;
const BASE_BACKOFF_SECONDS = 2;
const MAX_BACKOFF_SECONDS = 300;
const MAX_RESULT_CHARS = 512;
const KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,96}$/;
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

const MICROS_PER_SECOND = 1_000_000n;

export function plusSeconds(ts: Timestamp, seconds: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(seconds) * MICROS_PER_SECOND);
}

export function isActiveStatus(status: string): boolean {
  return (
    status === JOB_STATUS.queued ||
    status === JOB_STATUS.running ||
    status === JOB_STATUS.retryWait
  );
}

export function findByRequestKey(ctx: Ctx, owner: Identity, requestKey: string) {
  for (const row of ctx.db.job.by_owner_request.filter([owner, requestKey])) return row;
  return undefined;
}

export function insertJob(
  ctx: Ctx,
  owner: Identity,
  kind: string,
  requestKey: string,
  inputVersion: number,
  payload: string
) {
  return ctx.db.job.insert({
    jobId: 0n,
    owner,
    kind,
    requestKey,
    inputVersion,
    status: JOB_STATUS.queued,
    attemptCount: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    leaseOwner: undefined,
    leaseUntil: undefined,
    availableAt: ctx.timestamp,
    payload,
    resultRef: undefined,
    errorCode: undefined,
    createdAt: ctx.timestamp,
    updatedAt: ctx.timestamp,
  });
}

/**
 * Called from profile reducers. Coalesces: an existing queued/retry_wait
 * refresh for this owner is re-pointed at the newest profile version rather
 * than adding another job. A running job keeps its old version; its result is
 * rejected as stale by `completeJob`, and this new queued job supersedes it.
 */
export function enqueueRecommendationRefresh(ctx: Ctx, owner: Identity, profileVersion: number) {
  for (const row of ctx.db.job.owner.filter(owner)) {
    if (
      row.kind === JOB_KIND.refreshRecommendations &&
      (row.status === JOB_STATUS.queued || row.status === JOB_STATUS.retryWait)
    ) {
      ctx.db.job.jobId.update({
        ...row,
        inputVersion: profileVersion,
        requestKey: `refresh:v${profileVersion}`,
        updatedAt: ctx.timestamp,
      });
      return;
    }
  }
  insertJob(ctx, owner, JOB_KIND.refreshRecommendations, `refresh:v${profileVersion}`, profileVersion, '{}');
}

const PAPER_RECONCILE_RETENTION = 20;

/** One submit job per client order key. A repeated tap with the same key does not add another. */
export function enqueuePaperSubmit(ctx: Ctx, owner: Identity, clientOrderKey: string) {
  if (findByRequestKey(ctx, owner, clientOrderKey)) return;
  insertJob(ctx, owner, JOB_KIND.submitPaperOrder, clientOrderKey, 0, '{}');
}

/**
 * One active reconcile per owner. A finished reconcile does not block the next
 * poll. Older terminal reconcile jobs are pruned.
 */
export function enqueuePaperReconcile(ctx: Ctx, owner: Identity, delaySeconds: number) {
  for (const row of ctx.db.job.owner.filter(owner)) {
    if (row.kind === JOB_KIND.reconcilePaperAccount && isActiveStatus(row.status)) return;
  }
  const terminal = [...ctx.db.job.owner.filter(owner)]
    .filter(row => row.kind === JOB_KIND.reconcilePaperAccount && !isActiveStatus(row.status))
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch));
  for (const old of terminal.slice(PAPER_RECONCILE_RETENTION - 1)) ctx.db.job.jobId.delete(old.jobId);

  const row = insertJob(
    ctx,
    owner,
    JOB_KIND.reconcilePaperAccount,
    `reconcile:${ctx.timestamp.microsSinceUnixEpoch}`,
    0,
    '{}'
  );
  if (delaySeconds > 0) {
    ctx.db.job.jobId.update({ ...row, availableAt: plusSeconds(ctx.timestamp, delaySeconds) });
  }
}

/**
 * Enqueues one shared market-ingestion job unless one is already active
 * (scheduled ticks and manual requests coalesce). Owned by the database
 * identity, so it never appears in any user's `my_jobs`.
 */
export function enqueueMarketIngest(ctx: Ctx, reason: string) {
  for (const status of ACTIVE_STATUSES) {
    for (const _row of ctx.db.job.by_status_kind.filter([status, JOB_KIND.ingestMarket])) return;
  }
  const owner = ctx.databaseIdentity;
  const terminal = [...ctx.db.job.owner.filter(owner)]
    .filter(j => j.kind === JOB_KIND.ingestMarket && !isActiveStatus(j.status))
    .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch));
  for (const old of terminal.slice(SYSTEM_JOB_RETENTION - 1)) ctx.db.job.jobId.delete(old.jobId);

  const row = insertJob(
    ctx,
    owner,
    JOB_KIND.ingestMarket,
    `ingest:${ctx.timestamp.microsSinceUnixEpoch}`,
    0,
    JSON.stringify({ reason })
  );
  ctx.db.job.jobId.update({ ...row, maxAttempts: 3 });
}

const REFRESH_MIN_INTERVAL_SECONDS = 30;

/**
 * User command: recompute matches from the current profile and the shared
 * market generation. An in-flight refresh is coalesced onto this profile
 * version instead of adding a second job. A refresh that just succeeded is
 * rate-limited; profile edits use `enqueueRecommendationRefresh` directly.
 */
export const requestRecommendations = spacetimedb.reducer(ctx => {
  requireConsumer(ctx);
  const profile = ctx.db.investmentProfile.owner.find(ctx.sender);
  if (!profile) throw new SenderError('profile_not_found');
  for (const row of ctx.db.job.owner.filter(ctx.sender)) {
    if (row.kind !== JOB_KIND.refreshRecommendations) continue;
    if (row.status === JOB_STATUS.queued || row.status === JOB_STATUS.retryWait || row.status === JOB_STATUS.running) {
      enqueueRecommendationRefresh(ctx, ctx.sender, profile.profileVersion);
      return;
    }
  }
  const latestSuccess = [...ctx.db.job.owner.filter(ctx.sender)]
    .filter(row => row.kind === JOB_KIND.refreshRecommendations && row.status === JOB_STATUS.succeeded)
    .sort((a, b) => Number(b.updatedAt.microsSinceUnixEpoch - a.updatedAt.microsSinceUnixEpoch))[0];
  if (
    latestSuccess &&
    ctx.timestamp.microsSinceUnixEpoch - latestSuccess.updatedAt.microsSinceUnixEpoch <
      BigInt(REFRESH_MIN_INTERVAL_SECONDS) * MICROS_PER_SECOND
  ) {
    throw new SenderError('rate_limited');
  }
  enqueueRecommendationRefresh(ctx, ctx.sender, profile.profileVersion);
});

/** Service or admin: run market ingestion now (coalesces with any active run). */
export const requestMarketIngest = spacetimedb.reducer(ctx => {
  if (!isService(ctx, ctx.sender) && !ctx.db.moduleAdmin.identity.find(ctx.sender)) {
    throw new SenderError('not_authorized_service');
  }
  enqueueMarketIngest(ctx, 'manual');
});

/** Worker declares which job kinds it handles; unsupported kinds are never offered to it. */
export const registerWorker = spacetimedb.reducer({ kinds: t.array(t.string()) }, (ctx, { kinds }) => {
  requireService(ctx);
  const unique = [...new Set(kinds)];
  if (unique.length === 0 || unique.some(k => !KNOWN_JOB_KINDS.includes(k))) {
    throw new SenderError('invalid_job_kinds');
  }
  const row = { identity: ctx.sender, kinds: unique, registeredAt: ctx.timestamp };
  if (ctx.db.workerRegistration.identity.find(ctx.sender)) ctx.db.workerRegistration.identity.update(row);
  else ctx.db.workerRegistration.insert(row);
});

/**
 * User command: ask the worker to prove the backend round trip. The worker
 * reads this owner's profile through a service-gated view and reports the
 * version it observed. Idempotent by `requestKey`.
 */
export const requestBackendCheck = spacetimedb.reducer(
  { requestKey: t.string() },
  (ctx, { requestKey }) => {
    requireConsumer(ctx);
    if (!KEY_PATTERN.test(requestKey)) throw new SenderError('invalid_request_key');
    if (findByRequestKey(ctx, ctx.sender, requestKey)) return; // duplicate tap / retry

    let active = 0;
    for (const row of ctx.db.job.owner.filter(ctx.sender)) {
      if (row.kind === JOB_KIND.backendCheck && isActiveStatus(row.status)) active++;
    }
    if (active >= MAX_ACTIVE_COMMANDS_PER_OWNER) throw new SenderError('rate_limited');

    const profile = ctx.db.investmentProfile.owner.find(ctx.sender);
    insertJob(ctx, ctx.sender, JOB_KIND.backendCheck, requestKey, profile?.profileVersion ?? 0, '{}');
  }
);

/** Worker: atomically lease an eligible job. */
export const claimJob = spacetimedb.reducer(
  { jobId: t.u64(), leaseSeconds: t.u32() },
  (ctx, { jobId, leaseSeconds }) => {
    requireService(ctx);
    const row = ctx.db.job.jobId.find(jobId);
    if (!row) throw new SenderError('job_not_found');
    if (row.kind === JOB_KIND.submitPaperOrder || row.kind === JOB_KIND.reconcilePaperAccount) {
      const binding = ctx.db.paperBinding.slot.find('demo');
      if (!binding || !binding.owner.isEqual(row.owner)) throw new SenderError('paper_not_enabled');
    }

    const now = ctx.timestamp.microsSinceUnixEpoch;
    const waiting =
      (row.status === JOB_STATUS.queued || row.status === JOB_STATUS.retryWait) &&
      row.availableAt.microsSinceUnixEpoch <= now;
    const leaseExpired =
      row.status === JOB_STATUS.running &&
      row.leaseUntil !== undefined &&
      row.leaseUntil.microsSinceUnixEpoch < now;
    if (!waiting && !leaseExpired) throw new SenderError('job_not_claimable');

    if (row.attemptCount >= row.maxAttempts) {
      ctx.db.job.jobId.update({
        ...row,
        status: JOB_STATUS.failed,
        errorCode: 'attempts_exhausted',
        leaseOwner: undefined,
        leaseUntil: undefined,
        updatedAt: ctx.timestamp,
      });
      return;
    }

    const lease = Math.min(Math.max(leaseSeconds, MIN_LEASE_SECONDS), MAX_LEASE_SECONDS);
    ctx.db.job.jobId.update({
      ...row,
      status: JOB_STATUS.running,
      attemptCount: row.attemptCount + 1,
      leaseOwner: ctx.sender,
      leaseUntil: plusSeconds(ctx.timestamp, lease),
      errorCode: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);

/**
 * Verifies that the caller holds the current, unexpired lease for `attempt`.
 * `attempt` is the fencing token: a worker whose lease was reclaimed holds a
 * stale attempt number and cannot commit.
 */
export function requireLease(ctx: Ctx, jobId: bigint, attempt: number) {
  const row = ctx.db.job.jobId.find(jobId);
  if (!row) throw new SenderError('job_not_found');
  const holdsLease =
    row.leaseOwner !== undefined && row.leaseOwner.isEqual(ctx.sender) && row.attemptCount === attempt;
  return { row, holdsLease };
}

/** Worker: commit a result. Retrying the same completion is a no-op. */
export const completeJob = spacetimedb.reducer(
  { jobId: t.u64(), attempt: t.u32(), inputVersion: t.u32(), resultRef: t.string() },
  (ctx, { jobId, attempt, inputVersion, resultRef }) => {
    requireService(ctx);
    const { row, holdsLease } = requireLease(ctx, jobId, attempt);
    if (!holdsLease) throw new SenderError('lease_mismatch');
    if (row.status === JOB_STATUS.succeeded) return; // duplicate completion
    if (row.status !== JOB_STATUS.running) throw new SenderError('job_not_running');
    if (row.leaseUntil === undefined || row.leaseUntil.microsSinceUnixEpoch < ctx.timestamp.microsSinceUnixEpoch) {
      throw new SenderError('lease_expired');
    }
    if (row.inputVersion !== inputVersion) throw new SenderError('stale_input_version');
    if (resultRef.length === 0 || resultRef.length > MAX_RESULT_CHARS) {
      throw new SenderError('invalid_result_ref');
    }

    ctx.db.job.jobId.update({
      ...row,
      status: JOB_STATUS.succeeded,
      resultRef,
      errorCode: undefined,
      // Keep leaseOwner so a retried completion from the same worker is recognised.
      leaseUntil: undefined,
      updatedAt: ctx.timestamp,
    });
  }
);

/** Worker: record a failure; retryable failures back off with jitter. */
export const failJob = spacetimedb.reducer(
  { jobId: t.u64(), attempt: t.u32(), errorCode: t.string(), retryable: t.bool() },
  (ctx, { jobId, attempt, errorCode, retryable }) => {
    requireService(ctx);
    if (!ERROR_CODE_PATTERN.test(errorCode)) throw new SenderError('invalid_error_code');
    const { row, holdsLease } = requireLease(ctx, jobId, attempt);
    if (!holdsLease) throw new SenderError('lease_mismatch');
    if (row.status !== JOB_STATUS.running) {
      if (row.errorCode === errorCode) return; // duplicate failure report
      throw new SenderError('job_not_running');
    }

    if (retryable && row.attemptCount < row.maxAttempts) {
      const exp = Math.min(BASE_BACKOFF_SECONDS * 2 ** (row.attemptCount - 1), MAX_BACKOFF_SECONDS);
      const delay = Math.max(1, Math.round(exp * (0.5 + ctx.random())));
      ctx.db.job.jobId.update({
        ...row,
        status: JOB_STATUS.retryWait,
        errorCode,
        leaseUntil: undefined,
        availableAt: plusSeconds(ctx.timestamp, delay),
        updatedAt: ctx.timestamp,
      });
    } else {
      ctx.db.job.jobId.update({
        ...row,
        status: JOB_STATUS.failed,
        errorCode,
        leaseUntil: undefined,
        updatedAt: ctx.timestamp,
      });
    }
  }
);
