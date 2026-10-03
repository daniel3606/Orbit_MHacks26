"""Submit and reconcile paper orders outside the database transaction.

The submit handler looks up the client order id before posting. A timeout is
resolved with that same id. A retry of the job cannot create a second order.
Reconcile never posts. Alpaca remains the source of fills and holdings.
"""

from datetime import UTC

from app.state.dto import JobV1, PaperOrderV1
from app.state.gateway import ReducerRejected, SpacetimeGateway
from app.state.sats_json import option, timestamp_arg
from app.trading.checks import LocalReject, OrderIntent, check_order
from app.trading.money import from_micros, to_micros
from app.trading.provider import (
    PaperAccount,
    PaperClock,
    PaperOrder,
    PaperPosition,
    PaperRejected,
    PaperTimeout,
    PaperTradingProvider,
)
from app.workers.runner import Committed, JobFailure


def _owner(value: str) -> str:
    return value.removeprefix("0x").lower()


class SubmitPaperOrderHandler:
    kind = "submit_paper_order"
    lease_seconds = 45

    def __init__(self, provider: PaperTradingProvider, *, demo_identity: str):
        self._provider = provider
        self._demo = _owner(demo_identity)

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        if _owner(job.owner) != self._demo:
            raise JobFailure("paper_not_enabled", retryable=False)
        order = await _intent(gateway, job)
        account = await self._provider.get_account()
        clock = await self._provider.get_clock()
        positions = await self._provider.list_positions()
        tradable, fractionable = await self._provider.is_asset_supported(order.ticker)
        intent = OrderIntent(
            ticker=order.ticker,
            side=order.side,
            quantity=from_micros(order.quantity_micros) if order.quantity_micros is not None else None,
            notional=from_micros(order.notional_micros) if order.notional_micros is not None else None,
            quote=from_micros(order.quote_micros),
        )
        try:
            check_order(intent, account, positions, tradable=tradable, fractionable=fractionable)
        except LocalReject as exc:
            await _publish(gateway, job, account, clock, positions, _rejected(order, exc.reason))
            return Committed(f"rejected:{exc.reason}")

        try:
            broker = await self._provider.find_order(order.client_order_key)
            if broker is None:
                broker = await self._provider.submit_order(
                    client_order_id=order.client_order_key,
                    ticker=order.ticker,
                    side=order.side,
                    quantity=intent.quantity,
                    notional=intent.notional,
                )
        except PaperTimeout:
            try:
                broker = await self._provider.find_order(order.client_order_key)
            except PaperTimeout as exc:
                raise JobFailure("broker_timeout", retryable=True) from exc
            if broker is None:
                if job.attempt_count < job.max_attempts:
                    raise JobFailure("broker_timeout", retryable=True)
                await _publish(gateway, job, account, clock, positions, _unconfirmed(order))
                return Committed("reconciling")
        except PaperRejected as exc:
            await _publish(gateway, job, account, clock, positions, _rejected(order, exc.reason))
            return Committed(f"rejected:{exc.reason}")

        await _publish(gateway, job, account, clock, positions, broker)
        return Committed(broker.status)


class ReconcilePaperAccountHandler:
    kind = "reconcile_paper_account"
    lease_seconds = 45

    def __init__(self, provider: PaperTradingProvider, *, demo_identity: str):
        self._provider = provider
        self._demo = _owner(demo_identity)

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        if _owner(job.owner) != self._demo:
            raise JobFailure("paper_not_enabled", retryable=False)
        account = await self._provider.get_account()
        clock = await self._provider.get_clock()
        positions = await self._provider.list_positions()
        local = [row for row in await gateway.worker_paper_orders() if _owner(row.owner) == _owner(job.owner)]
        broker_orders = {row.client_order_id: row for row in await self._provider.list_orders()}
        updates: list[PaperOrder] = []
        for row in local:
            if row.status in {"filled", "rejected", "canceled"}:
                continue
            found = broker_orders.get(row.client_order_key)
            if found is None:
                try:
                    found = await self._provider.find_order(row.client_order_key)
                except PaperTimeout as exc:
                    raise JobFailure("broker_timeout", retryable=True) from exc
            if found is None:
                if row.status == "queued":
                    continue
                updates.append(_unconfirmed(row))
                continue
            updates.append(found)
        await _publish(gateway, job, account, clock, positions, *updates)
        return Committed(f"orders={len(updates)}")


