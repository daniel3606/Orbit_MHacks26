"""Daily Discovery: theme rotation, ranking, history, and graceful degradation.

Everything here is deterministic. The handler tests use an in-memory gateway
that returns the same DTOs the SpacetimeDB views return.
"""

import json
import re
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest

from app.config.universe import load_universe
from app.discovery.config import (
    DIVERSITY_GAP,
    MAX_SECTOR_REPEATS,
    NOVELTY_FRESH,
    NOVELTY_MONTH,
    NOVELTY_RECENT,
    SCORE_WEIGHTS,
    THEME_WINDOW_DAYS,
    TOP_N,
)
from app.discovery.handler import DailyDiscoveryHandler, parse_payload
from app.discovery.rotation import PastTheme, daily_order, ordered_themes
from app.discovery.scoring import (
    Candidate,
    MarketFacts,
    NewsFacts,
    NewsStory,
    ProfileTraits,
    novelty,
    rank_theme,
    score_candidate,
    weights_for,
)
from app.discovery.themes import ZODIAC_SIGNS, CompanyTraits, load_themes
from app.state.dto import (
    DailyDiscoveryItemV1,
    DailyDiscoveryV1,
    InvestmentProfileV1,
    JobV1,
    MarketGenerationV1,
    MarketQuoteV1,
    SignalFeatureV1,
    StockV1,
    TrendSignalV1,
)
from app.state.gateway import ReducerRejected
from app.workers.runner import JobFailure

TODAY = date(2026, 10, 4)
NOW = datetime(2026, 10, 4, 15, 0, tzinfo=UTC)
THEMES = load_themes()

CONSERVATIVE = ProfileTraits("conservative", "years", "value", ("utilities",), "new", "learn_basics")
AGGRESSIVE = ProfileTraits("aggressive", "weeks", "growth", ("technology",), "experienced", "follow_trends")


def traits(risk: str = "medium", character: str = "established", size: str = "large", familiarity: str = "high") -> CompanyTraits:
    return CompanyTraits(names=["Test Co"], size=size, risk=risk, familiarity=familiarity, character=character, about="Makes things.")  # type: ignore[arg-type]


def market(price: float | None = 100.0, prev: float | None = 100.0, trend: float | None = 50.0, z: float | None = 0.0, sector: str = "technology") -> MarketFacts:
    return MarketFacts(sector=sector, price=price, previous_close=prev, trend_score=trend, relative_momentum_z=z)


def cand(ticker: str, angle: str = "Angle", t: CompanyTraits | None = None, m: MarketFacts | None = None, news: NewsFacts | None = None, last_seen: date | None = None) -> Candidate:
    return Candidate(
        ticker=ticker,
        name=f"{ticker} Inc",
        angle=angle,
        traits=t or traits(),
        market=m or market(),
        news=news if news is not None else NewsFacts(available=True),
        last_seen=last_seen,
    )


# ---- configuration ----


def test_every_sign_maps_to_valid_sectors_and_every_ticker_is_in_the_universe() -> None:
    universe = {e.ticker for e in load_universe().equities}
    assert sorted(THEMES.zodiac) == sorted(ZODIAC_SIGNS)
    for sign in ZODIAC_SIGNS:
        assert len(THEMES.sectors_for(sign)) == 4
    for sub in THEMES.subthemes.values():
        assert len(sub.companies) >= 4
        assert {c.ticker for c in sub.companies} <= universe


# ---- rotation ----


def test_same_date_and_sign_always_resolve_to_the_same_theme() -> None:
    for sign in ZODIAC_SIGNS:
        first = ordered_themes(THEMES, sign, TODAY, [])
        assert first == ordered_themes(THEMES, sign, TODAY, [])
        assert first[0].sector_id in THEMES.zodiac[sign]


def test_dates_rotate_through_a_signs_themes() -> None:
    for sign in ZODIAC_SIGNS:
        picks = [ordered_themes(THEMES, sign, TODAY + timedelta(days=d), [])[0] for d in range(30)]
        sectors = {p.sector_id for p in picks}
        assert sectors == set(THEMES.zodiac[sign]), sign  # every sector shows up within a month
        changes = sum(1 for a, b in zip(picks, picks[1:], strict=False) if a != b)
        assert changes >= 15, sign  # not stuck on one theme


