"""Fixed-point money and quantities.

SpacetimeDB stores integer micro-units (1e-6). Python keeps Decimal until the
reducer boundary. Display code must not round-trip through binary floats.
"""

from decimal import Decimal, ROUND_HALF_EVEN

SCALE = Decimal(1_000_000)
_ONE = Decimal(1)


def to_micros(value: Decimal) -> int:
    quantized = (value * SCALE).quantize(_ONE, rounding=ROUND_HALF_EVEN)
    return int(quantized)


def from_micros(value: int) -> Decimal:
    return Decimal(value) / SCALE


def parse_decimal(raw: str | None) -> Decimal | None:
    if raw is None or raw == "":
        return None
    return Decimal(raw)
