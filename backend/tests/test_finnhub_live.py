"""LIVE provider checks against Finnhub with the configured backend key.

Opt-in only (costs API calls): `ORBIT_LIVE_PROVIDER_TESTS=1 uv run pytest tests/test_finnhub_live.py`
Asserts what the account actually returns; nothing here uses fixtures.
"""

import os
from datetime import UTC, datetime, timedelta

import pytest

from app.config.settings import get_settings
from app.market.finnhub import FinnhubProvider

pytestmark = pytest.mark.skipif(
    os.environ.get("ORBIT_LIVE_PROVIDER_TESTS") != "1" or get_settings().finnhub_api_key is None,
    reason="live provider tests are opt-in and need FINNHUB_API_KEY",
)


@pytest.fixture
async def finnhub():
    settings = get_settings()
    assert settings.finnhub_api_key is not None
    provider = FinnhubProvider(settings.finnhub_api_key, calls_per_minute=30, burst=5, max_retries=1)
    yield provider
    await provider.aclose()


async def test_live_quote_has_real_provider_timestamp(finnhub):
    q = await finnhub.get_quote("SPY")
    assert q.price > 0 and q.previous_close > 0
    assert datetime.now(UTC) - timedelta(days=5) < q.provider_time <= datetime.now(UTC) + timedelta(minutes=5)


async def test_live_capabilities_are_probed(finnhub):
    caps = {c.key: c for c in await finnhub.capabilities()}
    assert caps["finnhub.quote"].available
    # Report, don't assume: print what this account can access.
    for c in caps.values():
        print(f"{c.key}: {'available' if c.available else 'UNAVAILABLE'} — {c.detail}")


async def test_live_market_status(finnhub):
    status = await finnhub.get_market_status()
    assert status.exchange == "US" and isinstance(status.is_open, bool)
