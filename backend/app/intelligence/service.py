"""Shared, deduplicated news classification for every worker consumer.

One instance per worker process. Discovery, the home brief and chat all call it,
so an article already judged for a ticker under the current classifier version
is reused instead of sent again:

    content hash = sha256(normalized headline + text)   # syndicated copies share it
    cache key    = sha256(content hash | ticker | classifier version)

Lookup order: in-memory LRU → rows persisted in SpacetimeDB
(`news_classification`, read once per process) → Jev. Identical concurrent
requests share one provider call. Persisting is best-effort and never blocks a
consumer. A failed article stays unclassified with a stable reason; nothing is
filled in, and no other model is asked.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import unicodedata
from collections import Counter, OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal

from app.intelligence.classifier import Classification, ClassificationUnavailable, NewsClassifier, UnavailableReason
from app.intelligence.jev import CAPABILITY_KEY, PROVIDER
from app.market.provider import CapabilityResult
from app.state.dto import JobV1, NewsClassificationV1
from app.state.gateway import GatewayContractError, GatewayError, SpacetimeGateway
from app.state.sats_json import timestamp_arg

log = logging.getLogger(__name__)

DEFAULT_DEADLINE_SECONDS = 8.0
CACHE_SIZE = 4_000
CONCURRENCY = 8
PERSIST_BATCH = 50

CoverageStatus = Literal["classified", "partial", "unavailable", "not_configured", "no_articles"]
NOT_CONFIGURED = CapabilityResult(
    CAPABILITY_KEY, "News classification (Jev)", False, "Not configured (JEV_API_KEY unset)", PROVIDER
)


@dataclass(frozen=True)
class Article:
    article_id: str
    ticker: str
    headline: str
    text: str | None
    source: str
    published_at: datetime


@dataclass(frozen=True)
class Judged:
    article: Article
    classification: Classification | None
    reason: UnavailableReason | None  # set exactly when classification is None
    content_hash: str


@dataclass(frozen=True)
class ClassifiedNews:
    items: tuple[Judged, ...]
    status: CoverageStatus
    reason: UnavailableReason | None
    classifier_version: str | None

    @property
    def classified(self) -> int:
        return sum(1 for item in self.items if item.classification is not None)

    @property
    def coverage(self) -> float:
        return self.classified / len(self.items) if self.items else 0.0

    def label(self) -> str:
        """Compact, stable coverage label, e.g. `classified`, `partial:rate_limited`, `unavailable:auth_failed`."""
        if self.status in ("partial", "unavailable") and self.reason:
            return f"{self.status}:{self.reason}"
        return self.status

    def for_ticker(self, ticker: str) -> ClassifiedNews:
        """This ticker's articles with their own coverage status."""
        items = tuple(item for item in self.items if item.article.ticker == ticker)
        if not items:
            return ClassifiedNews((), "no_articles", None, self.classifier_version)
        if self.status == "not_configured":
            return ClassifiedNews(items, "not_configured", "not_configured", None)
        return _summary(items, self.classifier_version)


def content_hash(headline: str, text: str | None) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", f"{headline}\n{text or ''}").casefold().split())
    return hashlib.sha256(normalized.encode()).hexdigest()


def cache_key(digest: str, ticker: str, version: str) -> str:
    return hashlib.sha256(f"{digest}|{ticker}|{version}".encode()).hexdigest()


def _from_row(row: NewsClassificationV1) -> Classification:
    return Classification(
        relevant=row.relevant,
        relevance_score=row.relevance_score,
        event_type=row.event_type,
        sentiment=row.sentiment,
        materiality=row.materiality,
        keep=row.keep,
        classifier_version=row.classifier_version,
    )


def _row(key: str, digest: str, article: Article, result: Classification, now: datetime) -> dict[str, Any]:
    return {
        "cache_key": key,
        "ticker": article.ticker,
        "article_id": article.article_id[:128],
        "content_hash": digest,
        "classifier_version": result.classifier_version,
        "relevant": result.relevant,
        "relevance_score": result.relevance_score,
        "event_type": result.event_type,
        "sentiment": result.sentiment,
        "materiality": result.materiality,
        "keep": result.keep,
        "published_at": timestamp_arg(min(article.published_at, now)),
    }


