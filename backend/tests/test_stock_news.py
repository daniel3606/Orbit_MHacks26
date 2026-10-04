"""Stock Detail news and the shared story selection: 8 candidates → Jev → best 3.

Headlines are the ones Finnhub returned for AAPL, ARM and KO on 2026-10-04
(FIXTURES). A fake classifier returns the verdicts Jev gave live, or the ones the
v2 wording is meant to produce; no network."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from typing import Any

import pytest

from app.intelligence.classifier import Classification, ClassificationUnavailable
from app.intelligence.config import QUESTION_SET_VERSION, SPECIFIC_QUESTION
from app.intelligence.service import Article, Judged, NewsClassificationService, content_hash
from app.intelligence.stock_news import StockNewsHandler
from app.intelligence.stories import best_stories, company_names
from app.workers.runner import JobFailure

NOW = datetime(2026, 10, 4, 15, 0, tzinfo=UTC)
V = "jev-news-v2:test"


def c(*, keep: bool, relevance: float, event: str = "other", sentiment: str = "neutral", materiality: str = "low") -> Classification:
    return Classification(relevance >= 0.5, relevance, event, sentiment, materiality, keep, V)  # type: ignore[arg-type]


AAPL_FEED = [
    ("How Supreme Court Battles Involving Apple, Exxon, and Intel Could Hit Your Portfolio", c(keep=False, relevance=0.21)),
    ("Micron Technology vs. Qualcomm: What Revenue Trends Tell Investors About These Tech Companies", c(keep=False, relevance=0.02)),
    ("How Cody Ko made a #1 app before graduating college", c(keep=False, relevance=0.06)),
    ("Apple to start selling its Vision headset in India next month", c(keep=True, relevance=0.97, event="product", sentiment="positive", materiality="medium")),
    ("10 Stocks to Buy Before the Year Ends", c(keep=False, relevance=0.15)),
    ("Apple faces EU fine over App Store rules", c(keep=True, relevance=0.96, event="regulation", sentiment="negative", materiality="high")),
    ("Is Apple a buy at 30 times earnings?", c(keep=False, relevance=0.85)),  # opinion, no development
    ("Apple supplier Foxconn reports record sales", c(keep=True, relevance=0.6, event="other", sentiment="positive", materiality="low")),
]


def feed(ticker: str, rows: list[tuple[str, Any]]) -> list[dict[str, str]]:
    return [
        {
            "id": f"news:{ticker}:{i}",
            "ticker": ticker,
            "headline": headline,
            "url": f"https://news.example/{ticker}/{i}",
            "source": "Yahoo" if i % 2 else "Reuters",
            "published": (NOW - timedelta(hours=2 + 5 * i)).isoformat(),
            "summary": "",
        }
        for i, (headline, _) in enumerate(rows)
    ]


class Feed:
    def __init__(self, rows: dict[str, list[dict[str, str]]] | None = None, fail: bool = False):
        self.rows = rows or {}
        self.fail = fail
        self.limits: list[int] = []

    async def news_items(self, ticker, start, end, limit=3):
        self.limits.append(limit)
        if self.fail:
            return None
        return self.rows.get(ticker, [])[:limit]


class Jev:
    version = V

    def __init__(self, verdicts: dict[str, Any], fail: str | None = None):
        self.verdicts = verdicts
        self.fail = fail
        self.calls: list[str] = []

    async def available(self) -> bool:
        return self.fail is None

    async def classify_article(self, *, article_id, ticker, headline, text, source, published_at):
        self.calls.append(headline)
        if self.fail:
            raise ClassificationUnavailable(self.fail)  # type: ignore[arg-type]
        return self.verdicts[headline]


class Gateway:
    def __init__(self, stored: list[Any] | None = None):
        self.published: list[list[Any]] = []
        self.recorded: list[list[dict[str, Any]]] = []
        self.stored = stored or []

    async def stocks(self):
        return [
            SimpleNamespace(ticker="AAPL", name="Apple Inc.", kind="equity"),
            SimpleNamespace(ticker="ARM", name="Arm Holdings plc", kind="equity"),
            SimpleNamespace(ticker="SPY", name="SPDR S&P 500", kind="benchmark"),
        ]

    async def worker_news_classifications(self):
        return self.stored

    async def record_news_classifications(self, job_id, attempt, rows):
        self.recorded.append(list(rows))

    async def publish_provider_capabilities(self, capabilities):
        return None

    async def publish_stock_news(self, args):
        self.published.append(args)


def job(ticker: str = "AAPL") -> Any:
    return SimpleNamespace(job_id=31, attempt_count=1, owner="00" * 32, payload=json.dumps({"ticker": ticker}))


def handler(news: Feed | None, jev: Jev | None) -> StockNewsHandler:
    return StockNewsHandler(news, NewsClassificationService(jev), clock=lambda: NOW)  # type: ignore[arg-type]


# ---- classifier wording (v2) ----


def test_specific_question_keeps_analysis_with_a_real_development_and_drops_listicles():
    assert QUESTION_SET_VERSION == "jev-news-v2"
    text = json.dumps(SPECIFIC_QUESTION)
    assert "even if most of the article is analysis or opinion" in text
    assert "Analysis or opinion built around that development still counts" in text
    for still_dropped in ("only opinion", "list of stocks to buy", "recap of a price move"):
        assert still_dropped in SPECIFIC_QUESTION["criteria"]["false"]  # type: ignore[index]


def test_relevance_question_is_unchanged_by_v2():
    from app.intelligence.config import RELEVANCE_QUESTION, RELEVANCE_THRESHOLD

    assert RELEVANCE_THRESHOLD == 0.5
    assert "rather than mentioning it in passing" in RELEVANCE_QUESTION["instructions"]  # type: ignore[operator]


# ---- selection ----


def judged(rows: list[tuple[str, Any]], ticker: str = "AAPL") -> list[Judged]:
    out = []
    for item in feed(ticker, rows):
        verdict = dict(rows)[item["headline"]]
        article = Article(item["id"], ticker, item["headline"], None, item["source"], datetime.fromisoformat(item["published"]))
        out.append(Judged(article, verdict, None if verdict else "provider_unavailable", content_hash(item["headline"], None)))  # type: ignore[arg-type]
    return out


def test_noisy_aapl_feed_of_eight_yields_the_three_kept_stories_newest_first():
    chosen = best_stories(judged(AAPL_FEED), NOW, fill_unclassified=True)
    assert [j.article.headline for j in chosen] == [
        "Apple to start selling its Vision headset in India next month",
        "Apple faces EU fine over App Store rules",
        "Apple supplier Foxconn reports record sales",
    ]


def test_ranking_prefers_relevant_material_recent_stories_when_more_than_three_survive():
    rows = [(f"Apple development {i}", c(keep=True, relevance=0.9, materiality="low")) for i in range(4)]
    rows.append(("Apple announces a $100B buyback", c(keep=True, relevance=0.98, event="financing", materiality="critical")))
    headlines = [j.article.headline for j in best_stories(judged(rows), NOW, fill_unclassified=False)]
    assert len(headlines) == 3 and "Apple announces a $100B buyback" in headlines  # oldest, but critical
    assert "Apple development 3" not in headlines  # the oldest low-materiality story drops out


def test_syndicated_copies_count_once():
    rows = [("Apple faces EU fine over App Store rules", c(keep=True, relevance=0.96, materiality="high"))]
    items = judged(rows) + judged(rows)
    assert len(best_stories(items, NOW, fill_unclassified=False)) == 1


def test_unclassified_stories_fill_only_with_headlines_that_name_the_company():
    rows = [("Apple faces EU fine", None), ("Ten AI stocks to watch", None), ("Apple opens store in Mumbai", None)]
    chosen = best_stories(judged(rows), NOW, fill_unclassified=True, names=["Apple"])
    assert [j.article.headline for j in chosen] == ["Apple faces EU fine", "Apple opens store in Mumbai"]
    assert all(j.classification is None for j in chosen)  # never given a label
    assert best_stories(judged(rows), NOW, fill_unclassified=False) == []


def test_company_names_drop_legal_suffixes_and_keep_curated_brands():
    assert company_names("Apple Inc.") == ["Apple"]
    assert company_names("Arm Holdings plc") == ["Arm"]
    assert company_names("Alphabet Inc. Class A", ["Google"]) == ["Google", "Alphabet"]


# ---- the stock_news job ----


async def test_stock_detail_gets_relevant_news_for_a_company_not_in_discovery():
    news = Feed({"AAPL": feed("AAPL", AAPL_FEED)})
    jev = Jev(dict(AAPL_FEED))
    gateway = Gateway()
    await handler(news, jev).run(job(), gateway)  # type: ignore[arg-type]
    assert news.limits == [8] and len(jev.calls) == 8
    ((job_id, attempt, ticker, stories, label, version),) = gateway.published
    assert (job_id, attempt, ticker, label, version) == (31, 1, "AAPL", "classified", V)
    assert [s["headline"] for s in stories] == [h for h, v in AAPL_FEED if v.keep]
    by_headline = {item["headline"]: item["url"] for item in feed("AAPL", AAPL_FEED)}
    assert all(s["url"] == by_headline[s["headline"]] for s in stories)  # tap opens that story's own link
    assert set(stories[0]) == {"headline", "source", "url", "published_at"}  # no labels or probabilities


async def test_analysis_article_with_a_concrete_development_survives():
    arm = [
        ("Will Selling Chips Strengthen Arm's Moat or Put It at Risk?", c(keep=True, relevance=0.98, event="product", materiality="high")),
        ("Synopsys (SNPS) Has a Strong Design Business. Is Its Growth Worth the Premium?", c(keep=False, relevance=0.02)),
        ("If I Were Building a Portfolio From Scratch, I'd Anchor It With This Stock", c(keep=False, relevance=0.3)),
    ]
    gateway = Gateway()
    await handler(Feed({"ARM": feed("ARM", arm)}), Jev(dict(arm))).run(job("ARM"), gateway)  # type: ignore[arg-type]
    stories = gateway.published[0][3]
    assert [s["headline"] for s in stories] == ["Will Selling Chips Strengthen Arm's Moat or Put It at Risk?"]


async def test_no_relevant_news_publishes_an_empty_list():
    noise = [row for row in AAPL_FEED if not row[1].keep]
    gateway = Gateway()
    await handler(Feed({"AAPL": feed("AAPL", noise)}), Jev(dict(noise))).run(job(), gateway)  # type: ignore[arg-type]
    assert gateway.published[0][3] == [] and gateway.published[0][4] == "classified"


async def test_duplicate_requests_reuse_stored_classifications():
    news = Feed({"AAPL": feed("AAPL", AAPL_FEED)})
    jev = Jev(dict(AAPL_FEED))
    service = NewsClassificationService(jev)  # type: ignore[arg-type]
    first, second = Gateway(), Gateway()
    await StockNewsHandler(news, service, clock=lambda: NOW).run(job(), first)  # type: ignore[arg-type]
    await StockNewsHandler(news, service, clock=lambda: NOW).run(job(), second)  # type: ignore[arg-type]
    assert len(jev.calls) == 8  # second run: every judgment from the cache, nothing billed
    assert first.published[0][3] == second.published[0][3]
    assert len(first.recorded) == 1 and second.recorded == []


async def test_jev_unavailable_shows_unlabeled_headlines_that_name_the_company():
    gateway = Gateway()
    await handler(Feed({"AAPL": feed("AAPL", AAPL_FEED)}), Jev(dict(AAPL_FEED), fail="provider_unavailable")).run(job(), gateway)  # type: ignore[arg-type]
    (_, _, _, stories, label, _) = gateway.published[0]
    assert label == "unavailable:provider_unavailable"
    headlines = [s["headline"] for s in stories]
    assert len(headlines) == 3 and all("Apple" in h for h in headlines)
    assert "How Cody Ko made a #1 app before graduating college" not in headlines
    assert gateway.recorded == []  # nothing stored as a judgment


async def test_without_jev_configured_the_label_says_so():
    gateway = Gateway()
    await handler(Feed({"AAPL": feed("AAPL", AAPL_FEED)}), None).run(job(), gateway)
    assert gateway.published[0][4] == "not_configured" and gateway.published[0][5] == ""


async def test_failed_news_call_retries_and_keeps_the_previous_row():
    gateway = Gateway()
    with pytest.raises(JobFailure) as failure:
        await handler(Feed(fail=True), Jev({})).run(job(), gateway)  # type: ignore[arg-type]
    assert (failure.value.code, failure.value.retryable) == ("news_unavailable", True)
    assert gateway.published == []


@pytest.mark.parametrize(("payload", "code"), [(json.dumps({"ticker": "SPY"}), "unknown_ticker"), ("{}", "invalid_job_payload")])
async def test_bad_jobs_fail_without_retry(payload, code):
    with pytest.raises(JobFailure) as failure:
        await handler(Feed(), Jev({})).run(SimpleNamespace(job_id=1, attempt_count=1, owner="0", payload=payload), Gateway())  # type: ignore[arg-type]
    assert (failure.value.code, failure.value.retryable) == (code, False)


async def test_non_https_links_are_never_published():
    rows = [("Apple faces EU fine over App Store rules", c(keep=True, relevance=0.96, materiality="high"))]
    items = feed("AAPL", rows)
    items[0]["url"] = "http://insecure.example/story"
    gateway = Gateway()
    await handler(Feed({"AAPL": items}), Jev(dict(rows))).run(job(), gateway)  # type: ignore[arg-type]
    assert gateway.published[0][3] == []