def test_rotation_is_not_a_plain_sequence() -> None:
    picks = [daily_order(THEMES, "aquarius", TODAY + timedelta(days=d))[0].sector_id for d in range(20)]
    cycle = THEMES.zodiac["aquarius"]
    sequential = all(cycle.index(b) == (cycle.index(a) + 1) % len(cycle) for a, b in zip(picks, picks[1:], strict=False))
    assert not sequential


def test_different_signs_do_not_share_one_daily_theme() -> None:
    for offset in range(14):
        day = TODAY + timedelta(days=offset)
        themes = {ordered_themes(THEMES, sign, day, [])[0].subtheme_id for sign in ZODIAC_SIGNS}
        assert len(themes) >= 6, day


def test_history_prevents_repeats_over_a_simulated_month() -> None:
    for sign in ZODIAC_SIGNS:
        history: list[PastTheme] = []
        for offset in range(40):
            day = TODAY + timedelta(days=offset)
            pick = ordered_themes(THEMES, sign, day, history)[0]
            if history:
                assert pick.subtheme_id != history[-1].subtheme_id, (sign, day)
            window = [h for h in history if h.day >= day - timedelta(days=THEME_WINDOW_DAYS)]
            assert sum(1 for h in window if h.sector_id == pick.sector_id) < MAX_SECTOR_REPEATS, (sign, day)
            history.append(PastTheme(day, pick.sector_id, pick.subtheme_id))


def test_missing_zodiac_uses_the_neutral_pool() -> None:
    pick = ordered_themes(THEMES, None, TODAY, [])[0]
    assert pick.sector_id in THEMES.fallback_sectors
    assert parse_payload(json.dumps({"date": "2026-10-04", "zodiac": None})) == (TODAY, None)
    assert parse_payload(json.dumps({"date": "2026-10-04", "zodiac": "not-a-sign"})) == (TODAY, None)


# ---- scoring ----


def test_different_profiles_rank_the_same_theme_differently() -> None:
    steady = cand("STDY", "Utilities", traits(risk="lower", character="established", size="mega"), market(sector="utilities"))
    rocket = cand("RCKT", "Rockets", traits(risk="higher", character="emerging", size="mid", familiarity="low"))
    both = [steady, rocket]
    calm = rank_theme(both, CONSERVATIVE, title="Test", today=TODAY, now=NOW, has_history=False)
    bold = rank_theme(both, AGGRESSIVE, title="Test", today=TODAY, now=NOW, has_history=False)
    assert calm.picks[0].ticker == "STDY"
    assert bold.picks[0].ticker == "RCKT"


def test_recently_seen_company_ranks_below_an_otherwise_identical_new_one() -> None:
    fresh = score_candidate(cand("NEW"), CONSERVATIVE, TODAY, NOW)
    for days_ago in (1, 7, 20):
        seen = score_candidate(cand("OLD", last_seen=TODAY - timedelta(days=days_ago)), CONSERVATIVE, TODAY, NOW)
        assert seen.score < fresh.score
    assert novelty(TODAY - timedelta(days=3), TODAY) == NOVELTY_RECENT
    assert novelty(TODAY - timedelta(days=7), TODAY) == NOVELTY_RECENT
    assert novelty(TODAY - timedelta(days=8), TODAY) == NOVELTY_MONTH
    assert novelty(TODAY - timedelta(days=31), TODAY) == NOVELTY_FRESH
    assert novelty(None, TODAY) == NOVELTY_FRESH


def test_last_weeks_companies_are_held_back_while_new_ones_remain() -> None:
    strong_but_seen = [
        cand(f"S{i}", f"A{i}", m=market(trend=95, z=2.5), last_seen=TODAY - timedelta(days=2)) for i in range(3)
    ]
    weaker_new = [cand(f"N{i}", f"B{i}", m=market(trend=30)) for i in range(3)]
    ranking = rank_theme(strong_but_seen + weaker_new, CONSERVATIVE, title="Test", today=TODAY, now=NOW, has_history=True)
    assert {p.ticker for p in ranking.picks} == {"N0", "N1", "N2"}

    short = rank_theme(strong_but_seen + weaker_new[:1], CONSERVATIVE, title="Test", today=TODAY, now=NOW, has_history=True)
    assert short.picks[0].ticker == "N0"  # the new name still comes first
    assert len(short.picks) == TOP_N  # the theme is filled from last week's names only when it runs short


