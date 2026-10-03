"""Deterministic feature calculations (PRD §12). Pure functions over aligned,
validated completed-session series; index `i` is a session position and only
data at positions <= i is ever read."""

import math
from collections.abc import Sequence

from app.signals.config import SignalConfig


def simple_return(closes: Sequence[float], i: int, h: int) -> float | None:
    """R_h = P_t / P_(t-h) - 1."""
    if i - h < 0:
        return None
    return closes[i] / closes[i - h] - 1.0


def relative_return(stock: Sequence[float], bench: Sequence[float], i: int, h: int) -> float | None:
    s, b = simple_return(stock, i, h), simple_return(bench, i, h)
    return None if s is None or b is None else s - b


def momentum_raw(stock: Sequence[float], bench: Sequence[float], i: int, cfg: SignalConfig) -> float | None:
    """0.20*Rel_1d + 0.50*Rel_5d + 0.30*Rel_20d; None unless every horizon exists."""
    parts: list[float] = []
    for h in cfg.momentum_horizons:
        r = relative_return(stock, bench, i, h)
        if r is None:
            return None
        parts.append(r)
    return float(sum(w * p for w, p in zip(cfg.momentum_weights, parts, strict=True)))


def sample_std(values: Sequence[float]) -> float:
    n = len(values)
    mean = sum(values) / n
    return math.sqrt(sum((v - mean) ** 2 for v in values) / (n - 1))


def realized_vol(closes: Sequence[float], i: int, window: int) -> float | None:
    """Sample std (ddof=1) of the `window` daily simple returns ending at i (daily units)."""
    if i - window < 0:
        return None
    returns = [closes[k] / closes[k - 1] - 1.0 for k in range(i - window + 1, i + 1)]
    return sample_std(returns)


def vol_adjusted_momentum(
    stock: Sequence[float], bench: Sequence[float], i: int, cfg: SignalConfig
) -> float | None:
    m = momentum_raw(stock, bench, i, cfg)
    v = realized_vol(stock, i, cfg.vol_window)
    if m is None or v is None:
        return None
    return m / max(v, cfg.epsilon)


def volume_raw(volumes: Sequence[int | None], i: int, cfg: SignalConfig) -> float | None:
    """log(max(V_t / mean(previous `volume_window` volumes), eps)), completed sessions only."""
    w = cfg.volume_window
    if i - w < 0:
        return None
    window = volumes[i - w : i]
    current = volumes[i]
    known = [v for v in window if v is not None]
    if current is None or len(known) != w:
        return None
    mean = sum(known) / w
    if mean <= 0:
        return None
    return math.log(max(current / mean, cfg.epsilon))


def prior_zscore(
    history: Sequence[float | None], current: float, cfg: SignalConfig
) -> tuple[float | None, int]:
    """z = clip((x - mean_prior) / max(std_prior, eps), ±clip) using only the
    `baseline_window` observations strictly before the current one. Returns
    (z or None, number of prior observations used)."""
    prior = [v for v in history[-cfg.baseline_window :] if v is not None]
    if len(prior) < max(cfg.min_baseline, 2):
        return None, len(prior)
    mean = sum(prior) / len(prior)
    z = (current - mean) / max(sample_std(prior), cfg.epsilon)
    return max(-cfg.clip, min(cfg.clip, z)), len(prior)


def trend_score(composite: float) -> float:
    """100 / (1 + exp(-composite)). A heuristic, not a probability."""
    return 100.0 / (1.0 + math.exp(-composite))
