import { SenderError, t } from 'spacetimedb/server';
import { Timestamp, type Identity } from 'spacetimedb';
import spacetimedb from './schema';
import { requireConsumer, requireService, type Ctx } from './auth';

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
} as const;

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

function plusSeconds(ts: Timestamp, seconds: number): Timestamp {
  return new Timestamp(ts.microsSinceUnixEpoch + BigInt(seconds) * MICROS_PER_SECOND);
}

function isActive(status: string): boolean {
  return (
    status === JOB_STATUS.queued ||
    status === JOB_STATUS.running ||
    status === JOB_STATUS.retryWait
  );
}

function findByRequestKey(ctx: Ctx, owner: Identity, requestKey: string) {
  for (const row of ctx.db.job.by_owner_request.filter([owner, requestKey])) return row;
  return undefined;
}

function insertJob(
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
      if (row.kind === JOB_KIND.backendCheck && isActive(row.status)) active++;
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
function requireLease(ctx: Ctx, jobId: bigint, attempt: number) {
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
