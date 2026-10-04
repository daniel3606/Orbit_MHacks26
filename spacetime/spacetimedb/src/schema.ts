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
 * Zodiac sign. Kept in a separate table so ranking inputs (`investment_profile`,
 * `worker_job_profiles`) can never include it. Discovery copies it into its job
 * payload only to choose the day's theme; it is never a scoring input.
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
    logoUrl: t.string().default(''), // provider's https logo image; '' when it has none (ETFs)
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

/**
 * Fit components stored with each recommendation. `weight` is the rubric's
 * original weight. Unavailable components stay in the row so coverage can be
 * shown; they are not treated as a match.
 */
export const FitComponent = t.object('FitComponent', {
  name: t.string(),
  available: t.bool(),
  value: t.option(t.f64()),
  weight: t.f64(),
  reason: t.option(t.string()),
});

/**
 * The caller's current recommendation generation. The previous rows stay
 * readable until a newer publish commits in the same transaction.
 */
export const recommendationGeneration = table(
  { name: 'recommendation_generation' },
  {
    owner: t.identity().primaryKey(),
    generation: t.u64(),
    jobId: t.u64(),
    status: t.string(), // 'ready' | 'no_eligible' | 'insufficient_market'
    profileVersion: t.u32(),
    profileSchemaVersion: t.u16(),
    marketGeneration: t.u64(),
    signalAlgorithmVersion: t.string(),
    fitAlgorithmVersion: t.string(),
    signalSessionDate: t.string(),
    consideredCount: t.u16(),
    eligibleCount: t.u16(),
    publishedCount: t.u16(),
    summary: t.string(),
    limitations: t.array(t.string()),
    publishedAt: t.timestamp(),
  }
);

