"""Chat answers grounded in the evidence packet.

Deterministic text is the fallback when the model is unavailable, and the packet
is the only market context the model is allowed to see.
"""

from __future__ import annotations

import re
from decimal import Decimal

from app.assistant.facts import catalyst_level, performance, range_extremes, realized_vol, volume_ratio
from app.assistant.policy import (
    REDIRECT,
    REFUSAL,
    TREND_MEANING,
    BarPoint,
    Evidence,
    QuoteFact,
    Source,
    money_text,
    percent_text,
)
from app.assistant.select import peer_for

_EDUCATION = {
    "stock": (
        "A stock is a small piece of a company. When you own one, you own a share of that business. "
        "The price changes as people buy and sell those shares."
    ),
    "pe": (
        "P/E means price-to-earnings. It is how much investors are paying for each dollar of a company's earnings. "
        "A higher P/E means the price is higher compared with recent earnings. Orbit doesn't currently have P/E figures to show."
    ),
    "eps": (
        "EPS means earnings per share. It is the company's profit divided by the number of shares. "
        "Orbit doesn't currently have EPS figures to show."
    ),
    "cap": (
        "Market cap is the price of one share times the number of shares. It is a rough measure of the company's size. "
        "Orbit doesn't currently have market-cap figures to show."
    ),
    "paper": (
        "Practice trading lets you try an idea without using real money. You pick an amount and confirm the order yourself. "
        "If the market is closed, the order can stay pending until the next open."
    ),
    "trend": TREND_MEANING,
    "daily_move": (
        "Typical daily move tells you how much a stock normally moves in one trading day. "
        "It doesn't cause the stock to move; it gives you context. "
        "For example, if a stock usually moves about 1% a day, a 5% move would be unusually large."
    ),
    "volatility": (
        "Volatility is how much a stock's price tends to swing up and down. "
        "A more volatile stock makes bigger moves in both directions, so its price can change a lot in a short time. "
        "Orbit shows this as the typical daily move."
    ),
    "volume": (
        "Volume is the number of shares traded in a period. "
        "It doesn't push the price up or down by itself; it shows how much trading is behind a move. "
        "A big move on unusually high volume means many buyers and sellers took part."
    ),
    "orders": (
        "A market order buys or sells right away at the best price available. "
        "A limit order only fills at your price or better, so it may not fill at all. "
        "Market orders are simple, but the price you get can differ from the last quote when a stock is moving fast."
    ),
    "zero": (
        "Yes. A stock can fall to zero, usually when a company goes bankrupt and nothing is left for shareholders. "
        "It's rare for large, established companies, but it happens. "
        "That's one reason people spread their money across many companies."
    ),
    "moves": (
        "A stock's price moves when buyers and sellers change what they're willing to pay. "
        "Company results, news, interest rates, and the mood of the whole market can all shift that balance. "
        "Many daily moves have no single clear reason."
    ),
    "general": (
        "I can explain investing ideas like volatility, volume, P/E, and Trend Score, "
        "or look at a company Orbit follows. Which would help?"
    ),
}
_EDUCATION_FOLLOW = {
    "trend": ["How is the score calculated?", "What is a stock?"],
    "daily_move": ["What is volatility?", "What does Trend Score mean?"],
    "volatility": ["What is typical daily move?", "What does Trend Score mean?"],
    "volume": ["What is volatility?", "What does Trend Score mean?"],
}


def education_key(text: str) -> str:
    lowered = text.lower()
    if "trend score" in lowered or re.search(r"\bscore calculated\b", lowered):
        return "trend"
    if "p/e" in lowered or "price to earnings" in lowered or "price-to-earnings" in lowered:
        return "pe"
    if re.search(r"\beps\b", lowered) or "earnings per share" in lowered:
        return "eps"
    if "market cap" in lowered:
        return "cap"
    if re.search(r"\b(?:practice|paper) trad", lowered):
        return "paper"
    if re.search(r"\b(?:typical|daily) move", lowered):
        return "daily_move"
    if "volatil" in lowered:
        return "volatility"
    if re.search(r"\bvolume\b", lowered):
        return "volume"
    if re.search(r"\b(?:market|limit) orders?\b", lowered):
        return "orders"
    if re.search(r"\b(?:zero|bankrupt\w*)\b", lowered):
        return "zero"
    if re.search(r"\bwhy do(?:es)? (?:a )?stocks?\b|\bwhat makes (?:a )?stocks?\b|\bwhy do prices\b", lowered):
        return "moves"
    if re.search(r"\bstocks?\b", lowered):
        return "stock"
    return "general"


