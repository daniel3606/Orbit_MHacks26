"""`daily_discovery` job: today's theme → candidates → ranking → one atomic publish.

Reads only published state (stock, quote, Trend Score rows) plus this person's
own profile and recent discoveries, and asks the provider for company news.
Each step degrades on its own: a failed news call drops the news component, a
missing quote skips that company, and a theme without enough priced companies
hands over to the next theme in today's order.

Jev never changes a score here. After ranking, it judges each pick's newest
headlines, and the card shows the newest one Jev kept as being about that
company. Without classification the headline stays the newest one that names
the company (the rule before Jev), and the item records why in
`news_classification`.
"""

import asyncio
import dataclasses
import json
import logging
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol

from app.discovery.config import (
    ALGORITHM_VERSION,
    CLASSIFY_STORIES_PER_PICK,
    CLASSIFY_TIMEOUT_SECONDS,
    MIN_ITEMS,
    NEWS_MAX_ITEMS,
    NEWS_TIMEOUT_SECONDS,
    NEWS_WINDOW_DAYS,
)
from app.discovery.rotation import PastTheme, ThemePick, ordered_themes
from app.discovery.scoring import (
    Candidate,
    DiscoveryPick,
    MarketFacts,
    NewsFacts,
    NewsStory,
    ProfileTraits,
    ThemeRanking,
    rank_theme,
    recent_stories,
    relevant,
)
from app.discovery.themes import ZODIAC_SIGNS, ThemeConfig, load_themes
from app.intelligence.service import Article, ClassifiedNews, NewsClassificationService
from app.state.dto import (
    DailyDiscoveryItemV1,
    InvestmentProfileV1,
    JobV1,
    MarketGenerationV1,
    MarketQuoteV1,
    StockV1,
    TrendSignalV1,
)
from app.state.gateway import ReducerRejected, SpacetimeGateway
from app.state.sats_json import option, timestamp_arg
from app.workers.runner import Committed, JobFailure

log = logging.getLogger(__name__)


class NewsSource(Protocol):
    async def news_items(
        self, ticker: str, start: date, end: date, limit: int = 3
    ) -> list[dict[str, str]] | None: ...


def parse_payload(raw: str) -> tuple[date, str | None]:
    try:
        body = json.loads(raw)
        day = date.fromisoformat(body["date"])
    except (ValueError, KeyError, TypeError) as exc:
        raise JobFailure("invalid_job_payload", retryable=False) from exc
    zodiac = body.get("zodiac")
    return day, zodiac if isinstance(zodiac, str) and zodiac in ZODIAC_SIGNS else None


def profile_traits(row: InvestmentProfileV1 | None) -> ProfileTraits | None:
    if row is None:
        return None
    return ProfileTraits(
        risk_tolerance=row.risk_tolerance,
        investment_horizon=row.investment_horizon,
        investment_style=row.investment_style,
        sector_interests=tuple(row.sector_interests),
        experience_level=row.experience_level,
        primary_goal=row.primary_goal,
    )


def market_facts(
    stock: StockV1,
    quote: MarketQuoteV1 | None,
    signal: TrendSignalV1 | None,
    market: MarketGenerationV1 | None,
) -> MarketFacts:
    trend_score: float | None = None
    rel_z: float | None = None
    if signal is not None and signal.status == "published" and market is not None and signal.generation == market.generation:
        trend_score = signal.trend_score
        feature = next((f for f in signal.features if f.name == "relative_momentum"), None)
        if feature is not None and feature.available:
            rel_z = feature.normalized
    valid_quote = quote is not None and quote.price_micros > 0 and quote.previous_close_micros > 0
    return MarketFacts(
        sector=stock.sector,
        price=quote.price_micros / 1_000_000 if valid_quote and quote else None,
        previous_close=quote.previous_close_micros / 1_000_000 if valid_quote and quote else None,
        trend_score=trend_score,
        relative_momentum_z=rel_z,
    )


def last_seen_by_ticker(items: list[DailyDiscoveryItemV1], today: date) -> dict[str, date]:
    seen: dict[str, date] = {}
    for item in items:
        shown = date.fromisoformat(item.discovery_date)
        if shown >= today:
            continue
        if item.ticker not in seen or shown > seen[item.ticker]:
            seen[item.ticker] = shown
    return seen


def _story(item: dict[str, str]) -> NewsStory | None:
    try:
        published = datetime.fromisoformat(item["published"])
    except (KeyError, ValueError):
        return None
    return NewsStory(
        headline=item["headline"],
        source=item["source"],
        url=item["url"],
        published=published,
        article_id=item.get("id", ""),
        summary=item.get("summary") or None,
    )


