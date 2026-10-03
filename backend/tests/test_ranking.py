"""Hand checks and preference behavior for fit-v1.0.0.

Formulas in the hand check are written out here on purpose, separate from the
engine, using the documented weights and ceilings.
"""

import math
from datetime import UTC, date, datetime, timedelta

from app.ranking.config import (
    COMPONENT_WEIGHTS,
    DRAWDOWN_FLOOR,
    FIT_BLEND,
    TREND_BLEND,
    VARIETY_RANK_GAP,
    VOL_CEILING,
)
from app.ranking.fit import (
    BarInput,
    MarketInput,
    ProfileInput,
    SignalInput,
    StockInput,
    build_recommendations,
)
from app.ranking.metrics import risk_metrics
from app.ranking.refresh import RefreshRecommendationsHandler
from app.state.dto import InvestmentProfileV1, JobV1
from app.workers.runner import JobFailure

SESSION = date(2026, 10, 2)
WHEN = datetime(2026, 10, 3, tzinfo=UTC)
MARKET = MarketInput(generation=10, algorithm_version="trend-v1.0.0", last_completed_session=SESSION.isoformat())


def _profile(**overrides: object) -> ProfileInput:
    base: dict[str, object] = dict(
        risk_tolerance="conservative",
        investment_horizon="years",
        investment_style="growth",
        sector_interests=("technology",),
        experience_level="new",
        primary_goal="learn_basics",
        profile_version=1,
        schema_version=1,
    )
    base.update(overrides)
    return ProfileInput(**base)  # type: ignore[arg-type]


def _closes(returns: list[float], start: float = 100.0) -> list[float]:
    prices = [start]
    for change in returns:
        prices.append(prices[-1] * (1 + change))
    return prices


def _bars(ticker: str, closes: list[float], source: str = "alpaca_sip") -> list[BarInput]:
    start = SESSION - timedelta(days=len(closes) - 1)
    return [
        BarInput(ticker, start + timedelta(days=i), close, source, True) for i, close in enumerate(closes)
    ]


def _signal(ticker: str, score: float, benchmark: str = "XLK", **overrides: object) -> SignalInput:
    base: dict[str, object] = dict(
        ticker=ticker,
        generation=10,
        algorithm_version="trend-v1.0.0",
        session_date=SESSION.isoformat(),
        status="published",
        trend_score=score,
        benchmark=benchmark,
        relative_day_return=-0.004,
        notes=("history_source:alpaca_sip", "adjustment:split"),
        published_at=WHEN,
    )
    base.update(overrides)
    return SignalInput(**base)  # type: ignore[arg-type]


def _stock(ticker: str, sector: str, benchmark: str = "XLK", name: str = "") -> StockInput:
    return StockInput(ticker, name or ticker, sector, "equity", benchmark)


def _hand_std(values: list[float]) -> float:
    mean = sum(values) / len(values)
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (len(values) - 1))


def _hand_drawdown(closes: list[float]) -> float:
    window = closes[-60:]
    peak = window[0]
    worst = 0.0
    for price in window:
        peak = max(peak, price)
        worst = min(worst, price / peak - 1.0)
    return worst


def test_profile_inputs_have_no_zodiac_field():
    assert "zodiac" not in ProfileInput.__dataclass_fields__


def test_hand_check_matches_engine_for_a_calm_in_sector_stock():
    returns = [0.01, -0.01] * 10
    closes = _closes(returns)
    vol = _hand_std(returns)
    drawdown = _hand_drawdown(closes)
    ceiling = VOL_CEILING["conservative"]
    floor = DRAWDOWN_FLOOR["conservative"]
    assert ceiling is not None and floor is not None
    assert vol < ceiling and drawdown >= floor
    risk = 0.70 * (1 - vol / ceiling) + 0.30 * (1 - drawdown / floor)
    coverage = COMPONENT_WEIGHTS["risk_match"] + COMPONENT_WEIGHTS["sector_preference"]
    fit = 100 * (COMPONENT_WEIGHTS["risk_match"] * risk + COMPONENT_WEIGHTS["sector_preference"] * 1) / coverage
    trend = 40.0
    rank = TREND_BLEND * trend + FIT_BLEND * fit

    metrics = risk_metrics([SESSION - timedelta(days=20 - i) for i in range(21)], closes)
    assert metrics.realized_vol_20d is not None and math.isclose(metrics.realized_vol_20d, vol, rel_tol=0, abs_tol=1e-12)
    assert metrics.max_drawdown_60d is not None and math.isclose(metrics.max_drawdown_60d, drawdown, abs_tol=1e-12)

    batch = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology", name="Apple")],
        [_signal("AAPL", trend)],
        {"AAPL": _bars("AAPL", closes)},
        {"XLK": "Technology Select Sector"},
    )
    assert batch.status == "ready"
    (item,) = batch.items
    assert math.isclose(item.fit_coverage, coverage)
    assert math.isclose(item.fit_score, fit, abs_tol=1e-9)
    assert math.isclose(item.recommendation_rank, rank, abs_tol=1e-9)
    assert item.trend_score == trend
    assert [c.name for c in item.components] == ["risk_match", "horizon_match", "style_match", "sector_preference"]
    assert item.components[1].available is False and item.components[1].reason == "horizon_not_scored"
    assert item.components[2].available is False and item.components[2].reason == "style_not_classified"
    assert "Apple is in technology, one of the sectors you chose." in item.match_reason
    assert "steadier limit" in item.match_reason
    assert "not a chance of making money" in item.market_activity
    assert "growth stock" not in item.match_reason.lower()
    assert "leo" not in " ".join([item.match_reason, item.market_activity, item.learning_note]).lower()
    assert "price_volume_only" in batch.limitations


