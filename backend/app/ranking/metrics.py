"""Risk observations from one completed-session close series.

The series must already be a single source and a single adjustment convention.
Quote closes are not substituted when the signal's history source is missing.
"""

from dataclasses import dataclass
from datetime import date

from app.ranking.config import DRAWDOWN_WINDOW, MAX_SESSION_GAP_DAYS, VOL_WINDOW
from app.signals.features import sample_std


@dataclass(frozen=True)
class RiskMetrics:
    realized_vol_20d: float | None
    max_drawdown_60d: float | None
    vol_sessions: int
    drawdown_sessions: int
    reason: str | None


def _contiguous_suffix(sessions: list[date], closes: list[float]) -> tuple[list[date], list[float]]:
    if not sessions:
        return [], []
    start = len(sessions) - 1
    while start > 0 and (sessions[start] - sessions[start - 1]).days <= MAX_SESSION_GAP_DAYS:
        start -= 1
    return sessions[start:], closes[start:]


def risk_metrics(sessions: list[date], closes: list[float]) -> RiskMetrics:
    """`sessions` and `closes` are date-sorted and end on the signal session."""
    days, prices = _contiguous_suffix(sessions, closes)
    n = len(prices)
    if n < 2:
        return RiskMetrics(None, None, n, n, "insufficient_risk_history")

    draw_prices = prices[-DRAWDOWN_WINDOW:]
    peak = draw_prices[0]
    worst = 0.0
    for price in draw_prices:
        peak = max(peak, price)
        if peak > 0:
            worst = min(worst, price / peak - 1.0)
    drawdown_sessions = len(draw_prices)

    if n < VOL_WINDOW + 1:
        return RiskMetrics(None, worst, n, drawdown_sessions, "insufficient_risk_history")
    window = prices[-(VOL_WINDOW + 1) :]
    returns = [window[i] / window[i - 1] - 1.0 for i in range(1, len(window))]
    vol = sample_std(returns)
    return RiskMetrics(vol, worst, VOL_WINDOW + 1, drawdown_sessions, None)
