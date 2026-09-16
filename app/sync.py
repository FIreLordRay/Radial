"""Pull/push orchestration between Radial's local DB and Plaky.

Pull is a full mirror: every space -> every board -> every group + every
item, replacing the local cache wholesale (see Database.replace_plaky_cache).
Push is one item at a time, explicit, user-triggered -- there is no
background/automatic push anywhere in this file, matching the "never a
silent write" stance carried over from ray-chat/raybot.

Field-name note: Plaky's raw JSON uses `title` (not `name`) for every
display name, and bare integer ids in `space`/`board`/`group` for an item's
parents (confirmed against Plaky's own OpenAPI spec, not assumed) -- the
normalisation into Radial's own column names happens entirely in this file
so db.py and plaky_client.py can each stay agnostic of the other's shape.
"""

from __future__ import annotations

from typing import Any

from app.db import Database
from app.plaky_client import PlakyApiError, PlakyClient

__all__ = ["pull_all", "push_backlog_item", "get_home_board", "set_home_board"]


async def pull_all(db: Database, client: PlakyClient) -> dict[str, int]:
    """Fetch every space/board/group/item Plaky will show this API key.

    Returns counts for the caller to report; logs one sync_log row summarising
    the whole pull (success or the first failure) rather than one per call --
    a partial pull still commits nothing (replace_plaky_cache is all-or-nothing)
    so a mid-pull failure leaves the previous cache intact.
    """
    spaces_raw = await client.list_spaces()
    spaces = [{"id": s["id"], "name": s.get("title") or ""} for s in spaces_raw]

    boards: list[dict[str, Any]] = []
    groups: list[dict[str, Any]] = []
    items: list[dict[str, Any]] = []

    for space in spaces_raw:
        space_id = str(space["id"])
        boards_raw = await client.list_boards(space_id)
        for b in boards_raw:
            boards.append({"id": b["id"], "space_id": space_id, "name": b.get("title") or ""})

        for b in boards_raw:
            board_id = str(b["id"])
            groups_raw = await client.list_item_groups(space_id, board_id)
            for position, g in enumerate(groups_raw):
                groups.append(
                    {"id": g["id"], "board_id": board_id, "title": g.get("title") or "", "position": position}
                )

            items_raw = await client.list_items(space_id, board_id)
            for it in items_raw:
                group_val = it.get("group")
                items.append(
                    {
                        "id": it["id"],
                        "space_id": space_id,
                        "board_id": board_id,
                        "group_id": None if group_val is None else group_val,
                        "title": it.get("title") or "",
                        "fields": it.get("fields") or [],
                    }
                )

    await db.replace_plaky_cache(spaces=spaces, boards=boards, groups=groups, items=items)
    counts = {"spaces": len(spaces), "boards": len(boards), "groups": len(groups), "items": len(items)}
    await db.log_sync(
        direction="pull",
        target="all",
        ok=True,
        detail=f"{counts['spaces']} spaces, {counts['boards']} boards, {counts['items']} items",
    )
    return counts


async def get_home_board(db: Database) -> dict[str, str] | None:
    space_id = await db.get_setting("home_space_id")
    board_id = await db.get_setting("home_board_id")
    if not space_id or not board_id:
        return None
    return {"space_id": space_id, "board_id": board_id}


async def set_home_board(db: Database, *, space_id: str, board_id: str) -> None:
    """Set the home board, resetting every item's section if it actually changed.

    A group_id only means anything relative to the CURRENT home board (it's
    one of that board's real Plaky group ids); re-pointing home board to a
    different board without this would leave existing items referencing a
    section id that belongs to a different board entirely -- silently
    correct-looking until someone pushes and it lands (or fails to land) in
    the wrong place. Picking the *same* board again is a no-op, not a reset.
    """
    previous = await get_home_board(db)
    changed = previous is not None and (previous["space_id"] != space_id or previous["board_id"] != board_id)

    await db.set_setting("home_space_id", space_id)
    await db.set_setting("home_board_id", board_id)

    if changed:
        await db.clear_all_backlog_groups()


async def push_backlog_item(db: Database, client: PlakyClient, *, item_id: str) -> None:
    """Create one local backlog item in Plaky, into its assigned section, and link it.

    The item's `group_id` IS a real Plaky group id -- it was assigned from
    the home board's own sections (see get_home_board / app.main's group
    listing), so there is nothing left to ask the caller here; this reads
    the home board setting purely to recover the space/board ids Plaky's
    create-item endpoint requires alongside the group.

    Title-only at create time -- Plaky's API has no endpoint to rename an
    item afterward, only to change field VALUES (see plaky_client.py). If the
    created item comes back with a plain string/rich-text field, the local
    description is opportunistically written into the first one; if no such
    field exists on that board, the description simply stays local-only and
    nothing is silently lost -- it is still shown in Radial's own UI.
    """
    item = await db.get_backlog_item(item_id)
    if item is None:
        raise ValueError("backlog item not found")
    if item.linked:
        raise ValueError("this item is already linked to a Plaky item")
    if not item.group_id:
        raise ValueError("assign this item to a section before pushing")

    home = await get_home_board(db)
    if home is None:
        raise ValueError("set a home board before pushing")
    space_id, board_id = home["space_id"], home["board_id"]

    try:
        created = await client.create_item(
            space_id=space_id, board_id=board_id, title=item.title, group_id=item.group_id
        )
        plaky_item_id = str(created["id"])

        if item.description.strip():
            text_field_key = next(
                (
                    f["key"]
                    for f in created.get("fields") or []
                    if isinstance(f, dict) and f.get("type") in ("STRING", "RICH_TEXT")
                ),
                None,
            )
            if text_field_key:
                await client.update_item_fields(
                    space_id=space_id,
                    board_id=board_id,
                    item_id=plaky_item_id,
                    fields={text_field_key: item.description},
                )
    except PlakyApiError as exc:
        await db.log_sync(direction="push", target=f"item:{item_id}", ok=False, detail=str(exc))
        raise

    await db.mark_backlog_item_pushed(item_id, plaky_item_id=plaky_item_id)
    await db.log_sync(direction="push", target=f"item:{item_id}", ok=True, detail=f"created plaky item {plaky_item_id}")
