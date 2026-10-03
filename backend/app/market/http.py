"""Shared plumbing for provider HTTP calls: rate limiting, request coalescing,
bounded retries and stable error types. Credentials never appear in URLs,
logs or exceptions."""

import asyncio
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any


class ProviderError(Exception):
    code = "provider_error"
    retryable = False

    def __init__(self, message: str, *, status: int | None = None):
        super().__init__(message)
        self.status = status


class ProviderAccessDenied(ProviderError):
    """The account/plan cannot access this resource (HTTP 401/403). Never retried."""

    code = "provider_access_denied"


class ProviderRateLimited(ProviderError):
    code = "provider_rate_limited"
    retryable = True


class ProviderUnavailable(ProviderError):
    code = "provider_unavailable"
    retryable = True


class ProviderContractError(ProviderError):
    """Response did not match the documented shape, or the symbol has no data."""

    code = "provider_contract_error"


Sleep = Callable[[float], Awaitable[None]]
Clock = Callable[[], float]


class RateLimiter:
    """Token bucket: `per_minute` sustained with bursts up to `burst`, which
    also keeps under per-second caps. A 429 can pause all callers."""

    def __init__(
        self,
        per_minute: int,
        *,
        burst: int,
        clock: Clock = time.monotonic,
        sleep: Sleep = asyncio.sleep,
    ):
        self._rate = per_minute / 60.0
        self._capacity = float(max(1, burst))
        self._tokens = self._capacity
        self._clock = clock
        self._sleep = sleep
        self._updated = clock()
        self._paused_until = 0.0
        self._lock = asyncio.Lock()

    def pause_for(self, seconds: float) -> None:
        self._paused_until = max(self._paused_until, self._clock() + seconds)
        self._tokens = 0.0

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self._clock()
                if now < self._paused_until:
                    await self._sleep(self._paused_until - now)
                    continue
                self._tokens = min(self._capacity, self._tokens + (now - self._updated) * self._rate)
                self._updated = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                await self._sleep((1.0 - self._tokens) / self._rate)


class RequestCoalescer:
    """Identical concurrent requests share one in-flight call; successful
    results are reused for `ttl` seconds. Errors are not cached."""

    def __init__(self, clock: Clock = time.monotonic):
        self._clock = clock
        self._inflight: dict[str, asyncio.Future[Any]] = {}
        self._cache: dict[str, tuple[float, Any]] = {}

    async def get(self, key: str, ttl: float, factory: Callable[[], Awaitable[Any]]) -> Any:
        hit = self._cache.get(key)
        if hit and hit[0] > self._clock():
            return hit[1]
        pending = self._inflight.get(key)
        if pending is not None:
            return await asyncio.shield(pending)
        future: asyncio.Future[Any] = asyncio.get_running_loop().create_future()
        self._inflight[key] = future
        try:
            value = await factory()
        except BaseException as exc:
            future.set_exception(exc)
            future.exception()  # mark retrieved when nobody else is waiting
            raise
        else:
            future.set_result(value)
            if ttl > 0:
                self._cache[key] = (self._clock() + ttl, value)
            return value
        finally:
            del self._inflight[key]


async def with_retries(
    call: Callable[[], Awaitable[Any]],
    *,
    max_retries: int,
    base_delay: float = 0.5,
    max_delay: float = 20.0,
    sleep: Sleep = asyncio.sleep,
    on_rate_limited: Callable[[ProviderRateLimited], float] | None = None,
) -> Any:
    """Retries only retryable provider errors, with exponential backoff and jitter."""
    attempt = 0
    while True:
        try:
            return await call()
        except ProviderError as exc:
            if not exc.retryable or attempt >= max_retries:
                raise
            delay = min(max_delay, base_delay * 2**attempt) * (0.75 + 0.5 * random.random())
            if isinstance(exc, ProviderRateLimited) and on_rate_limited is not None:
                delay = max(delay, on_rate_limited(exc))
            attempt += 1
            await sleep(delay)
