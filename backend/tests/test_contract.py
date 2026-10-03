"""Cross-language contract tests using SQL responses recorded from
SpacetimeDB 2.10.2 (tests/fixtures). Identities in fixtures are public
identifiers from a local dev database; no tokens are stored."""

import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.state.dto import InvestmentProfileV1, JobV1, ServiceGrantV1
from app.state.sats_json import NONE, SatsDecodeError, decode_result_set, identity_arg, option, some

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> list[dict]:
    (result,) = json.loads((FIXTURES / name).read_text())
    return decode_result_set(result)


def test_job_rows_decode_to_dto():
    (row,) = load("sql_my_jobs.json")
    job = JobV1.model_validate(row)
    assert job.job_id == 1
    assert job.status == "queued"
    assert job.kind == "refresh_recommendations"
    assert len(job.owner) == 64 and not job.owner.startswith("0x")
    assert job.lease_owner is None and job.lease_until is None and job.result_ref is None
    assert job.created_at.tzinfo is UTC
    assert job.created_at > datetime(2026, 1, 1, tzinfo=UTC)


def test_profile_rows_decode_to_dto():
    (row,) = load("sql_my_profile.json")
    profile = InvestmentProfileV1.model_validate(row)
    assert profile.profile_version >= 1
    assert profile.sector_interests == ["technology", "healthcare"]
    assert "zodiac_sign" not in row  # branding is not part of ranking inputs


def test_service_grant_decodes():
    (row,) = load("sql_my_service_grant.json")
    grant = ServiceGrantV1.model_validate(row)
    assert grant.label == "dev-worker"


def test_dto_rejects_unknown_fields():
    (row,) = load("sql_my_jobs.json")
    with pytest.raises(ValidationError):
        JobV1.model_validate({**row, "surprise": 1})


def test_option_some_decodes():
    schema = {"elements": [{"name": {"some": "x"}, "algebraic_type": {"Sum": {"variants": [
        {"name": {"some": "some"}, "algebraic_type": {"String": []}},
        {"name": {"some": "none"}, "algebraic_type": {"Product": {"elements": []}}},
    ]}}}]}
    assert decode_result_set({"schema": schema, "rows": [[[0, "hi"]], [[1, []]]]}) == [{"x": "hi"}, {"x": None}]


def test_malformed_rows_raise():
    schema = {"elements": [{"name": {"some": "n"}, "algebraic_type": {"U32": []}}]}
    with pytest.raises(SatsDecodeError):
        decode_result_set({"schema": schema, "rows": [["not-a-number"]]})
    with pytest.raises(SatsDecodeError):
        decode_result_set({"schema": schema, "rows": [[1, 2]]})


def test_argument_encoding():
    assert some("leo") == {"some": "leo"}
    assert option(None) == NONE == {"none": []}
    hex_id = "c2" + "0" * 62
    assert identity_arg("0x" + hex_id.upper()) == ["0x" + hex_id]
    with pytest.raises(ValueError):
        identity_arg("0xnothex")
