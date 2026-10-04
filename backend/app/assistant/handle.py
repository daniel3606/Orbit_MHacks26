"""Answer a caller's assistant job from server-side evidence. No mutation tools."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import SecretStr

from app.assistant.openai_client import AssistantModelError, build_payload, complete
from app.assistant.policy import (
    UNAVAILABLE,
    Evidence,
    HoldingFact,
    NewsFact,
    QuoteFact,
    RecommendationFact,
    Source,
    Subject,
    blocked_user_text,
    choose_subject,
    deterministic_text,
    validate_reply,
)
from app.market.finnhub import FinnhubProvider
from app.state.dto import JobV1
from app.state.gateway import SpacetimeGateway
from app.workers.runner import Committed, JobFailure

log = logging.getLogger(__name__)


def _dec_micros(value: Any) -> Decimal:
    return Decimal(int(value)) / Decimal(1_000_000)


def _iso(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return str(value)


class AssistantHandler:
    lease_seconds = 45

    def __init__(
        self,
        *,
        kind: str,
        api_key: SecretStr | None,
        model: str,
        timeout: float,
        max_output_tokens: int,
        news: FinnhubProvider | None,
    ):
        self.kind = kind
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._max_output_tokens = max_output_tokens
        self._news = news

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        payload = json.loads(job.payload or "{}")
        reply_key = str(payload.get("replyClientKey") or "")
        if not reply_key:
            raise JobFailure("invalid_job_payload", retryable=False)

        evidence = await self._evidence(gateway, job.owner)
        subject = choose_subject(evidence)
        messages = [row for row in await gateway.worker_assistant_messages() if str(row.get("owner")) == job.owner]
        messages.sort(key=lambda row: int(row.get("sequence") or 0))
        user_text = None
        history: list[dict[str, str]] = []
        if self.kind == "answer_message":
            prior = [row for row in messages if row.get("status") == "complete" and row.get("client_key") != reply_key]
            if prior and prior[-1].get("role") == "user":
                user_text = str(prior[-1].get("body") or "")
                prior = prior[:-1]
            history = [
                {"role": "assistant" if row.get("role") == "assistant" else "user", "content": str(row.get("body") or "")}
                for row in prior
                if row.get("kind") == "chat" and row.get("status") == "complete"
            ]

        text, citations, status = await self._reply(evidence, subject, history, user_text)
        await gateway.publish_assistant_reply(job.job_id, job.attempt_count, reply_key, text, json.dumps(citations), status)
        return Committed(result_ref=f"assistant:{reply_key}"[:120])

    async def _evidence(self, gateway: SpacetimeGateway, owner: str) -> Evidence:
        quotes = []
        for row in await gateway.market_quotes():
            quotes.append(
                QuoteFact(
                    ticker=row.ticker,
                    name=row.ticker,
                    price=_dec_micros(row.price_micros),
                    previous_close=_dec_micros(row.previous_close_micros),
                    as_of=_iso(row.provider_time),
                    source=row.source,
                )
            )
        holdings = []
        for position in await gateway.worker_assistant_positions():
            if str(position.get("owner")) != owner:
                continue
            holdings.append(
                HoldingFact(ticker=str(position.get("ticker")), quantity=_dec_micros(position.get("quantity_micros") or 0))
            )
        recommendations = []
        for recommendation in await gateway.worker_assistant_recommendations():
            if str(recommendation.get("owner")) != owner:
                continue
            limitations = recommendation.get("limitations") or []
            recommendations.append(
                RecommendationFact(
                    ticker=str(recommendation.get("ticker")),
                    trend_score=Decimal(str(recommendation.get("trend_score"))),
                    session_date=str(recommendation.get("session_date")),
                    match_reason=str(recommendation.get("match_reason") or ""),
                    limitations=tuple(str(item) for item in limitations),
                )
            )
        news: list[NewsFact] = []
        news_checked = False
        focus = [h.ticker for h in holdings if h.quantity > 0][:3]
        if not focus:
            ranked = sorted(
                (q for q in quotes if q.day_return is not None and q.ticker != "SPY"),
                key=lambda q: abs(q.day_return or Decimal(0)),
                reverse=True,
            )
            focus = [q.ticker for q in ranked[:1]]
        if self._news is not None and focus:
            news_checked = True
            end = datetime.now(UTC).date()
            start = end - timedelta(days=3)
            for ticker in focus:
                for item in await self._news.company_news(ticker, start, end):
                    news.append(
                        NewsFact(
                            id=item["id"],
                            ticker=item["ticker"],
                            headline=item["headline"],
                            url=item["url"],
                            source=item["source"],
                            published=item["published"],
                        )
                    )
        names = {row.ticker: row.name or row.ticker for row in await gateway.stocks()}
        quotes = [
            QuoteFact(q.ticker, names.get(q.ticker, q.ticker), q.price, q.previous_close, q.as_of, q.source) for q in quotes
        ]
        return Evidence(quotes=quotes, holdings=holdings, news=news, recommendations=recommendations, news_checked=news_checked)

    async def _reply(
        self,
        evidence: Evidence,
        subject: Any,
        history: list[dict[str, str]],
        user_text: str | None,
    ) -> tuple[str, list[dict[str, str]], str]:
        if user_text:
            blocked = blocked_user_text(user_text)
            if blocked:
                return blocked, [], "complete"
        fallback = deterministic_text(subject, evidence)
        sources = list(subject.sources)
        for rec in evidence.recommendations:
            if subject.ticker and rec.ticker == subject.ticker:
                sources.append(
                    Source(
                        id=f"score:{rec.ticker}:{rec.session_date}",
                        as_of=rec.session_date,
                        label=f"Trend Score {rec.trend_score:.2f}",
                        numbers=(f"{rec.trend_score:.2f}",),
                    )
                )
        subject = Subject(subject.kind, subject.ticker, subject.summary, tuple(sources))
        if self._api_key is None:
            if self.kind == "home_brief":
                return fallback, [_cite(source) for source in subject.sources], "complete"
            return UNAVAILABLE, [], "failed"

        payload = build_payload(
            model=self._model,
            max_output_tokens=self._max_output_tokens,
            evidence=evidence,
            subject=subject,
            history=history,
            user_text=user_text,
        )
        try:
            parsed = await complete(self._api_key, payload, timeout=self._timeout)
        except AssistantModelError as exc:
            log.warning("assistant model %s retryable=%s", exc.code, exc.retryable)
            if self.kind == "home_brief":
                return fallback, [_cite(source) for source in subject.sources], "complete"
            if exc.retryable:
                raise JobFailure(exc.code, retryable=True) from exc
            return UNAVAILABLE, [], "failed"

        error = validate_reply(parsed["text"], parsed["citations"], sources)
        if error:
            log.warning("assistant reply rejected: %s", error)
            if self.kind == "home_brief":
                return fallback, [_cite(source) for source in subject.sources], "complete"
            return (
                "I can explain the prices and scores we have, but I don't want to guess past them. "
                "Ask about a stock, a score, or practice trading.",
                [],
                "complete",
            )
        return parsed["text"], parsed["citations"], "complete"


def _cite(source: Source) -> dict[str, str]:
    return {"id": source.id, "as_of": source.as_of}


def handlers(
    *,
    api_key: SecretStr | None,
    model: str,
    timeout: float,
    max_output_tokens: int,
    news: FinnhubProvider | None,
) -> dict[str, AssistantHandler]:
    answer = AssistantHandler(
        kind="answer_message",
        api_key=api_key,
        model=model,
        timeout=timeout,
        max_output_tokens=max_output_tokens,
        news=news,
    )
    brief = AssistantHandler(
        kind="home_brief",
        api_key=api_key,
        model=model,
        timeout=timeout,
        max_output_tokens=max_output_tokens,
        news=news,
    )
    return {answer.kind: answer, brief.kind: brief}
