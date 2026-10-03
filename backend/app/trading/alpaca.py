"""Alpaca paper trading adapter.

Host is locked to ``paper-api.alpaca.markets``. Market-data credentials are
not used here, and this client never calls ``api.alpaca.markets``. Capability
checks are GET account, clock, and asset only.
"""

import logging
from datetime import datetime
from decimal import Decimal
from typing import Any, Literal
from urllib.parse import urlparse

import httpx
from pydantic import SecretStr

from app.config.settings import ALPACA_PAPER_URL
from app.trading.money import parse_decimal
from app.trading.provider import (
    PaperAccount,
    PaperClock,
    PaperOrder,
    PaperPosition,
    PaperRejected,
    PaperTimeout,
)
from app.trading.status import map_status

log = logging.getLogger(__name__)


def _decimal(raw: Any, default: str = "0") -> Decimal:
    parsed = parse_decimal(str(raw) if raw is not None else default)
    if parsed is None:
        raise PaperRejected("invalid_money")
    return parsed


def _optional_decimal(raw: Any) -> Decimal | None:
    if raw is None or raw == "":
        return None
    return _decimal(raw)


def _when(raw: str | None) -> datetime | None:
    if not raw:
        return None
    return datetime.fromisoformat(raw.replace("Z", "+00:00"))


class AlpacaPaperProvider:
    def __init__(
        self,
        key_id: SecretStr,
        secret: SecretStr,
        *,
        base_url: str = ALPACA_PAPER_URL,
        transport: httpx.AsyncBaseTransport | None = None,
        timeout: float = 20.0,
    ):
        host = urlparse(base_url).hostname
        if host != "paper-api.alpaca.markets":
            raise ValueError("Only the Alpaca paper endpoint is allowed")
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={
                "APCA-API-KEY-ID": key_id.get_secret_value(),
                "APCA-API-SECRET-KEY": secret.get_secret_value(),
            },
            timeout=timeout,
            transport=transport,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        try:
            response = await self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise PaperTimeout() from exc
        except httpx.TransportError as exc:
            raise PaperTimeout() from exc
        return response

    async def get_account(self) -> PaperAccount:
        response = await self._request("GET", "/v2/account")
        self._raise(response)
        body = response.json()
        return PaperAccount(
            provider_account_id=str(body["id"]),
            cash=_decimal(body.get("cash")),
            equity=_decimal(body.get("equity")),
            buying_power=_decimal(body.get("buying_power")),
            currency=str(body.get("currency") or "USD"),
        )

    async def get_clock(self) -> PaperClock:
        response = await self._request("GET", "/v2/clock")
        self._raise(response)
        body = response.json()
        stamped = _when(body.get("timestamp"))
        if stamped is None:
            raise PaperRejected("invalid_clock")
        return PaperClock(
            is_open=bool(body.get("is_open")),
            timestamp=stamped,
            next_open=_when(body.get("next_open")),
            next_close=_when(body.get("next_close")),
        )

    async def is_asset_supported(self, ticker: str) -> tuple[bool, bool]:
        response = await self._request("GET", f"/v2/assets/{ticker}")
        if response.status_code == 404:
            return False, False
        self._raise(response)
        body = response.json()
        tradable = bool(body.get("tradable")) and body.get("status") == "active" and body.get("class") == "us_equity"
        return tradable, bool(body.get("fractionable"))

    async def submit_order(
        self,
        *,
        client_order_id: str,
        ticker: str,
        side: Literal["buy", "sell"],
        quantity: Decimal | None,
        notional: Decimal | None,
    ) -> PaperOrder:
        existing = await self.find_order(client_order_id)
        if existing is not None:
            return existing
        payload: dict[str, str] = {
            "symbol": ticker,
            "side": side,
            "type": "market",
            "time_in_force": "day",
            "client_order_id": client_order_id,
        }
        if quantity is not None:
            payload["qty"] = format(quantity, "f")
        elif notional is not None:
            payload["notional"] = format(notional, "f")
        else:
            raise PaperRejected("invalid_order_amount")
        response = await self._request("POST", "/v2/orders", json=payload)
        if response.status_code in (403, 409, 422):
            found = await self.find_order(client_order_id)
            if found is not None:
                return found
            raise PaperRejected(_reason(response))
        if response.status_code >= 500:
            raise PaperTimeout()
        self._raise(response)
        return _order(response.json())

    async def find_order(self, client_order_id: str) -> PaperOrder | None:
        response = await self._request(
            "GET",
            "/v2/orders:by_client_order_id",
            params={"client_order_id": client_order_id},
        )
        if response.status_code == 404:
            return None
        if response.status_code >= 500:
            raise PaperTimeout()
        self._raise(response)
        return _order(response.json())

    async def list_positions(self) -> list[PaperPosition]:
        response = await self._request("GET", "/v2/positions")
        self._raise(response)
        rows = response.json()
        out: list[PaperPosition] = []
        for row in rows:
            qty = _decimal(row.get("qty"))
            if qty <= 0:
                continue  # long-only; shorts are not imported
            out.append(
                PaperPosition(
                    ticker=str(row["symbol"]),
                    quantity=qty,
                    avg_entry_price=_decimal(row.get("avg_entry_price")),
                    market_value=_optional_decimal(row.get("market_value")),
                    unrealized_pl=_optional_decimal(row.get("unrealized_pl")),
                )
            )
        return out

    async def list_orders(self) -> list[PaperOrder]:
        response = await self._request("GET", "/v2/orders", params={"status": "all", "limit": 50, "direction": "desc"})
        self._raise(response)
        return [_order(row) for row in response.json()]

    @staticmethod
    def _raise(response: httpx.Response) -> None:
        if response.status_code < 300:
            return
        log.warning("alpaca paper HTTP %s", response.status_code)
        if response.status_code in (401, 403):
            raise PaperRejected("broker_unauthorized")
        if response.status_code == 429 or response.status_code >= 500:
            raise PaperTimeout()
        raise PaperRejected(_reason(response))


def _reason(response: httpx.Response) -> str:
    try:
        message = str(response.json().get("message", "")).lower()
    except Exception:
        message = ""
    if "insufficient" in message or "buying power" in message:
        return "insufficient_cash"
    if "not tradable" in message or "asset" in message and "not active" in message:
        return "not_tradable"
    if "client_order_id" in message:
        return "duplicate_client_order"
    return "broker_rejected"


def _order(body: dict[str, Any]) -> PaperOrder:
    qty = _optional_decimal(body.get("qty"))
    filled = _decimal(body.get("filled_qty") or "0")
    side = body.get("side")
    if side not in ("buy", "sell"):
        raise PaperRejected("invalid_side")
    return PaperOrder(
        client_order_id=str(body.get("client_order_id") or ""),
        provider_order_id=str(body.get("id") or ""),
        ticker=str(body.get("symbol") or ""),
        side=side,
        quantity=qty,
        notional=_optional_decimal(body.get("notional")),
        status=map_status(str(body.get("status") or ""), filled_quantity=filled, ordered_quantity=qty),
        filled_quantity=filled,
        filled_avg_price=_optional_decimal(body.get("filled_avg_price")),
        reject_reason=None,
    )
