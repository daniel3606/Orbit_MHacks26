"""SpacetimeGateway: the backend's only path to Orbit application state.

Transport is the documented SpacetimeDB HTTP API (PRD §5 MVP choice). Reads go
through caller-scoped/service-gated views with the service token; writes go
through reducers that re-check authorization. Swap the transport here (e.g. a
TypeScript SDK bridge) without touching workers.
"""

import logging
import re
from collections.abc import Sequence
from typing import Any, TypeVar

import httpx
from pydantic import BaseModel, SecretStr, ValidationError

from app.state.dto import (
    DailyBarV1,
    DailyDiscoveryItemV1,
    DailyDiscoveryV1,
    InvestmentProfileV1,
    JobV1,
    MarketGenerationV1,
    MarketQuoteV1,
    NewsClassificationV1,
    PaperAccountV1,
    PaperOrderV1,
    ProviderCapabilityV1,
    ServiceGrantV1,
    StockV1,
    TrendSignalV1,
)
from app.state.sats_json import SatsDecodeError, decode_result_set

log = logging.getLogger(__name__)

_CODE_PATTERN = re.compile(r"^[a-z][a-z0-9_]{0,63}$")

M = TypeVar("M", bound=BaseModel)


class GatewayError(Exception):
    """Base class; `code` is safe to surface to clients."""

    code = "state_gateway_error"
    retryable = False


class GatewayUnavailable(GatewayError):
    code = "state_unavailable"
    retryable = True


class GatewayAuthError(GatewayError):
    code = "state_auth_failed"


class GatewayContractError(GatewayError):
    code = "state_contract_mismatch"


class ReducerRejected(GatewayError):
    """A reducer threw SenderError. `code` is the module's stable error code."""

    def __init__(self, reducer: str, code: str):
        super().__init__(f"{reducer} rejected: {code}")
        self.reducer = reducer
        self.code = code


