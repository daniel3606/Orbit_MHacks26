"""News classification interface (PRD §11). The Jev API contract is NOT yet
verified; no adapter exists. On unavailability, semantic features are omitted
(reduced coverage) — never silently replaced by another model."""

from dataclasses import dataclass
from typing import Literal, Protocol

EventType = Literal[
    "earnings", "product", "partnership", "regulation", "M&A", "analyst_rating",
    "executive", "legal", "macro", "financing", "other",
]


@dataclass(frozen=True)
class Classification:
    relevant: bool
    relevance_score: float
    event_type: EventType
    sentiment: Literal["positive", "neutral", "negative"]
    materiality: Literal["low", "medium", "high", "critical"]
    keep: bool
    classifier_version: str


class NewsClassifier(Protocol):
    version: str

    async def available(self) -> bool: ...
    async def classify_article(
        self, *, article_id: str, ticker: str, headline: str, text: str | None, source: str, published_at: str
    ) -> Classification: ...
