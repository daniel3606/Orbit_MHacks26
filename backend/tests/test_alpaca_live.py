"""LIVE Alpaca historical bars and a hand check of the scoring formulas.

Opt-in (costs API calls):
`ORBIT_LIVE_PROVIDER_TESTS=1 uv run pytest -s tests/test_alpaca_live.py`

Uses the configured backend keys. Nothing here prints those keys.
The publication threshold and news-feature policy are the production ones.
"""

import math
import os
import statistics
from datetime import UTC, datetime, timedelta

import pytest

from app.config.settings import get_settings
from app.config.universe import load_universe
from app.market.alpaca import AlpacaHistoricalProvider, session_safe_for_historical_sip
from app.market.calendar import UsEquityCalendar
from app.market.finnhub import FinnhubProvider
from app.market.ingest import history_calendar_days
from app.market.provider import DailyBar
from app.signals.config import SignalConfig
from app.signals.pipeline import compute_signal

pytestmark = pytest.mark.skipif(
    os.environ.get("ORBIT_LIVE_PROVIDER_TESTS") != "1"
    or get_settings().alpaca_api_key_id is None
    or get_settings().alpaca_api_secret_key is None
    or get_settings().finnhub_api_key is None,
    reason="live Alpaca checks are opt-in and need Alpaca and Finnhub keys",
)

CFG = SignalConfig()


def _align(stock: list[DailyBar], bench: list[DailyBar], sessions: list, last) -> tuple[list[float], list[float], list[int]]:
    stock_by = {b.session: b for b in stock if b.session <= last and b.close > 0}
    bench_by = {b.session: b for b in bench if b.session <= last and b.close > 0}
    aligned: list = []
    for day in reversed([d for d in sessions if d <= last]):
        if day not in stock_by or day not in bench_by:
            break
        aligned.append(day)
    aligned.reverse()
    return (
        [float(stock_by[d].close) for d in aligned],
        [float(bench_by[d].close) for d in aligned],
        [int(stock_by[d].volume or 0) for d in aligned],
    )


def _hand(closes: list[float], bench: list[float], volumes: list[int]) -> dict[str, float]:
    """PRD formulas, written out for the latest session. Not the engine."""
    i = len(closes) - 1
    rel = []
    for horizon, weight in ((1, 0.20), (5, 0.50), (20, 0.30)):
        rel.append(weight * ((closes[i] / closes[i - horizon] - 1) - (bench[i] / bench[i - horizon] - 1)))
    momentum = sum(rel)
    window = [closes[k] / closes[k - 1] - 1 for k in range(i - 19, i + 1)]
    vol = statistics.stdev(window)
    vol_adj = momentum / max(vol, CFG.epsilon)
    baseline = volumes[i - 20 : i]
    volume_raw = math.log(max(volumes[i] / (sum(baseline) / 20), CFG.epsilon))

    def z_of(values: list[float]) -> float:
        # The last entry is the current observation and is not part of the baseline.
        prior = values[-61:-1]
        assert len(prior) >= 60
        mean = sum(prior) / len(prior)
        z = (values[-1] - mean) / max(statistics.stdev(prior), CFG.epsilon)
        return max(-3.0, min(3.0, z))

    momenta, vols, volumes_raw = [], [], []
    for k in range(20, i + 1):
        parts = []
        for horizon, weight in ((1, 0.20), (5, 0.50), (20, 0.30)):
            parts.append(weight * ((closes[k] / closes[k - horizon] - 1) - (bench[k] / bench[k - horizon] - 1)))
        m = sum(parts)
        momenta.append(m)
        rets = [closes[j] / closes[j - 1] - 1 for j in range(k - 19, k + 1)]
        vols.append(m / max(statistics.stdev(rets), CFG.epsilon))
        base = volumes[k - 20 : k]
        volumes_raw.append(math.log(max(volumes[k] / (sum(base) / 20), CFG.epsilon)))
    zm, zv, zq = z_of(momenta), z_of(vols), z_of(volumes_raw)
    coverage = 0.55
    composite = (0.25 * zm + 0.10 * zv + 0.20 * zq) / coverage
    return {
        "momentum": momentum,
        "vol": vol,
        "vol_adj": vol_adj,
        "volume_raw": volume_raw,
        "z_momentum": zm,
        "z_vol": zv,
        "z_volume": zq,
        "composite": composite,
        "score": 100 / (1 + math.exp(-composite)),
    }


