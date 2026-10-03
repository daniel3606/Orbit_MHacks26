"""Deterministic signal tests. Every series here is a synthetic FIXTURE
(source="fixture"), never market data."""

import math
from dataclasses import replace
from datetime import date, timedelta
from decimal import Decimal

import pytest

from app.market.provider import DailyBar
from app.signals import features as F
from app.signals.config import SignalConfig
from app.signals.pipeline import compute_signal

CFG = SignalConfig()


def weekdays(start: date, count: int) -> list[date]:
    out, d = [], start
    while len(out) < count:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def lcg(seed: int):
    state = seed
    while True:
        state = (1103515245 * state + 12345) % 2**31
        yield state / 2**31


def fixture_bars(ticker: str, days: list[date], seed: int, *, drift: float = 0.0, volumes: bool = True, adjusted: bool = True) -> list[DailyBar]:
    """FIXTURE: deterministic random walk with optional drift and volume."""
    rnd, price, out = lcg(seed), 100.0, []
    for d in days:
        price *= 1 + drift + (next(rnd) - 0.5) * 0.03
        vol = int(1_000_000 * (0.5 + next(rnd))) if volumes else None
        out.append(
            DailyBar(ticker, d, Decimal(f"{price:.6f}"), None, None, None, vol, adjusted, "fixture")
        )
    return out


# ---- hand-calculated feature examples ----


def test_relative_return_hand_calc():
    assert F.relative_return([100, 102], [50, 50.5], 1, 1) == pytest.approx(0.02 - 0.01)


def test_momentum_hand_calc():
    stock = [100.0 + i for i in range(21)]  # 100..120
    bench = [100.0] * 21
    expected = 0.20 * (120 / 119 - 1) + 0.50 * (120 / 115 - 1) + 0.30 * (120 / 100 - 1)
    assert F.momentum_raw(stock, bench, 20, CFG) == pytest.approx(expected)
    assert expected == pytest.approx(0.0834198, abs=1e-6)
    assert F.momentum_raw(stock, bench, 19, CFG) is None  # 20-day horizon needs 21 closes


def test_realized_vol_hand_calc():
    # returns +10%, -10% -> sample std = sqrt((0.01 + 0.01) / 1)
    assert F.realized_vol([100, 110, 99], 2, 2) == pytest.approx(math.sqrt(0.02))


def test_volume_raw_hand_calc():
    vols = [1000] * 20 + [2000]
    assert F.volume_raw(vols, 20, CFG) == pytest.approx(math.log(2))
    assert F.volume_raw([1000] * 19 + [None, 2000], 20, CFG) is None


def test_prior_zscore_hand_calc_and_clip():
    cfg = replace(CFG, baseline_window=5, min_baseline=5)
    z, n = F.prior_zscore([1, 2, 3, 4, 5], 6, cfg)  # mean 3, sample std sqrt(2.5)
    assert n == 5 and z == pytest.approx(3 / math.sqrt(2.5))
    assert F.prior_zscore([1, 2, 3, 4, 5], 100, cfg)[0] == 3.0
    assert F.prior_zscore([1, 2, 3, 4, 5], -100, cfg)[0] == -3.0
    assert F.prior_zscore([1, 2, 3, 4], 6, cfg) == (None, 4)


def test_zero_variance_uses_epsilon_then_clips():
    cfg = replace(CFG, baseline_window=5, min_baseline=5)
    assert F.prior_zscore([2, 2, 2, 2, 2], 2, cfg)[0] == 0.0
    assert F.prior_zscore([2, 2, 2, 2, 2], 2.5, cfg)[0] == 3.0


def test_trend_score_mapping():
    assert F.trend_score(0) == 50.0
    assert F.trend_score(math.log(3)) == pytest.approx(75.0)


# ---- pipeline behaviour ----

DAYS = weekdays(date(2026, 1, 5), 100)
LAST = DAYS[-1]


def run(stock, bench, last=LAST, days=DAYS, cfg=CFG):
    return compute_signal("TEST", "BENCH", stock, bench, last, days, cfg)


def test_full_history_publishes_with_price_volume_coverage():
    res = run(fixture_bars("TEST", DAYS, 1, drift=0.002), fixture_bars("BENCH", DAYS, 2))
    feats = {f.name: f for f in res.features}
    assert res.status == "published"
    assert res.coverage == pytest.approx(0.55)
    for name in ("relative_momentum", "vol_adjusted_momentum", "abnormal_volume"):
        assert feats[name].available and feats[name].baseline_count == 60
    for name in ("news_velocity", "sentiment_shift", "breadth_materiality"):
        assert not feats[name].available and feats[name].reason == "news_phase_pending"
    expected = sum(feats[n].weight / 0.55 * feats[n].normalized for n in ("relative_momentum", "vol_adjusted_momentum", "abnormal_volume"))
    assert res.composite == pytest.approx(expected)
    assert res.trend_score == pytest.approx(100 / (1 + math.exp(-expected)))
    assert 0 <= res.trend_score <= 100


