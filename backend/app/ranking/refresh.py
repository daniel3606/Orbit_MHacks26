"""Refresh recommendations from the leased profile and the current market generation.

Does not call market-data providers. Bars already stored for signals are reused,
and one generation of bars is cached for every user refreshed in this process.
"""

import time
from datetime import date

from app.ranking.config import ALGORITHM_VERSION
from app.ranking.fit import (
    BarInput,
    MarketInput,
    ProfileInput,
    RecommendationBatch,
    RecommendationItem,
    SignalInput,
    StockInput,
    build_recommendations,
)
from app.state.dto import DailyBarV1, InvestmentProfileV1, JobV1, StockV1, TrendSignalV1
from app.state.gateway import ReducerRejected, SpacetimeGateway
from app.state.sats_json import option
from app.workers.runner import Committed, JobFailure


def _item_arg(item: RecommendationItem) -> dict[str, object]:
    return {
        "ticker": item.ticker,
        "display_rank": item.display_rank,
        "trend_score": item.trend_score,
        "fit_score": item.fit_score,
        "recommendation_rank": item.recommendation_rank,
        "fit_coverage": item.fit_coverage,
        "components": [
            {
                "name": c.name,
                "available": c.available,
                "value": option(c.value),
                "weight": c.weight,
                "reason": option(c.reason),
            }
            for c in item.components
        ],
        "realized_vol": option(item.realized_vol_20d),
        "max_drawdown": option(item.max_drawdown_60d),
        "vol_sessions": item.vol_sessions,
        "drawdown_sessions": item.drawdown_sessions,
        "sector": item.sector,
        "benchmark": item.benchmark,
        "session_date": item.session_date,
        "history_source": item.history_source,
        "match_reason": item.match_reason,
        "market_activity": item.market_activity,
        "risk_observation": item.risk_observation,
        "learning_note": item.learning_note,
        "limitations": list(item.limitations),
    }


def publish_args(job: JobV1, generation: int, batch: RecommendationBatch) -> list[object]:
    return [
        job.job_id,
        job.attempt_count,
        generation,
        job.input_version,
        batch.market_generation,
        batch.signal_algorithm_version,
        ALGORITHM_VERSION,
        batch.signal_session_date,
        batch.status,
        batch.considered_count,
        batch.eligible_count,
        batch.summary,
        list(batch.limitations),
        [_item_arg(item) for item in batch.items],
    ]


class RefreshRecommendationsHandler:
    kind = "refresh_recommendations"
    lease_seconds = 60

    def __init__(self) -> None:
        self._bars_generation: int | None = None
        self._bars: list[DailyBarV1] = []
        self._generation_floor = 0

    def _next_generation(self) -> int:
        candidate = time.time_ns() // 1_000
        if candidate <= self._generation_floor:
            candidate = self._generation_floor + 1
        self._generation_floor = candidate
        return candidate

    async def _bars_for(self, gateway: SpacetimeGateway, market_generation: int) -> list[DailyBarV1]:
        if self._bars_generation != market_generation:
            self._bars = await gateway.worker_daily_bars()
            self._bars_generation = market_generation
        return self._bars

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        profiles = await gateway.worker_job_profiles()
        profile = next((row for row in profiles if row.owner == job.owner), None)
        if profile is None or profile.profile_version < job.input_version:
            raise JobFailure("profile_not_visible", retryable=True)
        if profile.profile_version != job.input_version:
            raise JobFailure("stale_profile_version", retryable=False)

        visible = await gateway.worker_jobs()
        superseded = any(
            row.owner == job.owner
            and row.kind == self.kind
            and row.job_id != job.job_id
            and row.input_version > job.input_version
            and row.status in ("queued", "retry_wait", "running")
            for row in visible
        )
        if superseded:
            raise JobFailure("stale_profile_version", retryable=False)

        batch = await self._compute(gateway, profile)
        generation = self._next_generation()
        try:
            await gateway.publish_recommendations(publish_args(job, generation, batch))
        except ReducerRejected as exc:
            if exc.code == "stale_market_generation":
                self._bars_generation = None
                raise JobFailure("stale_market_generation", retryable=True) from exc
            if exc.code in {"stale_profile_version", "stale_generation"}:
                raise JobFailure(exc.code, retryable=exc.code == "stale_generation") from exc
            raise
        return Committed(
            f"generation={generation};status={batch.status};count={len(batch.items)};profile={profile.profile_version}"
        )

    async def _compute(self, gateway: SpacetimeGateway, profile: InvestmentProfileV1) -> RecommendationBatch:
        market_row = await gateway.market_generation()
        if market_row is None:
            return build_recommendations(_profile(profile), None, [], [], {}, {})
        stocks = await gateway.stocks()
        signals = await gateway.trend_signals()
        bars = await self._bars_for(gateway, market_row.generation)
        grouped: dict[str, list[BarInput]] = {}
        for bar in bars:
            grouped.setdefault(bar.ticker, []).append(_bar(bar))
        names = {row.ticker: row.name for row in stocks if row.kind == "benchmark"}
        return build_recommendations(
            _profile(profile),
            MarketInput(
                generation=market_row.generation,
                algorithm_version=market_row.algorithm_version,
                last_completed_session=market_row.last_completed_session,
            ),
            [_stock(row) for row in stocks],
            [_signal(row) for row in signals],
            grouped,
            names,
        )


def _profile(row: InvestmentProfileV1) -> ProfileInput:
    return ProfileInput(
        risk_tolerance=row.risk_tolerance,
        investment_horizon=row.investment_horizon,
        investment_style=row.investment_style,
        sector_interests=tuple(row.sector_interests),
        experience_level=row.experience_level,
        primary_goal=row.primary_goal,
        profile_version=row.profile_version,
        schema_version=row.schema_version,
    )


def _stock(row: StockV1) -> StockInput:
    return StockInput(
        ticker=row.ticker,
        name=row.name,
        sector=row.sector,
        kind=row.kind,
        benchmark=row.benchmark,
        active=row.active,
    )


def _signal(row: TrendSignalV1) -> SignalInput:
    return SignalInput(
        ticker=row.ticker,
        generation=row.generation,
        algorithm_version=row.algorithm_version,
        session_date=row.session_date,
        status=row.status,
        trend_score=row.trend_score,
        benchmark=row.benchmark,
        relative_day_return=row.relative_day_return,
        notes=tuple(row.notes),
        published_at=row.published_at,
    )


def _bar(row: DailyBarV1) -> BarInput:
    return BarInput(
        ticker=row.ticker,
        session=date.fromisoformat(row.session_date),
        close=row.close_micros / 1_000_000,
        source=row.source,
        adjusted=row.adjusted,
    )
