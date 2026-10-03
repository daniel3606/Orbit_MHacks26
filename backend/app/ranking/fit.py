"""Eligibility, fit, and recommendation rank. Pure and deterministic.

Trend Score, Fit Score, and RecommendationRank stay separate until the last
blend. Zodiac is not a field on the inputs and cannot affect the result.
"""

from dataclasses import dataclass, field
from datetime import date, datetime

from app.ranking.config import (
    COMPONENT_ORDER,
    COMPONENT_WEIGHTS,
    DRAWDOWN_FLOOR,
    FIT_BLEND,
    REQUIRED_LIMITATION_CODES,
    RISK_DRAWDOWN_WEIGHT,
    RISK_VOL_WEIGHT,
    TOP_N,
    TREND_BLEND,
    VARIETY_RANK_GAP,
    VOL_CEILING,
)
from app.ranking.explain import (
    generation_summary,
    learning_note,
    market_activity,
    match_reason,
    risk_observation,
    row_limitations,
)
from app.ranking.metrics import RiskMetrics, risk_metrics


@dataclass(frozen=True)
class ProfileInput:
    risk_tolerance: str
    investment_horizon: str
    investment_style: str
    sector_interests: tuple[str, ...]
    experience_level: str
    primary_goal: str
    profile_version: int
    schema_version: int


@dataclass(frozen=True)
class StockInput:
    ticker: str
    name: str
    sector: str
    kind: str
    benchmark: str
    active: bool = True


@dataclass(frozen=True)
class SignalInput:
    ticker: str
    generation: int
    algorithm_version: str
    session_date: str
    status: str
    trend_score: float | None
    benchmark: str
    relative_day_return: float | None
    notes: tuple[str, ...]
    published_at: datetime


@dataclass(frozen=True)
class BarInput:
    ticker: str
    session: date
    close: float
    source: str
    adjusted: bool


@dataclass(frozen=True)
class MarketInput:
    generation: int
    algorithm_version: str
    last_completed_session: str


@dataclass(frozen=True)
class FitComponent:
    name: str
    available: bool
    value: float | None
    weight: float
    reason: str | None


@dataclass(frozen=True)
class RecommendationItem:
    ticker: str
    display_rank: int
    trend_score: float
    fit_score: float
    recommendation_rank: float
    fit_coverage: float
    components: tuple[FitComponent, ...]
    realized_vol_20d: float | None
    max_drawdown_60d: float | None
    vol_sessions: int
    drawdown_sessions: int
    sector: str
    benchmark: str
    session_date: str
    history_source: str
    match_reason: str
    market_activity: str
    risk_observation: str
    learning_note: str
    limitations: tuple[str, ...]


@dataclass(frozen=True)
class RecommendationBatch:
    status: str
    market_generation: int
    signal_algorithm_version: str
    signal_session_date: str
    considered_count: int
    eligible_count: int
    summary: str
    limitations: tuple[str, ...]
    items: tuple[RecommendationItem, ...]
    exclusions: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class _Scored:
    item: RecommendationItem
    sector: str
    recommendation_rank: float
    fit_score: float
    published_at: datetime
    ticker: str


def _history_source(notes: tuple[str, ...]) -> str:
    for note in notes:
        if note.startswith("history_source:"):
            return note.split(":", 1)[1]
    return ""


def _fit_score(components: list[FitComponent]) -> tuple[float, float]:
    coverage = sum(c.weight for c in components if c.available and c.value is not None)
    if coverage <= 0:
        return 0.0, 0.0
    blended = sum(c.weight * (c.value or 0.0) for c in components if c.available and c.value is not None)
    return 100.0 * blended / coverage, coverage


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def _series(bars: list[BarInput], session: date, source: str) -> tuple[list[date], list[float], str | None]:
    chosen = [b for b in bars if b.source == source and b.session <= session and b.close > 0]
    if not chosen:
        return [], [], "history_source_missing"
    if len({b.adjusted for b in chosen}) != 1:
        return [], [], "inconsistent_adjustment"
    ordered = sorted(chosen, key=lambda b: b.session)
    # Keep one bar per session. A duplicate date from the same source is ambiguous.
    by_day: dict[date, BarInput] = {}
    for bar in ordered:
        if bar.session in by_day and bar.close != by_day[bar.session].close:
            return [], [], "duplicate_session"
        by_day[bar.session] = bar
    days = sorted(by_day)
    if not days or days[-1] != session:
        return [], [], "signal_session_missing_from_history"
    return days, [by_day[d].close for d in days], None


