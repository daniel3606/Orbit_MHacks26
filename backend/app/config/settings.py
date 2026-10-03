"""Typed, validated environment configuration.

Values come from the process environment, then `backend/.env` (gitignored).
Secrets are `SecretStr` so they never appear in reprs or logs.
"""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import AnyHttpUrl, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]

ALPACA_PAPER_URL = "https://paper-api.alpaca.markets"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_env: Literal["development", "test", "demo", "production"] = "development"
    log_level: Literal["DEBUG", "INFO", "WARNING", "ERROR"] = "INFO"

    # SpacetimeDB
    spacetime_http_url: AnyHttpUrl = AnyHttpUrl("http://127.0.0.1:3000")
    spacetime_database: str = Field(default="orbit-dev", pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    spacetime_service_token: SecretStr | None = None
    spacetime_service_token_file: Path | None = BACKEND_DIR / ".secrets" / "service_token"
    spacetime_timeout_seconds: float = Field(default=10.0, gt=0, le=60)

    # Worker
    worker_id: str = Field(default="worker-local-1", pattern=r"^[A-Za-z0-9_.-]{1,48}$")
    worker_poll_interval_seconds: float = Field(default=1.0, ge=0.2, le=60)
    worker_max_poll_interval_seconds: float = Field(default=5.0, ge=1, le=300)
    worker_lease_seconds: int = Field(default=30, ge=5, le=300)
    worker_concurrency: int = Field(default=2, ge=1, le=16)

    # Provider credentials (not used in this phase; validated when present).
    finnhub_api_key: SecretStr | None = None
    jev_api_key: SecretStr | None = None
    jev_base_url: AnyHttpUrl | None = None
    openai_api_key: SecretStr | None = None
    alpaca_api_key_id: SecretStr | None = None
    alpaca_api_secret_key: SecretStr | None = None
    alpaca_base_url: AnyHttpUrl = AnyHttpUrl(ALPACA_PAPER_URL)

    @field_validator("alpaca_base_url")
    @classmethod
    def paper_only(cls, value: AnyHttpUrl) -> AnyHttpUrl:
        # Live execution is disabled in the MVP adapter (PRD §24).
        if value.host != "paper-api.alpaca.markets":
            raise ValueError("Only the Alpaca paper endpoint is allowed")
        return value

    @model_validator(mode="after")
    def alpaca_pair(self) -> "Settings":
        if (self.alpaca_api_key_id is None) != (self.alpaca_api_secret_key is None):
            raise ValueError("ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY must be set together")
        return self

    def resolved_service_token(self) -> SecretStr | None:
        """Env var wins; otherwise the gitignored token file written by bootstrap."""
        if self.spacetime_service_token is not None:
            return self.spacetime_service_token
        path = self.spacetime_service_token_file
        if path is not None and path.is_file():
            token = path.read_text(encoding="utf-8").strip()
            if token:
                return SecretStr(token)
        return None


@lru_cache
def get_settings() -> Settings:
    return Settings()
