import { t } from 'spacetimedb/server';
import type { Identity } from 'spacetimedb';
import spacetimedb, {
  dailyBar,
  investmentProfile,
  job,
  paperAccount,
  paperBinding,
  paperOrder,
  paperPosition,
  assistantMessage,
  dailyDiscovery,
  dailyDiscoveryItem,
  profileBranding,
  recommendation,
  recommendationGeneration,
  serviceIdentity,
  userAccount,
} from './schema';
import { isService } from './auth';
import { JOB_KIND, JOB_STATUS } from './jobs';

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

export const myRecommendationGeneration = spacetimedb.view(
  { name: 'my_recommendation_generation', public: true },
  t.option(recommendationGeneration.rowType),
  ctx => ctx.db.recommendationGeneration.owner.find(ctx.sender) ?? undefined
);

/** Recommendations in the caller's current generation only. Never another user's. */
export const myRecommendations = spacetimedb.view(
  { name: 'my_recommendations', public: true },
  t.array(recommendation.rowType),
  ctx => {
    const current = ctx.db.recommendationGeneration.owner.find(ctx.sender);
    if (!current) return [];
    return [...ctx.db.recommendation.by_owner_generation.filter([ctx.sender, current.generation])].sort(
      (a, b) => a.displayRank - b.displayRank
    );
  }
);

export const myJobs = spacetimedb.view(
  { name: 'my_jobs', public: true },
  t.array(job.rowType),
  ctx =>
    [...ctx.db.job.owner.filter(ctx.sender)]
      .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))
      .slice(0, MY_JOBS_LIMIT)
);

export const myPaperAccess = spacetimedb.view(
  { name: 'my_paper_access', public: true },
  t.option(paperBinding.rowType),
  ctx => {
    const binding = ctx.db.paperBinding.slot.find('demo');
    if (!binding || !binding.owner.isEqual(ctx.sender)) return undefined;
    return binding;
  }
);

export const myPaperAccount = spacetimedb.view(
  { name: 'my_paper_account', public: true },
  t.option(paperAccount.rowType),
  ctx => {
    const binding = ctx.db.paperBinding.slot.find('demo');
    if (!binding || !binding.owner.isEqual(ctx.sender)) return undefined;
    return ctx.db.paperAccount.owner.find(ctx.sender) ?? undefined;
  }
);

export const myPaperPositions = spacetimedb.view(
  { name: 'my_paper_positions', public: true },
  t.array(paperPosition.rowType),
  ctx => {
    const binding = ctx.db.paperBinding.slot.find('demo');
    if (!binding || !binding.owner.isEqual(ctx.sender)) return [];
    return [...ctx.db.paperPosition.by_owner.filter(ctx.sender)].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }
);

export const myPaperOrders = spacetimedb.view(
  { name: 'my_paper_orders', public: true },
  t.array(paperOrder.rowType),
  ctx => {
    const binding = ctx.db.paperBinding.slot.find('demo');
    if (!binding || !binding.owner.isEqual(ctx.sender)) return [];
    return [...ctx.db.paperOrder.owner.filter(ctx.sender)]
      .sort((a, b) => Number(b.createdAt.microsSinceUnixEpoch - a.createdAt.microsSinceUnixEpoch))
      .slice(0, MY_JOBS_LIMIT);
  }
);

// ---- Service-gated worker views: non-service callers get nothing. ----

/** Lets a worker confirm its own token is allowlisted (readiness check). */
export const myServiceGrant = spacetimedb.view(
  { name: 'my_service_grant', public: true },
  t.option(serviceIdentity.rowType),
  ctx => ctx.db.serviceIdentity.identity.find(ctx.sender) ?? undefined
);

/**
 * Jobs a worker may consider claiming, limited to the kinds it registered,
 * so unsupported kinds can neither be claimed nor crowd out supported work.
 * The claim reducer re-checks eligibility and time.
 */
export const workerJobs = spacetimedb.view(
  { name: 'worker_jobs', public: true },
  t.array(job.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const registration = ctx.db.workerRegistration.identity.find(ctx.sender);
    if (!registration) return [];
    const out = [];
    for (const status of [JOB_STATUS.queued, JOB_STATUS.retryWait, JOB_STATUS.running]) {
      for (const kind of registration.kinds) {
        for (const row of ctx.db.job.by_status_kind.filter([status, kind])) {
          out.push(row);
          if (out.length >= WORKER_JOBS_LIMIT) return out;
        }
      }
    }
    return out;
  }
);

