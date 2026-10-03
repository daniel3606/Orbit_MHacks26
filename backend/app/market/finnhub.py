"""Finnhub adapter (https://finnhub.io/docs/api).

Verified against the official OpenAPI spec (finnhub.io/static/swagger.json)
and live probes on 2026-10-03:
- Auth: `X-Finnhub-Token` header (documented), so the key never enters URLs.
- `/quote`: c, d, dp, h, l, o, pc and `t` (UNIX seconds; absent from the spec
  schema but returned live). No volume. Unknown symbols return all zeros.
- `/stock/candle`: daily data adjusted for splits (not dividends); intraday
  unadjusted. HTTP 403 on plans without access, which is probed, not assumed.
- Limits: plan limit per minute (x-ratelimit-* headers) plus 30 calls/second;
  exceeding returns HTTP 429.
"""

import json
import logging
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx
from pydantic import SecretStr

from app.market.http import (
    ProviderAccessDenied,
    ProviderContractError,
    ProviderRateLimited,
    ProviderUnavailable,
    RateLimiter,
    RequestCoalescer,
    Sleep,
    with_retries,
)
from app.market.provider import (
    CapabilityResult,
    CompanyProfile,
    DailyBar,
    Holiday,
    MarketStatus,
    Quote,
)

log = logging.getLogger(__name__)

PROVIDER = "finnhub"
DEFAULT_BASE_URL = "https://finnhub.io/api/v1"

# Cache lifetimes (seconds). Quotes are short so each ingestion sees fresh data.
QUOTE_TTL = 20
CANDLE_TTL = 3600
PROFILE_TTL = 86_400
HOLIDAY_TTL = 43_200
STATUS_TTL = 30
CAPABILITY_TTL = 6 * 3600

CAPABILITY_PROBE_SYMBOL = "SPY"


def _decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise ProviderContractError(f"{field} missing")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ProviderContractError(f"{field} not numeric") from exc
    if not result.is_finite():
        raise ProviderContractError(f"{field} not finite")
    return result


