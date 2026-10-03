"""Map Alpaca order statuses onto Orbit states.

An accepted or working order is never a fill. ``done_for_day`` closes the
order: a full fill stays filled, anything else is canceled with the filled
quantity kept.
"""

from decimal import Decimal

from app.trading.provider import OrderStatus

_PENDING = {
    "new",
    "accepted",
    "pending_new",
    "accepted_for_bidding",
    "held",
    "calculated",
    "pending_cancel",
    "pending_replace",
    "pending_review",
}
_CANCELED = {"canceled", "cancelled", "expired", "replaced", "stopped", "done_for_day"}


def map_status(raw: str, *, filled_quantity: Decimal, ordered_quantity: Decimal | None) -> OrderStatus:
    status = raw.strip().lower()
    if status in _PENDING:
        return "pending"
    if status == "partially_filled":
        return "partially_filled"
    if status == "filled":
        return "filled"
    if status in {"rejected", "suspended"}:
        return "rejected"
    if status in _CANCELED:
        if status == "done_for_day" and ordered_quantity is not None and filled_quantity >= ordered_quantity > 0:
            return "filled"
        return "canceled"
    if status == "":
        return "submitted"
    return "reconciling"
