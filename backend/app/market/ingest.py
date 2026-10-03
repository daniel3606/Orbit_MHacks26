"""`ingest_market` job: shared market ingestion → signals → atomic publication.

One run fetches each ticker once for the whole universe (never per user),
validates provider data, derives completed-session history, computes
coverage-aware signals and publishes one coherent generation via
`publish_market_snapshot`, which also completes the job under its lease.
"""

import asyncio
import logging
from collections import defaultdict
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any, Protocol

from app.config.universe import Universe
from app.market.calendar import UsEquityCalendar
from app.market.http import ProviderAccessDenied, ProviderError
from app.market.provider import (
    CapabilityResult,
    CompanyProfile,
    DailyBar,
    Holiday,
    MarketStatus,
    Quote,
)
from app.market.sessions import bars_from_quote, check_quote
from app.signals.config import SignalConfig
from app.signals.pipeline import FeatureResult, SignalResult, compute_signal
from app.state.dto import DailyBarV1, JobV1
from app.state.gateway import SpacetimeGateway
from app.state.sats_json import micros_of, option, timestamp_arg
from app.workers.runner import Committed, JobFailure

log = logging.getLogger(__name__)

SOURCE_RANK = {"fixture": 1, "finnhub_quote": 2, "finnhub_candle": 3}
CLOSE_CONFLICT_TOLERANCE = Decimal("0.005")  # 0.5%: same session reported differently → adjustment event


class IngestProvider(Protocol):
    name: str

    async def capabilities(self) -> list[CapabilityResult]: ...
    async def has(self, key: str) -> bool: ...
    async def get_quote(self, ticker: str) -> Quote: ...
    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]: ...
    async def get_profile(self, ticker: str) -> CompanyProfile | None: ...
    async def get_market_status(self) -> MarketStatus: ...
    async def get_holidays(self) -> list[Holiday]: ...


def to_micros(value: Decimal) -> int:
    return int((value * 1_000_000).to_integral_value(rounding=ROUND_HALF_EVEN))


def from_stored(bar: DailyBarV1) -> DailyBar:
    def dec(v: int | None) -> Decimal | None:
        return None if v is None else Decimal(v) / 1_000_000

    return DailyBar(
        ticker=bar.ticker,
        session=date.fromisoformat(bar.session_date),
        close=Decimal(bar.close_micros) / 1_000_000,
        open=dec(bar.open_micros),
        high=dec(bar.high_micros),
        low=dec(bar.low_micros),
        volume=bar.volume,
        adjusted=bar.adjusted,
        source=bar.source,
    )


def opt_micros(v: Decimal | None) -> dict[str, Any]:
    return option(None if v is None else to_micros(v))


def bar_arg(b: DailyBar) -> dict[str, Any]:
    return {
        "ticker": b.ticker,
        "session_date": b.session.isoformat(),
        "open_micros": opt_micros(b.open),
        "high_micros": opt_micros(b.high),
        "low_micros": opt_micros(b.low),
        "close_micros": to_micros(b.close),
        "volume": option(b.volume),
        "adjusted": b.adjusted,
        "source": b.source,
    }


def quote_arg(q: Quote) -> dict[str, Any]:
    return {
        "ticker": q.ticker,
        "price_micros": to_micros(q.price),
        "previous_close_micros": to_micros(q.previous_close),
        "open_micros": to_micros(q.open),
        "high_micros": to_micros(q.high),
        "low_micros": to_micros(q.low),
        "provider_time": timestamp_arg(q.provider_time),
        "ingested_at": timestamp_arg(q.ingested_at),
        "source": q.source,
    }


def feature_arg(f: FeatureResult) -> dict[str, Any]:
    return {
        "name": f.name,
        "available": f.available,
        "raw": option(f.raw),
        "normalized": option(f.normalized),
        "weight": f.weight,
        "sample_count": f.sample_count,
        "baseline_count": f.baseline_count,
        "reason": option(f.reason),
    }


