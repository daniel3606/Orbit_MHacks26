import { AppState, type AppStateStatus } from 'react-native';

import { config } from '@/config/env';
import { AppError, toAppError } from './errors';
import { DbConnection, tables } from './module_bindings';
import { clearSession, loadSession, saveSession, type StoredSession } from './session-storage';

/**
 * One managed SpacetimeDB connection per app session (PRD §8).
 *
 * - Restores the device-bound guest token from secure storage.
 * - Treats the app as ready only after the session subscription is applied.
 * - Drives pause/resume from React Native AppState (the SDK's own resume
 *   handling listens for browser `document`/`window` events that do not exist
 *   in React Native).
 * - Every connection gets a generation number; callbacks from superseded
 *   connections are ignored, so reconnects never stack listeners.
 */

export type ConnectionStatus =
  | 'starting'
  | 'connecting'
  | 'syncing'
  | 'ready'
  | 'reconnecting'
  | 'paused'
  | 'error';

export type ProfileVM = {
  profileVersion: number;
  schemaVersion: number;
  riskTolerance: string;
  investmentHorizon: string;
  investmentStyle: string;
  sectorInterests: string[];
  experienceLevel: string;
  primaryGoal: string;
  createdAt: Date;
  updatedAt: Date;
};
export type BrandingVM = { zodiacSign: string | null; updatedAt: Date };
export type AccountVM = { identityHex: string; issuer: string; subject: string; firstSeenAt: Date };
export type JobVM = {
  jobId: string;
  kind: string;
  requestKey: string;
  status: string;
  attemptCount: number;
  inputVersion: number;
  resultRef: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Device time when this row version first arrived via subscription. */
  observedAt: Date;
};

export type Diagnostics = {
  uri: string;
  uriSource: string;
  database: string;
  connectCount: number;
  liveConnections: number;
  reconnectAttempt: number;
  connectedAt: Date | null;
  subscriptionAppliedAt: Date | null;
  lastEventAt: Date | null;
  lastDisconnectReason: string | null;
  sessionRestored: boolean;
  sessionPersisted: boolean | null;
};

export type StockVM = {
  ticker: string;
  name: string;
  exchange: string;
  industry: string;
  sector: string;
  kind: 'equity' | 'benchmark';
  benchmark: string;
  displayOrder: number;
};
export type QuoteVM = {
  ticker: string;
  price: number; // display only (fixed-point micros converted)
  previousClose: number;
  providerTime: Date;
  publishedAt: Date;
  source: string;
};
export type FeatureVM = {
  name: string;
  available: boolean;
  raw: number | null;
  normalized: number | null;
  weight: number;
  baselineCount: number;
  reason: string | null;
};
export type SignalVM = {
  ticker: string;
  status: string;
  trendScore: number | null;
  coverage: number;
  coverageScope: string;
  benchmark: string;
  sessionDate: string;
  historySessions: number;
  requiredSessions: number;
  dayReturn: number | null;
  benchmarkDayReturn: number | null;
  relativeDayReturn: number | null;
  features: FeatureVM[];
  notes: string[];
  algorithmVersion: string;
};
export type GenerationVM = {
  generation: string;
  publishedAt: Date;
  marketOpen: boolean;
  marketSession: string;
  marketStatusAt: Date;
  lastCompletedSession: string;
  provider: string;
  algorithmVersion: string;
};
export type CapabilityVM = { key: string; capability: string; available: boolean; detail: string; checkedAt: Date };
export type MarketVM = {
  /** A screen currently holds the market subscription. */
  subscribed: boolean;
  /** Authoritative market rows received for the current subscription. */
  applied: boolean;
  error: string | null;
  stocks: StockVM[];
  quotes: Record<string, QuoteVM>;
  signals: Record<string, SignalVM>;
  generation: GenerationVM | null;
  capabilities: CapabilityVM[];
};

const EMPTY_MARKET: MarketVM = {
  subscribed: false,
  applied: false,
  error: null,
  stocks: [],
  quotes: {},
  signals: {},
  generation: null,
  capabilities: [],
};

const micros = (v: bigint) => Number(v) / 1_000_000;

