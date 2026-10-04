"""Which classified stories to show or cite (assistant evidence and Stock Detail news).

    up to 8 recent company headlines → Jev → drop what Jev did not keep
    → merge syndicated copies → rank → best 3, newest first

Rank = relevance × 0.5^(age / 36 h) × materiality weight, the same weight the
PRD sentiment input uses, so a fresh, material, clearly relevant story leads.
A story Jev judged and did not keep is never shown. A story Jev could not judge
(provider unavailable) gets no label; it only fills empty places when the caller
allows that, and only when its headline names the company if names are given.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from datetime import datetime

from app.discovery.scoring import mentions
from app.intelligence.features import MATERIALITY_WEIGHT, SENTIMENT_HALF_LIFE_HOURS
from app.intelligence.service import Judged

CANDIDATES = 8  # headlines read per company
SHOWN = 3  # stories kept for display or evidence

_SUFFIX = re.compile(
    r"[,.]?\s+(inc|incorporated|corp|corporation|co|company|plc|ltd|limited|holdings?|group|n\.?v|s\.?a|ag|"
    r"class [a-z])\.?$",
    re.IGNORECASE,
)


def rank_weight(item: Judged, now: datetime) -> float:
    c = item.classification
    if c is None:
        return 0.0
    age_hours = max(0.0, (now - item.article.published_at).total_seconds() / 3600)
    decay: float = 0.5 ** (age_hours / SENTIMENT_HALF_LIFE_HOURS)
    return c.relevance_score * decay * MATERIALITY_WEIGHT[c.materiality]


def best_stories(
    items: Sequence[Judged],
    now: datetime,
    *,
    limit: int = SHOWN,
    fill_unclassified: bool,
    names: Sequence[str] | None = None,
) -> list[Judged]:
    kept: dict[str, Judged] = {}
    for item in sorted(items, key=lambda i: i.article.published_at):
        c = item.classification
        if c is not None and c.keep and item.content_hash not in kept:
            kept[item.content_hash] = item  # earliest copy stands for a syndicated story
    chosen = sorted(kept.values(), key=lambda i: (-rank_weight(i, now), -i.article.published_at.timestamp()))[:limit]
    if fill_unclassified and len(chosen) < limit:
        seen = {item.content_hash for item in chosen}
        for item in sorted(items, key=lambda i: i.article.published_at, reverse=True):
            if item.classification is not None or item.content_hash in seen:
                continue
            if names and not mentions(item.article.headline, list(names)):
                continue
            chosen.append(item)
            seen.add(item.content_hash)
            if len(chosen) >= limit:
                break
    return sorted(chosen, key=lambda i: i.article.published_at, reverse=True)


def company_names(name: str, extra: Sequence[str] = ()) -> list[str]:
    """Names a headline may use for the company: curated brands plus the listed name without
    its legal suffix ("Apple Inc." → "Apple"). Tickers are left out; many are ordinary words."""
    base = name.strip()
    while True:
        stripped = _SUFFIX.sub("", base).strip()
        if stripped == base:
            break
        base = stripped
    out: list[str] = []
    for candidate in [*extra, base]:
        if candidate and candidate not in out:
            out.append(candidate)
    return out
