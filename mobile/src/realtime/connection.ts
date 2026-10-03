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
    for (const table of [conn.db.myAccount, conn.db.myProfile, conn.db.myBranding, conn.db.myJobs] as const) {
      table.onInsert(onChange);
      table.onDelete(onChange);
      detach.push(() => {
        table.removeOnInsert(onChange);
        table.removeOnDelete(onChange);
      });
    }
    for (const table of [conn.db.myAccount, conn.db.myProfile, conn.db.myBranding, conn.db.myJobs] as const) {
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

    this.patch(
      {
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
