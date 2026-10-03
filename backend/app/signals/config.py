"""Versioned, configurable signal settings (PRD §12–13).

All weights and thresholds are starting heuristics, not validated settings.
"""

from dataclasses import dataclass, field

ALGORITHM_VERSION = "trend-v1.0.0"

FEATURE_WEIGHTS: dict[str, float] = {
    "relative_momentum": 0.25,
    "vol_adjusted_momentum": 0.10,
    "abnormal_volume": 0.20,
    "news_velocity": 0.20,
    "sentiment_shift": 0.10,
    "breadth_materiality": 0.15,
}
PRICE_VOLUME_FEATURES = ("relative_momentum", "vol_adjusted_momentum", "abnormal_volume")
NEWS_FEATURES = ("news_velocity", "sentiment_shift", "breadth_materiality")


@dataclass(frozen=True)
class SignalConfig:
    algorithm_version: str = ALGORITHM_VERSION
    momentum_horizons: tuple[int, int, int] = (1, 5, 20)
    momentum_weights: tuple[float, float, float] = (0.20, 0.50, 0.30)
    vol_window: int = 20  # daily returns used for realized volatility
    volume_window: int = 20  # prior completed sessions in the volume baseline
    baseline_window: int = 60  # prior feature observations for normalization
    min_baseline: int = 60  # required prior observations before a z-score is used
    epsilon: float = 1e-6
    clip: float = 3.0
    feature_weights: dict[str, float] = field(default_factory=lambda: dict(FEATURE_WEIGHTS))
    publication_min_coverage: float = 0.55
    required_for_publication: tuple[str, ...] = ("relative_momentum", "abnormal_volume")
    # Unadjusted series: a one-day move beyond this is treated as a possible
    # corporate action and blocks history features until reconciled.
    corporate_action_jump: float = 0.40

    @property
    def lookback(self) -> int:
        return max(max(self.momentum_horizons), self.vol_window, self.volume_window)

    @property
    def required_sessions(self) -> int:
        """Closes needed for a fully normalized latest observation."""
        return self.lookback + self.baseline_window + 1