def test_a_close_new_angle_beats_a_third_card_from_the_same_angle() -> None:
    solar = [cand(f"SOL{i}", "Solar", m=market(trend=80 - i)) for i in range(3)]
    nuclear = cand("NUKE", "Nuclear", m=market(trend=74))
    ranking = rank_theme([*solar, nuclear], None, title="Powering the Future", today=TODAY, now=NOW, has_history=False)
    angles = [p.angle for p in ranking.picks]
    assert "Nuclear" in angles and angles.count("Solar") == 2

    far = cand("FAR", "Grid", m=market(trend=5, z=-3, price=90, prev=100))
    gap_ranking = rank_theme([*solar, far], None, title="Test", today=TODAY, now=NOW, has_history=False)
    best_solar = max(p.score for p in gap_ranking.picks if p.angle == "Solar")
    far_score = score_candidate(far, None, TODAY, NOW).score
    if best_solar - far_score > DIVERSITY_GAP:
        assert "FAR" not in {p.ticker for p in gap_ranking.picks}


def test_missing_news_is_left_out_not_counted_as_zero() -> None:
    no_news = score_candidate(cand("A", news=NewsFacts(available=False)), CONSERVATIVE, TODAY, NOW)
    assert no_news.components["news"] is None
    assert 0.0 <= no_news.score <= 1.0
    empty = score_candidate(cand("B", news=NewsFacts(available=True)), CONSERVATIVE, TODAY, NOW)
    assert empty.components["news"] == 0.0
    assert no_news.score > empty.score  # an outage is neutral; a checked "no stories" is low


def test_news_counts_recent_stories_and_ignores_old_ones() -> None:
    story = lambda hours: NewsStory("Headline", "Source", "https://example.com/a", NOW - timedelta(hours=hours))  # noqa: E731
    busy = score_candidate(cand("A", news=NewsFacts(True, (story(1), story(5), story(20)))), None, TODAY, NOW)
    stale = score_candidate(cand("B", news=NewsFacts(True, (story(24 * 10),))), None, TODAY, NOW)
    assert busy.news_count == 3 and busy.components["news"] is not None and busy.components["news"] > 0.5
    assert stale.news_count == 0 and stale.components["news"] == 0.0


def test_missing_quote_skips_that_company_only() -> None:
    ranking = rank_theme(
        [cand("NOQ", m=market(price=None, prev=None)), cand("A", "x"), cand("B", "y"), cand("C", "z")],
        None,
        title="Test",
        today=TODAY,
        now=NOW,
        has_history=False,
    )
    assert "NOQ" not in {p.ticker for p in ranking.picks}
    assert ranking.exclusions == {"NOQ": "quote_unavailable"}
    assert len(ranking.picks) == 3


def test_missing_profile_scores_without_personal_fit() -> None:
    scored = score_candidate(cand("A"), None, TODAY, NOW)
    assert scored.components["personal_fit"] is None
    assert weights_for(None) == SCORE_WEIGHTS


def test_horizon_shifts_keep_weights_summing_to_one() -> None:
    for horizon in ("weeks", "months", "years"):
        profile = replace(CONSERVATIVE, investment_horizon=horizon)
        assert sum(weights_for(profile).values()) == pytest.approx(1.0)
    assert weights_for(replace(CONSERVATIVE, investment_horizon="weeks"))["momentum"] > SCORE_WEIGHTS["momentum"]


BANNED = re.compile(r"\b(will|guarantee|likely|outperform|buy|sell|winner|best investment|go up|rise)\b", re.I)


def test_reasons_are_short_factual_and_never_predictive() -> None:
    story = NewsStory("Headline", "Source", "https://example.com", NOW - timedelta(hours=2))
    cases = [
        cand("A", m=market(trend=90, price=104, prev=100), news=NewsFacts(True, (story, story, story))),
        cand("B", t=traits(risk="lower", size="mega"), m=market(sector="utilities")),
        cand("C", t=traits(risk="higher", character="emerging", familiarity="low")),
    ]
    for profile in (CONSERVATIVE, AGGRESSIVE, None):
        ranking = rank_theme(cases, profile, title="The Data Economy", today=TODAY, now=NOW, has_history=True)
        for pick in ranking.picks:
            assert 1 <= len(pick.reasons) <= 2
            for line in pick.reasons:
                assert len(line) <= 90
                assert not BANNED.search(line), line
                assert "The Data Economy theme" not in line  # reads "today's Data Economy theme"


