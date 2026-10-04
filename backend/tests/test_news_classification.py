"""Shared classification service: dedupe, cache, coverage, persistence, and the
PRD news-feature inputs. A fake classifier stands in for Jev; no network."""

import asyncio
import math
from datetime import UTC, datetime, timedelta

import pytest

from app.intelligence.classifier import Classification, ClassificationUnavailable
from app.intelligence.features import news_signals
from app.intelligence.service import (
    Article,
    Judged,
    NewsClassificationService,
    cache_key,
    content_hash,
)
from app.market.provider import CapabilityResult
from app.state.dto import JobV1, NewsClassificationV1
from app.state.gateway import GatewayContractError

NOW = datetime(2026, 10, 4, 15, 0, tzinfo=UTC)
VERSION = "jev-news-v1:test-model"


def verdict(*, keep: bool = True, relevance: float = 0.9, sentiment: str = "positive", materiality: str = "high", event: str = "earnings") -> Classification:
    return Classification(
        relevant=relevance >= 0.5,
        relevance_score=relevance,
        event_type=event,  # type: ignore[arg-type]
        sentiment=sentiment,  # type: ignore[arg-type]
        materiality=materiality,  # type: ignore[arg-type]
        keep=keep,
        classifier_version=VERSION,
    )


class FakeClassifier:
    def __init__(self, by_headline: dict | None = None, *, default=None, delay: float = 0.0, version: str = VERSION):
        self.version = version
        self.by_headline = by_headline or {}
        self.default = default if default is not None else verdict()
        self.delay = delay
        self.calls: list[tuple[str, str]] = []
        self.state = (True, "Verified with fake")

    async def available(self) -> bool:
        return True

    async def classify_article(self, *, article_id, ticker, headline, text, source, published_at):
        self.calls.append((ticker, headline))
        if self.delay:
            await asyncio.sleep(self.delay)
        result = self.by_headline.get(headline, self.default)
        if isinstance(result, Exception):
            raise result
        return result

    def capability(self) -> CapabilityResult:
        return CapabilityResult("jev.news_classification", "News classification (Jev)", self.state[0], self.state[1], "jev")


class StoreGateway:
    def __init__(self, rows: list[NewsClassificationV1] | None = None, *, missing: bool = False):
        self.rows = rows or []
        self.missing = missing
        self.recorded: list[tuple[int, int, list[dict]]] = []
        self.capabilities: list[list[dict]] = []
        self.loads = 0

    async def worker_news_classifications(self):
        self.loads += 1
        if self.missing:
            raise GatewayContractError("HTTP 400")
        return self.rows

    async def record_news_classifications(self, job_id, attempt, rows):
        if self.missing:
            raise GatewayContractError("HTTP 400")
        self.recorded.append((job_id, attempt, list(rows)))

    async def publish_provider_capabilities(self, capabilities):
        self.capabilities.append(list(capabilities))


def article(headline: str = "Apple reports record revenue", *, ticker: str = "AAPL", article_id: str = "news:AAPL:1", source: str = "Reuters", hours_ago: float = 1, text: str | None = "Revenue rose.") -> Article:
    return Article(article_id, ticker, headline, text, source, NOW - timedelta(hours=hours_ago))


def job() -> JobV1:
    return JobV1(
        job_id=11, owner="ab" * 32, kind="answer_message", request_key="k", input_version=0, status="running",
        attempt_count=2, max_attempts=5, lease_owner="cd" * 32, lease_until=NOW + timedelta(minutes=1),
        available_at=NOW, payload="{}", result_ref=None, error_code=None, created_at=NOW, updated_at=NOW,
    )


# ---- deduplication and reuse ----


async def test_duplicate_and_syndicated_articles_share_one_call():
    fake = FakeClassifier()
    service = NewsClassificationService(fake)
    batch = [
        article(),
        article(),  # exact duplicate
        article(article_id="news:AAPL:2", source="Yahoo"),  # syndicated copy: same text, other source
    ]
    result = await service.classify(batch)
    assert len(fake.calls) == 1
    assert result.status == "classified" and result.classified == 3
    assert len({item.content_hash for item in result.items}) == 1


async def test_concurrent_consumers_share_one_in_flight_call():
    fake = FakeClassifier(delay=0.02)
    service = NewsClassificationService(fake)
    discovery, chat = await asyncio.gather(service.classify([article()]), service.classify([article(article_id="other-id")]))
    assert len(fake.calls) == 1
    assert discovery.items[0].classification == chat.items[0].classification


async def test_a_second_consumer_reuses_the_cached_judgment():
    fake = FakeClassifier()
    service = NewsClassificationService(fake)
    await service.classify([article()])  # Discovery
    again = await service.classify([article(article_id="news:AAPL:9")])  # chat, same story
    assert len(fake.calls) == 1 and service.provider_calls == 1
    assert again.status == "classified"


