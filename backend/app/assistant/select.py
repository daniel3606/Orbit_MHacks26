"""Server-side Daily Brief selection. The model never chooses the company."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from app.assistant.facts import catalyst_level, has_earnings, typical_daily_move, volume_ratio
from app.assistant.policy import Evidence, HoldingFact, QuoteFact, Source, money_text, percent_text
from app.ranking.explain import sector_label

_MOVE_TYPES = frozenset({"PORTFOLIO_MOVE", "UNUSUAL_MOVE", "UNUSUAL_VOLUME", "EARNINGS", "PORTFOLIO_EVENT"})


@dataclass(frozen=True)
class Candidate:
    ticker: str
    reason_type: str
    score: float
    eyebrow: str
    chart_range: str


@dataclass(frozen=True)
class Brief:
    ticker: str | None
    reason_type: str
    eyebrow: str
    chart_range: str
    reason_text: str
    context_text: str
    follow_ups: tuple[str, ...]
    sources: tuple[Source, ...]
    catalyst_level: int


def select_brief(evidence: Evidence) -> Brief:
    ranked = _rank(evidence)
    chosen = _prefer_novelty(ranked, evidence.recent_brief_tickers)
    if chosen is None:
        return Brief(
            None,
            "FALLBACK",
            "WORTH KNOWING",
            "1M",
            "Prices aren't available yet.",
            "You can still ask what a stock is, or how practice trading works.",
            ("What is a stock?", "What does Trend Score mean?", "How does practice trading work?"),
            (),
            4,
        )
    return _materialize(chosen, evidence)


def _rank(evidence: Evidence) -> list[Candidate]:
    found: list[Candidate] = []
    owned = [holding.ticker for holding in evidence.holdings if holding.quantity > 0 and evidence.is_equity(holding.ticker)]
    for ticker in owned:
        quote = evidence.quote(ticker)
        move = abs(quote.day_return) if quote and quote.day_return is not None else Decimal(0)
        level = catalyst_level(evidence.news_for(ticker), quote.as_of if quote else None)
        if quote and quote.day_return is not None and move >= Decimal("0.02"):
            found.append(Candidate(ticker, "PORTFOLIO_MOVE", 1000 + float(move) * 100, "FROM YOUR PRACTICE PORTFOLIO", "1W"))
        if level == 1:
            found.append(Candidate(ticker, "PORTFOLIO_EVENT", 900, "EARNINGS UPDATE", "1W"))

    for recommendation in evidence.recommendations:
        ticker = recommendation.ticker
        if not evidence.is_equity(ticker):
            continue
        quote = evidence.quote(ticker)
        move = abs(quote.day_return) if quote and quote.day_return is not None else Decimal(0)
        if move >= Decimal("0.02") or evidence.news_for(ticker):
            found.append(Candidate(ticker, "DISCOVERY_MATCH", 500 + float(move) * 50, "FOR YOU", "1M"))

    for quote in evidence.quotes:
        if not evidence.is_equity(quote.ticker) or quote.day_return is None:
            continue
        ticker = quote.ticker
        move = abs(quote.day_return)
        typical = typical_daily_move(evidence.bars.get(ticker, []))
        unusual = move >= Decimal("0.03") or (typical is not None and typical > 0 and move >= max(typical * 2, Decimal("0.015")))
        level = catalyst_level(evidence.news_for(ticker), quote.as_of)
        ratio = volume_ratio(evidence.bars.get(ticker, []))
        if level == 1:
            found.append(Candidate(ticker, "EARNINGS", 800 + float(move) * 10, "EARNINGS UPDATE", "1W"))
        elif unusual and move >= Decimal("0.02"):
            found.append(Candidate(ticker, "UNUSUAL_MOVE", 700 + float(move) * 100, "TODAY'S WATCH", "1W"))
        elif ratio is not None and ratio >= 2 and move >= Decimal("0.01"):
            found.append(Candidate(ticker, "UNUSUAL_VOLUME", 600 + float(ratio), "TODAY'S WATCH", "1W"))
        elif evidence.news_for(ticker) and level <= 3:
            found.append(Candidate(ticker, "RECENT_NEWS", 400, "WORTH KNOWING", "1M"))

    if not found:
        for recommendation in evidence.recommendations:
            if evidence.is_equity(recommendation.ticker) and evidence.quote(recommendation.ticker):
                found.append(Candidate(recommendation.ticker, "FALLBACK", 200, "DISCOVERY", "1M"))
                break
        quiet = [
            quote
            for quote in evidence.quotes
            if evidence.is_equity(quote.ticker) and quote.day_return is not None
        ]
        if quiet and not any(item.reason_type == "FALLBACK" for item in found):
            quote = max(quiet, key=lambda item: abs(item.day_return or Decimal(0)))
            found.append(Candidate(quote.ticker, "FALLBACK", 100, "DISCOVERY", "1M"))
    found.sort(key=lambda item: item.score, reverse=True)
    return _dedupe(found)


def _dedupe(items: list[Candidate]) -> list[Candidate]:
    best: dict[str, Candidate] = {}
    order: list[str] = []
    for item in items:
        current = best.get(item.ticker)
        if current is None or item.score > current.score:
            best[item.ticker] = item
            if item.ticker not in order:
                order.append(item.ticker)
    ranked = [best[ticker] for ticker in order]
    ranked.sort(key=lambda item: item.score, reverse=True)
    return ranked


def _prefer_novelty(ranked: list[Candidate], recent: tuple[str, ...]) -> Candidate | None:
    if not ranked:
        return None
    best = ranked[0]
    last = recent[-1] if recent else None
    if last and best.ticker == last and best.reason_type not in {"PORTFOLIO_MOVE", "PORTFOLIO_EVENT"}:
        alternative = next((item for item in ranked if item.ticker != last), None)
        if alternative is not None:
            return alternative
    return best


def _materialize(chosen: Candidate, evidence: Evidence) -> Brief:
    quote = evidence.quote(chosen.ticker)
    level = catalyst_level(evidence.news_for(chosen.ticker), quote.as_of if quote else None)
    sources: list[Source] = []
    if quote is not None:
        sources.append(_quote_source(quote))
    reason = _reason(chosen, evidence, quote)
    context = _context(chosen.ticker, evidence, level)
    return Brief(
        chosen.ticker,
        chosen.reason_type,
        chosen.eyebrow,
        chosen.chart_range if chosen.reason_type in _MOVE_TYPES else "1M",
        reason,
        context,
        tuple(_follow_ups(chosen.ticker, evidence, chosen.reason_type)),
        tuple(sources),
        level,
    )


def _reason(chosen: Candidate, evidence: Evidence, quote: QuoteFact | None) -> str:
    ticker = chosen.ticker
    move = quote.day_return if quote else None
    if chosen.reason_type == "PORTFOLIO_MOVE":
        return f"{ticker} is the largest mover in your practice portfolio."
    if chosen.reason_type == "PORTFOLIO_EVENT":
        return f"{ticker} is in your practice portfolio and recent coverage mentions earnings."
    if chosen.reason_type == "EARNINGS":
        return f"{ticker} recently reported quarterly earnings."
    if chosen.reason_type == "UNUSUAL_VOLUME":
        return f"{ticker}'s volume is well above its recent average."
    if chosen.reason_type == "DISCOVERY_MATCH":
        sector = evidence.stocks[ticker].sector if ticker in evidence.stocks else ""
        if sector and sector in evidence.interest_sectors:
            return f"Orbit surfaced {ticker} because it matches your interest in {sector_label(sector)}."
        return f"Orbit surfaced {ticker} from your current matches."
    if chosen.reason_type == "RECENT_NEWS":
        return f"Recent coverage mentions {ticker}."
    if chosen.reason_type == "UNUSUAL_MOVE" and move is not None:
        typical = typical_daily_move(evidence.bars.get(ticker, []))
        phrase = _session_move(ticker, move)
        if typical is not None and abs(move) >= typical * 2:
            return f"{phrase}, more than its recent typical move."
        return f"{phrase}."
    if chosen.reason_type == "FALLBACK":
        return f"{evidence.name_of(ticker)} is one of the companies Orbit is following."
    if move is not None:
        return f"{_session_move(ticker, move)}."
    return f"{evidence.name_of(ticker)} is one of the companies Orbit is following."


def _session_move(ticker: str, move: Decimal) -> str:
    pct = percent_text(abs(move))
    if move < 0:
        return f"{ticker} fell {pct}% in the latest session"
    return f"{ticker} moved {pct}% in the latest session"


def _context(ticker: str, evidence: Evidence, level: int) -> str:
    name = evidence.name_of(ticker)
    if level == 1:
        return f"Recent coverage discusses {name}'s earnings."
    if evidence.news_for(ticker):
        return "Recent coverage doesn't point to one clear reason for the move."
    if evidence.news_failed:
        return f"Orbit couldn't check recent coverage for {name}."
    return "No clear catalyst in Orbit's current sources."


def _follow_ups(ticker: str, evidence: Evidence, reason_type: str) -> list[str]:
    name = evidence.name_of(ticker)
    if reason_type in {"UNUSUAL_MOVE", "PORTFOLIO_MOVE", "UNUSUAL_VOLUME", "EARNINGS", "PORTFOLIO_EVENT"}:
        questions = [f"Why did {ticker} move?", "Is this move unusual?", f"What does {name} do?"]
    elif reason_type == "DISCOVERY_MATCH":
        questions = [f"What does {name} do?", f"How has {ticker} moved recently?", "What does this Trend Score mean?"]
    else:
        questions = [f"What does {name} do?", f"How has {ticker} moved recently?", f"Why did {ticker} move?"]
    return questions[:3]


def _peer(ticker: str, evidence: Evidence) -> str | None:
    stock = evidence.stocks.get(ticker)
    if stock is None or not stock.sector:
        return None
    for other, info in evidence.stocks.items():
        if other != ticker and info.kind == "equity" and info.sector == stock.sector and evidence.quote(other):
            return other
    return None


def _quote_source(quote: QuoteFact) -> Source:
    move = quote.day_return or Decimal(0)
    numbers = [money_text(quote.price), money_text(quote.previous_close), percent_text(abs(move))]
    return Source(f"quote:{quote.ticker}", quote.as_of, f"{quote.ticker} {quote.source}", tuple(numbers))


def peer_for(ticker: str, evidence: Evidence) -> str | None:
    return _peer(ticker, evidence)


def holding_for(evidence: Evidence, ticker: str) -> HoldingFact | None:
    return next((item for item in evidence.holdings if item.ticker == ticker and item.quantity > 0), None)


def earnings_headline(evidence: Evidence, ticker: str) -> bool:
    quote = evidence.quote(ticker)
    return has_earnings(evidence.news_for(ticker), quote.as_of if quote else None)