class FinnhubProvider:
    name = PROVIDER

    def __init__(
        self,
        api_key: SecretStr,
        *,
        base_url: str = DEFAULT_BASE_URL,
        calls_per_minute: int = 50,
        burst: int = 20,
        max_retries: int = 3,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep | None = None,
        limiter: RateLimiter | None = None,
    ):
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={"X-Finnhub-Token": api_key.get_secret_value()},
            timeout=timeout,
            transport=transport,
        )
        kwargs: dict[str, Any] = {} if sleep is None else {"sleep": sleep}
        self._limiter = limiter or RateLimiter(calls_per_minute, burst=burst, **kwargs)
        self._coalescer = RequestCoalescer()
        self._max_retries = max_retries
        self._sleep_kwargs = kwargs
        self.http_calls = 0  # observable for tests and diagnostics

    async def aclose(self) -> None:
        await self._client.aclose()

    # ---- transport ----

    async def _get_once(self, path: str, params: dict[str, Any]) -> Any:
        await self._limiter.acquire()
        self.http_calls += 1
        try:
            response = await self._client.get(path, params=params)
        except httpx.TimeoutException as exc:
            raise ProviderUnavailable("timeout") from exc
        except httpx.TransportError as exc:
            raise ProviderUnavailable(type(exc).__name__) from exc
        status = response.status_code
        if status == 200:
            try:
                return json.loads(response.text, parse_float=Decimal)
            except ValueError as exc:
                raise ProviderContractError("invalid JSON", status=status) from exc
        if status in (401, 403):
            raise ProviderAccessDenied(f"HTTP {status}: not available on this account", status=status)
        if status == 429:
            error = ProviderRateLimited("HTTP 429", status=status)
            reset = response.headers.get("x-ratelimit-reset")
            error.reset_at = float(reset) if reset and reset.isdigit() else None  # type: ignore[attr-defined]
            raise error
        if status >= 500:
            raise ProviderUnavailable(f"HTTP {status}", status=status)
        raise ProviderContractError(f"HTTP {status}", status=status)

    def _on_rate_limited(self, exc: ProviderRateLimited) -> float:
        reset_at = getattr(exc, "reset_at", None)
        wait = 5.0
        if reset_at is not None:
            wait = min(60.0, max(1.0, reset_at - datetime.now(UTC).timestamp()))
        self._limiter.pause_for(wait)
        return wait

    async def _get(self, path: str, params: dict[str, Any], ttl: float) -> Any:
        key = path + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
        return await self._coalescer.get(
            key,
            ttl,
            lambda: with_retries(
                lambda: self._get_once(path, params),
                max_retries=self._max_retries,
                on_rate_limited=self._on_rate_limited,
                **self._sleep_kwargs,
            ),
        )

    # ---- capabilities (probed, never assumed) ----

    async def capabilities(self) -> list[CapabilityResult]:
        result: list[CapabilityResult] = await self._coalescer.get(
            "capabilities", CAPABILITY_TTL, self._probe_capabilities
        )
        return result

    async def _probe_capabilities(self) -> list[CapabilityResult]:
        today = datetime.now(UTC).date()
        probes: list[tuple[str, str, str, dict[str, Any]]] = [
            ("quote", "Latest quote with timestamp", "/quote", {"symbol": CAPABILITY_PROBE_SYMBOL}),
            (
                "daily_candles",
                "Daily historical OHLCV",
                "/stock/candle",
                {
                    "symbol": CAPABILITY_PROBE_SYMBOL,
                    "resolution": "D",
                    "from": int(datetime.combine(today - timedelta(days=14), time(), UTC).timestamp()),
                    "to": int(datetime.combine(today, time(), UTC).timestamp()),
                },
            ),
            ("splits", "Split history", "/stock/split", {"symbol": CAPABILITY_PROBE_SYMBOL, "from": "2020-01-01", "to": today.isoformat()}),
            ("company_profile", "Company profile", "/stock/profile2", {"symbol": "AAPL"}),
            ("market_status", "Exchange status", "/stock/market-status", {"exchange": "US"}),
            ("market_holidays", "Exchange holidays", "/stock/market-holiday", {"exchange": "US"}),
        ]
        out = []
        for key, label, path, params in probes:
            try:
                await self._get(path, params, ttl=0)
                out.append(CapabilityResult(f"{PROVIDER}.{key}", label, True, "Accessible with configured key", PROVIDER))
            except ProviderAccessDenied as exc:
                out.append(CapabilityResult(f"{PROVIDER}.{key}", label, False, f"{exc}; not included in current plan", PROVIDER))
        return out

    async def has(self, key: str) -> bool:
        return any(c.key == f"{PROVIDER}.{key}" and c.available for c in await self.capabilities())

    async def history_source(self) -> str | None:
        if await self.has("daily_candles"):
            return "finnhub_candle"
        return None

    # ---- data ----

    async def get_quote(self, ticker: str) -> Quote:
        body = await self._get("/quote", {"symbol": ticker}, QUOTE_TTL)
        if not isinstance(body, dict):
            raise ProviderContractError("quote not an object")
        t = body.get("t")
        if not isinstance(t, int) or t <= 0 or body.get("c") in (0, None):
            raise ProviderContractError(f"no quote data for {ticker}")
        return Quote(
            ticker=ticker,
            price=_decimal(body.get("c"), "c"),
            previous_close=_decimal(body.get("pc"), "pc"),
            open=_decimal(body.get("o"), "o"),
            high=_decimal(body.get("h"), "h"),
            low=_decimal(body.get("l"), "l"),
            provider_time=datetime.fromtimestamp(t, UTC),
            ingested_at=datetime.now(UTC),
            source=PROVIDER,
        )

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        params = {
            "symbol": ticker,
            "resolution": "D",
            "from": int(datetime.combine(start, time(), UTC).timestamp()),
            "to": int(datetime.combine(end, time(23, 59), UTC).timestamp()),
        }
        body = await self._get("/stock/candle", params, CANDLE_TTL)
        if not isinstance(body, dict):
            raise ProviderContractError("candle response not an object")
        if body.get("s") == "no_data":
            return []
        if body.get("s") != "ok":
            raise ProviderContractError("unexpected candle status")
        columns = [body.get(k) for k in ("t", "o", "h", "l", "c", "v")]
        if not all(isinstance(col, list) for col in columns) or len({len(col) for col in columns}) != 1:  # type: ignore[arg-type]
            raise ProviderContractError("candle arrays malformed")
        bars = []
        for ts, o, h, low, c, v in zip(*columns, strict=True):
            bars.append(
                DailyBar(
                    ticker=ticker,
                    session=datetime.fromtimestamp(int(ts), UTC).date(),
                    close=_decimal(c, "c"),
                    open=_decimal(o, "o"),
                    high=_decimal(h, "h"),
                    low=_decimal(low, "l"),
                    volume=int(v),
                    adjusted=True,  # documented: daily candles are split-adjusted
                    source="finnhub_candle",
                )
            )
        return bars

    async def get_profile(self, ticker: str) -> CompanyProfile | None:
        body = await self._get("/stock/profile2", {"symbol": ticker}, PROFILE_TTL)
        if not isinstance(body, dict) or not body.get("name"):
            return None  # e.g. ETFs return {}
        return CompanyProfile(
            ticker=ticker,
            name=str(body["name"]),
            exchange=str(body.get("exchange", "")),
            industry=str(body.get("finnhubIndustry", "")),
            currency=str(body.get("currency", "USD")),
        )

    async def get_market_status(self) -> MarketStatus:
        body = await self._get("/stock/market-status", {"exchange": "US"}, STATUS_TTL)
        if not isinstance(body, dict) or not isinstance(body.get("t"), int):
            raise ProviderContractError("market status malformed")
        return MarketStatus(
            exchange="US",
            is_open=bool(body.get("isOpen")),
            session=str(body.get("session") or "closed"),
            holiday=body.get("holiday"),
            as_of=datetime.fromtimestamp(body["t"], UTC),
        )

    async def get_holidays(self) -> list[Holiday]:
        body = await self._get("/stock/market-holiday", {"exchange": "US"}, HOLIDAY_TTL)
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, list):
            raise ProviderContractError("holiday list malformed")
        return [
            Holiday(day=date.fromisoformat(h["atDate"]), trading_hours=str(h.get("tradingHour") or ""))
            for h in data
            if isinstance(h, dict) and h.get("atDate")
        ]
