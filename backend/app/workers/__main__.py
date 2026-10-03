"""Run the worker: `uv run python -m app.workers`."""

import asyncio
import logging
import signal
import sys

from app.config.settings import get_settings
from app.state.gateway import GatewayError, SpacetimeGateway
from app.workers.handlers import default_handlers
from app.workers.runner import Worker

log = logging.getLogger("orbit.worker")


async def main() -> int:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    token = settings.resolved_service_token()
    if token is None:
        log.error("No service token. Run `uv run python -m scripts.bootstrap_service_identity --grant` first.")
        return 2

    async with SpacetimeGateway(
        str(settings.spacetime_http_url),
        settings.spacetime_database,
        token,
        timeout=settings.spacetime_timeout_seconds,
    ) as gateway:
        try:
            grant = await gateway.service_grant()
        except GatewayError as exc:
            log.error("Cannot reach SpacetimeDB: %s", exc.code)
            return 1
        if grant is None:
            log.error("Service token is valid but not on the allowlist. Grant it (see README).")
            return 3

        worker = Worker(
            gateway,
            default_handlers(settings.worker_id),
            identity_hex=grant.identity,
            lease_seconds=settings.worker_lease_seconds,
            concurrency=settings.worker_concurrency,
            poll_interval=settings.worker_poll_interval_seconds,
            max_poll_interval=settings.worker_max_poll_interval_seconds,
        )
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        log.info("worker %s started as %s… (%s)", settings.worker_id, grant.identity[:12], grant.label)
        await worker.run_forever(stop)
        log.info("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
