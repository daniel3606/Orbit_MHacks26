"""TEST-ONLY: run one real ingestion (worker + handler + gateway) with the
labeled fixture provider against a test database.

    SPACETIME_DATABASE=orbit-test SPACETIME_SERVICE_TOKEN=... \\
        uv run python -m scripts.publish_fixture_snapshot

Requires the token's identity to be allowlisted and `allow_fixture_data`
enabled on that database (the module rejects fixture rows otherwise).
"""

import asyncio
import sys

from app.config.settings import get_settings
from app.config.universe import load_universe
from app.market.fixtures import FixtureProvider
from app.market.ingest import IngestMarketHandler
from app.signals.config import SignalConfig
from app.state.gateway import SpacetimeGateway
from app.workers.runner import Worker


async def main() -> int:
    settings = get_settings()
    if settings.spacetime_database in ("orbit-dev", "orbit"):
        print("Refusing to publish fixture data to a non-test database", file=sys.stderr)
        return 2
    token = settings.resolved_service_token()
    async with SpacetimeGateway(str(settings.spacetime_http_url), settings.spacetime_database, token) as gateway:
        grant = await gateway.service_grant()
        if grant is None:
            print("service token not allowlisted", file=sys.stderr)
            return 3
        handler = IngestMarketHandler(FixtureProvider(load_universe()), load_universe(), SignalConfig())
        worker = Worker(gateway, {handler.kind: handler}, identity_hex=grant.identity)
        await gateway.register_worker(worker.kinds)
        await gateway.request_market_ingest()
        claimed = await worker.run_once()
        generation = await gateway.market_generation()
        print(f"claimed={claimed} generation={generation.generation if generation else None}")
        return 0 if claimed and generation else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
