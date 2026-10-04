"""Discovery ranking for one theme. Pure and deterministic.

DiscoveryScore blends market relevance, personal fit, news, momentum and
novelty (weights in `config.py`). A component without data is left out and the
remaining weights are renormalized, so a provider outage is neither a reward
nor a penalty. Scores order companies for exploration; none of them estimates
future returns, and zodiac is not an input here.
"""

import math
import re
from dataclasses import dataclass, field
from datetime import date, datetime

from app.discovery.config import (
    ACTIVE_TREND,
    BIG_MOVE,
    DAY_MOVE_SCALE,
    DIVERSITY_GAP,
    FAMILIARITY_FIT,
    FIT_WEIGHTS,
    HORIZON_FIT,
    HORIZON_SHIFTS,
    MAX_REASONS,
    MOMENTUM_CLIP,
    NEWS_COUNT_CAP,
    NEWS_HALF_LIFE_HOURS,
    NEWS_REASON_MIN_STORIES,
    NEWS_SATURATION,
    NEWS_WINDOW_DAYS,
    NOVELTY_FRESH,
    NOVELTY_MONTH,
    NOVELTY_MONTH_DAYS,
    NOVELTY_RECENT,
    NOVELTY_RECENT_DAYS,
    RISK_FIT,
    SCORE_ORDER,
    SCORE_WEIGHTS,
    SECTOR_MATCH,
    SECTOR_OTHER,
    STRONG_FIT,
    STYLE_FIT,
    TOP_N,
)
from app.discovery.themes import CompanyTraits
from app.ranking.explain import sector_label


@dataclass(frozen=True)
class ProfileTraits:
    risk_tolerance: str
    investment_horizon: str
    investment_style: str
    sector_interests: tuple[str, ...]
    experience_level: str
    primary_goal: str


@dataclass(frozen=True)
class MarketFacts:
    """Only what the published market data actually contains for this ticker."""

    sector: str
    price: float | None
    previous_close: float | None
    trend_score: float | None  # 0–100, set only when the signal belongs to the current generation
    relative_momentum_z: float | None  # prior-only z-score from the same signal


@dataclass(frozen=True)
class NewsStory:
    headline: str
    source: str
    url: str
    published: datetime


@dataclass(frozen=True)
class NewsFacts:
    """`available` is False when the provider call failed; an empty list means it succeeded with no stories."""

    available: bool
    stories: tuple[NewsStory, ...] = ()


@dataclass(frozen=True)
class Candidate:
    ticker: str
    name: str
    angle: str
    traits: CompanyTraits
    market: MarketFacts
    news: NewsFacts
    last_seen: date | None  # most recent earlier discovery date that showed this company


@dataclass(frozen=True)
class ScoredCandidate:
    candidate: Candidate
    score: float
    components: dict[str, float | None]
    fit_parts: dict[str, float]
    news_count: int
    day_return: float | None
    recently_seen: bool


@dataclass(frozen=True)
class DiscoveryPick:
    ticker: str
    rank: int
    score: float
    components: dict[str, float | None]
    angle: str
    about: str
    reasons: tuple[str, ...]
    news_count: int
    headline: NewsStory | None


@dataclass(frozen=True)
class ThemeRanking:
    picks: tuple[DiscoveryPick, ...]
    considered: int
    eligible: int
    exclusions: dict[str, str] = field(default_factory=dict)


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def weights_for(profile: ProfileTraits | None) -> dict[str, float]:
    weights = dict(SCORE_WEIGHTS)
    if profile is not None:
        for name, shift in HORIZON_SHIFTS.get(profile.investment_horizon, {}).items():
            weights[name] = max(0.0, weights[name] + shift)
    return weights


def fit_parts(traits: CompanyTraits, sector: str, profile: ProfileTraits) -> dict[str, float]:
    return {
        "risk": RISK_FIT[profile.risk_tolerance][traits.risk],
        "style": STYLE_FIT[profile.investment_style][traits.character],
        "horizon": HORIZON_FIT[profile.investment_horizon][traits.size],
        "familiarity": FAMILIARITY_FIT[profile.experience_level][traits.familiarity],
        "sector": SECTOR_MATCH if sector in profile.sector_interests else SECTOR_OTHER,
    }


def personal_fit(parts: dict[str, float]) -> float:
    return sum(FIT_WEIGHTS[name] * value for name, value in parts.items())


def day_return(market: MarketFacts) -> float | None:
    if market.price is None or not market.previous_close or market.previous_close <= 0:
        return None
    return market.price / market.previous_close - 1.0


