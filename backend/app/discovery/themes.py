"""Typed loader for the zodiac → sector → sub-theme → company configuration.

The JSON file is the only place themes are defined. Validation ties it to the
ingestion universe so every company a theme can show has quotes, a logo and a
stock-detail screen.
"""

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.config.universe import Universe, load_universe

THEMES_FILE = Path(__file__).resolve().parents[1] / "config" / "discovery_themes.json"
ZODIAC_SIGNS = (
    "aries",
    "taurus",
    "gemini",
    "cancer",
    "leo",
    "virgo",
    "libra",
    "scorpio",
    "sagittarius",
    "capricorn",
    "aquarius",
    "pisces",
)
ID = r"^[a-z0-9][a-z0-9_-]{0,47}$"
MIN_COMPANIES_PER_SUBTHEME = 4


class _M(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class ThemeCompany(_M):
    ticker: str
    angle: str = Field(min_length=1, max_length=40)


class Subtheme(_M):
    title: str = Field(min_length=1, max_length=48)
    description: str = Field(min_length=1, max_length=140)
    companies: list[ThemeCompany] = Field(min_length=MIN_COMPANIES_PER_SUBTHEME, max_length=8)


class Sector(_M):
    name: str = Field(min_length=1, max_length=40)
    subthemes: list[str] = Field(min_length=1)


class CompanyTraits(_M):
    # Names a relevant headline uses (company, brands). A story counts only if it mentions one.
    names: list[str] = Field(min_length=1, max_length=6)
    size: Literal["mega", "large", "mid"]
    risk: Literal["lower", "medium", "higher"]
    familiarity: Literal["high", "medium", "low"]
    character: Literal["established", "growth", "emerging"]
    about: str = Field(min_length=1, max_length=120)


class ThemeConfig(_M):
    version: str
    notes: str = ""
    zodiac: dict[str, list[str]]
    fallback_sectors: list[str] = Field(min_length=2)
    sectors: dict[str, Sector]
    subthemes: dict[str, Subtheme]
    companies: dict[str, CompanyTraits]

    @model_validator(mode="after")
    def references(self) -> "ThemeConfig":
        if sorted(self.zodiac) != sorted(ZODIAC_SIGNS):
            raise ValueError("every zodiac sign needs exactly one entry")
        for sign, sectors in [*self.zodiac.items(), ("fallback", self.fallback_sectors)]:
            if len(sectors) < 2 or len(set(sectors)) != len(sectors):
                raise ValueError(f"{sign}: needs at least two distinct sectors")
            for listed in sectors:
                if listed not in self.sectors:
                    raise ValueError(f"{sign}: unknown sector {listed}")
        used: set[str] = set()
        for sector_id, sector in self.sectors.items():
            if not re.match(ID, sector_id):
                raise ValueError(f"bad sector id {sector_id}")
            for sub_ref in sector.subthemes:
                if sub_ref not in self.subthemes:
                    raise ValueError(f"{sector_id}: unknown sub-theme {sub_ref}")
                if sub_ref in used:
                    raise ValueError(f"sub-theme {sub_ref} belongs to two sectors")
                used.add(sub_ref)
        for sub_id, sub in self.subthemes.items():
            if not re.match(ID, sub_id):
                raise ValueError(f"bad sub-theme id {sub_id}")
            if sub_id not in used:
                raise ValueError(f"sub-theme {sub_id} is not reachable from any sector")
            tickers = [c.ticker for c in sub.companies]
            if len(set(tickers)) != len(tickers):
                raise ValueError(f"{sub_id}: duplicate ticker")
            for ticker in tickers:
                if ticker not in self.companies:
                    raise ValueError(f"{sub_id}: {ticker} has no company traits")
        return self

    def sector_of(self, subtheme_id: str) -> str:
        for sector_id, sector in self.sectors.items():
            if subtheme_id in sector.subthemes:
                return sector_id
        raise KeyError(subtheme_id)

    def sectors_for(self, zodiac: str | None) -> list[str]:
        if zodiac is not None and zodiac in self.zodiac:
            return list(self.zodiac[zodiac])
        return list(self.fallback_sectors)

    def check_universe(self, universe: Universe) -> None:
        equities = {e.ticker for e in universe.equities}
        missing = sorted({c.ticker for s in self.subthemes.values() for c in s.companies} - equities)
        if missing:
            raise ValueError(f"theme tickers missing from the universe: {', '.join(missing)}")


@lru_cache
def load_themes(path: Path = THEMES_FILE) -> ThemeConfig:
    config = ThemeConfig.model_validate(json.loads(path.read_text(encoding="utf-8")))
    config.check_universe(load_universe())
    return config
