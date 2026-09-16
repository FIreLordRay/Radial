"""Radial settings, loaded once from the environment/.env at process start.

Single-user, local-first tool: there is no session/auth layer here (see
README) -- Radial is meant to run on localhost for one person, same trust
model as raybot's dashboard.py. The one real secret is PLAKY_API_KEY, which
is why it is a SecretStr (never logged, never rendered back to the browser).
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # ---- Plaky ----
    plaky_api_key: SecretStr | None = None
    plaky_base_url: str = "https://api.plaky.com"
    # Automatic background pull cadence. 0 disables the background task
    # entirely (manual "Pull from Plaky" still always works).
    auto_pull_interval_seconds: int = 300

    # ---- server ----
    host: str = "127.0.0.1"
    port: int = 5100

    # ---- database ----
    database_path: Path = Path("./data/radial.db")

    @property
    def plaky_configured(self) -> bool:
        return self.plaky_api_key is not None and bool(self.plaky_api_key.get_secret_value().strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
