# Implementation status

_Last updated: 2026-10-03 · PRD phases 0–1 (integration proof, state and UI foundation)_

## Completed

**SpacetimeDB module** (`spacetime/spacetimedb/src`, TypeScript, SpacetimeDB 2.10.2)
- Private tables: `module_admin`, `service_identity`, `user_account`, `investment_profile`, `profile_branding`, `job`.
- Owner-authorized reducers `complete_onboarding` and `update_preferences`. Ownership always comes from `ctx.sender`, `expectedVersion` gives optimistic concurrency, and enum and sector values are validated against server-side lists.
- Zodiac is stored only in `profile_branding`. Ranking inputs (`worker_job_profiles`) cannot include it.
- Durable jobs (PRD §9):
  - `request_backend_check` is idempotent by request key and rate-limited.
  - Profile changes enqueue a coalesced `refresh_recommendations` job.
  - Worker reducers: `claim_job` (lease, with the attempt number as fencing token), `complete_job` (checks lease, expiry and input version; a duplicate is a no-op) and `fail_job` (backoff with jitter, attempt limit).
- Caller-scoped views: `my_account`, `my_profile`, `my_branding`, `my_jobs`.
- Service-gated views: `worker_jobs`, `worker_job_profiles` (lease-holder only) and `my_service_grant`.
- Admin-only `grant/revoke_service_identity`. The publisher becomes admin in `init`.

**Backend** (`backend/`, Python 3.14, FastAPI, uv)
- Typed settings validated by pydantic-settings. Secrets use `SecretStr`, and Alpaca accepts only the paper endpoint.
- `GET /health` and `GET /ready`. Readiness checks SpacetimeDB reachability and that the worker token is on the allowlist.
- v1 error envelope with request IDs.
- `SpacetimeGateway` over the documented HTTP API, with a schema-driven SATS-JSON decoder, versioned DTOs (`extra="forbid"`) and stable error mapping.
- Worker: poll → claim → confirm lease → handler (outside the transaction) → complete/fail. Bounded concurrency and idle backoff.
- The worker identity is created and granted by `scripts/bootstrap_service_identity.py`, with the token stored in a 0600 file.
- Provider protocols only: market data, news classifier, explanations, paper trading. No adapters and no fixtures.

**Mobile** (`mobile/`, Expo SDK 57, RN 0.86, Expo Router, Zustand)
- One managed connection (`src/realtime/connection.ts`):
  - Compression disabled.
  - Guest token kept in the Keychain (`THIS_DEVICE_ONLY`) and restored on launch.
  - The app is ready only after the subscription is applied.
  - AppState pause/resume, exponential reconnect, and generation-guarded callbacks so listeners never stack.
  - Survives Fast Refresh.
  - Never queues mutations offline.
- Shell: startup gate, protected routes, and tabs (Home, Discover, Practice). Discover and Practice show honest empty states and no placeholder data.
- Onboarding: 7 questions plus review, with the local draft in Zustand. Editing preferences detects conflicts. Banners cover loading, offline/stale, error and retry.
- In-app diagnostics: runtime API checks, connection counters, a backend round trip, and an explicit reset of the guest session.
- Provisional celestial design tokens and components (`src/ui`). No Figma reference was available.

**Tooling**: Makefile, README, `.env.example` for each component, committed lockfiles, a contract check between app and module option lists, and ESLint (eslint-config-expo).

## Verified

