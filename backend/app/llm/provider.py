"""Explanation provider interface (PRD §16). OpenAI adapter: Phase 6.
Inputs are structured evidence; outputs cite evidence IDs. Deterministic
fallbacks must keep the product usable when this provider is down."""

from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class EvidenceRef:
    evidence_id: str
    url: str
    published_at: str


@dataclass(frozen=True)
class Explanation:
    text: str
    cited_evidence_ids: tuple[str, ...]
    model: str
    prompt_version: str


class ExplanationProvider(Protocol):
    async def available(self) -> bool: ...
    async def explain(self, *, facts: dict[str, object], evidence: list[EvidenceRef]) -> Explanation: ...
