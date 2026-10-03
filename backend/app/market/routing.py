"""Routes market capabilities to the provider that can actually serve them.

Finnhub keeps quotes, company profiles, exchange status and holidays.
Alpaca Market Data, when the account can read it, is the only source of
daily bars. Finnhub quote closes are not spliced into that history.
"""

from datetime import date
from typing import Protocol

from app.market.provider import (
    CapabilityResult,
    CompanyProfile,
    DailyBar,
    Holiday,
    MarketStatus,
    Quote,
)


class _Quotes(Protocol):
    name: str

    async def capabilities(self) -> list[CapabilityResult]: ...
    async def has(self, key: str) -> bool: ...
    async def history_source(self) -> str | None: ...
    async def get_quote(self, ticker: str) -> Quote: ...
    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]: ...
    async def get_profile(self, ticker: str) -> CompanyProfile | None: ...
    async def get_market_status(self) -> MarketStatus: ...
    async def get_holidays(self) -> list[Holiday]: ...
    async def aclose(self) -> None: ...


class _History(Protocol):
    async def capabilities(self) -> list[CapabilityResult]: ...
    async def history_source(self) -> str | None: ...
    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]: ...
    async def aclose(self) -> None: ...


class RoutedMarketProvider:
    def __init__(self, quotes: _Quotes, history: _History | None = None):
        self._quotes = quotes
        self._history = history
        self._name = quotes.name
        self._active: str | None = None
        self._loaded = False

    @property
    def name(self) -> str:
        return self._name

    async def aclose(self) -> None:
        await self._quotes.aclose()
        if self._history is not None:
            await self._history.aclose()

    async def capabilities(self) -> list[CapabilityResult]:
        caps = list(await self._quotes.capabilities())
        active = await self._quotes.history_source()
        if self._history is not None:
            caps.extend(await self._history.capabilities())
            historical = await self._history.history_source()
            if historical is not None:
                active = historical
        self._active = active
        self._loaded = True
        self._name = f"{self._quotes.name}+alpaca" if active and active.startswith("alpaca_") else self._quotes.name
        return caps

    async def history_source(self) -> str | None:
        if not self._loaded:
            await self.capabilities()
        return self._active

    async def has(self, key: str) -> bool:
        if key == "daily_candles":
            return await self.history_source() is not None
        return await self._quotes.has(key)

    async def get_quote(self, ticker: str) -> Quote:
        return await self._quotes.get_quote(ticker)

    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]:
        source = await self.history_source()
        if self._history is not None and source is not None and source.startswith("alpaca_"):
            return await self._history.get_daily_bars(ticker, start, end)
        return await self._quotes.get_daily_bars(ticker, start, end)

    async def get_profile(self, ticker: str) -> CompanyProfile | None:
        return await self._quotes.get_profile(ticker)

    async def get_market_status(self) -> MarketStatus:
        return await self._quotes.get_market_status()

    async def get_holidays(self) -> list[Holiday]:
        return await self._quotes.get_holidays()