def test_every_configured_reason_fits_the_module_limits() -> None:
    for sub in THEMES.subthemes.values():
        for c in sub.companies:
            assert len(c.angle) <= 40
        assert len(f"Strong recent activity in today's {sub.title} theme") <= 90
    for company in THEMES.companies.values():
        assert not BANNED.search(company.about), company.about


# ---- handler ----


def _job(payload: dict[str, Any], input_version: int = 1) -> JobV1:
    return JobV1(
        job_id=7,
        owner="ab" * 32,
        kind="daily_discovery",
        request_key="discovery:2026-10-04:1",
        input_version=input_version,
        status="running",
        attempt_count=1,
        max_attempts=5,
        lease_owner="cd" * 32,
        lease_until=NOW + timedelta(minutes=1),
        available_at=NOW,
        payload=json.dumps(payload),
        result_ref=None,
        error_code=None,
        created_at=NOW,
        updated_at=NOW,
    )


class FakeGateway:
    def __init__(self, *, priced: set[str] | None = None, history: list[DailyDiscoveryV1] | None = None, items: list[DailyDiscoveryItemV1] | None = None, reject: str | None = None):
        universe = load_universe()
        self.priced = priced if priced is not None else {e.ticker for e in universe.equities}
        self.history = history or []
        self.items = items or []
        self.reject = reject
        self.published: list[list[Any]] = []
        self._stocks = [
            StockV1(ticker=e.ticker, name=e.name, exchange="NASDAQ", industry="", sector=e.sector, currency="USD", kind="equity", benchmark=e.benchmark, display_order=i, active=True, updated_at=NOW, logo_url="")
            for i, e in enumerate(universe.equities)
        ]

    async def worker_discovery_history(self) -> list[DailyDiscoveryV1]:
        return self.history

    async def worker_discovery_items(self) -> list[DailyDiscoveryItemV1]:
        return self.items

    async def worker_job_profiles(self) -> list[InvestmentProfileV1]:
        return [
            InvestmentProfileV1(owner="ab" * 32, schema_version=1, profile_version=1, risk_tolerance="moderate", investment_horizon="years", investment_style="growth", sector_interests=["technology"], experience_level="new", primary_goal="learn_basics", created_at=NOW, updated_at=NOW)
        ]

    async def market_generation(self) -> MarketGenerationV1:
        return MarketGenerationV1(scope="us", generation=42, job_id=1, as_of=NOW, published_at=NOW, market_open=False, market_session="closed", market_status_at=NOW, last_completed_session="2026-10-02", quote_count=1, signal_count=1, algorithm_version="trend-v1.0.0", provider="finnhub")

    async def stocks(self) -> list[StockV1]:
        return self._stocks

    async def market_quotes(self) -> list[MarketQuoteV1]:
        return [
            MarketQuoteV1(ticker=t, generation=42, price_micros=101_000_000, previous_close_micros=100_000_000, open_micros=0, high_micros=0, low_micros=0, provider_time=NOW, ingested_at=NOW, published_at=NOW, source="finnhub")
            for t in sorted(self.priced)
        ]

    async def trend_signals(self) -> list[TrendSignalV1]:
        feature = SignalFeatureV1(name="relative_momentum", available=True, raw=0.01, normalized=0.4, weight=0.25, sample_count=81, baseline_count=60, reason=None)
        return [
            TrendSignalV1(ticker=t, generation=42, algorithm_version="trend-v1.0.0", session_date="2026-10-02", status="published", trend_score=50.0 + (hash(t) % 40), composite=0.0, coverage=0.55, coverage_scope="price_volume", benchmark="SPY", history_sessions=300, required_sessions=81, day_return=0.01, benchmark_day_return=0.0, relative_day_return=0.01, features=[feature], notes=[], as_of=NOW, published_at=NOW)
            for t in sorted(self.priced)
        ]

    async def publish_daily_discovery(self, args: list[Any]) -> None:
        if self.reject:
            raise ReducerRejected("publish_daily_discovery", self.reject)
        self.published.append(args)


