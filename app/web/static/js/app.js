// Radial — frontend. No build step, no framework: fetch() + DOM APIs only.
// Every dynamic string goes through textContent, never innerHTML — habit
// carried over from ray-chat, worth keeping even though this app has no
// externally-sourced/untrusted content of its own.
//
// Columns come from GET /api/sections: the home board's real Plaky groups
// when one is set, otherwise Radial's own editable local sections (so the
// app is fully usable with no Plaky key at all). An item with
// group_id === null always renders in the "Unsorted" bucket.

const state = {
  view: "board",
  items: [],
  sections: [], // [{id, title}]
  sectionSource: "local", // "local" | "plaky"
  homeBoard: null, // {space_id, board_id} | null
  plakyConfigured: false,
  query: "",
  editingId: null, // null while creating a new item
  dragId: null,
};

const el = {};

// Inline SVG icons (Heroicons-style 24px outline paths). Rendered with DOM
// APIs, never innerHTML, same as everything else in this file.
const ICON_PATHS = {
  board: ["M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v12a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18V6Z", "M13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v6A2.25 2.25 0 0 1 18 14.25h-2.25A2.25 2.25 0 0 1 13.5 12V6Z"],
  live: ["M9.348 14.652a3.75 3.75 0 0 1 0-5.304m5.304 0a3.75 3.75 0 0 1 0 5.304m-7.425 2.121a6.75 6.75 0 0 1 0-9.546m9.546 0a6.75 6.75 0 0 1 0 9.546M5.106 18.894c-3.808-3.807-3.808-9.98 0-13.788m13.788 0c3.808 3.807 3.808 9.98 0 13.788M12 12h.008v.008H12V12Z"],
  log: ["M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm0 5.25h.007v.008H3.75V12Zm0 5.25h.007v.008H3.75v-.008Z"],
  sync: ["M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99"],
  search: ["m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z"],
  plus: ["M12 4.5v15m7.5-7.5h-15"],
  close: ["M6 18 18 6M6 6l12 12"],
  menu: ["M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5"],
  check: ["m4.5 12.75 6 6 9-13.5"],
  alert: ["M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"],
  info: ["m11.25 11.25.041-.02a.75.75 0 0 1 1.063.852l-.708 2.836a.75.75 0 0 0 1.063.853l.041-.021M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-3.75h.008v.008H12V8.25Z"],
  upload: ["M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"],
  file: ["M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"],
  comment: ["M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 0 1 .865-.501 48.172 48.172 0 0 0 3.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0 0 12 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018Z"],
  clip: ["m18.375 12.739-7.693 7.693a4.5 4.5 0 0 1-6.364-6.364l10.94-10.94A3 3 0 1 1 19.5 7.372L8.552 18.32m.009-.01-.01.01m5.699-9.941-7.81 7.81a1.5 1.5 0 0 0 2.112 2.13"],
  calendar: ["M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5"],
  trash: ["m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.94-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"],
};

function icon(name) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.6");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("i");
  for (const d of ICON_PATHS[name] || []) {
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

// Any element with data-icon="name" in the static HTML gets that icon prepended.
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach((node) => {
    if (node.querySelector(":scope > svg.i")) return;
    node.prepend(icon(node.dataset.icon));
  });
}

// Turns <button data-fx> into the sliding-arrow "FX" button: existing content
// moves into a label span, plus a fill circle and two arrows (see app.css).
function enhanceFxButtons(root = document) {
  const ns = "http://www.w3.org/2000/svg";
  const arrow = (side) => {
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.classList.add("btn__fx-arrow", `btn__fx-arrow--${side}`);
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", "M16.1716 10.9999L10.8076 5.63589L12.2218 4.22168L20 11.9999L12.2218 19.778L10.8076 18.3638L16.1716 12.9999H4V10.9999H16.1716Z");
    svg.appendChild(path);
    return svg;
  };
  root.querySelectorAll("button[data-fx]:not(.btn--fx)").forEach((btn) => {
    const label = document.createElement("span");
    label.className = "btn__fx-label";
    label.append(...btn.childNodes);
    const circle = document.createElement("span");
    circle.className = "btn__fx-circle";
    circle.setAttribute("aria-hidden", "true");
    btn.append(arrow("in"), label, circle, arrow("out"));
    btn.classList.add("btn--fx");
  });
}

// Accent presets (OKLCH hues). Picking one sets --hue; every accent shade in
// app.css is derived from it, so the whole UI recolors live.
const ACCENTS = [
  ["Electric", 255],
  ["Violet", 295],
  ["Magenta", 335],
  ["Ember", 55],
  ["Lime", 130],
  ["Mint", 170],
  ["Cyan", 210],
];

function initAccentPicker() {
  const root = document.documentElement;
  let current = 255;
  try {
    current = Number(localStorage.getItem("radial.hue")) || 255;
  } catch {
    // storage blocked: default hue, picker still works for this session
  }
  const buttons = ACCENTS.map(([name, hue]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.style.setProperty("--h", String(hue));
    b.title = name;
    b.setAttribute("aria-label", `${name} accent`);
    b.setAttribute("aria-pressed", String(hue === current));
    b.addEventListener("click", () => {
      root.style.setProperty("--hue", String(hue));
      buttons.forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
      try {
        localStorage.setItem("radial.hue", String(hue));
      } catch {
        // not persisted; fine
      }
    });
    return b;
  });
  document.getElementById("swatches").append(...buttons);
}

/* ---- dot-matrix headers ----------------------------------------------------
 * Classic 5x7 LED font: each glyph is 7 row strings of 5 columns, "#" = lit dot.
 * Headers render as a full grid of circles: lit ones spell the word, unlit
 * ones stay faintly visible (that's what sells the LED-board look). Drawn as
 * two <path>s per header (lit / unlit), not hundreds of <circle>s, because the
 * live board re-renders every 15s. The real text stays in the DOM, visually
 * hidden, for screen readers, search and tests. */
