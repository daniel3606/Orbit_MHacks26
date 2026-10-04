"""Jev adapter: TypeSafe's decision model through OpenRouter's Decisions API.

Contract taken from the official OpenRouter and TypeSafe documentation on
2026-10-04 (https://openrouter.ai/docs/guides/community/jev). Not yet confirmed
by a live call from this codebase:
- Endpoint: `POST https://openrouter.ai/api/alpha/decisions` (an "alpha" surface).
  https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request
- Auth: `Authorization: Bearer <OpenRouter API key>`. No separate TypeSafe account.
- Request: `{model, state, questions}`; each question is `noul` (yes/no),
  `choice` (one of named options) or `score` (position on ordered levels).
- Response: `{id, model, provider, answers, usage}`. A noul answer is the
  probability of yes; a choice answer has `choice`, `probabilities`,
  `confidence`; a score answer has `score` in [0, levels − 1], `probabilities`,
  `confidence`, `legend`. `model` names the dated snapshot that served it.
- Context: 32,000 tokens for state plus questions. Billed per input token.
- Errors: 400, 401 (bad key), 402 (credits), 403 (moderation or guardrail
  block), 408, 413, 429, 5xx/524/529. `Retry-After` may come with 429, 503, and
  a 402 caused by the in-flight spending budget.
- Rate limits: none published for paid models beyond DDoS protection, so the
  limiter below is Orbit's own ceiling.

The key is sent only as a bearer header. It never appears in URLs, logs, or
exception messages, and error bodies (which can quote flagged input) are not logged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import re
import time
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Any

import httpx
from pydantic import SecretStr

from app.config.settings import JEV_OPENROUTER_URL
from app.intelligence.classifier import (
    EVENT_TYPES,
    MATERIALITIES,
    SENTIMENTS,
    Classification,
    ClassificationUnavailable,
    UnavailableReason,
)
from app.intelligence.config import (
    MAX_HEADLINE_CHARS,
    MAX_SOURCE_CHARS,
    MAX_TEXT_CHARS,
    PROBE_ARTICLE,
    QUESTIONS,
    RELEVANCE_THRESHOLD,
    SPECIFIC_THRESHOLD,
    classifier_version,
)
from app.market.http import Clock, RateLimiter, Sleep
from app.market.provider import CapabilityResult

log = logging.getLogger(__name__)

PROVIDER = "jev"
CAPABILITY_KEY = "jev.news_classification"
DECISIONS_PATH = "/alpha/decisions"

BASE_BACKOFF_SECONDS = 0.5
MAX_BACKOFF_SECONDS = 4.0
# A Retry-After longer than this is not waited out inside a job; the classifier pauses instead.
MAX_INLINE_WAIT_SECONDS = 10.0
# After a failure that would repeat for every article, calls pause so jobs do not each wait it out.
PAUSE_SECONDS: dict[UnavailableReason, float] = {
    "payment_required": 600.0,
    "rate_limited": 30.0,
    "provider_unavailable": 30.0,
}

_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
_SPACE = re.compile(r"\s+")


class _Failure(Exception):
    def __init__(
        self,
        reason: UnavailableReason,
        *,
        status: int | None = None,
        retryable: bool = False,
        retry_after: float | None = None,
    ):
        super().__init__(reason)
        self.reason: UnavailableReason = reason
        self.status = status
        self.retryable = retryable
        self.retry_after = retry_after


def _retry_after(value: str | None) -> float | None:
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return max(0.0, (when - datetime.now(UTC)).total_seconds())


def clean_text(value: str | None, limit: int) -> str:
    """Untrusted provider text as plain, bounded content: no control characters, single spaces."""
    if not value:
        return ""
    return _SPACE.sub(" ", _CONTROL.sub(" ", value)).strip()[:limit]


def build_request(
    model: str, *, ticker: str, company: str, headline: str, text: str | None, source: str, published_at: str
) -> dict[str, Any]:
    article: dict[str, str] = {
        "headline": clean_text(headline, MAX_HEADLINE_CHARS),
        "source": clean_text(source, MAX_SOURCE_CHARS),
        "published_at": clean_text(published_at, 40),
    }
    body = clean_text(text, MAX_TEXT_CHARS)
    if body:
        article["text"] = body
    return {
        "model": model,
        "state": {"company": {"ticker": ticker, "name": clean_text(company, 120) or ticker}, "article": article},
        "questions": QUESTIONS,
    }


# ---- response validation ----


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise _Failure("invalid_response", status=200)
    return float(value)


def _probability(value: Any) -> float:
    number = _number(value)
    if not 0.0 <= number <= 1.0:
        raise _Failure("invalid_response", status=200)
    return number


def _answer(answers: dict[str, Any], key: str, kind: str) -> dict[str, Any]:
    answer = answers.get(key)
    if not isinstance(answer, dict) or answer.get("type") != kind:
        raise _Failure("invalid_response", status=200)
    if "confidence" in answer:
        _probability(answer["confidence"])
    return answer


def _distribution(value: Any, allowed: set[str]) -> None:
    if value is None:
        return
    if not isinstance(value, dict) or not set(value) <= allowed:
        raise _Failure("invalid_response", status=200)
    for probability in value.values():
        _probability(probability)


def _noul(answers: dict[str, Any], key: str) -> float:
    return _probability(_answer(answers, key, "noul").get("noul"))


def _choice(answers: dict[str, Any], key: str, options: tuple[str, ...]) -> str:
    answer = _answer(answers, key, "choice")
    choice = answer.get("choice")
    if not isinstance(choice, str) or choice not in options:
        raise _Failure("invalid_response", status=200)
    _distribution(answer.get("probabilities"), set(options))
    return choice


def _level(answers: dict[str, Any], key: str, levels: int) -> int:
    """Nearest level to the probability-weighted position; a tie goes to the lower level."""
    answer = _answer(answers, key, "score")
    score = _number(answer.get("score"))
    if not 0.0 <= score <= levels - 1:
        raise _Failure("invalid_response", status=200)
    _distribution(answer.get("probabilities"), {str(i) for i in range(levels)})
    return min(levels - 1, max(0, math.ceil(score - 0.5)))


def parse_decision(body: Any, version: str) -> tuple[Classification, str]:
    """A schema-checked Classification plus the served model snapshot. Raises on any mismatch."""
    if not isinstance(body, dict) or not isinstance(body.get("answers"), dict):
        raise _Failure("invalid_response", status=200)
    served = body.get("model")
    if not isinstance(served, str) or not served:
        raise _Failure("invalid_response", status=200)
    answers: dict[str, Any] = body["answers"]
    relevance = _noul(answers, "relevance")
    specific = _noul(answers, "specific")
    event_type = _choice(answers, "event_type", EVENT_TYPES)
    sentiment = _choice(answers, "sentiment", SENTIMENTS)
    materiality = MATERIALITIES[_level(answers, "materiality", len(MATERIALITIES))]
    relevant = relevance >= RELEVANCE_THRESHOLD
    classification = Classification(
        relevant=relevant,
        relevance_score=round(relevance, 6),
        event_type=event_type,  # type: ignore[arg-type]  # checked against EVENT_TYPES
        sentiment=sentiment,  # type: ignore[arg-type]  # checked against SENTIMENTS
        materiality=materiality,
        keep=relevant and specific >= SPECIFIC_THRESHOLD,
        classifier_version=version,
    )
    return classification, served[:80]


@dataclass(frozen=True)
class JevStatus:
    configured: bool
    verified_at: datetime | None  # last schema-valid response from the provider
    served_model: str | None
    last_failure: UnavailableReason | None
    last_failure_status: int | None
    disabled: bool


class JevClassifier:
    """`NewsClassifier` backed by Jev. One instance per worker; safe for concurrent use."""

    def __init__(
        self,
        api_key: SecretStr,
        *,
        base_url: str = JEV_OPENROUTER_URL,
        model: str = "typesafe/jev-1.13",
        company_names: Mapping[str, str] | None = None,
        timeout: float = 8.0,
        calls_per_minute: int = 120,
        burst: int = 10,
        max_retries: int = 2,
        transport: httpx.AsyncBaseTransport | None = None,
        sleep: Sleep | None = None,
        limiter: RateLimiter | None = None,
        clock: Clock = time.monotonic,
    ):
        self.model = model
        self.version = classifier_version(model)
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key.get_secret_value()}"},
            timeout=httpx.Timeout(timeout, connect=min(3.0, timeout)),
            transport=transport,
        )
        self._sleep: Sleep = sleep or asyncio.sleep
        self._limiter = limiter or RateLimiter(calls_per_minute, burst=burst, sleep=self._sleep)
        self._max_retries = max_retries
        self._names = dict(company_names or {})
        self._clock: Clock = clock
        self._disabled: UnavailableReason | None = None
        self._paused_until = 0.0
        self._pause_reason: UnavailableReason | None = None
        self._verified_at: datetime | None = None
        self._served_model: str | None = None
        self._last_failure: UnavailableReason | None = None
        self._last_failure_status: int | None = None
        self.http_calls = 0  # observable for tests and diagnostics
        self.cost_usd = 0.0  # sum of `usage.cost` reported by the provider

    async def aclose(self) -> None:
        await self._client.aclose()

    def set_company_names(self, names: Mapping[str, str]) -> None:
        self._names.update(names)

    # ---- NewsClassifier ----

    async def available(self) -> bool:
        return self._disabled is None and self._clock() >= self._paused_until

    async def classify_article(
        self, *, article_id: str, ticker: str, headline: str, text: str | None, source: str, published_at: str
    ) -> Classification:
        return await self._classify(
            ticker=ticker,
            company=self._names.get(ticker, ticker),
            headline=headline,
            text=text,
            source=source,
            published_at=published_at,
        )

    # ---- verification and status ----

    async def verify(self) -> CapabilityResult:
        """One real decision on a fixed probe article. Proves key, model and response schema together."""
        try:
            await self._classify(
                ticker=PROBE_ARTICLE["ticker"],
                company=PROBE_ARTICLE["company"],
                headline=PROBE_ARTICLE["headline"],
                text=PROBE_ARTICLE["text"],
                source=PROBE_ARTICLE["source"],
                published_at=datetime.now(UTC).isoformat(timespec="seconds"),
            )
        except ClassificationUnavailable:
            pass
        return self.capability()

    def status(self) -> JevStatus:
        return JevStatus(
            configured=True,
            verified_at=self._verified_at,
            served_model=self._served_model,
            last_failure=self._last_failure,
            last_failure_status=self._last_failure_status,
            disabled=self._disabled is not None,
        )

    def capability(self) -> CapabilityResult:
        """Health row: `available` only after a schema-valid response and while calls are allowed.
        The detail changes only when the state does (the row's `checked_at` records when)."""
        label = "News classification (Jev)"
        if self._disabled is not None:
            detail = f"Not verified: {self._disabled} (HTTP {self._last_failure_status}); off until the key is fixed"
            return CapabilityResult(CAPABILITY_KEY, label, False, detail, PROVIDER)
        failure = self._last_failure
        if self._verified_at is None:
            detail = (
                f"Key configured; verification failed: {failure} (HTTP {self._last_failure_status})"
                if failure
                else "Key configured; not verified yet"
            )
            return CapabilityResult(CAPABILITY_KEY, label, False, detail, PROVIDER)
        if self._clock() < self._paused_until and self._pause_reason is not None:
            detail = f"Verified with {self._served_model}; paused: {self._pause_reason}"
            return CapabilityResult(CAPABILITY_KEY, label, False, detail, PROVIDER)
        return CapabilityResult(CAPABILITY_KEY, label, True, f"Verified with {self._served_model}", PROVIDER)

    # ---- transport ----

    async def _classify(
        self, *, ticker: str, company: str, headline: str, text: str | None, source: str, published_at: str
    ) -> Classification:
        if self._disabled is not None:
            raise ClassificationUnavailable(self._disabled)
        if self._clock() < self._paused_until:
            raise ClassificationUnavailable("paused")
        request = build_request(
            self.model,
            ticker=ticker,
            company=company,
            headline=headline,
            text=text,
            source=source,
            published_at=published_at,
        )
        if not request["state"]["article"]["headline"]:
            raise ClassificationUnavailable("invalid_request")
        try:
            body = await self._decide(request)
            classification, served = parse_decision(body, self.version)
        except _Failure as exc:
            self._record_failure(exc, ticker)
            raise ClassificationUnavailable(exc.reason, status=exc.status) from None
        self._verified_at = datetime.now(UTC)
        self._served_model = served
        self._last_failure = None
        self._last_failure_status = None
        usage = body.get("usage") if isinstance(body, dict) else None
        cost = usage.get("cost") if isinstance(usage, dict) else None
        if isinstance(cost, (int, float)) and not isinstance(cost, bool) and math.isfinite(cost) and cost >= 0:
            self.cost_usd += float(cost)
        return classification

    async def _decide(self, request: dict[str, Any]) -> Any:
        attempt = 0
        while True:
            try:
                return await self._post_once(request)
            except _Failure as exc:
                if not exc.retryable or attempt >= self._max_retries:
                    raise
                if exc.retry_after is not None:
                    if exc.retry_after > MAX_INLINE_WAIT_SECONDS:
                        raise
                    wait = exc.retry_after
                    self._limiter.pause_for(wait)
                else:
                    wait = min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2**attempt) * (0.75 + 0.5 * random.random())
                attempt += 1
                await self._sleep(wait)

    async def _post_once(self, request: dict[str, Any]) -> Any:
        await self._limiter.acquire()
        self.http_calls += 1
        try:
            response = await self._client.post(DECISIONS_PATH, json=request)
        except httpx.TimeoutException:
            raise _Failure("provider_unavailable", retryable=True) from None
        except httpx.TransportError:
            raise _Failure("provider_unavailable", retryable=True) from None
        status = response.status_code
        retry_after = _retry_after(response.headers.get("retry-after"))
        if status == 200:
            try:
                body = json.loads(response.text)
            except ValueError:
                raise _Failure("invalid_response", status=status) from None
            error = body.get("error") if isinstance(body, dict) and "answers" not in body else None
            if isinstance(error, dict) and isinstance(error.get("code"), int):
                # An error object in a 200 body: treat it like the status it names.
                status = int(error["code"])
            else:
                return body
        if status == 401:
            raise _Failure("auth_failed", status=status)
        if status == 402:
            if retry_after is not None:  # in-flight spending budget: wait, then retry
                raise _Failure("rate_limited", status=status, retryable=True, retry_after=retry_after)
            raise _Failure("payment_required", status=status)
        if status == 403:
            raise _Failure("rejected_by_provider", status=status)
        if status == 429:
            raise _Failure("rate_limited", status=status, retryable=True, retry_after=retry_after)
        if status == 408 or status >= 500:
            raise _Failure("provider_unavailable", status=status, retryable=True, retry_after=retry_after)
        raise _Failure("invalid_request", status=status)

    def _record_failure(self, exc: _Failure, ticker: str) -> None:
        self._last_failure = exc.reason
        self._last_failure_status = exc.status
        if exc.reason == "auth_failed":
            if self._disabled is None:
                log.error("Jev rejected the API key (HTTP 401); news classification is off until the key is fixed")
            self._disabled = "auth_failed"
            return
        pause = PAUSE_SECONDS.get(exc.reason)
        if pause is not None:
            if exc.retry_after is not None:
                pause = max(pause, min(exc.retry_after, 600.0))
            self._paused_until = max(self._paused_until, self._clock() + pause)
            self._pause_reason = exc.reason
        log.warning("jev classification unavailable ticker=%s reason=%s status=%s", ticker, exc.reason, exc.status)
