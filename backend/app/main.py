"""FastAPI entrypoint: `uv run uvicorn app.main:app --reload`.

Protected command routes (`/assistant/messages`, `/paper/orders`,
`/recommendations/refresh`) are deliberately absent until the mobile → FastAPI
identity binding is verified (PRD §7). Mobile mutations go through
SpacetimeDB reducers directly.
"""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config.settings import Settings, get_settings
from app.routes import health
from app.state.gateway import GatewayError, SpacetimeGateway

log = logging.getLogger("orbit.api")


def _error(status: int, code: str, request_id: str, message: str | None = None) -> JSONResponse:
    return JSONResponse(
        status_code=status,
        content={"api_version": "v1", "error": {"code": code, "message": message or code, "request_id": request_id}},
        headers={"x-request-id": request_id},
    )


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    logging.basicConfig(level=settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        app.state.settings = settings
        app.state.gateway = SpacetimeGateway(
            str(settings.spacetime_http_url),
            settings.spacetime_database,
            settings.resolved_service_token(),
            timeout=settings.spacetime_timeout_seconds,
        )
        try:
            yield
        finally:
            await app.state.gateway.aclose()

    app = FastAPI(title="Orbit backend", version="0.1.0", lifespan=lifespan)

    @app.middleware("http")
    async def request_id(request: Request, call_next):  # type: ignore[no-untyped-def]
        rid = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = rid
        response = await call_next(request)
        response.headers["x-request-id"] = rid
        return response

    @app.exception_handler(GatewayError)
    async def gateway_error(request: Request, exc: GatewayError) -> JSONResponse:
        status = 503 if exc.retryable else 502
        return _error(status, exc.code, request.state.request_id)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        return _error(422, "invalid_request", request.state.request_id)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = {404: "not_found", 405: "method_not_allowed"}.get(exc.status_code, "http_error")
        return _error(exc.status_code, code, request.state.request_id)

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception) -> JSONResponse:
        log.exception("unhandled error request_id=%s", request.state.request_id)
        return _error(500, "internal_error", request.state.request_id)

    app.include_router(health.router)
    return app


app = create_app()
