"""Finnhub adapter behaviour against mocked HTTP. Response bodies mirror shapes
observed from the live API on 2026-10-03 (values are FIXTURES)."""

import asyncio
from datetime import UTC, date, datetime
from decimal import Decimal

import httpx
import pytest
from pydantic import SecretStr

from app.market.calendar import UsEquityCalendar
from app.market.finnhub import FinnhubProvider
from app.market.http import (
    ProviderAccessDenied,
    ProviderContractError,
    ProviderRateLimited,
    ProviderUnavailable,
    RateLimiter,
)
from app.market.provider import Holiday, Quote
from app.market.sessions import bars_from_quote, check_quote

QUOTE = {"c": 333.69, "d": 3.37, "dp": 1.0202, "h": 334.54, "l": 330.61, "o": 333.26, "pc": 330.32, "t": 1790971200}


class Recorder:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return item(request) if callable(item) else item


async def no_sleep(_seconds: float) -> None:
    return None


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


def provider(recorder: Recorder, **kw) -> FinnhubProvider:
    clock = FakeClock()
    limiter = RateLimiter(10_000, burst=1000, clock=clock, sleep=clock.sleep)
    return FinnhubProvider(
        SecretStr("test-key"), transport=httpx.MockTransport(recorder), sleep=no_sleep, limiter=limiter, **kw
    )


async def test_quote_parsed_with_decimal_and_provider_time():
    rec = Recorder([httpx.Response(200, json=QUOTE)])
    q = await provider(rec).get_quote("AAPL")
    assert q.price == Decimal("333.69") and q.previous_close == Decimal("330.32")
    assert q.provider_time == datetime(2026, 10, 2, 20, 0, tzinfo=UTC)
    req = rec.requests[0]
    assert req.headers["X-Finnhub-Token"] == "test-key"
    assert "token" not in str(req.url) and "test-key" not in str(req.url)


async def test_unknown_symbol_zero_quote_is_rejected():
    rec = Recorder([httpx.Response(200, json={"c": 0, "d": None, "dp": None, "h": 0, "l": 0, "o": 0, "pc": 0, "t": 0})])
    with pytest.raises(ProviderContractError):
        await provider(rec).get_quote("ZZZZQ")