async def test_the_same_story_is_judged_separately_per_ticker():
    fake = FakeClassifier()
    service = NewsClassificationService(fake)
    await service.classify([article("Apple and Microsoft sign a cloud deal", ticker="AAPL"), article("Apple and Microsoft sign a cloud deal", ticker="MSFT")])
    assert sorted(t for t, _ in fake.calls) == ["AAPL", "MSFT"]


def test_cache_key_changes_with_ticker_and_version():
    digest = content_hash("Apple reports", "text")
    assert content_hash("  APPLE   reports ", "TEXT") == digest  # normalized
    assert len({cache_key(digest, "AAPL", "v1"), cache_key(digest, "MSFT", "v1"), cache_key(digest, "AAPL", "v2")}) == 3


# ---- coverage and unavailability ----


async def test_without_a_classifier_every_article_is_marked_not_configured():
    result = await NewsClassificationService(None).classify([article()])
    assert result.status == "not_configured" and result.label() == "not_configured"
    assert result.items[0].classification is None and result.items[0].reason == "not_configured"


async def test_unavailable_provider_leaves_articles_unclassified_with_a_reason():
    service = NewsClassificationService(FakeClassifier(default=ClassificationUnavailable("auth_failed")))
    result = await service.classify([article(), article("Apple opens a store", article_id="b")])
    assert result.status == "unavailable" and result.label() == "unavailable:auth_failed"
    assert all(item.classification is None and item.reason == "auth_failed" for item in result.items)
    assert result.coverage == 0.0


async def test_partial_coverage_is_labeled():
    fake = FakeClassifier({"Apple opens a store": ClassificationUnavailable("rate_limited")})
    result = await NewsClassificationService(fake).classify([article(), article("Apple opens a store", article_id="b")])
    assert result.label() == "partial:rate_limited" and result.coverage == 0.5
    assert result.for_ticker("AAPL").label() == "partial:rate_limited"
    assert result.for_ticker("MSFT").label() == "no_articles"


async def test_failed_judgments_are_not_cached():
    fake = FakeClassifier(default=ClassificationUnavailable("provider_unavailable"))
    service = NewsClassificationService(fake)
    await service.classify([article()])
    fake.default = verdict()
    assert (await service.classify([article()])).status == "classified"
    assert len(fake.calls) == 2


async def test_deadline_marks_slow_articles_and_the_call_still_fills_the_cache():
    fake = FakeClassifier(delay=0.05)
    service = NewsClassificationService(fake)
    result = await service.classify([article()], deadline=0.001)
    assert result.items[0].reason == "deadline" and result.label() == "unavailable:deadline"
    await asyncio.sleep(0.08)
    assert (await service.classify([article()])).status == "classified"
    assert len(fake.calls) == 1


async def test_empty_input_is_no_articles():
    result = await NewsClassificationService(FakeClassifier()).classify([])
    assert result.status == "no_articles" and result.items == ()


# ---- persistence ----


def stored_row(a: Article, version: str = VERSION) -> NewsClassificationV1:
    digest = content_hash(a.headline, a.text)
    return NewsClassificationV1(
        cache_key=cache_key(digest, a.ticker, version), ticker=a.ticker, article_id=a.article_id, content_hash=digest,
        classifier_version=version, relevant=True, relevance_score=0.7, event_type="product", sentiment="negative",
        materiality="medium", keep=True, published_at=a.published_at, classified_at=NOW, job_id=3,
    )


async def test_stored_judgments_are_reused_after_a_restart():
    fake = FakeClassifier()
    gateway = StoreGateway([stored_row(article())])
    result = await NewsClassificationService(fake).classify([article()], gateway=gateway, job=job())  # type: ignore[arg-type]
    assert fake.calls == [] and gateway.recorded == []
    assert result.items[0].classification is not None and result.items[0].classification.sentiment == "negative"


async def test_stored_judgments_from_another_version_are_ignored():
    fake = FakeClassifier()
    gateway = StoreGateway([stored_row(article(), version="jev-news-v0:old")])
    await NewsClassificationService(fake).classify([article()], gateway=gateway, job=job())  # type: ignore[arg-type]
    assert len(fake.calls) == 1


async def test_new_judgments_are_recorded_under_the_job_lease():
    gateway = StoreGateway()
    copy = article(article_id="news:AAPL:copy")
    future = article("Apple sets an event date", article_id="f", hours_ago=-(24 * 400))  # provider clock far ahead
    await NewsClassificationService(FakeClassifier()).classify([article(), copy, future], gateway=gateway, job=job())  # type: ignore[arg-type]
    ((job_id, attempt, rows),) = gateway.recorded
    assert (job_id, attempt) == (11, 2)
    assert len(rows) == 2  # the copy shares the first article's judgment
    stored_at = [r["published_at"]["__timestamp_micros_since_unix_epoch__"] for r in rows]
    assert max(stored_at) <= int(datetime.now(UTC).timestamp() * 1_000_000)  # never stored in the future
    row = rows[0]
    assert set(row) == {
        "cache_key", "ticker", "article_id", "content_hash", "classifier_version", "relevant", "relevance_score",
        "event_type", "sentiment", "materiality", "keep", "published_at",
    }
    assert row["classifier_version"] == VERSION and len(row["cache_key"]) == 64


