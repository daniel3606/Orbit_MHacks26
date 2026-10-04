"""Run the worker: `uv run python -m app.workers`."""

import asyncio
import logging
import signal
import sys

from app.assistant.handle import handlers as assistant_handlers
from app.config.settings import get_settings
from app.config.universe import load_universe
from app.market.alpaca import AlpacaHistoricalProvider
from app.market.finnhub import FinnhubProvider
from app.market.ingest import IngestMarketHandler
from app.market.routing import RoutedMarketProvider
from app.signals.config import SignalConfig
from app.state.gateway import GatewayError, SpacetimeGateway
from app.trading.alpaca import AlpacaPaperProvider
from app.trading.execute import ReconcilePaperAccountHandler, SubmitPaperOrderHandler
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
        # The first historical backfill publishes hundreds of bars in one reducer call.
        timeout=max(settings.spacetime_timeout_seconds, 60.0),
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
        provider: RoutedMarketProvider | None = None
        news_provider: FinnhubProvider | None = None
        if settings.market_ingest_enabled and settings.finnhub_api_key is not None:
            quotes = FinnhubProvider(
                settings.finnhub_api_key,
                base_url=str(settings.finnhub_base_url).rstrip("/"),
                calls_per_minute=settings.finnhub_calls_per_minute,
                burst=settings.finnhub_burst,
                max_retries=settings.finnhub_max_retries,
            )
            history = None
            if settings.alpaca_api_key_id is not None and settings.alpaca_api_secret_key is not None:
                history = AlpacaHistoricalProvider(
                    settings.alpaca_api_key_id,
                    settings.alpaca_api_secret_key,
                    base_url=str(settings.alpaca_data_base_url).rstrip("/"),
                    calls_per_minute=settings.alpaca_data_calls_per_minute,
                    burst=settings.alpaca_data_burst,
                )
            else:
                log.warning("No Alpaca market-data keys; daily history stays on Finnhub capabilities")
            news_provider = quotes
            provider = RoutedMarketProvider(quotes, history)
            ingest = IngestMarketHandler(provider, load_universe(), SignalConfig())
            handlers[ingest.kind] = ingest
        else:
            log.warning("Market ingestion disabled (no FINNHUB_API_KEY or MARKET_INGEST_ENABLED=false)")

        paper: AlpacaPaperProvider | None = None
        if (
            settings.paper_demo_identity
            and settings.alpaca_api_key_id is not None
            and settings.alpaca_api_secret_key is not None
        ):
            paper = AlpacaPaperProvider(
                settings.alpaca_api_key_id,
                settings.alpaca_api_secret_key,
                base_url=str(settings.alpaca_base_url).rstrip("/"),
            )
            account = await paper.get_account()
            clock = await paper.get_clock()
            tradable, fractionable = await paper.is_asset_supported("AAPL")
            log.info(
                "paper account cash=%s equity=%s currency=%s open=%s next_open=%s aapl_tradable=%s aapl_fractionable=%s",
                account.cash,
                account.equity,
                account.currency,
                clock.is_open,
                clock.next_open.isoformat() if clock.next_open else None,
                tradable,
                fractionable,
            )
            handlers[SubmitPaperOrderHandler.kind] = SubmitPaperOrderHandler(
                paper, demo_identity=settings.paper_demo_identity
            )
            handlers[ReconcilePaperAccountHandler.kind] = ReconcilePaperAccountHandler(
                paper, demo_identity=settings.paper_demo_identity
            )
        else:
            log.warning("Paper trading not registered (PAPER_DEMO_IDENTITY or Alpaca keys missing)")

        handlers.update(
            assistant_handlers(
                api_key=settings.openai_api_key,
                model=settings.openai_model,
                timeout=settings.openai_timeout_seconds,
                max_output_tokens=settings.openai_max_output_tokens,
                news=news_provider,
            )
        )
        if settings.openai_api_key is None:
            log.warning("OPENAI_API_KEY is unset; home briefs use published data and chat stays unavailable")

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
        if paper is not None:
            await gateway.request_paper_reconcile()
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
            if paper is not None:
                await paper.aclose()
        log.info("worker stopped")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