/** Recent session closes for charts. Prices only; the full bar table stays private. */
/** Enough completed sessions for a 1Y chart when the stored history reaches it. */
const CHART_SESSIONS = 260;

const marketCloseRow = t.row('MarketClose', {
  id: t.u64().primaryKey(),
  ticker: t.string(),
  sessionDate: t.string(),
  closeMicros: t.i64(),
});

export const marketCloses = spacetimedb.view(
  { name: 'market_closes', public: true },
  t.array(marketCloseRow),
  ctx => {
    const out = [];
    for (const stock of ctx.db.stock.active.filter(true)) {
      const bars = [...ctx.db.dailyBar.by_ticker_date.filter(stock.ticker)].sort((a, b) =>
        a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0
      );
      for (const bar of bars.slice(-CHART_SESSIONS)) {
        out.push({
          id: bar.id,
          ticker: bar.ticker,
          sessionDate: bar.sessionDate,
          closeMicros: bar.closeMicros,
        });
      }
    }
    return out;
  }
);

/** Stored completed-session bars for the active universe (service only). */
export const workerDailyBars = spacetimedb.view(
  { name: 'worker_daily_bars', public: true },
  t.array(dailyBar.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    for (const s of ctx.db.stock.active.filter(true)) {
      for (const bar of ctx.db.dailyBar.by_ticker_date.filter(s.ticker)) out.push(bar);
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

/** Orders owned by a paper job this worker currently holds. */
export const workerPaperOrders = spacetimedb.view(
  { name: 'worker_paper_orders', public: true },
  t.array(paperOrder.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    const seen = new Set<string>();
    const binding = ctx.db.paperBinding.slot.find('demo');
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      if (row.kind !== 'submit_paper_order' && row.kind !== 'reconcile_paper_account') continue;
      if (!binding || !binding.owner.isEqual(row.owner)) continue;
      const key = row.owner.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const order of ctx.db.paperOrder.owner.filter(row.owner)) out.push(order);
    }
    return out;
  }
);

export const workerPaperAccount = spacetimedb.view(
  { name: 'worker_paper_account', public: true },
  t.option(paperAccount.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return undefined;
    const binding = ctx.db.paperBinding.slot.find('demo');
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      if (row.kind !== 'submit_paper_order' && row.kind !== 'reconcile_paper_account') continue;
      if (!binding || !binding.owner.isEqual(row.owner)) continue;
      return ctx.db.paperAccount.owner.find(row.owner) ?? undefined;
    }
    return undefined;
  }
);

const ASSISTANT_MESSAGE_LIMIT = 30;

/** The caller's assistant transcript, newest window only. */
export const myAssistantMessages = spacetimedb.view(
  { name: 'my_assistant_messages', public: true },
  t.array(assistantMessage.rowType),
  ctx =>
    [...ctx.db.assistantMessage.by_owner.filter(ctx.sender)]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-ASSISTANT_MESSAGE_LIMIT)
);

/**
 * Paper positions for the owner of an assistant job this worker currently
 * holds. Other callers, and owners without the bound paper account, get nothing.
 */
export const workerAssistantPositions = spacetimedb.view(
  { name: 'worker_assistant_positions', public: true },
  t.array(paperPosition.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const binding = ctx.db.paperBinding.slot.find('demo');
    const out = [];
    const seen = new Set<string>();
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      if (row.kind !== 'answer_message' && row.kind !== 'home_brief') continue;
      if (!binding || !binding.owner.isEqual(row.owner)) continue;
      const key = row.owner.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      for (const position of ctx.db.paperPosition.by_owner.filter(row.owner)) out.push(position);
    }
    return out;
  }
);

/** Transcript rows for an assistant job this worker holds. */
export const workerAssistantMessages = spacetimedb.view(
  { name: 'worker_assistant_messages', public: true },
  t.array(assistantMessage.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    const seen = new Set<string>();
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      if (row.kind !== 'answer_message' && row.kind !== 'home_brief') continue;
      const key = row.owner.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      const messages = [...ctx.db.assistantMessage.by_owner.filter(row.owner)].sort((a, b) => a.sequence - b.sequence);
      for (const message of messages.slice(-ASSISTANT_MESSAGE_LIMIT)) out.push(message);
    }
    return out;
  }
);

