# Implementation status

_Last updated: 2026-10-04 · PRD phases 0–2, personalized matches (fit-v1.0.0), Daily Discovery (discovery-v1.0.0), and paper orders on one bound Alpaca paper account_

## Daily Discovery (discovery-v1.0.0, 2026-10-04)

The Discover tab now shows one Discovery set per person per local day: the sign picks which corner of the market to
explore, and real market data, news, the saved profile and the person's own history pick the companies. The sign is
never a scoring input, and nothing in the copy says it predicts returns.

### Pipeline

1. **Theme.** `app/discovery/rotation.py`. Each sign has four theme sectors (`discovery_themes.json`). Sectors are
   ordered by `sha256(date | sign | sector)` and sub-themes by `sha256(date | sign | sub-theme)`, so the order is fixed
   for a day and not a plain sequence. The person's history skips yesterday's sub-theme and any sector already used
   twice in the last 6 days, when another option exists. No sign uses a neutral pool of six sectors.
2. **Candidates.** The sub-theme's curated companies (4–6, all in the ingestion universe). A company without a valid
   quote is skipped. A theme with fewer than two priced companies hands over to the next theme in the day's order.
3. **Score.** `DiscoveryScore = 0.30·Trend + 0.25·PersonalFit + 0.20·News + 0.15·Momentum + 0.10·Novelty`
   (`app/discovery/config.py`), renormalized over the components that have data. Time horizon shifts 0.05 between
   momentum and fit.
   - Trend: the published Trend Score / 100, only when it belongs to the current market generation.
   - Momentum: last-session move (±4% spans 0–1) averaged with the clipped `relative_momentum` z-score.
   - News: Finnhub company news from the last 3 days, kept only when the headline names the company or one of its
     brands; recency-weighted (36 h half-life). A failed call leaves the component out; a successful call with no
     stories scores 0.
   - Personal fit: curated traits (size, risk, character, familiarity) against risk, style, horizon, experience and
     saved sectors. These are heuristics, not fundamentals.
   - Novelty: 0 when shown in the last 7 days, 0.4 within 30 days, 1 otherwise.
4. **Select.** Companies shown in the last 7 days are held back while new ones remain. A later card takes a new
   angle (e.g. nuclear instead of a third solar name) when it scores within 0.12 of the best repeat.