def _risk_component(profile: ProfileInput, metrics: RiskMetrics) -> tuple[FitComponent, str | None]:
    """Returns the component and an exclusion reason when the stock cannot be ranked."""
    weight = COMPONENT_WEIGHTS["risk_match"]
    if metrics.reason or metrics.realized_vol_20d is None or metrics.max_drawdown_60d is None:
        return (
            FitComponent("risk_match", False, None, weight, metrics.reason or "insufficient_risk_history"),
            "risk_metric_unavailable",
        )
    ceiling = VOL_CEILING[profile.risk_tolerance]
    floor = DRAWDOWN_FLOOR[profile.risk_tolerance]
    if ceiling is None or floor is None:
        # Explicit "no ceiling" is not a request for the highest recent volatility.
        return FitComponent("risk_match", False, None, weight, "no_risk_ceiling"), None
    if metrics.realized_vol_20d > ceiling:
        return FitComponent("risk_match", False, None, weight, "above_vol_ceiling"), "above_vol_ceiling"
    if metrics.max_drawdown_60d < floor:
        return FitComponent("risk_match", False, None, weight, "below_drawdown_floor"), "below_drawdown_floor"
    vol_match = _clamp01(1.0 - metrics.realized_vol_20d / ceiling)
    draw_match = _clamp01(1.0 - metrics.max_drawdown_60d / floor)
    value = RISK_VOL_WEIGHT * vol_match + RISK_DRAWDOWN_WEIGHT * draw_match
    return FitComponent("risk_match", True, value, weight, "within_risk_limit"), None


def _unscored(name: str, reason: str) -> FitComponent:
    return FitComponent(name, False, None, COMPONENT_WEIGHTS[name], reason)


