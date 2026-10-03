"""Market-data provider interface (PRD §10, §20). Finnhub adapter: Phase 2.

Implementations must report capabilities honestly; unavailable fields are
`None`/absent, never synthesized.
"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol


@dataclass(frozen=True)
class ProviderCapabilities:
    quotes: bool
    daily_history: bool
    adjusted_history: bool
    company_news: bool
    market_news: bool
    benchmarks: tuple[str, ...]


@dataclass(frozen=True)
class Quote:
    ticker: str
    price: Decimal
    provider_time: datetime
    ingested_at: datetime
    source: str


@dataclass(frozen=True)
class DailyBar:
    ticker: str
    session_date: date
    close: Decimal
    volume: int
    adjusted: bool


@dataclass(frozen=True)
class NewsItem:
    article_id: str
    ticker: str | None
    headline: str
    summary: str | None
    source: str
    url: str
    published_at: datetime


class MarketDataProvider(Protocol):
    name: str

    async def capabilities(self) -> ProviderCapabilities: ...
    async def get_quote(self, ticker: str) -> Quote: ...
    async def get_price_history(self, ticker: str, start: date, end: date) -> list[DailyBar]: ...
    async def get_company_news(self, ticker: str, start: date, end: date) -> list[NewsItem]: ...
    async def get_market_news(self) -> list[NewsItem]: ...
