"""Alpaca historical-bar adapter against mocked HTTP.

Bodies follow the documented stock-bars shape. Values are FIXTURES.
The live account check is test_alpaca_live.py.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import httpx
import pytest
from pydantic import SecretStr

from app.market.alpaca import (
    AlpacaHistoricalProvider,
    session_safe_for_historical_sip,
)
from app.market.calendar import UsEquityCalendar
from app.market.http import ProviderAccessDenied, RateLimiter
from app.market.ingest import select_signal_bars
from app.market.provider import CapabilityResult, CompanyProfile, DailyBar, Holiday, MarketStatus, Quote
from app.market.routing import RoutedMarketProvider

FRIDAY = datetime(2026, 10, 2, 4, 0, tzinfo=UTC)  # midnight EDT, session 2026-10-02
THURSDAY = datetime(2026, 10, 1, 4, 0, tzinfo=UTC)
SATURDAY = datetime(2026, 10, 3, 18, 0, tzinfo=UTC)


def bar(stamp: datetime, close: str = "100", volume: int = 1000) -> dict[str, object]:
    return {"t": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"), "o": close, "h": close, "l": close, "c": close, "v": volume, "n": 1, "vw": close}


def page(symbol: str, rows: list[dict[str, object]], token: str | None = None) -> httpx.Response:
    return httpx.Response(200, json={"bars": {symbol: rows}, "next_page_token": token})


class Recorder:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        item = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        return item(request) if callable(item) else item


def provider(recorder: Recorder, **kw) -> AlpacaHistoricalProvider:
    clock = FakeClock()
    limiter = RateLimiter(10_000, burst=1000, clock=clock, sleep=clock.sleep)
    return AlpacaHistoricalProvider(
        SecretStr("key-id"),
        SecretStr("key-secret"),
        transport=httpx.MockTransport(recorder),
        limiter=limiter,
        clock=lambda: SATURDAY,
        **kw,
    )


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


def test_session_safe_waits_until_the_close_is_outside_the_sip_window():
    cal = UsEquityCalendar([])
    # Saturday: Friday's close is hours old.
    assert session_safe_for_historical_sip(cal, SATURDAY) == date(2026, 10, 2)
    # Five minutes after the Friday close: that session is not queryable yet.
    just_closed = datetime(2026, 10, 2, 20, 5, tzinfo=UTC)
    assert session_safe_for_historical_sip(cal, just_closed) == date(2026, 10, 1)


def test_data_host_rejects_trading_endpoints():
    with pytest.raises(ValueError):
        AlpacaHistoricalProvider(SecretStr("a"), SecretStr("b"), base_url="https://paper-api.alpaca.markets")
    with pytest.raises(ValueError):
        AlpacaHistoricalProvider(SecretStr("a"), SecretStr("b"), base_url="https://api.alpaca.markets")


async def test_sip_bars_are_split_adjusted_and_dated_in_new_york():
    rec = Recorder(
        [
            page("SPY", [bar(THURSDAY)]),  # capability probe
            page("AAPL", [bar(THURSDAY, "201.70", 100), bar(FRIDAY, "333.69", 3_000_000), bar(datetime(2026, 1, 2, 5, 0, tzinfo=UTC), "90", 50)]),
        ]
    )
    p = provider(rec)
    caps = {c.key: c for c in await p.capabilities()}
    assert caps["alpaca.historical_sip"].available
    assert "feed=sip" in caps["alpaca.historical_bars"].detail
    assert await p.history_source() == "alpaca_sip"
    bars = await p.get_daily_bars("AAPL", date(2026, 1, 1), date(2026, 10, 2))
    assert [b.session.isoformat() for b in bars] == ["2026-01-02", "2026-10-01", "2026-10-02"]
    assert bars[-1].close == Decimal("333.69")
    assert bars[-1].volume == 3_000_000
    assert all(b.adjusted and b.source == "alpaca_sip" for b in bars)
    data_req = rec.requests[-1]
    assert data_req.url.host == "data.alpaca.markets"
    assert data_req.url.params["adjustment"] == "split"
    assert data_req.url.params["feed"] == "sip"
    assert data_req.url.params["timeframe"] == "1Day"
    assert "key-secret" not in str(data_req.url)
    assert data_req.headers["APCA-API-SECRET-KEY"] == "key-secret"
    assert data_req.url.path == "/v2/stocks/bars"
    # Explicit end is the completed session, not "now".
    assert data_req.url.params["end"] < SATURDAY.strftime("%Y-%m-%dT%H:%M:%SZ")


async def test_pagination_follows_next_page_token():
    rec = Recorder(
        [
            page("SPY", [bar(THURSDAY)]),
            page("AAPL", [bar(THURSDAY, "1", 10)], token="next"),
            page("AAPL", [bar(FRIDAY, "2", 20)]),
        ]
    )
    bars = await provider(rec).get_daily_bars("AAPL", date(2026, 9, 1), date(2026, 10, 2))
    assert [b.close for b in bars] == [Decimal("1"), Decimal("2")]
    assert rec.requests[-1].url.params["page_token"] == "next"


async def test_sip_denial_falls_back_to_iex_and_records_the_volume_limit():
    rec = Recorder(
        [
            httpx.Response(422, json={"code": 42210000, "message": "subscription does not permit querying recent SIP data"}),
            page("SPY", [bar(THURSDAY, "1", 10)]),
            page("XLK", [bar(FRIDAY, "199.86", 514_115)]),
        ]
    )
    p = provider(rec)
    caps = {c.key: c for c in await p.capabilities()}
    assert not caps["alpaca.historical_sip"].available
    assert caps["alpaca.historical_bars"].available
    assert "not consolidated" in caps["alpaca.historical_bars"].detail
    assert await p.history_source() == "alpaca_iex"
    bars = await p.get_daily_bars("XLK", date(2026, 9, 1), date(2026, 10, 2))
    assert bars[0].source == "alpaca_iex" and bars[0].volume == 514_115
    assert all(r.url.params["feed"] == "iex" for r in rec.requests[1:])
    assert all(r.url.path == "/v2/stocks/bars" for r in rec.requests)


async def test_recent_session_inside_the_lag_is_dropped():
    rec = Recorder([page("SPY", [bar(THURSDAY)]), page("AAPL", [bar(THURSDAY, "1", 10), bar(FRIDAY, "2", 20)])])
    p = provider(rec)
    p._clock = lambda: datetime(2026, 10, 2, 20, 5, tzinfo=UTC)  # 5 min after the close
    await p.capabilities()
    bars = await p.get_daily_bars("AAPL", date(2026, 9, 1), date(2026, 10, 2))
    assert [b.session for b in bars] == [date(2026, 10, 1)]


async def test_access_denied_is_not_retried():
    rec = Recorder([httpx.Response(403, json={"message": "forbidden"})])
    p = provider(rec, max_retries=3)
    caps = {c.key: c for c in await p.capabilities()}
    assert not caps["alpaca.historical_sip"].available
    assert not caps["alpaca.historical_bars"].available
    assert len(rec.requests) == 2  # SIP denied once, then IEX denied once; 403 is not retried
    with pytest.raises(ProviderAccessDenied):
        await p.get_daily_bars("AAPL", date(2026, 9, 1), date(2026, 10, 2))


def test_signal_bars_do_not_mix_feeds_or_quote_closes():
    day = date(2026, 10, 2)
    earlier = date(2026, 10, 1)
    mixed = {
        earlier: DailyBar("AAPL", earlier, Decimal("1"), None, None, None, 10, False, "finnhub_quote"),
        day: DailyBar("AAPL", day, Decimal("2"), Decimal("2"), Decimal("2"), Decimal("2"), 20, True, "alpaca_sip"),
    }
    selected = select_signal_bars(mixed, "alpaca_sip")
    assert [b.source for b in selected] == ["alpaca_sip"]
    iex = dict(mixed)
    iex[earlier] = DailyBar("AAPL", earlier, Decimal("1"), Decimal("1"), Decimal("1"), Decimal("1"), 5, True, "alpaca_iex")
    assert {b.source for b in select_signal_bars(iex, "alpaca_sip")} == {"alpaca_sip"}
    assert {b.source for b in select_signal_bars(iex, "alpaca_iex")} == {"alpaca_iex"}
    quotes_only = select_signal_bars(mixed, None)
    assert [b.source for b in quotes_only] == ["finnhub_quote"]


class _Quotes:
    name = "finnhub"

    def __init__(self) -> None:
        self.quote_calls = 0
        self.bar_calls = 0

    async def capabilities(self) -> list[CapabilityResult]:
        return [
            CapabilityResult("finnhub.quote", "Latest quote", True, "ok", "finnhub"),
            CapabilityResult("finnhub.daily_candles", "Daily candles", False, "HTTP 403", "finnhub"),
        ]

    async def has(self, key: str) -> bool:
        return key == "quote"

    async def history_source(self) -> str | None:
        return None

    async def get_quote(self, ticker: str) -> Quote:
        self.quote_calls += 1
        return Quote(ticker, Decimal("1"), Decimal("1"), Decimal("1"), Decimal("1"), Decimal("1"), SATURDAY, SATURDAY, "finnhub")

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        self.bar_calls += 1
        return [DailyBar(ticker, end, Decimal("9"), None, None, None, None, False, "finnhub_quote")]

    async def get_profile(self, ticker: str) -> CompanyProfile | None:
        return None

    async def get_market_status(self) -> MarketStatus:
        return MarketStatus("US", False, "closed", None, SATURDAY)

    async def get_holidays(self) -> list[Holiday]:
        return []

    async def aclose(self) -> None:
        return None


class _History:
    def __init__(self) -> None:
        self.calls = 0

    async def capabilities(self) -> list[CapabilityResult]:
        return [CapabilityResult("alpaca.historical_bars", "Daily bars", True, "feed=sip", "alpaca")]

    async def history_source(self) -> str | None:
        return "alpaca_sip"

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        self.calls += 1
        return [DailyBar(ticker, end, Decimal("3"), Decimal("3"), Decimal("3"), Decimal("3"), 100, True, "alpaca_sip")]

    async def aclose(self) -> None:
        return None


async def test_router_keeps_finnhub_quotes_and_alpaca_history():
    quotes, history = _Quotes(), _History()
    routed = RoutedMarketProvider(quotes, history)
    caps = await routed.capabilities()
    assert routed.name == "finnhub+alpaca"
    assert {c.provider for c in caps} == {"finnhub", "alpaca"}
    await routed.get_quote("AAPL")
    bars = await routed.get_daily_bars("AAPL", date(2026, 9, 1), date(2026, 10, 2))
    assert quotes.quote_calls == 1 and quotes.bar_calls == 0
    assert history.calls == 1 and bars[0].source == "alpaca_sip"
    assert await routed.history_source() == "alpaca_sip"


async def test_january_bar_uses_the_new_york_date():
    # EST midnight is 05:00 UTC. The session date must not slip to the previous UTC date.
    stamp = datetime(2026, 1, 2, 5, 0, tzinfo=UTC)
    rec = Recorder([page("SPY", [bar(stamp)]), page("SPY", [bar(stamp, "400", 1_000_000)])])
    # Clock must be after that session's close plus the lag, or the bar is dropped.
    p = provider(rec)
    p._clock = lambda: datetime(2026, 1, 5, 18, 0, tzinfo=UTC)
    bars = await p.get_daily_bars("SPY", date(2026, 1, 1), date(2026, 1, 2))
    assert [b.session for b in bars] == [date(2026, 1, 2)]
