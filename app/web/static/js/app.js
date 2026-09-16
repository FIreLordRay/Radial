// Radial — frontend. No build step, no framework: fetch() + DOM APIs only.
// Every dynamic string goes through textContent, never innerHTML — habit
// carried over from ray-chat, worth keeping even though this app has no
// externally-sourced/untrusted content of its own.
//
// Sections are NOT a fixed enum: the board's columns are whatever groups the
// configured "home board" actually has in Plaky (see app/sync.py). An item
// with group_id === null always renders in the "Unsorted" bucket, which
// exists regardless of whether a home board is set at all.

const state = {
  view: "board",
  items: [],
  groups: [], // [{id, title}], the home board's real Plaky sections
  homeBoard: null, // {space_id, board_id} | null
  editingId: null, // null while creating a new item
};

const el = {};

function cacheElements() {
  el.navItems = [...document.querySelectorAll(".nav-item")];
  el.sidebar = document.getElementById("sidebar");
  el.sidebarScrim = document.getElementById("sidebar-scrim");
  el.drawerToggle = document.getElementById("drawer-toggle");
  el.viewTitle = document.getElementById("view-title");
  el.views = {
    board: document.getElementById("view-board"),
    plaky: document.getElementById("view-plaky"),
    log: document.getElementById("view-log"),
  };
  el.boardColumns = document.getElementById("board-columns");
  el.plakySpaceSelect = document.getElementById("plaky-space-select");
  el.plakyBoardSelect = document.getElementById("plaky-board-select");
  el.plakyItemList = document.getElementById("plaky-item-list");
  el.syncLogList = document.getElementById("sync-log-list");
  el.plakyStatus = document.getElementById("plaky-status");
  el.pullButton = document.getElementById("pull-button");
  el.autoPullHint = document.getElementById("auto-pull-hint");
  el.newItemButton = document.getElementById("new-item-button");
  el.boardPickerButton = document.getElementById("board-picker-button");
  el.boardPickerLabel = document.getElementById("board-picker-label");

  el.modalScrim = document.getElementById("modal-scrim");
  el.modalTitle = document.getElementById("modal-title");
  el.modalClose = document.getElementById("modal-close");
  el.fieldTitle = document.getElementById("field-title");
  el.fieldDescription = document.getElementById("field-description");
  el.fieldPriority = document.getElementById("field-priority");
  el.fieldGroup = document.getElementById("field-group");
  el.pushSection = document.getElementById("push-section");
  el.pushLinkedNote = document.getElementById("push-linked-note");
  el.pushButton = document.getElementById("push-button");
  el.saveButton = document.getElementById("save-button");
  el.deleteButton = document.getElementById("delete-button");

  el.boardModalScrim = document.getElementById("board-modal-scrim");
  el.boardModalClose = document.getElementById("board-modal-close");
  el.boardModalSpace = document.getElementById("board-modal-space");
  el.boardModalBoard = document.getElementById("board-modal-board");
  el.boardModalSave = document.getElementById("board-modal-save");
  el.boardModalWarning = document.getElementById("board-modal-warning");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    let detail = `${response.status}`;
    try {
      const body = await response.json();
      detail = body.detail || body.error || detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

/* ------------------------------------------------------------------ views */

function switchView(view) {
  state.view = view;
  el.navItems.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === view));
  Object.entries(el.views).forEach(([key, node]) => {
    node.hidden = key !== view;
  });
  el.viewTitle.textContent = { board: "Backlog", plaky: "Plaky", log: "Sync log" }[view];
  if (view === "plaky") loadPlakyBrowser();
  if (view === "log") loadSyncLog();
  closeDrawer();
}

function openDrawer() {
  el.sidebar.classList.add("is-open");
  el.sidebarScrim.hidden = false;
  el.sidebarScrim.classList.add("is-visible");
}

function closeDrawer() {
  el.sidebar.classList.remove("is-open");
  el.sidebarScrim.classList.remove("is-visible");
  el.sidebarScrim.hidden = true;
}

