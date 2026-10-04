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
and the worker token allowlisted). `/ready` reports Jev as `not_configured`, `configured` (key present, no successful
call recorded), `verified` (the worker got a schema-valid response), or `fail`, with the reason in `details.jev`.

### Market data (Phase 2)

- Put `FINNHUB_API_KEY` in `backend/.env` (backend only). `make worker` then registers the `ingest_market` job kind.
- The module schedules one shared `ingest_market` job every 300 s (`market_schedule`). For an existing database,
  create or change the schedule once as admin:
  `spacetime call --no-config orbit-dev --server local configure_market_schedule 300`.
- `make ingest-now` runs ingestion immediately. Overlapping requests coalesce into one active job.
- Universe: [backend/app/config/universe.json](backend/app/config/universe.json) lists 114 well-known US-listed
  equities, each with a SPDR sector ETF benchmark (XLRE added for real estate), and SPY as the fallback. Settings:
  [backend/app/signals/config.py](backend/app/signals/config.py) (`trend-v1.0.0`). New tickers backfill history a few
  per run (`BACKFILL_BAR_BUDGET` in `app/market/ingest.py` keeps each publish under SpacetimeDB's ~2 MB request limit),
  and company profiles are fetched once and then reused. Ingestion runs on its own worker lane.
- Finnhub's per-minute budget is split: `FINNHUB_INTERACTIVE_CALLS_PER_MINUTE` (default 10) is kept for news that a
  person is waiting on (Discovery, briefs, chat); ingestion uses the rest of `FINNHUB_CALLS_PER_MINUTE`.

### Daily Discovery

- The Discover tab requests `request_daily_discovery(localDate)`; the worker's `daily_discovery` job picks today's
  theme from the sign and publishes one set per person per local day through `publish_daily_discovery`. Reopening the
  tab the same day shows the same companies with live prices.
- Themes, sub-themes, candidate companies and their curated traits:
  [backend/app/config/discovery_themes.json](backend/app/config/discovery_themes.json). Weights and windows:
  [backend/app/discovery/config.py](backend/app/discovery/config.py) (`discovery-v1.0.0`).
- Constellation art is rasterized from the Figma exports in `mobile/assets/images/constellations/source/`:
  `node mobile/scripts/rasterize-constellations.mjs` (needs Google Chrome).
- Fixture data is rejected unless an admin runs `set_service_flag "allow_fixture_data" true`. Only the tests do
  this, and only on `orbit-test`.

### News classification (Jev)

- Jev is TypeSafe's decision model, called through OpenRouter's Decisions API
  (`POST https://openrouter.ai/api/alpha/decisions`). Put an OpenRouter API key in `backend/.env` as `JEV_API_KEY`
  (backend only), then restart `make worker`. Settings: `JEV_MODEL` (pinned `typesafe/jev-1.13`),
  `JEV_TIMEOUT_SECONDS`, `JEV_CALLS_PER_MINUTE`, `JEV_BURST`, `JEV_MAX_RETRIES`.
- On start the worker sends one fixed probe article and publishes the result as the `jev.news_classification`
  provider capability. That row is what `/ready` reads.
- The worker classifies the Finnhub headlines that Discovery and the assistant already fetch. Results are cached by
  article content, ticker and classifier version, shared by every job, and stored in the private
  `news_classification` table under the job's lease. Jev never changes a Discovery score or a Trend Score; see
  [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md#news-classification-jev-news-v1-2026-10-04) for what each label feeds.
- Without a key, or when Jev fails, news stays unlabeled and each consumer records why (`not_configured`,
  `unavailable:auth_failed`, …). Nothing falls back to OpenAI, and nothing is read as neutral sentiment.
- `ORBIT_LIVE_PROVIDER_TESTS=1 uv run pytest -q -s tests/test_jev_live.py` checks the live contract (billed calls).

### Paper trading

- Keep `ALPACA_BASE_URL` on `https://paper-api.alpaca.markets`. Market-data keys use `data.alpaca.markets` and cannot place orders.
- Bind one guest, once, as the module admin. A different identity is rejected:

  `spacetime call orbit-dev bind_paper_demo --server local '"0x<64 hex characters>"'`

- Put that same identity in `backend/.env` as `PAPER_DEMO_IDENTITY`, then restart `make worker`. Without it, paper jobs are not registered.
- The bound guest reviews an order on the stock screen and must press **Confirm paper order**. Practice shows the Alpaca cash and equity after the worker syncs. No balance is invented.
- On this `orbit-dev` database the bound guest is the profile with moderate risk, a months horizon, and financials only. The synced paper cash is $100,000. There are no open orders.

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

- `make test-spacetime` — republishes a throwaway `orbit-test` database (data wiped) and runs the WebSocket SDK
  integration tests:
  - subscription-then-mutation, two-identity isolation, validation, optimistic versioning, session restore
  - worker gating, idempotent enqueue, claim/complete, duplicate completion, backoff, lease-expiry fencing, revocation
  - market publication authorization, stale/out-of-order/invalid snapshots
  - recommendation publication, owner isolation, and stale-profile rejection
  - paper-order ownership, idempotent client keys, stale account revisions, partial fills, rejection, and lease restart
  - news classifications: lease-only writes, validation before any write, first judgment kept, consumers see nothing
  - Python worker → SpacetimeDB → subscribed client (labeled fixture provider)
- `make test-backend` — unit tests (hand-calculated features, prior-only normalization, coverage, provider retry,
  rate limits and deduplication, calendar) plus real-server worker round trips against `orbit-test`. The
  real-server tests are skipped automatically if the server or database is absent.
- `make test-live` — opt-in checks against Finnhub, Alpaca Market Data and Jev with the backend keys. Kept separate from fixture tests.
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
