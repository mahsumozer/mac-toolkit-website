// Editor — the studio's video tab, rearranged into an editor's shell.
//
// Not a rewrite and not a copy: studio.js builds and wires the same markup it
// always does, and this moves the finished pieces into place. Moving a node
// keeps its listeners, so every control goes on working exactly as it does in
// the studio — which is the only reason a second editor can exist at all
// without becoming a second thing to maintain.
//
// The shape is the one every editor has settled on: a rail of tools down the
// left, the tool's panel beside it, the canvas in the middle, what is selected
// on the right, and time along the bottom.

// The Clips block holds four shelves that have nothing to do with each other —
// recordings, footage, stills, stickers — and one "Media" button made you scroll
// past three of them to reach the fourth. Each becomes its own tool, split on
// the heading it already carries.
// Files from the Mac come first: the drop zone was buried under the stills,
// and "where do I add a video" is the first question an editor gets asked.
const UPLOAD = {
  id: "upload",
  label: "Upload",
  icon: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
};

const MEDIA_SHELVES = [
  { id: "recordings", label: "Recordings", match: "app recordings", icon: '<rect x="2" y="6" width="14" height="12" rx="2"/><path d="m16 12 6-3v9l-6-3z"/>' },
  { id: "clips", label: "Clips", match: "background clips", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/><path d="M8 5v14"/>' },
  { id: "stills", label: "Stills", match: "images", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 4 4 2-2 3 3"/>' },
  { id: "gifs", label: "GIFs", match: "gifs", icon: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 10h-1.5a1.5 1.5 0 0 0 0 3H12v-1.5"/><path d="M8 10v3"/><path d="M15 13v-3h2"/>' },
];

const RAIL = [
  {
    id: "footage",
    label: "Footage",
    block: "1 · Find footage",
    icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  },
  {
    id: "text",
    label: "Text",
    block: "3 · Script",
    icon: '<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M9 20h6"/>',
  },
  {
    id: "audio",
    label: "Audio",
    block: "5 · Captions & audio",
    icon: '<path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
  },
  {
    id: "export",
    label: "Export",
    block: "6 · Caption & render",
    icon: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z"/>',
  },
];

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;

function blocksByTitle(panel) {
  const found = new Map();
  for (const block of panel.querySelectorAll("details.block")) {
    const title = (block.querySelector("summary")?.textContent || "").replace(/\s+/g, " ").trim();
    found.set(title, block);
  }
  return found;
}

function build() {
  const panel = document.querySelector('.tab-panel[data-panel="video"]');
  const main = document.querySelector(".studio-main");
  if (!panel || !main) return;

  const blocks = blocksByTitle(panel);
  const shell = document.createElement("div");
  shell.className = "ed-shell";
  shell.innerHTML = `
    <nav class="ed-rail" aria-label="Tools"></nav>
    <section class="ed-panel" id="ed-panel">
      <header class="ed-panel-head">
        <span class="ed-panel-title" id="ed-panel-title">Media</span>
        <input class="ed-panel-filter" id="ed-panel-filter" type="search" placeholder="Filter by name" aria-label="Filter the cards by name" hidden />
        <button class="ed-panel-collapse" id="ed-panel-collapse" type="button" aria-label="Hide the panel">‹</button>
      </header>
      <div class="ed-panel-body" id="ed-panel-body"></div>
    </section>
    <section class="ed-stage" id="ed-stage"></section>
    <aside class="ed-inspector" id="ed-inspector">
      <header class="ed-inspector-head">Selected</header>
      <div class="ed-inspector-body" id="ed-inspector-body"></div>
    </aside>
    <section class="ed-dock" id="ed-dock"></section>
  `;
  main.appendChild(shell);

  // The stage, the timeline and the inspector each have one home; the rest of
  // the blocks live behind the rail.
  const stage = panel.querySelector(".studio-preview");
  if (stage) shell.querySelector("#ed-stage").appendChild(stage);
  const timeline = document.querySelector(".studio-body > .timeline, .timeline");
  if (timeline) shell.querySelector("#ed-dock").appendChild(timeline);

  const canvasBlock = blocks.get("4 · Canvas");
  if (canvasBlock) {
    const inspectorBody = canvasBlock.querySelector(".block-body");
    if (inspectorBody) shell.querySelector("#ed-inspector-body").appendChild(inspectorBody);
    canvasBlock.remove();
    buildInspectorTabs(shell.querySelector("#layer-inspector"));
  }

  const rail = shell.querySelector(".ed-rail");
  const body = shell.querySelector("#ed-panel-body");
  const panes = new Map();

  const addTool = (item, node, hint) => {
    const pane = document.createElement("div");
    pane.className = "ed-pane";
    pane.hidden = true;
    if (hint) {
      const p = document.createElement("p");
      p.className = "ed-pane-hint";
      p.textContent = hint;
      pane.appendChild(p);
    }
    pane.appendChild(node);
    body.appendChild(pane);
    panes.set(item.id, pane);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-rail-button";
    button.dataset.tool = item.id;
    button.innerHTML = `${svg(item.icon)}<span>${item.label}</span>`;
    button.addEventListener("click", () => show(item.id));
    rail.appendChild(button);
  };

  // Upload first, then the shelves in the order a clip usually arrives.
  const clipsBlock = blocks.get("2 · Clips");
  if (clipsBlock) {
    const drop = clipsBlock.querySelector("#video-drop");
    if (drop) {
      const upload = document.createElement("div");
      upload.className = "ed-upload";
      upload.appendChild(drop);
      const note = document.createElement("p");
      note.className = "field-hint";
      note.textContent = "Drop files on the box or click it to choose. Videos and music go to Clips, pictures to Stills; a file is on the canvas the moment you click it there.";
      upload.appendChild(note);
      addTool(UPLOAD, upload, "Add a video, a picture or a piece of music from this Mac.");
    }

    const fields = [...clipsBlock.querySelectorAll(":scope > .block-body > .field")];
    const heading = (field) => (field.querySelector(":scope > span")?.textContent || "").toLowerCase();
    const shelfHint = "Click a card to put it on the canvas, or drag it onto the stage to place it yourself.";
    for (const shelf of MEDIA_SHELVES) {
      const field = fields.find((candidate) => heading(candidate).includes(shelf.match));
      if (field) addTool(shelf, field, shelfHint);
    }
    // Whatever is left — the still-length control — belongs with the stills.
    const rest = [...clipsBlock.querySelectorAll(":scope > .block-body > *")];
    const stills = panes.get("stills");
    if (stills) for (const node of rest) stills.appendChild(node);
    clipsBlock.remove();
  }

  for (const item of RAIL) {
    const block = blocks.get(item.block);
    if (!block) continue;

    // The block's body moves and the <details> is left behind entirely. Removing
    // only the summary looks tidier in the markup and worse on screen: a
    // details element without one is drawn by the browser with its own label,
    // which is how a panel came to be titled "Ayrıntılar".
    const blockBody = block.querySelector(".block-body");
    addTool(item, blockBody || block);
    block.remove();
  }

  function show(id) {
    const alreadyOpen = shell.classList.contains("is-open") && rail.querySelector(".ed-rail-button.is-on")?.dataset.tool === id;
    // Clicking the tool you are already in closes the panel, which is how every
    // editor behaves and the quickest way to get the canvas back.
    if (alreadyOpen) return collapse(true);
    for (const [key, pane] of panes) pane.hidden = key !== id;
    for (const button of rail.querySelectorAll(".ed-rail-button")) button.classList.toggle("is-on", button.dataset.tool === id);
    const named = [UPLOAD, ...MEDIA_SHELVES, ...RAIL].find((item) => item.id === id);
    shell.querySelector("#ed-panel-title").textContent = named?.label || "";
    // The filter only makes sense over a shelf of cards.
    const filter = shell.querySelector("#ed-panel-filter");
    filter.hidden = !panes.get(id)?.querySelector(".clip-card, .gif-card");
    applyFilter();
    collapse(false);
  }

  // Cards whose name does not contain the words typed are hidden; the shelves
  // are rebuilt when the library reloads, so this runs again on every show
  // and on every upload.
  function applyFilter() {
    const filter = shell.querySelector("#ed-panel-filter");
    const query = filter.value.trim().toLowerCase();
    const pane = [...panes.values()].find((candidate) => !candidate.hidden);
    if (!pane) return;
    for (const card of pane.querySelectorAll(".clip-card, .gif-card")) {
      const name = (card.querySelector(".clip-name, .gif-name")?.textContent || card.textContent || "").toLowerCase();
      card.hidden = Boolean(query) && !name.includes(query);
    }
  }
  shell.querySelector("#ed-panel-filter").addEventListener("input", applyFilter);
  document.addEventListener("studio:uploaded", () => setTimeout(applyFilter, 50));

  // A button keeps focus after it is clicked, and Space on a focused button
  // clicks it again — so Space after Delete deleted the next layer too instead
  // of playing. Every button lets go of focus once it has done its job.
  shell.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button && document.activeElement === button) button.blur();
  });

  // The timeline's height is a drag on its top edge, remembered between visits.
  const dock = shell.querySelector("#ed-dock");
  const grip = document.createElement("div");
  grip.className = "ed-dock-grip";
  grip.title = "Drag to resize the timeline";
  dock.prepend(grip);
  const savedDock = Number(localStorage.getItem("ed-dock-height"));
  if (savedDock >= 140) shell.style.setProperty("--ed-dock", `${savedDock}px`);
  grip.addEventListener("pointerdown", (event) => {
    const startY = event.clientY;
    const startHeight = dock.getBoundingClientRect().height;
    grip.setPointerCapture(event.pointerId);
    grip.classList.add("is-dragging");
    const move = (ev) => {
      const height = Math.round(Math.max(140, Math.min(startHeight + (startY - ev.clientY), window.innerHeight * 0.6)));
      shell.style.setProperty("--ed-dock", `${height}px`);
      // The timeline lays itself out from its visible size.
      window.dispatchEvent(new Event("resize"));
    };
    const up = () => {
      grip.classList.remove("is-dragging");
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      localStorage.setItem("ed-dock-height", String(Math.round(dock.getBoundingClientRect().height)));
      window.dispatchEvent(new Event("resize"));
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
    event.preventDefault();
  });

  function collapse(hide) {
    shell.classList.toggle("is-open", !hide);
    if (hide) for (const button of rail.querySelectorAll(".ed-rail-button")) button.classList.remove("is-on");
  }

  shell.querySelector("#ed-panel-collapse").addEventListener("click", () => collapse(true));
  // An upload lands on the canvas by itself (studio.js); the panel follows it
  // to the shelf it was filed on, so the card is there to see.
  document.addEventListener("studio:uploaded", (event) => {
    const dirs = new Set((event.detail || []).map((file) => file.dir));
    show(dirs.has("videos") || dirs.has("music") ? "clips" : "stills");
  });
  show("recordings");

  // What is left of the studio's own layout is scaffolding this page does not
  // use: the tab strip, the step rail and the emptied controls column.
  document.querySelector(".step-rail")?.remove();
  document.querySelector(".tabs")?.remove();
  panel.querySelector(".studio-controls")?.remove();
  document.body.classList.add("ed-ready");
}

// The selected layer's controls, as three short pages — Layout, Timing,
// Adjust — rather than one scroll of a dozen rows. Rows are moved, not
// rebuilt, so every control keeps the listener studio.js gave it; the one row
// that mixed the two (speed beside opacity) is split between Timing and Adjust.
const INSPECTOR_TABS = [
  ["layout", "Layout"],
  ["timing", "Timing"],
  ["adjust", "Adjust"],
];

function buildInspectorTabs(inspector) {
  if (!inspector) return;
  const tabs = document.createElement("div");
  tabs.className = "ed-insp-tabs";
  const panes = {};
  for (const [id, label] of INSPECTOR_TABS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ed-insp-tab";
    button.dataset.tab = id;
    button.textContent = label;
    tabs.appendChild(button);
    const pane = document.createElement("div");
    pane.className = "ed-insp-pane";
    pane.dataset.tab = id;
    panes[id] = pane;
  }

  const has = (row, selector) => row.matches(selector) || Boolean(row.querySelector(selector));
  for (const row of [...inspector.children]) {
    if (has(row, "#insp-speed")) {
      const speed = row.querySelector("#insp-speed-field");
      const opacity = row.querySelector("#insp-opacity")?.closest(".field");
      const timing = document.createElement("div");
      timing.className = "field-row";
      if (speed) timing.appendChild(speed);
      panes.timing.appendChild(timing);
      const adjust = document.createElement("div");
      adjust.className = "field-row";
      if (opacity) adjust.appendChild(opacity);
      panes.adjust.appendChild(adjust);
      row.remove();
      continue;
    }
    let where = "layout";
    if (has(row, "#insp-start") || has(row, "#insp-fadein")) where = "timing";
    if (has(row, "#insp-rotate") || row.id === "insp-colour") where = "adjust";
    panes[where].appendChild(row);
  }
  inspector.append(tabs, panes.layout, panes.timing, panes.adjust);

  const show = (id) => {
    for (const [key, pane] of Object.entries(panes)) pane.hidden = key !== id;
    for (const button of tabs.children) button.classList.toggle("is-on", button.dataset.tab === id);
    try {
      localStorage.setItem("ed-insp-tab", id);
    } catch {}
  };
  tabs.addEventListener("click", (event) => {
    const button = event.target.closest(".ed-insp-tab");
    if (button) show(button.dataset.tab);
  });
  let remembered = "layout";
  try {
    remembered = localStorage.getItem("ed-insp-tab") || "layout";
  } catch {}
  show(panes[remembered] ? remembered : "layout");
}

// studio.js is a module and runs first; its own init is async, so the pieces are
// waited for rather than assumed. The thing waited for is the video tab being
// the active one: that is the last step of the studio's init, and it is also
// the step that moves the stage — build before it and showTab never finds its
// tab strip, leaves the image panel active, and every keyboard shortcut (they
// all check which panel is active) is dead on this page.
async function start() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (document.querySelector('.tab-panel[data-panel="video"].is-active .studio-preview') && document.querySelector("details.block")) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  build();
}

start();
