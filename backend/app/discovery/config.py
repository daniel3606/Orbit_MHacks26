"""Versioned Discovery settings (discovery-v1.0.0).

Every weight and window used by the daily discovery lives here. They are
starting heuristics for variety and relevance, not predictions: no component
estimates whether a price will rise.
"""

ALGORITHM_VERSION = "discovery-v1.0.0"

# DiscoveryScore = Σ weight × component over the components that are available,
# renormalized over those weights (missing news does not count as bad news).
SCORE_WEIGHTS: dict[str, float] = {
    "trend": 0.30,  # published Trend Score: relative momentum and abnormal volume vs its sector
    "personal_fit": 0.25,  # curated company traits vs the saved investment profile
    "news": 0.20,  # recent company headlines from the provider
    "momentum": 0.15,  # last-session move and recent relative momentum
    "novelty": 0.10,  # how recently this person was shown the company
}
SCORE_ORDER = ("trend", "personal_fit", "news", "momentum", "novelty")

# Time horizon nudges how much current activity matters. Shifts sum to zero.
HORIZON_SHIFTS: dict[str, dict[str, float]] = {
    "weeks": {"momentum": 0.05, "personal_fit": -0.05},
    "months": {},
    "years": {"momentum": -0.05, "personal_fit": 0.05},
}

# Personal fit: component weights (sum to 1) and lookup tables.
FIT_WEIGHTS: dict[str, float] = {
    "risk": 0.35,
    "style": 0.25,
    "horizon": 0.20,
    "familiarity": 0.10,
    "sector": 0.10,
}
RISK_FIT: dict[str, dict[str, float]] = {
    "conservative": {"lower": 1.0, "medium": 0.55, "higher": 0.10},
    "moderate": {"lower": 0.75, "medium": 1.0, "higher": 0.55},
    "aggressive": {"lower": 0.45, "medium": 0.80, "higher": 1.0},
}
STYLE_FIT: dict[str, dict[str, float]] = {
    "growth": {"established": 0.45, "growth": 1.0, "emerging": 0.80},
    "value": {"established": 1.0, "growth": 0.50, "emerging": 0.20},
    "income": {"established": 1.0, "growth": 0.40, "emerging": 0.10},
    "balanced": {"established": 0.80, "growth": 0.80, "emerging": 0.50},
}
HORIZON_FIT: dict[str, dict[str, float]] = {
    "years": {"mega": 1.0, "large": 0.85, "mid": 0.50},
    "months": {"mega": 0.85, "large": 0.90, "mid": 0.70},
    "weeks": {"mega": 0.70, "large": 0.70, "mid": 0.70},
}
FAMILIARITY_FIT: dict[str, dict[str, float]] = {
    "new": {"high": 1.0, "medium": 0.60, "low": 0.30},
    "some": {"high": 0.80, "medium": 0.80, "low": 0.60},
    "experienced": {"high": 0.50, "medium": 0.80, "low": 1.0},
}
SECTOR_MATCH = 1.0
SECTOR_OTHER = 0.30

# Novelty from the person's own discovery history (calendar days before today).
NOVELTY_RECENT_DAYS = 7  # shown within this window: novelty 0 and held back if possible
NOVELTY_MONTH_DAYS = 30  # shown within this window: partial novelty
NOVELTY_RECENT = 0.0
NOVELTY_MONTH = 0.4
NOVELTY_FRESH = 1.0
HISTORY_DAYS = 30  # history read by the worker

# Momentum: a last-session move of ±DAY_MOVE_SCALE maps to 1/0 around 0.5.
DAY_MOVE_SCALE = 0.04
MOMENTUM_CLIP = 3.0  # normalized relative momentum is a z-score clipped to ±3

# News: recency-weighted count of stories in the window, saturating toward 1.
NEWS_WINDOW_DAYS = 3
NEWS_HALF_LIFE_HOURS = 36.0
NEWS_SATURATION = 2.0
NEWS_MAX_ITEMS = 30  # stories read per company; only those naming the company are kept
NEWS_COUNT_CAP = 10  # shown as "10+" above this
NEWS_TIMEOUT_SECONDS = 8.0

# Final set.
TOP_N = 3
MIN_ITEMS = 2  # fewer eligible names than this moves on to the next theme in today's order
# A later card may take a new angle when its score is within this of the best remaining same-angle card.
DIVERSITY_GAP = 0.12

# Theme rotation.
THEME_WINDOW_DAYS = 6  # look-back window for broad-sector repetition
MAX_SECTOR_REPEATS = 2  # a sector already used this many times in the window is skipped when possible

# Reason thresholds.
STRONG_FIT = 0.85
ACTIVE_TREND = 0.65
NEWS_REASON_MIN_STORIES = 2
BIG_MOVE = 0.02

MAX_REASONS = 2
