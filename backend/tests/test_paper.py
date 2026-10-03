"""Paper execution edge cases. The broker is a fixture; these tests never call Alpaca."""

from datetime import UTC, datetime
from decimal import Decimal
from typing import Literal

import httpx
import pytest
from pydantic import SecretStr, ValidationError

from app.config.settings import Settings
from app.state.dto import JobV1, PaperAccountV1, PaperOrderV1
from app.state.gateway import ReducerRejected
from app.trading.alpaca import AlpacaPaperProvider
from app.trading.checks import LocalReject, OrderIntent, check_order
from app.trading.execute import ReconcilePaperAccountHandler, SubmitPaperOrderHandler
from app.trading.money import from_micros, to_micros
from app.trading.provider import (
    PaperAccount,
    PaperClock,
    PaperOrder,
    PaperPosition,
    PaperRejected,
    PaperTimeout,
)
from app.trading.status import map_status
from app.workers.runner import JobFailure

DEMO = "ab" * 32
NOW = datetime(2026, 10, 3, 19, 0, tzinfo=UTC)


def test_micros_round_trip():
    assert to_micros(Decimal("100000.50")) == 100_000_500_000
    assert from_micros(100_000_500_000) == Decimal("100000.50")


def test_accepted_status_is_not_a_fill():
    assert map_status("accepted", filled_quantity=Decimal(0), ordered_quantity=Decimal(1)) == "pending"
    assert map_status("new", filled_quantity=Decimal(0), ordered_quantity=Decimal(1)) == "pending"
    assert map_status("partially_filled", filled_quantity=Decimal("0.4"), ordered_quantity=Decimal(1)) == "partially_filled"
    assert map_status("filled", filled_quantity=Decimal(1), ordered_quantity=Decimal(1)) == "filled"
    assert map_status("rejected", filled_quantity=Decimal(0), ordered_quantity=Decimal(1)) == "rejected"
    assert map_status("canceled", filled_quantity=Decimal(0), ordered_quantity=Decimal(1)) == "canceled"
    assert map_status("mystery", filled_quantity=Decimal(0), ordered_quantity=Decimal(1)) == "reconciling"


def test_cash_and_shares_limits_ignore_margin_buying_power():
    account = PaperAccount("acct", Decimal("100000"), Decimal("100000"), Decimal("400000"), "USD")
    positions = [PaperPosition("CAT", Decimal(2), Decimal(100))]
    buy = OrderIntent("CAT", "buy", Decimal(1), None, Decimal(150))
    check_order(buy, account, positions, tradable=True, fractionable=True)
    too_big = OrderIntent("CAT", "buy", None, Decimal("100000.01"), Decimal(150))
    with pytest.raises(LocalReject) as cash:
        check_order(too_big, account, positions, tradable=True, fractionable=True)
    assert cash.value.reason == "insufficient_cash"
    with pytest.raises(LocalReject) as shares:
        check_order(
            OrderIntent("CAT", "sell", Decimal(3), None, Decimal(150)),
            account,
            positions,
            tradable=True,
            fractionable=True,
        )
    assert shares.value.reason == "insufficient_shares"
    with pytest.raises(LocalReject) as whole:
        check_order(
            OrderIntent("CAT", "buy", Decimal("1.5"), None, Decimal(10)),
            account,
            [],
            tradable=True,
            fractionable=False,
        )
    assert whole.value.reason == "whole_shares_only"


def test_live_trading_host_is_refused():
    with pytest.raises(ValueError):
        AlpacaPaperProvider(SecretStr("k"), SecretStr("s"), base_url="https://api.alpaca.markets")


def test_demo_identity_must_be_hex():
    with pytest.raises(ValidationError):
        Settings(paper_demo_identity="first-user", _env_file=None)


class Scripted:
    def __init__(self) -> None:
        self.posts = 0
        self.account = PaperAccount("acct-1", Decimal("100000"), Decimal("100000"), Decimal("400000"), "USD")
        self.clock = PaperClock(False, NOW, datetime(2026, 10, 5, 13, 30, tzinfo=UTC), None)
        self.positions: list[PaperPosition] = []
        self.tradable = True
        self.fractionable = True
        self.known: dict[str, PaperOrder] = {}
        self.timeouts_left = 0
        self.create_on_timeout = False
        self.reject: str | None = None

    async def get_account(self) -> PaperAccount:
        return self.account

    async def get_clock(self) -> PaperClock:
        return self.clock

    async def is_asset_supported(self, ticker: str) -> tuple[bool, bool]:
        del ticker
        return self.tradable, self.fractionable

    async def find_order(self, client_order_id: str) -> PaperOrder | None:
        return self.known.get(client_order_id)

    async def submit_order(
        self,
        *,
        client_order_id: str,
        ticker: str,
        side: Literal["buy", "sell"],
        quantity: Decimal | None,
        notional: Decimal | None,
    ) -> PaperOrder:
        existing = self.known.get(client_order_id)
        if existing:
            return existing
        self.posts += 1
        if self.timeouts_left:
            self.timeouts_left -= 1
            if self.create_on_timeout:
                self.known[client_order_id] = _broker(client_order_id, ticker, side, "pending", Decimal(0))
            raise PaperTimeout()
        if self.reject:
            raise PaperRejected(self.reject)
        order = _broker(
            client_order_id,
            ticker,
            side,
            "partially_filled" if quantity == Decimal("0.4") else "pending",
            Decimal("0.2") if quantity == Decimal("0.4") else Decimal(0),
        )
        if quantity == Decimal("0.4"):
            order = PaperOrder(
                client_order_id, "broker-1", ticker, side, quantity, notional,
                "partially_filled", Decimal("0.2"), Decimal(10), None,
            )
        self.known[client_order_id] = order
        return order

    async def list_positions(self) -> list[PaperPosition]:
        return list(self.positions)

    async def list_orders(self) -> list[PaperOrder]:
        return list(self.known.values())

    async def aclose(self) -> None:
        return None


