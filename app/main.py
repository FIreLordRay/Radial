"""Radial -- a local-first backlog tool that mirrors from and pushes to Plaky.

Single-user, localhost-only by default (see README): no session/auth layer,
same trust model as raybot's dashboard.py. The one real secret, the Plaky
API key, lives in .env and is never sent to the browser -- every Plaky call
happens server-side in this process.

Sections, not a fixed status enum: a backlog item's "column" is a real Plaky
group id, sourced from whichever board is configured as the "home board"
(see app.sync.get_home_board/set_home_board). That is what makes push a
one-click action -- the space/board/group a push targets is already known
before the user ever opens the push confirmation, because the item was
already living in one of that board's real sections.

A background task pulls automatically every AUTO_PULL_INTERVAL_SECONDS
(default 5 minutes) whenever Plaky is configured, in addition to the
always-available manual "Pull from Plaky" button -- see _auto_pull_loop.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from urllib.parse import quote
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Literal

import httpx
import uvicorn
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.db import Database
from app.plaky_client import PlakyApiError, PlakyClient
from app.sync import clear_home_board, get_home_board, pull_all, push_backlog_item, set_home_board

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("radial")

_APP_DIR = Path(__file__).resolve().parent


class BacklogCreate(BaseModel):
    # max_length=255 matches Plaky's own ItemCreateRequest.title limit, so a
    # title that's valid locally is always valid to push later too.
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(default="", max_length=8000)
    priority: Literal["low", "medium", "high"] = "medium"
    group_id: str | None = None


class BacklogUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=8000)
    priority: Literal["low", "medium", "high"] | None = None
    group_id: str | None = None


class SectionRequest(BaseModel):
    title: str = Field(min_length=1, max_length=80)


class LiveCreateRequest(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    group_id: str


class LiveMoveRequest(BaseModel):
    group_id: str


class LiveFieldRequest(BaseModel):
    value: Any = None


class LiveCommentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=10000)


_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_USERS_TTL_S = 600


class HomeBoardRequest(BaseModel):
    space_id: str
    board_id: str


def _new_client(settings: Settings, transport: httpx.AsyncBaseTransport | None = None) -> PlakyClient:
    if not settings.plaky_configured:
        raise HTTPException(status_code=409, detail="Plaky is not configured (set PLAKY_API_KEY in .env).")
    assert settings.plaky_api_key is not None
    return PlakyClient(
        api_key=settings.plaky_api_key.get_secret_value(), base_url=settings.plaky_base_url, transport=transport
    )


async def _auto_pull_loop(db: Database, settings: Settings) -> None:
    """Background task: pull on startup, then every interval, while configured.

    A failed pull just logs and retries next interval -- Plaky being briefly
    unreachable must never crash the whole server, only leave the cache
    stale until the next successful pull (or a manual one).
    """
    if not settings.plaky_configured or settings.auto_pull_interval_seconds <= 0:
        return
    while True:
        try:
            async with _new_client(settings) as client:
                counts = await pull_all(db, client)
            logger.info("radial.auto_pull.ok", extra={"counts": counts})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - a bad pull must not kill the background task
            logger.warning("radial.auto_pull.failed", exc_info=True)
            with contextlib.suppress(Exception):
                await db.log_sync(direction="pull", target="auto", ok=False, detail="auto-pull failed (see server log)")
        await asyncio.sleep(settings.auto_pull_interval_seconds)


def create_app(
    settings: Settings | None = None, *, plaky_transport: httpx.AsyncBaseTransport | None = None
) -> FastAPI:
    """Build the app. Tests pass their own Settings (temp DB, fake key) and an
    httpx transport that routes Plaky calls to an in-process fake, so the test
    suite never reads .env or touches the network."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db = Database(settings.database_path)
        await db.connect()
        app.state.db = db
        logger.info("radial.started", extra={"plaky_configured": settings.plaky_configured})

        auto_pull_task = asyncio.create_task(_auto_pull_loop(db, settings))
        try:
            yield
        finally:
            auto_pull_task.cancel()
            try:
                await auto_pull_task
            except asyncio.CancelledError:
                pass
            await db.close()

    app = FastAPI(title="Radial", lifespan=lifespan)
    app.state.settings = settings

    @app.middleware("http")
    async def _revalidate(request: Request, call_next):
        # Local app, tiny assets: always revalidate (ETag makes it a cheap 304)
        # so an update never leaves the browser running yesterday's JS.
        response = await call_next(request)
        response.headers.setdefault("Cache-Control", "no-cache")
        return response

    app.mount("/static", StaticFiles(directory=_APP_DIR / "web" / "static"), name="static")
    templates = Jinja2Templates(directory=_APP_DIR / "web" / "templates")

    def db(request: Request) -> Database:
        return request.app.state.db

    @app.exception_handler(PlakyApiError)
    async def _plaky_error_handler(request: Request, exc: PlakyApiError) -> JSONResponse:
        status = exc.status if exc.status and exc.status < 500 else 502
        return JSONResponse(status_code=status, content={"error": str(exc)})

    @app.get("/", include_in_schema=False)
    async def index(request: Request):
        return templates.TemplateResponse(request, "index.html", {"plaky_configured": settings.plaky_configured})

    @app.get("/sw.js", include_in_schema=False)
    async def service_worker() -> FileResponse:
        # Served from root, not /static/sw.js -- a service worker's default
        # scope is "everything at or below its own URL path", so root is
        # what lets it control the whole app instead of just /static/*.
        return FileResponse(_APP_DIR / "web" / "static" / "sw.js", media_type="application/javascript")

    @app.get("/api/config")
    async def get_config() -> dict[str, Any]:
        return {
            "plaky_configured": settings.plaky_configured,
            "auto_pull_interval_seconds": settings.auto_pull_interval_seconds,
        }

    # ---- home board -----------------------------------------------------------

    @app.get("/api/settings/home-board")
    async def home_board(request: Request) -> dict[str, Any]:
        home = await get_home_board(db(request))
        return {"home": home}

    @app.post("/api/settings/home-board")
    async def set_home_board_route(request: Request, payload: HomeBoardRequest) -> dict[str, Any]:
        await set_home_board(db(request), space_id=payload.space_id, board_id=payload.board_id)
        return {"home": {"space_id": payload.space_id, "board_id": payload.board_id}}

    @app.delete("/api/settings/home-board")
    async def clear_home_board_route(request: Request) -> dict[str, Any]:
        await clear_home_board(db(request))
        return {"home": None}

    # ---- sections (the backlog's columns) ------------------------------------

    @app.get("/api/sections")
    async def list_sections(request: Request) -> dict[str, Any]:
        """The current columns: the home board's real Plaky groups, else Radial's local ones."""
        home = await get_home_board(db(request))
        if home is not None:
            return {"source": "plaky", "sections": await db(request).list_plaky_groups(home["board_id"])}
        return {"source": "local", "sections": await db(request).list_local_sections()}

    async def _require_local_mode(request: Request) -> None:
        if await get_home_board(db(request)) is not None:
            raise HTTPException(status_code=409, detail="sections come from your Plaky home board; edit them in Plaky")

    @app.post("/api/sections", status_code=201)
    async def create_section(request: Request, payload: SectionRequest) -> dict[str, Any]:
        await _require_local_mode(request)
        return await db(request).create_local_section(payload.title.strip())

    @app.patch("/api/sections/{section_id}")
    async def rename_section(request: Request, section_id: str, payload: SectionRequest) -> dict[str, Any]:
        await _require_local_mode(request)
        if not await db(request).rename_local_section(section_id, payload.title.strip()):
            raise HTTPException(status_code=404, detail="not found")
        return {"id": section_id, "title": payload.title.strip()}

    @app.delete("/api/sections/{section_id}", status_code=204)
    async def delete_section(request: Request, section_id: str) -> None:
        await _require_local_mode(request)
        if not await db(request).delete_local_section(section_id):
            raise HTTPException(status_code=404, detail="not found")

    # ---- backlog ------------------------------------------------------------

    @app.get("/api/backlog")
    async def list_backlog(request: Request) -> list[dict[str, Any]]:
        items = await db(request).list_backlog_items()
        return [_backlog_to_json(i) for i in items]

    @app.post("/api/backlog", status_code=201)
    async def create_backlog(request: Request, payload: BacklogCreate) -> dict[str, Any]:
        item = await db(request).create_backlog_item(
            title=payload.title, description=payload.description, priority=payload.priority, group_id=payload.group_id
        )
        return _backlog_to_json(item)

    @app.patch("/api/backlog/{item_id}")
    async def update_backlog(request: Request, item_id: str, payload: BacklogUpdate) -> dict[str, Any]:
        # group_id has no "leave alone" value at the DB layer (None IS a
        # meaningful value there, Unsorted) -- so a PATCH that never
        # mentions group_id at all must not be treated as "set it to
        # Unsorted". model_fields_set is what tells the two apart; Radial's
        # own frontend always includes group_id, but the API itself
        # shouldn't only be correct by accident of how one caller behaves.
        group_id = payload.group_id
        if "group_id" not in payload.model_fields_set:
            existing = await db(request).get_backlog_item(item_id)
            if existing is None:
                raise HTTPException(status_code=404, detail="not found")
            group_id = existing.group_id

        item = await db(request).update_backlog_item(
            item_id,
            title=payload.title,
            description=payload.description,
            priority=payload.priority,
            group_id=group_id,
        )
        if item is None:
            raise HTTPException(status_code=404, detail="not found")
        return _backlog_to_json(item)

    @app.delete("/api/backlog/{item_id}", status_code=204, response_model=None)
    async def delete_backlog(request: Request, item_id: str) -> None:
        ok = await db(request).delete_backlog_item(item_id)
        if not ok:
            raise HTTPException(status_code=404, detail="not found")

    @app.post("/api/backlog/{item_id}/push")
    async def push_item(request: Request, item_id: str) -> dict[str, Any]:
        async with _new_client(settings, plaky_transport) as client:
            try:
                await push_backlog_item(db(request), client, item_id=item_id)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=str(exc)) from exc
        item = await db(request).get_backlog_item(item_id)
        assert item is not None
        return _backlog_to_json(item)

    # ---- live Plaky (straight through to Plaky, no cache) ---------------------
    #
    # Everything here talks to Plaky on every call: this is the "what Plaky
    # sees right now" view. The browser polls /api/live/board every ~15s
    # (Plaky has no webhooks). All of it targets the home board.

    async def _live_target(request: Request) -> tuple[str, str]:
        home = await get_home_board(db(request))
        if home is None:
            raise HTTPException(status_code=409, detail="Pick a Plaky board first (sidebar, board picker).")
        return home["space_id"], home["board_id"]

    async def _users(client: PlakyClient) -> dict[str, Any]:
        cache = getattr(app.state, "users_cache", None)
        if cache and time.monotonic() - cache["at"] < _USERS_TTL_S:
            return cache["data"]
        users = await client.list_users()
        try:
            me = await client.get_me()
        except PlakyApiError:
            me = {}
        data = {
            "me": str(me.get("id")) if me.get("id") is not None else None,
            "names": {str(u.get("id")): (u.get("name") or u.get("fullName") or u.get("email") or "") for u in users},
        }
        app.state.users_cache = {"at": time.monotonic(), "data": data}
        return data

    async def _log_push(request: Request, item_id: str, detail: str) -> None:
        await db(request).log_sync(direction="push", target=f"plaky:{item_id}", ok=True, detail=detail)

    @app.get("/api/live/board")
    async def live_board(request: Request) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        async with _new_client(settings, plaky_transport) as client:
            board = await client.get_board(space_id, board_id)
            items = await client.list_items_with_fields(space_id, board_id)
            try:
                users = await _users(client)  # cached 10 min, so ~free on most polls
            except PlakyApiError:
                users = {"me": None, "names": {}}  # names are nice-to-have; never block the board on them
        groups = sorted(board.get("groups") or [], key=lambda g: g.get("ranking") or "")
        return {
            "board": {"id": board.get("id"), "title": board.get("title")},
            "fields": board.get("fields") or [],
            "groups": [{"id": str(g["id"]), "title": g.get("title") or "", "color": g.get("color")} for g in groups],
            "items": [
                {
                    "id": str(it["id"]),
                    "title": it.get("title") or "",
                    "group_id": _ref_id(it.get("group")),
                    "ranking": it.get("ranking") or "",
                    "comment_count": it.get("commentCount") or 0,
                    "file_count": it.get("fileCount") or 0,
                    "fields": it.get("fields") or [],
                }
                for it in items
                if not it.get("archived") and not it.get("deleted")
            ],
            "people": users["names"],
            "me": users["me"],
            "fetched_at": int(time.time()),
        }

    @app.post("/api/live/items", status_code=201)
    async def live_create(request: Request, payload: LiveCreateRequest) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        title = payload.title.strip()
        async with _new_client(settings, plaky_transport) as client:
            created = await client.create_item(space_id=space_id, board_id=board_id, title=title, group_id=payload.group_id)
        await _log_push(request, str(created.get("id")), f"created '{title}'")
        return {"id": str(created.get("id"))}

    @app.patch("/api/live/items/{item_id}/group")
    async def live_move(request: Request, item_id: str, payload: LiveMoveRequest) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        async with _new_client(settings, plaky_transport) as client:
            await client.move_item_to_group(
                space_id=space_id, board_id=board_id, item_id=item_id, group_id=payload.group_id
            )
        await _log_push(request, item_id, f"moved to group {payload.group_id}")
        return {"ok": True}

    @app.patch("/api/live/items/{item_id}/fields/{field_key}")
    async def live_field(request: Request, item_id: str, field_key: str, payload: LiveFieldRequest) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        async with _new_client(settings, plaky_transport) as client:
            await client.update_item_field(
                space_id=space_id,
                board_id=board_id,
                item_id=item_id,
                field_key=quote(field_key, safe=""),
                value=payload.value,
            )
        await _log_push(request, item_id, f"set {field_key}")
        return {"ok": True}

    @app.get("/api/live/items/{item_id}/activity")
    async def live_activity(request: Request, item_id: str) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        async with _new_client(settings, plaky_transport) as client:
            comments = await client.list_comments(space_id, board_id, item_id)
            files = await client.list_files(space_id, board_id, item_id)
            users = await _users(client)

        def author(c: dict[str, Any]) -> str | None:
            return _ref_id(c.get("createdBy"))

        return {
            "comments": [
                {
                    "id": c.get("id"),
                    "text": c.get("content") or "",
                    "author": users["names"].get(author(c) or "") or "Someone",
                    "mine": users["me"] is not None and author(c) == users["me"],
                    "created_at": c.get("createdAt"),
                }
                for c in comments
                if not c.get("deleted")
            ],
            "files": [
                {"id": f.get("id"), "name": f.get("name") or "file", "size": f.get("size"), "created_at": f.get("createdAt")}
                for f in files
            ],
        }

    @app.post("/api/live/items/{item_id}/comments", status_code=201)
    async def live_comment(request: Request, item_id: str, payload: LiveCommentRequest) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        async with _new_client(settings, plaky_transport) as client:
            await client.create_comment(space_id=space_id, board_id=board_id, item_id=item_id, text=payload.text.strip())
        await _log_push(request, item_id, "commented")
        return {"ok": True}

    @app.post("/api/live/items/{item_id}/files", status_code=201)
    async def live_upload(request: Request, item_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
        space_id, board_id = await _live_target(request)
        content = await file.read(_MAX_UPLOAD_BYTES + 1)
        if len(content) > _MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="File is over 50 MB.")
        name = file.filename or "upload"
        async with _new_client(settings, plaky_transport) as client:
            await client.upload_file(
                space_id=space_id,
                board_id=board_id,
                item_id=item_id,
                filename=name,
                content=content,
                content_type=file.content_type or "",
            )
        await _log_push(request, item_id, f"uploaded {name}")
        return {"ok": True}

    # ---- Plaky cache (browse what's been pulled) -----------------------------

    @app.post("/api/sync/pull")
    async def sync_pull(request: Request) -> dict[str, Any]:
        async with _new_client(settings, plaky_transport) as client:
            try:
                counts = await pull_all(db(request), client)
            except PlakyApiError as exc:
                await db(request).log_sync(direction="pull", target="all", ok=False, detail=str(exc))
                raise
        return {"ok": True, "counts": counts}

    @app.get("/api/sync/log")
    async def sync_log(request: Request) -> list[dict[str, Any]]:
        entries = await db(request).list_sync_log()
        return [
            {"id": e.id, "direction": e.direction, "target": e.target, "ok": e.ok, "detail": e.detail, "created_at": e.created_at}
            for e in entries
        ]

    @app.get("/api/plaky/spaces")
    async def plaky_spaces(request: Request) -> list[dict[str, Any]]:
        return await db(request).list_plaky_spaces()

    @app.get("/api/plaky/boards")
    async def plaky_boards(request: Request, space_id: str) -> list[dict[str, Any]]:
        return await db(request).list_plaky_boards(space_id)

    @app.get("/api/plaky/groups")
    async def plaky_groups(request: Request, board_id: str) -> list[dict[str, Any]]:
        return await db(request).list_plaky_groups(board_id)

    @app.get("/api/plaky/items")
    async def plaky_items(request: Request, board_id: str | None = None) -> list[dict[str, Any]]:
        items = await db(request).list_plaky_items(board_id)
        return [
            {"id": i.id, "space_id": i.space_id, "board_id": i.board_id, "group_id": i.group_id, "title": i.title, "fields": i.fields}
            for i in items
        ]

    return app