def momentum(market: MarketFacts) -> float | None:
    parts: list[float] = []
    move = day_return(market)
    if move is not None and math.isfinite(move):
        parts.append(_clamp01(0.5 + move / (2 * DAY_MOVE_SCALE)))
    z = market.relative_momentum_z
    if z is not None and math.isfinite(z):
        clipped = max(-MOMENTUM_CLIP, min(MOMENTUM_CLIP, z))
        parts.append((clipped + MOMENTUM_CLIP) / (2 * MOMENTUM_CLIP))
    return sum(parts) / len(parts) if parts else None


def trend(market: MarketFacts) -> float | None:
    if market.trend_score is None or not math.isfinite(market.trend_score):
        return None
    return _clamp01(market.trend_score / 100.0)


def mentions(headline: str, names: list[str]) -> bool:
    """True when the headline names the company or one of its brands as a whole word."""
    return any(re.search(rf"(?<![A-Za-z0-9]){re.escape(name)}(?![A-Za-z0-9])", headline, re.IGNORECASE) for name in names)


def relevant(news: NewsFacts, names: list[str]) -> NewsFacts:
    """Keeps only stories about this company. Provider feeds include loosely related articles."""
    if not news.available:
        return news
    return NewsFacts(available=True, stories=tuple(s for s in news.stories if mentions(s.headline, names)))


def recent_stories(news: NewsFacts, now: datetime) -> list[NewsStory]:
    cutoff = NEWS_WINDOW_DAYS * 86_400
    out = []
    for story in news.stories:
        age = (now - story.published).total_seconds()
        if -3600 <= age <= cutoff:
            out.append(story)
    return sorted(out, key=lambda s: s.published, reverse=True)


def news_score(news: NewsFacts, now: datetime) -> float | None:
    if not news.available:
        return None
    weighted = 0.0
    for story in recent_stories(news, now):
        age_hours = max(0.0, (now - story.published).total_seconds() / 3600)
        weighted += 0.5 ** (age_hours / NEWS_HALF_LIFE_HOURS)
    return 1.0 - math.exp(-weighted / NEWS_SATURATION)


def novelty(last_seen: date | None, today: date) -> float:
    if last_seen is None:
        return NOVELTY_FRESH
    days = (today - last_seen).days
    if days <= NOVELTY_RECENT_DAYS:
        return NOVELTY_RECENT
    if days <= NOVELTY_MONTH_DAYS:
        return NOVELTY_MONTH
    return NOVELTY_FRESH


def score_candidate(
    candidate: Candidate, profile: ProfileTraits | None, today: date, now: datetime
) -> ScoredCandidate:
    parts = fit_parts(candidate.traits, candidate.market.sector, profile) if profile else {}
    components: dict[str, float | None] = {
        "trend": trend(candidate.market),
        "personal_fit": personal_fit(parts) if profile else None,
        "news": news_score(candidate.news, now),
        "momentum": momentum(candidate.market),
        "novelty": novelty(candidate.last_seen, today),
    }
    weights = weights_for(profile)
    total = sum(weights[name] for name in SCORE_ORDER if components[name] is not None)
    blended = sum(weights[name] * (components[name] or 0.0) for name in SCORE_ORDER if components[name] is not None)
    seen_days = (today - candidate.last_seen).days if candidate.last_seen else None
    return ScoredCandidate(
        candidate=candidate,
        score=blended / total if total > 0 else 0.0,
        components=components,
        fit_parts=parts,
        news_count=len(recent_stories(candidate.news, now)) if candidate.news.available else 0,
        day_return=day_return(candidate.market),
        recently_seen=seen_days is not None and seen_days <= NOVELTY_RECENT_DAYS,
    )


def select(scored: list[ScoredCandidate]) -> list[ScoredCandidate]:
    """Top names, holding back anything shown in the last week unless the theme runs short,
    and preferring a new angle when it scores close to a repeat."""
    ordered = sorted(scored, key=lambda s: (-s.score, s.candidate.ticker))
    fresh = [s for s in ordered if not s.recently_seen]
    held = [s for s in ordered if s.recently_seen]
    remaining = fresh + held
    picked: list[ScoredCandidate] = []
    while remaining and len(picked) < TOP_N:
        best = remaining[0]
        angles = {p.candidate.angle for p in picked}
        if best.candidate.angle in angles:
            alternative = next(
                (
                    r
                    for r in remaining
                    if r.candidate.angle not in angles and (best.recently_seen or not r.recently_seen)
                ),
                None,
            )
            if alternative is not None and best.score - alternative.score <= DIVERSITY_GAP:
                best = alternative
        picked.append(best)
        remaining.remove(best)
    return picked


_RISK_REASON = {
    "conservative": "Fits your preference for steadier companies",
    "moderate": "In line with the balanced risk level you chose",
    "aggressive": "Matches your comfort with bigger price swings",
}
_STYLE_REASON = {
    "growth": "Matches your interest in growing companies",
    "value": "Fits your preference for established companies",
    "income": "Fits your preference for established companies",
}


