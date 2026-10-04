"""Versioned DTOs for state read from SpacetimeDB views.

`extra="forbid"` makes a module schema change that the backend has not been
updated for fail loudly at the gateway instead of silently dropping fields.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

JobStatus = Literal["queued", "running", "succeeded", "retry_wait", "failed"]

IdentityHex = str


class _Dto(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class JobV1(_Dto):
    job_id: int
    owner: IdentityHex
    kind: str
    request_key: str
    input_version: int
    status: JobStatus
    attempt_count: int
    max_attempts: int
    lease_owner: IdentityHex | None
    lease_until: datetime | None
    available_at: datetime
    payload: str
    result_ref: str | None
    error_code: str | None
    created_at: datetime
    updated_at: datetime


class InvestmentProfileV1(_Dto):
    owner: IdentityHex
    schema_version: Literal[1]
    profile_version: int = Field(ge=1)
    risk_tolerance: Literal["conservative", "moderate", "aggressive"]
    investment_horizon: Literal["weeks", "months", "years"]
    investment_style: Literal["growth", "value", "income", "balanced"]
    sector_interests: list[str]
    experience_level: Literal["new", "some", "experienced"]
    primary_goal: Literal["learn_basics", "grow_long_term", "generate_income", "follow_trends"]
    created_at: datetime
    updated_at: datetime


class ServiceGrantV1(_Dto):
    identity: IdentityHex
    label: str
    added_at: datetime


class StockV1(_Dto):
    ticker: str
    name: str
    exchange: str
    industry: str
    sector: str
    currency: str
    kind: Literal["equity", "benchmark"]
    benchmark: str
    display_order: int
    active: bool
    updated_at: datetime
    logo_url: str = ""


class MarketQuoteV1(_Dto):
    ticker: str
    generation: int
    price_micros: int
    previous_close_micros: int
    open_micros: int
    high_micros: int
    low_micros: int
    provider_time: datetime
    ingested_at: datetime
    published_at: datetime
    source: str


class DailyBarV1(_Dto):
    id: int
    ticker: str
    session_date: str
    open_micros: int | None
    high_micros: int | None
    low_micros: int | None
    close_micros: int
    volume: int | None
    adjusted: bool
    source: str
    ingested_at: datetime


class MarketGenerationV1(_Dto):
    scope: str
    generation: int
    job_id: int
    as_of: datetime
    published_at: datetime
    market_open: bool
    market_session: str
    market_status_at: datetime
    last_completed_session: str
    quote_count: int
    signal_count: int
    algorithm_version: str
    provider: str


class ProviderCapabilityV1(_Dto):
    key: str
    provider: str
    capability: str
    available: bool
    detail: str
    checked_at: datetime


class SignalFeatureV1(_Dto):
    name: str
    available: bool
    raw: float | None
    normalized: float | None
    weight: float
    sample_count: int
    baseline_count: int
    reason: str | None


class TrendSignalV1(_Dto):
    ticker: str
    generation: int
    algorithm_version: str
    session_date: str
    status: str
    trend_score: float | None
    composite: float | None
    coverage: float
    coverage_scope: str
    benchmark: str
    history_sessions: int
    required_sessions: int
    day_return: float | None
    benchmark_day_return: float | None
    relative_day_return: float | None
    features: list[SignalFeatureV1]
    notes: list[str]
    as_of: datetime
    published_at: datetime


class PaperAccountV1(_Dto):
    owner: IdentityHex
    provider_account_id: str
    cash_micros: int
    equity_micros: int
    buying_power_micros: int
    currency: str
    revision: int
    provider_time: datetime
    synced_at: datetime
    market_open: bool
    next_open: datetime | None
    next_close: datetime | None


class PaperOrderV1(_Dto):
    order_id: int
    owner: IdentityHex
    client_order_key: str
    ticker: str
    side: Literal["buy", "sell"]
    quantity_micros: int | None
    notional_micros: int | None
    quote_micros: int
    quote_time: datetime
    status: str
    provider_order_id: str | None
    filled_quantity_micros: int
    filled_avg_price_micros: int | None
    reject_reason: str | None
    revision: int
    created_at: datetime
    updated_at: datetime


class DailyDiscoveryV1(_Dto):
    id: int
    owner: IdentityHex
    discovery_date: str
    zodiac_sign: str | None
    sector_id: str
    sector_name: str
    subtheme_id: str
    title: str
    description: str
    algorithm_version: str
    theme_version: str
    market_generation: int
    considered_count: int
    eligible_count: int
    job_id: int
    created_at: datetime


class DailyDiscoveryItemV1(_Dto):
    id: int
    discovery_id: int
    owner: IdentityHex
    discovery_date: str
    ticker: str
    rank: int
    score: float
    trend_score: float | None
    fit_score: float | None
    news_score: float | None
    momentum_score: float | None
    novelty_score: float
    angle: str
    about: str
    reasons: list[str]
    news_count: int
    news_headline: str | None
    news_source: str | None
    news_url: str | None
    news_published_at: datetime | None
    # Jev coverage for the headline choice: "" (before Jev), classified, partial:<reason>, unavailable:<reason>, …
    news_classification: str = ""


class NewsClassificationV1(_Dto):
    """One Jev judgment of one article for one ticker (`news_classification`, service view only)."""

    cache_key: str
    ticker: str
    article_id: str
    content_hash: str
    classifier_version: str
    relevant: bool
    relevance_score: float = Field(ge=0, le=1)
    event_type: Literal[
        "earnings", "product", "partnership", "regulation", "M&A", "analyst_rating",
        "executive", "legal", "macro", "financing", "other",
    ]
    sentiment: Literal["positive", "neutral", "negative"]
    materiality: Literal["low", "medium", "high", "critical"]
    keep: bool
    published_at: datetime
    classified_at: datetime
    job_id: int
