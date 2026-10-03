"""Decoding for SpacetimeDB HTTP SQL results and encoding for reducer arguments.

Formats verified against SpacetimeDB 2.10.2 `/v1/database/:name/sql` and
`/call/:reducer` (see backend/tests/test_sats_json.py for recorded samples):

* A result set is ``{"schema": ProductType, "rows": [[...], ...]}``; each row is
  a positional array in schema element order.
* ``Identity`` is a product with one ``__identity__`` element: ``["0x<hex>"]``.
* ``Timestamp`` is a product with one ``__timestamp_micros_since_unix_epoch__``
  element: ``[micros]``.
* Sums (including options) are ``[variant_index, payload]``; ``none`` payload is ``[]``.
* Reducer arguments are a JSON array in declaration order; options are
  ``{"some": v}`` / ``{"none": []}`` and identities are ``["0x<hex>"]``.
"""

from datetime import UTC, datetime, timedelta
from typing import Any


class SatsDecodeError(ValueError):
    """The server response did not match the expected SATS-JSON shape."""


_SPECIAL_PRODUCTS = {
    "__identity__",
    "__connection_id__",
    "__timestamp_micros_since_unix_epoch__",
    "__time_duration_micros__",
}


def _element_name(element: dict[str, Any]) -> str | None:
    name = element.get("name")
    if isinstance(name, dict):
        return name.get("some")
    return None


def decode_value(algebraic_type: dict[str, Any], value: Any) -> Any:
    if not isinstance(algebraic_type, dict) or len(algebraic_type) != 1:
        raise SatsDecodeError(f"unexpected type descriptor: {algebraic_type!r}")
    (kind, spec), = algebraic_type.items()

    if kind == "Product":
        elements = spec["elements"]
        if not isinstance(value, list) or len(value) != len(elements):
            raise SatsDecodeError(f"product arity mismatch for {value!r}")
        if len(elements) == 1 and _element_name(elements[0]) in _SPECIAL_PRODUCTS:
            return _decode_special(_element_name(elements[0]), value[0])
        return {
            _element_name(el) or str(i): decode_value(el["algebraic_type"], v)
            for i, (el, v) in enumerate(zip(elements, value, strict=True))
        }

    if kind == "Sum":
        variants = spec["variants"]
        if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], int):
            raise SatsDecodeError(f"sum value must be [tag, payload], got {value!r}")
        tag, payload = value
        if tag < 0 or tag >= len(variants):
            raise SatsDecodeError(f"sum tag {tag} out of range")
        names = [_element_name(v) for v in variants]
        if names == ["some", "none"]:
            return None if tag == 1 else decode_value(variants[0]["algebraic_type"], payload)
        return {"tag": names[tag], "value": decode_value(variants[tag]["algebraic_type"], payload)}

    if kind == "Array":
        if not isinstance(value, list):
            raise SatsDecodeError(f"array expected, got {value!r}")
        return [decode_value(spec, v) for v in value]

    if kind == "String":
        if not isinstance(value, str):
            raise SatsDecodeError("string expected")
        return value
    if kind == "Bool":
        if not isinstance(value, bool):
            raise SatsDecodeError("bool expected")
        return value
    if kind in {"U8", "U16", "U32", "U64", "U128", "U256", "I8", "I16", "I32", "I64", "I128", "I256"}:
        if isinstance(value, bool) or not isinstance(value, int):
            raise SatsDecodeError(f"{kind} expected integer, got {value!r}")
        return value
    if kind in {"F32", "F64"}:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise SatsDecodeError(f"{kind} expected number")
        return float(value)

    raise SatsDecodeError(f"unsupported type kind {kind!r}")


def _decode_special(name: str | None, raw: Any) -> Any:
    if name in ("__identity__", "__connection_id__"):
        if isinstance(raw, str):
            return raw.removeprefix("0x").lower()
        if isinstance(raw, int):
            return f"{raw:064x}"
        raise SatsDecodeError("identity must be hex string")
    if name == "__timestamp_micros_since_unix_epoch__":
        if not isinstance(raw, int):
            raise SatsDecodeError("timestamp micros must be integer")
        return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(microseconds=raw)
    if name == "__time_duration_micros__":
        return timedelta(microseconds=raw)
    raise SatsDecodeError(f"unknown special product {name!r}")


def decode_result_set(result: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        elements = result["schema"]["elements"]
        rows = result["rows"]
    except (KeyError, TypeError) as exc:
        raise SatsDecodeError("result set missing schema/rows") from exc
    product = {"Product": {"elements": elements}}
    return [decode_value(product, row) for row in rows]


# ---- reducer argument encoding ----

NONE: dict[str, list[Any]] = {"none": []}


def some(value: Any) -> dict[str, Any]:
    return {"some": value}


def option(value: Any | None) -> dict[str, Any]:
    return NONE if value is None else some(value)


def identity_arg(identity_hex: str) -> list[str]:
    hex_value = identity_hex.removeprefix("0x").lower()
    if len(hex_value) != 64 or any(c not in "0123456789abcdef" for c in hex_value):
        raise ValueError("identity must be 64 hex characters")
    return [f"0x{hex_value}"]