def test_high_trend_cannot_override_a_conservative_risk_limit():
    calm = _closes([0.001] * 25)
    wild = _closes([0.04, -0.04] * 15)
    batch = build_recommendations(
        _profile(),
        MARKET,
        [_stock("NVDA", "technology", name="NVIDIA"), _stock("NEE", "utilities", benchmark="XLU", name="NextEra")],
        [_signal("NVDA", 99), _signal("NEE", 10, benchmark="XLU")],
        {"NVDA": _bars("NVDA", wild), "NEE": _bars("NEE", calm)},
        {},
    )
    assert [item.ticker for item in batch.items] == ["NEE"]
    assert batch.exclusions["NVDA"] == "above_vol_ceiling"
    assert "risk_exclusions:1" in batch.limitations
    assert "not relaxed" in build_recommendations(
        _profile(sector_interests=("real_estate",)),
        MARKET,
        [_stock("NVDA", "technology")],
        [_signal("NVDA", 99)],
        {"NVDA": _bars("NVDA", wild)},
        {},
    ).summary


def test_sector_preference_changes_order_and_unsupported_fields_do_not():
    closes = _closes([0.001] * 25)
    stocks = [_stock("AAPL", "technology", name="Apple"), _stock("NEE", "utilities", benchmark="XLU", name="NextEra")]
    signals = [_signal("AAPL", 50), _signal("NEE", 50, benchmark="XLU")]
    bars = {"AAPL": _bars("AAPL", closes), "NEE": _bars("NEE", closes)}
    tech_first = build_recommendations(_profile(sector_interests=("technology",)), MARKET, stocks, signals, bars, {})
    utility_first = build_recommendations(_profile(sector_interests=("utilities",)), MARKET, stocks, signals, bars, {})
    assert [item.ticker for item in tech_first.items] == ["AAPL", "NEE"]
    assert [item.ticker for item in utility_first.items] == ["NEE", "AAPL"]
    assert tech_first.items[0].recommendation_rank > tech_first.items[1].recommendation_rank

    same_rank = build_recommendations(
        _profile(
            investment_horizon="weeks",
            investment_style="income",
            experience_level="experienced",
            primary_goal="generate_income",
        ),
        MARKET,
        stocks,
        signals,
        bars,
        {},
    )
    assert [item.recommendation_rank for item in same_rank.items] == [
        item.recommendation_rank for item in tech_first.items
    ]
    assert "not an income recommendation" in same_rank.items[0].learning_note
    assert "dividend" in same_rank.items[0].learning_note.lower()


def test_aggressive_preference_does_not_treat_high_volatility_as_a_better_match():
    calm = _closes([0.001] * 25)
    wild = _closes([0.04, -0.04] * 15)
    batch = build_recommendations(
        _profile(risk_tolerance="aggressive", sector_interests=("technology", "utilities")),
        MARKET,
        [_stock("NVDA", "technology", name="NVIDIA"), _stock("NEE", "utilities", benchmark="XLU", name="NextEra")],
        [_signal("NVDA", 40), _signal("NEE", 90, benchmark="XLU")],
        {"NVDA": _bars("NVDA", wild), "NEE": _bars("NEE", calm)},
        {},
    )
    assert [item.ticker for item in batch.items] == ["NEE", "NVDA"]
    for item in batch.items:
        risk = item.components[0]
        assert risk.available is False and risk.reason == "no_risk_ceiling" and risk.value is None
        assert math.isclose(item.fit_coverage, COMPONENT_WEIGHTS["sector_preference"])
    assert "did not raise or lower" in batch.items[1].match_reason


def test_sector_variety_fills_a_later_slot_without_relaxing_risk():
    closes = _closes([0.001] * 25)
    stocks = [
        _stock("AAPL", "technology"),
        _stock("MSFT", "technology"),
        _stock("NEE", "utilities", benchmark="XLU"),
    ]
    # Ranks: AAPL 88, MSFT 82, NEE 68. Gap 14 is inside the variety window.
    signals = [_signal("AAPL", 80), _signal("MSFT", 70), _signal("NEE", 60, benchmark="XLU")]
    bars = {s.ticker: _bars(s.ticker, closes) for s in stocks}
    picked = build_recommendations(_profile(sector_interests=("technology",)), MARKET, stocks, signals, bars, {})
    assert [item.ticker for item in picked.items] == ["AAPL", "NEE", "MSFT"]
    assert VARIETY_RANK_GAP == 15

    far = build_recommendations(
        _profile(sector_interests=("technology",)),
        MARKET,
        stocks,
        [_signal("AAPL", 80), _signal("MSFT", 70), _signal("NEE", 40, benchmark="XLU")],
        bars,
        {},
    )
    assert [item.ticker for item in far.items][:2] == ["AAPL", "MSFT"]