def signal_arg(s: SignalResult) -> dict[str, Any]:
    return {
        "ticker": s.ticker,
        "session_date": s.session.isoformat(),
        "status": s.status,
        "trend_score": option(s.trend_score),
        "composite": option(s.composite),
        "coverage": s.coverage,
        "coverage_scope": s.coverage_scope,
        "benchmark": s.benchmark,
        "history_sessions": s.history_sessions,
        "required_sessions": s.required_sessions,
        "day_return": option(s.day_return),
        "benchmark_day_return": option(s.benchmark_day_return),
        "relative_day_return": option(s.relative_day_return),
        "features": [feature_arg(f) for f in s.features],
        "notes": s.notes[:20],
    }


class IngestMarketHandler:
    kind = "ingest_market"
    lease_seconds = 120

    def __init__(
        self,
        provider: IngestProvider,
        universe: Universe,
        cfg: SignalConfig,
        *,
        candle_days: int = 180,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._provider = provider
        self._universe = universe
        self._cfg = cfg
        self._candle_days = candle_days
        self._clock = clock

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        started = self._clock()
        generation = micros_of(started)
        provider = self._provider

        caps = await provider.capabilities()
        await self._sync_capabilities(gateway, caps)
        if not any(c.key.endswith(".quote") and c.available for c in caps):
            raise JobFailure("provider_quotes_unavailable", retryable=False)

        status = await provider.get_market_status()
        holidays = await provider.get_holidays() if await provider.has("market_holidays") else []
        cal = UsEquityCalendar(holidays)
        last_completed = cal.last_completed_session(started)
        await self._sync_universe(gateway)

        # Quotes: one request per ticker per run, shared by every user.
        tickers = self._universe.all_tickers
        fetched = await asyncio.gather(*(provider.get_quote(t) for t in tickers), return_exceptions=True)
        errors = [r for r in fetched if isinstance(r, BaseException)]
        if len(errors) == len(tickers):
            first = errors[0]
            if isinstance(first, ProviderError):
                raise JobFailure(first.code, retryable=first.retryable)
            raise first
        notes: dict[str, list[str]] = defaultdict(list)
        existing = {q.ticker: q.provider_time for q in await gateway.market_quotes()}
        quotes: dict[str, Quote] = {}
        for ticker, result in zip(tickers, fetched, strict=True):
            if isinstance(result, BaseException):
                code = result.code if isinstance(result, ProviderError) else "internal_error"
                notes[ticker].append(f"quote_unavailable:{code}")
                continue
            check = check_quote(result, started, cal, status.is_open)
            if not check.valid:
                notes[ticker].append(f"quote_rejected:{check.reason}")
                continue
            if ticker in existing and result.provider_time < existing[ticker]:
                notes[ticker].append("quote_out_of_order_skipped")
                continue
            if check.stale:
                notes[ticker].append("quote_stale")
            quotes[ticker] = result

        # History: stored bars + candles (if the plan allows) or quote-derived closes.
        stored: dict[str, dict[date, DailyBar]] = defaultdict(dict)
        for row in await gateway.worker_daily_bars():
            stored[row.ticker][date.fromisoformat(row.session_date)] = from_stored(row)
        incoming: list[DailyBar] = []
        if await provider.has("daily_candles"):
            start = last_completed - timedelta(days=self._candle_days)
            for ticker in tickers:
                try:
                    incoming.extend(await provider.get_daily_bars(ticker, start, last_completed))
                except ProviderAccessDenied:
                    notes[ticker].append("candles_access_denied")
        else:
            for q in quotes.values():
                incoming.extend(bars_from_quote(q, started, cal))

        blocked: dict[str, str] = {}
        to_publish: list[DailyBar] = []
        for bar in incoming:
            if bar.session > last_completed:
                continue
            prior = stored[bar.ticker].get(bar.session)
            if prior is not None:
                if SOURCE_RANK[bar.source] < SOURCE_RANK[prior.source]:
                    continue
                if prior.source == bar.source and abs(bar.close / prior.close - 1) > CLOSE_CONFLICT_TOLERANCE:
                    blocked[bar.ticker] = f"adjustment_conflict:{bar.session.isoformat()}"
                    continue
                if prior == bar:
                    continue
            stored[bar.ticker][bar.session] = bar
            to_publish.append(bar)

        # Signals for equities against their configured (or fallback) benchmark.
        sessions = cal.sessions_between(last_completed - timedelta(days=400), last_completed)
        signals: list[SignalResult] = []
        for eq in self._universe.equities:
            benchmark = eq.benchmark
            if not stored.get(benchmark):
                notes[eq.ticker].append(f"benchmark_fallback:{benchmark}->{self._universe.fallback_benchmark}")
                benchmark = self._universe.fallback_benchmark
            signal = compute_signal(
                eq.ticker,
                benchmark,
                list(stored[eq.ticker].values()),
                list(stored[benchmark].values()),
                last_completed,
                sessions,
                self._cfg,
                extra_blocking=blocked.get(eq.ticker) or blocked.get(benchmark),
            )
            signal.notes[:0] = notes.get(eq.ticker, [])
            signals.append(signal)

        session_label = status.session if status.is_open else (f"holiday:{status.holiday}" if status.holiday else "closed")
        await gateway.publish_market_snapshot(
            [
                job.job_id,
                job.attempt_count,
                generation,
                timestamp_arg(started),
                self._cfg.algorithm_version,
                provider.name,
                status.is_open,
                session_label,
                timestamp_arg(status.as_of),
                last_completed.isoformat(),
                [quote_arg(q) for q in quotes.values()],
                [bar_arg(b) for b in to_publish],
                [signal_arg(s) for s in signals],
            ]
        )
        published = sum(1 for s in signals if s.status == "published")
        log.info(
            "market generation %s: %d quotes, %d new bars, %d signals (%d scored)",
            generation, len(quotes), len(to_publish), len(signals), published,
        )
        return Committed(f"generation={generation}")

    async def _sync_capabilities(self, gateway: SpacetimeGateway, caps: list[CapabilityResult]) -> None:
        current = {c.key: (c.available, c.detail) for c in await gateway.provider_capabilities()}
        changed = [c for c in caps if current.get(c.key) != (c.available, c.detail)]
        if changed:
            await gateway.publish_provider_capabilities(
                [
                    {"key": c.key, "provider": self._provider.name, "capability": c.capability, "available": c.available, "detail": c.detail}
                    for c in changed
                ]
            )

    async def _sync_universe(self, gateway: SpacetimeGateway) -> None:
        profiles: dict[str, CompanyProfile | None] = {}
        if await self._provider.has("company_profile"):
            for eq in self._universe.equities:
                try:
                    profiles[eq.ticker] = await self._provider.get_profile(eq.ticker)
                except ProviderError:
                    profiles[eq.ticker] = None
        desired: list[dict[str, Any]] = []
        order = 0
        for eq in self._universe.equities:
            p = profiles.get(eq.ticker)
            desired.append(
                {
                    "ticker": eq.ticker,
                    "name": p.name if p else eq.ticker,
                    "exchange": p.exchange if p else "",
                    "industry": p.industry if p else "",
                    "sector": eq.sector,
                    "currency": p.currency if p else "USD",
                    "kind": "equity",
                    "benchmark": eq.benchmark,
                    "display_order": order,
                }
            )
            order += 1
        for b in self._universe.benchmarks:
            desired.append(
                {
                    "ticker": b.ticker, "name": b.name, "exchange": "", "industry": "ETF", "sector": b.sector,
                    "currency": "USD", "kind": "benchmark", "benchmark": "", "display_order": order,
                }
            )
            order += 1
        current = {
            s.ticker: {k: getattr(s, k) for k in desired[0]}
            for s in await gateway.stocks()
            if s.active
        }
        if current != {d["ticker"]: d for d in desired}:
            await gateway.upsert_stocks(desired)