/* ------------------------------------------------------------------ home board + sections */

async function loadHomeBoard() {
  const res = await api("/api/settings/home-board");
  state.homeBoard = res.home;
  if (state.homeBoard) {
    state.groups = await api(`/api/plaky/groups?board_id=${encodeURIComponent(state.homeBoard.board_id)}`);
    const boards = await api(`/api/plaky/boards?space_id=${encodeURIComponent(state.homeBoard.space_id)}`);
    const board = boards.find((b) => b.id === state.homeBoard.board_id);
    el.boardPickerLabel.textContent = board ? board.name : `Board ${state.homeBoard.board_id}`;
  } else {
    state.groups = [];
    el.boardPickerLabel.textContent = "No board set";
  }
  populateGroupSelect();
}

function populateGroupSelect() {
  el.fieldGroup.replaceChildren(new Option("Unsorted", ""));
  for (const g of state.groups) el.fieldGroup.appendChild(new Option(g.title, g.id));
}

async function openBoardModal() {
  el.boardModalScrim.hidden = false;
  el.boardModalSpace.replaceChildren(new Option("Select…", ""));
  el.boardModalBoard.replaceChildren(new Option("Select…", ""));
  el.boardModalBoard.disabled = true;
  el.boardModalSave.disabled = true;
  el.boardModalWarning.hidden = true;

  const spaces = await api("/api/plaky/spaces");
  if (spaces.length === 0) {
    el.boardModalSpace.replaceChildren(new Option("Pull from Plaky first…", ""));
    return;
  }
  for (const s of spaces) el.boardModalSpace.appendChild(new Option(s.name, s.id));
  if (state.homeBoard) el.boardModalSpace.value = state.homeBoard.space_id;
  if (el.boardModalSpace.value) await onBoardModalSpaceChange();
}

function closeBoardModal() {
  el.boardModalScrim.hidden = true;
}

function isChangingBoard() {
  if (!state.homeBoard) return false; // first-time set, nothing to lose
  return (
    state.homeBoard.space_id !== el.boardModalSpace.value || state.homeBoard.board_id !== el.boardModalBoard.value
  );
}

function updateBoardModalWarning() {
  el.boardModalWarning.hidden = !(el.boardModalBoard.value && isChangingBoard());
}

async function onBoardModalSpaceChange() {
  const spaceId = el.boardModalSpace.value;
  el.boardModalBoard.replaceChildren(new Option("Select…", ""));
  el.boardModalBoard.disabled = !spaceId;
  el.boardModalSave.disabled = true;
  if (!spaceId) {
    updateBoardModalWarning();
    return;
  }
  const boards = await api(`/api/plaky/boards?space_id=${encodeURIComponent(spaceId)}`);
  for (const b of boards) el.boardModalBoard.appendChild(new Option(b.name, b.id));
  if (state.homeBoard && state.homeBoard.space_id === spaceId) {
    el.boardModalBoard.value = state.homeBoard.board_id;
  }
  el.boardModalSave.disabled = !el.boardModalBoard.value;
  updateBoardModalWarning();
}

async function onBoardModalSave() {
  if (isChangingBoard()) {
    const ok = confirm(
      "Switching your home board moves every sectioned item back to Unsorted. Continue?"
    );
    if (!ok) return;
  }
  await api("/api/settings/home-board", {
    method: "POST",
    body: JSON.stringify({ space_id: el.boardModalSpace.value, board_id: el.boardModalBoard.value }),
  });
  closeBoardModal();
  await loadHomeBoard();
  await loadBacklog();
}

/* ------------------------------------------------------------------ board */

async function loadBacklog() {
  state.items = await api("/api/backlog");
  renderBoard();
}

