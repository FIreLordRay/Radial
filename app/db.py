"""SQLite persistence for Radial.

Single-writer-lock + WAL, same pattern as ray-chat's app/db.py: one process,
one file, every statement parameterised (no f-string SQL anywhere in this
file -- that discipline is the entire SQL-injection defence).

Two families of table:
  * A local cache of what Plaky actually has (spaces/boards/groups/plaky_items),
    refreshed wholesale on every pull -- never hand-edited, never the source
    of truth for anything Radial itself created.
  * Radial's own backlog (items), which exists independently of Plaky and
    only gains a plaky_item_id once explicitly pushed. An item's group_id
    is always a real Plaky group id from whichever board is the current
    "home board" (app.sync.get_home_board) -- see clear_all_backlog_groups
    for what happens to it when that changes.
"""

from __future__ import annotations

import json
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import aiosqlite

__all__ = [
    "Database",
    "BacklogItem",
    "PlakyItem",
    "SyncLogEntry",
    "new_id",
]

SCHEMA_SQL: Final[str] = """
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS backlog_items (
    id            TEXT PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    priority      TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high')),
    group_id      TEXT,
    plaky_item_id TEXT,
    pushed_at     INTEGER,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backlog_group ON backlog_items(group_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_backlog_plaky_item ON backlog_items(plaky_item_id)
    WHERE plaky_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS plaky_spaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    cached_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plaky_boards (
    id         TEXT PRIMARY KEY,
    space_id   TEXT NOT NULL REFERENCES plaky_spaces(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    cached_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_boards_space ON plaky_boards(space_id);

CREATE TABLE IF NOT EXISTS plaky_groups (
    id         TEXT PRIMARY KEY,
    board_id   TEXT NOT NULL REFERENCES plaky_boards(id) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    cached_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_groups_board ON plaky_groups(board_id);

CREATE TABLE IF NOT EXISTS plaky_items (
    id          TEXT PRIMARY KEY,
    space_id    TEXT NOT NULL,
    board_id    TEXT NOT NULL,
    group_id    TEXT,
    title       TEXT NOT NULL,
    fields_json TEXT NOT NULL DEFAULT '[]',
    cached_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_plaky_items_board ON plaky_items(board_id);

CREATE TABLE IF NOT EXISTS sync_log (
    id         TEXT PRIMARY KEY,
    direction  TEXT NOT NULL CHECK (direction IN ('pull','push')),
    target     TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sync_log_created ON sync_log(created_at DESC);
"""

_PRAGMAS: Final[tuple[str, ...]] = (
    "PRAGMA journal_mode = WAL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA busy_timeout = 5000;",
    "PRAGMA synchronous = NORMAL;",
)


def new_id() -> str:
    return secrets.token_hex(12)


def _now() -> int:
    return int(time.time())


@dataclass(frozen=True, slots=True)
class BacklogItem:
    id: str
    title: str
    description: str
    priority: str
    group_id: str | None
    plaky_item_id: str | None
    pushed_at: int | None
    created_at: int
    updated_at: int

    @property
    def linked(self) -> bool:
        return self.plaky_item_id is not None


@dataclass(frozen=True, slots=True)
class PlakyItem:
    id: str
    space_id: str
    board_id: str
    group_id: str | None
    title: str
    fields: list[dict[str, Any]]
    cached_at: int


@dataclass(frozen=True, slots=True)
class SyncLogEntry:
    id: str
    direction: str
    target: str
    ok: bool
    detail: str | None
    created_at: int


def _row_to_backlog_item(row: sqlite3.Row) -> BacklogItem:
    return BacklogItem(
        id=row["id"],
        title=row["title"],
        description=row["description"],
        priority=row["priority"],
        group_id=row["group_id"],
        plaky_item_id=row["plaky_item_id"],
        pushed_at=row["pushed_at"],
        created_at=int(row["created_at"]),
        updated_at=int(row["updated_at"]),
    )


def _row_to_plaky_item(row: sqlite3.Row) -> PlakyItem:
    try:
        fields = json.loads(row["fields_json"])
    except (TypeError, ValueError):
        fields = []
    return PlakyItem(
        id=row["id"],
        space_id=row["space_id"],
        board_id=row["board_id"],
        group_id=row["group_id"],
        title=row["title"],
        fields=fields if isinstance(fields, list) else [],
        cached_at=int(row["cached_at"]),
    )