async def _intent(gateway: SpacetimeGateway, job: JobV1) -> PaperOrderV1:
    matches = [
        row
        for row in await gateway.worker_paper_orders()
        if row.client_order_key == job.request_key and _owner(row.owner) == _owner(job.owner)
    ]
    if len(matches) != 1:
        raise JobFailure("order_not_found", retryable=True)
    return matches[0]


def _rejected(order: PaperOrderV1, reason: str) -> PaperOrder:
    return PaperOrder(
        client_order_id=order.client_order_key,
        provider_order_id="",
        ticker=order.ticker,
        side=order.side,
        quantity=None,
        notional=None,
        status="rejected",
        filled_quantity=from_micros(0),
        filled_avg_price=None,
        reject_reason=reason,
    )


def _unconfirmed(order: PaperOrderV1) -> PaperOrder:
    return PaperOrder(
        client_order_id=order.client_order_key,
        provider_order_id=order.provider_order_id or "",
        ticker=order.ticker,
        side=order.side,
        quantity=None,
        notional=None,
        status="reconciling",
        filled_quantity=from_micros(order.filled_quantity_micros),
        filled_avg_price=from_micros(order.filled_avg_price_micros) if order.filled_avg_price_micros is not None else None,
        reject_reason=None,
    )


def _order_arg(order: PaperOrder) -> dict[str, object]:
    filled_avg = None if order.filled_avg_price is None else to_micros(order.filled_avg_price)
    return {
        "client_order_key": order.client_order_id,
        "status": order.status,
        "provider_order_id": option(order.provider_order_id or None),
        "filled_quantity_micros": to_micros(order.filled_quantity),
        "filled_avg_price_micros": option(filled_avg),
        "reject_reason": option(order.reject_reason),
    }


def _position_arg(position: PaperPosition, revision_unused: int = 0) -> dict[str, object]:
    del revision_unused
    return {
        "ticker": position.ticker,
        "quantity_micros": to_micros(position.quantity),
        "avg_entry_micros": to_micros(position.avg_entry_price),
        "market_value_micros": option(None if position.market_value is None else to_micros(position.market_value)),
        "unrealized_pl_micros": option(None if position.unrealized_pl is None else to_micros(position.unrealized_pl)),
    }


async def _publish(
    gateway: SpacetimeGateway,
    job: JobV1,
    account: PaperAccount,
    clock: PaperClock,
    positions: list[PaperPosition],
    *orders: PaperOrder,
) -> None:
    current = await gateway.worker_paper_account()
    revision = (current.revision if current else 0) + 1
    args = [
        job.job_id,
        job.attempt_count,
        revision,
        account.provider_account_id,
        to_micros(account.cash),
        to_micros(account.equity),
        to_micros(account.buying_power),
        account.currency,
        timestamp_arg(clock.timestamp if clock.timestamp.tzinfo else clock.timestamp.replace(tzinfo=UTC)),
        clock.is_open,
        option(timestamp_arg(clock.next_open) if clock.next_open else None),
        option(timestamp_arg(clock.next_close) if clock.next_close else None),
        [_position_arg(row) for row in positions],
        [_order_arg(row) for row in orders],
    ]
    try:
        await gateway.apply_paper_snapshot(args)
    except ReducerRejected as exc:
        if exc.code == "stale_revision":
            raise JobFailure("stale_revision", retryable=True) from exc
        raise