def _article(ticker: str, story: NewsStory) -> Article:
    return Article(
        article_id=story.article_id or f"news:{ticker}:{int(story.published.timestamp())}",
        ticker=ticker,
        headline=story.headline,
        text=story.summary,
        source=story.source,
        published_at=story.published,
    )


def choose_headline(stories: list[NewsStory], judged: ClassifiedNews, ticker: str) -> tuple[NewsStory | None, str]:
    """The newest story Jev kept for this company, and the coverage label.

    Stories Jev judged off-topic or not specific are skipped. Without any
    classification the newest story stays (the rule before Jev). With partial
    coverage, an unclassified story is used only when no classified one was kept."""
    if not stories:
        return None, "no_articles"
    if judged.status in ("unavailable", "not_configured"):
        return stories[0], judged.label()
    by_id = {item.article.article_id: item for item in judged.items}
    fallback: NewsStory | None = None
    for story in stories:
        item = by_id.get(_article(ticker, story).article_id)
        if item is None or item.classification is None:
            fallback = fallback or story
            continue
        if item.classification.keep:
            return story, judged.label()
    return fallback, judged.label()


def item_arg(pick: DiscoveryPick, news_classification: str = "not_configured") -> dict[str, Any]:
    headline = pick.headline if pick.headline is not None and pick.headline.url.startswith("https://") else None
    return {
        "ticker": pick.ticker,
        "rank": pick.rank,
        "score": round(pick.score, 6),
        "trend_score": option(pick.components.get("trend")),
        "fit_score": option(pick.components.get("personal_fit")),
        "news_score": option(pick.components.get("news")),
        "momentum_score": option(pick.components.get("momentum")),
        "novelty_score": pick.components["novelty"],
        "angle": pick.angle,
        "about": pick.about,
        "reasons": list(pick.reasons),
        "news_count": pick.news_count,
        "news_headline": option(headline.headline if headline else None),
        "news_source": option(headline.source if headline else None),
        "news_url": option(headline.url if headline else None),
        "news_published_at": option(timestamp_arg(headline.published) if headline else None),
        "news_classification": news_classification,
    }


