"""Paper trading provider interface (PRD §17). Alpaca Paper adapter: Phase 5.

The provider is authoritative for orders, fills, cash and positions. Money and
quantities use Decimal. `submit_order` must be idempotent on
`client_order_id`; after a timeout callers use `find_order` before retrying.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

OrderStatus = Literal[
    "submitted", "partially_filled", "filled", "rejected", "canceled", "unknown"
]


@dataclass(frozen=True)
class PaperAccount:
    provider_account_id: str
    cash: Decimal
    buying_power: Decimal
    currency: str


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


@dataclass(frozen=True)
class PaperPosition:
    ticker: str
    quantity: Decimal
    avg_entry_price: Decimal


class PaperTradingProvider(Protocol):
    async def get_account(self) -> PaperAccount: ...
    async def is_asset_supported(self, ticker: str) -> tuple[bool, bool]:
        """(tradable, fractionable)"""
        ...
    async def submit_order(
        self, *, client_order_id: str, ticker: str, side: Literal["buy", "sell"],
        quantity: Decimal | None, notional: Decimal | None,
    ) -> PaperOrder: ...
    async def find_order(self, client_order_id: str) -> PaperOrder | None: ...
    async def list_positions(self) -> list[PaperPosition]: ...
