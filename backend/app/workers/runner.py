"""Durable job worker (PRD §9).

Loop: read eligible jobs from the service-gated `worker_jobs` view → claim via
reducer (atomic lease) → confirm the lease by re-reading → run the handler
outside any database transaction → commit with `complete_job` / `fail_job`,
passing the attempt number as the fencing token.
"""

import asyncio
import logging
import random
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Protocol

from app.state.dto import JobV1
from app.state.gateway import GatewayError, GatewayUnavailable, ReducerRejected, SpacetimeGateway

log = logging.getLogger(__name__)

# Rejections that mean "someone else owns this now"; drop silently.
_LOST_RACE = {"job_not_claimable", "job_not_found", "lease_mismatch", "lease_expired", "job_not_running"}


class JobFailure(Exception):
    def __init__(self, code: str, *, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True)
class Committed:
    """Returned by handlers whose result reducer already completed the job atomically."""

    result_ref: str


class JobHandler(Protocol):
    kind: str

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> str | Committed:
        """Return a short result reference (runner completes the job), a
        `Committed` marker, or raise JobFailure."""
        ...


class Worker:
    @property
    def kinds(self) -> list[str]:
        return sorted(self._handlers)

    def __init__(
        self,
        gateway: SpacetimeGateway,
        handlers: Mapping[str, JobHandler],
        *,
        identity_hex: str,
        lease_seconds: int = 30,
        concurrency: int = 2,
        poll_interval: float = 1.0,
        max_poll_interval: float = 15.0,
    ):
        self._gateway = gateway
        self._handlers = dict(handlers)
        self._identity = identity_hex
        self._lease_seconds = lease_seconds
        self._semaphore = asyncio.Semaphore(concurrency)
        # Handlers with `lane = "system"` (shared market ingestion) run one at a time on their
        # own lane, so a multi-minute ingest never takes a slot from user-facing work.
        self._system_lane = asyncio.Semaphore(1)
        self._poll_interval = poll_interval
        self._max_poll_interval = max_poll_interval
        # Jobs being processed by run_forever, so a slow job (market ingestion) never
        # holds up claiming the next quick one (a Discovery set, a chat reply).
        self._inflight: dict[int, asyncio.Task[bool]] = {}

    def _eligible(self, jobs: list[JobV1], now: datetime) -> list[JobV1]:
        out = []
        for job in jobs:
            if job.kind not in self._handlers:
                continue
            waiting = job.status in ("queued", "retry_wait") and job.available_at <= now
            expired = job.status == "running" and job.lease_until is not None and job.lease_until < now
            if waiting or expired:
                out.append(job)
        return sorted(out, key=lambda j: (j.available_at, j.job_id))

    async def run_once(self) -> int:
        """Process one batch of eligible jobs to completion. Returns how many were claimed."""
        jobs = await self._gateway.worker_jobs()
        eligible = self._eligible(jobs, datetime.now(UTC))
        results = await asyncio.gather(*(self._process(job) for job in eligible))
        return sum(results)

    async def dispatch(self) -> int:
        """Start eligible jobs that are not already in flight, without waiting for them.
        Returns how many were started; the semaphore still bounds how many run at once."""
        jobs = await self._gateway.worker_jobs()
        started = 0
        for job in self._eligible(jobs, datetime.now(UTC)):
            if job.job_id in self._inflight:
                continue
            task = asyncio.create_task(self._guarded(job))
            self._inflight[job.job_id] = task
            task.add_done_callback(self._forget(job.job_id))
            started += 1
        return started

    def _forget(self, job_id: int) -> "Callable[[asyncio.Task[bool]], None]":
        def done(_task: asyncio.Task[bool]) -> None:
            self._inflight.pop(job_id, None)

        return done

    async def _guarded(self, job: JobV1) -> bool:
        try:
            return await self._process(job)
        except GatewayError as exc:
            log.warning("job %s not processed: %s (%s)", job.job_id, exc.code, exc)
            return False

    async def _process(self, job: JobV1) -> bool:
        handler = self._handlers[job.kind]
        lane = self._system_lane if getattr(handler, "lane", None) == "system" else self._semaphore
        async with lane:
            lease_seconds = int(getattr(handler, "lease_seconds", self._lease_seconds))
            try:
                await self._gateway.claim_job(job.job_id, lease_seconds)
            except ReducerRejected as exc:
                if exc.code in _LOST_RACE:
                    return False
                raise

            leased = await self._confirm_lease(job.job_id)
            if leased is None:
                return False  # e.g. attempts exhausted → marked failed by the reducer

            log.info("job %s claimed kind=%s attempt=%s", leased.job_id, leased.kind, leased.attempt_count)
            try:
                result_ref = await asyncio.wait_for(handler.run(leased, self._gateway), timeout=lease_seconds * 0.8)
            except JobFailure as exc:
                await self._fail(leased, exc.code, exc.retryable)
            except TimeoutError:
                await self._fail(leased, "handler_timeout", True)
            except GatewayUnavailable:
                await self._fail(leased, "state_unavailable", True)
            except ReducerRejected as exc:
                # e.g. stale_generation / lease_expired from an atomic result reducer
                if exc.code in _LOST_RACE or exc.code == "stale_generation":
                    log.warning("job %s result rejected: %s", leased.job_id, exc.code)
                else:
                    await self._fail(leased, exc.code, False)
            except Exception:
                log.exception("job %s handler crashed", leased.job_id)
                await self._fail(leased, "internal_error", True)
            else:
                if isinstance(result_ref, Committed):
                    log.info("job %s committed: %s", leased.job_id, result_ref.result_ref)
                else:
                    await self._commit(leased, result_ref)
            return True

    async def _confirm_lease(self, job_id: int) -> JobV1 | None:
        for job in await self._gateway.worker_jobs():
            if job.job_id == job_id and job.status == "running" and job.lease_owner == self._identity:
                return job
        return None

    async def _commit(self, job: JobV1, result_ref: str) -> None:
        try:
            await self._gateway.complete_job(job.job_id, job.attempt_count, job.input_version, result_ref)
            log.info("job %s succeeded", job.job_id)
        except ReducerRejected as exc:
            # stale_input_version: preferences changed mid-run; a newer job supersedes this one.
            log.warning("job %s result rejected: %s", job.job_id, exc.code)

    async def _fail(self, job: JobV1, code: str, retryable: bool) -> None:
        try:
            await self._gateway.fail_job(job.job_id, job.attempt_count, code, retryable)
            log.warning("job %s failed code=%s retryable=%s", job.job_id, code, retryable)
        except ReducerRejected as exc:
            log.warning("job %s failure report rejected: %s", job.job_id, exc.code)

    async def run_forever(self, stop: asyncio.Event) -> None:
        delay = self._poll_interval
        while not stop.is_set():
            try:
                claimed = await self.dispatch()
                delay = self._poll_interval if claimed else min(delay * 1.5, self._max_poll_interval)
            except GatewayError as exc:
                log.warning("poll failed: %s (%s)", exc.code, exc)
                delay = min(delay * 2, self._max_poll_interval)
            jittered = delay * (0.8 + 0.4 * random.random())
            try:
                await asyncio.wait_for(stop.wait(), timeout=jittered)
            except TimeoutError:
                pass
        if self._inflight:
            await asyncio.gather(*self._inflight.values(), return_exceptions=True)