5. **Explain.** One or two factual lines per card ("Matches your interest in growing companies", "In the news: 3
   stories in the last 3 days"), varied across the set. No line predicts a price.

### State

- `daily_discovery` (owner, local date, sign, sector, sub-theme, title, description, versions, counts) and
  `daily_discovery_item` (ticker, rank, score and components, angle, about, reasons, top relevant headline). The
  reducer enforces one set per (owner, date); a published set is never rebuilt. The 45 most recent sets are kept and
  double as discovery history.
- `request_daily_discovery(localDate)`: caller is `ctx.sender`; the date must be "today" somewhere on Earth
  (UTC−12…UTC+14). One active job per person; at most six requests per day. The sign comes from the caller's own
  branding row, and a sign saved before a queued job starts is the one it uses.
- `publish_daily_discovery`: service-only, under the job lease; validates everything, then writes the set and completes
  the job in one transaction.
- Views: `my_daily_discovery`, `my_discovery_items` (caller only); `worker_discovery_history`,
  `worker_discovery_items` (only the owners of Discovery jobs the calling worker holds).
- FastAPI still has no user-authenticated routes, so there is no `GET /discovery/today`; the reducer + views above are
  that endpoint in this architecture.

### Infrastructure changes that came with it

- Universe grew from 11 to 114 equities (+XLRE). First backfills are capped at 4,500 bars per publish: a 9.5k-bar
  publish was rejected with HTTP 413. Profiles are fetched 30 per run and then reused.
- Ingestion lease 120 → 300 s. On 2026-10-04 a run took 2 min 56 s (124 quotes, 4,452 new bars, 114 signals, 24 scored
  while history backfills).
- The worker no longer waits for every job in a batch before polling again, and ingestion has its own lane, so a long
  ingest cannot hold up Discovery, briefs or chat. Finnhub's budget is split (`FINNHUB_INTERACTIVE_CALLS_PER_MINUTE`).

### Verified

| Behavior | How |
|---|---|
| Same date + sign → same theme; dates rotate through every sector within 30 days; not sequential; ≥6 distinct themes across signs each day | `backend/tests/test_discovery.py` |
| 40-day simulation: never yesterday's sub-theme, never a sector 3× in a 6-day window | same |
| Different profiles rank the same theme differently; seen-recently ranks lower; last week's names held back; new angle preferred | same |
| News outage leaves the component out; irrelevant headlines dropped; one missing quote skips one company; no market data retries | same |
| Handler: publishes 3 companies of today's theme, falls through to the next theme, never rebuilds a day, uses history next day | same, in-memory gateway |
| Slow ingest does not block quick jobs; system lane | `backend/tests/test_runner.py` |
| Backfill budget | `test_first_backfills_stay_inside_one_publish_budget` |
| Date bounds, one job per day with the stored sign, consumer cannot publish, invalid sets write nothing, same day never rebuilt, other users see nothing, next day gets a new set, worker sees only leased owner's history, sign change re-points a queued job | `spacetime/tests/discovery.test.ts` |
| Live: no-sign guest → `life-in-the-cloud` (GOOGL, AMZN, MSFT) in ~230 ms; Aquarius guest → `powering-the-future` (TSLA battery storage, FSLR solar, GEV grid & wind) | worker on `orbit-dev` |
| On device: constellation header, theme, cards with logos, live prices, reasons, footnote, missing-logo monogram, card → stock detail with the same reasons | iPhone 17 Pro (402 pt, no sign) and iPhone 16e (390 pt, Aquarius) simulators |

### Not verified or still open

- Error state, negative and flat price moves, and widths above 430 pt (Pro Max) were not seen on a device; the code
  paths are written but only the populated and loading states were observed.
- The first no-sign set was published before ORCL/NET had quotes, so it shows three "Cloud platform" companies.
  Diversity only works on companies that have prices.
- News for Discovery waits at most 8 s per company; on a busy key the news component is left out rather than delayed.
- Curated traits and blurbs are hand-written heuristics; there are no fundamentals behind "growth" or "established".
- There is no analytics provider in the app, so no Discovery events are recorded.

## Approved provider change (2026-10-03)

Finnhub's configured plan still returns HTTP 403 for daily candles, so it cannot supply the OHLCV history Trend Scores need. Alpaca Market Data is now the historical daily-bar provider. Finnhub stays in place for the capabilities that work: quotes, company profiles, exchange status, and holidays.

Market data and trading are separate:

- Historical bars use `https://data.alpaca.markets` only (`ALPACA_DATA_BASE_URL`).
- Paper trading stays on `https://paper-api.alpaca.markets` (`ALPACA_BASE_URL`). Live trading hosts are still rejected.
- The historical adapter calls `GET /v2/stocks/bars` only. It does not submit orders or read an account.

No Alpaca subscription was purchased. The configured paper keys can read historical SIP.

## Phase 2 — market data and deterministic signals

### Provider capabilities (verified on 2026-10-03)

Capabilities are probed and published to `provider_capability`. Finnhub details come from its OpenAPI spec and a live probe. Alpaca details come from the [historical bars reference](https://docs.alpaca.markets/us/reference/stockbars) and the [market-data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq), plus a live probe with an end time outside the latest-15-minute SIP window.

| Capability | Configured account | Notes |
|---|---|---|
| Finnhub `/quote` | **Available** | Latest price for display. No volume. Unknown symbols return all zeros, which the adapter rejects. |
| Finnhub `/stock/candle` | **HTTP 403** | Not used for scores. Quote closes are not spliced into Alpaca bars. |
| Finnhub `/stock/split` | **HTTP 403** | No corporate-action feed. |
| Finnhub profile, market status, holidays | **Available** | Holiday data covers 2023–2027, including early closes. |
| Alpaca historical SIP daily bars | **Available** | `feed=sip`, `adjustment=split`. Probed limit 200 requests/minute; the adapter targets 150/min. |
| Alpaca historical IEX | Accessible, **not used** | Kept as a fallback only if SIP is denied. IEX volume is one exchange, not consolidated volume. SIP and IEX are never mixed. |

**Adjustment policy.** Alpaca's default is `raw` (no adjustment). Orbit sends `adjustment=split`, which the docs define as adjusting both price and volume for forward and reverse splits. Dividend and spin-off adjustments are not requested. The same parameter is used for stocks and benchmark ETFs. `adjusted=true` on a bar means that split adjustment, not dividend adjustment.

**History window.** Each ingestion loads about 460 calendar days, which is enough for the 20-session lookback plus 60 prior observations used to normalize (81 aligned sessions required). On 2026-10-03 every universe ticker returned **318** completed sessions from 2025-06-30 through 2026-10-02. Daily bar timestamps are midnight America/New_York. A session is requested only after its close is at least 16 minutes old, so the query stays outside the SIP "latest 15 minutes" restriction. Missing sessions are not filled in.

### What publishes

All 11 equities publish a Trend Score for the session **2026-10-02**. Coverage is **0.55** (the three price/volume weights). News features stay unavailable with reason `news_velocity` / `sentiment_shift` / `breadth_materiality` = `news_phase_pending`. The 0.55 gate was not lowered.

Hand check of AAPL versus XLK on the retrieved SIP bars, using the PRD formulas independently of the engine: momentum −0.037136, 20-day realized vol 0.014543, volatility-adjusted momentum −2.5535, abnormal-volume log ratio −0.2420, prior-only z-scores −0.814 / −1.076 / −0.301, composite −0.6750, Trend Score **33.74**. The engine matched those values. The same run published:

| Ticker | Trend Score | Benchmark |
|---|---:|---|
| AAPL | 33.74 | XLK |
| MSFT | 32.81 | XLK |
| NVDA | 49.68 | XLK |
| JNJ | 37.22 | XLV |
| JPM | 37.02 | XLF |
| AMZN | 55.63 | XLY |
| KO | 48.97 | XLP |
| XOM | 56.94 | XLE |
| CAT | 77.96 | XLI |
| GOOGL | 69.46 | XLC |
| NEE | 58.16 | XLU |

Quotes on the Market screen remain Finnhub's latest prices, with Finnhub's own timestamps. Scores use Alpaca daily bars only.

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
- `register_worker`: `worker_jobs` returns only the kinds a worker has registered. The local worker registers `refresh_recommendations`, `submit_paper_order`, and `reconcile_paper_account` when `PAPER_DEMO_IDENTITY` and the Alpaca keys are set. A worker that does not register a kind is never offered it.
- Admin reducers: `configure_market_schedule`, `set_service_flag`. Service reducer: `request_market_ingest` (also allowed for the admin).

**Backend:**
- `FinnhubProvider`:
  - The key is sent only in the `X-Finnhub-Token` header, never in URLs or logs.
  - Token-bucket rate limiter (pauses on 429).
  - In-flight request coalescing plus TTL cache, so concurrent identical requests make one call.
  - Bounded retries with jitter. 401/403 are never retried.
  - Capability probing; `Decimal` parsing.
- `AlpacaHistoricalProvider`: historical daily bars only. SIP is probed first; IEX is recorded and used only if SIP is denied. Pagination, New York session dates, the 16-minute SIP lag, and `adjustment=split` are explicit.
- `RoutedMarketProvider`: Finnhub serves quotes, profiles, status, and holidays. Alpaca serves daily bars when the probe succeeds. Quote-derived closes are not added to an Alpaca series.
- `UsEquityCalendar` (weekends, provider holidays, early closes). Quote validation and derivation of completed-session closes from quotes, used only when no daily-bar source is available.
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
  - A short "What you can see" card: Finnhub prices, split-adjusted daily history, and whether volume is the full US market or IEX only. News is described as not included yet.
  - Per stock: price with the provider's data timestamp and source, change vs previous close, the 1-day move vs its benchmark, and the Trend Score with the score date when one is published.
  - Session counts, coverage decimals, feature values, and source notes sit in an expandable diagnostics area.
  - Loading, empty, stale (>15 min), offline and error states.
- No fabricated fit scores, match percentages or "why matched" text.

### Verified

| Behavior | How |
|---|---|
| Live SIP daily bars for all 21 tickers, 318 sessions each, split-adjusted | `tests/test_alpaca_live.py` on 2026-10-03. IEX was reachable and was not used. |
| Hand check of momentum, volatility, abnormal volume, prior-only z-scores, composite, and Trend Score against retrieved AAPL and XLK bars | same live test; engine values matched the independent formulas. All 11 equities published at coverage 0.55 |
| Live Finnhub quotes + Alpaca history → `publish_market_snapshot` | Worker on `orbit-dev`: generation `1791051317873408`, 21 quotes, 6,678 new bars, 11 scored signals, `history=alpaca_sip` through 2026-10-02. Provider on the generation row is `finnhub+alpaca`. |
| Subscription update | Anonymous `SELECT * FROM trend_signal` received the initial scores, then a live delete/insert when generation `1791051422356387` replaced them. Scores were unchanged; the generation and publish time moved. |
| Live quotes for 21 tickers; Finnhub 403 on candles and splits | `make test-live` and the worker run. Candles are no longer on the scoring path. |
| Earlier Finnhub-only screen check | iOS 26.3 simulator, before this provider change: Market tab showed Friday Oct 2 closes while the market was closed. |
| Market subscription survives a server outage | simulator: offline banner kept the last data; after restart it re-subscribed and showed the new generation |
| Hand-calculated features, prior-only normalization, clipping, zero variance, coverage and renormalization, publication gate | `backend/tests/test_signals.py` (18) |
| Missing bars, stale history, incomplete/future sessions, invalid bars, mixed adjustment, possible corporate action, current-plan shape (2 unadjusted closes, no volume) | same |
| Request coalescing, bounded retry, 429 pause, 403 not retried, capability probe, zero-quote rejection, candle parsing, calendar/early close | `backend/tests/test_finnhub_provider.py` (13), mocked HTTP |
| Consumers cannot publish, register workers, request ingestion or configure; private bars are not readable | `spacetime/tests/market.test.ts` |
| Lease enforcement, stale/equal generations, out-of-order quotes (whole snapshot rejected, nothing written), invalid values, fixture rejection, idempotent retry | same |
| Real Python worker → SpacetimeDB → subscribed Node client, full scored path | same, using the labeled **fixture** provider on `orbit-test`: 10 or more published signals at coverage 0.55 |
| Unsupported job kinds are not offered to workers | `backend/tests/test_worker_integration.py` |
| Alpaca SIP bars accepted by `publish_market_snapshot`; an unknown feed label is rejected | `spacetime/tests/market.test.ts` |
| Regression suite | Backend: 62 passed, live tests skipped in the default run, mypy --strict clean. Spacetime: 26 passed, including the fixture scored path on `orbit-test`. Mobile `tsc` and lint clean. |

### Not verified or not available

- **Market tab after this UI copy change.** The iPhone 17 Pro simulator is booted and Orbit is installed. Opening `orbit://market` raised the system "Open in Orbit?" confirmation on top of Home, and this session could not dismiss that dialog. The subscription the screen uses was verified with the SpacetimeDB client, not by reading the new copy off the device.
- **Finnhub candle parsing against a real 200.** Still untested. Scoring does not use that endpoint.
- **Split detection without a split feed.** Unadjusted quote history still uses the 40% jump guard. Alpaca split-adjusted bars do not. A revised close from the same source still pauses that ticker.
- **Early-close same-day scoring.** The calendar treats an early close as complete 16 minutes after that close. The Alpaca adapter also waits until 16:00 ET is 16 minutes old before it keeps that day's bar, so on an early-close afternoon the score can lag until about 4:16 PM ET.
- **Physical iPhone.** Not run.

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

- **OIDC** (SpacetimeAuth client and the `orbit://` redirect), an **Apple developer team** for a physical iPhone, and the **Figma** file or exports.
- **Jev** API documentation (the contract is unverified), plus the OpenAI key already present. Alpaca paper keys are in use for historical bars and remain the paper-trading credentials for a later phase. A Finnhub candle upgrade is no longer required for Trend Scores.

## Decisions

- Prices are stored as integer micro-units (i64); features are f64. UI prices are display-only.
- Benchmarks are SPDR sector ETFs from a configurable universe file, with SPY as the documented fallback.
- Daily history is Alpaca SIP with `adjustment=split` for both stocks and benchmarks. Those bars are labeled `alpaca_sip`. Finnhub quote closes stay on the quote row and are not mixed into that history. If SIP is ever denied, the whole series switches to `alpaca_iex` and the IEX volume limitation is stored on `provider_capability`.
- Market tables are public projections because market data is shared. Bars and signal history stay private.
- `ingest_market` jobs are owned by the database identity, so they never appear in any user's `my_jobs`.

## Personalized discovery (fit-v1.0.0)

Completing or editing a profile still enqueues one coalesced `refresh_recommendations` job. The worker reads that user’s profile (never zodiac), the current market generation, published Trend Scores, and the stored daily bars. It publishes one generation through `publish_recommendations`, which checks the profile version and the market generation, writes every row, switches the pointer, and completes the job in a single transaction. A stale profile is rejected and the previous generation stays visible. Home and Discover subscribe to `my_recommendation_generation` and `my_recommendations`.

### Rubric

Trend Score, Fit Score, and RecommendationRank stay separate until the last line. Original weights are risk 0.40, horizon 0.30, style 0.20, sector 0.10. `RecommendationRank = 0.60*TrendScore + 0.40*FitScore`.

| Component | fit-v1.0.0 | Why |
|---|---|---|
| Risk match | Scored for conservative and moderate | 20-session realized volatility (daily sample std) and the worst peak-to-trough drop over up to 60 completed sessions, from the same bar source as the Trend Score. |
| Sector preference | Scored | 1 when the universe sector is one the user saved, otherwise 0. Not a hard filter. |
| Horizon | Unavailable (`horizon_not_scored`) | A daily trend does not say whether a stock fits weeks, months, or years. |
| Style | Unavailable (`style_not_classified`) | No valuation, dividend, or growth data, so nothing is labeled growth, value, or income. |
| Experience and goal | Not in the score | They change how the explanation is worded. |
| Zodiac | Not an input | Branding stays on its own table. |

Available weights are renormalized. Coverage is the sum of the original weights that were actually used: **0.50** when risk and sector are scored, **0.10** when the user set no volatility ceiling (aggressive). Aggressive does not rank names higher for being more volatile.

Risk is also a hard filter, applied before ranking. A stock is left out when the metric cannot be computed, when volatility is above the ceiling, or when the drawdown is worse than the floor. High Trend Score does not override that. The list can be shorter than three. Ceilings are heuristics:

| Profile | Max 20-session daily volatility | Worst 60-session drawdown |
|---|---:|---:|
| Conservative | 0.015 | −0.15 |
| Moderate | 0.025 | −0.28 |
| Aggressive | no ceiling | no floor |

Among names that pass, ties break by fit, then newer signal time, then ticker. A later slot may take a new sector when that name’s rank is within 15 points of the best remaining same-sector name.

### What published on orbit-dev

The restarted worker claimed the three queued refresh jobs and committed a `ready` generation for each (3 names, all 11 equities eligible, session **2026-10-02**, history `alpaca_sip`, rubric `fit-v1.0.0`).

- Risk-limited profiles (coverage 0.50): **CAT, GOOGL, NEE**. CAT’s stored volatility is 0.0165 and its drawdown is −18.2%, inside the moderate limits and outside the conservative ones.
- An aggressive profile (coverage 0.10, sector-only fit): **XOM, NVDA, JNJ**, each with fit 100 because those sectors were saved. Recent volatility did not raise or lower those matches.

On the iPhone 17 Pro simulator, Home showed “For you,” Caterpillar at **$845.42** with a Finnhub timestamp of Fri, Oct 2, 4:00 PM EDT, the sentence that industrials is not a chosen sector and the swings are inside the balanced limit, and the limitation that trend analysis uses daily price and volume only. A system “Open in Orbit?” dialog stayed on top, so Market and the stock-detail screen were not opened from this session.

### Verified for this flow

| Behavior | How |
|---|---|
| Different sectors change order; horizon, style, experience, and goal do not change rank | `backend/tests/test_ranking.py` |
| A high Trend Score cannot pass a conservative volatility ceiling | same |
| Aggressive has no ceiling and does not reward higher volatility | same |
| SIP closes are not mixed with IEX or quote closes | same |
| Hand-computed volatility, drawdown, renormalized fit, and rank match the engine | same, alternating ±1% series |
| A stale profile does not publish | same, plus `spacetime/tests/recommendations.test.ts` |
| An invalid batch writes nothing; the subscribed client then receives the full generation | recommendations test |
| After a preference change, the old generation stays until the new publish replaces it, including an honest empty list | same test: status `no_eligible`, zero rows |
| Another user’s subscription stays empty; a consumer cannot publish | same test |
| Repeated refresh requests while one is queued do not add a job | same test |
| Backend and module regression | Backend 90 passed, 4 skipped, mypy clean. Spacetime 31 passed. Mobile `tsc` clean. |

### Still open

- The simulator “Open in Orbit?” dialog still blocks taps, so stock-detail navigation, order review, and the Practice tab were not read off the device after this change. Home’s recommendation copy was visible in an earlier launch.
- A sector-only fit of 100 is no longer printed as a match percentage. Coverage stays in Data details, and the card still uses the published reason.
- News features are still `news_phase_pending`. Explanations are deterministic templates, not OpenAI.
- Every live profile on 2026-10-02 still had 11 eligible names. Conservative exclusion is covered by the unit test, not by a live conservative profile in `orbit-dev`.
- Early-close scoring can still lag until about 4:16 PM ET, as in Phase 2.

## Paper account and orders

One Alpaca paper account is bound to one guest. Connecting does not grant access, and a second identity is rejected with `paper_demo_already_bound`. The worker also refuses every owner other than `PAPER_DEMO_IDENTITY`. On this machine that guest is the profile saved as moderate risk, a months horizon, and financials only.

Capability check on 2026-10-03 used `GET /v2/account`, `GET /v2/clock`, and `GET /v2/assets/AAPL` on `paper-api.alpaca.markets`. No order was posted.

| Check | Result |
|---|---|
| Account | Active, USD, trading not blocked |
| Cash | **$100,000.00** |
| Equity | **$100,000.00** |
| Buying power | $400,000.00, which includes margin. Orbit buys are limited to cash |
| Clock | Closed. Next open Monday 2026-10-05 9:30 AM ET. Next close 4:00 PM ET |
| AAPL | US equity, active, tradable, fractionable |
| Shorting | Enabled at Alpaca. Orbit accepts long buys and sells of shares already held |

The worker published that cash and equity to `orbit-dev` as paper revision 1. `paper_order` has no rows. Nothing is waiting to execute when the market opens.

Orders, when the bound guest confirms one, go through `create_paper_order_intent` → `submit_paper_order` → Alpaca `POST /v2/orders` outside the database transaction, then `apply_paper_snapshot`. A timeout looks up the same `client_order_id` before another post. Accepted and pending states are not fills. Reconciliation polls with `reconcile_paper_account` and drops an older revision.

### Verified for paper trading

| Behavior | How |
|---|---|
| Live host refused; capability probe does not POST | `backend/tests/test_paper.py` |
| Insufficient cash or shares, whole-share rule, cash rather than margin | same |
| Duplicate client id does not post again | same |
| Timeout lookup, retry, then reconciling; restart finds the existing order | same |
| Broker rejection, partial fill, other owner, stale revision | same |
| Bound identity only, idempotent key, stale snapshot writes nothing, partial fill, rejection, lease restart | `spacetime/tests/paper.test.ts` |

## Next step

Phase 3 news (Jev, after its contract is verified, and Finnhub company news if the plan allows). OpenAI can replace the deterministic sentences only after those evidence rows exist. A paper order should be sent only when the bound guest presses Confirm on a review. Do not mark a weekend order filled.

