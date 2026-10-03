"""US equity session calendar from provider holiday data plus weekends.

Regular session 09:30–16:00 America/New_York; early closes come from the
holiday list's trading hours. Dates outside the provider's holiday range are
treated as weekend-only (documented limitation).
"""

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.market.provider import Holiday

ET = ZoneInfo("America/New_York")
REGULAR_CLOSE = time(16, 0)


class UsEquityCalendar:
    def __init__(self, holidays: list[Holiday]):
        self._holidays = {h.day: h.trading_hours for h in holidays}

    def is_trading_day(self, day: date) -> bool:
        if day.weekday() >= 5:
            return False
        hours = self._holidays.get(day)
        return hours is None or hours != ""

    def session_close(self, day: date) -> datetime:
        hours = self._holidays.get(day)
        close = REGULAR_CLOSE
        if hours and "-" in hours:
            hh, mm = hours.split("-")[1].split(":")
            close = time(int(hh), int(mm))
        return datetime.combine(day, close, ET)

    def previous_trading_day(self, day: date) -> date:
        d = day - timedelta(days=1)
        while not self.is_trading_day(d):
            d -= timedelta(days=1)
        return d

    def last_completed_session(self, now: datetime) -> date:
        """Most recent trading day whose close is at or before `now`."""
        d = now.astimezone(ET).date()
        while not (self.is_trading_day(d) and self.session_close(d) <= now):
            d -= timedelta(days=1)
        return d

    def sessions_between(self, start: date, end: date) -> list[date]:
        out, d = [], start
        while d <= end:
            if self.is_trading_day(d):
                out.append(d)
            d += timedelta(days=1)
        return out