export type RealtimeSnapshot = {
  status: ConnectionStatus;
  /** Authoritative state was received at least once for the current identity. */
  hasSynced: boolean;
  /** Showing last-known data while not live. */
  stale: boolean;
  identityHex: string | null;
  error: AppError | null;
  account: AccountVM | null;
  profile: ProfileVM | null;
  branding: BrandingVM | null;
  jobs: JobVM[];
  market: MarketVM;
  diagnostics: Diagnostics;
};

const REDUCER_TIMEOUT_MS = 10_000;
const MAX_BACKOFF_MS = 30_000;

const toDate = (ts: { toDate(): Date }) => ts.toDate();

function initialSnapshot(): RealtimeSnapshot {
  return {
    status: 'starting',
    hasSynced: false,
    stale: false,
    identityHex: null,
    error: null,
    account: null,
    profile: null,
    branding: null,
    jobs: [],
    market: EMPTY_MARKET,
    diagnostics: {
      uri: config.spacetimeUri,
      uriSource: config.spacetimeUriSource,
      database: config.spacetimeDatabase,
      connectCount: 0,
      liveConnections: 0,
      reconnectAttempt: 0,
      connectedAt: null,
      subscriptionAppliedAt: null,
      lastEventAt: null,
      lastDisconnectReason: null,
      sessionRestored: false,
      sessionPersisted: null,
    },
  };
}

class ConnectionManager {
  private snapshot: RealtimeSnapshot = initialSnapshot();
  private listeners = new Set<() => void>();
  private conn: DbConnection | null = null;
  private generation = 0;
  private started = false;
  private stored: StoredSession | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private appState: AppStateStatus = AppState.currentState;
  private recomputeQueued = false;
  private detachTableListeners: (() => void) | null = null;
  private jobObservations = new Map<string, { updatedAtMicros: bigint; observedAt: Date }>();
  private marketRefs = 0;
  private marketHandle: { unsubscribe(): void; isActive(): boolean } | null = null;

  // ---- store plumbing (useSyncExternalStore) ----

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  private patch(update: Partial<RealtimeSnapshot>, diagnostics?: Partial<Diagnostics>) {
    this.snapshot = {
      ...this.snapshot,
      ...update,
      diagnostics: diagnostics ? { ...this.snapshot.diagnostics, ...diagnostics } : this.snapshot.diagnostics,
    };
    for (const l of this.listeners) l();
  }

  // ---- lifecycle ----

  start() {
    if (this.started) return;
    this.started = true;
    AppState.addEventListener('change', this.onAppStateChange);
    void this.bootstrap();
  }

  private async bootstrap() {
    try {
      this.stored = await loadSession(config.sessionScope, config.spacetimeDatabase);
    } catch (err) {
      this.fail(toAppError(err));
      return;
    }
    this.patch({}, { sessionRestored: this.stored !== null });
    this.connect();
  }

  private onAppStateChange = (next: AppStateStatus) => {
    const prev = this.appState;
    this.appState = next;
    if (next === 'background') {
      // Release the socket instead of letting iOS kill it mid-frame.
      this.teardown('backgrounded');
      if (this.snapshot.status !== 'error') this.patch({ status: 'paused', stale: this.snapshot.hasSynced });
    } else if (next === 'active' && prev !== 'active') {
      if (this.snapshot.status === 'paused' || this.snapshot.status === 'reconnecting') {
        this.patch({}, { reconnectAttempt: 0 });
        this.connect();
      }
    }
  };

