"""Local backlog and sections: the part of Radial that works with no Plaky at all."""


def section_ids(c):
    return [s["id"] for s in c.get("/api/sections").json()["sections"]]


def test_fresh_install_has_default_local_sections(local_client):
    body = local_client.get("/api/sections").json()
    assert body["source"] == "local"
    assert [s["title"] for s in body["sections"]] == ["To do", "In progress", "Done"]
    assert all(s["id"].startswith("local-") for s in body["sections"])


def test_config_reports_local_only(local_client):
    assert local_client.get("/api/config").json()["plaky_configured"] is False


def test_create_edit_delete_item(local_client):
    todo = section_ids(local_client)[0]
    created = local_client.post("/api/backlog", json={"title": "Write README", "group_id": todo})
    assert created.status_code == 201
    item = created.json()
    assert item["group_id"] == todo and item["priority"] == "medium" and item["linked"] is False

    edited = local_client.patch(f"/api/backlog/{item['id']}", json={"title": "Write README v2", "priority": "high"})
    assert edited.status_code == 200
    assert edited.json()["title"] == "Write README v2"
    # PATCH that never mentions group_id must not drop the item to Unsorted
    assert edited.json()["group_id"] == todo

    assert local_client.delete(f"/api/backlog/{item['id']}").status_code == 204
    assert local_client.get("/api/backlog").json() == []


def test_move_item_between_sections(local_client):
    todo, doing, _ = section_ids(local_client)
    item = local_client.post("/api/backlog", json={"title": "x", "group_id": todo}).json()
    moved = local_client.patch(f"/api/backlog/{item['id']}", json={"group_id": doing}).json()
    assert moved["group_id"] == doing
    unsorted = local_client.patch(f"/api/backlog/{item['id']}", json={"group_id": None}).json()
    assert unsorted["group_id"] is None


def test_validation_rejects_bad_input(local_client):
    assert local_client.post("/api/backlog", json={"title": ""}).status_code == 422
    assert local_client.post("/api/backlog", json={"title": "x", "priority": "urgent"}).status_code == 422
    assert local_client.post("/api/backlog", json={"title": "x" * 256}).status_code == 422
    assert local_client.patch("/api/backlog/nope", json={"title": "y"}).status_code == 404
    assert local_client.delete("/api/backlog/nope").status_code == 404


def test_section_add_rename_delete(local_client):
    added = local_client.post("/api/sections", json={"title": "Blocked"})
    assert added.status_code == 201
    sid = added.json()["id"]
    assert local_client.patch(f"/api/sections/{sid}", json={"title": "Waiting"}).status_code == 200
    titles = [s["title"] for s in local_client.get("/api/sections").json()["sections"]]
    assert titles[-1] == "Waiting"

    item = local_client.post("/api/backlog", json={"title": "stuck", "group_id": sid}).json()
    assert local_client.delete(f"/api/sections/{sid}").status_code == 204
    # deleting a column never deletes its items; they fall back to Unsorted
    assert local_client.get("/api/backlog").json()[0]["id"] == item["id"]
    assert local_client.get("/api/backlog").json()[0]["group_id"] is None


def test_push_needs_plaky(local_client):
    item = local_client.post("/api/backlog", json={"title": "x"}).json()
    assert local_client.post(f"/api/backlog/{item['id']}/push").status_code == 409


def test_static_assets_always_revalidate(local_client):
    r = local_client.get("/static/js/app.js")
    assert r.status_code == 200
    assert r.headers["cache-control"] == "no-cache"


def test_index_renders(local_client):
    r = local_client.get("/")
    assert r.status_code == 200 and "Radial" in r.text