const DOT_FONT = {
  "A": [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "B": ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."],
  "C": [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."],
  "D": ["###..", "#..#.", "#...#", "#...#", "#...#", "#..#.", "###.."],
  "E": ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  "F": ["#####", "#....", "#....", "####.", "#....", "#....", "#...."],
  "G": [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"],
  "H": ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"],
  "I": [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "J": ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."],
  "K": ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  "L": ["#....", "#....", "#....", "#....", "#....", "#....", "#####"],
  "M": ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"],
  "N": ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"],
  "O": [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "P": ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."],
  "Q": [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"],
  "R": ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"],
  "S": [".####", "#....", "#....", ".###.", "....#", "....#", "####."],
  "T": ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  "U": ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  "V": ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."],
  "W": ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."],
  "X": ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"],
  "Y": ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."],
  "Z": ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"],
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
  " ": [".....", ".....", ".....", ".....", ".....", ".....", "....."],
  "(": ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."],
  ")": [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."],
  "-": [".....", ".....", ".....", "#####", ".....", ".....", "....."],
  ".": [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."],
  ",": [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."],
  "'": ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."],
  "&": [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"],
  "/": [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."],
  ":": [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."],
  "!": ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."],
  "?": [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."],
  "#": [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."],
  "+": [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."],
};
const dotCache = new Map();

function dotGlyph(ch) {
  return (DOT_FONT[ch] || DOT_FONT[ch.toUpperCase()] || DOT_FONT["?"]).join("");
}

// A circle as two arcs, so thousands of dots fit in one path's d attribute.
function dotArc(cx, cy, r) {
  return `M${(cx - r).toFixed(2)} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

function buildDotSvg(text) {
  const chars = [...text.toUpperCase()];
  const cols = Math.max(1, chars.length * 6 - 1); // 5 dots per char + 1 spacer column
  const r = 0.4;
  let on = "";
  let off = "";
  chars.forEach((ch, i) => {
    const glyph = dotGlyph(ch);
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 6; col++) {
        const x = i * 6 + col;
        if (x >= cols) continue;
        const lit = col < 5 && glyph[row * 5 + col] === "#";
        const d = dotArc(x + 0.5, row + 0.5, r);
        if (lit) on += d;
        else off += d;
      }
    }
  });
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${cols} 7`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.setProperty("--cols", String(cols));
  for (const [cls, d] of [["dot-text__off", off], ["dot-text__on", on]]) {
    if (!d) continue;
    const path = document.createElementNS(ns, "path");
    path.setAttribute("class", cls);
    path.setAttribute("d", d);
    svg.appendChild(path);
  }
  return svg;
}

function dotText(text) {
  const wrap = document.createElement("span");
  wrap.className = "dot-text";
  const key = text.toUpperCase();
  if (!dotCache.has(key)) dotCache.set(key, buildDotSvg(key));
  const real = document.createElement("span");
  real.className = "visually-hidden";
  real.textContent = text;
  wrap.append(dotCache.get(key).cloneNode(true), real);
  return wrap;
}

function setDotText(node, text) {
  node.replaceChildren(dotText(text));
  node.title = text;
}

function badge(text, iconName, modifier = "") {
  const b = document.createElement("span");
  b.className = `badge${modifier ? ` badge--${modifier}` : ""}`;
  if (iconName) b.appendChild(icon(iconName));
  b.appendChild(document.createTextNode(text));
  return b;
}

function metaCount(iconName, n, label) {
  const m = document.createElement("span");
  m.className = "meta";
  m.title = `${n} ${label}`;
  m.append(icon(iconName), document.createTextNode(String(n)));
  return m;
}

function relativeTime(epochSeconds) {
  const diff = Math.round(Date.now() / 1000 - epochSeconds);
  if (diff < 45) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)}d ago`;
  return new Date(epochSeconds * 1000).toLocaleDateString();
}

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

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
  el.search = document.getElementById("search");
  el.liveColumns = document.getElementById("live-columns");
  el.liveStatus = document.getElementById("live-status");
  el.liveTitle = document.getElementById("live-title");
  el.liveEmpty = document.getElementById("live-empty");
  el.livePickBoard = document.getElementById("live-pick-board");
  el.liveRefresh = document.getElementById("live-refresh");
  el.liveModalScrim = document.getElementById("live-modal-scrim");
  el.liveModalTitle = document.getElementById("live-modal-title");
  el.liveModalClose = document.getElementById("live-modal-close");
  el.liveGroup = document.getElementById("live-group");
  el.liveDone = document.getElementById("live-done");
  el.liveFields = document.getElementById("live-fields");
  el.liveActivityHint = document.getElementById("live-activity-hint");
  el.liveFiles = document.getElementById("live-files");
  el.liveFile = document.getElementById("live-file");
  el.liveDrop = document.getElementById("live-drop");
  el.liveUploadStatus = document.getElementById("live-upload-status");
  el.liveTurnin = document.getElementById("live-turnin");
  el.liveCrumb = document.getElementById("live-crumb");
  el.liveDoneLabel = document.getElementById("live-done-label");
  el.countBoard = document.getElementById("count-board");
  el.countPlaky = document.getElementById("count-plaky");
  el.boardPickerSpace = document.getElementById("board-picker-space");
  el.viewSub = document.getElementById("view-sub");
  el.liveComments = document.getElementById("live-comments");
  el.liveCommentText = document.getElementById("live-comment-text");
  el.liveCommentPost = document.getElementById("live-comment-post");
  el.syncLogList = document.getElementById("sync-log-list");
  el.plakyStatus = document.getElementById("plaky-status");
  el.plakyControls = document.getElementById("plaky-controls");
  el.pullButton = document.getElementById("pull-button");
  el.autoPullHint = document.getElementById("auto-pull-hint");
  el.newItemButton = document.getElementById("new-item-button");
  el.boardPickerButton = document.getElementById("board-picker-button");
  el.boardPickerLabel = document.getElementById("board-picker-label");
  el.toasts = document.getElementById("toasts");

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
  el.boardModalLocal = document.getElementById("board-modal-local");
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
      if (Array.isArray(detail)) detail = detail.map((d) => d.msg).join("; ");
    } catch {
      // ignore
    }
    throw new Error(detail);
  }
  if (response.status === 204) return null;
  return response.json();
}

function toast(title, kind = "info", description = "") {
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.kind = kind;
  node.setAttribute("role", kind === "error" ? "alert" : "status");

  const main = document.createElement("div");
  main.className = "toast__main";
  const ico = document.createElement("div");
  ico.className = "toast__icon";
  ico.appendChild(icon({ ok: "check", error: "alert" }[kind] || "info"));
  const text = document.createElement("div");
  text.className = "toast__text";
  const t = document.createElement("p");
  t.className = "toast__title";
  t.textContent = title;
  const d = document.createElement("p");
  d.className = "toast__desc";
  d.textContent = description;
  text.append(t, d);
  main.append(ico, text);

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast__close";
  close.setAttribute("aria-label", "Dismiss");
  close.appendChild(icon("close"));

  node.append(main, close);
  el.toasts.appendChild(node);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.classList.add("is-leaving");
    setTimeout(() => node.remove(), 250);
  };
  const arm = () => (timer = setTimeout(dismiss, kind === "error" ? 7000 : 3500));
  close.addEventListener("click", dismiss);
  node.addEventListener("mouseenter", () => clearTimeout(timer)); // hover to keep reading
  node.addEventListener("mouseleave", arm);
  arm();
}

/* ------------------------------------------------------------------ views */

function switchView(view) {
  state.view = view;
  el.navItems.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === view));
  Object.entries(el.views).forEach(([key, node]) => {
    node.hidden = key !== view;
  });
  setDotText(el.viewTitle, { board: "Backlog", plaky: "Plaky (live)", log: "Sync log" }[view]);
  el.search.closest(".search").hidden = view === "log";
  el.newItemButton.hidden = view !== "board";
  el.liveRefresh.hidden = view !== "plaky" || !state.homeBoard;
  setLiveStatus("");
  updateViewSub();
  if (view === "plaky") startLivePolling();
  else stopLivePolling();
  if (view === "log") loadSyncLog();
  closeDrawer();
}

function updateViewSub() {
  if (state.view === "board") {
    const n = state.items.length;
    const sections = state.sections.length + 1;
    el.viewSub.textContent = `${n} item${n === 1 ? "" : "s"} · ${sections} sections`;
  } else if (state.view === "plaky") {
    el.viewSub.textContent = live.data ? live.data.board.title : "";
  } else {
    el.viewSub.textContent = "Every pull and push, newest first";
  }
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

/* ------------------------------------------------------------------ sections + home board */

async function loadSections() {
  const [home, sections] = await Promise.all([api("/api/settings/home-board"), api("/api/sections")]);
  state.homeBoard = home.home;
  state.sections = sections.sections;
  state.sectionSource = sections.source;
  if (state.homeBoard) {
    const boards = await api(`/api/plaky/boards?space_id=${encodeURIComponent(state.homeBoard.space_id)}`);
    const board = boards.find((b) => b.id === state.homeBoard.board_id);
    el.boardPickerLabel.textContent = board ? board.name : `Board ${state.homeBoard.board_id}`;
    const spaces = await api("/api/plaky/spaces");
    el.boardPickerSpace.textContent = spaces.find((x) => x.id === state.homeBoard.space_id)?.name || "";
  } else {
    el.boardPickerLabel.textContent = "No board picked";
    el.boardPickerSpace.textContent = "Backlog uses local sections";
  }
  populateGroupSelect();
}

function populateGroupSelect() {
  el.fieldGroup.replaceChildren(new Option("Unsorted", ""));
  for (const s of state.sections) el.fieldGroup.appendChild(new Option(s.title, s.id));
}

async function addSection() {
  const title = prompt("New section name:");
  if (!title || !title.trim()) return;
  await api("/api/sections", { method: "POST", body: JSON.stringify({ title: title.trim() }) });
  await loadSections();
  renderBoard();
}

async function renameSection(section) {
  const title = prompt("Rename section:", section.title);
  if (!title || !title.trim() || title.trim() === section.title) return;
  await api(`/api/sections/${encodeURIComponent(section.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ title: title.trim() }),
  });
  await loadSections();
  renderBoard();
}

async function deleteSection(section) {
  const count = state.items.filter((i) => i.group_id === section.id).length;
  const msg = count
    ? `Delete "${section.title}"? Its ${count} item(s) move to Unsorted.`
    : `Delete "${section.title}"?`;
  if (!confirm(msg)) return;
  await api(`/api/sections/${encodeURIComponent(section.id)}`, { method: "DELETE" });
  await loadSections();
  await loadBacklog();
}

async function openBoardModal() {
  el.boardModalScrim.hidden = false;
  el.boardModalSpace.replaceChildren(new Option("Select…", ""));
  el.boardModalBoard.replaceChildren(new Option("Select…", ""));
  el.boardModalBoard.disabled = true;
  el.boardModalSave.disabled = true;
  el.boardModalWarning.hidden = true;
  el.boardModalLocal.hidden = !state.homeBoard;

  let spaces = await api("/api/plaky/spaces");
  if (spaces.length === 0 && state.plakyConfigured) {
    el.boardModalSpace.replaceChildren(new Option("Loading your Plaky spaces…", ""));
    await api("/api/sync/pull", { method: "POST" });
    spaces = await api("/api/plaky/spaces");
    el.boardModalSpace.replaceChildren(new Option("Select…", ""));
  }
  if (spaces.length === 0) {
    el.boardModalSpace.replaceChildren(new Option("No Plaky spaces found", ""));
    return;
  }
  for (const s of spaces) el.boardModalSpace.appendChild(new Option(s.name, s.id));
  if (state.homeBoard) el.boardModalSpace.value = state.homeBoard.space_id;
  if (el.boardModalSpace.value) await onBoardModalSpaceChange();
}

function closeBoardModal() {
  el.boardModalScrim.hidden = true;
}

function hasSectionedItems() {
  return state.items.some((i) => i.group_id);
}

function isChangingBoard() {
  if (!state.homeBoard) return hasSectionedItems(); // leaving local sections
  return (
    state.homeBoard.space_id !== el.boardModalSpace.value || state.homeBoard.board_id !== el.boardModalBoard.value
  );
}

function updateBoardModalWarning() {
  el.boardModalWarning.hidden = !(el.boardModalBoard.value && isChangingBoard() && hasSectionedItems());
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
  if (isChangingBoard() && hasSectionedItems()) {
    if (!confirm("Switching boards moves every sectioned item back to Unsorted. Continue?")) return;
  }
  await api("/api/settings/home-board", {
    method: "POST",
    body: JSON.stringify({ space_id: el.boardModalSpace.value, board_id: el.boardModalBoard.value }),
  });
  closeBoardModal();
  await loadSections();
  await loadBacklog();
  if (state.view === "plaky") await loadLive();
}

async function onUseLocalSections() {
  if (hasSectionedItems() && !confirm("Going back to local sections moves every sectioned item to Unsorted. Continue?")) {
    return;
  }
  await api("/api/settings/home-board", { method: "DELETE" });
  closeBoardModal();
  await loadSections();
  await loadBacklog();
}

/* ------------------------------------------------------------------ board */

async function loadBacklog() {
  state.items = await api("/api/backlog");
  renderBoard();
}

function matchesQuery(item) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return item.title.toLowerCase().includes(q) || item.description.toLowerCase().includes(q);
}

function renderBoard() {
  el.boardColumns.replaceChildren();
  const local = state.sectionSource === "local";
  const columns = [{ id: "", title: "Unsorted", fixed: true }, ...state.sections];
  el.countBoard.textContent = state.items.length ? String(state.items.length) : "";
  updateViewSub();

  for (const section of columns) {
    const items = state.items.filter((i) => (i.group_id || "") === section.id && matchesQuery(i));
    const { col, head, body, foot } = buildColumn(section.title, items.length);
    wireDropTarget(col, section.id);

    if (local && !section.fixed) {
      head.querySelector(".board-col__title").title = "Double-click to rename";
      head.querySelector(".board-col__title").addEventListener("dblclick", () => renameSection(section));
      const del = document.createElement("button");
      del.type = "button";
      del.className = "icon-btn icon-btn--sm board-col__delete";
      del.setAttribute("aria-label", `Delete section ${section.title}`);
      del.title = "Delete section";
      del.appendChild(icon("trash"));
      del.addEventListener("click", () => deleteSection(section));
      head.appendChild(del);
    }

    for (const item of items) body.appendChild(buildCard(item));
    if (items.length === 0) body.appendChild(emptyHint(state.query ? "No matches." : "Drop items here."));
    foot.appendChild(buildQuickAdd(section.id));
    el.boardColumns.appendChild(col);
  }

  if (local) {
    const add = document.createElement("button");
    add.type = "button";
    add.className = "board-add-col";
    add.append(icon("plus"), document.createTextNode("Add section"));
    add.addEventListener("click", addSection);
    el.boardColumns.appendChild(add);
  }
}

// Column shell shared by the backlog and the live board: sticky head,
// independently scrolling body, add-box pinned to the bottom.
function buildColumn(title, count, color) {
  const col = document.createElement("div");
  col.className = "board-col";
  const head = document.createElement("div");
  head.className = "board-col__head";
  const dot = document.createElement("span");
  dot.className = "board-col__dot";
  if (color) dot.style.setProperty("--group-color", color);
  const label = document.createElement("span");
  label.className = "board-col__title";
  if (title) setDotText(label, title);
  const n = document.createElement("span");
  n.className = "board-col__count";
  n.textContent = String(count);
  head.append(dot, label, n);
  const body = document.createElement("div");
  body.className = "board-col__body";
  const foot = document.createElement("div");
  foot.className = "board-col__foot";
  col.append(head, body, foot);
  return { col, head, body, foot };
}

function emptyHint(text) {
  const hint = document.createElement("p");
  hint.className = "empty-hint";
  hint.textContent = text;
  return hint;
}

function buildQuickAdd(groupId) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "quick-add";
  input.placeholder = "+ Add item";
  input.maxLength = 255;
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      return;
    }
    if (e.key !== "Enter" || !input.value.trim()) return;
    const title = input.value.trim();
    input.value = "";
    await api("/api/backlog", {
      method: "POST",
      body: JSON.stringify({ title, group_id: groupId || null }),
    });
    await loadBacklog();
    // renderBoard rebuilt the column; keep typing in the same spot.
    const cols = el.boardColumns.querySelectorAll(".board-col");
    const index = groupId ? state.sections.findIndex((s) => s.id === groupId) + 1 : 0;
    cols[index]?.querySelector(".quick-add")?.focus();
  });
  return input;
}

function wireDropTarget(col, groupId) {
  col.addEventListener("dragover", (e) => {
    if (!state.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("is-drop-target");
  });
  col.addEventListener("dragleave", (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("is-drop-target");
  });
  col.addEventListener("drop", async (e) => {
    e.preventDefault();
    col.classList.remove("is-drop-target");
    const id = state.dragId;
    state.dragId = null;
    const item = state.items.find((i) => i.id === id);
    if (!item || (item.group_id || "") === groupId) return;
    item.group_id = groupId || null; // optimistic
    renderBoard();
    try {
      await api(`/api/backlog/${id}`, { method: "PATCH", body: JSON.stringify({ group_id: groupId || null }) });
    } finally {
      await loadBacklog();
    }
  });
}

function buildCard(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.p = item.priority;
  card.draggable = true;
  card.tabIndex = 0;
  card.title = `${item.priority} priority`;
  card.addEventListener("click", () => openModal(item));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openModal(item);
  });
  card.addEventListener("dragstart", (e) => {
    state.dragId = item.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.id);
    requestAnimationFrame(() => card.classList.add("is-dragging"));
  });
  card.addEventListener("dragend", () => {
    state.dragId = null;
    card.classList.remove("is-dragging");
    document.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
  });

  const title = document.createElement("div");
  title.className = "card__title";
  title.textContent = item.title;
  card.appendChild(title);

  if (item.description.trim()) {
    const desc = document.createElement("div");
    desc.className = "card__desc";
    desc.textContent = item.description;
    card.appendChild(desc);
  }

  const meta = document.createElement("div");
  meta.className = "card__meta";
  if (item.priority === "high") meta.appendChild(badge("High", null, "overdue"));
  if (item.linked) {
    const linked = document.createElement("span");
    linked.className = "meta meta--push meta--linked";
    linked.append(icon("live"), document.createTextNode("In Plaky"));
    meta.appendChild(linked);
  }
  card.appendChild(meta);
  return card;
}

/* ------------------------------------------------------------------ modal */

function openModal(item, groupId = "") {
  state.editingId = item ? item.id : null;
  el.modalTitle.textContent = item ? "Edit item" : "New item";
  el.fieldTitle.value = item ? item.title : "";
  el.fieldDescription.value = item ? item.description : "";
  el.fieldPriority.value = item ? item.priority : "medium";
  el.fieldGroup.value = item ? item.group_id || "" : groupId;
  el.deleteButton.hidden = !item;

  // Push only makes sense against a real Plaky board.
  el.pushSection.hidden = !item || !state.plakyConfigured;
  if (item && state.plakyConfigured) {
    if (item.linked) {
      el.pushLinkedNote.hidden = false;
      el.pushLinkedNote.textContent = `Linked to Plaky item ${item.plaky_item_id}. Title can't be re-synced (Plaky has no rename endpoint).`;
      el.pushButton.hidden = true;
    } else if (state.sectionSource !== "plaky") {
      el.pushLinkedNote.hidden = false;
      el.pushLinkedNote.textContent = "Set a Plaky home board (sidebar) to push items.";
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
  el.saveButton.disabled = true;
  try {
    if (state.editingId) {
      await api(`/api/backlog/${state.editingId}`, { method: "PATCH", body: JSON.stringify(payload) });
    } else {
      await api("/api/backlog", { method: "POST", body: JSON.stringify(payload) });
    }
    closeModal();
    await loadBacklog();
  } finally {
    el.saveButton.disabled = false;
  }
}

async function onDelete() {
  if (!state.editingId) return;
  const item = state.items.find((i) => i.id === state.editingId);
  if (!confirm(`Delete "${item ? item.title : "this item"}"?`)) return;
  await api(`/api/backlog/${state.editingId}`, { method: "DELETE" });
  closeModal();
  await loadBacklog();
  toast("Item deleted");
}

async function onPush() {
  if (!state.editingId) return;
  el.pushButton.disabled = true;
  el.pushButton.textContent = "Pushing…";
  try {
    await api(`/api/backlog/${state.editingId}/push`, { method: "POST" });
    closeModal();
    await loadBacklog();
    toast("Pushed to Plaky", "ok", "Created as a new Plaky item");
  } catch (err) {
    el.pushLinkedNote.hidden = false;
    el.pushLinkedNote.textContent = `Push failed: ${err.message}`;
    el.pushButton.disabled = false;
    el.pushButton.textContent = "Push to Plaky";
  }
}

/* ------------------------------------------------------------------ live Plaky board */
// What Plaky sees right now: the home board's real groups + items, fetched
// straight from Plaky (via our server, which holds the key) and re-polled
// every LIVE_POLL_MS while this view is open. Plaky has no webhooks, so
// polling is the only way; ~8 requests/min is far under its 200/min limit.

const LIVE_POLL_MS = 15000;
const FINAL_GROUP_RE = /\b(done|complete|completed|submitted|finished|turned in)\b/i;

const live = {
  data: null, // last /api/live/board response
  timer: null,
  loading: false,
  error: null,
  openItemId: null,
  dragId: null,
};

function liveFieldDefs() {
  return new Map((live.data?.fields || []).map((f) => [f.key, f]));
}

function liveFieldValue(item, key) {
  const f = item.fields.find((x) => x.key === key);
  return f ? f.value : null;
}

function statusLabel(def, value) {
  const labels = def?.configuration?.values || [];
  const key = value && typeof value === "object" ? value.key : value;
  const found = labels.find((l) => l.key === key);
  if (found) return found;
  // Real Plaky returns {key, label, color} even unexpanded; use it if the board defs miss it.
  if (value && typeof value === "object" && value.key) return { key: value.key, title: value.label || "", color: value.color };
  return null;
}

function finalStatusTarget() {
  for (const def of live.data?.fields || []) {
    if (def.type !== "STATUS") continue;
    const final = (def.configuration?.values || []).find((l) => l.isFinal);
    if (final) return { def, label: final };
  }
  return null;
}

function finalGroup() {
  return (live.data?.groups || []).find((g) => FINAL_GROUP_RE.test(g.title)) || null;
}

// Coalescing loader: a call made while a fetch is in flight doesn't get
// dropped (that would render stale data right after a write); it queues one
// follow-up fetch, and every caller awaits the result that reflects its write.
function loadLive(opts = {}) {
  if (live.inflight) {
    live.queued ??= live.inflight.then(() => {
      live.queued = null;
      return loadLive({ quiet: true });
    });
    return live.queued;
  }
  live.inflight = fetchLive(opts).finally(() => {
    live.inflight = null;
  });
  return live.inflight;
}

async function fetchLive({ quiet = false } = {}) {
  if (!state.homeBoard) {
    live.data = null;
    renderLive();
    return;
  }
  live.loading = true;
  if (!quiet) setLiveStatus("Loading…");
  if (!live.data) renderLiveSkeleton();
  el.liveRefresh.classList.add("is-spinning");
  try {
    live.data = await api("/api/live/board");
    live.error = null;
  } catch (err) {
    live.error = err.message;
  } finally {
    live.loading = false;
    el.liveRefresh.classList.remove("is-spinning");
  }
  if (state.view !== "plaky") return;
  if (live.dragId) return; // don't yank the board out from under a drag
  renderLive();
  if (live.openItemId) refreshLiveModalFields();
}

function startLivePolling() {
  stopLivePolling();
  loadLive();
  live.timer = setInterval(() => {
    if (document.visibilityState === "visible") loadLive({ quiet: true });
    else updateLiveAge();
  }, LIVE_POLL_MS);
  live.ageTimer = setInterval(updateLiveAge, 1000);
}

function stopLivePolling() {
  clearInterval(live.timer);
  clearInterval(live.ageTimer);
  live.timer = null;
}

function setLiveStatus(text, kind = "") {
  el.liveStatus.textContent = state.view === "plaky" ? text : "";
  el.liveStatus.dataset.kind = kind;
}

function updateLiveAge() {
  if (state.view !== "plaky") return;
  if (live.error) {
    setLiveStatus(`${live.error} (showing last known board)`, "error");
    return;
  }
  if (!live.data) return;
  const age = Math.max(0, Math.round(Date.now() / 1000 - live.data.fetched_at));
  setLiveStatus(age < 5 ? "Live · just updated" : `Live · updated ${age}s ago`, "ok");
}

function renderLiveSkeleton() {
  el.liveEmpty.hidden = true;
  el.liveColumns.replaceChildren();
  el.liveColumns.classList.add("skeleton");
  for (const n of [3, 2, 4, 1]) {
    const { col, head, body } = buildColumn("", "");
    head.replaceChildren(document.createElement("span"));
    for (let i = 0; i < n; i++) {
      const c = document.createElement("div");
      c.className = "card";
      body.appendChild(c);
    }
    el.liveColumns.appendChild(col);
  }
}

function renderLive() {
  el.liveColumns.classList.remove("skeleton");
  el.liveColumns.replaceChildren();
  el.liveRefresh.hidden = state.view !== "plaky" || !state.homeBoard;
  if (!state.homeBoard) {
    el.liveTitle.textContent = "";
    el.countPlaky.textContent = "";
    setLiveStatus("");
    el.liveEmpty.hidden = false;
    updateViewSub();
    return;
  }
  el.liveEmpty.hidden = true;
  updateLiveAge();
  if (!live.data) return;
  el.liveTitle.textContent = live.data.board.title || "";
  el.countPlaky.textContent = String(live.data.items.length);
  updateViewSub();

  const statusDef = (live.data.fields || []).find((f) => f.type === "STATUS");
  const q = state.query.toLowerCase();

  for (const group of live.data.groups) {
    const items = live.data.items.filter((i) => i.group_id === group.id && (!q || i.title.toLowerCase().includes(q)));
    const { col, body, foot } = buildColumn(group.title, items.length, group.color);
    wireLiveDropTarget(col, group.id);
    for (const item of items) body.appendChild(buildLiveCard(item, statusDef));
    if (items.length === 0) body.appendChild(emptyHint(q ? "No matches." : "Nothing here."));
    foot.appendChild(buildLiveQuickAdd(group.id));
    el.liveColumns.appendChild(col);
  }
}

function isLiveItemDone(item) {
  const done = finalStatusTarget();
  if (done) return statusLabel(done.def, liveFieldValue(item, done.def.key))?.key === done.label.key;
  const g = finalGroup();
  return Boolean(g && item.group_id === g.id);
}

function dueBadge(item, done) {
  const def = (live.data?.fields || []).find((f) => f.type === "DATE_TIME");
  const value = def && liveFieldValue(item, def.key);
  if (typeof value !== "string" || !value) return null;
  const due = new Date(value);
  if (Number.isNaN(due.getTime())) return null;
  const days = Math.floor((due - new Date(new Date().toDateString())) / 86400000);
  const label = due.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const kind = done ? "done" : days < 0 ? "overdue" : days <= 2 ? "soon" : "";
  const b = badge(label, "calendar", kind);
  b.title = `${def.name || "Due"}: ${due.toLocaleDateString()}${!done && days < 0 ? " (overdue)" : ""}`;
  return b;
}

function buildLiveCard(item, statusDef) {
  const done = isLiveItemDone(item);
  const card = document.createElement("div");
  card.className = `card${done ? " is-done" : ""}`;
  card.draggable = true;
  card.tabIndex = 0;
  card.addEventListener("click", () => openLiveModal(item.id));
  card.addEventListener("keydown", (e) => {
    if (e.key === "Enter") openLiveModal(item.id);
  });
  card.addEventListener("dragstart", (e) => {
    live.dragId = item.id;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", item.id);
    requestAnimationFrame(() => card.classList.add("is-dragging"));
  });
  card.addEventListener("dragend", () => {
    live.dragId = null;
    card.classList.remove("is-dragging");
    document.querySelectorAll(".is-drop-target").forEach((n) => n.classList.remove("is-drop-target"));
  });

  const title = document.createElement("div");
  title.className = "card__title";
  title.textContent = item.title;
  card.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "card__meta";
  const label = statusDef ? statusLabel(statusDef, liveFieldValue(item, statusDef.key)) : null;
  if (label && label.title) {
    const pill = document.createElement("span");
    pill.className = "status-pill";
    pill.textContent = label.title;
    if (label.color) pill.style.setProperty("--pill", label.color);
    meta.appendChild(pill);
  }
  const due = dueBadge(item, done);
  if (due) meta.appendChild(due);
  const counts = document.createElement("span");
  counts.className = "meta meta--push";
  if (item.comment_count) counts.appendChild(metaCount("comment", item.comment_count, "comments"));
  if (item.file_count) counts.appendChild(metaCount("clip", item.file_count, "files"));
  if (counts.childElementCount) {
    counts.style.gap = "8px";
    meta.appendChild(counts);
  }
  card.appendChild(meta);
  return card;
}

function buildLiveQuickAdd(groupId) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "quick-add";
  input.placeholder = "+ Add to Plaky";
  input.maxLength = 255;
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      input.value = "";
      input.blur();
      return;
    }
    if (e.key !== "Enter" || !input.value.trim()) return;
    const title = input.value.trim();
    input.disabled = true;
    try {
      await api("/api/live/items", { method: "POST", body: JSON.stringify({ title, group_id: groupId }) });
      toast("Added to Plaky", "ok", title);
      await loadLive({ quiet: true });
    } finally {
      input.disabled = false;
    }
  });
  return input;
}

function wireLiveDropTarget(col, groupId) {
  col.addEventListener("dragover", (e) => {
    if (!live.dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    col.classList.add("is-drop-target");
  });
  col.addEventListener("dragleave", (e) => {
    if (!col.contains(e.relatedTarget)) col.classList.remove("is-drop-target");
  });
  col.addEventListener("drop", async (e) => {
    e.preventDefault();
    col.classList.remove("is-drop-target");
    const id = live.dragId;
    live.dragId = null;
    const item = live.data?.items.find((i) => i.id === id);
    if (!item || item.group_id === groupId) return;
    await moveLiveItem(item, groupId);
  });
}

async function moveLiveItem(item, groupId) {
  const previous = item.group_id;
  item.group_id = groupId; // optimistic
  renderLive();
  try {
    await api(`/api/live/items/${item.id}/group`, { method: "PATCH", body: JSON.stringify({ group_id: groupId }) });
  } catch (err) {
    item.group_id = previous;
    renderLive();
    throw err;
  }
  await loadLive({ quiet: true });
}

async function setLiveField(itemId, key, value) {
  await api(`/api/live/items/${itemId}/fields/${encodeURIComponent(key)}`, {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
  await loadLive({ quiet: true });
}

/* ---- live item modal ---- */

function currentLiveItem() {
  return live.data?.items.find((i) => i.id === live.openItemId) || null;
}

function openLiveModal(itemId) {
  live.openItemId = itemId;
  const item = currentLiveItem();
  if (!item) return;
  el.liveModalTitle.textContent = item.title;
  el.liveGroup.replaceChildren(...live.data.groups.map((g) => new Option(g.title, g.id)));
  el.liveGroup.value = item.group_id || "";
  el.liveCommentText.value = "";
  el.liveFile.value = "";
  el.liveUploadStatus.textContent = "Up to 50 MB";
  el.liveComments.replaceChildren();
  el.liveFiles.replaceChildren();
  refreshLiveModalFields();
  el.liveModalScrim.hidden = false;
  el.liveModalClose.focus();
  loadLiveActivity(itemId);
}

function closeLiveModal() {
  el.liveModalScrim.hidden = true;
  live.openItemId = null;
}

function refreshLiveModalFields() {
  const item = currentLiveItem();
  if (!item) return;
  const group = live.data.groups.find((g) => g.id === item.group_id);
  el.liveCrumb.textContent = [live.data.board.title, group?.title].filter(Boolean).join("  ›  ");
  // Don't clobber a field the user is in the middle of typing into.
  if (el.liveFields.contains(document.activeElement) || el.liveTurnin.contains(document.activeElement)) return;
  el.liveGroup.value = item.group_id || "";

  const done = finalStatusTarget();
  const doneGroup = finalGroup();
  const isDone = isLiveItemDone(item);
  el.liveDone.hidden = !done && !doneGroup;
  el.liveDone.disabled = isDone;
  el.liveDone.classList.toggle("btn--primary", !isDone);
  el.liveDone.classList.toggle("btn--success", isDone);
  el.liveDoneLabel.textContent = isDone ? "Done" : `Mark ${done ? done.label.title : doneGroup?.title || "done"}`;

  el.liveFields.replaceChildren();
  el.liveTurnin.replaceChildren();
  for (const def of live.data.fields) {
    const editor = buildFieldEditor(item, def);
    if (!editor) continue;
    // Links are how work gets turned in, so they live next to file upload.
    if (def.type === "LINK") {
      editor.classList.add("field--wide");
      el.liveTurnin.appendChild(editor);
    } else {
      el.liveFields.appendChild(editor);
    }
  }
}

function buildFieldEditor(item, def) {
  const value = liveFieldValue(item, def.key);
  const wrap = document.createElement("label");
  wrap.className = "field";
  const name = document.createElement("span");
  name.textContent = def.name || def.key;
  wrap.appendChild(name);

  const save = async (v) => {
    try {
      await setLiveField(item.id, def.key, v);
      toast(`${def.name || def.key} updated`, "ok", "Saved to Plaky");
    } catch (err) {
      toast(`Couldn't update ${def.name || def.key}`, "error", err.message);
    }
  };

  let input;
  switch (def.type) {
    case "STATUS": {
      input = document.createElement("select");
      input.className = "select";
      input.appendChild(new Option("None", ""));
      for (const l of def.configuration?.values || []) input.appendChild(new Option(l.title, l.key));
      input.value = statusLabel(def, value)?.key || "";
      input.addEventListener("change", () => save(input.value || null));
      break;
    }
    case "STRING":
    case "RICH_TEXT": {
      input = document.createElement(def.type === "RICH_TEXT" ? "textarea" : "input");
      if (def.type === "RICH_TEXT") input.rows = 3;
      input.value = typeof value === "string" ? value : "";
      input.addEventListener("change", () => save(input.value));
      break;
    }
    case "NUMBER": {
      input = document.createElement("input");
      input.type = "number";
      input.value = value ?? "";
      input.addEventListener("change", () => save(input.value === "" ? null : Number(input.value)));
      break;
    }
    case "DATE_TIME": {
      input = document.createElement("input");
      input.type = "date";
      input.value = typeof value === "string" ? value.slice(0, 10) : "";
      // Noon UTC so the date reads the same in every US/EU timezone.
      input.addEventListener("change", () => save(input.value ? `${input.value}T12:00:00.000Z` : null));
      break;
    }
    case "LINK": {
      input = document.createElement("input");
      input.type = "url";
      input.placeholder = "https://…";
      input.value = (value && typeof value === "object" ? value.url : value) || "";
      input.addEventListener("change", () => save(input.value.trim() || null));
      break;
    }
    case "TAG": {
      const labels = def.configuration?.values || [];
      const current = new Set((Array.isArray(value) ? value : []).map((v) => (typeof v === "object" ? v.key : v)));
      input = document.createElement("div");
      input.className = "tag-list";
      for (const l of labels) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "tag-chip";
        chip.textContent = l.title;
        chip.setAttribute("aria-pressed", String(current.has(l.key)));
        chip.addEventListener("click", () => {
          if (current.has(l.key)) current.delete(l.key);
          else current.add(l.key);
          chip.setAttribute("aria-pressed", String(current.has(l.key)));
          save([...current]);
        });
        input.appendChild(chip);
      }
      break;
    }
    default: {
      // PERSON / TIMELINE: shown, not edited here.
      input = document.createElement("div");
      input.className = "field__readonly";
      input.textContent = describeValue(def.type, value);
      break;
    }
  }
  wrap.appendChild(input);
  return wrap;
}

function describeValue(type, value) {
  if (value == null || value === "") return "Not set";
  if (type === "TIMELINE" && typeof value === "object") {
    return [value.start, value.end].filter(Boolean).map((d) => d.slice(0, 10)).join(" → ") || "Not set";
  }
  if (type === "PERSON" && typeof value === "object") {
    const people = live.data?.people || {};
    const names = (value.users || []).map((u) => {
      const id = String(u?.id ?? u);
      return id === live.data?.me ? "You" : people[id] || u?.name || "Someone";
    });
    for (const t of value.teams || []) names.push(t?.title || "a team");
    return names.length ? names.join(", ") : "Not set";
  }
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function loadLiveActivity(itemId) {
  el.liveActivityHint.textContent = "Loading files and comments…";
  el.liveActivityHint.hidden = false;
  let data;
  try {
    data = await api(`/api/live/items/${itemId}/activity`);
  } catch (err) {
    el.liveActivityHint.textContent = `Couldn't load activity: ${err.message}`;
    return;
  }
  if (live.openItemId !== itemId) return;
  el.liveActivityHint.hidden = true;

  el.liveFiles.replaceChildren();
  for (const f of data.files) {
    const row = document.createElement("li");
    row.className = "file-row";
    const name = document.createElement("span");
    name.className = "file-row__name";
    name.textContent = f.name;
    name.title = f.name;
    const meta = document.createElement("span");
    meta.className = "file-row__meta";
    const when = f.created_at ? relativeTime(Date.parse(f.created_at) / 1000) : "";
    meta.textContent = [f.size ? formatBytes(f.size) : "", when].filter(Boolean).join(" · ");
    row.append(icon("file"), name, meta);
    el.liveFiles.appendChild(row);
  }

  el.liveComments.replaceChildren();
  for (const c of data.comments) {
    const row = document.createElement("li");
    row.className = "comment";
    row.dataset.mine = String(c.mine);
    const who = c.mine ? "You" : c.author;
    const avatar = document.createElement("span");
    avatar.className = "avatar";
    avatar.textContent = initials(who === "You" ? "You" : c.author);
    avatar.title = c.author;
    const bodyCol = document.createElement("div");
    const head = document.createElement("div");
    head.className = "comment__who";
    const strong = document.createElement("strong");
    strong.textContent = who;
    head.appendChild(strong);
    if (c.created_at) {
      const t = Date.parse(c.created_at);
      const when = document.createElement("time");
      when.dateTime = c.created_at;
      when.title = new Date(t).toLocaleString();
      when.textContent = relativeTime(t / 1000);
      head.appendChild(when);
    }
    const text = document.createElement("div");
    text.className = "comment__text";
    // Plaky stores comment bodies as HTML; show the text only (never innerHTML).
    text.textContent = new DOMParser().parseFromString(c.text, "text/html").body.textContent || "";
    bodyCol.append(head, text);
    row.append(avatar, bodyCol);
    el.liveComments.appendChild(row);
  }
  if (data.comments.length === 0) {
    const row = document.createElement("li");
    row.className = "empty-hint";
    row.textContent = "No comments yet. Start the thread below.";
    el.liveComments.appendChild(row);
  }
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function onLiveGroupChange() {
  const item = currentLiveItem();
  if (!item || el.liveGroup.value === item.group_id) return;
  await moveLiveItem(item, el.liveGroup.value);
  toast("Moved", "ok", live.data.groups.find((g) => g.id === el.liveGroup.value)?.title || "");
}

async function onLiveDone() {
  const item = currentLiveItem();
  if (!item) return;
  el.liveDone.disabled = true;
  try {
    const done = finalStatusTarget();
    if (done) await setLiveField(item.id, done.def.key, done.label.key);
    else await moveLiveItem(item, finalGroup().id);
    toast("Marked done", "ok", `"${item.title}" is updated in Plaky.`);
  } finally {
    refreshLiveModalFields();
  }
}

async function onLiveComment() {
  const text = el.liveCommentText.value.trim();
  if (!text || !live.openItemId) return;
  el.liveCommentPost.disabled = true;
  try {
    await api(`/api/live/items/${live.openItemId}/comments`, { method: "POST", body: JSON.stringify({ text }) });
    el.liveCommentText.value = "";
    toast("Comment posted", "ok");
    await loadLiveActivity(live.openItemId);
    el.liveComments.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    loadLive({ quiet: true });
  } finally {
    el.liveCommentPost.disabled = false;
  }
}

async function onLiveUpload(file = el.liveFile.files[0]) {
  if (!file || !live.openItemId) return;
  if (file.size > 50 * 1024 * 1024) {
    toast("File too large", "error", `${file.name} is over 50 MB.`);
    return;
  }
  const body = new FormData();
  body.append("file", file);
  el.liveDrop.classList.add("is-busy");
  el.liveUploadStatus.textContent = `Uploading ${file.name}…`;
  try {
    // Not api(): that forces a JSON content type; the browser must set the multipart boundary.
    const response = await fetch(`/api/live/items/${live.openItemId}/files`, { method: "POST", body });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.detail || err.error || `${response.status}`);
    }
    toast("File uploaded", "ok", file.name);
    await loadLiveActivity(live.openItemId);
    loadLive({ quiet: true });
  } finally {
    el.liveFile.value = "";
    el.liveDrop.classList.remove("is-busy");
    el.liveUploadStatus.textContent = "Up to 50 MB";
  }
}

/* ------------------------------------------------------------------ sync log */

async function loadSyncLog() {
  const entries = await api("/api/sync/log");
  el.syncLogList.replaceChildren();
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const ico = document.createElement("div");
    ico.className = "empty-state__icon";
    ico.appendChild(icon("log"));
    const h = document.createElement("h2");
    h.textContent = "Nothing synced yet";
    const p = document.createElement("p");
    p.textContent = "Pulls from Plaky and every change you push show up here.";
    empty.append(ico, h, p);
    el.syncLogList.appendChild(empty);
    return;
  }
  for (const e of entries) {
    const row = document.createElement("div");
    row.className = "log-row";
    row.dataset.ok = String(e.ok);
    const dir = badge(e.ok ? e.direction : `${e.direction} failed`, null);
    dir.classList.add("dir");
    dir.dataset.dir = e.direction;
    const target = document.createElement("span");
    target.className = "log-row__target";
    target.textContent = e.target;
    const detail = document.createElement("span");
    detail.className = "log-row__detail";
    detail.textContent = e.detail || "";
    detail.title = e.detail || "";
    const when = document.createElement("time");
    when.className = "log-row__when";
    when.title = new Date(e.created_at * 1000).toLocaleString();
    when.textContent = relativeTime(e.created_at);
    row.append(dir, target, detail, when);
    el.syncLogList.appendChild(row);
  }
}

/* ------------------------------------------------------------------ status chip + pull */

async function refreshConfigStatus() {
  const cfg = await api("/api/config");
  state.plakyConfigured = cfg.plaky_configured;
  el.plakyStatus.dataset.ok = cfg.plaky_configured ? "true" : "off";
  el.plakyStatus.querySelector(".chip__label").textContent = cfg.plaky_configured
    ? "Plaky connected"
    : "Local only (no Plaky key)";
  el.plakyControls.hidden = !cfg.plaky_configured;
  el.pullButton.hidden = !cfg.plaky_configured;
  // Local-only: the Plaky browser and sync log would only ever be empty.
  el.navItems.forEach((btn) => {
    if (btn.dataset.view !== "board") btn.hidden = !cfg.plaky_configured;
  });
  if (cfg.plaky_configured && cfg.auto_pull_interval_seconds > 0) {
    const minutes = Math.round(cfg.auto_pull_interval_seconds / 60);
    el.autoPullHint.textContent = `Board list auto-syncs every ${minutes} min`;
  } else {
    el.autoPullHint.textContent = "";
  }
}

async function onPull() {
  el.pullButton.disabled = true;
  el.pullButton.classList.add("is-spinning");
  try {
    const res = await api("/api/sync/pull", { method: "POST" });
    await loadSections();
    await loadBacklog();
    toast("Pulled from Plaky", "ok", `${res.counts.boards} boards, ${res.counts.items} items`);
  } finally {
    el.pullButton.disabled = false;
    el.pullButton.classList.remove("is-spinning");
  }
  if (state.view === "plaky") await loadLive();
  if (state.view === "log") await loadSyncLog();
}

/* ------------------------------------------------------------------ wiring */

function isTyping(target) {
  return target instanceof HTMLElement && (target.matches("input, textarea, select") || target.isContentEditable);
}

function anyModalOpen() {
  return !el.modalScrim.hidden || !el.boardModalScrim.hidden || !el.liveModalScrim.hidden;
}

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
  el.search.addEventListener("input", () => {
    state.query = el.search.value.trim();
    if (state.view === "plaky") renderLive();
    else renderBoard();
  });

  el.livePickBoard.addEventListener("click", openBoardModal);
  el.liveRefresh.addEventListener("click", () => loadLive());
  el.liveModalClose.addEventListener("click", closeLiveModal);
  el.liveModalScrim.addEventListener("click", (e) => {
    if (e.target === el.liveModalScrim) closeLiveModal();
  });
  el.liveGroup.addEventListener("change", onLiveGroupChange);
  el.liveDone.addEventListener("click", onLiveDone);
  el.liveCommentPost.addEventListener("click", onLiveComment);
  el.liveCommentText.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onLiveComment();
    }
  });
  // Pick a file or drop one on the zone: either uploads straight away.
  el.liveFile.addEventListener("change", () => onLiveUpload());
  el.liveDrop.addEventListener("dragover", (e) => {
    if (![...e.dataTransfer.types].includes("Files")) return;
    e.preventDefault();
    el.liveDrop.classList.add("is-over");
  });
  el.liveDrop.addEventListener("dragleave", () => el.liveDrop.classList.remove("is-over"));
  el.liveDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    el.liveDrop.classList.remove("is-over");
    const file = e.dataTransfer.files[0];
    if (file) onLiveUpload(file);
  });

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
  el.boardModalLocal.addEventListener("click", onUseLocalSections);

  // Enter in the title field saves; Ctrl/Cmd+Enter saves from anywhere in the modal.
  el.fieldTitle.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      onSave();
    }
  });
  el.modalScrim.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!el.modalScrim.hidden) closeModal();
      if (!el.boardModalScrim.hidden) closeBoardModal();
      if (!el.liveModalScrim.hidden) closeLiveModal();
      if (document.activeElement === el.search) {
        el.search.value = "";
        state.query = "";
        el.search.blur();
        if (state.view === "plaky") renderLive();
        else renderBoard();
      }
      return;
    }
    if (isTyping(e.target) || anyModalOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "n" && state.view === "board") {
      e.preventDefault();
      openModal(null);
    } else if (e.key === "/") {
      e.preventDefault();
      if (state.view === "log") switchView("board");
      el.search.focus();
    }
  });

  // Any failed API call anywhere surfaces instead of silently doing nothing.
  window.addEventListener("unhandledrejection", (e) => {
    toast("Something went wrong", "error", e.reason instanceof Error ? e.reason.message : String(e.reason));
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
  path.setAttribute("fill", "currentColor"); // follows the accent hue
  path.setAttribute("stroke", "rgba(0, 0, 0, 0.6)");
  cursor.style.color = "var(--accent)";
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

  const track = (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  };
  document.addEventListener("mousemove", track);
  // mousemove doesn't fire mid-drag, so follow the card being dragged too.
  document.addEventListener("dragover", track);

  (function animate() {
    curX += (mouseX - curX) * 0.45;
    curY += (mouseY - curY) * 0.45;
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
  hydrateIcons();
  enhanceFxButtons();
  setDotText(el.viewTitle, "Backlog");
  initAccentPicker();
  wireEvents();
  initSmoothCursor();
  initHyperText();
  registerServiceWorker();
  await refreshConfigStatus();
  await loadSections();
  await loadBacklog();
  if (state.view === "plaky") loadLive(); // clicked over before the home board was known
});
