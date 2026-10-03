"""DEVELOPMENT/TEST-ONLY fixture provider.

Generates deterministic synthetic sessions so the full calculation and
publication path can be exercised without a provider plan that includes
history. Everything it returns is labeled `source="fixture"`, and the
SpacetimeDB module rejects fixture rows unless an admin has enabled
`allow_fixture_data` (test databases only). Never use for live data.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from app.config.universe import Universe
from app.market.calendar import UsEquityCalendar
from app.market.provider import CapabilityResult, CompanyProfile, DailyBar, Holiday, MarketStatus, Quote

FIXTURE_SESSIONS = 120


class FixtureProvider:
    name = "fixture"

    def __init__(self, universe: Universe, now: datetime | None = None, seed: int = 7):
        self._universe = universe
        self._now = now or datetime.now(UTC)
        self._cal = UsEquityCalendar([])
        last = self._cal.last_completed_session(self._now)
        sessions = self._cal.sessions_between(last - timedelta(days=FIXTURE_SESSIONS * 2), last)[-FIXTURE_SESSIONS:]
        self._bars: dict[str, list[DailyBar]] = {}
        for i, ticker in enumerate(universe.all_tickers):
            state, price, bars = seed * 1000 + i, Decimal("100"), []
            for d in sessions:
                state = (1103515245 * state + 12345) % 2**31
                move = Decimal(state % 3001 - 1500) / Decimal(100_000)  # ±1.5%
                price = (price * (1 + move)).quantize(Decimal("0.0001"))
                state = (1103515245 * state + 12345) % 2**31
                volume = 500_000 + state % 1_000_000
                bars.append(DailyBar(ticker, d, price, None, None, None, volume, True, "fixture"))
            self._bars[ticker] = bars

    async def capabilities(self) -> list[CapabilityResult]:
        return [
            CapabilityResult("fixture.quote", "Latest quote with timestamp", True, "Synthetic test fixture", "fixture"),
            CapabilityResult("fixture.daily_candles", "Daily historical OHLCV", True, "Synthetic test fixture", "fixture"),
        ]

    async def has(self, key: str) -> bool:
        return key in ("quote", "daily_candles")

    async def history_source(self) -> str | None:
        return "fixture"

    async def get_quote(self, ticker: str) -> Quote:
        bars = self._bars[ticker]
        last = bars[-1]
        close_time = self._cal.session_close(last.session).astimezone(UTC)
        return Quote(ticker, last.close, bars[-2].close, last.close, last.close, last.close, close_time, self._now, "fixture")

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        return [b for b in self._bars[ticker] if start <= b.session <= end]

    async def get_profile(self, ticker: str) -> CompanyProfile | None:
        return CompanyProfile(ticker, f"{ticker} (fixture)", "FIXTURE", "Fixture", "USD")

    async def get_market_status(self) -> MarketStatus:
        return MarketStatus("US", False, "closed", None, self._now)

    async def get_holidays(self) -> list[Holiday]:
        return []