async def test_live_sip_history_covers_the_universe_and_matches_the_formulas():
    settings = get_settings()
    assert settings.alpaca_api_key_id is not None
    assert settings.alpaca_api_secret_key is not None
    assert settings.finnhub_api_key is not None
    alpaca = AlpacaHistoricalProvider(
        settings.alpaca_api_key_id,
        settings.alpaca_api_secret_key,
        base_url=str(settings.alpaca_data_base_url).rstrip("/"),
        calls_per_minute=settings.alpaca_data_calls_per_minute,
        burst=settings.alpaca_data_burst,
        max_retries=1,
    )
    finnhub = FinnhubProvider(settings.finnhub_api_key, calls_per_minute=30, burst=5, max_retries=1)
    try:
        caps = {c.key: c for c in await alpaca.capabilities()}
        for key in ("alpaca.historical_sip", "alpaca.historical_bars"):
            print(f"{key}: {'available' if caps[key].available else 'UNAVAILABLE'} — {caps[key].detail}")
        assert caps["alpaca.historical_sip"].available, caps["alpaca.historical_sip"].detail
        assert await alpaca.history_source() == "alpaca_sip"
        assert "feed=sip" in caps["alpaca.historical_bars"].detail
        assert "adjustment=split" in caps["alpaca.historical_bars"].detail

        holidays = await finnhub.get_holidays()
        cal = UsEquityCalendar(holidays)
        now = datetime.now(UTC)
        last = session_safe_for_historical_sip(cal, now)
        start = last - timedelta(days=history_calendar_days(CFG))
        universe = load_universe()
        bars: dict[str, list[DailyBar]] = {}
        for ticker in universe.all_tickers:
            bars[ticker] = await alpaca.get_daily_bars(ticker, start, last)
        counts = {ticker: len(rows) for ticker, rows in bars.items()}
        print(f"feed=sip adjustment=split score_through={last.isoformat()} min_bars={min(counts.values())} max_bars={max(counts.values())}")
        for ticker, count in counts.items():
            print(f"  {ticker}: {count} sessions {bars[ticker][0].session.isoformat()} → {bars[ticker][-1].session.isoformat()}")
            assert count >= CFG.required_sessions, ticker
            assert bars[ticker][-1].session == last
            assert all(b.source == "alpaca_sip" and b.adjusted and b.volume and b.volume > 0 for b in bars[ticker])

        sessions = cal.sessions_between(start, last)
        signal = compute_signal("AAPL", "XLK", bars["AAPL"], bars["XLK"], last, sessions, CFG)
        closes, bench, volumes = _align(bars["AAPL"], bars["XLK"], sessions, last)
        assert len(closes) == signal.history_sessions
        hand = _hand(closes, bench, volumes)
        by_name = {f.name: f for f in signal.features}
        assert by_name["relative_momentum"].raw == pytest.approx(hand["momentum"], rel=1e-9)
        assert by_name["vol_adjusted_momentum"].raw == pytest.approx(hand["vol_adj"], rel=1e-9)
        assert by_name["abnormal_volume"].raw == pytest.approx(hand["volume_raw"], rel=1e-9)
        assert by_name["relative_momentum"].normalized == pytest.approx(hand["z_momentum"], rel=1e-9, abs=1e-9)
        assert by_name["vol_adjusted_momentum"].normalized == pytest.approx(hand["z_vol"], rel=1e-9, abs=1e-9)
        assert by_name["abnormal_volume"].normalized == pytest.approx(hand["z_volume"], rel=1e-9, abs=1e-9)
        assert signal.coverage == pytest.approx(0.55)
        assert signal.status == "published"
        assert signal.trend_score == pytest.approx(hand["score"], rel=1e-9, abs=1e-6)
        assert signal.composite == pytest.approx(hand["composite"], rel=1e-9, abs=1e-9)
        assert all(not f.available and f.reason == "news_phase_pending" for f in signal.features if f.name in ("news_velocity", "sentiment_shift", "breadth_materiality"))
        print(
            f"AAPL vs XLK through {signal.session.isoformat()}: "
            f"momentum={hand['momentum']:.6f} vol={hand['vol']:.6f} "
            f"vol_adj={hand['vol_adj']:.4f} volume_raw={hand['volume_raw']:.4f} "
            f"z=({hand['z_momentum']:.3f}, {hand['z_vol']:.3f}, {hand['z_volume']:.3f}) "
            f"composite={hand['composite']:.4f} score={hand['score']:.2f} "
            f"sessions={signal.history_sessions} coverage={signal.coverage}"
        )

        published = 0
        for equity in universe.equities:
            result = compute_signal(equity.ticker, equity.benchmark, bars[equity.ticker], bars[equity.benchmark], last, sessions, CFG)
            reason = next((f.reason for f in result.features if f.reason and f.reason != "news_phase_pending"), None)
            print(f"  {equity.ticker}: {result.status} score={result.trend_score} sessions={result.history_sessions} reason={reason}")
            assert result.status == "published", (equity.ticker, reason, result.history_sessions)
            published += 1
        assert published == len(universe.equities)
    finally:
        await alpaca.aclose()
        await finnhub.aclose()