/** One row per recommended ticker in a generation. Private; caller view only. */
export const recommendation = table(
  {
    name: 'recommendation',
    indexes: [{ accessor: 'by_owner_generation', algorithm: 'btree', columns: ['owner', 'generation'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    generation: t.u64(),
    ticker: t.string(),
    displayRank: t.u16(),
    trendScore: t.f64(),
    fitScore: t.f64(),
    recommendationRank: t.f64(),
    fitCoverage: t.f64(),
    components: t.array(FitComponent),
    realizedVol: t.option(t.f64()),
    maxDrawdown: t.option(t.f64()),
    volSessions: t.u32(),
    drawdownSessions: t.u32(),
    sector: t.string(),
    benchmark: t.string(),
    sessionDate: t.string(),
    historySource: t.string(),
    matchReason: t.string(),
    marketActivity: t.string(),
    riskObservation: t.string(),
    learningNote: t.string(),
    limitations: t.array(t.string()),
  }
);

/**
 * One Discovery set per person per local calendar day. The reducer enforces
 * uniqueness on (owner, discoveryDate); a set never changes once published, so
 * reopening the tab the same day shows the same companies. Prices are not
 * stored here: cards read the live `market_quote` rows.
 */
export const dailyDiscovery = table(
  {
    name: 'daily_discovery',
    indexes: [{ accessor: 'by_owner_date', algorithm: 'btree', columns: ['owner', 'discoveryDate'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    discoveryDate: t.string(), // the person's local YYYY-MM-DD
    zodiacSign: t.option(t.string()), // navigation only; never a scoring input
    sectorId: t.string(),
    sectorName: t.string(),
    subthemeId: t.string(),
    title: t.string(),
    description: t.string(),
    algorithmVersion: t.string(),
    themeVersion: t.string(),
    marketGeneration: t.u64(),
    consideredCount: t.u16(),
    eligibleCount: t.u16(),
    jobId: t.u64(),
    createdAt: t.timestamp(),
  }
);

/** Companies in one Discovery set. Recent rows double as the person's discovery history. */
export const dailyDiscoveryItem = table(
  {
    name: 'daily_discovery_item',
    indexes: [{ accessor: 'by_discovery', algorithm: 'btree', columns: ['discoveryId'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    discoveryId: t.u64(),
    owner: t.identity().index('btree'),
    discoveryDate: t.string(),
    ticker: t.string(),
    rank: t.u16(),
    score: t.f64(),
    trendScore: t.option(t.f64()),
    fitScore: t.option(t.f64()),
    newsScore: t.option(t.f64()),
    momentumScore: t.option(t.f64()),
    noveltyScore: t.f64(),
    angle: t.string(),
    about: t.string(),
    reasons: t.array(t.string()),
    newsCount: t.u16(),
    newsHeadline: t.option(t.string()),
    newsSource: t.option(t.string()),
    newsUrl: t.option(t.string()),
    newsPublishedAt: t.option(t.timestamp()),
  }
);

/** One explicit paper-account binding. Not created on connect. */
export const paperBinding = table(
  { name: 'paper_binding' },
  {
    slot: t.string().primaryKey(),
    owner: t.identity(),
    providerAccountId: t.string(),
    boundAt: t.timestamp(),
  }
);

/** Latest Alpaca paper account snapshot for the bound owner. Money is micro-units (1e-6). */
export const paperAccount = table(
  { name: 'paper_account' },
  {
    owner: t.identity().primaryKey(),
    providerAccountId: t.string(),
    cashMicros: t.i64(),
    equityMicros: t.i64(),
    buyingPowerMicros: t.i64(),
    currency: t.string(),
    revision: t.u64(),
    providerTime: t.timestamp(),
    syncedAt: t.timestamp(),
    marketOpen: t.bool(),
    nextOpen: t.option(t.timestamp()),
    nextClose: t.option(t.timestamp()),
  }
);

/** Positions from the same revision as `paper_account`. Long-only quantities, micro-shares. */
export const paperPosition = table(
  {
    name: 'paper_position',
    indexes: [{ accessor: 'by_owner', algorithm: 'btree', columns: ['owner'] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    ticker: t.string(),
    quantityMicros: t.i64(),
    avgEntryMicros: t.i64(),
    marketValueMicros: t.option(t.i64()),
    unrealizedPlMicros: t.option(t.i64()),
    revision: t.u64(),
  }
);

/** Order intents and provider status. `queued` is not a fill. */
export const paperOrder = table(
  {
    name: 'paper_order',
    indexes: [{ accessor: 'by_owner_key', algorithm: 'btree', columns: ['owner', 'clientOrderKey'] }],
  },
  {
    orderId: t.u64().primaryKey().autoInc(),
    owner: t.identity().index('btree'),
    clientOrderKey: t.string(),
    ticker: t.string(),
    side: t.string(),
    quantityMicros: t.option(t.i64()),
    notionalMicros: t.option(t.i64()),
    quoteMicros: t.i64(),
    quoteTime: t.timestamp(),
    status: t.string(),
    providerOrderId: t.option(t.string()),
    filledQuantityMicros: t.i64(),
    filledAvgPriceMicros: t.option(t.i64()),
    rejectReason: t.option(t.string()),
    revision: t.u64(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  }
);

/**
 * One caller's assistant transcript. Private. `clientKey` makes a repeated tap
 * the same message. The model never writes this table directly.
 */
export const assistantMessage = table(
  {
    name: 'assistant_message',
    indexes: [
      { accessor: 'by_owner', algorithm: 'btree', columns: ['owner'] },
      { accessor: 'by_owner_key', algorithm: 'btree', columns: ['owner', 'clientKey'] },
    ],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    owner: t.identity(),
    sequence: t.u32(),
    role: t.string(), // 'user' | 'assistant'
    kind: t.string(), // 'chat' | 'brief'
    body: t.string(),
    citations: t.string(),
    status: t.string(), // 'pending' | 'complete' | 'failed'
    clientKey: t.string(),
    createdAt: t.timestamp(),
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
  recommendationGeneration,
  recommendation,
  dailyDiscovery,
  dailyDiscoveryItem,
  paperBinding,
  paperAccount,
  paperPosition,
  paperOrder,
  assistantMessage,
  marketSchedule,
});
export default spacetimedb;