/** Current-generation recommendations for an assistant job this worker holds. */
export const workerAssistantRecommendations = spacetimedb.view(
  { name: 'worker_assistant_recommendations', public: true },
  t.array(recommendation.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    const seen = new Set<string>();
    for (const row of ctx.db.job.status.filter(JOB_STATUS.running)) {
      if (!row.leaseOwner || !row.leaseOwner.isEqual(ctx.sender)) continue;
      if (row.kind !== 'answer_message' && row.kind !== 'home_brief') continue;
      const key = row.owner.toHexString();
      if (seen.has(key)) continue;
      seen.add(key);
      const current = ctx.db.recommendationGeneration.owner.find(row.owner);
      if (!current) continue;
      for (const item of ctx.db.recommendation.by_owner_generation.filter([row.owner, current.generation])) {
        out.push(item);
      }
    }
    return out;
  }
);

// ---- Discovery ----

/** Discovery sets a worker may read per owner: enough history for novelty and theme rotation. */
const DISCOVERY_HISTORY_SETS = 30;

const byDateDesc = (a: { discoveryDate: string }, b: { discoveryDate: string }) =>
  a.discoveryDate < b.discoveryDate ? 1 : a.discoveryDate > b.discoveryDate ? -1 : 0;

/** The caller's most recent Discovery set. The client compares its date with the local day. */
export const myDailyDiscovery = spacetimedb.view(
  { name: 'my_daily_discovery', public: true },
  t.option(dailyDiscovery.rowType),
  ctx => [...ctx.db.dailyDiscovery.owner.filter(ctx.sender)].sort(byDateDesc)[0] ?? undefined
);

/** Companies in the caller's most recent set, in rank order. Never another person's. */
export const myDiscoveryItems = spacetimedb.view(
  { name: 'my_discovery_items', public: true },
  t.array(dailyDiscoveryItem.rowType),
  ctx => {
    const latest = [...ctx.db.dailyDiscovery.owner.filter(ctx.sender)].sort(byDateDesc)[0];
    if (!latest) return [];
    return [...ctx.db.dailyDiscoveryItem.by_discovery.filter(latest.id)].sort((a, b) => a.rank - b.rank);
  }
);

/** Owners of Discovery jobs the calling worker currently holds. */
function leasedDiscoveryOwners(
  running: Iterable<{ kind: string; owner: Identity; leaseOwner: Identity | undefined }>,
  sender: Identity
): Identity[] {
  const owners = new Map<string, Identity>();
  for (const row of running) {
    if (row.kind !== JOB_KIND.dailyDiscovery) continue;
    if (!row.leaseOwner || !row.leaseOwner.isEqual(sender)) continue;
    owners.set(row.owner.toHexString(), row.owner);
  }
  return [...owners.values()];
}

/** Recent Discovery sets for the owner of a Discovery job this worker holds (theme rotation). */
export const workerDiscoveryHistory = spacetimedb.view(
  { name: 'worker_discovery_history', public: true },
  t.array(dailyDiscovery.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    for (const owner of leasedDiscoveryOwners(ctx.db.job.status.filter(JOB_STATUS.running), ctx.sender)) {
      const sets = [...ctx.db.dailyDiscovery.owner.filter(owner)].sort(byDateDesc);
      for (const set of sets.slice(0, DISCOVERY_HISTORY_SETS)) out.push(set);
    }
    return out;
  }
);

/** Companies shown in those recent sets (novelty). */
export const workerDiscoveryItems = spacetimedb.view(
  { name: 'worker_discovery_items', public: true },
  t.array(dailyDiscoveryItem.rowType),
  ctx => {
    if (!isService(ctx, ctx.sender)) return [];
    const out = [];
    for (const owner of leasedDiscoveryOwners(ctx.db.job.status.filter(JOB_STATUS.running), ctx.sender)) {
      const sets = [...ctx.db.dailyDiscovery.owner.filter(owner)].sort(byDateDesc);
      for (const set of sets.slice(0, DISCOVERY_HISTORY_SETS)) {
        for (const item of ctx.db.dailyDiscoveryItem.by_discovery.filter(set.id)) out.push(item);
      }
    }
    return out;
  }
);