def _broker(
    key: str, ticker: str, side: Literal["buy", "sell"], status: Literal["pending"], filled: Decimal
) -> PaperOrder:
    return PaperOrder(key, "broker-1", ticker, side, Decimal(1), None, status, filled, None, None)


class Store:
    def __init__(self, order: PaperOrderV1, account: PaperAccountV1 | None = None) -> None:
        self.order = order
        self.account = account
        self.snapshots: list[list[object]] = []
        self.stale = False

    async def worker_paper_orders(self) -> list[PaperOrderV1]:
        return [self.order]

    async def worker_paper_account(self) -> PaperAccountV1 | None:
        return self.account

    async def apply_paper_snapshot(self, args: list[object]) -> None:
        if self.stale:
            raise ReducerRejected("apply_paper_snapshot", "stale_revision")
        self.snapshots.append(args)
        self.account = PaperAccountV1(
            owner=DEMO,
            provider_account_id=str(args[3]),
            cash_micros=int(args[4]),  # type: ignore[arg-type]
            equity_micros=int(args[5]),  # type: ignore[arg-type]
            buying_power_micros=int(args[6]),  # type: ignore[arg-type]
            currency=str(args[7]),
            revision=int(args[2]),  # type: ignore[arg-type]
            provider_time=NOW,
            synced_at=NOW,
            market_open=bool(args[9]),
            next_open=NOW,
            next_close=None,
        )


def _job(attempt: int = 1, owner: str = DEMO) -> JobV1:
    return JobV1(
        job_id=7,
        owner=owner,
        kind="submit_paper_order",
        request_key="orbit-abcdefgh",
        input_version=0,
        status="running",
        attempt_count=attempt,
        max_attempts=2,
        lease_owner="cd" * 32,
        lease_until=NOW,
        available_at=NOW,
        payload="{}",
        result_ref=None,
        error_code=None,
        created_at=NOW,
        updated_at=NOW,
    )


def _order(**overrides: object) -> PaperOrderV1:
    base: dict[str, object] = dict(
        order_id=1,
        owner=DEMO,
        client_order_key="orbit-abcdefgh",
        ticker="CAT",
        side="buy",
        quantity_micros=1_000_000,
        notional_micros=None,
        quote_micros=150_000_000,
        quote_time=NOW,
        status="queued",
        provider_order_id=None,
        filled_quantity_micros=0,
        filled_avg_price_micros=None,
        reject_reason=None,
        revision=0,
        created_at=NOW,
        updated_at=NOW,
    )
    base.update(overrides)
    return PaperOrderV1.model_validate(base)


async def test_insufficient_cash_does_not_submit():
    broker = Scripted()
    store = Store(_order(notional_micros=200_000_000_000, quantity_micros=None))
    handler = SubmitPaperOrderHandler(broker, demo_identity=DEMO)
    result = await handler.run(_job(), store)  # type: ignore[arg-type]
    assert result.result_ref == "rejected:insufficient_cash"
    assert broker.posts == 0
    assert store.snapshots[0][13][0]["status"] == "rejected"  # type: ignore[index]


async def test_duplicate_client_id_does_not_post_again():
    broker = Scripted()
    broker.known["orbit-abcdefgh"] = _broker("orbit-abcdefgh", "CAT", "buy", "pending", Decimal(0))
    store = Store(_order())
    await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(_job(), store)  # type: ignore[arg-type]
    assert broker.posts == 0
    assert store.snapshots[0][13][0]["status"] == "pending"  # type: ignore[index]


async def test_timeout_is_reconciled_with_the_same_order_before_retry():
    broker = Scripted()
    broker.timeouts_left = 1
    broker.create_on_timeout = True
    store = Store(_order())
    result = await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(_job(), store)  # type: ignore[arg-type]
    assert broker.posts == 1
    assert result.result_ref == "pending"
    assert store.snapshots[0][13][0]["client_order_key"] == "orbit-abcdefgh"  # type: ignore[index]


