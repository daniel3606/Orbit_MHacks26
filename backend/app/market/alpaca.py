"""Alpaca Market Data historical daily bars.

Verified against the official docs and a live probe on 2026-10-03:
- https://docs.alpaca.markets/us/reference/stockbars
- https://docs.alpaca.markets/us/docs/market-data-faq

Host is ``data.alpaca.markets`` only. This adapter never calls the paper or
live trading APIs, so reading history cannot submit or enable orders.

Adjustment is the explicit query parameter ``split``. The API default is
``raw`` (no adjustment). Documented ``split`` semantics: adjust price and
volume for forward and reverse splits. Dividend and spin-off adjustments are
not requested, so every stock and benchmark uses one convention. ``adjusted``
on the bar means that split adjustment, not dividend adjustment.

Feed preference is historical SIP (consolidated US tape). SIP queries must
use an ``end`` at least 15 minutes old unless the account has a realtime SIP
subscription; this adapter always ends at least 16 minutes ago and only on
completed sessions. If SIP is denied, the whole series falls back to IEX and
that limitation is recorded: IEX volume is one exchange, not consolidated
volume. SIP and IEX bars are never combined in one series.

Daily bar timestamps are midnight America/New_York (for example
``2026-10-02T04:00:00Z`` during EDT). The session date is that New York date.
The provider omits a bar when any OHLC or volume field is zero, so missing
sessions are left missing rather than filled in.
"""

import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

import httpx
from pydantic import SecretStr

from app.market.calendar import ET, UsEquityCalendar
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
from app.market.provider import CapabilityResult, DailyBar

log = logging.getLogger(__name__)

PROVIDER = "alpaca"
DEFAULT_BASE_URL = "https://data.alpaca.markets"
BARS_PATH = "/v2/stocks/bars"

# Documented adjustment set: raw | split | dividend | spin-off | all.
# `split` adjusts both price and volume. It is not the API default.
ADJUSTMENT = "split"
ADJUSTMENT_DETAIL = (
    "adjustment=split: prices and volume adjusted for splits, not dividends or spin-offs"
)

# Historical SIP without a realtime subscription requires `end` >= 15 minutes ago.
SIP_QUERY_LAG = timedelta(minutes=16)
BAR_TTL = 3600
CAPABILITY_TTL = 6 * 3600
MAX_PAGES = 20
PAGE_LIMIT = 10_000
PROBE_SYMBOL = "SPY"

SOURCE_SIP = "alpaca_sip"
SOURCE_IEX = "alpaca_iex"


def session_safe_for_historical_sip(cal: UsEquityCalendar, now: datetime) -> date:
    """Latest completed session whose close is at least `SIP_QUERY_LAG` ago.

    A daily bar is only requested once that session is finished and outside
    the latest-15-minute SIP window. Early closes use the calendar's close.
    """
    day = cal.last_completed_session(now)
    while cal.session_close(day) > now - SIP_QUERY_LAG:
        day = cal.previous_trading_day(day)
    return day


def _decimal(value: Any, field: str) -> Decimal:
    if isinstance(value, bool) or value is None:
        raise ProviderContractError(f"{field} missing")
    try:
        result = Decimal(str(value))
    except InvalidOperation as exc:
        raise ProviderContractError(f"{field} not numeric") from exc
    if not result.is_finite() or result <= 0:
        raise ProviderContractError(f"{field} not a positive price")
    return result


def _session_date(stamp: str) -> date:
    text = stamp.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ProviderContractError("bar timestamp malformed") from exc
    if parsed.tzinfo is None:
        raise ProviderContractError("bar timestamp missing timezone")
    return parsed.astimezone(ET).date()