class FakeNews:
    def __init__(self, fail: bool = False):
        self.fail = fail
        self.calls: list[str] = []

    async def news_items(self, ticker: str, start: date, end: date, limit: int = 3) -> list[dict[str, str]] | None:
        self.calls.append(ticker)
        if self.fail:
            raise RuntimeError("provider down")
        name = THEMES.companies[ticker].names[0]
        return [
            {"headline": f"{name} opens a new plant", "url": "https://news.example/a", "source": "Wire", "published": (NOW - timedelta(hours=3)).isoformat()},
            {"headline": "Rival chipmaker posts record quarter", "url": "https://news.example/b", "source": "Wire", "published": (NOW - timedelta(hours=2)).isoformat()},
        ]


def _handler(news: FakeNews | None) -> DailyDiscoveryHandler:
    return DailyDiscoveryHandler(news, THEMES, clock=lambda: NOW)


async def test_handler_publishes_todays_theme_with_three_companies() -> None:
    gateway = FakeGateway()
    await _handler(FakeNews()).run(_job({"date": "2026-10-04", "zodiac": "aquarius"}), gateway)  # type: ignore[arg-type]
    (args,) = gateway.published
    expected = ordered_themes(THEMES, "aquarius", TODAY, [])[0]
    assert args[2] == "2026-10-04"
    assert args[3] == {"some": "aquarius"}
    assert (args[4], args[6]) == (expected.sector_id, expected.subtheme_id)
    tickers = [item["ticker"] for item in args[14]]
    sub = {c.ticker for c in THEMES.subthemes[expected.subtheme_id].companies}
    assert len(tickers) == 3 and set(tickers) <= sub
    assert [item["rank"] for item in args[14]] == [1, 2, 3]
    assert all(item["news_headline"] != {"none": []} for item in args[14])


def test_only_headlines_naming_the_company_count_as_its_news() -> None:
    from app.discovery.scoring import mentions, relevant

    story = lambda text: NewsStory(text, "Wire", "https://example.com", NOW)  # noqa: E731
    feed = NewsFacts(True, (story("Amazon expands same-day delivery"), story("How much visibility does Microsoft's backlog provide?")))
    kept = relevant(feed, THEMES.companies["AMZN"].names)
    assert [s.headline for s in kept.stories] == ["Amazon expands same-day delivery"]
    assert not mentions("Armory sales rise", ["Arm"])  # whole words only
    assert mentions("AT&T raises its outlook", ["AT&T"])
    assert relevant(NewsFacts(available=False), ["Amazon"]).available is False


async def test_handler_keeps_only_relevant_headlines() -> None:
    gateway = FakeGateway()
    await _handler(FakeNews()).run(_job({"date": "2026-10-04", "zodiac": "aquarius"}), gateway)  # type: ignore[arg-type]
    for item in gateway.published[0][14]:
        assert item["news_count"] == 1
        assert "Rival" not in item["news_headline"]["some"]


def test_reasons_vary_across_the_set_when_there_is_a_choice() -> None:
    same = [cand(f"S{i}", f"A{i}", traits(risk="lower", size="mega"), market(sector="utilities", trend=80)) for i in range(3)]
    picks = rank_theme(same, CONSERVATIVE, title="Test", today=TODAY, now=NOW, has_history=False).picks
    firsts = [p.reasons[0] for p in picks]
    assert len(set(firsts)) == len(firsts)


async def test_handler_survives_news_outage() -> None:
    gateway = FakeGateway()
    await _handler(FakeNews(fail=True)).run(_job({"date": "2026-10-04", "zodiac": "leo"}), gateway)  # type: ignore[arg-type]
    (args,) = gateway.published
    for item in args[14]:
        assert item["news_score"] == {"none": []}
        assert item["news_headline"] == {"none": []}


async def test_handler_moves_to_the_next_theme_when_one_has_no_prices() -> None:
    first = ordered_themes(THEMES, "aries", TODAY, [])[0]
    unpriced = {c.ticker for c in THEMES.subthemes[first.subtheme_id].companies}
    everyone = {e.ticker for e in load_universe().equities}
    gateway = FakeGateway(priced=everyone - unpriced)
    await _handler(None).run(_job({"date": "2026-10-04", "zodiac": "aries"}), gateway)  # type: ignore[arg-type]
    (args,) = gateway.published
    assert args[6] != first.subtheme_id


async def test_handler_retries_later_when_no_market_data_exists() -> None:
    with pytest.raises(JobFailure) as failure:
        await _handler(None).run(_job({"date": "2026-10-04", "zodiac": "aries"}), FakeGateway(priced=set()))  # type: ignore[arg-type]
    assert failure.value.code == "no_discovery_candidates" and failure.value.retryable


