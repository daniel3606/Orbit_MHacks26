"""End-to-end worker round trip against a real local SpacetimeDB.

Requires `spacetime start` and the module published as `orbit-test`
(`cd spacetime/tests && npm run publish:test-db`). Skipped otherwise.
Uses fresh identities each run; the CLI identity (module admin) grants and
revokes the test worker.
"""

import os
import shutil
import subprocess
import uuid

import httpx
import pytest
from pydantic import SecretStr

from app.state.gateway import ReducerRejected, SpacetimeGateway
from app.state.sats_json import NONE, some
from app.workers.handlers import default_handlers
from app.workers.runner import Worker

BASE = os.environ.get("STDB_HTTP_URL", "http://127.0.0.1:3000")
DB = os.environ.get("STDB_TEST_DB", "orbit-test")


def _server_ready() -> bool:
    try:
        ok = httpx.get(f"{BASE}/v1/ping", timeout=2).status_code == 200
        db = httpx.post(f"{BASE}/v1/database/{DB}/sql", content=b"SELECT * FROM my_jobs", timeout=2)
        return ok and db.status_code == 200 and shutil.which("spacetime") is not None
    except httpx.HTTPError:
        return False


pytestmark = pytest.mark.skipif(not _server_ready(), reason="local SpacetimeDB with orbit-test not available")


def new_identity() -> tuple[str, SecretStr]:
    body = httpx.post(f"{BASE}/v1/identity", timeout=5).json()
    return body["identity"], SecretStr(body["token"])


def cli(*args: str) -> None:
    subprocess.run(["spacetime", "call", "--no-config", DB, "--server", "local", *args], check=True, capture_output=True)


PREFS = ["moderate", "years", "growth", ["technology"], "new", "learn_basics"]


@pytest.fixture
async def actors():
    svc_id, svc_token = new_identity()
    user_id, user_token = new_identity()
    cli("grant_service_identity", f'"0x{svc_id}"', '"pytest-worker"')
    svc = SpacetimeGateway(BASE, DB, svc_token)
    user = SpacetimeGateway(BASE, DB, user_token)
    yield svc_id, svc, user_id, user
    cli("revoke_service_identity", f'"0x{svc_id}"')
    await svc.aclose()
    await user.aclose()


async def test_enqueue_claim_complete_round_trip(actors):
    svc_id, svc, user_id, user = actors
    grant = await svc.service_grant()
    assert grant is not None and grant.identity == svc_id

    await user.call_reducer("complete_onboarding", [*PREFS, some("leo")])
    await user.call_reducer("update_preferences", [1, "aggressive", "years", "growth", ["technology"], "new", "learn_basics", NONE])
    key = f"pytest-{uuid.uuid4().hex[:12]}"
    await user.call_reducer("request_backend_check", [key])
    await user.call_reducer("request_backend_check", [key])  # idempotent duplicate

    # Before registering, a service worker is offered nothing.
    assert await svc.worker_jobs() == []
    await svc.register_worker(["backend_check"])
    offered = await svc.worker_jobs()
    assert offered and all(j.kind == "backend_check" for j in offered)  # never refresh_recommendations

    mine = [j for j in await user.my_jobs() if j.kind == "backend_check"]
    assert len(mine) == 1 and mine[0].status == "queued" and mine[0].input_version == 2

    worker = Worker(svc, default_handlers("pytest"), identity_hex=svc_id, lease_seconds=30, concurrency=2)
    claimed = await worker.run_once()
    assert claimed >= 1

    (done,) = [j for j in await user.my_jobs() if j.request_key == key]
    assert done.status == "succeeded"
    assert done.attempt_count == 1
    assert done.lease_owner == svc_id
    assert done.result_ref == "worker=pytest;observed_profile_version=2"

    # Retried completion from the same lease holder is a no-op.
    await svc.complete_job(done.job_id, 1, 2, "changed")
    (again,) = [j for j in await user.my_jobs() if j.request_key == key]
    assert again.result_ref == done.result_ref and again.updated_at == done.updated_at

    # refresh_recommendations has no handler yet (Phase 4) and must stay queued, not faked.
    refresh = [j for j in await user.my_jobs() if j.kind == "refresh_recommendations"]
    assert len(refresh) == 1 and refresh[0].status == "queued"


async def test_consumer_cannot_use_service_paths(actors):
    _svc_id, _svc, user_id, user = actors
    await user.call_reducer("request_backend_check", [f"pytest-{uuid.uuid4().hex[:12]}"])
    (job,) = [j for j in await user.my_jobs() if j.kind == "backend_check"]
    assert await user.worker_jobs() == []
    assert await user.worker_job_profiles() == []
    assert await user.service_grant() is None
    for reducer, args in [
        ("claim_job", [job.job_id, 30]),
        ("complete_job", [job.job_id, 1, 0, "x"]),
        ("fail_job", [job.job_id, 1, "x", False]),
    ]:
        with pytest.raises(ReducerRejected) as info:
            await user.call_reducer(reducer, args)
        assert info.value.code == "not_authorized_service"
    with pytest.raises(ReducerRejected) as info:
        await user.call_reducer("grant_service_identity", [[f"0x{user_id}"], "me"])
    assert info.value.code == "not_authorized_admin"