async def test_concurrent_identical_requests_are_coalesced():
    async def slow(_request):
        await asyncio.sleep(0.01)
        return httpx.Response(200, json=QUOTE)

    calls = 0

    class Transport(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            nonlocal calls
            calls += 1
            return await slow(request)

    p = FinnhubProvider(SecretStr("k"), transport=Transport(), limiter=RateLimiter(10_000, burst=1000))
    results = await asyncio.gather(*(p.get_quote("AAPL") for _ in range(10)))
    assert calls == 1 and len({r.price for r in results}) == 1
    await p.get_quote("AAPL")  # within TTL: served from cache
    assert calls == 1


async def test_transient_errors_retry_with_bound():
    rec = Recorder([httpx.Response(503), httpx.Response(502), httpx.Response(200, json=QUOTE)])
    q = await provider(rec, max_retries=3).get_quote("AAPL")
    assert q.ticker == "AAPL" and len(rec.requests) == 3

    rec = Recorder([httpx.Response(503)])
    with pytest.raises(ProviderUnavailable):
        await provider(rec, max_retries=2).get_quote("AAPL")
    assert len(rec.requests) == 3  # initial + 2 retries, then stop


async def test_rate_limit_429_pauses_then_retries():
    rec = Recorder([httpx.Response(429, headers={"x-ratelimit-reset": "0"}), httpx.Response(200, json=QUOTE)])
    p = provider(rec, max_retries=2)
    assert (await p.get_quote("AAPL")).ticker == "AAPL"
    assert len(rec.requests) == 2

    rec = Recorder([httpx.Response(429)])
    with pytest.raises(ProviderRateLimited):
        await provider(rec, max_retries=1).get_quote("AAPL")
    assert len(rec.requests) == 2


async def test_access_denied_is_not_retried_and_marks_capability():
    rec = Recorder([httpx.Response(403, json={"error": "You don't have access to this resource."})])
    p = provider(rec, max_retries=3)
    with pytest.raises(ProviderAccessDenied):
        await p.get_daily_bars("SPY", date(2026, 9, 1), date(2026, 10, 2))
    assert len(rec.requests) == 1


async def test_capability_probe_reports_plan_restrictions():
    def route(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith(("/stock/candle", "/stock/split")):
            return httpx.Response(403, json={"error": "You don't have access to this resource."})
        if request.url.path.endswith("/stock/market-holiday"):
            return httpx.Response(200, json={"data": [], "exchange": "US"})
        return httpx.Response(200, json=QUOTE)

    p = provider(Recorder([route]))
    caps = {c.key: c for c in await p.capabilities()}
    assert caps["finnhub.quote"].available
    assert not caps["finnhub.daily_candles"].available and "403" in caps["finnhub.daily_candles"].detail
    assert not caps["finnhub.splits"].available
    assert await p.has("quote") and not await p.has("daily_candles")


async def test_profile_keeps_https_logo_only():
    logo = "https://static2.finnhub.io/file/publicdatany/finnhubimage/stock_logo/GOOG.png"
    body = {"name": "Alphabet Inc", "exchange": "NASDAQ", "finnhubIndustry": "Media", "currency": "USD", "logo": logo}
    p = await provider(Recorder([httpx.Response(200, json=body)])).get_profile("GOOGL")
    assert p is not None and p.logo_url == logo
    for bad in ("http://example.com/a.png", "", None, 7, "https://x/" + "a" * 300):
        p = await provider(Recorder([httpx.Response(200, json={**body, "logo": bad})])).get_profile("GOOGL")
        assert p is not None and p.logo_url == ""
    assert await provider(Recorder([httpx.Response(200, json={})])).get_profile("SPY") is None


async def test_candles_parsed_as_split_adjusted_bars():
    # Daily candles are stamped 00:00 UTC of the session date.
    body = {"s": "ok", "t": [1790812800, 1790899200], "o": [1, 2], "h": [2, 3], "l": [0.5, 1.5], "c": [1.5, 2.5], "v": [100, 200]}
    bars = await provider(Recorder([httpx.Response(200, json=body)])).get_daily_bars("X", date(2026, 10, 1), date(2026, 10, 2))
    assert [b.session for b in bars] == [date(2026, 10, 1), date(2026, 10, 2)]
    assert all(b.adjusted and b.source == "finnhub_candle" for b in bars)
    assert bars[1].volume == 200 and bars[1].close == Decimal("2.5")
    assert await provider(Recorder([httpx.Response(200, json={"s": "no_data"})])).get_daily_bars("X", date(2026, 1, 1), date(2026, 1, 2)) == []


async def test_rate_limiter_spaces_calls_after_burst():
    now = [0.0]
    slept: list[float] = []

    async def fake_sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    limiter = RateLimiter(60, burst=2, clock=lambda: now[0], sleep=fake_sleep)
    for _ in range(4):
        await limiter.acquire()
    assert sum(slept) == pytest.approx(2.0)  # two burst tokens, then 1/s


# ---- calendar and quote-derived sessions ----

HOLIDAYS = [Holiday(date(2026, 11, 26), ""), Holiday(date(2026, 11, 27), "09:30-13:00")]
CAL = UsEquityCalendar(HOLIDAYS)


def quote(t: datetime, price="333.69", pc="330.32") -> Quote:
    return Quote("AAPL", Decimal(price), Decimal(pc), Decimal("333.26"), Decimal("334.54"), Decimal("330.61"), t, t, "finnhub")


def test_calendar_sessions_holidays_and_early_close():
    assert not CAL.is_trading_day(date(2026, 10, 3))  # Saturday
    assert not CAL.is_trading_day(date(2026, 11, 26))  # Thanksgiving
    assert CAL.session_close(date(2026, 11, 27)).hour == 13
    assert CAL.previous_trading_day(date(2026, 11, 27)) == date(2026, 11, 25)
    sat = datetime(2026, 10, 3, 17, 0, tzinfo=UTC)
    assert CAL.last_completed_session(sat) == date(2026, 10, 2)
    fri_midday = datetime(2026, 10, 2, 16, 0, tzinfo=UTC)  # 12:00 ET
    assert CAL.last_completed_session(fri_midday) == date(2026, 10, 1)


def test_after_close_quote_yields_previous_and_current_session_closes():
    q = quote(datetime(2026, 10, 2, 20, 0, tzinfo=UTC))  # 16:00 ET Friday
    bars = bars_from_quote(q, datetime(2026, 10, 3, 17, 0, tzinfo=UTC), CAL)
    assert [(b.session, b.close) for b in bars] == [
        (date(2026, 10, 1), Decimal("330.32")),
        (date(2026, 10, 2), Decimal("333.69")),
    ]
    assert all(not b.adjusted and b.volume is None and b.source == "finnhub_quote" for b in bars)


def test_intraday_quote_is_not_a_completed_session():
    q = quote(datetime(2026, 10, 2, 16, 0, tzinfo=UTC))  # 12:00 ET, market open
    bars = bars_from_quote(q, datetime(2026, 10, 2, 16, 1, tzinfo=UTC), CAL)
    assert [b.session for b in bars] == [date(2026, 10, 1)]


def test_quote_checks():
    now = datetime(2026, 10, 3, 17, 0, tzinfo=UTC)
    assert check_quote(quote(datetime(2026, 10, 2, 20, 0, tzinfo=UTC)), now, CAL, False).valid
    assert check_quote(quote(datetime(2026, 10, 2, 20, 0, tzinfo=UTC), price="0"), now, CAL, False).reason == "invalid_price"
    assert check_quote(quote(datetime(2026, 10, 3, 18, 0, tzinfo=UTC)), now, CAL, False).reason == "future_timestamp"
    assert check_quote(quote(datetime(2026, 10, 1, 20, 0, tzinfo=UTC)), now, CAL, False).stale
