import { schema, table, t } from 'spacetimedb/server';

/**
 * Orbit application-state schema.
 *
 * Every table is private (the default). Clients only read through the
 * caller-scoped views in `views.ts`; workers only read through the
 * service-gated views, which check the `service_identity` allowlist.
 */

/** Identities allowed to administer the module (seeded with the publisher in `init`). */
export const moduleAdmin = table(
  { name: 'module_admin' },
  {
    identity: t.identity().primaryKey(),
    addedAt: t.timestamp(),
  }
);

/** Server-configured allowlist of worker/service identities. */
export const serviceIdentity = table(
  { name: 'service_identity' },
  {
    identity: t.identity().primaryKey(),
    label: t.string(),
    addedAt: t.timestamp(),
  }
);

/**
 * One row per authenticated identity. Issuer/subject come from the JWT claims
 * that SpacetimeDB verified for the connection; they are never client-supplied.
 */
export const userAccount = table(
  { name: 'user_account' },
  {
    identity: t.identity().primaryKey(),
    issuer: t.string(),
    subject: t.string(),
    firstSeenAt: t.timestamp(),
    lastSeenAt: t.timestamp(),
  }
);

/** Investment preferences used by ranking. Owner-scoped, versioned. */
export const investmentProfile = table(
  { name: 'investment_profile' },
  {
    owner: t.identity().primaryKey(),
    schemaVersion: t.u16(),
    profileVersion: t.u32(),
    riskTolerance: t.string(),
    investmentHorizon: t.string(),
    investmentStyle: t.string(),
    sectorInterests: t.array(t.string()),
    experienceLevel: t.string(),
    primaryGoal: t.string(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/**
 * Presentation-only personalization. Kept in a separate table so ranking
 * inputs (`investment_profile`, `worker_job_profiles`) can never include it.
 */
export const profileBranding = table(
  { name: 'profile_branding' },
  {
    owner: t.identity().primaryKey(),
    zodiacSign: t.option(t.string()),
    updatedAt: t.timestamp(),
  }
);

/** Durable command/job record (PRD §9). */
export const job = table(
  {
    name: 'job',
    indexes: [
      {
        accessor: 'by_owner_request',
        algorithm: 'btree',
        columns: ['owner', 'requestKey'],
      },
    ],
  },
  {
    jobId: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    kind: t.string(),
    requestKey: t.string(),
    inputVersion: t.u32(),
    status: t.string().index('btree'),
    attemptCount: t.u32(),
    maxAttempts: t.u32(),
    leaseOwner: t.option(t.identity()),
    leaseUntil: t.option(t.timestamp()),
    availableAt: t.timestamp(),
    payload: t.string(),
    resultRef: t.option(t.string()),
    errorCode: t.option(t.string()),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

const spacetimedb = schema({
  moduleAdmin,
  serviceIdentity,
  userAccount,
  investmentProfile,
  profileBranding,
  job,
});
export default spacetimedb;
