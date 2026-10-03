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