def _ref_id(value: Any) -> str | None:
    """Plaky returns parents/authors as a bare id, or as an object when expanded."""
    if isinstance(value, dict):
        value = value.get("id")
    return None if value is None else str(value)


def _backlog_to_json(item: Any) -> dict[str, Any]:
    return {
        "id": item.id,
        "title": item.title,
        "description": item.description,
        "priority": item.priority,
        "group_id": item.group_id,
        "linked": item.linked,
        "plaky_item_id": item.plaky_item_id,
        "pushed_at": item.pushed_at,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


app = create_app()


def main() -> None:
    settings = get_settings()
    if sys.stdout is None or sys.stderr is None:
        # pythonw (start_hidden.vbs) has no console: stdout/stderr are None
        # and uvicorn's log formatter crashes on startup. Log to a file instead.
        log_path = settings.database_path.parent / "radial.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        sys.stdout = sys.stderr = open(log_path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
        logging.getLogger().handlers.clear()
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s", stream=sys.stderr)
    # Import string, not the `app` object: under `python -m app.main` this
    # module is `__main__`, and on Python 3.14 + Pydantic 2.13 the request
    # models defined here then fail to build ("not fully defined"), so every
    # POST/PATCH 500s. Letting uvicorn import app.main normally avoids that.
    uvicorn.run("app.main:app", host=settings.host, port=settings.port)


if __name__ == "__main__":
    main()