def _rfc3339(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class AlpacaHistoricalProvider:
    """Historical daily bars only. No quotes, no orders, no account calls."""

    name = PROVIDER

    def __init__(
        self,
        key_id: SecretStr,
        secret_key: SecretStr,
        *,
        base_url: str = DEFAULT_BASE_URL,
        calls_per_minute: int = 150,
        burst: int = 10,
        max_retries: int = 3,
        timeout: float = 20.0,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep | None = None,
        limiter: RateLimiter | None = None,
        clock: Callable[[], datetime] | None = None,
    ):
        if httpx.URL(base_url).host != "data.alpaca.markets":
            raise ValueError("Alpaca historical data must use data.alpaca.markets")
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={
                "APCA-API-KEY-ID": key_id.get_secret_value(),
                "APCA-API-SECRET-KEY": secret_key.get_secret_value(),
            },
            timeout=timeout,
            transport=transport,
        )
        kwargs: dict[str, Any] = {} if sleep is None else {"sleep": sleep}
        self._limiter = limiter or RateLimiter(calls_per_minute, burst=burst, **kwargs)
        self._coalescer = RequestCoalescer()
        self._max_retries = max_retries
        self._sleep_kwargs = kwargs
        self._clock = clock or (lambda: datetime.now(UTC))
        self.http_calls = 0
        self._feed: str | None = None  # "sip" | "iex" once probed

    async def aclose(self) -> None:
        await self._client.aclose()

    def _now(self) -> datetime:
        now = self._clock()
        if now.tzinfo is None:
            raise ProviderContractError("clock must be timezone-aware")
        return now

    async def _get_once(self, params: dict[str, Any]) -> Any:
        await self._limiter.acquire()
        self.http_calls += 1
        try:
            response = await self._client.get(BARS_PATH, params=params)
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
        message = _safe_message(response)
        if status in (401, 403) or _sip_subscription_denied(status, message):
            raise ProviderAccessDenied(message or f"HTTP {status}", status=status)
        if status == 429:
            error = ProviderRateLimited("HTTP 429", status=status)
            reset = response.headers.get("x-ratelimit-reset")
            error.reset_at = float(reset) if reset and reset.isdigit() else None  # type: ignore[attr-defined]
            raise error
        if status >= 500:
            raise ProviderUnavailable(f"HTTP {status}", status=status)
        raise ProviderContractError(message or f"HTTP {status}", status=status)

    def _on_rate_limited(self, exc: ProviderRateLimited) -> float:
        reset_at = getattr(exc, "reset_at", None)
        wait = 5.0
        if reset_at is not None:
            wait = min(60.0, max(1.0, reset_at - self._now().timestamp()))
        self._limiter.pause_for(wait)
        return wait

    async def _get(self, params: dict[str, Any]) -> Any:
        return await with_retries(
            lambda: self._get_once(params),
            max_retries=self._max_retries,
            on_rate_limited=self._on_rate_limited,
            **self._sleep_kwargs,
        )

    async def capabilities(self) -> list[CapabilityResult]:
        result: list[CapabilityResult] = await self._coalescer.get(
            "capabilities", CAPABILITY_TTL, self._probe_capabilities
        )
        return result

    async def _probe_capabilities(self) -> list[CapabilityResult]:
        """SIP first, on a completed window safely outside the 15-minute rule."""
        now = self._now()
        end = now - timedelta(days=3)
        start = end - timedelta(days=10)
        sip_error = ""
        try:
            await self._get(self._params(PROBE_SYMBOL, start.date(), end, "sip"))
            self._feed = "sip"
        except ProviderAccessDenied as exc:
            sip_error = str(exc)
            self._feed = None
        if self._feed == "sip":
            return [
                CapabilityResult(
                    "alpaca.historical_sip",
                    "Consolidated US daily bars (SIP)",
                    True,
                    f"Historical SIP accessible. {ADJUSTMENT_DETAIL}.",
                    PROVIDER,
                ),
                CapabilityResult(
                    "alpaca.historical_bars",
                    "Daily historical prices and volume",
                    True,
                    f"feed=sip; {ADJUSTMENT_DETAIL}. Volume is consolidated US market volume.",
                    PROVIDER,
                ),
            ]
        iex_error = ""
        try:
            await self._get(self._params(PROBE_SYMBOL, start.date(), end, "iex"))
            self._feed = "iex"
        except ProviderAccessDenied as exc:
            iex_error = str(exc)
            self._feed = None
        if self._feed == "iex":
            return [
                CapabilityResult(
                    "alpaca.historical_sip",
                    "Consolidated US daily bars (SIP)",
                    False,
                    sip_error or "SIP historical bars are not available on this account",
                    PROVIDER,
                ),
                CapabilityResult(
                    "alpaca.historical_bars",
                    "Daily historical prices and volume",
                    True,
                    (
                        f"feed=iex; {ADJUSTMENT_DETAIL}. "
                        "IEX volume is not consolidated market volume. "
                        "SIP and IEX observations are not mixed."
                    ),
                    PROVIDER,
                ),
            ]
        self._feed = None
        return [
            CapabilityResult(
                "alpaca.historical_sip",
                "Consolidated US daily bars (SIP)",
                False,
                sip_error or "SIP historical bars are not available on this account",
                PROVIDER,
            ),
            CapabilityResult(
                "alpaca.historical_bars",
                "Daily historical prices and volume",
                False,
                iex_error or sip_error or "Historical daily bars are not available on this account",
                PROVIDER,
            ),
        ]

    async def history_source(self) -> str | None:
        await self.capabilities()
        if self._feed == "sip":
            return SOURCE_SIP
        if self._feed == "iex":
            return SOURCE_IEX
        return None

    def _params(self, ticker: str, start: date, end: datetime, feed: str, page_token: str | None = None) -> dict[str, Any]:
        params: dict[str, Any] = {
            "symbols": ticker,
            "timeframe": "1Day",
            "start": _rfc3339(datetime.combine(start, time.min, ET)),
            "end": _rfc3339(end),
            "adjustment": ADJUSTMENT,
            "feed": feed,
            "limit": PAGE_LIMIT,
            "sort": "asc",
        }
        if page_token:
            params["page_token"] = page_token
        return params

    def _query_end(self, end: date, now: datetime) -> datetime:
        """Inclusive end: that New York date, and never inside the SIP lag."""
        day_end = datetime.combine(end, time(23, 59, 59), ET)
        return min(day_end, now.astimezone(ET) - SIP_QUERY_LAG)

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        source = await self.history_source()
        if source is None or self._feed is None:
            raise ProviderAccessDenied("Alpaca historical bars are not available")
        feed = self._feed
        now = self._now()
        query_end = self._query_end(end, now)
        if query_end < datetime.combine(start, time.min, ET):
            return []
        key = f"bars:{feed}:{ADJUSTMENT}:{ticker}:{start.isoformat()}:{end.isoformat()}:{_rfc3339(query_end)}"
        bars: list[DailyBar] = await self._coalescer.get(
            key, BAR_TTL, lambda: self._fetch_bars(ticker, start, end, query_end, feed, source)
        )
        return bars

    async def _fetch_bars(
        self, ticker: str, start: date, end: date, query_end: datetime, feed: str, source: str
    ) -> list[DailyBar]:
        token: str | None = None
        seen: set[str] = set()
        raw: list[dict[str, Any]] = []
        for _ in range(MAX_PAGES):
            current = token
            body = await self._get(self._params(ticker, start, query_end, feed, current))
            if not isinstance(body, dict):
                raise ProviderContractError("bars response not an object")
            currency = body.get("currency")
            if currency not in (None, "USD"):
                raise ProviderContractError("unexpected bar currency")
            grouped = body.get("bars")
            if not isinstance(grouped, dict):
                raise ProviderContractError("bars payload malformed")
            rows = grouped.get(ticker, [])
            if not isinstance(rows, list):
                raise ProviderContractError("bars list malformed")
            raw.extend(row for row in rows if isinstance(row, dict))
            nxt = body.get("next_page_token")
            if not nxt:
                break
            if not isinstance(nxt, str) or nxt in seen:
                raise ProviderContractError("pagination token malformed")
            seen.add(nxt)
            token = nxt
        else:
            raise ProviderContractError("pagination did not end")
        bars = _bars_from_rows(ticker, raw, start, end, source)
        # Drop a session whose regular close is still after the query end. That
        # keeps a just-closed day out of the series until it is outside the SIP
        # lag. Early closes are included once 16:00 ET has cleared that lag.
        return [b for b in bars if datetime.combine(b.session, time(16, 0), ET) <= query_end]


