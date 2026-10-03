"""Builds one ticker's coverage-aware signal from stored completed-session bars.

Guarantees:
- Only sessions on or before the last completed session are used (no
  incomplete or future sessions).
- The exchange calendar defines expected sessions; the usable history is the
  contiguous run ending at the last completed session where both stock and
  benchmark have bars. Gaps are never interpolated.
- A series must use one adjustment convention; mixing makes history
  features unavailable.
- Normalization uses only prior feature observations, never the current one.
- Missing features are reported with reasons; available weights are
  renormalized and `coverage` keeps the sum of original available weights.
"""

import math
from dataclasses import dataclass, field
from datetime import date

from app.market.provider import DailyBar
from app.signals import features as F
from app.signals.config import NEWS_FEATURES, PRICE_VOLUME_FEATURES, SignalConfig


@dataclass(frozen=True)
class FeatureResult:
    name: str
    available: bool  # usable in the score: raw value and normalized value both present
    raw: float | None
    normalized: float | None
    weight: float
    sample_count: int
    baseline_count: int
    reason: str | None


@dataclass(frozen=True)
class SignalResult:
    ticker: str
    session: date
    status: str  # "published" | "insufficient_data"
    trend_score: float | None
    composite: float | None
    coverage: float  # sum of original weights of features used
    coverage_scope: str
    benchmark: str
    history_sessions: int
    required_sessions: int
    day_return: float | None
    benchmark_day_return: float | None
    relative_day_return: float | None
    features: list[FeatureResult]
    notes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class Series:
    sessions: list[date]
    closes: list[float]
    volumes: list[int | None]
    adjusted: set[bool]


def clean_series(bars: list[DailyBar], last_completed: date) -> tuple[Series, list[str]]:
    """Valid, unique, completed sessions in date order. Returns notes for anything dropped."""
    notes: list[str] = []
    by_day: dict[date, DailyBar] = {}
    for b in bars:
        if b.session > last_completed:
            notes.append(f"excluded_incomplete_session:{b.session.isoformat()}")
            continue
        if not (b.close > 0) or (b.volume is not None and b.volume < 0):
            notes.append(f"invalid_bar:{b.session.isoformat()}")
            continue
        if b.high is not None and b.low is not None and not (b.low <= b.close <= b.high):
            notes.append(f"invalid_bar:{b.session.isoformat()}")
            continue
        by_day[b.session] = b
    ordered = [by_day[d] for d in sorted(by_day)]
    return (
        Series(
            sessions=[b.session for b in ordered],
            closes=[float(b.close) for b in ordered],
            volumes=[b.volume for b in ordered],
            adjusted={b.adjusted for b in ordered},
        ),
        notes,
    )


def _pv_feature_value(name: str, s: list[float], b: list[float], v: list[int | None], i: int, cfg: SignalConfig) -> float | None:
    if name == "relative_momentum":
        return F.momentum_raw(s, b, i, cfg)
    if name == "vol_adjusted_momentum":
        return F.vol_adjusted_momentum(s, b, i, cfg)
    return F.volume_raw(v, i, cfg)


