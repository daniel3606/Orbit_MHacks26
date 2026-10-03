"""Market-data provider interface (PRD §10, §20).

Implementations report capabilities from what the configured account can
actually access; unavailable data is absent, never synthesized. Prices are
`Decimal`; times are timezone-aware UTC. News methods arrive with the news
intelligence phase.
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class CapabilityResult:
    key: str  # e.g. "finnhub.daily_candles"
    capability: str
    available: bool
    detail: str
    provider: str = ""


@dataclass(frozen=True)
class Quote:
    ticker: str
    price: Decimal
    previous_close: Decimal
    open: Decimal
    high: Decimal
    low: Decimal
    provider_time: datetime  # provider's last-trade/data timestamp
    ingested_at: datetime
    source: str


@dataclass(frozen=True)
class DailyBar:
    """One completed session. OHLC/volume are None when the source lacks them."""

    ticker: str
    session: date
    close: Decimal
    open: Decimal | None
    high: Decimal | None
    low: Decimal | None
    volume: int | None
    adjusted: bool  # split-adjusted prices and volume; not dividend-adjusted
    source: str  # "finnhub_candle" | "finnhub_quote" | "alpaca_sip" | "alpaca_iex" | "fixture"


@dataclass(frozen=True)
class MarketStatus:
    exchange: str
    is_open: bool
    session: str  # "pre-market" | "regular" | "post-market" | "closed"
    holiday: str | None
    as_of: datetime


@dataclass(frozen=True)
class Holiday:
    day: date
    trading_hours: str  # "" = closed all day; "09:30-13:00" = early close


@dataclass(frozen=True)
class CompanyProfile:
    ticker: str
    name: str
    exchange: str
    industry: str
    currency: str


class MarketDataProvider(Protocol):
    name: str

    async def capabilities(self) -> list[CapabilityResult]: ...
    async def get_quote(self, ticker: str) -> Quote: ...
    async def get_daily_bars(self, ticker: str, start: date, end: date) -> list[DailyBar]: ...
    async def get_profile(self, ticker: str) -> CompanyProfile | None: ...
    async def get_market_status(self) -> MarketStatus: ...
    async def get_holidays(self) -> list[Holiday]: ...
