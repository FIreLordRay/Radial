"""An in-process fake of Plaky's public API, shaped after its published OpenAPI spec.

Deliberately strict about the things Radial has to get right (the X-API-Key
header, integer `groupId` / `itemGroupId`, `{"value": ...}` field bodies,
multipart `file` uploads, bare-array vs paged responses), so a wiring bug fails
here with a 4xx exactly like it would against real Plaky.

Each call to make_fake_plaky() returns a fresh app + state, so tests can't
leak into each other. `state.requests` records every call for assertions.
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse

API_KEY = "test-key"
P = "/v1/public"
B = P + "/spaces/{s}/boards/{b}"

STATUS_FIELD = {
    "id": 1, "name": "Status", "key": "status-1", "type": "STATUS",
    "configuration": {"values": [
        {"key": "s1", "title": "Not started", "color": "#a09488", "isFinal": False},
        {"key": "s2", "title": "Working on it", "color": "#f59e0b", "isFinal": False},
        {"key": "s3", "title": "Submitted", "color": "#4ade80", "isFinal": True},
    ], "defaultValue": "s1"},
}
FIELDS = [
    STATUS_FIELD,
    {"id": 2, "name": "Due", "key": "date-1", "type": "DATE_TIME", "configuration": {}},
    {"id": 3, "name": "Work link", "key": "link-1", "type": "LINK", "configuration": {}},
    {"id": 4, "name": "Notes", "key": "text-1", "type": "RICH_TEXT", "configuration": {}},
    {"id": 5, "name": "Owner", "key": "person-1", "type": "PERSON", "configuration": {}},
]
GROUPS = [
    {"id": 11, "title": "Week 1", "color": "#f59e0b", "ranking": "b"},
    {"id": 10, "title": "Orientation", "color": "#60a5fa", "ranking": "a"},  # out of order on purpose
    {"id": 13, "title": "Done", "color": "#4ade80", "ranking": "c"},
]


@dataclass
class FakeState:
    items: dict[int, dict[str, Any]] = field(default_factory=dict)
    comments: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    files: dict[int, list[dict[str, Any]]] = field(default_factory=dict)
    requests: list[tuple[str, str]] = field(default_factory=list)
    ids: Any = field(default_factory=lambda: itertools.count(1000))

    def add_item(self, title: str, group: int, status: str = "s1", **extra: Any) -> int:
        iid = next(self.ids)
        self.items[iid] = {
            "id": iid, "title": title, "group": group, "ranking": str(iid),
            "archived": extra.get("archived", False), "deleted": False,
            "values": {"status-1": status, "date-1": None, "link-1": None, "text-1": "",
                       "person-1": {"users": [{"id": 7}], "teams": []}},
        }
        self.comments[iid], self.files[iid] = [], []
        return iid


def make_fake_plaky(*, n_filler: int = 0) -> tuple[FastAPI, FakeState]:
    state = FakeState()
    state.add_item("SQL joins worksheet", 11, "s2")
    state.add_item("Python OOP project", 11)
    state.add_item("Old archived thing", 11, archived=True)
    state.add_item("Week 1 reflection", 13, "s3")
    for k in range(n_filler):  # enough to force multiple pages at pageSize=50
        state.add_item(f"Standup {k + 1}", 10)

    app = FastAPI()

    @app.middleware("http")
    async def auth_and_record(request: Request, call_next):
        state.requests.append((request.method, request.url.path + ("?" + request.url.query if request.url.query else "")))
        if request.headers.get("x-api-key") != API_KEY:
            return JSONResponse(status_code=401, content={"message": "Unauthorized"})
        return await call_next(request)

    def item_json(it: dict[str, Any], expand: list[str]) -> dict[str, Any]:
        out = {k: it[k] for k in ("id", "title", "group", "ranking", "archived", "deleted")}
        out["commentCount"], out["fileCount"] = len(state.comments[it["id"]]), len(state.files[it["id"]])
        if "fields" in expand:
            out["fields"] = [
                # real Plaky returns STATUS as {key,label,color} even unexpanded; mirror that
                {"key": f["key"], "type": f["type"], "title": f["name"],
                 "value": _status_obj(it["values"][f["key"]]) if f["type"] == "STATUS" else it["values"][f["key"]]}
                for f in FIELDS
            ]
        return out

    def _status_obj(key: str | None) -> dict[str, Any] | None:
        label = next((v for v in STATUS_FIELD["configuration"]["values"] if v["key"] == key), None)
        return None if label is None else {"key": label["key"], "label": label["title"], "color": label["color"]}

    def paged(rows: list[dict[str, Any]], request: Request) -> dict[str, Any]:
        page = int(request.query_params.get("page", 1))
        size = int(request.query_params.get("pageSize", 50))
        if size > 100:
            raise HTTPException(400, "pageSize too large")
        chunk = rows[(page - 1) * size : page * size]
        return {"data": chunk, "hasMore": page * size < len(rows)}

    def get_item(item_id: int) -> dict[str, Any]:
        it = state.items.get(int(item_id))
        if not it:
            raise HTTPException(404, "item not found")
        return it

    @app.get(P + "/spaces")
    def spaces(request: Request):
        return paged([{"id": 1, "title": "Intern Space"}], request)

    @app.get(P + "/spaces/{s}/boards")
    def boards(s: int, request: Request):
        return paged([{"id": 2, "title": "Assignments"}], request)

    @app.get(B)
    def board(s: int, b: int):
        return {"id": 2, "title": "Assignments", "fields": FIELDS, "groups": GROUPS}

    @app.get(B + "/item-groups")
    def groups(s: int, b: int, request: Request):
        return paged(GROUPS, request)

    @app.get(B + "/items")
    def items(s: int, b: int, request: Request):
        expand = request.query_params.getlist("expand")
        return paged([item_json(i, expand) for i in state.items.values()], request)

    @app.post(B + "/items")
    async def create(s: int, b: int, request: Request):
        body = await request.json()
        if not isinstance(body.get("groupId"), int) or not body.get("title"):
            raise HTTPException(400, f"bad create body {body}")
        iid = state.add_item(body["title"], body["groupId"])
        return item_json(state.items[iid], ["fields"])

    @app.patch(B + "/items/{i}/group")
    async def move(s: int, b: int, i: int, request: Request):
        body = await request.json()
        if set(body) != {"itemGroupId"} or not isinstance(body["itemGroupId"], int):
            raise HTTPException(400, f"bad move body {body}")
        get_item(i)["group"] = body["itemGroupId"]
        return item_json(get_item(i), ["fields"])

    @app.patch(B + "/items/{i}/fields/{key}")
    async def set_field(s: int, b: int, i: int, key: str, request: Request):
        body = await request.json()
        if set(body) != {"value"}:
            raise HTTPException(400, f"bad field body {body}")
        it = get_item(i)
        if key not in it["values"]:
            raise HTTPException(404, "field not found")
        value = body["value"]
        if key == "link-1" and isinstance(value, str):
            value = {"url": value, "displayText": value}
        it["values"][key] = value
        return item_json(it, ["fields"])

    @app.patch(B + "/items/{i}/fields")
    async def set_fields(s: int, b: int, i: int, request: Request):
        body = await request.json()
        it = get_item(i)
        for k, v in body.items():
            it["values"][k] = v
        return item_json(it, ["fields"])

    @app.get(B + "/items/{i}/comments")
    def comments(s: int, b: int, i: int):
        get_item(i)
        return state.comments[i]  # bare array, per spec

    @app.post(B + "/items/{i}/comments")
    async def comment(s: int, b: int, i: int, request: Request):
        body = await request.json()
        if not body.get("text"):
            raise HTTPException(400, "text required")
        c = {"id": next(state.ids), "content": f"<p>{body['text']}</p>", "deleted": False, "createdBy": 7,
             "createdAt": datetime.now(timezone.utc).isoformat()}
        state.comments[get_item(i)["id"]].append(c)
        return c

    @app.get(B + "/items/{i}/files")
    def files(s: int, b: int, i: int):
        get_item(i)
        return state.files[i]  # bare array, per spec (NOT the paged envelope)

    @app.post(B + "/items/{i}/files")
    async def upload(s: int, b: int, i: int, file: UploadFile = File(...)):
        data = await file.read()
        f = {"id": next(state.ids), "name": file.filename, "size": len(data),
             "createdAt": datetime.now(timezone.utc).isoformat()}
        state.files[get_item(i)["id"]].append(f)
        return f

    @app.get(P + "/users")
    def users(request: Request):
        return paged([{"id": 7, "name": "Test Student"}, {"id": 8, "name": "Instructor Kim"}], request)

    @app.get(P + "/users/me")
    def me():
        return {"id": 7, "name": "Test Student"}

    return app, state
