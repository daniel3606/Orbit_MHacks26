"""Versioned user-fit rubric (fit-v1.0.0).

Weights follow the PRD. Horizon and style stay in the formula so coverage can
record that they were not scored. They are never filled in from daily momentum
or from a guessed growth/value/income label.

Risk ceilings are starting heuristics, not optimized thresholds.
A rough annualized scale is daily volatility times sqrt(252); the product
shows the daily figure, not that annualized number.
"""

ALGORITHM_VERSION = "fit-v1.0.0"
SIGNAL_ALGORITHM_VERSION = "trend-v1.0.0"

TREND_BLEND = 0.60
FIT_BLEND = 0.40

# Original component weights. Available weights are renormalized; coverage keeps this sum.
COMPONENT_WEIGHTS: dict[str, float] = {
    "risk_match": 0.40,
    "horizon_match": 0.30,
    "style_match": 0.20,
    "sector_preference": 0.10,
}
COMPONENT_ORDER = ("risk_match", "horizon_match", "style_match", "sector_preference")

# 20-session sample standard deviation of daily simple returns.
VOL_CEILING: dict[str, float | None] = {
    "conservative": 0.015,
    "moderate": 0.025,
    "aggressive": None,
}
# Most negative peak-to-trough return over up to 60 completed sessions.
DRAWDOWN_FLOOR: dict[str, float | None] = {
    "conservative": -0.15,
    "moderate": -0.28,
    "aggressive": None,
}
RISK_VOL_WEIGHT = 0.70
RISK_DRAWDOWN_WEIGHT = 0.30

VOL_WINDOW = 20
DRAWDOWN_WINDOW = 60
# Successive stored sessions further apart than this are treated as a hole.
# A 4-day gap covers a holiday weekend. A missing week does not.
MAX_SESSION_GAP_DAYS = 4
TOP_N = 3
# A later slot may take a new sector when that stock's rank is within this many
# points of the best remaining same-sector stock. Risk limits are not relaxed.
VARIETY_RANK_GAP = 15.0

REQUIRED_LIMITATION_CODES = (
    "horizon_not_scored",
    "style_not_classified",
    "price_volume_only",
)
