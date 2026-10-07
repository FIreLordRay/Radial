# Radial

A local-first backlog tool that mirrors from, and pushes to, [Plaky](https://plaky.com) —
themed in the same Dark Ember palette as `raybot`'s dashboard.

## What it does

- **Pulls** every space → board → section (Plaky calls these "item groups") → item your
  Plaky API key can see, into Radial's own SQLite database. Automatic, every
  `AUTO_PULL_INTERVAL_SECONDS` (5 minutes by default), plus a manual "Pull from Plaky" button.
- Gives you a **backlog**: create/edit/delete items locally, organized into whichever
  board you pick as your "home board" — the columns you see are that board's *real*
  Plaky sections, not an invented status enum, plus an always-present "Unsorted" bucket.
- **Pushes** a locally-created item into Plaky as a real item, in the section you put it in.
- A **Plaky browser** view to read anything pulled in, and a **sync log** of every pull/push,
  success or failure.

## Using it

Works with or without Plaky. With no API key it's a plain local kanban:

- Columns start as **To do / In progress / Done**. Double-click a column name to rename it,
  hover for the x to delete it (its items drop to Unsorted), or **+ Add section**.
- Type in a column's **+ Add item** box and hit Enter to drop a card straight in.
- **Drag cards** between columns. Click a card to edit it.
- Keys: `N` new item, `/` search, `Esc` close/clear, `Enter` (title) or `Ctrl+Enter` saves.

Once a Plaky home board is set, its real sections replace the local ones (the board picker's
**Use local sections** switches back).

### Plaky (live)

With a key in `.env`, the **Plaky (live)** tab shows your chosen board exactly as Plaky has it,
re-checked every 15 seconds (Plaky has no webhooks; that's ~8 of its 200 requests/minute).
From there you can:

- drag items between columns, or add new ones with a column's **+ Add to Plaky** box
- open an item to edit its fields (status, dates, links, text, tags), hit **Mark done**
  (sets the board's "final" status, or moves it to a Done-style column), upload files,
  and read/post comments

Renaming an item still isn't possible through Plaky's API, so do that in Plaky itself.

## Setup

```bash
cd radial
cp .env.example .env
```

Edit `.env`:
- `PLAKY_API_KEY` — generate one at plaky.com: profile picture → Preferences → Advanced →
  Manage API keys → Generate API key. Leave blank to run with no Plaky connection at all
  (local-only backlog, sync features simply disabled — see `/api/config`).

```bash
pip install -r requirements.txt
python -m app.main       # or: run.cmd on Windows
```

Open `http://localhost:5100`. First thing to do: click **Pull from Plaky**, then set a
**home board** (the sidebar's board picker) — that board's sections become your backlog columns.

## Architecture

Same shape as `ray-chat`/`raybot`: FastAPI + SQLite (`aiosqlite`) + vanilla JS, no build step,
no framework, no ORM. Single-user, meant for `localhost` — there is no session/auth layer,
same trust model as `raybot`'s `dashboard.py`.

```
app/
  config.py        Settings (.env) — Plaky key, base URL, auto-pull interval, DB path
  db.py             SQLite schema + all queries (only file that writes SQL)
  plaky_client.py   Thin async wrapper over Plaky's public REST API
  sync.py           Pull (mirror) / push (create) orchestration between db.py and plaky_client.py
  main.py           FastAPI app, routes, the background auto-pull task
  web/
    templates/index.html
    static/css/app.css   Dark Ember theme, ported verbatim from raybot's dashboard.py
    static/js/app.js     All frontend logic — fetch() + DOM APIs, no innerHTML anywhere
```

### The Plaky integration, and its real limitation

Everything in `plaky_client.py` is written directly against Plaky's own published OpenAPI
spec (verified before writing any of this, not guessed): base URL `https://api.plaky.com`,
auth via an `X-API-Key` header, paths under `/v1/public/...`.

**Update 2026-10-07**: Plaky has since added endpoints to move an item to another group, comment
and upload files, all used by the live view. What follows still applies to the *backlog's*
push. **The original limitation**: Plaky's public API had no endpoint to rename an item or move
it to a different section after creation — only `PATCH .../items/{id}/fields` to change a
custom field's *value*. That's why:

- `push` only ever *creates* a new Plaky item (title + section, set once, at creation).
- An item already linked to Plaky (`item.linked === true`) shows a note instead of a push
  button — there's nothing left Radial can push for it beyond field values, and this app
  doesn't yet build UI for editing arbitrary per-board custom fields.
- If a pushed item has a description and the target board happens to have a plain
  text/rich-text field, Radial opportunistically writes the description into it. If the
  board has no such field, the description just stays local-only — nothing is silently lost,
  it's still visible in Radial's own UI, it just never reaches Plaky.

### Pull vs. push

Pull is a full mirror, not a merge: every pull wholesale-replaces the cached
spaces/boards/sections/items with whatever Plaky returns *right now* (see
`Database.replace_plaky_cache`). It never touches your local backlog. Push is one item at a
time, always explicit — there is no automatic/background push anywhere, only automatic pull.

## Security notes

No auth, no session — anyone who can reach this process's port can read/write your backlog
and trigger pulls/pushes using the server's Plaky key. Keep `HOST=127.0.0.1` (the default)
unless you specifically want this reachable from your LAN, and understand that means anyone
on that network could use your Plaky API key through this app if you widen it — same
trade-off as `raybot`'s `dashboard.py`, see that repo's README for the fuller version of this
argument.

The Plaky API key lives only in `.env` and this process's memory — it is never sent to the
browser, never logged, and every outbound Plaky call happens server-side.
