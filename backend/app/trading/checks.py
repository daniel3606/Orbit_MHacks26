"""Local order checks. These run before any broker call.

Buys are limited to cash. Alpaca paper buying power can include margin;
Orbit does not use it. Sells cannot exceed the long position.
"""

from dataclasses import dataclass
from decimal import Decimal

from app.trading.provider import PaperAccount, PaperPosition


class LocalReject(Exception):
    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class OrderIntent:
    ticker: str
    side: str
    quantity: Decimal | None
    notional: Decimal | None
    quote: Decimal


def estimate_buy_cost(intent: OrderIntent) -> Decimal:
    if intent.notional is not None:
        return intent.notional
    if intent.quantity is None:
        raise LocalReject("invalid_order_amount")
    return intent.quantity * intent.quote


def check_order(
    intent: OrderIntent,
    account: PaperAccount,
    positions: list[PaperPosition],
    *,
    tradable: bool,
    fractionable: bool,
) -> None:
    if intent.side not in ("buy", "sell"):
        raise LocalReject("invalid_side")
    if (intent.quantity is None) == (intent.notional is None):
        raise LocalReject("invalid_order_amount")
    amount = intent.quantity if intent.quantity is not None else intent.notional
    if amount is None or amount <= 0 or intent.quote <= 0:
        raise LocalReject("invalid_order_amount")
    if not tradable:
        raise LocalReject("not_tradable")
    fractional = intent.quantity is not None and intent.quantity != intent.quantity.to_integral_value()
    if intent.notional is not None and not fractionable:
        raise LocalReject("notional_not_supported")
    if fractional and not fractionable:
        raise LocalReject("whole_shares_only")

    held = next((row.quantity for row in positions if row.ticker == intent.ticker), Decimal(0))
    if intent.side == "buy":
        if estimate_buy_cost(intent) > account.cash:
            raise LocalReject("insufficient_cash")
        return
    if intent.quantity is not None and intent.quantity > held:
        raise LocalReject("insufficient_shares")
    if intent.notional is not None and intent.notional > held * intent.quote:
        raise LocalReject("insufficient_shares")
