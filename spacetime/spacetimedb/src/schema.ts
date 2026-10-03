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
      {
        accessor: 'by_status_kind',
        algorithm: 'btree',
        columns: ['status', 'kind'],
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

/** Job kinds each worker identity handles; `worker_jobs` returns only these. */
export const workerRegistration = table(
  { name: 'worker_registration' },
  {
    identity: t.identity().primaryKey(),
    kinds: t.array(t.string()),
    registeredAt: t.timestamp(),
  }
);

/** Admin-set flags (PRD `service_config`). */
export const serviceConfig = table(
  { name: 'service_config' },
  {
    key: t.string().primaryKey(),
    boolValue: t.bool(),
    updatedAt: t.timestamp(),
  }
);

// ---- Market data (Phase 2). Latest projections are public and read-only to
// clients; every write goes through service-only reducers. ----

/** Supported universe and benchmarks. `sector` uses Orbit's onboarding vocabulary. */
export const stock = table(
  { name: 'stock', public: true },
  {
    ticker: t.string().primaryKey(),
    name: t.string(),
    exchange: t.string(),
    industry: t.string(),
    sector: t.string(),
    currency: t.string(),
    kind: t.string(), // 'equity' | 'benchmark'
    benchmark: t.string(), // benchmark ticker for relative features; '' for benchmarks
    displayOrder: t.u16(),
    active: t.bool().index('btree'),
    updatedAt: t.timestamp(),
  }
);

/**
 * Latest quote per ticker. Prices are fixed-point micro-units (1e-6) of the
 * listed currency. `providerTime` is the provider's own data timestamp.
 */
export const marketQuote = table(
  { name: 'market_quote', public: true },
  {
    ticker: t.string().primaryKey(),
    generation: t.u64(),
    priceMicros: t.i64(),
    previousCloseMicros: t.i64(),
    openMicros: t.i64(),
    highMicros: t.i64(),
    lowMicros: t.i64(),
    providerTime: t.timestamp(),
    ingestedAt: t.timestamp(),
    publishedAt: t.timestamp(),
    source: t.string(),
  }
);

export const SignalFeature = t.object('SignalFeature', {
  name: t.string(),
  available: t.bool(),
  raw: t.option(t.f64()),
  normalized: t.option(t.f64()),
  weight: t.f64(),
  sampleCount: t.u32(),
  baselineCount: t.u32(),
  reason: t.option(t.string()),
});

/** Latest deterministic signal per ticker (heuristic; not a probability). */
export const trendSignal = table(
  { name: 'trend_signal', public: true },
  {
    ticker: t.string().primaryKey(),
    generation: t.u64(),
    algorithmVersion: t.string(),
    sessionDate: t.string(),
    status: t.string(), // 'published' | 'insufficient_data'
    trendScore: t.option(t.f64()),
    composite: t.option(t.f64()),
    coverage: t.f64(),
    coverageScope: t.string(),
    benchmark: t.string(),
    historySessions: t.u32(),
    requiredSessions: t.u32(),
    dayReturn: t.option(t.f64()),
    benchmarkDayReturn: t.option(t.f64()),
    relativeDayReturn: t.option(t.f64()),
    features: t.array(SignalFeature),
    notes: t.array(t.string()),
    asOf: t.timestamp(),
    publishedAt: t.timestamp(),
  }
);

/** Bounded per-ticker feature history (private). */
export const trendSignalHistory = table(
  {
    name: 'trend_signal_history',
    indexes: [{ accessor: 'by_ticker', algorithm: 'btree', columns: ['ticker'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    ticker: t.string(),
    generation: t.u64(),
    algorithmVersion: t.string(),
    sessionDate: t.string(),
    status: t.string(),
    trendScore: t.option(t.f64()),
    coverage: t.f64(),
    features: t.array(SignalFeature),
    asOf: t.timestamp(),
    publishedAt: t.timestamp(),
  }
);

/** Completed-session bars (private, bounded). Volume/OHLC absent when the source lacks them. */
export const dailyBar = table(
  {
    name: 'daily_bar',
    indexes: [{ accessor: 'by_ticker_date', algorithm: 'btree', columns: ['ticker', 'sessionDate'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    ticker: t.string(),
    sessionDate: t.string(),
    openMicros: t.option(t.i64()),
    highMicros: t.option(t.i64()),
    lowMicros: t.option(t.i64()),
    closeMicros: t.i64(),
    volume: t.option(t.u64()),
    adjusted: t.bool(),
    source: t.string(),
    ingestedAt: t.timestamp(),
  }
);

/** Current coherent market generation (one row per scope). */
export const marketGeneration = table(
  { name: 'market_generation', public: true },
  {
    scope: t.string().primaryKey(),
    generation: t.u64(),
    jobId: t.u64(),
    asOf: t.timestamp(),
    publishedAt: t.timestamp(),
    marketOpen: t.bool(),
    marketSession: t.string(),
    marketStatusAt: t.timestamp(),
    lastCompletedSession: t.string(),
    quoteCount: t.u32(),
    signalCount: t.u32(),
    algorithmVersion: t.string(),
    provider: t.string(),
  }
);

/** What the configured provider account can actually access (probed, not assumed). */
export const providerCapability = table(
  { name: 'provider_capability', public: true },
  {
    key: t.string().primaryKey(),
    provider: t.string(),
    capability: t.string(),
    available: t.bool(),
    detail: t.string(),
    checkedAt: t.timestamp(),
  }
);

/** Repeating schedule that enqueues shared market ingestion (not user commands). */
export const marketSchedule = table(
  { name: 'market_schedule' },
  {
    scheduledId: t.u64().primaryKey().autoInc(),
    scheduledAt: t.scheduleAt(),
    intervalSeconds: t.u32(),
  }
);

const spacetimedb = schema({
  moduleAdmin,
  serviceIdentity,
  userAccount,
  investmentProfile,
  profileBranding,
  job,
  workerRegistration,
  serviceConfig,
  stock,
  marketQuote,
  trendSignal,
  trendSignalHistory,
  dailyBar,
  marketGeneration,
  providerCapability,
  marketSchedule,
});
export default spacetimedb;