class DailyDiscoveryHandler:
    kind = "daily_discovery"
    lease_seconds = 60

    def __init__(
        self,
        news: NewsSource | None,
        themes: ThemeConfig | None = None,
        *,
        classification: NewsClassificationService | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ):
        self._news = news
        self._themes = themes or load_themes()
        self._classification = classification or NewsClassificationService(None)
        self._clock = clock

    async def _news_for(self, ticker: str, day: date) -> NewsFacts:
        if self._news is None:
            return NewsFacts(available=False)
        start = day - timedelta(days=NEWS_WINDOW_DAYS)
        try:
            rows = await asyncio.wait_for(
                self._news.news_items(ticker, start, day + timedelta(days=1), NEWS_MAX_ITEMS),
                timeout=NEWS_TIMEOUT_SECONDS,
            )
        except Exception:  # noqa: BLE001 - news is optional (timeouts included); never fail the set over it
            log.info("discovery news unavailable for %s", ticker)
            return NewsFacts(available=False)
        if rows is None:
            return NewsFacts(available=False)
        stories = tuple(story for story in (_story(row) for row in rows) if story is not None)
        return NewsFacts(available=True, stories=stories)

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        day, zodiac = parse_payload(job.payload)
        history = [row for row in await gateway.worker_discovery_history() if row.owner == job.owner]
        if any(row.discovery_date == day.isoformat() for row in history):
            raise JobFailure("discovery_exists", retryable=False)

        profile_row: InvestmentProfileV1 | None = None
        if job.input_version > 0:
            profiles = await gateway.worker_job_profiles()
            profile_row = next((row for row in profiles if row.owner == job.owner), None)
            if profile_row is None or profile_row.profile_version < job.input_version:
                raise JobFailure("profile_not_visible", retryable=True)
        profile = profile_traits(profile_row)

        items = [row for row in await gateway.worker_discovery_items() if row.owner == job.owner]
        seen = last_seen_by_ticker(items, day)
        market = await gateway.market_generation()
        stocks = {row.ticker: row for row in await gateway.stocks() if row.active and row.kind == "equity"}
        quotes = {row.ticker: row for row in await gateway.market_quotes()}
        signals = {row.ticker: row for row in await gateway.trend_signals()}
        past = [
            PastTheme(date.fromisoformat(row.discovery_date), row.sector_id, row.subtheme_id) for row in history
        ]

        best: tuple[ThemePick, ThemeRanking, dict[str, NewsFacts]] | None = None
        for pick in ordered_themes(self._themes, zodiac, day, past):
            ranked = await self._rank(pick, day, profile, stocks, quotes, signals, market, seen, has_history=bool(items))
            if ranked is None:
                continue
            ranking, news_by_ticker = ranked
            if len(ranking.picks) >= MIN_ITEMS:
                best = (pick, ranking, news_by_ticker)
                break
            if best is None or len(ranking.picks) > len(best[1].picks):
                best = (pick, ranking, news_by_ticker)
        if best is None or not best[1].picks:
            raise JobFailure("no_discovery_candidates", retryable=True)

        pick, ranking, news_by_ticker = best
        picks, coverage = await self._headlines(ranking.picks, news_by_ticker, job, gateway)
        sector = self._themes.sectors[pick.sector_id]
        sub = self._themes.subthemes[pick.subtheme_id]
        args = [
            job.job_id,
            job.attempt_count,
            day.isoformat(),
            option(zodiac),
            pick.sector_id,
            sector.name,
            pick.subtheme_id,
            sub.title,
            sub.description,
            ALGORITHM_VERSION,
            self._themes.version,
            market.generation if market else 0,
            ranking.considered,
            ranking.eligible,
            [item_arg(p, coverage[p.ticker]) for p in picks],
        ]
        try:
            await gateway.publish_daily_discovery(args)
        except ReducerRejected as exc:
            if exc.code == "discovery_exists":
                raise JobFailure(exc.code, retryable=False) from exc
            raise
        log.info(
            "discovery %s for %s…: %s (%s) → %s classification=%s",
            day,
            job.owner[:10],
            pick.subtheme_id,
            zodiac or "no sign",
            ", ".join(p.ticker for p in ranking.picks),
            ",".join(f"{p.ticker}:{coverage[p.ticker]}" for p in picks),
        )
        return Committed(f"discovery={day.isoformat()};theme={pick.subtheme_id};count={len(ranking.picks)}")

    async def _headlines(
        self,
        picks: tuple[DiscoveryPick, ...],
        news_by_ticker: dict[str, NewsFacts],
        job: JobV1,
        gateway: SpacetimeGateway,
    ) -> tuple[list[DiscoveryPick], dict[str, str]]:
        """Classifies each pick's newest stories in one batch and picks the headline to show."""
        now = self._clock()
        recent = {
            p.ticker: recent_stories(news_by_ticker[p.ticker], now)[:CLASSIFY_STORIES_PER_PICK]
            if news_by_ticker[p.ticker].available
            else []
            for p in picks
        }
        articles = [_article(ticker, story) for ticker, stories in recent.items() for story in stories]
        judged = await self._classification.classify(
            articles, gateway=gateway, job=job, deadline=CLASSIFY_TIMEOUT_SECONDS
        )
        chosen: list[DiscoveryPick] = []
        coverage: dict[str, str] = {}
        for p in picks:
            headline, coverage[p.ticker] = choose_headline(recent[p.ticker], judged.for_ticker(p.ticker), p.ticker)
            chosen.append(dataclasses.replace(p, headline=headline))
        return chosen, coverage

    async def _rank(
        self,
        pick: ThemePick,
        day: date,
        profile: ProfileTraits | None,
        stocks: dict[str, StockV1],
        quotes: dict[str, MarketQuoteV1],
        signals: dict[str, TrendSignalV1],
        market: MarketGenerationV1 | None,
        seen: dict[str, date],
        *,
        has_history: bool,
    ) -> tuple[ThemeRanking, dict[str, NewsFacts]] | None:
        sub = self._themes.subthemes[pick.subtheme_id]
        listed = [c for c in sub.companies if c.ticker in stocks]
        facts = {c.ticker: market_facts(stocks[c.ticker], quotes.get(c.ticker), signals.get(c.ticker), market) for c in listed}
        priced = [c for c in listed if facts[c.ticker].price is not None]
        if not priced:
            return None
        # News is fetched only for companies that can actually be shown.
        news = await asyncio.gather(*(self._news_for(c.ticker, day) for c in priced))
        candidates = [
            Candidate(
                ticker=c.ticker,
                name=stocks[c.ticker].name,
                angle=c.angle,
                traits=self._themes.companies[c.ticker],
                market=facts[c.ticker],
                news=relevant(n, self._themes.companies[c.ticker].names),
                last_seen=seen.get(c.ticker),
            )
            for c, n in zip(priced, news, strict=True)
        ]
        ranking = rank_theme(candidates, profile, title=sub.title, today=day, now=self._clock(), has_history=has_history)
        skipped = len(sub.companies) - len(priced)
        return ThemeRanking(
            picks=ranking.picks,
            considered=len(sub.companies),
            eligible=ranking.eligible,
            exclusions={**ranking.exclusions, **({"_unpriced": str(skipped)} if skipped else {})},
        ), {c.ticker: c.news for c in candidates}
