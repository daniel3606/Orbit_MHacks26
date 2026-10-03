# Implementation status

_Last updated: 2026-10-03 · PRD phases 0–2 (integration proof, state and UI foundation, quant foundation)_

## Phase 2 — market data and deterministic signals

### Provider capabilities (verified on 2026-10-03)

These come from Finnhub's official OpenAPI spec (`finnhub.io/static/swagger.json`) and live probes with the configured key. Capabilities are re-probed automatically and published to `provider_capability`.

| Capability | Configured key | Notes |
|---|---|---|
| `/quote` | **Available** | Returns `c,d,dp,h,l,o,pc,t`. `t` (UNIX seconds) is returned live but missing from the spec schema. No volume. Unknown symbols return all zeros, which the adapter rejects. |
| `/stock/candle` (daily OHLCV, also used for benchmark history) | **HTTP 403** "You don't have access to this resource." | The spec says daily candles are split-adjusted (not dividend-adjusted) and intraday candles are unadjusted. |
| `/stock/split` | **HTTP 403** | No corporate-action feed is available. |
| `/stock/profile2` | Available | Returns `{}` for ETFs. |
| `/stock/market-status`, `/stock/market-holiday` | Available | Holiday data covers 2023–2027, including early closes. |
| Rate limits | 60 calls/min (`x-ratelimit-limit` header), plus a documented 30 calls/s cap | HTTP 429 when exceeded. The adapter targets 50/min with bursts up to 20. |

**Consequence.** The real data obtained is the latest quote for all 21 tickers (11 equities and 10 benchmark ETFs) with the provider's own timestamps, plus completed-session closes derived from those quotes: the previous close, and the current session's close once that session has ended. These closes are unadjusted and have no volume.

No genuine 20-day history exists, so every relative momentum, volatility and abnormal-volume feature is published as **unavailable**. No Trend Score is published (status `insufficient_data`). Only the 1-day move and the 1-day move relative to the benchmark are shown. Abnormal volume needs daily volume, which quotes never provide. So even after months of quote-derived closes, coverage could reach at most 0.35, below the 0.55 publication gate.

**Smallest setup that enables real scoring:** a Finnhub plan that includes **Stock Candles (daily)** for the 21 tickers. No code change is needed. On the next run the probe sees access, the adapter pulls 180 days of split-adjusted OHLCV, and the candle bars replace the quote-derived bars (candles rank higher as a source). Scores then publish once there are 81 aligned sessions per ticker and its benchmark. A split-history entitlement would be useful but is not required.

### Built

**Module** (additive migration; `orbit-dev` kept all existing data):
- Public, read-only projections:
  - `stock` (universe and benchmarks)
  - `market_quote` (latest per ticker; fixed-point micro-units)
  - `trend_signal` (latest per ticker: features, raw and normalized values, sample/baseline counts, reasons, coverage, notes)
  - `market_generation` (current coherent snapshot, with market status)
  - `provider_capability`
- Private, bounded tables: `daily_bar` (≤400 per ticker), `trend_signal_history` (≤120 per ticker), `market_schedule`, `worker_registration`, `service_config`.
- `publish_market_snapshot` (service-only):
  - Requires the caller's current lease on the `ingest_market` job and a strictly newer generation.
  - Requires each ticker's provider time to be non-decreasing.
  - Rejects unknown or duplicate tickers, non-positive prices, future timestamps or sessions, NaN/∞ values, scores outside 0–100, and coverage outside 0–1. A score must be present exactly when status is `published`.
  - Rejects fixture rows unless an admin enables `allow_fixture_data`.
  - Validates everything before writing anything, then commits quotes, bars, signals, generation and job completion in one transaction. A retried identical publish is a no-op.
- A scheduled reducer enqueues one shared `ingest_market` job every 300 s, owned by the database identity. Active jobs coalesce and system-job retention is bounded.
- `register_worker`: `worker_jobs` now returns only the kinds a worker has registered. Unsupported `refresh_recommendations` jobs are never offered, so they can neither be claimed repeatedly nor block supported work.
- Admin reducers: `configure_market_schedule`, `set_service_flag`. Service reducer: `request_market_ingest` (also allowed for the admin).

**Backend:**
- `FinnhubProvider`:
  - The key is sent only in the `X-Finnhub-Token` header, never in URLs or logs.
  - Token-bucket rate limiter (pauses on 429).
  - In-flight request coalescing plus TTL cache, so concurrent identical requests make one call.
  - Bounded retries with jitter. 401/403 are never retried.
  - Capability probing; `Decimal` parsing.
- `UsEquityCalendar` (weekends, provider holidays, early closes). Quote validation and derivation of completed-session closes from quotes.
- Signals (`app/signals`, `trend-v1.0.0`):
  - PRD formulas for relative momentum over 1, 5 and 20 sessions (sector-ETF benchmark, SPY fallback), 20-session realized volatility, volatility-adjusted momentum, and completed-day abnormal volume.
  - Prior-only 60-observation z-scores, clipped to ±3.
  - Weights renormalized over the available price/volume features, with `coverage` = sum of the original available weights.
  - Publication gate: momentum and volume available, and coverage ≥ 0.55.
  - News features are explicitly `news_phase_pending`.
- Guards:
  - Missing bars (calendar-aligned; no interpolation), invalid bars, incomplete or future sessions, stale history.
  - Mixed adjustment conventions; one-day jumps over 40% on unadjusted series (possible split).
  - Revised closes from the same source (adjustment conflict); zero variance (epsilon).
