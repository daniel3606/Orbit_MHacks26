"""Deterministic market math for the assistant.

Figures come from stored quotes and completed-session bars. Missing inputs stay
missing. Nothing here forecasts a price.
"""

from __future__ import annotations

import re
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from app.assistant.policy import BarPoint, NewsFact, QuoteFact

ET = ZoneInfo("America/New_York")
_EARNINGS = re.compile(r"\b(earnings|quarterly results|reports? results)\b", re.IGNORECASE)


def ordered_bars(bars: list[BarPoint]) -> list[BarPoint]:
    return sorted(bars, key=lambda bar: bar.session)


def session_date_of(iso: str) -> str | None:
    try:
        parsed = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(ET).date().isoformat()


def price_series(bars: list[BarPoint], quote: QuoteFact | None) -> list[Decimal]:
    """Completed closes, with the latest quote folded in when it is a later print."""
    series = [bar.close for bar in ordered_bars(bars) if bar.close > 0]
    if quote is None or quote.price <= 0:
        return series
    quote_day = session_date_of(quote.as_of)
    if not series:
        return [quote.price]
    last_session = ordered_bars(bars)[-1].session
    if quote_day is None:
        if abs(series[-1] - quote.price) > Decimal("0.01"):
            series.append(quote.price)
        return series
    if quote_day == last_session:
        series[-1] = quote.price
    elif quote_day > last_session:
        series.append(quote.price)
    return series


def window_return(series: list[Decimal], sessions: int) -> Decimal | None:
    if sessions < 1 or len(series) <= sessions:
        return None
    base = series[-1 - sessions]
    if base <= 0:
        return None
    return series[-1] / base - 1


def performance(bars: list[BarPoint], quote: QuoteFact | None) -> dict[str, Decimal | None]:
    series = price_series(bars, quote)
    one_day = quote.day_return if quote is not None else window_return(series, 1)
    return {
        "oneDay": one_day,
        "oneWeek": window_return(series, 5),
        "oneMonth": window_return(series, 21),
        "threeMonth": window_return(series, 63),
        "oneYear": window_return(series, 252),
    }


def typical_daily_move(bars: list[BarPoint]) -> Decimal | None:
    """Median absolute close-to-close move over the last 20 completed sessions."""
    closes = [bar.close for bar in ordered_bars(bars) if bar.close > 0]
    window = closes[-21:]
    moves: list[Decimal] = []
    for earlier, later in zip(window, window[1:], strict=False):
        if earlier > 0:
            moves.append(abs(later / earlier - 1))
    if len(moves) < 5:
        return None
    moves.sort()
    mid = len(moves) // 2
    if len(moves) % 2 == 1:
        return moves[mid]
    return (moves[mid - 1] + moves[mid]) / 2


def volume_ratio(bars: list[BarPoint]) -> Decimal | None:
    known = [bar for bar in ordered_bars(bars) if bar.volume is not None and bar.volume > 0]
    if len(known) < 6:
        return None
    current = known[-1].volume
    prior = known[-21:-1]
    if current is None or len(prior) < 5:
        return None
    average = sum(bar.volume or 0 for bar in prior) / Decimal(len(prior))
    if average <= 0:
        return None
    return Decimal(current) / average


def realized_vol(bars: list[BarPoint]) -> Decimal | None:
    closes = [bar.close for bar in ordered_bars(bars) if bar.close > 0]
    if len(closes) < 21:
        return None
    window = closes[-21:]
    returns = [window[i] / window[i - 1] - 1 for i in range(1, len(window)) if window[i - 1] > 0]
    if len(returns) < 20:
        return None
    mean = sum(returns) / Decimal(len(returns))
    variance = sum((item - mean) ** 2 for item in returns) / Decimal(len(returns) - 1)
    return variance.sqrt()


def range_extremes(bars: list[BarPoint]) -> tuple[Decimal, Decimal, int] | None:
    closes = [bar.close for bar in ordered_bars(bars) if bar.close > 0]
    if len(closes) < 20:
        return None
    window = closes[-252:]
    return max(window), min(window), len(window)


def catalyst_level(news: list[NewsFact], as_of: str | None) -> int:
    """1 earnings-aligned, 2 recent coverage, 3 older related news, 4 none.

    A story Jev classified is earnings news only when Jev kept it for this company
    with event type `earnings`; one Jev did not keep is not coverage of it at all.
    An unclassified story falls back to the headline pattern used before Jev."""
    news = [item for item in news if item.classification is None or item.classification.keep]
    if not news:
        return 4
    as_of_day = session_date_of(as_of) if as_of else None
    best = 3
    for item in news:
        published = session_date_of(item.published)
        gap = _day_gap(as_of_day, published)
        if item.classification is not None:
            earnings = item.classification.event_type == "earnings"
        else:
            earnings = _EARNINGS.search(item.headline) is not None
        if earnings and gap is not None and gap <= 3:
            return 1
        if gap is not None and gap <= 2:
            best = min(best, 2)
    return best


def has_earnings(news: list[NewsFact], as_of: str | None) -> bool:
    return catalyst_level(news, as_of) == 1


def _day_gap(left: str | None, right: str | None) -> int | None:
    if left is None or right is None:
        return None
    try:
        a = datetime.fromisoformat(left).date()
        b = datetime.fromisoformat(right).date()
    except ValueError:
        return None
    return abs((a - b).days)
