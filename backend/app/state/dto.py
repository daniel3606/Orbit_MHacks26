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
