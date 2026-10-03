import { t } from 'spacetimedb/server';
import spacetimedb, {
  investmentProfile,
  job,
  profileBranding,
  serviceIdentity,
  userAccount,
} from './schema';
import { isService } from './auth';
import { JOB_STATUS } from './jobs';

const MY_JOBS_LIMIT = 20;
const WORKER_JOBS_LIMIT = 100;

// ---- Caller-scoped user views: every lookup is keyed on ctx.sender. ----

export const myAccount = spacetimedb.view(
  { name: 'my_account', public: true },
  t.option(userAccount.rowType),
  ctx => ctx.db.userAccount.identity.find(ctx.sender) ?? undefined
);

export const myProfile = spacetimedb.view(
  { name: 'my_profile', public: true },
  t.option(investmentProfile.rowType),
  ctx => ctx.db.investmentProfile.owner.find(ctx.sender) ?? undefined
);

export const myBranding = spacetimedb.view(
  { name: 'my_branding', public: true },
  t.option(profileBranding.rowType),
  ctx => ctx.db.profileBranding.owner.find(ctx.sender) ?? undefined
);

export const myJobs = spacetimedb.view(
  { name: 'my_jobs', public: true },
  t.array(job.rowType),
  ctx =>
    [...ctx.db.job.owner.filter(ctx.sender)]
      .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))
      .slice(0, MY_JOBS_LIMIT)
);

// ---- Service-gated worker views: non-service callers get nothing. ----

/** Lets a worker confirm its own token is allowlisted (readiness check). */
export const myServiceGrant = spacetimedb.view(
  { name: 'my_service_grant', public: true },
  t.option(serviceIdentity.rowType),
  ctx => ctx.db.serviceIdentity.identity.find(ctx.sender) ?? undefined
);

/** Jobs a worker may consider claiming. The claim reducer re-checks eligibility and time. */
export const workerJobs = spacetimedb.view(
  { name: 'worker_jobs', public: true },
  t.array(job.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    for (const status of [JOB_STATUS.queued, JOB_STATUS.retryWait, JOB_STATUS.running]) {
      for (const row of ctx.db.job.status.filter(status)) {
        out.push(row);
        if (out.length >= WORKER_JOBS_LIMIT) return out;
      }
    }
    return out;
  }
);

/**
 * Ranking inputs for jobs leased by the calling worker only. Contains the
 * investment profile and never branding (zodiac).
 */
export const workerJobProfiles = spacetimedb.view(
  { name: 'worker_job_profiles', public: true },
  t.array(investmentProfile.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    const seen = new Set<string>();
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      const key = row.owner.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      const profile = ctx.db.investmentProfile.owner.find(row.owner);
      if (profile) out.push(profile);
    }
    return out;
  }
);