def test_normalization_uses_only_prior_observations():
    stock, bench = fixture_bars("TEST", DAYS, 3), fixture_bars("BENCH", DAYS, 4)
    res = run(stock, bench)
    s = [float(b.close) for b in stock]
    b = [float(x.close) for x in bench]
    n = len(DAYS) - 1
    prior = [F.momentum_raw(s, b, k, CFG) for k in range(n - 60, n)]
    mean = sum(prior) / 60
    current = F.momentum_raw(s, b, n, CFG)
    expected_z = max(-3, min(3, (current - mean) / F.sample_std(prior)))
    feat = next(f for f in res.features if f.name == "relative_momentum")
    assert feat.raw == pytest.approx(current) and feat.normalized == pytest.approx(expected_z)


def test_future_and_incomplete_sessions_are_excluded():
    stock, bench = fixture_bars("TEST", DAYS, 5), fixture_bars("BENCH", DAYS, 6)
    baseline = run(stock, bench)
    future_day = LAST + timedelta(days=1)
    spike = DailyBar("TEST", future_day, Decimal("1000"), None, None, None, 99_000_000, True, "fixture")
    with_future = run(stock + [spike], bench + [replace(spike, ticker="BENCH", close=Decimal("1"))])
    assert with_future.features == baseline.features
    assert any("excluded_incomplete_session" in n for n in with_future.notes)


def test_quote_derived_two_sessions_give_day_move_only():
    """Shape of what the current Finnhub plan supports: two unadjusted closes, no volume."""
    days = DAYS[-2:]
    stock = [DailyBar("TEST", days[0], Decimal("100"), None, None, None, None, False, "finnhub_quote"),
             DailyBar("TEST", days[1], Decimal("102"), None, None, None, None, False, "finnhub_quote")]
    bench = [DailyBar("BENCH", days[0], Decimal("50"), None, None, None, None, False, "finnhub_quote"),
             DailyBar("BENCH", days[1], Decimal("50.5"), None, None, None, None, False, "finnhub_quote")]
    res = run(stock, bench)
    feats = {f.name: f for f in res.features}
    assert res.status == "insufficient_data" and res.trend_score is None and res.composite is None
    assert res.coverage == 0.0 and res.history_sessions == 2
    assert res.day_return == pytest.approx(0.02) and res.relative_day_return == pytest.approx(0.01)
    assert feats["relative_momentum"].reason == "insufficient_history:2/21"
    assert feats["abnormal_volume"].reason == "volume_unavailable"


def test_missing_volume_blocks_publication_but_keeps_momentum():
    res = run(fixture_bars("TEST", DAYS, 7, volumes=False), fixture_bars("BENCH", DAYS, 8))
    feats = {f.name: f for f in res.features}
    assert feats["relative_momentum"].available and feats["vol_adjusted_momentum"].available
    assert not feats["abnormal_volume"].available
    assert res.coverage == pytest.approx(0.35)
    assert res.status == "insufficient_data" and res.trend_score is None


def test_missing_bar_truncates_history_without_interpolation():
    stock = fixture_bars("TEST", DAYS, 9)
    gap_day = DAYS[-10]
    res = run([b for b in stock if b.session != gap_day], fixture_bars("BENCH", DAYS, 10))
    assert res.history_sessions == 9
    assert any(f"missing_bar:TEST:{gap_day.isoformat()}" in n for n in res.notes)
    assert res.status == "insufficient_data"


def test_insufficient_baseline_keeps_raw_value():
    days = DAYS[-40:]
    res = run(fixture_bars("TEST", days, 11), fixture_bars("BENCH", days, 12), days=days)
    feat = next(f for f in res.features if f.name == "relative_momentum")
    assert feat.raw is not None and feat.normalized is None
    assert feat.reason == "insufficient_baseline:19/60"


def test_stale_history_blocks_features():
    stock, bench = fixture_bars("TEST", DAYS[:-3], 13), fixture_bars("BENCH", DAYS[:-3], 14)
    res = run(stock, bench)
    assert all(not f.available for f in res.features)
    assert any(n.startswith("stale_history") for n in res.notes)


def test_mixed_adjustment_conventions_block_features():
    stock = fixture_bars("TEST", DAYS, 15)
    stock[-1] = replace(stock[-1], adjusted=False)
    res = run(stock, fixture_bars("BENCH", DAYS, 16))
    assert "inconsistent_adjustment" in res.notes
    assert res.day_return is None and res.status == "insufficient_data"


def test_unadjusted_jump_flags_possible_corporate_action():
    stock = fixture_bars("TEST", DAYS, 17, adjusted=False)
    stock[-5] = replace(stock[-5], close=stock[-5].close * 2)  # e.g. unseen split
    res = run(stock, fixture_bars("BENCH", DAYS, 18, adjusted=False))
    assert any(n.startswith("possible_corporate_action") for n in res.notes)
    assert all(not f.available for f in res.features)


def test_invalid_bars_are_dropped():
    stock = fixture_bars("TEST", DAYS, 19)
    stock[-1] = replace(stock[-1], close=Decimal("0"))
    res = run(stock, fixture_bars("BENCH", DAYS, 20))
    assert any("invalid_bar" in n for n in res.notes)
    assert res.history_sessions == 0  # latest session missing -> stale, nothing aligned
