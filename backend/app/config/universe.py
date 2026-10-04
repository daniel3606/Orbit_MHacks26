"""Typed loader for the configurable ticker universe."""

import json
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, model_validator

UNIVERSE_FILE = Path(__file__).with_name("universe.json")
TICKER = r"^[A-Z][A-Z0-9.]{0,9}$"


class _M(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class BenchmarkEntry(_M):
    ticker: str = Field(pattern=TICKER)
    name: str
    sector: str


class EquityEntry(_M):
    ticker: str = Field(pattern=TICKER)
    sector: str
    benchmark: str = Field(pattern=TICKER)
    # Shown until the provider profile is stored; the profile name wins once fetched.
    name: str = Field(default="", max_length=120)


class Universe(_M):
    version: str
    notes: str = ""
    fallback_benchmark: str
    benchmarks: list[BenchmarkEntry]
    equities: list[EquityEntry] = Field(min_length=1, max_length=150)

    @model_validator(mode="after")
    def references(self) -> "Universe":
        bench = {b.ticker for b in self.benchmarks}
        if self.fallback_benchmark not in bench:
            raise ValueError("fallback benchmark must be listed")
        tickers = [e.ticker for e in self.equities] + list(bench)
        if len(set(tickers)) != len(tickers):
            raise ValueError("duplicate tickers")
        for e in self.equities:
            if e.benchmark not in bench:
                raise ValueError(f"{e.ticker}: unknown benchmark {e.benchmark}")
        return self

    @property
    def all_tickers(self) -> list[str]:
        return [e.ticker for e in self.equities] + [b.ticker for b in self.benchmarks]


@lru_cache
def load_universe(path: Path = UNIVERSE_FILE) -> Universe:
    return Universe.model_validate(json.loads(path.read_text(encoding="utf-8")))
