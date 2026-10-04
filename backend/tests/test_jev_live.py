"""LIVE Jev checks through OpenRouter's Decisions API with the configured backend key.

Opt-in only (each call is billed per input token):
`ORBIT_LIVE_PROVIDER_TESTS=1 uv run pytest -q -s tests/test_jev_live.py`
Proves the documented contract holds for this key and prints what came back.
"""

import os
from datetime import UTC, datetime

import pytest

from app.config.settings import get_settings
from app.intelligence.jev import JevClassifier

pytestmark = pytest.mark.skipif(
    os.environ.get("ORBIT_LIVE_PROVIDER_TESTS") != "1" or get_settings().jev_api_key is None,
    reason="live provider tests are opt-in and need JEV_API_KEY",
)


@pytest.fixture
async def jev():
    settings = get_settings()
    assert settings.jev_api_key is not None
    classifier = JevClassifier(
        settings.jev_api_key,
        base_url=str(settings.jev_base_url).rstrip("/"),
        model=settings.jev_model,
        company_names={"AAPL": "Apple Inc."},
        timeout=settings.jev_timeout_seconds,
        max_retries=1,
    )
    yield classifier
    print(f"jev calls={classifier.http_calls} cost_usd={classifier.cost_usd:.6f}")
    await classifier.aclose()


async def test_live_verification_returns_a_schema_valid_decision(jev):
    capability = await jev.verify()
    print(capability.detail)
    assert capability.available, capability.detail


async def test_live_relevance_and_sentiment_are_judged_separately(jev):
    now = datetime.now(UTC).isoformat(timespec="seconds")
    bad_news = await jev.classify_article(
        article_id="live-1",
        ticker="AAPL",
        headline="Apple recalls two million iPhone chargers after overheating reports",
        text="Apple said it will replace the chargers at no cost after regulators received reports of overheating.",
        source="Orbit live test",
        published_at=now,
    )
    unrelated = await jev.classify_article(
        article_id="live-2",
        ticker="AAPL",
        headline="Local bakery wins regional bread contest for the third year",
        text="The bakery's sourdough beat 40 other entries.",
        source="Orbit live test",
        published_at=now,
    )
    print(bad_news)
    print(unrelated)
    assert bad_news.relevant and bad_news.keep and bad_news.sentiment == "negative"
    assert not unrelated.relevant and not unrelated.keep