def build_packet(
    evidence: Evidence,
    tickers: list[str],
    *,
    intent: str,
    include_definition: bool,
) -> tuple[dict[str, object], list[Source], int]:
    """Return the model packet, the sources those numbers may cite, and a catalyst level."""
    entities: list[dict[str, object]] = []
    sources: list[Source] = []
    levels: list[int] = []
    for ticker in tickers:
        quote = evidence.quote(ticker)
        bars = evidence.bars.get(ticker, [])
        moves = performance(bars, quote)
        news = evidence.news_for(ticker)[:3]
        level = catalyst_level(news, quote.as_of if quote else None)
        levels.append(level)
        source = _entity_source(ticker, quote, moves, evidence)
        if source is not None:
            sources.append(source)
        entities.append(
            {
                "symbol": ticker,
                "companyName": evidence.name_of(ticker),
                "quote": _quote_json(quote),
                "performance": {key: _num(value) for key, value in moves.items()},
                "marketActivity": _activity(bars),
                "news": [
                    {"id": item.id, "source": item.source, "headline": item.headline, "published": item.published}
                    for item in news
                ],
                "catalystLevel": level,
                "trendScore": _score_json(evidence, ticker),
                "portfolioHeld": any(item.ticker == ticker and item.quantity > 0 for item in evidence.holdings),
            }
        )
    level = min(levels) if levels else 4
    packet: dict[str, object] = {
        "intent": intent,
        "entities": entities,
        "marketOpen": evidence.market_open,
        "lastCompletedSession": evidence.last_session,
        "newsChecked": evidence.news_checked,
        "catalystLevel": level,
        "sources": [
            {"id": source.id, "as_of": source.as_of, "label": source.label, "numbers": list(source.numbers)}
            for source in sources
        ],
        "missing": {"fundamentals": "Revenue, EPS, margins, P/E, and market cap are not in Orbit's current data."},
    }
    if include_definition or intent == "education":
        packet["trendScoreDefinition"] = {
            "range": "0 to 100",
            "measures": [
                "recent price movement compared with a benchmark over 1, 5, and 20 sessions",
                "whether completed-session volume was unusually high or low",
            ],
            "not": "Not a probability of future returns and not a buy or sell recommendation.",
            "newsInputs": "News features are designed but current published scores use price and volume only.",
        }
    return packet, sources, level


def fallback_answer(
    intent: str,
    tickers: list[str],
    evidence: Evidence,
    user_text: str,
    *,
    ambiguous: tuple[str, ...] = (),
    missing: tuple[str, ...] = (),
) -> tuple[str, list[dict[str, str]], list[str], str | None]:
    """Text, citations, follow-ups, and an optional practice ticker. Never places an order."""
    if intent == "refusal":
        return REFUSAL, [], [], None
    if intent == "redirect":
        return REDIRECT, [], ["What is a stock?", "How does practice trading work?"], None
    if ambiguous:
        names = ", ".join(evidence.name_of(ticker) for ticker in ambiguous)
        return (
            f"Which company do you mean: {names}?",
            [],
            [f"How is {ticker} doing?" for ticker in ambiguous[:3]],
            None,
        )
    if intent == "education":
        key = education_key(user_text)
        return _EDUCATION[key], [], _EDUCATION_FOLLOW.get(key, ["What does Trend Score mean?"]), None
    if not tickers:
        if missing:
            return (
                f"Orbit doesn't currently follow {missing[0]}. I can explain a company Orbit does follow.",
                [],
                ["What is a stock?"],
                None,
            )
        lead = "Which company do you want to look at?"
        if intent == "recommendation":
            lead = f"I can't pick a stock for you, but I can help you evaluate a company Orbit follows. {lead}"
        elif intent == "prediction":
            lead = f"No one can know the next price move reliably. {lead}"
        return lead, [], ["What is a stock?", "How does practice trading work?"], None

    _packet, sources, level = build_packet(evidence, tickers, intent=intent, include_definition=False)
    citations = [{"id": source.id, "as_of": source.as_of} for source in sources]
    practice = tickers[0] if intent in {"recommendation", "paper"} else None
    if intent == "comparison" and len(tickers) >= 2:
        text = _comparison(tickers[0], tickers[1], evidence)
    elif intent == "comparison":
        text = f"I can compare two companies Orbit follows. I only resolved {evidence.name_of(tickers[0])}."
        if missing:
            text += f" Orbit doesn't currently follow {missing[0]}."
    elif intent == "prediction":
        text = _prediction(tickers[0], evidence, level)
    elif intent == "recommendation":
        text = _recommendation(tickers[0], evidence, level)
    elif intent == "paper":
        text = (
            f"You can try {evidence.name_of(tickers[0])} without using real money. "
            "You'll choose the amount and confirm the order yourself. This chat can't place it."
        )
    elif intent == "movement":
        text = _movement(tickers[0], evidence, level)
    elif intent == "portfolio":
        text = _portfolio(tickers, evidence)
    else:
        text = _research(tickers[0], evidence, level)
        if re.search(r"\b(expensive|valuation|p/e|pe ratio|p/e ratio)\b", user_text, re.IGNORECASE):
            text += (
                "\n\nOrbit's current feed doesn't include valuation metrics like P/E yet, "
                "so I can't reliably compare valuation from the data I have. "
                "I can still show recent price performance and Trend Score."
            )
    return text, citations, _follow(intent, tickers[0], evidence), practice


