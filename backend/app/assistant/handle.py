"""Answer a caller's assistant job from server-side evidence. No mutation tools."""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import SecretStr

from app.assistant.facts import catalyst_level
from app.assistant.intent import resolve
from app.assistant.openai_client import AssistantModelError, build_payload, complete
from app.assistant.policy import (
    BarPoint,
    Evidence,
    HoldingFact,
    NewsFact,
    QuoteFact,
    RecommendationFact,
    SignalFact,
    Source,
    StockFact,
    clean_follow_ups,
    validate_brief_copy,
    validate_reply,
)
from app.assistant.reply import build_packet, fallback_answer
from app.assistant.select import Brief, select_brief
from app.intelligence.features import news_signals
from app.intelligence.service import Article, NewsClassificationService
from app.intelligence.stories import CANDIDATES, SHOWN, best_stories
from app.market.finnhub import FinnhubProvider
from app.state.dto import JobV1
from app.state.gateway import GatewayError, SpacetimeGateway
from app.workers.runner import Committed, JobFailure

log = logging.getLogger(__name__)
_TICKER = re.compile(r"^[A-Z][A-Z0-9.]{0,9}$")
NEWS_WINDOW_DAYS = 7
# Time Jev gets per reply, inside the 45 s lease that also covers news, state reads and OpenAI.
NEWS_CLASSIFY_SECONDS = 6.0
# The brief scans up to 6 companies, so it keeps the 3 newest headlines each (≤ 18 Jev calls in the time above).
BRIEF_CANDIDATES = 3


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
        classification: NewsClassificationService | None = None,
    ):
        self.kind = kind
        self._api_key = api_key
        self._model = model
        self._timeout = timeout
        self._max_output_tokens = max_output_tokens
        self._news = news
        self._classification = classification or NewsClassificationService(None)

    async def run(self, job: JobV1, gateway: SpacetimeGateway) -> Committed:
        payload = json.loads(job.payload or "{}")
        reply_key = str(payload.get("replyClientKey") or "")
        if not reply_key:
            raise JobFailure("invalid_job_payload", retryable=False)
        evidence, history, user_text = await self._load(gateway, job.owner, reply_key)
        if self.kind == "home_brief":
            await self._brief(job, gateway, reply_key, evidence)
        else:
            await self._chat(job, gateway, reply_key, evidence, history, user_text or "")
        return Committed(result_ref=f"assistant:{reply_key}"[:120])

    async def _brief(self, job: JobV1, gateway: SpacetimeGateway, reply_key: str, evidence: Evidence) -> None:
        await self._attach_news(evidence, _brief_candidates(evidence), job, gateway)
        brief = select_brief(evidence)
        citations = json.dumps([{"id": source.id, "as_of": source.as_of} for source in brief.sources])
        try:
            await gateway.publish_assistant_reply(
                job.job_id, job.attempt_count, reply_key, _brief_body(brief, copy_ready=False), citations, "draft"
            )
        except GatewayError:
            log.warning("assistant draft skipped kind=home_brief")
        final = brief
        llm = "skipped"
        fallback = True
        if self._api_key is not None and brief.ticker:
            packet, _sources, level = build_packet(
                evidence, [brief.ticker], intent="brief", include_definition=False
            )
            packet["selection"] = {
                "reasonType": brief.reason_type,
                "eyebrow": brief.eyebrow,
                "reasonFacts": brief.reason_text,
                "catalystLevel": brief.catalyst_level,
            }
            try:
                parsed = await complete(
                    self._api_key,
                    build_payload(
                        model=self._model,
                        max_output_tokens=self._max_output_tokens,
                        history=[],
                        user_text=None,
                        packet=packet,
                        mode="brief",
                    ),
                    timeout=self._timeout,
                    shape="brief",
                )
                llm = "ok"
                follow = clean_follow_ups([str(item) for item in parsed["followUps"]])
                error = validate_brief_copy(
                    str(parsed["reasonText"]),
                    str(parsed["contextText"]),
                    follow or list(brief.follow_ups),
                    list(brief.sources),
                    catalyst_level=level,
                )
                if error:
                    log.warning("assistant brief copy rejected: %s", error)
                else:
                    final = Brief(
                        brief.ticker,
                        brief.reason_type,
                        brief.eyebrow,
                        brief.chart_range,
                        str(parsed["reasonText"]).strip(),
                        str(parsed["contextText"]).strip(),
                        tuple(follow or brief.follow_ups),
                        brief.sources,
                        brief.catalyst_level,
                    )
                    fallback = False
            except AssistantModelError as exc:
                llm = exc.code
                log.warning("assistant model %s retryable=%s", exc.code, exc.retryable)
        log.info(
            "assistant kind=home_brief intent=%s symbols=%s news=%s classification=%s market_open=%s llm=%s fallback=%s",
            brief.reason_type,
            brief.ticker or "",
            "failed" if evidence.news_failed else "ok" if evidence.news_checked else "skipped",
            evidence.news_classification.get(brief.ticker or "", "none"),
            evidence.market_open,
            llm,
            fallback,
        )
        await gateway.publish_assistant_reply(
            job.job_id,
            job.attempt_count,
            reply_key,
            _brief_body(final, copy_ready=True),
            citations,
            "complete",
        )

    async def _chat(
        self,
        job: JobV1,
        gateway: SpacetimeGateway,
        reply_key: str,
        evidence: Evidence,
        history: list[dict[str, str]],
        user_text: str,
    ) -> None:
        resolution = resolve(user_text, evidence, evidence.active_ticker)
        tickers = list(resolution.tickers)
        if resolution.intent not in {"education", "refusal", "redirect"} and tickers:
            await self._attach_news(evidence, tickers, job, gateway)
        text, citations, follow, practice = fallback_answer(
            resolution.intent,
            tickers,
            evidence,
            user_text,
            ambiguous=resolution.ambiguous,
            missing=resolution.missing,
        )
        llm = "skipped"
        fallback = True
        level = catalyst_level(
            evidence.news_for(tickers[0]) if tickers else [],
            _as_of(evidence, tickers),
        )
        if self._api_key is not None and resolution.intent not in {"refusal", "redirect"} and not resolution.ambiguous:
            packet, sources, level = build_packet(
                evidence,
                tickers,
                intent=resolution.intent,
                include_definition=resolution.intent == "education" or "trend score" in user_text.lower(),
            )
            if resolution.missing:
                packet["unresolvedNames"] = list(resolution.missing)
            try:
                parsed = await complete(
                    self._api_key,
                    build_payload(
                        model=self._model,
                        max_output_tokens=self._max_output_tokens,
                        history=history,
                        user_text=user_text,
                        packet=packet,
                        mode="chat",
                    ),
                    timeout=self._timeout,
                    shape="chat",
                )
                llm = "ok"
                labels: list[str] = []
                entities = packet.get("entities", [])
                if isinstance(entities, list):
                    for entity in entities:
                        if not isinstance(entity, dict):
                            continue
                        score = entity.get("trendScore")
                        if isinstance(score, dict) and score.get("activityLabel"):
                            labels.append(str(score["activityLabel"]))
                error = validate_reply(
                    parsed["text"],
                    parsed["citations"],
                    sources,
                    catalyst_level=level,
                    intent=resolution.intent,
                    activity_labels=tuple(labels),
                )
                if error:
                    log.warning("assistant reply rejected: %s", error)
                else:
                    text = parsed["text"]
                    citations = parsed["citations"]
                    model_follow = clean_follow_ups([str(item) for item in parsed["followUps"]])
                    if len(model_follow) >= 2:
                        follow = model_follow
                    fallback = False
            except AssistantModelError as exc:
                llm = exc.code
                log.warning("assistant model %s retryable=%s", exc.code, exc.retryable)
                if exc.retryable:
                    raise JobFailure(exc.code, retryable=True) from exc
        if practice and (len(tickers) != 1 or not _TICKER.match(tickers[0])):
            practice = None
        log.info(
            "assistant kind=answer_message intent=%s lookup=%s context=%s symbols=%s news=%s classification=%s "
            "market_open=%s llm=%s fallback=%s",
            resolution.intent,
            resolution.looked_up,
            resolution.used_context,
            ",".join(tickers),
            "failed" if evidence.news_failed else "ok" if evidence.news_checked else "skipped",
            ",".join(f"{t}:{evidence.news_classification[t]}" for t in tickers if t in evidence.news_classification) or "none",
            evidence.market_open,
            llm,
            fallback,
        )
        await gateway.publish_assistant_reply(
            job.job_id,
            job.attempt_count,
            reply_key,
            text,
            _with_ui(citations, follow, practice if resolution.intent in {"recommendation", "paper"} else None),
            "complete",
        )

    async def _load(
        self, gateway: SpacetimeGateway, owner: str, reply_key: str
    ) -> tuple[Evidence, list[dict[str, str]], str | None]:
        evidence = Evidence()
        for listed in await gateway.stocks():
            evidence.stocks[listed.ticker] = StockFact(listed.ticker, listed.name or listed.ticker, listed.kind, listed.sector)
        for listed_quote in await gateway.market_quotes():
            evidence.quotes.append(
                QuoteFact(
                    ticker=listed_quote.ticker,
                    name=evidence.stocks[listed_quote.ticker].name if listed_quote.ticker in evidence.stocks else listed_quote.ticker,
                    price=_dec_micros(listed_quote.price_micros),
                    previous_close=_dec_micros(listed_quote.previous_close_micros),
                    as_of=_iso(listed_quote.provider_time),
                    source=listed_quote.source,
                )
            )
        for position in await gateway.worker_assistant_positions():
            if str(position.get("owner")) != owner:
                continue
            evidence.holdings.append(
                HoldingFact(ticker=str(position.get("ticker")), quantity=_dec_micros(position.get("quantity_micros") or 0))
            )
        for recommendation in await gateway.worker_assistant_recommendations():
            if str(recommendation.get("owner")) != owner:
                continue
            limitations = recommendation.get("limitations") or []
            evidence.recommendations.append(
                RecommendationFact(
                    ticker=str(recommendation.get("ticker")),
                    trend_score=Decimal(str(recommendation.get("trend_score"))),
                    session_date=str(recommendation.get("session_date")),
                    match_reason=str(recommendation.get("match_reason") or ""),
                    limitations=tuple(str(item) for item in limitations),
                )
            )
        grouped: dict[str, list[BarPoint]] = {}
        for bar in await gateway.worker_daily_bars():
            grouped.setdefault(bar.ticker, []).append(
                BarPoint(bar.session_date, _dec_micros(bar.close_micros), bar.volume)
            )
        evidence.bars = grouped
        for signal in await gateway.trend_signals():
            if signal.status != "published" or signal.trend_score is None:
                continue
            evidence.signals[signal.ticker] = SignalFact(
                signal.ticker,
                Decimal(str(signal.trend_score)),
                signal.session_date,
                signal.status,
                signal.coverage_scope,
                signal.benchmark,
                tuple(feature.name for feature in signal.features if feature.available),
            )
        generation = await gateway.market_generation()
        if generation is not None:
            evidence.market_open = generation.market_open
            evidence.last_session = generation.last_completed_session
        for profile in await gateway.worker_job_profiles():
            if profile.owner == owner:
                evidence.interest_sectors = tuple(profile.sector_interests)
                break

        messages = [row for row in await gateway.worker_assistant_messages() if str(row.get("owner")) == owner]
        messages.sort(key=lambda row: int(row.get("sequence") or 0))
        evidence.recent_brief_tickers = _recent_briefs(messages)
        evidence.active_ticker = _active_ticker(messages)
        history: list[dict[str, str]] = []
        user_text = None
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
        return evidence, history, user_text

    async def _attach_news(
        self, evidence: Evidence, tickers: list[str], job: JobV1, gateway: SpacetimeGateway
    ) -> None:
        """Up to 8 recent headlines per company (3 for the brief), judged by Jev; the best 3 it kept become evidence.
        A story Jev did not keep is left out. Stories Jev could not judge stay unlabeled and only fill
        empty places (all of them when Jev is unavailable, as before Jev), with the reason recorded."""
        if self._news is None or not tickers:
            evidence.news_checked = False
            return
        evidence.news_checked = True
        end = datetime.now(UTC).date()
        start = end - timedelta(days=NEWS_WINDOW_DAYS)
        failed = False
        seen = {item.id for item in evidence.news}
        fetched: list[dict[str, str]] = []
        checked: list[str] = []
        for ticker in tickers:
            limit = CANDIDATES if self.kind == "answer_message" else BRIEF_CANDIDATES
            items = await self._news.news_items(ticker, start, end, limit=limit)
            if items is None:
                failed = True
                continue
            checked.append(ticker)
            for item in items:
                if item["id"] in seen:
                    continue
                seen.add(item["id"])
                fetched.append(item)
        judged = await self._classification.classify(
            [_article(item) for item in fetched], gateway=gateway, job=job, deadline=NEWS_CLASSIFY_SECONDS
        )
        now = datetime.now(UTC)
        by_id = {item["id"]: item for item in fetched}
        for ticker in checked:
            own = judged.for_ticker(ticker)
            evidence.news_classification[ticker] = own.label()
            evidence.news_signals[ticker] = news_signals(own.items, now, window_hours=NEWS_WINDOW_DAYS * 24)
            for chosen in best_stories(own.items, now, limit=SHOWN, fill_unclassified=True):
                item = by_id[chosen.article.article_id]
                evidence.news.append(
                    NewsFact(
                        id=item["id"],
                        ticker=item["ticker"],
                        headline=item["headline"],
                        url=item["url"],
                        source=item["source"],
                        published=item["published"],
                        classification=chosen.classification,
                    )
                )
        evidence.news_failed = failed and not any(item.ticker in tickers for item in evidence.news)