- `ingest_market` handler: one shared fetch per run, never per user. Deduplicated, versioned bars. Atomic publication through the lease.
- The worker registers its kinds at startup and supports per-kind leases.
- `FixtureProvider` and `scripts/publish_fixture_snapshot.py` are TEST-ONLY. All their data is labeled `fixture`, and the script refuses to run against `orbit-dev`.

**Mobile:**
- New **Market** tab. It subscribes to the market projections only while focused and re-subscribes after reconnect. It never subscribes to the history tables and never polls FastAPI.
- Screen contents:
  - Market open/closed state, last completed session, status check time and publish time.
  - A data-limits card built from the probed capabilities.
  - Per stock: price with the provider's data timestamp and source, change vs previous close, and the 1-day move vs its benchmark.
  - Trend Score only when published, labeled "heuristic" and "not a probability". Otherwise history/coverage status, plus a per-feature breakdown with plain-language reasons.
  - Loading, empty, stale (>15 min), offline and error states.
- No fabricated fit scores, match percentages or "why matched" text.

### Verified

| Behavior | How |
|---|---|
| Live quotes for 21 tickers with provider timestamps; 403 on candles and splits | `make test-live` (3 live tests) and a live worker run on `orbit-dev` |
| Live Finnhub → Python → `publish_market_snapshot` → subscribed app | iOS 26.3 **simulator**: Market tab shows Friday Oct 2 4:00 PM EDT closes, "market closed", and the data-limits card. A second ingestion updated the open screen without user action. |
| Market subscription survives a server outage | simulator: offline banner kept the last data; after restart it re-subscribed and showed the new generation |
| Hand-calculated features, prior-only normalization, clipping, zero variance, coverage and renormalization, publication gate | `backend/tests/test_signals.py` (18) |
| Missing bars, stale history, incomplete/future sessions, invalid bars, mixed adjustment, possible corporate action, current-plan shape (2 unadjusted closes, no volume) | same |
| Request coalescing, bounded retry, 429 pause, 403 not retried, capability probe, zero-quote rejection, candle parsing, calendar/early close | `backend/tests/test_finnhub_provider.py` (13), mocked HTTP |
| Consumers cannot publish, register workers, request ingestion or configure; private bars are not readable | `spacetime/tests/market.test.ts` |
| Lease enforcement, stale/equal generations, out-of-order quotes (whole snapshot rejected, nothing written), invalid values, fixture rejection, idempotent retry | same |
| Real Python worker → SpacetimeDB → subscribed Node client, full scored path | same, using the labeled **fixture** provider on `orbit-test`: 10 or more published signals at coverage 0.55 |
| Unsupported job kinds are not offered to workers | `backend/tests/test_worker_integration.py` |
| Regression suite | `make check`: 25 realtime and 53 backend tests, tsc ×3, lint, contract check, mypy --strict |

### Not verified or not available

- **Scored live signals.** Blocked by the Finnhub plan (no candles, no volume); see "Smallest setup" above. Scored output has only been produced from labeled fixtures.
- **Candle path with real data.** Parsing is tested against the documented shape; it has never received a real 200 response.
- **Split detection without a split feed.** It is heuristic (a jump of more than 40% on unadjusted closes, or a revised close). A real split would pause features for that ticker until history is reconciled.
- **Physical iPhone.** Not run. The market screen was checked only on the simulator.

## Earlier phases (unchanged and still passing)

- **SpacetimeDB:**
  - Private owner-scoped profile, branding, account and job tables; owner-authorized onboarding and editing with optimistic versioning.
  - Caller-scoped `my_*` views; service-allowlisted worker views and reducers.
  - Durable jobs with leases, fencing, backoff and idempotency.
- **Backend:**
  - Typed settings (empty `KEY=` lines in `.env` now mean unset); `/health` and `/ready`.
  - `SpacetimeGateway` over the HTTP API, versioned DTOs, durable worker.
- **Mobile:**
  - Guest session in the Keychain; one managed connection with AppState pause/resume and reconnect.
  - Onboarding, Home, editing, diagnostics.
  - Simulator-verified relaunch persistence, offline/reconnect, and the backend round trip.

## Outstanding dependencies (supplied by you)

- **Finnhub plan with daily Stock Candles.** Needed for real Trend Scores. The key stays in `backend/.env`.
- **OIDC** (SpacetimeAuth client and the `orbit://` redirect), an **Apple developer team** for a physical iPhone, and the **Figma** file or exports.
- **Jev** API documentation (the contract is unverified), plus the keys already present for OpenAI and Alpaca paper. These are used in later phases.

## Decisions

- Prices are stored as integer micro-units (i64); features are f64. UI prices are display-only.
- Benchmarks are SPDR sector ETFs from a configurable universe file, with SPY as the documented fallback.
- Without candles, the history is built from quote-derived closes. These are labeled `finnhub_quote` and unadjusted, and are never mixed with adjusted candles in a single calculation.
- Market tables are public projections because market data is shared. Bars and signal history stay private.
- `ingest_market` jobs are owned by the database identity, so they never appear in any user's `my_jobs`.

## Next step toward personalized discovery (Phase 3/4)

1. Enable daily candles (plan change), then verify live scored signals and inspect a few features by hand against the provider data.
2. Phase 3: add the Jev adapter after verifying its API contract, plus Finnhub company news (check plan access first). That makes news features available or explicitly unavailable.
3. Phase 4:
   - A Python fit rubric from `worker_job_profiles` and the published signals.
   - A `refresh_recommendations` handler that writes a versioned recommendation generation with an atomic pointer switch, rejecting results computed from stale profiles.
   - Caller-scoped `my_recommendations` and a Discover screen with real "why matched" reasons from structured evidence.
