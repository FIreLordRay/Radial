"""Plaky integration against the strict fake: pull, home board, push, and the live view."""

import httpx
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import _settings
from tests.fake_plaky import make_fake_plaky

# ---------------------------------------------------------------- pull + home board


def test_pull_mirrors_everything(client):
    r = client.post("/api/sync/pull")
    assert r.status_code == 200
    assert r.json()["counts"] == {"spaces": 1, "boards": 1, "groups": 3, "items": 4}
    log = client.get("/api/sync/log").json()
    assert log[0]["direction"] == "pull" and log[0]["ok"] is True


def test_pull_walks_every_page(tmp_path):
    fake_app, state = make_fake_plaky(n_filler=120)  # 124 items -> 3 pages at 50
    app = create_app(_settings(tmp_path), plaky_transport=httpx.ASGITransport(app=fake_app))
    with TestClient(app) as c:
        assert c.post("/api/sync/pull").json()["counts"]["items"] == 124
    item_pages = [q for m, q in state.requests if "/items?" in q]
    assert any("page=3" in q for q in item_pages)
    assert all("pageSize=50" in q for q in item_pages)  # documented default, never a guessed max


def test_bad_key_is_reported_not_crashed(tmp_path):
    fake_app, _ = make_fake_plaky()
    app = create_app(_settings(tmp_path, key="wrong"), plaky_transport=httpx.ASGITransport(app=fake_app))
    with TestClient(app) as c:
        r = c.post("/api/sync/pull")
        assert r.status_code == 401
        assert "rejected the API key" in r.json()["error"]


def test_home_board_switches_sections_to_plaky_groups(client):
    client.post("/api/sync/pull")
    local_todo = client.get("/api/sections").json()["sections"][0]["id"]
    item = client.post("/api/backlog", json={"title": "x", "group_id": local_todo}).json()

    client.post("/api/settings/home-board", json={"space_id": "1", "board_id": "2"})
    body = client.get("/api/sections").json()
    assert body["source"] == "plaky"
    assert {s["title"] for s in body["sections"]} == {"Orientation", "Week 1", "Done"}
    # local section ids mean nothing to Plaky, so they're cleared on the switch
    assert client.get("/api/backlog").json()[0]["group_id"] is None

    # sections are Plaky's now; Radial refuses to edit them locally
    assert client.post("/api/sections", json={"title": "nope"}).status_code == 409

    # and back to local
    assert client.delete("/api/settings/home-board").status_code == 200
    assert client.get("/api/sections").json()["source"] == "local"
    assert client.get("/api/backlog").json()[0]["id"] == item["id"]


def test_push_creates_plaky_item_in_the_right_group(live_client, plaky_state):
    week1 = next(s["id"] for s in live_client.get("/api/sections").json()["sections"] if s["title"] == "Week 1")
    item = live_client.post(
        "/api/backlog", json={"title": "Pushed task", "group_id": week1, "description": "notes here"}
    ).json()
    r = live_client.post(f"/api/backlog/{item['id']}/push")
    assert r.status_code == 200 and r.json()["linked"] is True
    created = next(i for i in plaky_state.items.values() if i["title"] == "Pushed task")
    assert created["group"] == int(week1)
    assert created["values"]["text-1"] == "notes here"  # description lands in the rich-text field
    # pushing twice is refused rather than duplicating
    assert live_client.post(f"/api/backlog/{item['id']}/push").status_code == 400


def test_push_refuses_items_in_local_sections(client):
    local_todo = client.get("/api/sections").json()["sections"][0]["id"]
    item = client.post("/api/backlog", json={"title": "x", "group_id": local_todo}).json()
    r = client.post(f"/api/backlog/{item['id']}/push")
    assert r.status_code == 400 and "local section" in r.json()["detail"]


# ---------------------------------------------------------------- live view


def test_live_board_requires_home_board(client):
    assert client.get("/api/live/board").status_code == 409


def test_live_board_shape(live_client):
    data = live_client.get("/api/live/board").json()
    assert data["board"]["title"] == "Assignments"
    assert [g["title"] for g in data["groups"]] == ["Orientation", "Week 1", "Done"]  # sorted by ranking
    titles = {i["title"] for i in data["items"]}
    assert "Old archived thing" not in titles  # archived items are hidden
    assert len(data["items"]) == 3
    sql = next(i for i in data["items"] if i["title"] == "SQL joins worksheet")
    status = next(f for f in sql["fields"] if f["type"] == "STATUS")
    assert status["value"]["key"] == "s2"  # real Plaky's object form passes through intact
    assert data["people"]["7"] == "Test Student" and data["me"] == "7"
    final = [v for f in data["fields"] if f["type"] == "STATUS" for v in f["configuration"]["values"] if v["isFinal"]]
    assert final[0]["title"] == "Submitted"  # what powers "Mark done"


def _item_id(state, title):
    return str(next(i["id"] for i in state.items.values() if i["title"] == title))


def test_live_move_sends_integer_group(live_client, plaky_state):
    iid = _item_id(plaky_state, "Python OOP project")
    assert live_client.patch(f"/api/live/items/{iid}/group", json={"group_id": "13"}).status_code == 200
    assert plaky_state.items[int(iid)]["group"] == 13


def test_live_field_updates(live_client, plaky_state):
    iid = _item_id(plaky_state, "Python OOP project")
    assert live_client.patch(f"/api/live/items/{iid}/fields/status-1", json={"value": "s3"}).status_code == 200
    assert live_client.patch(
        f"/api/live/items/{iid}/fields/link-1", json={"value": "https://github.com/x/y"}
    ).status_code == 200
    vals = plaky_state.items[int(iid)]["values"]
    assert vals["status-1"] == "s3"
    assert vals["link-1"]["url"] == "https://github.com/x/y"
    assert live_client.patch(f"/api/live/items/{iid}/fields/nope-9", json={"value": 1}).status_code == 404


def test_live_create(live_client, plaky_state):
    r = live_client.post("/api/live/items", json={"title": "From Radial", "group_id": "10"})
    assert r.status_code == 201
    assert plaky_state.items[int(r.json()["id"])]["group"] == 10


def test_comment_and_upload_show_in_activity(live_client, plaky_state):
    iid = _item_id(plaky_state, "SQL joins worksheet")
    assert live_client.post(f"/api/live/items/{iid}/comments", json={"text": "Turned in"}).status_code == 201
    up = live_client.post(f"/api/live/items/{iid}/files", files={"file": ("joins.sql", b"SELECT 1;", "text/plain")})
    assert up.status_code == 201

    act = live_client.get(f"/api/live/items/{iid}/activity").json()
    # regression: files come back as a bare array; reading it as a paged
    # envelope used to make this list silently empty
    assert [f["name"] for f in act["files"]] == ["joins.sql"]
    assert act["files"][0]["size"] == 9
    assert act["comments"][-1]["mine"] is True
    assert act["comments"][-1]["author"] == "Test Student"


def test_empty_comment_rejected(live_client, plaky_state):
    iid = _item_id(plaky_state, "SQL joins worksheet")
    assert live_client.post(f"/api/live/items/{iid}/comments", json={"text": ""}).status_code == 422


def test_writes_are_logged(live_client, plaky_state):
    iid = _item_id(plaky_state, "Python OOP project")
    live_client.patch(f"/api/live/items/{iid}/group", json={"group_id": "13"})
    log = live_client.get("/api/sync/log").json()
    assert log[0]["direction"] == "push" and log[0]["target"] == f"plaky:{iid}"
