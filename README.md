# Orbit

A beginner-friendly investing companion: **Discover → Understand → Practice** with virtual money.
The product and architecture spec is [Orbit_PRD_SpacetimeDB.md](Orbit_PRD_SpacetimeDB.md); current progress is in
[IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).

| Path | Component | Responsibility |
|---|---|---|
| [spacetime/](spacetime/) | SpacetimeDB TypeScript module | Persistent app state, owner-authorized reducers, caller-scoped and service-gated views, durable jobs |
| [backend/](backend/) | FastAPI + Python worker | Health/readiness, `SpacetimeGateway` (HTTP API), job worker, provider interfaces |
| [mobile/](mobile/) | Expo (SDK 57) + Expo Router + Zustand | App shell, onboarding, subscribed profile, connection lifecycle, diagnostics |

## Pinned toolchain

| Tool | Version | Notes |
|---|---|---|
| SpacetimeDB CLI / server | 2.10.2 | `curl -sSf https://install.spacetimedb.com \| sh` → `~/.local/bin/spacetime` |
| `spacetimedb` npm (module, tests, mobile) | 2.10.2 (exact) | Must match the CLI used for `generate` |
| Node | 24.15.0 (`.nvmrc`) | Expo SDK 57 / RN 0.86 require ≥ 22.13 |
| Python / uv | 3.14 / uv 0.9 | `backend/uv.lock` |
| Xcode / CocoaPods | 27 / 1.16 | CocoaPods needs `LANG=en_US.UTF-8` (the Makefile sets it) |

## First-time setup

```bash
nvm use
```

```bash
make install
```

Terminal 1 — local SpacetimeDB (keep running):

```bash
make stdb-start
```

Terminal 2 — publish the module and create the worker identity:

```bash
make publish
```

```bash
make worker-identity
```

`make worker-identity` creates a service identity via `POST /v1/identity`, stores its token in
`backend/.secrets/service_token` (gitignored, mode 0600), and allowlists it by calling the admin-only
`grant_service_identity` reducer with your local `spacetime` CLI identity (the module admin, because it published).

## Run

```bash
make api
```

```bash
make worker
```

```bash
make mobile-ios
```

`make mobile-ios` builds the development client, installs it on the simulator (`SIM="iPhone 17 Pro"` by default),
and starts Metro. After the first build, `make mobile-start` is enough.

Check the backend: `curl localhost:8000/health` (liveness) and `curl localhost:8000/ready` (SpacetimeDB reachable
and the worker token allowlisted).

### Market data (Phase 2)

- Put `FINNHUB_API_KEY` in `backend/.env` (backend only). `make worker` then registers the `ingest_market` job kind.
- The module schedules one shared `ingest_market` job every 300 s (`market_schedule`). For an existing database,
  create or change the schedule once as admin:
  `spacetime call --no-config orbit-dev --server local configure_market_schedule 300`.
- `make ingest-now` runs ingestion immediately. Overlapping requests coalesce into one active job.
- Universe: [backend/app/config/universe.json](backend/app/config/universe.json) lists 11 equities, each with a
  SPDR sector ETF benchmark, and SPY as the fallback. Settings: [backend/app/signals/config.py](backend/app/signals/config.py)
  (`trend-v1.0.0`).
- Fixture data is rejected unless an admin runs `set_service_flag "allow_fixture_data" true`. Only the tests do
  this, and only on `orbit-test`.

### Physical iPhone

`localhost` on the phone is the phone. In development the app derives the SpacetimeDB address from the Metro host
(`ws://<your-mac-LAN-IP>:3000`), which works when the phone and Mac share a network. If it does not, copy
`mobile/.env.example` to `mobile/.env` and set `EXPO_PUBLIC_SPACETIME_URI=ws://<mac-LAN-IP>:3000`. Build to the
device with `cd mobile && npx expo run:ios --device` (requires an Apple developer signing team in Xcode).
The in-app **Connection diagnostics** screen shows the resolved address and runtime checks.

## Tests and checks

```bash
make check
```

- `make test-spacetime` — republishes a throwaway `orbit-test` database (data wiped) and runs 25 WebSocket SDK
  integration tests:
  - subscription-then-mutation, two-identity isolation, validation, optimistic versioning, session restore
  - worker gating, idempotent enqueue, claim/complete, duplicate completion, backoff, lease-expiry fencing, revocation
  - market publication authorization, stale/out-of-order/invalid snapshots
  - Python worker → SpacetimeDB → subscribed client (labeled fixture provider)
- `make test-backend` — unit tests (hand-calculated features, prior-only normalization, coverage, provider retry,
  rate limits and deduplication, calendar) plus real-server worker round trips against `orbit-test`. The
  real-server tests are skipped automatically if the server or database is absent.
- `make test-live` — opt-in checks against the real Finnhub API with your key. Kept separate from fixture tests.
- `make typecheck` — `tsc` for module, tests and app; `expo lint`; app ↔ module preference-contract check; `mypy --strict`.

## Changing the module

1. Edit `spacetime/spacetimedb/src/*`.
2. `make publish` (additive changes migrate in place; breaking changes are refused — never reset a populated
   database just to fix types).
3. `make generate` and commit the regenerated bindings together with the module change.

## Configuration

| File | Purpose |
|---|---|
| `backend/.env.example` → `backend/.env` | Backend settings; provider keys are optional in this phase |
| `mobile/.env.example` → `mobile/.env` | Public client config only (`EXPO_PUBLIC_*` is bundled into the app) |
| `spacetime/.env.example` | Test script variables; the module itself has no env vars |

Secrets never go in `EXPO_PUBLIC_*` variables or in source control. Alpaca configuration accepts only the paper
endpoint.

## Authentication status

This build uses **device-bound guest sessions**: SpacetimeDB issues an identity on first connect, and the app keeps
its token in the iOS Keychain (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`). It is not an account and cannot be recovered
on another device or after “Start a new guest session”. The PRD's OIDC/SpacetimeAuth flow is not yet configured;
FastAPI exposes no user-authenticated routes until that mapping is verified.
