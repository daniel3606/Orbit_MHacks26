"""Quote validation and derivation of completed-session closes from quotes.

Without candle access, the only genuine daily history is what quotes reveal:
- `pc` is the close of the session before the quote's session;
- after the quote's session has closed, `c` (with `o`, `h`, `l`) describes
  that completed session.
Volume is never available from quotes. These closes are unadjusted for
corporate actions and labeled `finnhub_quote`.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.market.calendar import ET, UsEquityCalendar
from app.market.provider import DailyBar, Quote

MAX_FUTURE = timedelta(minutes=5)
OPEN_MARKET_STALE_AFTER = timedelta(minutes=20)


@dataclass(frozen=True)
class QuoteCheck:
    valid: bool
    reason: str | None = None
    stale: bool = False


def check_quote(q: Quote, now: datetime, cal: UsEquityCalendar, market_open: bool) -> QuoteCheck:
    if q.price <= 0 or q.previous_close <= 0:
        return QuoteCheck(False, "invalid_price")
    if min(q.open, q.high, q.low) < 0 or (q.high > 0 and q.low > 0 and q.high < q.low):
        return QuoteCheck(False, "invalid_range")
    if q.provider_time > now + MAX_FUTURE:
        return QuoteCheck(False, "future_timestamp")
    session = q.provider_time.astimezone(ET).date()
    if market_open:
        stale = now - q.provider_time > OPEN_MARKET_STALE_AFTER
    else:
        stale = session < cal.last_completed_session(now)
    return QuoteCheck(True, None, stale)


def bars_from_quote(q: Quote, now: datetime, cal: UsEquityCalendar) -> list[DailyBar]:
    session = q.provider_time.astimezone(ET).date()
    if not cal.is_trading_day(session):
        return []
    source = "finnhub_quote" if q.source == "finnhub" else "fixture"
    bars = [DailyBar(q.ticker, cal.previous_trading_day(session), q.previous_close, None, None, None, None, False, source)]
    closed = cal.session_close(session)
    if now >= closed and q.provider_time >= closed - timedelta(minutes=1):
        bars.append(
            DailyBar(
                q.ticker,
                session,
                q.price,
                q.open if q.open > 0 else None,
                q.high if q.high > 0 else None,
                q.low if q.low > 0 else None,
                None,
                False,
                source,
            )
        )
    return bars