def _row_to_sync_log(row: sqlite3.Row) -> SyncLogEntry:
    return SyncLogEntry(
        id=row["id"],
        direction=row["direction"],
        target=row["target"],
        ok=bool(row["ok"]),
        detail=row["detail"],
        created_at=int(row["created_at"]),
    )


class Database:
    def __init__(self, path: Path | str) -> None:
        self._path = Path(path)
        self._conn: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        if self._conn is not None:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        conn = await aiosqlite.connect(self._path, isolation_level=None)
        conn.row_factory = sqlite3.Row
        for pragma in _PRAGMAS:
            await conn.execute(pragma)
        await conn.executescript(SCHEMA_SQL)
        self._conn = conn

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("database is not connected")
        return self._conn

    # ---- backlog items ----------------------------------------------------

    async def create_backlog_item(
        self, *, title: str, description: str = "", priority: str = "medium", group_id: str | None = None
    ) -> BacklogItem:
        item_id = new_id()
        now = _now()
        await self.conn.execute(
            "INSERT INTO backlog_items "
            "(id, title, description, priority, group_id, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?);",
            (item_id, title, description, priority, group_id, now, now),
        )
        row = await self._fetch_backlog_row(item_id)
        assert row is not None
        return _row_to_backlog_item(row)

    async def _fetch_backlog_row(self, item_id: str) -> sqlite3.Row | None:
        async with self.conn.execute(
            "SELECT * FROM backlog_items WHERE id = ?;", (item_id,)
        ) as cur:
            return await cur.fetchone()

    async def get_backlog_item(self, item_id: str) -> BacklogItem | None:
        row = await self._fetch_backlog_row(item_id)
        return None if row is None else _row_to_backlog_item(row)

    async def list_backlog_items(self) -> list[BacklogItem]:
        async with self.conn.execute(
            "SELECT * FROM backlog_items ORDER BY "
            "CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, updated_at DESC;"
        ) as cur:
            rows = await cur.fetchall()
        return [_row_to_backlog_item(r) for r in rows]

    async def update_backlog_item(
        self,
        item_id: str,
        *,
        title: str | None = None,
        description: str | None = None,
        priority: str | None = None,
        group_id: str | None = None,
    ) -> BacklogItem | None:
        """`group_id` is always written as given (including None = Unsorted) --
        unlike title/description/priority, it has no "leave alone" sentinel
        because the frontend always submits its current value on every save.
        """
        now = _now()
        await self.conn.execute(
            "UPDATE backlog_items SET "
            "title = COALESCE(?, title), "
            "description = COALESCE(?, description), "
            "priority = COALESCE(?, priority), "
            "group_id = ?, "
            "updated_at = ? "
            "WHERE id = ?;",
            (title, description, priority, group_id, now, item_id),
        )
        row = await self._fetch_backlog_row(item_id)
        return None if row is None else _row_to_backlog_item(row)

    async def delete_backlog_item(self, item_id: str) -> bool:
        cur = await self.conn.execute("DELETE FROM backlog_items WHERE id = ?;", (item_id,))
        return cur.rowcount > 0

    async def clear_all_backlog_groups(self) -> None:
        """Unset every unpushed item's section (used when the home board changes).

        A group_id is only meaningful relative to whichever board is
        currently "home" -- it's a real Plaky group id from that board's
        own sections. Switching to a different board makes every existing
        group_id stale (it may not even exist on the new board, or worse,
        collide with an unrelated group id that happens to belong to it),
        so this resets them all to Unsorted rather than leaving items
        silently pointing at sections that no longer make sense.
        """
        now = _now()
        await self.conn.execute(
            "UPDATE backlog_items SET group_id = NULL, updated_at = ? WHERE group_id IS NOT NULL;", (now,)
        )

    async def mark_backlog_item_pushed(self, item_id: str, *, plaky_item_id: str) -> BacklogItem | None:
        now = _now()
        await self.conn.execute(
            "UPDATE backlog_items SET plaky_item_id = ?, pushed_at = ?, updated_at = ? WHERE id = ?;",
            (plaky_item_id, now, now, item_id),
        )
        row = await self._fetch_backlog_row(item_id)
        return None if row is None else _row_to_backlog_item(row)

    # ---- settings (currently just the "home board") ------------------------

    async def get_setting(self, key: str) -> str | None:
        async with self.conn.execute("SELECT value FROM app_settings WHERE key = ?;", (key,)) as cur:
            row = await cur.fetchone()
        return None if row is None else row["value"]

    async def set_setting(self, key: str, value: str) -> None:
        await self.conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
            (key, value),
        )

    # ---- Plaky cache (wholesale-replaced on pull) --------------------------

    async def replace_plaky_cache(
        self,
        *,
        spaces: list[dict[str, Any]],
        boards: list[dict[str, Any]],
        groups: list[dict[str, Any]],
        items: list[dict[str, Any]],
    ) -> None:
        """Atomically swap the entire Plaky cache for a fresh pull's results.

        Deleting and re-inserting (rather than diffing) is deliberate: the
        cache exists only to browse/select against, never as a merge target,
        so "wholesale replace" is simpler and cannot drift from what Plaky
        actually returned this pull.
        """
        now = _now()
        conn = self.conn
        await conn.execute("BEGIN IMMEDIATE;")
        try:
            await conn.execute("DELETE FROM plaky_items;")
            await conn.execute("DELETE FROM plaky_groups;")
            await conn.execute("DELETE FROM plaky_boards;")
            await conn.execute("DELETE FROM plaky_spaces;")
            for s in spaces:
                await conn.execute(
                    "INSERT INTO plaky_spaces (id, name, cached_at) VALUES (?, ?, ?);",
                    (str(s["id"]), s.get("name") or "", now),
                )
            for b in boards:
                await conn.execute(
                    "INSERT INTO plaky_boards (id, space_id, name, cached_at) VALUES (?, ?, ?, ?);",
                    (str(b["id"]), str(b["space_id"]), b.get("name") or "", now),
                )
            for g in groups:
                await conn.execute(
                    "INSERT INTO plaky_groups (id, board_id, title, position, cached_at) VALUES (?, ?, ?, ?, ?);",
                    (str(g["id"]), str(g["board_id"]), g.get("title") or "", int(g.get("position") or 0), now),
                )
            for it in items:
                await conn.execute(
                    "INSERT INTO plaky_items (id, space_id, board_id, group_id, title, fields_json, cached_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?);",
                    (
                        str(it["id"]),
                        str(it["space_id"]),
                        str(it["board_id"]),
                        None if it.get("group_id") is None else str(it["group_id"]),
                        it.get("title") or "",
                        json.dumps(it.get("fields") or [], ensure_ascii=False),
                        now,
                    ),
                )
            await conn.execute("COMMIT;")
        except BaseException:
            await conn.execute("ROLLBACK;")
            raise

    async def list_plaky_spaces(self) -> list[dict[str, Any]]:
        async with self.conn.execute("SELECT id, name FROM plaky_spaces ORDER BY name;") as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "name": r["name"]} for r in rows]

    async def list_plaky_boards(self, space_id: str) -> list[dict[str, Any]]:
        async with self.conn.execute(
            "SELECT id, name FROM plaky_boards WHERE space_id = ? ORDER BY name;", (space_id,)
        ) as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "name": r["name"]} for r in rows]

    async def list_plaky_groups(self, board_id: str) -> list[dict[str, Any]]:
        async with self.conn.execute(
            "SELECT id, title FROM plaky_groups WHERE board_id = ? ORDER BY position;", (board_id,)
        ) as cur:
            rows = await cur.fetchall()
        return [{"id": r["id"], "title": r["title"]} for r in rows]

    async def list_plaky_items(self, board_id: str | None = None) -> list[PlakyItem]:
        if board_id is not None:
            async with self.conn.execute(
                "SELECT * FROM plaky_items WHERE board_id = ? ORDER BY title;", (board_id,)
            ) as cur:
                rows = await cur.fetchall()
        else:
            async with self.conn.execute("SELECT * FROM plaky_items ORDER BY cached_at DESC;") as cur:
                rows = await cur.fetchall()
        return [_row_to_plaky_item(r) for r in rows]

    # ---- sync log -----------------------------------------------------------

    async def log_sync(self, *, direction: str, target: str, ok: bool, detail: str | None = None) -> None:
        await self.conn.execute(
            "INSERT INTO sync_log (id, direction, target, ok, detail, created_at) VALUES (?, ?, ?, ?, ?, ?);",
            (new_id(), direction, target, 1 if ok else 0, detail, _now()),
        )

    async def list_sync_log(self, limit: int = 50) -> list[SyncLogEntry]:
        async with self.conn.execute(
            "SELECT * FROM sync_log ORDER BY created_at DESC LIMIT ?;", (max(1, min(limit, 500)),)
        ) as cur:
            rows = await cur.fetchall()
        return [_row_to_sync_log(r) for r in rows]