async def test_missing_store_turns_persistence_off_but_still_classifies():
    gateway = StoreGateway(missing=True)
    service = NewsClassificationService(FakeClassifier())
    first = await service.classify([article()], gateway=gateway, job=job())  # type: ignore[arg-type]
    await service.classify([article("Apple opens a store", article_id="b")], gateway=gateway, job=job())  # type: ignore[arg-type]
    assert first.status == "classified" and gateway.loads == 1


async def test_capability_is_published_only_when_it_changes():
    fake = FakeClassifier()
    gateway = StoreGateway()
    service = NewsClassificationService(fake)
    await service.classify([article()], gateway=gateway)  # type: ignore[arg-type]
    await service.classify([article("Apple opens a store", article_id="b")], gateway=gateway)  # type: ignore[arg-type]
    assert len(gateway.capabilities) == 1 and gateway.capabilities[0][0]["available"] is True
    fake.state = (False, "Not verified: auth_failed (HTTP 401); off until the key is fixed")
    await service.publish_capability(gateway)  # type: ignore[arg-type]
    assert len(gateway.capabilities) == 2 and gateway.capabilities[1][0]["available"] is False


async def test_unconfigured_service_publishes_not_configured():
    gateway = StoreGateway()
    await NewsClassificationService(None).publish_capability(gateway)  # type: ignore[arg-type]
    ((row,),) = gateway.capabilities
    assert row["key"] == "jev.news_classification" and row["available"] is False and "JEV_API_KEY" in row["detail"]


# ---- PRD news-feature inputs ----


def judged(a: Article, c: Classification | None, reason: str | None = None) -> Judged:
    return Judged(a, c, reason, content_hash(a.headline, a.text))  # type: ignore[arg-type]


def test_news_signals_match_the_prd_formulas_by_hand():
    a = article("Apple beats estimates", source="Reuters", hours_ago=0)
    b = article("Apple faces EU fine", article_id="b", source="Bloomberg", hours_ago=36)
    c = article("Ten stocks to watch", article_id="c", source="Blog", hours_ago=2)
    d = article("Apple beats estimates", article_id="d", source="Yahoo", hours_ago=-0.5)  # syndicated copy of a, later
    e = article("Apple supplier update", article_id="e", source="Wire", hours_ago=3)
    items = [
        judged(a, verdict(relevance=0.9, sentiment="positive", materiality="high")),
        judged(b, verdict(relevance=0.8, sentiment="negative", materiality="medium")),
        judged(c, verdict(keep=False, relevance=0.1, sentiment="negative")),
        judged(d, verdict(relevance=0.9, sentiment="positive", materiality="high")),
        judged(e, None, "rate_limited"),
    ]
    signals = news_signals(items, NOW, window_hours=168)
    # w_a = 0.9 · 1 · 0.75 = 0.675 ; w_b = 0.8 · 0.5 · 0.5 = 0.2 ; d merges into a ; c is not kept
    assert signals.recent_sentiment == pytest.approx((0.675 - 0.2) / 0.875, abs=1e-6)
    assert (signals.articles, signals.classified, signals.relevant_events) == (5, 4, 2)
    assert signals.independent_sources == 2  # the syndicated copy is not independent corroboration
    assert signals.breadth_raw == pytest.approx(math.log(3))
    assert signals.materiality_mean == pytest.approx(0.625)
    assert signals.highest_materiality == "high"
    assert signals.unavailable_reason is None


def test_no_relevant_news_is_missing_sentiment_not_neutral():
    items = [judged(article("Ten stocks to watch"), verdict(keep=False, relevance=0.1, sentiment="negative"))]
    signals = news_signals(items, NOW, window_hours=168)
    assert signals.recent_sentiment is None and signals.relevant_events == 0
    assert signals.unavailable_reason == "no_relevant_articles"


def test_unclassified_news_has_no_semantic_values():
    signals = news_signals([judged(article(), None, "auth_failed")], NOW, window_hours=168)
    assert signals.recent_sentiment is None and signals.highest_materiality is None and signals.breadth_raw is None
    assert signals.unavailable_reason == "classification_unavailable:auth_failed"


def test_articles_outside_the_window_are_ignored():
    signals = news_signals([judged(article(hours_ago=200), verdict())], NOW, window_hours=168)
    assert signals.articles == 0 and signals.unavailable_reason == "no_articles"