  private connect() {
    this.teardown('superseded');
    const gen = ++this.generation;
    const isCurrent = () => gen === this.generation;

    this.patch(
      { status: this.snapshot.hasSynced ? 'reconnecting' : 'connecting', error: null, stale: this.snapshot.hasSynced },
      { connectCount: this.snapshot.diagnostics.connectCount + 1 }
    );

    let counted = false;
    const conn = DbConnection.builder()
      .withUri(config.spacetimeUri)
      .withDatabaseName(config.spacetimeDatabase)
      .withToken(this.stored?.token)
      // Hermes has no DecompressionStream; gzip frames could not be decoded.
      .withCompression('none')
      .onConnect((connected, identity, token) => {
        if (!isCurrent()) {
          connected.disconnect();
          return;
        }
        counted = true;
        this.patch({}, { liveConnections: this.snapshot.diagnostics.liveConnections + 1, connectedAt: new Date() });
        void this.afterConnect(conn, gen, identity.toHexString(), token);
      })
      .onConnectError((_ctx, err) => {
        if (!isCurrent()) return;
        const message = err?.message ?? String(err);
        if (/verify token|401|Unauthorized/i.test(message)) {
          this.fail(new AppError('session_rejected', message));
        } else {
          this.scheduleReconnect(message);
        }
      })
      .onDisconnect((_ctx, err) => {
        if (counted) {
          counted = false;
          this.patch({}, { liveConnections: Math.max(0, this.snapshot.diagnostics.liveConnections - 1) });
        }
        if (!isCurrent()) return;
        this.scheduleReconnect(err?.message ?? 'connection closed');
      })
      .build();
    this.conn = conn;
  }