async def test_handler_never_rebuilds_a_published_day() -> None:
    today = DailyDiscoveryV1(id=1, owner="ab" * 32, discovery_date="2026-10-04", zodiac_sign="aries", sector_id="defense", sector_name="Defense", subtheme_id="built-to-protect", title="Built to Protect", description="d", algorithm_version="discovery-v1.0.0", theme_version="themes-v1", market_generation=42, considered_count=4, eligible_count=4, job_id=3, created_at=NOW)
    gateway = FakeGateway(history=[today])
    with pytest.raises(JobFailure) as failure:
        await _handler(None).run(_job({"date": "2026-10-04", "zodiac": "aries"}), gateway)  # type: ignore[arg-type]
    assert failure.value.code == "discovery_exists" and not failure.value.retryable
    assert gateway.published == []


async def test_next_day_uses_history_to_change_theme_and_companies() -> None:
    gateway = FakeGateway()
    await _handler(None).run(_job({"date": "2026-10-04", "zodiac": "aquarius"}), gateway)  # type: ignore[arg-type]
    day_one = gateway.published[0]
    history = [
        DailyDiscoveryV1(id=1, owner="ab" * 32, discovery_date="2026-10-04", zodiac_sign="aquarius", sector_id=day_one[4], sector_name=day_one[5], subtheme_id=day_one[6], title=day_one[7], description=day_one[8], algorithm_version="discovery-v1.0.0", theme_version="themes-v1", market_generation=42, considered_count=5, eligible_count=5, job_id=7, created_at=NOW)
    ]
    items = [
        DailyDiscoveryItemV1(id=i, discovery_id=1, owner="ab" * 32, discovery_date="2026-10-04", ticker=item["ticker"], rank=item["rank"], score=item["score"], trend_score=None, fit_score=None, news_score=None, momentum_score=None, novelty_score=1.0, angle=item["angle"], about=item["about"], reasons=item["reasons"], news_count=0, news_headline=None, news_source=None, news_url=None, news_published_at=None)
        for i, item in enumerate(day_one[14])
    ]
    tomorrow = FakeGateway(history=history, items=items)
    job = _job({"date": "2026-10-05", "zodiac": "aquarius"})
    await DailyDiscoveryHandler(None, THEMES, clock=lambda: NOW + timedelta(days=1)).run(job, tomorrow)  # type: ignore[arg-type]
    day_two = tomorrow.published[0]
    assert day_two[6] != day_one[6]
    yesterday = {item["ticker"] for item in day_one[14]}
    today_tickers = {item["ticker"] for item in day_two[14]}
    sub = {c.ticker for c in THEMES.subthemes[day_two[6]].companies}
    if len(sub - yesterday) >= TOP_N:
        assert not today_tickers & yesterday


async def test_handler_reports_a_concurrent_publish_without_retrying() -> None:
    gateway = FakeGateway(reject="discovery_exists")
    with pytest.raises(JobFailure) as failure:
        await _handler(None).run(_job({"date": "2026-10-04", "zodiac": "pisces"}), gateway)  # type: ignore[arg-type]
    assert not failure.value.retryable


# ---- ingestion budget for the larger universe ----


def test_first_backfills_stay_inside_one_publish_budget() -> None:
    from decimal import Decimal

    from app.market.http import ProviderUnavailable
    from app.market.ingest import admit_history
    from app.market.provider import DailyBar

    def bars(ticker: str, n: int) -> list[DailyBar]:
        return [
            DailyBar(ticker, TODAY - timedelta(days=i), Decimal(1), None, None, None, None, True, "alpaca_sip")
            for i in range(n)
        ]

    tickers = ["OLD", "NEW1", "NEW2", "NEW3", "DOWN"]
    fetched: list[Any] = [bars("OLD", 300), bars("NEW1", 300), bars("NEW2", 300), bars("NEW3", 300), ProviderUnavailable("x")]
    admitted, held = admit_history(tickers, fetched, {"OLD"}, budget=650)
    assert {b.ticker for b in admitted} == {"OLD", "NEW1", "NEW2"}  # known history always passes
    assert held == {"NEW3": "history_backfill_pending", "DOWN": "history_unavailable:provider_unavailable"}
