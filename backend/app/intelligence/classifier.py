"""News classification interface (PRD §11).

The Jev adapter (`app/intelligence/jev.py`) implements this through OpenRouter's
Decisions API. On unavailability, semantic features are omitted (reduced
coverage) — never replaced by another model or read as neutral sentiment."""

from dataclasses import dataclass
from typing import Literal, Protocol, get_args

EventType = Literal[
    "earnings", "product", "partnership", "regulation", "M&A", "analyst_rating",
    "executive", "legal", "macro", "financing", "other",
]
Sentiment = Literal["positive", "neutral", "negative"]
Materiality = Literal["low", "medium", "high", "critical"]

EVENT_TYPES: tuple[EventType, ...] = get_args(EventType)
SENTIMENTS: tuple[Sentiment, ...] = get_args(Sentiment)
MATERIALITIES: tuple[Materiality, ...] = get_args(Materiality)  # ordered low → critical

# Stable reason codes for a missing classification. Shown as coverage, never as a label.
UnavailableReason = Literal[
    "not_configured",
    "auth_failed",  # HTTP 401: classification is switched off until the key is fixed
    "payment_required",  # HTTP 402: credits exhausted; paused for a while
    "rejected_by_provider",  # HTTP 403: moderation or guardrail block for this article
    "rate_limited",
    "provider_unavailable",  # 5xx, timeouts, network errors after retries
    "invalid_request",
    "invalid_response",  # the response did not match the documented schema
    "paused",  # a recent failure paused calls; retried after the pause
    "deadline",  # the caller's time budget ran out first
]


@dataclass(frozen=True)
class Classification:
    relevant: bool
    relevance_score: float
    event_type: EventType
    sentiment: Sentiment
    materiality: Materiality
    keep: bool
    classifier_version: str


class ClassificationUnavailable(Exception):
    """No classification for this article. `reason` is a stable code; the message never holds secrets."""

    def __init__(self, reason: UnavailableReason, *, status: int | None = None):
        super().__init__(reason)
        self.reason: UnavailableReason = reason
        self.status = status


class NewsClassifier(Protocol):
    version: str

    async def available(self) -> bool: ...
    async def classify_article(
        self, *, article_id: str, ticker: str, headline: str, text: str | None, source: str, published_at: str
    ) -> Classification: ...