def activity_label(score: Decimal) -> str:
    """Presentation bands for a descriptive activity score. Not a forecast."""
    value = float(score)
    if value < 25:
        return "Low recent activity"
    if value < 50:
        return "Below-average recent activity"
    if value < 75:
        return "Moderate recent activity"
    if value < 90:
        return "Strong recent activity"
    return "Very strong recent activity"


def _research(ticker: str, evidence: Evidence, level: int) -> str:
    quote = evidence.quote(ticker)
    moves = performance(evidence.bars.get(ticker, []), quote)
    parts = [_catalyst_sentence(ticker, evidence, level)]
    note = _pattern(evidence.name_of(ticker), moves)
    if note:
        parts.insert(0, note)
    return " ".join(parts)


def _movement(ticker: str, evidence: Evidence, level: int) -> str:
    quote = evidence.quote(ticker)
    move = quote.day_return if quote else None
    if move is None:
        lead = f"Orbit doesn't have a latest move for {ticker}."
    elif move < 0:
        lead = f"{ticker} fell {percent_text(abs(move))}% in the latest session."
    else:
        lead = f"{ticker} moved {percent_text(abs(move))}% in the latest session."
    return "\n\n".join([lead, _catalyst_sentence(ticker, evidence, level)])


def _prediction(ticker: str, evidence: Evidence, level: int) -> str:
    return f"No one can know the next price move reliably. {_detail(ticker, evidence, level)}"


def _recommendation(ticker: str, evidence: Evidence, level: int) -> str:
    name = evidence.name_of(ticker)
    return " ".join(
        [
            f"I can't decide whether you should buy {name}, but I can help you evaluate it.",
            _detail(ticker, evidence, level),
            "You can try that idea without using real money.",
        ]
    )


def _comparison(left: str, right: str, evidence: Evidence) -> str:
    lines = [f"{evidence.name_of(left)} and {evidence.name_of(right)}."]
    for label, key in (("Latest session", "oneDay"), ("Past month", "oneMonth"), ("Past year", "oneYear")):
        a = performance(evidence.bars.get(left, []), evidence.quote(left)).get(key)
        b = performance(evidence.bars.get(right, []), evidence.quote(right)).get(key)
        if a is None and b is None:
            continue
        lines.append(f"{label}: {_pct_or_missing(a)} for {left}, {_pct_or_missing(b)} for {right}.")
    lines.append("The larger number is not a better investment. It is only the measured change.")
    return "\n\n".join(lines)


def _portfolio(tickers: list[str], evidence: Evidence) -> str:
    if not tickers:
        return "You don't have a practice holding for me to describe yet."
    lines = ["Here's the latest move in your practice portfolio."]
    for ticker in tickers[:5]:
        quote = evidence.quote(ticker)
        if quote and quote.day_return is not None:
            direction = "up" if quote.day_return > 0 else "down"
            lines.append(f"{ticker} is {direction} {percent_text(abs(quote.day_return))}%.")
        else:
            lines.append(f"Orbit doesn't have a latest move for {ticker}.")
    return "\n\n".join(lines)


def _detail(ticker: str, evidence: Evidence, level: int) -> str:
    quote = evidence.quote(ticker)
    moves = performance(evidence.bars.get(ticker, []), quote)
    note = _pattern(evidence.name_of(ticker), moves)
    catalyst = _catalyst_sentence(ticker, evidence, level)
    if note:
        return f"{note} {catalyst}"
    return catalyst


def _pattern(name: str, moves: dict[str, Decimal | None]) -> str | None:
    """One sentence on the visible pattern. No prices or percents."""
    day = moves.get("oneDay")
    month = moves.get("oneMonth")
    year = moves.get("oneYear")
    if day is not None and month is not None and year is not None:
        if day > 0 and month < 0 and year < 0:
            verb = "rose sharply" if day >= Decimal("0.03") else "rose"
            return f"{name} {verb} in the latest session, but it remains down over the past month and year."
        if day < 0 and month > 0 and year > 0:
            verb = "fell sharply" if day <= Decimal("-0.03") else "fell"
            return f"{name} {verb} in the latest session, but it remains up over the past month and year."
    if (
        month is not None
        and year is not None
        and abs(year) >= Decimal("0.10")
        and abs(year) >= abs(month) * 3
    ):
        if year > 0 and month > 0:
            modest = month < Decimal("0.05") and (day is None or abs(day) < Decimal("0.03"))
            tone = "modestly positive" if modest else "positive"
            return f"{name} has been {tone} recently, with a much stronger one-year gain than its monthly move."
        if year < 0 and month < 0:
            return f"{name} has been weaker recently, with a much larger one-year drop than its monthly move."
        if year > 0 and month < 0:
            return f"{name} is down over the past month, but the past year is still up by much more."
        if year < 0 and month > 0:
            return f"{name} is up over the past month, but the past year is still down by much more."
    return None