  private async afterConnect(conn: DbConnection, gen: number, identityHex: string, token: string) {
    const isCurrent = () => gen === this.generation;

    if (this.stored && this.stored.identityHex !== identityHex) {
      // Never overwrite a stored session with a different identity.
      this.fail(new AppError('identity_changed'));
      return;
    }
    if (this.snapshot.identityHex && this.snapshot.identityHex !== identityHex) {
      this.clearData();
    }
    let persisted = true;
    if (!this.stored || this.stored.token !== token) {
      const session = { token, identityHex, createdAt: this.stored?.createdAt || new Date().toISOString() };
      try {
        await saveSession(config.sessionScope, config.spacetimeDatabase, session);
        this.stored = session;
      } catch {
        persisted = false;
      }
    }
    if (!isCurrent()) return;
    this.patch({ status: 'syncing', identityHex }, { sessionPersisted: persisted });

    this.detachTableListeners = this.attachTableListeners(conn, isCurrent);
    conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (!isCurrent()) return;
        this.recompute();
        this.patch(
          { status: 'ready', hasSynced: true, stale: false, error: null },
          { subscriptionAppliedAt: new Date(), reconnectAttempt: 0 }
        );
        if (this.marketRefs > 0) this.subscribeMarket(conn, isCurrent);
      })
      .onError(ctx => {
        if (!isCurrent()) return;
        this.fail(new AppError('subscription_failed', ctx.event?.message));
      })
      .subscribe([tables.myAccount, tables.myProfile, tables.myBranding, tables.myJobs]);
  }

  private attachTableListeners(conn: DbConnection, isCurrent: () => boolean) {
    const onChange = () => {
      if (isCurrent()) this.queueRecompute();
    };
    const detach: (() => void)[] = [];
    const tables = [
      conn.db.myAccount,
      conn.db.myProfile,
      conn.db.myBranding,
      conn.db.myJobs,
      conn.db.stock,
      conn.db.marketQuote,
      conn.db.trendSignal,
      conn.db.marketGeneration,
      conn.db.providerCapability,
    ] as const;
    for (const table of tables) {
      table.onInsert(onChange);
      table.onDelete(onChange);
      detach.push(() => {
        table.removeOnInsert(onChange);
        table.removeOnDelete(onChange);
      });
    }
    for (const table of tables) {
      table.onUpdate(onChange);
      detach.push(() => table.removeOnUpdate(onChange));
    }
    return () => detach.forEach(fn => fn());
  }

  private queueRecompute() {
    if (this.recomputeQueued) return;
    this.recomputeQueued = true;
    queueMicrotask(() => {
      this.recomputeQueued = false;
      if (this.snapshot.status === 'ready' || this.snapshot.status === 'syncing') this.recompute();
    });
  }

  /** Projects the SDK client cache into plain view models. */
  private recompute() {
    const conn = this.conn;
    if (!conn) return;
    const p = [...conn.db.myProfile.iter()][0];
    const b = [...conn.db.myBranding.iter()][0];
    const a = [...conn.db.myAccount.iter()][0];
    const jobs = [...conn.db.myJobs.iter()]
      .map((j): JobVM => {
        const jobId = j.jobId.toString();
        const updatedAtMicros = j.updatedAt.microsSinceUnixEpoch;
        let seen = this.jobObservations.get(jobId);
        if (!seen || seen.updatedAtMicros !== updatedAtMicros) {
          seen = { updatedAtMicros, observedAt: new Date() };
          this.jobObservations.set(jobId, seen);
        }
        return {
          jobId,
          kind: j.kind,
          requestKey: j.requestKey,
          status: j.status,
          attemptCount: j.attemptCount,
          inputVersion: j.inputVersion,
          resultRef: j.resultRef ?? null,
          errorCode: j.errorCode ?? null,
          createdAt: toDate(j.createdAt),
          updatedAt: toDate(j.updatedAt),
          observedAt: seen.observedAt,
        };
      })
      .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime());

    const market: MarketVM = this.marketRefs > 0 ? this.projectMarket(conn) : EMPTY_MARKET;

    this.patch(
      {
        market,
        profile: p
          ? {
              profileVersion: p.profileVersion,
              schemaVersion: p.schemaVersion,
              riskTolerance: p.riskTolerance,
              investmentHorizon: p.investmentHorizon,
              investmentStyle: p.investmentStyle,
              sectorInterests: [...p.sectorInterests],
              experienceLevel: p.experienceLevel,
              primaryGoal: p.primaryGoal,
              createdAt: toDate(p.createdAt),
              updatedAt: toDate(p.updatedAt),
            }
          : null,
        branding: b ? { zodiacSign: b.zodiacSign ?? null, updatedAt: toDate(b.updatedAt) } : null,
        account: a
          ? { identityHex: a.identity.toHexString(), issuer: a.issuer, subject: a.subject, firstSeenAt: toDate(a.firstSeenAt) }
          : null,
        jobs,
      },
      { lastEventAt: new Date() }
    );
  }

  private projectMarket(conn: DbConnection): MarketVM {
    const g = [...conn.db.marketGeneration.iter()][0];
    const quotes: Record<string, QuoteVM> = {};
    for (const q of conn.db.marketQuote.iter()) {
      quotes[q.ticker] = {
        ticker: q.ticker,
        price: micros(q.priceMicros),
        previousClose: micros(q.previousCloseMicros),
        providerTime: toDate(q.providerTime),
        publishedAt: toDate(q.publishedAt),
        source: q.source,
      };
    }
    const signals: Record<string, SignalVM> = {};
    for (const s of conn.db.trendSignal.iter()) {
      signals[s.ticker] = {
        ticker: s.ticker,
        status: s.status,
        trendScore: s.trendScore ?? null,
        coverage: s.coverage,
        coverageScope: s.coverageScope,
        benchmark: s.benchmark,
        sessionDate: s.sessionDate,
        historySessions: s.historySessions,
        requiredSessions: s.requiredSessions,
        dayReturn: s.dayReturn ?? null,
        benchmarkDayReturn: s.benchmarkDayReturn ?? null,
        relativeDayReturn: s.relativeDayReturn ?? null,
        features: s.features.map(f => ({
          name: f.name,
          available: f.available,
          raw: f.raw ?? null,
          normalized: f.normalized ?? null,
          weight: f.weight,
          baselineCount: f.baselineCount,
          reason: f.reason ?? null,
        })),
        notes: [...s.notes],
        algorithmVersion: s.algorithmVersion,
      };
    }
    return {
      subscribed: true,
      applied: this.snapshot.market.applied,
      error: this.snapshot.market.error,
      stocks: [...conn.db.stock.iter()]
        .filter(s => s.active)
        .map(s => ({
          ticker: s.ticker,
          name: s.name,
          exchange: s.exchange,
          industry: s.industry,
          sector: s.sector,
          kind: s.kind === 'benchmark' ? ('benchmark' as const) : ('equity' as const),
          benchmark: s.benchmark,
          displayOrder: s.displayOrder,
        }))
        .sort((a, b) => a.displayOrder - b.displayOrder),
      quotes,
      signals,
      generation: g
        ? {
            generation: g.generation.toString(),
            publishedAt: toDate(g.publishedAt),
            marketOpen: g.marketOpen,
            marketSession: g.marketSession,
            marketStatusAt: toDate(g.marketStatusAt),
            lastCompletedSession: g.lastCompletedSession,
            provider: g.provider,
            algorithmVersion: g.algorithmVersion,
          }
        : null,
      capabilities: [...conn.db.providerCapability.iter()].map(c => ({
        key: c.key,
        capability: c.capability,
        available: c.available,
        detail: c.detail,
        checkedAt: toDate(c.checkedAt),
      })),
    };
  }

  /** Screen-scoped subscription to shared market projections (never the history tables). */
  private subscribeMarket(conn: DbConnection, isCurrent: () => boolean) {
    if (this.marketHandle?.isActive()) return;
    this.patch({ market: { ...this.snapshot.market, subscribed: true, applied: false, error: null } });
    this.marketHandle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        if (!isCurrent() || this.marketRefs === 0) return;
        this.patch({ market: { ...this.snapshot.market, applied: true, error: null } });
        this.recompute();
      })
      .onError(ctx => {
        if (!isCurrent()) return;
        this.patch({ market: { ...this.snapshot.market, error: ctx.event?.message ?? 'subscription_failed' } });
      })
      .subscribe([tables.stock, tables.marketQuote, tables.trendSignal, tables.marketGeneration, tables.providerCapability]);
  }

  /** Call when a market screen gains focus; returns the release function. */
  acquireMarket(): () => void {
    this.marketRefs += 1;
    if (this.marketRefs === 1 && this.conn && this.snapshot.status === 'ready') {
      const gen = this.generation;
      this.subscribeMarket(this.conn, () => gen === this.generation);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.marketRefs -= 1;
      if (this.marketRefs === 0) {
        try {
          if (this.marketHandle?.isActive()) this.marketHandle.unsubscribe();
        } catch {
          // connection already gone
        }
        this.marketHandle = null;
        this.patch({ market: EMPTY_MARKET });
      }
    };
  }

  private scheduleReconnect(reason: string) {
    this.teardown('lost');
    const attempt = this.snapshot.diagnostics.reconnectAttempt + 1;
    this.patch(
      { status: 'reconnecting', stale: this.snapshot.hasSynced },
      { reconnectAttempt: attempt, lastDisconnectReason: reason }
    );
    if (this.appState !== 'active') {
      this.patch({ status: 'paused' });
      return;
    }
    const base = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const delay = base * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private fail(error: AppError) {
    this.teardown('error');
    this.patch({ status: 'error', error, stale: this.snapshot.hasSynced });
  }

  /** Invalidates the current connection; its callbacks become no-ops. */
  private teardown(reason: string) {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.generation++;
    this.detachTableListeners?.();
    this.detachTableListeners = null;
    this.marketHandle = null; // dies with the connection; re-subscribed after reconnect
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      this.patch({}, { lastDisconnectReason: reason });
      try {
        conn.disconnect();
      } catch {
        // already closed
      }
    }
  }

  private clearData() {
    this.jobObservations.clear();
    this.patch({ hasSynced: false, stale: false, identityHex: null, account: null, profile: null, branding: null, jobs: [] });
  }

  // ---- public actions ----

  retry() {
    this.patch({}, { reconnectAttempt: 0 });
    this.connect();
  }

  /**
   * Discards this device's guest identity. The old identity's data stays on
   * the server but becomes unreachable from this device — there is no
   * cross-device or post-reset recovery for guest sessions.
   */
  async resetGuestSession() {
    this.teardown('reset');
    await clearSession(config.sessionScope, config.spacetimeDatabase);
    this.stored = null;
    this.clearData();
    this.patch({ error: null }, { sessionRestored: false, sessionPersisted: null, subscriptionAppliedAt: null });
    this.connect();
  }

  /** Runs a reducer only while live; never queues offline mutations. */
  async call(run: (conn: DbConnection) => Promise<void>): Promise<void> {
    const conn = this.conn;
    if (!conn || this.snapshot.status !== 'ready') throw new AppError('not_connected');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError('request_timeout')), REDUCER_TIMEOUT_MS);
    });
    try {
      await Promise.race([run(conn), timeout]);
    } catch (err) {
      throw toAppError(err);
    } finally {
      clearTimeout(timer);
    }
  }
}

// Survive Fast Refresh without opening a second connection.
const holder = globalThis as unknown as { __orbitRealtime?: ConnectionManager };
export const realtime = (holder.__orbitRealtime ??= new ConnectionManager());
