import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.config.settings import Settings
from app.main import create_app
from app.state.gateway import (
    GatewayAuthError,
    GatewayContractError,
    GatewayUnavailable,
    ReducerRejected,
    SpacetimeGateway,
)


def gateway_with(handler) -> SpacetimeGateway:
    return SpacetimeGateway("http://stdb.test", "orbit-test", SecretStr("t"), transport=httpx.MockTransport(handler))


async def test_sender_error_maps_to_reducer_rejected():
    gw = gateway_with(lambda req: httpx.Response(530, text="not_authorized_service"))
    with pytest.raises(ReducerRejected) as info:
        await gw.claim_job(1, 30)
    assert info.value.code == "not_authorized_service"
    assert info.value.reducer == "claim_job"


async def test_unstructured_reducer_error_gets_generic_code():
    gw = gateway_with(lambda req: httpx.Response(530, text="panic at line 3: secret detail"))
    with pytest.raises(ReducerRejected) as info:
        await gw.complete_job(1, 1, 1, "x")
    assert info.value.code == "reducer_error"


async def test_request_shape_and_auth_header():
    seen = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["path"] = req.url.path
        seen["auth"] = req.headers.get("authorization")
        seen["body"] = req.content
        return httpx.Response(200)

    await gateway_with(handler).complete_job(7, 2, 3, "ok")
    assert seen == {"path": "/v1/database/orbit-test/call/complete_job", "auth": "Bearer t", "body": b'[7,2,3,"ok"]'}


@pytest.mark.parametrize(
    ("status", "error"),
    [(401, GatewayAuthError), (400, GatewayContractError), (404, GatewayContractError), (503, GatewayUnavailable)],
)
async def test_status_mapping(status, error):
    gw = gateway_with(lambda req: httpx.Response(status, text="x"))
    with pytest.raises(error):
        await gw.worker_jobs()


async def test_transport_failure_is_retryable():
    def boom(req):
        raise httpx.ConnectError("refused")

    with pytest.raises(GatewayUnavailable) as info:
        await gateway_with(boom).worker_jobs()
    assert info.value.retryable


def test_alpaca_live_endpoint_rejected():
    with pytest.raises(ValidationError):
        Settings(alpaca_base_url="https://api.alpaca.markets", _env_file=None)


def test_alpaca_keys_must_be_paired():
    with pytest.raises(ValidationError):
        Settings(alpaca_api_key_id="abc", _env_file=None)


def test_secrets_not_in_repr():
    s = Settings(openai_api_key="sk-should-not-leak", _env_file=None, spacetime_service_token_file=None)
    assert "sk-should-not-leak" not in repr(s)


def test_health_and_unready_without_server():
    settings = Settings(
        _env_file=None,
        spacetime_http_url="http://127.0.0.1:9",  # nothing listens here
        spacetime_service_token_file=None,
    )
    with TestClient(create_app(settings)) as client:
        assert client.get("/health").json() == {"api_version": "v1", "status": "ok", "env": "development"}
        ready = client.get("/ready")
        assert ready.status_code == 503
        assert ready.json()["checks"]["spacetimedb"] == "fail"
        assert ready.json()["checks"]["service_identity"] == "not_configured"
        missing = client.get("/nope")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "not_found"
        assert missing.headers["x-request-id"]


def test_blank_env_values_are_treated_as_unset(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text("SPACETIME_SERVICE_TOKEN=\nFINNHUB_API_KEY=\n")
    token_file = tmp_path / "service_token"
    token_file.write_text("from-file")
    s = Settings(_env_file=env, spacetime_service_token_file=token_file)
    assert s.spacetime_service_token is None and s.finnhub_api_key is None
    assert s.resolved_service_token().get_secret_value() == "from-file"
