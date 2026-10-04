"""OpenAI Responses API. The key is sent only as a bearer token and is never logged."""

from __future__ import annotations

import json
from typing import Any

import httpx
from pydantic import SecretStr

from app.assistant.policy import response_body

API_URL = "https://api.openai.com/v1/responses"


class AssistantModelError(Exception):
    def __init__(self, code: str, *, retryable: bool):
        super().__init__(code)
        self.code = code
        self.retryable = retryable


async def complete(
    api_key: SecretStr,
    payload: dict[str, object],
    *,
    timeout: float,
    client: httpx.AsyncClient | None = None,
    shape: str = "chat",
) -> dict[str, Any]:
    owns_client = client is None
    http = client or httpx.AsyncClient(timeout=timeout)
    try:
        response = await http.post(
            API_URL,
            headers={"Authorization": f"Bearer {api_key.get_secret_value()}"},
            json=payload,
        )
    except httpx.HTTPError as exc:
        raise AssistantModelError("model_unavailable", retryable=True) from exc
    finally:
        if owns_client:
            await http.aclose()

    if response.status_code == 429 or response.status_code >= 500:
        raise AssistantModelError("model_unavailable", retryable=True)
    if response.status_code >= 400:
        raise AssistantModelError("model_rejected", retryable=False)
    try:
        body = response.json()
    except json.JSONDecodeError as exc:
        raise AssistantModelError("model_rejected", retryable=False) from exc
    text = _output_text(body)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as exc:
        raise AssistantModelError("model_rejected", retryable=False) from exc
    if not isinstance(parsed, dict):
        raise AssistantModelError("model_rejected", retryable=False)
    if shape == "brief":
        follow = _strings(parsed.get("followUps"))
        if not isinstance(parsed.get("reasonText"), str) or not isinstance(parsed.get("contextText"), str) or follow is None:
            raise AssistantModelError("model_rejected", retryable=False)
        return {
            "reasonText": parsed["reasonText"].strip(),
            "contextText": parsed["contextText"].strip(),
            "followUps": follow,
        }
    if not isinstance(parsed.get("text"), str) or not isinstance(parsed.get("citations"), list):
        raise AssistantModelError("model_rejected", retryable=False)
    citations = []
    for item in parsed["citations"]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("as_of"), str):
            raise AssistantModelError("model_rejected", retryable=False)
        citations.append({"id": item["id"], "as_of": item["as_of"]})
    follow = _strings(parsed.get("followUps", []))
    if follow is None:
        raise AssistantModelError("model_rejected", retryable=False)
    return {"text": parsed["text"].strip(), "citations": citations, "followUps": follow}


def _strings(value: Any) -> list[str] | None:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return None
    return value


def _output_text(body: dict[str, Any]) -> str:
    if isinstance(body.get("output_text"), str) and body["output_text"].strip():
        return str(body["output_text"])
    chunks: list[str] = []
    for item in body.get("output") or []:
        if not isinstance(item, dict):
            continue
        for content in item.get("content") or []:
            if isinstance(content, dict) and isinstance(content.get("text"), str):
                chunks.append(content["text"])
    if not chunks:
        raise AssistantModelError("model_rejected", retryable=False)
    return "".join(chunks)


def build_payload(**kwargs: Any) -> dict[str, object]:
    payload = response_body(**kwargs)
    if "tools" in payload:
        raise RuntimeError("assistant payload must not include tools")
    return payload
