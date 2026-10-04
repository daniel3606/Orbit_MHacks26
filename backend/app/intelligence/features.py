"""PRD §12 news-feature inputs computed from classified articles.

These are raw, un-normalized values for one ticker over one window:

- relevant_events → news velocity's `CurrentRelevantEventCount` (kept articles,
  syndicated copies merged by content hash)
- recent_sentiment → sentiment shift's `RecentSentiment`
  (Σ sentiment·w / Σ w, w = relevance · 0.5^(age/half-life) · materiality weight)
- breadth_raw and materiality_mean → the two halves of breadth/materiality

The Trend Score uses each feature only as a z-score against a 30–60 day baseline
of the same window. Orbit stores no news baseline yet and ingestion does not
read news, so Trend Scores keep `news_velocity`, `sentiment_shift` and
`breadth_materiality` unavailable, and nothing here enters any published score.
The assistant shows these values as described facts about recent coverage.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime

from app.intelligence.classifier import MATERIALITIES, Materiality, Sentiment
from app.intelligence.service import Judged

SENTIMENT_VALUE: dict[Sentiment, float] = {"positive": 1.0, "neutral": 0.0, "negative": -1.0}
MATERIALITY_WEIGHT: dict[Materiality, float] = {"low": 0.25, "medium": 0.50, "high": 0.75, "critical": 1.00}
SENTIMENT_HALF_LIFE_HOURS = 36.0


@dataclass(frozen=True)
class NewsSignals:
    articles: int  # articles in the window
    classified: int  # of those, how many Jev judged (coverage numerator)
    relevant_events: int  # kept and deduplicated
    independent_sources: int
    breadth_raw: float | None  # log(1 + independent sources); None without kept events
    materiality_mean: float | None  # mean materiality weight of kept events
    highest_materiality: Materiality | None
    recent_sentiment: float | None  # −1…1; None when there is nothing to weigh, never a stand-in 0
    unavailable_reason: str | None  # why the semantic values are missing, when they are


def news_signals(items: Sequence[Judged], now: datetime, window_hours: float) -> NewsSignals:
    in_window = [
        item for item in items if -1.0 <= (now - item.article.published_at).total_seconds() / 3600 <= window_hours
    ]
    classified = [item for item in in_window if item.classification is not None]
    kept: dict[str, Judged] = {}
    for item in sorted(classified, key=lambda i: i.article.published_at):
        assert item.classification is not None
        if item.classification.keep and item.content_hash not in kept:
            kept[item.content_hash] = item  # earliest copy stands for the event

    reason: str | None = None
    if not in_window:
        reason = "no_articles"
    elif not classified:
        reasons = {item.reason for item in in_window if item.reason}
        reason = f"classification_unavailable:{sorted(reasons)[0]}" if reasons else "classification_unavailable"
    elif not kept:
        reason = "no_relevant_articles"

    sources = {" ".join(item.article.source.casefold().split()) for item in kept.values() if item.article.source.strip()}
    weights: list[tuple[float, float]] = []
    levels: list[Materiality] = []
    for item in kept.values():
        c = item.classification
        assert c is not None
        levels.append(c.materiality)
        age = max(0.0, (now - item.article.published_at).total_seconds() / 3600)
        weight = c.relevance_score * 0.5 ** (age / SENTIMENT_HALF_LIFE_HOURS) * MATERIALITY_WEIGHT[c.materiality]
        weights.append((SENTIMENT_VALUE[c.sentiment], weight))
    total = sum(w for _, w in weights)
    sentiment = sum(s * w for s, w in weights) / total if total > 0 else None
    return NewsSignals(
        articles=len(in_window),
        classified=len(classified),
        relevant_events=len(kept),
        independent_sources=len(sources),
        breadth_raw=math.log1p(len(sources)) if kept else None,
        materiality_mean=sum(MATERIALITY_WEIGHT[level] for level in levels) / len(levels) if levels else None,
        highest_materiality=max(levels, key=MATERIALITIES.index) if levels else None,
        recent_sentiment=round(sentiment, 6) if sentiment is not None else None,
        unavailable_reason=reason,
    )
