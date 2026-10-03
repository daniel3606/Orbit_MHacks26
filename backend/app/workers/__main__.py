"""Run the worker: `uv run python -m app.workers`."""

import asyncio
import logging
import signal
import sys

from app.config.settings import get_settings
from app.config.universe import load_universe
from app.market.finnhub import FinnhubProvider
from app.market.ingest import IngestMarketHandler
from app.signals.config import SignalConfig
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

        handlers = default_handlers(settings.worker_id)
        provider: FinnhubProvider | None = None
        if settings.market_ingest_enabled and settings.finnhub_api_key is not None:
            provider = FinnhubProvider(
                settings.finnhub_api_key,
                base_url=str(settings.finnhub_base_url).rstrip("/"),
                calls_per_minute=settings.finnhub_calls_per_minute,
                burst=settings.finnhub_burst,
                max_retries=settings.finnhub_max_retries,
            )
            ingest = IngestMarketHandler(provider, load_universe(), SignalConfig())
            handlers[ingest.kind] = ingest
        else:
            log.warning("Market ingestion disabled (no FINNHUB_API_KEY or MARKET_INGEST_ENABLED=false)")

        worker = Worker(
            gateway,
            handlers,
            identity_hex=grant.identity,
            lease_seconds=settings.worker_lease_seconds,
            concurrency=settings.worker_concurrency,
            poll_interval=settings.worker_poll_interval_seconds,
            max_poll_interval=settings.worker_max_poll_interval_seconds,
        )
        await gateway.register_worker(worker.kinds)
        log.info("registered job kinds: %s", ", ".join(worker.kinds))
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        log.info("worker %s started as %s… (%s)", settings.worker_id, grant.identity[:12], grant.label)
        try:
            await worker.run_forever(stop)
        finally:
            if provider is not None:
                await provider.aclose()
        log.info("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