| Behavior | How |
|---|---|
| Subscription applied → reducer → row update | `spacetime/tests` (17 tests, Node SDK over WebSocket against the local server) |
| Two identities isolated; consumers see empty worker views | same, plus HTTP checks in `backend/tests/test_worker_integration.py` |
| Consumer calls to claim/complete/fail/grant rejected | same (`not_authorized_service`, `not_authorized_admin`) |
| Validation, optimistic versioning, branding-only edits keep the version | spacetime tests |
| Claim ownership, duplicate completion no-op, stale input rejected, backoff, lease expiry and reclaim with fencing, revocation | spacetime tests |
| Python gateway authenticated read and reducer path; worker enqueue → claim → complete | `backend/tests` (21 tests, 2 against the real server) |
| HTTP API contracts (arg encoding, sum/identity/timestamp row encoding, 530 = SenderError) | recorded fixtures in `backend/tests/fixtures` |
| Expo runtime: Hermes, `URL` (relative, protocol setter, searchParams), `TextDecoder`, `BigInt` | in-app diagnostics on the **iOS 26.3 simulator** (iPhone 17 Pro). No URL polyfill was needed: Expo 57's runtime provides WHATWG `URL` |
| Binary protocol encode/decode on Hermes | simulator: subscription applied and reducers succeeded |
| Onboarding saved → Home shows subscribed values; edit → version 2 shown | simulator, cross-checked with `spacetime sql` |
| Cold relaunch restores the same identity and profile from the Keychain | simulator (terminate + relaunch) |
| Server outage → stale banner with editing disabled → automatic reconnect | simulator (stopped and restarted `spacetime start`) |
| Background → socket torn down; foreground → reconnect; one live connection | simulator (Home button; diagnostics showed 1 live after 6 opens) |
| Device → backend round trip (tap → worker → subscribed result) | simulator diagnostics: job #3 succeeded in about 10.6 s with the old 15 s idle poll; the cap is now 5 s |
| Type and lint checks | `make typecheck`: tsc ×3, expo lint, contract check, mypy --strict |

## Prepared but not verified

- **Physical iPhone.** Nothing has run on a device. The address auto-derives from the Metro host; set `EXPO_PUBLIC_SPACETIME_URI` if needed. Checks still required on a device:
  - runtime diagnostics all green
  - onboarding saved
  - relaunch restores the session
  - airplane mode on/off reconnects
  - background ≥ 30 s then foreground
  - backend check succeeds over LAN
  - a release build (`expo run:ios --configuration Release`) behaves the same
- **OIDC / SpacetimeAuth.** Not configured. The app runs on device-bound guest identities, labeled as such in the UI.
- **FastAPI user authentication.** No user-authenticated routes exist. `GET /v1/identity/public-key` exists on the server and could verify guest tokens, but that mapping has not been built or tested.
- **Android.** Not run.

## Outstanding dependencies (supplied by you)

- **Figma**: the file or frame exports, plus confirmation of whether pre-event assets may be reused. The UI is provisional until then.
- **OIDC**: the SpacetimeAuth (or other provider) project, client ID and redirect URI for the Expo scheme `orbit://`.
- **Apple developer team**: needed to sign a build for a physical iPhone.
- **Provider keys** in `backend/.env`, needed from the next phases on:
  - `FINNHUB_API_KEY` (and confirmation of which plan tier covers history, news and benchmarks)
  - `JEV_API_KEY` and `JEV_BASE_URL`, plus API documentation (the contract is unverified)
  - `OPENAI_API_KEY`
  - `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` for the designated paper demo account

## Decisions and deviations

- The module lives at `spacetime/spacetimedb/src`, the official `spacetime init` layout. Routes live at `mobile/src/app`, the Expo SDK 57 default. The PRD names `spacetime/src` and `mobile/app`.
- The repo uses Node 24.15 (`.nvmrc`), because Expo SDK 57 requires Node ≥ 22.13. The machine default (Node 20) is unchanged.
- Preference enums are validated strings, which keeps the TypeScript and Python contracts simple. The values are listed in `preferences.ts` and checked against the app.
- `refresh_recommendations` jobs stay **queued** on purpose. There is no handler until ranking (Phase 4) exists, so no work is faked.
- I added the `my_service_grant` view so worker readiness can prove the token is on the allowlist.

## Next step (PRD Phase 0 remainder → Phase 2)

1. Run the physical-iPhone checks above and validate OIDC with SpacetimeAuth on device. Then bind FastAPI requests to verified tokens.
2. Check what the Alpaca paper account provides (balance, fractional orders) during Phase 0, as the PRD requires.
3. Phase 2: a Finnhub `MarketDataProvider` adapter after checking plan capabilities. Then `stocks`, `market_snapshots` and `trend_signals` tables with service-only publish reducers, and deterministic momentum, volume and volatility features with coverage tracking, published live without AI.