def compute_signal(
    ticker: str,
    benchmark: str,
    stock_bars: list[DailyBar],
    bench_bars: list[DailyBar],
    last_completed: date,
    calendar_sessions: list[date],
    cfg: SignalConfig,
    *,
    extra_blocking: str | None = None,
) -> SignalResult:
    stock, stock_notes = clean_series(stock_bars, last_completed)
    bench, bench_notes = clean_series(bench_bars, last_completed)
    notes = [f"{ticker}:{n}" for n in stock_notes] + [f"{benchmark}:{n}" for n in bench_notes]
    weights = cfg.feature_weights

    # Contiguous run of calendar sessions, ending at the last completed
    # session, where both series have a bar.
    stock_idx = {d: k for k, d in enumerate(stock.sessions)}
    b_pos = {d: k for k, d in enumerate(bench.sessions)}
    aligned_days: list[date] = []
    for d in reversed([d for d in calendar_sessions if d <= last_completed]):
        missing = [t for t, idx in ((ticker, stock_idx), (benchmark, b_pos)) if d not in idx]
        if missing:
            # A real gap, not simply the start of a series.
            gaps = [
                t for t, series in ((ticker, stock), (benchmark, bench))
                if t in missing and series.sessions and series.sessions[0] < d
            ]
            if aligned_days and gaps:
                notes.append(f"missing_bar:{'+'.join(gaps)}:{d.isoformat()}")
            break
        aligned_days.append(d)
    aligned_days.reverse()
    s_close = [stock.closes[stock_idx[d]] for d in aligned_days]
    s_vol = [stock.volumes[stock_idx[d]] for d in aligned_days]
    b_close = [bench.closes[b_pos[d]] for d in aligned_days]
    n = len(aligned_days) - 1
    history_sessions = len(aligned_days)

    blocking: str | None = extra_blocking
    if blocking is not None:
        pass
    elif history_sessions == 0:
        latest = max(stock.sessions[-1:] + bench.sessions[-1:], default=None)
        blocking = f"stale_history:last={latest.isoformat()}" if latest else "no_history"
    elif len(stock.adjusted | bench.adjusted) > 1:
        blocking = "inconsistent_adjustment"
    elif False in (stock.adjusted | bench.adjusted):
        # Unadjusted closes: guard against splits we cannot see.
        for k in range(1, len(s_close)):
            if abs(s_close[k] / s_close[k - 1] - 1.0) > cfg.corporate_action_jump:
                blocking = f"possible_corporate_action:{aligned_days[k].isoformat()}"
                break

    day_return = bench_day = rel_day = None
    if blocking is None and n >= 1:
        day_return = F.simple_return(s_close, n, 1)
        bench_day = F.simple_return(b_close, n, 1)
        rel_day = F.relative_return(s_close, b_close, n, 1)

    results: list[FeatureResult] = []
    for name in PRICE_VOLUME_FEATURES:
        w = weights[name]
        if blocking is not None:
            results.append(FeatureResult(name, False, None, None, w, history_sessions, 0, blocking))
            continue
        raw = _pv_feature_value(name, s_close, b_close, s_vol, n, cfg)
        if raw is None:
            if name == "abnormal_volume" and any(v is None for v in s_vol[-(cfg.volume_window + 1) :]):
                reason = "volume_unavailable"
            else:
                reason = f"insufficient_history:{history_sessions}/{cfg.lookback + 1}"
            results.append(FeatureResult(name, False, None, None, w, history_sessions, 0, reason))
            continue
        if not math.isfinite(raw):
            results.append(FeatureResult(name, False, None, None, w, history_sessions, 0, "non_finite"))
            continue
        prior = [
            _pv_feature_value(name, s_close, b_close, s_vol, k, cfg)
            for k in range(max(0, n - cfg.baseline_window), n)
        ]
        z, count = F.prior_zscore(prior, raw, cfg)
        if z is None:
            results.append(
                FeatureResult(name, False, raw, None, w, history_sessions, count, f"insufficient_baseline:{count}/{cfg.min_baseline}")
            )
        else:
            results.append(FeatureResult(name, True, raw, z, w, history_sessions, count, None))
    for name in NEWS_FEATURES:
        results.append(FeatureResult(name, False, None, None, weights[name], 0, 0, "news_phase_pending"))

    used = [f for f in results if f.available]
    coverage = round(sum(f.weight for f in used), 6)
    composite: float | None = None
    if used:
        composite = float(sum(f.weight / coverage * (f.normalized or 0.0) for f in used))
    gate = (
        all(any(f.name == r and f.available for f in results) for r in cfg.required_for_publication)
        and coverage >= cfg.publication_min_coverage - 1e-9
    )
    if blocking:
        notes.append(blocking)
    return SignalResult(
        ticker=ticker,
        session=aligned_days[-1] if aligned_days else last_completed,
        status="published" if gate else "insufficient_data",
        trend_score=F.trend_score(composite) if gate and composite is not None else None,
        composite=composite if gate else None,
        coverage=coverage,
        coverage_scope="price_volume",
        benchmark=benchmark,
        history_sessions=history_sessions,
        required_sessions=cfg.required_sessions,
        day_return=day_return,
        benchmark_day_return=bench_day,
        relative_day_return=rel_day,
        features=results,
        notes=notes,
    )