class NewsClassificationService:
    def __init__(
        self,
        classifier: NewsClassifier | None,
        *,
        cache_size: int = CACHE_SIZE,
        concurrency: int = CONCURRENCY,
        deadline: float = DEFAULT_DEADLINE_SECONDS,
    ):
        self._classifier = classifier
        self._cache: OrderedDict[str, Classification] = OrderedDict()
        self._cache_size = cache_size
        self._inflight: dict[str, asyncio.Task[Classification]] = {}
        self._semaphore = asyncio.Semaphore(concurrency)
        self._deadline = deadline
        self._loaded = False
        self._store_enabled = True
        self._load_lock = asyncio.Lock()
        self._published: tuple[bool, str] | None = None
        self.provider_calls = 0  # classifications requested from the provider (not cache hits)

    @property
    def version(self) -> str | None:
        return self._classifier.version if self._classifier is not None else None

    @property
    def configured(self) -> bool:
        return self._classifier is not None

    async def classify(
        self,
        articles: Sequence[Article],
        *,
        gateway: SpacetimeGateway | None = None,
        job: JobV1 | None = None,
        deadline: float | None = None,
    ) -> ClassifiedNews:
        version = self.version
        if not articles:
            return ClassifiedNews((), "no_articles", None, version)
        digests = [content_hash(a.headline, a.text) for a in articles]
        if self._classifier is None or version is None:
            items = tuple(Judged(a, None, "not_configured", d) for a, d in zip(articles, digests, strict=True))
            return ClassifiedNews(items, "not_configured", "not_configured", None)
        if gateway is not None:
            await self._warm(gateway, version)

        keys = [cache_key(d, a.ticker, version) for a, d in zip(articles, digests, strict=True)]
        outcomes: dict[str, Classification | UnavailableReason] = {}
        pending: dict[str, asyncio.Future[Classification]] = {}
        fresh: dict[str, tuple[Article, str]] = {}
        for article, digest, key in zip(articles, digests, keys, strict=True):
            if key in outcomes or key in pending:
                continue  # a syndicated copy in the same batch shares one judgment
            hit = self._cache.get(key)
            if hit is not None:
                self._cache.move_to_end(key)
                outcomes[key] = hit
                continue
            pending[key] = asyncio.shield(self._start(key, article))
            fresh[key] = (article, digest)

        if pending:
            done, waiting = await asyncio.wait(pending.values(), timeout=self._deadline if deadline is None else deadline)
            for key, future in pending.items():
                if future in waiting:
                    future.cancel()  # the shielded provider call still finishes and fills the cache
                    outcomes[key] = "deadline"
                    continue
                exc = future.exception()
                if exc is None:
                    outcomes[key] = future.result()
                elif isinstance(exc, ClassificationUnavailable):
                    outcomes[key] = exc.reason
                else:
                    log.error("news classification failed unexpectedly: %s", type(exc).__name__)
                    outcomes[key] = "invalid_response"

        items = tuple(
            Judged(a, o, None, d) if isinstance(o := outcomes[k], Classification) else Judged(a, None, o, d)
            for a, d, k in zip(articles, digests, keys, strict=True)
        )
        if gateway is not None:
            new_rows = [
                (key, fresh[key][1], fresh[key][0], outcome)
                for key, outcome in outcomes.items()
                if key in fresh and isinstance(outcome, Classification)
            ]
            if new_rows and job is not None:
                await self._persist(gateway, job, new_rows)
            await self.publish_capability(gateway)
        return _summary(items, version)

    # ---- provider calls ----

    def _start(self, key: str, article: Article) -> asyncio.Task[Classification]:
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._call(key, article))
            self._inflight[key] = task
            task.add_done_callback(lambda t, k=key: self._settle(k, t))  # type: ignore[misc]
        return task

    def _settle(self, key: str, task: asyncio.Task[Classification]) -> None:
        self._inflight.pop(key, None)
        if not task.cancelled():
            task.exception()  # retrieved here so an abandoned call never logs "never retrieved"

    async def _call(self, key: str, article: Article) -> Classification:
        assert self._classifier is not None
        async with self._semaphore:
            self.provider_calls += 1
            result = await self._classifier.classify_article(
                article_id=article.article_id,
                ticker=article.ticker,
                headline=article.headline,
                text=article.text,
                source=article.source,
                published_at=article.published_at.astimezone(UTC).isoformat(timespec="seconds"),
            )
        self._remember(key, result)
        return result

    def _remember(self, key: str, result: Classification) -> None:
        self._cache[key] = result
        self._cache.move_to_end(key)
        while len(self._cache) > self._cache_size:
            self._cache.popitem(last=False)

    # ---- persistence (best-effort) ----

    async def _warm(self, gateway: SpacetimeGateway, version: str) -> None:
        if self._loaded or not self._store_enabled:
            return
        async with self._load_lock:
            if self._loaded or not self._store_enabled:
                return
            try:
                rows = await gateway.worker_news_classifications()
            except GatewayContractError:
                self._store_enabled = False
                log.warning("news_classification view unavailable; classifications stay in memory (republish the module)")
                return
            except GatewayError as exc:
                log.info("stored classifications not loaded: %s", exc.code)
                return
            for row in rows:
                if row.classifier_version == version:
                    self._remember(row.cache_key, _from_row(row))
            self._loaded = True

    async def _persist(
        self, gateway: SpacetimeGateway, job: JobV1, rows: list[tuple[str, str, Article, Classification]]
    ) -> None:
        if not self._store_enabled:
            return
        now = datetime.now(UTC)
        args = [_row(key, digest, article, result, now) for key, digest, article, result in rows]
        for start in range(0, len(args), PERSIST_BATCH):
            try:
                await gateway.record_news_classifications(job.job_id, job.attempt_count, args[start : start + PERSIST_BATCH])
            except GatewayContractError:
                self._store_enabled = False
                log.warning("record_news_classifications unavailable; classifications stay in memory (republish the module)")
                return
            except GatewayError as exc:
                log.warning("classifications not stored: %s", exc.code)
                return

    async def publish_capability(self, gateway: SpacetimeGateway) -> CapabilityResult | None:
        """Publishes the classifier's verification state when it changed. Never raises."""
        capability = getattr(self._classifier, "capability", None)
        if self._classifier is None:
            result = NOT_CONFIGURED
        elif callable(capability):
            result = capability()
        else:
            return None
        state = (result.available, result.detail)
        if state == self._published:
            return result
        try:
            await gateway.publish_provider_capabilities(
                [
                    {
                        "key": result.key,
                        "provider": result.provider,
                        "capability": result.capability,
                        "available": result.available,
                        "detail": result.detail[:240],
                    }
                ]
            )
            self._published = state
        except GatewayError as exc:
            log.warning("classifier capability not published: %s", exc.code)
        return result


def _summary(items: tuple[Judged, ...], version: str | None) -> ClassifiedNews:
    failures = Counter(item.reason for item in items if item.reason is not None)
    reason = failures.most_common(1)[0][0] if failures else None
    if not failures:
        status: CoverageStatus = "classified"
    elif sum(failures.values()) == len(items):
        status = "unavailable"
    else:
        status = "partial"
    return ClassifiedNews(items, status, reason, version)