function renderBoard() {
  el.boardColumns.replaceChildren();
  const columns = [{ id: "", title: "Unsorted" }, ...state.groups.map((g) => ({ id: g.id, title: g.title }))];

  for (const { id, title } of columns) {
    const col = document.createElement("div");
    col.className = "board-col";

    const head = document.createElement("div");
    head.className = "board-col__head";
    const headLabel = document.createElement("span");
    headLabel.textContent = title;
    const items = state.items.filter((i) => (i.group_id || "") === id);
    const count = document.createElement("span");
    count.className = "board-col__count";
    count.textContent = String(items.length);
    head.append(headLabel, count);
    col.appendChild(head);

    if (items.length === 0) {
      const hint = document.createElement("div");
      hint.className = "empty-hint";
      hint.textContent = "Nothing here.";
      col.appendChild(hint);
    }
    for (const item of items) col.appendChild(buildCard(item));
    el.boardColumns.appendChild(col);
  }
}

function buildCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.addEventListener("click", () => openModal(item));

  const title = document.createElement("div");
  title.className = "card__title";
  title.textContent = item.title;
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card__meta";
  const dot = document.createElement("span");
  dot.className = "card__priority";
  dot.dataset.p = item.priority;
  meta.appendChild(dot);
  const priorityLabel = document.createElement("span");
  priorityLabel.textContent = item.priority;
  meta.appendChild(priorityLabel);
  if (item.linked) {
    const linked = document.createElement("span");
    linked.className = "card__linked";
    linked.textContent = "→ Plaky";
    meta.appendChild(linked);
  }
  card.appendChild(meta);
  return card;
}

/* ------------------------------------------------------------------ modal */

function openModal(item) {
  state.editingId = item ? item.id : null;
  el.modalTitle.textContent = item ? "Edit item" : "New item";
  el.fieldTitle.value = item ? item.title : "";
  el.fieldDescription.value = item ? item.description : "";
  el.fieldPriority.value = item ? item.priority : "medium";
  el.fieldGroup.value = item ? item.group_id || "" : "";
  el.deleteButton.hidden = !item;

  el.pushSection.hidden = !item;
  if (item) {
    if (item.linked) {
      el.pushLinkedNote.hidden = false;
      el.pushLinkedNote.textContent = `Linked to Plaky item ${item.plaky_item_id}. Title can't be re-synced (Plaky has no rename endpoint) — only future field pushes will apply.`;
      el.pushButton.hidden = true;
    } else {
      el.pushLinkedNote.hidden = true;
      el.pushButton.hidden = false;
      el.pushButton.disabled = false;
      el.pushButton.textContent = "Push to Plaky";
    }
  }

  el.modalScrim.hidden = false;
  el.fieldTitle.focus();
}

function closeModal() {
  el.modalScrim.hidden = true;
  state.editingId = null;
}