class SpacetimeGateway:
    def __init__(
        self,
        base_url: str,
        database: str,
        token: SecretStr | None,
        *,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        headers = {"Authorization": f"Bearer {token.get_secret_value()}"} if token else {}
        self._db = database
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"), headers=headers, timeout=timeout, transport=transport
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "SpacetimeGateway":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ---- transport ----

    async def _post(self, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.post(path, **kwargs)
        except httpx.TimeoutException as exc:
            raise GatewayUnavailable("timeout") from exc
        except httpx.TransportError as exc:
            raise GatewayUnavailable(type(exc).__name__) from exc
        return response

    def _raise_for_status(self, response: httpx.Response, *, reducer: str | None = None) -> None:
        status = response.status_code
        if status < 300:
            return
        body = response.text.strip()
        if status == 530 and reducer is not None:
            code = body if _CODE_PATTERN.match(body) else "reducer_error"
            raise ReducerRejected(reducer, code)
        if status in (401, 403):
            raise GatewayAuthError(f"HTTP {status}")
        if 400 <= status < 500:
            # Do not echo server bodies upward; log a bounded excerpt for operators.
            log.warning("spacetime contract error HTTP %s: %.200s", status, body)
            raise GatewayContractError(f"HTTP {status}")
        raise GatewayUnavailable(f"HTTP {status}")

    async def ping(self) -> bool:
        try:
            response = await self._client.get("/v1/ping")
        except httpx.HTTPError:
            return False
        return response.status_code == 200

    async def sql(self, query: str) -> list[list[dict[str, Any]]]:
        response = await self._post(f"/v1/database/{self._db}/sql", content=query.encode())
        self._raise_for_status(response)
        try:
            return [decode_result_set(result) for result in response.json()]
        except (ValueError, SatsDecodeError) as exc:
            raise GatewayContractError("undecodable SQL result") from exc

    async def call_reducer(self, reducer: str, args: Sequence[Any]) -> None:
        response = await self._post(f"/v1/database/{self._db}/call/{reducer}", json=list(args))
        self._raise_for_status(response, reducer=reducer)

    # ---- typed reads (views) ----

    async def _view(self, view: str) -> list[dict[str, Any]]:
        (rows,) = await self.sql(f"SELECT * FROM {view}")
        return rows

    @staticmethod
    def _parse(model: type[M], rows: list[dict[str, Any]]) -> list[M]:
        try:
            return [model.model_validate(row) for row in rows]
        except ValidationError as exc:
            raise GatewayContractError(f"{model.__name__} contract mismatch") from exc

    async def service_grant(self) -> ServiceGrantV1 | None:
        rows = self._parse(ServiceGrantV1, await self._view("my_service_grant"))
        return rows[0] if rows else None

    async def worker_jobs(self) -> list[JobV1]:
        return self._parse(JobV1, await self._view("worker_jobs"))

    async def worker_job_profiles(self) -> list[InvestmentProfileV1]:
        return self._parse(InvestmentProfileV1, await self._view("worker_job_profiles"))

    async def my_jobs(self) -> list[JobV1]:
        return self._parse(JobV1, await self._view("my_jobs"))

    # ---- worker reducers ----

    async def claim_job(self, job_id: int, lease_seconds: int) -> None:
        await self.call_reducer("claim_job", [job_id, lease_seconds])

    async def complete_job(self, job_id: int, attempt: int, input_version: int, result_ref: str) -> None:
        await self.call_reducer("complete_job", [job_id, attempt, input_version, result_ref])

    async def fail_job(self, job_id: int, attempt: int, error_code: str, retryable: bool) -> None:
        await self.call_reducer("fail_job", [job_id, attempt, error_code, retryable])

    async def register_worker(self, kinds: Sequence[str]) -> None:
        await self.call_reducer("register_worker", [list(kinds)])

    # ---- market (service-only reducers; public projections) ----

    async def stocks(self) -> list[StockV1]:
        return self._parse(StockV1, await self._view("stock"))

    async def market_quotes(self) -> list[MarketQuoteV1]:
        return self._parse(MarketQuoteV1, await self._view("market_quote"))

    async def market_generation(self) -> MarketGenerationV1 | None:
        rows = self._parse(MarketGenerationV1, await self._view("market_generation"))
        return rows[0] if rows else None

    async def provider_capabilities(self) -> list[ProviderCapabilityV1]:
        return self._parse(ProviderCapabilityV1, await self._view("provider_capability"))

    async def worker_daily_bars(self) -> list[DailyBarV1]:
        return self._parse(DailyBarV1, await self._view("worker_daily_bars"))

    async def upsert_stocks(self, stocks: Sequence[dict[str, Any]]) -> None:
        await self.call_reducer("upsert_stocks", [list(stocks)])

    async def publish_provider_capabilities(self, capabilities: Sequence[dict[str, Any]]) -> None:
        await self.call_reducer("publish_provider_capabilities", [list(capabilities)])

    async def trend_signals(self) -> list[TrendSignalV1]:
        return self._parse(TrendSignalV1, await self._view("trend_signal"))

    async def publish_recommendations(self, args: Sequence[Any]) -> None:
        await self.call_reducer("publish_recommendations", list(args))

    async def request_market_ingest(self) -> None:
        await self.call_reducer("request_market_ingest", [])

    async def publish_market_snapshot(self, args: Sequence[Any]) -> None:
        await self.call_reducer("publish_market_snapshot", list(args))

    async def worker_paper_orders(self) -> list[PaperOrderV1]:
        return self._parse(PaperOrderV1, await self._view("worker_paper_orders"))

    async def worker_paper_account(self) -> PaperAccountV1 | None:
        rows = self._parse(PaperAccountV1, await self._view("worker_paper_account"))
        return rows[0] if rows else None

    async def apply_paper_snapshot(self, args: Sequence[Any]) -> None:
        await self.call_reducer("apply_paper_snapshot", list(args))

    async def request_paper_reconcile(self) -> None:
        await self.call_reducer("request_paper_reconcile", [])

    async def worker_discovery_history(self) -> list[DailyDiscoveryV1]:
        return self._parse(DailyDiscoveryV1, await self._view("worker_discovery_history"))

    async def worker_discovery_items(self) -> list[DailyDiscoveryItemV1]:
        return self._parse(DailyDiscoveryItemV1, await self._view("worker_discovery_items"))

    async def publish_daily_discovery(self, args: Sequence[Any]) -> None:
        await self.call_reducer("publish_daily_discovery", list(args))

    async def worker_news_classifications(self) -> list[NewsClassificationV1]:
        return self._parse(NewsClassificationV1, await self._view("worker_news_classifications"))

    async def record_news_classifications(self, job_id: int, attempt: int, rows: Sequence[dict[str, Any]]) -> None:
        """Stores Jev judgments under the caller's lease on the job that produced them."""
        await self.call_reducer("record_news_classifications", [job_id, attempt, list(rows)])

    async def worker_assistant_messages(self) -> list[dict[str, Any]]:
        return await self._view("worker_assistant_messages")

    async def worker_assistant_positions(self) -> list[dict[str, Any]]:
        return await self._view("worker_assistant_positions")

    async def worker_assistant_recommendations(self) -> list[dict[str, Any]]:
        return await self._view("worker_assistant_recommendations")

    async def publish_assistant_reply(
        self, job_id: int, attempt: int, reply_client_key: str, body: str, citations: str, status: str
    ) -> None:
        await self.call_reducer(
            "publish_assistant_reply",
            [job_id, attempt, reply_client_key, body, citations, status],
        )
