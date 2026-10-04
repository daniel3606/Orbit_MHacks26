"""The polling loop keeps claiming new work while a slow job is still running."""

import asyncio
from datetime import UTC, datetime, timedelta

from app.state.dto import JobV1
from app.workers.runner import Worker

NOW = datetime(2026, 10, 4, tzinfo=UTC)
ME = "cd" * 32


def _job(job_id: int, kind: str) -> JobV1:
    return JobV1(
        job_id=job_id, owner="ab" * 32, kind=kind, request_key=f"k{job_id}", input_version=0, status="queued",
        attempt_count=0, max_attempts=5, lease_owner=None, lease_until=None, available_at=NOW - timedelta(seconds=1),
        payload="{}", result_ref=None, error_code=None, created_at=NOW, updated_at=NOW,
    )


class Gateway:
    def __init__(self) -> None:
        self.jobs = {1: _job(1, "slow")}
        self.completed: list[int] = []

    async def worker_jobs(self) -> list[JobV1]:
        return list(self.jobs.values())

    async def claim_job(self, job_id: int, lease_seconds: int) -> None:
        job = self.jobs[job_id]
        self.jobs[job_id] = job.model_copy(
            update={"status": "running", "attempt_count": job.attempt_count + 1, "lease_owner": ME,
                    "lease_until": datetime.now(UTC) + timedelta(seconds=lease_seconds)}
        )

    async def complete_job(self, job_id: int, attempt: int, input_version: int, result_ref: str) -> None:
        self.completed.append(job_id)
        self.jobs.pop(job_id, None)


class Slow:
    kind = "slow"
    lease_seconds = 60

    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def run(self, job: JobV1, gateway: object) -> str:
        await self.release.wait()
        return "slow-done"


class Quick:
    kind = "quick"

    async def run(self, job: JobV1, gateway: object) -> str:
        return "quick-done"


async def test_a_quick_job_is_not_held_up_by_a_slow_one() -> None:
    gateway = Gateway()
    slow = Slow()
    worker = Worker(gateway, {"slow": slow, "quick": Quick()}, identity_hex=ME, concurrency=2)  # type: ignore[arg-type,dict-item]
    assert await worker.dispatch() == 1
    await asyncio.sleep(0)
    gateway.jobs[2] = _job(2, "quick")
    assert await worker.dispatch() == 1  # the in-flight slow job is not started twice
    for _ in range(20):
        if 2 in gateway.completed:
            break
        await asyncio.sleep(0.01)
    assert gateway.completed == [2]
    slow.release.set()
    for _ in range(20):
        if 1 in gateway.completed:
            break
        await asyncio.sleep(0.01)
    assert gateway.completed == [2, 1]


class SystemSlow(Slow):
    lane = "system"


async def test_system_work_never_takes_the_last_user_slot() -> None:
    gateway = Gateway()
    slow = SystemSlow()
    worker = Worker(gateway, {"slow": slow, "quick": Quick()}, identity_hex=ME, concurrency=1)  # type: ignore[arg-type,dict-item]
    await worker.dispatch()
    await asyncio.sleep(0)
    gateway.jobs[2] = _job(2, "quick")
    await worker.dispatch()
    for _ in range(20):
        if 2 in gateway.completed:
            break
        await asyncio.sleep(0.01)
    assert gateway.completed == [2]  # ran while the system job still held its own lane
    slow.release.set()