async function onSave() {
  const payload = {
    title: el.fieldTitle.value.trim(),
    description: el.fieldDescription.value,
    priority: el.fieldPriority.value,
    group_id: el.fieldGroup.value || null,
  };
  if (!payload.title) {
    el.fieldTitle.focus();
    return;
  }
  if (state.editingId) {
    await api(`/api/backlog/${state.editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
  } else {
    await api("/api/backlog", { method: "POST", body: JSON.stringify(payload) });
  }
  closeModal();
  await loadBacklog();
}

async function onDelete() {
  if (!state.editingId) return;
  await api(`/api/backlog/${state.editingId}`, { method: "DELETE" });
  closeModal();
  await loadBacklog();
}

async function onPush() {
  if (!state.editingId) return;
  el.pushButton.disabled = true;
  el.pushButton.textContent = "Pushing…";
  try {
    await api(`/api/backlog/${state.editingId}/push`, { method: "POST" });
    closeModal();
    await loadBacklog();
  } catch (err) {
    el.pushLinkedNote.hidden = false;
    el.pushLinkedNote.textContent = `Push failed: ${err.message}`;
    el.pushButton.disabled = false;
    el.pushButton.textContent = "Push to Plaky";
  }
}

/* ------------------------------------------------------------------ plaky browser */

async function loadPlakyBrowser() {
  const spaces = await api("/api/plaky/spaces");
  el.plakySpaceSelect.replaceChildren(new Option("All spaces…", ""));
  for (const s of spaces) el.plakySpaceSelect.appendChild(new Option(s.name, s.id));
  el.plakyBoardSelect.replaceChildren(new Option("All boards…", ""));
  el.plakyBoardSelect.disabled = true;
  await renderPlakyItems();
}

async function onPlakySpaceChange() {
  const spaceId = el.plakySpaceSelect.value;
  el.plakyBoardSelect.replaceChildren(new Option("All boards…", ""));
  el.plakyBoardSelect.disabled = !spaceId;
  if (spaceId) {
    const boards = await api(`/api/plaky/boards?space_id=${encodeURIComponent(spaceId)}`);
    for (const b of boards) el.plakyBoardSelect.appendChild(new Option(b.name, b.id));
  }
  await renderPlakyItems();
}

async function renderPlakyItems() {
  const boardId = el.plakyBoardSelect.value;
  const items = boardId
    ? await api(`/api/plaky/items?board_id=${encodeURIComponent(boardId)}`)
    : await api("/api/plaky/items");

  el.plakyItemList.replaceChildren();
  if (items.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "Nothing cached yet — try “Pull from Plaky”.";
    el.plakyItemList.appendChild(hint);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "plaky-row";
    const title = document.createElement("span");
    title.className = "plaky-row__title";
    title.textContent = item.title;
    const meta = document.createElement("span");
    meta.className = "plaky-row__meta";
    meta.textContent = `#${item.id}`;
    row.append(title, meta);
    el.plakyItemList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ sync log */

async function loadSyncLog() {
  const entries = await api("/api/sync/log");
  el.syncLogList.replaceChildren();
  if (entries.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty-hint";
    hint.textContent = "No syncs yet.";
    el.syncLogList.appendChild(hint);
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.dataset.ok = String(e.ok);

    const dir = document.createElement("span");
    dir.className = "log-row__dir";
    dir.textContent = e.direction;

    const target = document.createElement("span");
    target.textContent = e.target;

    const detail = document.createElement("span");
    detail.textContent = e.detail || "";

    const when = document.createElement("span");
    when.textContent = new Date(e.created_at * 1000).toLocaleString();

    row.append(dir, target, detail, when);
    el.syncLogList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ status chip + pull */

async function refreshConfigStatus() {
  const cfg = await api("/api/config");
  el.plakyStatus.dataset.ok = String(cfg.plaky_configured);
  el.plakyStatus.querySelector(".chip__label").textContent = cfg.plaky_configured
    ? "Plaky connected"
    : "Plaky not configured";
  el.pullButton.disabled = !cfg.plaky_configured;
  if (cfg.plaky_configured && cfg.auto_pull_interval_seconds > 0) {
    const minutes = Math.round(cfg.auto_pull_interval_seconds / 60);
    el.autoPullHint.textContent = `Auto-syncs every ${minutes} min`;
  } else {
    el.autoPullHint.textContent = "";
  }
}

async function onPull() {
  el.pullButton.disabled = true;
  el.pullButton.textContent = "Pulling…";
  try {
    await api("/api/sync/pull", { method: "POST" });
    await loadHomeBoard();
    await loadBacklog();
  } catch (err) {
    alert(`Pull failed: ${err.message}`);
  } finally {
    el.pullButton.disabled = false;
    el.pullButton.textContent = "Pull from Plaky";
  }
  if (state.view === "plaky") await loadPlakyBrowser();
  if (state.view === "log") await loadSyncLog();
}

/* ------------------------------------------------------------------ wiring */

function wireEvents() {
  el.navItems.forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));
  el.drawerToggle.addEventListener("click", openDrawer);
  el.sidebarScrim.addEventListener("click", closeDrawer);
  el.newItemButton.addEventListener("click", () => openModal(null));
  el.modalClose.addEventListener("click", closeModal);
  el.modalScrim.addEventListener("click", (e) => {
    if (e.target === el.modalScrim) closeModal();
  });
  el.saveButton.addEventListener("click", onSave);
  el.deleteButton.addEventListener("click", onDelete);
  el.pushButton.addEventListener("click", onPush);
  el.pullButton.addEventListener("click", onPull);
  el.plakySpaceSelect.addEventListener("change", onPlakySpaceChange);
  el.plakyBoardSelect.addEventListener("change", renderPlakyItems);

  el.boardPickerButton.addEventListener("click", openBoardModal);
  el.boardModalClose.addEventListener("click", closeBoardModal);
  el.boardModalScrim.addEventListener("click", (e) => {
    if (e.target === el.boardModalScrim) closeBoardModal();
  });
  el.boardModalSpace.addEventListener("change", onBoardModalSpaceChange);
  el.boardModalBoard.addEventListener("change", () => {
    el.boardModalSave.disabled = !el.boardModalBoard.value;
    updateBoardModalWarning();
  });
  el.boardModalSave.addEventListener("click", onBoardModalSave);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!el.modalScrim.hidden) closeModal();
    if (!el.boardModalScrim.hidden) closeBoardModal();
  });
}

