"""Shared fixtures: a Radial app wired to a temp database and an in-process fake Plaky.

Nothing here reads .env or opens a network socket: Settings are built
explicitly (with _env_file=None), and Plaky calls go through an httpx
ASGITransport straight into tests/fake_plaky.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from tests.fake_plaky import API_KEY, make_fake_plaky  # noqa: E402


def _settings(tmp_path: Path, *, key: str | None = API_KEY) -> Settings:
    return Settings(
        _env_file=None,
        plaky_api_key=key,
        plaky_base_url="http://plaky.test",
        auto_pull_interval_seconds=0,  # no background pulls during tests
        database_path=tmp_path / "radial.db",
    )


@pytest.fixture
def fake_plaky():
    return make_fake_plaky()


@pytest.fixture
def client(tmp_path, fake_plaky):
    fake_app, _state = fake_plaky
    app = create_app(_settings(tmp_path), plaky_transport=httpx.ASGITransport(app=fake_app))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def plaky_state(fake_plaky):
    return fake_plaky[1]


@pytest.fixture
def local_client(tmp_path):
    """Radial with no Plaky key at all (local-only mode)."""
    app = create_app(_settings(tmp_path, key=None))
    with TestClient(app) as c:
        yield c


@pytest.fixture
def live_client(client):
    """Pulled from fake Plaky with the Assignments board set as home."""
    assert client.post("/api/sync/pull").status_code == 200
    assert client.post("/api/settings/home-board", json={"space_id": "1", "board_id": "2"}).status_code == 200
    return client