def test_fewer_than_three_and_no_candidates_stay_honest():
    closes = _closes([0.001] * 25)
    one = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology", name="Apple")],
        [_signal("AAPL", 55)],
        {"AAPL": _bars("AAPL", closes)},
        {},
    )
    assert one.status == "ready" and len(one.items) == 1

    wild = _closes([0.05, -0.05] * 15)
    none = build_recommendations(
        _profile(),
        MARKET,
        [_stock("NVDA", "technology")],
        [_signal("NVDA", 99)],
        {"NVDA": _bars("NVDA", wild)},
        {},
    )
    assert none.status == "no_eligible" and none.items == ()
    assert "empty on purpose" in none.summary


def test_missing_market_and_missing_scores_do_not_invent_matches():
    empty = build_recommendations(_profile(), None, [], [], {}, {})
    assert empty.status == "insufficient_market" and empty.items == () and empty.market_generation == 0
    unpublished = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology")],
        [_signal("AAPL", 0, status="insufficient_data", trend_score=None)],
        {},
        {},
    )
    assert unpublished.status == "insufficient_market" and unpublished.items == ()


def test_sip_history_is_not_mixed_with_iex_or_quotes():
    calm = _closes([0.001] * 30)
    wild = _closes([0.08, -0.08] * 20)
    sip = _bars("AAPL", calm, "alpaca_sip")
    iex = _bars("AAPL", wild, "alpaca_iex")
    quotes = _bars("AAPL", wild, "finnhub_quote")
    batch = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology", name="Apple")],
        [_signal("AAPL", 50)],
        {"AAPL": sip + iex + quotes},
        {},
    )
    assert batch.status == "ready"
    assert batch.items[0].history_source == "alpaca_sip"
    assert batch.items[0].realized_vol_20d is not None and batch.items[0].realized_vol_20d < 0.005
    assert "iex_volume_not_consolidated" not in batch.limitations

    iex_only = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology", name="Apple")],
        [_signal("AAPL", 50, notes=("history_source:alpaca_iex",))],
        {"AAPL": _bars("AAPL", calm, "alpaca_iex")},
        {},
    )
    assert iex_only.items[0].history_source == "alpaca_iex"
    assert "iex_volume_not_consolidated" in iex_only.limitations
    assert "IEX exchange only" in iex_only.items[0].limitations[-1]


def test_a_hole_in_the_risk_window_excludes_the_stock():
    closes = _closes([0.001] * 25)
    bars = _bars("AAPL", closes)
    bars[10] = BarInput("AAPL", bars[10].session + timedelta(days=10), bars[10].close, "alpaca_sip", True)
    batch = build_recommendations(
        _profile(),
        MARKET,
        [_stock("AAPL", "technology")],
        [_signal("AAPL", 50)],
        {"AAPL": bars},
        {},
    )
    assert batch.status == "no_eligible"
    assert batch.exclusions["AAPL"] == "risk_metric_unavailable"


class _Gateway:
    def __init__(self, profile_version: int):
        self.profile_version = profile_version
        self.published = False

    async def worker_job_profiles(self):
        return [
            InvestmentProfileV1(
                owner="aa" * 32,
                schema_version=1,
                profile_version=self.profile_version,
                risk_tolerance="moderate",
                investment_horizon="years",
                investment_style="growth",
                sector_interests=["technology"],
                experience_level="new",
                primary_goal="learn_basics",
                created_at=WHEN,
                updated_at=WHEN,
            )
        ]

    async def worker_jobs(self):
        return []

    async def publish_recommendations(self, _args: object) -> None:
        self.published = True


def _job(version: int) -> JobV1:
    return JobV1(
        job_id=7,
        owner="aa" * 32,
        kind="refresh_recommendations",
        request_key="refresh:v1",
        input_version=version,
        status="running",
        attempt_count=1,
        max_attempts=5,
        lease_owner="bb" * 32,
        lease_until=None,
        available_at=WHEN,
        payload="{}",
        result_ref=None,
        error_code=None,
        created_at=WHEN,
        updated_at=WHEN,
    )


async def test_stale_profile_does_not_publish():
    gateway = _Gateway(profile_version=2)
    handler = RefreshRecommendationsHandler()
    try:
        await handler.run(_job(1), gateway)  # type: ignore[arg-type]
    except JobFailure as exc:
        assert exc.code == "stale_profile_version" and exc.retryable is False
    else:
        raise AssertionError("expected a stale profile failure")
    assert gateway.published is False
