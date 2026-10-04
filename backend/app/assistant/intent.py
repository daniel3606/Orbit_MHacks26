"""Deterministic intent and company resolution. The model does not choose the entity.

The order is fixed: classify the question, decide whether that intent needs a
company, and only then look for one. No company is a valid result. A word
becomes a company only with evidence that the user is naming a security:
ticker form ($NVDA, or NVDA in a normally typed sentence), a company name or
alias, or a stock slot such as "X stock" or "how is X doing".
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

from app.assistant.policy import Evidence

# Names that do not appear in the legal company name. Used only when that ticker
# is actually in Orbit's catalog. Everything else is resolved by ticker or name.
_ALIASES = {
    "google": "GOOGL",
    "alphabet": "GOOGL",
    "facebook": "META",
    "fb": "META",
    "meta": "META",
    "exxon": "XOM",
    "pepsi": "PEP",
    "tsmc": "TSM",
}

# Company-shaped questions that become a general explanation when no company is named
# and there is nothing to refer back to ("why do stocks go down?").
_GENERALIZES = frozenset({"research", "movement", "comparison"})

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
    r"\b(why (?:did|is|has|was)|what moved|what happened|"
    r"why .+ (?:up|down|rise|rose|fall|fell|jump|jumped|drop|dropped|surged|plunged|tanked|soared|sank))\b",
    re.IGNORECASE,
)
_TREND = re.compile(r"\btrend score\b|\bhow is (?:the |my )?(?:trend )?score calculated\b", re.IGNORECASE)
_PORTFOLIO = re.compile(r"\b(my (?:practice )?portfolio|my holdings|what do i own|practice account)\b", re.IGNORECASE)
_OFF_TOPIC = re.compile(
    r"\b(weather|recipe|homework|write (?:me )?(?:a )?poem|who won the game)\b",
    re.IGNORECASE,
)

# A general question whose subject is stocks or investors in general: "Can a stock go to zero?",
# "Why do stocks move?", "Should beginners use market orders?".
_GENERIC_SUBJECT = re.compile(
    r"^\s*(?:(?:so|and|but|ok|okay|also|hey)[,\s]+)?"
    r"(?:can|could|will|would|should|do|does|did|is|are|was|were|why do|why does|why would|why are|"
    r"how do|how does|how can|when do|when does|what makes|what causes|what happens when|what happens if)\s+"
    r"(?:(?:a|an|any|every|most|many|some|all|higher|lower|high|low|more|less|rising|falling|big|small|large|"
    r"individual|single|typical|new|beginner|average|normal|long[- ]term|short[- ]term)\s+)*"
    r"(?:stocks?|shares?|stock prices?|prices?|(?:the )?(?:stock )?markets?|investors?|beginners?|people|companies|"
    r"traders?|(?:trading )?volume|volatility|dividends?|etfs?|index funds?|bonds?|options|interest rates?|"
    r"inflation|earnings|news)\b",
    re.IGNORECASE,
)
# A concept question needs both an explainer shape and an investing concept.
_CONCEPT_ASK = re.compile(
    r"\b(?:what(?:'s|’s|\s+is|\s+are|\s+does|\s+do)|whats|explain|define|describe|meaning of|definition of|"
    r"difference between|tell me about|teach me|how (?:does|do|is|are|can|should|would)|"
    r"should (?:i|you|we) (?:use|care|worry|avoid|know|learn|understand|pay attention)|what happens (?:when|if))\b",
    re.IGNORECASE,
)
_CONCEPT = re.compile(
    r"\b(?:volatility|volatile|typical (?:daily )?move|daily move|p/?e(?: ratio)?|price[- ]to[- ]earnings|eps|"
    r"earnings per share|earnings|revenue|net income|profits?|cash flow|market cap(?:italization)?|dividends?|"
    r"etfs?|index funds?|mutual funds?|bonds?|options?|market orders?|limit orders?|stop[- ]loss(?:es)?|stop orders?|short selling|shorting|"
    r"short squeeze|bull market|bear market|recessions?|inflation|interest rates?|diversif\w*|ipos?|beta|"
    r"moving averages?|liquidity|spreads?|stock splits?|buybacks?|margin|leverage|penny stocks?|blue[- ]chips?|"
    r"growth stocks?|value stocks?|compound(?:ing| interest)|dollar[- ]cost averaging|after[- ]hours|pre[- ]market|"
    r"fractional shares?|expense ratio|(?:trading )?volume|valuation|benchmarks?|stock market|market hours|"
    r"paper trading|practice trading|what (?:is|are) (?:a )?(?:stock|share)s?)\b",
    re.IGNORECASE,
)

# Points at the company already under discussion.
_ANAPHORA = re.compile(
    r"\b(?:its|this stock|that stock|the stock(?! market)|this company|that company|this one|that one|"
    r"this move|that move|the move|this drop|the drop|this jump|the jump)\b",
    re.IGNORECASE,
)
_PRONOUN = re.compile(r"\b(?:it|it's|it’s|they|them)\b", re.IGNORECASE)
# About the market in general, so an earlier company is not the subject.
_MARKET_WIDE = re.compile(
    r"\b(?:stocks|the (?:stock )?market|markets|investors|beginners|people|companies|everyone|the economy|"
    r"(?:a|any|every|which|what|best|good|single) stock|(?:a|any|which) company)\b",
    re.IGNORECASE,
)

_W = r"\$?[^\W_](?:[^\W_]|[&.'’])*"
_TOKEN = re.compile(r"(\$)?([^\W_](?:[^\W_]|[&.'’])*)")
# Positions where a word is being used as a company. "strong" slots are enough for a
# lowercase ticker; "ask" slots need a ticker that is not also an everyday word.
_SLOTS: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "how",
        re.compile(
            rf"\bhow(?:'s|’s|\s+is|\s+are|\s+was|\s+has|\s+have)\s+(?P<x>{_W}(?:\s+{_W}){{0,2}}?)\s+"
            r"(?:been\s+)?(?:doing|performing|performed|trading|looking|holding up|done)\b",
            re.IGNORECASE,
        ),
    ),
    ("stock", re.compile(rf"(?<!\S)(?P<x>{_W})\s+(?:stock|stocks|shares|share price|ticker)\b", re.IGNORECASE)),
    ("shares", re.compile(rf"\b(?:shares of|shares in|stock in|ticker|symbol)\s+(?P<x>{_W})", re.IGNORECASE)),
    (
        "ask",
        re.compile(
            r"\b(?:buy|buying|sell|selling|hold|holding|invest in|investing in|about|look at|thoughts on|news on|take on)"
            rf"\s+(?:some\s+|more\s+|any\s+)?(?P<x>{_W})",
            re.IGNORECASE,
        ),
    ),
    ("ask", re.compile(rf"\bwhy\s+(?:did|is|has|was|does|are|were)\s+(?P<x>{_W})", re.IGNORECASE)),
    (
        "ask",
        re.compile(
            rf"\b(?:will|would|could|can|does|did|is|was)\s+(?P<x>{_W})\s+"
            r"(?:go|going|keep|rise|fall|crash|drop|recover|bounce|hit|reach|double|beat|pay|up|down|a buy|a good|"
            r"worth|overvalued|undervalued|expensive|cheap|risky|volatile)\b",
            re.IGNORECASE,
        ),
    ),
    (
        "ask",
        re.compile(
            rf"\bcompare\s+(?P<x>{_W})(?:\s+(?:and|with|to|vs\.?|versus|or)\s+(?P<y>{_W}))?", re.IGNORECASE
        ),
    ),
    ("ask", re.compile(rf"(?<!\S)(?P<x>{_W})\s+(?:vs\.?|versus)\s+(?P<y>{_W})", re.IGNORECASE)),
)
_STRONG_SLOTS = frozenset({"how", "stock", "shares"})
_TRAILING_OBJECT = re.compile(
    rf"\b(?:of|for|about|with|on|in|at)\s+(?P<x>{_W}(?:\s+{_W})?)\s*[?.!]*\s*$", re.IGNORECASE
)


@dataclass(frozen=True)
class Resolution:
    intent: str
    tickers: tuple[str, ...]
    ambiguous: tuple[str, ...]
    missing: tuple[str, ...]
    used_context: bool
    # Whether the text was searched for a company at all. Pure concept questions are not.
    looked_up: bool = False


@dataclass(frozen=True)
class Mentions:
    tickers: tuple[str, ...] = ()
    ambiguous: tuple[str, ...] = ()
    missing: tuple[str, ...] = ()
    # Named subjects that are not a followed company ("gold", "tech"). They mean the
    # question is not about the earlier company, but they are not reported as missing.
    other: tuple[str, ...] = ()


def classify(text: str) -> str:
    if _REFUSAL.search(text):
        return "refusal"
    if _TREND.search(text) and not re.search(r"\bwill [A-Z]{1,5}\b", text):
        return "education"
    if _RECOMMEND.search(text):
        return "recommendation"
    if _PREDICT.search(text):
        return "prediction"
    if _GENERIC_SUBJECT.search(text) or (_CONCEPT_ASK.search(text) and _CONCEPT.search(text)):
        return "education"
    if _PAPER.search(text):
        return "paper"
    if _COMPARE.search(text):
        return "comparison"
    if _MOVE.search(text):
        return "movement"
    if _PORTFOLIO.search(text):
        return "portfolio"
    if _OFF_TOPIC.search(text):
        return "redirect"
    return "research"


def resolve(text: str, evidence: Evidence, active: str | None) -> Resolution:
    intent = classify(text)
    if intent in {"refusal", "redirect"}:
        return Resolution(intent, (), (), (), False)
    if intent == "portfolio":
        owned = tuple(holding.ticker for holding in evidence.holdings if holding.quantity > 0)
        return Resolution(intent, owned, (), (), False)
    if intent == "education":
        # A concept question needs no company. "What does its Trend Score mean?" uses the
        # server-side active company; a company is searched for only when the text names one.
        if active and _ANAPHORA.search(text):
            return Resolution(intent, (active,), (), (), True)
        if not names_something(text):
            return Resolution(intent, (), (), (), False)
        found = find_companies(text, evidence)
        return Resolution(intent, found.tickers[:2], found.ambiguous[:4], found.missing[:2], False, True)

    found = find_companies(text, evidence)
    tickers = list(found.tickers)
    used_context = False
    unnamed = not tickers and not found.ambiguous and not found.missing
    anaphoric = bool(_ANAPHORA.search(text)) or (bool(_PRONOUN.search(text)) and not _MARKET_WIDE.search(text))
    if unnamed and active and not found.other and (anaphoric or _elliptical(text)):
        tickers.append(active)
        used_context = True
    elif intent == "comparison" and len(tickers) == 1 and active and active not in tickers and not found.missing:
        tickers.append(active)
        used_context = True
    if not tickers and unnamed and intent in _GENERALIZES and not anaphoric:
        return Resolution("education", (), (), (), False, True)
    return Resolution(intent, tuple(tickers[:2]), found.ambiguous[:4], found.missing[:2], used_context, True)


def names_something(text: str) -> bool:
    """Signs in the wording alone that a question is about a particular security."""
    if _ANAPHORA.search(text):
        return True
    tokens = _tokens(text)
    shouting = _shouting(tokens)
    for token in tokens:
        if token.cashtag:
            return True
        if token.upper and not shouting and len(token.bare) >= 2 and token.bare.upper() not in _ACRONYMS:
            return True
        if token.title and not token.initial and token.word not in _NOT_NAMES:
            return True
        if token.possessive and token.word not in _PLAIN and token.word not in _TOPIC:
            return True
    trailing = _TRAILING_OBJECT.search(text)
    if trailing:
        start, end = trailing.span("x")
        return _filler_kind([token for token in tokens if token.start >= start and token.end <= end]) == "name"
    return False


def find_companies(text: str, evidence: Evidence) -> Mentions:
    """Companies the text names, in order. Empty when it names none."""
    catalog = set(evidence.stocks) | {quote.ticker for quote in evidence.quotes}
    tokens = _tokens(text)
    shouting = _shouting(tokens)
    slots = _slots(text, tokens)
    strength: dict[int, str] = {}
    for kind, indices in slots:
        for index in indices:
            if strength.get(index) != "strong":
                strength[index] = "strong" if kind in _STRONG_SLOTS else "ask"
    names = _name_index(evidence, catalog)
    longest = max((len(key) for key in names), default=1)

    hits: list[tuple[int, str]] = []
    ambiguous: list[str] = []
    used: set[int] = set()
    i = 0
    while i < len(tokens):
        for size in range(min(longest, len(tokens) - i), 0, -1):
            span = tokens[i : i + size]
            owners = names.get(tuple(token.word for token in span))
            if not owners or not _plausible_name(span, strength, shouting):
                continue
            if len(owners) == 1:
                hits.append((i, next(iter(owners))))
            else:
                ambiguous.extend(ticker for ticker in sorted(owners) if ticker not in ambiguous)
            used.update(range(i, i + size))
            i += size
            break
        else:
            i += 1

    for token in tokens:
        if token.index in used:
            continue
        symbol = token.bare.upper()
        if symbol not in catalog:
            continue
        slot = strength.get(token.index)
        everyday = token.word in _EVERYDAY
        if (
            token.cashtag
            or (token.upper and not shouting and len(symbol) >= 2)
            or slot == "strong"
            or (slot == "ask" and len(symbol) >= 3 and not everyday)
            or (len(tokens) == 1 and not everyday)
        ):
            hits.append((token.index, symbol))
            used.add(token.index)

    missing: list[str] = []
    other: list[str] = []
    for token in tokens:
        if token.index in used or not token.bare[:1].isalpha():
            continue
        symbol = token.bare.upper()
        if token.cashtag or (
            token.upper and not shouting and 2 <= len(symbol) <= 5 and symbol.isalpha() and symbol not in _ACRONYMS
        ):
            missing.append(token.bare)
            used.add(token.index)
    for kind, indices in slots:
        if any(index in used for index in indices):
            continue
        filler = [tokens[index] for index in indices]
        filled = _filler_kind(filler)
        label = " ".join(token.bare for token in filler)[:40]
        proper = any((token.upper and not shouting) or (token.title and not token.initial) for token in filler)
        if filled == "name" and (kind in {"how", "shares"} or proper):
            missing.append(label)
        elif (filled == "topic" and kind == "how") or (filled == "name" and kind == "ask"):
            other.append(label)
        used.update(indices)
    for token in tokens:
        if token.index not in used and token.title and not token.initial and token.word not in _NOT_NAMES:
            other.append(token.bare)

    ordered: list[str] = []
    for _, ticker in sorted(hits):
        if ticker not in ordered:
            ordered.append(ticker)
    return Mentions(tuple(ordered), tuple(ambiguous), tuple(dict.fromkeys(missing)), tuple(other))


def _elliptical(text: str) -> bool:
    """A short follow-up with no subject of its own, such as "What are the current risks?"."""
    return len(text.split()) <= 8 and not _MARKET_WIDE.search(text)


@dataclass(frozen=True)
class _Token:
    index: int
    start: int
    end: int
    bare: str  # as typed, without a cashtag, a possessive, or trailing dots
    word: str  # folded to ASCII lowercase for name matching
    cashtag: bool
    possessive: bool
    initial: bool  # first word of a sentence, so capitalization says nothing

    @property
    def upper(self) -> bool:
        return self.bare.isupper()

    @property
    def title(self) -> bool:
        return self.bare[:1].isupper() and not self.bare.isupper()


def _fold(text: str) -> str:
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9&]", "", ascii_text)


def _tokens(text: str) -> list[_Token]:
    tokens: list[_Token] = []
    for match in _TOKEN.finditer(text):
        raw = match.group(2).rstrip(".'’")
        if not raw:
            continue
        possessive = re.search(r"['’]s$", raw, re.IGNORECASE) is not None
        bare = raw[:-2] if possessive else raw
        word = _fold(bare)
        if not word:
            continue
        before = text[: match.start()].rstrip(" \t\"'“‘(")
        tokens.append(
            _Token(
                index=len(tokens),
                start=match.start(2),
                end=match.start(2) + len(raw),
                bare=bare,
                word=word,
                cashtag=bool(match.group(1)) and bare[:1].isalpha(),
                possessive=possessive,
                initial=not before or before[-1] in ".!?:;\n",
            )
        )
    return tokens


def _shouting(tokens: list[_Token]) -> bool:
    """All caps carries no ticker signal."""
    worded = [token for token in tokens if any(char.isalpha() for char in token.bare)]
    return len(worded) >= 2 and all(not any(char.islower() for char in token.bare) for token in worded)


def _slots(text: str, tokens: list[_Token]) -> list[tuple[str, tuple[int, ...]]]:
    found: list[tuple[str, tuple[int, ...]]] = []
    for kind, pattern in _SLOTS:
        for match in pattern.finditer(text):
            for group in ("x", "y"):
                if group not in pattern.groupindex or match.group(group) is None:
                    continue
                start, end = match.span(group)
                indices = tuple(token.index for token in tokens if token.start >= start and token.end <= end)
                if indices:
                    found.append((kind, indices))
    return found


def _filler_kind(filler: list[_Token]) -> str:
    """plain: a pronoun or everyday word. topic: an investing word. name: possibly a company."""
    if not filler or filler[0].word in _PLAIN or all(token.word.isdigit() for token in filler):
        return "plain"
    if any(token.word in _TOPIC for token in filler):
        return "topic"
    return "name"


def _plausible_name(span: list[_Token], strength: dict[int, str], shouting: bool) -> bool:
    """A company name that is also an everyday word needs capitalization or a stock slot."""
    if len(span) > 1 or span[0].word not in _EVERYDAY:
        return True
    token = span[0]
    return (token.upper and not shouting) or (token.title and not token.initial) or token.index in strength


def _name_variants(name: str) -> list[tuple[str, ...]]:
    variants: list[tuple[str, ...]] = []
    for form in (re.sub(r"['’]s\b", "", name), name):
        words = tuple(word for word in (_fold(part) for part in re.split(r"[\s\-/,]+", form)) if re.search(r"[a-z0-9]", word))
        if words and words not in variants:
            variants.append(words)
    return variants


def _name_index(evidence: Evidence, catalog: set[str]) -> dict[tuple[str, ...], frozenset[str]]:
    index: dict[tuple[str, ...], set[str]] = {}

    def add(key: tuple[str, ...], ticker: str) -> None:
        if key and (len(key) > 1 or len(key[0]) >= 3):
            index.setdefault(key, set()).add(ticker)

    for alias, ticker in _ALIASES.items():
        if ticker in catalog:
            index.setdefault(tuple(alias.split()), set()).add(ticker)
    for ticker in catalog:
        name = evidence.name_of(ticker)
        if not name or name.upper() == ticker:
            continue
        for words in _name_variants(name):
            add(words, ticker)
            if not evidence.is_equity(ticker):
                continue  # funds match by full name or ticker only
            core = list(words)
            while core and core[-1] in _NAME_SUFFIXES:
                core.pop()
            if core and any(word not in _NAME_FILLER for word in core):
                add(tuple(core), ticker)
            for word in words:
                if len(word) >= 4 and word not in _NAME_FILLER and not word.isdigit():
                    add((word,), ticker)
    return {key: frozenset(owners) for key, owners in index.items()}


# Corporate suffixes dropped to get the name people say: "Meta Platforms" → "meta".
_NAME_SUFFIXES = frozenset(
    "holdings holding group platforms technologies pharmaceuticals company corporation corp inc co motor wholesale "
    "software networks services service international entertainment athletica beauty aerospace health energy "
    "automotive us".split()
)
# Words inside company names that do not identify one company on their own.
_NAME_FILLER = _NAME_SUFFIXES | frozenset(
    "the of and solar income realty tower american america bank general first home united union pacific parcel air "
    "lines live nation electronic arts advanced micro devices semiconductor automation chase mobile motors gamble "
    "hers trust fund select sector spdr etf".split()
)
# Catalog tickers and names that are also everyday words. Lowercase, they need a strong
# stock slot ("can stock", "how is now doing") before they count as a company.
_EVERYDAY = frozenset(
    "can now low net arm snow race shop spot cat cost mar elf pins ups dis len sap amt pep cop hims ko ma de el ea "
    "on block booking delta intuitive rocket".split()
)
# Uppercase words that are not ticker symbols.
_ACRONYMS = frozenset(
    "AI API ATH ATM CEO CFO CPI CTO DCA DD EPS ETF ETFS EU EV EVS ESG FAQ FED FOMC FOMO FX GDP IPO IPOS IRA IT LLC "
    "NAV NYSE OK OTC PE PEG PM AM PPI ROE ROI S&P SEC TV UK US USA USD YOLO YTD IMO TBH BTW LOL ET EST PST PT".split()
)
# Capitalized words that are not companies.
_TITLE_WORDS = frozenset(
    "i orbit trend score practice fed federal reserve wall street dow jones nasdaq nyse s&p sec monday tuesday "
    "wednesday thursday friday saturday sunday january february march april may june july august september "
    "october november december".split()
)
# Pronouns, determiners and everyday words that can sit in a company slot without naming one.
_PLAIN = frozenset(
    "i me my mine you your yours yourself we us our they them their he him his she her it its itself this that "
    "these those the a an any some every each all both either neither no one ones another other such there here "
    "what which who whom whose why how when where now today tonight tomorrow yesterday soon later again back ever "
    "never always still already yet too also then just only even really very so well right left next last first "
    "early late long more less most least much many few lot lots enough everything anything something nothing "
    "everyone anyone someone nobody up down high low over under out off in on at to for of with by from about into "
    "than as or and but if is are was were be been am do does did have has had will would could should can may "
    "might must going keep get make let".split()
)
# Investing words that name a topic, not a company.
_TOPIC = frozenset(
    "stock stocks share shares price prices market markets investor investors beginner beginners people company "
    "companies trader traders volume volatility valuation earnings revenue profit profits dividend dividends risk "
    "risks sector sectors index indexes indices fund funds etf etfs bond bonds option options order orders investing "
    "investment investments trading trade trades portfolio money cash economy inflation rate rates interest tech "
    "technology energy bank banks growth value penny chip chips semiconductors ai move moves trend score practice "
    "paper account news chart data".split()
)
_NOT_NAMES = _TITLE_WORDS | _PLAIN | _TOPIC
