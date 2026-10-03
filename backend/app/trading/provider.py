"""Paper trading provider interface (PRD §17).

Alpaca Paper is authoritative for orders, fills, cash, and positions. Money and
quantities use Decimal. ``submit_order`` is idempotent on ``client_order_id``:
after a timeout, callers look the order up before sending it again.
"""

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Literal, Protocol

OrderStatus = Literal[
    "submitted",
    "pending",
    "partially_filled",
    "filled",
    "rejected",
    "canceled",
    "reconciling",
]


class PaperTimeout(Exception):
    """The broker did not answer in time. The order may or may not exist."""


class PaperRejected(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class PaperAccount:
    provider_account_id: str
    cash: Decimal
    equity: Decimal
    buying_power: Decimal
    currency: str


@dataclass(frozen=True)
class PaperClock:
    is_open: bool
    timestamp: datetime
    next_open: datetime | None
    next_close: datetime | None


@dataclass(frozen=True)
class PaperOrder:
    client_order_id: str
    provider_order_id: str
    ticker: str
    side: Literal["buy", "sell"]
    quantity: Decimal | None
    notional: Decimal | None
    status: OrderStatus
    filled_quantity: Decimal
    filled_avg_price: Decimal | None
    reject_reason: str | None = None


@dataclass(frozen=True)
class PaperPosition:
    ticker: str
    quantity: Decimal
    avg_entry_price: Decimal
    market_value: Decimal | None = None
    unrealized_pl: Decimal | None = None


class PaperTradingProvider(Protocol):
    async def get_account(self) -> PaperAccount: ...

    async def get_clock(self) -> PaperClock: ...

    async def is_asset_supported(self, ticker: str) -> tuple[bool, bool]:
        """(tradable, fractionable). Must not submit an order."""
        ...

    async def submit_order(
        self,
        *,
        client_order_id: str,
        ticker: str,
        side: Literal["buy", "sell"],
        quantity: Decimal | None,
        notional: Decimal | None,
    ) -> PaperOrder: ...

    async def find_order(self, client_order_id: str) -> PaperOrder | None: ...

    async def list_positions(self) -> list[PaperPosition]: ...

    async def list_orders(self) -> list[PaperOrder]: ...

    async def aclose(self) -> None: ...