def _bars_from_rows(ticker: str, rows: list[dict[str, Any]], start: date, end: date, source: str) -> list[DailyBar]:
    by_day: dict[date, DailyBar] = {}
    for row in rows:
        session = _session_date(str(row.get("t") or ""))
        if session < start or session > end:
            continue
        try:
            close = _decimal(row.get("c"), "c")
            opened = _decimal(row.get("o"), "o")
            high = _decimal(row.get("h"), "h")
            low = _decimal(row.get("l"), "l")
            volume = row.get("v")
            if isinstance(volume, bool) or not isinstance(volume, (int, Decimal)):
                raise ProviderContractError("volume missing")
            vol = int(volume)
        except ProviderContractError:
            log.warning("alpaca bar skipped for %s on %s", ticker, session.isoformat())
            continue
        if vol <= 0 or not (low <= close <= high) or not (low <= opened <= high):
            log.warning("alpaca bar skipped for %s on %s", ticker, session.isoformat())
            continue
        by_day[session] = DailyBar(
            ticker=ticker,
            session=session,
            close=close,
            open=opened,
            high=high,
            low=low,
            volume=vol,
            adjusted=True,
            source=source,
        )
    return [by_day[d] for d in sorted(by_day)]


def _safe_message(response: httpx.Response) -> str:
    """Error text from the provider. Response bodies here do not echo credentials."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if isinstance(body, dict):
        message = body.get("message")
        if isinstance(message, str):
            return message[:300]
    return ""


def _sip_subscription_denied(status: int, message: str) -> bool:
    if status not in (403, 422):
        return False
    text = message.lower()
    return "subscription does not permit" in text or "recent sip" in text
