"""`stock_news` job: recent, relevant news for one company on Stock Detail.

    up to 8 Finnhub headlines → Jev (cached and stored judgments reused)
    → best 3 kept stories → `publish_stock_news` (replaces the ticker's row and
    completes the job in one transaction)

The phone only calls `request_stock_news`; Finnhub and Jev keys stay here. The
row holds headline, publisher, link and time: no labels, scores or probabilities.
When Jev cannot judge, headlines that name the company are shown unlabeled and
the row records why (`unavailable:<reason>`). A failed Finnhub call fails the job
and leaves the previous row in place.
"""

import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from app.discovery.themes import ThemeConfig, load_themes
from app.intelligence.service import Article, NewsClassificationService
from app.intelligence.stories import CANDIDATES, SHOWN, best_stories, company_names
from app.state.dto import JobV1
from app.state.gateway import ReducerRejected, SpacetimeGateway
from app.state.sats_json import timestamp_arg
from app.workers.runner import Committed, JobFailure

log = logging.getLogger(__name__)

WINDOW_DAYS = 7
CLASSIFY_SECONDS = 8.0


class NewsSource(Protocol):
    async def news_items(
        self, ticker: str, start: date, end: date, limit: int = 3
    ) -> list[dict[str, str]] | None: ...


def _ticker(raw: str) -> str:
    try:
        ticker = json.loads(raw)["ticker"]
    except (ValueError, KeyError, TypeError) as exc:
        raise JobFailure("invalid_job_payload", retryable=False) from exc
    if not isinstance(ticker, str) or not ticker:
        raise JobFailure("invalid_job_payload", retryable=False)
    return ticker


def _article(item: dict[str, str]) -> Article | None:
    try:
        published = datetime.fromisoformat(item["published"])
    except (KeyError, ValueError):
        return None
    if not item.get("url", "").startswith("https://"):
        return None  # the phone opens only https links
    return Article(
        article_id=item["id"],
        ticker=item["ticker"],
        headline=item["headline"],
        text=item.get("summary") or None,
        source=item["source"],
        published_at=published,
    )


class StockNewsHandler:
    kind = "stock_news"
    lease_seconds = 45

    def __init__(
        self,
        news: NewsSource | None,
        classification: NewsClassificationService,
        themes: ThemeConfig | None = None,
        *,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._news = news
        self._classification = classification
        self._themes = themes or load_themes()
        self._clock = clock

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        ticker = _ticker(job.payload)
        stock = next((row for row in await gateway.stocks() if row.ticker == ticker), None)
        if stock is None or stock.kind != "equity":
            raise JobFailure("unknown_ticker", retryable=False)
        if self._news is None:
            raise JobFailure("news_not_configured", retryable=False)
        now = self._clock()
        rows = await self._news.news_items(ticker, now.date() - timedelta(days=WINDOW_DAYS), now.date(), CANDIDATES)
        if rows is None:
            raise JobFailure("news_unavailable", retryable=True)
        by_id = {row["id"]: row for row in rows}
        articles = [a for a in (_article(row) for row in rows) if a is not None]
        judged = await self._classification.classify(articles, gateway=gateway, job=job, deadline=CLASSIFY_SECONDS)
        curated = self._themes.companies.get(ticker)
        names = company_names(stock.name, curated.names if curated else ())
        chosen = best_stories(judged.items, now, limit=SHOWN, fill_unclassified=True, names=names)
        stories: list[dict[str, Any]] = [
            {
                "headline": item.article.headline[:180],
                "source": (item.article.source or "Finnhub")[:80],
                "url": by_id[item.article.article_id]["url"],
                "published_at": timestamp_arg(min(item.article.published_at, now)),
            }
            for item in chosen
        ]
        label = judged.label()
        try:
            await gateway.publish_stock_news(
                [job.job_id, job.attempt_count, ticker, stories, label, judged.classifier_version or ""]
            )
        except ReducerRejected as exc:
            if exc.code in ("unknown_ticker", "ticker_mismatch"):
                raise JobFailure(exc.code, retryable=False) from exc
            raise
        log.info("stock news %s: %d candidates → %d shown classification=%s", ticker, len(articles), len(stories), label)
        return Committed(f"news={ticker};stories={len(stories)};classification={label}")
