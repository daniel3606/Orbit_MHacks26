from typing import Literal

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel

from app.config.settings import Settings
from app.state.gateway import GatewayError, SpacetimeGateway

router = APIRouter(tags=["health"])

CheckStatus = Literal["ok", "fail", "not_configured"]


class HealthV1(BaseModel):
    api_version: Literal["v1"] = "v1"
    status: Literal["ok"] = "ok"
    env: str


class ReadinessV1(BaseModel):
    api_version: Literal["v1"] = "v1"
    ready: bool
    checks: dict[str, CheckStatus]


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

    # Provider adapters are not implemented in this phase; report configuration only.
    checks["finnhub"] = "ok" if settings.finnhub_api_key else "not_configured"
    checks["jev"] = "ok" if settings.jev_api_key else "not_configured"
    checks["openai"] = "ok" if settings.openai_api_key else "not_configured"
    checks["alpaca_paper"] = "ok" if settings.alpaca_api_key_id else "not_configured"

    required = ("spacetimedb", "service_identity")
    is_ready = all(checks[name] == "ok" for name in required)
    if not is_ready:
        response.status_code = 503
    return ReadinessV1(ready=is_ready, checks=checks)
