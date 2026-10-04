"""Deterministic intent and company resolution. The model does not choose the entity."""

from __future__ import annotations

import re
from dataclasses import dataclass

from app.assistant.policy import Evidence

# Names that do not appear in the legal company name. Used only when that ticker
# is actually in Orbit's catalog. Everything else is resolved by ticker or name search.
_ALIASES = {
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "facebook": "META",
    "fb": "META",
    "meta": "META",
}

_REFUSAL = re.compile(
    r"\b(insider trad(?:e|ing)|material nonpublic|manipulat(?:e|ing) the (?:price|market)|"
    r"wash trad(?:e|ing)|pump and dump|evad(?:e|ing) (?:the )?(?:sec|rules|regulations)|front[- ]run)\b",
    re.IGNORECASE,
)
_PAPER = re.compile(
    r"\b(practice (buying|selling|with)|paper trad|open the trade|let me practice|try (buying|it) with play money)\b",
    re.IGNORECASE,
)
_RECOMMEND = re.compile(
    r"\b(should i (?:buy|sell|invest|own)|put all my money|bet my tuition|sell everything|best stock|"
    r"which (?:stock|one) should i|guaranteed to double|what should i buy)\b",
    re.IGNORECASE,
)
_PREDICT = re.compile(
    r"\b(will .+ (?:go up|go down|rise|fall|crash|keep going|keep rising)|exact price tomorrow|"
    r"where will .+ be|price tomorrow|definitely going up|going to (?:double|crash|moon))\b",
    re.IGNORECASE,
)
_COMPARE = re.compile(r"\b(compare|versus|vs\.?)\b", re.IGNORECASE)
_MOVE = re.compile(
    r"\b(why (?:did|is|has|was)|what moved|what happened|why .+ (?:up|down|rise|fall|jump|drop))\b",
    re.IGNORECASE,
)
_EDUCATION = re.compile(
    r"\b(what is a stock|what(?:'s| is) (?:a |an )?(?:p/?e|eps|market cap)|what does .+ mean|"
    r"how does (?:practice|paper) trading work|trend score|how is (?:the |my )?(?:trend )?score calculated)\b",
    re.IGNORECASE,
)
_PORTFOLIO = re.compile(r"\b(my (?:practice )?portfolio|my holdings|what do i own|practice account)\b", re.IGNORECASE)
_OFF_TOPIC = re.compile(
    r"\b(weather|recipe|homework|write (?:me )?(?:a )?poem|who won the game)\b",
    re.IGNORECASE,
)
_PRONOUN = re.compile(r"\b(it|its|it's|this stock|that stock|the stock|this one)\b", re.IGNORECASE)
_SPLIT = re.compile(r"\b(?:versus|vs\.?|and|with)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Resolution:
    intent: str
    tickers: tuple[str, ...]
    ambiguous: tuple[str, ...]
    missing: tuple[str, ...]
    used_context: bool


def classify(text: str) -> str:
    if _REFUSAL.search(text):
        return "refusal"
    if _PAPER.search(text):
        return "paper"
    if re.search(r"\btrend score\b", text, re.IGNORECASE) and not re.search(r"\bwill [A-Z]{1,5}\b", text):
        return "education"
    if _RECOMMEND.search(text):
        return "recommendation"
    if _PREDICT.search(text):
        return "prediction"
    if _COMPARE.search(text):
        return "comparison"
    if _MOVE.search(text):
        return "movement"
    if _PORTFOLIO.search(text):
        return "portfolio"
    if _EDUCATION.search(text):
        return "education"
    if _OFF_TOPIC.search(text):
        return "redirect"
    return "research"


def resolve(text: str, evidence: Evidence, active: str | None) -> Resolution:
    intent = classify(text)
    if intent in {"refusal", "redirect"}:
        return Resolution(intent, (), (), (), False)
    if intent == "education" and not _wants_company(text, evidence):
        return Resolution(intent, (), (), (), False)
    if intent == "portfolio":
        owned = tuple(holding.ticker for holding in evidence.holdings if holding.quantity > 0)
        return Resolution(intent, owned, (), (), False)

    parts = _SPLIT.split(text) if intent == "comparison" else [text]
    found: list[str] = []
    ambiguous: list[str] = []
    missing: list[str] = []
    for part in parts:
        tickers, unsure = _match_part(part, evidence)
        if len(tickers) == 1:
            if tickers[0] not in found:
                found.append(tickers[0])
        elif len(tickers) > 1:
            ambiguous.extend(ticker for ticker in tickers if ticker not in ambiguous)
        elif unsure:
            ambiguous.extend(ticker for ticker in unsure if ticker not in ambiguous)
        else:
            label = _unmatched_label(part)
            if label and label not in missing:
                missing.append(label)

    used_context = False
    context_follow = _PRONOUN.search(text) is not None or (len(text.split()) <= 8 and not missing)
    if not found and not ambiguous and active and context_follow and intent != "education":
        found.append(active)
        used_context = True
        missing = []
    if intent == "comparison" and len(found) == 1 and active and active not in found and not missing:
        found.append(active)
        used_context = True
    return Resolution(intent, tuple(found[:2]), tuple(ambiguous[:4]), tuple(missing[:2]), used_context)


def _wants_company(text: str, evidence: Evidence) -> bool:
    tickers, unsure = _match_part(text, evidence)
    return bool(tickers or unsure or _PRONOUN.search(text))


def _unmatched_label(text: str) -> str | None:
    words = [word for word in re.findall(r"[A-Za-z][A-Za-z0-9.&'-]{2,}", text) if word.lower() not in _STOP]
    if not words:
        return None
    return str(words[0][:40])


def _match_part(text: str, evidence: Evidence) -> tuple[list[str], list[str]]:
    catalog = set(evidence.stocks) | {quote.ticker for quote in evidence.quotes}
    explicit: list[str] = []
    for token in re.findall(r"\b([A-Za-z]{1,5}(?:\.[A-Za-z])?)\b", text):
        upper = token.upper()
        if upper not in catalog or len(upper) < 2:
            continue
        if token.isupper() or token.lower() not in _STOP:
            if upper not in explicit:
                explicit.append(upper)
    if text.strip().upper() in catalog:
        explicit = [text.strip().upper()]
    if explicit:
        unique = list(dict.fromkeys(explicit))
        return unique[:2], []

    lowered = text.lower()
    alias_hits: list[str] = []
    for word, ticker in _ALIASES.items():
        if ticker in catalog and re.search(rf"\b{re.escape(word)}\b", lowered):
            if ticker not in alias_hits:
                alias_hits.append(ticker)
    if len(alias_hits) == 1:
        return alias_hits, []
    if len(alias_hits) > 1:
        return [], alias_hits

    words = [word for word in re.findall(r"[a-z0-9]+", lowered) if len(word) > 2 and word not in _STOP]
    if not words:
        return [], []
    scored: list[tuple[int, str]] = []
    for ticker in catalog:
        if not evidence.is_equity(ticker) and ticker not in evidence.stocks:
            continue
        name = evidence.name_of(ticker).lower()
        if not name or name == ticker.lower():
            continue
        name_words = set(re.findall(r"[a-z0-9]+", name))
        if any(word in name_words for word in words) or any(word in name for word in words if len(word) > 3):
            overlap = len(name_words & set(words))
            scored.append((overlap, ticker))
    if not scored:
        return [], []
    scored.sort(key=lambda item: item[0], reverse=True)
    best = scored[0][0]
    winners = [ticker for score, ticker in scored if score == best and score > 0]
    if len(winners) == 1:
        return winners, []
    return [], winners


_STOP = frozenset(
    "how what why when where who the and for with from this that your you are was were has have had its it's it "
    "stock stocks share shares price prices doing today about company companies compare versus practice buying "
    "selling buy sell should will going keep recent latest move moved moving unusual expensive valuation mean "
    "does did down rise rose fall fell jump jumped drop dropped tell more days these right".split()
)