def build_recommendations(
    profile: ProfileInput,
    market: MarketInput | None,
    stocks: list[StockInput],
    signals: list[SignalInput],
    bars_by_ticker: dict[str, list[BarInput]],
    benchmark_names: dict[str, str],
) -> RecommendationBatch:
    limitations = list(REQUIRED_LIMITATION_CODES)
    if market is None:
        return RecommendationBatch(
            status="insufficient_market",
            market_generation=0,
            signal_algorithm_version="",
            signal_session_date="",
            considered_count=0,
            eligible_count=0,
            summary=generation_summary(status="insufficient_market", risk_tolerance=profile.risk_tolerance, published=0),
            limitations=tuple(limitations),
            items=(),
        )

    by_signal = {s.ticker: s for s in signals}
    equities = [s for s in stocks if s.active and s.kind == "equity"]
    scored: list[_Scored] = []
    exclusions: dict[str, str] = {}
    iex = False

    for stock in equities:
        signal = by_signal.get(stock.ticker)
        if signal is None or signal.status != "published" or signal.trend_score is None:
            exclusions[stock.ticker] = "trend_not_published"
            continue
        if signal.generation != market.generation or signal.algorithm_version != market.algorithm_version:
            exclusions[stock.ticker] = "incoherent_signal"
            continue
        if signal.session_date != market.last_completed_session:
            exclusions[stock.ticker] = "session_mismatch"
            continue
        if not stock.sector:
            exclusions[stock.ticker] = "sector_unknown"
            continue
        source = _history_source(signal.notes)
        if source == "alpaca_iex":
            iex = True
        if not source:
            exclusions[stock.ticker] = "history_source_unknown"
            continue
        sessions, closes, series_reason = _series(bars_by_ticker.get(stock.ticker, []), date.fromisoformat(signal.session_date), source)
        metrics = risk_metrics(sessions, closes) if series_reason is None else RiskMetrics(None, None, 0, 0, series_reason)
        risk, excluded = _risk_component(profile, metrics)
        if excluded:
            exclusions[stock.ticker] = excluded
            continue
        in_sector = stock.sector in profile.sector_interests
        components = [
            risk,
            _unscored("horizon_match", "horizon_not_scored"),
            _unscored("style_match", "style_not_classified"),
            FitComponent(
                "sector_preference",
                True,
                1.0 if in_sector else 0.0,
                COMPONENT_WEIGHTS["sector_preference"],
                "sector_selected" if in_sector else "sector_not_selected",
            ),
        ]
        # Keep the documented component order even if risk was built first.
        components = [next(c for c in components if c.name == name) for name in COMPONENT_ORDER]
        fit, coverage = _fit_score(components)
        rank = TREND_BLEND * signal.trend_score + FIT_BLEND * fit
        bench_name = benchmark_names.get(stock.benchmark) or stock.benchmark
        company = stock.name or stock.ticker
        item = RecommendationItem(
            ticker=stock.ticker,
            display_rank=0,
            trend_score=signal.trend_score,
            fit_score=fit,
            recommendation_rank=rank,
            fit_coverage=coverage,
            components=tuple(components),
            realized_vol_20d=metrics.realized_vol_20d,
            max_drawdown_60d=metrics.max_drawdown_60d,
            vol_sessions=metrics.vol_sessions,
            drawdown_sessions=metrics.drawdown_sessions,
            sector=stock.sector,
            benchmark=stock.benchmark,
            session_date=signal.session_date,
            history_source=source,
            match_reason=match_reason(
                company=company, sector=stock.sector, in_sector=in_sector, risk_tolerance=profile.risk_tolerance
            ),
            market_activity=market_activity(
                trend_score=signal.trend_score,
                session_date=signal.session_date,
                benchmark_label=bench_name,
                experience=profile.experience_level,
                relative_day_return=signal.relative_day_return,
            ),
            risk_observation=risk_observation(
                realized_vol=metrics.realized_vol_20d,
                max_drawdown=metrics.max_drawdown_60d,
                vol_sessions=metrics.vol_sessions,
                drawdown_sessions=metrics.drawdown_sessions,
                experience=profile.experience_level,
            ),
            learning_note=learning_note(experience=profile.experience_level, goal=profile.primary_goal),
            limitations=tuple(row_limitations(history_source=source)),
        )
        scored.append(
            _Scored(
                item=item,
                sector=stock.sector,
                recommendation_rank=rank,
                fit_score=fit,
                published_at=signal.published_at,
                ticker=stock.ticker,
            )
        )

    if iex and "iex_volume_not_consolidated" not in limitations:
        limitations.append("iex_volume_not_consolidated")
    risk_exclusions = sum(1 for reason in exclusions.values() if reason in {"above_vol_ceiling", "below_drawdown_floor"})
    if risk_exclusions:
        limitations.append(f"risk_exclusions:{risk_exclusions}")

    ordered = sorted(scored, key=lambda s: (-s.recommendation_rank, -s.fit_score, -s.published_at.timestamp(), s.ticker))
    picked = _with_sector_variety(ordered)
    items: list[RecommendationItem] = []
    for rank, scored_row in enumerate(picked, start=1):
        item = scored_row.item
        items.append(
            RecommendationItem(
                ticker=item.ticker,
                display_rank=rank,
                trend_score=item.trend_score,
                fit_score=item.fit_score,
                recommendation_rank=item.recommendation_rank,
                fit_coverage=item.fit_coverage,
                components=item.components,
                realized_vol_20d=item.realized_vol_20d,
                max_drawdown_60d=item.max_drawdown_60d,
                vol_sessions=item.vol_sessions,
                drawdown_sessions=item.drawdown_sessions,
                sector=item.sector,
                benchmark=item.benchmark,
                session_date=item.session_date,
                history_source=item.history_source,
                match_reason=item.match_reason,
                market_activity=item.market_activity,
                risk_observation=item.risk_observation,
                learning_note=item.learning_note,
                limitations=item.limitations,
            )
        )

    published_any = any(s.status == "published" and s.trend_score is not None for s in signals)
    if not published_any:
        status = "insufficient_market"
    elif items:
        status = "ready"
    else:
        status = "no_eligible"
    return RecommendationBatch(
        status=status,
        market_generation=market.generation,
        signal_algorithm_version=market.algorithm_version,
        signal_session_date="" if status == "insufficient_market" else market.last_completed_session,
        considered_count=len(equities),
        eligible_count=len(scored),
        summary=generation_summary(status=status, risk_tolerance=profile.risk_tolerance, published=len(items)),
        limitations=tuple(limitations),
        items=tuple(items),
        exclusions=exclusions,
    )


def _with_sector_variety(ordered: list[_Scored]) -> list[_Scored]:
    remaining = list(ordered)
    picked: list[_Scored] = []
    while remaining and len(picked) < TOP_N:
        best = remaining[0]
        chosen_sectors = {row.sector for row in picked}
        if best.sector in chosen_sectors:
            alternative = next((row for row in remaining if row.sector not in chosen_sectors), None)
            if alternative is not None and best.recommendation_rank - alternative.recommendation_rank <= VARIETY_RANK_GAP:
                best = alternative
        picked.append(best)
        remaining.remove(best)
    return picked