def _article(item: dict[str, str]) -> Article:
    return Article(
        article_id=item["id"],
        ticker=item["ticker"],
        headline=item["headline"],
        text=item.get("summary") or None,
        source=item["source"],
        published_at=datetime.fromisoformat(item["published"]),
    )


def _as_of(evidence: Evidence, tickers: list[str]) -> str | None:
    if not tickers:
        return None
    quote = evidence.quote(tickers[0])
    return quote.as_of if quote else None


def _brief_candidates(evidence: Evidence) -> list[str]:
    found: list[str] = []

    def add(ticker: str) -> None:
        if ticker and evidence.is_equity(ticker) and ticker not in found:
            found.append(ticker)

    for holding in evidence.holdings:
        if holding.quantity > 0:
            add(holding.ticker)
    for recommendation in evidence.recommendations[:3]:
        add(recommendation.ticker)
    movers = [quote for quote in evidence.quotes if evidence.is_equity(quote.ticker) and quote.day_return is not None]
    movers.sort(key=lambda quote: abs(quote.day_return or Decimal(0)), reverse=True)
    for quote in movers[:3]:
        add(quote.ticker)
    return found[:6]


def _brief_body(brief: Brief, *, copy_ready: bool) -> str:
    payload = {
        "v": 1,
        "eyebrow": brief.eyebrow,
        "ticker": brief.ticker or "",
        "reasonType": brief.reason_type,
        "range": brief.chart_range,
        "reasonText": brief.reason_text if copy_ready else "",
        "contextText": brief.context_text if copy_ready else "",
        "followUps": list(brief.follow_ups) if copy_ready else [],
        "copyReady": copy_ready,
    }
    return json.dumps(payload, separators=(",", ":"))