def _catalyst_sentence(ticker: str, evidence: Evidence, level: int) -> str:
    name = evidence.name_of(ticker)
    if level == 1:
        return f"Shares moved after coverage of {name}'s earnings."
    if evidence.news_for(ticker):
        return "Recent coverage doesn't point to one clear reason for the move."
    if evidence.news_failed:
        return "Orbit couldn't check recent coverage."
    return "No clear catalyst in Orbit's current sources."


def _follow(intent: str, ticker: str, evidence: Evidence) -> list[str]:
    peer = peer_for(ticker, evidence)
    if intent == "prediction":
        questions = ["What are the current risks?", f"How has {ticker} performed this year?", "Practice with $100"]
    elif intent == "recommendation":
        questions = [f"Why did {ticker} move?", "Practice with $100"]
    elif intent == "movement":
        questions = ["Is this move unusual?", f"How has {ticker} moved recently?", "Practice with $100"]
    elif intent == "paper":
        questions = [f"How has {ticker} moved recently?", "What does Trend Score mean?"]
    else:
        questions = [f"Why has {ticker} moved recently?", "What does Trend Score mean?"]
    if peer and intent not in {"prediction", "paper"}:
        questions.append(f"Compare {ticker} with {peer}")
    kept: list[str] = []
    for question in questions:
        if question not in kept:
            kept.append(question)
    return kept[:4]


def _pct_or_missing(value: Decimal | None) -> str:
    if value is None:
        return "unavailable"
    return f"{percent_text(value)}%"


def _num(value: Decimal | None) -> str | None:
    if value is None:
        return None
    return percent_text(value)


def _quote_json(quote: QuoteFact | None) -> dict[str, str] | None:
    if quote is None:
        return None
    move = quote.day_return
    return {
        "price": money_text(quote.price),
        "previousClose": money_text(quote.previous_close),
        "changePercent": percent_text(move) if move is not None else "",
        "asOf": quote.as_of,
        "source": quote.source,
    }


def _activity(bars: list[BarPoint]) -> dict[str, str | None]:
    vol = realized_vol(bars)
    ratio = volume_ratio(bars)
    extremes = range_extremes(bars)
    payload: dict[str, str | None] = {
        "typicalDailyMovePercent": percent_text(vol) if vol is not None else None,
        "volumeVersusRecentAverage": f"{ratio:.2f}" if ratio is not None else None,
    }
    if extremes is None:
        payload["high"] = None
        payload["low"] = None
        payload["sessions"] = None
    else:
        high, low, count = extremes
        payload["high"] = money_text(high)
        payload["low"] = money_text(low)
        payload["sessions"] = str(count)
    return payload


def _score_json(evidence: Evidence, ticker: str) -> dict[str, str] | None:
    signal = evidence.signals.get(ticker)
    if signal is None or signal.trend_score is None or signal.status != "published":
        return None
    label = activity_label(signal.trend_score)
    return {
        "value": f"{signal.trend_score:.0f}",
        "activityLabel": label,
        "sessionDate": signal.session_date,
        "coverageScope": signal.coverage_scope,
        "benchmark": signal.benchmark,
        "meaning": (
            f"{label}. Recent price movement versus {signal.benchmark or 'its benchmark'} "
            "and unusual completed-session volume. Not a probability and not a recommendation."
        ),
    }


def _entity_source(
    ticker: str,
    quote: QuoteFact | None,
    moves: dict[str, Decimal | None],
    evidence: Evidence,
) -> Source | None:
    numbers: list[str] = []
    as_of = ""
    if quote is not None:
        numbers.extend([money_text(quote.price), money_text(quote.previous_close)])
        if quote.day_return is not None:
            numbers.append(percent_text(abs(quote.day_return)))
            numbers.append(percent_text(quote.day_return))
        as_of = quote.as_of
    for value in moves.values():
        if value is not None:
            numbers.append(percent_text(abs(value)))
            numbers.append(percent_text(value))
    signal = evidence.signals.get(ticker)
    if signal and signal.trend_score is not None:
        numbers.append(f"{signal.trend_score:.0f}")
        numbers.append(f"{signal.trend_score:.2f}")
    if not numbers:
        return None
    return Source(f"quote:{ticker}", as_of or "unknown", ticker, tuple(dict.fromkeys(numbers)))
