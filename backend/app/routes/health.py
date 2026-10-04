from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from app.config.settings import Settings
from app.intelligence.jev import CAPABILITY_KEY as JEV_CAPABILITY
from app.state.gateway import GatewayError, SpacetimeGateway

router = APIRouter(tags=["health"])

# `configured` = credentials present but no successful provider call recorded;
# `verified` = the worker recorded a schema-valid provider response.
CheckStatus = Literal["ok", "fail", "not_configured", "configured", "verified"]


class HealthV1(BaseModel):
    api_version: Literal["v1"] = "v1"
    status: Literal["ok"] = "ok"
    env: str


class ReadinessV1(BaseModel):
    api_version: Literal["v1"] = "v1"
    ready: bool
    checks: dict[str, CheckStatus]
    details: dict[str, str] = {}


@router.get("/health", response_model=HealthV1)
async def health(request: Request) -> HealthV1:
    """Process liveness only; does not touch dependencies."""
    settings: Settings = request.app.state.settings
    return HealthV1(env=settings.app_env)


@router.get("/ready", response_model=ReadinessV1)
async def ready(request: Request, response: Response) -> ReadinessV1:
    settings: Settings = request.app.state.settings
    gateway: SpacetimeGateway | None = request.app.state.gateway
    checks: dict[str, CheckStatus] = {}

    checks["spacetimedb"] = "ok" if gateway and await gateway.ping() else "fail"
    if gateway is None or settings.resolved_service_token() is None:
        checks["service_identity"] = "not_configured"
    else:
        try:
            checks["service_identity"] = "ok" if await gateway.service_grant() else "fail"
        except GatewayError:
            checks["service_identity"] = "fail"

    # These report configuration only ("ok" = credentials present).
    checks["finnhub"] = "ok" if settings.finnhub_api_key else "not_configured"
    checks["openai"] = "ok" if settings.openai_api_key else "not_configured"
    checks["alpaca_paper"] = "ok" if settings.alpaca_api_key_id else "not_configured"
    details: dict[str, str] = {}
    checks["jev"], details["jev"] = await _jev_status(settings, gateway, checks["spacetimedb"] == "ok")

    required = ("spacetimedb", "service_identity")
    is_ready = all(checks[name] == "ok" for name in required)
    if not is_ready:
        response.status_code = 503
    return ReadinessV1(ready=is_ready, checks=checks, details=details)


async def _jev_status(
    settings: Settings, gateway: SpacetimeGateway | None, can_read: bool
) -> tuple[CheckStatus, str]:
    """A key alone is `configured`. Only the worker's recorded provider result makes it `verified`."""
    if settings.jev_api_key is None:
        return "not_configured", "JEV_API_KEY is unset"
    if gateway is None or not can_read:
        return "configured", "Key configured; verification state unreadable"
    try:
        rows = await gateway.provider_capabilities()
    except GatewayError:
        return "configured", "Key configured; verification state unreadable"
    row = next((r for r in rows if r.key == JEV_CAPABILITY), None)
    if row is None:
        return "configured", "Key configured; no worker has verified it yet"
    when = row.checked_at.isoformat(timespec="seconds")
    if row.available:
        return "verified", f"{row.detail} (recorded {when})"
    if row.detail.startswith("Not configured") or row.detail.endswith("not verified yet"):
        return "configured", f"Key configured; worker reported: {row.detail} (recorded {when})"
    return "fail", f"{row.detail} (recorded {when})"