/* ------------------------------------------------------------------ decorative: cursor + scramble */

function initSmoothCursor() {
  if (!window.matchMedia("(pointer: fine)").matches) return;
  const cursor = document.createElement("div");
  cursor.id = "smooth-cursor";
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", "22");
  svg.setAttribute("height", "22");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  const path = document.createElementNS(svgNS, "path");
  path.setAttribute("d", "M4 2L20 12L12 13.5L9 21L4 2Z");
  path.setAttribute("fill", "#f59e0b");
  path.setAttribute("stroke", "#100C0A");
  path.setAttribute("stroke-width", "1.2");
  path.setAttribute("stroke-linejoin", "round");
  svg.appendChild(path);
  cursor.appendChild(svg);
  document.body.appendChild(cursor);

  let mouseX = window.innerWidth / 2;
  let mouseY = window.innerHeight / 2;
  let curX = mouseX;
  let curY = mouseY;
  let curAngle = 0;
  let lastX = mouseX;
  let lastY = mouseY;

  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  (function animate() {
    curX += (mouseX - curX) * 0.22;
    curY += (mouseY - curY) * 0.22;
    const dx = mouseX - lastX;
    const dy = mouseY - lastY;
    if (Math.hypot(dx, dy) > 1) {
      const targetAngle = (Math.atan2(dy, dx) * 180) / Math.PI + 90;
      curAngle += (targetAngle - curAngle) * 0.25;
    }
    lastX = mouseX;
    lastY = mouseY;
    cursor.style.transform = `translate(${curX}px, ${curY}px) rotate(${curAngle}deg)`;
    requestAnimationFrame(animate);
  })();
}

function initHyperText() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  document.querySelectorAll(".brand__name").forEach((elm) => {
    const original = elm.textContent;
    let animating = false;
    elm.addEventListener("mouseenter", () => {
      if (animating) return;
      animating = true;
      const duration = 500;
      const start = performance.now();
      const len = original.length;
      (function frame(now) {
        const progress = Math.min((now - start) / duration, 1);
        const revealCount = progress * len;
        let out = "";
        for (let i = 0; i < len; i++) {
          const ch = original[i];
          out += ch === " " ? " " : i <= revealCount ? ch : chars[Math.floor(Math.random() * chars.length)];
        }
        elm.textContent = out;
        if (progress < 1) requestAnimationFrame(frame);
        else {
          elm.textContent = original;
          animating = false;
        }
      })(start);
    });
  });
}

/* ------------------------------------------------------------------ boot */

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("/sw.js").catch(() => {
    // Installability just degrades to "no install prompt"; the app itself
    // works fine as a plain page either way.
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  wireEvents();
  initSmoothCursor();
  initHyperText();
  registerServiceWorker();
  await refreshConfigStatus();
  await loadHomeBoard();
  await loadBacklog();
});