async def test_timeout_without_an_order_retries_then_records_reconciling():
    broker = Scripted()
    broker.timeouts_left = 5
    store = Store(_order())
    handler = SubmitPaperOrderHandler(broker, demo_identity=DEMO)
    with pytest.raises(JobFailure) as first:
        await handler.run(_job(attempt=1), store)  # type: ignore[arg-type]
    assert first.value.retryable is True
    assert broker.posts == 1
    result = await handler.run(_job(attempt=2), store)  # type: ignore[arg-type]
    assert result.result_ref == "reconciling"
    assert broker.posts == 2  # second attempt looks up, misses, posts once more, still times out
    assert store.snapshots[0][13][0]["status"] == "reconciling"  # type: ignore[index]


async def test_restart_finds_the_order_created_before_the_crash():
    broker = Scripted()
    broker.timeouts_left = 1
    broker.create_on_timeout = True
    store = Store(_order())
    handler = SubmitPaperOrderHandler(broker, demo_identity=DEMO)
    await handler.run(_job(attempt=1), store)  # type: ignore[arg-type]
    posts = broker.posts
    await handler.run(_job(attempt=2), store)  # type: ignore[arg-type]
    assert broker.posts == posts


async def test_broker_rejection_and_partial_fill():
    broker = Scripted()
    broker.reject = "broker_rejected"
    store = Store(_order())
    await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(_job(), store)  # type: ignore[arg-type]
    assert store.snapshots[0][13][0]["status"] == "rejected"  # type: ignore[index]
    broker.reject = None
    store.order = _order(client_order_key="orbit-partial01", quantity_micros=400_000)
    job = _job()
    job = job.model_copy(update={"request_key": "orbit-partial01"})
    await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(job, store)  # type: ignore[arg-type]
    update = store.snapshots[-1][13][0]
    assert update["status"] == "partially_filled"  # type: ignore[index]
    assert update["filled_quantity_micros"] == 200_000  # type: ignore[index]


async def test_other_owner_is_not_submitted():
    broker = Scripted()
    store = Store(_order())
    with pytest.raises(JobFailure) as info:
        await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(_job(owner="ff" * 32), store)  # type: ignore[arg-type]
    assert info.value.code == "paper_not_enabled"
    assert broker.posts == 0


async def test_stale_snapshot_is_retryable_and_writes_nothing():
    broker = Scripted()
    store = Store(_order())
    store.stale = True
    with pytest.raises(JobFailure) as info:
        await SubmitPaperOrderHandler(broker, demo_identity=DEMO).run(_job(), store)  # type: ignore[arg-type]
    assert info.value.code == "stale_revision"
    assert info.value.retryable is True
    assert store.snapshots == []


async def test_reconcile_applies_a_later_fill_and_keeps_revision_order():
    broker = Scripted()
    broker.known["orbit-abcdefgh"] = PaperOrder(
        "orbit-abcdefgh", "broker-1", "CAT", "buy", Decimal(1), None, "filled", Decimal(1), Decimal("150"), None
    )
    store = Store(_order(status="pending", provider_order_id="broker-1"))
    job = _job().model_copy(update={"kind": "reconcile_paper_account", "request_key": "reconcile:1"})
    await ReconcilePaperAccountHandler(broker, demo_identity=DEMO).run(job, store)  # type: ignore[arg-type]
    assert store.snapshots[0][2] == 1
    assert store.snapshots[0][13][0]["status"] == "filled"  # type: ignore[index]
    store.stale = True
    with pytest.raises(JobFailure):
        await ReconcilePaperAccountHandler(broker, demo_identity=DEMO).run(job, store)  # type: ignore[arg-type]


async def test_capability_probe_does_not_post_an_order():
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        if request.url.path == "/v2/account":
            return httpx.Response(
                200,
                json={
                    "id": "account-1",
                    "cash": "100000",
                    "equity": "100000",
                    "buying_power": "400000",
                    "currency": "USD",
                },
            )
        if request.url.path == "/v2/clock":
            return httpx.Response(
                200,
                json={
                    "is_open": False,
                    "timestamp": "2026-10-03T15:02:26-04:00",
                    "next_open": "2026-10-05T09:30:00-04:00",
                    "next_close": "2026-10-05T16:00:00-04:00",
                },
            )
        if request.url.path == "/v2/assets/AAPL":
            return httpx.Response(200, json={"symbol": "AAPL", "class": "us_equity", "status": "active", "tradable": True, "fractionable": True})
        return httpx.Response(500)

    provider = AlpacaPaperProvider(SecretStr("k"), SecretStr("s"), transport=httpx.MockTransport(handler))
    account = await provider.get_account()
    clock = await provider.get_clock()
    tradable, fractionable = await provider.is_asset_supported("AAPL")
    await provider.aclose()
    assert account.cash == Decimal("100000")
    assert account.equity == Decimal("100000")
    assert clock.is_open is False
    assert tradable and fractionable
    assert all(not call.startswith("POST") for call in calls)
