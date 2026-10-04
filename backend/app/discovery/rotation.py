"""Deterministic daily theme selection.

For one sign and one calendar day the order of candidate themes is fixed:
sectors are shuffled by hash(date | sign | sector) and, inside each sector,
sub-themes by hash(date | sign | sub-theme). A hash per item (rather than
`seed % n` with a rising seed) keeps consecutive days from stepping through the
list in an obvious sequence.

The person's own history then trims repetition: yesterday's sub-theme is
skipped, and a broad sector already used MAX_SECTOR_REPEATS times in the last
THEME_WINDOW_DAYS is skipped when another option exists. Without history the
date-based order alone decides. Zodiac only chooses the part of the market to
explore; it is never a scoring input.
"""

import hashlib
from dataclasses import dataclass
from datetime import date, timedelta

from app.discovery.config import MAX_SECTOR_REPEATS, THEME_WINDOW_DAYS
from app.discovery.themes import ThemeConfig


@dataclass(frozen=True)
class ThemePick:
    sector_id: str
    subtheme_id: str


@dataclass(frozen=True)
class PastTheme:
    day: date
    sector_id: str
    subtheme_id: str


def _rank(*parts: str) -> int:
    digest = hashlib.sha256("|".join(parts).encode("utf-8")).digest()
    return int.from_bytes(digest[:8], "big")


def daily_order(config: ThemeConfig, zodiac: str | None, day: date) -> list[ThemePick]:
    """Every theme reachable for this sign, in today's deterministic order (history ignored)."""
    sign = zodiac if zodiac in config.zodiac else "fallback"
    stamp = day.isoformat()
    sectors = sorted(config.sectors_for(zodiac), key=lambda s: _rank(stamp, sign, "sector", s))
    # Round-robin across sectors so the second choice is a different sector, not a sibling sub-theme.
    per_sector = [
        sorted(config.sectors[s].subthemes, key=lambda sub: _rank(stamp, sign, "subtheme", sub)) for s in sectors
    ]
    order: list[ThemePick] = []
    depth = max(len(subs) for subs in per_sector)
    for level in range(depth):
        for sector_id, subs in zip(sectors, per_sector, strict=True):
            if level < len(subs):
                order.append(ThemePick(sector_id, subs[level]))
    return order


def ordered_themes(
    config: ThemeConfig, zodiac: str | None, day: date, history: list[PastTheme]
) -> list[ThemePick]:
    """Today's themes, best first, after the repetition rules. Later entries are fallbacks."""
    order = daily_order(config, zodiac, day)
    earlier = [h for h in history if h.day < day]
    yesterday = {h.subtheme_id for h in earlier if h.day == day - timedelta(days=1)}
    window_start = day - timedelta(days=THEME_WINDOW_DAYS)
    counts: dict[str, int] = {}
    for h in earlier:
        if h.day >= window_start:
            counts[h.sector_id] = counts.get(h.sector_id, 0) + 1

    def rested(pick: ThemePick) -> bool:
        return pick.subtheme_id not in yesterday

    def balanced(pick: ThemePick) -> bool:
        return counts.get(pick.sector_id, 0) < MAX_SECTOR_REPEATS

    preferred = [p for p in order if rested(p) and balanced(p)]
    relaxed = [p for p in order if rested(p) and not balanced(p)]
    last_resort = [p for p in order if not rested(p)]
    return preferred + relaxed + last_resort
