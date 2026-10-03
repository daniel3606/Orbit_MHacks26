"""Deterministic match, activity, and learning sentences.

Experience changes how much detail is shown. Goal changes the learning
emphasis. Neither changes eligibility or rank. Zodiac is not an input.
"""

from app.ranking.config import VOL_WINDOW

_MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)

SECTOR_LABELS = {
    "technology": "technology",
    "healthcare": "healthcare",
    "financials": "financials",
    "consumer_discretionary": "consumer discretionary",
    "consumer_staples": "consumer staples",
    "energy": "energy",
    "industrials": "industrials",
    "communication_services": "communication services",
    "utilities": "utilities",
    "real_estate": "real estate",
    "materials": "materials",
}

_GOAL = {
    "learn_basics": "You said you want to learn the basics, so the notes stay in everyday words.",
    "grow_long_term": "You said you want to grow money over time. These checks do not measure whether a stock fits a years-long plan.",
    "generate_income": "You asked about income. Dividend data is not available, so this is not an income recommendation.",
    "follow_trends": "You wanted to follow what is moving. The activity note is about recent price and volume, separate from the sector and risk checks.",
}


def sector_label(sector: str) -> str:
    return SECTOR_LABELS.get(sector, sector.replace("_", " "))


def session_label(iso_date: str) -> str:
    year, month, day = (int(part) for part in iso_date.split("-"))
    return f"{_MONTHS[month - 1]} {day}, {year}"


def _score_text(score: float, experience: str) -> str:
    if experience == "experienced":
        return f"{score:.1f}"
    return str(round(score))


def match_reason(*, company: str, sector: str, in_sector: bool, risk_tolerance: str) -> str:
    label = sector_label(sector)
    if in_sector:
        sector_sentence = f"{company} is in {label}, one of the sectors you chose."
    else:
        sector_sentence = f"{company} is in {label}, which is not one of the sectors you chose."
    if risk_tolerance == "conservative":
        risk_sentence = "Its recent day-to-day price swings are inside the steadier limit you set."
    elif risk_tolerance == "moderate":
        risk_sentence = "Its recent day-to-day price swings are inside the balanced limit you set."
    else:
        risk_sentence = (
            "You did not set a limit on day-to-day price swings, so recent volatility did not raise or lower this match."
        )
    return f"{sector_sentence} {risk_sentence}"


def market_activity(
    *,
    trend_score: float,
    session_date: str,
    benchmark_label: str,
    experience: str,
    relative_day_return: float | None,
) -> str:
    text = (
        f"Through {session_label(session_date)}, the Trend Score is {_score_text(trend_score, experience)} out of 100. "
        f"It compares recent price moves with {benchmark_label} and whether volume was unusually high or low. "
        "It is not a chance of making money."
    )
    if experience == "experienced" and relative_day_return is not None:
        points = relative_day_return * 100
        sign = "+" if points >= 0 else "−"
        text += f" The last completed session moved {sign}{abs(points):.2f} points versus {benchmark_label}."
    return text


def risk_observation(
    *,
    realized_vol: float | None,
    max_drawdown: float | None,
    vol_sessions: int,
    drawdown_sessions: int,
    experience: str,
) -> str:
    if realized_vol is None or max_drawdown is None:
        return "Recent volatility could not be measured from the stored daily prices."
    vol_pct = f"{realized_vol * 100:.1f}%"
    drop_pct = f"{abs(max_drawdown) * 100:.1f}%"
    if experience == "experienced":
        signed = f"{max_drawdown * 100:.1f}%"
        return (
            f"Realized volatility over {VOL_WINDOW} sessions is {realized_vol:.4f} per day ({vol_pct}). "
            f"The largest peak-to-trough drop over {drawdown_sessions} sessions is {signed}."
        )
    return (
        f"Over the last {vol_sessions} trading days, a typical daily move was about {vol_pct}. "
        f"The largest drop from a high point over {drawdown_sessions} trading days was about {drop_pct}."
    )


def learning_note(*, experience: str, goal: str) -> str:
    goal_line = _GOAL[goal]
    if experience == "new":
        return f"{goal_line} Nothing here is a promise that the stock will suit you."
    if experience == "experienced":
        return f"{goal_line} Horizon and style were not scored."
    return goal_line


def row_limitations(*, history_source: str) -> list[str]:
    lines = [
        "Trend analysis uses completed daily prices and volume only. News is not included.",
        "Time horizon was not scored. A recent trend does not show whether a stock fits weeks, months, or years.",
        "Growth, value, and income were not scored. Orbit does not have the fundamentals that would support those labels.",
    ]
    if history_source == "alpaca_iex":
        lines.append("Volume is from the IEX exchange only, not the full US market. It is not mixed with other feeds.")
    return lines


def generation_summary(*, status: str, risk_tolerance: str, published: int) -> str:
    if status == "insufficient_market":
        return "Matches need a published Trend Score. None is available yet."
    if status == "no_eligible":
        if risk_tolerance == "aggressive":
            return "No stock has both a published Trend Score and enough daily history to describe its risk. Nothing was added to fill the list."
        return (
            "No stock with a published Trend Score stays inside the risk limit you set. "
            "The list is empty on purpose. That limit was not relaxed."
        )
    if risk_tolerance == "aggressive":
        return (
            f"{published} stock{'s' if published != 1 else ''} ranked from recent market activity and the sectors you saved. "
            "You did not set a risk limit, so none were removed for volatility."
        )
    return (
        f"{published} stock{'s' if published != 1 else ''} that stayed inside your risk limit, "
        "ranked from recent market activity and the sectors you saved."
    )