def _with_ui(citations: list[dict[str, str]], follow_ups: list[str], practice: str | None) -> str:
    ui: dict[str, object] = {"id": "orbit.ui", "as_of": "", "followUps": follow_ups[:4]}
    if practice:
        ui["practice"] = practice
    return json.dumps([*citations, ui])


def _recent_briefs(messages: list[dict[str, Any]]) -> tuple[str, ...]:
    found: list[str] = []
    for row in messages:
        if row.get("kind") != "brief" or row.get("status") != "complete":
            continue
        ticker = _ticker_from_body(str(row.get("body") or ""))
        if ticker:
            found.append(ticker)
    return tuple(found[-3:])


def _active_ticker(messages: list[dict[str, Any]]) -> str | None:
    """The company the conversation is about, from rows the worker wrote. User text never sets it."""
    for row in reversed(messages):
        if row.get("role") != "assistant" or str(row.get("status") or "") not in {"complete", "pending"}:
            continue
        ticker = _ticker_from_body(str(row.get("body") or ""))
        if ticker:
            return ticker
        match = re.search(r"quote:([A-Z][A-Z0-9.]{0,9})", str(row.get("citations") or ""))
        if match:
            return match.group(1)
    return None


def handlers(
    *,
    api_key: SecretStr | None,
    model: str,
    timeout: float,
    max_output_tokens: int,
    news: FinnhubProvider | None,
    classification: NewsClassificationService | None = None,
) -> dict[str, AssistantHandler]:
    answer = AssistantHandler(
        kind="answer_message",
        api_key=api_key,
        model=model,
        timeout=timeout,
        max_output_tokens=max_output_tokens,
        news=news,
        classification=classification,
    )
    brief = AssistantHandler(
        kind="home_brief",
        api_key=api_key,
        model=model,
        timeout=timeout,
        max_output_tokens=max_output_tokens,
        news=news,
        classification=classification,
    )
    return {answer.kind: answer, brief.kind: brief}


def _ticker_from_body(body: str) -> str | None:
    try:
        data = json.loads(body)
    except json.JSONDecodeError:
        return None
    if isinstance(data, dict) and isinstance(data.get("ticker"), str) and data["ticker"]:
        return str(data["ticker"])
    return None