def _pick(options: list[tuple[float, str]], used: set[str]) -> str | None:
    """Strongest option, preferring a line the earlier cards have not already used."""
    ranked = [text for _, text in sorted(options, key=lambda option: -option[0])]
    return next((text for text in ranked if text not in used), ranked[0] if ranked else None)


def _personal_reason(scored: ScoredCandidate, profile: ProfileTraits, used: set[str]) -> str | None:
    parts = scored.fit_parts
    options: list[tuple[float, str]] = []
    if parts.get("sector") == SECTOR_MATCH:
        options.append((0.95, f"In {sector_label(scored.candidate.market.sector)}, a sector you chose"))
    if parts.get("risk", 0) >= STRONG_FIT:
        options.append((parts["risk"] * 0.9, _RISK_REASON[profile.risk_tolerance]))
    if parts.get("style", 0) >= STRONG_FIT and profile.investment_style in _STYLE_REASON:
        options.append((parts["style"] * 0.92, _STYLE_REASON[profile.investment_style]))
    if parts.get("horizon", 0) >= 0.95 and profile.investment_horizon == "years":
        options.append((0.85, "Fits the long-term view you chose"))
    if parts.get("familiarity", 0) >= STRONG_FIT:
        if profile.experience_level == "new":
            options.append((0.8, "A name you probably already know"))
        elif profile.experience_level == "experienced":
            options.append((0.8, "A less familiar name worth a look"))
    return _pick(options, used)


def theme_name(title: str) -> str:
    """"The Data Economy" reads as "today's Data Economy theme"."""
    return title[4:] if title.startswith("The ") else title


def _market_reason(scored: ScoredCandidate, title: str, used: set[str]) -> str | None:
    options: list[tuple[float, str]] = []
    if scored.news_count >= NEWS_REASON_MIN_STORIES:
        count = f"{NEWS_COUNT_CAP}+" if scored.news_count > NEWS_COUNT_CAP else str(scored.news_count)
        options.append((0.9, f"In the news: {count} stories in the last {NEWS_WINDOW_DAYS} days"))
    trend_value = scored.components.get("trend")
    if trend_value is not None and trend_value >= ACTIVE_TREND:
        options.append((trend_value, f"Strong recent activity in today's {theme_name(title)} theme"))
    move = scored.day_return
    if move is not None and abs(move) >= BIG_MOVE:
        sign = "+" if move > 0 else "−"
        options.append((0.7, f"Moved {sign}{abs(move) * 100:.1f}% in its latest session"))
    return _pick(options, used)


def reasons_for(
    scored: ScoredCandidate,
    profile: ProfileTraits | None,
    title: str,
    has_history: bool,
    used: set[str] | None = None,
) -> tuple[str, ...]:
    """One or two short, factual lines. Never a claim about future price. `used` holds lines
    already shown on earlier cards, so the set does not repeat itself when it has a choice."""
    seen = used if used is not None else set()
    theme_line = f"Part of today's {theme_name(title)} theme"
    novelty_line = "New to you: not in your recent discoveries" if has_history and scored.components["novelty"] == NOVELTY_FRESH else None
    personal = _personal_reason(scored, profile, seen) if profile else None
    if personal in seen and novelty_line:
        personal = novelty_line
    first = personal or novelty_line
    second = _market_reason(scored, title, seen) or (theme_line if first != theme_line else None)
    lines = [line for line in (first, second) if line]
    if not lines:
        lines = [theme_line]
    deduped: list[str] = []
    for line in lines:
        if line not in deduped:
            deduped.append(line)
    return tuple(deduped[:MAX_REASONS])


def rank_theme(
    candidates: list[Candidate],
    profile: ProfileTraits | None,
    *,
    title: str,
    today: date,
    now: datetime,
    has_history: bool,
) -> ThemeRanking:
    exclusions: dict[str, str] = {}
    eligible: list[Candidate] = []
    for candidate in candidates:
        if candidate.market.price is None or candidate.market.price <= 0:
            exclusions[candidate.ticker] = "quote_unavailable"
            continue
        eligible.append(candidate)
    scored = [score_candidate(c, profile, today, now) for c in eligible]
    picks: list[DiscoveryPick] = []
    used: set[str] = set()
    for rank, row in enumerate(select(scored), start=1):
        stories = recent_stories(row.candidate.news, now) if row.candidate.news.available else []
        reasons = reasons_for(row, profile, title, has_history, used)
        used.update(reasons)
        picks.append(
            DiscoveryPick(
                ticker=row.candidate.ticker,
                rank=rank,
                score=row.score,
                components=row.components,
                angle=row.candidate.angle,
                about=row.candidate.traits.about,
                reasons=reasons,
                news_count=row.news_count,
                headline=stories[0] if stories else None,
            )
        )
    return ThemeRanking(picks=tuple(picks), considered=len(candidates), eligible=len(eligible), exclusions=exclusions)
