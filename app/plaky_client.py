"""Thin async client over Plaky's public REST API (https://docs.plaky.com/).

Verified directly against Plaky's published OpenAPI spec (embedded in
docs.plaky.com, re-checked 2026-10-07): base URL, auth header, path shapes,
pagination envelope. Plaky has since added PATCH .../items/{id}/group (move
to another group), comments and file uploads; there is still NO endpoint to
rename an item after creation, and no webhooks (so "live" means polling;
the rate limit is 200 requests/user/minute).

Auth: header ``X-API-Key: <key>``. Every request in this file carries it;
there is no other credential and no cookie/session involved.
"""

from __future__ import annotations

from typing import Any, Final

import httpx

__all__ = ["PlakyClient", "PlakyApiError"]

_API_PREFIX: Final[str] = "/v1/public"
# Plaky's documented default; the spec publishes no maximum, so don't guess a bigger one.
_PAGE_SIZE: Final[int] = 50
_MAX_PAGES: Final[int] = 50  # hard stop so a pagination bug can't loop forever


class PlakyApiError(Exception):
    """A non-2xx response from Plaky, or a transport failure. Message is safe to show/log."""

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


class PlakyClient:
    def __init__(self, *, api_key: str, base_url: str = "https://api.plaky.com", timeout_s: float = 15.0) -> None:
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            headers={"X-API-Key": api_key, "Accept": "application/json"},
            timeout=timeout_s,
            trust_env=False,
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "PlakyClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    # ------------------------------------------------------------------ core request

    async def _request(self, method: str, path: str, **kwargs: Any) -> dict[str, Any]:
        try:
            response = await self._client.request(method, f"{_API_PREFIX}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise PlakyApiError(f"Could not reach Plaky: {exc}") from exc

        if response.status_code == 401 or response.status_code == 403:
            raise PlakyApiError("Plaky rejected the API key.", status=response.status_code)
        if response.status_code == 429:
            raise PlakyApiError("Plaky is rate-limiting requests. Try again shortly.", status=429)
        if response.status_code >= 400:
            detail = response.text[:300]
            raise PlakyApiError(f"Plaky returned {response.status_code}: {detail}", status=response.status_code)

        if response.status_code == 204 or not response.content:
            return {}
        try:
            data = response.json()
        except ValueError as exc:
            raise PlakyApiError("Plaky returned an unreadable response.") from exc
        return data if isinstance(data, dict) else {}

    async def _request_list(self, method: str, path: str, **kwargs: Any) -> list[dict[str, Any]]:
        """Like _request, for endpoints whose body is a JSON array (or a paged envelope)."""
        try:
            response = await self._client.request(method, f"{_API_PREFIX}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise PlakyApiError(f"Could not reach Plaky: {exc}") from exc
        if response.status_code >= 400:
            raise PlakyApiError(f"Plaky returned {response.status_code}: {response.text[:300]}", status=response.status_code)
        try:
            data = response.json()
        except ValueError as exc:
            raise PlakyApiError("Plaky returned an unreadable response.") from exc
        if isinstance(data, dict):
            data = data.get("data", [])
        return [d for d in data if isinstance(d, dict)] if isinstance(data, list) else []

    async def _paginated(self, path: str) -> list[dict[str, Any]]:
        """Walk every page of a Plaky list endpoint (page/pageSize, data/hasMore envelope)."""
        results: list[dict[str, Any]] = []
        page = 1
        for _ in range(_MAX_PAGES):
            data = await self._request("GET", path, params={"page": page, "pageSize": _PAGE_SIZE})
            batch = data.get("data")
            if isinstance(batch, list):
                results.extend(item for item in batch if isinstance(item, dict))
            if not data.get("hasMore"):
                break
            page += 1
        return results

    # ------------------------------------------------------------------ reads

    async def list_spaces(self) -> list[dict[str, Any]]:
        return await self._paginated("/spaces")

    async def list_boards(self, space_id: str) -> list[dict[str, Any]]:
        return await self._paginated(f"/spaces/{space_id}/boards")

    async def list_item_groups(self, space_id: str, board_id: str) -> list[dict[str, Any]]:
        return await self._paginated(f"/spaces/{space_id}/boards/{board_id}/item-groups")

    async def list_items(self, space_id: str, board_id: str) -> list[dict[str, Any]]:
        return await self._paginated(f"/spaces/{space_id}/boards/{board_id}/items")

    async def get_item(self, space_id: str, board_id: str, item_id: str) -> dict[str, Any]:
        return await self._request(
            "GET", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}", params={"expand": "fields"}
        )

    async def get_board(self, space_id: str, board_id: str) -> dict[str, Any]:
        """BoardResponse: includes `fields` (ItemAttributeDefinition, with status
        labels + `isFinal` under `configuration.values`) and `groups`."""
        return await self._request("GET", f"/spaces/{space_id}/boards/{board_id}")

    async def list_items_with_fields(self, space_id: str, board_id: str) -> list[dict[str, Any]]:
        """Items with field values. Without expand=fields Plaky omits them;
        sub-items are excluded so they don't show up as top-level cards."""
        results: list[dict[str, Any]] = []
        page = 1
        for _ in range(_MAX_PAGES):
            data = await self._request(
                "GET",
                f"/spaces/{space_id}/boards/{board_id}/items",
                params={"page": page, "pageSize": _PAGE_SIZE, "expand": "fields", "subitemsBehaviour": "EXCLUDE"},
            )
            batch = data.get("data")
            if isinstance(batch, list):
                results.extend(item for item in batch if isinstance(item, dict))
            if not data.get("hasMore"):
                break
            page += 1
        return results

    async def list_users(self) -> list[dict[str, Any]]:
        return await self._paginated("/users")

    async def get_me(self) -> dict[str, Any]:
        return await self._request("GET", "/users/me")

    async def list_comments(self, space_id: str, board_id: str, item_id: str) -> list[dict[str, Any]]:
        # Unlike the list endpoints above, this one returns a bare JSON array.
        return await self._request_list("GET", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/comments")

    async def list_files(self, space_id: str, board_id: str, item_id: str) -> list[dict[str, Any]]:
        # Also a bare array, not the paged envelope (per the spec's response schema).
        return await self._request_list("GET", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/files")

    # ------------------------------------------------------------------ writes

    async def create_item(
        self, *, space_id: str, board_id: str, title: str, group_id: str, fields: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """POST .../items -- ItemCreateRequest's group field is `groupId` (an
        integer), NOT `group` (that name only exists on the *response* shape,
        for reading back which group an item landed in). Confirmed against
        Plaky's OpenAPI spec after finding this exact mismatch in review:
        the wrong key wouldn't error, Plaky just silently drops new items
        into the board's first group instead of the one actually chosen.
        """
        body: dict[str, Any] = {"title": title, "groupId": int(group_id)}
        if fields:
            body["fields"] = fields
        return await self._request("POST", f"/spaces/{space_id}/boards/{board_id}/items", json=body)

    async def update_item_fields(
        self, *, space_id: str, board_id: str, item_id: str, fields: dict[str, Any]
    ) -> dict[str, Any]:
        """PATCH .../items/{id}/fields -- the ONLY write path once an item exists.

        `fields` is keyed by field key or field title (Plaky accepts either),
        value shape depends on field type -- see Plaky's own docs for the
        full type table. There is no API path to rename an item or move it
        to a different group after creation.
        """
        return await self._request(
            "PATCH", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/fields", json=fields
        )

    async def update_item_field(
        self, *, space_id: str, board_id: str, item_id: str, field_key: str, value: Any
    ) -> dict[str, Any]:
        """PATCH .../fields/{key}, body FieldValueChangeRequest {value}. Value shape
        per type: STATUS label key or title, TAG list of keys, LINK url string or
        {url, displayText}, DATE_TIME ISO string, NUMBER number, STRING/RICH_TEXT text."""
        return await self._request(
            "PATCH",
            f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/fields/{field_key}",
            json={"value": value},
        )

    async def move_item_to_group(self, *, space_id: str, board_id: str, item_id: str, group_id: str) -> dict[str, Any]:
        """PATCH .../items/{id}/group, body ItemMoveToGroupRequest {itemGroupId}."""
        return await self._request(
            "PATCH",
            f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/group",
            json={"itemGroupId": int(group_id)},
        )

    async def create_comment(self, *, space_id: str, board_id: str, item_id: str, text: str) -> dict[str, Any]:
        """POST .../comments, body CommentRequest {text}."""
        return await self._request(
            "POST", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/comments", json={"text": text}
        )

    async def upload_file(
        self, *, space_id: str, board_id: str, item_id: str, filename: str, content: bytes, content_type: str
    ) -> dict[str, Any]:
        """POST .../files as multipart/form-data with a single `file` part."""
        return await self._request(
            "POST",
            f"/spaces/{space_id}/boards/{board_id}/items/{item_id}/files",
            files={"file": (filename, content, content_type or "application/octet-stream")},
        )

    async def delete_item(self, space_id: str, board_id: str, item_id: str) -> None:
        await self._request("DELETE", f"/spaces/{space_id}/boards/{board_id}/items/{item_id}")
